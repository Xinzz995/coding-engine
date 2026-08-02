import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const QUALITY_CONTRACT_SCHEMA_VERSION = 2 as const;
export const QUALITY_CONTRACT_RELATIVE_PATH = '.coding-x/quality.json';
export const QUALITY_GATE_REQUIRED_CHECK = 'quality-gate';
export const POLICY_GUARD_REQUIRED_CHECK = 'policy-guard-source';
export const REQUIRED_GITHUB_CHECKS = [
  QUALITY_GATE_REQUIRED_CHECK,
  POLICY_GUARD_REQUIRED_CHECK,
] as const;

export type QualityPlatform = 'linux' | 'macos' | 'windows';
export type QualityCheckCategory = 'test' | 'build' | 'static' | 'security';
export type QualityRiskCategory =
  | 'policy'
  | 'public-contract'
  | 'state'
  | 'migration'
  | 'recovery'
  | 'idempotency'
  | 'concurrency'
  | 'timeout'
  | 'retry'
  | 'subprocess'
  | 'security'
  | 'privacy'
  | 'untrusted-input'
  | 'cross-module'
  | 'large-file'
  | 'high-risk-path'
  | 'reviewer-request'
  | 'release';

export interface PathSource {
  kind: 'path';
  path: string;
}

export interface PullRequestSource {
  kind: 'pull-request';
}

export type QualityIntentSource = PathSource | PullRequestSource;

interface QualityCommandBase {
  cwd: string;
  platforms: QualityPlatform[];
  timeoutMs: number;
}

export interface StructuredQualityCommand extends QualityCommandBase {
  executable: string;
  args: string[];
}

export interface ShellQualityCommand extends QualityCommandBase {
  /** 明确选择的 shell executable，例如 bash、pwsh；不从用户环境静默推断。 */
  shell: string;
  script: string;
}

export type QualityCommand = StructuredQualityCommand | ShellQualityCommand;

export interface QualityCheck {
  id: string;
  module: string;
  paths?: string[];
  command: QualityCommand;
}

export type QualityToolchain =
  | {
      kind: 'node';
      version: string;
      cache?: 'npm' | 'yarn' | 'pnpm';
      cacheDependencyPath?: string;
    }
  | {
      kind: 'go';
      version: string;
      cache?: boolean;
      cacheDependencyPath?: string;
    }
  | {
      kind: 'python';
      version: string;
      cache?: 'pip' | 'pipenv' | 'poetry';
      cacheDependencyPath?: string;
    };

export interface QualityGitHubJob {
  id: string;
  platform: QualityPlatform;
  /** 只允许生成器内置并固定版本的官方 setup action。 */
  toolchains: QualityToolchain[];
  /** 工具链就绪后、项目检查前执行的项目原生命令。 */
  setup: QualityCommand[];
  /** 本任务实际执行的检查 ID；同一检查可在多个版本或系统重复。 */
  checkIds: string[];
}

export interface QualityLocalValidation {
  /** 在临时干净检出建立后、任何本地检查或 Validator 启动前运行。 */
  prepare: QualityCommand[];
  /** 本地依赖或缓存目录；生成物目录继续由 generatedPaths 单一维护。 */
  allowedPaths: string[];
}

export type QualityCodeScanningAlertsThreshold =
  | 'none'
  | 'errors'
  | 'errors_and_warnings'
  | 'all';

export type QualityCodeScanningSecurityAlertsThreshold =
  | 'none'
  | 'critical'
  | 'high_or_higher'
  | 'medium_or_higher'
  | 'all';

export interface QualityCodeScanningTool {
  tool: string;
  alertsThreshold: QualityCodeScanningAlertsThreshold;
  securityAlertsThreshold: QualityCodeScanningSecurityAlertsThreshold;
}

export type QualityCheckPolicy =
  | { checks: QualityCheck[] }
  | { notApplicable: string };

export interface QualityContract {
  schemaVersion: typeof QUALITY_CONTRACT_SCHEMA_VERSION;
  codingXVersion: string;
  repository: {
    provider: 'github';
    fullName: string;
    defaultBranch: string;
  };
  release: {
    protectedRefs: string[];
    notApplicable?: string;
  };
  sources: {
    specs: QualityIntentSource[];
    acceptanceCriteria: QualityIntentSource[];
    engineeringStandards: string[];
  };
  modules: Array<{ id: string; path: string }>;
  generatedPaths: string[];
  localValidation: QualityLocalValidation;
  checks: Record<QualityCheckCategory, QualityCheckPolicy>;
  risk: {
    defaultCategories: QualityRiskCategory[];
    highRiskPaths: string[];
    pathRules: Array<{ paths: string[]; categories: QualityRiskCategory[] }>;
  };
  github: {
    /** 明确表达系统、工具版本、准备命令和检查范围，工作流只从这里生成。 */
    jobs: QualityGitHubJob[];
    requiredChecks: string[];
    /** 声明后由 Ruleset 强制指定工具及阈值；缺省表示 coding-x 不接管现有代码扫描规则。 */
    requiredCodeScanning?: QualityCodeScanningTool[];
    /** 声明为 true 后，init 启用、doctor 回读 GitHub 不可变 Release。 */
    immutableReleases?: true;
    /** 可选的仓库安全能力要求；声明后 doctor 必须回读真实 GitHub 状态。 */
    securityFeatures?: {
      dependabotSecurityUpdates: boolean;
      secretScanning: boolean;
      secretScanningPushProtection: boolean;
    };
  };
  exceptions: {
    p1: { issueTemplate: string; maxDays: number };
    policy: { issueTemplate: string; maxDays: number };
  };
}

