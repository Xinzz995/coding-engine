import { runContractQualityChecks, type ContractGateResult } from '../engine/gate.js';
import type { AgentKind } from '../engine/agent.js';
import { CODING_X_VERSION } from '../version.js';
import { GhGitHubQualityClient, type GitHubQualityClient } from '../quality/github.js';
import type { QualityContract } from '../quality/contract.js';
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
import { evaluateReviewRemoteState } from './remote.js';
import { assessReviewRisk } from './risk.js';
import { REVIEW_RULES_DIGEST } from './rules.js';
import {
  RUNNER_TOOL_POLICY_VERSION,
  probeRunnerIsolation,
  readRunnerVersion,
  runSafeReviewAxis,
  type RunnerIsolationProbe,
  type SafeRunnerInvocation,
} from './runner.js';
import {
  invalidateFinalReviewState,
  readFinalReviewState,
  readReviewDecisions,
  writeFinalReviewState,
} from './state.js';
import {
  REVIEW_RULES_VERSION,
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
  runner: AgentKind;
  model: string;
  runnerVersion: string;
  axis: ReviewAxis;
  reviewPackage: ReturnType<typeof createReviewPackage>;
  timeoutMs: number;
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

function binding(options: {
  context: ReviewPreflightContext;
  risk: ReviewRiskAssessment;
  codingXVersion: string;
  runner: AgentKind;
  model: string;
  runnerVersion: string;
}): ReviewBinding {
  return {
    prNumber: options.context.pullRequest.number,
    targetBranch: options.context.pullRequest.baseBranch,
    baseSha: options.context.baseSha,
    headSha: options.context.headSha,
    prTitleDigest: digest(normalizeText(options.context.pullRequest.title)),
    prBodyDigest: digest(normalizeText(options.context.pullRequest.body)),
    specDigest: digest(options.context.specs),
    engineeringStandardsDigest: digest(options.context.engineeringStandards),
    qualityContractDigest: options.context.baseContractDigest,
    codingXVersion: options.codingXVersion,
    runner: options.runner,
    model: options.model,
    runnerVersion: options.runnerVersion,
    reviewRulesVersion: REVIEW_RULES_VERSION,
    reviewRulesDigest: REVIEW_RULES_DIGEST,
    riskDigest: options.risk.digest,
  };
}

function reviewerEscalatedRisk(risk: ReviewRiskAssessment): ReviewRiskAssessment {
  if (risk.categories.includes('reviewer-request')) return risk;
  const value = {
    ...risk,
    triggered: true,
    categories: [...risk.categories, 'reviewer-request' as const].sort(),
    reasons: [...risk.reasons, 'Spec 或工程 Reviewer 主动升级为深度结构评审'].sort(),
  };
  return { ...value, digest: digest({ ...value, digest: undefined }) };
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
  currentContract: QualityContract;
  runner: AgentKind;
  model?: string;
  codingXVersion?: string;
  shadow?: boolean;
  timeoutMs?: number;
  client?: GitHubQualityClient;
  preflight?: () => ReviewPreflightResult;
  gate?: (contract: QualityContract, root: string) => Promise<ContractGateResult>;
  probe?: typeof probeRunnerIsolation;
  axisRunner?: AxisRunner;
  runnerVersion?: string;
  remote?: (context: ReviewPreflightContext, contract: QualityContract) => ReviewRemoteState;
  revalidate?: () => ReviewContextRevalidation;
}): Promise<FinalReviewOutcome> {
  const startedAt = new Date().toISOString();
  if (!options.model?.trim()) {
    return {
      exitCode: 5,
      message: '最终 Review 必须使用明确模型；请在 PRD models.validator 中固定，或传 --review-model',
    };
  }
  const model = options.model.trim();
  const client = options.client ?? new GhGitHubQualityClient();
  const preflight = options.preflight?.() ?? runReviewPreflight({
    root: options.root,
    workspace: options.workspace,
    currentContract: options.currentContract,
    client,
  });
  if (preflight.status !== 'ready') {
    const exitCode = preflight.status === 'config-error' ? 2
      : preflight.status === 'remote-not-ready' ? 6 : 5;
    return { exitCode, message: preflight.message } as FinalReviewOutcome;
  }
  const context = preflight.context;
  const round = initialRound(options.workspace);
  // 先使旧结果失效，再进入本轮任何可失败环节。否则同一 head 上的机械
  // 检查回归、裁决文件损坏或 Runner 中断可能让 status 继续读到旧的绿色结果。
  invalidateFinalReviewState(options.workspace);
  let decisions;
  try {
    decisions = readReviewDecisions(options.workspace);
  } catch (error) {
    return {
      exitCode: 2,
      message: `Review 裁决记录无效：${error instanceof Error ? error.message : String(error)}`,
    };
  }

  const gate = await (options.gate
    ? options.gate(context.baseContract, context.root)
    : runContractQualityChecks(context.baseContract.checks, context.root));
  if (!gate.ok) {
    const failure = gate.failure;
    return {
      exitCode: 1,
      message: `最终 Review 前机械检查失败：${failure?.command ?? 'unknown'}` +
        `${failure?.timedOut ? '（超时）' : failure?.exitCode !== null && failure?.exitCode !== undefined ? `（退出码 ${failure.exitCode}）` : ''}`,
    };
  }

  let runnerVersion: string;
  try { runnerVersion = options.runnerVersion ?? readRunnerVersion(options.runner); } catch (error) {
    return { exitCode: 5, message: error instanceof Error ? error.message : String(error) };
  }
  let risk = assessReviewRisk(context);
  const remote = () => options.remote?.(context, context.baseContract)
    ?? evaluateReviewRemoteState({ context, contract: context.baseContract, client });
  const makeBinding = () => binding({
    context,
    risk,
    codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
    runner: options.runner,
    model,
    runnerVersion,
  });

  let probe: RunnerIsolationProbe;
  try {
    probe = await (options.probe ?? probeRunnerIsolation)({
      runner: options.runner,
      model,
      runnerVersion,
      timeoutMs: Math.min(options.timeoutMs ?? 30 * 60_000, 5 * 60_000),
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
    const requiredAxes: ReviewAxis[] = risk.triggered
      ? ['spec', 'engineering', 'deep']
      : ['spec', 'engineering'];
    const axes: ReviewAxisResult[] = requiredAxes.map((axis) => ({
      axis, status: 'unverifiable', requestDeepReview: false, summary,
      findings: [], durationMs: probe.durationMs, attempts: 1,
    }));
    const state = makeState({
      status: 'unverifiable', deliveryStatus: 'unverifiable', binding: makeBinding(), risk,
      axes, remote: remote(), round, shadow: options.shadow ?? false, startedAt,
    });
    writeFinalReviewState(options.workspace, state);
    return stateOutcome(state);
  }

  const axes: ReviewAxisResult[] = [];
  const axisRunner = options.axisRunner ?? runSafeReviewAxis;
  const runAxis = async (axis: ReviewAxis): Promise<void> => {
    let reviewPackage: ReturnType<typeof createReviewPackage> | null = null;
    try {
      reviewPackage = createReviewPackage({
        context, risk, axis, runner: options.runner, model,
      });
      const invocation = await axisRunner({
        runner: options.runner,
        model,
        runnerVersion,
        axis,
        reviewPackage,
        timeoutMs: options.timeoutMs ?? 30 * 60_000,
      });
      const output = invocation.output;
      axes.push({
        axis,
        status: output.status,
        summary: output.unverifiableReason
          ? `${output.summary}（不可验证：${output.unverifiableReason}）`
          : output.summary,
        findings: engineFindings({ output, axis, context, round }),
        requestDeepReview: output.requestDeepReview,
        durationMs: invocation.durationMs,
        attempts: invocation.attempts,
      });
    } catch (error) {
      axes.push({
        axis,
        status: 'unverifiable',
        summary: error instanceof Error ? error.message : String(error),
        findings: [], requestDeepReview: false, durationMs: 0, attempts: reviewPackage ? 2 : 0,
      });
    } finally {
      reviewPackage?.cleanup();
    }
  };

  await runAxis('spec');
  await runAxis('engineering');
  if (axes.some((axis) => axis.requestDeepReview)) risk = reviewerEscalatedRisk(risk);
  if (risk.triggered) await runAxis('deep');

  const revalidated = options.revalidate?.()
    ?? (options.preflight ? { ok: true as const } : revalidateReviewContext(context, client));
  if (!revalidated.ok) {
    return { exitCode: 5, message: `${revalidated.message}；本轮 Review 已作废，请重新运行 coding-x` };
  }
  if (options.runnerVersion === undefined) {
    try {
      const currentRunnerVersion = readRunnerVersion(options.runner);
      if (currentRunnerVersion !== runnerVersion) {
        return { exitCode: 5, message: '评审期间 Runner 版本发生变化；本轮 Review 已作废' };
      }
    } catch (error) {
      return {
        exitCode: 5,
        message: `无法在评审结束时重新核对 Runner 版本：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }

  const allFindings = axes.flatMap((axis) => axis.findings);
  const resolution = unresolvedBlockingFindings({
    findings: allFindings,
    decisions: decisions.decisions,
    headSha: context.headSha,
    contract: context.baseContract,
    client,
  });
  const anyUnverifiable = axes.some((axis) => axis.status === 'unverifiable')
    || resolution.decisionErrors.length > 0;
  const status = anyUnverifiable ? 'unverifiable'
    : resolution.unresolved.length > 0 ? 'failed' : 'passed';
  if (resolution.decisionErrors.length > 0) {
    const engineering = axes.find((axis) => axis.axis === 'engineering');
    if (engineering) {
      engineering.status = 'unverifiable';
      engineering.summary = `${engineering.summary}；裁决记录无法验证：${resolution.decisionErrors.join('；')}`;
    }
  }
  const remoteState = remote();
  const shadow = options.shadow ?? false;
  const deliveryStatus = status === 'unverifiable' ? 'unverifiable'
    : status === 'failed' ? 'findings'
      : shadow ? 'shadow'
        : remoteState.status !== 'ready' ? 'remote-pending' : 'ready';
  const state = makeState({
    status,
    deliveryStatus,
    binding: makeBinding(),
    risk,
    axes,
    remote: remoteState,
    round,
    shadow,
    startedAt,
  });
  writeFinalReviewState(options.workspace, state);
  return stateOutcome(state);
}
