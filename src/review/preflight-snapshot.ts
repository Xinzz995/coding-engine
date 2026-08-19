import { createHash, randomUUID } from 'node:crypto';
import { chmodSync, realpathSync } from 'node:fs';
import { resolve } from 'node:path';
import { GIT_NULL_CONFIG_PATH } from '../engine/git-environment.js';
import {
  parseReviewBaseQualityContract,
  QUALITY_CONTRACT_RELATIVE_PATH,
  type QualityContract,
} from '../quality/contract.js';
import {
  classifyCommandError,
  parseGitHubPullRequest,
  parseGitHubRepository,
} from '../quality/github.js';
import { environmentEntries, runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import { inlineModuleArguments } from '../workspace-safety/inline-program.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { normalizeText } from './common.js';
import { confirmTemporaryUsesAfterSettledProcessFailure } from './managed-temporary-use.js';
import { resolveReviewInfrastructureExecutable } from './managed-observation.js';
import { runBoundedGitHubReadRetry } from './github-read-retry.js';
import {
  allowedDirtyPath,
  completePullRequest,
  containsGitBinaryPatch,
  isLfsPointer,
  parseManagedGitStatusPaths,
  sourceDocuments,
  validatePullRequestIntent,
  validateReviewChangedFileCount,
  type ReviewFileContent,
  type ReviewPreflightResult,
} from './preflight.js';
import { reviewRunnerEnvironment } from './runner.js';
import {
  describeReviewTemporaryRetention,
  ReviewTemporaryDirectory,
  ReviewTemporaryDirectoryError,
} from './temporary-directory.js';

export const REVIEW_PREFLIGHT_SNAPSHOT_SCHEMA_VERSION = 1 as const;
export const REVIEW_PREFLIGHT_SNAPSHOT_MAX_OUTPUT_BYTES = 14 * 1024 * 1024;
const SNAPSHOT_CHILD_TIMEOUT_MS = 30_000;
const SNAPSHOT_OPERATION_TIMEOUT_MS = 5 * 60_000;

interface PreflightSnapshotRequest {
  readonly schemaVersion: typeof REVIEW_PREFLIGHT_SNAPSHOT_SCHEMA_VERSION;
  readonly projectRoot: string;
  readonly git: string;
  readonly gh: string;
  readonly repository: string;
  readonly defaultBranch: string;
  readonly nonce: string;
  readonly childTimeoutMs: number;
}

interface PreflightSnapshotFile {
  readonly path: string;
  readonly baseMode: string | null;
  readonly headMode: string | null;
  readonly baseBase64: string | null;
  readonly headBase64: string | null;
}

interface PreflightSnapshotDocument {
  readonly path: string;
  readonly contentBase64: string;
}

export interface ReviewPreflightSnapshotResult {
  readonly schemaVersion: typeof REVIEW_PREFLIGHT_SNAPSHOT_SCHEMA_VERSION;
  readonly requestDigest: string;
  readonly childProcessCount: number;
  readonly branch: string;
  readonly repositoryJson: string;
  readonly pullRequestsJson: string;
  readonly baseSha: string;
  readonly headSha: string;
  readonly baseIsAncestor: boolean;
  readonly baseContractBase64: string | null;
  readonly statusBase64: string;
  readonly changedFiles: readonly string[];
  readonly diffBase64: string;
  readonly files: readonly PreflightSnapshotFile[];
  readonly headPaths: readonly string[];
  readonly specs: readonly PreflightSnapshotDocument[];
  readonly engineeringStandards: readonly PreflightSnapshotDocument[];
  readonly historyBase64: string;
}

interface SnapshotOptions {
  readonly session: WorkspaceSession;
  readonly root: string;
  readonly workspace: string;
  readonly currentContract: QualityContract;
  readonly termination?: {
    readonly signal: AbortSignal;
    readonly reason: 'user-interrupt' | 'parent-shutdown';
  };
  /** @internal Deterministic managed-operation seam. */
  readonly managedProcess?: typeof runManagedWorkspaceProcess;
  /** @internal Trusted executable fixtures outside the project. */
  readonly executablesForTests?: { readonly git: string; readonly gh: string };
}

const PREFLIGHT_SNAPSHOT_HELPER = String.raw`
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';

const fatal = (error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(message.length <= 4000 ? message : message.slice(0, 1900) + '…' + message.slice(-1900));
  process.exit(1);
};
process.on('uncaughtException', fatal);
process.on('unhandledRejection', fatal);

const request = JSON.parse(process.argv[1]);
const exact = (value, keys, label) => {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(label + ' must be an object');
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) throw new Error(label + ' has invalid keys');
};
exact(request, ['schemaVersion','projectRoot','git','gh','repository','defaultBranch','nonce','childTimeoutMs'], 'request');
if (request.schemaVersion !== 1 || !Number.isSafeInteger(request.childTimeoutMs) || request.childTimeoutMs < 1 || request.childTimeoutMs > 120000) throw new Error('request scalar is invalid');
for (const key of ['projectRoot','git','gh','repository','defaultBranch']) {
  if (typeof request[key] !== 'string' || request[key].length < 1 || request[key].length > 4096 || request[key].includes('\0')) throw new Error(key + ' is invalid');
}
if (!/^[0-9a-f-]{36}$/u.test(request.nonce)) throw new Error('nonce is invalid');
const sha256 = (value) => 'sha256:' + createHash('sha256').update(value).digest('hex');
const payload = process.argv[1];
let childProcessCount = 0;
let aggregateBytes = 0;
const withoutEnvironment = (environment, names) => {
  const blocked = new Set(names.map((name) => name.toUpperCase()));
  return Object.fromEntries(Object.entries(environment).filter(([name]) => !blocked.has(name.toUpperCase())));
};
const githubNames = ['GH_TOKEN','GITHUB_TOKEN','GH_ENTERPRISE_TOKEN','GH_HOST'];
const gitEnvironment = withoutEnvironment(process.env, githubNames);
const githubEnvironment = process.env;
const MAX_CHILD_BYTES = 8 * 1024 * 1024;
const MAX_AGGREGATE_BYTES = 10 * 1024 * 1024;
const count = (bytes) => {
  aggregateBytes += bytes.length;
  if (aggregateBytes > MAX_AGGREGATE_BYTES) throw new Error('snapshot aggregate exceeds the fixed bound');
  return bytes;
};
const run = (label, executable, args, options = {}) => {
  childProcessCount += 1;
  const observed = spawnSync(executable, args, {
    cwd: request.projectRoot,
    env: options.environment ?? process.env,
    encoding: null,
    stdio: ['ignore','pipe','pipe'],
    timeout: request.childTimeoutMs,
    maxBuffer: options.maximumBytes ?? MAX_CHILD_BYTES,
    windowsHide: true,
    shell: false,
  });
  if (observed.error) throw new Error(label + ': ' + observed.error.message);
  const status = observed.status;
  const allowed = options.allowedStatuses ?? [0];
  if (!allowed.includes(status)) {
    const detail = Buffer.concat([observed.stdout ?? Buffer.alloc(0), observed.stderr ?? Buffer.alloc(0)]).toString('utf8').slice(-1900);
    throw new Error(label + ': exit ' + String(status) + (detail ? ': ' + detail : ''));
  }
  return { status, stdout: count(observed.stdout ?? Buffer.alloc(0)) };
};
const git = (label, args, options = {}) => run(label, request.git, args, { ...options, environment: gitEnvironment });
const gh = (label, args, options = {}) => run(label, request.gh, args, { ...options, environment: githubEnvironment });
const text = (bytes) => bytes.toString('utf8');
const base64 = (bytes) => bytes.toString('base64');
const splitZero = (bytes) => text(bytes).split('\0').filter(Boolean);
const tree = (bytes) => {
  const result = new Map();
  for (const entry of splitZero(bytes)) {
    const tab = entry.indexOf('\t');
    if (tab < 0) throw new Error('git tree entry is invalid');
    const prefix = entry.slice(0, tab).split(' ');
    if (prefix.length !== 3) throw new Error('git tree prefix is invalid');
    const path = entry.slice(tab + 1);
    if (!path || result.has(path)) throw new Error('git tree path is invalid or duplicated');
    result.set(path, { mode: prefix[0], type: prefix[1], object: prefix[2] });
  }
  return result;
};
const glob = (path, pattern) => {
  let regex = '';
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index];
    if (char === '*' && pattern[index + 1] === '*') {
      if (pattern[index + 2] === '/') { regex += '(?:.*/)?'; index += 2; }
      else { regex += '.*'; index += 1; }
    } else if (char === '*') regex += '[^/]*';
    else if (char === '?') regex += '[^/]';
    else regex += char.replace(/[.+^\${}()|[\]\\]/g, '\\$&');
  }
  return new RegExp('^' + regex + '$').test(path);
};
const sections = (body) => {
  const source = String(body ?? '').replaceAll('\r\n','\n').replaceAll('\r','\n').trim();
  const visible = [];
  let depth = 0;
  for (let index = 0; index < source.length;) {
    if (source.startsWith('<!--', index)) { depth += 1; index += 4; continue; }
    if (depth > 0 && source.startsWith('-->', index)) { depth -= 1; index += 3; continue; }
    if (depth === 0) visible.push(source[index]);
    index += 1;
  }
  const normalized = visible.join('');
  const found = [...normalized.matchAll(/^##\s+(.+?)\s*$/gm)];
  return Object.fromEntries(found.map((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = found[index + 1]?.index ?? normalized.length;
    return [match[1].trim(), normalized.slice(start, end).trim()];
  }));
};
const cache = new Map();
const show = (ref, path, label) => {
  const key = ref + '\0' + path;
  if (!cache.has(key)) cache.set(key, git(label, ['show', ref + ':' + path]).stdout);
  return cache.get(key);
};

const branch = text(git('git-branch', ['symbolic-ref','--quiet','--short','HEAD'], { maximumBytes: 4096 }).stdout).trim();
const repositoryJsonBytes = gh('github-repository', ['repo','view','--json','nameWithOwner,defaultBranchRef,isPrivate']).stdout;
const repositoryValue = JSON.parse(text(repositoryJsonBytes));
const fullName = repositoryValue?.nameWithOwner;
const defaultBranch = repositoryValue?.defaultBranchRef?.name;
if (typeof fullName !== 'string' || typeof defaultBranch !== 'string') throw new Error('github-repository: response is invalid');
git('git-fetch', ['fetch','--no-tags','origin',defaultBranch], { maximumBytes: 1024 * 1024 });
const baseSha = text(git('git-base', ['rev-parse','refs/remotes/origin/' + defaultBranch], { maximumBytes: 4096 }).stdout).trim();
const headSha = text(git('git-head', ['rev-parse','HEAD'], { maximumBytes: 4096 }).stdout).trim();
const ancestor = git('git-ancestor', ['merge-base','--is-ancestor',baseSha,headSha], { allowedStatuses: [0,1], maximumBytes: 4096 }).status === 0;
const owner = fullName.split('/')[0];
const query = new URLSearchParams({ state:'open', head:owner + ':' + branch, base:defaultBranch, per_page:'10' });
const pullRequestsJsonBytes = gh('github-pull-request', ['api','-H','Accept: application/vnd.github+json','-H','X-GitHub-Api-Version: 2022-11-28','repos/' + fullName + '/pulls?' + query]).stdout;
const pullRequests = JSON.parse(text(pullRequestsJsonBytes));
const pullRequest = Array.isArray(pullRequests) && pullRequests.length === 1 ? pullRequests[0] : {};
const statusBytes = git('git-status', ['status','--porcelain=v1','-z','--untracked-files=all'], { maximumBytes: 1024 * 1024 }).stdout;
const changedFiles = splitZero(git('git-changed-files', ['diff','--name-only','-z',baseSha + '...' + headSha], { maximumBytes: 1024 * 1024 }).stdout).sort();
if (changedFiles.length > 128) throw new Error('changed file count exceeds snapshot bound');
const diffBytes = git('git-diff', ['diff','--no-ext-diff','--find-renames','--binary',baseSha + '...' + headSha,'--'], { maximumBytes: 6 * 1024 * 1024 }).stdout;
const baseTree = tree(git('git-base-tree', ['ls-tree','-r','-z',baseSha], { maximumBytes: 4 * 1024 * 1024 }).stdout);
const headTree = tree(git('git-head-tree', ['ls-tree','-r','-z',headSha], { maximumBytes: 4 * 1024 * 1024 }).stdout);
const contractEntry = baseTree.get(${JSON.stringify(QUALITY_CONTRACT_RELATIVE_PATH)});
const contractBytes = contractEntry?.type === 'blob' ? show(baseSha, ${JSON.stringify(QUALITY_CONTRACT_RELATIVE_PATH)}, 'git-base-contract') : null;
let rawContract = {};
try { rawContract = contractBytes ? JSON.parse(text(contractBytes)) : {}; } catch { rawContract = {}; }
const files = changedFiles.map((path) => {
  const base = baseTree.get(path);
  const head = headTree.get(path);
  return {
    path,
    baseMode: base?.mode ?? null,
    headMode: head?.mode ?? null,
    baseBase64: base?.type === 'blob' ? base64(show(baseSha, path, 'git-base-file')) : null,
    headBase64: head?.type === 'blob' ? base64(show(headSha, path, 'git-head-file')) : null,
  };
});
const headPaths = [...headTree.keys()];
const referenceText = sections(pullRequest?.body)['Spec 与验收标准来源'] ?? '';
const sourcePatterns = (value) => Array.isArray(value) ? value.filter((entry) => entry?.kind === 'path' && typeof entry.path === 'string').map((entry) => entry.path) : [];
const specPatterns = sourcePatterns(rawContract?.sources?.specs);
const acceptancePatterns = sourcePatterns(rawContract?.sources?.acceptanceCriteria);
const changed = new Set(changedFiles);
const documentPaths = [...new Set(headPaths.filter((path) => {
  const patterns = [...specPatterns, ...acceptancePatterns];
  const exactPatterns = new Set(patterns.filter((pattern) => !/[?*]/u.test(pattern)));
  return patterns.some((pattern) => glob(path, pattern)) && (changed.has(path) || exactPatterns.has(path) || referenceText.includes(path));
}))].sort();
const specs = documentPaths.map((path) => ({ path, contentBase64: base64(show(headSha, path, 'git-spec')) }));
const engineeringPaths = Array.isArray(rawContract?.sources?.engineeringStandards) ? rawContract.sources.engineeringStandards.filter((path) => typeof path === 'string') : [];
const engineeringStandards = engineeringPaths.map((path) => ({ path, contentBase64: base64(show(baseSha, path, 'git-engineering-standard')) }));
const historyBytes = git('git-history', ['log','--format=%H%x09%s','--max-count=20',baseSha + '..' + headSha], { maximumBytes: 1024 * 1024 }).stdout;
const result = {
  schemaVersion: 1,
  requestDigest: sha256(payload),
  childProcessCount,
  branch,
  repositoryJson: text(repositoryJsonBytes),
  pullRequestsJson: text(pullRequestsJsonBytes),
  baseSha,
  headSha,
  baseIsAncestor: ancestor,
  baseContractBase64: contractBytes ? base64(contractBytes) : null,
  statusBase64: base64(statusBytes),
  changedFiles,
  diffBase64: base64(diffBytes),
  files,
  headPaths,
  specs,
  engineeringStandards,
  historyBase64: base64(historyBytes),
};
process.stdout.write(JSON.stringify(result));
`;

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    throw new Error('preflight snapshot 含未知或缺失字段');
  }
}

