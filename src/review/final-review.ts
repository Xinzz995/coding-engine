import {
  runContractQualityChecks,
  selectContractQualityChecks,
  type ContractGateResult,
  type ManagedGateContext,
  type QualityChangeSelection,
} from '../engine/gate.js';
import type { AgentKind } from '../engine/agent.js';
import { CODING_X_VERSION } from '../version.js';
import type { GitHubReviewReadClient } from '../quality/github.js';
import type { QualityContract } from '../quality/contract.js';
import {
  digestFinalReviewMechanicalEnvironment,
  finalReviewMechanicalEnvironmentPolicy,
} from '../engine/story-validation-currentness.js';
import {
  createCleanValidationCheckout,
  describeCleanValidationCheckoutCleanup,
  type CleanValidationCheckout,
} from '../engine/clean-validation-checkout.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { workspacePathsReferToSameDirectory } from '../workspace-safety/filesystem.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { createReviewBinding, digestReviewBinding } from './binding.js';
import {
  verifyReviewAuthoritySnapshot,
  type ReviewAuthoritySnapshotVerifier,
} from './authority-snapshot.js';
import { digest, normalizeText } from './common.js';
import { unresolvedBlockingFindings } from './decisions.js';
import { createReviewPackage } from './package.js';
import {
  runReviewPreflight,
  revalidateReviewContext,
  type ReviewPreflightContext,
  type ReviewPreflightResult,
  type ReviewContextRevalidation,
} from './preflight.js';
import { evaluateManagedReviewRemoteState } from './remote.js';
import {
  createManagedReviewObservation,
  type ManagedReviewObservation,
} from './managed-observation.js';
import { applyReviewerRequestedDeepReview, assessReviewRisk } from './risk.js';
import {
  RUNNER_TOOL_POLICY_VERSION,
  RunnerPolicyViolation,
  probeRunnerIsolation,
  readRunnerVersion,
  runSafeReviewAxis,
  type RunnerIsolationProbe,
  type SafeRunnerInvocation,
} from './runner.js';
import {
  describeReviewTemporaryRetention,
  ReviewTemporaryDirectoryError,
} from './temporary-directory.js';
import {
  reusableFullGateResult,
  type FullGateProof,
} from '../engine/full-gate-proof.js';
import {
  invalidateFinalReviewState,
  readFinalReviewState,
  readReviewDecisions,
  writeFinalReviewState,
} from './state.js';
import {
  REVIEW_STATE_SCHEMA_VERSION,
  type FinalReviewOutcome,
  type FinalReviewState,
  type ModelReviewOutput,
  type ReviewAxis,
  type ReviewAxisResult,
  type ReviewBinding,
  type ReviewFinding,
  type ReviewRemoteState,
  type ReviewRiskAssessment,
} from './types.js';

type AxisRunner = (options: {
  session: WorkspaceSession;
  runner: AgentKind;
  model: string;
  runnerVersion: string;
  axis: ReviewAxis;
  reviewPackage: ReturnType<typeof createReviewPackage>;
  timeoutMs: number;
  termination?: ManagedGateContext['termination'];
}) => Promise<SafeRunnerInvocation>;

export type StoryValidationBindingObservation =
  | {
      status: 'ready';
      digest: string;
      observationToken: string;
      authorityInputDigest?: string;
    }
  | { status: 'unverifiable'; message: string };

