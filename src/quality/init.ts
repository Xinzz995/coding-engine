import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { writeFileAtomicSync } from '../engine/fs-atomic.js';
import { readStableFile } from '../workspace-safety/stable-file.js';
import {
  POLICY_GUARD_REQUIRED_CHECK,
  QUALITY_CONTRACT_RELATIVE_PATH,
  digestQualityContract,
  parseQualityContract,
  readQualityContract,
  type QualityCheckCategory,
  type QualityCodeScanningTool,
  type QualityContract,
} from './contract.js';
import {
  GitHubQualityError,
  type GitHubQualityClient,
  type GitHubRepositoryInfo,
  type GitHubRuleset,
  type RequiredStatusCheck,
} from './github.js';
import { GhGitHubQualityClient } from './github-unmanaged.js';
import {
  discoverQualityContract,
  discoverTrackedWorkflowPlatforms,
  parseRequiredPlatformsInput,
  resolveNotApplicableReasons,
} from './init-discovery.js';
import { renderManagedGitHubFiles } from './github-workflows.js';
import {
  buildManagedRulesetPayload,
  findManagedRuleset,
  requiredChecksFromRuleset,
  validateManagedRuleset,
} from './ruleset.js';
import {
  buildManagedReleaseRulesetPayload,
  findManagedReleaseRuleset,
  validateManagedReleaseRuleset,
} from './release-ruleset.js';

export type QualityInitStatus =
  | 'cancelled'
  | 'files-created'
  | 'waiting-for-pr'
  | 'waiting-for-checks'
  | 'checks-activated'
  | 'ready';

export interface QualityInitResult {
  status: QualityInitStatus;
  exitCode: 0 | 2 | 6;
  repository: string;
  defaultBranch: string;
  branch: string;
  rulesetId: number | null;
  releaseRulesetId: number | null;
  immutableReleases: boolean | null;
  createdFiles: string[];
  updatedFiles: string[];
  activeRequiredChecks: string[];
  pendingRequiredChecks: string[];
  pullRequest: number | null;
  message: string;
}

export interface QualityInitOptions {
  root: string;
  actualVersion: string;
  contractFile?: string;
  client?: GitHubQualityClient;
  /** 用户确认；CLI 交互或显式 --yes 均实现此接口。 */
  confirm: (summary: string) => boolean | Promise<boolean>;
  /** 自动发现时取得明确平台选择，以及缺少某类检查时的具体不适用理由。 */
  ask: (question: string) => string | Promise<string>;
  emit?: (message: string) => void;
  /**
   * 在本地/远端任何质量配置写入前建立运行时 workspace 安全根。
   * discovery 与工作树检查仍在它之前，避免新建 workspace 反过来污染初始化预检。
   */
  prepareWorkspace?: () => void | Promise<void>;
}

const MANAGED_MARKER = 'Generated from';
const CATEGORY_LABEL: Record<QualityCheckCategory, string> = {
  test: '测试',
  build: '构建',
  static: '静态检查',
  security: '安全检查',
};

