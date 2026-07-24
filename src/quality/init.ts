import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { writeFileAtomicSync } from '../engine/fs-atomic.js';
import {
  currentPackageVersion,
  readManagedQualityAsset,
  type ManagedQualityAsset,
} from './assets.js';
import {
  parseQualityContract,
  parseQualityExceptions,
  readQualityContract,
  readQualityExceptions,
  QUALITY_CONTRACT_PATH,
} from './contract.js';
import {
  GitHubClient,
  QUALITY_RELEASE_RULESET_NAME,
  QUALITY_RULESET_NAME,
  qualityBranchRulesetPayload,
  qualityReleaseRulesetPayload,
  verifyQualityBranchRuleset,
  verifyQualityReleaseRuleset,
} from './github.js';
import {
  defaultBranch,
  repositoryFromRemote,
  resolveGitRoot,
} from './git.js';
import type {
  QualityCheck,
  QualityContractV1,
} from './types.js';

const MANAGED_ASSETS: Array<{
  source: ManagedQualityAsset;
  destination: string;
}> = [
  {
    source: 'github/coding-x-project-checks.yml',
    destination: join('.github', 'workflows', 'coding-x-project-checks.yml'),
  },
  {
    source: 'github/coding-x-review.yml',
    destination: join('.github', 'workflows', 'coding-x-review.yml'),
  },
  {
    source: 'github/coding-x-doctor.yml',
    destination: join('.github', 'workflows', 'coding-x-doctor.yml'),
  },
  {
    source: 'github/pull_request_template.md',
    destination: join('.github', 'pull_request_template.md'),
  },
];

export interface QualityCandidate {
  id: string;
  command: string;
  cwd: string;
  paths: string[];
  reason: string;
}

export interface QualityInitOverrides {
  checks?: QualityCheck[];
  specSources?: string[];
  standardsSources?: string[];
  repository?: string;
  defaultBranch?: string;
  model?: string;
  releaseRefs?: string[];
}

export interface QualityInitFile {
  path: string;
  content: string;
  action: 'create' | 'update' | 'unchanged';
}

export interface QualityInitPlan {
  root: string;
  contract: QualityContractV1;
  candidates: QualityCandidate[];
  files: QualityInitFile[];
}

function compareVersions(left: string, right: string): number {
  const parts = (value: string) => {
    const [core, prerelease = ''] = value.split('-', 2);
    return {
      numbers: core.split('.').map(Number),
      prerelease,
    };
  };
  const a = parts(left);
  const b = parts(right);
  for (let index = 0; index < 3; index++) {
    if (a.numbers[index] !== b.numbers[index]) return a.numbers[index] - b.numbers[index];
  }
  if (a.prerelease === b.prerelease) return 0;
  if (a.prerelease === '') return 1;
  if (b.prerelease === '') return -1;
  return a.prerelease.localeCompare(b.prerelease);
}

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (typeof value === 'object' && value !== null) {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

function packageScripts(root: string): Record<string, string> {
  try {
    const value = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')) as {
      scripts?: unknown;
    };
    if (!value.scripts || typeof value.scripts !== 'object' || Array.isArray(value.scripts)) return {};
    return Object.fromEntries(
      Object.entries(value.scripts)
        .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
    );
  } catch {
    return {};
  }
}

function makeTargets(root: string): Set<string> {
  let raw: string;
  try {
    raw = readFileSync(join(root, 'Makefile'), 'utf8');
  } catch {
    return new Set();
  }
  return new Set(
    raw.split(/\r?\n/).flatMap((line) => {
      const match = /^([A-Za-z0-9_.-]+)\s*:(?![=])/.exec(line);
      return match ? [match[1]] : [];
    }),
  );
}

