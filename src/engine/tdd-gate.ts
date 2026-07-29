import { createHash } from 'node:crypto';
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import { GATE_TIMEOUT_MS, runGateCommand, type GateFailure } from './gate.js';
import type { Prd, TddConfig, TddPolicyFile } from './prd.js';
import { readSafeControlFileSync, readSafeControlFileUtf8Sync } from './safe-control-file.js';
import { execTrustedToolSync } from './trusted-tool.js';

export type { TddConfig, TddPolicyFile } from './prd.js';

export type TddConfigReadResult =
  | { status: 'disabled' }
  | { status: 'invalid'; error: string }
  | { status: 'enabled'; config: TddConfig };

export type TddPolicyFailureCode =
  | 'project-root-unreadable'
  | 'git-unavailable'
  | 'git-root-mismatch'
  | 'baseline-unreachable'
  | 'policy-file-missing'
  | 'policy-file-outside-root'
  | 'policy-file-duplicate-target'
  | 'policy-file-unreadable'
  | 'policy-hash-mismatch'
  | 'source-scan-failed'
  | 'forbidden-pattern-added'
  | 'coverage-check-failed';

export interface TddGateFailure extends GateFailure {
  code: TddPolicyFailureCode;
}

export interface TddPolicyResult {
  ok: boolean;
  failure: TddGateFailure | null;
  ms: number;
}

export interface TddGateResult {
  ok: boolean;
  /** 政策文件、Git 基线与新增 ignore marker 是否完整。 */
  policyOk: boolean;
  /** coverageCheck 是否实际启动。 */
  commandRan: boolean;
  failure: TddGateFailure | null;
  ms: number;
}

const CONFIG_KEYS = [
  'coverageCheck',
  'sourcePathspecs',
  'policyFiles',
  'baselineRef',
  'forbiddenAddedPatterns',
] as const;
const POLICY_FILE_KEYS = ['path', 'sha256'] as const;
const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;
const TDD_POLICY_FILE_MAX_BYTES = 4 * 1024 * 1024;
const TDD_UNTRACKED_SOURCE_MAX_BYTES = 16 * 1024 * 1024;
const TDD_UNTRACKED_SOURCE_FILE_LIMIT = 4_096;
const TDD_UNTRACKED_SOURCE_TOTAL_MAX_BYTES = 64 * 1024 * 1024;
const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] as const;

interface TddUntrackedScanLimits {
  fileLimit: number;
  totalBytes: number;
}

const DEFAULT_UNTRACKED_SCAN_LIMITS: TddUntrackedScanLimits = {
  fileLimit: TDD_UNTRACKED_SOURCE_FILE_LIMIT,
  totalBytes: TDD_UNTRACKED_SOURCE_TOTAL_MAX_BYTES,
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  return (
    actual.length === expected.length &&
    [...expected].sort().every((key, index) => actual[index] === key)
  );
}

function invalid(error: string): TddConfigReadResult {
  return { status: 'invalid', error };
}

function isNonBlankString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0 && !/[\0\r\n]/.test(value);
}

function hasParentSegment(path: string): boolean {
  return path.split(/[\\/]/).includes('..');
}

function pathspecBody(pathspec: string): string | null {
  if (!pathspec.startsWith(':')) return pathspec;
  if (!pathspec.startsWith(':(')) return null;
  const close = pathspec.indexOf(')');
  if (close < 3) return null;
  const magic = pathspec
    .slice(2, close)
    .split(',')
    .map((part) => part.trim());
  if (magic.length === 0 || magic.some((part) => !['glob', 'top', 'literal'].includes(part))) {
    return null;
  }
  return pathspec.slice(close + 1);
}

function isSafeSourcePathspec(value: unknown): value is string {
  if (!isNonBlankString(value)) return false;
  const body = pathspecBody(value);
  if (!body || isAbsolute(body) || win32.isAbsolute(body) || hasParentSegment(body)) return false;
  if (body.startsWith('!') || body.startsWith('^') || body.includes('\\')) return false;
  return true;
}

function isSafePolicyPath(value: unknown): value is string {
  return (
    isNonBlankString(value) &&
    value !== '.' &&
    !isAbsolute(value) &&
    !win32.isAbsolute(value) &&
    !hasParentSegment(value) &&
    !value.includes('\\')
  );
}

function readUniqueStringArray(
  value: unknown,
  label: string,
  validate: (item: unknown) => item is string,
  options: { caseInsensitiveDuplicates?: boolean } = {},
): { ok: true; value: string[] } | { ok: false; error: string } {
  if (!Array.isArray(value) || value.length === 0) {
    return { ok: false, error: `${label} 必须是非空数组` };
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of value) {
    if (!validate(item)) return { ok: false, error: `${label} 含空值或非法路径/字符串` };
    const key = options.caseInsensitiveDuplicates ? item.toLowerCase() : item;
    if (seen.has(key)) return { ok: false, error: `${label} 含重复项：${item}` };
    seen.add(key);
    out.push(item);
  }
  return { ok: true, value: out };
}

