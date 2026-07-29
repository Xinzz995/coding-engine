import { join, basename } from 'node:path';
import { writeFileAtomicSync } from './fs-atomic.js';
import {
  freezeAgentRunner,
  runAgent,
  type AgentKind,
  type FrozenAgentRunner,
  type RunResult,
} from './agent.js';
import { type Prd } from './prd.js';
import type { PrdReadResult } from './prd-guard.js';
import {
  blankStateFor,
  tryReadState,
  getCurrentStoryId,
  allStoriesResolved,
  enableEscalation,
  restoreEscalated,
  restoreValidationOwnership,
  issueValidationReceipt,
  reconcileValidationReceipts,
  revokeValidationReceipt,
  validationReceiptsDigest,
  tryReadEngineOwnedFields,
  validationOwnedFieldsOf,
  INITIAL_STORY_STATE,
  STATE_CONTROL_FILE_MAX_BYTES,
  type RunState,
} from './state.js';
import { readSafeControlFileUtf8Sync } from './safe-control-file.js';
import {
  runQualityChecks,
  runContractQualityChecks,
  readQualityChecks,
  applyGateFailure,
  applyAbortRollback,
  abortDesc,
  applyValidatorFailure,
  applyValidatorSuccess,
} from './gate.js';
import { resolveBuilderModel, resolveValidatorModel } from './models.js';
import type { ModelCatalogResult } from './model-catalog.js';
import * as dashboard from '../dashboard/server.js';
import { writeReport } from '../report/report.js';
import {
  appendEvidence,
  clipEvidenceDiagnostic,
  type EvidenceRecord,
  type AgentInvocationEvidence,
  type LoopValidationProtocolErrorCode,
  type ValidationTargetEvidence,
} from './evidence.js';
import { acquireLock, LockConflictError, type LockHandle } from './lock.js';
import {
  clearValidationResult,
  createValidationRequest,
  readGitHead,
  readValidationArtifactIdentity,
  readValidationResult,
  renderValidatorInstruction,
  type ValidationArtifactIdentity,
  type ValidationRequest,
} from './validation-protocol.js';
import { runTddGate } from './tdd-gate.js';
import {
  qualityChecksMatchContract,
  type QualityContract,
  type QualityContractReadResult,
} from '../quality/contract.js';
import { CODING_X_VERSION } from '../version.js';
import { runFinalReview } from '../review/final-review.js';
import { freezeReviewRunner, type FrozenReviewRunner } from '../review/runner.js';
import { reviewRoutingDigest } from '../review/common.js';
import type { FinalReviewOutcome, StoryValidationCheck } from '../review/types.js';
import {
  freezeReviewDecisions,
  invalidateFinalReviewState,
  readFinalReviewState,
  restoreReviewDecisionsSnapshot,
} from '../review/state.js';
import type { ReviewDecisionsSnapshot } from '../review/types.js';
import { runLoopPreflight } from './loop-preflight.js';
import { freezeTrustedTool } from './trusted-tool.js';
import { removeRegisteredWorkspaceFileSync } from './workspace-identity.js';

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
  /** 项目根；生产缺省当前目录，测试/嵌入环境可显式指定。 */
  projectRoot?: string;
  /** 只供隔离测试注入；生产始终读取项目根 .coding-x/quality.json。 */
  qualityContractReader?: (projectRoot: string) => QualityContractReadResult;
  /** 测试/嵌入注入；生产缺省执行真实本地三层 Review。 */
  finalReviewRunner?: (options: {
    root: string;
    workspace: string;
    currentContract: QualityContract;
    runner: AgentKind;
    model?: string;
    codingXVersion: string;
    shadow: boolean;
    timeoutMs: number;
    validateStoryReceipts: () => StoryValidationCheck;
    reviewDecisions: ReviewDecisionsSnapshot;
    reviewRoutingDigest: string;
    reviewRound: number;
  }) => Promise<FinalReviewOutcome>;
  /**
   * 仅供历史单测 fixture：允许旧 Validator 直接改 state。CLI 从不设置；生产默认
   * 必须提交结构化 validation result，禁止静默降级。
   */
  legacyValidatorProtocolForTests?: boolean;
  /** 只供测试注入；生产始终在 Validator 前后核对真实 Git HEAD 与工作树。 */
  validationArtifactIdentityReader?: (cwd: string, workspace: string) => ValidationArtifactIdentity;
  /** 只供使用脚本 fixture 的历史测试；生产始终冻结 Developer/Validator 启动入口。 */
  unsafeSkipAgentExecutableFreezeForTests?: boolean;
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