function strictString(value: unknown, name: string, maximum = 16 * 1024 * 1024): string {
  if (typeof value !== 'string' || value.length > maximum || value.includes('\0')) {
    throw new Error(`preflight snapshot ${name} 非法`);
  }
  return value;
}

function strictBase64(value: unknown, name: string): Buffer {
  const encoded = strictString(value, name, 24 * 1024 * 1024);
  if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/u.test(encoded)) {
    throw new Error(`preflight snapshot ${name} 不是规范 base64`);
  }
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) {
    throw new Error(`preflight snapshot ${name} base64 非规范`);
  }
  return bytes;
}

function nullableString(value: unknown, name: string): string | null {
  return value === null ? null : strictString(value, name);
}

function stringArray(value: unknown, name: string): string[] {
  if (!Array.isArray(value) || value.length > 20_000) {
    throw new Error(`preflight snapshot ${name} 非法`);
  }
  const result = value.map((entry, index) => strictString(entry, `${name}[${index}]`, 4096));
  if (new Set(result).size !== result.length) throw new Error(`preflight snapshot ${name} 重复`);
  return result;
}

function parseFile(value: unknown, index: number): PreflightSnapshotFile {
  if (!isRecord(value)) throw new Error(`preflight snapshot files[${index}] 非法`);
  exactKeys(value, ['path', 'baseMode', 'headMode', 'baseBase64', 'headBase64']);
  const mode = (entry: unknown, name: string): string | null => {
    const result = nullableString(entry, name);
    if (result !== null && !/^[0-7]{6}$/u.test(result)) throw new Error(`${name} 非法`);
    return result;
  };
  return {
    path: strictString(value.path, `files[${index}].path`, 4096),
    baseMode: mode(value.baseMode, `files[${index}].baseMode`),
    headMode: mode(value.headMode, `files[${index}].headMode`),
    baseBase64:
      value.baseBase64 === null
        ? null
        : strictString(value.baseBase64, `files[${index}].baseBase64`, 24 * 1024 * 1024),
    headBase64:
      value.headBase64 === null
        ? null
        : strictString(value.headBase64, `files[${index}].headBase64`, 24 * 1024 * 1024),
  };
}

