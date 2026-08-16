import { randomUUID } from 'node:crypto';
import type { Writable } from 'node:stream';
import { join, basename } from 'node:path';
import { runAgent, type AgentKind, type RunResult } from './agent.js';
import { type Prd } from './prd.js';
import type { PrdReadResult } from './prd-guard.js';
import {
  blankStateFor,
  tryReadState,
  selectNextStory,
  allStoriesResolvedAt,
  bindStoryValidationBase,
  enableEscalation,
  restoreEscalated,
  restoreValidationOwnership,
  validationOwnershipOf,
  issueValidationReceipt,
  markValidatorUnverifiable,
  reconcileValidationReceipts,
  rollbackUnvalidatedPass,
  tryReadEngineOwnedFields,
  INITIAL_STORY_STATE,
  type RunState,
  type ValidationRunnerBinding,
} from './state.js';
import {
  runQualityChecks,
  runContractQualityChecks,
  readQualityChecks,
  applyGateFailure,
  applyAbortRollback,
  classifyValidationOnlyGateFailure,
  abortDesc,
  applyValidatorFailure,
  applyValidatorSuccess,
} from './gate.js';
import { resolveBuilderModel, resolveValidatorModel } from './models.js';
import type { ModelCatalogResult } from './model-catalog.js';
import * as dashboard from '../dashboard/server.js';
import { writeReportWithWriter, type ReportOptions } from '../report/report.js';
import {
  appendEvidenceWithWriter,
  clipEvidenceDiagnostic,
  type EvidenceRecord,
  type AgentInvocationEvidence,
  type LoopValidationProtocolErrorCode,
  type ValidationHeadAbortEvidence,
  type ValidationHeadAbortPhase,
  type ValidationTargetEvidence,
  type ValidatorProfileEvidence,
} from './evidence.js';
import {
  establishValidatorHostIsolation,
  type ValidatorCanaryProvider,
  type ValidatorHostIsolationOutcome,
} from './validator-host-isolation.js';
import { runValidatorCanary } from './validator-canary.js';
import {
  validatorCanaryEvidenceDigest,
  VALIDATOR_RUNNER_PROFILE_POLICY_VERSION,
} from './validator-runner-profile.js';
import type { ValidatorRunnerObservation } from './validator-runner-observation.js';
import {
  clearValidationResultWithWriter,
  acceptanceHash,
  createValidationRequest,
  readGitHead,
  readValidationResult,
  renderValidatorInstruction,
  type ValidationRequest,
} from './validation-protocol.js';
import { classifyValidationOnlyTddFailure, runTddGate } from './tdd-gate.js';
import {
  qualityChecksMatchContract,
  type QualityContract,
  type QualityContractReadResult,
} from '../quality/contract.js';
import { CODING_X_VERSION } from '../version.js';
import { runFinalReview, type StoryValidationBindingObservation } from '../review/final-review.js';
import { invalidateFinalReviewState } from '../review/state.js';
import type { FinalReviewOutcome } from '../review/types.js';
import type { CurrentReviewStatus } from '../review/status.js';
import { readTrackedQualityContractAtHead, runLoopPreflight } from './loop-preflight.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession, type WorkspaceSession } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { readStableFile } from '../workspace-safety/stable-file.js';
import {
  installCommandSignals,
  type CommandSignalController,
} from '../workspace-safety/command-signals.js';
import type { SupervisorTerminationReason } from '../workspace-safety/supervisor-protocol.js';
import {
  CleanValidationCheckoutError,
  CleanValidationCheckoutManager,
  STORY_CHANGE_MANIFEST_VERSION,
  describeCleanValidationCheckoutCleanup,
  valueReferencesProjectPath,
  type CleanValidationCheckout,
  type StoryChangeManifest,
} from './clean-validation-checkout.js';
import {
  bindStoryValidationRuntimeIdentity,
  candidateStoryValidationEnvironmentPolicy,
  digestCandidateStoryValidationEnvironment,
} from './story-validation-currentness.js';
import {
  observeStoryValidationCurrentness,
  type StoryValidationObservation,
} from '../review/story-validation-observation.js';
import { classifyValidatorAttempt } from './validator-outcome.js';
import type { VerifiedCandidateIdentity } from '../release/candidate-identity.js';
import {
  CANDIDATE_PROOF_FILE,
  createCandidateDogfoodProof,
} from '../release/candidate-proof.js';
import {
  createFullGateProof,
  engineQualityGateEvidence,
  type FullGateProof,
} from './full-gate-proof.js';

export { renderInstruction } from './loop-instructions.js';

export interface LoopConfig {
  kind: AgentKind;
  /** CLI 位置参数是否显式指定 kind；直接 API 调用缺省视为显式。 */
  kindExplicit?: boolean;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  /** 临时覆盖 builder 阶段模型（压过 prd.json models 与升级链） */
  builderModel?: string;
  /** 临时覆盖 validator 阶段模型（压过 prd.json models.validator） */
  validatorModel?: string;
  /** 临时固定最终三层 Review 模型；缺省复用 models.validator。 */
  reviewModel?: string;
  /** 临时覆盖升级 builder 模型；只在 state.escalated=true 时生效。 */
  escalationModel?: string;
  /** 测试注入；生产缺省只读全局模型目录。 */
  modelCatalog?: (runner: AgentKind) => ModelCatalogResult | Promise<ModelCatalogResult>;
  workspace: string;
  instructionsDir: string;
  port?: number;
  openBrowser?: boolean;
  /** 运行结束后保留仪表盘直到 interrupt（默认 Ctrl+C）；退出码仍是循环的真实结果 */
  keepOpen?: boolean;
  /** keepOpen 的放行信号，默认等待 SIGINT；测试注入用 */
  interrupt?: Promise<void>;
  /** 连续无进展轮（no-op/超时/异常退出）熔断上限；缺省 3 */
  stallLimit?: number;
  /** 候选版本 Dogfood；只有原本成功的收敛出口改为 7，失败码保持原义。 */
  shadow?: boolean;
  /** 实际运行版本；生产由 CLI 注入，API 缺省使用构建内常量。 */
  actualVersion?: string;
  /** 已逐文件核对的候选包身份；只有 shadow Dogfood 可以绑定。 */
  candidateIdentity?: VerifiedCandidateIdentity;
  /** 项目根；生产缺省当前目录，测试/嵌入环境可显式指定。 */
  projectRoot?: string;
  /** 只供隔离测试注入；生产始终读取项目根 .coding-x/quality.json。 */
  qualityContractReader?: (projectRoot: string) => QualityContractReadResult;
  /** @internal 只供测试固定本地 origin 默认分支提交；生产由受管 Git 读取。 */
  defaultBranchGitHeadForTests?: string;
  /** @internal 跳过真实干净检出的测试必须显式提供等价变化摘要。 */
  storyChangeManifestForTests?: (
    storyBaseGitHead: string,
    gitHead: string,
  ) => Pick<StoryChangeManifest, 'digest' | 'changedPathCount'>;
  /** 测试/嵌入注入；生产缺省执行真实本地三层 Review。 */
  finalReviewRunner?: (options: {
    root: string;
    workspace: string;
    session: WorkspaceSession;
    currentContract: QualityContract;
    runner: AgentKind;
    model?: string;
    codingXVersion: string;
    shadow: boolean;
    timeoutMs: number;
    storyValidationDigest: string;
    reusableFullGate?: FullGateProof;
    observeStoryValidation: () =>
      StoryValidationBindingObservation | Promise<StoryValidationBindingObservation>;
    termination?: {
      signal: AbortSignal;
      reason: Exclude<SupervisorTerminationReason, 'timeout' | 'output-failure'>;
    };
  }) => Promise<FinalReviewOutcome>;
  /** 只供提交身份竞态测试：在 Validator request 读取 HEAD 的最后边界同步执行。 */
  beforeValidatorRequestForTests?: (validationRoot: string) => void;
  /** 只供清理失败回归：在通过结果签发 receipt 前、验证检出清理前同步执行。 */
  beforeValidationCheckoutCleanupForTests?: (root: string) => void;
  /** 只供提交身份竞态测试：验证检出已收口、Validator claim 尚未写入状态时执行。 */
  afterValidationCheckoutSettlementForTests?: () => void | Promise<void>;
  /** 只供提交身份竞态测试：Validator claim 已写状态、引擎尚未完成最终 HEAD 复核时执行。 */
  afterValidatorClaimStateWriteForTests?: () => void | Promise<void>;
  /** 只供提交身份竞态测试：不可验证标记首次写入、引擎尚未完成 HEAD 复核时执行。 */
  afterValidatorUnverifiableStateWriteForTests?: () => void | Promise<void>;
  /** 只供 Validator 输出故障闭环测试；生产始终使用进程 stdout/stderr。 */
  validatorOutputForTests?: { readonly stdout: Writable; readonly stderr: Writable };
  /** 只供 Builder 输出故障闭环测试；生产始终使用进程 stdout/stderr。 */
  builderOutputForTests?: { readonly stdout: Writable; readonly stderr: Writable };
  /** @internal 隔离单次测试使用的假 Runner 环境，避免修改进程级环境后因超时串扰后续用例。 */
  runnerEnvironmentForTests?: Readonly<NodeJS.ProcessEnv>;
  /** 只供 session release 信号竞态测试；生产始终安装真实进程信号。 */
  commandSignalsForTests?: CommandSignalController;
  /** 只供 session release 信号竞态测试：close 已进入 closing、尚未 await 时执行。 */
  afterSessionCloseStartedForTests?: () => void | Promise<void>;
  /** @internal 历史状态机测试保留原 cwd；生产 CLI 永不设置。 */
  unsafeUseProjectRootForValidationTests?: boolean;
  /** @internal 允许测试 fake Runner 位于项目 workspace；生产拒绝这类覆盖。 */
  unsafeAllowProjectScopedRunnerForValidationTests?: boolean;
  /** @internal 历史 receipt fixture 的机械环境摘要；实际版本与模式仍由引擎强制绑定。 */
  validationEnvironmentDigestForTests?: string;
  /**
   * @internal 历史 fixture 的 Runner 宿主隔离绑定（ADR-025）：设置时跳过真实 profile/canary
   * 链并以该绑定签发凭证；生产由真实链提供，缺失时凭证签发失败关闭。
   */
  validatorRunnerBindingForTests?: ValidationRunnerBinding;
  /** @internal 测试注入 Runner 机械观察；生产始终受监督探测真实可执行文件。 */
  validatorRunnerObservationForTests?: ValidatorRunnerObservation;
  /** @internal 测试注入 canary 证据提供器；生产由引擎 canary 执行器提供。 */
  validatorCanaryForTests?: ValidatorCanaryProvider;
  /**
   * 仅供历史单测 fixture：允许旧 Validator 直接改 state。CLI 从不设置；生产默认
   * 必须提交结构化 validation result，禁止静默降级。
   */
  legacyValidatorProtocolForTests?: boolean;
}

function waitForSigint(): Promise<void> {
  return new Promise((resolve) => process.once('SIGINT', () => resolve()));
}

// 运行期读取执行状态；缺失/损坏时按全部未开始处理（绝不覆盖原文件，交给 repair）。
function readRunState(statePath: string, prd: Prd): RunState {
  const state = tryReadState(statePath);
  if (state) return state;
  console.warn(
    '⚠️  state.json 缺失或不可读，本轮按全部 story 未开始处理；若文件损坏请运行 npx coding-x repair',
  );
  return blankStateFor(prd);
}

// 收敛出口单源：两个 allStoriesResolved 出口（no-op 快路径/轮末完成判定）共用，
// blocked>0 时 exit 3——「收敛但待人工」对所有出口成立（ADR-009/发现 D）
const blockedConvergedExit = (prd: Prd, state: RunState): number | null => {
  const blockedIds = prd.userStories.filter((s) => state[s.id]?.blocked).map((s) => s.id);
  if (blockedIds.length > 0) {
    const passedCount = prd.userStories.length - blockedIds.length;
    console.log(
      `\n⏸️  ${passedCount} 个 story 通过，${blockedIds.length} 个 blocked 待人工处理（${blockedIds.join(', ')}）。处理后重跑引擎收敛剩余项；人审入口见 .workspace/report.html 与 state.json notes。`,
    );
    return 3;
  }
  return null;
};

// validation-only 启动预检不会解析 Builder 路由。它若明确失败并清除候选，本次运行
// 必须先停止；下次启动重新预检后才能进入 Developer，不能在同一进程里越过模型预检。
const validationOnlyFailureExit = (
  prd: Prd | null,
  state: RunState | null,
  currentGitHead: string | null,
  currentValidationEnvironmentDigest: string,
): number => {
  if (
    !prd ||
    !state ||
    !currentGitHead ||
    !allStoriesResolvedAt(prd, state, currentGitHead, currentValidationEnvironmentDigest)
  ) {
    return 1;
  }
  return blockedConvergedExit(prd, state) ?? 1;
};

const validationOnlyRecoveryMessage = (storyId: string | null, state: RunState | null): string =>
  state && storyId && state[storyId]?.blocked
    ? '已达到重试上限，需先人工处理'
    : '本次运行停止，下次启动重新预检后才会进入 Developer';