function findingId(axis: ReviewAxis, finding: ModelReviewOutput['findings'][number]): string {
  return `RV-${axis.toUpperCase()}-${digest({
    axis,
    severity: finding.severity,
    title: normalizeText(finding.title),
    location: finding.location,
    ruleSource: normalizeText(finding.ruleSource),
    impact: normalizeText(finding.impact),
  }).slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

function engineFindings(options: {
  output: ModelReviewOutput;
  axis: ReviewAxis;
  context: ReviewPreflightContext;
  round: number;
}): ReviewFinding[] {
  return options.output.findings.map((finding) => ({
    id: findingId(options.axis, finding),
    axis: options.axis,
    severity: finding.severity,
    title: finding.title,
    location: finding.location,
    ruleSource: finding.ruleSource,
    impact: finding.impact,
    recommendation: finding.recommendation,
    requiresHumanDecision: finding.requiresHumanDecision,
    prNumber: options.context.pullRequest.number,
    baseSha: options.context.baseSha,
    headSha: options.context.headSha,
    round: options.round,
  }));
}

function stateOutcome(state: FinalReviewState): FinalReviewOutcome {
  if (state.status === 'unverifiable') {
    return { exitCode: 5, state, message: '最终 Review 无法验证；没有产生可交付结论' };
  }
  if (state.deliveryStatus === 'findings') {
    return { exitCode: 4, state, message: '存在待人工处理的阻断 finding；请运行 /review-loop' };
  }
  if (state.shadow) {
    return { exitCode: 7, state, message: 'Shadow Review 完成；该结果不能表示可交付' };
  }
  if (state.remote.status !== 'ready') {
    return { exitCode: 6, state, message: '本地 Review 已完成，但 GitHub CI 或 Ruleset 尚未就绪' };
  }
  return { exitCode: 0, state, message: '实现验证、本地 Review 与 GitHub 交付条件均已就绪' };
}

function initialRound(workspace: string): number {
  const previous = readFinalReviewState(workspace);
  return previous.status === 'ready' ? previous.state.round + 1 : 1;
}

function makeState(options: {
  status: FinalReviewState['status'];
  deliveryStatus: FinalReviewState['deliveryStatus'];
  binding: ReviewBinding;
  risk: ReviewRiskAssessment;
  axes: ReviewAxisResult[];
  remote: ReviewRemoteState;
  round: number;
  shadow: boolean;
  startedAt: string;
}): FinalReviewState {
  return {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    ...options,
    completedAt: new Date().toISOString(),
  };
}

export async function runFinalReview(options: {
  root: string;
  workspace: string;
  session: WorkspaceSession;
  currentContract: QualityContract;
  runner: AgentKind;
  model?: string;
  codingXVersion?: string;
  shadow?: boolean;
  timeoutMs?: number;
  /** Test seam. Production formal Review uses the supervised observation client. */
  client?: GitHubReviewReadClient;
  /** Test seam. Production formal Review runs the supervised preflight. */
  preflight?: () => ReviewPreflightResult | Promise<ReviewPreflightResult>;
  /** Test seam for deterministic observation fixtures. */
  observation?: ManagedReviewObservation;
  gate?: (
    contract: QualityContract,
    root: string,
    managed: ManagedGateContext,
  ) => Promise<ContractGateResult>;
  /** 同一 loop 内由引擎签发；输入不完全一致时静默放弃并重新运行。 */
  reusableFullGate?: FullGateProof;
  probe?: typeof probeRunnerIsolation;
  axisRunner?: AxisRunner;
  runnerVersion?: string;
  /** @internal Deterministic Runner identity seam; production fixes readRunnerVersion. */
  runnerVersionReader?: typeof readRunnerVersion;
  remote?: (
    context: ReviewPreflightContext,
    contract: QualityContract,
  ) => ReviewRemoteState | Promise<ReviewRemoteState>;
  revalidate?: () => ReviewContextRevalidation | Promise<ReviewContextRevalidation>;
  /** @internal Whole-checkpoint test seam; production fixes the managed snapshot helper. */
  authoritySnapshotVerifier?: ReviewAuthoritySnapshotVerifier;
  /** @internal Trusted executable fixtures for the real managed snapshot integration test. */
  authoritySnapshotExecutablesForTests?: { git: string; gh: string; runner: string };
  /** @internal Explicit compatibility switch for legacy fine-grained unit fixtures only. */
  legacyAuthorityVerificationForTests?: boolean;
  /** loop 在进入 Review 前冻结的精确 Story 凭证集合摘要。 */
  storyValidationDigest: string;
  /** 在同一 workspace session 中只读重算当前 PRD/state/HEAD 的凭证集合。 */
  observeStoryValidation: () =>
    StoryValidationBindingObservation | Promise<StoryValidationBindingObservation>;
  termination?: ManagedGateContext['termination'];
}): Promise<FinalReviewOutcome> {
  const startedAt = new Date().toISOString();
  const workspace = options.session.writer.workspacePath;
  const persistState = async (state: FinalReviewState): Promise<string | null> => {
    if (options.session.state !== 'open') {
      return `workspace session 处于 ${options.session.state}，无法写入最终 Review 状态`;
    }
    try {
      await writeFinalReviewState(options.session.writer, state);
      return null;
    } catch (error) {
      return `无法写入最终 Review 状态：${error instanceof Error ? error.message : String(error)}`;
    }
  };
  let matchesSession = false;
  try {
    matchesSession = await workspacePathsReferToSameDirectory(options.workspace, workspace);
  } catch {
    // Unverifiable aliases must not select a second read/write root for a formal Review.
  }
  if (!matchesSession) {
    return {
      exitCode: 2,
      message: '最终 Review 的 workspace 与受控会话不一致；拒绝读取或写入状态',
    };
  }
  if (!options.model?.trim()) {
    return {
      exitCode: 5,
      message:
        '最终 Review 必须使用明确模型；请在 PRD models.validator 中固定，或传 --review-model',
    };
  }
  const model = options.model.trim();
  const round = initialRound(workspace);
  const isolateAfterStateRevocationFailure = (message: string): string => {
    if (options.session.state === 'open') {
      try {
        options.session.retainLeaseForIsolation();
        return `${message}；workspace 已隔离，活动租约已保留`;
      } catch (error) {
        return `${message}；workspace 无法进入隔离：${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    return `${message}；workspace session 处于 ${options.session.state}，活动状态不得视为已安全收口`;
  };
  // 一旦用户明确发起新一轮 Review，就先撤销旧结论。后续任何前置检查、受管观察或
  // 远端读取失败，都不能让旧绿色结果继续冒充本轮结论。
  try {
    await invalidateFinalReviewState(options.session.writer);
  } catch (error) {
    return {
      exitCode: 5,
      message: isolateAfterStateRevocationFailure(
        `无法先撤销旧 Final Review：${error instanceof Error ? error.message : String(error)}`,
      ),
    };
  }
  let storyObservationToken: string | null = null;
  let storyAuthorityInputDigest: string | null = null;
  const verifyStoryValidationBinding = async (
    phase: string,
    establish = false,
  ): Promise<string | null> => {
    if (!/^sha256:[a-f0-9]{64}$/u.test(options.storyValidationDigest)) {
      return `${phase}Story 验收凭证集合摘要非法；本轮 Review 已作废`;
    }
    try {
      const observed = await options.observeStoryValidation();
      if (observed.status !== 'ready') {
        return `${phase}Story 验收凭证集合无法验证：${observed.message}`;
      }
      if (!/^sha256:[a-f0-9]{64}$/u.test(observed.observationToken)) {
        return `${phase}Story 验收观察令牌非法；本轮 Review 已作废`;
      }
      if (observed.digest !== options.storyValidationDigest) {
        return `${phase}Story 验收凭证集合发生变化；本轮 Review 已作废`;
      }
      if (establish) {
        storyObservationToken = observed.observationToken;
        storyAuthorityInputDigest =
          observed.authorityInputDigest !== undefined &&
          /^sha256:[a-f0-9]{64}$/u.test(observed.authorityInputDigest)
            ? observed.authorityInputDigest
            : null;
        return null;
      }
      return storyObservationToken === observed.observationToken
        ? null
        : `${phase}Story 验收权威输入发生变化；本轮 Review 已作废`;
    } catch (error) {
      return `${phase}Story 验收凭证集合无法验证：${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  };
  const initialStoryError = await verifyStoryValidationBinding('最终 Review 启动前：', true);
  if (initialStoryError) return { exitCode: 5, message: initialStoryError };
  const managedObservation =
    options.observation ??
    createManagedReviewObservation({
      session: options.session,
      root: options.root,
      termination: options.termination,
    });
  const observation =
    options.client === undefined
      ? managedObservation
      : { ...managedObservation, github: options.client };
  const client = observation.github;
  const preflight = await (options.preflight?.() ??
    runReviewPreflight({
      root: options.root,
      workspace,
      currentContract: options.currentContract,
      observation,
    }));
  if (preflight.status !== 'ready') {
    const exitCode =
      preflight.status === 'config-error' ? 2 : preflight.status === 'remote-not-ready' ? 6 : 5;
    return { exitCode, message: preflight.message };
  }
  const context = preflight.context;
  let decisions;
  try {
    decisions = readReviewDecisions(workspace);
  } catch (error) {
    return {
      exitCode: 2,
      message: `Review 裁决记录无效：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  const decisionsDigest = digest(decisions);
  const verifyDecisionsSnapshot = (phase: string): string | null => {
    try {
      return digest(readReviewDecisions(workspace)) === decisionsDigest
        ? null
        : `${phase}Review 裁决记录发生变化；本轮 Review 已作废`;
    } catch (error) {
      return `${phase}Review 裁决记录无法验证：${
        error instanceof Error ? error.message : String(error)
      }`;
    }
  };

  const managedGate: ManagedGateContext = {
    session: options.session,
    kind: 'final-review',
    termination: options.termination,
  };
  let mechanicalCheckout: CleanValidationCheckout | null = null;
  let mechanicalRoot = context.root;
  const mechanicalValidationEnvironmentDigest = digestFinalReviewMechanicalEnvironment({
    contract: context.baseContract,
    headSha: context.headSha,
    defaultBranchGitHead: context.baseSha,
  });
  let gate: ContractGateResult | null = null;
  let mechanicalChangeManifestDigest: string | null = null;
  let mechanicalChangeSelection: QualityChangeSelection | undefined;
  let mechanicalEnvironmentError: string | null = null;
  const mechanicalPolicy = finalReviewMechanicalEnvironmentPolicy(
    context.baseContract,
    context.baseSha,
  );
  const reused = reusableFullGateResult(options.reusableFullGate, {
    contract: context.baseContract,
    headSha: context.headSha,
    defaultBranchGitHead: context.baseSha,
    additionalRefs: mechanicalPolicy.additionalRefs,
    referenceAliases: mechanicalPolicy.referenceAliases,
  }, context.baseSha);
  try {
    if (reused) {
      gate = reused;
      mechanicalChangeManifestDigest = options.reusableFullGate?.changeScope?.manifestDigest ?? null;
      console.log('♻️  最终 Review 复用同一进程中输入完全一致的适用检查结果');
    } else if (!options.gate) {
      mechanicalCheckout = await createCleanValidationCheckout({
        sourceRoot: context.root,
        head: context.headSha,
        contract: context.baseContract,
        ...mechanicalPolicy,
        managed: managedGate,
      });
      mechanicalRoot = mechanicalCheckout.root;
      if (mechanicalCheckout.environmentDigest !== mechanicalValidationEnvironmentDigest) {
        throw new Error('最终 Review 干净检出返回的机械环境摘要与引擎预计算值不一致');
      }
      const preparedStoryError =
        await verifyStoryValidationBinding('最终 Review 干净检出准备结束后：');
      if (preparedStoryError) return { exitCode: 5, message: preparedStoryError };
      const manifest = await mechanicalCheckout.storyChangeManifest(
        context.baseSha,
        '最终 Review ',
      );
      mechanicalChangeManifestDigest = manifest.digest;
      mechanicalChangeSelection = manifest.changeSelection;
    }
    if (!reused) {
      gate = await (options.gate
        ? options.gate(context.baseContract, context.root, managedGate)
        : runContractQualityChecks(
            context.baseContract.checks,
            mechanicalRoot,
            undefined,
            mechanicalCheckout
              ? {
                  ...managedGate,
                  environment: mechanicalCheckout.processEnvironment,
                  forbiddenExecutableRoot: context.root,
                }
              : managedGate,
            mechanicalChangeSelection,
          ));
    }
    if (mechanicalCheckout) {
      await mechanicalCheckout.assertCurrent('最终 Review 机械检查结束后');
    }
  } catch (error) {
    mechanicalEnvironmentError = error instanceof Error ? error.message : String(error);
  } finally {
    if (mechanicalCheckout) {
      const cleanup = mechanicalCheckout.cleanup();
      if (cleanup.status !== 'removed') {
        mechanicalEnvironmentError =
          `${mechanicalEnvironmentError ? `${mechanicalEnvironmentError}；` : ''}` +
          `临时验证目录未能安全清理，${describeCleanValidationCheckoutCleanup(cleanup)}`;
      }
    }
  }
  if (mechanicalEnvironmentError) {
    return {
      exitCode: 5,
      message: `最终 Review 的机械验证环境不可验证：${mechanicalEnvironmentError}`,
    };
  }
  if (!gate) {
    return { exitCode: 5, message: '最终 Review 的机械检查没有返回结果' };
  }
  if (options.termination?.signal.aborted) {
    return { exitCode: 5, message: '最终 Review 已由用户中断；旧结果保持失效' };
  }
  if (!gate.ok) {
    const failure = gate.failure;
    return {
      exitCode: 1,
      message:
        `最终 Review 前机械检查失败：${failure?.command ?? 'unknown'}` +
        `${failure?.timedOut ? '（超时）' : failure?.exitCode !== null && failure?.exitCode !== undefined ? `（退出码 ${failure.exitCode}）` : ''}`,
    };
  }
  const platform =
    process.platform === 'linux'
      ? 'linux'
      : process.platform === 'darwin'
        ? 'macos'
        : process.platform === 'win32'
          ? 'windows'
          : null;
  const defaultSelection =
    platform === null
      ? null
      : selectContractQualityChecks(context.baseContract.checks, platform);
  const selectedCheckIds =
    gate.selectedCheckIds ?? defaultSelection?.applicable.map((check) => check.id) ?? [];
  const skippedCheckIds =
    gate.selectedCheckIds === undefined
      ? (defaultSelection?.skippedByPlatform ?? [])
      : [...gate.skipped];
  const mechanicalEvidence = {
    status: 'passed' as const,
    headSha: context.headSha,
    qualityContractDigest: context.baseContractDigest,
    validationEnvironmentDigest: mechanicalValidationEnvironmentDigest,
    scope: 'all-current-change-applicable-contract-checks' as const,
    selectionMode: gate.selectionMode ?? ('full' as const),
    selectedCheckIds,
    skippedCheckIds,
    changeManifestDigest:
      gate.selectionMode === 'scoped' ? mechanicalChangeManifestDigest : null,
  };
  const preModelStoryError = await verifyStoryValidationBinding('机械检查结束后、模型调用前：');
  if (preModelStoryError) return { exitCode: 5, message: preModelStoryError };

  let runnerVersion: string;
  try {
    runnerVersion =
      options.runnerVersion ??
      (await (options.runnerVersionReader ?? readRunnerVersion)({
        session: options.session,
        runner: options.runner,
        projectRoot: context.root,
        termination: options.termination,
      }));
  } catch (error) {
    return { exitCode: 5, message: error instanceof Error ? error.message : String(error) };
  }
  let risk = assessReviewRisk(context);
  const remote = async () =>
    await (options.remote?.(context, context.baseContract) ??
      evaluateManagedReviewRemoteState({ context, contract: context.baseContract, client }));
  const makeBinding = () =>
    createReviewBinding({
      context,
      risk,
      codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
      runner: options.runner,
      model,
      runnerVersion,
      storyValidationDigest: options.storyValidationDigest,
      validationEnvironmentDigest: mechanicalValidationEnvironmentDigest,
    });
  const revalidateContext = async () =>
    await (options.revalidate?.() ?? revalidateReviewContext(context, workspace, observation));
  const verifyRunnerVersion = async (phase: string): Promise<string | null> => {
    if (options.runnerVersion !== undefined) return null;
    try {
      const currentRunnerVersion = await (options.runnerVersionReader ?? readRunnerVersion)({
        session: options.session,
        runner: options.runner,
        projectRoot: context.root,
        termination: options.termination,
      });
      return currentRunnerVersion === runnerVersion
        ? null
        : `${phase} Runner 版本发生变化；本轮 Review 已作废`;
    } catch (error) {
      return `${phase}无法核对 Runner 版本：${error instanceof Error ? error.message : String(error)}`;
    }
  };
  const verifyReviewAuthorities = async (
    phase: string,
    includeDecisions: boolean,
  ): Promise<string | null> => {
    const productionSnapshot =
      options.authoritySnapshotVerifier !== undefined ||
      options.legacyAuthorityVerificationForTests !== true;
    if (productionSnapshot) {
      if (options.authoritySnapshotVerifier === undefined && storyAuthorityInputDigest === null) {
        return `${phase}：Story 验收权威输入摘要缺失；本轮 Review 已作废`;
      }
      try {
        const error = await (
          options.authoritySnapshotVerifier ??
          ((request) =>
            verifyReviewAuthoritySnapshot({
              session: options.session,
              context,
              workspace,
              runner: options.runner,
              expectedRunnerVersion: runnerVersion,
              expectedStoryAuthorityInputDigest: storyAuthorityInputDigest!,
              expectedDecisionsDigest: decisionsDigest,
              includeDecisions: request.includeDecisions,
              phase: request.phase,
              termination: options.termination,
              ...(options.authoritySnapshotExecutablesForTests
                ? { executablesForTests: options.authoritySnapshotExecutablesForTests }
                : {}),
            }))
        )({ phase, includeDecisions });
        return error === null ? null : `${phase}：${error}`;
      } catch (error) {
        return `${phase}：无法核对 Review 权威快照：${
          error instanceof Error ? error.message : String(error)
        }；本轮 Review 已作废`;
      }
    }
    const storyError = await verifyStoryValidationBinding(`${phase}：`);
    if (storyError) return storyError;
    const runnerError = await verifyRunnerVersion(`${phase}：`);
    if (runnerError) return runnerError;
    const decisionsError = includeDecisions ? verifyDecisionsSnapshot(`${phase}：`) : null;
    if (decisionsError) return decisionsError;
    const revalidated = await revalidateContext();
    return revalidated.ok ? null : `${phase}：${revalidated.message}；本轮 Review 已作废`;
  };
  const persistVerifiedState = async (
    state: FinalReviewState,
    includeDecisions: boolean,
  ): Promise<string | null> => {
    const before = await verifyReviewAuthorities('最终 Review 状态落盘前', includeDecisions);
    if (before) return before;
    const persistenceError = await persistState(state);
    if (persistenceError) return persistenceError;
    const after = await verifyReviewAuthorities('最终 Review 状态落盘后', includeDecisions);
    if (!after) return null;
    try {
      await invalidateFinalReviewState(options.session.writer);
      return `${after}；刚写入的状态已撤销`;
    } catch (error) {
      return isolateAfterStateRevocationFailure(
        `${after}；刚写入的状态无法安全撤销：${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  };

  const beforeProbeError = await verifyReviewAuthorities('Runner 隔离探测前', false);
  if (beforeProbeError) return { exitCode: 5, message: beforeProbeError };

  let probe: RunnerIsolationProbe;
  try {
    probe = await (options.probe ?? probeRunnerIsolation)({
      session: options.session,
      runner: options.runner,
      model,
      projectRoot: context.root,
      runnerVersion,
      timeoutMs: Math.min(options.timeoutMs ?? 30 * 60_000, 5 * 60_000),
      termination: options.termination,
    });
  } catch (error) {
    probe = {
      ok: false,
      runner: options.runner,
      model,
      runnerVersion,
      policyVersion: RUNNER_TOOL_POLICY_VERSION,
      durationMs: 0,
      failures: [error instanceof Error ? error.message : String(error)],
    };
  }
  const postProbeCurrentnessError = await verifyReviewAuthorities('Runner 隔离探测结束后', false);
  if (postProbeCurrentnessError) {
    return { exitCode: 5, message: postProbeCurrentnessError };
  }
  if (!probe.ok) {
    const summary = `Runner 隔离反测未通过：${probe.failures.join('；')}`;
    if (options.session.state !== 'open') {
      return {
        exitCode: 5,
        message: `${summary}；workspace session 处于 ${options.session.state}，旧结果保持失效`,
      };
    }
    const requiredAxes: ReviewAxis[] = risk.triggered
      ? ['spec', 'engineering', 'deep']
      : ['spec', 'engineering'];
    const axes: ReviewAxisResult[] = requiredAxes.map((axis) => ({
      axis,
      status: 'unverifiable',
      requestDeepReview: false,
      summary,
      findings: [],
      durationMs: probe.durationMs,
      attempts: 1,
    }));
    const remoteState = await remote();
    const remoteCurrentnessError = await verifyReviewAuthorities('远端核验后', false);
    if (remoteCurrentnessError) return { exitCode: 5, message: remoteCurrentnessError };
    const state = makeState({
      status: 'unverifiable',
      deliveryStatus: 'unverifiable',
      binding: makeBinding(),
      risk,
      axes,
      remote: remoteState,
      round,
      shadow: options.shadow ?? false,
      startedAt,
    });
    const persistenceError = await persistVerifiedState(state, false);
    if (persistenceError !== null) return { exitCode: 5, message: persistenceError };
    return stateOutcome(state);
  }

  const axes: ReviewAxisResult[] = [];
  const axisRunner = options.axisRunner ?? runSafeReviewAxis;
  const runAxis = async (
    axis: ReviewAxis,
  ): Promise<{
    readonly stop: boolean;
    readonly diagnostic?: string;
    readonly currentnessError?: string;
  }> => {
    let reviewPackage: ReturnType<typeof createReviewPackage> | null = null;
    let result: ReviewAxisResult;
    let stop = false;
    let invocationFailed = false;
    try {
      reviewPackage = createReviewPackage({
        context,
        risk,
        axis,
        runner: options.runner,
        model,
        mechanicalEvidence,
      });
      const invocation = await axisRunner({
        session: options.session,
        runner: options.runner,
        model,
        runnerVersion,
        axis,
        reviewPackage,
        timeoutMs: options.timeoutMs ?? 30 * 60_000,
        termination: options.termination,
      });
      const output = invocation.output;
      result = {
        axis,
        status: output.status,
        summary: output.unverifiableReason
          ? `${output.summary}（不可验证：${output.unverifiableReason}）`
          : output.summary,
        findings: engineFindings({ output, axis, context, round }),
        requestDeepReview: output.requestDeepReview,
        durationMs: invocation.durationMs,
        attempts: invocation.attempts,
      };
    } catch (error) {
      invocationFailed = true;
      const securityError =
        error instanceof RunnerPolicyViolation ||
        error instanceof ReviewTemporaryDirectoryError ||
        error instanceof WorkspaceSafetyError;
      stop = securityError;
      result = {
        axis,
        status: 'unverifiable',
        summary: error instanceof Error ? error.message : String(error),
        findings: [],
        requestDeepReview: false,
        durationMs: 0,
        attempts: reviewPackage
          ? error instanceof RunnerPolicyViolation
            ? error.attempts
            : securityError
              ? 1
              : 2
          : 0,
      };
    }

    let cleanupDiagnostic: string | undefined;
    if (reviewPackage !== null) {
      try {
        const cleanup = reviewPackage.cleanup();
        if (cleanup.status !== 'removed') {
          cleanupDiagnostic =
            `Reviewer 临时审查包${describeReviewTemporaryRetention(cleanup)}：` + cleanup.reason;
        }
      } catch (error) {
        cleanupDiagnostic = `Reviewer 临时审查包无法安全收口：${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    if (cleanupDiagnostic !== undefined) {
      result.status = 'unverifiable';
      result.summary = invocationFailed
        ? `${result.summary}；${cleanupDiagnostic}`
        : cleanupDiagnostic;
      result.findings = [];
      result.requestDeepReview = false;
      stop = true;
    }
    axes.push(result);
    const currentnessError = await verifyReviewAuthorities(`${axis} Review 结束后`, false);
    return {
      stop,
      ...(cleanupDiagnostic === undefined ? {} : { diagnostic: cleanupDiagnostic }),
      ...(currentnessError === null ? {} : { currentnessError }),
    };
  };

  let securityStop = await runAxis('spec');
  if (securityStop.currentnessError) {
    return { exitCode: 5, message: securityStop.currentnessError };
  }
  if (!securityStop.stop && !options.termination?.signal.aborted) {
    securityStop = await runAxis('engineering');
    if (securityStop.currentnessError) {
      return { exitCode: 5, message: securityStop.currentnessError };
    }
  }
  risk = applyReviewerRequestedDeepReview(risk, axes);
  if (risk.triggered && !securityStop.stop && !options.termination?.signal.aborted) {
    securityStop = await runAxis('deep');
    if (securityStop.currentnessError) {
      return { exitCode: 5, message: securityStop.currentnessError };
    }
  }
  const postModelStoryError = await verifyStoryValidationBinding('Reviewer 模型结束后：');
  if (postModelStoryError) return { exitCode: 5, message: postModelStoryError };
  if (options.termination?.signal.aborted && securityStop.stop) {
    return {
      exitCode: 5,
      message:
        '最终 Review 已由用户中断，且 Reviewer 安全边界无法收口；' +
        (securityStop.diagnostic ?? axes.at(-1)?.summary ?? '现场已保留'),
    };
  }
  if (options.termination?.signal.aborted) {
    return { exitCode: 5, message: '最终 Review 已由用户中断；旧结果保持失效' };
  }
  if (securityStop.stop) {
    const summary = securityStop.diagnostic ?? '本轮 Reviewer 安全边界无法验证';
    if (options.session.state !== 'open') {
      return {
        exitCode: 5,
        message: `${summary}；workspace session 处于 ${options.session.state}，旧结果保持失效`,
      };
    }
    const requiredAxes: ReviewAxis[] = risk.triggered
      ? ['spec', 'engineering', 'deep']
      : ['spec', 'engineering'];
    for (const axis of requiredAxes) {
      if (axes.some((entry) => entry.axis === axis)) continue;
      axes.push({
        axis,
        status: 'unverifiable',
        summary: `前序 Reviewer 安全边界无法收口，${axis} Review 未执行`,
        findings: [],
        requestDeepReview: false,
        durationMs: 0,
        attempts: 0,
      });
    }
    const state = makeState({
      status: 'unverifiable',
      deliveryStatus: 'unverifiable',
      binding: makeBinding(),
      risk,
      axes,
      remote: {
        status: 'invalid',
        checks: [],
        rulesetErrors: [],
        detail: summary,
        checkedAt: new Date().toISOString(),
      },
      round,
      shadow: options.shadow ?? false,
      startedAt,
    });
    const persistenceError = await persistVerifiedState(state, false);
    if (persistenceError !== null) {
      return { exitCode: 5, message: `${summary}；${persistenceError}` };
    }
    return stateOutcome(state);
  }

  const preResolutionCurrentnessError = await verifyReviewAuthorities('评审结束时', true);
  if (preResolutionCurrentnessError) {
    return { exitCode: 5, message: preResolutionCurrentnessError };
  }

  const allFindings = axes.flatMap((axis) => axis.findings);
  const finalBinding = makeBinding();
  const resolution = await unresolvedBlockingFindings({
    findings: allFindings,
    decisions: decisions.decisions,
    headSha: context.headSha,
    reviewBindingDigest: digestReviewBinding(finalBinding),
    contract: context.baseContract,
    client,
  });
  const postResolutionCurrentnessError = await verifyReviewAuthorities(
    'Review 裁决与延期 Issue 核验后',
    true,
  );
  if (postResolutionCurrentnessError) {
    return { exitCode: 5, message: postResolutionCurrentnessError };
  }
  const anyUnverifiable =
    axes.some((axis) => axis.status === 'unverifiable') || resolution.decisionErrors.length > 0;
  const status = anyUnverifiable
    ? 'unverifiable'
    : resolution.unresolved.length > 0
      ? 'failed'
      : 'passed';
  if (resolution.decisionErrors.length > 0) {
    const engineering = axes.find((axis) => axis.axis === 'engineering');
    if (engineering) {
      engineering.status = 'unverifiable';
      engineering.summary = `${engineering.summary}；裁决记录无法验证：${resolution.decisionErrors.join('；')}`;
    }
  }
  const remoteState = await remote();
  const finalCurrentnessError = await verifyReviewAuthorities('远端核验后', true);
  if (finalCurrentnessError) return { exitCode: 5, message: finalCurrentnessError };
  const shadow = options.shadow ?? false;
  const deliveryStatus =
    status === 'unverifiable'
      ? 'unverifiable'
      : status === 'failed'
        ? 'findings'
        : shadow
          ? 'shadow'
          : remoteState.status !== 'ready'
            ? 'remote-pending'
            : 'ready';
  const state = makeState({
    status,
    deliveryStatus,
    binding: finalBinding,
    risk,
    axes,
    remote: remoteState,
    round,
    shadow,
    startedAt,
  });
  const persistenceError = await persistVerifiedState(state, true);
  if (persistenceError !== null) return { exitCode: 5, message: persistenceError };
  return stateOutcome(state);
}
