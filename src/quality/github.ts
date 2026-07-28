import { execFileSync } from 'node:child_process';

const DEFAULT_GITHUB_READ_TIMEOUT_MS = 10_000;
const DEFAULT_GITHUB_READ_ATTEMPTS = 3;
const GITHUB_RETRY_BASE_DELAY_MS = 250;
const RETRYABLE_GITHUB_READ_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408,
  500,
  502,
  503,
  504,
]);

export interface GitHubCommandInvocation {
  args: readonly string[];
  cwd?: string;
  input?: string;
  timeoutMs?: number;
}

export type GitHubCommandExecutor = (invocation: GitHubCommandInvocation) => string;

export interface GhGitHubQualityClientOptions {
  executor?: GitHubCommandExecutor;
  sleep?: (delayMs: number) => void;
}

export type GitHubQualityErrorKind =
  | 'transient'
  | 'unauthenticated'
  | 'forbidden'
  | 'not-found'
  | 'rate-limit'
  | 'validation'
  | 'invalid-response'
  | 'tool'
  | 'unknown';

export interface GitHubQualityErrorOptions {
  kind?: GitHubQualityErrorKind;
  httpStatus?: number;
  retryable?: boolean;
  attempts?: number;
}

export const MANAGED_RULESET_NAME = 'coding-x quality gate';
export const LEGACY_BOOTSTRAP_RULESET_NAME = 'coding-x bootstrap minimum';
export const MANAGED_RELEASE_RULESET_NAME = 'coding-x protected release tags';
/** github.com 的 GitHub Actions 官方 App integration ID。 */
export const GITHUB_ACTIONS_APP_ID = 15_368;

export interface GitHubRepositoryInfo {
  fullName: string;
  defaultBranch: string;
  isPrivate: boolean;
}

export interface GitHubSecurityFeatures {
  dependabotSecurityUpdates: boolean;
  secretScanning: boolean;
  secretScanningPushProtection: boolean;
}

export interface GitHubImmutableReleases {
  enabled: boolean;
  enforcedByOwner: boolean;
}

export interface GitHubPullRequestInfo {
  number: number;
  headSha: string;
  baseBranch: string;
  url: string;
  /** Review 绑定所需；旧 init fixture 可以不提供，最终 Review 会严格拒绝缺失。 */
  baseSha?: string;
  title?: string;
  body?: string;
  labels?: string[];
}

export interface GitHubIssueInfo {
  number: number;
  state: 'open' | 'closed';
  title: string;
  body: string;
  labels: string[];
  url: string;
  isPullRequest: boolean;
}

export interface GitHubCheckRun {
  id?: number;
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
  target: 'branch' | 'tag';
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
  getSecurityFeatures?(repository: string): GitHubSecurityFeatures;
  getImmutableReleases?(repository: string): GitHubImmutableReleases;
  enableImmutableReleases?(repository: string): void;
  getIssue?(repository: string, number: number): GitHubIssueInfo;
  listOpenIssuesByLabel?(repository: string, label: string): GitHubIssueInfo[];
  ensureLabel(repository: string, name: string, color: string, description: string): void;
}

export class GitHubQualityError extends Error {
  readonly kind: GitHubQualityErrorKind;
  readonly httpStatus?: number;
  readonly retryable: boolean;
  readonly attempts: number;

