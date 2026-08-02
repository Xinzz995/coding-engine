import { CODING_X_VERSION } from '../version.js';
import type { QualityContract } from '../quality/contract.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { digestReviewBinding } from './binding.js';
import { currentBlockingDecisionProof, validateP1DeferralIssue } from './decisions.js';
import {
  createManagedReviewObservation,
  type ManagedReviewObservation,
  type ManagedReviewTermination,
} from './managed-observation.js';
import { evaluateCurrentReviewStatus, type CurrentReviewStatus } from './currentness.js';
import { revalidateReviewContext, runReviewPreflight } from './preflight.js';
import { evaluateManagedReviewRemoteState } from './remote.js';
import { readRunnerVersion } from './runner.js';
import { readFinalReviewState, readReviewDecisions } from './state.js';
import {
  observeStoryValidationCurrentness,
  readWorkingQualityContractAuthority,
  type StoryValidationObservation,
} from './story-validation-observation.js';
import type { FinalReviewState } from './types.js';

export interface ManagedStatusQualityResult {
  storyValidation: StoryValidationObservation;
  runnerVersionObservation:
    | { status: 'not-required' }
    | { status: 'ready'; runner: 'claude' | 'codex' | 'cursor'; version: string }
    | {
        status: 'unverifiable';
        runner: 'claude' | 'codex' | 'cursor';
        message: string;
      };
  finalReview: CurrentReviewStatus;
}

function stale(read: ReturnType<typeof readFinalReviewState>, reason: string): CurrentReviewStatus {
  return {
    read,
    current: false,
    staleReasons: read.status === 'ready' ? [reason] : [],
  };
}

function addReason(status: CurrentReviewStatus, reason: string): CurrentReviewStatus {
  return { ...status, current: false, staleReasons: [...status.staleReasons, reason] };
}

function sameStoryObservation(
  left: StoryValidationObservation,
  right: StoryValidationObservation,
): boolean {
  return (
    left.status === 'ready' &&
    right.status === 'ready' &&
    left.observationToken === right.observationToken
  );
}

async function runnerObservation(options: {
  session: WorkspaceSession;
  projectRoot: string;
  runner: 'claude' | 'codex' | 'cursor';
  termination?: ManagedReviewTermination;
}): Promise<ManagedStatusQualityResult['runnerVersionObservation']> {
  try {
    return {
      status: 'ready',
      runner: options.runner,
      version: await readRunnerVersion({
        session: options.session,
        runner: options.runner,
        projectRoot: options.projectRoot,
        ...(options.termination === undefined ? {} : { termination: options.termination }),
      }),
    };
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    return {
      status: 'unverifiable',
      runner: options.runner,
      message: error instanceof Error ? error.message : String(error),
    };
  }
}