/**
 * PRD 中冻结的项目检查快照。它不是第二份人工配置：prd-to-json 必须从当前质量契约
 * 原样派生，引擎和 doctor 都会逐字段核对。保留类别分组，避免丢失“不适用”理由和顺序。
 */
export type FrozenQualityChecks = QualityContract['checks'];

export type QualityContractParseResult =
  | { status: 'ready'; contract: QualityContract; digest: string }
  | { status: 'invalid'; errors: string[] };

export type QualityContractReadResult =
  | { status: 'missing'; path: string }
  | { status: 'io-error'; path: string; error: string }
  | { status: 'invalid-json'; path: string; error: string }
  | { status: 'invalid'; path: string; errors: string[] }
  | { status: 'ready'; path: string; contract: QualityContract; digest: string };

export interface QualityRuntimeAssessment {
  mode: 'formal' | 'shadow' | 'version-mismatch';
  expectedVersion: string;
  actualVersion: string;
  versionMatches: boolean;
  deliveryReadyAllowed: boolean;
}

type UnknownRecord = Record<string, unknown>;

const PLATFORMS = new Set<QualityPlatform>(['linux', 'macos', 'windows']);
const CHECK_CATEGORIES: QualityCheckCategory[] = ['test', 'build', 'static', 'security'];
const CODE_SCANNING_ALERTS_THRESHOLDS = new Set<QualityCodeScanningAlertsThreshold>([
  'none', 'errors', 'errors_and_warnings', 'all',
]);
const CODE_SCANNING_SECURITY_ALERTS_THRESHOLDS =
  new Set<QualityCodeScanningSecurityAlertsThreshold>([
    'none', 'critical', 'high_or_higher', 'medium_or_higher', 'all',
  ]);
const RISK_CATEGORIES = new Set<QualityRiskCategory>([
  'policy', 'public-contract', 'state', 'migration', 'recovery', 'idempotency',
  'concurrency', 'timeout', 'retry', 'subprocess', 'security', 'privacy',
  'untrusted-input', 'cross-module', 'large-file', 'high-risk-path',
  'reviewer-request', 'release',
]);

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function objectShape(
  value: unknown,
  path: string,
  required: readonly string[],
  optional: readonly string[],
  errors: string[],
): UnknownRecord | null {
  if (!isRecord(value)) {
    errors.push(`${path || '根'}必须是对象`);
    return null;
  }
  const allowed = new Set([...required, ...optional]);
  for (const key of required) {
    if (!Object.hasOwn(value, key)) {
      errors.push(path ? `${path} 缺少字段 ${key}` : `缺少字段 ${key}`);
    }
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(path ? `${path} 未知字段 ${key}` : `未知字段 ${key}`);
  }
  return value;
}

function nonEmptyString(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    errors.push(`${path} 必须是非空字符串`);
    return false;
  }
  return true;
}

function exactVersion(value: unknown, path: string, errors: string[]): value is string {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) {
    errors.push(`${path} 必须是精确 X.Y.Z 版本`);
    return false;
  }
  return true;
}

function positiveInteger(
  value: unknown,
  path: string,
  max: number,
  errors: string[],
): value is number {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > max) {
    errors.push(`${path} 必须是 1 到 ${max} 的整数`);
    return false;
  }
  return true;
}

function repoPath(
  value: unknown,
  path: string,
  errors: string[],
  allowDot = false,
): value is string {
  if (!nonEmptyString(value, path, errors)) return false;
  if ((value === '.' && allowDot)) return true;
  const segments = value.split('/');
  const invalid = value === '.'
    || value.startsWith('/')
    || /^[A-Za-z]:/.test(value)
    || value.includes('\\')
    || value.includes('//')
    || segments.some((segment) => segment === '' || segment === '..');
  if (invalid) {
    errors.push(`${path} 必须是使用 / 的仓库相对路径且不能越界`);
    return false;
  }
  return true;
}

