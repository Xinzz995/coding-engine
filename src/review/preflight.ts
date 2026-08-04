import { relative, resolve, sep } from 'node:path';
import {
  parseReviewBaseQualityContract,
  QUALITY_CONTRACT_RELATIVE_PATH,
  type QualityContract,
} from '../quality/contract.js';
import { GitHubQualityError, type GitHubPullRequestInfo } from '../quality/github.js';
import type { ManagedReviewObservation } from './managed-observation.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { matchesAny, normalizeText } from './common.js';

const REQUIRED_PR_SECTIONS = [
  '本次目标',
  '明确的非目标',
  'Spec 与验收标准来源',
  '验证方式',
  '风险说明',
] as const;

/** 超过该规模的 PR 必须拆分；否则逐文件完整读取会放大受管子进程调用并超出模型上下文。 */
export const MAX_REVIEW_CHANGED_FILES = 128;

export function validateReviewChangedFileCount(count: number): string | null {
  if (count === 0) return 'PR 相对默认分支没有可评审改动';
  if (count > MAX_REVIEW_CHANGED_FILES) {
    return (
      `PR 变更文件数 ${count} 超过完整 Review 上限 ${MAX_REVIEW_CHANGED_FILES}；` +
      '请拆分 PR 后重跑'
    );
  }
  return null;
}

export interface ReviewFileContent {
  path: string;
  base: string | null;
  head: string | null;
}

