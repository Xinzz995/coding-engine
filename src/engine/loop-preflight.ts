import { join, resolve } from 'node:path';
import { permissionWarning, type AgentKind } from './agent.js';
import { appendEvidence, clipEvidenceDiagnostic } from './evidence.js';
import { writeFileAtomicSync } from './fs-atomic.js';
import { readLoopInstructions, renderLoopInstructions } from './loop-instructions.js';
import type { LoopConfig } from './loop.js';
import {
  ModelPreflightError,
  preflightModelRouting,
  renderPreflightSummary,
  type ModelPreflightResult,
} from './model-preflight.js';
import { createPrdGuard } from './prd-guard.js';
import type { Prd } from './prd.js';
import {
  allStoriesResolved,
  blankStateFor,
  ensureStateFile,
  rollbackUnvalidatedPasses,
  tryReadState,
  type RunState,
} from './state.js';
import { checkTddPolicy, readTddConfig, type TddConfig } from './tdd-gate.js';
import { readGitHead } from './validation-protocol.js';
import {
  assessQualityRuntime,
  qualityChecksMatchContract,
  readQualityContract,
  type FrozenQualityChecks,
  type QualityContractReadResult,
} from '../quality/contract.js';
import { invalidateFinalReviewState, readFinalReviewState } from '../review/state.js';
import { CODING_X_VERSION } from '../version.js';

type QualityReader = NonNullable<LoopConfig['qualityContractReader']>;
type ReadyQualityContract = Extract<QualityContractReadResult, { status: 'ready' }>;

export type LoopPreflightResult =
  | { status: 'failed'; exitCode: number }
  | {
      status: 'ready';
      statePath: string;
      guard: ReturnType<typeof createPrdGuard>;
      projectRoot: string;
      qualityReader: QualityReader;
      qualityRead: ReadyQualityContract;
      bootPrd: Prd;
      bootState: RunState;
      agentEnv: NodeJS.ProcessEnv;
      tddConfig: TddConfig | null;
      builder: string | null;
      validatorBase: string | null;
      modelPreflight: ModelPreflightResult;
      frozenQualityChecks: FrozenQualityChecks;
      runKind: AgentKind;
      bootResolved: boolean;
    };