export function discoverQualityCandidates(root: string): QualityCandidate[] {
  const candidates: QualityCandidate[] = [];
  const scripts = packageScripts(root);
  if (Object.keys(scripts).length > 0) {
    if (existsSync(join(root, 'package-lock.json'))) {
      candidates.push({
        id: 'install',
        command: 'npm ci',
        cwd: '.',
        paths: ['.'],
        reason: '检测到 npm lockfile',
      });
    }
    for (const name of ['typecheck', 'test', 'build', 'lint'] as const) {
      if (scripts[name]) {
        candidates.push({
          id: name,
          command: `npm run ${name}`,
          cwd: '.',
          paths: ['.'],
          reason: `检测到 package.json scripts.${name}`,
        });
      }
    }
  }
  if (existsSync(join(root, 'pyproject.toml'))
    || existsSync(join(root, 'pytest.ini'))
    || existsSync(join(root, 'tests'))) {
    candidates.push({
      id: 'python-test',
      command: 'python -m pytest -q',
      cwd: '.',
      paths: ['.'],
      reason: '检测到 Python 项目或 tests 目录',
    });
  }
  if (existsSync(join(root, 'go.mod'))) {
    candidates.push({
      id: 'go-test',
      command: 'go test ./...',
      cwd: '.',
      paths: ['.'],
      reason: '检测到 go.mod',
    });
    candidates.push({
      id: 'go-vet',
      command: 'go vet ./...',
      cwd: '.',
      paths: ['.'],
      reason: '检测到 go.mod',
    });
  }
  const targets = makeTargets(root);
  for (const target of ['test', 'check', 'lint', 'build']) {
    if (targets.has(target)
      && !candidates.some((candidate) => candidate.id === target
        || candidate.id.endsWith(`-${target}`))) {
      candidates.push({
        id: `make-${target}`,
        command: `make ${target}`,
        cwd: '.',
        paths: ['.'],
        reason: `检测到 Makefile ${target} target`,
      });
    }
  }
  const seen = new Set<string>();
  return candidates.filter((candidate) => {
    if (seen.has(candidate.id)) return false;
    seen.add(candidate.id);
    return true;
  });
}

function existingSources(root: string, candidates: string[]): string[] {
  return candidates.filter((path) => {
    if (!existsSync(join(root, path))) return false;
    try {
      if (readdirSync(join(root, path), { withFileTypes: true }).length === 0) return false;
    } catch {
      // It is a file.
    }
    return true;
  });
}

function generatedContract(
  root: string,
  candidates: QualityCandidate[],
  overrides: QualityInitOverrides,
): QualityContractV1 {
  const checks = overrides.checks ?? candidates.map(({ id, command, cwd, paths }) => ({
    id, command, cwd, paths,
  }));
  if (checks.length === 0) {
    throw new Error('没有发现可重复执行的项目检查；请用 --check 明确提供至少一条命令');
  }
  const specSources = overrides.specSources ?? existingSources(root, [
    'docs/specs/', 'docs/prds/', 'SPEC.md',
  ]);
  if (specSources.length === 0) {
    throw new Error('没有发现 Spec 来源；请先建立规格文件，或用 --spec-source 明确选择');
  }
  const standardsSources = overrides.standardsSources ?? existingSources(root, [
    'AGENTS.md', 'CONTRIBUTING.md', 'docs/golden-principles.md', 'docs/patterns.md',
  ]);
  if (standardsSources.length === 0) {
    throw new Error('没有发现工程标准来源；请先建立项目规范，或用 --standards-source 明确选择');
  }
  const repository = overrides.repository ?? repositoryFromRemote(root);
  if (!repository) {
    throw new Error('无法从 origin 识别 GitHub 仓库；请用 --repository owner/repo 明确提供');
  }
  const branch = overrides.defaultBranch ?? defaultBranch(root);
  const value: QualityContractV1 = {
    version: 1,
    checks,
    review: {
      model: overrides.model ?? 'openai/gpt-4.1',
      specSources,
      standardsSources,
      deepReview: {
        highRiskPaths: [
          '.coding-x/',
          '.github/workflows/',
          'migrations/',
          'security/',
        ],
        changedProductionLines: 400,
        largeFileLines: 1000,
      },
    },
    github: {
      repository,
      defaultBranch: branch,
      releaseRefs: overrides.releaseRefs ?? [],
      codingXVersion: currentPackageVersion(),
      requiredChecks: [
        'coding-x / project-checks',
        'coding-x / spec-review',
        'coding-x / standards-review',
        'coding-x / deep-review',
      ],
    },
    exceptionPolicy: {
      deferrableSeverities: ['medium'],
    },
    exceptionsFile: join('.coding-x', 'exceptions.json'),
  };
  const parsed = parseQualityContract(value, root);
  if (parsed.status === 'invalid') {
    throw new Error(`生成的质量契约无效：${parsed.errors.join('；')}`);
  }
  return parsed.contract;
}

function priorManagedVersion(source: ManagedQualityAsset, content: string): string | null {
  const match = /coding-x@(\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?)/.exec(content);
  if (!match) return null;
  return readManagedQualityAsset(source, match[1]) === content ? match[1] : null;
}