function stringArray(
  value: unknown,
  path: string,
  errors: string[],
  options: { nonEmpty?: boolean; unique?: boolean; validate?: (v: unknown, p: string, e: string[]) => boolean } = {},
): value is string[] {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return false;
  }
  if (options.nonEmpty && value.length === 0) errors.push(`${path} 不能为空`);
  value.forEach((entry, index) => {
    if (options.validate) options.validate(entry, `${path}[${index}]`, errors);
    else nonEmptyString(entry, `${path}[${index}]`, errors);
  });
  if (options.unique) {
    const seen = new Set<string>();
    for (const entry of value) {
      if (typeof entry !== 'string') continue;
      if (seen.has(entry)) errors.push(`${path} 含重复值 ${entry}`);
      seen.add(entry);
    }
  }
  return true;
}

function sourceArray(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return;
  }
  if (value.length === 0) errors.push(`${path} 不能为空`);
  value.forEach((entry, index) => {
    const itemPath = `${path}[${index}]`;
    if (!isRecord(entry)) {
      errors.push(`${itemPath} 必须是对象`);
      return;
    }
    if (entry.kind === 'path') {
      const source = objectShape(entry, itemPath, ['kind', 'path'], [], errors);
      if (source) repoPath(source.path, `${itemPath}.path`, errors);
      return;
    }
    if (entry.kind === 'pull-request') {
      objectShape(entry, itemPath, ['kind'], [], errors);
      return;
    }
    errors.push(`${itemPath}.kind 必须是 path 或 pull-request`);
  });
}

function platforms(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return;
  }
  if (value.length === 0) errors.push(`${path} 不能为空`);
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !PLATFORMS.has(entry as QualityPlatform)) {
      errors.push(`${path}[${index}] 必须是 linux、macos 或 windows`);
      return;
    }
    if (seen.has(entry)) errors.push(`${path} 含重复值 ${entry}`);
    seen.add(entry);
  });
}

function command(value: unknown, path: string, errors: string[]): void {
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return;
  }
  const hasExecutable = Object.hasOwn(value, 'executable');
  const hasShell = Object.hasOwn(value, 'shell');
  if (hasExecutable === hasShell) {
    errors.push(`${path} 必须且只能选择 executable 或 shell 一种形式`);
    // 仍按字段并集检查，给出精确 unknown/基础字段错误。
    objectShape(
      value,
      path,
      ['cwd', 'platforms', 'timeoutMs'],
      ['executable', 'args', 'shell', 'script'],
      errors,
    );
  } else if (hasExecutable) {
    const item = objectShape(
      value,
      path,
      ['executable', 'args', 'cwd', 'platforms', 'timeoutMs'],
      [],
      errors,
    );
    if (item) {
      nonEmptyString(item.executable, `${path}.executable`, errors);
      if (!Array.isArray(item.args) || !item.args.every((arg) => typeof arg === 'string' && !arg.includes('\0'))) {
        errors.push(`${path}.args 必须是字符串数组`);
      }
    }
  } else {
    const item = objectShape(
      value,
      path,
      ['shell', 'script', 'cwd', 'platforms', 'timeoutMs'],
      [],
      errors,
    );
    if (item) {
      nonEmptyString(item.shell, `${path}.shell`, errors);
      nonEmptyString(item.script, `${path}.script`, errors);
    }
  }
  repoPath(value.cwd, `${path}.cwd`, errors, true);
  platforms(value.platforms, `${path}.platforms`, errors);
  positiveInteger(value.timeoutMs, `${path}.timeoutMs`, 3_600_000, errors);
}

function allowedArtifactPath(value: unknown, path: string, errors: string[]): boolean {
  if (!nonEmptyString(value, path, errors)) return false;
  if (value === '*' || value === '**' || value === './**') {
    errors.push(`${path} 不能允许整个项目根`);
    return false;
  }
  if (!value.endsWith('/**')) {
    errors.push(`${path} 必须是明确目录的 /** 模式`);
    return false;
  }
  const directory = value.slice(0, -3);
  if (directory === '' || /^[*?/]+$/u.test(directory)) {
    errors.push(`${path} 不能允许整个项目根`);
    return false;
  }
  if (/[*?[\]{}]/u.test(directory)) {
    errors.push(`${path} 的基目录必须是字面路径，不能包含 glob 元字符`);
    return false;
  }
  return repoPath(directory, path, errors);
}

function riskCategories(value: unknown, path: string, errors: string[]): void {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return;
  }
  if (value.length === 0) errors.push(`${path} 不能为空`);
  const seen = new Set<string>();
  value.forEach((entry, index) => {
    if (typeof entry !== 'string' || !RISK_CATEGORIES.has(entry as QualityRiskCategory)) {
      errors.push(`${path}[${index}] 是未知风险类别`);
      return;
    }
    if (seen.has(entry)) errors.push(`${path} 含重复值 ${entry}`);
    seen.add(entry);
  });
}

