import { join } from 'node:path';
import { CODING_X_VERSION } from '../version.js';
import { tryReadPrd } from '../engine/prd.js';
import { evaluateStoryValidationReceiptSet, tryReadState } from '../engine/state.js';
import { readQualityContract, type QualityContractReadResult } from '../quality/contract.js';
import {
  createManagedReviewObservation,
  type ManagedReviewObservation,
  type ManagedReviewTermination,
} from '../review/managed-observation.js';
import {
  revalidateReviewContext,
  runReviewPreflight,
  type ReviewContextRevalidation,
  type ReviewPreflightResult,
} from '../review/preflight.js';
import { evaluateManagedReviewRemoteState } from '../review/remote.js';
import { readRunnerVersion } from '../review/runner.js';
import { readFinalReviewState, type ReviewStateRead } from '../review/state.js';
import {
  evaluateCurrentReviewStatus,
  type CurrentReviewStatus,
  type RunnerVersionObservation,
} from '../review/currentness.js';
import type { ReviewRemoteState } from '../review/types.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { workspacePathsReferToSameDirectory } from '../workspace-safety/filesystem.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { writeReportWithWriter, type WriteReportResult } from './report.js';

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
  now(): Date;
}

const CURRENT_REPORT_ADAPTERS: CurrentReportAdapters = {
  readContract: readQualityContract,
  createObservation: createManagedReviewObservation,
  preflight: runReviewPreflight,
  readVersion: readRunnerVersion,
  remote: evaluateManagedReviewRemoteState,
  revalidate: revalidateReviewContext,
  readReview: readFinalReviewState,
  now: () => new Date(),
};

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

function storyValidationDigest(workspace: string, headSha: string): string | null {
  const prd = tryReadPrd(join(workspace, 'prd.json'));
  const state = tryReadState(join(workspace, 'state.json'));
  if (!prd || !Array.isArray(prd.userStories) || !state) return null;
  return evaluateStoryValidationReceiptSet(prd, state, headSha).digest;
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
  const read = adapters.readReview(workspace);
  let currentReview: CurrentReviewStatus;
  let reviewContextHead: string | null = null;
  const observation = adapters.createObservation({
    session: options.session,
    root: options.projectRoot,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  });

  if (read.status !== 'ready') {
    currentReview = { read, current: false, staleReasons: [] };
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
          storyValidationDigest: storyValidationDigest(workspace, context.headSha),
        });

        if (currentReview.current) {
          let refreshedRemote: ReviewRemoteState | undefined;
          if (options.refreshRemote) {
            refreshedRemote = await adapters.remote({
              context,
              contract: context.baseContract,
              client: observation.github,
            });
          }

          // Match final Review's trust sequence: after the remote read, re-observe the complete
          // git/PR context and Runner identity immediately before the parent writes report.html.
          let finalRunner: RunnerVersionObservation;
          try {
            finalRunner = runnerObservation(
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
            finalRunner = {
              status: 'unverifiable',
              runner: read.state.binding.runner,
              message: error instanceof Error ? error.message : String(error),
            };
          }
          const revalidated = await adapters.revalidate(context, workspace, observation);
          currentReview = evaluateCurrentReviewStatus({
            read,
            context,
            runnerVersionObservation: finalRunner,
            codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
            storyValidationDigest: storyValidationDigest(workspace, context.headSha),
            ...(refreshedRemote === undefined ? {} : { refreshedRemote }),
          });
          if (!revalidated.ok) {
            currentReview = addStaleReason(currentReview, revalidated.message);
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

  // generatedAt is captured only after every observation, keeping the timestamp aligned with the
  // state that is about to be rendered. writeReportWithWriter re-reads final-review.json and
  // deep-compares it with currentReview, closing the remaining workspace-state replacement race.
  return await writeReportWithWriter(options.session.writer, adapters.now(), {
    currentReview,
    currentGitHead: reportGitHead,
  });
}
