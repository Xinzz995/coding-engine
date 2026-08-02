import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, relative, resolve, sep, win32 } from 'node:path';
import {
  classifyValidationOnlyGateFailure,
  GATE_TIMEOUT_MS,
  runGateCommand,
  type GateFailure,
  type ManagedGateContext,
  type ValidationOnlyFailureClassification,
} from './gate.js';
import { resolveExecutablePath } from './agent.js';
import { GIT_NULL_CONFIG_PATH } from './git-environment.js';
import type { Prd, TddConfig, TddPolicyFile } from './prd.js';
import { environmentEntries, runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';

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

/**
 * validation-only 的 TDD 失败裁决。只有能直接证明候选违反冻结政策的结果
 * 才算明确失败；基础设施、Git、读取与环境异常都保留候选并返回不可验证。
 */
export function classifyValidationOnlyTddFailure(
  failure: TddGateFailure,
): ValidationOnlyFailureClassification {
  switch (failure.code) {
    case 'policy-file-missing':
    case 'policy-hash-mismatch':
    case 'forbidden-pattern-added':
      return 'failed';
    case 'coverage-check-failed':
      return classifyValidationOnlyGateFailure(failure);
    default:
      return 'unverifiable';
  }
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
  /** coverageCheck 自身的结局；未启动时为 null，不与后置政策复核混写。 */
  commandOk: boolean | null;
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
export const GIT_OUTPUT_LIMIT = 4 * 1024 * 1024;

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

export function fail(
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

export interface GitResult {
  ok: boolean;
  stdout: string;
  diagnostic: string;
  exitCode: number | null;
}

interface ManagedGitPolicyResults {
  prefix: GitResult;
  top?: GitResult;
  baseline?: GitResult;
  diff?: GitResult;
  listed?: GitResult;
}

// One trusted helper invocation owns the entire Git policy probe. Git itself (including a PATH
// wrapper) remains a supervised descendant, while one operation baseline avoids a separate
// coordinator round-trip for every read-only Git command.
const MANAGED_GIT_POLICY_PROBE = String.raw`
import { spawnSync } from 'node:child_process';
const request = JSON.parse(process.argv[1]);
const run = (args) => {
  const result = spawnSync(request.git, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    maxBuffer: ${GIT_OUTPUT_LIMIT},
  });
  const stdout = result.stdout ?? '';
  const stderr = result.stderr ?? '';
  return {
    ok: !result.error && result.status === 0,
    stdout,
    diagnostic: (stderr || result.error?.message || stdout).slice(-2000),
    exitCode: result.status,
  };
};
const output = { prefix: run(['rev-parse', '--show-prefix']) };
if (output.prefix.ok) {
  if (output.prefix.stdout.trim() !== '') {
    output.top = run(['rev-parse', '--show-toplevel']);
  } else {
    output.baseline = run(['cat-file', '-e', request.baselineRef + '^{commit}']);
    if (output.baseline.ok) {
      output.diff = run([
        'diff', '--no-ext-diff', '--no-textconv', '--text', '--no-color', '--unified=0', request.baselineRef,
        '--', ...request.sourcePathspecs,
      ]);
      if (output.diff.ok) {
        output.listed = run([
          'ls-files', '--others', '--exclude-standard', '-z', '--', ...request.sourcePathspecs,
        ]);
      }
    }
  }
}
process.stdout.write(JSON.stringify(output));
`;

async function runManagedGitPolicyProbes(
  root: string,
  config: TddConfig,
  managed: ManagedGateContext,
): Promise<ManagedGitPolicyResults> {
  const environment = { ...(managed.environment ?? process.env) };
  for (const name of Object.keys(environment)) {
    if (name.toUpperCase().startsWith('GIT_')) delete environment[name];
  }
  Object.assign(environment, {
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_OPTIONAL_LOCKS: '0',
    GIT_ATTR_NOSYSTEM: '1',
  });
  let git: string;
  try {
    git = realpathSync.native(
      managed.gitExecutable ?? resolveExecutablePath('git', root, environment),
    );
  } catch (error) {
    return {
      prefix: {
        ok: false,
        stdout: '',
        diagnostic: error instanceof Error ? error.message : String(error),
        exitCode: null,
      },
    };
  }
  const result = await runManagedWorkspaceProcess(managed.session, {
    kind: managed.kind,
    delegation: 'read-only-v1',
    executable: realpathSync(process.execPath),
    args: [
      '--input-type=module',
      '--eval',
      MANAGED_GIT_POLICY_PROBE,
      JSON.stringify({
        git,
        baselineRef: config.baselineRef,
        sourcePathspecs: config.sourcePathspecs,
      }),
    ],
    cwd: root,
    environment: environmentEntries(environment),
    timeoutMs: GATE_TIMEOUT_MS,
    termination: managed.termination,
  });
  const stdout = result.stdout.toString('utf8');
  const stderr = result.stderr.toString('utf8');
  const diagnostic = `${stderr || stdout}${
    result.processTreeNotEmpty ? '\n检测到 Git 探测根进程退出后仍有后代进程；本次结果已拒绝' : ''
  }`.slice(-2000);
  if (
    result.verdict !== 'completed' ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.processTreeNotEmpty
  ) {
    return {
      prefix: {
        ok: false,
        stdout: '',
        diagnostic,
        exitCode: result.exitCode,
      },
    };
  }
  try {
    return JSON.parse(stdout) as ManagedGitPolicyResults;
  } catch (error) {
    return {
      prefix: {
        ok: false,
        stdout: '',
        diagnostic: `Git 探测输出无法解析：${error instanceof Error ? error.message : String(error)}`,
        exitCode: result.exitCode,
      },
    };
  }
}

export function findForbiddenAddedLine(diff: string, patterns: readonly string[]): string | null {
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

export function scanUntrackedListing(
  root: string,
  config: TddConfig,
  listed: GitResult,
): TddGateFailure | null {
  if (!listed.ok) {
    return fail(
      'source-scan-failed',
      `无法枚举未跟踪生产文件：${listed.diagnostic}`,
      'git ls-files --others',
      listed.exitCode,
    );
  }
  const lowered = config.forbiddenAddedPatterns.map((pattern) => pattern.toLowerCase());
  for (const relPath of listed.stdout.split('\0').filter(Boolean)) {
    let real: string;
    let content: string;
    try {
      real = realpathSync(resolve(root, relPath));
      if (!isInside(root, real)) {
        return fail('source-scan-failed', `未跟踪生产文件越出项目根：${relPath}`);
      }
      content = readFileSync(real, 'utf8');
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

export function checkPolicyFiles(
  config: TddConfig,
  root: string,
  started: number,
): TddPolicyResult | null {
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
      actual = createHash('sha256').update(readFileSync(real)).digest('hex');
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
  return null;
}

/**
 * 正式执行路径的 TDD 政策检查。所有 Git 探测都通过当前 WorkspaceSession 的 coordinator；
 * 探测进程只要改变 workspace，coordinator 就会隔离并拒绝，不能产生政策假绿。
 */
export async function checkTddPolicyManaged(
  config: TddConfig,
  projectRoot: string,
  managed: ManagedGateContext,
): Promise<TddPolicyResult> {
  const started = Date.now();
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

  const probes = await runManagedGitPolicyProbes(root, config, managed);
  const prefix = probes.prefix;
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
    const top = probes.top;
    return {
      ok: false,
      failure: fail(
        'git-root-mismatch',
        `coding-x 必须从 Git 根启动；当前 ${root}，Git 根 ${top?.ok ? top.stdout.trim() : '不可读'}`,
      ),
      ms: Date.now() - started,
    };
  }

  const baseline = probes.baseline;
  if (!baseline?.ok) {
    return {
      ok: false,
      failure: fail(
        'baseline-unreachable',
        `TDD baselineRef 不可达：${config.baselineRef}`,
        `git cat-file -e ${config.baselineRef}^{commit}`,
        baseline?.exitCode ?? null,
      ),
      ms: Date.now() - started,
    };
  }

  const policyFailure = checkPolicyFiles(config, root, started);
  if (policyFailure) return policyFailure;

  const diff = probes.diff;
  if (!diff?.ok) {
    return {
      ok: false,
      failure: fail(
        'source-scan-failed',
        `生产代码 diff 扫描失败：${diff?.diagnostic ?? 'Git 探测未返回 diff 结果'}`,
        'git diff <baselineRef> -- <sourcePathspecs>',
        diff?.exitCode ?? null,
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

  const listed = probes.listed ?? {
    ok: false,
    stdout: '',
    diagnostic: 'Git 探测未返回未跟踪文件结果',
    exitCode: null,
  };
  const untrackedFailure = scanUntrackedListing(root, config, listed);
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
  timeoutMs: number | undefined,
  managed: ManagedGateContext,
): Promise<TddGateResult> {
  const started = Date.now();
  const policy = await checkTddPolicyManaged(config, projectRoot, managed);
  if (!policy.ok) {
    return {
      ok: false,
      policyOk: false,
      commandRan: false,
      commandOk: null,
      failure: policy.failure,
      ms: Date.now() - started,
    };
  }
  const commandFailure = await runGateCommand(
    config.coverageCheck,
    projectRoot,
    timeoutMs ?? GATE_TIMEOUT_MS,
    managed,
  );
  if (commandFailure) {
    return {
      ok: false,
      policyOk: true,
      commandRan: true,
      commandOk: false,
      failure: { ...commandFailure, code: 'coverage-check-failed' },
      ms: Date.now() - started,
    };
  }
  // coverageCheck 是项目代码，可能成功退出却改写政策文件、生产代码或未跟踪文件。
  // 必须在同一 session 上重做完整政策检查，不能沿用命令前的结论。
  const policyAfterCommand = await checkTddPolicyManaged(config, projectRoot, managed);
  if (!policyAfterCommand.ok) {
    return {
      ok: false,
      policyOk: false,
      commandRan: true,
      commandOk: true,
      failure: policyAfterCommand.failure,
      ms: Date.now() - started,
    };
  }
  return {
    ok: true,
    policyOk: true,
    commandRan: true,
    commandOk: true,
    failure: null,
    ms: Date.now() - started,
  };
}