function toolchain(value: unknown, path: string, errors: string[]): void {
  const item = objectShape(
    value,
    path,
    ['kind', 'version'],
    ['cache', 'cacheDependencyPath'],
    errors,
  );
  if (!item) return;
  const kind = item.kind;
  if (kind !== 'node' && kind !== 'go' && kind !== 'python') {
    errors.push(`${path}.kind 必须是 node、go 或 python`);
  }
  if (nonEmptyString(item.version, `${path}.version`, errors)
      && /[\r\n]/.test(item.version)) {
    errors.push(`${path}.version 不能包含换行`);
  }
  if (Object.hasOwn(item, 'cache')) {
    const cache = item.cache;
    if (kind === 'node' && cache !== 'npm' && cache !== 'yarn' && cache !== 'pnpm') {
      errors.push(`${path}.cache 对 node 必须是 npm、yarn 或 pnpm`);
    } else if (kind === 'go' && typeof cache !== 'boolean') {
      errors.push(`${path}.cache 对 go 必须是布尔值`);
    } else if (kind === 'python' && cache !== 'pip' && cache !== 'pipenv' && cache !== 'poetry') {
      errors.push(`${path}.cache 对 python 必须是 pip、pipenv 或 poetry`);
    }
  }
  if (Object.hasOwn(item, 'cacheDependencyPath')) {
    repoPath(item.cacheDependencyPath, `${path}.cacheDependencyPath`, errors);
  }
}