/**
 * `tdd` 一旦出现就严格校验；任何不确定形状都返回 invalid，调用方必须 fail closed。
 * 缺失字段才是唯一的 disabled 状态。
 */
export function readTddConfig(prd: Prd | null): TddConfigReadResult {
  if (!prd || !Object.prototype.hasOwnProperty.call(prd, 'tdd')) return { status: 'disabled' };
  const raw: unknown = (prd as unknown as Record<string, unknown>).tdd;
  if (!isRecord(raw) || !hasExactKeys(raw, CONFIG_KEYS)) {
    return invalid(`tdd 必须只包含 ${CONFIG_KEYS.join('、')}`);
  }
  if (!isNonBlankString(raw.coverageCheck)) return invalid('tdd.coverageCheck 必须是非空单行命令');

  const sourcePathspecs = readUniqueStringArray(
    raw.sourcePathspecs,
    'tdd.sourcePathspecs',
    isSafeSourcePathspec,
  );
  if (!sourcePathspecs.ok) return invalid(sourcePathspecs.error);

  if (!Array.isArray(raw.policyFiles)) return invalid('tdd.policyFiles 必须是数组');
  const policyFiles: TddPolicyFile[] = [];
  const policyPaths = new Set<string>();
  for (const item of raw.policyFiles) {
    if (!isRecord(item) || !hasExactKeys(item, POLICY_FILE_KEYS)) {
      return invalid('tdd.policyFiles 每项必须只包含 path 与 sha256');
    }
    if (!isSafePolicyPath(item.path)) return invalid('tdd.policyFiles.path 必须是项目内相对路径');
    if (typeof item.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(item.sha256)) {
      return invalid(`tdd.policyFiles[${item.path}].sha256 必须是 64 位小写十六进制`);
    }
    if (policyPaths.has(item.path)) return invalid(`tdd.policyFiles 含重复路径：${item.path}`);
    policyPaths.add(item.path);
    policyFiles.push({ path: item.path, sha256: item.sha256 });
  }

  if (
    typeof raw.baselineRef !== 'string' ||
    !/^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(raw.baselineRef)
  ) {
    return invalid('tdd.baselineRef 必须是完整 Git commit id');
  }
  const forbiddenAddedPatterns = readUniqueStringArray(
    raw.forbiddenAddedPatterns,
    'tdd.forbiddenAddedPatterns',
    isNonBlankString,
    { caseInsensitiveDuplicates: true },
  );
  if (!forbiddenAddedPatterns.ok) return invalid(forbiddenAddedPatterns.error);

  return {
    status: 'enabled',
    config: {
      coverageCheck: raw.coverageCheck,
      sourcePathspecs: sourcePathspecs.value,
      policyFiles,
      baselineRef: raw.baselineRef,
      forbiddenAddedPatterns: forbiddenAddedPatterns.value,
    },
  };
}

