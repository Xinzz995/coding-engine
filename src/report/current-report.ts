import { CODING_X_VERSION } from '../version.js';
import { type QualityContract, type QualityContractReadResult } from '../quality/contract.js';
import {
  createManagedReviewObservation,
  type ManagedReviewObservation,
  type ManagedReviewTermination,
} from '../review/managed-observation.js';
import {
  revalidateReviewContext,
  runReviewPreflight,
  type ReviewContextRevalidation,
  type ReviewPreflightContext,
  type ReviewPreflightResult,
} from '../review/preflight.js';
import { evaluateManagedReviewRemoteState } from '../review/remote.js';
import { readRunnerVersion } from '../review/runner.js';
import {
  readFinalReviewState,
  readReviewDecisions,
  type ReviewStateRead,
} from '../review/state.js';
import {
  evaluateCurrentReviewStatus,
  type CurrentReviewStatus,
  type RunnerVersionObservation,
} from '../review/currentness.js';
import type { FinalReviewState, ReviewRemoteState } from '../review/types.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { workspacePathsReferToSameDirectory } from '../workspace-safety/filesystem.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { writeReportWithWriter, type WriteReportResult } from './report.js';
import {
  observeStoryValidationCurrentness,
  readWorkingQualityContractAuthority,
  type StoryValidationObservation,
} from '../review/story-validation-observation.js';
import { digestReviewBinding } from '../review/binding.js';
import { currentBlockingDecisionProof, validateP1DeferralIssue } from '../review/decisions.js';

interface CurrentReportAdapters {
  readContract(projectRoot: string): QualityContractReadResult;
  createObservation(options: {
    session: WorkspaceSession;
    root: string;
    termination?: ManagedReviewTermination;
  }): ManagedReviewObservation;
  preflight(options: Parameters<typeof runReviewPreflight>[0]): Promise<ReviewPreflightResult>;
  readVersion(options: Parameters<typeof readRunnerVersion>[0]): Promise<string>;
  remote(
    options: Parameters<typeof evaluateManagedReviewRemoteState>[0],
  ): Promise<ReviewRemoteState>;
  revalidate(
    ...options: Parameters<typeof revalidateReviewContext>
  ): Promise<ReviewContextRevalidation>;
  readReview(workspace: string): ReviewStateRead;
  observeStoryValidation: typeof observeStoryValidationCurrentness;
  now(): Date;
}

const CURRENT_REPORT_ADAPTERS: CurrentReportAdapters = {
  readContract: readWorkingQualityContractAuthority,
  createObservation: createManagedReviewObservation,
  preflight: runReviewPreflight,
  readVersion: readRunnerVersion,
  remote: evaluateManagedReviewRemoteState,
  revalidate: revalidateReviewContext,
  readReview: readFinalReviewState,
  observeStoryValidation: observeStoryValidationCurrentness,
  now: () => new Date(),
};

const CURRENT_REPORT_FILE = 'report.html';

function isolateOpenSession(session: WorkspaceSession): void {
  if (session.state === 'open') session.retainLeaseForIsolation();
}

async function invalidateCurrentReport(session: WorkspaceSession): Promise<void> {
  try {
    await session.writer.removeFile(CURRENT_REPORT_FILE);
  } catch (error) {
    isolateOpenSession(session);
    throw error;
  }
}

async function rewriteCurrentReportFailClosed(
  session: WorkspaceSession,
  write: () => Promise<WriteReportResult>,
): Promise<WriteReportResult> {
  await invalidateCurrentReport(session);
  try {
    const result = await write();
    if (result.status !== 'written') isolateOpenSession(session);
    return result;
  } catch (error) {
    isolateOpenSession(session);
    throw error;
  }
}

function staleReview(read: ReviewStateRead, reason: string): CurrentReviewStatus {
  return {
    read,
    current: false,
    staleReasons: read.status === 'ready' ? [reason] : [],
  };
}

function addStaleReason(status: CurrentReviewStatus, reason: string): CurrentReviewStatus {
  return {
    ...status,
    current: false,
    staleReasons: [...status.staleReasons, reason],
  };
}

function runnerObservation(
  read: Extract<ReviewStateRead, { status: 'ready' }>,
  version: string,
): RunnerVersionObservation {
  return { status: 'ready', runner: read.state.binding.runner, version };
}