function plannedFile(
  root: string,
  path: string,
  content: string,
  source?: ManagedQualityAsset,
): QualityInitFile {
  const absolute = join(root, path);
  if (!existsSync(absolute)) return { path, content, action: 'create' };
  const current = readFileSync(absolute, 'utf8');
  if (current === content) return { path, content, action: 'unchanged' };
  if (source && priorManagedVersion(source, current)) {
    return { path, content, action: 'update' };
  }
  throw new Error(`拒绝覆盖已有且非受管内容：${path}`);
}

function plannedWorkspaceIgnore(root: string): QualityInitFile {
  const path = '.gitignore';
  const marker = '/.workspace/';
  const absolute = join(root, path);
  if (!existsSync(absolute)) {
    return { path, content: `${marker}\n`, action: 'create' };
  }
  const current = readFileSync(absolute, 'utf8');
  const alreadyIgnored = current.split(/\r?\n/).some((line) =>
    ['.workspace', '.workspace/', '/.workspace', '/.workspace/'].includes(line.trim()));
  if (alreadyIgnored) return { path, content: current, action: 'unchanged' };
  const separator = current === '' || current.endsWith('\n') ? '' : '\n';
  return {
    path,
    content: `${current}${separator}${marker}\n`,
    action: 'update',
  };
}

export function buildQualityInitPlan(
  cwd: string,
  overrides: QualityInitOverrides = {},
): QualityInitPlan {
  const root = resolveGitRoot(cwd);
  const canonicalCwd = realpathSync(cwd);
  const canonicalRoot = realpathSync(root);
  if (canonicalRoot !== canonicalCwd) {
    throw new Error(`quality init 必须在 Git 仓库根执行：${root}`);
  }
  const candidates = discoverQualityCandidates(root);
  const existing = readQualityContract(root);
  let contract: QualityContractV1;
  let contractFile: QualityInitFile;
  if (existing.status === 'valid') {
    if (Object.keys(overrides).length > 0) {
      throw new Error('已有质量契约；初始化参数不会静默改写既有政策，请直接审阅契约后再升级');
    }
    const currentVersion = currentPackageVersion();
    const comparison = compareVersions(currentVersion, existing.contract.github.codingXVersion);
    if (comparison < 0) {
      throw new Error(
        `拒绝用旧版 coding-x ${currentVersion} 降级门禁 ${existing.contract.github.codingXVersion}`,
      );
    }
    contract = comparison === 0
      ? existing.contract
      : {
          ...existing.contract,
          github: {
            ...existing.contract.github,
            codingXVersion: currentVersion,
          },
        };
    const content = comparison === 0
      ? existing.raw
      : `${JSON.stringify(contract, null, 2)}\n`;
    contractFile = {
      path: QUALITY_CONTRACT_PATH,
      content,
      action: comparison === 0 ? 'unchanged' : 'update',
    };
  } else if (existing.status === 'invalid') {
    throw new Error(`已有质量契约无效，拒绝覆盖：${existing.errors.join('；')}`);
  } else {
    contract = generatedContract(root, candidates, overrides);
    contractFile = plannedFile(
      root,
      QUALITY_CONTRACT_PATH,
      `${JSON.stringify(contract, null, 2)}\n`,
    );
  }
  const exceptionsContent = `${JSON.stringify({
    version: 1,
    exceptions: [],
    deliveries: [],
  }, null, 2)}\n`;
  const existingExceptions = readQualityExceptions(root, contract.exceptionsFile);
  let exceptionsFile: QualityInitFile;
  if (existingExceptions.status === 'valid') {
    exceptionsFile = {
      path: contract.exceptionsFile,
      content: readFileSync(join(root, contract.exceptionsFile), 'utf8'),
      action: 'unchanged',
    };
  } else if (existingExceptions.status === 'invalid') {
    throw new Error(`已有异常记录无效，拒绝覆盖：${existingExceptions.errors.join('；')}`);
  } else {
    exceptionsFile = plannedFile(root, contract.exceptionsFile, exceptionsContent);
  }
  const managed = MANAGED_ASSETS.map(({ source, destination }) =>
    plannedFile(
      root,
      destination,
      readManagedQualityAsset(source, contract.github.codingXVersion),
      source,
    ));
  return {
    root,
    contract,
    candidates,
    files: [contractFile, exceptionsFile, plannedWorkspaceIgnore(root), ...managed],
  };
}

