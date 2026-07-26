import { join, basename, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
import { permissionWarning, runAgent, type AgentKind, type RunResult } from './agent.js';
import { type Prd } from './prd.js';
import { createPrdGuard } from './prd-guard.js';
import type { PrdReadResult } from './prd-guard.js';
import {
  ensureStateFile, blankStateFor, tryReadState, getCurrentStoryId, allStoriesResolved,
  enableEscalation, restoreEscalated, restoreValidated, issueValidationReceipt,
  rollbackUnvalidatedPass, rollbackUnvalidatedPasses, tryReadEngineOwnedFields,
  INITIAL_STORY_STATE, type RunState,
} from './state.js';
import {
  runQualityChecks, runContractQualityChecks, readQualityChecks, applyGateFailure, applyAbortRollback,
  abortDesc, MAX_RETRIES, ARBITRATION_PREFIXES, applyValidatorFailure,
  applyValidatorSuccess,
} from './gate.js';
import { resolveBuilderModel, resolveValidatorModel } from './models.js';
import { ModelPreflightError, preflightModelRouting, renderPreflightSummary } from './model-preflight.js';
import type { ModelCatalogResult } from './model-catalog.js';
import * as dashboard from '../dashboard/server.js';
import { writeReport } from '../report/report.js';
import {
  appendEvidence, clipEvidenceDiagnostic, type EvidenceRecord,
  type AgentInvocationEvidence, type LoopValidationProtocolErrorCode,
  type ValidationTargetEvidence,
} from './evidence.js';
import { acquireLock, LockConflictError, type LockHandle } from './lock.js';
import {
  clearValidationResult,
  createValidationRequest,
  readGitHead,
  readValidationResult,
  renderValidatorInstruction,
  type ValidationRequest,
} from './validation-protocol.js';
import { checkTddPolicy, readTddConfig, runTddGate, type TddConfig } from './tdd-gate.js';
import {
  assessQualityRuntime,
  qualityChecksMatchContract,
  readQualityContract,
  type QualityContract,
  type QualityContractReadResult,
} from '../quality/contract.js';
import { CODING_X_VERSION } from '../version.js';
import { runFinalReview } from '../review/final-review.js';
import type { FinalReviewOutcome } from '../review/types.js';
import { readFinalReviewState } from '../review/state.js';

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
  }) => Promise<FinalReviewOutcome>;
  /**
   * 仅供历史单测 fixture：允许旧 Validator 直接改 state。CLI 从不设置；生产默认
   * 必须提交结构化 validation result，禁止静默降级。
   */
  legacyValidatorProtocolForTests?: boolean;
}

function waitForSigint(): Promise<void> {
  return new Promise((resolve) => process.once('SIGINT', () => resolve()));
}

function readInstruction(dir: string, file: string): string | null {
  try {
    return readFileSync(join(dir, file), 'utf-8');
  } catch {
    return null;
  }
}

// Instruction files use the {{WORKSPACE}} placeholder instead of a hardcoded
// '.workspace/' prefix so a custom --workspace path reaches the agent. The
// agent runs at the project root, and cfg.workspace is resolved the same way
// the engine resolves it (relative to the project root, or absolute), so the
// agent and engine always share the same prd.json / state.json / progress.md.
const TDD_WORKFLOW_INSTRUCTION = [
  '',
  '本轮已启用 TDD。读取并遵循已安装的 `tdd` skill；本 story 的 acceptanceCriteria 已获用户批准，',
  '把它们作为行为清单逐项完成真实 RED→GREEN→重构。若 acceptanceCriteria 不足以确定公共行为、',
  '与源码事实冲突或需要新增覆盖排除，使用 [需要人工核实] 并将 story 置 blocked，不自行补意图。',
  '',
].join('\n');

export function renderInstruction(
  text: string,
  workspace: string,
  tddEnabled = false,
): string {
  return text
    .replaceAll('{{WORKSPACE}}', workspace)
    .replaceAll('{{MAX_RETRIES}}', String(MAX_RETRIES))
    .replaceAll('{{ARBITRATION_PREFIXES}}', ARBITRATION_PREFIXES.join('、'))
    .replaceAll('{{TDD_WORKFLOW}}', tddEnabled ? TDD_WORKFLOW_INSTRUCTION : '');
}

// 运行期读取执行状态；缺失/损坏时按全部未开始处理（绝不覆盖原文件，交给 repair）。
function readRunState(statePath: string, prd: Prd): RunState {
  const state = tryReadState(statePath);
  if (state) return state;
  console.warn('⚠️  state.json 缺失或不可读，本轮按全部 story 未开始处理；若文件损坏请运行 npx coding-x repair');
  return blankStateFor(prd);
}