async function observedGitHead(observation: ManagedReviewObservation): Promise<string | null> {
  try {
    const value = (await observation.git(['rev-parse', '--verify', 'HEAD'], 256))
      .trim()
      .toLowerCase();
    return /^(?:[a-f0-9]{40}|[a-f0-9]{64})$/u.test(value) ? value : null;
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    return null;
  }
}

function sameStoryObservation(
  expected: StoryValidationObservation,
  observed: StoryValidationObservation,
): boolean {
  return (
    expected.status === 'ready' &&
    observed.status === 'ready' &&
    expected.observationToken === observed.observationToken
  );
}

async function managedDecisionProblems(options: {
  state: FinalReviewState;
  workspace: string;
  contract: QualityContract;
  client: ManagedReviewObservation['github'];
  refreshRemote: boolean;
  now: Date;
}): Promise<string[]> {
  let proof: ReturnType<typeof currentBlockingDecisionProof>;
  try {
    proof = currentBlockingDecisionProof({
      findings: options.state.axes.flatMap((axis) => axis.findings),
      decisions: readReviewDecisions(options.workspace).decisions,
      headSha: options.state.binding.headSha,
      reviewBindingDigest: digestReviewBinding(options.state.binding),
    });
  } catch (error) {
    return [`Review 裁决记录无法验证：${error instanceof Error ? error.message : String(error)}`];
  }
  if (proof.errors.length > 0 || proof.deferrals.length === 0) return proof.errors;
  if (!options.refreshRemote) return ['P1 延期 Issue 未经过当前 GitHub 状态核验'];
  if (!options.client.getIssue) return ['当前 GitHub 适配器无法核验 P1 延期 Issue'];
  const problems: string[] = [];
  for (const reference of proof.deferrals) {
    try {
      const issue = await options.client.getIssue(
        options.contract.repository.fullName,
        reference.issue,
      );
      problems.push(
        ...validateP1DeferralIssue(issue, options.contract.exceptions.p1.maxDays, options.now).map(
          (problem) => `${reference.findingId}：${problem}`,
        ),
      );
    } catch (error) {
      if (error instanceof WorkspaceSafetyError) throw error;
      problems.push(
        `${reference.findingId}：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  return problems;
}

/**
 * Manual report currentness is observed and persisted under one report lease. Every Runner, git
 * and GitHub subprocess is reached only through the managed observation/coordinator bound to that
 * session. The ordinary report module stays process-free so automatic loop reporting cannot reach
 * a second observation path.
 */
export async function writeCurrentReportWithSession(options: {
  session: WorkspaceSession;
  workspace: string;
  projectRoot: string;
  refreshRemote: boolean;
  termination?: ManagedReviewTermination;
  codingXVersion?: string;
  /** @internal Deterministic observation seams; production always uses the fixed adapters above. */
  adapters?: Partial<CurrentReportAdapters>;
}): Promise<WriteReportResult> {
  const workspace = options.session.writer.workspacePath;
  // report.html is local feedback rather than delivery proof. Remove the previous snapshot before
  // any observation can fail so a stale green page never survives a failed refresh attempt.
  await invalidateCurrentReport(options.session);
  let matchesSession = false;
  try {
    matchesSession = await workspacePathsReferToSameDirectory(options.workspace, workspace);
  } catch {
    // A missing, replaced, or otherwise unverifiable alias is never allowed to select a second
    // workspace. Keep the same fail-closed boundary as a proven different directory.
  }
  if (!matchesSession) {
    throw new Error('手动报告的 workspace 与受控会话不一致');
  }
  const adapters = { ...CURRENT_REPORT_ADAPTERS, ...options.adapters };
  const storyObservationOptions = {
    projectRoot: options.projectRoot,
    workspace,
    session: options.session,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  };
  const initialStoryObservation = await adapters.observeStoryValidation(storyObservationOptions);
  let storyObservation = initialStoryObservation;
  const read = adapters.readReview(workspace);
  let currentReview: CurrentReviewStatus;
  let reviewContextHead: string | null = null;
  let reviewContext: ReviewPreflightContext | null = null;
  const observation = adapters.createObservation({
    session: options.session,
    root: options.projectRoot,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  });

  const refreshStoryObservation = async (phase: string): Promise<boolean> => {
    const next = await adapters.observeStoryValidation(storyObservationOptions);
    storyObservation = next;
    if (sameStoryObservation(initialStoryObservation, next)) return true;
    if (read.status === 'ready') {
      currentReview = addStaleReason(
        currentReview,
        `${phase}Story 验收观察已变化：${next.status === 'ready' ? '绑定输入不同' : next.message}`,
      );
    }
    return false;
  };

  if (read.status !== 'ready') {
    currentReview = { read, current: false, staleReasons: [] };
  } else if (initialStoryObservation.status !== 'ready') {
    currentReview = staleReview(
      read,
      `Story 验收当前性无法验证：${initialStoryObservation.message}`,
    );
  } else {
    const contract = adapters.readContract(options.projectRoot);
    if (contract.status !== 'ready') {
      currentReview = staleReview(read, `质量契约不可用：${contract.status}`);
    } else {
      const preflight = await adapters.preflight({
        root: options.projectRoot,
        workspace,
        currentContract: contract.contract,
        observation,
      });
      if (preflight.status !== 'ready') {
        currentReview = staleReview(read, preflight.message);
      } else {
        const context = preflight.context;
        reviewContext = context;
        reviewContextHead = context.headSha;
        let initialRunner: RunnerVersionObservation;
        try {
          initialRunner = runnerObservation(
            read,
            await adapters.readVersion({
              session: options.session,
              runner: read.state.binding.runner,
              projectRoot: options.projectRoot,
              ...(options.termination === undefined ? {} : { termination: options.termination }),
            }),
          );
        } catch (error) {
          if (error instanceof WorkspaceSafetyError) throw error;
          initialRunner = {
            status: 'unverifiable',
            runner: read.state.binding.runner,
            message: error instanceof Error ? error.message : String(error),
          };
        }
        currentReview = evaluateCurrentReviewStatus({
          read,
          context,
          runnerVersionObservation: initialRunner,
          codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
          storyValidationDigest:
            initialStoryObservation.headSha === context.headSha
              ? initialStoryObservation.storyValidationDigest
              : null,
        });

        if (currentReview.current) {
          let refreshedRemote: ReviewRemoteState | undefined;
          const stableBeforeRemote = await refreshStoryObservation('远端刷新前');
          if (options.refreshRemote && stableBeforeRemote && currentReview.current) {
            refreshedRemote = await adapters.remote({
              context,
              contract: context.baseContract,
              client: observation.github,
            });
            await refreshStoryObservation('远端刷新后');
          }

          // Match final Review's trust sequence: after the remote read, re-observe the complete
          // git/PR context and Runner identity immediately before the parent writes report.html.
          if (currentReview.current) {
            let finalRunner: RunnerVersionObservation;
            try {
              finalRunner = runnerObservation(
                read,
                await adapters.readVersion({
                  session: options.session,
                  runner: read.state.binding.runner,
                  projectRoot: options.projectRoot,
                  ...(options.termination === undefined
                    ? {}
                    : { termination: options.termination }),
                }),
              );
            } catch (error) {
              if (error instanceof WorkspaceSafetyError) throw error;
              finalRunner = {
                status: 'unverifiable',
                runner: read.state.binding.runner,
                message: error instanceof Error ? error.message : String(error),
              };
            }
            const revalidated = await adapters.revalidate(context, workspace, observation);
            const stableAfterContext = await refreshStoryObservation('最终上下文核验后');
            if (stableAfterContext && storyObservation.status === 'ready') {
              currentReview = evaluateCurrentReviewStatus({
                read,
                context,
                runnerVersionObservation: finalRunner,
                codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
                storyValidationDigest:
                  storyObservation.headSha === context.headSha
                    ? storyObservation.storyValidationDigest
                    : null,
                ...(refreshedRemote === undefined ? {} : { refreshedRemote }),
              });
            }
            if (!revalidated.ok) {
              currentReview = addStaleReason(currentReview, revalidated.message);
            }
            if (currentReview.current && read.state.schemaVersion === 2) {
              const decisionProblems = await managedDecisionProblems({
                state: read.state,
                workspace,
                contract: context.baseContract,
                client: observation.github,
                refreshRemote: options.refreshRemote,
                now: adapters.now(),
              });
              for (const problem of decisionProblems) {
                currentReview = addStaleReason(currentReview, problem);
              }
              let afterDecisionRunner: RunnerVersionObservation;
              try {
                afterDecisionRunner = runnerObservation(
                  read,
                  await adapters.readVersion({
                    session: options.session,
                    runner: read.state.binding.runner,
                    projectRoot: options.projectRoot,
                    ...(options.termination === undefined
                      ? {}
                      : { termination: options.termination }),
                  }),
                );
              } catch (error) {
                if (error instanceof WorkspaceSafetyError) throw error;
                afterDecisionRunner = {
                  status: 'unverifiable',
                  runner: read.state.binding.runner,
                  message: error instanceof Error ? error.message : String(error),
                };
              }
              await refreshStoryObservation('延期核验后');
              const retainedReasons = [...currentReview.staleReasons];
              if (storyObservation.status === 'ready') {
                currentReview = evaluateCurrentReviewStatus({
                  read,
                  context,
                  runnerVersionObservation: afterDecisionRunner,
                  codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
                  storyValidationDigest:
                    storyObservation.headSha === context.headSha
                      ? storyObservation.storyValidationDigest
                      : null,
                  ...(refreshedRemote === undefined ? {} : { refreshedRemote }),
                });
              }
              for (const reason of retainedReasons) {
                if (!currentReview.staleReasons.includes(reason)) {
                  currentReview = addStaleReason(currentReview, reason);
                }
              }
              const afterDecisionContext = await adapters.revalidate(
                context,
                workspace,
                observation,
              );
              if (!afterDecisionContext.ok) {
                currentReview = addStaleReason(currentReview, afterDecisionContext.message);
              }
            }
          }
        }
      }
    }
  }

  const reportGitHead = await observedGitHead(observation);
  if (
    read.status === 'ready' &&
    reviewContextHead !== null &&
    reportGitHead !== reviewContextHead
  ) {
    currentReview = addStaleReason(
      currentReview,
      reportGitHead === null
        ? '报告收口前当前 Git HEAD 无法验证'
        : '报告收口前当前 Git HEAD 已变化',
    );
  }

  const stableBeforePersist = await refreshStoryObservation('报告写入前');
  const beforePersist = storyObservation;
  if (!stableBeforePersist && read.status === 'ready') {
    currentReview = addStaleReason(currentReview, '报告写入前 Story 验收绑定不再稳定');
  }
  if (reviewContext !== null) {
    const finalContext = await adapters.revalidate(reviewContext, workspace, observation);
    if (!finalContext.ok) currentReview = addStaleReason(currentReview, finalContext.message);
  }
  const firstWrite = await writeReportWithWriter(options.session.writer, adapters.now(), {
    currentReview,
    currentGitHead: beforePersist.headSha,
    storyValidationObservation: beforePersist,
  });
  if (firstWrite.status !== 'written') return firstWrite;

  let afterPersist: StoryValidationObservation;
  let afterPersistContext: ReviewContextRevalidation = { ok: true };
  try {
    afterPersist = await adapters.observeStoryValidation(storyObservationOptions);
    if (reviewContext !== null) {
      afterPersistContext = await adapters.revalidate(reviewContext, workspace, observation);
    }
  } catch (error) {
    await invalidateCurrentReport(options.session);
    throw error;
  }
  const storyChangedAfterPersist =
    beforePersist.status === 'ready' && !sameStoryObservation(beforePersist, afterPersist);
  if (!storyChangedAfterPersist && afterPersistContext.ok) {
    return firstWrite;
  }

  if (storyChangedAfterPersist) {
    currentReview = addStaleReason(currentReview, '报告写入后 Story 验收绑定发生变化');
  }
  if (!afterPersistContext.ok) {
    currentReview = addStaleReason(currentReview, afterPersistContext.message);
  }
  const rewrite = await rewriteCurrentReportFailClosed(options.session, () =>
    writeReportWithWriter(options.session.writer, adapters.now(), {
      currentReview,
      currentGitHead: afterPersist.headSha,
      storyValidationObservation: afterPersist,
    }),
  );
  if (rewrite.status !== 'written') return rewrite;
  const afterRewrite = await adapters.observeStoryValidation(storyObservationOptions);
  const afterRewriteContext =
    reviewContext === null
      ? ({ ok: true } as const)
      : await adapters.revalidate(reviewContext, workspace, observation);
  if (
    (afterPersist.status === 'ready' && !sameStoryObservation(afterPersist, afterRewrite)) ||
    !afterRewriteContext.ok
  ) {
    const finalReason = !afterRewriteContext.ok
      ? addStaleReason(currentReview, afterRewriteContext.message)
      : currentReview;
    return await rewriteCurrentReportFailClosed(options.session, () =>
      writeReportWithWriter(options.session.writer, adapters.now(), {
        currentReview: addStaleReason(finalReason, '报告重写期间权威输入再次变化'),
        currentGitHead: null,
        storyValidationObservation: null,
        storyValidationObservationError: '报告持久化期间权威输入持续变化，已强制撤销全部绿灯',
      }),
    );
  }
  return rewrite;
}