export async function runLoop(cfg: LoopConfig): Promise<number> {
  // 单写者互斥（ADR-008）：活锁 fail-fast、stale 自动接管；冲突时未启动任何资源，直接退出码 2
  let lock: LockHandle;
  try {
    lock = acquireLock(cfg.workspace, 'run');
  } catch (err) {
    if (err instanceof LockConflictError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  let server: ReturnType<typeof dashboard.start> | null = null;
  try {
    const startup = await runLoopPreflight(cfg);
    if (startup.status === 'failed') return startup.exitCode;
    const {
      statePath,
      guard,
      projectRoot,
      qualityReader,
      qualityRead,
      bootPrd,
      bootState,
      agentEnv,
      tddConfig,
      builder,
      validatorBase,
      modelPreflight: preflight,
      frozenQualityChecks,
      runKind,
      bootResolved,
    } = startup;
    const bootBlockedResolved =
      bootResolved && bootPrd.userStories.some((story) => bootState[story.id]?.blocked);
    try {
      // 负结果也由 trusted-tool 缓存；项目代码运行后不能通过新建同名 gh 改写结论。
      freezeTrustedTool('gh', projectRoot);
    } catch (error) {
      console.warn(
        `⚠️ 无法在项目代码运行前冻结 gh；若进入最终 Review 将按不可验证处理：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    let frozenAgentRunner: FrozenAgentRunner | undefined;
    if (!bootResolved && !cfg.unsafeSkipAgentExecutableFreezeForTests) {
      try {
        frozenAgentRunner = freezeAgentRunner(runKind, projectRoot);
      } catch (error) {
        console.error(
          `❌ 无法在项目代码运行前冻结 Developer/Validator Runner：` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return 2;
      }
    }
    let frozenReviewer: FrozenReviewRunner | undefined;
    if (!cfg.finalReviewRunner && !bootBlockedResolved) {
      try {
        // 必须发生在 Developer、Validator 和任意项目检查之前。后续正式 Review
        // 只复用这份绝对启动链，项目代码不能靠改 PATH 或替换 CLI 改换 Reviewer。
        frozenReviewer = freezeReviewRunner(runKind, { projectRoot });
      } catch (error) {
        console.error(
          `❌ 无法在项目代码运行前冻结正式 Reviewer：` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
        return 5;
      }
    }
    let frozenReviewDecisions: ReviewDecisionsSnapshot;
    try {
      frozenReviewDecisions = freezeReviewDecisions(cfg.workspace);
    } catch (error) {
      console.error(
        `❌ Review 裁决记录无效：${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
    const agentCwd = projectRoot;
    const stallLimit = cfg.stallLimit ?? 3;
    // --max-iter 继续约束可能调用 Developer 的实现/修复轮。提交新鲜度导致的
    // validation-only 不应吞掉这份预算，否则 N 个全部成功的 Story 最坏需要
    // 2N-1 轮，默认 50 会确定性截断 26 个 Story。重验使用独立且有界的余量：
    // 每个 Story 最多经历 stallLimit-1 次连续瞬时失败后再成功；成功会清零全局
    // stall，因此必须按 Story 分配，而不能只在全局额外加一次 stall 余量。
    const validationOnlyRoundLimit = Math.max(
      1,
      bootPrd.userStories.length * Math.max(1, stallLimit),
    );
    const totalRoundLimit = cfg.maxIterations + validationOnlyRoundLimit;

    server = dashboard.start({
      workspace: cfg.workspace,
      maxIterations: totalRoundLimit,
      port: cfg.port,
      openBrowser: cfg.openBrowser ?? true,
      projectRoot,
    });
    await server.ready;
    dashboard.setState({ runner: runKind });
    // Agents must run at the project root (the engine process's cwd), NOT at
    // cfg.workspace. The engine reads prd.json at join(cfg.workspace,
    // 'prd.json'), which for the default relative '.workspace' resolves against
    // the process cwd → <root>/.workspace/prd.json. The builder/validator
    // instructions also read '.workspace/prd.json' and root AGENTS.md/tasks/,
    // assuming cwd == project root. Spawning at cfg.workspace would make the
    // agent resolve '.workspace/prd.json' to <root>/.workspace/.workspace/prd.json,
    // so engine and agent would never share state and the loop would always hit
    // maxIterations. (See loop.test.ts "spawns the agent at the project root".)
    const progressPath = join(cfg.workspace, 'progress.md');
    const rawOf = (p: string): string | null => {
      try {
        return readSafeControlFileUtf8Sync(p, {
          maxBytes: STATE_CONTROL_FILE_MAX_BYTES,
          allowMissing: true,
        });
      } catch {
        return null;
      }
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
        ...(diagnostic ? { diagnosticTail: diagnostic } : {}),
      };
    };
    // evidence 是增强不是关键路径：写入失败只 warn（去重一次），绝不影响循环
    let warnedEvidence = false;
    const recordEvidence = (record: EvidenceRecord) => {
      try {
        appendEvidence(cfg.workspace, record);
      } catch (err) {
        if (!warnedEvidence) {
          warnedEvidence = true;
          console.warn(
            `⚠️  evidence 记录写入失败（不影响循环）：${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
    };
    const qualityContractStillCurrent = (): boolean => {
      const current = qualityReader(projectRoot);
      if (current.status === 'ready' && current.digest === qualityRead.digest) return true;
      const observed = current.status === 'ready' ? current.digest : current.status;
      console.error(
        `❌ 运行期间质量契约发生变化或不可读（启动 ${qualityRead.digest}，当前 ${observed}）。` +
          '本次运行按配置错误停止；请确认变更后重新派生 PRD。',
      );
      return false;
    };
    // 每次 guard.read() 都可能检出新篡改事件——三处读取点共用（archive 记文件名，与报告红旗区文件清单对齐）
    const recordTamper = (read: PrdReadResult, iteration: number) => {
      if (read.tamperedArchive !== undefined) {
        recordEvidence({
          type: 'tamper',
          source: 'engine',
          at: new Date().toISOString(),
          iteration,
          archive: read.tamperedArchive === null ? null : basename(read.tamperedArchive),
        });
      }
    };
    // 四处提前退出（builder 异常轮熔断 / no-op 全部 resolved 快路径 / no-op 非 resolved 熔断 / validator 异常轮熔断）
    // break 前统一补一次 guard.read()+recordTamper()——它们都复用轮首快照提前结束本轮，
    // 若 builder 在本轮篡改了 prd.json，不补这一读就不会被检测/恢复/存档（与标准完成判定
    // 路径:344-345 的读点同形态）。guard.read() 幂等：磁盘未变时是真无操作。
    const tamperCheckBeforeExit = (iteration: number) => {
      const r = guard.read();
      recordTamper(r, iteration);
    };
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
    let implementationRounds = 0;
    let validationOnlyRounds = 0;
    let lastIteration = 0;
    const completeResolvedRun = async (prd: Prd, state: RunState): Promise<number> => {
      const blocked = blockedConvergedExit(prd, state);
      if (blocked !== null) return blocked;
      const validateStoryReceipts = (): StoryValidationCheck => {
        const currentHead = readGitHead(projectRoot);
        if (currentHead === null) return { ok: false, message: '无法读取当前 Git HEAD' };
        const currentState = tryReadState(statePath);
        if (!currentState) return { ok: false, message: 'state.json 缺失、损坏或不可读' };
        const reconciled = reconcileValidationReceipts(prd, currentState, currentHead);
        if (reconciled.changed) {
          writeFileAtomicSync(statePath, JSON.stringify(reconciled.state, null, 2));
          invalidateFinalReviewState(cfg.workspace);
        }
        if (reconciled.invalidated.length > 0) {
          return {
            ok: false,
            message: `存在过期 Story：${reconciled.invalidated.map((item) => item.storyId).join(', ')}`,
          };
        }
        const receiptDigest = validationReceiptsDigest(prd, reconciled.state, currentHead);
        if (receiptDigest === null)
          return { ok: false, message: '并非所有 Story 都有当前有效的 Validator 凭证' };
        return { ok: true, digest: receiptDigest };
      };
      const receiptCheck = validateStoryReceipts();
      if (!receiptCheck.ok) {
        console.error(`\n⏸️  最终 Review 前 Validator 凭证无法验证：${receiptCheck.message}`);
        return 5;
      }
      const decisionsBeforeReview = restoreReviewDecisionsSnapshot(
        cfg.workspace,
        frozenReviewDecisions,
      );
      if (decisionsBeforeReview.changed) {
        console.error('\n⏸️  Review 裁决记录在本轮运行期间发生变化；已恢复冻结快照');
        return 5;
      }
      // 自定义/测试 Review runner 也不能让旧绿色结果跨过一次新尝试继续存活；
      // 生产 runFinalReview 内部会再次幂等失效，保持直接调用时同样安全。
      const previousReview = readFinalReviewState(cfg.workspace);
      const reviewRound = previousReview.status === 'ready' ? previousReview.state.round + 1 : 1;
      invalidateFinalReviewState(cfg.workspace);
      console.log('\n🔎 全部 story 已验证，开始针对当前 PR 最新提交执行本地最终 Review。');
      const finalReviewOptions = {
        root: projectRoot,
        workspace: cfg.workspace,
        currentContract: qualityRead.contract,
        runner: runKind,
        model: preflight.review.model,
        codingXVersion: cfg.actualVersion ?? CODING_X_VERSION,
        shadow: cfg.shadow ?? false,
        timeoutMs: cfg.valTimeoutMs,
        validateStoryReceipts,
        reviewDecisions: frozenReviewDecisions,
        reviewRoutingDigest: reviewRoutingDigest(prd.models),
        reviewRound,
      };
      const finalReview = cfg.finalReviewRunner
        ? await cfg.finalReviewRunner(finalReviewOptions)
        : await runFinalReview({
            ...finalReviewOptions,
            frozenRunner: frozenReviewer!,
          });
      const decisionsAfterReview = restoreReviewDecisionsSnapshot(
        cfg.workspace,
        frozenReviewDecisions,
      );
      if (decisionsAfterReview.changed) {
        invalidateFinalReviewState(cfg.workspace);
        console.error('\n⏸️  最终 Review 期间裁决记录发生变化；已恢复冻结快照并删除本轮结果');
        return 5;
      }
      // 测试/嵌入注入的 runner 也不能绕过 Review 后核对。生产 runFinalReview
      // 自己会做更完整的 PR/HEAD/Runner 复核，这里再守住 loop 的统一出口。
      const receiptAfterReview = validateStoryReceipts();
      if (!receiptAfterReview.ok || receiptAfterReview.digest !== receiptCheck.digest) {
        invalidateFinalReviewState(cfg.workspace);
        const reason = receiptAfterReview.ok
          ? 'Story Validator 凭证身份在最终 Review 期间发生变化'
          : receiptAfterReview.message;
        console.error(`\n⏸️  最终 Review 结果已作废：${reason}`);
        return 5;
      }
      const emit =
        finalReview.exitCode === 0 || finalReview.exitCode === 7 ? console.log : console.error;
      emit(
        `\n${finalReview.exitCode === 0 ? '✅' : finalReview.exitCode === 7 ? '🧪' : '⏸️'} ${finalReview.message}`,
      );
      return finalReview.exitCode;
    };
    if (bootResolved) {
      dashboard.setState({
        phase: 'done',
        currentStory: null,
        model: null,
        routeSource: null,
        storyDifficulty: null,
      });
      exitCode = await completeResolvedRun(bootPrd, bootState);
    }
    for (let i = 1; !bootResolved && i <= totalRoundLimit; i++) {
      lastIteration = i;
      lock.verify(); // 轮首自愈：agent 误删/改写锁时告警重建（同 prd-guard 的机械防护哲学）
      if (!qualityContractStillCurrent()) {
        exitCode = 2;
        break;
      }
      let stateRawBefore = rawOf(statePath);
      const progressRawBefore = rawOf(progressPath);
      const beforeRead = guard.read();
      recordTamper(beforeRead, i);
      const before = beforeRead.prd;
      // 写回失败=磁盘仍是篡改版=本轮 validator 读到的验收标准不可信 → 跳过（下轮开头重试恢复）
      let skipValidator = beforeRead.restoreFailed;
      let beforeState = before ? readRunState(statePath, before) : null;
      if (beforeState && before) {
        const currentHead = readGitHead(projectRoot);
        if (!cfg.legacyValidatorProtocolForTests && currentHead === null) {
          console.error('❌ 运行期间无法读取当前 Git HEAD；停止且不启动 Agent');
          exitCode = 2;
          tamperCheckBeforeExit(i);
          break;
        }
        const reconciled = reconcileValidationReceipts(before, beforeState, currentHead);
        if (reconciled.changed) {
          beforeState = reconciled.state;
          writeFileAtomicSync(statePath, JSON.stringify(beforeState, null, 2));
          stateRawBefore = rawOf(statePath);
        }
        if (reconciled.invalidated.length > 0) {
          invalidateFinalReviewState(cfg.workspace);
          console.warn(
            `⚠️  提交或验收标准已变化，旧 Validator 凭证失效：` +
              reconciled.invalidated.map((item) => item.storyId).join(', '),
          );
        }
      }
      const currentStory = before && beforeState ? getCurrentStoryId(before, beforeState) : null;
      const currentStoryObj = before?.userStories.find((s) => s.id === currentStory) ?? null;
      const currentStoryState = currentStory && beforeState ? beforeState[currentStory] : undefined;
      const validationOnly =
        !!currentStoryState &&
        currentStoryState.passes &&
        !currentStoryState.blocked &&
        !currentStoryState.validated;
      if (validationOnly) {
        if (validationOnlyRounds >= validationOnlyRoundLimit) {
          console.error(
            `\n🛑 仅重验轮已用尽 ${validationOnlyRoundLimit} 轮安全余量；` +
              '请排查 Validator、模型服务或反复变化的提交后重跑。',
          );
          tamperCheckBeforeExit(i);
          break;
        }
        validationOnlyRounds += 1;
      } else {
        if (implementationRounds >= cfg.maxIterations) {
          console.error(
            `\n🛑 已用尽 ${cfg.maxIterations} 轮实现/修复预算；` +
              '当前结果未收敛，请检查失败记录后决定是否提高 --max-iter。',
          );
          tamperCheckBeforeExit(i);
          break;
        }
        implementationRounds += 1;
      }
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
          if (
            !owned ||
            (owned.validated === expected.validated &&
              JSON.stringify(owned.validationReceipt) ===
                JSON.stringify(expected.validationReceipt) &&
              owned.escalated === expected.escalated)
          )
            continue;
          materialized = { ...materialized, [storyId]: { ...expected } };
          materializedChanged = true;
        }
        if (materializedChanged) {
          writeFileAtomicSync(statePath, JSON.stringify(materialized, null, 2));
          stateRawBefore = rawOf(statePath);
        }
      }
      const routeTampers: Array<{
        storyId: string;
        expected: boolean;
        received: boolean | 'missing';
        side: 'builder' | 'validator' | 'gate';
      }> = [];
      const validationTampers: Array<{
        storyId: string;
        expected: boolean;
        received: boolean | 'missing';
        side: 'builder' | 'validator' | 'gate';
        fields?: Array<'validated' | 'validationReceipt'>;
      }> = [];
      const reviewDecisionsTampers: Array<{
        side: 'builder' | 'validator' | 'gate';
        expectedDigest: string;
        receivedDigest: string;
      }> = [];
      let gateStateMutation = false;
      const restoreRawStateSnapshot = (expectedRaw: string | null) => {
        if (expectedRaw === null) removeRegisteredWorkspaceFileSync(statePath, true);
        else writeFileAtomicSync(statePath, expectedRaw);
      };
      const restoreEngineOwnership = (
        side: 'builder' | 'validator' | 'gate',
        expectedState: RunState | null,
        expectedRaw: string | null,
      ): { storyMissing: boolean } => {
        if (!expectedState) {
          if (rawOf(statePath) !== expectedRaw) {
            restoreRawStateSnapshot(expectedRaw);
            console.warn(`⚠️  ${side} 在调用前 state.json 不可读时改写了文件，已恢复完整原始快照`);
          }
          return { storyMissing: false };
        }
        const state = tryReadState(statePath);
        if (!state) {
          for (const storyId of ownershipStoryIds) {
            const expected = expectedState[storyId] ?? INITIAL_STORY_STATE;
            routeTampers.push({
              storyId,
              expected: expected.escalated,
              received: 'missing',
              side,
            });
            validationTampers.push({
              storyId,
              expected: expected.validated,
              received: 'missing',
              side,
              fields: ['validated', 'validationReceipt'],
            });
          }
          restoreRawStateSnapshot(expectedRaw);
          console.warn(`⚠️  ${side} 删除或损坏了 state.json，已恢复调用前完整快照`);
          return { storyMissing: currentStory !== null };
        }
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
            validationOwnedFieldsOf(expected),
            expected,
            observed
              ? {
                  validated: observed.validated,
                  validationReceipt: observed.validationReceipt,
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
            const fields: Array<'validated' | 'validationReceipt'> = [];
            if (validation.tamper.received.validated !== validation.tamper.expected.validated) {
              fields.push('validated');
            }
            if (
              JSON.stringify(validation.tamper.received.validationReceipt) !==
              JSON.stringify(validation.tamper.expected.validationReceipt)
            ) {
              fields.push('validationReceipt');
            }
            validationTampers.push({
              storyId,
              expected: validation.tamper.expected.validated,
              received: validation.tamper.received.validated,
              side,
              ...(fields.length > 0 ? { fields } : {}),
            });
            console.warn(
              `⚠️  ${side} 修改了引擎独占的 ${storyId} 验收状态` +
                `${fields.length > 0 ? `（${fields.join('、')}）` : ''}，已恢复`,
            );
          }
        }
        if (changed) writeFileAtomicSync(statePath, JSON.stringify(restored, null, 2));
        return { storyMissing };
      };
      const restoreGateState = (expectedRaw: string | null, expectedState: RunState | null) => {
        if (rawOf(statePath) === expectedRaw) return;
        gateStateMutation = true;
        // 先恢复并记录可解析的字段级差异，再恢复完整字节快照。项目检查对 state.json
        // 没有任何写权限；完整恢复同时覆盖 passes/blocked/notes/retryCount 旁路。
        restoreEngineOwnership('gate', expectedState, expectedRaw);
        if (rawOf(statePath) !== expectedRaw) restoreRawStateSnapshot(expectedRaw);
        console.warn('⚠️  项目检查修改了 state.json，已恢复检查前完整快照');
      };
      const guardFrozenReviewDecisions = (side: 'builder' | 'validator' | 'gate'): boolean => {
        const restored = restoreReviewDecisionsSnapshot(cfg.workspace, frozenReviewDecisions);
        if (!restored.changed) return false;
        reviewDecisionsTampers.push({
          side,
          expectedDigest: frozenReviewDecisions.digest,
          receivedDigest: restored.receivedDigest,
        });
        console.warn(`⚠️  ${side} 修改了本轮冻结的 Review 裁决记录，已恢复并停止本轮运行`);
        return true;
      };
      const hasDedicatedEscalation = Boolean(cfg.escalationModel || preflight.config?.escalation);
      const triggerEscalation = (reason: 'gate' | 'validator' | 'noop'): boolean => {
        if (!currentStory) return false;
        const state = tryReadState(statePath);
        if (!state) return false;
        const enabled = enableEscalation(state, currentStory, hasDedicatedEscalation);
        if (!enabled.changed) return false;
        writeFileAtomicSync(statePath, JSON.stringify(enabled.state, null, 2));
        console.log(`⬆️  ${currentStory} 首次有效失败（${reason}），下轮起使用 escalation 模型`);
        return true;
      };
      // 异常轮回写：本轮把当前 story 的 passes 从 false 翻到 true 且未 blocked → 回写待复核。
      // state 读取失败（缺失/损坏）不回写不覆盖（同门禁打回的保守语义）。返回是否发生回写。
      const rollbackIfUnvalidatedPass = (
        side: 'builder' | 'validator',
        r: { timedOut: boolean; exitCode: number | null },
      ): boolean => {
        if (!currentStory) return false;
        const passedBefore = beforeState?.[currentStory]?.passes ?? false;
        const st = tryReadState(statePath);
        const cur = st?.[currentStory];
        if (!st || !cur || !cur.passes || cur.blocked || passedBefore) return false;
        const next = applyAbortRollback(
          st,
          currentStory,
          { side, timedOut: r.timedOut, exitCode: r.exitCode },
          new Date(),
        );
        writeFileAtomicSync(statePath, JSON.stringify(next, null, 2));
        console.warn(
          `⚠️  ${currentStory} 在中断轮被置为通过，未经完整验收——已回写待复核（${side} ${abortDesc(r)}）`,
        );
        return true;
      };
      const keepPendingValidation = (reason: string): boolean => {
        if (!currentStory) return false;
        const state = tryReadState(statePath);
        if (!state) return false;
        const current = state[currentStory];
        if (!current || !current.passes || current.blocked) return false;
        const revoked = revokeValidationReceipt(state, currentStory);
        if (revoked.changed) {
          writeFileAtomicSync(statePath, JSON.stringify(revoked.state, null, 2));
        }
        console.warn(
          `⚠️  ${currentStory} 未取得引擎验收凭证（${reason}）；` +
            '实现候选保留，下轮只重新执行门禁与 Validator',
        );
        return true;
      };
      const builderChoice = resolveBuilderModel({
        builderOverride: cfg.builderModel,
        escalationOverride: cfg.escalationModel,
        config: preflight.config,
        story: currentStoryObj,
        escalated:
          currentStory && beforeState ? (beforeState[currentStory]?.escalated ?? false) : false,
      });
      const builderWillRun = !!builder && !validationOnly;
      let builderInvocation: AgentInvocationEvidence | undefined;
      let validatorInvocation: AgentInvocationEvidence | undefined;
      // 「每轮一条 iteration」五个写入点的公共底座单源：各点只传差异字段——
      // 0.22.0 轮五点位分四批才靠审查抓齐，字段漂移风险有实证，底座必须只有一份。
      const recordIteration = (over: Partial<Extract<EvidenceRecord, { type: 'iteration' }>>) => {
        recordEvidence({
          type: 'iteration',
          source: 'engine',
          at: new Date().toISOString(),
          iteration: i,
          storyId: currentStory,
          builderRan: builderWillRun,
          builderModel: builderWillRun ? (builderChoice.model ?? null) : null,
          validatorRan: false,
          validatorModel: null,
          skippedValidator: false,
          agentBlocked: false,
          builderRouteSource: builderChoice.source,
          ...(currentStoryObj?.difficulty ? { storyDifficulty: currentStoryObj.difficulty } : {}),
          ...(routeTampers.length > 0 ? { stateRouteTamper: [...routeTampers] } : {}),
          ...(validationTampers.length > 0
            ? { stateValidationTamper: [...validationTampers] }
            : {}),
          ...(gateStateMutation ? { gateStateMutation: true as const } : {}),
          ...(reviewDecisionsTampers.length > 0
            ? { reviewDecisionsTamper: [...reviewDecisionsTampers] }
            : {}),
          ...(builderInvocation ? { builderInvocation } : {}),
          ...(validatorInvocation ? { validatorInvocation } : {}),
          ...over,
        });
      };
      // Builder 之前另取一次可解析快照；beforeState 在损坏文件上会回退为空状态，
      // 不能把该回退误当作磁盘真实内容并允许 Agent 借机“修复”为伪造绿态。
      const ownedStateBeforeBuilder = tryReadState(statePath);

      dashboard.setState({
        iteration: i,
        phase: validationOnly ? 'gating' : 'developing',
        currentStory,
        model: builderWillRun ? (builderChoice.model ?? null) : null,
        routeSource: builderWillRun ? builderChoice.source : null,
        storyDifficulty: currentStoryObj?.difficulty ?? null,
      });

      // Developer
      let builderOutcome: 'completed' | 'timeout' | 'error' | undefined;
      let builderRollback = false;
      if (validationOnly) {
        console.log(
          `🔁 ${currentStory} 实现候选仍保留，本轮跳过 Developer 并只重新执行门禁与 Validator`,
        );
      } else if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else {
        console.log(
          `🧠 builder 实际模型: ${builderChoice.model ?? 'runner 默认'} [${builderChoice.source}]` +
            `${currentStoryObj?.difficulty ? ` · 难度 ${currentStoryObj.difficulty}` : ''}` +
            `${builderChoice.escalated ? ` · ${currentStory} 升级路由` : ''}`,
        );
        let builderDecisionsTampered = false;
        const dev = await runAgent({
          kind: runKind,
          prompt: builder,
          cwd: agentCwd,
          timeoutMs: cfg.devTimeoutMs,
          model: builderChoice.model,
          env: agentEnv,
          ...(frozenAgentRunner ? { frozenRunner: frozenAgentRunner } : {}),
        }).finally(() => {
          builderDecisionsTampered = guardFrozenReviewDecisions('builder');
        });
        builderOutcome = outcomeOf(dev);
        builderInvocation = invocationOf(dev, builderOutcome);
        restoreEngineOwnership('builder', ownedStateBeforeBuilder, stateRawBefore);
        if (builderDecisionsTampered) {
          recordIteration({ builderOutcome });
          exitCode = 5;
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          tamperCheckBeforeExit(i);
          break;
        }
        if (builderOutcome !== 'completed') {
          builderRollback = rollbackIfUnvalidatedPass('builder', dev);
          // evidence=引擎机械事实：agentBlocked 不能硬编码 false——agent 可能同轮已置 blocked:true
          // 又以非零码退出（如仲裁上报后环境异常收尾），此处需实时读一次 state 反映真实情况。
          const blockedNow = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
          recordIteration({
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
          if (stalled()) {
            tamperCheckBeforeExit(i);
            break;
          }
          continue; // 异常轮：跳过门禁与验收，下轮重试（回写已保证不带走未验收的 true）
        }
      }

      // no-op 空转检测：builder 正常结束但 state 与 progress 双无变化（机械信号）——
      // 跳过门禁与验收（省一次强模型调用），计入 stall。
      if (builderWillRun && builderOutcome === 'completed' && !qualityContractStillCurrent()) {
        recordIteration({ builderOutcome: 'completed' });
        exitCode = 2;
        tamperCheckBeforeExit(i);
        break;
      }

      if (
        builderWillRun &&
        builderOutcome === 'completed' &&
        rawOf(statePath) === stateRawBefore &&
        rawOf(progressPath) === progressRawBefore
      ) {
        // 双无变化不等于「无事发生」：本轮开始时可能已经全部 resolved（如 legacy 迁移在
        // bootstrap 就把 passes 写进 state.json，或断点续跑接手一个已完成的工作区）——
        // before/beforeState 就是这轮唯一会有的磁盘状态（没变化），完成判定照样要跑，
        // 否则已完工的工作区会被当成空转一路吃到熔断。
        if (before && beforeState && allStoriesResolved(before, beforeState)) {
          // 每轮一条 iteration 不变式：这条快路径 break 前也要留痕，否则已完工工作区
          // 重跑的终轮在 evidence 时间线上是空洞（其余所有退出路径都恰写一条）。
          recordIteration({ builderOutcome: 'completed', noop: true });
          tamperCheckBeforeExit(i);
          dashboard.setState({
            phase: 'done',
            currentStory: null,
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          exitCode = await completeResolvedRun(before, beforeState);
          break;
        }
        console.warn('⏭️  本轮 builder 无任何产出（state/progress 双无变化），跳过门禁与验收');
        const escalationTriggered = triggerEscalation('noop');
        recordIteration({
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
          tamperCheckBeforeExit(i);
          break;
        }
        continue;
      }

      // 机械门禁：builder 之后、validator 之前确定性执行质量检查（fail-fast）。
      // 失败即机械打回并跳过本轮 validator——builder 谎报「检查通过」在此被零成本戳穿。
      // 第四检测点：builder 刚跑完、validator 未拉起——本轮 builder 的篡改必须在此恢复，
      // 否则 validator（独立进程直读磁盘）当轮就会按假 AC 验收（ADR-007）。
      const gateRead = guard.read();
      recordTamper(gateRead, i);
      if (gateRead.restoreFailed) skipValidator = true;
      // agent 轮内显式置 blocked（仲裁上报，如 [需要人工核实]）：机械路径不得推进它——
      // 当轮跳过门禁执行与验收，完成判定按 resolved 正常收敛。
      // 第四检测点（上方 guard.read()）保持无条件执行：篡改恢复不因跳过而延后。
      const agentBlocked = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
      if (agentBlocked) {
        console.log(`⏭️  ${currentStory} 已被置 blocked（待人工处理），本轮跳过门禁与验收`);
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
        // 项目检查会执行仓库中的任意代码，因此与 Agent 一样没有 state 所有权。
        // Validator 的调用前基准只能建立在恢复后的状态上；否则检查脚本可替任意
        // Story 伪造验收凭证，并让后续完成判定把它当成引擎事实。
        const stateRawBeforeGate = rawOf(statePath);
        const ownedStateBeforeGate = tryReadState(statePath);
        let gateDecisionsTampered = false;
        const gate = await (
          legacyChecks && legacyChecks !== 'invalid'
            ? runQualityChecks(legacyChecks, agentCwd)
            : runContractQualityChecks(frozenQualityChecks, agentCwd)
        ).finally(() => {
          restoreGateState(stateRawBeforeGate, ownedStateBeforeGate);
          gateDecisionsTampered = guardFrozenReviewDecisions('gate');
        });
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
        recordEvidence({
          type: 'gate-run',
          source: 'engine',
          at: new Date().toISOString(),
          iteration: i,
          storyId: currentStory,
          ok: gate.ok,
          total: gate.total,
          ran: gate.ran,
          ms: gate.ms,
          ...(gate.failure
            ? {
                failedCommand: gate.failure.command,
                exitCode: gate.failure.exitCode,
                timedOut: gate.failure.timedOut,
                ...(gateDiagnostic ? { diagnosticTail: gateDiagnostic } : {}),
              }
            : {}),
        });
        if (gateDecisionsTampered) {
          recordIteration({
            ...(builderOutcome ? { builderOutcome } : {}),
            validatorOutcome: 'skipped',
          });
          exitCode = 5;
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          tamperCheckBeforeExit(i);
          break;
        }
        if (!gate.ok) {
          console.error(
            `\n❌ 机械门禁未通过（${gate.failure!.command}），打回 ${currentStory} 待下轮重试`,
          );
          const st = tryReadState(statePath);
          if (st) {
            const failed = applyGateFailure(st, currentStory, gate.failure!, new Date());
            const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
            writeFileAtomicSync(statePath, JSON.stringify(enabled.state, null, 2));
            if (enabled.changed)
              console.log(`⬆️  ${currentStory} 首次有效失败（gate），下轮起使用 escalation 模型`);
            recordIteration({
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
          if (!st)
            recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}),
              validatorOutcome: 'skipped',
              gateRejected: true,
            });
          stallCount = 0; // 有 state 写入=有活动；打回预算由 MAX_RETRIES 独立约束
          // 已知不对称：门禁把最后一个 story 打到 blocked 时，本轮 continue 跳过完成判定，
          // 完成要到下一轮才被发现；发生在末轮迭代时退出码为 1（validator 打回则当轮判定）。低频且 blocked→1 语义诚实，接受。
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          continue;
        }
      }

      // TDD 最终门禁：普通检查之后、Validator 之前重新校验受保护政策面并运行
      // coverageCheck。它不消费或信任宿主 hook 的结果。
      if (!agentBlocked && tddConfig && currentStory) {
        dashboard.setState({
          phase: 'gating',
          model: null,
          routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
        const stateRawBeforeGate = rawOf(statePath);
        const ownedStateBeforeGate = tryReadState(statePath);
        let tddDecisionsTampered = false;
        const tddGate = await runTddGate(tddConfig, agentCwd).finally(() => {
          restoreGateState(stateRawBeforeGate, ownedStateBeforeGate);
          tddDecisionsTampered = guardFrozenReviewDecisions('gate');
        });
        const diagnostic = tddGate.failure
          ? clipEvidenceDiagnostic(tddGate.failure.outputTail).trim()
          : '';
        recordEvidence({
          type: 'tdd-gate',
          source: 'engine',
          at: new Date().toISOString(),
          phase: 'post-builder',
          iteration: i,
          storyId: currentStory,
          ok: tddGate.ok,
          policyOk: tddGate.policyOk,
          commandRan: tddGate.commandRan,
          ms: tddGate.ms,
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
        if (tddDecisionsTampered) {
          recordIteration({
            ...(builderOutcome ? { builderOutcome } : {}),
            validatorOutcome: 'skipped',
          });
          exitCode = 5;
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          tamperCheckBeforeExit(i);
          break;
        }
        if (!tddGate.ok) {
          console.error(
            `\n❌ TDD 门禁未通过（${tddGate.failure!.command}），打回 ${currentStory} 待下轮重试`,
          );
          const st = tryReadState(statePath);
          if (st) {
            const failed = applyGateFailure(st, currentStory, tddGate.failure!, new Date());
            const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
            writeFileAtomicSync(statePath, JSON.stringify(enabled.state, null, 2));
            if (enabled.changed)
              console.log(`⬆️  ${currentStory} 首次有效失败（gate），下轮起使用 escalation 模型`);
            recordIteration({
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
          if (!st)
            recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}),
              validatorOutcome: 'skipped',
              gateRejected: true,
            });
          stallCount = 0;
          dashboard.setState({
            phase: 'idle',
            model: null,
            routeSource: null,
            storyDifficulty: null,
          });
          continue;
        }
      }

      // Validator
      const validatorChoice = resolveValidatorModel({
        cliOverride: cfg.validatorModel,
        config: preflight.config,
      });
      const validatorModel = validatorChoice.model;
      const structuredValidation = !cfg.legacyValidatorProtocolForTests;
      const validatorWillRun =
        !!validatorBase &&
        !skipValidator &&
        !agentBlocked &&
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
      let validationPending = false;
      let validationReceipt = false;
      let validatorEscalationTriggered = false;
      let validatorDiagnostic: string | undefined;
      let validationProtocol: 'passed' | 'failed' | 'invalid' | undefined;
      let validationTarget: ValidationTargetEvidence | undefined;
      let validationProtocolError:
        | {
            code: LoopValidationProtocolErrorCode;
            diagnostic: string;
          }
        | undefined;
      let validatorStateMutation = false;
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

      if (!validatorBase) {
        console.error('❌ validator.md 不存在，本轮无法签发验收凭证');
        validatorOutcome = 'skipped';
      } else if (skipValidator) {
        console.warn('⚠️  prd.json 快照写回失败，跳过本轮 validator（磁盘验收标准不可信）');
        validatorOutcome = 'skipped';
      } else if (!agentBlocked && (!structuredValidation || currentStoryObj)) {
        console.log(
          `🧠 validator 实际模型: ${validatorModel ?? 'runner 默认'} [${validatorChoice.source}]`,
        );
        const validatorStateBefore = tryReadState(statePath);
        const currentValidatorStateBefore = currentStory
          ? validatorStateBefore?.[currentStory]
          : undefined;
        const stateRawBeforeValidator = rawOf(statePath);
        let validationRequest: ValidationRequest | null = null;
        let validatorPrompt = validatorBase;
        let canStartValidator = true;

        if (structuredValidation && currentStoryObj) {
          const artifact = (cfg.validationArtifactIdentityReader ?? readValidationArtifactIdentity)(
            agentCwd,
            cfg.workspace,
          );
          if (!artifact.ok) {
            canStartValidator = false;
            validatorOutcome = 'skipped';
            rejectProtocol(
              'artifact-changed',
              `${artifact.diagnostic}；Validator 未启动，也不会签发凭证`,
            );
          } else {
            validationRequest = createValidationRequest(
              currentStoryObj,
              cfg.workspace,
              artifact.gitHead,
            );
          }
        }
        if (validationRequest) {
          validationTarget = {
            requestId: validationRequest.requestId,
            storyId: validationRequest.storyId,
            acceptanceHash: validationRequest.acceptanceHash,
            gitHead: validationRequest.gitHead,
          };
          validatorPrompt = renderValidatorInstruction(validatorBase, validationRequest);
          try {
            clearValidationResult(validationRequest.resultPath);
          } catch (err) {
            canStartValidator = false;
            validatorOutcome = 'skipped';
            rejectProtocol(
              'result-cleanup-failed',
              `无法清理上一轮 validation result：${err instanceof Error ? err.message : String(err)}`,
            );
          }
        }

        if (canStartValidator) {
          validatorActuallyRan = true;
          let validatorDecisionsTampered = false;
          const val = await runAgent({
            kind: runKind,
            prompt: validatorPrompt,
            cwd: agentCwd,
            timeoutMs: cfg.valTimeoutMs,
            model: validatorModel,
            env: agentEnv,
            ...(frozenAgentRunner ? { frozenRunner: frozenAgentRunner } : {}),
          }).finally(() => {
            validatorDecisionsTampered = guardFrozenReviewDecisions('validator');
          });
          validatorOutcome = outcomeOf(val);
          validatorInvocation = invocationOf(val, validatorOutcome);
          const stateRawAfterValidator = rawOf(statePath);
          const validatorOwnership = restoreEngineOwnership(
            'validator',
            validatorStateBefore,
            stateRawBeforeValidator,
          );

          if (structuredValidation && stateRawAfterValidator !== stateRawBeforeValidator) {
            validatorStateMutation = true;
            restoreRawStateSnapshot(stateRawBeforeValidator);
            console.warn(
              `⚠️  ${currentStory} Validator 修改了 state.json，已恢复调用前快照并拒绝本轮结论`,
            );
          }

          if (validatorDecisionsTampered) {
            recordIteration({
              validatorRan: true,
              validatorModel: validatorModel ?? null,
              validatorRouteSource: validatorChoice.source,
              ...(builderOutcome ? { builderOutcome } : {}),
              validatorOutcome,
            });
            exitCode = 5;
            dashboard.setState({
              phase: 'idle',
              model: null,
              routeSource: null,
              storyDifficulty: null,
            });
            tamperCheckBeforeExit(i);
            break;
          }

          if (!structuredValidation) {
            // 历史单测专用兼容路径：生产 CLI 永不进入。旧 Validator 直接写 state，
            // 仍按 v0.25 receipt 语义恢复引擎字段并判定。
            if (validatorOutcome !== 'completed') {
              validatorRollback = rollbackIfUnvalidatedPass('validator', val);
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
                validatorEscalationTriggered = triggerEscalation('validator');
              }
              if (
                stateAfter &&
                currentValidatorStateBefore.passes &&
                !currentValidatorStateBefore.blocked &&
                validatorStateAfter?.passes &&
                !validatorStateAfter.blocked
              ) {
                stateAfter = tryReadState(statePath);
                if (stateAfter && currentStoryObj) {
                  const legacyRequest = createValidationRequest(
                    currentStoryObj,
                    cfg.workspace,
                    readGitHead(agentCwd),
                  );
                  const issued =
                    legacyRequest.gitHead === null
                      ? { state: stateAfter, changed: false }
                      : issueValidationReceipt(stateAfter, currentStory, {
                          schemaVersion: 1,
                          requestId: legacyRequest.requestId,
                          gitHead: legacyRequest.gitHead,
                          acceptanceHash: legacyRequest.acceptanceHash,
                        });
                  if (issued.changed) {
                    writeFileAtomicSync(statePath, JSON.stringify(issued.state, null, 2));
                    validationReceipt = true;
                    console.log(`✅ ${currentStory} validator 已正常完成，引擎验收凭证已签发`);
                  }
                }
              }
            }
          } else if (validationRequest) {
            const artifactAfterValidator = (
              cfg.validationArtifactIdentityReader ?? readValidationArtifactIdentity
            )(agentCwd, cfg.workspace);
            const protocol = artifactAfterValidator.ok
              ? readValidationResult(
                  validationRequest.resultPath,
                  validationRequest,
                  artifactAfterValidator.gitHead,
                )
              : {
                  ok: false as const,
                  code: 'artifact-changed' as const,
                  diagnostic: artifactAfterValidator.diagnostic,
                };
            try {
              clearValidationResult(validationRequest.resultPath);
            } catch (err) {
              // nonce 已阻止下轮复用；留存清理故障但不把已完成的当前绑定判成假失败。
              console.warn(
                `⚠️  validation result 清理失败，下轮会再次拒绝旧文件：${err instanceof Error ? err.message : String(err)}`,
              );
            }

            if (validatorOutcome !== 'completed') {
              rejectProtocol('agent-aborted', `Validator ${abortDesc(val)}`);
            } else if (validatorStateMutation) {
              rejectProtocol('state-mutated', 'Validator 修改了引擎独占的 state.json');
            } else if (!protocol.ok) {
              rejectProtocol(protocol.code, protocol.diagnostic);
            } else if (currentStory && validatorStateBefore && currentValidatorStateBefore) {
              recordEvidence({
                type: 'validation-claim',
                source: 'validator',
                at: new Date().toISOString(),
                iteration: i,
                requestId: protocol.result.requestId,
                storyId: protocol.result.storyId,
                acceptanceHash: protocol.result.acceptanceHash,
                gitHead: protocol.result.gitHead,
                verdict: protocol.result.verdict,
                checks: protocol.result.checks,
                summary: protocol.result.summary,
              });
              if (protocol.result.verdict === 'failed') {
                validationProtocol = 'failed';
                const failed = applyValidatorFailure(
                  validatorStateBefore,
                  currentStory,
                  protocol.result,
                  new Date(),
                );
                const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
                writeFileAtomicSync(statePath, JSON.stringify(enabled.state, null, 2));
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
                const issued =
                  validationRequest.gitHead === null
                    ? { state: passed, changed: false }
                    : issueValidationReceipt(passed, currentStory, {
                        schemaVersion: 1,
                        requestId: validationRequest.requestId,
                        gitHead: validationRequest.gitHead,
                        acceptanceHash: validationRequest.acceptanceHash,
                      });
                if (issued.changed) {
                  writeFileAtomicSync(statePath, JSON.stringify(issued.state, null, 2));
                  validationProtocol = 'passed';
                  validationReceipt = true;
                  console.log(`✅ ${currentStory} 结构化验收目标匹配，引擎验收凭证已签发`);
                } else {
                  rejectProtocol('candidate-not-passing', '引擎无法对当前候选态签发验收凭证');
                }
              }
            } else {
              rejectProtocol('candidate-not-passing', '当前 story 或调用前状态缺失');
            }
          }
        }
      } else if (agentBlocked) {
        validatorOutcome = 'skipped';
      } else if (structuredValidation && !currentStoryObj) {
        validatorOutcome = 'skipped';
        rejectProtocol('candidate-not-passing', '无法从可信 PRD 快照定位当前 story');
      }

      // Validator 未签发凭证不等于实现已知错误。候选保持 passes=true，下一轮进入
      // validation-only；只有机械门禁或合法 failed claim 才把它打回 Developer。
      if (!validationReceipt && !validatorRollback) {
        validationPending = keepPendingValidation(
          validatorOutcome === 'completed' ? 'validator 未确认候选通过' : 'validator 未完整执行',
        );
      }

      // 每轮一条 iteration 不变式：continue 路径（builder 异常/no-op/门禁打回）各自留痕后跳出，
      // 走到这里的轮在此记录——evidence 时间线零空洞（v0.22.0，dogfood 发现 B）。
      recordIteration({
        validatorRan: validatorActuallyRan,
        validatorModel: validatorModel ?? null,
        validatorRouteSource: validatorChoice.source,
        skippedValidator: skipValidator,
        agentBlocked,
        ...(builderOutcome ? { builderOutcome } : {}),
        ...(validatorOutcome ? { validatorOutcome } : {}),
        ...(validatorRollback ? { abortRollback: { storyId: currentStory! } } : {}),
        ...(validationPending ? { validationPending: true as const } : {}),
        ...(validationReceipt ? { validationReceipt: true as const } : {}),
        ...(validationProtocol ? { validationProtocol } : {}),
        ...(validationTarget ? { validationTarget } : {}),
        ...(validationProtocolError ? { validationProtocolError } : {}),
        ...(validatorStateMutation ? { validatorStateMutation: true as const } : {}),
        ...(validatorEscalationTriggered ? { escalationTriggeredBy: 'validator' as const } : {}),
        ...(validatorDiagnostic ? { validatorDiagnostic } : {}),
      });

      if (!qualityContractStillCurrent()) {
        exitCode = 2;
        tamperCheckBeforeExit(i);
        break;
      }

      if (validatorOutcome === 'timeout' || validatorOutcome === 'error' || validationPending) {
        if (stalled()) {
          tamperCheckBeforeExit(i);
          break;
        }
      } else {
        stallCount = 0; // 正常走完的轮（含 agentBlocked/skipValidator 跳过轮）清零
      }

      // Completion check
      dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
      const afterRead = guard.read();
      recordTamper(afterRead, i);
      const after = afterRead.prd;
      let afterState = after ? readRunState(statePath, after) : null;
      let afterHead: string | null = null;
      if (after && afterState) {
        afterHead = readGitHead(projectRoot);
        if (!cfg.legacyValidatorProtocolForTests && afterHead === null) {
          console.error('❌ Validator 完成后无法读取当前 Git HEAD；本轮结果不能收口');
          exitCode = 2;
          break;
        }
        const reconciled = reconcileValidationReceipts(after, afterState, afterHead);
        if (reconciled.changed) {
          afterState = reconciled.state;
          writeFileAtomicSync(statePath, JSON.stringify(afterState, null, 2));
        }
        if (reconciled.invalidated.length > 0) {
          invalidateFinalReviewState(cfg.workspace);
          console.warn(
            `🔁 当前提交变化使旧 Story 需要最终重验：` +
              reconciled.invalidated.map((item) => item.storyId).join(', '),
          );
        }
      }
      if (
        after &&
        afterState &&
        allStoriesResolved(after, afterState) &&
        validationReceiptsDigest(after, afterState, afterHead) !== null
      ) {
        dashboard.setState({
          phase: 'done',
          currentStory: null,
          model: null,
          routeSource: null,
          storyDifficulty: null,
        });
        exitCode = await completeResolvedRun(after, afterState);
        break;
      }
    }
    // 循环终轮收口（第五处，ADR-007 交互残洞）：builder 异常/no-op 的 continue 路径
    // （:238/:273）在 i === maxIterations 且未触发 stall 熔断时自然耗尽本次运行，
    // 中间不会再有下一轮轮首读——本轮若被篡改，只有这里补一次 guard.read() 才能恢复/存档。
    // 对四个既有 break 出口而言是安全的幂等重复调用：它们各自最后一步已是同轮读，
    // break 前后都未再写 prd.json，磁盘已等于快照，这里的 read() 真无操作（prd-guard.ts:115）。
    try {
      lock.verify();
    } catch (error) {
      console.error(
        `❌ 最终收口前 workspace 身份已变化：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
      return 2;
    }
    const closeRead = guard.read();
    recordTamper(closeRead, lastIteration);
    if (closeRead.restoreFailed) {
      exitCode = 2;
      try {
        invalidateFinalReviewState(cfg.workspace);
      } catch (error) {
        console.warn(
          `⚠️  PRD 恢复失败后无法清理最终 Review：` +
            `${error instanceof Error ? error.message : String(error)}`,
        );
      }
      console.error(
        '❌ 最终收口时 prd.json 无法恢复到启动快照；本轮结果已作废，请修复 workspace 后重跑',
      );
    }
    const tamper = guard.summary();
    if (tamper.count > 0) {
      console.warn(
        `\n⚠️  运行期间检测到 prd.json 被修改 ${tamper.count} 次（引擎已按启动快照恢复并继续）。` +
          (tamper.archives.length > 0
            ? `篡改存档：\n${tamper.archives.map((a) => `  - ${a}`).join('\n')}`
            : '（文件删除类篡改无存档）'),
      );
    }
    // 循环结束无条件生成静态验证报告（进行中态也诚实存档）；
    // 报告是副产物：任何失败只 warn，绝不影响循环退出码。
    try {
      // closeRead 是最终一次 PRD guard 读：只要启动时建立过可信快照，即使磁盘恢复
      // 失败也必须用快照出报告。guard 从未建立快照的异常输入才保留磁盘诊断回退。
      const report =
        closeRead.prd === null
          ? writeReport(cfg.workspace, new Date(), { projectRoot })
          : writeReport(cfg.workspace, new Date(), { trustedPrd: closeRead.prd, projectRoot });
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
    try {
      lock.verify();
    } catch (error) {
      exitCode = 2;
      console.error(
        `❌ 返回结果前 workspace 身份已变化：` +
          `${error instanceof Error ? error.message : String(error)}`,
      );
    }
    // keepOpen 等待阶段只读、无需持锁；此处释放同时注销信号 handler，
    // 等待期 Ctrl+C 完全走既有 waitForSigint 语义（真实退出码保留）
    lock.release();
    if (cfg.keepOpen) {
      const url = `http://localhost:${server.address().port}`;
      console.log(`\n✅ 运行结束（退出码 ${exitCode}）。仪表盘仍在 ${url} ，按 Ctrl+C 退出。`);
      await (cfg.interrupt ?? waitForSigint());
    }
    return exitCode;
  } finally {
    lock.release(); // 幂等：正常路径已释放则短路；异常路径在此兜底
    server?.close();
  }
}
