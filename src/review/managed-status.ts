import { CODING_X_VERSION } from '../version.js';
import type { QualityContract } from '../quality/contract.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { digestReviewBinding } from './binding.js';
import { normalizeText } from './common.js';
import { currentBlockingDecisionProof, validateP1DeferralIssue } from './decisions.js';
import {
  createManagedReviewObservation,
  type ManagedReviewObservation,
  type ManagedReviewTermination,
} from './managed-observation.js';
import { evaluateCurrentReviewStatus, type CurrentReviewStatus } from './currentness.js';
import {
  runReviewPreflight,
  type ReviewContextRevalidation,
  type ReviewPreflightContext,
  type ReviewPreflightResult,
} from './preflight.js';
import { runReviewPreflightSnapshot } from './preflight-snapshot.js';
import { evaluateManagedReviewRemoteState } from './remote.js';
import { readRunnerVersion } from './runner.js';
import { readFinalReviewState, readReviewDecisions } from './state.js';
import {
  observeStoryValidationCurrentness,
  readWorkingQualityContractAuthority,
  type StoryValidationObservation,
} from './story-validation-observation.js';
import type { FinalReviewState } from './types.js';

interface ManagedStatusAdapters {
  observeStoryValidation: typeof observeStoryValidationCurrentness;
  preflightSnapshot: typeof runReviewPreflightSnapshot;
  legacyPreflight: typeof runReviewPreflight;
}

const MANAGED_STATUS_ADAPTERS: ManagedStatusAdapters = {
  observeStoryValidation: observeStoryValidationCurrentness,
  preflightSnapshot: runReviewPreflightSnapshot,
  legacyPreflight: runReviewPreflight,
};

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

/** @internal Snapshot failure falls back only while the same session is still safe and open. */
export async function runManagedStatusPreflightControlled(
  options: Parameters<typeof runReviewPreflight>[0] & {
    session: WorkspaceSession;
    termination?: ManagedReviewTermination;
  },
  adapters: Pick<ManagedStatusAdapters, 'preflightSnapshot' | 'legacyPreflight'>,
) {
  try {
    return await adapters.preflightSnapshot({
      session: options.session,
      root: options.root,
      workspace: options.workspace,
      currentContract: options.currentContract,
      ...(options.termination === undefined ? {} : { termination: options.termination }),
    });
  } catch (error) {
    if (options.session.state !== 'open') throw error;
    return await adapters.legacyPreflight(options);
  }
}

function sortedLabels(value: readonly string[]): string[] {
  return value.map((label) => normalizeText(label)).sort((left, right) => left.localeCompare(right));
}

/** @internal A fresh full preflight must preserve every mutable fact checked by revalidation. */
export function revalidateReviewContextFromPreflight(
  expected: ReviewPreflightContext,
  observed: ReviewPreflightResult,
): ReviewContextRevalidation {
  if (observed.status !== 'ready') {
    return { ok: false, message: `评审期间完整当前性快照不可用：${observed.message}` };
  }
  const current = observed.context;
  if (current.branch !== expected.branch) {
    return { ok: false, message: '评审期间本地功能分支身份发生变化' };
  }
  if (
    current.baseContract.repository.fullName !== expected.baseContract.repository.fullName ||
    current.baseContract.repository.defaultBranch !== expected.baseContract.repository.defaultBranch
  ) {
    return { ok: false, message: '评审期间 GitHub 仓库或默认分支身份发生变化' };
  }
  if (current.baseSha !== expected.baseSha) {
    return { ok: false, message: '评审期间默认分支 base SHA 发生变化' };
  }
  if (current.headSha !== expected.headSha) {
    return { ok: false, message: '评审期间本地 HEAD 发生变化' };
  }
  if (current.pullRequest.number !== expected.pullRequest.number) {
    return { ok: false, message: '评审期间绑定的开放 PR 消失或编号发生变化' };
  }
  if (
    current.pullRequest.headSha !== expected.pullRequest.headSha ||
    current.pullRequest.baseSha !== expected.pullRequest.baseSha ||
    current.pullRequest.baseBranch !== expected.pullRequest.baseBranch
  ) {
    return { ok: false, message: '评审期间 PR 的 head、base 或目标分支发生变化' };
  }
  if (
    normalizeText(current.pullRequest.title) !== normalizeText(expected.pullRequest.title) ||
    normalizeText(current.pullRequest.body) !== normalizeText(expected.pullRequest.body)
  ) {
    return { ok: false, message: '评审期间 PR 标题或正文发生变化' };
  }
  if (
    JSON.stringify(sortedLabels(current.pullRequest.labels)) !==
    JSON.stringify(sortedLabels(expected.pullRequest.labels))
  ) {
    return { ok: false, message: '评审期间 PR 标签发生变化' };
  }
  return { ok: true };
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
  /** 候选命令复核 Shadow 凭证时必须显式提供；普通状态观察保持为空。 */
  candidateIdentityDigest?: string | null;
  /** @internal Deterministic currentness seam; production always uses the fixed observer. */
  adapters?: Partial<ManagedStatusAdapters>;
}): Promise<ManagedStatusQualityResult> {
  const adapters = { ...MANAGED_STATUS_ADAPTERS, ...options.adapters };
  const read = readFinalReviewState(options.workspace);
  const storyOptions = {
    session: options.session,
    workspace: options.workspace,
    projectRoot: options.projectRoot,
    runtimeIdentity: {
      mode: read.status === 'ready' && read.state.shadow ? 'shadow' as const : 'formal' as const,
      actualCodingXVersion: options.codingXVersion ?? CODING_X_VERSION,
      candidateIdentityDigest:
        read.status === 'ready' && read.state.shadow
          ? options.candidateIdentityDigest ?? null
          : null,
    },
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  };
  const initialStory = await adapters.observeStoryValidation(storyOptions);
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
  const preflight = await runManagedStatusPreflightControlled({
    session: options.session,
    root: options.projectRoot,
    workspace: options.workspace,
    currentContract: contract.contract,
    observation,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  }, adapters);
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
  const revalidateContext = async (): Promise<ReviewContextRevalidation> =>
    revalidateReviewContextFromPreflight(
      context,
      await runManagedStatusPreflightControlled(
        {
          session: options.session,
          root: options.projectRoot,
          workspace: options.workspace,
          currentContract: contract.contract,
          observation,
          ...(options.termination === undefined ? {} : { termination: options.termination }),
        },
        adapters,
      ),
    );
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
  const firstRevalidation = await revalidateContext();
  let finalStory = await adapters.observeStoryValidation(storyOptions);
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
    const finalRevalidation = await revalidateContext();
    if (!finalRevalidation.ok) status = addReason(status, finalRevalidation.message);
  }

  return {
    storyValidation: finalStory,
    runnerVersionObservation: finalRunner,
    finalReview: status,
  };
}
