export const DEFAULT_GITHUB_READ_TIMEOUT_MS = 10_000;
export const DEFAULT_GITHUB_READ_ATTEMPTS = 3;
export const GITHUB_RETRY_BASE_DELAY_MS = 250;
export const RETRYABLE_GITHUB_READ_HTTP_STATUSES: ReadonlySet<number> = new Set([
  408, 500, 502, 503, 504,
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

export type GitHubReadResult<T> = T | Promise<T>;

/**
 * Read-only GitHub surface used by an active Review session. Synchronous status clients and
 * asynchronously supervised clients both satisfy this shape; formal Review always injects the
 * supervised implementation.
 */
export interface GitHubReviewReadClient {
  discoverRepository(root: string): GitHubReadResult<GitHubRepositoryInfo>;
  findOpenPullRequest(
    repository: GitHubRepositoryInfo,
    branch: string,
  ): GitHubReadResult<GitHubPullRequestInfo | null>;
  listRulesets(repository: string): GitHubReadResult<GitHubRuleset[]>;
  listCheckRuns(repository: string, sha: string): GitHubReadResult<GitHubCheckRun[]>;
  getImmutableReleases?(repository: string): GitHubReadResult<GitHubImmutableReleases>;
  getIssue?(repository: string, number: number): GitHubReadResult<GitHubIssueInfo>;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringField(value: unknown, name: string): string {
  if (typeof value !== 'string' || value === '')
    throw new GitHubQualityError(`GitHub 返回缺少 ${name}`);
  return value;
}

export function numberField(value: unknown, name: string): number {
  if (!Number.isInteger(value) || (value as number) <= 0) {
    throw new GitHubQualityError(`GitHub 返回非法 ${name}`);
  }
  return value as number;
}

export function parseGitHubRepository(value: unknown): GitHubRepositoryInfo {
  if (!isRecord(value)) throw new GitHubQualityError('无法解析 GitHub 仓库信息');
  const defaultRef = value.defaultBranchRef;
  if (!isRecord(defaultRef)) {
    throw new GitHubQualityError('远端仓库没有默认分支；请先创建最小初始提交');
  }
  if (typeof value.isPrivate !== 'boolean')
    throw new GitHubQualityError('GitHub 返回非法 isPrivate');
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

export function parseGitHubRuleset(value: unknown): GitHubRuleset {
  if (!isRecord(value)) throw new GitHubQualityError('无法解析 GitHub Ruleset');
  const conditions = value.conditions;
  const refName = isRecord(conditions) ? conditions.ref_name : null;
  if (
    !isRecord(refName) ||
    !Array.isArray(refName.include) ||
    !Array.isArray(refName.exclude) ||
    !refName.include.every((item) => typeof item === 'string') ||
    !refName.exclude.every((item) => typeof item === 'string')
  ) {
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

export function parseGitHubPullRequest(value: unknown): GitHubPullRequestInfo {
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

export function parseGitHubIssue(value: unknown): GitHubIssueInfo {
  if (!isRecord(value) || !Array.isArray(value.labels)) {
    throw new GitHubQualityError('无法解析 GitHub Issue');
  }
  const state = value.state;
  if (state !== 'open' && state !== 'closed')
    throw new GitHubQualityError('GitHub Issue state 非法');
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

export function parseGitHubCheckRun(value: unknown): GitHubCheckRun {
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

export function parseSecurityFeatures(value: unknown): GitHubSecurityFeatures {
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

export function parseGitHubImmutableReleases(value: unknown): GitHubImmutableReleases {
  if (
    !isRecord(value) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.enforced_by_owner !== 'boolean'
  ) {
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

export function classifyCommandError(
  error: unknown,
  attempts: number,
  operationCanRetry: boolean,
): GitHubQualityError {
  if (error instanceof GitHubQualityError) {
    const retryable =
      operationCanRetry &&
      error.retryable &&
      (error.httpStatus === undefined || RETRYABLE_GITHUB_READ_HTTP_STATUSES.has(error.httpStatus));
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
  const transient =
    httpStatus === undefined
      ? [
          'ECONNRESET',
          'ECONNREFUSED',
          'EAI_AGAIN',
          'EHOSTUNREACH',
          'ENETDOWN',
          'ENETUNREACH',
          'ENOTFOUND',
          'EPIPE',
          'ETIMEDOUT',
        ].includes(code ?? '') ||
        /(?:\bEOF\b|connection reset|connection refused|connection attempt failed|forcibly closed by (?:the )?remote host|socket hang up|TLS handshake timeout|i\/o timeout|operation timed out|context deadline exceeded|temporary failure|network is unreachable|no such host|could not resolve host|error connecting to|check your internet connection)/i.test(
          detail,
        )
      : RETRYABLE_GITHUB_READ_HTTP_STATUSES.has(httpStatus);

  if (
    httpStatus === 401 ||
    /bad credentials|not logged in|gh auth login|populate (?:the )?GH_TOKEN|authentication token/i.test(
      detail,
    )
  ) {
    return new GitHubQualityError('GitHub CLI 未认证', detail, {
      kind: 'unauthenticated',
      httpStatus,
      retryable: false,
      attempts,
    });
  }
  if (rateLimited) {
    return new GitHubQualityError('GitHub API 请求受限', detail, {
      kind: 'rate-limit',
      httpStatus,
      retryable: false,
      attempts,
    });
  }
  if (
    httpStatus === 403 ||
    /resource not accessible by (?:integration|personal access token)/i.test(detail)
  ) {
    return new GitHubQualityError('GitHub API 权限不足', detail, {
      kind: 'forbidden',
      httpStatus,
      retryable: false,
      attempts,
    });
  }
  if (httpStatus === 404) {
    return new GitHubQualityError('GitHub 资源不存在', detail, {
      kind: 'not-found',
      httpStatus,
      retryable: false,
      attempts,
    });
  }
  if (httpStatus === 422) {
    return new GitHubQualityError('GitHub API 请求无效', detail, {
      kind: 'validation',
      httpStatus,
      retryable: false,
      attempts,
    });
  }
  if (transient) {
    return new GitHubQualityError('GitHub 远端暂时不可用', detail, {
      kind: 'transient',
      httpStatus,
      retryable: operationCanRetry,
      attempts,
    });
  }
  if (code === 'ENOENT') {
    return new GitHubQualityError('无法运行 GitHub CLI', detail, {
      kind: 'tool',
      retryable: false,
      attempts,
    });
  }
  return new GitHubQualityError('GitHub API 调用失败', detail, {
    kind: 'unknown',
    httpStatus,
    retryable: false,
    attempts,
  });
}
