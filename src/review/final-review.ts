import {
  runContractQualityChecks,
  type ContractGateResult,
  type ManagedGateContext,
} from '../engine/gate.js';
import type { AgentKind } from '../engine/agent.js';
import { CODING_X_VERSION } from '../version.js';
import type { GitHubReviewReadClient } from '../quality/github.js';
import type { QualityContract } from '../quality/contract.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { workspacePathsReferToSameDirectory } from '../workspace-safety/filesystem.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { createReviewBinding, digestReviewBinding } from './binding.js';
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
  probe?: typeof probeRunnerIsolation;
  axisRunner?: AxisRunner;
  runnerVersion?: string;
  remote?: (
    context: ReviewPreflightContext,
    contract: QualityContract,
  ) => ReviewRemoteState | Promise<ReviewRemoteState>;
  revalidate?: () => ReviewContextRevalidation | Promise<ReviewContextRevalidation>;
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
  const round = initialRound(workspace);
  // 先使旧结果失效，再进入本轮任何可失败环节。否则同一 head 上的机械
  // 检查回归、裁决文件损坏或 Runner 中断可能让 status 继续读到旧的绿色结果。
  await invalidateFinalReviewState(options.session.writer);
  let decisions;
  try {
    decisions = readReviewDecisions(workspace);
  } catch (error) {
    return {
      exitCode: 2,
      message: `Review 裁决记录无效：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const managedGate: ManagedGateContext = {
    session: options.session,
    kind: 'final-review',
    termination: options.termination,
  };
  const gate = await (options.gate
    ? options.gate(context.baseContract, context.root, managedGate)
    : runContractQualityChecks(context.baseContract.checks, context.root, undefined, managedGate));
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
  const mechanicalEvidence = {
    status: 'passed' as const,
    headSha: context.headSha,
    qualityContractDigest: context.baseContractDigest,
    scope: 'all-current-platform-applicable-contract-checks' as const,
  };

  let runnerVersion: string;
  try {
    runnerVersion =
      options.runnerVersion ??
      (await readRunnerVersion({
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
    });
  const revalidateContext = async () =>
    await (options.revalidate?.() ?? revalidateReviewContext(context, workspace, observation));
  const verifyRunnerVersion = async (phase: string): Promise<string | null> => {
    if (options.runnerVersion !== undefined) return null;
    try {
      const currentRunnerVersion = await readRunnerVersion({
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
    const runnerError = await verifyRunnerVersion('远端核验后');
    if (runnerError) return { exitCode: 5, message: runnerError };
    const finallyRevalidated = await revalidateContext();
    if (!finallyRevalidated.ok) {
      return {
        exitCode: 5,
        message: `${finallyRevalidated.message}；远端核验后的本轮 Review 已作废，请重新运行 coding-x`,
      };
    }
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
    const persistenceError = await persistState(state);
    if (persistenceError !== null) return { exitCode: 5, message: persistenceError };
    return stateOutcome(state);
  }

  const axes: ReviewAxisResult[] = [];
  const axisRunner = options.axisRunner ?? runSafeReviewAxis;
  const runAxis = async (
    axis: ReviewAxis,
  ): Promise<{ readonly stop: boolean; readonly diagnostic?: string }> => {
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
    return cleanupDiagnostic === undefined
      ? { stop }
      : { stop, diagnostic: cleanupDiagnostic };
  };

  let securityStop = await runAxis('spec');
  if (!securityStop.stop && !options.termination?.signal.aborted) {
    securityStop = await runAxis('engineering');
  }
  risk = applyReviewerRequestedDeepReview(risk, axes);
  if (risk.triggered && !securityStop.stop && !options.termination?.signal.aborted) {
    securityStop = await runAxis('deep');
  }
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
    const persistenceError = await persistState(state);
    if (persistenceError !== null) {
      return { exitCode: 5, message: `${summary}；${persistenceError}` };
    }
    return stateOutcome(state);
  }

  const revalidated = await revalidateContext();
  if (!revalidated.ok) {
    return {
      exitCode: 5,
      message: `${revalidated.message}；本轮 Review 已作废，请重新运行 coding-x`,
    };
  }
  const runnerError = await verifyRunnerVersion('评审结束时');
  if (runnerError) return { exitCode: 5, message: runnerError };

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
  const finalRunnerError = await verifyRunnerVersion('远端核验后');
  if (finalRunnerError) return { exitCode: 5, message: finalRunnerError };
  const finallyRevalidated = await revalidateContext();
  if (!finallyRevalidated.ok) {
    return {
      exitCode: 5,
      message: `${finallyRevalidated.message}；远端核验后的本轮 Review 已作废，请重新运行 coding-x`,
    };
  }
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
  const persistenceError = await persistState(state);
  if (persistenceError !== null) return { exitCode: 5, message: persistenceError };
  return stateOutcome(state);
}