export async function runLoopPreflight(cfg: LoopConfig): Promise<LoopPreflightResult> {
  const prdPath = join(cfg.workspace, 'prd.json');
  const statePath = join(cfg.workspace, 'state.json');
  const guard = createPrdGuard(prdPath);
  const instructionSources = readLoopInstructions(cfg.instructionsDir);
  const projectRoot = resolve(cfg.projectRoot ?? process.cwd());
  const qualityReader = cfg.qualityContractReader ?? readQualityContract;
  const qualityRead = qualityReader(projectRoot);
  if (qualityRead.status !== 'ready') {
    const detail =
      qualityRead.status === 'missing'
        ? '质量契约不存在；请先运行 coding-x init'
        : qualityRead.status === 'invalid'
          ? qualityRead.errors.join('；')
          : qualityRead.error;
    console.error(`❌ 质量契约不可用（${qualityRead.path}）：${detail}`);
    return { status: 'failed', exitCode: 2 };
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
    return { status: 'failed', exitCode: 2 };
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
  let bootState = bootPrd ? (tryReadState(statePath) ?? blankStateFor(bootPrd)) : null;
  // 最终 Review 后的任何新提交都会使旧 Review 失效。Story 与变更文件没有可靠的
  // 多对多映射，因此首版保守重验全部已通过 Story，绝不猜测“只影响哪几个”。
  // 这里同时撤销候选通过与引擎凭证，让既有 Developer → 门禁 → Validator 顺序完整重跑。
  if (bootState && bootPrd) {
    const previousReview = readFinalReviewState(cfg.workspace);
    const currentHead = readGitHead(projectRoot);
    if (
      previousReview.status === 'ready' &&
      currentHead &&
      previousReview.state.binding.headSha !== currentHead
    ) {
      // 失效必须同时落到 Story 凭证与 Review 文件。否则本轮重验 Story 后若只因
      // PR 尚未同步而退出，下一次启动仍会读到旧 head 的 Review，并重复重验同一提交。
      invalidateFinalReviewState(cfg.workspace);
      const invalidated: string[] = [];
      const next = structuredClone(bootState);
      for (const story of bootPrd.userStories) {
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
      console.warn(
        `⚠️  检测到未完成 validator 的待验收状态，已回写待复核：${recovered.storyIds.join(', ')}`,
      );
    }
  }

  const agentEnv: NodeJS.ProcessEnv = {
    CODING_X_WORKSPACE: resolve(cfg.workspace),
    CODING_X_PROJECT_ROOT: projectRoot,
  };
  const tddRead = readTddConfig(bootPrd);
  let tddConfig: TddConfig | null = null;
  if (tddRead.status === 'invalid') {
    const diagnostic = clipEvidenceDiagnostic(tddRead.error);
    try {
      appendEvidence(cfg.workspace, {
        type: 'tdd-gate',
        source: 'engine',
        at: new Date().toISOString(),
        phase: 'preflight',
        iteration: 0,
        storyId: null,
        ok: false,
        policyOk: false,
        commandRan: false,
        ms: 0,
        failureCode: 'invalid-config',
        failedCommand: '[tdd-config]',
        exitCode: null,
        timedOut: false,
        diagnosticTail: diagnostic,
      });
    } catch (err) {
      console.warn(
        `⚠️  TDD 预检 evidence 写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    console.error(`❌ TDD 配置预检失败：${tddRead.error}`);
    return { status: 'failed', exitCode: 1 };
  }
  if (tddRead.status === 'enabled') {
    tddConfig = tddRead.config;
    const policy = checkTddPolicy(tddConfig, projectRoot);
    const diagnostic = policy.failure
      ? clipEvidenceDiagnostic(policy.failure.outputTail).trim()
      : '';
    try {
      appendEvidence(cfg.workspace, {
        type: 'tdd-gate',
        source: 'engine',
        at: new Date().toISOString(),
        phase: 'preflight',
        iteration: 0,
        storyId: null,
        ok: policy.ok,
        policyOk: policy.ok,
        commandRan: false,
        ms: policy.ms,
        ...(policy.failure
          ? {
              failureCode: policy.failure.code,
              failedCommand: policy.failure.command,
              exitCode: policy.failure.exitCode,
              timedOut: policy.failure.timedOut,
              diagnosticTail: diagnostic || 'TDD 政策预检失败',
            }
          : {}),
      });
    } catch (err) {
      console.warn(
        `⚠️  TDD 预检 evidence 写入失败：${err instanceof Error ? err.message : String(err)}`,
      );
    }
    if (!policy.ok) {
      console.error(`❌ TDD 政策预检失败：${policy.failure!.outputTail}`);
      return { status: 'failed', exitCode: 1 };
    }
  }

  const instructions = renderLoopInstructions(
    instructionSources,
    cfg.workspace,
    tddConfig !== null,
  );
  let modelPreflight: ModelPreflightResult;
  try {
    modelPreflight = await preflightModelRouting({
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
      return { status: 'failed', exitCode: 2 };
    }
    throw err;
  }
  // 生产最终 Review 必须绑定一个明确模型；测试可注入不调用模型的评审器。
  // 在任何 Story agent 启动前拒绝，避免实现全部完成后才发现结果无法签发。
  if (!modelPreflight.review.model && !cfg.finalReviewRunner) {
    console.error(
      '❌ 模型路由预检失败：最终 Review 必须使用明确模型；' +
        '请在 prd.json models.validator 中固定，或传 --review-model',
    );
    return { status: 'failed', exitCode: 2 };
  }
  if (!bootPrd) {
    console.error(`❌ 无法读取 ${prdPath}；请先从源 PRD 重新派生`);
    return { status: 'failed', exitCode: 2 };
  }
  if (bootPrd.qualityContractDigest !== qualityRead.digest) {
    const received =
      typeof bootPrd.qualityContractDigest === 'string' ? bootPrd.qualityContractDigest : 'missing';
    console.error(
      `❌ PRD 的质量契约摘要无效：期望 ${qualityRead.digest}，收到 ${received}。` +
        '请停止运行并从当前质量契约重新派生 PRD。',
    );
    return { status: 'failed', exitCode: 2 };
  }
  if (
    !cfg.legacyValidatorProtocolForTests &&
    !qualityChecksMatchContract(bootPrd.qualityChecks, qualityRead.contract)
  ) {
    console.error(
      '❌ prd.json 的 qualityChecks 不是当前质量契约的完整派生快照。' +
        '请重新派生 PRD；不要手写或单独维护项目检查。',
    );
    return { status: 'failed', exitCode: 2 };
  }
  // 正式模式执行 PRD 中已经过逐字段核对的冻结快照；历史测试兼容路径没有新快照时
  // 才回退测试注入契约，生产不会走该分支。
  const frozenQualityChecks = qualityChecksMatchContract(
    bootPrd.qualityChecks,
    qualityRead.contract,
  )
    ? structuredClone(bootPrd.qualityChecks)
    : structuredClone(qualityRead.contract.checks);
  const runKind = modelPreflight.runner;
  const readyState = bootState ?? blankStateFor(bootPrd);
  const bootResolved = allStoriesResolved(bootPrd, readyState);
  for (const warning of modelPreflight.warnings) console.warn(`⚠️  ${warning}`);
  console.log(renderPreflightSummary(modelPreflight));
  if (!bootResolved) console.warn(permissionWarning(runKind));

  return {
    status: 'ready',
    statePath,
    guard,
    projectRoot,
    qualityReader,
    qualityRead,
    bootPrd,
    bootState: readyState,
    agentEnv,
    tddConfig,
    builder: instructions.builder,
    validatorBase: instructions.validator,
    modelPreflight,
    frozenQualityChecks,
    runKind,
    bootResolved,
  };
}
