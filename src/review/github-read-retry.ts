import {
  DEFAULT_GITHUB_READ_ATTEMPTS,
  GITHUB_RETRY_BASE_DELAY_MS,
  GitHubQualityError,
} from '../quality/github.js';

export type GitHubReadRetryAttempt<T> =
  | { readonly status: 'complete'; readonly value: T }
  | { readonly status: 'retry'; readonly failure: GitHubQualityError };

interface GitHubReadRetryTermination {
  readonly signal: AbortSignal;
  readonly error: () => Error;
}

interface BoundedGitHubReadRetryOptions<T> {
  readonly operationName: string;
  readonly attempt: (attempt: number) => Promise<GitHubReadRetryAttempt<T>>;
  readonly termination?: GitHubReadRetryTermination;
  /** @internal Deterministic test seam for the shared controller only. */
  readonly sleep?: (delayMs: number) => void | Promise<void>;
}

function sleep(delayMs: number): Promise<void> {
  return new Promise((resolveSleep) => setTimeout(resolveSleep, delayMs));
}

function assertNotInterrupted(termination: GitHubReadRetryTermination | undefined): void {
  if (termination?.signal.aborted) throw termination.error();
}

function exhausted(
  operationName: string,
  failure: GitHubQualityError,
  attempts: number,
): GitHubQualityError {
  return new GitHubQualityError(
    `${operationName}连续 ${attempts} 次失败`,
    `最后一次失败：${failure.detail ?? failure.message}`,
    {
      kind: failure.kind,
      ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
      retryable: failure.retryable,
      attempts,
    },
  );
}

/**
 * Shared asynchronous retry schedule for already-qualified, read-only GitHub failures.
 * Callers remain responsible for proving that an attempt is safe and eligible before returning
 * `retry`; thrown errors and completed values always leave immediately.
 */
export async function runBoundedGitHubReadRetry<T>(
  options: BoundedGitHubReadRetryOptions<T>,
): Promise<T> {
  const wait = options.sleep ?? sleep;
  for (let attempt = 1; attempt <= DEFAULT_GITHUB_READ_ATTEMPTS; attempt++) {
    assertNotInterrupted(options.termination);
    const outcome = await options.attempt(attempt);
    assertNotInterrupted(options.termination);
    if (outcome.status === 'complete') return outcome.value;

    const failure = outcome.failure;
    if (failure.kind !== 'transient' || !failure.retryable) throw failure;
    if (attempt === DEFAULT_GITHUB_READ_ATTEMPTS) {
      throw exhausted(options.operationName, failure, attempt);
    }
    await wait(GITHUB_RETRY_BASE_DELAY_MS * 2 ** (attempt - 1));
    assertNotInterrupted(options.termination);
  }
  throw new Error(`${options.operationName}重试未产生结果`);
}
