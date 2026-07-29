import { relative, resolve, sep } from 'node:path';
import {
  execTrustedToolSync,
  readTrustedGitBlobUtf8Sync,
  TrustedGitBlobUtf8Error,
} from '../engine/trusted-tool.js';
import { verifyGitObjectClosure } from '../engine/validation-protocol.js';
import {
  digestQualityContract,
  parseQualityContract,
  QUALITY_CONTRACT_MAX_BYTES,
  QUALITY_CONTRACT_RELATIVE_PATH,
  type QualityContract,
} from '../quality/contract.js';
import {
  GhGitHubQualityClient,
  GitHubQualityError,
  type GitHubPullRequestInfo,
  type GitHubQualityClient,
} from '../quality/github.js';
import { matchesAny, normalizeText } from './common.js';

const REQUIRED_PR_SECTIONS = [
  '本次目标',
  '明确的非目标',
  'Spec 与验收标准来源',
  '验证方式',
  '风险说明',
] as const;
const SAFE_GIT_CONFIG = ['-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false'] as const;
const REVIEW_CONTEXT_MAX_BYTES = 8 * 1024 * 1024;
const GIT_OUTPUT_MARGIN_BYTES = 64 * 1024;
const REVIEW_PATH_LIST_MAX_BYTES = 2 * 1024 * 1024;

interface ReviewContentBudget {
  usedBytes: number;
  readonly maxBytes: number;
}

type GitFileReadResult =
  | { status: 'ready'; content: string; bytes: number }
  | { status: 'missing' }
  | { status: 'unreadable' }
  | { status: 'invalid-utf8' }
  | { status: 'over-limit'; reason: 'file' | 'aggregate'; maxBytes: number };

export interface ReviewFileContent {
  path: string;
  base: string | null;
  head: string | null;
}

export interface ReviewPreflightContext {
  root: string;
  /** 本轮允许变化的引擎 workspace（绝对路径）。 */
  workspace: string;
  branch: string;
  baseSha: string;
  headSha: string;
  pullRequest: Required<
    Pick<
      GitHubPullRequestInfo,
      'number' | 'headSha' | 'baseBranch' | 'baseSha' | 'url' | 'title' | 'body' | 'labels'
    >
  >;
  baseContract: QualityContract;
  baseContractDigest: string;
  changedFiles: string[];
  files: ReviewFileContent[];
  diff: string;
  specs: Array<{ path: string; content: string }>;
  engineeringStandards: Array<{ path: string; content: string }>;
  history: string;
  prSections: Record<(typeof REQUIRED_PR_SECTIONS)[number], string>;
}

export type ReviewPreflightResult =
  | { status: 'ready'; context: ReviewPreflightContext }
  | { status: 'config-error'; message: string }
  | { status: 'remote-not-ready'; message: string }
  | { status: 'unverifiable'; message: string };

export type ReviewContextRevalidation = { ok: true } | { ok: false; message: string };

function git(root: string, args: string[], maxBuffer = 32 * 1024 * 1024): string {
  return execTrustedToolSync('git', [...SAFE_GIT_CONFIG, ...args], {
    cwd: root,
    projectRoot: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer,
  });
}

function tryGit(root: string, args: string[]): string | null {
  try {
    return git(root, args);
  } catch {
    return null;
  }
}

function trackedPaths(root: string, ref: string): string[] {
  return git(
    root,
    ['ls-tree', '-r', '--name-only', '-z', ref],
    REVIEW_PATH_LIST_MAX_BYTES + GIT_OUTPUT_MARGIN_BYTES,
  )
    .split('\0')
    .filter(Boolean);
}

function existsAt(root: string, ref: string, path: string): boolean {
  return tryGit(root, ['cat-file', '-e', `${ref}:${path}`]) !== null;
}