function git(root: string, args: string[]): string {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    }).trim();
  } catch (error) {
    throw new Error(
      `Git 检查失败（git ${args.join(' ')}）：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function validateGitRoot(root: string): void {
  const prefix = git(root, ['rev-parse', '--show-prefix']);
  if (prefix !== '') {
    const actual = git(root, ['rev-parse', '--show-toplevel']);
    throw new Error(`请从 Git 项目根运行 init：${actual}`);
  }
}

function currentBranch(root: string): string {
  const branch = git(root, ['branch', '--show-current']);
  if (!branch) throw new Error('当前处于 detached HEAD，不能初始化交付门禁');
  return branch;
}

interface ContractSource {
  path: string;
  relativePath: string;
  bytes: Buffer;
  fingerprint: string;
  realRoot: string;
  realPath: string;
}

function assertSafeWorktree(root: string, contractSource: ContractSource | undefined): void {
  const lines = git(root, ['status', '--porcelain=v1', '--untracked-files=all'])
    .split('\n')
    .filter(Boolean);
  const allowed = new Set([
    QUALITY_CONTRACT_RELATIVE_PATH,
    ...(contractSource ? [contractSource.relativePath] : []),
    ...Object.keys(renderManagedGitHubFilesPlaceholder()),
  ]);
  const unrelated = lines.filter((line) => {
    const path = line.slice(3).split(' -> ').at(-1) ?? '';
    return !allowed.has(path);
  });
  if (unrelated.length > 0) {
    throw new Error(`工作树含与初始化无关的改动，先提交或处理：${unrelated.join('、')}`);
  }
}

/** 只为取得固定的托管路径；内容不会使用。 */
function renderManagedGitHubFilesPlaceholder(): Record<string, string> {
  return {
    '.github/workflows/quality-gate.yml': '',
    '.github/workflows/policy-guard.yml': '',
    '.github/PULL_REQUEST_TEMPLATE.md': '',
    '.github/ISSUE_TEMPLATE/quality-p1.yml': '',
    '.github/ISSUE_TEMPLATE/quality-policy.yml': '',
  };
}

function pathInsideRoot(root: string, value: string): string {
  const path = resolve(root, value);
  const rel = relative(resolve(root), path);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`路径位于项目根之外：${value}`);
  }
  return path;
}

interface ContractBoundary {
  realRoot: string;
  realPath: string;
}

function resolveContractBoundary(root: string, path: string, value: string): ContractBoundary {
  let realRoot: string;
  let realPath: string;
  try {
    realRoot = realpathSync(root);
    realPath = realpathSync(path);
  } catch (error) {
    throw new Error(
      `无法读取契约输入 ${value}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const realRelative = relative(realRoot, realPath);
  if (realRelative === '..' || realRelative.startsWith(`..${sep}`) || isAbsolute(realRelative)) {
    throw new Error(`契约输入的真实位置位于项目根之外：${value}`);
  }
  return { realRoot, realPath };
}

function readFrozenContractSource(root: string, value: string): ContractSource {
  const lexicalPath = pathInsideRoot(root, value);
  const before = resolveContractBoundary(root, lexicalPath, value);
  const observed = readStableFile(lexicalPath, { label: `契约输入 ${value}` });
  if (observed.status !== 'ready') {
    const detail = observed.status === 'missing' ? '文件不存在' : observed.diagnostic;
    throw new Error(`无法读取契约输入 ${value}：${detail}`);
  }
  const after = resolveContractBoundary(root, lexicalPath, value);
  if (before.realRoot !== after.realRoot || before.realPath !== after.realPath) {
    throw new Error(`契约输入的真实位置在读取期间发生变化：${value}`);
  }
  return {
    path: lexicalPath,
    relativePath: relative(resolve(root), lexicalPath).split(sep).join('/'),
    bytes: observed.bytes,
    fingerprint: observed.fingerprint,
    realRoot: after.realRoot,
    realPath: after.realPath,
  };
}

function revalidateContractSource(root: string, source: ContractSource): void {
  const before = resolveContractBoundary(root, source.path, source.relativePath);
  if (before.realRoot !== source.realRoot || before.realPath !== source.realPath) {
    throw new Error(`契约输入的真实位置在仓库探测期间发生变化：${source.relativePath}`);
  }
  const observed = readStableFile(source.path, { label: `契约输入 ${source.relativePath}` });
  if (observed.status !== 'ready') {
    const detail = observed.status === 'missing' ? '文件不存在' : observed.diagnostic;
    throw new Error(`契约输入在仓库探测期间不可稳定读取：${detail}`);
  }
  const after = resolveContractBoundary(root, source.path, source.relativePath);
  if (
    before.realRoot !== after.realRoot ||
    before.realPath !== after.realPath ||
    after.realRoot !== source.realRoot ||
    after.realPath !== source.realPath ||
    observed.fingerprint !== source.fingerprint
  ) {
    throw new Error(`契约输入在仓库探测期间发生变化：${source.relativePath}`);
  }
}

function parseContractFile(bytes: Buffer, path: string): QualityContract {
  let parsed: unknown;
  try {
    parsed = JSON.parse(bytes.toString('utf8'));
  } catch (error) {
    throw new Error(
      `无法读取契约输入 ${path}：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const result = parseQualityContract(parsed);
  if (result.status === 'invalid') throw new Error(`契约输入非法：${result.errors.join('；')}`);
  return result.contract;
}

function validateContractIdentity(
  contract: QualityContract,
  repository: GitHubRepositoryInfo,
  actualVersion: string,
): void {
  if (
    contract.repository.fullName !== repository.fullName ||
    contract.repository.defaultBranch !== repository.defaultBranch
  ) {
    throw new Error(
      `质量契约绑定 ${contract.repository.fullName}/${contract.repository.defaultBranch}，` +
        `实际远端为 ${repository.fullName}/${repository.defaultBranch}`,
    );
  }
  if (contract.codingXVersion !== actualVersion) {
    throw new Error(`质量契约固定 ${contract.codingXVersion}，当前 coding-x 为 ${actualVersion}`);
  }
}

async function resolveContract(
  options: QualityInitOptions,
  repository: GitHubRepositoryInfo,
  contractSource: ContractSource | undefined,
): Promise<{ contract: QualityContract; needsWrite: boolean }> {
  const existing = readQualityContract(options.root);
  if (contractSource) {
    revalidateContractSource(options.root, contractSource);
    const contract = parseContractFile(contractSource.bytes, contractSource.relativePath);
    validateContractIdentity(contract, repository, options.actualVersion);
    if (existing.status === 'ready') {
      if (existing.digest !== digestQualityContract(contract)) {
        throw new Error('契约候选与现有 .coding-x/quality.json 不一致；请先人工完成一致性裁决');
      }
      return { contract, needsWrite: false };
    }
    if (existing.status !== 'missing') {
      const detail = existing.status === 'invalid' ? existing.errors.join('；') : existing.error;
      throw new Error(`现有质量契约不可用：${detail}`);
    }
    return { contract, needsWrite: true };
  }
  if (existing.status === 'ready') {
    validateContractIdentity(existing.contract, repository, options.actualVersion);
    return { contract: existing.contract, needsWrite: false };
  }
  if (existing.status !== 'missing') {
    const detail = existing.status === 'invalid' ? existing.errors.join('；') : existing.error;
    throw new Error(`现有质量契约不可用：${detail}`);
  }
  const workflowHints = discoverTrackedWorkflowPlatforms(options.root);
  const hintSummary =
    workflowHints.platforms.length > 0
      ? `已跟踪 workflow 中写死的 runner 提示：${workflowHints.platforms.join('、')}。`
      : '已跟踪 workflow 没有可直接识别的固定 runner 提示。';
  const uncertaintySummary = workflowHints.hasUncertainRunners
    ? '另有动态或 self-hosted runner，coding-x 不会猜测其平台。'
    : '没有发现动态或 self-hosted runner。';
  const requiredPlatforms = parseRequiredPlatformsInput(
    await options.ask(
      `${hintSummary}\n${uncertaintySummary}\n` +
        '请输入目标项目交付前必须验证的平台，使用逗号分隔，只允许 linux、macos、windows；空值会停止初始化：',
    ),
  );
  const draft = discoverQualityContract(
    options.root,
    repository,
    options.actualVersion,
    requiredPlatforms,
  );
  const reasons: Partial<Record<QualityCheckCategory, string>> = {};
  for (const category of draft.unresolvedCategories) {
    reasons[category] = await options.ask(
      `未发现${CATEGORY_LABEL[category]}命令。请说明该项为什么不适用；空值会停止初始化：`,
    );
  }
  const contract = resolveNotApplicableReasons(draft, reasons);
  const parsed = parseQualityContract(contract);
  if (parsed.status === 'invalid')
    throw new Error(`自动发现的契约未通过校验：${parsed.errors.join('；')}`);
  options.emit?.(
    `发现生态：${draft.detectedEcosystems.join('、')}\n` +
      `候选质量契约：\n${JSON.stringify(contract, null, 2)}`,
  );
  return { contract, needsWrite: true };
}

async function ensureMinimumRules(
  options: QualityInitOptions,
  repository: GitHubRepositoryInfo,
  existing: GitHubRuleset | null,
  currentChecks: RequiredStatusCheck[],
  requiredCodeScanning: QualityCodeScanningTool[] | undefined,
): Promise<GitHubRuleset | null> {
  const currentErrors = existing
    ? validateManagedRuleset(existing, currentChecks, requiredCodeScanning)
    : ['Ruleset 不存在'];
  if (currentErrors.length === 0) return existing;
  const confirmed = await options.confirm(
    [
      '即将配置 GitHub 默认分支规则：所有改动必须经过 PR、解决所有对话、禁止强推和删除、无日常绕过者。',
      currentChecks.length > 0
        ? `保留已启用检查：${currentChecks.map((check) => check.context).join('、')}`
        : '当前仍处于 Bootstrap 最小阶段，不提前要求尚未出现的检查。',
      requiredCodeScanning && requiredCodeScanning.length > 0
        ? `强制代码扫描：${requiredCodeScanning
            .map(
              (entry) =>
                `${entry.tool}（安全 ${entry.securityAlertsThreshold}；普通 ${entry.alertsThreshold}）`,
            )
            .join('、')}`
        : '质量契约未要求 coding-x 接管代码扫描规则。',
      `远端当前差异：${currentErrors.join('；')}`,
    ].join('\n'),
  );
  if (!confirmed) return null;
  const payload = buildManagedRulesetPayload(existing, currentChecks, requiredCodeScanning);
  const changed = existing
    ? options.client!.updateRuleset(repository.fullName, existing.id, payload)
    : options.client!.createRuleset(repository.fullName, payload);
  const readback = options.client!.getRuleset(repository.fullName, changed.id);
  const errors = validateManagedRuleset(readback, currentChecks, requiredCodeScanning);
  if (errors.length > 0) throw new GitHubQualityError('Ruleset 回读核验失败', errors.join('；'));
  return readback;
}

async function ensureReleaseProtection(
  options: QualityInitOptions,
  repository: GitHubRepositoryInfo,
  existing: GitHubRuleset | null,
  protectedRefs: string[],
  requireImmutableReleases: boolean,
): Promise<{ ruleset: GitHubRuleset | null; immutableReleases: boolean | null } | null> {
  const manageRefs = protectedRefs.length > 0;
  if (!manageRefs && !requireImmutableReleases) {
    return { ruleset: null, immutableReleases: null };
  }
  const errors = manageRefs
    ? existing
      ? validateManagedReleaseRuleset(existing, protectedRefs)
      : ['发布标签 Ruleset 不存在']
    : [];
  let immutableReleases: boolean | null = null;
  if (requireImmutableReleases) {
    if (!options.client!.getImmutableReleases || !options.client!.enableImmutableReleases) {
      throw new GitHubQualityError('当前 GitHub 适配器无法配置不可变 Release');
    }
    immutableReleases = options.client!.getImmutableReleases(repository.fullName).enabled;
    if (!immutableReleases) errors.push('GitHub 不可变 Release 尚未启用');
  }
  if (errors.length === 0) {
    return { ruleset: manageRefs ? existing : null, immutableReleases };
  }

  const confirmed = await options.confirm(
    [
      ...(manageRefs
        ? [
            `即将保护 GitHub 发布标签：${protectedRefs.join('、')}。`,
            '有仓库写权限的人可以首次创建标签；创建后禁止更新和删除，且不配置日常绕过者。',
          ]
        : []),
      requireImmutableReleases
        ? '发布后 GitHub Release、关联标签和资产不可修改。'
        : '质量契约未要求 coding-x 管理 GitHub Release 不可变设置。',
      `远端当前差异：${errors.join('；')}`,
    ].join('\n'),
  );
  if (!confirmed) return null;

  let readback: GitHubRuleset | null = null;
  if (manageRefs) {
    const payload = buildManagedReleaseRulesetPayload(existing, protectedRefs);
    const changed = existing
      ? options.client!.updateRuleset(repository.fullName, existing.id, payload)
      : options.client!.createRuleset(repository.fullName, payload);
    readback = options.client!.getRuleset(repository.fullName, changed.id);
    const ruleErrors = validateManagedReleaseRuleset(readback, protectedRefs);
    if (ruleErrors.length > 0) {
      throw new GitHubQualityError('发布标签 Ruleset 回读核验失败', ruleErrors.join('；'));
    }
  }

  if (requireImmutableReleases && !immutableReleases) {
    options.client!.enableImmutableReleases!(repository.fullName);
    immutableReleases = options.client!.getImmutableReleases!(repository.fullName).enabled;
    if (!immutableReleases) throw new GitHubQualityError('不可变 Release 启用后回读仍为关闭');
  }
  return { ruleset: readback, immutableReleases };
}

function planManagedFiles(
  root: string,
  contract: QualityContract,
  needsContractWrite: boolean,
): { files: Record<string, string>; create: string[]; update: string[] } {
  const files = renderManagedGitHubFiles(contract);
  if (needsContractWrite) {
    files[QUALITY_CONTRACT_RELATIVE_PATH] = `${JSON.stringify(contract, null, 2)}\n`;
  }
  const create: string[] = [];
  const update: string[] = [];
  for (const [relativePath, content] of Object.entries(files)) {
    const path = pathInsideRoot(root, relativePath);
    if (!existsSync(path)) {
      create.push(relativePath);
      continue;
    }
    const current = readFileSync(path, 'utf8');
    if (current === content) continue;
    if (relativePath === QUALITY_CONTRACT_RELATIVE_PATH || !current.includes(MANAGED_MARKER)) {
      throw new Error(`不会覆盖非托管文件 ${relativePath}；请人工合并后重跑 init`);
    }
    update.push(relativePath);
  }
  return { files, create, update };
}

function writeManagedFiles(root: string, plan: ReturnType<typeof planManagedFiles>): void {
  for (const relativePath of [...plan.create, ...plan.update]) {
    const path = pathInsideRoot(root, relativePath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileAtomicSync(path, plan.files[relativePath]);
  }
}

function ensureManagedLabels(client: GitHubQualityClient, repository: string): void {
  client.ensureLabel(
    repository,
    'quality-policy-approved',
    'B60205',
    'Owner approved one protected policy exception.',
  );
  client.ensureLabel(
    repository,
    'quality-policy-exception',
    'D93F0B',
    'Time-bounded quality policy exception.',
  );
  client.ensureLabel(repository, 'quality-p1-deferral', 'FBCA04', 'Time-bounded P1 deferral.');
}

function result(
  status: QualityInitStatus,
  exitCode: 0 | 2 | 6,
  repository: GitHubRepositoryInfo,
  branch: string,
  ruleset: GitHubRuleset | null,
  contract: QualityContract,
  over: Partial<QualityInitResult>,
): QualityInitResult {
  const active = requiredChecksFromRuleset(ruleset).map((check) => check.context);
  return {
    status,
    exitCode,
    repository: repository.fullName,
    defaultBranch: repository.defaultBranch,
    branch,
    rulesetId: ruleset?.id ?? null,
    releaseRulesetId: null,
    immutableReleases: null,
    createdFiles: [],
    updatedFiles: [],
    activeRequiredChecks: active,
    pendingRequiredChecks: contract.github.requiredChecks.filter((name) => !active.includes(name)),
    pullRequest: null,
    message: '',
    ...over,
  };
}

export async function runQualityInit(options: QualityInitOptions): Promise<QualityInitResult> {
  options.client ??= new GhGitHubQualityClient();
  validateGitRoot(options.root);
  const contractSource = options.contractFile
    ? readFrozenContractSource(options.root, options.contractFile)
    : undefined;
  assertSafeWorktree(options.root, contractSource);
  const branch = currentBranch(options.root);
  const repository = options.client.discoverRepository(options.root);
  options.client.verifyDefaultBranch(repository);
  if (branch === repository.defaultBranch) {
    throw new Error(`当前位于默认分支 ${branch}；请先创建 Bootstrap 或 Policy 功能分支`);
  }
  const { contract, needsWrite } = await resolveContract(options, repository, contractSource);
  await options.prepareWorkspace?.();
  const initialRulesets = options.client.listRulesets(repository.fullName);
  const initialRuleset = findManagedRuleset(initialRulesets);
  const initialReleaseRuleset = findManagedReleaseRuleset(initialRulesets);
  const currentChecks = requiredChecksFromRuleset(initialRuleset);
  const contractCheckNames = new Set(contract.github.requiredChecks);
  const unexpected = currentChecks.filter((check) => !contractCheckNames.has(check.context));
  if (unexpected.length > 0) {
    throw new Error(
      `托管 Ruleset 含契约外检查：${unexpected.map((check) => check.context).join('、')}`,
    );
  }
  const requiredCodeScanning = contract.github.requiredCodeScanning;
  const ruleset = await ensureMinimumRules(
    options,
    repository,
    initialRuleset,
    currentChecks,
    requiredCodeScanning,
  );
  if (!ruleset) {
    return result('cancelled', 6, repository, branch, initialRuleset, contract, {
      releaseRulesetId: initialReleaseRuleset?.id ?? null,
      message:
        '用户取消 GitHub 最小规则配置；未写质量契约、CI 或模板，已完成的 workspace 安全初始化保留。',
    });
  }
  const releaseProtection = await ensureReleaseProtection(
    options,
    repository,
    initialReleaseRuleset,
    contract.release.protectedRefs,
    contract.github.immutableReleases === true,
  );
  if (!releaseProtection) {
    return result('cancelled', 6, repository, branch, ruleset, contract, {
      releaseRulesetId: initialReleaseRuleset?.id ?? null,
      message: '用户取消发布标签或不可变 Release 配置；默认分支规则保持启用。',
    });
  }
  const releaseState = {
    releaseRulesetId: releaseProtection.ruleset?.id ?? null,
    immutableReleases: releaseProtection.immutableReleases,
  };

  const filePlan = planManagedFiles(options.root, contract, needsWrite);
  if (filePlan.create.length > 0 || filePlan.update.length > 0) {
    const confirmed = await options.confirm(
      [
        'GitHub 最小规则已回读确认。即将生成受 Git 管理的质量文件：',
        ...filePlan.create.map((path) => `新增 ${path}`),
        ...filePlan.update.map((path) => `更新 ${path}`),
        '请确认候选命令、工作目录、运行系统、超时、规范来源和不适用理由均正确。',
        '尤其确认 localValidation.prepare 会在项目外的干净检出运行，allowedPaths 只列出确实需要的本地依赖目录。',
      ].join('\n'),
    );
    if (!confirmed) {
      return result('cancelled', 6, repository, branch, ruleset, contract, {
        ...releaseState,
        message: '用户取消本地质量文件生成；GitHub 最小规则保持启用。',
      });
    }
    writeManagedFiles(options.root, filePlan);
    ensureManagedLabels(options.client, repository.fullName);
    return result('files-created', 6, repository, branch, ruleset, contract, {
      ...releaseState,
      createdFiles: filePlan.create,
      updatedFiles: filePlan.update,
      message:
        '本地初始化文件已生成。请提交、推送并打开 Bootstrap PR，然后重新运行 coding-x init。',
    });
  }

  ensureManagedLabels(options.client, repository.fullName);

  const pullRequest = options.client.findOpenPullRequest(repository, branch);
  if (!pullRequest) {
    return result('waiting-for-pr', 6, repository, branch, ruleset, contract, {
      ...releaseState,
      message: '本地文件已就绪，但当前分支没有对应的打开 PR。推送并打开 PR 后重跑 init。',
    });
  }
  const head = git(options.root, ['rev-parse', 'HEAD']);
  if (pullRequest.headSha !== head) {
    return result('waiting-for-pr', 6, repository, branch, ruleset, contract, {
      ...releaseState,
      pullRequest: pullRequest.number,
      message: `PR #${pullRequest.number} 的 head 不是当前提交；先推送 ${head} 后重跑 init。`,
    });
  }

  const runs = options.client.listCheckRuns(repository.fullName, head);
  const activeChecks = requiredChecksFromRuleset(ruleset);
  const activeNames = new Set(activeChecks.map((check) => check.context));
  const newlyObserved: RequiredStatusCheck[] = [];
  for (const name of contract.github.requiredChecks.filter((check) => !activeNames.has(check))) {
    const matching = runs.filter((run) => run.name === name && run.headSha === head);
    if (matching.length === 0) continue;
    const appIds = new Set(matching.map((run) => run.app.id));
    const invalidSource = matching.find((run) => run.app.slug !== 'github-actions');
    if (invalidSource || appIds.size !== 1) {
      throw new Error(`检查 ${name} 不是唯一的 GitHub Actions 来源，不能加入 Ruleset`);
    }
    newlyObserved.push({ context: name, integration_id: matching[0].app.id });
  }

  let finalRuleset = ruleset;
  if (newlyObserved.length > 0) {
    const merged = [...activeChecks, ...newlyObserved];
    const confirmed = await options.confirm(
      `PR #${pullRequest.number} 已出现 GitHub Actions 检查：` +
        `${newlyObserved.map((check) => check.context).join('、')}。` +
        '是否将它们绑定到默认分支 Ruleset 并立即回读核验？',
    );
    if (!confirmed) {
      return result('cancelled', 6, repository, branch, ruleset, contract, {
        ...releaseState,
        pullRequest: pullRequest.number,
        message: '用户取消必需检查升级。',
      });
    }
    const payload = buildManagedRulesetPayload(ruleset, merged, requiredCodeScanning);
    const changed = options.client.updateRuleset(repository.fullName, ruleset.id, payload);
    finalRuleset = options.client.getRuleset(repository.fullName, changed.id);
    const errors = validateManagedRuleset(finalRuleset, merged, requiredCodeScanning);
    if (errors.length > 0) throw new GitHubQualityError('必需检查回读核验失败', errors.join('；'));
  }

  const finalChecks = requiredChecksFromRuleset(finalRuleset);
  const pending = contract.github.requiredChecks.filter(
    (name) => !finalChecks.some((check) => check.context === name),
  );
  if (pending.length > 0) {
    return result(
      newlyObserved.length > 0 ? 'checks-activated' : 'waiting-for-checks',
      6,
      repository,
      branch,
      finalRuleset,
      contract,
      {
        ...releaseState,
        pullRequest: pullRequest.number,
        message:
          `仍等待默认分支可信工作流产生检查：${pending.join('、')}。` +
          `Bootstrap PR 可先启用 quality-gate；${POLICY_GUARD_REQUIRED_CHECK} ` +
          '必须在工作流进入默认分支后的 Activation PR 中启用。',
      },
    );
  }
  const errors = validateManagedRuleset(finalRuleset, finalChecks, requiredCodeScanning);
  if (errors.length > 0) throw new GitHubQualityError('最终 Ruleset 核验失败', errors.join('；'));
  return result('ready', 0, repository, branch, finalRuleset, contract, {
    ...releaseState,
    pullRequest: pullRequest.number,
    message: '质量契约、本地托管文件和 GitHub 默认分支 Ruleset 已全部回读确认。',
  });
}
