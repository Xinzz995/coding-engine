import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { resolveBinary, resolveRunnerExecutablePath, type AgentKind } from '../engine/agent.js';
import { GIT_NULL_CONFIG_PATH } from '../engine/git-environment.js';
import {
  parseGitHubPullRequest,
  parseGitHubRepository,
  type GitHubPullRequestInfo,
} from '../quality/github.js';
import {
  environmentEntries,
  runManagedWorkspaceProcess,
  type ManagedWorkspaceProcessOptions,
} from '../workspace-safety/coordinator.js';
import { inlineModuleArguments } from '../workspace-safety/inline-program.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { normalizeText } from './common.js';
import { resolveReviewInfrastructureExecutable } from './managed-observation.js';
import {
  allowedDirtyPath,
  completePullRequest,
  parseManagedGitStatusPaths,
  type ReviewPreflightContext,
} from './preflight.js';
import { reviewRunnerEnvironment } from './runner.js';
import {
  describeReviewTemporaryRetention,
  ReviewTemporaryDirectory,
  ReviewTemporaryDirectoryError,
} from './temporary-directory.js';

export const REVIEW_AUTHORITY_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const REVIEW_AUTHORITY_SNAPSHOT_MAX_OUTPUT_BYTES = 14 * 1024 * 1024;
const AUTHORITY_FILE_MAX_BYTES = 16 * 1024 * 1024;
const TRACKED_CONTRACT_MAX_BYTES = 1024 * 1024;
const CHILD_OUTPUT_MAX_BYTES = 8 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 30_000;
const AUTHORITY_CHILD_PROCESS_BUDGET = 14;
const MINIMUM_OPERATION_OVERHEAD_MS = 10_000;
type ManagedProcessRunner = typeof runManagedWorkspaceProcess;
type ManagedTermination = ManagedWorkspaceProcessOptions['termination'];

export interface ReviewAuthoritySnapshotRequest {
  readonly phase: string;
  readonly includeDecisions: boolean;
}

export type ReviewAuthoritySnapshotVerifier = (
  request: ReviewAuthoritySnapshotRequest,
) => Promise<string | null>;

export interface ReviewAuthoritySnapshotResult {
  schemaVersion: typeof REVIEW_AUTHORITY_SNAPSHOT_SCHEMA_VERSION;
  requestDigest: string;
  childProcessCount: typeof AUTHORITY_CHILD_PROCESS_BUDGET;
  storyBeforeDigest: string;
  storyAfterDigest: string;
  runnerVersion: string;
  branchBefore: string;
  branchAfter: string;
  headSha: string;
  baseSha: string;
  repositoryJson: string;
  repositoryAfterJson: string;
  pullRequestJson: string;
  pullRequestState: string;
  statusBeforeBase64: string;
  statusBase64: string;
  decisionsDigest: string | null;
}

interface HelperRequest {
  schemaVersion: typeof REVIEW_AUTHORITY_SNAPSHOT_SCHEMA_VERSION;
  projectRoot: string;
  workspace: string;
  runnerDirectory: string;
  git: string;
  gh: string;
  runner: string;
  repository: string;
  defaultBranch: string;
  pullRequestNumber: number;
  includeDecisions: boolean;
  phase: string;
  nonce: string;
  timeoutMs: number;
}