async function decisionProblems(options: {
  workspace: string;
  state: FinalReviewState;
  contract: QualityContract;
  observation: ManagedReviewObservation;
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
  if (!options.observation.github.getIssue) return ['当前 GitHub 适配器无法核验 P1 延期 Issue'];

  const problems: string[] = [];
  for (const reference of proof.deferrals) {
    try {
      const issue = await options.observation.github.getIssue(
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
 * `status` 的完整交付判断只在临时受管域中执行。项目路径里的同名 git/gh、失控后代
 * 或无期限网络读取都不能参与签发绿色结果。
 */
export async function collectManagedStatusQuality(options: {
  session: WorkspaceSession;
  workspace: string;
  projectRoot: string;
  refreshRemote: boolean;
  termination?: ManagedReviewTermination;
  codingXVersion?: string;
}): Promise<ManagedStatusQualityResult> {
  const storyOptions = {
    session: options.session,
    workspace: options.workspace,
    projectRoot: options.projectRoot,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  };
  const initialStory = await observeStoryValidationCurrentness(storyOptions);
  const read = readFinalReviewState(options.workspace);
  if (read.status !== 'ready') {
    return {
      storyValidation: initialStory,
      runnerVersionObservation: { status: 'not-required' },
      finalReview: { read, current: false, staleReasons: [] },
    };
  }

  const runner = read.state.binding.runner;
  if (initialStory.status !== 'ready') {
    return {
      storyValidation: initialStory,
      runnerVersionObservation: { status: 'unverifiable', runner, message: initialStory.message },
      finalReview: stale(read, `Story 验收当前性无法验证：${initialStory.message}`),
    };
  }
  const contract = readWorkingQualityContractAuthority(options.projectRoot);
  if (contract.status !== 'ready') {
    return {
      storyValidation: initialStory,
      runnerVersionObservation: {
        status: 'unverifiable',
        runner,
        message: `质量契约不可用：${contract.status}`,
      },
      finalReview: stale(read, `质量契约不可用：${contract.status}`),
    };
  }

  const observation = createManagedReviewObservation({
    session: options.session,
    root: options.projectRoot,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  });
  const preflight = await runReviewPreflight({
    root: options.projectRoot,
    workspace: options.workspace,
    currentContract: contract.contract,
    observation,
  });
  if (preflight.status !== 'ready') {
    return {
      storyValidation: initialStory,
      runnerVersionObservation: {
        status: 'unverifiable',
        runner,
        message: preflight.message,
      },
      finalReview: stale(read, preflight.message),
    };
  }

  const context = preflight.context;
  let finalRunner = await runnerObservation({
    session: options.session,
    projectRoot: options.projectRoot,
    runner,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  });
  let status = evaluateCurrentReviewStatus({
    read,
    context,
    runnerVersionObservation: finalRunner,
    codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
    storyValidationDigest:
      initialStory.headSha === context.headSha ? initialStory.storyValidationDigest : null,
  });
  if (!status.current) {
    return {
      storyValidation: initialStory,
      runnerVersionObservation: finalRunner,
      finalReview: status,
    };
  }

  const refreshedRemote = options.refreshRemote
    ? await evaluateManagedReviewRemoteState({
        context,
        contract: context.baseContract,
        client: observation.github,
      })
    : undefined;
  const firstRevalidation = await revalidateReviewContext(context, options.workspace, observation);
  let finalStory = await observeStoryValidationCurrentness(storyOptions);
  finalRunner = await runnerObservation({
    session: options.session,
    projectRoot: options.projectRoot,
    runner,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  });
  status = evaluateCurrentReviewStatus({
    read,
    context,
    runnerVersionObservation: finalRunner,
    codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
    storyValidationDigest:
      sameStoryObservation(initialStory, finalStory) && finalStory.headSha === context.headSha
        ? finalStory.storyValidationDigest
        : null,
    ...(refreshedRemote === undefined ? {} : { refreshedRemote }),
  });
  if (!firstRevalidation.ok) status = addReason(status, firstRevalidation.message);
  if (!sameStoryObservation(initialStory, finalStory)) {
    status = addReason(status, 'status 查询期间 Story 验收绑定发生变化');
  }

  if (status.current && read.state.schemaVersion === 2) {
    for (const problem of await decisionProblems({
      workspace: options.workspace,
      state: read.state,
      contract: context.baseContract,
      observation,
      refreshRemote: options.refreshRemote,
      now: new Date(),
    })) {
      status = addReason(status, problem);
    }
    const retainedReasons = [...status.staleReasons];
    finalStory = await observeStoryValidationCurrentness(storyOptions);
    finalRunner = await runnerObservation({
      session: options.session,
      projectRoot: options.projectRoot,
      runner,
      ...(options.termination === undefined ? {} : { termination: options.termination }),
    });
    status = evaluateCurrentReviewStatus({
      read,
      context,
      runnerVersionObservation: finalRunner,
      codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
      storyValidationDigest:
        sameStoryObservation(initialStory, finalStory) && finalStory.headSha === context.headSha
          ? finalStory.storyValidationDigest
          : null,
      ...(refreshedRemote === undefined ? {} : { refreshedRemote }),
    });
    for (const reason of retainedReasons) {
      if (!status.staleReasons.includes(reason)) status = addReason(status, reason);
    }
    // P1 Issue、Runner 与 Story 都可能是慢观察。完整 PR/base/head/标签必须最后夹取，
    // 否则这些观察期间发生的远端变化仍可能被当成当前绿色结果。
    const finalRevalidation = await revalidateReviewContext(
      context,
      options.workspace,
      observation,
    );
    if (!finalRevalidation.ok) status = addReason(status, finalRevalidation.message);
  }

  return {
    storyValidation: finalStory,
    runnerVersionObservation: finalRunner,
    finalReview: status,
  };
}