// 收敛出口单源：两个 allStoriesResolved 出口（no-op 快路径/轮末完成判定）共用，
// blocked>0 时 exit 3——「收敛但待人工」对所有出口成立（ADR-009/发现 D）
const blockedConvergedExit = (prd: Prd, state: RunState): number | null => {
  const blockedIds = prd.userStories.filter((s) => state[s.id]?.blocked).map((s) => s.id);
  if (blockedIds.length > 0) {
    const passedCount = prd.userStories.length - blockedIds.length;
    console.log(`\n⏸️  ${passedCount} 个 story 通过，${blockedIds.length} 个 blocked 待人工处理（${blockedIds.join(', ')}）。处理后重跑引擎收敛剩余项；人审入口见 .workspace/report.html 与 state.json notes。`);
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
  const prdPath = join(cfg.workspace, 'prd.json');
  const statePath = join(cfg.workspace, 'state.json');
  const guard = createPrdGuard(prdPath);
  const builderRaw = readInstruction(cfg.instructionsDir, 'builder.md');
  const validatorRaw = readInstruction(cfg.instructionsDir, 'validator.md');

  let server: ReturnType<typeof dashboard.start> | null = null;
  try {
    const projectRoot = resolve(cfg.projectRoot ?? process.cwd());
    const qualityReader = cfg.qualityContractReader ?? readQualityContract;
    const qualityRead = qualityReader(projectRoot);
    if (qualityRead.status !== 'ready') {
      const detail = qualityRead.status === 'missing'
        ? '质量契约不存在；请先运行 coding-x init'
        : qualityRead.status === 'invalid'
          ? qualityRead.errors.join('；')
          : qualityRead.error;
      console.error(`❌ 质量契约不可用（${qualityRead.path}）：${detail}`);
      return 2;
    }
    const runtime = assessQualityRuntime(
      qualityRead.contract,
      cfg.actualVersion ?? CODING_X_VERSION,
      cfg.shadow ?? false,
    );
    if (runtime.mode === 'version-mismatch') {
      console.error(
        `❌ coding-x 版本与质量契约不一致：契约要求 ${runtime.expectedVersion}，` +
        `当前为 ${runtime.actualVersion}。请使用固定版本，或只为候选 Dogfood 显式加 --shadow。`,
      );
      return 2;
    }
    if (runtime.mode === 'shadow') {
      console.log(
        `🧪 Shadow 模式：契约版本 ${runtime.expectedVersion}，当前版本 ${runtime.actualVersion}；` +
        '本次运行永远不会产生可交付结论。',
      );
    }
    // 启动时保证 state.json 存在：v0.4 及更早的 prd.json 把状态写在 story 上，
    // ensureStateFile 会把它们抽取成 state.json（一次性迁移）。
    const bootPrd = guard.read().prd;
    if (bootPrd) ensureStateFile(cfg.workspace, bootPrd);
    // ensureStateFile 为了 legacy 迁移会在损坏 state 时返回内嵌旧状态，但运行期
    // 绝不能因此“复活”旧 passes。重读磁盘：新迁移文件可读则正常使用，
    // 仍损坏则与轮内 readRunState 一样按全未开始处理，且不覆盖原文件。
    let bootState = bootPrd
      ? (tryReadState(statePath) ?? blankStateFor(bootPrd))
      : null;
    // 最终 Review 后的任何新提交都会使旧 Review 失效。Story 与变更文件没有可靠的
    // 多对多映射，因此首版保守重验全部已通过 Story，绝不猜测“只影响哪几个”。
    // 这里同时撤销候选通过与引擎凭证，让既有 Developer → 门禁 → Validator 顺序完整重跑。
    if (bootState) {
      const previousReview = readFinalReviewState(cfg.workspace);
      const currentHead = readGitHead(projectRoot);
      if (previousReview.status === 'ready' && currentHead
          && previousReview.state.binding.headSha !== currentHead) {
        const invalidated: string[] = [];
        const next = structuredClone(bootState);
        for (const story of bootPrd!.userStories) {
          const current = next[story.id];
          if (!current || current.blocked || !current.passes || !current.validated) continue;
          next[story.id] = { ...current, passes: false, validated: false };
          invalidated.push(story.id);
        }
        if (invalidated.length > 0) {
          bootState = next;
          writeFileAtomicSync(statePath, JSON.stringify(bootState, null, 2));
          console.warn(
            `⚠️  最终 Review 后提交已变化，旧 Validator 凭证失效；` +
            `将保守重验：${invalidated.join(', ')}`,
          );
        }
      }
    }
    // 进程可能在 builder 写 passes=true 后、validator 签发凭证前被杀。显式
    // validated=false 是 v0.25 的待验收残态；启动时回写成可被 builder 重新选中的状态。
    // 旧 state 缺字段时 tryReadState 已按历史 passes 兼容，不会在这里被误重验。
    if (bootState) {
      const recovered = rollbackUnvalidatedPasses(bootState);
      if (recovered.storyIds.length > 0) {
        bootState = recovered.state;
        writeFileAtomicSync(statePath, JSON.stringify(bootState, null, 2));
        console.warn(`⚠️  检测到未完成 validator 的待验收状态，已回写待复核：${recovered.storyIds.join(', ')}`);
      }
    }
    const agentCwd = projectRoot;
    const agentEnv: NodeJS.ProcessEnv = {
      CODING_X_WORKSPACE: resolve(cfg.workspace),
      CODING_X_PROJECT_ROOT: agentCwd,
    };
    const tddRead = readTddConfig(bootPrd);
    let tddConfig: TddConfig | null = null;
    if (tddRead.status === 'invalid') {
      const diagnostic = clipEvidenceDiagnostic(tddRead.error);
      try {
        appendEvidence(cfg.workspace, {
          type: 'tdd-gate', source: 'engine', at: new Date().toISOString(),
          phase: 'preflight', iteration: 0, storyId: null,
          ok: false, policyOk: false, commandRan: false, ms: 0,
          failureCode: 'invalid-config', failedCommand: '[tdd-config]',
          exitCode: null, timedOut: false, diagnosticTail: diagnostic,
        });
      } catch (err) {
        console.warn(`⚠️  TDD 预检 evidence 写入失败：${err instanceof Error ? err.message : String(err)}`);
      }
      console.error(`❌ TDD 配置预检失败：${tddRead.error}`);
      return 1;
    }
    if (tddRead.status === 'enabled') {
      tddConfig = tddRead.config;
      const policy = checkTddPolicy(tddConfig, agentCwd);
      const diagnostic = policy.failure
        ? clipEvidenceDiagnostic(policy.failure.outputTail).trim()
        : '';
      try {
        appendEvidence(cfg.workspace, {
          type: 'tdd-gate', source: 'engine', at: new Date().toISOString(),
          phase: 'preflight', iteration: 0, storyId: null,
          ok: policy.ok, policyOk: policy.ok, commandRan: false, ms: policy.ms,
          ...(policy.failure ? {
            failureCode: policy.failure.code,
            failedCommand: policy.failure.command,
            exitCode: policy.failure.exitCode,
            timedOut: policy.failure.timedOut,
            diagnosticTail: diagnostic || 'TDD 政策预检失败',
          } : {}),
        });
      } catch (err) {
        console.warn(`⚠️  TDD 预检 evidence 写入失败：${err instanceof Error ? err.message : String(err)}`);
      }
      if (!policy.ok) {
        console.error(`❌ TDD 政策预检失败：${policy.failure!.outputTail}`);
        return 1;
      }
    }
    const builder = builderRaw === null
      ? null
      : renderInstruction(builderRaw, cfg.workspace, tddConfig !== null);
    const validatorBase = validatorRaw === null
      ? null
      : renderInstruction(validatorRaw, cfg.workspace, tddConfig !== null);
    let preflight;
    try {
      preflight = await preflightModelRouting({
        prd: bootPrd,
        state: bootState,
        requestedRunner: cfg.kind,
        runnerExplicit: cfg.kindExplicit ?? true,
        builderOverride: cfg.builderModel,
        validatorOverride: cfg.validatorModel,
        escalationOverride: cfg.escalationModel,
        reviewOverride: cfg.reviewModel,
        ...(cfg.modelCatalog ? { catalog: cfg.modelCatalog } : {}),
      });
    } catch (err) {
      if (err instanceof ModelPreflightError) {
        console.error(`❌ 模型路由预检失败：${err.message}`);
        return 2;
      }
      throw err;
    }
    // 生产最终 Review 必须绑定一个明确模型；测试可注入不调用模型的评审器。
    // 在任何 Story agent 启动前拒绝，避免实现全部完成后才发现结果无法签发。
    if (!preflight.review.model && !cfg.finalReviewRunner) {
      console.error(
        '❌ 模型路由预检失败：最终 Review 必须使用明确模型；' +
        '请在 prd.json models.validator 中固定，或传 --review-model',
      );
      return 2;
    }
    if (!bootPrd) {
      console.error(`❌ 无法读取 ${prdPath}；请先从源 PRD 重新派生`);
      return 2;
    }
    if (bootPrd.qualityContractDigest !== qualityRead.digest) {
      const received = typeof bootPrd.qualityContractDigest === 'string'
        ? bootPrd.qualityContractDigest
        : 'missing';
      console.error(
        `❌ PRD 的质量契约摘要无效：期望 ${qualityRead.digest}，收到 ${received}。` +
        '请停止运行并从当前质量契约重新派生 PRD。',
      );
      return 2;
    }
    if (!cfg.legacyValidatorProtocolForTests
        && !qualityChecksMatchContract(bootPrd.qualityChecks, qualityRead.contract)) {
      console.error(
        '❌ prd.json 的 qualityChecks 不是当前质量契约的完整派生快照。' +
        '请重新派生 PRD；不要手写或单独维护项目检查。',
      );
      return 2;
    }
    // 正式模式执行 PRD 中已经过逐字段核对的冻结快照；历史测试兼容路径没有新快照时
    // 才回退测试注入契约，生产不会走该分支。
    const frozenQualityChecks = qualityChecksMatchContract(
      bootPrd.qualityChecks,
      qualityRead.contract,
    )
      ? structuredClone(bootPrd.qualityChecks)
      : structuredClone(qualityRead.contract.checks);
    const runKind = preflight.runner;
    const bootResolved = !!(bootPrd && bootState && allStoriesResolved(bootPrd, bootState));
    for (const warning of preflight.warnings) console.warn(`⚠️  ${warning}`);
    console.log(renderPreflightSummary(preflight));
    if (!bootResolved) console.warn(permissionWarning(runKind));

    server = dashboard.start({
      workspace: cfg.workspace,
      maxIterations: cfg.maxIterations,
      port: cfg.port,
      openBrowser: cfg.openBrowser ?? true,
    });
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
      try { return readFileSync(p, 'utf-8'); } catch { return null; }
    };
    const outcomeOf = (r: { timedOut: boolean; exitCode: number | null }): 'completed' | 'timeout' | 'error' =>
      r.timedOut ? 'timeout' : r.exitCode === 0 ? 'completed' : 'error';
    const invocationOf = (
      result: RunResult,
      outcome: 'completed' | 'timeout' | 'error',
    ): AgentInvocationEvidence => {
      const diagnostic = outcome === 'completed'
        ? ''
        : clipEvidenceDiagnostic(result.outputTail).trim();
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
          console.warn(`⚠️  evidence 记录写入失败（不影响循环）：${err instanceof Error ? err.message : String(err)}`);
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
          type: 'tamper', source: 'engine', at: new Date().toISOString(), iteration,
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
    const stallLimit = cfg.stallLimit ?? 3;
    let stallCount = 0;
    // stall 熔断判定：stall 轮调用；达限打横幅并返回 true（调用方 break）
    const stalled = (): boolean => {
      stallCount += 1;
      if (stallCount < stallLimit) return false;
      console.error(`\n🛑 连续 ${stallLimit} 轮无进展（no-op/超时/异常退出），提前终止。排查 agent CLI 可用性、模型名与网络后重跑（引擎幂等续跑）。`);
      return true;
    };
    let exitCode = 1;
    const completeResolvedRun = async (prd: Prd, state: RunState): Promise<number> => {
      const blocked = blockedConvergedExit(prd, state);
      if (blocked !== null) return blocked;
      console.log('\n🔎 全部 story 已验证，开始针对当前 PR 最新提交执行本地最终 Review。');
      const finalReview = await (cfg.finalReviewRunner ?? runFinalReview)({
        root: projectRoot,
        workspace: cfg.workspace,
        currentContract: qualityRead.contract,
        runner: runKind,
        model: preflight.review.model,
        codingXVersion: cfg.actualVersion ?? CODING_X_VERSION,
        shadow: cfg.shadow ?? false,
        timeoutMs: cfg.valTimeoutMs,
      });
      const emit = finalReview.exitCode === 0 || finalReview.exitCode === 7 ? console.log : console.error;
      emit(`\n${finalReview.exitCode === 0 ? '✅' : finalReview.exitCode === 7 ? '🧪' : '⏸️'} ${finalReview.message}`);
      return finalReview.exitCode;
    };
    if (bootResolved) {
      dashboard.setState({ phase: 'done', model: null, routeSource: null, storyDifficulty: null });
      exitCode = await completeResolvedRun(bootPrd, bootState!);
    }
    for (let i = 1; !bootResolved && i <= cfg.maxIterations; i++) {
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
      // 上一轮可能由非当前 story 的所有权篡改留下 passes=true/validated=false。
      // 在选取 current story 前统一回写，避免该候选因 passes=true 被 builder 跳过而空转；
      // 这里只发生在轮界，不会碰当前轮 builder→validator 之间的合法候选。
      if (beforeState) {
        const recovered = rollbackUnvalidatedPasses(beforeState);
        if (recovered.storyIds.length > 0) {
          beforeState = recovered.state;
          writeFileAtomicSync(statePath, JSON.stringify(beforeState, null, 2));
          stateRawBefore = rawOf(statePath);
          console.warn(`⚠️  检测到跨轮未签发的待验收状态，已回写待复核：${recovered.storyIds.join(', ')}`);
        }
      }
      const currentStory = before && beforeState ? getCurrentStoryId(before, beforeState) : null;
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
          if (!owned || (owned.validated === expected.validated
              && owned.escalated === expected.escalated)) continue;
          materialized = { ...materialized, [storyId]: { ...expected } };
          materializedChanged = true;
        }
        if (materializedChanged) {
          writeFileAtomicSync(statePath, JSON.stringify(materialized, null, 2));
          stateRawBefore = rawOf(statePath);
        }
      }
      const routeTampers: Array<{
        storyId: string; expected: boolean; received: boolean | 'missing'; side: 'builder' | 'validator';
      }> = [];
      const validationTampers: Array<{
        storyId: string; expected: boolean; received: boolean | 'missing'; side: 'builder' | 'validator';
      }> = [];
      const restoreEngineOwnership = (
        side: 'builder' | 'validator', expectedState: RunState | null,
      ): { storyMissing: boolean } => {
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
            restored, storyId, expected.escalated, expected, observed?.escalated,
          );
          restored = route.state;
          const validation = restoreValidated(
            restored, storyId, expected.validated, expected, observed?.validated,
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
            validationTampers.push({ storyId, ...validation.tamper, side });
            console.warn(
              `⚠️  ${side} 修改了引擎独占的 ${storyId}.validated ` +
              `(${validation.tamper.expected} → ${validation.tamper.received})，已恢复`,
            );
          }
        }
        if (changed) writeFileAtomicSync(statePath, JSON.stringify(restored, null, 2));
        return { storyMissing };
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
      const rollbackIfUnvalidatedPass = (side: 'builder' | 'validator', r: { timedOut: boolean; exitCode: number | null }): boolean => {
        if (!currentStory) return false;
        const passedBefore = beforeState?.[currentStory]?.passes ?? false;
        const st = tryReadState(statePath);
        const cur = st?.[currentStory];
        if (!st || !cur || !cur.passes || cur.blocked || passedBefore) return false;
        const next = applyAbortRollback(st, currentStory, { side, timedOut: r.timedOut, exitCode: r.exitCode }, new Date());
        writeFileAtomicSync(statePath, JSON.stringify(next, null, 2));
        console.warn(`⚠️  ${currentStory} 在中断轮被置为通过，未经完整验收——已回写待复核（${side} ${abortDesc(r)}）`);
        return true;
      };
      const rollbackPendingValidation = (reason: string): boolean => {
        if (!currentStory) return false;
        const state = tryReadState(statePath);
        if (!state) return false;
        const rolled = rollbackUnvalidatedPass(state, currentStory);
        if (!rolled.changed) return false;
        writeFileAtomicSync(statePath, JSON.stringify(rolled.state, null, 2));
        console.warn(`⚠️  ${currentStory} 未取得引擎验收凭证（${reason}），已回写待复核`);
        return true;
      };
      const builderChoice = resolveBuilderModel({
        builderOverride: cfg.builderModel, escalationOverride: cfg.escalationModel,
        config: preflight.config, story: currentStoryObj,
        escalated: currentStory && beforeState ? (beforeState[currentStory]?.escalated ?? false) : false,
      });
      let builderInvocation: AgentInvocationEvidence | undefined;
      let validatorInvocation: AgentInvocationEvidence | undefined;
      // 「每轮一条 iteration」五个写入点的公共底座单源：各点只传差异字段——
      // 0.22.0 轮五点位分四批才靠审查抓齐，字段漂移风险有实证，底座必须只有一份。
      const recordIteration = (over: Partial<Extract<EvidenceRecord, { type: 'iteration' }>>) => {
        recordEvidence({
          type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
          storyId: currentStory, builderRan: !!builder, builderModel: builderChoice.model ?? null,
          validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
          builderRouteSource: builderChoice.source,
          ...(currentStoryObj?.difficulty ? { storyDifficulty: currentStoryObj.difficulty } : {}),
          ...(routeTampers.length > 0 ? { stateRouteTamper: [...routeTampers] } : {}),
          ...(validationTampers.length > 0 ? { stateValidationTamper: [...validationTampers] } : {}),
          ...(builderInvocation ? { builderInvocation } : {}),
          ...(validatorInvocation ? { validatorInvocation } : {}),
          ...over,
        });
      };

      dashboard.setState({
        iteration: i, phase: 'developing', currentStory,
        model: builder ? (builderChoice.model ?? null) : null,
        routeSource: builder ? builderChoice.source : null,
        storyDifficulty: currentStoryObj?.difficulty ?? null,
      });

      // Developer
      let builderOutcome: 'completed' | 'timeout' | 'error' | undefined;
      let builderRollback = false;
      if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else {
        console.log(
          `🧠 builder 实际模型: ${builderChoice.model ?? 'runner 默认'} [${builderChoice.source}]` +
          `${currentStoryObj?.difficulty ? ` · 难度 ${currentStoryObj.difficulty}` : ''}` +
          `${builderChoice.escalated ? ` · ${currentStory} 升级路由` : ''}`,
        );
        const dev = await runAgent({
          kind: runKind, prompt: builder, cwd: agentCwd, timeoutMs: cfg.devTimeoutMs,
          model: builderChoice.model, env: agentEnv,
        });
        builderOutcome = outcomeOf(dev);
        builderInvocation = invocationOf(dev, builderOutcome);
        restoreEngineOwnership('builder', beforeState);
        if (builderOutcome !== 'completed') {
          builderRollback = rollbackIfUnvalidatedPass('builder', dev);
          // evidence=引擎机械事实：agentBlocked 不能硬编码 false——agent 可能同轮已置 blocked:true
          // 又以非零码退出（如仲裁上报后环境异常收尾），此处需实时读一次 state 反映真实情况。
          const blockedNow = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
          recordIteration({
            agentBlocked: blockedNow,
            builderOutcome, ...(builderRollback ? { abortRollback: { storyId: currentStory! } } : {}),
          });
          dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
          if (stalled()) { tamperCheckBeforeExit(i); break; }
          continue; // 异常轮：跳过门禁与验收，下轮重试（回写已保证不带走未验收的 true）
        }
      }

      // no-op 空转检测：builder 正常结束但 state 与 progress 双无变化（机械信号）——
      // 跳过门禁与验收（省一次强模型调用），计入 stall。
      if (builder && builderOutcome === 'completed'
          && !qualityContractStillCurrent()) {
        recordIteration({ builderOutcome: 'completed' });
        exitCode = 2;
        tamperCheckBeforeExit(i);
        break;
      }

      if (builder && builderOutcome === 'completed'
          && rawOf(statePath) === stateRawBefore && rawOf(progressPath) === progressRawBefore) {
        // 双无变化不等于「无事发生」：本轮开始时可能已经全部 resolved（如 legacy 迁移在
        // bootstrap 就把 passes 写进 state.json，或断点续跑接手一个已完成的工作区）——
        // before/beforeState 就是这轮唯一会有的磁盘状态（没变化），完成判定照样要跑，
        // 否则已完工的工作区会被当成空转一路吃到熔断。
        if (before && beforeState && allStoriesResolved(before, beforeState)) {
          // 每轮一条 iteration 不变式：这条快路径 break 前也要留痕，否则已完工工作区
          // 重跑的终轮在 evidence 时间线上是空洞（其余所有退出路径都恰写一条）。
          recordIteration({ builderOutcome: 'completed', noop: true });
          tamperCheckBeforeExit(i);
          dashboard.setState({ phase: 'done', model: null, routeSource: null, storyDifficulty: null });
          exitCode = await completeResolvedRun(before, beforeState);
          break;
        }
        console.warn('⏭️  本轮 builder 无任何产出（state/progress 双无变化），跳过门禁与验收');
        const escalationTriggered = triggerEscalation('noop');
        recordIteration({
          builderOutcome: 'completed', noop: true,
          ...(escalationTriggered ? { escalationTriggeredBy: 'noop' as const } : {}),
        });
        dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
        if (stalled()) { tamperCheckBeforeExit(i); break; }
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
      const legacyChecks = cfg.legacyValidatorProtocolForTests
        && Array.isArray(gateRead.prd?.qualityChecks)
        ? readQualityChecks(gateRead.prd)
        : null;
      const derivedSnapshot = qualityChecksMatchContract(
        gateRead.prd?.qualityChecks,
        qualityRead.contract,
      );
      if (cfg.legacyValidatorProtocolForTests
          && gateRead.prd?.qualityChecks !== undefined
          && !derivedSnapshot
          && (legacyChecks === 'invalid' || !Array.isArray(gateRead.prd.qualityChecks))) {
        console.warn('⚠️  prd.json 的 qualityChecks 形状非法（应为字符串数组），机械门禁未启用');
      } else if (!agentBlocked && currentStory
          && (!cfg.legacyValidatorProtocolForTests
            || (legacyChecks !== 'invalid' && legacyChecks !== null)
            || derivedSnapshot)) {
        dashboard.setState({
          phase: 'gating', model: null, routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
        const gate = legacyChecks && legacyChecks !== 'invalid'
          ? await runQualityChecks(legacyChecks, agentCwd)
          : await runContractQualityChecks(frozenQualityChecks, agentCwd);
        const skippedChecks = 'skipped' in gate && Array.isArray(gate.skipped)
          ? gate.skipped.filter((value): value is string => typeof value === 'string')
          : [];
        if (skippedChecks.length > 0) {
          console.log(`⏭️  当前系统不适用的质量检查：${skippedChecks.join('、')}`);
        }
        const gateDiagnostic = gate.failure
          ? clipEvidenceDiagnostic(gate.failure.outputTail).trim()
          : '';
        recordEvidence({
          type: 'gate-run', source: 'engine', at: new Date().toISOString(), iteration: i,
          storyId: currentStory, ok: gate.ok, total: gate.total, ran: gate.ran, ms: gate.ms,
          ...(gate.failure ? {
            failedCommand: gate.failure.command, exitCode: gate.failure.exitCode, timedOut: gate.failure.timedOut,
            ...(gateDiagnostic ? { diagnosticTail: gateDiagnostic } : {}),
          } : {}),
        });
        if (!gate.ok) {
          console.error(`\n❌ 机械门禁未通过（${gate.failure!.command}），打回 ${currentStory} 待下轮重试`);
          const st = tryReadState(statePath);
          if (st) {
            const failed = applyGateFailure(st, currentStory, gate.failure!, new Date());
            const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
            writeFileAtomicSync(statePath, JSON.stringify(enabled.state, null, 2));
            if (enabled.changed) console.log(`⬆️  ${currentStory} 首次有效失败（gate），下轮起使用 escalation 模型`);
            recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}), validatorOutcome: 'skipped', gateRejected: true,
              ...(enabled.changed ? { escalationTriggeredBy: 'gate' as const } : {}),
            });
          } else {
            // 缺失/损坏都不落盘打回：绝不覆盖可能损坏的文件（同 ensureStateFile 语义）
            console.warn('⚠️  state.json 缺失或不可读，门禁打回未落盘；若文件损坏请运行 npx coding-x repair');
          }
          if (!st) recordIteration({
            ...(builderOutcome ? { builderOutcome } : {}), validatorOutcome: 'skipped', gateRejected: true,
          });
          stallCount = 0; // 有 state 写入=有活动；打回预算由 MAX_RETRIES 独立约束
          // 已知不对称：门禁把最后一个 story 打到 blocked 时，本轮 continue 跳过完成判定，
          // 完成要到下一轮才被发现；发生在末轮迭代时退出码为 1（validator 打回则当轮判定）。低频且 blocked→1 语义诚实，接受。
          dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
          continue;
        }
      }

      // TDD 最终门禁：普通检查之后、Validator 之前重新校验受保护政策面并运行
      // coverageCheck。它不消费或信任宿主 hook 的结果。
      if (!agentBlocked && tddConfig && currentStory) {
        dashboard.setState({
          phase: 'gating', model: null, routeSource: null,
          storyDifficulty: currentStoryObj?.difficulty ?? null,
        });
        const tddGate = await runTddGate(tddConfig, agentCwd);
        const diagnostic = tddGate.failure
          ? clipEvidenceDiagnostic(tddGate.failure.outputTail).trim()
          : '';
        recordEvidence({
          type: 'tdd-gate', source: 'engine', at: new Date().toISOString(),
          phase: 'post-builder', iteration: i, storyId: currentStory,
          ok: tddGate.ok, policyOk: tddGate.policyOk,
          commandRan: tddGate.commandRan, ms: tddGate.ms,
          ...(tddGate.failure ? {
            failureCode: tddGate.failure.code,
            failedCommand: tddGate.failure.command,
            exitCode: tddGate.failure.exitCode,
            timedOut: tddGate.failure.timedOut,
            diagnosticTail: diagnostic || 'TDD 门禁失败',
          } : {}),
        });
        if (!tddGate.ok) {
          console.error(`\n❌ TDD 门禁未通过（${tddGate.failure!.command}），打回 ${currentStory} 待下轮重试`);
          const st = tryReadState(statePath);
          if (st) {
            const failed = applyGateFailure(st, currentStory, tddGate.failure!, new Date());
            const enabled = enableEscalation(failed, currentStory, hasDedicatedEscalation);
            writeFileAtomicSync(statePath, JSON.stringify(enabled.state, null, 2));
            if (enabled.changed) console.log(`⬆️  ${currentStory} 首次有效失败（gate），下轮起使用 escalation 模型`);
            recordIteration({
              ...(builderOutcome ? { builderOutcome } : {}),
              validatorOutcome: 'skipped', gateRejected: true,
              ...(enabled.changed ? { escalationTriggeredBy: 'gate' as const } : {}),
            });
          } else {
            console.warn('⚠️  state.json 缺失或不可读，TDD 门禁打回未落盘；若文件损坏请运行 npx coding-x repair');
          }
          if (!st) recordIteration({
            ...(builderOutcome ? { builderOutcome } : {}),
            validatorOutcome: 'skipped', gateRejected: true,
          });
          stallCount = 0;
          dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
          continue;
        }
      }

      // Validator
      const validatorChoice = resolveValidatorModel({ cliOverride: cfg.validatorModel, config: preflight.config });
      const validatorModel = validatorChoice.model;
      const structuredValidation = !cfg.legacyValidatorProtocolForTests;
      const validatorWillRun = !!validatorBase && !skipValidator && !agentBlocked
        && (!structuredValidation || !!currentStoryObj);
      dashboard.setState({
        phase: 'validating', model: validatorWillRun ? (validatorModel ?? null) : null,
        routeSource: validatorWillRun ? validatorChoice.source : null,
        storyDifficulty: currentStoryObj?.difficulty ?? null,
      });
      let validatorOutcome: 'completed' | 'timeout' | 'error' | 'skipped' | undefined;
      let validatorActuallyRan = false;
      let validatorRollback = false;
      let validationRollback = false;
      let validationReceipt = false;
      let validatorEscalationTriggered = false;
      let validatorDiagnostic: string | undefined;
      let validationProtocol: 'passed' | 'failed' | 'invalid' | undefined;
      let validationTarget: ValidationTargetEvidence | undefined;
      let validationProtocolError: {
        code: LoopValidationProtocolErrorCode;
        diagnostic: string;
      } | undefined;
      let validatorStateMutation = false;
      const rejectProtocol = (code: LoopValidationProtocolErrorCode, diagnostic: string) => {
        validationProtocol = 'invalid';
        validationProtocolError = {
          code,
          diagnostic: clipEvidenceDiagnostic(diagnostic),
        };
        console.warn(`⚠️  ${currentStory ?? '当前 story'} Validator 结构化结果无效（${code}）：${diagnostic}`);
      };

      if (!validatorBase) {
        console.error('❌ validator.md 不存在，本轮无法签发验收凭证');
        validatorOutcome = 'skipped';
      } else if (skipValidator) {
        console.warn('⚠️  prd.json 快照写回失败，跳过本轮 validator（磁盘验收标准不可信）');
        validatorOutcome = 'skipped';
      } else if (!agentBlocked && (!structuredValidation || currentStoryObj)) {
        console.log(`🧠 validator 实际模型: ${validatorModel ?? 'runner 默认'} [${validatorChoice.source}]`);
        const validatorStateBefore = tryReadState(statePath);
        const currentValidatorStateBefore = currentStory ? validatorStateBefore?.[currentStory] : undefined;
        const stateRawBeforeValidator = rawOf(statePath);
        let validationRequest: ValidationRequest | null = null;
        let validatorPrompt = validatorBase;
        let canStartValidator = true;

        if (structuredValidation && currentStoryObj) {
          validationRequest = createValidationRequest(
            currentStoryObj,
            cfg.workspace,
            readGitHead(agentCwd),
          );
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
          const val = await runAgent({
            kind: runKind, prompt: validatorPrompt, cwd: agentCwd, timeoutMs: cfg.valTimeoutMs,
            model: validatorModel, env: agentEnv,
          });
          validatorOutcome = outcomeOf(val);
          validatorInvocation = invocationOf(val, validatorOutcome);
          const stateRawAfterValidator = rawOf(statePath);
          const validatorOwnership = restoreEngineOwnership('validator', validatorStateBefore);

          if (structuredValidation && stateRawAfterValidator !== stateRawBeforeValidator) {
            validatorStateMutation = true;
            if (stateRawBeforeValidator !== null) {
              writeFileAtomicSync(statePath, stateRawBeforeValidator);
            }
            console.warn(`⚠️  ${currentStory} Validator 修改了 state.json，已恢复调用前快照并拒绝本轮结论`);
          }

          if (!structuredValidation) {
            // 历史单测专用兼容路径：生产 CLI 永不进入。旧 Validator 直接写 state，
            // 仍按 v0.25 receipt 语义恢复引擎字段并判定。
            if (validatorOutcome !== 'completed') {
              validatorRollback = rollbackIfUnvalidatedPass('validator', val);
            } else if (currentStory && currentValidatorStateBefore && !validatorOwnership.storyMissing) {
              let stateAfter = tryReadState(statePath);
              const validatorStateAfter = stateAfter?.[currentStory];
              const rejected = !!validatorStateAfter
                && !validatorStateAfter.passes
                && validatorStateAfter.retryCount > currentValidatorStateBefore.retryCount;
              if (rejected) {
                const diagnostic = clipEvidenceDiagnostic(validatorStateAfter.notes).trim();
                if (diagnostic) validatorDiagnostic = diagnostic;
                validatorEscalationTriggered = triggerEscalation('validator');
              }
              if (stateAfter && currentValidatorStateBefore.passes && !currentValidatorStateBefore.blocked
                  && validatorStateAfter?.passes && !validatorStateAfter.blocked) {
                stateAfter = tryReadState(statePath);
                if (stateAfter) {
                  const issued = issueValidationReceipt(stateAfter, currentStory);
                  if (issued.changed) {
                    writeFileAtomicSync(statePath, JSON.stringify(issued.state, null, 2));
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
              readGitHead(agentCwd),
            );
            try {
              clearValidationResult(validationRequest.resultPath);
            } catch (err) {
              // nonce 已阻止下轮复用；留存清理故障但不把已完成的当前绑定判成假失败。
              console.warn(`⚠️  validation result 清理失败，下轮会再次拒绝旧文件：${err instanceof Error ? err.message : String(err)}`);
            }

            if (validatorOutcome !== 'completed') {
              rejectProtocol('agent-aborted', `Validator ${abortDesc(val)}`);
              validatorRollback = rollbackIfUnvalidatedPass('validator', val);
            } else if (validatorStateMutation) {
              rejectProtocol('state-mutated', 'Validator 修改了引擎独占的 state.json');
            } else if (!protocol.ok) {
              rejectProtocol(protocol.code, protocol.diagnostic);
            } else if (currentStory && validatorStateBefore && currentValidatorStateBefore) {
              recordEvidence({
                type: 'validation-claim', source: 'validator', at: new Date().toISOString(), iteration: i,
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
                  console.log(`⬆️  ${currentStory} 首次有效失败（validator），下轮起使用 escalation 模型`);
                }
                const diagnostic = clipEvidenceDiagnostic(enabled.state[currentStory]?.notes ?? '').trim();
                if (diagnostic) validatorDiagnostic = diagnostic;
              } else if (!currentValidatorStateBefore.passes || currentValidatorStateBefore.blocked) {
                rejectProtocol('candidate-not-passing', 'Builder 未留下可验收的 passes=true 候选态');
              } else {
                const passed = applyValidatorSuccess(validatorStateBefore, currentStory);
                const issued = issueValidationReceipt(passed, currentStory);
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

      // 除 blocked 外，任何没有签发凭证的路径都不能把 builder 的 passes=true 带到
      // 下一轮；异常结局已由 applyAbortRollback 回写，此处覆盖缺指令/skip 等其余路径。
      if (!validationReceipt && !validatorRollback) {
        validationRollback = rollbackPendingValidation(
          validatorOutcome === 'completed' ? 'validator 未确认候选通过' : 'validator 未完整执行',
        );
      }

      // 每轮一条 iteration 不变式：continue 路径（builder 异常/no-op/门禁打回）各自留痕后跳出，
      // 走到这里的轮在此记录——evidence 时间线零空洞（v0.22.0，dogfood 发现 B）。
      recordIteration({
        validatorRan: validatorActuallyRan,
        validatorModel: validatorModel ?? null,
        validatorRouteSource: validatorChoice.source,
        skippedValidator: skipValidator, agentBlocked,
        ...(builderOutcome ? { builderOutcome } : {}),
        ...(validatorOutcome ? { validatorOutcome } : {}),
        ...(validatorRollback ? { abortRollback: { storyId: currentStory! } } : {}),
        ...(validationRollback ? { validationRollback: true as const } : {}),
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

      if (validatorOutcome === 'timeout' || validatorOutcome === 'error' || validationRollback) {
        if (stalled()) { tamperCheckBeforeExit(i); break; }
      } else {
        stallCount = 0; // 正常走完的轮（含 agentBlocked/skipValidator 跳过轮）清零
      }

      // Completion check
      dashboard.setState({ phase: 'idle', model: null, routeSource: null, storyDifficulty: null });
      const afterRead = guard.read();
      recordTamper(afterRead, i);
      const after = afterRead.prd;
      const afterState = after ? readRunState(statePath, after) : null;
      if (after && afterState && allStoriesResolved(after, afterState)) {
        dashboard.setState({ phase: 'done', model: null, routeSource: null, storyDifficulty: null });
        exitCode = await completeResolvedRun(after, afterState);
        break;
      }
    }
    // 循环终轮收口（第五处，ADR-007 交互残洞）：builder 异常/no-op 的 continue 路径
    // （:238/:273）在 i === maxIterations 且未触发 stall 熔断时自然耗尽本次运行，
    // 中间不会再有下一轮轮首读——本轮若被篡改，只有这里补一次 guard.read() 才能恢复/存档。
    // 对四个既有 break 出口而言是安全的幂等重复调用：它们各自最后一步已是同轮读，
    // break 前后都未再写 prd.json，磁盘已等于快照，这里的 read() 真无操作（prd-guard.ts:115）。
    const closeRead = guard.read();
    recordTamper(closeRead, cfg.maxIterations);
    const tamper = guard.summary();
    if (tamper.count > 0) {
      console.warn(
        `\n⚠️  运行期间检测到 prd.json 被修改 ${tamper.count} 次（引擎已按启动快照恢复并继续）。` +
        (tamper.archives.length > 0 ? `篡改存档：\n${tamper.archives.map((a) => `  - ${a}`).join('\n')}` : '（文件删除类篡改无存档）'),
      );
    }
    // 循环结束无条件生成静态验证报告（进行中态也诚实存档）；
    // 报告是副产物：任何失败只 warn，绝不影响循环退出码。
    try {
      // closeRead 是最终一次 PRD guard 读：只要启动时建立过可信快照，即使磁盘恢复
      // 失败也必须用快照出报告。guard 从未建立快照的异常输入才保留磁盘诊断回退。
      const report = closeRead.prd === null
        ? writeReport(cfg.workspace, new Date())
        : writeReport(cfg.workspace, new Date(), { trustedPrd: closeRead.prd });
      if (report.status === 'written') {
        console.log(`📄 验证报告: ${report.path}`);
      } else {
        console.warn(`⚠️  验证报告未生成（prd.json ${report.status === 'missing' ? '缺失' : '不可解析'}）`);
      }
    } catch (err) {
      console.warn(`⚠️  验证报告生成失败：${err instanceof Error ? err.message : String(err)}`);
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
