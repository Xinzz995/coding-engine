import { existsSync, lstatSync, opendirSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { AgentKind } from '../engine/agent.js';
import { execTrustedToolSync } from '../engine/trusted-tool.js';
import { readGlobalModelConfig, resolveGlobalConfigPath } from '../engine/model-catalog.js';
import { readModelRouting } from '../engine/models.js';
import { tryReadPrd, validatePrdStoryDefinitions } from '../engine/prd.js';
import { isPidAlive, readLockInfo, LOCK_FILE } from '../engine/lock.js';
import { checkTddPolicy, readTddConfig } from '../engine/tdd-gate.js';
import { readSafeProjectFileUtf8Sync } from '../engine/safe-control-file.js';
import {
  assessQualityRuntime,
  deriveQualityChecks,
  qualityChecksMatchContract,
  readQualityContract,
  type FrozenQualityChecks,
  type QualityContract,
} from '../quality/contract.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { checkDeliveryGate, type DeliveryGateCheckResult } from './delivery.js';
import { CODING_X_VERSION } from '../version.js';

export interface DoctorIssue {
  file: string;
  message: string;
}

export interface FrontmatterCheckResult {
  scanned: number;
  checked: number;
  issues: DoctorIssue[];
}

export interface FreshnessCheckResult {
  staleDays: number;
  gitAvailable: boolean;
  checked: number;
  /** docs/archive/ 下带 frontmatter 的冷档案数量；只跳过 updated 新鲜度，其他检查照常。 */
  archivedSkipped: number;
  issues: DoctorIssue[];
}

export interface AgentsIndexCheckResult {
  /** 项目根是否存在 AGENTS.md；不存在时跳过本项检查，不计失败 */
  agentsFound: boolean;
  checked: number;
  issues: DoctorIssue[];
}

export interface LinksCheckResult {
  checked: number;
  issues: DoctorIssue[];
}

export interface DoctorOptions {
  /** git 最后提交日期晚于 updated 超过该天数判过期；0 表示晚一天即过期。缺省 30。 */
  staleDays?: number;
  /** 引擎工作区目录（相对项目根），门禁配置检查用。缺省 .workspace。 */
  workspace?: string;
  /** 全局模型目录路径；测试/隔离环境可显式注入，缺省遵循 CODING_X_CONFIG 或固定用户目录。 */
  modelConfigPath?: string;
  /** 实际 coding-x 版本；生产缺省构建内版本。 */
  actualVersion?: string;
  /** 独立单元测试可关闭本项；CLI 不设置，生产始终要求质量契约。 */
  requireQualityContract?: boolean;
  /** 只核对本地契约与生成物，不查询 GitHub。 */
  local?: boolean;
  /** 测试或其他适配器注入；生产缺省复用 gh 登录。 */
  githubClient?: GitHubQualityClient;
  /** 例外到期检查的时钟；生产缺省当前时间。 */
  now?: Date;
}

export interface QualityContractCheckResult {
  contractPath: string;
  prdPath: string;
  status: 'skipped' | 'missing' | 'invalid' | 'version-mismatch' | 'ready';
  digest: string | null;
  /** prd-to-json 应原样写入 prd.json.qualityChecks 的机器派生快照。 */
  derivedChecks: FrozenQualityChecks | null;
  configuredChecks: number;
  notApplicableCategories: string[];
  prdFound: boolean;
  prdDigestMatches: boolean | null;
  prdChecksMatch: boolean | null;
  issues: DoctorIssue[];
}

const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] as const;

