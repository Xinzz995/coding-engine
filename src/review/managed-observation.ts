import { realpathSync } from 'node:fs';
import { delimiter, isAbsolute, relative, resolve, sep } from 'node:path';
import { resolveExecutablePath } from '../engine/agent.js';
import {
  GitHubQualityError,
  parseGitHubCheckRun,
  parseGitHubImmutableReleases,
  parseGitHubIssue,
  parseGitHubPullRequest,
  parseGitHubRepository,
  parseGitHubRuleset,
  type GitHubCheckRun,
  type GitHubImmutableReleases,
  type GitHubIssueInfo,
  type GitHubPullRequestInfo,
  type GitHubRepositoryInfo,
  type GitHubReviewReadClient,
  type GitHubRuleset,
} from '../quality/github.js';
import { environmentEntries, runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import type { SupervisorTerminationReason } from '../workspace-safety/supervisor-protocol.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';

const DEFAULT_READ_TIMEOUT_MS = 30_000;
const MAX_OBSERVATION_BYTES = 16 * 1024 * 1024;

export interface ManagedReviewTermination {
  readonly signal: AbortSignal;
  readonly reason: Exclude<SupervisorTerminationReason, 'timeout'>;
}

export interface ManagedReviewObservation {
  readonly github: GitHubReviewReadClient;
  git(args: readonly string[], maximumBytes?: number): Promise<string>;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function environmentWithSinglePath(
  environment: NodeJS.ProcessEnv,
  directory: string,
): NodeJS.ProcessEnv {
  return Object.fromEntries([
    ...Object.entries(environment).filter(([name]) => name.toUpperCase() !== 'PATH'),
    ['PATH', directory],
  ]);
}

function insideProjectRoot(projectRoot: string, executable: string): boolean {
  const relation = relative(projectRoot, executable);
  return (
    relation === '' ||
    (relation !== '..' && !relation.startsWith(`..${sep}`) && !isAbsolute(relation))
  );
}

/** @internal Infrastructure tools may come from the user's host PATH, never from PR files. */
export function resolveReviewInfrastructureExecutable(
  name: 'git' | 'gh',
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  const root = realpathSync(resolve(projectRoot));
  const pathEntry = Object.entries(environment).find(([key]) => key.toUpperCase() === 'PATH')?.[1];
  for (const directory of (pathEntry ?? '').split(process.platform === 'win32' ? ';' : delimiter)) {
    if (!directory) continue;
    try {
      const executable = resolveExecutablePath(
        name,
        root,
        environmentWithSinglePath(environment, directory),
      );
      if (!insideProjectRoot(root, executable)) return executable;
    } catch {
      // Try the next host PATH entry. Project-owned or broken candidates are never fallback proof.
    }
  }
  throw new WorkspaceSafetyError('invalid', `找不到项目目录之外的可信 ${name} 可执行文件`);
}

function commandFailure(
  executable: string,
  result: Awaited<ReturnType<typeof runManagedWorkspaceProcess>>,
): never {
  const detail = Buffer.concat([result.stdout, result.stderr]).toString('utf8').trim();
  if (result.timedOut) {
    throw new WorkspaceSafetyError('invalid', `${executable} 只读观察超时`);
  }
  if (result.processTreeNotEmpty) {
    throw new WorkspaceSafetyError(
      'isolated',
      `${executable} 根进程结束后仍有后代进程；拒绝观察结果`,
    );
  }
  throw new Error(
    `${executable} 只读观察失败${result.exitCode === null ? '' : `（退出码 ${result.exitCode}）`}` +
      `${detail === '' ? '' : `：${detail}`}`,
  );
}

async function runManagedReadCommand(options: {
  session: WorkspaceSession;
  root: string;
  executable: 'git' | 'gh';
  args: readonly string[];
  maximumBytes?: number;
  termination?: ManagedReviewTermination;
}): Promise<string> {
  const environment = {
    ...process.env,
    GH_PROMPT_DISABLED: '1',
    GIT_TERMINAL_PROMPT: '0',
  };
  const root = realpathSync(resolve(options.root));
  const executable = resolveReviewInfrastructureExecutable(options.executable, root, environment);
  const result = await runManagedWorkspaceProcess(options.session, {
    kind: 'final-review',
    delegation: 'read-only-v1',
    executable,
    args: options.args,
    cwd: root,
    environment: environmentEntries(environment),
    timeoutMs: DEFAULT_READ_TIMEOUT_MS,
    termination: options.termination,
  });
  if (result.verdict !== 'completed' || result.exitCode !== 0) {
    commandFailure(options.executable, result);
  }
  const maximumBytes = options.maximumBytes ?? 8 * 1024 * 1024;
  if (maximumBytes < 1 || maximumBytes > MAX_OBSERVATION_BYTES) {
    throw new WorkspaceSafetyError('invalid', '只读观察输出预算非法');
  }
  if (result.stdout.length > maximumBytes) {
    throw new WorkspaceSafetyError(
      'invalid',
      `${options.executable} 只读观察输出超过 ${maximumBytes} 字节预算`,
    );
  }
  return result.stdout.toString('utf8');
}

class ManagedGhReviewClient implements GitHubReviewReadClient {
  constructor(private readonly run: (args: readonly string[]) => Promise<string>) {}

  private async json(args: readonly string[]): Promise<unknown> {
    const output = await this.run(args);
    if (output.trim() === '') return null;
    try {
      return JSON.parse(output);
    } catch (error) {
      throw new GitHubQualityError(
        'GitHub 返回无法解析的 JSON',
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  private api(path: string): Promise<unknown> {
    return this.json([
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
      path,
    ]);
  }

  async discoverRepository(_root: string): Promise<GitHubRepositoryInfo> {
    return parseGitHubRepository(
      await this.json(['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,isPrivate']),
    );
  }

  async findOpenPullRequest(
    repository: GitHubRepositoryInfo,
    branch: string,
  ): Promise<GitHubPullRequestInfo | null> {
    const owner = repository.fullName.split('/')[0];
    const query = new URLSearchParams({
      state: 'open',
      head: `${owner}:${branch}`,
      base: repository.defaultBranch,
      per_page: '10',
    });
    const value = await this.api(`repos/${repository.fullName}/pulls?${query}`);
    if (!Array.isArray(value)) throw new GitHubQualityError('GitHub 返回的 PR 列表非法');
    if (value.length === 0) return null;
    if (value.length > 1) {
      throw new GitHubQualityError('当前分支对应多个打开的 PR，无法唯一绑定');
    }
    return parseGitHubPullRequest(value[0]);
  }

  async listRulesets(repository: string): Promise<GitHubRuleset[]> {
    const value = await this.api(
      `repos/${repository}/rulesets?includes_parents=false&per_page=100`,
    );
    if (!Array.isArray(value)) throw new GitHubQualityError('GitHub 返回的 Ruleset 列表非法');
    const result: GitHubRuleset[] = [];
    for (const entry of value) {
      if (!record(entry) || !Number.isInteger(entry.id) || (entry.id as number) < 1) {
        throw new GitHubQualityError('GitHub 返回非法 Ruleset 列表项');
      }
      result.push(
        parseGitHubRuleset(await this.api(`repos/${repository}/rulesets/${entry.id as number}`)),
      );
    }
    return result;
  }

  async listCheckRuns(repository: string, sha: string): Promise<GitHubCheckRun[]> {
    const value = await this.api(
      `repos/${repository}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    );
    if (!record(value) || !Array.isArray(value.check_runs)) {
      throw new GitHubQualityError('GitHub 返回的 check runs 非法');
    }
    return value.check_runs.map(parseGitHubCheckRun);
  }

  async getImmutableReleases(repository: string): Promise<GitHubImmutableReleases> {
    return parseGitHubImmutableReleases(await this.api(`repos/${repository}/immutable-releases`));
  }

  async getIssue(repository: string, number: number): Promise<GitHubIssueInfo> {
    return parseGitHubIssue(await this.api(`repos/${repository}/issues/${number}`));
  }
}

/**
 * Creates the only observation surface allowed inside formal Review and decision sessions.
 * Every descendant command is supervised and its workspace delta is mechanically read-only.
 */
export function createManagedReviewObservation(options: {
  session: WorkspaceSession;
  root: string;
  termination?: ManagedReviewTermination;
}): ManagedReviewObservation {
  const git = (args: readonly string[], maximumBytes?: number) =>
    runManagedReadCommand({
      ...options,
      executable: 'git',
      args,
      ...(maximumBytes === undefined ? {} : { maximumBytes }),
    });
  const github = new ManagedGhReviewClient((args) =>
    runManagedReadCommand({ ...options, executable: 'gh', args }),
  );
  return { git, github };
}