function showWithinBudget(
  root: string,
  ref: string,
  path: string,
  budget: ReviewContentBudget,
  perFileMaxBytes = budget.maxBytes,
): GitFileReadResult {
  const rawSize = tryGit(root, ['cat-file', '-s', `${ref}:${path}`]);
  if (rawSize === null) {
    return { status: existsAt(root, ref, path) ? 'unreadable' : 'missing' };
  }
  const normalizedSize = normalizeText(rawSize);
  if (!/^\d+$/.test(normalizedSize)) return { status: 'unreadable' };
  const declaredBytes = Number(normalizedSize);
  if (!Number.isSafeInteger(declaredBytes)) return { status: 'unreadable' };
  const remainingBytes = budget.maxBytes - budget.usedBytes;
  if (declaredBytes > perFileMaxBytes) {
    return { status: 'over-limit', reason: 'file', maxBytes: perFileMaxBytes };
  }
  if (declaredBytes > remainingBytes) {
    return { status: 'over-limit', reason: 'aggregate', maxBytes: budget.maxBytes };
  }

  let read: { content: string; bytes: number };
  try {
    read = readTrustedGitBlobUtf8Sync(root, ref, path, {
      maxBuffer: Math.min(perFileMaxBytes, remainingBytes) + GIT_OUTPUT_MARGIN_BYTES,
    });
  } catch (error) {
    if (error instanceof TrustedGitBlobUtf8Error) return { status: 'invalid-utf8' };
    return { status: 'unreadable' };
  }
  const { content, bytes } = read;
  if (bytes !== declaredBytes) return { status: 'unreadable' };
  if (bytes > perFileMaxBytes) {
    return { status: 'over-limit', reason: 'file', maxBytes: perFileMaxBytes };
  }
  if (bytes > remainingBytes) {
    return { status: 'over-limit', reason: 'aggregate', maxBytes: budget.maxBytes };
  }
  budget.usedBytes += bytes;
  return { status: 'ready', content, bytes };
}

function contextLimitMessage(path: string): ReviewPreflightResult {
  return {
    status: 'unverifiable',
    message:
      `完整 Review 上下文总量超过 ${REVIEW_CONTEXT_MAX_BYTES} bytes（读取 ${path} 时达到上限）；` +
      '不会截断或自动分片，请拆分 PR',
  };
}

function fileLimitMessage(path: string, maxBytes: number): ReviewPreflightResult {
  return {
    status: 'unverifiable',
    message: `${path} 超过 ${maxBytes} bytes，无法完整纳入 Review；不会截断，请缩小文件`,
  };
}

function readLimitMessage(
  path: string,
  read: Extract<GitFileReadResult, { status: 'over-limit' }>,
): ReviewPreflightResult {
  return read.reason === 'file' ? fileLimitMessage(path, read.maxBytes) : contextLimitMessage(path);
}

function consumeReviewText(
  budget: ReviewContentBudget,
  value: string,
  label: string,
): ReviewPreflightResult | null {
  const bytes = Buffer.byteLength(value);
  if (budget.usedBytes + bytes > budget.maxBytes) return contextLimitMessage(label);
  budget.usedBytes += bytes;
  return null;
}

function remainingGitOutputLimit(budget: ReviewContentBudget): number {
  return Math.max(0, budget.maxBytes - budget.usedBytes) + GIT_OUTPUT_MARGIN_BYTES;
}

