import { execFileSync } from 'node:child_process';
import {
  classifyCommandError,
  DEFAULT_GITHUB_READ_ATTEMPTS,
  DEFAULT_GITHUB_READ_TIMEOUT_MS,
  GITHUB_RETRY_BASE_DELAY_MS,
  GitHubQualityError,
  isRecord,
  numberField,
  parseGitHubCheckRun,
  parseGitHubImmutableReleases,
  parseGitHubIssue,
  parseGitHubPullRequest,
  parseGitHubRepository,
  parseGitHubRuleset,
  parseSecurityFeatures,
  type GhGitHubQualityClientOptions,
  type GitHubCheckRun,
  type GitHubCommandExecutor,
  type GitHubCommandInvocation,
  type GitHubImmutableReleases,
  type GitHubIssueInfo,
  type GitHubPullRequestInfo,
  type GitHubQualityClient,
  type GitHubRepositoryInfo,
  type GitHubRuleset,
  type GitHubRulesetPayload,
  type GitHubSecurityFeatures,
} from './github.js';

export type {
  GhGitHubQualityClientOptions,
  GitHubCommandExecutor,
  GitHubCommandInvocation,
} from './github.js';

const sleepBuffer = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));

function sleepSync(delayMs: number): void {
  Atomics.wait(sleepBuffer, 0, 0, delayMs);
}

function defaultCommandExecutor(invocation: GitHubCommandInvocation): string {
  return execFileSync('gh', [...invocation.args], {
    ...(invocation.cwd ? { cwd: invocation.cwd } : {}),
    ...(invocation.input === undefined ? {} : { input: invocation.input }),
    encoding: 'utf8',
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, GH_PROMPT_DISABLED: '1' },
    maxBuffer: 8 * 1024 * 1024,
    ...(invocation.timeoutMs === undefined ? {} : { timeout: invocation.timeoutMs }),
  });
}

/** No-session `gh` client. Formal Review must use its supervised observation client. */
export class GhGitHubQualityClient implements GitHubQualityClient {
  private readonly executor: GitHubCommandExecutor;
  private readonly sleep: (delayMs: number) => void;

  constructor(options: GhGitHubQualityClientOptions = {}) {
    this.executor = options.executor ?? defaultCommandExecutor;
    this.sleep = options.sleep ?? sleepSync;
  }

  private run(args: string[], cwd?: string, input?: string, retryRead = false): unknown {
    const maxAttempts = retryRead ? DEFAULT_GITHUB_READ_ATTEMPTS : 1;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let output: string;
      try {
        output = this.executor({
          args,
          ...(cwd ? { cwd } : {}),
          ...(input === undefined ? {} : { input }),
          ...(retryRead ? { timeoutMs: DEFAULT_GITHUB_READ_TIMEOUT_MS } : {}),
        });
      } catch (error) {
        const failure = classifyCommandError(error, attempt, retryRead);
        if (!retryRead || !failure.retryable || attempt === maxAttempts) throw failure;
        this.sleep(GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
        continue;
      }
      if (typeof output !== 'string') {
        throw new GitHubQualityError('GitHub CLI 返回非文本结果', undefined, {
          kind: 'invalid-response',
          retryable: false,
          attempts: attempt,
        });
      }
      if (output.trim() === '') return null;
      try {
        return JSON.parse(output);
      } catch (error) {
        throw new GitHubQualityError(
          'GitHub 返回无法解析的 JSON',
          error instanceof Error ? error.message : String(error),
          { kind: 'invalid-response', retryable: false, attempts: attempt },
        );
      }
    }
    throw new GitHubQualityError('GitHub 读取重试未产生结果', undefined, {
      kind: 'unknown',
      retryable: false,
      attempts: maxAttempts,
    });
  }

  private api(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): unknown {
    const args = [
      'api',
      '-H',
      'Accept: application/vnd.github+json',
      '-H',
      'X-GitHub-Api-Version: 2022-11-28',
    ];
    if (method !== 'GET') args.push('--method', method);
    args.push(path);
    if (body !== undefined) args.push('--input', '-');
    return this.run(
      args,
      undefined,
      body === undefined ? undefined : JSON.stringify(body),
      method === 'GET',
    );
  }

