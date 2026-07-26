import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const QUALITY_CONTRACT_SCHEMA_VERSION = 1 as const;
export const QUALITY_CONTRACT_RELATIVE_PATH = '.coding-x/quality.json';

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
  checks: Record<QualityCheckCategory, QualityCheckPolicy>;
  risk: {
    defaultCategories: QualityRiskCategory[];
    highRiskPaths: string[];
    pathRules: Array<{ paths: string[]; categories: QualityRiskCategory[] }>;
  };
  github: {
    requiredChecks: string[];
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

function validateContract(value: unknown): string[] {
  const errors: string[] = [];
  const root = objectShape(value, '', [
    'schemaVersion', 'codingXVersion', 'repository', 'release', 'sources', 'modules',
    'generatedPaths', 'checks', 'risk', 'github', 'exceptions',
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
    stringArray(release.protectedRefs, 'release.protectedRefs', errors, { unique: true });
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
    validate: (entry, path, target) => repoPath(entry, path, target),
  });

  const checks = objectShape(root.checks, 'checks', CHECK_CATEGORIES, [], errors);
  const checkIds = new Set<string>();
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
        const checkPath = `${groupPath}.checks[${index}]`;
        const item = objectShape(entry, checkPath, ['id', 'module', 'command'], ['paths'], errors);
        if (!item) return;
        if (nonEmptyString(item.id, `${checkPath}.id`, errors)) {
          if (!/^[a-z0-9][a-z0-9._-]*$/.test(item.id)) errors.push(`${checkPath}.id 格式非法`);
          if (checkIds.has(item.id)) errors.push(`重复 check id ${item.id}`);
          checkIds.add(item.id);
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
      });
    }
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

  const github = objectShape(root.github, 'github', ['requiredChecks'], [], errors);
  if (github && stringArray(github.requiredChecks, 'github.requiredChecks', errors, {
    nonEmpty: true,
    unique: true,
  })) {
    if (Array.isArray(github.requiredChecks)) {
      for (const required of ['quality-gate', 'policy-guard']) {
        if (!github.requiredChecks.includes(required)) {
          errors.push(`github.requiredChecks 必须包含 ${required}`);
        }
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

export function parseQualityContract(value: unknown): QualityContractParseResult {
  const errors = validateContract(value);
  if (errors.length > 0) return { status: 'invalid', errors };
  // 上述严格对象、union、枚举和交叉引用校验完成后才收窄；返回克隆避免调用方改写输入对象。
  const contract = structuredClone(value) as QualityContract;
  return { status: 'ready', contract, digest: digestQualityContract(contract) };
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
