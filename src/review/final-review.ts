import { runContractQualityChecks, type ContractGateResult } from '../engine/gate.js';
import type { AgentKind } from '../engine/agent.js';
import { writeFileAtomicSync } from '../engine/fs-atomic.js';
import { readSafeControlFileUtf8Sync } from '../engine/safe-control-file.js';
import { STATE_CONTROL_FILE_MAX_BYTES } from '../engine/state.js';
import { CODING_X_VERSION } from '../version.js';
import { GhGitHubQualityClient, type GitHubQualityClient } from '../quality/github.js';
import type { QualityContract } from '../quality/contract.js';
import { realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { removeRegisteredWorkspaceFileSync } from '../engine/workspace-identity.js';
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
import { applyReviewerDeepReviewRequest, assessReviewRisk } from './risk.js';
import { REVIEW_RULES_DIGEST } from './rules.js';
import {
  RUNNER_TOOL_POLICY_VERSION,
  freezeReviewRunner,
  probeRunnerIsolation,
  revalidateFrozenReviewRunner,
  runSafeReviewAxis,
  type FrozenReviewRunner,
  type RunnerIsolationProbe,
  type SafeRunnerInvocation,
} from './runner.js';
import {
  invalidateFinalReviewState,
  FINAL_REVIEW_CONTROL_FILE_MAX_BYTES,
  readFinalReviewState,
  reviewDecisionsSnapshotIsValid,
  restoreReviewDecisionsSnapshot,
  writeFinalReviewState,
} from './state.js';
import {
  REVIEW_RULES_VERSION,
  REVIEW_STATE_FILE,
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
  type ReviewDecisionsSnapshot,
  type StoryValidationCheck,
} from './types.js';

type AxisRunner = (options: {
  runner: AgentKind;
  model: string;
  runnerVersion: string;
  frozenRunner?: FrozenReviewRunner;
  axis: ReviewAxis;
  reviewPackage: ReturnType<typeof createReviewPackage>;
  timeoutMs: number;
}) => Promise<SafeRunnerInvocation>;

interface WorkspaceFileSnapshot {
  path: string;
  raw: string | null;
}

function snapshotWorkspaceFile(path: string): WorkspaceFileSnapshot {
  return {
    path,
    raw: readSafeControlFileUtf8Sync(path, {
      maxBytes: path.endsWith(REVIEW_STATE_FILE)
        ? FINAL_REVIEW_CONTROL_FILE_MAX_BYTES
        : STATE_CONTROL_FILE_MAX_BYTES,
      allowMissing: true,
    }),
  };
}

function restoreWorkspaceFile(snapshot: WorkspaceFileSnapshot): boolean {
  let current: string | null;
  let unsafe = false;
  try {
    current = readSafeControlFileUtf8Sync(snapshot.path, {
      maxBytes: snapshot.path.endsWith(REVIEW_STATE_FILE)
        ? FINAL_REVIEW_CONTROL_FILE_MAX_BYTES
        : STATE_CONTROL_FILE_MAX_BYTES,
      allowMissing: true,
    });
  } catch {
    current = null;
    unsafe = true;
  }
  if (!unsafe && current === snapshot.raw) return false;
  if (snapshot.raw === null) removeRegisteredWorkspaceFileSync(snapshot.path, true);
  else writeFileAtomicSync(snapshot.path, snapshot.raw);
  return true;
}

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
  storyValidationDigest: string;
  reviewDecisionsDigest: string;
  reviewRoutingDigest: string;
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
    storyValidationDigest: options.storyValidationDigest,
    reviewDecisionsDigest: options.reviewDecisionsDigest,
    reviewRoutingDigest: options.reviewRoutingDigest,
    codingXVersion: options.codingXVersion,
    runner: options.runner,
    model: options.model,
    runnerVersion: options.runnerVersion,
    reviewRulesVersion: REVIEW_RULES_VERSION,
    reviewRulesDigest: REVIEW_RULES_DIGEST,
    riskDigest: options.risk.digest,
  };
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
  /** 已在 coding-x 启动、任何项目代码运行前冻结的正式 Reviewer 身份。 */
  frozenRunner?: FrozenReviewRunner;
  /** 只作为冻结版本的附加断言；绝不单独建立 Runner 信任。 */
  runnerVersion?: string;
  /**
   * 仅供不启动真实模型的单元测试。使用它时必须同时注入 probe、axisRunner 和
   * runnerVersion；生产调用不得设置。
   */
  unsafeSkipReviewerExecutableFreezeForTests?: true;
  remote?: (context: ReviewPreflightContext, contract: QualityContract) => ReviewRemoteState;
  revalidate?: () => ReviewContextRevalidation;
  /** loop 提供的 Story Validator 凭证当前性机械核对；模型调用前后都必须成功。 */
  validateStoryReceipts?: () => StoryValidationCheck;
  /** coding-x 启动、任何不可信项目代码运行前冻结的人工裁决输入。 */
  reviewDecisions: ReviewDecisionsSnapshot;
  /** 启动时冻结 PRD models 的确定性摘要；不包含 CLI 临时覆盖。 */
  reviewRoutingDigest: string;
  /** loop 在失效旧结果前计算；直接调用缺省从当前状态递增。 */
  reviewRound?: number;
}): Promise<FinalReviewOutcome> {
  const startedAt = new Date().toISOString();
  if (!reviewDecisionsSnapshotIsValid(options.reviewDecisions)) {
    return { exitCode: 5, message: '冻结的 Review 裁决快照自身不一致，本轮无法验证' };
  }
  if (!/^sha256:[a-f0-9]{64}$/.test(options.reviewRoutingDigest)) {
    return { exitCode: 5, message: '最终 Review 缺少有效的 PRD 模型路由摘要，本轮无法验证' };
  }
  if (!options.model?.trim()) {
    return {
      exitCode: 5,
      message:
        '最终 Review 必须使用明确模型；请在 PRD models.validator 中固定，或传 --review-model',
    };
  }
  const model = options.model.trim();
  const skipRunnerFreezeForTest = options.unsafeSkipReviewerExecutableFreezeForTests === true;
  let frozenRunner: FrozenReviewRunner | undefined;
  let runnerVersion: string;
  if (skipRunnerFreezeForTest) {
    if (!options.probe || !options.axisRunner || !options.runnerVersion?.trim()) {
      return {
        exitCode: 5,
        message: '测试专用 Runner 冻结绕过必须同时注入 probe、axisRunner 和明确 runnerVersion',
      };
    }
    runnerVersion = options.runnerVersion.trim();
  } else {
    try {
      const canonicalProjectRoot = realpathSync.native(resolve(options.root));
      frozenRunner =
        options.frozenRunner ??
        freezeReviewRunner(options.runner, { projectRoot: canonicalProjectRoot });
      if (frozenRunner.runner !== options.runner) {
        return {
          exitCode: 5,
          message: `冻结的 Reviewer 类型错配：期望 ${options.runner}，收到 ${frozenRunner.runner}`,
        };
      }
      if (frozenRunner.excludedProjectRoot !== canonicalProjectRoot) {
        return {
          exitCode: 5,
          message: '冻结的 Reviewer 未绑定当前项目根；拒绝复用不完整的信任快照',
        };
      }
      const initial = revalidateFrozenReviewRunner(frozenRunner);
      if (!initial.ok) {
        return {
          exitCode: 5,
          message: `冻结的 Reviewer 启动时已失效：${initial.errors.join('；')}`,
        };
      }
      if (options.runnerVersion !== undefined && options.runnerVersion !== frozenRunner.version) {
        return {
          exitCode: 5,
          message:
            `Runner 版本断言与冻结身份不一致：期望 ${frozenRunner.version}，` +
            `收到 ${options.runnerVersion}`,
        };
      }
      runnerVersion = frozenRunner.version;
    } catch (error) {
      return {
        exitCode: 5,
        message: `无法冻结正式 Reviewer：${error instanceof Error ? error.message : String(error)}`,
      };
    }
  }
  const revalidateFrozenRunner = (phase: string): string | null => {
    if (!frozenRunner) return null;
    const result = revalidateFrozenReviewRunner(frozenRunner);
    return result.ok
      ? null
      : `${phase}冻结的 Reviewer 已失效：${result.errors.join('；')}；本轮无法验证`;
  };
  const client = options.client ?? new GhGitHubQualityClient();
  const preflight =
    options.preflight?.() ??
    runReviewPreflight({
      root: options.root,
      workspace: options.workspace,
      currentContract: options.currentContract,
      client,
    });
  if (preflight.status !== 'ready') {
    const exitCode =
      preflight.status === 'config-error' ? 2 : preflight.status === 'remote-not-ready' ? 6 : 5;
    return { exitCode, message: preflight.message };
  }
  const context = preflight.context;
  const round = options.reviewRound ?? initialRound(options.workspace);
  if (!Number.isInteger(round) || round < 1) {
    return { exitCode: 5, message: '最终 Review 轮次无效，本轮无法验证' };
  }
  // 先使旧结果失效，再进入本轮任何可失败环节。否则同一 head 上的机械
  // 检查回归、裁决文件损坏或 Runner 中断可能让 status 继续读到旧的绿色结果。
  invalidateFinalReviewState(options.workspace);
  const entryDecisions = restoreReviewDecisionsSnapshot(options.workspace, options.reviewDecisions);
  if (entryDecisions.changed) {
    return {
      exitCode: 5,
      message: 'Review 裁决记录在本轮启动后发生变化；已恢复冻结快照，本轮无法验证',
    };
  }
  const decisions = options.reviewDecisions.value;

  const restoreFrozenDecisions = (phase: string): string | null => {
    const restored = restoreReviewDecisionsSnapshot(options.workspace, options.reviewDecisions);
    return restored.changed
      ? `${phase} Review 裁决记录发生变化；已恢复冻结快照，本轮无法验证`
      : null;
  };

  // Story 凭证基线必须建立在任何项目命令执行之前。机械检查即使
  // 返回 0，也不得借机伪造一份新凭证再进入模型评审。
  const validateStoryReceipts = options.validateStoryReceipts;
  if (!validateStoryReceipts) {
    return { exitCode: 5, message: '最终 Review 缺少 Story Validator 凭证核对，无法验证' };
  }
  const validationBefore = validateStoryReceipts();
  if (!validationBefore.ok) {
    return {
      exitCode: 5,
      message: `最终 Review 前 Story Validator 凭证无效：${validationBefore.message}`,
    };
  }
  const guardedWorkspaceFiles = [
    snapshotWorkspaceFile(join(options.workspace, 'state.json')),
    snapshotWorkspaceFile(join(options.workspace, REVIEW_STATE_FILE)),
  ];
  const restoreGuardedWorkspace = (phase: string): string | null => {
    const changed = guardedWorkspaceFiles
      .filter((snapshot) => restoreWorkspaceFile(snapshot))
      .map((snapshot) =>
        snapshot.path.endsWith(REVIEW_STATE_FILE) ? REVIEW_STATE_FILE : 'state.json',
      );
    return changed.length > 0
      ? `${phase}修改了引擎独占状态 ${changed.join('、')}；已恢复冻结快照，本轮无法验证`
      : null;
  };
  const revalidateBoundContext = (): ReviewContextRevalidation =>
    options.revalidate?.() ??
    (options.preflight ? { ok: true as const } : revalidateReviewContext(context, client));
  const revalidateBoundStoryReceipts = (
    phase: '最终机械检查后' | '评审期间' | '写入最终结果前' | '最终结果写入后',
  ): { ok: true } | { ok: false; message: string } => {
    const validation = validateStoryReceipts();
    if (!validation.ok) {
      return { ok: false, message: `${phase} Story Validator 凭证失效：${validation.message}` };
    }
    if (validation.digest !== validationBefore.digest) {
      return {
        ok: false,
        message: `${phase} Story Validator 凭证身份发生变化；本轮 Review 已作废`,
      };
    }
    return { ok: true };
  };

  const persistAndVerifyState = (
    state: FinalReviewState,
    staleMessage: string,
  ): FinalReviewOutcome => {
    try {
      writeFinalReviewState(options.workspace, state);
      const decisionsAfterWrite = restoreFrozenDecisions('写入最终结果后');
      if (decisionsAfterWrite) throw new Error(decisionsAfterWrite);
      const persistedContext = revalidateBoundContext();
      if (!persistedContext.ok) throw new Error(`${persistedContext.message}；${staleMessage}`);
      const persistedValidation = revalidateBoundStoryReceipts('最终结果写入后');
      if (!persistedValidation.ok) throw new Error(persistedValidation.message);
      const persisted = readFinalReviewState(options.workspace);
      if (persisted.status !== 'ready' || digest(persisted.state) !== digest(state)) {
        throw new Error('最终结果写入后发生变化');
      }
      const runnerAfterWrite = revalidateFrozenRunner('最终结果写入后');
      if (runnerAfterWrite) throw new Error(runnerAfterWrite);
      const decisionsBeforeReturn = restoreFrozenDecisions('最终结果返回前');
      if (decisionsBeforeReturn) throw new Error(decisionsBeforeReturn);
      const runnerBeforeReturn = revalidateFrozenRunner('最终结果返回前');
      if (runnerBeforeReturn) throw new Error(runnerBeforeReturn);
      return stateOutcome(state);
    } catch (error) {
      invalidateFinalReviewState(options.workspace);
      return {
        exitCode: 5,
        message:
          `最终结果写入或复核失败：${error instanceof Error ? error.message : String(error)}` +
          '；刚写入的结果已删除',
      };
    }
  };

  const runnerBeforeGate = revalidateFrozenRunner('最终机械检查前');
  if (runnerBeforeGate) return { exitCode: 5, message: runnerBeforeGate };
  let gateDecisionTamper: string | null = null;
  let gateWorkspaceTamper: string | null = null;
  let gateRunnerTamper: string | null = null;
  const gate = await (
    options.gate
      ? options.gate(context.baseContract, context.root)
      : runContractQualityChecks(context.baseContract.checks, context.root)
  ).finally(() => {
    gateWorkspaceTamper = restoreGuardedWorkspace('最终 Review 机械检查期间');
    gateDecisionTamper = restoreFrozenDecisions('最终 Review 机械检查期间');
    gateRunnerTamper = revalidateFrozenRunner('最终机械检查后');
  });
  if (gateWorkspaceTamper) return { exitCode: 5, message: gateWorkspaceTamper };
  if (gateDecisionTamper) return { exitCode: 5, message: gateDecisionTamper };
  if (gateRunnerTamper) return { exitCode: 5, message: gateRunnerTamper };
  if (!gate.ok) {
    const failure = gate.failure;
    return {
      exitCode: 1,
      message:
        `最终 Review 前机械检查失败：${failure?.command ?? 'unknown'}` +
        `${failure?.timedOut ? '（超时）' : failure?.exitCode !== null && failure?.exitCode !== undefined ? `（退出码 ${failure.exitCode}）` : ''}`,
    };
  }
  const postGateContext = revalidateBoundContext();
  if (!postGateContext.ok) {
    return {
      exitCode: 5,
      message: `${postGateContext.message}；最终机械检查后本轮 Review 无法验证`,
    };
  }
  const postGateValidation = revalidateBoundStoryReceipts('最终机械检查后');
  if (!postGateValidation.ok) return { exitCode: 5, message: postGateValidation.message };
  const mechanicalEvidence = {
    status: 'passed' as const,
    headSha: context.headSha,
    qualityContractDigest: context.baseContractDigest,
    scope: 'all-current-platform-applicable-contract-checks' as const,
  };

  let risk = assessReviewRisk(context);
  const remote = () =>
    options.remote?.(context, context.baseContract) ??
    evaluateReviewRemoteState({ context, contract: context.baseContract, client });
  const makeBinding = () =>
    binding({
      context,
      risk,
      codingXVersion: options.codingXVersion ?? CODING_X_VERSION,
      runner: options.runner,
      model,
      runnerVersion,
      storyValidationDigest: validationBefore.digest,
      reviewDecisionsDigest: options.reviewDecisions.digest,
      reviewRoutingDigest: options.reviewRoutingDigest,
    });

  let probe: RunnerIsolationProbe;
  try {
    probe = await (options.probe ?? probeRunnerIsolation)({
      runner: options.runner,
      model,
      runnerVersion,
      ...(frozenRunner ? { frozenRunner } : {}),
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
  const probeRunnerTamper = revalidateFrozenRunner('Runner 隔离反测后');
  if (probeRunnerTamper) return { exitCode: 5, message: probeRunnerTamper };
  const probeWorkspaceTamper = restoreGuardedWorkspace('Runner 隔离反测期间');
  if (probeWorkspaceTamper) return { exitCode: 5, message: probeWorkspaceTamper };
  if (!probe.ok) {
    const summary = `Runner 隔离反测未通过：${probe.failures.join('；')}`;
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
    const remoteState = remote();
    const remoteWorkspaceTamper = restoreGuardedWorkspace('隔离失败后的远端查询期间');
    if (remoteWorkspaceTamper) return { exitCode: 5, message: remoteWorkspaceTamper };
    const finalContext = revalidateBoundContext();
    if (!finalContext.ok) {
      return {
        exitCode: 5,
        message: `${finalContext.message}；隔离失败结果写入前已失效`,
      };
    }
    const finalValidation = revalidateBoundStoryReceipts('写入最终结果前');
    if (!finalValidation.ok) return { exitCode: 5, message: finalValidation.message };
    const runnerAfterRemote = revalidateFrozenRunner('隔离失败后的远端查询后');
    if (runnerAfterRemote) return { exitCode: 5, message: runnerAfterRemote };
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
    const beforeWrite = restoreFrozenDecisions('写入最终结果前');
    if (beforeWrite) return { exitCode: 5, message: beforeWrite };
    const beforeWriteWorkspace = restoreGuardedWorkspace('写入最终结果前');
    if (beforeWriteWorkspace) return { exitCode: 5, message: beforeWriteWorkspace };
    const runnerBeforeWrite = revalidateFrozenRunner('写入最终结果前');
    if (runnerBeforeWrite) return { exitCode: 5, message: runnerBeforeWrite };
    return persistAndVerifyState(state, '隔离失败结果写入后已失效');
  }

  const axes: ReviewAxisResult[] = [];
  const axisRunner = options.axisRunner ?? runSafeReviewAxis;
  let axisRunnerTamper: string | null = null;
  const runAxis = async (axis: ReviewAxis): Promise<void> => {
    let reviewPackage: ReturnType<typeof createReviewPackage> | null = null;
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
        runner: options.runner,
        model,
        runnerVersion,
        ...(frozenRunner ? { frozenRunner } : {}),
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
        findings: [],
        requestDeepReview: false,
        durationMs: 0,
        attempts: reviewPackage ? 2 : 0,
      });
    } finally {
      reviewPackage?.cleanup();
      axisRunnerTamper ??= revalidateFrozenRunner(`${axis} Review 后`);
    }
  };

  await runAxis('spec');
  if (axisRunnerTamper) return { exitCode: 5, message: axisRunnerTamper };
  await runAxis('engineering');
  if (axisRunnerTamper) return { exitCode: 5, message: axisRunnerTamper };
  risk = applyReviewerDeepReviewRequest(
    risk,
    axes.some((axis) => axis.axis !== 'deep' && axis.requestDeepReview),
  );
  if (risk.triggered) {
    await runAxis('deep');
    if (axisRunnerTamper) return { exitCode: 5, message: axisRunnerTamper };
  }

  const axisWorkspaceTamper = restoreGuardedWorkspace('模型评审期间');
  if (axisWorkspaceTamper) return { exitCode: 5, message: axisWorkspaceTamper };

  const revalidated = revalidateBoundContext();
  if (!revalidated.ok) {
    return {
      exitCode: 5,
      message: `${revalidated.message}；本轮 Review 已作废，请重新运行 coding-x`,
    };
  }
  const validationAfter = revalidateBoundStoryReceipts('评审期间');
  if (!validationAfter.ok) return { exitCode: 5, message: validationAfter.message };
  const runnerAfterAxes = revalidateFrozenRunner('模型评审后');
  if (runnerAfterAxes) return { exitCode: 5, message: runnerAfterAxes };

  const allFindings = axes.flatMap((axis) => axis.findings);
  const resolution = unresolvedBlockingFindings({
    findings: allFindings,
    decisions: decisions.decisions,
    headSha: context.headSha,
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
  const remoteState = remote();
  const remoteWorkspaceTamper = restoreGuardedWorkspace('裁决与远端查询期间');
  if (remoteWorkspaceTamper) return { exitCode: 5, message: remoteWorkspaceTamper };
  // finding 裁决和远端状态查询都可能耗时；它们结束后必须再次核对易变身份。
  // 否则 PR/HEAD/Story 凭证恰好在最后一次查询期间变化，旧结果仍会被写成绿色。
  const finalContext = revalidateBoundContext();
  if (!finalContext.ok) {
    return {
      exitCode: 5,
      message: `${finalContext.message}；写入最终结果前本轮 Review 已作废，请重新运行 coding-x`,
    };
  }
  const finalValidation = revalidateBoundStoryReceipts('写入最终结果前');
  if (!finalValidation.ok) return { exitCode: 5, message: finalValidation.message };
  const runnerBeforeState = revalidateFrozenRunner('写入最终结果前');
  if (runnerBeforeState) return { exitCode: 5, message: runnerBeforeState };
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
    binding: makeBinding(),
    risk,
    axes,
    remote: remoteState,
    round,
    shadow,
    startedAt,
  });
  const beforeWrite = restoreFrozenDecisions('写入最终结果前');
  if (beforeWrite) return { exitCode: 5, message: beforeWrite };
  const beforeWriteWorkspace = restoreGuardedWorkspace('写入最终结果前');
  if (beforeWriteWorkspace) return { exitCode: 5, message: beforeWriteWorkspace };
  // 持久写入不是身份核对的一部分。写入完成后再读一次全部易变来源；任何异常、
  // 身份变化或回调抛错都会删除刚写入的权威 JSON，绝不能留下旧绿色结果。
  return persistAndVerifyState(state, '最终结果写入后已失效，请重新运行 coding-x');
}
