import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import type { QualityStatus } from './types.js';

const API_BASE = 'https://api.github.com';
const API_VERSION = '2022-11-28';
export const QUALITY_RULESET_NAME = 'coding-x quality gate';
export const QUALITY_RELEASE_RULESET_NAME = 'coding-x release refs';

export class GitHubApiError extends Error {
  readonly status: number;

  constructor(status: number, message: string) {
    super(`GitHub API HTTP ${status}：${message}`);
    this.name = 'GitHubApiError';
    this.status = status;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function sha(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{40}$/i.test(value);
}

export interface GitHubPullRequestEvent {
  repository: string;
  number: number;
  title: string;
  body: string;
  baseRef: string;
  baseSha: string;
  headSha: string;
}

export function parseGitHubPullRequestEvent(path: string): GitHubPullRequestEvent {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`无法读取 GitHub event：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(value) || !isRecord(value.repository) || !isRecord(value.pull_request)) {
    throw new Error('GitHub event 缺少 repository/pull_request');
  }
  const pr = value.pull_request;
  if (!isRecord(pr.base) || !isRecord(pr.head)
    || typeof value.repository.full_name !== 'string'
    || !/^[^/]+\/[^/]+$/.test(value.repository.full_name)
    || !Number.isInteger(pr.number) || (pr.number as number) <= 0
    || typeof pr.title !== 'string'
    || !(typeof pr.body === 'string' || pr.body === null)
    || typeof pr.base.ref !== 'string' || pr.base.ref.trim() === ''
    || !sha(pr.base.sha) || !sha(pr.head.sha)) {
    throw new Error('GitHub event 的 PR 身份字段非法');
  }
  return {
    repository: value.repository.full_name,
    number: pr.number as number,
    title: pr.title,
    body: typeof pr.body === 'string' ? pr.body : '',
    baseRef: pr.base.ref,
    baseSha: pr.base.sha,
    headSha: pr.head.sha,
  };
}

export function resolveGitHubToken(env: NodeJS.ProcessEnv = process.env): string | null {
  const direct = env.GH_TOKEN?.trim() || env.GITHUB_TOKEN?.trim();
  if (direct) return direct;
  try {
    const token = execFileSync('gh', ['auth', 'token'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim();
    return token || null;
  } catch {
    return null;
  }
}

interface RequestOptions {
  method?: string;
  body?: unknown;
  accept?: string;
}

export interface GitHubRulesetSummary {
  id: number;
  name: string;
  enforcement: string;
  target: string;
}

export interface GitHubRuleset extends GitHubRulesetSummary {
  bypass_actors?: unknown[];
  conditions?: unknown;
  rules?: unknown[];
}

export interface RequiredStatusCheck {
  context: string;
  integration_id?: number;
}

export interface RulesetPayload {
  name: string;
  target: 'branch' | 'tag';
  enforcement: 'active';
  bypass_actors: unknown[];
  conditions: { ref_name: { include: string[]; exclude: string[] } };
  rules: Array<{ type: string; parameters?: Record<string, unknown> }>;
}

export function qualityBranchRulesetPayload(
  branch: string,
  requiredChecks: RequiredStatusCheck[],
  requiredApprovals = 0,
): RulesetPayload {
  return {
    name: QUALITY_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: [`refs/heads/${branch}`], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          allowed_merge_methods: ['squash', 'merge'],
          dismiss_stale_reviews_on_push: true,
          require_code_owner_review: false,
          require_last_push_approval: false,
          required_approving_review_count: requiredApprovals,
          required_review_thread_resolution: true,
        },
      },
      {
        type: 'required_status_checks',
        parameters: {
          required_status_checks: requiredChecks,
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
        },
      },
    ],
  };
}

function record(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function rulesOf(ruleset: GitHubRuleset): Array<Record<string, unknown>> {
  return Array.isArray(ruleset.rules)
    ? ruleset.rules.filter(isRecord)
    : [];
}

function namedRule(
  ruleset: GitHubRuleset,
  type: string,
): Record<string, unknown> | null {
  return rulesOf(ruleset).find((rule) => rule.type === type) ?? null;
}

function sameStrings(actual: unknown, expected: string[]): boolean {
  return Array.isArray(actual)
    && actual.every((item) => typeof item === 'string')
    && [...actual].sort().join('\0') === [...expected].sort().join('\0');
}

export function verifyQualityBranchRuleset(
  ruleset: GitHubRuleset,
  expected: {
    branch: string;
    requiredChecks: RequiredStatusCheck[];
    requiredApprovals: number;
  },
): string[] {
  const errors: string[] = [];
  if (ruleset.name !== QUALITY_RULESET_NAME) errors.push('分支 ruleset 名称不匹配');
  if (ruleset.target !== 'branch') errors.push('分支 ruleset target 不是 branch');
  if (ruleset.enforcement !== 'active') errors.push('分支 ruleset 未启用');
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0) {
    errors.push('分支 ruleset 存在日常绕过主体');
  }
  const conditions = record(ruleset.conditions);
  const refName = record(conditions?.ref_name);
  if (!sameStrings(refName?.include, [`refs/heads/${expected.branch}`])
    || !sameStrings(refName?.exclude, [])) {
    errors.push('分支 ruleset 保护引用范围不匹配');
  }
  if (!namedRule(ruleset, 'deletion')) errors.push('分支 ruleset 未禁止删除');
  if (!namedRule(ruleset, 'non_fast_forward')) errors.push('分支 ruleset 未禁止强推');
  const pullRequest = namedRule(ruleset, 'pull_request');
  const pullParameters = record(pullRequest?.parameters);
  if (!pullRequest
    || !sameStrings(pullParameters?.allowed_merge_methods, ['squash', 'merge'])
    || pullParameters?.dismiss_stale_reviews_on_push !== true
    || pullParameters?.required_review_thread_resolution !== true
    || pullParameters?.required_approving_review_count !== expected.requiredApprovals) {
    errors.push('分支 ruleset 的 PR 审核或对话规则不匹配');
  }
  const statusRule = namedRule(ruleset, 'required_status_checks');
  const statusParameters = record(statusRule?.parameters);
  if (!statusRule
    || statusParameters?.strict_required_status_checks_policy !== true
    || statusParameters?.do_not_enforce_on_create !== false) {
    errors.push('分支 ruleset 未要求最新提交上的严格检查');
  } else {
    const actual = Array.isArray(statusParameters.required_status_checks)
      ? statusParameters.required_status_checks.filter(isRecord)
      : [];
    const expectedKeys = expected.requiredChecks
      .map((item) => `${item.context}\0${item.integration_id ?? ''}`)
      .sort();
    const actualKeys = actual
      .map((item) => `${String(item.context ?? '')}\0${String(item.integration_id ?? '')}`)
      .sort();
    if (expectedKeys.join('\n') !== actualKeys.join('\n')) {
      errors.push('分支 ruleset 的 required checks 或 GitHub App 来源不匹配');
    }
  }
  return errors;
}

export function verifyQualityReleaseRuleset(
  ruleset: GitHubRuleset,
  releaseRefs: string[],
): string[] {
  const errors: string[] = [];
  if (ruleset.name !== QUALITY_RELEASE_RULESET_NAME) errors.push('发布 ruleset 名称不匹配');
  if (ruleset.target !== 'tag') errors.push('发布 ruleset target 不是 tag');
  if (ruleset.enforcement !== 'active') errors.push('发布 ruleset 未启用');
  if (!Array.isArray(ruleset.bypass_actors) || ruleset.bypass_actors.length !== 0) {
    errors.push('发布 ruleset 存在绕过主体');
  }
  const conditions = record(ruleset.conditions);
  const refName = record(conditions?.ref_name);
  if (!sameStrings(refName?.include, releaseRefs) || !sameStrings(refName?.exclude, [])) {
    errors.push('发布 ruleset 保护引用范围不匹配');
  }
  if (!namedRule(ruleset, 'deletion')) errors.push('发布 ruleset 未禁止删除');
  if (!namedRule(ruleset, 'non_fast_forward')) errors.push('发布 ruleset 未禁止强推');
  return errors;
}

export function qualityReleaseRulesetPayload(releaseRefs: string[]): RulesetPayload {
  return {
    name: QUALITY_RELEASE_RULESET_NAME,
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: releaseRefs, exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
  };
}

export class GitHubClient {
  readonly token: string;
  readonly repository: string;
  readonly fetchImpl: typeof fetch;

  constructor(token: string, repository: string, fetchImpl: typeof fetch = fetch) {
    if (token.trim() === '') throw new Error('GitHub token 不能为空');
    if (!/^[^/]+\/[^/]+$/.test(repository)) throw new Error('GitHub repository 必须是 owner/repo');
    this.token = token;
    this.repository = repository;
    this.fetchImpl = fetchImpl;
  }

  private async request(path: string, options: RequestOptions = {}): Promise<Response> {
    const url = path.startsWith('https://') ? path : `${API_BASE}${path}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 60_000);
    try {
      const response = await this.fetchImpl(url, {
        method: options.method ?? 'GET',
        headers: {
          Accept: options.accept ?? 'application/vnd.github+json',
          Authorization: `Bearer ${this.token}`,
          'Content-Type': 'application/json',
          'X-GitHub-Api-Version': API_VERSION,
        },
        ...(options.body === undefined ? {} : { body: JSON.stringify(options.body) }),
        signal: controller.signal,
      });
      if (!response.ok) {
        const diagnostic = (await response.text()).slice(0, 1500);
        throw new GitHubApiError(response.status, diagnostic || response.statusText);
      }
      return response;
    } finally {
      clearTimeout(timer);
    }
  }