export interface ReviewPreflightContext {
  root: string;
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

export function allowedDirtyPath(
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

export function completePullRequest(
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

export function isLfsPointer(content: string | null): boolean {
  return content?.startsWith('version https://git-lfs.github.com/spec/v1\n') ?? false;
}

export function containsGitBinaryPatch(diff: string): boolean {
  return diff
    .split('\n')
    .some(
      (line) =>
        line === 'GIT binary patch' ||
        (line.startsWith('Binary files ') && line.endsWith(' differ')),
    );
}

export function sourceDocuments(options: {
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

async function managedTryGit(
  observation: ManagedReviewObservation,
  args: readonly string[],
): Promise<string | null> {
  try {
    return await observation.git(args);
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    return null;
  }
}

async function managedShow(
  observation: ManagedReviewObservation,
  ref: string,
  path: string,
): Promise<string | null> {
  return managedTryGit(observation, ['show', `${ref}:${path}`]);
}

async function managedExistsAt(
  observation: ManagedReviewObservation,
  ref: string,
  path: string,
): Promise<boolean> {
  return (await managedTryGit(observation, ['cat-file', '-e', `${ref}:${path}`])) !== null;
}

export function parseManagedGitStatusPaths(output: string): string[] {
  const entries = output.split('\0');
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

async function managedStatusPaths(observation: ManagedReviewObservation): Promise<string[]> {
  return parseManagedGitStatusPaths(
    await observation.git(['status', '--porcelain=v1', '-z', '--untracked-files=all']),
  );
}

async function managedUnexpectedDirtyPaths(options: {
  root: string;
  workspace: string;
  generatedPaths: string[];
  observation: ManagedReviewObservation;
}): Promise<string[]> {
  return (await managedStatusPaths(options.observation)).filter(
    (path) => !allowedDirtyPath(options.root, options.workspace, options.generatedPaths, path),
  );
}

async function managedIsSubmodule(
  observation: ManagedReviewObservation,
  ref: string,
  path: string,
): Promise<boolean> {
  const value = await managedTryGit(observation, ['ls-tree', ref, '--', path]);
  return value !== null && value.startsWith('160000 ');
}

/** Formal Review preflight. Every git/gh descendant is bound to the active workspace session. */
export async function runReviewPreflight(options: {
  root: string;
  workspace: string;
  currentContract: QualityContract;
  observation: ManagedReviewObservation;
}): Promise<ReviewPreflightResult> {
  const root = resolve(options.root);
  const { observation } = options;
  const client = observation.github;
  try {
    const branch = normalizeText(
      await observation.git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    );
    if (!branch)
      return { status: 'config-error', message: '当前处于 detached HEAD，不能绑定功能分支' };
    if (branch === options.currentContract.repository.defaultBranch) {
      return {
        status: 'config-error',
        message: '当前位于默认分支；最终 Review 只允许在功能分支运行',
      };
    }
    const repository = await client.discoverRepository(root);
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
      await observation.git(['fetch', '--no-tags', 'origin', repository.defaultBranch]);
    } catch (error) {
      if (error instanceof WorkspaceSafetyError) throw error;
      return {
        status: 'remote-not-ready',
        message: `无法获取最新远端默认分支：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const baseSha = normalizeText(
      await observation.git(['rev-parse', `refs/remotes/origin/${repository.defaultBranch}`]),
    );
    const headSha = normalizeText(await observation.git(['rev-parse', 'HEAD']));
    if (
      (await managedTryGit(observation, ['merge-base', '--is-ancestor', baseSha, headSha])) === null
    ) {
      return {
        status: 'remote-not-ready',
        message: `当前分支未包含最新 ${repository.defaultBranch}；请自行 merge 或 rebase 后重跑`,
      };
    }

    const found = await client.findOpenPullRequest(repository, branch);
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

    const rawBaseContract = await managedShow(observation, baseSha, QUALITY_CONTRACT_RELATIVE_PATH);
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
    const dirty = await managedUnexpectedDirtyPaths({
      root,
      workspace: options.workspace,
      generatedPaths: baseContract.generatedPaths,
      observation,
    });
    if (dirty.length > 0) {
      return { status: 'config-error', message: `工作树含未允许改动：${dirty.join('、')}` };
    }

    const changedFiles = (
      await observation.git(['diff', '--name-only', '-z', `${baseSha}...${headSha}`])
    )
      .split('\0')
      .filter(Boolean)
      .sort();
    const changedFileCountError = validateReviewChangedFileCount(changedFiles.length);
    if (changedFileCountError) return { status: 'unverifiable', message: changedFileCountError };
    let diff: string;
    try {
      diff = await observation.git(
        ['diff', '--no-ext-diff', '--find-renames', '--binary', `${baseSha}...${headSha}`, '--'],
        16 * 1024 * 1024,
      );
    } catch (error) {
      if (error instanceof WorkspaceSafetyError) throw error;
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
      const base = await managedShow(observation, baseSha, path);
      const head = await managedShow(observation, headSha, path);
      if (
        (base === null && (await managedExistsAt(observation, baseSha, path))) ||
        (head === null && (await managedExistsAt(observation, headSha, path)))
      ) {
        return {
          status: 'unverifiable',
          message: `无法完整读取变更文件；不会把缺失内容当作删除：${path}`,
        };
      }
      files.push({ path, base, head });
    }
    for (const file of files) {
      if (
        (await managedIsSubmodule(observation, baseSha, file.path)) ||
        (await managedIsSubmodule(observation, headSha, file.path))
      ) {
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

    const headPaths = (await observation.git(['ls-tree', '-r', '--name-only', '-z', headSha]))
      .split('\0')
      .filter(Boolean);
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
      const content = await managedShow(observation, headSha, path);
      if (content === null) {
        return { status: 'unverifiable', message: `当前提交中的 Spec 或验收来源不可读取：${path}` };
      }
      specs.push({ path, content });
    }
    const engineeringStandards: Array<{ path: string; content: string }> = [];
    for (const path of baseContract.sources.engineeringStandards) {
      const content = await managedShow(observation, baseSha, path);
      if (content === null) {
        return { status: 'unverifiable', message: `默认分支工程规范不可读取：${path}` };
      }
      engineeringStandards.push({ path, content });
    }
    const history = (
      await observation.git([
        'log',
        '--format=%H%x09%s',
        '--max-count=20',
        `${baseSha}..${headSha}`,
      ])
    ).trim();

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
    if (error instanceof WorkspaceSafetyError) throw error;
    const message =
      error instanceof GitHubQualityError
        ? error.message
        : error instanceof Error
          ? error.message
          : String(error);
    return { status: 'config-error', message };
  }
}

/** Revalidates the formal Review binding through the same supervised observation surface. */
export async function revalidateReviewContext(
  context: ReviewPreflightContext,
  workspace: string,
  observation: ManagedReviewObservation,
): Promise<ReviewContextRevalidation> {
  try {
    const branch = normalizeText(
      await observation.git(['symbolic-ref', '--quiet', '--short', 'HEAD']),
    );
    if (branch !== context.branch) {
      return { ok: false, message: '评审期间本地功能分支身份发生变化' };
    }
    const repository = await observation.github.discoverRepository(context.root);
    if (
      repository.fullName !== context.baseContract.repository.fullName ||
      repository.defaultBranch !== context.baseContract.repository.defaultBranch
    ) {
      return { ok: false, message: '评审期间 GitHub 仓库或默认分支身份发生变化' };
    }
    await observation.git(['fetch', '--no-tags', 'origin', repository.defaultBranch]);
    const currentBase = normalizeText(
      await observation.git(['rev-parse', `refs/remotes/origin/${repository.defaultBranch}`]),
    );
    const currentHead = normalizeText(await observation.git(['rev-parse', 'HEAD']));
    if (currentBase !== context.baseSha)
      return { ok: false, message: '评审期间默认分支 base SHA 发生变化' };
    if (currentHead !== context.headSha)
      return { ok: false, message: '评审期间本地 HEAD 发生变化' };
    const found = await observation.github.findOpenPullRequest(repository, context.branch);
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
    const labels = (value: readonly string[]) =>
      value.map((label) => normalizeText(label)).sort((left, right) => left.localeCompare(right));
    if (
      JSON.stringify(labels(current.labels)) !== JSON.stringify(labels(context.pullRequest.labels))
    ) {
      return { ok: false, message: '评审期间 PR 标签发生变化' };
    }
    const dirty = await managedUnexpectedDirtyPaths({
      root: context.root,
      workspace,
      generatedPaths: context.baseContract.generatedPaths,
      observation,
    });
    if (dirty.length > 0) {
      return {
        ok: false,
        message: `评审期间工作树产生未允许改动：${dirty.join('、')}`,
      };
    }
    return { ok: true };
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    return {
      ok: false,
      message: `无法在评审结束时重新核对提交与 PR：${error instanceof Error ? error.message : String(error)}`,
    };
  }
}