function git(root: string, args: readonly string[]): string {
  return execTrustedToolSync('git', [...SAFE_GIT_CONFIG, ...args], {
    cwd: root,
    projectRoot: root,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

export interface TddConfigCheckResult {
  /** 展示用的 workspace/prd.json 路径。 */
  prdPath: string;
  status: 'missing' | 'disabled' | 'invalid' | 'ready' | 'policy-error';
  /** 非空即为必须修复的配置/政策完整性问题；doctor 计入失败。 */
  issues: DoctorIssue[];
}

export interface LockCheckResult {
  /** engine.lock 是否存在；不存在=无引擎实例在运行，正常态 */
  found: boolean;
  /** 存在时：持锁 pid 已死或锁损坏（stale，上次异常退出遗留）；引擎运行中为 false */
  stale: boolean;
  pid: number | null;
}

export interface WorkspaceGitCheckResult {
  /** 展示用的 workspace 路径（默认 .workspace）。 */
  workspacePath: string;
  /** workspace 目录当前是否存在。 */
  workspaceFound: boolean;
  /** 项目根是否位于 Git worktree 内；false 时其余 Git 检查跳过。 */
  gitAvailable: boolean;
  /** workspace 是否位于项目根所属的同一个 Git worktree 内。 */
  insideRepository: boolean;
  /** workspace 目录是否命中 Git ignore 规则（即使目录尚未创建也可判定）。 */
  ignored: boolean;
  /** workspace 下已经进入 Git 索引的文件（Git worktree 相对路径）。 */
  trackedFiles: string[];
}

export interface ModelCatalogCheckResult {
  /** 展示用的 workspace/prd.json 路径。 */
  prdPath: string;
  /** prd.json 是否存在；不存在时仅跳过项目映射复核，已有全局配置仍校验。 */
  prdFound: boolean;
  /** prd.json 是否启用了完整有效的 models 路由。 */
  routingEnabled: boolean;
  /** 启用路由时绑定的 runner。 */
  runner: AgentKind | null;
  /** 实际读取（或本应读取）的全局模型目录路径。 */
  configPath: string;
  /** 配置文件的静态读取状态；missing 在当前项目无需路由时不计失败。 */
  configStatus: 'missing' | 'available' | 'error';
  /** schema 合法时，各个已声明 runner 的目录条目数。 */
  configuredRunners: Array<{ runner: AgentKind; count: number }>;
  /** 成功读取目录后核对的项目模型位置数；完整路由固定为五项。 */
  checked: number;
  /** 配置缺失/非法、runner 空目录、项目模型未声明等机械失败。 */
  issues: DoctorIssue[];
}

export interface DoctorReport {
  docsFound: boolean;
  frontmatter: FrontmatterCheckResult | null;
  freshness: FreshnessCheckResult | null;
  agentsIndex: AgentsIndexCheckResult | null;
  links: LinksCheckResult | null;
  quality: QualityContractCheckResult;
  delivery: DeliveryGateCheckResult;
  tdd: TddConfigCheckResult;
  modelCatalog: ModelCatalogCheckResult;
  workspaceGit: WorkspaceGitCheckResult;
  lock: LockCheckResult;
}

const REQUIRED_FIELDS = ['title', 'status', 'updated', 'scope'] as const;
const DEFAULT_STALE_DAYS = 30;
const DAY_MS = 86_400_000;
const DOCTOR_DIRECTORY_ENTRY_LIMIT = 4_096;
const DOCTOR_MARKDOWN_FILE_LIMIT = 2_048;
const DOCTOR_DIRECTORY_DEPTH_LIMIT = 64;
const DOCTOR_MARKDOWN_FILE_MAX_BYTES = 4 * 1024 * 1024;
const DOCTOR_MARKDOWN_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
const AGENTS_FILE_MAX_BYTES = 1024 * 1024;

/**
 * 简单行解析（零依赖，ADR 见 PRD 技术考量）：内容须以 `---` 行开头，
 * 到下一个 `---` 行为止，块内提取 `key: value`。无块或未闭合返回 null。
 */
export function parseFrontmatter(content: string): Record<string, string> | null {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return null;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  if (end === -1) return null;
  const fm: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (m) fm[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, '$2');
  }
  return fm;
}

/** frontmatter 块之后的正文；无块或未闭合时原样返回。 */
function bodyAfterFrontmatter(content: string): string {
  const lines = content.replace(/^\uFEFF/, '').split(/\r?\n/);
  if (lines[0]?.trim() !== '---') return content;
  const end = lines.findIndex((line, i) => i > 0 && line.trim() === '---');
  return end === -1 ? content : lines.slice(end + 1).join('\n');
}

/** 剥掉 fenced code block 与行内 code span——其中的 [text](target) 是字面文本，不是 markdown 链接。 */
function stripCodeSegments(content: string): string {
  const kept: string[] = [];
  let inFence = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (!inFence) kept.push(line);
  }
  return kept.join('\n').replace(/`[^`\n]*`/g, '');
}

/**
 * 相对路径判定：无空格、不以 / 或 - 开头（排除绝对路径与 `--flag`），
 * 且含目录分隔符或字母扩展名（排除 `npm test`、`0.6.0` 这类非路径反引号内容）。
 */
function isRelativePathLike(value: string): boolean {
  if (value === '' || /\s/.test(value)) return false;
  if (value.startsWith('/') || value.startsWith('-')) return false;
  return value.includes('/') || /\.[A-Za-z][A-Za-z0-9]*$/.test(value);
}

/**
 * 从 AGENTS.md 的 markdown 表格行中提取反引号包裹的相对路径（去重）。
 * 只认「整个单元格 trim 后正好是一个反引号 token」的情况——即路径独占整格；
 * 说明列散文里内嵌的反引号路径（单元格内还有其他文字）不是索引项，不提取。
 */
export function extractAgentsIndexPaths(content: string): string[] {
  const paths = new Set<string>();
  for (const line of content.split(/\r?\n/)) {
    if (!line.trimStart().startsWith('|')) continue; // 只解析表格行
    for (const cell of line.split('|')) {
      const trimmed = cell.trim();
      const m = trimmed.match(/^`([^`]+)`$/); // 反引号 token 必须独占整格
      if (!m) continue;
      const candidate = m[1].trim();
      if (isRelativePathLike(candidate)) paths.add(candidate);
    }
  }
  return [...paths];
}

/** 提取正文中 markdown 内联链接 [text](target) 的 target（含图片链接；不含 reference-style）。 */
export function extractInlineLinkTargets(content: string): string[] {
  const targets: string[] = [];
  for (const m of stripCodeSegments(content).matchAll(/\[[^\]]*\]\(\s*([^)\s]+)(?:\s+[^)]*)?\)/g)) {
    targets.push(m[1]);
  }
  return targets;
}