export function renderQualityInitPreview(plan: QualityInitPlan, localOnly: boolean): string {
  return [
    `项目：${plan.contract.github.repository}`,
    `默认分支：${plan.contract.github.defaultBranch}`,
    `coding-x 固定版本：${plan.contract.github.codingXVersion}`,
    '项目检查：',
    ...plan.contract.checks.map((check) => `  - ${check.id}: (${check.cwd}) ${check.command}`),
    '评审来源：',
    `  - Spec: ${plan.contract.review.specSources.join(', ')}`,
    `  - Standards: ${plan.contract.review.standardsSources.join(', ')}`,
    '文件变更：',
    ...plan.files.map((file) => `  - ${file.action}: ${file.path}`),
    `远端规则：${localOnly ? '本次不配置（最终状态 unverifiable）' : '配置并回读核验'}`,
  ].join('\n');
}

export function applyQualityInitFiles(plan: QualityInitPlan): string[] {
  const changed = plan.files.filter((file) => file.action !== 'unchanged');
  const backups = new Map<string, string | null>();
  try {
    for (const file of changed) {
      const absolute = join(plan.root, file.path);
      backups.set(absolute, existsSync(absolute) ? readFileSync(absolute, 'utf8') : null);
      mkdirSync(dirname(absolute), { recursive: true });
      writeFileAtomicSync(absolute, file.content);
    }
    return changed.map((file) => file.path);
  } catch (error) {
    for (const [path, previous] of [...backups].reverse()) {
      try {
        if (previous === null) rmSync(path, { force: true });
        else writeFileAtomicSync(path, previous);
      } catch {
        // Preserve the original error; rollback is best effort.
      }
    }
    throw error;
  }
}

export interface RemoteQualityResult {
  status: 'passed' | 'unverifiable';
  repository: string;
  requiredApprovals: number;
  integrationId: number | null;
  rulesets: Array<{ name: string; id: number }>;
  errors: string[];
}

export interface RemoteQualityPreview {
  repository: string;
  defaultBranch: string;
  requiredApprovals: number;
  integrationId: number | null;
  currentRulesets: Array<{
    id: number;
    name: string;
    target: string;
    enforcement: string;
  }>;
  proposedRulesets: string[];
  errors: string[];
}

