import type { QualityContract } from '../quality/contract.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { evaluateReviewRemoteState } from './remote.js';
import { readFinalReviewState, readReviewDecisions } from './state.js';
import type {
  ReviewContextRevalidation,
  ReviewPreflightContext,
  ReviewPreflightResult,
} from './preflight.js';
import {
  evaluateCurrentReviewStatus,
  type CurrentReviewStatus,
  type RunnerVersionObservation,
} from './currentness.js';
import { digestReviewBinding } from './binding.js';
import { currentBlockingDecisionProof, validateP1DeferralIssue } from './decisions.js';
import type { FinalReviewState } from './types.js';

export {
  evaluateCurrentReviewStatus,
  runnerVersionStaleReason,
  type CurrentReviewStatus,
  type RunnerVersionObservation,
} from './currentness.js';

function staticDecisionProblems(
  workspace: string,
  state: FinalReviewState,
): {
  issues: Array<{ findingId: string; issue: number }>;
  problems: string[];
} {
  try {
    const decisions = readReviewDecisions(workspace);
    const proof = currentBlockingDecisionProof({
      findings: state.axes.flatMap((axis) => axis.findings),
      decisions: decisions.decisions,
      headSha: state.binding.headSha,
      reviewBindingDigest: digestReviewBinding(state.binding),
    });
    return { issues: proof.deferrals, problems: proof.errors };
  } catch (error) {
    return {
      issues: [],
      problems: [
        `Review 裁决记录无法验证：${error instanceof Error ? error.message : String(error)}`,
      ],
    };
  }
}

function liveDeferralProblems(options: {
  state: FinalReviewState;
  workspace: string;
  contract: QualityContract;
  client: GitHubQualityClient;
  now: Date;
}): string[] {
  const proof = staticDecisionProblems(options.workspace, options.state);
  if (proof.problems.length > 0 || proof.issues.length === 0) return proof.problems;
  if (!options.client.getIssue) return ['当前 GitHub 适配器无法核验 P1 延期 Issue'];
  const problems: string[] = [];
  for (const reference of proof.issues) {
    try {
      const issue = options.client.getIssue(options.contract.repository.fullName, reference.issue);
      problems.push(
        ...validateP1DeferralIssue(issue, options.contract.exceptions.p1.maxDays, options.now).map(
          (problem) => `${reference.findingId}：${problem}`,
        ),
      );
    } catch (error) {
      problems.push(
        `${reference.findingId}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return problems;
}

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
  revalidate?: (
    context: ReviewPreflightContext,
    workspace: string,
    client: GitHubQualityClient,
  ) => ReviewContextRevalidation;
  /** @internal Deterministic exception-expiry seam. */
  now?: Date;
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
  if (!options.preflight) {
    return {
      read,
      current: false,
      staleReasons: ['最终 Review 当前性未经过受管 status/report 观察'],
    };
  }
  const preflight = options.preflight();
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
    storyValidationDigest: options.storyValidationDigest ?? null,
  });
  if (!evaluated.current || read.state.schemaVersion !== 2) return evaluated;
  const decisionProof = staticDecisionProblems(options.workspace, read.state);
  if (decisionProof.problems.length > 0) {
    return {
      ...evaluated,
      current: false,
      staleReasons: [...evaluated.staleReasons, ...decisionProof.problems],
    };
  }
  if (!options.refreshRemote) {
    if (decisionProof.issues.length === 0) return evaluated;
    return {
      ...evaluated,
      current: false,
      staleReasons: [...evaluated.staleReasons, 'P1 延期 Issue 未经过当前 GitHub 状态核验'],
    };
  }
  if (!options.client || !options.revalidate) {
    return {
      ...evaluated,
      current: false,
      staleReasons: [...evaluated.staleReasons, '远端当前性缺少受控 GitHub 观察器'],
    };
  }
  const client = options.client;
  const refreshedRemote = evaluateReviewRemoteState({
    context: preflight.context,
    contract: preflight.context.baseContract,
    client,
  });
  const revalidated = options.revalidate(preflight.context, options.workspace, client);
  if (!revalidated.ok) {
    return {
      ...evaluated,
      current: false,
      staleReasons: [...evaluated.staleReasons, revalidated.message],
    };
  }
  const deferralProblems = liveDeferralProblems({
    state: read.state,
    workspace: options.workspace,
    contract: preflight.context.baseContract,
    client,
    now: options.now ?? new Date(),
  });
  const afterDeferral = options.revalidate(preflight.context, options.workspace, client);
  const closingProblems = [
    ...deferralProblems,
    ...(afterDeferral.ok ? [] : [afterDeferral.message]),
  ];
  if (closingProblems.length > 0) {
    return {
      ...evaluated,
      current: false,
      staleReasons: [...evaluated.staleReasons, ...closingProblems],
    };
  }
  return { ...evaluated, refreshedRemote };
}