function walkMarkdownFiles(root: string): { files: string[]; issues: DoctorIssue[] } {
  const files: string[] = [];
  const issues: DoctorIssue[] = [];
  const pending = [{ dir: root, depth: 0 }];
  let entries = 0;
  while (pending.length > 0) {
    const current = pending.pop()!;
    let handle: ReturnType<typeof opendirSync> | null = null;
    try {
      handle = opendirSync(current.dir);
      let entry = handle.readSync();
      while (entry !== null) {
        entries += 1;
        if (entries > DOCTOR_DIRECTORY_ENTRY_LIMIT) {
          issues.push({
            file: relative(dirname(root), root),
            message: `目录条目超过 ${DOCTOR_DIRECTORY_ENTRY_LIMIT} 个，已停止扫描`,
          });
          return { files: files.sort(), issues };
        }
        const full = join(current.dir, entry.name);
        if (entry.isSymbolicLink()) {
          issues.push({
            file: relative(dirname(root), full),
            message: '文档目录不读取软链',
          });
        } else if (entry.isDirectory()) {
          if (current.depth >= DOCTOR_DIRECTORY_DEPTH_LIMIT) {
            issues.push({
              file: relative(dirname(root), full),
              message: `目录深度超过 ${DOCTOR_DIRECTORY_DEPTH_LIMIT} 层，已停止向下扫描`,
            });
          } else {
            pending.push({ dir: full, depth: current.depth + 1 });
          }
        } else if (entry.isFile() && entry.name.endsWith('.md')) {
          files.push(full);
          if (files.length > DOCTOR_MARKDOWN_FILE_LIMIT) {
            issues.push({
              file: relative(dirname(root), root),
              message: `Markdown 文件超过 ${DOCTOR_MARKDOWN_FILE_LIMIT} 个，已停止扫描`,
            });
            return { files: files.slice(0, DOCTOR_MARKDOWN_FILE_LIMIT).sort(), issues };
          }
        } else if (entry.name.endsWith('.md')) {
          issues.push({
            file: relative(dirname(root), full),
            message: 'Markdown 路径不是普通文件',
          });
        }
        entry = handle.readSync();
      }
    } catch (error) {
      issues.push({
        file: relative(dirname(root), current.dir),
        message: `目录不可读取：${error instanceof Error ? error.message : String(error)}`,
      });
    } finally {
      try {
        handle?.closeSync();
      } catch {
        // 扫描失败已经记录；关闭错误不覆盖原诊断。
      }
    }
  }
  return { files: files.sort(), issues };
}

/** 严格 YYYY-MM-DD → UTC 毫秒；格式不符或日期不存在（如 2026-13-01）返回 null。 */
function parseDateUTC(value: string): number | null {
  const m = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return null;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const ts = Date.UTC(y, mo - 1, d);
  const dt = new Date(ts);
  const valid = dt.getUTCFullYear() === y && dt.getUTCMonth() === mo - 1 && dt.getUTCDate() === d;
  return valid ? ts : null;
}

function isGitWorkTree(root: string): boolean {
  try {
    const out = git(root, ['rev-parse', '--is-inside-work-tree']);
    return out.trim() === 'true';
  } catch {
    return false;
  }
}

/**
 * 只读检查运行时 workspace 是否与 story commit 隔离。ignore 规则只能阻止
 * 新文件进入索引，所以已跟踪文件必须单独列出，且由用户决定如何停止跟踪。
 */
export function checkWorkspaceGitIsolation(
  root: string,
  workspace: string,
): WorkspaceGitCheckResult {
  const workspacePath = workspace;
  // macOS 的临时目录常同时以 /var 与 /private/var 表示；比较仓库边界前先消除该别名。
  const canonicalRoot = realpathSync(root);
  const unresolvedWorkspace = resolve(canonicalRoot, workspace);
  const workspaceAbs = existsSync(unresolvedWorkspace)
    ? realpathSync(unresolvedWorkspace)
    : unresolvedWorkspace;
  const base: WorkspaceGitCheckResult = {
    workspacePath,
    workspaceFound: existsSync(workspaceAbs),
    gitAvailable: false,
    insideRepository: false,
    ignored: false,
    trackedFiles: [],
  };

  try {
    git(root, ['rev-parse', '--is-inside-work-tree']);
  } catch {
    return base;
  }

  // 以调用目录为相对基准，不比较 Git 输出的绝对路径。Windows runner 可能让 Node 返回
  // 8.3 短路径、Git 返回长路径；二者指向同一目录却不能按字符串比较。
  const relFromProjectRoot = relative(canonicalRoot, workspaceAbs);
  const insideRepository =
    relFromProjectRoot === '' ||
    (!isAbsolute(relFromProjectRoot) &&
      relFromProjectRoot !== '..' &&
      !relFromProjectRoot.startsWith(`..${sep}`));
  if (!insideRepository) return { ...base, gitAvailable: true };

  // Git 的 pathspec 固定使用正斜杠；workspace=仓库根时不能把整个仓库误列为运行时文件。
  const pathspec = relFromProjectRoot.split(sep).join('/');
  let trackedFiles: string[] = [];
  if (pathspec !== '') {
    try {
      const tracked = git(root, ['ls-files', '-z', '--', pathspec]);
      trackedFiles = tracked.split('\0').filter(Boolean).sort();
    } catch {
      // rev-parse 已确认仓库；单项查询失败时保守地保持空列表并继续给出 ignore 建议。
    }
  }

  let ignored = false;
  if (pathspec !== '') {
    try {
      git(root, ['check-ignore', '-q', '--no-index', '--', `${pathspec}/`]);
      ignored = true;
    } catch {
      // exit 1 表示未命中 ignore；其他错误同样不冒充已受保护。
    }
  }

  return {
    ...base,
    gitAvailable: true,
    insideRepository: true,
    ignored,
    trackedFiles,
  };
}

