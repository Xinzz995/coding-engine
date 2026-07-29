import { createHash, randomUUID } from 'node:crypto';
import { join, relative, resolve, sep } from 'node:path';
import type { Story } from './prd.js';
import { SafeControlFileError, readSafeControlFileUtf8Sync } from './safe-control-file.js';
import { execTrustedToolSync } from './trusted-tool.js';
import { removeRegisteredWorkspaceFileSync } from './workspace-identity.js';

export const VALIDATION_PROTOCOL_VERSION = 1 as const;
export const VALIDATION_RESULT_FILE = 'validation-result.json';
export const VALIDATION_RESULT_MAX_BYTES = 64 * 1024;
export const VALIDATION_TEXT_MAX_CHARS = 2000;
const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] as const;

function execTrustedGit(
  cwd: string,
  args: readonly string[],
  options: Omit<Parameters<typeof execTrustedToolSync>[2], 'cwd' | 'projectRoot'> = {},
): string {
  return execTrustedToolSync('git', [...SAFE_GIT_CONFIG, ...args], {
    ...options,
    cwd,
    projectRoot: cwd,
  });
}

export interface ValidationRequest {
  version: typeof VALIDATION_PROTOCOL_VERSION;
  requestId: string;
  storyId: string;
  acceptanceHash: string;
  acceptanceCriteria: string[];
  /** 调用 Validator 前的 Git HEAD；非 Git workspace 显式为 null。 */
  gitHead: string | null;
  resultPath: string;
}

export interface ValidationCheck {
  /** 一基序号，必须按 1..N 精确覆盖 request.acceptanceCriteria。 */
  acIndex: number;
  passed: boolean;
  /** Validator 声明的有界证据；是 claim，不是引擎证明。 */
  evidence: string;
}

export interface ValidationResult {
  version: typeof VALIDATION_PROTOCOL_VERSION;
  requestId: string;
  storyId: string;
  acceptanceHash: string;
  gitHead: string | null;
  verdict: 'passed' | 'failed';
  checks: ValidationCheck[];
  summary: string;
}

export type ValidationProtocolErrorCode =
  | 'missing-result'
  | 'unreadable-result'
  | 'result-too-large'
  | 'invalid-json'
  | 'invalid-schema'
  | 'binding-mismatch'
  | 'artifact-changed';

export type ValidationProtocolOutcome =
  | { ok: true; result: ValidationResult }
  | { ok: false; code: ValidationProtocolErrorCode; diagnostic: string };

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, i) => key === wanted[i]);
}

function isGitHead(value: unknown): value is string | null {
  return (
    value === null || (typeof value === 'string' && /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value))
  );
}

function isBoundedText(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.trim().length > 0 &&
    value.length <= VALIDATION_TEXT_MAX_CHARS
  );
}

/** AC 快照身份：只编码 story ID 与有序 AC 数组，避免标题/描述改写造成无关失效。 */
export function acceptanceHash(storyId: string, acceptanceCriteria: readonly string[]): string {
  const canonical = JSON.stringify({ storyId, acceptanceCriteria });
  return `sha256:${createHash('sha256').update(canonical, 'utf8').digest('hex')}`;
}

/**
 * 读取当前提交身份。无法读取时返回 null，供协议兼容、历史诊断与上层拒绝正式运行；
 * 绝不把错误文案或空字符串伪装成 artifact identity。
 */
export function readGitHead(cwd: string): string | null {
  try {
    const value = execTrustedGit(cwd, ['rev-parse', '--verify', 'HEAD'], {
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5_000,
    })
      .trim()
      .toLowerCase();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/.test(value) ? value : null;
  } catch {
    return null;
  }
}

export type ValidationArtifactIdentity =
  { ok: true; gitHead: string } | { ok: false; diagnostic: string };

export type GitObjectClosureResult = { ok: true } | { ok: false; diagnostic: string };

/**
 * 项目 Agent 可以写 .git/objects；只相信对象名会允许被覆盖的压缩对象冒充同一 SHA。
 * 对即将绑定的精确提交闭包强制重算对象哈希，损坏或错名对象一律 fail closed。
 */
