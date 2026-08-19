import { performance } from 'node:perf_hooks';
import { digestReviewBinding } from '../review/binding.js';
import { readFinalReviewState } from '../review/state.js';
import {
  collectStatusWithWorkspaceSafety,
  type StatusReportWithWorkspaceSafety,
} from '../status/status.js';
import type { IssueEngineResult } from './issue-run.js';

type StatusCollector = (
  workspace: string,
  options: { projectRoot: string; refreshRemote: true },
) => Promise<StatusReportWithWorkspaceSafety>;

export function issueRemoteRefreshResult(
  report: StatusReportWithWorkspaceSafety,
  durationMs: number,
): IssueEngineResult | null {
  if (
    report.status !== 'ok' ||
    report.workspaceSafety.status !== 'ready' ||
    report.stateCorrupted ||
    report.stories.length === 0 ||
    !report.stories.every((story) => !story.blocked && story.passes && story.validated) ||
    !report.storyValidation.current ||
    report.storyValidation.gitHead === null ||
    report.storyValidation.invalidStoryIds.length > 0 ||
    report.storyValidation.configurationError !== null
  ) {
    return null;
  }
  const review = report.finalReview;
  if (
    review.read.status !== 'ready' ||
    review.read.state.schemaVersion !== 2 ||
    review.read.state.status !== 'passed' ||
    review.read.state.shadow ||
    !review.current ||
    review.refreshedRemote === undefined
  ) {
    return null;
  }

  const elapsed = Math.max(0, Math.round(durationMs));
  const remote = review.refreshedRemote;
  return {
    exitCode: remote.status === 'ready' ? 0 : 6,
    message:
      remote.status === 'ready'
        ? `已复用当前最终审查，仅刷新远端状态（${elapsed} ms）`
        : `已复用当前最终审查；远端状态仍为 ${remote.status}（${elapsed} ms）`,
    evidence: {
      reviewBindingDigest: digestReviewBinding(review.read.state.binding),
      storyValidationDigest: review.read.state.binding.storyValidationDigest,
      reusedFinalReview: true,
      remoteRefreshDurationMs: elapsed,
    },
  };
}

export async function refreshReadyIssueReview(options: {
  workspace: string;
  projectRoot: string;
  monotonicNow?: () => number;
  /** @internal Deterministic observation seam; production uses managed status collection. */
  collectStatus?: StatusCollector;
  /** @internal Avoids constructing a full status observation when no prior Review exists. */
  readReview?: typeof readFinalReviewState;
}): Promise<IssueEngineResult | null> {
  const read = (options.readReview ?? readFinalReviewState)(options.workspace);
  if (read.status !== 'ready' || read.state.schemaVersion !== 2) return null;

  const monotonicNow = options.monotonicNow ?? (() => performance.now());
  const started = monotonicNow();
  const report = await (options.collectStatus ?? collectStatusWithWorkspaceSafety)(
    options.workspace,
    {
      projectRoot: options.projectRoot,
      refreshRemote: true,
    },
  );
  return issueRemoteRefreshResult(report, Math.max(0, monotonicNow() - started));
}