/** 文件在 git 的最后提交日期（%cs，YYYY-MM-DD）；尚无提交记录或 git 失败返回 null。 */
function gitLastCommitDate(root: string, relFile: string): string | null {
  try {
    const out = git(root, ['log', '-1', '--format=%cs', '--', relFile]).trim();
    return out === '' ? null : out;
  } catch {
    return null;
  }
}

/**
 * 全局目录是用户声明的允许集合，不是 provider 在线探测。存在配置文件时始终
 * 校验 schema；项目启用 models 路由时，再机械核对五个项目模型。普通零配置
 * 项目允许目录缺失，继续使用 runner 默认模型。
 */
function checkModelCatalog(
  prdPath: string,
  prdDisplayPath: string,
  configPath: string,
): ModelCatalogCheckResult {
  const base: ModelCatalogCheckResult = {
    prdPath: prdDisplayPath,
    prdFound: existsSync(prdPath),
    routingEnabled: false,
    runner: null,
    configPath,
    configStatus: 'missing',
    configuredRunners: [],
    checked: 0,
    issues: [],
  };
  let routing: ReturnType<typeof readModelRouting> | null = null;
  const prdIssues: DoctorIssue[] = [];
  if (base.prdFound) {
    const prd = tryReadPrd(prdPath);
    if (prd === null) {
      prdIssues.push({ file: prdDisplayPath, message: 'prd.json 无法解析，不能检查全局模型目录' });
    } else {
      const storyDefinitions = validatePrdStoryDefinitions(prd);
      if (!storyDefinitions.ok) {
        prdIssues.push({
          file: prdDisplayPath,
          message: `PRD Story 定义无效，不能检查全局模型目录：${storyDefinitions.error}`,
        });
      } else {
        routing = readModelRouting(prd);
        if (routing.status === 'invalid') {
          prdIssues.push(...routing.errors.map((message) => ({ file: prdDisplayPath, message })));
        }
      }
    }
  }

  const enabledRouting = routing?.status === 'enabled' ? routing.config : null;
  const withRouting =
    enabledRouting === null
      ? base
      : { ...base, routingEnabled: true, runner: enabledRouting.runner };
  const config = readGlobalModelConfig(configPath);
  if (config.status === 'error') {
    const missing = !existsSync(configPath);
    const configIssues =
      missing && enabledRouting === null
        ? []
        : config.errors.map((message) => ({ file: configPath, message }));
    return {
      ...withRouting,
      configStatus: missing ? 'missing' : 'error',
      issues: [...prdIssues, ...configIssues],
    };
  }

  const configuredRunners = (
    Object.entries(config.config.models) as Array<
      [AgentKind, NonNullable<(typeof config.config.models)[AgentKind]>]
    >
  ).map(([runner, models]) => ({ runner, count: models.length }));
  const available = {
    ...withRouting,
    configStatus: 'available' as const,
    configuredRunners,
    issues: prdIssues,
  };
  if (enabledRouting === null) return available;

  const runnerModels = config.config.models[enabledRouting.runner] ?? [];
  if (runnerModels.length === 0) {
    return {
      ...available,
      issues: [
        ...prdIssues,
        {
          file: configPath,
          message: `全局模型目录未配置任何模型（runner: ${enabledRouting.runner}）：${configPath}`,
        },
      ],
    };
  }

  const configuredIds = new Set(runnerModels.map((model) => model.id));
  const projectModels: Array<[path: string, model: string]> = [
    ['models.builder.low', enabledRouting.builder.low],
    ['models.builder.medium', enabledRouting.builder.medium],
    ['models.builder.high', enabledRouting.builder.high],
    ['models.validator', enabledRouting.validator],
    ['models.escalation', enabledRouting.escalation],
  ];
  const routingIssues = projectModels
    .filter(([, model]) => !configuredIds.has(model))
    .map(([path, model]) => ({
      file: prdDisplayPath,
      message: `${path} 的模型 ${model} 未在 ${enabledRouting.runner} 全局模型目录中声明`,
    }));
  return { ...available, checked: projectModels.length, issues: [...prdIssues, ...routingIssues] };
}