  constructor(
    message: string,
    readonly detail?: string,
    options: GitHubQualityErrorOptions = {},
  ) {
    super(detail ? `${message}：${detail}` : message);
    this.name = 'GitHubQualityError';
    this.kind = options.kind ?? 'invalid-response';
    this.httpStatus = options.httpStatus;
    this.retryable = options.retryable ?? false;
    this.attempts = options.attempts ?? 1;
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
  const labels = Array.isArray(value.labels)
    ? value.labels.map((entry) => {
        if (!isRecord(entry)) throw new GitHubQualityError('GitHub PR label 非法');
        return stringField(entry.name, 'pull_request.labels.name');
      })
    : [];
  return {
    number: numberField(value.number, 'pull_request.number'),
    headSha: stringField(value.head.sha, 'pull_request.head.sha'),
    baseBranch: stringField(value.base.ref, 'pull_request.base.ref'),
    url: stringField(value.html_url, 'pull_request.html_url'),
    baseSha: stringField(value.base.sha, 'pull_request.base.sha'),
    title: stringField(value.title, 'pull_request.title'),
    body: typeof value.body === 'string' ? value.body : '',
    labels,
  };
}

function parseIssue(value: unknown): GitHubIssueInfo {
  if (!isRecord(value) || !Array.isArray(value.labels)) {
    throw new GitHubQualityError('无法解析 GitHub Issue');
  }
  const state = value.state;
  if (state !== 'open' && state !== 'closed') throw new GitHubQualityError('GitHub Issue state 非法');
  return {
    number: numberField(value.number, 'issue.number'),
    state,
    title: stringField(value.title, 'issue.title'),
    body: typeof value.body === 'string' ? value.body : '',
    labels: value.labels.map((entry) => {
      if (!isRecord(entry)) throw new GitHubQualityError('GitHub Issue label 非法');
      return stringField(entry.name, 'issue.labels.name');
    }),
    url: stringField(value.html_url, 'issue.html_url'),
    isPullRequest: isRecord(value.pull_request),
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
    id: numberField(value.id, 'check_run.id'),
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

function parseSecurityFeatures(value: unknown): GitHubSecurityFeatures {
  if (!isRecord(value) || !isRecord(value.security_and_analysis)) {
    throw new GitHubQualityError('GitHub 未返回仓库安全功能状态；请确认权限和套餐能力');
  }
  const security = value.security_and_analysis;
  const enabled = (name: string): boolean => {
    const feature = security[name];
    if (!isRecord(feature) || (feature.status !== 'enabled' && feature.status !== 'disabled')) {
      throw new GitHubQualityError(`GitHub 未返回 ${name} 状态；该功能可能不可用`);
    }
    return feature.status === 'enabled';
  };
  return {
    dependabotSecurityUpdates: enabled('dependabot_security_updates'),
    secretScanning: enabled('secret_scanning'),
    secretScanningPushProtection: enabled('secret_scanning_push_protection'),
  };
}

function parseImmutableReleases(value: unknown): GitHubImmutableReleases {
  if (!isRecord(value) || typeof value.enabled !== 'boolean'
      || typeof value.enforced_by_owner !== 'boolean') {
    throw new GitHubQualityError('GitHub 未返回合法的不可变 Release 状态');
  }
  return { enabled: value.enabled, enforcedByOwner: value.enforced_by_owner };
}

function commandErrorText(error: unknown): string {
  if (isRecord(error)) {
    const stderr = error.stderr;
    if (typeof stderr === 'string' && stderr.trim() !== '') return stderr.trim();
    if (Buffer.isBuffer(stderr) && stderr.length > 0) return stderr.toString('utf8').trim();
  }
  return error instanceof Error ? error.message : String(error);
}

function commandErrorCode(error: unknown): string | undefined {
  return isRecord(error) && typeof error.code === 'string' ? error.code : undefined;
}

function httpStatusFromError(detail: string): number | undefined {
  const match = /\bHTTP(?:\/\d(?:\.\d)?)?\s+(\d{3})\b/i.exec(detail);
  return match ? Number(match[1]) : undefined;
}

function classifyCommandError(
  error: unknown,
  attempts: number,
  operationCanRetry: boolean,
): GitHubQualityError {
  if (error instanceof GitHubQualityError) {
    const retryable = operationCanRetry
      && error.retryable
      && (error.httpStatus === undefined
        || RETRYABLE_GITHUB_READ_HTTP_STATUSES.has(error.httpStatus));
    if (retryable === error.retryable && error.attempts === attempts) return error;
    return new GitHubQualityError('GitHub 远端操作失败', error.detail ?? error.message, {
      kind: error.kind,
      httpStatus: error.httpStatus,
      retryable,
      attempts,
    });
  }
  const detail = commandErrorText(error);
  const code = commandErrorCode(error);
  const httpStatus = httpStatusFromError(detail);
  const rateLimited = httpStatus === 429 || /(?:secondary |API )?rate limit/i.test(detail);
  const transient = httpStatus === undefined
    ? [
        'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN', 'EHOSTUNREACH', 'ENETDOWN',
        'ENETUNREACH', 'ENOTFOUND', 'EPIPE', 'ETIMEDOUT',
      ].includes(code ?? '')
      || /(?:\bEOF\b|connection reset|connection refused|connection attempt failed|socket hang up|TLS handshake timeout|i\/o timeout|operation timed out|context deadline exceeded|temporary failure|network is unreachable|no such host|could not resolve host|error connecting to|check your internet connection)/i
        .test(detail)
    : RETRYABLE_GITHUB_READ_HTTP_STATUSES.has(httpStatus);

  if (httpStatus === 401
      || /bad credentials|not logged in|gh auth login|populate (?:the )?GH_TOKEN|authentication token/i
        .test(detail)) {
    return new GitHubQualityError('GitHub CLI 未认证', detail, {
      kind: 'unauthenticated', httpStatus, retryable: false, attempts,
    });
  }
  if (rateLimited) {
    return new GitHubQualityError('GitHub API 请求受限', detail, {
      kind: 'rate-limit', httpStatus, retryable: false, attempts,
    });
  }
  if (httpStatus === 403
      || /resource not accessible by (?:integration|personal access token)/i.test(detail)) {
    return new GitHubQualityError('GitHub API 权限不足', detail, {
      kind: 'forbidden', httpStatus, retryable: false, attempts,
    });
  }
  if (httpStatus === 404) {
    return new GitHubQualityError('GitHub 资源不存在', detail, {
      kind: 'not-found', httpStatus, retryable: false, attempts,
    });
  }
  if (httpStatus === 422) {
    return new GitHubQualityError('GitHub API 请求无效', detail, {
      kind: 'validation', httpStatus, retryable: false, attempts,
    });
  }
  if (transient) {
    return new GitHubQualityError('GitHub 远端暂时不可用', detail, {
      kind: 'transient', httpStatus, retryable: operationCanRetry, attempts,
    });
  }
  if (code === 'ENOENT') {
    return new GitHubQualityError('无法运行 GitHub CLI', detail, {
      kind: 'tool', retryable: false, attempts,
    });
  }
  return new GitHubQualityError('GitHub API 调用失败', detail, {
    kind: 'unknown', httpStatus, retryable: false, attempts,
  });
}

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

/** `gh` 复用用户现有登录，不把 token 写入项目或命令参数。 */
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
          kind: 'invalid-response', retryable: false, attempts: attempt,
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
      kind: 'unknown', retryable: false, attempts: maxAttempts,
    });
  }

  private api(path: string, method: 'GET' | 'POST' | 'PUT' = 'GET', body?: unknown): unknown {
    const args = ['api', '-H', 'Accept: application/vnd.github+json', '-H', 'X-GitHub-Api-Version: 2022-11-28'];
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
    return parseRepository(this.run([
      'repo', 'view', '--json', 'nameWithOwner,defaultBranchRef,isPrivate',
    ], root, undefined, true));
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

  getSecurityFeatures(repository: string): GitHubSecurityFeatures {
    return parseSecurityFeatures(this.api(`repos/${repository}`));
  }

  getImmutableReleases(repository: string): GitHubImmutableReleases {
    return parseImmutableReleases(this.api(`repos/${repository}/immutable-releases`));
  }

  enableImmutableReleases(repository: string): void {
    this.api(`repos/${repository}/immutable-releases`, 'PUT');
  }

  getIssue(repository: string, number: number): GitHubIssueInfo {
    return parseIssue(this.api(`repos/${repository}/issues/${number}`));
  }

  listOpenIssuesByLabel(repository: string, label: string): GitHubIssueInfo[] {
    const query = new URLSearchParams({ state: 'open', labels: label, per_page: '100' });
    const value = this.api(`repos/${repository}/issues?${query}`);
    if (!Array.isArray(value)) throw new GitHubQualityError('GitHub 返回的 Issue 列表非法');
    return value.map(parseIssue).filter((issue) => !issue.isPullRequest);
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