export function verifyGitObjectClosure(
  cwd: string,
  refs: readonly string[],
): GitObjectClosureResult {
  if (refs.length === 0) return { ok: false, diagnostic: 'Git 对象核对缺少绑定提交' };
  const nullDevice = process.platform === 'win32' ? 'NUL' : '/dev/null';
  try {
    execTrustedGit(
      cwd,
      [
        '-c',
        `fsck.skipList=${nullDevice}`,
        'fsck',
        '--full',
        '--strict',
        '--no-reflogs',
        '--no-dangling',
        '--no-progress',
        ...refs,
      ],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      diagnostic:
        `Git 提交对象闭包损坏或无法重算：` +
        `${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

function gitStatusPaths(cwd: string): string[] {
  const raw = execTrustedGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const entries = raw.split('\0');
  const paths: string[] = [];
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (!entry) continue;
    if (entry.length < 4) throw new Error('git status 返回非法记录');
    paths.push(entry.slice(3));
    if (entry[0] === 'R' || entry[0] === 'C' || entry[1] === 'R' || entry[1] === 'C') {
      const previous = entries[index + 1];
      if (!previous) throw new Error('git status rename 记录不完整');
      paths.push(previous);
      index += 1;
    }
  }
  return [...new Set(paths)];
}

function gitIndexHiddenPaths(cwd: string): string[] {
  const raw = execTrustedGit(cwd, ['ls-files', '-v', '-z'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 10_000,
    maxBuffer: 16 * 1024 * 1024,
  });
  const hidden: string[] = [];
  for (const entry of raw.split('\0')) {
    if (!entry) continue;
    if (entry.length < 3 || entry[1] !== ' ') throw new Error('git ls-files 返回非法记录');
    // 普通 stage-0 tracked 文件标记为 H。小写标记表示 assume-unchanged，S 表示
    // skip-worktree；其他标记也不是可绑定的普通干净输入，统一 fail closed。
    if (entry[0] !== 'H') hidden.push(entry.slice(2));
  }
  return [...new Set(hidden)];
}

function assertTrackedContentMatchesHead(cwd: string): void {
  try {
    execTrustedGit(
      cwd,
      ['diff', '--no-ext-diff', '--quiet', '--ignore-submodules=none', 'HEAD', '--'],
      {
        stdio: ['ignore', 'ignore', 'pipe'],
        timeout: 30_000,
        maxBuffer: 16 * 1024 * 1024,
      },
    );
  } catch {
    throw new Error('已跟踪文件内容或索引与 HEAD 不一致');
  }
}

/**
 * Validator 凭证绑定 Git HEAD，并在调用前后拒绝已跟踪内容、索引或未忽略
 * 的未跟踪路径变化。workspace 是引擎控制面，允许变化。Git ignored 输入仍属于
 * 本地执行环境，当前凭证不绑定它们；改为精确 HEAD 干净检出执行由 Issue #91 跟踪。
 */
export function readValidationArtifactIdentity(
  cwd: string,
  workspace: string,
): ValidationArtifactIdentity {
  try {
    const before = readGitHead(cwd);
    if (before === null) return { ok: false, diagnostic: '无法读取 Validator 调用前 Git HEAD' };
    const objects = verifyGitObjectClosure(cwd, [before]);
    if (!objects.ok) return objects;
    const hidden = gitIndexHiddenPaths(cwd);
    if (hidden.length > 0) {
      return {
        ok: false,
        diagnostic:
          `Validator 不接受 assume-unchanged、skip-worktree 或其他隐藏索引状态：` +
          hidden.join('、'),
      };
    }
    const workspaceRelative = relative(resolve(cwd), resolve(cwd, workspace)).split(sep).join('/');
    const dirty = gitStatusPaths(cwd).filter(
      (path) =>
        !(
          workspaceRelative !== '' &&
          !workspaceRelative.startsWith('../') &&
          (path === workspaceRelative || path.startsWith(`${workspaceRelative}/`))
        ),
    );
    if (dirty.length > 0) {
      return {
        ok: false,
        diagnostic:
          `Validator 要求已跟踪内容与 HEAD 一致，且不存在未允许的未忽略改动：` + dirty.join('、'),
      };
    }
    assertTrackedContentMatchesHead(cwd);
    const after = readGitHead(cwd);
    if (after === null || after !== before) {
      return { ok: false, diagnostic: '核对工作树期间 Git HEAD 发生变化' };
    }
    return { ok: true, gitHead: after };
  } catch (error) {
    return {
      ok: false,
      diagnostic: `无法核对 Validator 工作树：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function createValidationRequest(
  story: Pick<Story, 'id' | 'acceptanceCriteria'>,
  workspace: string,
  gitHead: string | null,
  requestId: string = randomUUID(),
): ValidationRequest {
  const criteria = [...story.acceptanceCriteria];
  return {
    version: VALIDATION_PROTOCOL_VERSION,
    requestId,
    storyId: story.id,
    acceptanceHash: acceptanceHash(story.id, criteria),
    acceptanceCriteria: criteria,
    gitHead,
    resultPath: join(workspace, VALIDATION_RESULT_FILE),
  };
}

/**
 * 协议块由引擎追加，custom instruction 无占位符也不能静默降级。它只约束控制面；
 * agent 是否遵守由结果文件、目标绑定与 state 不变式机械判定。
 */
export function renderValidatorInstruction(base: string, request: ValidationRequest): string {
  return `${base.trimEnd()}

<!-- ENGINE-BOUND VALIDATION REQUEST: do not infer another target -->
## 引擎绑定的验收请求（最高优先级运行时合同）

- 只验证下面 JSON 指定的 story、AC 快照与 Git HEAD；不得从 progress.md 猜测目标。
- 不得修改 state.json、prd.json 或项目源码。你只提交 Validator claim，最终状态由引擎写入。
- 按 request.acceptanceCriteria 的顺序逐条验证；结果 checks 必须以 1..N 精确覆盖全部 AC。
- 将单个 JSON 对象原子写入 request.resultPath；schema 必须匹配项目 validator 指令。
- 即使验收失败也正常写入 verdict=failed 的结果；不要用进程退出码代替结构化结论。

\`\`\`json
${JSON.stringify(request, null, 2)}
\`\`\`
`;
}

/** 每轮前只清理引擎固定的临时 result 路径；ENOENT 是合法空态。 */
export function clearValidationResult(path: string): void {
  removeRegisteredWorkspaceFileSync(path, true);
}

function invalidSchema(diagnostic: string): ValidationProtocolOutcome {
  return { ok: false, code: 'invalid-schema', diagnostic };
}

function parseValidationResult(value: unknown, acCount: number): ValidationProtocolOutcome {
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      'version',
      'requestId',
      'storyId',
      'acceptanceHash',
      'gitHead',
      'verdict',
      'checks',
      'summary',
    ])
  )
    return invalidSchema('result 必须是且只能包含 v1 schema 字段的对象');

  if (value.version !== VALIDATION_PROTOCOL_VERSION) {
    return invalidSchema(`不支持的 validation result version: ${String(value.version)}`);
  }
  if (
    typeof value.requestId !== 'string' ||
    value.requestId.length === 0 ||
    typeof value.storyId !== 'string' ||
    value.storyId.length === 0 ||
    typeof value.acceptanceHash !== 'string' ||
    !/^sha256:[a-f0-9]{64}$/.test(value.acceptanceHash) ||
    !isGitHead(value.gitHead) ||
    (value.verdict !== 'passed' && value.verdict !== 'failed') ||
    !Array.isArray(value.checks) ||
    !isBoundedText(value.summary)
  ) {
    return invalidSchema('result 顶层字段类型、格式或长度非法');
  }
  if (value.checks.length !== acCount) {
    return invalidSchema(`checks 数量 ${value.checks.length} 与 AC 数量 ${acCount} 不一致`);
  }

  const checks: ValidationCheck[] = [];
  for (let index = 0; index < value.checks.length; index++) {
    const check: unknown = value.checks[index];
    if (
      !isRecord(check) ||
      !hasExactKeys(check, ['acIndex', 'passed', 'evidence']) ||
      check.acIndex !== index + 1 ||
      typeof check.passed !== 'boolean' ||
      !isBoundedText(check.evidence)
    ) {
      return invalidSchema(`checks[${index}] 未按 AC ${index + 1} 的 schema 提交`);
    }
    checks.push({ acIndex: check.acIndex, passed: check.passed, evidence: check.evidence });
  }

  const allPassed = checks.every((check) => check.passed);
  if ((value.verdict === 'passed') !== allPassed) {
    return invalidSchema('verdict 与逐 AC checks 结论矛盾');
  }

  return {
    ok: true,
    result: {
      version: VALIDATION_PROTOCOL_VERSION,
      requestId: value.requestId,
      storyId: value.storyId,
      acceptanceHash: value.acceptanceHash,
      gitHead: value.gitHead,
      verdict: value.verdict,
      checks,
      summary: value.summary,
    },
  };
}