async function verifyRemoteManagedBase(
  client: GitHubClient,
  contract: QualityContractV1,
): Promise<string[]> {
  const errors: string[] = [];
  const ref = contract.github.defaultBranch;
  try {
    const remoteContract = JSON.parse(
      await client.getTextFile(QUALITY_CONTRACT_PATH, ref, 512 * 1024),
    ) as unknown;
    if (stableJson(remoteContract) !== stableJson(contract)) {
      errors.push('默认分支质量契约与待配置契约不一致');
    }
  } catch (error) {
    errors.push(`默认分支缺少可核验的质量契约：${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    const remoteExceptions = parseQualityExceptions(JSON.parse(
      await client.getTextFile(
        contract.exceptionsFile.replace(/\\/g, '/'),
        ref,
        512 * 1024,
      ),
    ));
    if (remoteExceptions.status !== 'valid') {
      errors.push(`默认分支异常记录无效：${remoteExceptions.errors.join('；')}`);
    }
  } catch (error) {
    errors.push(`默认分支缺少可核验的异常记录：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const { source, destination } of MANAGED_ASSETS) {
    try {
      const actual = await client.getTextFile(
        destination.replace(/\\/g, '/'),
        ref,
        512 * 1024,
      );
      const expected = readManagedQualityAsset(source, contract.github.codingXVersion);
      if (actual !== expected) errors.push(`默认分支受管文件漂移：${destination}`);
    } catch (error) {
      errors.push(
        `默认分支缺少受管文件 ${destination}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return errors;
}

export async function previewRemoteQuality(opts: {
  contract: QualityContractV1;
  token: string;
  client?: GitHubClient;
}): Promise<RemoteQualityPreview> {
  const contract = opts.contract;
  const client = opts.client
    ?? new GitHubClient(opts.token, contract.github.repository);
  try {
    const [repository, collaborators, integrationId, currentRulesets] = await Promise.all([
      client.getRepository(),
      client.countAdditionalPushCollaborators(),
      client.discoverGitHubActionsIntegrationId(contract.github.defaultBranch),
      client.listRulesets(),
    ]);
    const errors: string[] = [];
    if (repository.fullName !== contract.github.repository) {
      errors.push(`远端仓库身份不匹配：${repository.fullName}`);
    }
    if (repository.defaultBranch !== contract.github.defaultBranch) {
      errors.push(`远端默认分支不匹配：${repository.defaultBranch}`);
    }
    if (integrationId === null) {
      errors.push('默认分支尚无 GitHub Actions Check Run，暂不能绑定检查来源');
    }
    errors.push(...await verifyRemoteManagedBase(client, contract));
    return {
      repository: repository.fullName,
      defaultBranch: repository.defaultBranch,
      requiredApprovals: collaborators > 0 ? 1 : 0,
      integrationId,
      currentRulesets,
      proposedRulesets: [
        QUALITY_RULESET_NAME,
        ...(contract.github.releaseRefs.length > 0 ? [QUALITY_RELEASE_RULESET_NAME] : []),
      ],
      errors,
    };
  } catch (error) {
    return {
      repository: contract.github.repository,
      defaultBranch: contract.github.defaultBranch,
      requiredApprovals: 0,
      integrationId: null,
      currentRulesets: [],
      proposedRulesets: [
        QUALITY_RULESET_NAME,
        ...(contract.github.releaseRefs.length > 0 ? [QUALITY_RELEASE_RULESET_NAME] : []),
      ],
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}

export async function configureRemoteQuality(opts: {
  contract: QualityContractV1;
  token: string;
  client?: GitHubClient;
}): Promise<RemoteQualityResult> {
  const contract = opts.contract;
  const client = opts.client
    ?? new GitHubClient(opts.token, contract.github.repository);
  const errors: string[] = [];
  const rulesets: Array<{ name: string; id: number }> = [];
  try {
    const repository = await client.getRepository();
    if (repository.fullName !== contract.github.repository) {
      errors.push(`远端仓库身份不匹配：${repository.fullName}`);
    }
    if (repository.defaultBranch !== contract.github.defaultBranch) {
      errors.push(`远端默认分支不匹配：${repository.defaultBranch}`);
    }
    const collaborators = await client.countAdditionalPushCollaborators();
    const requiredApprovals = collaborators > 0 ? 1 : 0;
    const integrationId = await client.discoverGitHubActionsIntegrationId(
      contract.github.defaultBranch,
    );
    if (integrationId === null) {
      return {
        status: 'unverifiable',
        repository: contract.github.repository,
        requiredApprovals,
        integrationId,
        rulesets,
        errors: [
          ...errors,
          '默认分支尚无 GitHub Actions Check Run，无法绑定 required checks 的可信应用来源',
        ],
      };
    }
    if (errors.length > 0) {
      return {
        status: 'unverifiable',
        repository: contract.github.repository,
        requiredApprovals,
        integrationId,
        rulesets,
        errors,
      };
    }
    const bootstrapErrors = await verifyRemoteManagedBase(client, contract);
    if (bootstrapErrors.length > 0) {
      return {
        status: 'unverifiable',
        repository: contract.github.repository,
        requiredApprovals,
        integrationId,
        rulesets,
        errors: [
          '远端规则尚未启用；请先把质量契约和受管工作流合并到默认分支',
          ...bootstrapErrors,
        ],
      };
    }
    const requiredChecks = contract.github.requiredChecks.map((context) => ({
      context,
      integration_id: integrationId,
    }));
    if (contract.github.releaseRefs.length > 0) {
      const release = await client.upsertRuleset(
        QUALITY_RELEASE_RULESET_NAME,
        qualityReleaseRulesetPayload(contract.github.releaseRefs),
      );
      rulesets.push({ name: release.name, id: release.id });
      errors.push(...verifyQualityReleaseRuleset(release, contract.github.releaseRefs));
      if (errors.length > 0) {
        return {
          status: 'unverifiable',
          repository: contract.github.repository,
          requiredApprovals,
          integrationId,
          rulesets,
          errors,
        };
      }
    }
    const branch = await client.upsertRuleset(
      QUALITY_RULESET_NAME,
      qualityBranchRulesetPayload(
        contract.github.defaultBranch,
        requiredChecks,
        requiredApprovals,
      ),
    );
    rulesets.push({ name: branch.name, id: branch.id });
    errors.push(...verifyQualityBranchRuleset(branch, {
      branch: contract.github.defaultBranch,
      requiredChecks,
      requiredApprovals,
    }));
    return {
      status: errors.length === 0 ? 'passed' : 'unverifiable',
      repository: contract.github.repository,
      requiredApprovals,
      integrationId,
      rulesets,
      errors,
    };
  } catch (error) {
    return {
      status: 'unverifiable',
      repository: contract.github.repository,
      requiredApprovals: 0,
      integrationId: null,
      rulesets,
      errors: [error instanceof Error ? error.message : String(error)],
    };
  }
}