const AUTHORITY_SNAPSHOT_HELPER = String.raw`
import { createHash } from 'node:crypto';
import { closeSync, constants, fstatSync, lstatSync, openSync, readSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

const payload = process.argv[1];
const request = JSON.parse(payload);
const exact = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(label + ' has invalid keys');
};
exact(request, ['schemaVersion','projectRoot','workspace','runnerDirectory','git','gh','runner','repository','defaultBranch','pullRequestNumber','includeDecisions','phase','nonce','timeoutMs'], 'request');
if (request.schemaVersion !== 1) throw new Error('request schema version is invalid');
for (const key of ['projectRoot','workspace','runnerDirectory','git','gh','runner','repository','defaultBranch']) {
  if (typeof request[key] !== 'string' || request[key].length < 1 || request[key].length > 4096 || request[key].includes('\0')) throw new Error(key + ' is invalid');
}
if (!Number.isSafeInteger(request.pullRequestNumber) || request.pullRequestNumber < 1 || typeof request.includeDecisions !== 'boolean' || !Number.isSafeInteger(request.timeoutMs) || request.timeoutMs < 1 || request.timeoutMs > 120000) throw new Error('request scalar is invalid');
if (typeof request.phase !== 'string' || request.phase.length < 1 || request.phase.length > 256 || !/^[0-9a-f-]{36}$/u.test(request.nonce)) throw new Error('request checkpoint identity is invalid');
const sha256 = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const same = (a, b) => a.dev === b.dev && a.ino === b.ino && a.nlink === b.nlink && a.size === b.size && a.mtimeNs === b.mtimeNs && a.ctimeNs === b.ctimeNs;
const stableRead = (path, maximumBytes, missingAllowed = false) => {
  let before;
  try { before = lstatSync(path, { bigint: true }); }
  catch (error) {
    if (missingAllowed && error && error.code === 'ENOENT') return { status: 'missing' };
    throw error;
  }
  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n || before.size > BigInt(maximumBytes)) throw new Error('authority file is not a bounded independent file');
  let fd = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    const nonBlock = process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0);
    fd = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(fd, { bigint: true });
    const openedPath = lstatSync(path, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(maximumBytes) || !same(opened, openedPath)) throw new Error('authority file identity changed while opening');
    const hash = createHash('sha256');
    const chunks = [];
    const chunk = Buffer.allocUnsafe(64 * 1024);
    let total = 0;
    for (;;) {
      const count = readSync(fd, chunk, 0, chunk.length, null);
      if (count === 0) break;
      total += count;
      if (total > maximumBytes) throw new Error('authority file exceeded byte budget');
      const bytes = Buffer.from(chunk.subarray(0, count));
      chunks.push(bytes);
      hash.update(bytes);
    }
    const afterHandle = fstatSync(fd, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (BigInt(total) !== opened.size || !same(opened, afterHandle) || !same(afterHandle, afterPath)) throw new Error('authority file changed while reading');
    return { status: 'ready', fingerprint: 'sha256:' + hash.digest('hex'), bytes: Buffer.concat(chunks) };
  } finally { if (fd !== null) closeSync(fd); }
};
const stableFingerprint = (path, maximumBytes) => {
  const result = stableRead(path, maximumBytes, false);
  if (result.status !== 'ready') throw new Error('required authority file is missing');
  return result.fingerprint;
};
let childProcessCount = 0;
const run = (executable, args, cwd, maximumBytes) => {
  childProcessCount += 1;
  if (childProcessCount > ${AUTHORITY_CHILD_PROCESS_BUDGET}) throw new Error('authority child process budget exceeded');
  const result = spawnSync(executable, args, { cwd, env: process.env, encoding: 'buffer', timeout: request.timeoutMs, maxBuffer: maximumBytes + 1, windowsHide: true, shell: false });
  if (result.error) throw result.error;
  if (result.signal) throw new Error(executable + ' terminated by ' + result.signal);
  if (result.status !== 0) throw new Error(executable + ' exited ' + result.status + ': ' + Buffer.from(result.stderr ?? []).toString('utf8').slice(-2000));
  const stdout = Buffer.from(result.stdout ?? []);
  if (stdout.length > maximumBytes) throw new Error(executable + ' output exceeded byte budget');
  return stdout;
};
const git = (args, maximumBytes = ${CHILD_OUTPUT_MAX_BYTES}) => run(request.git, ['--no-replace-objects','-c','core.hooksPath=${GIT_NULL_CONFIG_PATH}','-c','core.fsmonitor=false', ...args], request.projectRoot, maximumBytes);
const gh = (args, maximumBytes = ${CHILD_OUTPUT_MAX_BYTES}, cwd = request.runnerDirectory) => run(request.gh, args, cwd, maximumBytes);
const tddFingerprint = (prdBytes) => {
  const prd = JSON.parse(prdBytes.toString('utf8'));
  if (!Object.prototype.hasOwnProperty.call(prd, 'tdd')) return sha256(JSON.stringify({ status: 'disabled' }));
  const raw = prd.tdd;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('tdd authority is invalid');
  const result = { status: 'enabled', config: { coverageCheck: raw.coverageCheck, sourcePathspecs: raw.sourcePathspecs, policyFiles: raw.policyFiles, baselineRef: raw.baselineRef, forbiddenAddedPatterns: raw.forbiddenAddedPatterns } };
  return sha256(JSON.stringify(result));
};
const story = () => {
  const head = git(['rev-parse','HEAD'], 4096).toString('utf8').trim();
  const prd = stableRead(join(request.workspace, 'prd.json'), ${AUTHORITY_FILE_MAX_BYTES});
  if (prd.status !== 'ready') throw new Error('prd authority is missing');
  const identity = {
    workspacePath: request.workspace,
    head,
    prd: 'ready:' + prd.fingerprint,
    state: 'ready:' + stableFingerprint(join(request.workspace, 'state.json'), ${AUTHORITY_FILE_MAX_BYTES}),
    workingContract: stableFingerprint(join(request.projectRoot, '.coding-x', 'quality.json'), ${AUTHORITY_FILE_MAX_BYTES}),
    trackedContract: sha256(git(['cat-file','blob', head + ':.coding-x/quality.json'], ${TRACKED_CONTRACT_MAX_BYTES})),
    tdd: tddFingerprint(prd.bytes),
  };
  return sha256(JSON.stringify(identity));
};
const canonical = (value) => Array.isArray(value) ? value.map(canonical) : (!value || typeof value !== 'object' ? value : Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])])));
const decisionDigest = () => {
  const path = join(request.workspace, 'review-decisions.json');
  const observed = stableRead(path, ${AUTHORITY_FILE_MAX_BYTES}, true);
  if (observed.status === 'missing') return sha256(JSON.stringify(canonical({ schemaVersion: 1, decisions: [] })));
  return sha256(JSON.stringify(canonical(JSON.parse(observed.bytes.toString('utf8')))));
};
const storyBeforeDigest = story();
const branchBefore = git(['symbolic-ref','--quiet','--short','HEAD'], 4096).toString('utf8').trim();
const runnerVersionOutput = run(request.runner, ['--version'], request.runnerDirectory, 4 * 1024 * 1024).toString('utf8').trim();
if (!runnerVersionOutput) throw new Error('runner version is empty');
const runnerVersion = runnerVersionOutput.split(/\r?\n/u)[0].trim();
const repositoryJson = gh(['repo','view','--json','nameWithOwner,defaultBranchRef,isPrivate'], ${CHILD_OUTPUT_MAX_BYTES}, request.projectRoot).toString('utf8');
const branchJson = gh(['api','-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28','repos/' + request.repository + '/branches/' + encodeURIComponent(request.defaultBranch)]).toString('utf8');
const branchValue = JSON.parse(branchJson);
if (!branchValue || !branchValue.commit || typeof branchValue.commit.sha !== 'string') throw new Error('default branch response is invalid');
const pullRequestJson = gh(['api','-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28','repos/' + request.repository + '/pulls/' + request.pullRequestNumber]).toString('utf8');
const pullRequestValue = JSON.parse(pullRequestJson);
if (!pullRequestValue || typeof pullRequestValue.state !== 'string') throw new Error('pull request response is invalid');
const statusBefore = git(['status','--porcelain=v1','-z','--untracked-files=all']);
const decisionsDigest = request.includeDecisions ? decisionDigest() : null;
const storyAfterDigest = story();
const branchAfter = git(['symbolic-ref','--quiet','--short','HEAD'], 4096).toString('utf8').trim();
const headSha = git(['rev-parse','HEAD'], 4096).toString('utf8').trim();
const repositoryAfterJson = gh(['repo','view','--json','nameWithOwner,defaultBranchRef,isPrivate'], ${CHILD_OUTPUT_MAX_BYTES}, request.projectRoot).toString('utf8');
const status = git(['status','--porcelain=v1','-z','--untracked-files=all']);
if (childProcessCount !== ${AUTHORITY_CHILD_PROCESS_BUDGET}) throw new Error('authority child process budget was not fully accounted');
const result = {
  schemaVersion: 1,
  requestDigest: sha256(payload),
  childProcessCount,
  storyBeforeDigest,
  storyAfterDigest,
  runnerVersion,
  branchBefore,
  branchAfter,
  headSha,
  baseSha: branchValue.commit.sha,
  repositoryJson,
  repositoryAfterJson,
  pullRequestJson,
  pullRequestState: pullRequestValue.state,
  statusBeforeBase64: statusBefore.toString('base64'),
  statusBase64: status.toString('base64'),
  decisionsDigest,
};
process.stdout.write(JSON.stringify(result));
`;

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function authorityTimeouts(value: number | undefined): {
  childTimeoutMs: number;
  operationTimeoutMs: number;
} {
  const childTimeoutMs = value ?? DEFAULT_TIMEOUT_MS;
  if (!Number.isSafeInteger(childTimeoutMs) || childTimeoutMs < 1 || childTimeoutMs > 120_000) {
    throw new Error('authority snapshot 子命令 timeout 非法');
  }
  return {
    childTimeoutMs,
    operationTimeoutMs:
      childTimeoutMs * AUTHORITY_CHILD_PROCESS_BUDGET +
      Math.max(childTimeoutMs, MINIMUM_OPERATION_OVERHEAD_MS),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function strictString(value: unknown, name: string, maximum: number): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new Error(`authority snapshot ${name} 非法`);
  }
  return value;
}