/**
 * 读取、严格解析并与本轮 request/调用后 Git HEAD 对账。所有不确定性都返回
 * 显式错误码，调用方必须 fail closed；result 自身仍只是 source=validator 的 claim。
 */
export function readValidationResult(
  path: string,
  expected: ValidationRequest,
  actualGitHead: string | null,
): ValidationProtocolOutcome {
  let raw: string;
  try {
    const value = readSafeControlFileUtf8Sync(path, {
      maxBytes: VALIDATION_RESULT_MAX_BYTES,
      allowMissing: true,
    });
    if (value === null) {
      return {
        ok: false,
        code: 'missing-result',
        diagnostic: 'Validator 未写 validation result',
      };
    }
    raw = value;
  } catch (err) {
    if (err instanceof SafeControlFileError && err.code === 'too-large') {
      return {
        ok: false,
        code: 'result-too-large',
        diagnostic: `validation result 超过 ${VALIDATION_RESULT_MAX_BYTES} bytes`,
      };
    }
    return {
      ok: false,
      code: 'unreadable-result',
      diagnostic: `validation result 不可读：${err instanceof Error ? err.message : String(err)}`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    return { ok: false, code: 'invalid-json', diagnostic: 'validation result 不是合法 JSON' };
  }
  const shaped = parseValidationResult(parsed, expected.acceptanceCriteria.length);
  if (!shaped.ok) return shaped;

  const result = shaped.result;
  if (
    result.requestId !== expected.requestId ||
    result.storyId !== expected.storyId ||
    result.acceptanceHash !== expected.acceptanceHash ||
    result.gitHead !== expected.gitHead
  ) {
    return {
      ok: false,
      code: 'binding-mismatch',
      diagnostic: 'validation result 与本轮 request ID、story、AC hash 或 Git HEAD 不匹配',
    };
  }
  if (actualGitHead !== expected.gitHead) {
    return {
      ok: false,
      code: 'artifact-changed',
      diagnostic: 'Validator 执行期间 Git HEAD 发生变化，结果不再绑定调用前产物',
    };
  }
  return shaped;
}
