import { readQualityContract } from '../quality/contract.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { GhGitHubQualityClient } from '../quality/github-unmanaged.js';
import {
  revalidateUnmanagedReviewContext,
  runUnmanagedReviewPreflight,
} from './unmanaged-preflight.js';
import { evaluateReviewRemoteState } from './remote.js';
import { readFinalReviewState } from './state.js';
import type { ReviewPreflightResult } from './preflight.js';
import {
  evaluateCurrentReviewStatus,
  type CurrentReviewStatus,
  type RunnerVersionObservation,
} from './currentness.js';

export {
  evaluateCurrentReviewStatus,
  runnerVersionStaleReason,
  type CurrentReviewStatus,
  type RunnerVersionObservation,
} from './currentness.js';

export function collectCurrentReviewStatus(options: {
  workspace: string;
  projectRoot?: string;
  client?: GitHubQualityClient;
  refreshRemote?: boolean;
  codingXVersion?: string;
  runnerVersionObservation?: RunnerVersionObservation;
  storyValidationDigest?: string | null;
  /** @internal Deterministic currentness seam; production performs the full preflight. */
  preflight?: () => ReviewPreflightResult;
  /** @internal Deterministic end-of-refresh seam; production performs full context revalidation. */
  revalidate?: typeof revalidateUnmanagedReviewContext;
}): CurrentReviewStatus {
  const read = readFinalReviewState(options.workspace);
  if (read.status !== 'ready') return { read, current: false, staleReasons: [] };
  if (!options.projectRoot) {
    return {
      read,
      current: false,
      staleReasons: ['缺少项目根目录，无法核对最终 Review 当前性'],
    };
  }
  const client = options.client ?? new GhGitHubQualityClient();
  let preflight: ReviewPreflightResult;
  if (options.preflight) {
    preflight = options.preflight();
  } else {
    const contract = readQualityContract(options.projectRoot);
    if (contract.status !== 'ready') {
      return { read, current: false, staleReasons: [`质量契约不可用：${contract.status}`] };
    }
    preflight = runUnmanagedReviewPreflight({
      root: options.projectRoot,
      workspace: options.workspace,
      currentContract: contract.contract,
      client,
    });
  }
  if (preflight.status !== 'ready') {
    return { read, current: false, staleReasons: [preflight.message] };
  }
  const evaluated = evaluateCurrentReviewStatus({
    read,
    context: preflight.context,
    ...(options.codingXVersion === undefined ? {} : { codingXVersion: options.codingXVersion }),
    ...(options.runnerVersionObservation === undefined
      ? {}
      : { runnerVersionObservation: options.runnerVersionObservation }),
    ...(options.storyValidationDigest === undefined
      ? {}
      : { storyValidationDigest: options.storyValidationDigest }),
  });
  if (!evaluated.current || !options.refreshRemote) return evaluated;
  const refreshedRemote = evaluateReviewRemoteState({
    context: preflight.context,
    contract: preflight.context.baseContract,
    client,
  });
  const revalidated = (options.revalidate ?? revalidateUnmanagedReviewContext)(
    preflight.context,
    options.workspace,
    client,
  );
  if (!revalidated.ok) {
    return {
      ...evaluated,
      current: false,
      staleReasons: [...evaluated.staleReasons, revalidated.message],
    };
  }
  return { ...evaluated, refreshedRemote };
}