  async requestJson(path: string, options: RequestOptions = {}): Promise<unknown> {
    const response = await this.request(path, options);
    if (response.status === 204) return null;
    return response.json();
  }

  async requestText(path: string, options: RequestOptions = {}): Promise<string> {
    return (await this.request(path, options)).text();
  }

  async getRepository(): Promise<{ fullName: string; defaultBranch: string }> {
    const value = await this.requestJson(`/repos/${this.repository}`);
    if (!isRecord(value) || typeof value.full_name !== 'string'
      || typeof value.default_branch !== 'string') {
      throw new Error('GitHub repository 响应形状非法');
    }
    return { fullName: value.full_name, defaultBranch: value.default_branch };
  }

  async countAdditionalPushCollaborators(): Promise<number> {
    const owner = this.repository.split('/')[0].toLowerCase();
    let count = 0;
    for (let page = 1; page <= 10; page++) {
      const value = await this.requestJson(
        `/repos/${this.repository}/collaborators?affiliation=all&permission=push&per_page=100&page=${page}`,
      );
      if (!Array.isArray(value)) throw new Error('GitHub collaborators 响应形状非法');
      count += value.filter((item) =>
        isRecord(item)
        && typeof item.login === 'string'
        && item.login.toLowerCase() !== owner
        && item.type !== 'Bot').length;
      if (value.length < 100) return count;
    }
    throw new Error('GitHub 直接协作者超过 1000 人，无法可靠计算审核人数');
  }

