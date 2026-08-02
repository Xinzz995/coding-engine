import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import {
  parseReviewBaseQualityContract,
  QUALITY_CONTRACT_RELATIVE_PATH,
  type QualityContract,
} from '../quality/contract.js';
import { GitHubQualityError, type GitHubQualityClient } from '../quality/github.js';
import { GhGitHubQualityClient } from '../quality/github-unmanaged.js';
import { normalizeText } from './common.js';
import {
  allowedDirtyPath,
  completePullRequest,
  containsGitBinaryPatch,
  isLfsPointer,
  sourceDocuments,
  validatePullRequestIntent,
  type ReviewContextRevalidation,
  type ReviewFileContent,
  type ReviewPreflightContext,
  type ReviewPreflightResult,
} from './preflight.js';

function git(root: string, args: string[], maxBuffer = 32 * 1024 * 1024): string {
  return execFileSync('git', args, {
    cwd: root,
    encoding: 'utf8',
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
  return git(root, ['ls-tree', '-r', '--name-only', '-z', ref]).split('\0').filter(Boolean);
}

function show(root: string, ref: string, path: string): string | null {
  return tryGit(root, ['show', `${ref}:${path}`]);
}

function existsAt(root: string, ref: string, path: string): boolean {
  return tryGit(root, ['cat-file', '-e', `${ref}:${path}`]) !== null;
}

function statusPaths(root: string): string[] {
  const entries = git(root, ['status', '--porcelain=v1', '-z', '--untracked-files=all']).split(
    '\0',
  );
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

function isSubmodule(root: string, ref: string, path: string): boolean {
  const value = tryGit(root, ['ls-tree', ref, '--', path]);
  return value !== null && value.startsWith('160000 ');
}

/** No-session status revalidation. Formal Review must use revalidateReviewContext instead. */
export function revalidateUnmanagedReviewContext(
  context: ReviewPreflightContext,
  workspace: string,
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
    git(context.root, ['fetch', '--no-tags', 'origin', repository.defaultBranch]);
    const currentBase = normalizeText(
      git(context.root, ['rev-parse', `refs/remotes/origin/${repository.defaultBranch}`]),
    );
    const currentHead = normalizeText(git(context.root, ['rev-parse', 'HEAD']));
    if (currentBase !== context.baseSha)
      return { ok: false, message: '评审期间默认分支 base SHA 发生变化' };
    if (currentHead !== context.headSha)
      return { ok: false, message: '评审期间本地 HEAD 发生变化' };
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
    const dirty = statusPaths(context.root).filter(
      (path) =>
        !allowedDirtyPath(context.root, workspace, context.baseContract.generatedPaths, path),
    );
    if (dirty.length > 0) {
      return {
        ok: false,
        message: `评审期间工作树产生未允许改动：${dirty.join('、')}`,
      };
    }
    return { ok: true };
  } catch (error) {
    return {
      ok: false,
      message: `无法在评审结束时重新核对提交与 PR：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/** No-session status preflight. Formal Review must use runReviewPreflight instead. */
export function runUnmanagedReviewPreflight(options: {
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
    try {
      git(root, ['fetch', '--no-tags', 'origin', repository.defaultBranch]);
    } catch (error) {
      return {
        status: 'remote-not-ready',
        message: `无法获取最新远端默认分支：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const baseSha = normalizeText(
      git(root, ['rev-parse', `refs/remotes/origin/${repository.defaultBranch}`]),
    );
    const headSha = normalizeText(git(root, ['rev-parse', 'HEAD']));
    if (tryGit(root, ['merge-base', '--is-ancestor', baseSha, headSha]) === null) {
      return {
        status: 'remote-not-ready',
        message: `当前分支未包含最新 ${repository.defaultBranch}；请自行 merge 或 rebase 后重跑`,
      };
    }

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

    const rawBaseContract = show(root, baseSha, QUALITY_CONTRACT_RELATIVE_PATH);
    if (rawBaseContract === null) {
      return { status: 'unverifiable', message: '默认分支缺少质量契约，无法用旧规则裁决当前 PR' };
    }
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(rawBaseContract);
    } catch {
      return { status: 'unverifiable', message: '默认分支质量契约不是合法 JSON' };
    }
    const baseParsed = parseReviewBaseQualityContract(parsedJson);
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
    const dirty = statusPaths(root).filter(
      (path) => !allowedDirtyPath(root, options.workspace, baseContract.generatedPaths, path),
    );
    if (dirty.length > 0) {
      return { status: 'config-error', message: `工作树含未允许改动：${dirty.join('、')}` };
    }

    const changedFiles = git(root, ['diff', '--name-only', '-z', `${baseSha}...${headSha}`])
      .split('\0')
      .filter(Boolean)
      .sort();
    if (changedFiles.length === 0) {
      return { status: 'unverifiable', message: 'PR 相对默认分支没有可评审改动' };
    }
    let diff: string;
    try {
      diff = git(
        root,
        ['diff', '--no-ext-diff', '--find-renames', '--binary', `${baseSha}...${headSha}`, '--'],
        64 * 1024 * 1024,
      );
    } catch (error) {
      return {
        status: 'unverifiable',
        message: `无法完整读取 PR diff；不会截断或拆分评审：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (containsGitBinaryPatch(diff)) {
      return {
        status: 'unverifiable',
        message: 'PR 包含关键二进制变化，无法完整交给文本 Reviewer',
      };
    }
    const files: ReviewFileContent[] = [];
    for (const path of changedFiles) {
      const base = show(root, baseSha, path);
      const head = show(root, headSha, path);
      if (
        (base === null && existsAt(root, baseSha, path)) ||
        (head === null && existsAt(root, headSha, path))
      ) {
        return {
          status: 'unverifiable',
          message: `无法完整读取变更文件；不会把缺失内容当作删除：${path}`,
        };
      }
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

    const headPaths = trackedPaths(root, headSha);
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
      const content = show(root, headSha, path);
      if (content === null) {
        return { status: 'unverifiable', message: `当前提交中的 Spec 或验收来源不可读取：${path}` };
      }
      specs.push({ path, content });
    }
    const engineeringStandards: Array<{ path: string; content: string }> = [];
    for (const path of baseContract.sources.engineeringStandards) {
      const content = show(root, baseSha, path);
      if (content === null) {
        return { status: 'unverifiable', message: `默认分支工程规范不可读取：${path}` };
      }
      engineeringStandards.push({ path, content });
    }
    const history = git(root, [
      'log',
      '--format=%H%x09%s',
      '--max-count=20',
      `${baseSha}..${headSha}`,
    ]).trim();

    return {
      status: 'ready',
      context: {
        root,
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