  discoverRepository(root: string): GitHubRepositoryInfo {
    return parseGitHubRepository(
      this.run(
        ['repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,isPrivate'],
        root,
        undefined,
        true,
      ),
    );
  }

  verifyDefaultBranch(repository: GitHubRepositoryInfo): void {
    const branch = encodeURIComponent(repository.defaultBranch);
    this.api(`repos/${repository.fullName}/git/ref/heads/${branch}`);
  }

  listRulesets(repository: string): GitHubRuleset[] {
    const value = this.api(`repos/${repository}/rulesets?includes_parents=false&per_page=100`);
    if (!Array.isArray(value)) throw new GitHubQualityError('GitHub 返回的 Ruleset 列表非法');
    return value.map((entry) => {
      if (!isRecord(entry)) throw new GitHubQualityError('GitHub 返回非法 Ruleset 列表项');
      return this.getRuleset(repository, numberField(entry.id, 'ruleset.id'));
    });
  }

  getRuleset(repository: string, id: number): GitHubRuleset {
    return parseGitHubRuleset(this.api(`repos/${repository}/rulesets/${id}`));
  }

  createRuleset(repository: string, payload: GitHubRulesetPayload): GitHubRuleset {
    return parseGitHubRuleset(this.api(`repos/${repository}/rulesets`, 'POST', payload));
  }

  updateRuleset(repository: string, id: number, payload: GitHubRulesetPayload): GitHubRuleset {
    return parseGitHubRuleset(this.api(`repos/${repository}/rulesets/${id}`, 'PUT', payload));
  }

  findOpenPullRequest(
    repository: GitHubRepositoryInfo,
    branch: string,
  ): GitHubPullRequestInfo | null {
    const owner = repository.fullName.split('/')[0];
    const query = new URLSearchParams({
      state: 'open',
      head: `${owner}:${branch}`,
      base: repository.defaultBranch,
      per_page: '10',
    });
    const value = this.api(`repos/${repository.fullName}/pulls?${query}`);
    if (!Array.isArray(value)) throw new GitHubQualityError('GitHub 返回的 PR 列表非法');
    if (value.length === 0) return null;
    if (value.length > 1) throw new GitHubQualityError('当前分支对应多个打开的 PR，无法唯一绑定');
    return parseGitHubPullRequest(value[0]);
  }

  listCheckRuns(repository: string, sha: string): GitHubCheckRun[] {
    const value = this.api(
      `repos/${repository}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`,
    );
    if (!isRecord(value) || !Array.isArray(value.check_runs)) {
      throw new GitHubQualityError('GitHub 返回的 check runs 非法');
    }
    return value.check_runs.map(parseGitHubCheckRun);
  }

  getSecurityFeatures(repository: string): GitHubSecurityFeatures {
    return parseSecurityFeatures(this.api(`repos/${repository}`));
  }

  getImmutableReleases(repository: string): GitHubImmutableReleases {
    return parseGitHubImmutableReleases(this.api(`repos/${repository}/immutable-releases`));
  }

  enableImmutableReleases(repository: string): void {
    this.api(`repos/${repository}/immutable-releases`, 'PUT');
  }

  getIssue(repository: string, number: number): GitHubIssueInfo {
    return parseGitHubIssue(this.api(`repos/${repository}/issues/${number}`));
  }

  listOpenIssuesByLabel(repository: string, label: string): GitHubIssueInfo[] {
    const query = new URLSearchParams({ state: 'open', labels: label, per_page: '100' });
    const value = this.api(`repos/${repository}/issues?${query}`);
    if (!Array.isArray(value)) throw new GitHubQualityError('GitHub 返回的 Issue 列表非法');
    return value.map(parseGitHubIssue).filter((issue) => !issue.isPullRequest);
  }

  ensureLabel(repository: string, name: string, color: string, description: string): void {
    const encoded = encodeURIComponent(name);
    try {
      this.api(`repos/${repository}/labels/${encoded}`);
      return;
    } catch (error) {
      if (!(error instanceof GitHubQualityError) || error.httpStatus !== 404) throw error;
      this.api(`repos/${repository}/labels`, 'POST', { name, color, description });
    }
  }
}
