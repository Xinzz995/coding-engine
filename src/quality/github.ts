import { execFileSync } from 'node:child_process';

export const MANAGED_RULESET_NAME = 'coding-x quality gate';
export const LEGACY_BOOTSTRAP_RULESET_NAME = 'coding-x bootstrap minimum';

export interface GitHubRepositoryInfo {
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface GitHubPullRequestInfo {
  number: number;
  headSha: string;
  baseBranch: string;
  url: string;
}

export interface GitHubCheckRun {
  name: string;
  headSha: string;
  status: string;
  conclusion: string | null;
  app: { id: number; slug: string; name: string };
}

export interface RequiredStatusCheck {
  context: string;
  integration_id: number;
}

export interface GitHubRulesetRule {
  type: string;
  parameters?: Record<string, unknown>;
}

export interface GitHubRuleset {
  id: number;
  name: string;
  target: string;
  enforcement: string;
  bypass_actors: unknown[];
  conditions: {
    ref_name: { include: string[]; exclude: string[] };
  };
  rules: GitHubRulesetRule[];
}

export interface GitHubRulesetPayload {
  name: string;
  target: 'branch';
  enforcement: 'active';
  bypass_actors: unknown[];
  conditions: {
    ref_name: { include: string[]; exclude: string[] };
  };
  rules: GitHubRulesetRule[];
}

export interface GitHubQualityClient {
  discoverRepository(root: string): GitHubRepositoryInfo;
  verifyDefaultBranch(repository: GitHubRepositoryInfo): void;
  listRulesets(repository: string): GitHubRuleset[];
  getRuleset(repository: string, id: number): GitHubRuleset;
  createRuleset(repository: string, payload: GitHubRulesetPayload): GitHubRuleset;
  updateRuleset(repository: string, id: number, payload: GitHubRulesetPayload): GitHubRuleset;
  findOpenPullRequest(
    repository: GitHubRepositoryInfo,
    branch: string,
  ): GitHubPullRequestInfo | null;
  listCheckRuns(repository: string, sha: string): GitHubCheckRun[];
  ensureLabel(repository: string, name: string, color: string, description: string): void;
}

export class GitHubQualityError extends Error {
  constructor(message: string, readonly detail?: string) {
    super(detail ? `${message}：${detail}` : message);
    this.name = 'GitHubQualityError';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '') throw new GitHubQualityError(`GitHub 返回缺少 ${name}`);
  return value;
}

function numberField(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new GitHubQualityError(`GitHub 返回非法 ${name}`);
  }
  return value as number;
}

function parseRepository(value: unknown): GitHubRepositoryInfo {
  if (!isRecord(value)) throw new GitHubQualityError('无法解析 GitHub 仓库信息');
  const defaultRef = value.defaultBranchRef;
  if (!isRecord(defaultRef)) {
    throw new GitHubQualityError('远端仓库没有默认分支；请先创建最小初始提交');
  }
  if (typeof value.isPrivate !== 'boolean') throw new GitHubQualityError('GitHub 返回非法 isPrivate');
  return {
    fullName: stringField(value.nameWithOwner, 'nameWithOwner'),
    defaultBranch: stringField(defaultRef.name, 'defaultBranchRef.name'),
    isPrivate: value.isPrivate,
  };
}

function parseRule(value: unknown): GitHubRulesetRule {
  if (!isRecord(value)) throw new GitHubQualityError('GitHub 返回非法 Ruleset rule');
  const type = stringField(value.type, 'rule.type');
  if (value.parameters !== undefined && !isRecord(value.parameters)) {
    throw new GitHubQualityError(`GitHub 返回非法 ${type}.parameters`);
  }
  return {
    type,
    ...(isRecord(value.parameters) ? { parameters: value.parameters } : {}),
  };
}

function parseRuleset(value: unknown): GitHubRuleset {
  if (!isRecord(value)) throw new GitHubQualityError('无法解析 GitHub Ruleset');
  const conditions = value.conditions;
  const refName = isRecord(conditions) ? conditions.ref_name : null;
  if (!isRecord(refName) || !Array.isArray(refName.include) || !Array.isArray(refName.exclude)
      || !refName.include.every((item) => typeof item === 'string')
      || !refName.exclude.every((item) => typeof item === 'string')) {
    throw new GitHubQualityError('GitHub Ruleset 缺少合法 ref_name 条件');
  }
  if (!Array.isArray(value.rules) || !Array.isArray(value.bypass_actors)) {
    throw new GitHubQualityError('GitHub Ruleset 缺少 rules 或 bypass_actors');
  }
  return {
    id: numberField(value.id, 'ruleset.id'),
    name: stringField(value.name, 'ruleset.name'),
    target: stringField(value.target, 'ruleset.target'),
    enforcement: stringField(value.enforcement, 'ruleset.enforcement'),
    bypass_actors: value.bypass_actors,
    conditions: {
      ref_name: {
        include: [...refName.include] as string[],
        exclude: [...refName.exclude] as string[],
      },
    },
    rules: value.rules.map(parseRule),
  };
}

