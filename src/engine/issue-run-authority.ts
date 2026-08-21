/**
 * An in-memory, one-shot capability issued only by the ready Issue orchestrator after it has
 * re-read the live Issue, PR, managed workflow and Ruleset. A plain `coding-x run` invocation
 * cannot reconstruct this object from workspace files, so Issue workspaces cannot silently skip
 * their live-currentness boundary.
 */

export interface ReadyIssueRunAuthorityClaims {
  readonly projectRoot: string;
  readonly workspaceIdentity: string;
  readonly repository: string;
  readonly issueNumber: number;
  readonly bodyDigest: string;
  readonly branch: string;
  readonly pullRequest: number;
  readonly runId: string;
  readonly executionContractDigest: string;
  readonly gitHead: string;
}

declare const READY_ISSUE_RUN_AUTHORITY: unique symbol;

export interface ReadyIssueRunAuthority {
  readonly [READY_ISSUE_RUN_AUTHORITY]: true;
}

const activeAuthorities = new WeakMap<object, Readonly<ReadyIssueRunAuthorityClaims>>();

/** @internal The callback is the only lifetime in which the capability is valid. */
export async function withReadyIssueRunAuthority<T>(
  claims: ReadyIssueRunAuthorityClaims,
  run: (authority: ReadyIssueRunAuthority) => Promise<T>,
): Promise<T> {
  const authority = Object.freeze(Object.create(null)) as ReadyIssueRunAuthority;
  activeAuthorities.set(authority, Object.freeze({ ...claims }));
  try {
    return await run(authority);
  } finally {
    activeAuthorities.delete(authority);
  }
}

/** @internal Formal preflight consumes the capability so it cannot authorize a second run. */
export function consumeReadyIssueRunAuthority(
  value: unknown,
): Readonly<ReadyIssueRunAuthorityClaims> | null {
  if ((typeof value !== 'object' || value === null) && typeof value !== 'function') return null;
  const claims = activeAuthorities.get(value) ?? null;
  if (claims !== null) activeAuthorities.delete(value);
  return claims;
}