function statusPaths(root: string): string[] {
  const entries = git(root, [
    'status',
    '--porcelain=v1',
    '-z',
    '--untracked-files=all',
    '--ignore-submodules=none',
  ]).split('\0');
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

function hiddenIndexPaths(root: string): string[] {
  const hidden: string[] = [];
  for (const entry of git(root, ['ls-files', '-v', '-z']).split('\0')) {
    if (!entry) continue;
    if (entry.length < 3 || entry[1] !== ' ') throw new Error('git ls-files 返回非法记录');
    if (entry[0] !== 'H') hidden.push(entry.slice(2));
  }
  return [...new Set(hidden)];
}

function trackedContentPaths(root: string): string[] {
  return git(root, [
    'diff',
    '--name-only',
    '-z',
    '--no-ext-diff',
    '--no-textconv',
    '--ignore-submodules=none',
    'HEAD',
    '--',
  ])
    .split('\0')
    .filter(Boolean);
}

function allowedDirtyPath(
  root: string,
  workspace: string,
  generated: string[],
  path: string,
): boolean {
  const workspaceAbsolute = resolve(workspace);
  const workspaceRelative = relative(root, workspaceAbsolute).split(sep).join('/');
  if (
    workspaceRelative !== '' &&
    !workspaceRelative.startsWith('../') &&
    (path === workspaceRelative || path.startsWith(`${workspaceRelative}/`))
  )
    return true;
  return matchesAny(path, generated);
}

function disallowedWorktreeState(options: {
  root: string;
  workspace: string;
  generated: string[];
  refs: string[];
}): string | null {
  const objects = verifyGitObjectClosure(options.root, options.refs);
  if (!objects.ok) return objects.diagnostic;
  const hidden = hiddenIndexPaths(options.root);
  if (hidden.length > 0) {
    return `存在 assume-unchanged、skip-worktree 或其他隐藏索引状态：${hidden.join('、')}`;
  }
  const dirty = [
    ...new Set([...statusPaths(options.root), ...trackedContentPaths(options.root)]),
  ].filter((path) => !allowedDirtyPath(options.root, options.workspace, options.generated, path));
  return dirty.length > 0 ? `Git 可见工作树含未允许改动：${dirty.join('、')}` : null;
}

function parseSections(body: string): Record<string, string> {
  const source = normalizeText(body);
  const visible: string[] = [];
  let commentDepth = 0;
  for (let index = 0; index < source.length;) {
    if (source.startsWith('<!--', index)) {
      commentDepth += 1;
      index += 4;
      continue;
    }
    if (commentDepth > 0 && source.startsWith('-->', index)) {
      commentDepth -= 1;
      index += 3;
      continue;
    }
    if (commentDepth === 0) visible.push(source[index]);
    index += 1;
  }
  const normalized = visible.join('');
  const sections: Record<string, string> = {};
  const matches = [...normalized.matchAll(/^##\s+(.+?)\s*$/gm)];
  matches.forEach((match, index) => {
    const start = (match.index ?? 0) + match[0].length;
    const end = matches[index + 1]?.index ?? normalized.length;
    sections[match[1].trim()] = normalized.slice(start, end).trim();
  });
  return sections;
}

function hasMeaningfulIntent(value: string | undefined): boolean {
  return value !== undefined && /[\p{L}\p{N}]/u.test(value);
}

export function validatePullRequestIntent(
  body: string,
):
  | { ok: true; sections: Record<(typeof REQUIRED_PR_SECTIONS)[number], string> }
  | { ok: false; missing: string[] } {
  const parsed = parseSections(body);
  const missing = REQUIRED_PR_SECTIONS.filter((name) => !hasMeaningfulIntent(parsed[name]));
  if (missing.length > 0) return { ok: false, missing: [...missing] };
  return {
    ok: true,
    sections: Object.fromEntries(
      REQUIRED_PR_SECTIONS.map((name) => [name, parsed[name]]),
    ) as Record<(typeof REQUIRED_PR_SECTIONS)[number], string>,
  };
}

function completePullRequest(
  pr: GitHubPullRequestInfo,
): ReviewPreflightContext['pullRequest'] | null {
  if (
    pr.baseSha === undefined ||
    pr.title === undefined ||
    pr.body === undefined ||
    pr.labels === undefined
  ) {
    return null;
  }
  return {
    number: pr.number,
    headSha: pr.headSha,
    baseBranch: pr.baseBranch,
    baseSha: pr.baseSha,
    url: pr.url,
    title: pr.title,
    body: pr.body,
    labels: pr.labels,
  };
}

function isSubmodule(root: string, ref: string, path: string): boolean {
  const value = tryGit(root, ['ls-tree', ref, '--', path]);
  return value !== null && value.startsWith('160000 ');
}

function isLfsPointer(content: string | null): boolean {
  return content?.startsWith('version https://git-lfs.github.com/spec/v1\n') ?? false;
}

function sourceDocuments(options: {
  headPaths: string[];
  changedFiles: string[];
  referenceText: string;
  patterns: string[];
}): string[] {
  const changed = new Set(options.changedFiles);
  const exact = new Set(options.patterns.filter((pattern) => !/[?*]/.test(pattern)));
  return options.headPaths.filter(
    (path) =>
      matchesAny(path, options.patterns) &&
      (changed.has(path) || exact.has(path) || options.referenceText.includes(path)),
  );
}

/** 模型调用结束后再次核对易变的本地提交、默认分支和 PR 意图。 */
export function revalidateReviewContext(
  context: ReviewPreflightContext,
  client: GitHubQualityClient,
): ReviewContextRevalidation {
  try {
    const repository = client.discoverRepository(context.root);
    if (
      repository.fullName !== context.baseContract.repository.fullName ||
      repository.defaultBranch !== context.baseContract.repository.defaultBranch
    ) {
      return { ok: false, message: '评审期间 GitHub 仓库或默认分支身份发生变化' };
    }
    const currentHead = normalizeText(git(context.root, ['rev-parse', 'HEAD']));
    if (currentHead !== context.headSha)
      return { ok: false, message: '评审期间本地 HEAD 发生变化' };
    const worktreeProblem = disallowedWorktreeState({
      root: context.root,
      workspace: context.workspace,
      generated: context.baseContract.generatedPaths,
      refs: [context.baseSha, context.headSha],
    });
    if (worktreeProblem) {
      return {
        ok: false,
        message: `评审期间${worktreeProblem}`,
      };
    }
    const found = client.findOpenPullRequest(repository, context.branch);
    const current = found ? completePullRequest(found) : null;
    if (!current || current.number !== context.pullRequest.number) {
      return { ok: false, message: '评审期间绑定的开放 PR 消失或编号发生变化' };
    }
    if (
      current.headSha !== context.headSha ||
      current.baseSha !== context.baseSha ||
      current.baseBranch !== context.pullRequest.baseBranch
    ) {
      return { ok: false, message: '评审期间 PR 的 head、base 或目标分支发生变化' };
    }
    if (
      normalizeText(current.title) !== normalizeText(context.pullRequest.title) ||
      normalizeText(current.body) !== normalizeText(context.pullRequest.body)
    ) {
      return { ok: false, message: '评审期间 PR 标题或正文发生变化' };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `无法在评审结束时重新核对提交与 PR：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export function runReviewPreflight(options: {
  root: string;
  workspace: string;
  currentContract: QualityContract;
  client?: GitHubQualityClient;
}): ReviewPreflightResult {
  const root = resolve(options.root);
  const client = options.client ?? new GhGitHubQualityClient();
  try {
    const branch = normalizeText(git(root, ['symbolic-ref', '--quiet', '--short', 'HEAD']));
    if (!branch)
      return { status: 'config-error', message: '当前处于 detached HEAD，不能绑定功能分支' };
    if (branch === options.currentContract.repository.defaultBranch) {
      return {
        status: 'config-error',
        message: '当前位于默认分支；最终 Review 只允许在功能分支运行',
      };
    }
    const repository = client.discoverRepository(root);
    if (
      repository.fullName !== options.currentContract.repository.fullName ||
      repository.defaultBranch !== options.currentContract.repository.defaultBranch
    ) {
      return {
        status: 'config-error',
        message: '质量契约中的 GitHub 仓库或默认分支与真实远端不一致',
      };
    }
    const headSha = normalizeText(git(root, ['rev-parse', 'HEAD']));

    const found = client.findOpenPullRequest(repository, branch);
    if (!found) {
      return { status: 'remote-not-ready', message: '当前分支没有目标为默认分支的开放 GitHub PR' };
    }
    const pullRequest = completePullRequest(found);
    if (!pullRequest) {
      return { status: 'unverifiable', message: 'GitHub PR 缺少标题、正文、base SHA 或标签信息' };
    }
    if (pullRequest.baseBranch !== repository.defaultBranch) {
      return {
        status: 'remote-not-ready',
        message: `PR 目标分支是 ${pullRequest.baseBranch}，不是 ${repository.defaultBranch}`,
      };
    }
    if (pullRequest.headSha !== headSha) {
      return { status: 'remote-not-ready', message: '本地 HEAD 与 GitHub PR 最新提交不一致' };
    }
    const baseSha = pullRequest.baseSha;
    if (tryGit(root, ['cat-file', '-e', `${baseSha}^{commit}`]) === null) {
      return {
        status: 'remote-not-ready',
        message: `本地尚无 PR 最新 base 提交 ${baseSha}；请自行 fetch 后重跑`,
      };
    }
    if (tryGit(root, ['merge-base', '--is-ancestor', baseSha, headSha]) === null) {
      return {
        status: 'remote-not-ready',
        message: `当前分支未包含 PR 最新 ${repository.defaultBranch}；请自行 merge 或 rebase 后重跑`,
      };
    }
    const intent = validatePullRequestIntent(pullRequest.body);
    if (!intent.ok) {
      return {
        status: 'unverifiable',
        message: `PR 正文缺少有效内容：${intent.missing.join('、')}`,
      };
    }

    const contentBudget: ReviewContentBudget = {
      usedBytes: 0,
      maxBytes: REVIEW_CONTEXT_MAX_BYTES,
    };
    const pullRequestBudgetError = consumeReviewText(
      contentBudget,
      `${pullRequest.title}\n${pullRequest.body}`,
      'PR 标题与正文',
    );
    if (pullRequestBudgetError !== null) return pullRequestBudgetError;
    const baseContractRead = showWithinBudget(
      root,
      baseSha,
      QUALITY_CONTRACT_RELATIVE_PATH,
      contentBudget,
      QUALITY_CONTRACT_MAX_BYTES,
    );
    if (baseContractRead.status === 'over-limit') {
      return readLimitMessage(QUALITY_CONTRACT_RELATIVE_PATH, baseContractRead);
    }
    if (baseContractRead.status === 'missing') {
      return { status: 'unverifiable', message: '默认分支缺少质量契约，无法用旧规则裁决当前 PR' };
    }
    if (baseContractRead.status === 'invalid-utf8') {
      return { status: 'unverifiable', message: '默认分支质量契约不是合法 UTF-8 文本' };
    }
    if (baseContractRead.status === 'unreadable') {
      return { status: 'unverifiable', message: '默认分支质量契约无法完整读取' };
    }
    const rawBaseContract: string = baseContractRead.content;
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBaseContract) as unknown;
    } catch {
      return { status: 'unverifiable', message: '默认分支质量契约不是合法 JSON' };
    }
    const baseParsed = parseQualityContract(parsedJson);
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
    const worktreeProblem = disallowedWorktreeState({
      root,
      workspace: options.workspace,
      generated: baseContract.generatedPaths,
      refs: [baseSha, headSha],
    });
    if (worktreeProblem) {
      return { status: 'config-error', message: worktreeProblem };
    }

    let rawChangedFiles: string;
    try {
      rawChangedFiles = git(
        root,
        ['diff', '--name-only', '-z', `${baseSha}...${headSha}`],
        remainingGitOutputLimit(contentBudget),
      );
    } catch (error) {
      return {
        status: 'unverifiable',
        message: `无法完整读取 PR 文件列表：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const changedFilesBudgetError = consumeReviewText(
      contentBudget,
      rawChangedFiles,
      'PR 文件列表',
    );
    if (changedFilesBudgetError !== null) return changedFilesBudgetError;
    const changedFiles = rawChangedFiles.split('\0').filter(Boolean).sort();
    if (changedFiles.length === 0) {
      return { status: 'unverifiable', message: 'PR 相对默认分支没有可评审改动' };
    }
    let diff: string;
    try {
      diff = git(
        root,
        [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--find-renames',
          '--binary',
          `${baseSha}...${headSha}`,
          '--',
        ],
        remainingGitOutputLimit(contentBudget),
      );
    } catch (error) {
      return {
        status: 'unverifiable',
        message: `无法完整读取 PR diff；不会截断或拆分评审：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const diffBudgetError = consumeReviewText(contentBudget, diff, 'PR diff');
    if (diffBudgetError !== null) return diffBudgetError;
    if (diff.includes('GIT binary patch') || /Binary files .* differ/.test(diff)) {
      return {
        status: 'unverifiable',
        message: 'PR 包含关键二进制变化，无法完整交给文本 Reviewer',
      };
    }
    const files: ReviewFileContent[] = [];
    for (const path of changedFiles) {
      const baseRead = showWithinBudget(root, baseSha, path, contentBudget);
      if (baseRead.status === 'over-limit') return readLimitMessage(`${path}（base）`, baseRead);
      const headRead = showWithinBudget(root, headSha, path, contentBudget);
      if (headRead.status === 'over-limit') return readLimitMessage(`${path}（head）`, headRead);
      if (baseRead.status === 'invalid-utf8' || headRead.status === 'invalid-utf8') {
        return {
          status: 'unverifiable',
          message: `变更文件不是合法 UTF-8 文本，不会将静默替换后的内容交给 Reviewer：${path}`,
        };
      }
      if (baseRead.status === 'unreadable' || headRead.status === 'unreadable') {
        return {
          status: 'unverifiable',
          message: `无法完整读取变更文件；不会把缺失内容当作删除：${path}`,
        };
      }
      const base = baseRead.status === 'ready' ? baseRead.content : null;
      const head = headRead.status === 'ready' ? headRead.content : null;
      files.push({ path, base, head });
    }
    for (const file of files) {
      if (isSubmodule(root, baseSha, file.path) || isSubmodule(root, headSha, file.path)) {
        return {
          status: 'unverifiable',
          message: `子模块指针无法在本地 Review 中核验：${file.path}`,
        };
      }
      if (isLfsPointer(file.base) || isLfsPointer(file.head)) {
        return {
          status: 'unverifiable',
          message: `Git LFS 内容未展开，无法完整评审：${file.path}`,
        };
      }
    }

    let headPaths: string[];
    try {
      headPaths = trackedPaths(root, headSha);
    } catch (error) {
      return {
        status: 'unverifiable',
        message: `当前提交文件列表超过 ${REVIEW_PATH_LIST_MAX_BYTES} bytes 或无法完整读取：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const referenceText = intent.sections['Spec 与验收标准来源'];
    const specPatterns = baseContract.sources.specs
      .filter((source): source is { kind: 'path'; path: string } => source.kind === 'path')
      .map((source) => source.path);
    const acceptancePatterns = baseContract.sources.acceptanceCriteria
      .filter((source): source is { kind: 'path'; path: string } => source.kind === 'path')
      .map((source) => source.path);
    const specPaths = sourceDocuments({
      headPaths,
      changedFiles,
      referenceText,
      patterns: specPatterns,
    });
    const acceptancePaths = sourceDocuments({
      headPaths,
      changedFiles,
      referenceText,
      patterns: acceptancePatterns,
    });
    if (
      specPaths.length === 0 &&
      !baseContract.sources.specs.some((source) => source.kind === 'pull-request')
    ) {
      return { status: 'unverifiable', message: 'PR 没有修改或明确引用质量契约声明的 Spec 文件' };
    }
    if (
      acceptancePaths.length === 0 &&
      !baseContract.sources.acceptanceCriteria.some((source) => source.kind === 'pull-request')
    ) {
      return { status: 'unverifiable', message: 'PR 没有修改或明确引用质量契约声明的验收标准文件' };
    }
    const documentPaths = [...new Set([...specPaths, ...acceptancePaths])].sort();
    const specs: Array<{ path: string; content: string }> = [];
    for (const path of documentPaths) {
      const read = showWithinBudget(root, headSha, path, contentBudget);
      if (read.status === 'over-limit') return readLimitMessage(path, read);
      if (read.status === 'invalid-utf8') {
        return { status: 'unverifiable', message: `Spec 或验收来源不是合法 UTF-8 文本：${path}` };
      }
      if (read.status !== 'ready') {
        return { status: 'unverifiable', message: `当前提交中的 Spec 或验收来源不可读取：${path}` };
      }
      specs.push({ path, content: read.content });
    }
    const engineeringStandards: Array<{ path: string; content: string }> = [];
    for (const path of baseContract.sources.engineeringStandards) {
      const read = showWithinBudget(root, baseSha, path, contentBudget);
      if (read.status === 'over-limit') return readLimitMessage(path, read);
      if (read.status === 'invalid-utf8') {
        return { status: 'unverifiable', message: `默认分支工程规范不是合法 UTF-8 文本：${path}` };
      }
      if (read.status !== 'ready') {
        return { status: 'unverifiable', message: `默认分支工程规范不可读取：${path}` };
      }
      engineeringStandards.push({ path, content: read.content });
    }
    let rawHistory: string;
    try {
      rawHistory = git(
        root,
        ['log', '--format=%H%x09%s', '--max-count=20', `${baseSha}..${headSha}`],
        remainingGitOutputLimit(contentBudget),
      );
    } catch (error) {
      return {
        status: 'unverifiable',
        message: `无法完整读取 PR 提交历史：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const historyBudgetError = consumeReviewText(contentBudget, rawHistory, 'PR 提交历史');
    if (historyBudgetError !== null) return historyBudgetError;
    const history = rawHistory.trim();

    return {
      status: 'ready',
      context: {
        root,
        workspace: resolve(options.workspace),
        branch,
        baseSha,
        headSha,
        pullRequest,
        baseContract,
        baseContractDigest: digestQualityContract(baseContract),
        changedFiles,
        files,
        diff,
        specs,
        engineeringStandards,
        history,
        prSections: intent.sections,
      },
    };
  } catch (error) {
    const message =
      error instanceof GitHubQualityError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { status: 'config-error', message };
  }
}