/** 对项目根 root 只读执行各项健康检查（无 docs/ 时温和降级）。 */
export function runDoctor(root: string, options: DoctorOptions = {}): DoctorReport {
  const staleDays = options.staleDays ?? DEFAULT_STALE_DAYS;
  const workspace = options.workspace ?? '.workspace';
  const prdRel = join(workspace, 'prd.json');
  const prdPath = resolve(root, prdRel);
  const modelConfigPath = options.modelConfigPath ?? resolveGlobalConfigPath();
  const modelCatalog = checkModelCatalog(prdPath, prdRel, modelConfigPath);
  const workspaceGit = checkWorkspaceGitIsolation(root, workspace);
  const requireQuality = options.requireQualityContract ?? true;
  const contractRel = join('.coding-x', 'quality.json');
  let quality: QualityContractCheckResult = {
    contractPath: contractRel,
    prdPath: prdRel,
    status: requireQuality ? 'missing' : 'skipped',
    digest: null,
    derivedChecks: null,
    configuredChecks: 0,
    notApplicableCategories: [],
    prdFound: existsSync(prdPath),
    prdDigestMatches: null,
    prdChecksMatch: null,
    issues: [],
  };
  let qualityContract: QualityContract | null = null;
  if (requireQuality) {
    const contractRead = readQualityContract(root);
    if (contractRead.status === 'missing') {
      quality.issues.push({ file: contractRel, message: '质量契约不存在；请先运行 coding-x init' });
    } else if (contractRead.status !== 'ready') {
      const details =
        contractRead.status === 'invalid' ? contractRead.errors : [contractRead.error];
      quality = {
        ...quality,
        status: 'invalid',
        issues: details.map((message) => ({ file: contractRel, message })),
      };
    } else {
      qualityContract = contractRead.contract;
      const runtime = assessQualityRuntime(
        contractRead.contract,
        options.actualVersion ?? CODING_X_VERSION,
        false,
      );
      const categories = ['test', 'build', 'static', 'security'] as const;
      const configuredChecks = categories.reduce((count, category) => {
        const policy = contractRead.contract.checks[category];
        return count + ('checks' in policy ? policy.checks.length : 0);
      }, 0);
      const notApplicableCategories = categories.filter(
        (category) => 'notApplicable' in contractRead.contract.checks[category],
      );
      quality = {
        ...quality,
        status: runtime.mode === 'formal' ? 'ready' : 'version-mismatch',
        digest: contractRead.digest,
        derivedChecks: deriveQualityChecks(contractRead.contract),
        configuredChecks,
        notApplicableCategories,
      };
      if (runtime.mode !== 'formal') {
        quality.issues.push({
          file: contractRel,
          message: `固定版本 ${runtime.expectedVersion} 与当前版本 ${runtime.actualVersion} 不一致`,
        });
      }
      if (quality.prdFound) {
        const prd = tryReadPrd(prdPath);
        if (prd === null) {
          quality.issues.push({ file: prdRel, message: 'prd.json 无法解析，不能核对质量契约摘要' });
        } else {
          const storyDefinitions = validatePrdStoryDefinitions(prd);
          if (!storyDefinitions.ok) {
            quality.status = 'invalid';
            quality.issues.push({
              file: prdRel,
              message: `PRD Story 定义无效，不能核对质量契约：${storyDefinitions.error}`,
            });
          } else {
            quality.prdDigestMatches = prd.qualityContractDigest === contractRead.digest;
            if (!quality.prdDigestMatches) {
              quality.issues.push({
                file: prdRel,
                message: `质量契约摘要不匹配（期望 ${contractRead.digest}，收到 ${prd.qualityContractDigest ?? 'missing'}）`,
              });
            }
            quality.prdChecksMatch = qualityChecksMatchContract(
              prd.qualityChecks,
              contractRead.contract,
            );
            if (!quality.prdChecksMatch) {
              quality.issues.push({
                file: prdRel,
                message: 'qualityChecks 不是当前质量契约的完整派生快照；请重新派生 PRD',
              });
            }
          }
        }
      }
    }
  }
  const delivery = checkDeliveryGate({
    root,
    workspace,
    contract: qualityContract,
    local: options.local ?? false,
    ...(options.githubClient ? { client: options.githubClient } : {}),
    ...(options.now ? { now: options.now } : {}),
  });
  let tdd: TddConfigCheckResult = { prdPath: prdRel, status: 'missing', issues: [] };
  // resolve（非 join）：workspace 可能是绝对路径（如 --workspace 巡检异地目录）；join 会把
  // 已是绝对路径的第二段原样拼在 root 之下产生不存在的路径，resolve 则在遇到绝对路径段时
  // 正确丢弃 root，相对 workspace 的既有行为不变（终审 2026-07-16 发现 1）。
  if (existsSync(prdPath)) {
    const prd = tryReadPrd(prdPath);
    if (prd === null) {
      tdd = {
        prdPath: prdRel,
        status: 'invalid',
        issues: [{ file: prdRel, message: 'prd.json 无法解析，不能检查 TDD 政策' }],
      };
    } else {
      const storyDefinitions = validatePrdStoryDefinitions(prd);
      if (!storyDefinitions.ok) {
        tdd = {
          prdPath: prdRel,
          status: 'invalid',
          issues: [
            {
              file: prdRel,
              message: `PRD Story 定义无效，不能检查 TDD 政策：${storyDefinitions.error}`,
            },
          ],
        };
      } else {
        const parsed = readTddConfig(prd);
        if (parsed.status === 'disabled') {
          tdd = { prdPath: prdRel, status: 'disabled', issues: [] };
        } else if (parsed.status === 'invalid') {
          tdd = {
            prdPath: prdRel,
            status: 'invalid',
            issues: [{ file: prdRel, message: parsed.error }],
          };
        } else {
          const policy = checkTddPolicy(parsed.config, root);
          tdd = policy.ok
            ? { prdPath: prdRel, status: 'ready', issues: [] }
            : {
                prdPath: prdRel,
                status: 'policy-error',
                issues: [
                  {
                    file: prdRel,
                    message: policy.failure?.outputTail || 'TDD 政策完整性检查失败',
                  },
                ],
              };
        }
      }
    }
  }
  const lockPath = resolve(root, workspace, LOCK_FILE);
  let lock: LockCheckResult = { found: false, stale: false, pid: null };
  if (existsSync(lockPath)) {
    const info = readLockInfo(lockPath);
    lock = { found: true, stale: !(info !== null && isPidAlive(info.pid)), pid: info?.pid ?? null };
  }
  const docsDir = join(root, 'docs');
  if (!existsSync(docsDir)) {
    return {
      docsFound: false,
      frontmatter: null,
      freshness: null,
      agentsIndex: null,
      links: null,
      quality,
      delivery,
      tdd,
      modelCatalog,
      workspaceGit,
      lock,
    };
  }
  let walked: ReturnType<typeof walkMarkdownFiles>;
  try {
    const docsStat = lstatSync(docsDir);
    walked =
      docsStat.isSymbolicLink() || !docsStat.isDirectory()
        ? {
            files: [],
            issues: [{ file: 'docs', message: 'docs 必须是真实目录，不能是软链或其他文件' }],
          }
        : walkMarkdownFiles(docsDir);
  } catch (error) {
    walked = {
      files: [],
      issues: [
        {
          file: 'docs',
          message: `docs 目录不可读取：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  const files = walked.files;
  const gitAvailable = isGitWorkTree(root);
  const fmIssues: DoctorIssue[] = [...walked.issues];
  const freshnessIssues: DoctorIssue[] = [];
  const linkIssues: DoctorIssue[] = [];
  let checked = 0;
  let freshnessChecked = 0;
  let archivedFreshnessSkipped = 0;
  let linksChecked = 0;
  let markdownBytes = 0;
  for (const file of files) {
    let content: string;
    try {
      const value = readSafeProjectFileUtf8Sync(root, file, {
        maxBytes: DOCTOR_MARKDOWN_FILE_MAX_BYTES,
      });
      if (value === null) throw new Error('文件在扫描期间消失');
      content = value;
    } catch (error) {
      fmIssues.push({
        file: relative(root, file),
        message: `文档不是可安全读取的小型普通文件：${error instanceof Error ? error.message : String(error)}`,
      });
      continue;
    }
    markdownBytes += Buffer.byteLength(content);
    if (markdownBytes > DOCTOR_MARKDOWN_TOTAL_MAX_BYTES) {
      fmIssues.push({
        file: 'docs',
        message: `Markdown 总量超过 ${DOCTOR_MARKDOWN_TOTAL_MAX_BYTES} bytes，已停止扫描`,
      });
      break;
    }
    const fm = parseFrontmatter(content);
    if (fm === null) continue; // 无 frontmatter 的 .md（README 占位、工作产物）不参与本项检查
    checked++;
    const rel = relative(root, file);
    const missing = REQUIRED_FIELDS.filter((field) => !(field in fm));
    if (missing.length > 0) {
      fmIssues.push({ file: rel, message: `缺失字段 ${missing.join('、')}` });
    }
    for (const target of extractInlineLinkTargets(bodyAfterFrontmatter(content))) {
      if (/^(https?:\/\/|#|\/)/.test(target)) continue; // 外链、纯锚点、绝对路径不属相对链接检查
      linksChecked++;
      const filePart = target.split('#')[0]; // 含锚点时只检查文件部分
      if (filePart !== '' && !existsSync(join(dirname(file), filePart))) {
        linkIssues.push({ file: rel, message: `断链 ${target}（目标不存在）` });
      }
    }
    // 冷档案仍检查 frontmatter 必填字段与正文相对链接，但历史文档不再以 updated
    // 对当前知识的新鲜度负责。只按 docs/archive/ 物理边界判定，不拿 status 猜生命周期。
    if (relative(docsDir, file).split(sep)[0] === 'archive') {
      archivedFreshnessSkipped++;
      continue;
    }
    if (!('updated' in fm)) continue; // 缺 updated 已由完整性检查报告，新鲜度不重复计
    freshnessChecked++;
    const updatedTs = parseDateUTC(fm.updated);
    if (updatedTs === null) {
      freshnessIssues.push({
        file: rel,
        message: `updated 值「${fm.updated}」不是 YYYY-MM-DD 格式`,
      });
      continue;
    }
    if (!gitAvailable) continue; // 非 git 仓库：跳过新鲜度比较，不报错
    const gitDate = gitLastCommitDate(root, rel);
    if (gitDate === null) continue; // 尚无提交记录：跳过，不报错
    const gitTs = parseDateUTC(gitDate);
    if (gitTs === null) continue;
    const daysBehind = Math.round((gitTs - updatedTs) / DAY_MS);
    if (daysBehind > staleDays) {
      freshnessIssues.push({
        file: rel,
        message: `updated ${fm.updated}，git 最后提交 ${gitDate}，落后 ${daysBehind} 天（阈值 ${staleDays} 天）`,
      });
    }
  }
  const agentsFile = join(root, 'AGENTS.md');
  let agentsIndex: AgentsIndexCheckResult;
  try {
    const agentsContent = readSafeProjectFileUtf8Sync(root, agentsFile, {
      maxBytes: AGENTS_FILE_MAX_BYTES,
      allowMissing: true,
    });
    if (agentsContent === null) {
      agentsIndex = { agentsFound: false, checked: 0, issues: [] };
    } else {
      const indexPaths = extractAgentsIndexPaths(agentsContent);
      agentsIndex = {
        agentsFound: true,
        checked: indexPaths.length,
        issues: indexPaths
          .filter((p) => !existsSync(join(root, p)))
          .map((p) => ({ file: 'AGENTS.md', message: `索引路径 ${p} 不存在` })),
      };
    }
  } catch (error) {
    agentsIndex = {
      agentsFound: true,
      checked: 0,
      issues: [
        {
          file: 'AGENTS.md',
          message: `文件不可安全读取：${error instanceof Error ? error.message : String(error)}`,
        },
      ],
    };
  }
  return {
    docsFound: true,
    frontmatter: { scanned: files.length, checked, issues: fmIssues },
    freshness: {
      staleDays,
      gitAvailable,
      checked: freshnessChecked,
      archivedSkipped: archivedFreshnessSkipped,
      issues: freshnessIssues,
    },
    agentsIndex,
    links: { checked: linksChecked, issues: linkIssues },
    quality,
    delivery,
    tdd,
    modelCatalog,
    workspaceGit,
    lock,
  };
}

function renderQualityLines(result: QualityContractCheckResult): string[] {
  const lines = ['⚙️  项目质量契约'];
  if (result.status === 'skipped') {
    lines.push('  ℹ️  本次独立检查未启用质量契约校验');
    return lines;
  }
  if (result.issues.length > 0) {
    for (const issue of result.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
    return lines;
  }
  lines.push(`  ✅ 契约有效；已声明 ${result.configuredChecks} 项机械检查，摘要 ${result.digest}`);
  if (result.notApplicableCategories.length > 0) {
    lines.push(`  ℹ️  明确不适用：${result.notApplicableCategories.join('、')}`);
  }
  if (!result.prdFound) {
    lines.push(`  ℹ️  未找到 ${result.prdPath}：当前没有待运行 PRD，无需核对摘要`);
  } else {
    lines.push(`  ✅ ${result.prdPath} 已绑定当前契约摘要`);
  }
  return lines;
}

function renderDeliveryLines(result: DeliveryGateCheckResult): string[] {
  const lines = ['🛡️  交付门禁漂移'];
  if (result.status === 'skipped') {
    lines.push('  ℹ️  质量契约不可用，本项已跳过');
    return lines;
  }
  for (const issue of result.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  if (result.issues.length === 0) {
    lines.push(
      result.remoteChecked
        ? `  ✅ 本地 ${result.managedFilesChecked} 个托管文件与 GitHub ` +
            `${result.releaseRulesetId === null ? '默认分支 Ruleset' : '默认分支、发布标签 Ruleset'} 均一致`
        : `  ✅ 本地 ${result.managedFilesChecked} 个托管文件一致（--local 已跳过 GitHub）`,
    );
    if (result.remoteChecked && result.immutableReleases === true) {
      lines.push('  ✅ GitHub Release 已启用不可变保护');
    }
  }
  if (result.remoteChecked) {
    lines.push(`  ℹ️  已核对 ${result.exceptionIssuesChecked} 份开放或当前引用的例外记录`);
  }
  return lines;
}

function renderTddLines(result: TddConfigCheckResult): string[] {
  const lines = ['🧪 TDD 门禁'];
  if (result.status === 'missing') {
    lines.push(`  ℹ️  未找到 ${result.prdPath}：已跳过 TDD 配置检查`);
  } else if (result.status === 'disabled') {
    lines.push('  ℹ️  未启用；现有普通门禁行为不变');
  } else if (result.status === 'ready') {
    lines.push(
      '  ✅ 配置、Git 基线、政策摘要与新增忽略标记检查通过',
      '  ℹ️  doctor 未运行覆盖率命令；真实门禁由提交前 hook 与 coding-x 运行时执行',
    );
  } else {
    for (const issue of result.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  return lines;
}

function renderModelCatalogLines(result: ModelCatalogCheckResult): string[] {
  const lines = ['🧭 全局模型目录'];
  if (result.issues.length > 0) {
    for (const issue of result.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  } else if (result.configStatus === 'missing') {
    lines.push(`  ℹ️  未配置（${result.configPath}）：runner-default 不受影响`);
    if (!result.prdFound) lines.push(`  ℹ️  未找到 ${result.prdPath}：无需项目模型映射复核`);
    else lines.push('  ℹ️  prd.json 未启用 models：无需项目模型映射复核');
  } else if (!result.routingEnabled) {
    const summary =
      result.configuredRunners.length === 0
        ? '尚未声明 runner'
        : result.configuredRunners.map(({ runner, count }) => `${runner} ${count} 项`).join('、');
    lines.push(`  ✅ 配置 schema 合法（${summary}）`);
    if (!result.prdFound) lines.push(`  ℹ️  未找到 ${result.prdPath}：无需项目模型映射复核`);
    else lines.push('  ℹ️  prd.json 未启用 models：无需项目模型映射复核');
  } else {
    lines.push(
      `  ✅ ${result.runner} 的 ${result.checked}/5 个项目模型均已在全局目录声明`,
      '  ℹ️  这里只检查静态允许目录，不检查 provider 在线可用性',
    );
  }
  return lines;
}

function renderLockLines(lock: LockCheckResult): string[] {
  const lines = ['🔒 workspace 锁'];
  if (!lock.found) {
    lines.push('  ✅ 无 engine.lock（当前没有引擎实例在运行）');
  } else if (lock.stale) {
    lines.push(
      `  💡 发现 stale 锁${lock.pid !== null ? `（pid ${lock.pid} 已不存在）` : '（锁文件损坏）'}：上次异常退出遗留，下次 coding-x 运行将自动接管（建议项，不计失败）`,
    );
  } else {
    lines.push(`  ℹ️  引擎运行中（pid ${lock.pid}）：请勿对同一 workspace 并行启动 run/repair`);
  }
  return lines;
}

function renderWorkspaceGitLines(result: WorkspaceGitCheckResult): string[] {
  const lines = ['🧹 workspace Git 隔离'];
  if (!result.gitAvailable) {
    lines.push('  ℹ️  非 Git 项目：已跳过 workspace 忽略检查');
  } else if (!result.insideRepository) {
    lines.push(`  ✅ ${result.workspacePath} 位于当前 Git 仓库之外，不会进入当前仓库提交`);
  } else if (result.trackedFiles.length > 0) {
    const shown = result.trackedFiles.slice(0, 5).join('、');
    const more = result.trackedFiles.length > 5 ? ` 等 ${result.trackedFiles.length} 个文件` : '';
    lines.push(
      `  💡 ${result.workspacePath} 下的以下文件已被 Git 跟踪：${shown}${more}`,
      '  💡 请人工决定如何停止跟踪并忽略 workspace；doctor 不会自动修改 Git 索引或 .gitignore（建议项，不计失败）',
    );
  } else if (result.ignored) {
    lines.push(`  ✅ ${result.workspacePath} 已被 Git 忽略（运行时文件不会进入 story commit）`);
  } else if (result.workspaceFound) {
    lines.push(
      `  💡 ${result.workspacePath} 未被 Git 忽略：建议先配置忽略规则；doctor 不会自动修改 .gitignore（建议项，不计失败）`,
    );
  } else {
    lines.push(
      `  💡 ${result.workspacePath} 尚未创建且未命中 Git 忽略规则：创建前请确认忽略配置；doctor 不会自动修改 .gitignore（建议项，不计失败）`,
    );
  }
  return lines;
}

export function renderDoctorReport(report: DoctorReport): { text: string; exitCode: number } {
  if (!report.docsFound) {
    const total =
      report.modelCatalog.issues.length +
      report.tdd.issues.length +
      report.quality.issues.length +
      report.delivery.issues.length;
    return {
      text: [
        'ℹ️  未找到 docs/ 目录：建议先运行 /init-docs 生成知识库，再用 doctor 做健康检查。',
        '',
        ...renderQualityLines(report.quality),
        '',
        ...renderDeliveryLines(report.delivery),
        '',
        ...renderTddLines(report.tdd),
        '',
        ...renderModelCatalogLines(report.modelCatalog),
        '',
        ...renderWorkspaceGitLines(report.workspaceGit),
        '',
        ...renderLockLines(report.lock),
      ].join('\n'),
      exitCode: total === 0 ? 0 : 1,
    };
  }
  const fm = report.frontmatter!;
  const fresh = report.freshness!;
  const lines: string[] = ['🩺 docs/ 知识库健康检查', '', '📋 frontmatter 完整性'];
  if (fm.issues.length === 0) {
    lines.push(
      `  ✅ 通过（已检查 ${fm.checked} 个带 frontmatter 文件 / 共扫描 ${fm.scanned} 个 .md）`,
    );
  } else {
    for (const issue of fm.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  lines.push('', `⏰ updated 新鲜度（阈值 ${fresh.staleDays} 天）`);
  if (fresh.issues.length === 0) {
    const notes = [
      ...(fresh.gitAvailable ? [] : ['非 git 仓库，已跳过 git 日期比较']),
      ...(fresh.archivedSkipped === 0 ? [] : [`冷档案 ${fresh.archivedSkipped} 份已跳过`]),
    ];
    lines.push(
      `  ✅ 通过（已检查 ${fresh.checked} 个含 updated 文件${notes.length === 0 ? '' : `；${notes.join('；')}`}）`,
    );
  } else {
    for (const issue of fresh.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
    if (fresh.archivedSkipped > 0)
      lines.push(`  ℹ️  冷档案 ${fresh.archivedSkipped} 份未参与新鲜度检查`);
  }
  const idx = report.agentsIndex!;
  lines.push('', '📇 AGENTS.md 索引');
  if (!idx.agentsFound) {
    lines.push('  ℹ️  未找到 AGENTS.md：已跳过索引检查');
  } else if (idx.issues.length === 0) {
    lines.push(`  ✅ 通过（已检查 ${idx.checked} 条索引路径）`);
  } else {
    for (const issue of idx.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  const links = report.links!;
  lines.push('', '🔗 文档相对链接');
  if (links.issues.length === 0) {
    lines.push(`  ✅ 通过（已检查 ${links.checked} 条相对链接）`);
  } else {
    for (const issue of links.issues) lines.push(`  ❌ ${issue.file}：${issue.message}`);
  }
  lines.push('', ...renderQualityLines(report.quality));
  lines.push('', ...renderDeliveryLines(report.delivery));
  lines.push('', ...renderTddLines(report.tdd));
  lines.push('', ...renderModelCatalogLines(report.modelCatalog));
  lines.push('', ...renderWorkspaceGitLines(report.workspaceGit));
  lines.push('', ...renderLockLines(report.lock));
  const total =
    fm.issues.length +
    fresh.issues.length +
    idx.issues.length +
    links.issues.length +
    report.modelCatalog.issues.length +
    report.tdd.issues.length +
    report.quality.issues.length +
    report.delivery.issues.length;
  lines.push('', total === 0 ? '✅ 全部通过' : `❌ 共发现 ${total} 个问题`);
  return { text: lines.join('\n'), exitCode: total === 0 ? 0 : 1 };
}

/** 机器读取与人类报告共享同一退出判定；stdout 只包含一个 JSON 对象。 */
export function renderDoctorJson(report: DoctorReport): { text: string; exitCode: number } {
  const { exitCode } = renderDoctorReport(report);
  return {
    text: JSON.stringify({ schemaVersion: 1, ...report }, null, 2),
    exitCode,
  };
}