  async getPullDiff(number: number): Promise<string> {
    return this.requestText(`/repos/${this.repository}/pulls/${number}`, {
      accept: 'application/vnd.github.v3.diff',
    });
  }

  async getPullIdentity(number: number): Promise<{
    number: number;
    title: string;
    body: string;
    baseRef: string;
    baseSha: string;
    headSha: string;
  }> {
    const value = await this.requestJson(`/repos/${this.repository}/pulls/${number}`);
    if (!isRecord(value) || !Number.isInteger(value.number)
      || typeof value.title !== 'string'
      || !(typeof value.body === 'string' || value.body === null)
      || !isRecord(value.base) || !isRecord(value.head)
      || typeof value.base.ref !== 'string' || !sha(value.base.sha) || !sha(value.head.sha)) {
      throw new Error('GitHub pull request 响应形状非法');
    }
    return {
      number: value.number as number,
      title: value.title,
      body: typeof value.body === 'string' ? value.body : '',
      baseRef: value.base.ref,
      baseSha: value.base.sha,
      headSha: value.head.sha,
    };
  }

  async getPullFiles(number: number): Promise<Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch: string | null;
  }>> {
    const output: Array<{
      filename: string;
      status: string;
      additions: number;
      deletions: number;
      patch: string | null;
    }> = [];
    for (let page = 1; page <= 30; page++) {
      const value = await this.requestJson(
        `/repos/${this.repository}/pulls/${number}/files?per_page=100&page=${page}`,
      );
      if (!Array.isArray(value)) throw new Error('GitHub pull files 响应形状非法');
      for (const item of value) {
        if (!isRecord(item) || typeof item.filename !== 'string'
          || typeof item.status !== 'string'
          || !Number.isInteger(item.additions) || !Number.isInteger(item.deletions)) {
          throw new Error('GitHub pull file 条目形状非法');
        }
        output.push({
          filename: item.filename,
          status: item.status,
          additions: item.additions as number,
          deletions: item.deletions as number,
          patch: typeof item.patch === 'string' ? item.patch : null,
        });
      }
      if (value.length < 100) return output;
    }
    throw new Error('GitHub pull files 超过 3000 个，无法可靠评审');
  }

  async getTreePaths(ref: string): Promise<string[]> {
    const value = await this.requestJson(
      `/repos/${this.repository}/git/trees/${encodeURIComponent(ref)}?recursive=1`,
    );
    if (!isRecord(value) || !Array.isArray(value.tree) || value.truncated === true) {
      throw new Error('GitHub tree 缺失或被截断');
    }
    return value.tree.flatMap((item) =>
      isRecord(item) && item.type === 'blob' && typeof item.path === 'string' ? [item.path] : []);
  }

  async getTextFile(path: string, ref: string, maxBytes = 128 * 1024): Promise<string> {
    const value = await this.requestJson(
      `/repos/${this.repository}/contents/${path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(ref)}`,
    );
    if (!isRecord(value) || value.type !== 'file' || value.encoding !== 'base64'
      || typeof value.content !== 'string' || typeof value.size !== 'number') {
      throw new Error(`GitHub 文件响应形状非法：${path}`);
    }
    if (value.size > maxBytes) throw new Error(`${path} 超过读取上限 ${maxBytes} bytes`);
    const raw = Buffer.from(value.content.replace(/\n/g, ''), 'base64');
    if (raw.includes(0)) throw new Error(`${path} 不是文本文件`);
    return raw.toString('utf8');
  }

  async createCheckRun(opts: {
    name: string;
    headSha: string;
    status: QualityStatus;
    title: string;
    summary: string;
    text: string;
  }): Promise<{ id: number; url: string | null }> {
    if (!sha(opts.headSha)) throw new Error('Check Run headSha 非法');
    const value = await this.requestJson(`/repos/${this.repository}/check-runs`, {
      method: 'POST',
      body: {
        name: opts.name,
        head_sha: opts.headSha,
        status: 'completed',
        conclusion: opts.status === 'passed' ? 'success' : 'failure',
        output: {
          title: opts.title.slice(0, 255),
          summary: opts.summary.slice(0, 65_535),
          text: opts.text.slice(0, 65_535),
        },
      },
    });
    if (!isRecord(value) || !Number.isInteger(value.id)) {
      throw new Error('GitHub Check Run 响应形状非法');
    }
    return {
      id: value.id as number,
      url: typeof value.html_url === 'string' ? value.html_url : null,
    };
  }

  async listRulesets(): Promise<GitHubRulesetSummary[]> {
    const output: GitHubRulesetSummary[] = [];
    for (let page = 1; page <= 10; page++) {
      const value = await this.requestJson(
        `/repos/${this.repository}/rulesets?includes_parents=false&per_page=100&page=${page}`,
      );
      if (!Array.isArray(value)) throw new Error('GitHub rulesets 响应形状非法');
      output.push(...value.flatMap((item) => {
        if (!isRecord(item) || !Number.isInteger(item.id) || typeof item.name !== 'string'
          || typeof item.enforcement !== 'string' || typeof item.target !== 'string') return [];
        return [{
          id: item.id as number,
          name: item.name,
          enforcement: item.enforcement,
          target: item.target,
        }];
      }));
      if (value.length < 100) return output;
    }
    throw new Error('GitHub ruleset 超过 1000 个，无法可靠回读');
  }

  async getRuleset(id: number): Promise<GitHubRuleset> {
    const value = await this.requestJson(`/repos/${this.repository}/rulesets/${id}`);
    if (!isRecord(value) || !Number.isInteger(value.id) || typeof value.name !== 'string'
      || typeof value.enforcement !== 'string' || typeof value.target !== 'string') {
      throw new Error('GitHub ruleset 响应形状非法');
    }
    return value as unknown as GitHubRuleset;
  }

  async upsertRuleset(name: string, payload: RulesetPayload): Promise<GitHubRuleset> {
    const current = (await this.listRulesets()).filter((ruleset) => ruleset.name === name);
    if (current.length > 1) throw new Error(`存在多个同名 ruleset：${name}`);
    const value = current.length === 0
      ? await this.requestJson(`/repos/${this.repository}/rulesets`, {
          method: 'POST',
          body: payload,
        })
      : await this.requestJson(`/repos/${this.repository}/rulesets/${current[0].id}`, {
          method: 'PUT',
          body: payload,
        });
    if (!isRecord(value) || !Number.isInteger(value.id)) {
      throw new Error('GitHub ruleset 写入响应形状非法');
    }
    return this.getRuleset(value.id as number);
  }

  async discoverGitHubActionsIntegrationId(ref: string): Promise<number | null> {
    for (let page = 1; page <= 10; page++) {
      const value = await this.requestJson(
        `/repos/${this.repository}/commits/${encodeURIComponent(ref)}/check-runs?per_page=100&page=${page}`,
      );
      if (!isRecord(value) || !Array.isArray(value.check_runs)) {
        throw new Error('GitHub check-runs 响应形状非法');
      }
      for (const check of value.check_runs) {
        if (!isRecord(check) || !isRecord(check.app)) continue;
        if (check.app.slug === 'github-actions' && Number.isInteger(check.app.id)) {
          return check.app.id as number;
        }
      }
      if (value.check_runs.length < 100) return null;
    }
    throw new Error('GitHub Check Run 超过 1000 个，无法可靠识别应用来源');
  }
}