function validateContract(value: unknown): string[] {
  const errors: string[] = [];
  const root = objectShape(value, '', [
    'schemaVersion', 'codingXVersion', 'repository', 'release', 'sources', 'modules',
    'generatedPaths', 'localValidation', 'checks', 'risk', 'github', 'exceptions',
  ], [], errors);
  if (!root) return errors;

  if (root.schemaVersion !== QUALITY_CONTRACT_SCHEMA_VERSION) {
    errors.push(`不支持 schemaVersion ${String(root.schemaVersion)}；当前只支持 ${QUALITY_CONTRACT_SCHEMA_VERSION}`);
  }
  exactVersion(root.codingXVersion, 'codingXVersion', errors);

  const repository = objectShape(
    root.repository,
    'repository',
    ['provider', 'fullName', 'defaultBranch'],
    [],
    errors,
  );
  if (repository) {
    if (repository.provider !== 'github') errors.push('repository.provider 必须是 github');
    if (typeof repository.fullName !== 'string'
        || !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository.fullName)) {
      errors.push('repository.fullName 必须是 owner/repo');
    }
    if (nonEmptyString(repository.defaultBranch, 'repository.defaultBranch', errors)
        && /[\s~^:?*\[\\]/.test(repository.defaultBranch)) {
      errors.push('repository.defaultBranch 不是合法分支名');
    }
  }

  const release = objectShape(root.release, 'release', ['protectedRefs'], ['notApplicable'], errors);
  if (release) {
    stringArray(release.protectedRefs, 'release.protectedRefs', errors, {
      unique: true,
      validate: (entry, path, target) => {
        if (!nonEmptyString(entry, path, target)) return false;
        if (entry !== entry.trim() || entry.startsWith('/') || entry.startsWith('refs/')
            || /[\u0000-\u0020\u007f~^:?\[\\]/.test(entry)
            || entry.includes('..') || entry.includes('//') || entry.includes('@{')
            || entry.endsWith('/') || entry.endsWith('.') || entry.endsWith('.lock')
            || entry === '*' || entry === '@') {
          target.push(`${path} 必须是明确的 Git tag 模式，例如 v* 或 releases/v*`);
          return false;
        }
        return true;
      },
    });
    const refs = Array.isArray(release.protectedRefs) ? release.protectedRefs : [];
    if (refs.length === 0) {
      if (!nonEmptyString(release.notApplicable, 'release.notApplicable', errors)) {
        errors.push('release.protectedRefs 为空时必须提供 notApplicable 理由');
      }
    } else if (Object.hasOwn(release, 'notApplicable')) {
      errors.push('release.notApplicable 只能在 protectedRefs 为空时使用');
    }
  }

  const sources = objectShape(
    root.sources,
    'sources',
    ['specs', 'acceptanceCriteria', 'engineeringStandards'],
    [],
    errors,
  );
  if (sources) {
    sourceArray(sources.specs, 'sources.specs', errors);
    sourceArray(sources.acceptanceCriteria, 'sources.acceptanceCriteria', errors);
    stringArray(sources.engineeringStandards, 'sources.engineeringStandards', errors, {
      nonEmpty: true,
      unique: true,
      validate: (entry, path, target) => repoPath(entry, path, target),
    });
  }

  const moduleIds = new Set<string>();
  const modulePaths = new Set<string>();
  if (!Array.isArray(root.modules)) {
    errors.push('modules 必须是数组');
  } else {
    if (root.modules.length === 0) errors.push('modules 不能为空');
    root.modules.forEach((entry, index) => {
      const path = `modules[${index}]`;
      const item = objectShape(entry, path, ['id', 'path'], [], errors);
      if (!item) return;
      if (nonEmptyString(item.id, `${path}.id`, errors)) {
        if (!/^[a-z0-9][a-z0-9._-]*$/.test(item.id)) errors.push(`${path}.id 格式非法`);
        if (moduleIds.has(item.id)) errors.push(`重复 module id ${item.id}`);
        moduleIds.add(item.id);
      }
      if (repoPath(item.path, `${path}.path`, errors, true)) {
        if (modulePaths.has(item.path)) errors.push(`重复 module path ${item.path}`);
        modulePaths.add(item.path);
      }
    });
  }

  stringArray(root.generatedPaths, 'generatedPaths', errors, {
    unique: true,
    validate: allowedArtifactPath,
  });

  const localValidation = objectShape(
    root.localValidation,
    'localValidation',
    ['prepare', 'allowedPaths'],
    [],
    errors,
  );
  if (localValidation) {
    if (!Array.isArray(localValidation.prepare)) {
      errors.push('localValidation.prepare 必须是数组');
    } else {
      localValidation.prepare.forEach((entry, index) => {
        command(entry, `localValidation.prepare[${index}]`, errors);
      });
    }
    stringArray(localValidation.allowedPaths, 'localValidation.allowedPaths', errors, {
      unique: true,
      validate: allowedArtifactPath,
    });
  }

  const checks = objectShape(root.checks, 'checks', CHECK_CATEGORIES, [], errors);
  const checkIds = new Set<string>();
  const checkPlatformsById = new Map<string, Set<QualityPlatform>>();
  let configuredCheckCount = 0;
  if (checks) {
    for (const category of CHECK_CATEGORIES) {
      const groupPath = `checks.${category}`;
      const group = objectShape(checks[category], groupPath, [], ['checks', 'notApplicable'], errors);
      if (!group) continue;
      const hasChecks = Object.hasOwn(group, 'checks');
      const hasReason = Object.hasOwn(group, 'notApplicable');
      if (hasChecks === hasReason) {
        errors.push(`${groupPath} 必须且只能包含 checks 或 notApplicable`);
        continue;
      }
      if (hasReason) {
        nonEmptyString(group.notApplicable, `${groupPath}.notApplicable`, errors);
        continue;
      }
      if (!Array.isArray(group.checks) || group.checks.length === 0) {
        errors.push(`${groupPath}.checks 必须是非空数组`);
        continue;
      }
      group.checks.forEach((entry, index) => {
        configuredCheckCount += 1;
        const checkPath = `${groupPath}.checks[${index}]`;
        const item = objectShape(entry, checkPath, ['id', 'module', 'command'], ['paths'], errors);
        if (!item) return;
        let checkId: string | null = null;
        if (nonEmptyString(item.id, `${checkPath}.id`, errors)) {
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(item.id)) errors.push(`${checkPath}.id 格式非法`);
          if (checkIds.has(item.id)) errors.push(`重复 check id ${item.id}`);
          checkIds.add(item.id);
          checkId = item.id;
        }
        if (nonEmptyString(item.module, `${checkPath}.module`, errors)
            && !moduleIds.has(item.module)) {
          errors.push(`${checkPath} 引用未知 module ${item.module}`);
        }
        if (Object.hasOwn(item, 'paths')) {
          stringArray(item.paths, `${checkPath}.paths`, errors, {
            nonEmpty: true,
            unique: true,
            validate: (entryValue, entryPath, target) => repoPath(entryValue, entryPath, target),
          });
        }
        command(item.command, `${checkPath}.command`, errors);
        if (checkId && isRecord(item.command) && Array.isArray(item.command.platforms)) {
          checkPlatformsById.set(checkId, new Set(
            item.command.platforms.filter((platform): platform is QualityPlatform => (
              typeof platform === 'string' && PLATFORMS.has(platform as QualityPlatform)
            )),
          ));
        }
      });
    }
  }
  if (configuredCheckCount === 0) {
    errors.push('checks 至少必须声明一项可重复执行的项目检查');
  }

  const risk = objectShape(
    root.risk,
    'risk',
    ['defaultCategories', 'highRiskPaths', 'pathRules'],
    [],
    errors,
  );
  if (risk) {
    riskCategories(risk.defaultCategories, 'risk.defaultCategories', errors);
    stringArray(risk.highRiskPaths, 'risk.highRiskPaths', errors, {
      unique: true,
      validate: (entry, path, target) => repoPath(entry, path, target),
    });
    if (!Array.isArray(risk.pathRules)) {
      errors.push('risk.pathRules 必须是数组');
    } else {
      risk.pathRules.forEach((entry, index) => {
        const path = `risk.pathRules[${index}]`;
        const item = objectShape(entry, path, ['paths', 'categories'], [], errors);
        if (!item) return;
        stringArray(item.paths, `${path}.paths`, errors, {
          nonEmpty: true,
          unique: true,
          validate: (entryValue, entryPath, target) => repoPath(entryValue, entryPath, target),
        });
        riskCategories(item.categories, `${path}.categories`, errors);
      });
    }
  }

  const pythonToolchainPlatforms = new Set<QualityPlatform>();
  const github = objectShape(
    root.github,
    'github',
    ['jobs', 'requiredChecks'],
    ['requiredCodeScanning', 'immutableReleases', 'securityFeatures'],
    errors,
  );
  if (github) {
    if (!Array.isArray(github.jobs)) {
      errors.push('github.jobs 必须是数组');
    } else {
      if (github.jobs.length === 0) errors.push('github.jobs 不能为空');
      const jobIds = new Set<string>();
      const coveredChecks = new Set<string>();
      github.jobs.forEach((entry, index) => {
        const path = `github.jobs[${index}]`;
        const item = objectShape(
          entry,
          path,
          ['id', 'platform', 'toolchains', 'setup', 'checkIds'],
          [],
          errors,
        );
        if (!item) return;
        if (nonEmptyString(item.id, `${path}.id`, errors)) {
          if (!/^[a-z0-9][a-z0-9_-]*$/.test(item.id)) errors.push(`${path}.id 格式非法`);
          if (jobIds.has(item.id)) errors.push(`重复 GitHub job id ${item.id}`);
          jobIds.add(item.id);
        }
        const platform = item.platform;
        if (typeof platform !== 'string' || !PLATFORMS.has(platform as QualityPlatform)) {
          errors.push(`${path}.platform 必须是 linux、macos 或 windows`);
        }
        if (!Array.isArray(item.toolchains)) {
          errors.push(`${path}.toolchains 必须是数组`);
        } else {
          const kinds = new Set<string>();
          item.toolchains.forEach((entryValue, toolIndex) => {
            toolchain(entryValue, `${path}.toolchains[${toolIndex}]`, errors);
            if (isRecord(entryValue) && typeof entryValue.kind === 'string') {
              if (
                entryValue.kind === 'python' &&
                typeof platform === 'string' &&
                PLATFORMS.has(platform as QualityPlatform)
              ) {
                pythonToolchainPlatforms.add(platform as QualityPlatform);
              }
              if (kinds.has(entryValue.kind)) errors.push(`${path}.toolchains 含重复 ${entryValue.kind}`);
              kinds.add(entryValue.kind);
            }
          });
        }
        if (!Array.isArray(item.setup)) {
          errors.push(`${path}.setup 必须是数组`);
        } else {
          item.setup.forEach((entryValue, setupIndex) => {
            command(entryValue, `${path}.setup[${setupIndex}]`, errors);
            if (typeof platform === 'string' && PLATFORMS.has(platform as QualityPlatform)
                && isRecord(entryValue) && Array.isArray(entryValue.platforms)
                && !entryValue.platforms.includes(platform)) {
              errors.push(`${path}.setup[${setupIndex}] 不适用于任务系统 ${platform}`);
            }
          });
        }
        if (stringArray(item.checkIds, `${path}.checkIds`, errors, { nonEmpty: true, unique: true })) {
          for (const checkId of item.checkIds) {
            if (!checkIds.has(checkId)) {
              errors.push(`${path}.checkIds 引用未知检查 ${checkId}`);
              continue;
            }
            coveredChecks.add(checkId);
            if (typeof platform === 'string' && PLATFORMS.has(platform as QualityPlatform)
                && !checkPlatformsById.get(checkId)?.has(platform as QualityPlatform)) {
              errors.push(`${path} 在 ${platform} 运行不适用的检查 ${checkId}`);
            }
          }
        }
      });
      for (const checkId of checkIds) {
        if (!coveredChecks.has(checkId)) errors.push(`项目检查 ${checkId} 未被任何 GitHub job 覆盖`);
      }
    }
  }
  if (pythonToolchainPlatforms.size > 0) {
    if (!Array.isArray(localValidation?.prepare) || localValidation.prepare.length === 0) {
      errors.push('Python 项目必须显式声明 localValidation.prepare 以建立隔离环境');
    }
    if (!Array.isArray(localValidation?.allowedPaths) || localValidation.allowedPaths.length === 0) {
      errors.push('Python 项目必须显式声明 localValidation.allowedPaths 以限定隔离环境目录');
    }
    for (const platform of pythonToolchainPlatforms) {
      if (
        !Array.isArray(localValidation?.prepare) ||
        !localValidation.prepare.some(
          (entry) => isRecord(entry) &&
            Array.isArray(entry.platforms) &&
            entry.platforms.includes(platform),
        )
      ) {
        errors.push(`Python 项目的 localValidation.prepare 必须覆盖 ${platform}`);
      }
    }
  }
  if (github && stringArray(github.requiredChecks, 'github.requiredChecks', errors, {
    nonEmpty: true,
    unique: true,
  })) {
    if (Array.isArray(github.requiredChecks)) {
      for (const required of REQUIRED_GITHUB_CHECKS) {
        if (!github.requiredChecks.includes(required)) {
          errors.push(`github.requiredChecks 必须包含 ${required}`);
        }
      }
    }
  }
  if (github && Object.hasOwn(github, 'requiredCodeScanning')) {
    if (!Array.isArray(github.requiredCodeScanning)) {
      errors.push('github.requiredCodeScanning 必须是数组');
    } else {
      if (github.requiredCodeScanning.length === 0) {
        errors.push('github.requiredCodeScanning 不能为空');
      }
      const tools = new Set<string>();
      github.requiredCodeScanning.forEach((entry, index) => {
        const path = `github.requiredCodeScanning[${index}]`;
        const item = objectShape(
          entry,
          path,
          ['tool', 'alertsThreshold', 'securityAlertsThreshold'],
          [],
          errors,
        );
        if (!item) return;
        if (nonEmptyString(item.tool, `${path}.tool`, errors)) {
          if (/[\r\n]/.test(item.tool)) errors.push(`${path}.tool 不能包含换行`);
          const identity = item.tool.toLowerCase();
          if (tools.has(identity)) errors.push(`github.requiredCodeScanning 含重复工具 ${item.tool}`);
          tools.add(identity);
        }
        if (typeof item.alertsThreshold !== 'string'
            || !CODE_SCANNING_ALERTS_THRESHOLDS.has(
              item.alertsThreshold as QualityCodeScanningAlertsThreshold,
            )) {
          errors.push(`${path}.alertsThreshold 是未知阈值`);
        }
        if (typeof item.securityAlertsThreshold !== 'string'
            || !CODE_SCANNING_SECURITY_ALERTS_THRESHOLDS.has(
              item.securityAlertsThreshold as QualityCodeScanningSecurityAlertsThreshold,
            )) {
          errors.push(`${path}.securityAlertsThreshold 是未知阈值`);
        }
      });
    }
  }
  if (github && Object.hasOwn(github, 'immutableReleases')
      && github.immutableReleases !== true) {
    errors.push('github.immutableReleases 只能声明为 true');
  }
  if (github && Object.hasOwn(github, 'securityFeatures')) {
    const features = objectShape(
      github.securityFeatures,
      'github.securityFeatures',
      ['dependabotSecurityUpdates', 'secretScanning', 'secretScanningPushProtection'],
      [],
      errors,
    );
    if (features) {
      for (const name of [
        'dependabotSecurityUpdates',
        'secretScanning',
        'secretScanningPushProtection',
      ] as const) {
        if (typeof features[name] !== 'boolean') {
          errors.push(`github.securityFeatures.${name} 必须是布尔值`);
        }
      }
      if (features.secretScanningPushProtection === true && features.secretScanning !== true) {
        errors.push('github.securityFeatures 启用推送保护时必须同时启用秘密扫描');
      }
    }
  }

  const exceptions = objectShape(root.exceptions, 'exceptions', ['p1', 'policy'], [], errors);
  if (exceptions) {
    for (const kind of ['p1', 'policy'] as const) {
      const path = `exceptions.${kind}`;
      const item = objectShape(exceptions[kind], path, ['issueTemplate', 'maxDays'], [], errors);
      if (!item) continue;
      repoPath(item.issueTemplate, `${path}.issueTemplate`, errors);
      positiveInteger(item.maxDays, `${path}.maxDays`, 3650, errors);
    }
  }

  return errors;
}