export function parseReviewAuthoritySnapshotResult(
  bytes: Uint8Array,
  expectedRequestDigest: string,
): ReviewAuthoritySnapshotResult {
  if (bytes.byteLength > REVIEW_AUTHORITY_SNAPSHOT_MAX_OUTPUT_BYTES) {
    throw new Error(
      `authority snapshot 输出超过 ${REVIEW_AUTHORITY_SNAPSHOT_MAX_OUTPUT_BYTES} 字节预算`,
    );
  }
  let value: unknown;
  try {
    value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw new Error(
      `authority snapshot 输出不是严格 UTF-8 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const keys = [
    'schemaVersion',
    'requestDigest',
    'childProcessCount',
    'storyBeforeDigest',
    'storyAfterDigest',
    'runnerVersion',
    'branchBefore',
    'branchAfter',
    'headSha',
    'baseSha',
    'repositoryJson',
    'repositoryAfterJson',
    'pullRequestJson',
    'pullRequestState',
    'statusBeforeBase64',
    'statusBase64',
    'decisionsDigest',
  ] as const;
  if (!isRecord(value) || !exactKeys(value, keys)) {
    throw new Error('authority snapshot 输出 schema 非法');
  }
  if (value.schemaVersion !== REVIEW_AUTHORITY_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('authority snapshot 输出版本非法');
  }
  if (value.childProcessCount !== AUTHORITY_CHILD_PROCESS_BUDGET) {
    throw new Error('authority snapshot 子进程预算非法');
  }
  const requestDigest = strictString(value.requestDigest, 'requestDigest', 71);
  if (requestDigest !== expectedRequestDigest) {
    throw new Error('authority snapshot 输出未绑定当前请求');
  }
  const canonicalDigest = (input: unknown, name: string): string => {
    const result = strictString(input, name, 71);
    if (!/^sha256:[a-f0-9]{64}$/u.test(result)) {
      throw new Error(`authority snapshot ${name} 非法`);
    }
    return result;
  };
  const decisionsDigest =
    value.decisionsDigest === null
      ? null
      : canonicalDigest(value.decisionsDigest, 'decisionsDigest');
  return {
    schemaVersion: REVIEW_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
    requestDigest,
    childProcessCount: AUTHORITY_CHILD_PROCESS_BUDGET,
    storyBeforeDigest: canonicalDigest(value.storyBeforeDigest, 'storyBeforeDigest'),
    storyAfterDigest: canonicalDigest(value.storyAfterDigest, 'storyAfterDigest'),
    runnerVersion: strictString(value.runnerVersion, 'runnerVersion', 4096),
    branchBefore: strictString(value.branchBefore, 'branchBefore', 4096),
    branchAfter: strictString(value.branchAfter, 'branchAfter', 4096),
    headSha: strictString(value.headSha, 'headSha', 128),
    baseSha: strictString(value.baseSha, 'baseSha', 128),
    repositoryJson: strictString(value.repositoryJson, 'repositoryJson', 1024 * 1024),
    repositoryAfterJson: strictString(
      value.repositoryAfterJson,
      'repositoryAfterJson',
      1024 * 1024,
    ),
    pullRequestJson: strictString(value.pullRequestJson, 'pullRequestJson', 2 * 1024 * 1024),
    pullRequestState: strictString(value.pullRequestState, 'pullRequestState', 32),
    statusBeforeBase64: strictString(
      value.statusBeforeBase64,
      'statusBeforeBase64',
      12 * 1024 * 1024,
    ),
    statusBase64: strictString(value.statusBase64, 'statusBase64', 12 * 1024 * 1024),
    decisionsDigest,
  };
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(
      `${name} 不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function labels(value: readonly string[]): string[] {
  return value
    .map((label) => normalizeText(label))
    .sort((left, right) => left.localeCompare(right));
}

function equalPullRequest(
  current: Required<
    Pick<
      GitHubPullRequestInfo,
      'number' | 'headSha' | 'baseBranch' | 'baseSha' | 'url' | 'title' | 'body' | 'labels'
    >
  >,
  expected: ReviewPreflightContext['pullRequest'],
): string | null {
  if (current.number !== expected.number) return '评审期间绑定的开放 PR 消失或编号发生变化';
  if (
    current.headSha !== expected.headSha ||
    current.baseSha !== expected.baseSha ||
    current.baseBranch !== expected.baseBranch
  ) {
    return '评审期间 PR 的 head、base 或目标分支发生变化';
  }
  if (
    normalizeText(current.title) !== normalizeText(expected.title) ||
    normalizeText(current.body) !== normalizeText(expected.body)
  ) {
    return '评审期间 PR 标题或正文发生变化';
  }
  return JSON.stringify(labels(current.labels)) === JSON.stringify(labels(expected.labels))
    ? null
    : '评审期间 PR 标签发生变化';
}

function strictBase64(value: string): Buffer {
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(value)) {
    throw new Error('authority snapshot Git status 不是规范 base64');
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.toString('base64') !== value) {
    throw new Error('authority snapshot Git status base64 非规范');
  }
  return bytes;
}

function snapshotEnvironment(runner: AgentKind): NodeJS.ProcessEnv {
  const environment = reviewRunnerEnvironment(runner);
  for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) {
    if (process.env[name] !== undefined) environment[name] = process.env[name];
  }
  return {
    ...environment,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_OPTIONAL_LOCKS: '0',
  };
}

export async function verifyReviewAuthoritySnapshot(options: {
  session: WorkspaceSession;
  context: ReviewPreflightContext;
  workspace: string;
  runner: AgentKind;
  expectedRunnerVersion: string;
  expectedStoryAuthorityInputDigest: string;
  expectedDecisionsDigest: string;
  includeDecisions: boolean;
  phase: string;
  termination?: ManagedTermination;
  timeoutMs?: number;
  /** @internal Full-operation test seam. */
  managedProcess?: ManagedProcessRunner;
  /** @internal Trusted executable fixtures outside the project. */
  executablesForTests?: { git: string; gh: string; runner: string };
}): Promise<string | null> {
  const root = realpathSync.native(resolve(options.context.root));
  const workspace = realpathSync.native(resolve(options.workspace));
  const { childTimeoutMs, operationTimeoutMs } = authorityTimeouts(options.timeoutMs);
  const temporary = ReviewTemporaryDirectory.create({
    prefix: 'coding-x-review-authority-',
    projectRoot: root,
  });
  let failure: unknown;
  let result: ReviewAuthoritySnapshotResult | undefined;
  try {
    chmodSync(temporary.root, 0o500);
    temporary.sealExactTree({ files: [] });
    const environment = snapshotEnvironment(options.runner);
    const git =
      options.executablesForTests?.git ??
      resolveReviewInfrastructureExecutable('git', root, process.env);
    const gh =
      options.executablesForTests?.gh ??
      resolveReviewInfrastructureExecutable('gh', root, process.env);
    const runner =
      options.executablesForTests?.runner ??
      resolveRunnerExecutablePath(
        options.runner,
        resolveBinary(options.runner),
        temporary.root,
        environment,
      );
    const request: HelperRequest = {
      schemaVersion: REVIEW_AUTHORITY_SNAPSHOT_SCHEMA_VERSION,
      projectRoot: root,
      workspace,
      runnerDirectory: temporary.root,
      git,
      gh,
      runner,
      repository: options.context.baseContract.repository.fullName,
      defaultBranch: options.context.baseContract.repository.defaultBranch,
      pullRequestNumber: options.context.pullRequest.number,
      includeDecisions: options.includeDecisions,
      phase: options.phase,
      nonce: randomUUID(),
      timeoutMs: childTimeoutMs,
    };
    const payload = JSON.stringify(request);
    const requestDigest = sha256(payload);
    temporary.prepareManagedUse();
    temporary.beginManagedUse();
    const observed = await (options.managedProcess ?? runManagedWorkspaceProcess)(options.session, {
      kind: 'final-review',
      delegation: 'read-only-v1',
      executable: process.execPath,
      args: inlineModuleArguments(AUTHORITY_SNAPSHOT_HELPER, payload),
      cwd: temporary.root,
      environment: environmentEntries(environment),
      timeoutMs: operationTimeoutMs,
      ...(options.termination ? { termination: options.termination } : {}),
    });
    if (
      observed.timedOut ||
      observed.processTreeNotEmpty ||
      observed.terminationReason !== null ||
      observed.verdict !== 'completed'
    ) {
      throw new WorkspaceSafetyError(
        observed.processTreeNotEmpty ? 'isolated' : 'invalid',
        observed.processTreeNotEmpty
          ? 'authority snapshot 根进程结束后仍有后代进程'
          : 'authority snapshot 未完整结算',
      );
    }
    temporary.confirmManagedUseSettled();
    if (observed.exitCode !== 0) {
      throw new Error(
        `authority snapshot 失败（退出码 ${observed.exitCode ?? 'null'}）：${Buffer.concat([
          observed.stdout,
          observed.stderr,
        ])
          .toString('utf8')
          .slice(-2000)}`,
      );
    }
    result = parseReviewAuthoritySnapshotResult(observed.stdout, requestDigest);
  } catch (error) {
    failure = error;
  }
  const cleanup = temporary.cleanup();
  if (cleanup.status !== 'removed') {
    const message =
      `authority snapshot 临时域${describeReviewTemporaryRetention(cleanup)}：${cleanup.reason}` +
      (failure === undefined
        ? ''
        : `；原始失败：${
            failure instanceof Error
              ? failure.message
              : typeof failure === 'string'
                ? failure
                : '非 Error 失败'
          }`);
    throw new ReviewTemporaryDirectoryError(message);
  }
  if (failure instanceof Error) throw failure;
  if (failure !== undefined || result === undefined)
    throw new Error('authority snapshot 未返回结果');

  return evaluateReviewAuthoritySnapshot(result, options);
}

export function evaluateReviewAuthoritySnapshot(
  result: ReviewAuthoritySnapshotResult,
  options: {
    context: ReviewPreflightContext;
    workspace: string;
    expectedRunnerVersion: string;
    expectedStoryAuthorityInputDigest: string;
    expectedDecisionsDigest: string;
    includeDecisions: boolean;
  },
): string | null {
  if (
    result.storyBeforeDigest !== options.expectedStoryAuthorityInputDigest ||
    result.storyAfterDigest !== options.expectedStoryAuthorityInputDigest
  ) {
    return 'Story 验收权威输入发生变化；本轮 Review 已作废';
  }
  if (result.runnerVersion !== options.expectedRunnerVersion) {
    return 'Runner 版本发生变化；本轮 Review 已作废';
  }
  if (
    normalizeText(result.branchBefore) !== options.context.branch ||
    normalizeText(result.branchAfter) !== options.context.branch
  ) {
    return '评审期间本地功能分支身份发生变化';
  }
  if (normalizeText(result.headSha) !== options.context.headSha) {
    return '评审期间本地 HEAD 发生变化';
  }
  if (normalizeText(result.baseSha) !== options.context.baseSha) {
    return '评审期间默认分支 base SHA 发生变化';
  }
  const repository = parseGitHubRepository(parseJson(result.repositoryJson, 'GitHub 仓库响应'));
  const repositoryAfter = parseGitHubRepository(
    parseJson(result.repositoryAfterJson, 'GitHub 尾部仓库响应'),
  );
  if (
    repository.fullName !== options.context.baseContract.repository.fullName ||
    repository.defaultBranch !== options.context.baseContract.repository.defaultBranch ||
    repositoryAfter.fullName !== repository.fullName ||
    repositoryAfter.defaultBranch !== repository.defaultBranch ||
    repositoryAfter.isPrivate !== repository.isPrivate
  ) {
    return '评审期间 GitHub 仓库或默认分支身份发生变化';
  }
  if (result.pullRequestState !== 'open') {
    return '评审期间绑定的开放 PR 消失或编号发生变化';
  }
  const current = completePullRequest(
    parseGitHubPullRequest(parseJson(result.pullRequestJson, 'GitHub PR 响应')),
  );
  if (!current) return '评审期间绑定的开放 PR 消失或编号发生变化';
  const pullRequestError = equalPullRequest(current, options.context.pullRequest);
  if (pullRequestError !== null) return pullRequestError;
  const statuses = [result.statusBeforeBase64, result.statusBase64].map((statusBase64) =>
    new TextDecoder('utf-8', { fatal: true }).decode(strictBase64(statusBase64)),
  );
  for (const status of statuses) {
    const dirty = parseManagedGitStatusPaths(status).filter(
      (path) =>
        !allowedDirtyPath(
          options.context.root,
          options.workspace,
          options.context.baseContract.generatedPaths,
          path,
        ),
    );
    if (dirty.length > 0) return `评审期间工作树产生未允许改动：${dirty.join('、')}`;
  }
  if (statuses[0] !== statuses[1]) {
    return '评审期间工作树状态发生变化；本轮 Review 已作废';
  }
  if (options.includeDecisions && result.decisionsDigest !== options.expectedDecisionsDigest) {
    return 'Review 裁决记录发生变化；本轮 Review 已作废';
  }
  if (!options.includeDecisions && result.decisionsDigest !== null) {
    throw new Error('authority snapshot 在未请求时返回了裁决摘要');
  }
  return null;
}