function parseDocument(value: unknown, name: string): PreflightSnapshotDocument {
  if (!isRecord(value)) throw new Error(`preflight snapshot ${name} 非法`);
  exactKeys(value, ['path', 'contentBase64']);
  return {
    path: strictString(value.path, `${name}.path`, 4096),
    contentBase64: strictString(value.contentBase64, `${name}.contentBase64`, 24 * 1024 * 1024),
  };
}

export function parseReviewPreflightSnapshotResult(
  bytes: Uint8Array,
  expectedRequestDigest: string,
): ReviewPreflightSnapshotResult {
  if (bytes.byteLength > REVIEW_PREFLIGHT_SNAPSHOT_MAX_OUTPUT_BYTES) {
    throw new Error('preflight snapshot 输出超过固定预算');
  }
  let value: unknown;
  try {
    value = JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch (error) {
    throw new Error(
      `preflight snapshot JSON 非法：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (!isRecord(value)) throw new Error('preflight snapshot 结果必须是对象');
  exactKeys(value, [
    'schemaVersion',
    'requestDigest',
    'childProcessCount',
    'branch',
    'repositoryJson',
    'pullRequestsJson',
    'baseSha',
    'headSha',
    'baseIsAncestor',
    'baseContractBase64',
    'statusBase64',
    'changedFiles',
    'diffBase64',
    'files',
    'headPaths',
    'specs',
    'engineeringStandards',
    'historyBase64',
  ]);
  if (value.schemaVersion !== REVIEW_PREFLIGHT_SNAPSHOT_SCHEMA_VERSION) {
    throw new Error('preflight snapshot schema 版本非法');
  }
  if (value.requestDigest !== expectedRequestDigest) {
    throw new Error('preflight snapshot request 摘要不匹配');
  }
  if (
    !Number.isSafeInteger(value.childProcessCount) ||
    (value.childProcessCount as number) < 1 ||
    (value.childProcessCount as number) > 1024
  ) {
    throw new Error('preflight snapshot 子进程计数非法');
  }
  if (typeof value.baseIsAncestor !== 'boolean') {
    throw new Error('preflight snapshot ancestor 结论非法');
  }
  if (!Array.isArray(value.files) || value.files.length > 128) {
    throw new Error('preflight snapshot files 非法');
  }
  if (!Array.isArray(value.specs) || value.specs.length > 256) {
    throw new Error('preflight snapshot specs 非法');
  }
  if (!Array.isArray(value.engineeringStandards) || value.engineeringStandards.length > 256) {
    throw new Error('preflight snapshot engineeringStandards 非法');
  }
  return {
    schemaVersion: REVIEW_PREFLIGHT_SNAPSHOT_SCHEMA_VERSION,
    requestDigest: expectedRequestDigest,
    childProcessCount: value.childProcessCount as number,
    branch: strictString(value.branch, 'branch', 4096),
    repositoryJson: strictString(value.repositoryJson, 'repositoryJson'),
    pullRequestsJson: strictString(value.pullRequestsJson, 'pullRequestsJson'),
    baseSha: strictString(value.baseSha, 'baseSha', 128),
    headSha: strictString(value.headSha, 'headSha', 128),
    baseIsAncestor: value.baseIsAncestor,
    baseContractBase64:
      value.baseContractBase64 === null
        ? null
        : strictString(value.baseContractBase64, 'baseContractBase64', 2 * 1024 * 1024),
    statusBase64: strictString(value.statusBase64, 'statusBase64', 2 * 1024 * 1024),
    changedFiles: stringArray(value.changedFiles, 'changedFiles'),
    diffBase64: strictString(value.diffBase64, 'diffBase64', 10 * 1024 * 1024),
    files: value.files.map(parseFile),
    headPaths: stringArray(value.headPaths, 'headPaths'),
    specs: value.specs.map((entry, index) => parseDocument(entry, `specs[${index}]`)),
    engineeringStandards: value.engineeringStandards.map((entry, index) =>
      parseDocument(entry, `engineeringStandards[${index}]`),
    ),
    historyBase64: strictString(value.historyBase64, 'historyBase64', 2 * 1024 * 1024),
  };
}

function parseJson(value: string, name: string): unknown {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} JSON 非法：${error instanceof Error ? error.message : String(error)}`);
  }
}

function decodeDocument(
  document: PreflightSnapshotDocument,
  name: string,
): {
  path: string;
  content: string;
} {
  return {
    path: document.path,
    content: strictBase64(document.contentBase64, name).toString('utf8'),
  };
}

export function evaluateReviewPreflightSnapshot(
  snapshot: ReviewPreflightSnapshotResult,
  options: {
    readonly root: string;
    readonly workspace: string;
    readonly currentContract: QualityContract;
  },
): ReviewPreflightResult {
  try {
    const branch = normalizeText(snapshot.branch);
    if (!branch)
      return { status: 'config-error', message: '当前处于 detached HEAD，不能绑定功能分支' };
    if (branch === options.currentContract.repository.defaultBranch) {
      return {
        status: 'config-error',
        message: '当前位于默认分支；最终 Review 只允许在功能分支运行',
      };
    }
    const repository = parseGitHubRepository(parseJson(snapshot.repositoryJson, 'GitHub 仓库响应'));
    if (
      repository.fullName !== options.currentContract.repository.fullName ||
      repository.defaultBranch !== options.currentContract.repository.defaultBranch
    ) {
      return {
        status: 'config-error',
        message: '质量契约中的 GitHub 仓库或默认分支与真实远端不一致',
      };
    }
    if (!snapshot.baseIsAncestor) {
      return {
        status: 'remote-not-ready',
        message: `当前分支未包含最新 ${repository.defaultBranch}；请自行 merge 或 rebase 后重跑`,
      };
    }
    const pullRequests = parseJson(snapshot.pullRequestsJson, 'GitHub PR 列表响应');
    if (!Array.isArray(pullRequests)) {
      return { status: 'config-error', message: 'GitHub 返回的 PR 列表非法' };
    }
    if (pullRequests.length === 0) {
      return {
        status: 'remote-not-ready',
        message: '当前分支没有目标为默认分支的开放 GitHub PR',
      };
    }
    if (pullRequests.length > 1) {
      return { status: 'config-error', message: '当前分支对应多个打开的 PR，无法唯一绑定' };
    }
    const pullRequest = completePullRequest(parseGitHubPullRequest(pullRequests[0]));
    if (!pullRequest) {
      return {
        status: 'unverifiable',
        message: 'GitHub PR 缺少标题、正文、base SHA 或标签信息',
      };
    }
    const baseSha = normalizeText(snapshot.baseSha);
    const headSha = normalizeText(snapshot.headSha);
    if (pullRequest.baseBranch !== repository.defaultBranch) {
      return {
        status: 'remote-not-ready',
        message: `PR 目标分支是 ${pullRequest.baseBranch}，不是 ${repository.defaultBranch}`,
      };
    }
    if (pullRequest.headSha !== headSha) {
      return { status: 'remote-not-ready', message: '本地 HEAD 与 GitHub PR 最新提交不一致' };
    }
    if (pullRequest.baseSha !== baseSha) {
      return { status: 'remote-not-ready', message: 'PR base SHA 与刚获取的远端默认分支不一致' };
    }
    const intent = validatePullRequestIntent(pullRequest.body);
    if (!intent.ok) {
      return {
        status: 'unverifiable',
        message: `PR 正文缺少有效内容：${intent.missing.join('、')}`,
      };
    }
    if (snapshot.baseContractBase64 === null) {
      return { status: 'unverifiable', message: '默认分支缺少质量契约，无法用旧规则裁决当前 PR' };
    }
    const rawBaseContract = strictBase64(
      snapshot.baseContractBase64,
      'baseContractBase64',
    ).toString('utf8');
    const baseParsed = parseReviewBaseQualityContract(
      parseJson(rawBaseContract, '默认分支质量契约'),
    );
    if (baseParsed.status !== 'ready') {
      return {
        status: 'unverifiable',
        message: `默认分支质量契约无效：${baseParsed.errors.join('；')}`,
      };
    }
    const baseContract = baseParsed.contract;
    if (
      baseContract.repository.fullName !== repository.fullName ||
      baseContract.repository.defaultBranch !== repository.defaultBranch
    ) {
      return {
        status: 'unverifiable',
        message: '默认分支质量契约指向另一个 GitHub 仓库或默认分支',
      };
    }
    const dirty = parseManagedGitStatusPaths(
      strictBase64(snapshot.statusBase64, 'statusBase64').toString('utf8'),
    ).filter(
      (path) =>
        !allowedDirtyPath(options.root, options.workspace, baseContract.generatedPaths, path),
    );
    if (dirty.length > 0) {
      return { status: 'config-error', message: `工作树含未允许改动：${dirty.join('、')}` };
    }
    const changedFiles = [...snapshot.changedFiles].sort();
    const changedFileCountError = validateReviewChangedFileCount(changedFiles.length);
    if (changedFileCountError) return { status: 'unverifiable', message: changedFileCountError };
    if (JSON.stringify(snapshot.changedFiles) !== JSON.stringify(changedFiles)) {
      return { status: 'unverifiable', message: '批量快照的变更文件顺序不稳定' };
    }
    const diff = strictBase64(snapshot.diffBase64, 'diffBase64').toString('utf8');
    if (containsGitBinaryPatch(diff)) {
      return {
        status: 'unverifiable',
        message: 'PR 包含关键二进制变化，无法完整交给文本 Reviewer',
      };
    }
    if (
      snapshot.files.length !== changedFiles.length ||
      snapshot.files.some((file, index) => file.path !== changedFiles[index])
    ) {
      return { status: 'unverifiable', message: '批量快照的逐文件集合与完整变化不一致' };
    }
    const files: ReviewFileContent[] = snapshot.files.map((file, index) => {
      const validModes = new Set(['100644', '100755', '120000', '160000']);
      if (
        (file.baseMode !== null && !validModes.has(file.baseMode)) ||
        (file.headMode !== null && !validModes.has(file.headMode))
      ) {
        throw new Error(`批量快照文件模式非法：${file.path}`);
      }
      const consistentSide = (mode: string | null, content: string | null): boolean =>
        mode === null ? content === null : mode === '160000' ? content === null : content !== null;
      if (
        !consistentSide(file.baseMode, file.baseBase64) ||
        !consistentSide(file.headMode, file.headBase64)
      ) {
        throw new Error(`批量快照文件存在性与内容不一致：${file.path}`);
      }
      if (file.baseMode === '160000' || file.headMode === '160000') {
        throw new Error(`子模块指针无法在本地 Review 中核验：${file.path}`);
      }
      const base =
        file.baseBase64 === null
          ? null
          : strictBase64(file.baseBase64, `files[${index}].baseBase64`).toString('utf8');
      const head =
        file.headBase64 === null
          ? null
          : strictBase64(file.headBase64, `files[${index}].headBase64`).toString('utf8');
      if (isLfsPointer(base) || isLfsPointer(head)) {
        throw new Error(`Git LFS 内容未展开，无法完整评审：${file.path}`);
      }
      return { path: file.path, base, head };
    });
    const headPaths = [...snapshot.headPaths];
    const referenceText = intent.sections['Spec 与验收标准来源'];
    const specPatterns = baseContract.sources.specs
      .filter((source): source is { kind: 'path'; path: string } => source.kind === 'path')
      .map((source) => source.path);
    const acceptancePatterns = baseContract.sources.acceptanceCriteria
      .filter((source): source is { kind: 'path'; path: string } => source.kind === 'path')
      .map((source) => source.path);
    const expectedSpecPaths = [
      ...new Set([
        ...sourceDocuments({ headPaths, changedFiles, referenceText, patterns: specPatterns }),
        ...sourceDocuments({
          headPaths,
          changedFiles,
          referenceText,
          patterns: acceptancePatterns,
        }),
      ]),
    ].sort();
    if (
      expectedSpecPaths.length === 0 &&
      !baseContract.sources.specs.some((source) => source.kind === 'pull-request')
    ) {
      return { status: 'unverifiable', message: 'PR 没有修改或明确引用质量契约声明的 Spec 文件' };
    }
    if (
      sourceDocuments({ headPaths, changedFiles, referenceText, patterns: acceptancePatterns })
        .length === 0 &&
      !baseContract.sources.acceptanceCriteria.some((source) => source.kind === 'pull-request')
    ) {
      return { status: 'unverifiable', message: 'PR 没有修改或明确引用质量契约声明的验收标准文件' };
    }
    const specs = snapshot.specs.map((entry, index) =>
      decodeDocument(entry, `specs[${index}].contentBase64`),
    );
    if (JSON.stringify(specs.map((entry) => entry.path)) !== JSON.stringify(expectedSpecPaths)) {
      return { status: 'unverifiable', message: '批量快照的 Spec/验收来源路径与质量契约不一致' };
    }
    const engineeringStandards = snapshot.engineeringStandards.map((entry, index) =>
      decodeDocument(entry, `engineeringStandards[${index}].contentBase64`),
    );
    if (
      JSON.stringify(engineeringStandards.map((entry) => entry.path)) !==
      JSON.stringify(baseContract.sources.engineeringStandards)
    ) {
      return { status: 'unverifiable', message: '批量快照的工程规范路径与质量契约不一致' };
    }
    return {
      status: 'ready',
      context: {
        root: options.root,
        branch,
        baseSha,
        headSha,
        pullRequest,
        baseContract,
        baseContractDigest: baseParsed.digest,
        changedFiles,
        files,
        diff,
        specs,
        engineeringStandards,
        history: strictBase64(snapshot.historyBase64, 'historyBase64').toString('utf8').trim(),
        prSections: intent.sections,
      },
    };
  } catch (error) {
    return {
      status: 'unverifiable',
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

function snapshotEnvironment(): NodeJS.ProcessEnv {
  const environment = reviewRunnerEnvironment('codex');
  delete environment.CODEX_API_KEY;
  delete environment.OPENAI_API_KEY;
  delete environment.CODEX_HOME;
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

async function runReviewPreflightSnapshotAttempt(
  options: SnapshotOptions,
): Promise<ReviewPreflightResult> {
  const contextRoot = resolve(options.root);
  const contextWorkspace = resolve(options.workspace);
  const root = realpathSync.native(resolve(options.root));
  realpathSync.native(resolve(options.workspace));
  const temporary = ReviewTemporaryDirectory.create({
    prefix: 'coding-x-preflight-snapshot-',
    projectRoot: root,
  });
  let failure: unknown;
  let snapshot: ReviewPreflightSnapshotResult | undefined;
  try {
    chmodSync(temporary.root, 0o500);
    temporary.sealExactTree({ files: [] });
    const environment = snapshotEnvironment();
    const git =
      options.executablesForTests?.git ??
      resolveReviewInfrastructureExecutable('git', root, process.env);
    const gh =
      options.executablesForTests?.gh ??
      resolveReviewInfrastructureExecutable('gh', root, process.env);
    const request: PreflightSnapshotRequest = {
      schemaVersion: REVIEW_PREFLIGHT_SNAPSHOT_SCHEMA_VERSION,
      projectRoot: root,
      git,
      gh,
      repository: options.currentContract.repository.fullName,
      defaultBranch: options.currentContract.repository.defaultBranch,
      nonce: randomUUID(),
      childTimeoutMs: SNAPSHOT_CHILD_TIMEOUT_MS,
    };
    const payload = JSON.stringify(request);
    const requestDigest = sha256(payload);
    temporary.prepareManagedUse();
    temporary.beginManagedUse();
    const observed = await (options.managedProcess ?? runManagedWorkspaceProcess)(options.session, {
      kind: 'final-review',
      delegation: 'read-only-v1',
      executable: process.execPath,
      args: inlineModuleArguments(PREFLIGHT_SNAPSHOT_HELPER, payload),
      cwd: temporary.root,
      environment: environmentEntries(environment),
      timeoutMs: SNAPSHOT_OPERATION_TIMEOUT_MS,
      ...(options.termination ? { termination: options.termination } : {}),
    });
    if (
      observed.timedOut ||
      observed.processTreeNotEmpty ||
      observed.terminationReason !== null ||
      (observed.verdict !== 'completed' && observed.verdict !== 'root-failed')
    ) {
      throw new WorkspaceSafetyError(
        observed.processTreeNotEmpty ? 'isolated' : 'invalid',
        observed.processTreeNotEmpty
          ? 'preflight snapshot 根进程结束后仍有后代进程'
          : 'preflight snapshot 未完整结算',
      );
    }
    temporary.confirmManagedUseSettled();
    if (observed.verdict === 'root-failed' || observed.exitCode !== 0) {
      const detail = Buffer.concat([observed.stdout, observed.stderr])
        .toString('utf8')
        .slice(-4000);
      throw new Error(
        `preflight snapshot 失败（退出码 ${observed.exitCode ?? 'null'}）：${detail}`,
      );
    }
    snapshot = parseReviewPreflightSnapshotResult(observed.stdout, requestDigest);
  } catch (error) {
    failure = error;
    confirmTemporaryUsesAfterSettledProcessFailure(error, [temporary], ['natural']);
  }
  const cleanup = temporary.cleanup();
  if (cleanup.status !== 'removed') {
    throw new ReviewTemporaryDirectoryError(
      `preflight snapshot 临时域${describeReviewTemporaryRetention(cleanup)}：${cleanup.reason}` +
        (failure instanceof Error ? `；原始失败：${failure.message}` : ''),
    );
  }
  if (failure instanceof Error) throw failure;
  if (failure !== undefined || snapshot === undefined)
    throw new Error('preflight snapshot 未返回结果');
  return evaluateReviewPreflightSnapshot(snapshot, {
    root: contextRoot,
    workspace: contextWorkspace,
    currentContract: options.currentContract,
  });
}

export async function runReviewPreflightSnapshot(
  options: SnapshotOptions,
): Promise<ReviewPreflightResult> {
  return await runBoundedGitHubReadRetry({
    operationName: 'Review preflight snapshot 的 GitHub 读取',
    attempt: async (attempt) => {
      try {
        return {
          status: 'complete',
          value: await runReviewPreflightSnapshotAttempt(options),
        };
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        if (!/(?:github-[a-z-]+|git-fetch):/u.test(detail)) throw error;
        const failure = classifyCommandError(detail, attempt, !options.termination?.signal.aborted);
        if (failure.kind !== 'transient' || !failure.retryable) throw failure;
        return { status: 'retry', failure };
      }
    },
    ...(options.termination
      ? {
          termination: {
            signal: options.termination.signal,
            error: () =>
              new Error(`Review preflight snapshot 已被中断（${options.termination!.reason}）`),
          },
        }
      : {}),
  });
}