/** JSON key 稳定排序；数组保持原顺序，因为 check/source 顺序具有执行语义。 */
function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (!isRecord(value)) return value;
  return Object.fromEntries(
    Object.keys(value).sort().map((key) => [key, canonicalize(value[key])]),
  );
}

/** 从契约派生可写入 PRD 的检查快照；返回深拷贝，防止调用方改写契约对象。 */
export function deriveQualityChecks(contract: QualityContract): FrozenQualityChecks {
  return structuredClone(contract.checks);
}

/** PRD 快照必须与当前契约逐字段一致，不能只比较命令文本或检查数量。 */
export function qualityChecksMatchContract(
  value: unknown,
  contract: QualityContract,
): value is FrozenQualityChecks {
  return JSON.stringify(canonicalize(value))
    === JSON.stringify(canonicalize(contract.checks));
}

export function digestQualityContract(contract: QualityContract): string {
  const json = JSON.stringify(canonicalize(contract));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

function digestContractSource(value: unknown): string {
  const json = JSON.stringify(canonicalize(value));
  return `sha256:${createHash('sha256').update(json).digest('hex')}`;
}

export function parseQualityContract(value: unknown): QualityContractParseResult {
  const errors = validateContract(value);
  if (errors.length > 0) return { status: 'invalid', errors };
  // 上述严格对象、union、枚举和交叉引用校验完成后才收窄；返回克隆避免调用方改写输入对象。
  const contract = structuredClone(value) as QualityContract;
  return { status: 'ready', contract, digest: digestQualityContract(contract) };
}

/**
 * 默认分支旧规则只读兼容入口。schema 1 没有本地准备声明，因此只允许从旧规则中
 * 同一平台所有 GitHub job 的一致 setup 确定性迁移；候选 PR 不能提供或改写该命令。
 * 返回摘要始终绑定原始默认分支文件，而不是内存中的兼容表示。
 */
export function parseReviewBaseQualityContract(value: unknown): QualityContractParseResult {
  if (!isRecord(value) || value.schemaVersion !== 1) return parseQualityContract(value);
  if (Object.hasOwn(value, 'localValidation')) {
    return { status: 'invalid', errors: ['schemaVersion 1 不能声明 localValidation'] };
  }
  const platform: QualityPlatform | null =
    process.platform === 'linux'
      ? 'linux'
      : process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'win32'
          ? 'windows'
          : null;
  if (!platform) {
    return {
      status: 'invalid',
      errors: [`schemaVersion 1 无法在 ${process.platform} 推导本地准备命令`],
    };
  }
  const github = isRecord(value.github) ? value.github : null;
  const allJobs = Array.isArray(github?.jobs)
    ? github.jobs.filter((job): job is Record<string, unknown> => isRecord(job))
    : [];
  const allToolchainKinds = new Set(
    allJobs.flatMap((job) =>
      Array.isArray(job.toolchains)
        ? job.toolchains.flatMap((toolchain) =>
            isRecord(toolchain) && typeof toolchain.kind === 'string'
              ? [toolchain.kind]
              : [],
          )
        : [],
    ),
  );
  if (allToolchainKinds.has('python')) {
    return {
      status: 'invalid',
      errors: [
        'schemaVersion 1 的 Python setup 未声明隔离安装目录，不能安全迁移为本地准备命令',
      ],
    };
  }
  const jobs = allJobs.filter(
        (job): job is Record<string, unknown> => isRecord(job) && job.platform === platform,
      );
  if (jobs.length === 0) {
    return {
      status: 'invalid',
      errors: [`schemaVersion 1 没有 ${platform} GitHub job，无法确定本地准备命令`],
    };
  }
  const setupValues = jobs.map((job) => job.setup);
  const setupIdentity = setupValues.map((setup) => JSON.stringify(canonicalize(setup)));
  if (
    setupIdentity.length > 1 &&
    setupIdentity.some((identity) => identity !== setupIdentity[0])
  ) {
    return {
      status: 'invalid',
      errors: [`schemaVersion 1 的 ${platform} GitHub jobs setup 不一致，无法确定本地准备命令`],
    };
  }
  const prepare = setupValues[0] ?? [];
  const toolchainKinds = new Set(
    jobs.flatMap((job) =>
      Array.isArray(job.toolchains)
        ? job.toolchains.flatMap((toolchain) =>
            isRecord(toolchain) && typeof toolchain.kind === 'string'
              ? [toolchain.kind]
              : [],
          )
        : [],
    ),
  );
  const migrated = {
    ...value,
    schemaVersion: QUALITY_CONTRACT_SCHEMA_VERSION,
    localValidation: {
      prepare,
      allowedPaths: toolchainKinds.has('node') ? ['node_modules/**'] : [],
    },
  };
  const parsed = parseQualityContract(migrated);
  if (parsed.status !== 'ready') {
    return {
      status: 'invalid',
      errors: parsed.errors.map((error) => `schemaVersion 1 兼容迁移失败：${error}`),
    };
  }
  return { ...parsed, digest: digestContractSource(value) };
}

export function readQualityContract(projectRoot: string): QualityContractReadResult {
  const path = join(projectRoot, QUALITY_CONTRACT_RELATIVE_PATH);
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch (error) {
    const code = isRecord(error) && typeof error.code === 'string' ? error.code : null;
    if (code === 'ENOENT') return { status: 'missing', path };
    return { status: 'io-error', path, error: error instanceof Error ? error.message : String(error) };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      status: 'invalid-json',
      path,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const result = parseQualityContract(parsed);
  if (result.status === 'invalid') return { ...result, path };
  return { ...result, path };
}

export function assessQualityRuntime(
  contract: QualityContract,
  actualVersion: string,
  shadow: boolean,
): QualityRuntimeAssessment {
  const versionMatches = contract.codingXVersion === actualVersion;
  if (shadow) {
    return {
      mode: 'shadow',
      expectedVersion: contract.codingXVersion,
      actualVersion,
      versionMatches,
      deliveryReadyAllowed: false,
    };
  }
  return {
    mode: versionMatches ? 'formal' : 'version-mismatch',
    expectedVersion: contract.codingXVersion,
    actualVersion,
    versionMatches,
    deliveryReadyAllowed: versionMatches,
  };
}