function parsePullRequest(value: unknown): GitHubPullRequestInfo {
  if (!isRecord(value) || !isRecord(value.head) || !isRecord(value.base)) {
    throw new GitHubQualityError('无法解析 GitHub PR');
  }
  return {
    number: numberField(value.number, 'pull_request.number'),
    headSha: stringField(value.head.sha, 'pull_request.head.sha'),
    baseBranch: stringField(value.base.ref, 'pull_request.base.ref'),
    url: stringField(value.html_url, 'pull_request.html_url'),
  };
}

function parseCheckRun(value: unknown): GitHubCheckRun {
  if (!isRecord(value) || !isRecord(value.app)) {
    throw new GitHubQualityError('无法解析 GitHub check run');
  }
  const conclusion = value.conclusion;
  if (conclusion !== null && typeof conclusion !== 'string') {
    throw new GitHubQualityError('GitHub check run conclusion 非法');
  }
  return {
    name: stringField(value.name, 'check_run.name'),
    headSha: stringField(value.head_sha, 'check_run.head_sha'),
    status: stringField(value.status, 'check_run.status'),
    conclusion,
    app: {
      id: numberField(value.app.id, 'check_run.app.id'),
      slug: stringField(value.app.slug, 'check_run.app.slug'),
      name: stringField(value.app.name, 'check_run.app.name'),
    },
  };
}

/** `gh` 复用用户现有登录，不把 token 写入项目或命令参数。 */
export class GhGitHubQualityClient implements GitHubQualityClient {
  private run(args: string[], cwd?: string, input?: string): unknown {
    try {
      const output = execFileSync('gh', args, {
        ...(cwd ? { cwd } : {}),
        ...(input === undefined ? {} : { input }),
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, GH_PROMPT_DISABLED: '1' },
        maxBuffer: 8 * 1024 * 1024,
      });
      return output.trim() === '' ? null : JSON.parse(output);
    } catch (error) {
      const stderr = isRecord(error) && typeof error.stderr === 'string'
        ? error.stderr.trim()
        : error instanceof Error ? error.message : String(error);
      throw new GitHubQualityError('GitHub API 调用失败', stderr);
    }
  }

  private api(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): unknown {
    const args = ['api', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
    if (method !== 'GET') args.push('--method', method);
    args.push(path);
    if (body !== undefined) args.push('--input', '-');
    return this.run(args, undefined, body === undefined ? undefined : JSON.stringify(body));
  }

  discoverRepository(root: string): GitHubRepositoryInfo {
    return parseRepository(this.run([
      'repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,isPrivate',
    ], root));
  }

  verifyDefaultBranch(repository: GitHubRepositoryInfo): void {
    const branch = encodeURIComponent(repository.defaultBranch);
    this.api(`repos/${repository.fullName}/git/ref/heads/${branch}`);
  }

  listRulesets(repository: string): GitHubRuleset[] {
    const value = this.api(`repos/${repository}/rulesets?includes_parents=false&per_page=100`);
    if (!Array.isArray(value)) throw new GitHubQualityError('GitHub 返回的 Ruleset 列表非法');
    // 列表响应可能不带完整 rules/conditions，逐项读详情后再裁决。
    return value.map((entry) => {
      if (!isRecord(entry)) throw new GitHubQualityError('GitHub 返回非法 Ruleset 列表项');
      return this.getRuleset(repository, numberField(entry.id, 'ruleset.id'));
    });
  }

  getRuleset(repository: string, id: number): GitHubRuleset {
    return parseRuleset(this.api(`repos/${repository}/rulesets/${id}`));
  }

  createRuleset(repository: string, payload: GitHubRulesetPayload): GitHubRuleset {
    return parseRuleset(this.api(`repos/${repository}/rulesets`, 'POST', payload));
  }

  updateRuleset(repository: string, id: number, payload: GitHubRulesetPayload): GitHubRuleset {
    return parseRuleset(this.api(`repos/${repository}/rulesets/${id}`, 'PUT', payload));
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
    return parsePullRequest(value[0]);
  }

  listCheckRuns(repository: string, sha: string): GitHubCheckRun[] {
    const value = this.api(`repos/${repository}/commits/${encodeURIComponent(sha)}/check-runs?per_page=100`);
    if (!isRecord(value) || !Array.isArray(value.check_runs)) {
      throw new GitHubQualityError('GitHub 返回的 check runs 非法');
    }
    return value.check_runs.map(parseCheckRun);
  }

  ensureLabel(repository: string, name: string, color: string, description: string): void {
    const encoded = encodeURIComponent(name);
    try {
      this.api(`repos/${repository}/labels/${encoded}`);
      return;
    } catch (error) {
      if (!(error instanceof GitHubQualityError) || !error.message.includes('HTTP 404')) throw error;
      this.api(`repos/${repository}/labels`, 'POST', { name, color, description });
    }
  }
}