function fail(
  code: TddPolicyFailureCode,
  message: string,
  command = `[tdd-policy:${code}]`,
  exitCode: number | null = null,
): TddGateFailure {
  return {
    code,
    command,
    exitCode,
    timedOut: false,
    outputTail: message,
  };
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

interface GitResult {
  ok: boolean;
  stdout: string;
  diagnostic: string;
  exitCode: number | null;
}

function runGit(root: string, args: string[]): GitResult {
  try {
    const stdout = execTrustedToolSync('git', [...SAFE_GIT_CONFIG, ...args], {
      cwd: root,
      projectRoot: root,
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: GIT_OUTPUT_LIMIT,
    });
    return { ok: true, stdout, diagnostic: '', exitCode: 0 };
  } catch (error) {
    const detail =
      typeof error === 'object' && error !== null
        ? (error as { stdout?: string | Buffer; stderr?: string | Buffer; status?: number | null })
        : {};
    const stdout = Buffer.isBuffer(detail.stdout)
      ? detail.stdout.toString('utf8')
      : (detail.stdout ?? '');
    const stderr = Buffer.isBuffer(detail.stderr)
      ? detail.stderr.toString('utf8')
      : (detail.stderr ?? '');
    const message = error instanceof Error ? error.message : String(error);
    return {
      ok: false,
      stdout,
      diagnostic: (stderr || message || stdout).slice(-2000),
      exitCode: typeof detail.status === 'number' ? detail.status : null,
    };
  }
}

function findForbiddenAddedLine(diff: string, patterns: readonly string[]): string | null {
  const lowered = patterns.map((pattern) => pattern.toLowerCase());
  let file = 'unknown';
  for (const line of diff.split(/\r?\n/)) {
    if (line.startsWith('+++ ')) {
      file = line.slice(4).replace(/^b\//, '');
      continue;
    }
    if (!line.startsWith('+') || line.startsWith('+++')) continue;
    const added = line.slice(1);
    const index = lowered.findIndex((pattern) => added.toLowerCase().includes(pattern));
    if (index >= 0) return `${file}: 新增了禁止的覆盖忽略标记 “${patterns[index]}”\n${added}`;
  }
  return null;
}

function scanUntracked(
  root: string,
  config: TddConfig,
  limits: TddUntrackedScanLimits,
): TddGateFailure | null {
  const listed = runGit(root, [
    'ls-files',
    '--others',
    '--exclude-standard',
    '-z',
    '--',
    ...config.sourcePathspecs,
  ]);
  if (!listed.ok) {
    return fail(
      'source-scan-failed',
      `无法枚举未跟踪生产文件：${listed.diagnostic}`,
      'git ls-files --others',
      listed.exitCode,
    );
  }
  const lowered = config.forbiddenAddedPatterns.map((pattern) => pattern.toLowerCase());
  let cursor = 0;
  let files = 0;
  let totalBytes = 0;
  while (cursor < listed.stdout.length) {
    const separator = listed.stdout.indexOf('\0', cursor);
    const end = separator === -1 ? listed.stdout.length : separator;
    const relPath = listed.stdout.slice(cursor, end);
    cursor = end + 1;
    if (!relPath) continue;
    files += 1;
    if (files > limits.fileLimit) {
      return fail(
        'source-scan-failed',
        `未跟踪生产文件超过 ${limits.fileLimit} 个，拒绝执行无界扫描`,
      );
    }
    let real: string;
    let content: string;
    try {
      real = realpathSync(resolve(root, relPath));
      if (!isInside(root, real)) {
        return fail('source-scan-failed', `未跟踪生产文件越出项目根：${relPath}`);
      }
      content = readSafeControlFileUtf8Sync(real, {
        maxBytes: TDD_UNTRACKED_SOURCE_MAX_BYTES,
      })!;
      totalBytes += Buffer.byteLength(content);
      if (totalBytes > limits.totalBytes) {
        return fail(
          'source-scan-failed',
          `未跟踪生产文件总量超过 ${limits.totalBytes} bytes，拒绝执行无界扫描`,
        );
      }
    } catch (err) {
      return fail(
        'source-scan-failed',
        `无法读取未跟踪生产文件 ${relPath}：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    for (const line of content.split(/\r?\n/)) {
      const index = lowered.findIndex((pattern) => line.toLowerCase().includes(pattern));
      if (index >= 0) {
        return fail(
          'forbidden-pattern-added',
          `${relPath}: 新增了禁止的覆盖忽略标记 “${config.forbiddenAddedPatterns[index]}”\n${line}`,
        );
      }
    }
  }
  return null;
}

/**
 * 验证受保护政策面，不运行覆盖率命令。启动预检与每轮最终门禁共用。
 */
export function checkTddPolicy(
  config: TddConfig,
  projectRoot: string,
  untrackedScanLimits: TddUntrackedScanLimits = DEFAULT_UNTRACKED_SCAN_LIMITS,
): TddPolicyResult {
  const started = Date.now();
  if (
    !Number.isSafeInteger(untrackedScanLimits.fileLimit) ||
    untrackedScanLimits.fileLimit < 1 ||
    !Number.isSafeInteger(untrackedScanLimits.totalBytes) ||
    untrackedScanLimits.totalBytes < 1
  ) {
    return {
      ok: false,
      failure: fail('source-scan-failed', 'TDD 未跟踪文件扫描上限无效'),
      ms: Date.now() - started,
    };
  }
  let root: string;
  try {
    root = realpathSync(projectRoot);
  } catch (err) {
    return {
      ok: false,
      failure: fail(
        'project-root-unreadable',
        `项目根不可读：${err instanceof Error ? err.message : String(err)}`,
      ),
      ms: Date.now() - started,
    };
  }

  const prefix = runGit(root, ['rev-parse', '--show-prefix']);
  if (!prefix.ok) {
    return {
      ok: false,
      failure: fail(
        'git-unavailable',
        `TDD 门禁要求 Git 仓库：${prefix.diagnostic}`,
        'git rev-parse',
        prefix.exitCode,
      ),
      ms: Date.now() - started,
    };
  }
  if (prefix.stdout.trim() !== '') {
    const top = runGit(root, ['rev-parse', '--show-toplevel']);
    return {
      ok: false,
      failure: fail(
        'git-root-mismatch',
        `coding-x 必须从 Git 根启动；当前 ${root}，Git 根 ${top.ok ? top.stdout.trim() : '不可读'}`,
      ),
      ms: Date.now() - started,
    };
  }

  const baseline = runGit(root, ['cat-file', '-e', `${config.baselineRef}^{commit}`]);
  if (!baseline.ok) {
    return {
      ok: false,
      failure: fail(
        'baseline-unreachable',
        `TDD baselineRef 不可达：${config.baselineRef}`,
        `git cat-file -e ${config.baselineRef}^{commit}`,
        baseline.exitCode,
      ),
      ms: Date.now() - started,
    };
  }

  const policyTargets = new Set<string>();
  for (const policy of config.policyFiles) {
    const lexical = resolve(root, policy.path);
    if (!isInside(root, lexical)) {
      return {
        ok: false,
        failure: fail('policy-file-outside-root', `政策文件越出项目根：${policy.path}`),
        ms: Date.now() - started,
      };
    }
    let real: string;
    try {
      real = realpathSync(lexical);
    } catch (err) {
      const code =
        (err as NodeJS.ErrnoException).code === 'ENOENT'
          ? 'policy-file-missing'
          : 'policy-file-unreadable';
      return {
        ok: false,
        failure: fail(
          code,
          `政策文件不可用 ${policy.path}：${err instanceof Error ? err.message : String(err)}`,
        ),
        ms: Date.now() - started,
      };
    }
    if (!isInside(root, real)) {
      return {
        ok: false,
        failure: fail('policy-file-outside-root', `政策文件 realpath 越出项目根：${policy.path}`),
        ms: Date.now() - started,
      };
    }
    if (policyTargets.has(real)) {
      return {
        ok: false,
        failure: fail('policy-file-duplicate-target', `多个政策路径指向同一文件：${policy.path}`),
        ms: Date.now() - started,
      };
    }
    policyTargets.add(real);
    let actual: string;
    try {
      actual = createHash('sha256')
        .update(readSafeControlFileSync(real, { maxBytes: TDD_POLICY_FILE_MAX_BYTES })!)
        .digest('hex');
    } catch (err) {
      return {
        ok: false,
        failure: fail(
          'policy-file-unreadable',
          `政策文件读取失败 ${policy.path}：${err instanceof Error ? err.message : String(err)}`,
        ),
        ms: Date.now() - started,
      };
    }
    if (actual !== policy.sha256) {
      return {
        ok: false,
        failure: fail(
          'policy-hash-mismatch',
          `政策文件摘要变化：${policy.path}（expected ${policy.sha256}, received ${actual}）`,
        ),
        ms: Date.now() - started,
      };
    }
  }

  const diff = runGit(root, [
    'diff',
    '--no-ext-diff',
    '--no-textconv',
    '--no-color',
    '--unified=0',
    config.baselineRef,
    '--',
    ...config.sourcePathspecs,
  ]);
  if (!diff.ok) {
    return {
      ok: false,
      failure: fail(
        'source-scan-failed',
        `生产代码 diff 扫描失败：${diff.diagnostic}`,
        'git diff <baselineRef> -- <sourcePathspecs>',
        diff.exitCode,
      ),
      ms: Date.now() - started,
    };
  }
  const forbidden = findForbiddenAddedLine(diff.stdout, config.forbiddenAddedPatterns);
  if (forbidden) {
    return {
      ok: false,
      failure: fail('forbidden-pattern-added', forbidden),
      ms: Date.now() - started,
    };
  }
  const untrackedFailure = scanUntracked(root, config, untrackedScanLimits);
  if (untrackedFailure) {
    return { ok: false, failure: untrackedFailure, ms: Date.now() - started };
  }

  return { ok: true, failure: null, ms: Date.now() - started };
}

/**
 * 最终 TDD 门禁：每次先重新验证政策面，再独立运行项目 coverageCheck。
 */
export async function runTddGate(
  config: TddConfig,
  projectRoot: string,
  timeoutMs: number = GATE_TIMEOUT_MS,
): Promise<TddGateResult> {
  const started = Date.now();
  const policy = checkTddPolicy(config, projectRoot);
  if (!policy.ok) {
    return {
      ok: false,
      policyOk: false,
      commandRan: false,
      failure: policy.failure,
      ms: Date.now() - started,
    };
  }
  const commandFailure = await runGateCommand(config.coverageCheck, projectRoot, timeoutMs);
  if (commandFailure) {
    return {
      ok: false,
      policyOk: true,
      commandRan: true,
      failure: { ...commandFailure, code: 'coverage-check-failed' },
      ms: Date.now() - started,
    };
  }
  return {
    ok: true,
    policyOk: true,
    commandRan: true,
    failure: null,
    ms: Date.now() - started,
  };
}