export async function runLoop(cfg: LoopConfig): Promise<number> {
  let cleanValidationManager: CleanValidationCheckoutManager | null = null;
  let session: WorkspaceSession;
  try {
    const lease = await acquireWorkspaceLease({ workspacePath: cfg.workspace, command: 'run' });
    session = createWorkspaceSession(lease);
  } catch (err) {
    if (err instanceof WorkspaceSafetyError) {
      console.error(`❌ workspace 不可进入正式运行：${err.message}`);
      return 2;
    }
    throw err;
  }
  const workspace = session.writer.workspacePath;
  const commandSignals = cfg.commandSignalsForTests ?? installCommandSignals();
  let closeHookCalled = false;
  const closeSession = async (): Promise<void> => {
    const closing = session.close();
    if (!closeHookCalled) {
      closeHookCalled = true;
      await cfg.afterSessionCloseStartedForTests?.();
    }
    await closing;
  };
  let server: ReturnType<typeof dashboard.start> | null = null;
  try {
    const startup = await runLoopPreflight(cfg, session, commandSignals.termination);
    if (startup.status === 'failed') return startup.exitCode;
    if (commandSignals.exitCode !== null) return commandSignals.exitCode;
    const {
      statePath,
      guard,
      projectRoot,
      qualityReader,
      qualityRead,
      agentEnv,
      tddConfig,
      builder,
      validatorBase,
      modelPreflight: preflight,
      frozenQualityChecks,
      runKind,
      bootResolved,
      validationEnvironmentDigest: bootValidationEnvironmentDigest,
      validationRuntimeIdentity,
      defaultBranchGitHead,
    } = startup;
    await session.writer.removeFile(CANDIDATE_PROOF_FILE);
    const agentCwd = projectRoot;
    const storyValidationEnvironmentAt = (headSha: string): string =>
      cfg.validationEnvironmentDigestForTests !== undefined
        ? bindStoryValidationRuntimeIdentity(
            cfg.validationEnvironmentDigestForTests,
            validationRuntimeIdentity,
          )
        : digestCandidateStoryValidationEnvironment({
          contract: qualityRead.contract,
          headSha,
          defaultBranchGitHead,
          tddConfig,
            runtimeIdentity: validationRuntimeIdentity,
          });
    const runId = randomUUID();
    const validationRunnerEnvironment = Object.fromEntries(
      ['CODING_X_CLAUDE_BIN', 'CODING_X_CODEX_BIN', 'CODING_X_CURSOR_BIN'].flatMap((name) => {
        const value = agentEnv[name] ?? process.env[name];
        if (!value) return [];
        if (
          !cfg.unsafeAllowProjectScopedRunnerForValidationTests &&
          valueReferencesProjectPath(projectRoot, value)
        ) {
          return [];
        }
        return [[name, value]];
      }),
    );
    if (
      !cfg.legacyValidatorProtocolForTests &&
      !cfg.validatorRunnerBindingForTests &&
      runKind !== 'codex'
    ) {
      console.warn(
        `\n⚠️  当前 runner（${runKind}）尚无法证明 Validator 宿主隔离（ADR-025）：Builder 可正常运行，` +
          '进入验证阶段将按不可验证保留候选并以退出码 5 停止。可签发验收凭证的 runner：codex（固定审计版本）。\n',
      );
    }
    if (!cfg.unsafeUseProjectRootForValidationTests) {
      cleanValidationManager = new CleanValidationCheckoutManager(
        projectRoot,
        qualityRead.contract,
        {
          session,
          kind: 'quality-check',
          termination: commandSignals.termination,
        },
      );
    }

    server = dashboard.start({
      workspace,
      maxIterations: cfg.maxIterations,
      projectRoot,
      port: cfg.port,
      storyValidationObserver: () =>
        observeStoryValidationCurrentness({
          projectRoot,
          session,
          runtimeIdentity: validationRuntimeIdentity,
          termination: commandSignals.termination,
          ...(cfg.qualityContractReader
            ? { qualityContractReader: cfg.qualityContractReader }
            : {}),
          ...(cfg.validationEnvironmentDigestForTests !== undefined
            ? { validationEnvironmentDigestForTests: cfg.validationEnvironmentDigestForTests }
            : {}),
        }),
    });
    await server.ready;
    dashboard.setState({ runner: runKind });
    // Developer stays at the project root; Validator later moves to the exact-HEAD
    // validation checkout. Neither agent runs inside the workspace. Instructions and result paths
    // use the lease-authenticated absolute path, so changing cwd cannot redirect engine state.
    const progressPath = join(workspace, 'progress.md');
    const rawOf = (p: string): string | null => {
      const file = readStableFile(p, { label: basename(p) });
      return file.status === 'ready' ? file.bytes.toString('utf8') : null;
    };
    const outcomeOf = (r: {
      timedOut: boolean;
      exitCode: number | null;
    }): 'completed' | 'timeout' | 'error' =>
      r.timedOut ? 'timeout' : r.exitCode === 0 ? 'completed' : 'error';
    const invocationOf = (
      result: RunResult,
      outcome: 'completed' | 'timeout' | 'error',
    ): AgentInvocationEvidence => {
      const diagnostic =
        outcome === 'completed' ? '' : clipEvidenceDiagnostic(result.outputTail).trim();
      return {
        durationMs: result.durationMs,
        exitCode: result.exitCode,
        ...(result.terminationReason ? { terminationReason: result.terminationReason } : {}),
        ...(diagnostic ? { diagnosticTail: diagnostic } : {}),
      };
    };
    // evidence 是增强不是关键路径：写入失败只 warn（去重一次），绝不影响循环
    let warnedEvidence = false;
    const recordEvidence = async (record: EvidenceRecord): Promise<void> => {
      try {
        await appendEvidenceWithWriter(session.writer, record);
      } catch (err) {
        if (!warnedEvidence) {
          warnedEvidence = true;
          console.warn(
            `⚠️  evidence 记录写入失败（不影响循环）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    const qualityContractStillCurrent = async (expectedHead?: string): Promise<boolean> => {
      const current = qualityReader(projectRoot);
      if (current.status !== 'ready' || current.digest !== qualityRead.digest) {
        const observed = current.status === 'ready' ? current.digest : current.status;
        console.error(
          `❌ 运行期间工作树质量契约发生变化或不可读（启动 ${qualityRead.digest}，当前 ${observed}）。` +
            '本次运行按配置错误停止；请确认变更后重新派生 PRD。',
        );
        return false;
      }
      // 测试注入没有真实 Git/契约文件；生产每次都把待验证 HEAD 中的受管契约重新绑定
      // 到启动摘要。不能只相信工作树文件：Developer 可能提交不同契约后再把工作树恢复。
      if (cfg.qualityContractReader) return true;
      const head = expectedHead ?? readGitHead(projectRoot);
      if (!head) {
        console.error('❌ 运行期间无法读取当前 Git HEAD；不能确认质量契约仍绑定待验证提交');
        return false;
      }
      const tracked = await readTrackedQualityContractAtHead({
        projectRoot,
        head,
        session,
        termination: commandSignals.termination,
      });
      if (tracked.status === 'ready' && tracked.digest === qualityRead.digest) return true;
      const observed =
        tracked.status === 'ready'
          ? tracked.digest
          : tracked.status === 'invalid'
            ? tracked.errors.join('；')
            : tracked.status === 'missing'
              ? 'missing'
              : tracked.error;
      console.error(
        `❌ 待验证 HEAD ${head} 的质量契约与启动契约不一致` +
          `（启动 ${qualityRead.digest}，HEAD ${observed}）；本次运行按配置错误停止。`,
      );
      return false;
    };
    const reconcileAtCurrentHead = async (
      prd: Prd,
      state: RunState,
      context: string,
    ): Promise<{
      state: RunState;
      gitHead: string;
      validationEnvironmentDigest: string;
    } | null> => {
      const gitHead = readGitHead(agentCwd);
      if (!gitHead) {
        console.error(`❌ ${context}无法读取当前 Git HEAD，本次运行停止且不会接受旧验收结果`);
        return null;
      }
      const currentEnvironmentDigest = storyValidationEnvironmentAt(gitHead);
      const reconciled = reconcileValidationReceipts(prd, state, gitHead, currentEnvironmentDigest);
      if (reconciled.invalidatedStoryIds.length > 0) {
        await session.writer.writeFile('state.json', JSON.stringify(reconciled.state, null, 2));
        console.warn(
          `⚠️  ${context}检测到旧 Validator 凭证已过期，保留实现候选并等待重验：` +
            reconciled.invalidatedStoryIds.join(', '),
        );
      }
      return {
        state: reconciled.state,
        gitHead,
        validationEnvironmentDigest: currentEnvironmentDigest,
      };
    };
    // 每次 guard.read() 都可能检出新篡改事件——三处读取点共用（archive 记文件名，与报告红旗区文件清单对齐）
    const recordTamper = async (read: PrdReadResult, iteration: number): Promise<void> => {
      if (read.tamperedArchive !== undefined) {
        await recordEvidence({
          type: 'tamper',
          source: 'engine',
          at: new Date().toISOString(),
          iteration,
          archive: read.tamperedArchive === null ? null : basename(read.tamperedArchive),
        });
      }
    };
    // 提前退出（builder 异常轮熔断 / no-op 全部 resolved 快路径 / no-op 非 resolved 熔断）
    // break 前统一补一次 guard.read()+recordTamper()——它们都复用轮首快照提前结束本轮，
    // 若 builder 在本轮篡改了 prd.json，不补这一读就不会被检测/恢复/存档（与标准完成判定
    // 路径:344-345 的读点同形态）。guard.read() 幂等：磁盘未变时是真无操作。
    const tamperCheckBeforeExit = async (iteration: number): Promise<void> => {
      const r = await guard.read();
      await recordTamper(r, iteration);
    };
    const stallLimit = cfg.stallLimit ?? 3;
    let stallCount = 0;
    // stall 熔断判定：stall 轮调用；达限打横幅并返回 true（调用方 break）
    const stalled = (): boolean => {
      stallCount += 1;
      if (stallCount < stallLimit) return false;
      console.error(
        `\n🛑 连续 ${stallLimit} 轮无进展（no-op/超时/异常退出），提前终止。排查 agent CLI 可用性、模型名与网络后重跑（引擎幂等续跑）。`,
      );
      return true;
    };
    let exitCode = 1;
    let reusableFullGate: FullGateProof | undefined;
    let reportCurrentReview: CurrentReviewStatus | undefined;
    const reportOptionsFor = (
      trustedPrd: Prd | null,
      observation: StoryValidationObservation | null,
      observationError?: string,
    ): ReportOptions => ({
      ...(trustedPrd === null ? {} : { trustedPrd }),
      ...(reportCurrentReview === undefined ? {} : { currentReview: reportCurrentReview }),
      currentGitHead: observation?.headSha ?? null,
      storyValidationObservation: observation,
      ...(observationError === undefined
        ? {}
        : { storyValidationObservationError: observationError }),
    });
    const pendingCloseoutMessage =
      '本次运行尚未完成最终安全清理，不能把此报告视为最终结局';
    let pendingCloseoutReportWritten = false;
    const writePendingCloseoutReport = async (trustedPrd: Prd | null): Promise<void> => {
      try {
        const pending = await writeReportWithWriter(
          session.writer,
          new Date(),
          reportOptionsFor(trustedPrd, null, pendingCloseoutMessage),
        );
        pendingCloseoutReportWritten ||= pending.status === 'written';
      } catch (err) {
        if (err instanceof WorkspaceSafetyError) throw err;
        console.warn(
          `⚠️  安全收口前的保守报告未能写入：${err instanceof Error ? err.message : String(err)}`,
        );
      }
    };
    const observeCurrentStoryValidation = () =>
      observeStoryValidationCurrentness({
        projectRoot,
        session,
        runtimeIdentity: validationRuntimeIdentity,
        termination: commandSignals.termination,
        ...(cfg.qualityContractReader ? { qualityContractReader: cfg.qualityContractReader } : {}),
        ...(cfg.validationEnvironmentDigestForTests !== undefined
          ? { validationEnvironmentDigestForTests: cfg.validationEnvironmentDigestForTests }
          : {}),
        ...(cfg.defaultBranchGitHeadForTests !== undefined
          ? { defaultBranchGitHeadForTests: cfg.defaultBranchGitHeadForTests }
          : {}),
      });
    const completeResolvedRun = async (): Promise<number> => {
      const initialStoryValidation = await observeCurrentStoryValidation();
      if (initialStoryValidation.status !== 'ready') {
        console.error(
          `❌ 进入最终 Review 前无法确认 Story 验收当前性：${initialStoryValidation.message}`,
        );
        return 2;
      }
      if (
        !initialStoryValidation.headSha ||
        initialStoryValidation.storyValidationDigest === null ||
        !allStoriesResolvedAt(
          initialStoryValidation.prd,
          initialStoryValidation.state,
          initialStoryValidation.headSha,
          initialStoryValidation.storyValidationEnvironmentDigest,
        )
      ) {
        console.warn(
          '⚠️  进入最终 Review 前发现 Story 验收凭证不再对应当前提交，本次不启动 Review',
        );
        return 1;
      }
      const blocked = blockedConvergedExit(
        initialStoryValidation.prd,
        initialStoryValidation.state,
      );
      if (blocked !== null) return blocked;
      const initialToken = initialStoryValidation.observationToken;
      const initialDigest = initialStoryValidation.storyValidationDigest;
      const initialEnvironmentDigest = initialStoryValidation.storyValidationEnvironmentDigest;
      const initialHead = initialStoryValidation.headSha;
      const observeStoryValidation = async (): Promise<StoryValidationBindingObservation> => {
        const observed = await observeCurrentStoryValidation();
        if (observed.status !== 'ready') {
          return {
            status: 'unverifiable' as const,
            message: observed.message,
          };
        }
        if (
          observed.observationToken !== initialToken ||
          observed.headSha !== initialHead ||
          observed.storyValidationEnvironmentDigest !== initialEnvironmentDigest ||
          observed.storyValidationDigest !== initialDigest
        ) {
          return {
            status: 'unverifiable' as const,
            message: 'Story 验收绑定输入已变化；必须基于最新 PRD、状态、契约与提交重新 Review',
          };
        }
        return {
          status: 'ready' as const,
          digest: initialDigest,
          observationToken: observed.observationToken,
          ...(observed.authorityInputDigest === undefined
            ? {}
            : { authorityInputDigest: observed.authorityInputDigest }),
        };
      };
      console.log('\n🔎 全部 story 已验证，开始针对当前 PR 最新提交执行本地最终 Review。');
      const finalReview = await (cfg.finalReviewRunner ?? runFinalReview)({
        root: projectRoot,
        workspace,
        session,
        currentContract: qualityRead.contract,
        runner: runKind,
        model: preflight.review.model,
        codingXVersion: cfg.actualVersion ?? CODING_X_VERSION,
        shadow: cfg.shadow ?? false,
        timeoutMs: cfg.valTimeoutMs,
        storyValidationDigest: initialDigest,
        reusableFullGate,
        observeStoryValidation,
        termination: commandSignals.termination,
      });
      if (finalReview.state !== undefined) {
        const accepted = await observeStoryValidation();
        if (accepted.status !== 'ready' || accepted.digest !== initialDigest) {
          try {
            await invalidateFinalReviewState(session.writer);
          } catch (error) {
            if (session.state === 'open') session.retainLeaseForIsolation();
            console.error(
              '❌ loop 接受最终 Review 前 Story 验收凭证集合已变化，' +
                `但无法安全撤销旧结果；workspace 已隔离：${error instanceof Error ? error.message : String(error)}`,
            );
            return 2;
          }
          console.error('⏸️  loop 接受最终 Review 前 Story 验收凭证集合已变化；本轮结果已作废');
          return 5;
        }
      }
      if (cfg.candidateIdentity && finalReview.state !== undefined) {
        if (
          finalReview.state.shadow &&
          finalReview.state.status === 'passed' &&
          finalReview.state.remote.status === 'ready'
        ) {
          try {
            const proof = createCandidateDogfoodProof({
              identity: cfg.candidateIdentity,
              contract: qualityRead.contract,
              review: finalReview.state,
              storyValidationEnvironmentDigest: initialEnvironmentDigest,
            });
            await session.writer.writeFile(CANDIDATE_PROOF_FILE, `${JSON.stringify(proof, null, 2)}\n`);
            console.log(`📦 候选 Dogfood 机器证明已写入 ${CANDIDATE_PROOF_FILE}`);
          } catch (error) {
            console.error(
              `❌ 候选 Dogfood 机器证明无法签发：${error instanceof Error ? error.message : String(error)}`,
            );
            return 5;
          }
        } else if (finalReview.state.shadow && finalReview.state.status === 'passed') {
          console.warn('⏳ Shadow Review 已通过，但远端总闸尚未 ready；不会生成发布用候选证明');
        }
      }
      reportCurrentReview =
        finalReview.state === undefined
          ? undefined
          : {
              read: { status: 'ready', state: finalReview.state },
              current: true,
              staleReasons: [],
              refreshedRemote: finalReview.state.remote,
            };
      if (commandSignals.exitCode !== null) return commandSignals.exitCode;
      const emit =
        finalReview.exitCode === 0 || finalReview.exitCode === 7 ? console.log : console.error;
      emit(
        `\n${finalReview.exitCode === 0 ? '✅' : finalReview.exitCode === 7 ? '🧪' : '⏸️'} ${finalReview.message}`,
      );
      return finalReview.exitCode;
    };
    const phaseAfterResolvedRun = (resolvedExitCode: number): dashboard.Phase => {
      if (resolvedExitCode === 0) return 'done';
      if (resolvedExitCode === 7) return 'shadow';
      if (resolvedExitCode >= 3 && resolvedExitCode <= 6) return 'blocked';
      return 'error';
    };
    const completeResolvedRunWithDashboard = async (): Promise<number> => {
      dashboard.setState({
        phase: 'validating',
        model: null,
        routeSource: null,
        storyDifficulty: null,
      });
      try {
        const resolvedExitCode = await completeResolvedRun();
        dashboard.setState({
          phase: phaseAfterResolvedRun(resolvedExitCode),
          model: null,
          routeSource: null,
          storyDifficulty: null,
        });
        return resolvedExitCode;
      } catch (error) {
        dashboard.setState({
          phase: 'error',
          model: null,
          routeSource: null,
          storyDifficulty: null,
        });
        throw error;
      }
    };
    if (bootResolved) {
      exitCode = await completeResolvedRunWithDashboard();
    }
    for (
      let i = 1;
      !bootResolved && commandSignals.exitCode === null && i <= cfg.maxIterations;
      i++
    ) {
      await session.lease.verify();
      if (!(await qualityContractStillCurrent())) {
        exitCode = 2;
        break;
      }
      let stateRawBefore = rawOf(statePath);
      const progressRawBefore = rawOf(progressPath);
      const beforeRead = await guard.read();
      await recordTamper(beforeRead, i);
      const before = beforeRead.prd;
      // 写回失败=磁盘仍是篡改版=本轮 validator 读到的验收标准不可信 → 跳过（下轮开头重试恢复）
      let skipValidator = beforeRead.restoreFailed;
      let beforeState = before ? readRunState(statePath, before) : null;
      let currentGitHead: string | null = null;
      let currentValidationEnvironmentDigest = bootValidationEnvironmentDigest;
      if (before && beforeState) {
        const reconciled = await reconcileAtCurrentHead(before, beforeState, '轮首');
        if (!reconciled) {
          exitCode = 2;
          break;
        }
        beforeState = reconciled.state;
        currentGitHead = reconciled.gitHead;
        currentValidationEnvironmentDigest = reconciled.validationEnvironmentDigest;
        stateRawBefore = rawOf(statePath);
      }
      const selection =
        before && beforeState && currentGitHead
          ? selectNextStory(before, beforeState, currentGitHead, currentValidationEnvironmentDigest)
          : null;
      const currentStory = selection?.storyId ?? null;
      const validationOnly = selection?.mode === 'validation-only';
      const currentStoryObj = before?.userStories.find((s) => s.id === currentStory) ?? null;
      const ownershipStoryIds = before?.userStories.map((story) => story.id) ?? [];
      // 旧 state 只读时不迁移；一旦进入执行轮，就先把全部 PRD story 的引擎
      // 独占字段实体化。这样 agent 后续删除字段能与 legacy 缺省明确区分，且
      // 非当前 story 也不能靠伪造 validated/escalated 绕过选取与完成判定。
      if (beforeState) {
        let materialized = beforeState;
        let materializedChanged = false;
        for (const storyId of ownershipStoryIds) {
          const expected = beforeState[storyId] ?? INITIAL_STORY_STATE;
          const owned = tryReadEngineOwnedFields(statePath, storyId);
          if (!owned) continue;
          const route = restoreEscalated(
            materialized,
            storyId,
            expected.escalated,
            expected,
            owned.escalated,
          );
          materialized = route.state;
          const validation = restoreValidationOwnership(
            materialized,
            storyId,
            validationOwnershipOf(expected),
            expected,
            {
              validated: owned.validated,
              storyBaseGitHead: owned.storyBaseGitHead,
              validationReceipt: owned.validationReceipt,
              validatorUnverifiable: owned.validatorUnverifiable,
            },
          );
          materialized = validation.state;
          if (route.tamper || validation.tamper) materializedChanged = true;
        }
        if (materializedChanged) {
          await session.writer.writeFile('state.json', JSON.stringify(materialized, null, 2));
          stateRawBefore = rawOf(statePath);
        }
        beforeState = materialized;
      }
      // readRunState 会为损坏文件提供只用于失败关闭的内存回退；冻结 Story 起点前必须
      // 再证明磁盘 state 本身可解析，绝不能用回退值覆盖并“洗白”损坏权威文件。
      const persistedStateBeforeBaseBinding = beforeState ? tryReadState(statePath) : null;
      if (
        beforeState &&
        persistedStateBeforeBaseBinding &&
        currentStory &&
        currentGitHead &&
        !validationOnly
      ) {
        const bound = bindStoryValidationBase(beforeState, currentStory, currentGitHead);
        if (bound.changed) {
          await session.writer.writeFile('state.json', JSON.stringify(bound.state, null, 2));
          stateRawBefore = rawOf(statePath);
          beforeState = bound.state;
          console.log(`📍 ${currentStory} 已固定本轮 Story 起点 ${currentGitHead}`);
        }
      }
      const routeTampers: Array<{
        storyId: string;
        expected: boolean;
        received: boolean | 'missing';
        side: 'builder' | 'validator';
      }> = [];
      const validationTampers: Array<{
        storyId: string;
        expected: boolean;
        received: boolean | 'missing';
        side: 'builder' | 'validator';
      }> = [];
      const restoreEngineOwnership = async (
        side: 'builder' | 'validator',
        expectedState: RunState | null,
      ): Promise<{ storyMissing: boolean }> => {
        if (!expectedState) return { storyMissing: false };
        const state = tryReadState(statePath);
        if (!state) return { storyMissing: false };
        const storyMissing = !!currentStory && !state[currentStory];
        let restored = state;
        let changed = false;
        for (const storyId of ownershipStoryIds) {
          const expected = expectedState[storyId] ?? INITIAL_STORY_STATE;
          const observed = tryReadEngineOwnedFields(statePath, storyId);
          const route = restoreEscalated(
            restored,
            storyId,
            expected.escalated,
            expected,
            observed?.escalated,
          );
          restored = route.state;
          const validation = restoreValidationOwnership(
            restored,
            storyId,
            validationOwnershipOf(expected),
            expected,
            observed
              ? {
                  validated: observed.validated,
                  storyBaseGitHead: observed.storyBaseGitHead,
                  validationReceipt: observed.validationReceipt,
                  validatorUnverifiable: observed.validatorUnverifiable,
                }
              : undefined,
          );
          restored = validation.state;
          if (route.tamper) {
            changed = true;
            routeTampers.push({ storyId, ...route.tamper, side });
            console.warn(
              `⚠️  ${side} 修改了引擎独占的 ${storyId}.escalated ` +
                `(${route.tamper.expected} → ${route.tamper.received})，已恢复`,
            );
          }
          if (validation.tamper) {
            changed = true;
            if (validation.tamper.expected.validated !== validation.tamper.received.validated) {
              validationTampers.push({
                storyId,
                expected: validation.tamper.expected.validated,
                received: validation.tamper.received.validated,
                side,
              });
            }
            console.warn(
              `⚠️  ${side} 修改了引擎独占的 ${storyId} 验收状态，已整体恢复`,
            );
          }
        }
        if (changed) {
          await session.writer.writeFile('state.json', JSON.stringify(restored, null, 2));
        }
        return { storyMissing };
      };
      const hasDedicatedEscalation = Boolean(cfg.escalationModel || preflight.config?.escalation);
      const triggerEscalation = async (reason: 'gate' | 'validator' | 'noop'): Promise<boolean> => {
        if (!currentStory) return false;
        const state = tryReadState(statePath);
        if (!state) return false;
        const enabled = enableEscalation(state, currentStory, hasDedicatedEscalation);
        if (!enabled.changed) return false;
        await session.writer.writeFile('state.json', JSON.stringify(enabled.state, null, 2));
        console.log(`⬆️  ${currentStory} 首次有效失败（${reason}），下轮起使用 escalation 模型`);
        return true;
      };
      // Developer 异常和 legacy Validator 测试兼容路径：本轮把当前 story 的 passes 从
      // false 翻到 true 且未 blocked → 回写待复核。结构化 Validator 由 ADR-023 分类，
      // 不进入此处。state 读取失败（缺失/损坏）不回写不覆盖。
      const rollbackIfUnvalidatedPass = async (
        side: 'builder' | 'validator',
        r: Pick<RunResult, 'timedOut' | 'exitCode' | 'terminationReason'>,
      ): Promise<boolean> => {
        if (!currentStory) return false;
        const passedBefore = beforeState?.[currentStory]?.passes ?? false;
        const st = tryReadState(statePath);
        const cur = st?.[currentStory];
        if (!st || !cur || !cur.passes || cur.blocked || passedBefore) return false;
        const next = applyAbortRollback(
          st,
          currentStory,
          {
            side,
            timedOut: r.timedOut,
            exitCode: r.exitCode,
            terminationReason: r.terminationReason,
          },
          new Date(),
        );
        await session.writer.writeFile('state.json', JSON.stringify(next, null, 2));
        console.warn(
          `⚠️  ${currentStory} 在中断轮被置为通过，未经完整验收——已回写待复核（${side} ${abortDesc(r)}）`,
        );
        return true;
      };
      // 只供 legacy Validator 测试兼容路径；正式结构化协议不可验证时保留候选。
      const rollbackPendingValidation = async (reason: string): Promise<boolean> => {
        if (!currentStory) return false;
        const state = tryReadState(statePath);
        if (!state) return false;
        const rolled = rollbackUnvalidatedPass(state, currentStory);
        if (!rolled.changed) return false;
        await session.writer.writeFile('state.json', JSON.stringify(rolled.state, null, 2));
        console.warn(`⚠️  ${currentStory} 未取得引擎验收凭证（${reason}），已回写待复核`);
        return true;
      };
      const builderChoice = validationOnly
        ? null
        : resolveBuilderModel({
            builderOverride: cfg.builderModel,
            escalationOverride: cfg.escalationModel,
            config: preflight.config,
            story: currentStoryObj,
            escalated:
              currentStory && beforeState ? (beforeState[currentStory]?.escalated ?? false) : false,
          });
      let builderInvocation: AgentInvocationEvidence | undefined;
      let validatorInvocation: AgentInvocationEvidence | undefined;
      // 「每轮一条 iteration」五个写入点的公共底座单源：各点只传差异字段——
      // 0.22.0 轮五点位分四批才靠审查抓齐，字段漂移风险有实证，底座必须只有一份。
      const recordIteration = async (
        over: Partial<Extract<EvidenceRecord, { type: 'iteration' }>>,
      ): Promise<void> => {
        await recordEvidence({
          type: 'iteration',
          source: 'engine',
          at: new Date().toISOString(),
          runId,
          iteration: i,
          storyId: currentStory,
          builderRan: !validationOnly && !!builder,
          builderModel: builderChoice?.model ?? null,
          validatorRan: false,
          validatorModel: null,
          skippedValidator: false,
          agentBlocked: false,
          ...(builderChoice ? { builderRouteSource: builderChoice.source } : {}),
          ...(currentStoryObj?.difficulty ? { storyDifficulty: currentStoryObj.difficulty } : {}),
          ...(routeTampers.length > 0 ? { stateRouteTamper: [...routeTampers] } : {}),
          ...(validationTampers.length > 0
            ? { stateValidationTamper: [...validationTampers] }
            : {}),
          ...(builderInvocation ? { builderInvocation } : {}),
          ...(validatorInvocation ? { validatorInvocation } : {}),
          ...over,
        });
      };
      const persistCurrentValidatorUnverifiable = async (
        fallbackGitHead: string | null,
      ): Promise<void> => {
        if (!currentStoryObj) return;
        let bindingHead = readGitHead(agentCwd) ?? fallbackGitHead;
        if (!bindingHead) return;

        // Git HEAD 与 state.json 不是同一个原子事务。首次写入后立即复核；若提交在
        // await 窗口中变化，再把标记绑定到新提交。这样 run=5 不会紧接着在 status
        // 中无解释地退成 1。仍读不到 HEAD 时，status 会把它保守地继续显示为 5。
        for (let attempt = 0; attempt < 2; attempt += 1) {
          const state = tryReadState(statePath);
          if (!state) return;
          const marked = markValidatorUnverifiable(state, currentStoryObj, bindingHead);
          if (marked.changed) {
            await session.writer.writeFile('state.json', JSON.stringify(marked.state, null, 2));
          }
          if (attempt === 0) await cfg.afterValidatorUnverifiableStateWriteForTests?.();
          const observedHead = readGitHead(agentCwd);
          if (observedHead === null || observedHead === bindingHead) return;
          bindingHead = observedHead;
        }
      };
      const observeValidationHead = async (
        expectedGitHead: string | null,
        context: string,
        observedGitHead = readGitHead(agentCwd),
      ): Promise<string | null> => {
        if (expectedGitHead && observedGitHead === expectedGitHead) return null;

        if (before && observedGitHead) {
          const state = tryReadState(statePath);
          if (state) {
            const observedEnvironmentDigest = storyValidationEnvironmentAt(observedGitHead);
            const reconciled = reconcileValidationReceipts(
              before,
              state,
              observedGitHead,
              observedEnvironmentDigest,
            );
            if (reconciled.invalidatedStoryIds.length > 0) {
              await session.writer.writeFile(
                'state.json',
                JSON.stringify(reconciled.state, null, 2),
              );
              console.warn(
                `⚠️  ${context}检测到提交变化，旧 Validator 凭证已撤销：` +
                  reconciled.invalidatedStoryIds.join(', '),
              );
            }
          }
        }

        const expected = expectedGitHead ?? 'unavailable';
        const observed = observedGitHead ?? 'unavailable';
        return `${context}Git HEAD 与本轮检查目标不一致（期望 ${expected}，当前 ${observed}）`;
      };
      const validationHeadAbortOf = (
        phase: ValidationHeadAbortPhase,
        expectedGitHead: string | null,
        actualGitHead: string | null,
        diagnostic: string,
      ): ValidationHeadAbortEvidence => ({
        phase,
        reason:
          expectedGitHead === null || actualGitHead === null ? 'head-unreadable' : 'head-changed',
        expectedGitHead,
        actualGitHead,
        diagnostic: clipEvidenceDiagnostic(diagnostic),
      });
      const stopForValidationHeadChange = async (
        expectedGitHead: string | null,
        context: string,
        phase: ValidationHeadAbortPhase,
        builderOutcome?: 'completed' | 'timeout' | 'error',
        observedGitHead = readGitHead(agentCwd),
      ): Promise<boolean> => {
        const diagnostic = await observeValidationHead(expectedGitHead, context, observedGitHead);
        if (!diagnostic) return false;
        const validationHeadAbort = validationHeadAbortOf(
          phase,
          expectedGitHead,
          observedGitHead,
          diagnostic,
        );
        const recovery = '保留当前实现状态且不增加重试';
        console.error(`\n⏸️  ${diagnostic}；${recovery}，本次运行停止且不启动 Validator`);
        await persistCurrentValidatorUnverifiable(expectedGitHead);
        await recordIteration({
          ...(builderOutcome ? { builderOutcome } : {}),
          validatorOutcome: 'skipped',
          validationProtocol: 'invalid',
          validationProtocolError: {
            code: 'artifact-changed',
            diagnostic: clipEvidenceDiagnostic(diagnostic),
          },
          validationHeadAbort,
        });
        dashboard.setState({
          phase: 'blocked',
          model: null,
          routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
        exitCode = 5;
        await tamperCheckBeforeExit(i);
        return true;
      };
      const throwIfValidationContainmentUnverifiable = (error: unknown): void => {
        if (error instanceof WorkspaceSafetyError) throw error;
        if (
          error instanceof CleanValidationCheckoutError &&
          (error.code === 'cleanup-unverifiable' || error.code === 'topology-unverifiable')
        ) {
          if (session.state === 'open') session.retainLeaseForIsolation();
          throw new WorkspaceSafetyError('isolated', error.message);
        }
      };
      const stopForValidationEnvironmentFailure = async (
        error: unknown,
        builderOutcome?: 'completed' | 'timeout' | 'error',
      ): Promise<true> => {
        throwIfValidationContainmentUnverifiable(error);
        const detail = clipEvidenceDiagnostic(
          error instanceof Error ? error.message : String(error),
        ).trim();
        const candidateState = currentStory ? tryReadState(statePath)?.[currentStory] : undefined;
        const candidateReady =
          cfg.legacyValidatorProtocolForTests ||
          (!!currentStoryObj && !!candidateState?.passes && !candidateState.blocked);
        if (!candidateReady) {
          console.warn(
            `⏭️  本地验证环境未能建立，但当前 Story 尚无可验收候选：${detail}；` +
              '按普通未收敛结束，不把它误记为 Validator 无法验证',
          );
          await recordIteration({
            ...(builderOutcome ? { builderOutcome } : {}),
            validatorOutcome: 'skipped',
          });
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          await tamperCheckBeforeExit(i);
          return true;
        }
        const recovery = '保留当前实现状态且不增加重试';
        console.error(`\n⏸️  本地验证环境不可验证：${detail}；${recovery}，本次运行停止`);
        await persistCurrentValidatorUnverifiable(currentGitHead);
        await recordIteration({
          ...(builderOutcome ? { builderOutcome } : {}),
          validatorOutcome: 'skipped',
          validationProtocol: 'invalid',
          validationProtocolError: {
            code: 'environment-unverifiable',
            diagnostic: detail,
          },
        });
        dashboard.setState({
          phase: 'blocked',
          model: null,
          routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
        exitCode = 5;
        await tamperCheckBeforeExit(i);
        return true;
      };

      dashboard.setState({
        iteration: i,
        phase: validationOnly ? 'gating' : 'developing',
        currentStory,
        model: !validationOnly && builder ? (builderChoice?.model ?? null) : null,
        routeSource: !validationOnly && builder ? (builderChoice?.source ?? null) : null,
        storyDifficulty: currentStoryObj?.difficulty ?? null,
      });

      // Developer
      let builderOutcome: 'completed' | 'timeout' | 'error' | undefined;
      let builderRollback = false;
      if (validationOnly) {
        console.log(
          `🔁 ${currentStory} 的实现候选仍保留，本轮跳过 Developer，只重新执行检查与 Validator`,
        );
      } else if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else if (!currentStoryObj) {
        console.error('❌ 无法从可信 PRD 快照定位当前 story，本次运行停止');
        exitCode = 2;
        await tamperCheckBeforeExit(i);
        break;
      } else {
        console.log(
          `🧠 builder 实际模型: ${builderChoice!.model ?? 'runner 默认'} [${builderChoice!.source}]` +
            `${currentStoryObj?.difficulty ? ` · 难度 ${currentStoryObj.difficulty}` : ''}` +
            `${builderChoice!.escalated ? ` · ${currentStory} 升级路由` : ''}`,
        );
        const builderStateRawBefore = rawOf(statePath);
        const builderStateWasReadable = tryReadState(statePath) !== null;
        const dev = await runAgent({
          kind: runKind,
          prompt: builder,
          cwd: agentCwd,
          timeoutMs: cfg.devTimeoutMs,
          model: builderChoice!.model,
          env: agentEnv,
          ...(cfg.builderOutputForTests ? { output: cfg.builderOutputForTests } : {}),
          managed: {
            session,
            termination: commandSignals.termination,
            operation: {
              kind: 'builder',
              delegation: 'builder-v1',
              storyId: currentStoryObj.id,
              acceptanceHash: acceptanceHash(
                currentStoryObj.id,
                currentStoryObj.acceptanceCriteria,
              ),
              checkCount: currentStoryObj.acceptanceCriteria.length,
            },
          },
        });
        builderOutcome = outcomeOf(dev);
        builderInvocation = invocationOf(dev, builderOutcome);
        // Builder 可以更新候选字段，但不能把整份状态写成无法解析的形状。若调用前
        // 状态可读、调用后损坏，则恢复调用前完整快照并停止，避免独占凭证被非法值
        // 绕过选择性恢复后永久污染 workspace。
        if (builderStateWasReadable && tryReadState(statePath) === null) {
          if (builderStateRawBefore !== null) {
            await session.writer.writeFile('state.json', builderStateRawBefore);
          }
          console.warn('⚠️  Builder 写出了不可解析的 state.json，已恢复调用前快照并拒绝本轮结果');
          await recordIteration({ builderOutcome });
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          exitCode = 1;
          await tamperCheckBeforeExit(i);
          break;
        }
        await restoreEngineOwnership('builder', beforeState);
        if (builderOutcome !== 'completed') {
          builderRollback = await rollbackIfUnvalidatedPass('builder', dev);
          // evidence=引擎机械事实：agentBlocked 不能硬编码 false——agent 可能同轮已置 blocked:true
          // 又以非零码退出（如仲裁上报后环境异常收尾），此处需实时读一次 state 反映真实情况。
          const blockedNow = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
          await recordIteration({
            agentBlocked: blockedNow,
            builderOutcome,
            ...(builderRollback ? { abortRollback: { storyId: currentStory! } } : {}),
          });
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          if (commandSignals.exitCode !== null) {
            exitCode = commandSignals.exitCode;
            await tamperCheckBeforeExit(i);
            break;
          }
          if (stalled()) {
            await tamperCheckBeforeExit(i);
            break;
          }
          continue; // 异常轮：跳过门禁与验收，下轮重试（回写已保证不带走未验收的 true）
        }
      }

      // no-op 空转检测：builder 正常结束但 state 与 progress 双无变化（机械信号）——
      // 跳过门禁与验收（省一次强模型调用），计入 stall。
      if (
        !validationOnly &&
        builder &&
        builderOutcome === 'completed' &&
        !(await qualityContractStillCurrent())
      ) {
        await recordIteration({ builderOutcome: 'completed' });
        exitCode = 2;
        await tamperCheckBeforeExit(i);
        break;
      }

      if (!validationOnly && builderOutcome === 'completed' && before) {
        const stateAfterBuilder = tryReadState(statePath);
        if (stateAfterBuilder) {
          const reconciled = await reconcileAtCurrentHead(
            before,
            stateAfterBuilder,
            'Developer 返回后',
          );
          if (!reconciled) {
            const headDiagnostic = `Developer 返回后Git HEAD 与本轮检查目标不一致（期望 ${currentGitHead ?? 'unavailable'}，当前 unavailable）`;
            await persistCurrentValidatorUnverifiable(currentGitHead);
            await recordIteration({
              builderOutcome: 'completed',
              validatorOutcome: 'skipped',
              validationProtocol: 'invalid',
              validationProtocolError: {
                code: 'artifact-changed',
                diagnostic: clipEvidenceDiagnostic(headDiagnostic),
              },
              validationHeadAbort: validationHeadAbortOf(
                'quality-check-start',
                currentGitHead,
                null,
                headDiagnostic,
              ),
            });
            exitCode = 5;
            await tamperCheckBeforeExit(i);
            break;
          }
          currentGitHead = reconciled.gitHead;
          currentValidationEnvironmentDigest = reconciled.validationEnvironmentDigest;
        }
      }

      if (
        !validationOnly &&
        builder &&
        builderOutcome === 'completed' &&
        rawOf(statePath) === stateRawBefore &&
        rawOf(progressPath) === progressRawBefore
      ) {
        // 双无变化不等于「无事发生」：本轮开始时可能已经全部 resolved（如 legacy 迁移在
        // bootstrap 就把 passes 写进 state.json，或断点续跑接手一个已完成的工作区）——
        // before/beforeState 就是这轮唯一会有的磁盘状态（没变化），完成判定照样要跑，
        // 否则已完工的工作区会被当成空转一路吃到熔断。
        if (
          before &&
          beforeState &&
          currentGitHead &&
          allStoriesResolvedAt(
            before,
            beforeState,
            currentGitHead,
            currentValidationEnvironmentDigest,
          )
        ) {
          // 每轮一条 iteration 不变式：这条快路径 break 前也要留痕，否则已完工工作区
          // 重跑的终轮在 evidence 时间线上是空洞（其余所有退出路径都恰写一条）。
          await recordIteration({ builderOutcome: 'completed', noop: true });
          await tamperCheckBeforeExit(i);
          exitCode = await completeResolvedRunWithDashboard();
          break;
        }
        console.warn('⏭️  本轮 builder 无任何产出（state/progress 双无变化），跳过门禁与验收');
        const escalationTriggered = await triggerEscalation('noop');
        await recordIteration({
          builderOutcome: 'completed',
          noop: true,
          ...(escalationTriggered ? { escalationTriggeredBy: 'noop' as const } : {}),
        });
        dashboard.setState({
          phase: 'idle',
          model: null,
          routeSource: null,
          storyDifficulty: null,
        });
        if (stalled()) {
          await tamperCheckBeforeExit(i);
          break;
        }
        continue;
      }

      const verificationHead = currentGitHead;
      let validationCheckout: CleanValidationCheckout | null = null;
      let storyChangeManifest: StoryChangeManifest | null = null;
      let validationRoot = agentCwd;
      const roundValidationEnvironmentDigest = currentValidationEnvironmentDigest;

      // 机械门禁：builder 之后、validator 之前确定性执行质量检查（fail-fast）。
      // 失败即机械打回并跳过本轮 validator——builder 谎报「检查通过」在此被零成本戳穿。
      // 第四检测点：builder 刚跑完、validator 未拉起——本轮 builder 的篡改必须在此恢复，
      // 否则 validator（独立进程直读磁盘）当轮就会按假 AC 验收（ADR-007）。
      const gateRead = await guard.read();
      await recordTamper(gateRead, i);
      if (gateRead.restoreFailed) skipValidator = true;
      // agent 轮内显式置 blocked（仲裁上报，如 [需要人工核实]）：机械路径不得推进它——
      // 当轮跳过门禁执行与验收，完成判定按 resolved 正常收敛。
      // 第四检测点（上方 guard.read()）保持无条件执行：篡改恢复不因跳过而延后。
      const agentBlocked = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
      if (agentBlocked) {
        console.log(`⏭️  ${currentStory} 已被置 blocked（待人工处理），本轮跳过门禁与验收`);
      }
      if (
        !agentBlocked &&
        currentStory &&
        (await stopForValidationHeadChange(
          verificationHead,
          '项目机械检查启动前',
          'quality-check-start',
          builderOutcome,
        ))
      ) {
        break;
      }
      if (!agentBlocked && currentStory && verificationHead && cleanValidationManager) {
        if (!(await qualityContractStillCurrent(verificationHead))) {
          exitCode = 2;
          await tamperCheckBeforeExit(i);
          break;
        }
        // 从这一刻起会建立临时验证目录；其准备、核对或清理一旦无法证明，workspace
        // 将立即隔离且不能再写报告。先留下保守版本，但不要提前覆盖 Developer/PRD
        // 越界路径“不得生成报告”的既有边界。
        await writePendingCloseoutReport(gateRead.prd);
        try {
          const validationPolicy = candidateStoryValidationEnvironmentPolicy(
            tddConfig,
            qualityRead.contract,
            defaultBranchGitHead,
          );
          validationCheckout = await cleanValidationManager.acquire(
            verificationHead,
            validationPolicy.additionalRefs,
            validationPolicy.additionalPolicy,
            validationPolicy.referenceAliases,
          );
          const receivedDigest = bindStoryValidationRuntimeIdentity(
            validationCheckout.environmentDigest,
            validationRuntimeIdentity,
          );
          if (receivedDigest !== roundValidationEnvironmentDigest) {
            const cleanup = cleanValidationManager.dispose();
            validationCheckout = null;
            const cleanupDiagnostic =
              cleanup && cleanup.status !== 'removed'
                ? `；${describeCleanValidationCheckoutCleanup(cleanup)}`
                : '';
            throw new Error(
              `验证检出返回的环境摘要与引擎预计算摘要不一致（期望 ${roundValidationEnvironmentDigest}，` +
                `收到 ${receivedDigest}）${cleanupDiagnostic}`,
            );
          }
          validationRoot = validationCheckout.root;
          const storyBaseGitHead = tryReadState(statePath)?.[currentStory]?.storyBaseGitHead;
          if (!storyBaseGitHead) {
            throw new CleanValidationCheckoutError(
              'history-unverifiable',
              `${currentStory} 缺少引擎在首次实现前固定的 Story 起点；旧候选不得从当前历史反推起点`,
            );
          }
          storyChangeManifest = await validationCheckout.storyChangeManifest(
            storyBaseGitHead,
            `${currentStory} `,
          );
        } catch (error) {
          await stopForValidationEnvironmentFailure(error, builderOutcome);
          break;
        }
      } else if (!agentBlocked && currentStory && verificationHead) {
        const storyBaseGitHead = tryReadState(statePath)?.[currentStory]?.storyBaseGitHead;
        const injected =
          storyBaseGitHead && cfg.storyChangeManifestForTests
            ? cfg.storyChangeManifestForTests(storyBaseGitHead, verificationHead)
            : null;
        if (!storyBaseGitHead || !injected) {
          await stopForValidationEnvironmentFailure(
            new Error(
              `${currentStory} 无法建立固定 Story 起点与变化摘要；跳过干净检出的测试必须显式提供摘要`,
            ),
            builderOutcome,
          );
          break;
        }
        storyChangeManifest = {
          version: STORY_CHANGE_MANIFEST_VERSION,
          storyBaseGitHead,
          gitHead: verificationHead,
          digest: injected.digest,
          changedPathCount: injected.changedPathCount,
        };
      }
      const legacyChecks =
        cfg.legacyValidatorProtocolForTests && Array.isArray(gateRead.prd?.qualityChecks)
          ? readQualityChecks(gateRead.prd)
          : null;
      const derivedSnapshot = qualityChecksMatchContract(
        gateRead.prd?.qualityChecks,
        qualityRead.contract,
      );
      if (
        cfg.legacyValidatorProtocolForTests &&
        gateRead.prd?.qualityChecks !== undefined &&
        !derivedSnapshot &&
        (legacyChecks === 'invalid' || !Array.isArray(gateRead.prd.qualityChecks))
      ) {
        console.warn('⚠️  prd.json 的 qualityChecks 形状非法（应为字符串数组），机械门禁未启用');
      } else if (
        !agentBlocked &&
        currentStory &&
        (!cfg.legacyValidatorProtocolForTests ||
          (legacyChecks !== 'invalid' && legacyChecks !== null) ||
          derivedSnapshot)
      ) {
        dashboard.setState({
          phase: 'gating',
          model: null,
          routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
        const stateBeforeGate = rawOf(statePath);
        reusableFullGate = undefined;
        const managedGate = {
          session,
          kind: 'quality-check' as const,
          ...(validationCheckout
            ? {
                environment: validationCheckout.processEnvironment,
                forbiddenExecutableRoot: agentCwd,
                gitExecutable: validationCheckout.gitExecutable,
              }
            : {}),
          termination: commandSignals.termination,
        };
        let gate =
          legacyChecks && legacyChecks !== 'invalid'
            ? await runQualityChecks(legacyChecks, validationRoot, undefined, managedGate)
            : await runContractQualityChecks(
                frozenQualityChecks,
                validationRoot,
                undefined,
                managedGate,
              );
        if (rawOf(statePath) !== stateBeforeGate) {
          if (stateBeforeGate !== null) {
            await session.writer.writeFile('state.json', stateBeforeGate);
          }
          gate = {
            ...gate,
            ok: false,
            failure: {
              command: '[state-ownership]',
              exitCode: null,
              timedOut: false,
              outputTail: '项目机械检查修改了引擎状态；已恢复检查前快照',
            },
          };
          console.warn('⚠️  项目机械检查修改了 state.json，已恢复并拒绝本轮结果');
        }
        const skippedChecks =
          'skipped' in gate && Array.isArray(gate.skipped)
            ? gate.skipped.filter((value): value is string => typeof value === 'string')
            : [];
        if (skippedChecks.length > 0) {
          console.log(`⏭️  当前系统不适用的质量检查：${skippedChecks.join('、')}`);
        }
        const gateDiagnostic = gate.failure
          ? clipEvidenceDiagnostic(gate.failure.outputTail).trim()
          : '';
        let gateEnvironmentFailure: Error | null = null;
        if (validationCheckout) {
          try {
            await validationCheckout.assertCurrent('项目机械检查结束后');
          } catch (error) {
            gateEnvironmentFailure = error instanceof Error ? error : new Error(String(error));
          }
        }
        const gateHeadAfter = readGitHead(agentCwd);
        const gateArtifactChanged = !verificationHead || gateHeadAfter !== verificationHead;
        const gatePostconditionFailed = gateArtifactChanged || gateEnvironmentFailure !== null;
        await recordEvidence({
          type: 'gate-run',
          source: 'engine',
          at: new Date().toISOString(),
          runId,
          iteration: i,
          storyId: currentStory,
          ok: gate.ok,
          total: gate.total,
          ran: gate.ran,
          ms: gate.ms,
          ...(gatePostconditionFailed ? { accepted: false as const } : {}),
          ...(gate.failure
            ? {
                failedCommand: gate.failure.command,
                exitCode: gate.failure.exitCode,
                timedOut: gate.failure.timedOut,
                ...(gateDiagnostic ? { diagnosticTail: gateDiagnostic } : {}),
              }
            : {}),
        });
        if (
          gateArtifactChanged &&
          (await stopForValidationHeadChange(
            verificationHead,
            '项目机械检查结束后',
            'quality-check-finish',
            builderOutcome,
            gateHeadAfter,
          ))
        ) {
          break;
        }
        if (gateEnvironmentFailure !== null) {
          await stopForValidationEnvironmentFailure(gateEnvironmentFailure, builderOutcome);
          break;
        }
        if (commandSignals.exitCode !== null) {
          await recordIteration({
            ...(builderOutcome ? { builderOutcome } : {}),
            validatorOutcome: 'skipped',
          });
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          exitCode = commandSignals.exitCode;
          await tamperCheckBeforeExit(i);
          break;
        }
        if (!gate.ok) {
          const classification = validationOnly
            ? classifyValidationOnlyGateFailure(gate.failure!)
            : 'failed';
          if (validationOnly && classification === 'unverifiable') {
            console.error(
              `\n⏸️  ${currentStory} 的机械检查无法可靠完成（${gate.failure!.command}）；` +
                '保留实现候选且不增加重试，本次运行停止',
            );
            await recordIteration({ validatorOutcome: 'skipped', gateRejected: true });
            dashboard.setState({
              phase: 'idle',
              model: null,
              routeSource: null,
              storyDifficulty: null,
            });
            exitCode = 1;
            await tamperCheckBeforeExit(i);
            break;
          }
          console.error(
            `\n❌ 机械门禁未通过（${gate.failure!.command}），打回 ${currentStory} 待下轮重试`,
          );
          const st = tryReadState(statePath);
          let failedState: RunState | null = null;
          if (st) {
            const failed = applyGateFailure(st, currentStory, gate.failure!, new Date());
            const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
            await session.writer.writeFile('state.json', JSON.stringify(enabled.state, null, 2));
            failedState = enabled.state;
            if (enabled.changed)
              console.log(`⬆️  ${currentStory} 首次有效失败（gate），下轮起使用 escalation 模型`);
            await recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}),
              validatorOutcome: 'skipped',
              gateRejected: true,
              ...(enabled.changed ? { escalationTriggeredBy: 'gate' as const } : {}),
            });
          } else {
            // 缺失/损坏都不落盘打回：绝不覆盖可能损坏的文件（同 ensureStateFile 语义）
            console.warn(
              '⚠️  state.json 缺失或不可读，门禁打回未落盘；若文件损坏请运行 npx coding-x repair',
            );
          }
          if (!st) {
            await recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}),
              validatorOutcome: 'skipped',
              gateRejected: true,
            });
          }
          stallCount = 0; // 有 state 写入=有活动；打回预算由 MAX_RETRIES 独立约束
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          if (validationOnly) {
            console.error(
              `\n⏸️  ${currentStory} 的旧候选已被明确判定失败；` +
                validationOnlyRecoveryMessage(currentStory, failedState),
            );
            exitCode = validationOnlyFailureExit(
              before,
              failedState,
              currentGitHead,
              currentValidationEnvironmentDigest,
            );
            await tamperCheckBeforeExit(i);
            break;
          }
          continue;
        }
        if (
          derivedSnapshot &&
          'skipped' in gate &&
          Array.isArray(gate.skipped) &&
          verificationHead
        ) {
          const proofPolicy = candidateStoryValidationEnvironmentPolicy(
            tddConfig,
            qualityRead.contract,
            defaultBranchGitHead,
          );
          reusableFullGate = createFullGateProof(
            {
              contract: qualityRead.contract,
              headSha: verificationHead,
              defaultBranchGitHead,
              additionalRefs: proofPolicy.additionalRefs,
              referenceAliases: proofPolicy.referenceAliases,
            },
            {
              ...gate,
              skipped: gate.skipped.filter(
                (value): value is string => typeof value === 'string',
              ),
            },
          );
        }
      }

      // TDD 最终门禁：普通检查之后、Validator 之前重新校验受保护政策面并运行
      // coverageCheck。它不消费或信任宿主 hook 的结果。
      if (!agentBlocked && tddConfig && currentStory) {
        if (
          await stopForValidationHeadChange(
            verificationHead,
            'TDD 门禁启动前',
            'tdd-check-start',
            builderOutcome,
          )
        ) {
          break;
        }
        dashboard.setState({
          phase: 'gating',
          model: null,
          routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
        const stateBeforeTdd = rawOf(statePath);
        let tddGate = await runTddGate(tddConfig, validationRoot, undefined, {
          session,
          kind: 'tdd-check',
          ...(validationCheckout
            ? {
                environment: validationCheckout.processEnvironment,
                forbiddenExecutableRoot: agentCwd,
                gitExecutable: validationCheckout.gitExecutable,
              }
            : {}),
          termination: commandSignals.termination,
        });
        if (rawOf(statePath) !== stateBeforeTdd) {
          if (stateBeforeTdd !== null) {
            await session.writer.writeFile('state.json', stateBeforeTdd);
          }
          tddGate = {
            ...tddGate,
            ok: false,
            policyOk: false,
            failure: {
              code: 'source-scan-failed',
              command: '[state-ownership]',
              exitCode: null,
              timedOut: false,
              outputTail: 'TDD 门禁修改了引擎状态；已恢复检查前快照',
            },
          };
          console.warn('⚠️  TDD 门禁修改了 state.json，已恢复并拒绝本轮结果');
        }
        const diagnostic = tddGate.failure
          ? clipEvidenceDiagnostic(tddGate.failure.outputTail).trim()
          : '';
        let tddEnvironmentFailure: Error | null = null;
        if (validationCheckout) {
          try {
            await validationCheckout.assertCurrent('TDD 门禁结束后');
          } catch (error) {
            tddEnvironmentFailure = error instanceof Error ? error : new Error(String(error));
          }
        }
        const tddHeadAfter = readGitHead(agentCwd);
        const tddArtifactChanged = !verificationHead || tddHeadAfter !== verificationHead;
        const tddPostconditionFailed = tddArtifactChanged || tddEnvironmentFailure !== null;
        await recordEvidence({
          type: 'tdd-gate',
          source: 'engine',
          at: new Date().toISOString(),
          phase: 'post-builder',
          iteration: i,
          storyId: currentStory,
          ok: tddGate.ok,
          policyOk: tddGate.policyOk,
          commandRan: tddGate.commandRan,
          ...(tddGate.commandOk === null ? {} : { commandOk: tddGate.commandOk }),
          runId,
          ms: tddGate.ms,
          ...(tddPostconditionFailed ? { accepted: false as const } : {}),
          ...(tddGate.failure
            ? {
                failureCode: tddGate.failure.code,
                failedCommand: tddGate.failure.command,
                exitCode: tddGate.failure.exitCode,
                timedOut: tddGate.failure.timedOut,
                diagnosticTail: diagnostic || 'TDD 门禁失败',
              }
            : {}),
        });
        if (
          tddArtifactChanged &&
          (await stopForValidationHeadChange(
            verificationHead,
            'TDD 门禁结束后',
            'tdd-check-finish',
            builderOutcome,
            tddHeadAfter,
          ))
        ) {
          break;
        }
        if (tddEnvironmentFailure !== null) {
          await stopForValidationEnvironmentFailure(tddEnvironmentFailure, builderOutcome);
          break;
        }
        if (commandSignals.exitCode !== null) {
          await recordIteration({
            ...(builderOutcome ? { builderOutcome } : {}),
            validatorOutcome: 'skipped',
          });
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          exitCode = commandSignals.exitCode;
          await tamperCheckBeforeExit(i);
          break;
        }
        if (!tddGate.ok) {
          const classification = validationOnly
            ? classifyValidationOnlyTddFailure(tddGate.failure!)
            : 'failed';
          if (validationOnly && classification === 'unverifiable') {
            console.error(
              `\n⏸️  ${currentStory} 的 TDD 门禁无法可靠完成（${tddGate.failure!.command}）；` +
                '保留实现候选且不增加重试，本次运行停止',
            );
            await recordIteration({ validatorOutcome: 'skipped', gateRejected: true });
            dashboard.setState({
              phase: 'idle',
              model: null,
              routeSource: null,
              storyDifficulty: null,
            });
            exitCode = 1;
            await tamperCheckBeforeExit(i);
            break;
          }
          console.error(
            `\n❌ TDD 门禁未通过（${tddGate.failure!.command}），打回 ${currentStory} 待下轮重试`,
          );
          const st = tryReadState(statePath);
          let failedState: RunState | null = null;
          if (st) {
            const failed = applyGateFailure(st, currentStory, tddGate.failure!, new Date());
            const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
            await session.writer.writeFile('state.json', JSON.stringify(enabled.state, null, 2));
            failedState = enabled.state;
            if (enabled.changed)
              console.log(`⬆️  ${currentStory} 首次有效失败（gate），下轮起使用 escalation 模型`);
            await recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}),
              validatorOutcome: 'skipped',
              gateRejected: true,
              ...(enabled.changed ? { escalationTriggeredBy: 'gate' as const } : {}),
            });
          } else {
            console.warn(
              '⚠️  state.json 缺失或不可读，TDD 门禁打回未落盘；若文件损坏请运行 npx coding-x repair',
            );
          }
          if (!st) {
            await recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}),
              validatorOutcome: 'skipped',
              gateRejected: true,
            });
          }
          stallCount = 0;
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          if (validationOnly) {
            console.error(
              `\n⏸️  ${currentStory} 的旧候选已被明确判定失败；` +
                validationOnlyRecoveryMessage(currentStory, failedState),
            );
            exitCode = validationOnlyFailureExit(
              before,
              failedState,
              currentGitHead,
              currentValidationEnvironmentDigest,
            );
            await tamperCheckBeforeExit(i);
            break;
          }
          continue;
        }
      }

      // Validator
      if (
        !agentBlocked &&
        currentStory &&
        (await stopForValidationHeadChange(
          verificationHead,
          'Validator 启动前',
          'validator-start',
          builderOutcome,
        ))
      ) {
        break;
      }
      const validatorChoice = resolveValidatorModel({
        cliOverride: cfg.validatorModel,
        config: preflight.config,
      });
      const validatorModel = validatorChoice.model;
      const structuredValidation = !cfg.legacyValidatorProtocolForTests;
      // Runner 宿主隔离绑定（ADR-025）：真实 profile/canary 链建立后按本轮解析结果赋值；
      // 测试注入沿用 receipt fixture 模式。缺失时 issueValidationReceipt 失败关闭。
      let roundValidatorRunnerBinding: ValidationRunnerBinding | undefined =
        cfg.validatorRunnerBindingForTests;
      const validatorStateSnapshot = tryReadState(statePath);
      const currentValidatorStateSnapshot = currentStory
        ? validatorStateSnapshot?.[currentStory]
        : undefined;
      const structuredCandidateReady =
        !structuredValidation ||
        (!!currentStoryObj &&
          !!currentValidatorStateSnapshot?.passes &&
          !currentValidatorStateSnapshot.blocked);
      const validatorWillRun =
        !!validatorBase &&
        !skipValidator &&
        !agentBlocked &&
        structuredCandidateReady &&
        (!structuredValidation || !!currentStoryObj);
      dashboard.setState({
        phase: 'validating',
        model: validatorWillRun ? (validatorModel ?? null) : null,
        routeSource: validatorWillRun ? validatorChoice.source : null,
        storyDifficulty: currentStoryObj?.difficulty ?? null,
      });
      let validatorOutcome: 'completed' | 'timeout' | 'error' | 'skipped' | undefined;
      let validatorActuallyRan = false;
      let validatorRollback = false;
      let validationRollback = false;
      let validationUnverifiable = false;
      let validationReceipt = false;
      let validatorEscalationTriggered = false;
      let validatorDiagnostic: string | undefined;
      let validationProtocol: 'passed' | 'failed' | 'invalid' | undefined;
      let validationTarget: ValidationTargetEvidence | undefined;
      let validationHeadFailure: string | null = null;
      let validationHeadAbort: ValidationHeadAbortEvidence | undefined;
      let validationProtocolError:
        | {
            code: LoopValidationProtocolErrorCode;
            diagnostic: string;
          }
        | undefined;
      let validatorStateMutation = false;
      // Validator 宿主隔离（ADR-025）：真实链按本轮建立；bypass 测试模式沿用注入绑定。
      let validatorIsolation: ValidatorHostIsolationOutcome | null = null;
      let validatorProfileEvidence: ValidatorProfileEvidence | undefined;
      const settleValidatorIsolation = (): void => {
        if (!validatorIsolation) return;
        const cleanup = validatorIsolation.dispose();
        validatorIsolation = null;
        if (cleanup.status !== 'removed') {
          throw new WorkspaceSafetyError(
            'isolated',
            `Validator 临时身份域未能安全清理（${cleanup.status}）：${cleanup.reason}`,
          );
        }
      };
      const rejectProtocol = (code: LoopValidationProtocolErrorCode, diagnostic: string) => {
        validationProtocol = 'invalid';
        validationProtocolError = {
          code,
          diagnostic: clipEvidenceDiagnostic(diagnostic),
        };
        console.warn(
          `⚠️  ${currentStory ?? '当前 story'} Validator 结构化结果无效（${code}）：${diagnostic}`,
        );
      };
      const settleValidationCheckoutBeforeClaim = async (): Promise<boolean> => {
        let checkoutStillCurrent = true;
        if (validationCheckout && cleanValidationManager) {
          try {
            cfg.beforeValidationCheckoutCleanupForTests?.(validationCheckout.root);
            await validationCheckout.assertCurrent('签发凭证清理前');
          } catch (error) {
            throwIfValidationContainmentUnverifiable(error);
            rejectProtocol(
              'artifact-changed',
              `验证检出在接受 Validator 结论前已变化：${error instanceof Error ? error.message : String(error)}`,
            );
            validationUnverifiable = true;
            checkoutStillCurrent = false;
          }
          const cleanup = cleanValidationManager.dispose();
          validationCheckout = null;
          if (cleanup && cleanup.status !== 'removed') {
            throw new WorkspaceSafetyError(
              'isolated',
              `验证检出未能在接受 Validator 结论前安全清理：${describeCleanValidationCheckoutCleanup(cleanup)}`,
            );
          }
        }
        const receiptHead = readGitHead(agentCwd);
        if (receiptHead !== verificationHead) {
          const diagnostic =
            `接受 Validator 结论前项目 Git HEAD 与本轮检查目标不一致（期望 ${verificationHead ?? 'unavailable'}，` +
            `当前 ${receiptHead ?? 'unavailable'}）`;
          validationHeadAbort = validationHeadAbortOf(
            'validator-finish',
            verificationHead,
            receiptHead,
            diagnostic,
          );
          rejectProtocol('artifact-changed', diagnostic);
          validationUnverifiable = true;
          checkoutStillCurrent = false;
        }
        return checkoutStillCurrent;
      };
      const rejectClaimForSourceHeadChange = (context: string, actualHead: string | null): false => {
        const diagnostic =
          `${context}项目 Git HEAD 与本轮检查目标不一致（期望 ${verificationHead ?? 'unavailable'}，` +
          `当前 ${actualHead ?? 'unavailable'}）`;
        validationHeadAbort = validationHeadAbortOf(
          'validator-finish',
          verificationHead,
          actualHead,
          diagnostic,
        );
        rejectProtocol('artifact-changed', diagnostic);
        validationUnverifiable = true;
        return false;
      };
      const sourceHeadStillCurrentForClaim = (context: string): boolean => {
        const actualHead = readGitHead(agentCwd);
        return actualHead === verificationHead
          ? true
          : rejectClaimForSourceHeadChange(context, actualHead);
      };
      const writeValidatorClaimState = async (
        nextState: RunState,
        previousState: RunState,
      ): Promise<boolean> => {
        if (!sourceHeadStillCurrentForClaim('写入 Validator 结论前')) return false;
        await session.writer.writeFile('state.json', JSON.stringify(nextState, null, 2));
        await cfg.afterValidatorClaimStateWriteForTests?.();
        const actualHead = readGitHead(agentCwd);
        if (actualHead === verificationHead) return true;

        // state.json 与 Git HEAD 不是同一个原子事务。写入后再复核；若提交已变化，先恢复
        // 调用前候选，再把本轮 claim 判为不可验证，避免旧提交的 failed/passed 污染新提交。
        await session.writer.writeFile('state.json', JSON.stringify(previousState, null, 2));
        return rejectClaimForSourceHeadChange('写入 Validator 结论后', actualHead);
      };

      if (structuredValidation && !structuredCandidateReady) {
        validatorOutcome = 'skipped';
      } else if (!validatorBase) {
        console.error('❌ validator.md 不存在，本轮无法签发验收凭证');
        validatorOutcome = 'skipped';
        rejectProtocol('validator-unavailable', 'validator.md 不存在，本轮无法启动 Validator');
      } else if (skipValidator) {
        console.warn('⚠️  prd.json 快照写回失败，跳过本轮 validator（磁盘验收标准不可信）');
        validatorOutcome = 'skipped';
        rejectProtocol('environment-unverifiable', 'prd.json 快照不可信，不能启动 Validator');
      } else if (!agentBlocked && (!structuredValidation || currentStoryObj)) {
        console.log(
          `🧠 validator 实际模型: ${validatorModel ?? 'runner 默认'} [${validatorChoice.source}]`,
        );
        const validatorStateBefore = validatorStateSnapshot;
        const currentValidatorStateBefore = currentStory
          ? validatorStateBefore?.[currentStory]
          : undefined;
        const stateRawBeforeValidator = rawOf(statePath);
        let validationRequest: ValidationRequest | null = null;
        let validatorPrompt = validatorBase;
        let canStartValidator = true;
        let validatorHead: string | null = null;

        if (currentStoryObj) {
          cfg.beforeValidatorRequestForTests?.(validationRoot);
          const sourceHead = readGitHead(agentCwd);
          const headDiagnostic = await observeValidationHead(
            verificationHead,
            'Validator 请求建立前',
            sourceHead,
          );
          if (headDiagnostic) {
            canStartValidator = false;
            validatorOutcome = 'skipped';
            validationHeadFailure = headDiagnostic;
            validationHeadAbort = validationHeadAbortOf(
              'validator-start',
              verificationHead,
              sourceHead,
              headDiagnostic,
            );
            console.error(`⏸️  ${headDiagnostic}；不启动 Validator`);
          } else {
            try {
              await validationCheckout?.assertCurrent('Validator 请求建立前');
            } catch (error) {
              throwIfValidationContainmentUnverifiable(error);
              canStartValidator = false;
              validatorOutcome = 'skipped';
              validationHeadFailure = error instanceof Error ? error.message : String(error);
              console.error(`⏸️  ${validationHeadFailure}；不启动 Validator`);
            }
            validatorHead = canStartValidator ? readGitHead(validationRoot) : null;
            if (!validatorHead) {
              canStartValidator = false;
              validatorOutcome = 'skipped';
              validationHeadFailure ??= 'Validator 干净检出无法读取精确 HEAD';
            }
          }
          if (canStartValidator && structuredValidation && !cfg.validatorRunnerBindingForTests) {
            // 引擎自有 canary 执行器（ADR-025）：与验证同一密封 profile 的有界反测调用；
            // 结论只来自引擎机械观察，执行器内部故障不产出证据（canary-missing 失败关闭）。
            let canaryDurationMs: number | undefined;
            const engineCanaryProvider: ValidatorCanaryProvider = async (profile) => {
              const run = await runValidatorCanary(profile, {
                session,
                story: {
                  storyId: currentStoryObj.id,
                  acceptanceHash: acceptanceHash(
                    currentStoryObj.id,
                    currentStoryObj.acceptanceCriteria,
                  ),
                  checkCount: currentStoryObj.acceptanceCriteria.length,
                  gitHead: validatorHead!,
                  storyBaseGitHead: storyChangeManifest!.storyBaseGitHead,
                  changeManifestDigest: storyChangeManifest!.digest,
                  changedPathCount: storyChangeManifest!.changedPathCount,
                },
                timeoutMs: Math.min(cfg.valTimeoutMs, 180_000),
                termination: commandSignals.termination,
                ...(validationCheckout && !cfg.unsafeAllowProjectScopedRunnerForValidationTests
                  ? { forbiddenExecutableRoot: projectRoot }
                  : {}),
              });
              canaryDurationMs = run.durationMs;
              if (run.diagnostic) {
                console.warn(`⚠️  Validator 隔离反测：${run.diagnostic}`);
              }
              return run.evidence;
            };
            validatorIsolation = await establishValidatorHostIsolation({
              session,
              runner: runKind,
              model: validatorModel ?? null,
              projectRoot,
              engineWorkspaceRoot: workspace,
              cleanCheckoutRoot: validationRoot,
              commandContractSha256: qualityRead.digest.replace(/^sha256:/u, ''),
              termination: commandSignals.termination,
              ...(cfg.validatorRunnerObservationForTests
                ? { observationForTests: cfg.validatorRunnerObservationForTests }
                : {}),
              canaryProvider: cfg.validatorCanaryForTests ?? engineCanaryProvider,
            });
            if (validatorIsolation.status === 'unverifiable') {
              validatorProfileEvidence = {
                policyVersion: VALIDATOR_RUNNER_PROFILE_POLICY_VERSION,
                resolution: validatorIsolation.code,
                ...(validatorIsolation.profileDigest
                  ? { profileDigest: validatorIsolation.profileDigest }
                  : {}),
              };
              canStartValidator = false;
              validatorOutcome = 'skipped';
              rejectProtocol(
                'environment-unverifiable',
                `Validator Runner 宿主隔离无法证明（${validatorIsolation.code}）：` +
                  validatorIsolation.message,
              );
              settleValidatorIsolation();
            } else {
              validatorProfileEvidence = {
                policyVersion: validatorIsolation.profile.policyVersion,
                resolution: 'ready',
                runnerVersion: validatorIsolation.profile.runnerVersion,
                profileDigest: validatorIsolation.profile.profileDigest,
                canaryEvidenceDigest: validatorCanaryEvidenceDigest(validatorIsolation.canary),
                ...(canaryDurationMs !== undefined ? { canaryDurationMs } : {}),
              };
              roundValidatorRunnerBinding = validatorIsolation.binding;
            }
          }
          if (canStartValidator && storyChangeManifest === null) {
            canStartValidator = false;
            validatorOutcome = 'skipped';
            rejectProtocol(
              'environment-unverifiable',
              '引擎未生成绑定固定 Story 起点的变化摘要，不能启动 Validator',
            );
          }
          if (canStartValidator) {
            validationRequest = createValidationRequest(
              currentStoryObj,
              workspace,
              {
                gitHead: validatorHead,
                storyBaseGitHead: storyChangeManifest!.storyBaseGitHead,
                changeManifestDigest: storyChangeManifest!.digest,
                changedPathCount: storyChangeManifest!.changedPathCount,
              },
              undefined,
              validatorIsolation?.status === 'ready' ? validatorIsolation.resultPath : undefined,
              reusableFullGate ? engineQualityGateEvidence(reusableFullGate) : undefined,
            );
            if (structuredValidation) {
              validationTarget = {
                requestId: validationRequest.requestId,
                storyId: validationRequest.storyId,
                acceptanceHash: validationRequest.acceptanceHash,
                gitHead: validationRequest.gitHead,
                storyBaseGitHead: validationRequest.storyBaseGitHead,
                changeManifestDigest: validationRequest.changeManifestDigest,
                changedPathCount: validationRequest.changedPathCount,
              };
              validatorPrompt = renderValidatorInstruction(validatorBase, validationRequest);
              try {
                await clearValidationResultWithWriter(session.writer);
              } catch (err) {
                if (err instanceof WorkspaceSafetyError) throw err;
                canStartValidator = false;
                validatorOutcome = 'skipped';
                rejectProtocol(
                  'result-cleanup-failed',
                  `无法清理上一轮 validation result：${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
          }
        }

        if (canStartValidator && validationRequest === null) {
          canStartValidator = false;
          validatorOutcome = 'skipped';
          rejectProtocol('candidate-not-passing', '无法建立绑定当前 Story 与提交的 Validator 请求');
        }
        // 任何预调用失败路径都必须先收口临时身份域；清理无法证明成功时失败关闭。
        if (!canStartValidator) settleValidatorIsolation();

        if (canStartValidator) {
          validatorActuallyRan = true;
          const readyIsolation =
            validatorIsolation && validatorIsolation.status === 'ready' ? validatorIsolation : null;
          let val: Awaited<ReturnType<typeof runAgent>>;
          try {
            val = await runAgent({
              kind: runKind,
              prompt: validatorPrompt,
              cwd: validationRoot,
              timeoutMs: cfg.valTimeoutMs,
              ...(readyIsolation
                ? { sealedInvocation: readyIsolation.sealedInvocation }
                : {
                    model: validatorModel,
                    env: validationCheckout
                      ? {
                          ...validationCheckout.processEnvironment,
                          ...validationRunnerEnvironment,
                          CODING_X_WORKSPACE: agentEnv.CODING_X_WORKSPACE,
                          CODING_X_PROJECT_ROOT: validationRoot,
                        }
                      : { ...agentEnv, CODING_X_PROJECT_ROOT: validationRoot },
                    inheritProcessEnvironment: validationCheckout ? false : undefined,
                  }),
              forbiddenExecutableRoot:
                validationCheckout && !cfg.unsafeAllowProjectScopedRunnerForValidationTests
                  ? projectRoot
                  : undefined,
              ...(cfg.validatorOutputForTests ? { output: cfg.validatorOutputForTests } : {}),
              managed: {
                session,
                termination: commandSignals.termination,
                operation: {
                  kind: 'validator',
                  delegation: 'validator-v1',
                  storyId: validationRequest!.storyId,
                  requestId: validationRequest!.requestId,
                  acceptanceHash: validationRequest!.acceptanceHash,
                  checkCount: validationRequest!.acceptanceCriteria.length,
                  gitHead: validationRequest!.gitHead!,
                  storyBaseGitHead: validationRequest!.storyBaseGitHead!,
                  changeManifestDigest: validationRequest!.changeManifestDigest,
                  changedPathCount: validationRequest!.changedPathCount,
                },
              },
            });
          } catch (error) {
            // 受管进程失败（containment 由 runAgent 的受管 operation 裁决）：尽力收口
            // 临时身份域；原始失败优先上抛，域保留事实随警告与 retention 分类留存。
            try {
              settleValidatorIsolation();
            } catch (retention) {
              console.warn(
                `⚠️  ${retention instanceof Error ? retention.message : String(retention)}`,
              );
            }
            throw error;
          }
          validatorOutcome = outcomeOf(val);
          validatorInvocation = invocationOf(val, validatorOutcome);
          const stateRawAfterValidator = rawOf(statePath);
          const validatorOwnership = await restoreEngineOwnership(
            'validator',
            validatorStateBefore,
          );

          if (structuredValidation && stateRawAfterValidator !== stateRawBeforeValidator) {
            validatorStateMutation = true;
            if (stateRawBeforeValidator !== null) {
              await session.writer.writeFile('state.json', stateRawBeforeValidator);
            }
            console.warn(
              `⚠️  ${currentStory} Validator 修改了 state.json，已恢复调用前快照并拒绝本轮结论`,
            );
          }
          const validatorHeadAfter = readGitHead(validationRoot);
          const sourceHeadAfter = readGitHead(agentCwd);
          let validatorHeadDiagnostic = await observeValidationHead(
            verificationHead,
            'Validator 返回后',
            sourceHeadAfter,
          );
          try {
            await validationCheckout?.assertCurrent('Validator 返回后');
          } catch (error) {
            throwIfValidationContainmentUnverifiable(error);
            validatorHeadDiagnostic = error instanceof Error ? error.message : String(error);
          }
          if (validatorHeadAfter !== verificationHead) {
            validatorHeadDiagnostic =
              `Validator 返回后干净检出 HEAD 与目标不一致（期望 ${verificationHead}，` +
              `当前 ${validatorHeadAfter ?? 'unavailable'}）`;
          }

          if (validatorHeadDiagnostic) {
            const observedHeadAfter =
              sourceHeadAfter !== verificationHead ? sourceHeadAfter : validatorHeadAfter;
            validationHeadAbort = validationHeadAbortOf(
              'validator-finish',
              verificationHead,
              observedHeadAfter,
              validatorHeadDiagnostic,
            );
            if (structuredValidation && validationRequest) {
              try {
                await clearValidationResultWithWriter(session.writer);
              } catch (err) {
                if (err instanceof WorkspaceSafetyError) throw err;
                console.warn(
                  `⚠️  validation result 清理失败，下轮会再次拒绝旧文件：${err instanceof Error ? err.message : String(err)}`,
                );
              }
            }
            rejectProtocol('artifact-changed', validatorHeadDiagnostic);
            settleValidatorIsolation();
          } else if (!structuredValidation) {
            // 历史单测专用兼容路径：生产 CLI 永不进入。旧 Validator 直接写 state，
            // 仍按 v0.25 receipt 语义恢复引擎字段并判定。
            if (validatorOutcome !== 'completed') {
              validatorRollback = await rollbackIfUnvalidatedPass('validator', val);
            } else if (
              currentStory &&
              currentValidatorStateBefore &&
              !validatorOwnership.storyMissing
            ) {
              let stateAfter = tryReadState(statePath);
              const validatorStateAfter = stateAfter?.[currentStory];
              const rejected =
                !!validatorStateAfter &&
                !validatorStateAfter.passes &&
                validatorStateAfter.retryCount > currentValidatorStateBefore.retryCount;
              if (rejected) {
                const diagnostic = clipEvidenceDiagnostic(validatorStateAfter.notes).trim();
                if (diagnostic) validatorDiagnostic = diagnostic;
                validatorEscalationTriggered = await triggerEscalation('validator');
              }
              if (
                stateAfter &&
                currentValidatorStateBefore.passes &&
                !currentValidatorStateBefore.blocked &&
                validatorStateAfter?.passes &&
                !validatorStateAfter.blocked &&
                (await settleValidationCheckoutBeforeClaim())
              ) {
                stateAfter = tryReadState(statePath);
                if (stateAfter) {
                  const issued =
                    validationRequest && currentStoryObj
                      ? issueValidationReceipt(
                          stateAfter,
                          currentStoryObj,
                          validationRequest,
                          roundValidationEnvironmentDigest,
                          roundValidatorRunnerBinding,
                        )
                      : { state: stateAfter, changed: false };
                  if (issued.changed) {
                    await session.writer.writeFile(
                      'state.json',
                      JSON.stringify(issued.state, null, 2),
                    );
                    validationReceipt = true;
                    console.log(`✅ ${currentStory} validator 已正常完成，引擎验收凭证已签发`);
                  }
                }
              }
            }
          } else if (validationRequest) {
            const protocol = readValidationResult(
              validationRequest.resultPath,
              validationRequest,
              validatorHeadAfter,
            );
            try {
              await clearValidationResultWithWriter(session.writer);
            } catch (err) {
              if (err instanceof WorkspaceSafetyError) throw err;
              // nonce 已阻止下轮复用；留存清理故障但不把已完成的当前绑定判成假失败。
              console.warn(
                `⚠️  validation result 清理失败，下轮会再次拒绝旧文件：${err instanceof Error ? err.message : String(err)}`,
              );
            }
            // claim 已读入内存；接受结论前先收口临时身份域（含预置认证），失败即不可采信。
            settleValidatorIsolation();

            if (validatorOutcome !== 'completed') {
              rejectProtocol('agent-aborted', `Validator ${abortDesc(val)}`);
            } else if (validatorStateMutation) {
              rejectProtocol('state-mutated', 'Validator 修改了引擎独占的 state.json');
            } else if (!protocol.ok) {
              rejectProtocol(protocol.code, protocol.diagnostic);
            } else if (!(await settleValidationCheckoutBeforeClaim())) {
              // 结论返回后、引擎采用前的检出或 source HEAD 已变化；拒绝当前 claim。
            } else {
              await cfg.afterValidationCheckoutSettlementForTests?.();
              if (!sourceHeadStillCurrentForClaim('记录 Validator 结论前')) {
                // 检出已收口后 source HEAD 仍可能变化；拒绝旧提交 claim。
              } else if (currentStory && validatorStateBefore && currentValidatorStateBefore) {
              await recordEvidence({
                type: 'validation-claim',
                source: 'validator',
                at: new Date().toISOString(),
                iteration: i,
                requestId: protocol.result.requestId,
                storyId: protocol.result.storyId,
                acceptanceHash: protocol.result.acceptanceHash,
                gitHead: protocol.result.gitHead,
                storyBaseGitHead: protocol.result.storyBaseGitHead,
                changeManifestDigest: protocol.result.changeManifestDigest,
                changedPathCount: protocol.result.changedPathCount,
                verdict: protocol.result.verdict,
                checks: protocol.result.checks,
                summary: protocol.result.summary,
              });
              if (protocol.result.verdict === 'failed') {
                const failed = applyValidatorFailure(
                  validatorStateBefore,
                  currentStory,
                  protocol.result,
                  new Date(),
                );
                const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
                if (await writeValidatorClaimState(enabled.state, validatorStateBefore)) {
                  validationProtocol = 'failed';
                  validatorEscalationTriggered = enabled.changed;
                  if (enabled.changed) {
                    console.log(
                      `⬆️  ${currentStory} 首次有效失败（validator），下轮起使用 escalation 模型`,
                    );
                  }
                  const diagnostic = clipEvidenceDiagnostic(
                    enabled.state[currentStory]?.notes ?? '',
                  ).trim();
                  if (diagnostic) validatorDiagnostic = diagnostic;
                }
              } else if (
                !currentValidatorStateBefore.passes ||
                currentValidatorStateBefore.blocked
              ) {
                rejectProtocol(
                  'candidate-not-passing',
                  'Builder 未留下可验收的 passes=true 候选态',
                );
              } else {
                const passed = applyValidatorSuccess(validatorStateBefore, currentStory);
                const issued = currentStoryObj
                  ? issueValidationReceipt(
                      passed,
                      currentStoryObj,
                      validationRequest,
                      roundValidationEnvironmentDigest,
                      roundValidatorRunnerBinding,
                    )
                  : { state: passed, changed: false };
                if (issued.changed) {
                  if (await writeValidatorClaimState(issued.state, validatorStateBefore)) {
                    validationProtocol = 'passed';
                    validationReceipt = true;
                    console.log(`✅ ${currentStory} 结构化验收目标匹配，引擎验收凭证已签发`);
                  }
                } else if (!validationProtocolError) {
                  rejectProtocol('candidate-not-passing', '引擎无法对当前候选态签发验收凭证');
                }
              }
              } else {
                rejectProtocol('candidate-not-passing', '当前 story 或调用前状态缺失');
              }
            }
          }
        }
      } else if (agentBlocked) {
        validatorOutcome = 'skipped';
      } else if (structuredValidation && !currentStoryObj) {
        validatorOutcome = 'skipped';
        rejectProtocol('candidate-not-passing', '无法从可信 PRD 快照定位当前 story');
      }

      // 结构化 Validator 的进程、协议与凭证由单一分类器裁决。无法验证时无论候选
      // 是本轮新建还是跨轮保留，都不清 passes、不增加 retry，并立即以 exit 5 停止。
      if (structuredValidation) {
        if (validationHeadFailure && !validationProtocolError) {
          rejectProtocol('artifact-changed', validationHeadFailure);
        }
        validationUnverifiable =
          classifyValidatorAttempt({
            expected: !agentBlocked && currentStory !== null && structuredCandidateReady,
            runnerOutcome: validatorOutcome,
            protocol: validationProtocol,
            receiptIssued: validationReceipt,
          }) === 'unverifiable';
        if (validationUnverifiable) {
          await persistCurrentValidatorUnverifiable(verificationHead);
        }
      } else if (!validationReceipt && !validatorRollback && !validationOnly) {
        validationRollback = await rollbackPendingValidation(
          validatorOutcome === 'completed' ? 'validator 未确认候选通过' : 'validator 未完整执行',
        );
      }

      // 兜底收口：任何未覆盖分支泄漏的临时身份域在此清理；健康域幂等无副作用。
      settleValidatorIsolation();

      // 每轮一条 iteration 不变式：continue 路径（builder 异常/no-op/门禁打回）各自留痕后跳出，
      // 走到这里的轮在此记录——evidence 时间线零空洞（v0.22.0，dogfood 发现 B）。
      await recordIteration({
        validatorRan: validatorActuallyRan,
        validatorModel: validatorModel ?? null,
        validatorRouteSource: validatorChoice.source,
        skippedValidator: skipValidator,
        agentBlocked,
        ...(builderOutcome ? { builderOutcome } : {}),
        ...(validatorOutcome ? { validatorOutcome } : {}),
        ...(validatorRollback ? { abortRollback: { storyId: currentStory! } } : {}),
        ...(validationRollback ? { validationRollback: true as const } : {}),
        ...(validationHeadAbort ? { validationHeadAbort } : {}),
        ...(validationReceipt ? { validationReceipt: true as const } : {}),
        ...(validationProtocol ? { validationProtocol } : {}),
        ...(validationTarget ? { validationTarget } : {}),
        ...(validationProtocolError ? { validationProtocolError } : {}),
        ...(validatorStateMutation ? { validatorStateMutation: true as const } : {}),
        ...(validatorEscalationTriggered ? { escalationTriggeredBy: 'validator' as const } : {}),
        ...(validatorDiagnostic ? { validatorDiagnostic } : {}),
        ...(validatorProfileEvidence ? { validatorProfile: validatorProfileEvidence } : {}),
      });

      if (commandSignals.exitCode !== null) {
        exitCode = commandSignals.exitCode;
        await tamperCheckBeforeExit(i);
        break;
      }

      if (!(await qualityContractStillCurrent())) {
        exitCode = 2;
        await tamperCheckBeforeExit(i);
        break;
      }

      if (validationUnverifiable) {
        const reason = validationHeadFailure
          ? '验收前无法确认当前提交身份'
          : 'Validator 结果无法可靠验证';
        console.error(`\n⏸️  ${currentStory} 的${reason}；保留实现候选且不增加重试，本次运行停止`);
        dashboard.setState({
          phase: 'blocked',
          model: null,
          routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
        exitCode = 5;
        await tamperCheckBeforeExit(i);
        break;
      }

      if (validationOnly && validationProtocol === 'failed') {
        const failedState = tryReadState(statePath);
        console.error(
          `\n⏸️  ${currentStory} 的旧候选已被 Validator 明确判定失败；` +
            validationOnlyRecoveryMessage(currentStory, failedState),
        );
        exitCode = validationOnlyFailureExit(
          before,
          failedState,
          currentGitHead,
          currentValidationEnvironmentDigest,
        );
        await tamperCheckBeforeExit(i);
        break;
      }

      if (validatorOutcome === 'timeout' || validatorOutcome === 'error' || validationRollback) {
        if (stalled()) {
          await tamperCheckBeforeExit(i);
          break;
        }
      } else {
        stallCount = 0; // 正常走完的轮（含 agentBlocked/skipValidator 跳过轮）清零
      }

      // Completion check
      dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
      const afterRead = await guard.read();
      await recordTamper(afterRead, i);
      const after = afterRead.prd;
      let afterState = after ? readRunState(statePath, after) : null;
      let afterGitHead: string | null = null;
      if (after && afterState) {
        const reconciled = await reconcileAtCurrentHead(after, afterState, 'Validator 返回后');
        if (!reconciled) {
          exitCode = 2;
          break;
        }
        afterState = reconciled.state;
        afterGitHead = reconciled.gitHead;
      }
      if (
        after &&
        afterState &&
        afterGitHead &&
        allStoriesResolvedAt(
          after,
          afterState,
          afterGitHead,
          storyValidationEnvironmentAt(afterGitHead),
        )
      ) {
        exitCode = await completeResolvedRunWithDashboard();
        break;
      }
    }
    // 循环终轮收口（第五处，ADR-007 交互残洞）：builder 异常/no-op 的 continue 路径
    // （:238/:273）在 i === maxIterations 且未触发 stall 熔断时自然耗尽本次运行，
    // 中间不会再有下一轮轮首读——本轮若被篡改，只有这里补一次 guard.read() 才能恢复/存档。
    // 对四个既有 break 出口而言是安全的幂等重复调用：它们各自最后一步已是同轮读，
    // break 前后都未再写 prd.json，磁盘已等于快照，这里的 read() 真无操作（prd-guard.ts:115）。
    if (commandSignals.exitCode !== null) exitCode = commandSignals.exitCode;
    const closeRead = await guard.read();
    await recordTamper(closeRead, cfg.maxIterations);
    const tamper = guard.summary();
    if (tamper.count > 0) {
      console.warn(
        `\n⚠️  运行期间检测到 prd.json 被修改 ${tamper.count} 次（引擎已按启动快照恢复并继续）。` +
          (tamper.archives.length > 0
            ? `篡改存档：\n${tamper.archives.map((a) => `  - ${a}`).join('\n')}`
            : '（文件删除类篡改无存档）'),
      );
    }
    // closeRead 是最终一次 PRD guard 读：只要启动时建立过可信快照，即使磁盘恢复
    // 失败也必须用快照出报告。guard 从未建立快照的异常输入才保留磁盘诊断回退。
    const sameReadyObservation = (
      expected: StoryValidationObservation,
      observed: StoryValidationObservation,
    ): boolean =>
      expected.status === 'ready' &&
      observed.status === 'ready' &&
      expected.observationToken === observed.observationToken;
    // 最终清理失败会立刻把 session 隔离，之后不能再写报告。先原子写入一个明确的
    // “尚未完成安全收口”版本；只有临时检出实际清理成功后，才用当前观察覆盖成最终报告。
    await writePendingCloseoutReport(closeRead.prd);

    const cleanValidationCleanup = cleanValidationManager?.dispose();
    const cleanValidationCleanupFailed =
      cleanValidationCleanup !== null &&
      cleanValidationCleanup !== undefined &&
      cleanValidationCleanup.status !== 'removed';
    if (cleanValidationCleanupFailed) {
      console.error(
        `❌ 本地验证临时目录未能安全清理，` +
          describeCleanValidationCheckoutCleanup(cleanValidationCleanup),
      );
      if (!pendingCloseoutReportWritten) {
        console.warn('⚠️  现有 report.html 可能来自更早运行，不代表本次安全收口结果');
      }
      exitCode = 2;
    }

    // 循环结束生成静态验证报告（进行中态也诚实存档）。只有最终临时目录已经安全
    // 收口时才写入可供阅读的当前观察；报告失败只 warn，不改写真实循环退出码。
    if (!cleanValidationCleanupFailed) {
      try {
      const beforeWrite = await observeCurrentStoryValidation();
      let report = await writeReportWithWriter(
        session.writer,
        new Date(),
        reportOptionsFor(closeRead.prd, beforeWrite),
      );
      if (report.status === 'written' && beforeWrite.status === 'ready') {
        const afterWrite = await observeCurrentStoryValidation();
        if (!sameReadyObservation(beforeWrite, afterWrite)) {
          report = await writeReportWithWriter(
            session.writer,
            new Date(),
            reportOptionsFor(closeRead.prd, afterWrite),
          );
          if (report.status === 'written' && afterWrite.status === 'ready') {
            const afterRewrite = await observeCurrentStoryValidation();
            if (!sameReadyObservation(afterWrite, afterRewrite)) {
              report = await writeReportWithWriter(
                session.writer,
                new Date(),
                reportOptionsFor(
                  closeRead.prd,
                  null,
                  '报告持久化期间 Story 验收状态持续变化，已强制撤销全部绿灯',
                ),
              );
            }
          }
        }
      }
      if (report.status === 'written') {
        console.log(`📄 验证报告: ${report.path}`);
      } else {
        console.warn(
          `⚠️  验证报告未生成（prd.json ${report.status === 'missing' ? '缺失' : '不可解析'}）`,
        );
      }
      } catch (err) {
        console.warn(`⚠️  验证报告生成失败：${err instanceof Error ? err.message : String(err)}`);
      }
    }
    // keepOpen 等待阶段只读、无需持有 owner lease。
    // 等待期 Ctrl+C 完全走既有 waitForSigint 语义（真实退出码保留）
    if (commandSignals.exitCode !== null) exitCode = commandSignals.exitCode;
    if (session.state === 'open') await closeSession();
    if (commandSignals.exitCode !== null) exitCode = commandSignals.exitCode;
    commandSignals.dispose();
    if (cfg.keepOpen && commandSignals.exitCode === null) {
      const url = `http://localhost:${server.address().port}`;
      console.log(`\n✅ 运行结束（退出码 ${exitCode}）。仪表盘仍在 ${url} ，按 Ctrl+C 退出。`);
      await (cfg.interrupt ?? waitForSigint());
    }
    return exitCode;
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) {
      console.error(`❌ workspace 安全执行失败：${error.message}`);
      return commandSignals.exitCode ?? 2;
    }
    throw error;
  } finally {
    let closeFailed = false;
    const finalValidationCleanup = cleanValidationManager?.dispose();
    if (finalValidationCleanup && finalValidationCleanup.status !== 'removed') {
      closeFailed = true;
      console.error(
        `❌ 本地验证临时目录未能安全清理，` +
          describeCleanValidationCheckoutCleanup(finalValidationCleanup),
      );
    }
    if (session.state === 'open') {
      try {
        await closeSession();
      } catch (error) {
        closeFailed = true;
        console.error(
          `❌ workspace owner 无法安全释放：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    const signalExitCode = commandSignals.exitCode;
    commandSignals.dispose();
    server?.close();
    if (signalExitCode !== null) return signalExitCode;
    if (closeFailed) return 2;
  }
}
