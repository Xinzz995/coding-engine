import { join, resolve } from 'node:path';
import { existsSync } from 'node:fs';
import { permissionWarning, type AgentKind } from './agent.js';
import { appendEvidenceWithWriter, clipEvidenceDiagnostic } from './evidence.js';
import type { ManagedGateContext } from './gate.js';
import { readLoopInstructions, renderLoopInstructions } from './loop-instructions.js';
import type { LoopConfig } from './loop.js';
import {
  ModelPreflightError,
  preflightModelRouting,
  renderPreflightSummary,
  type ModelPreflightResult,
} from './model-preflight.js';
import { createManagedPrdGuard } from './prd-guard.js';
import { validatePrdStorySet, type Prd } from './prd.js';
import {
  allStoriesResolvedAt,
  blankStateFor,
  initialStateFor,
  reconcileValidationReceipts,
  tryReadState,
  type RunState,
} from './state.js';
import { checkTddPolicyManaged, readTddConfig, type TddConfig } from './tdd-gate.js';
import { readGitHead } from './validation-protocol.js';
import {
  bindStoryValidationRuntimeIdentity,
  candidateStoryValidationEnvironmentPolicy,
  digestCandidateStoryValidationEnvironment,
  type StoryValidationRuntimeIdentity,
} from './story-validation-currentness.js';
import {
  assessQualityRuntime,
  qualityChecksMatchContract,
  readQualityContract,
  type FrozenQualityChecks,
  type QualityContractReadResult,
} from '../quality/contract.js';
import {
  readDefaultBranchGitHead,
  readTrackedQualityContractAtHead,
} from '../quality/tracked-contract.js';
import { invalidateFinalReviewState, readFinalReviewState } from '../review/state.js';
import { CODING_X_VERSION } from '../version.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';

type QualityReader = NonNullable<LoopConfig['qualityContractReader']>;
type ReadyQualityContract = Extract<QualityContractReadResult, { status: 'ready' }>;
export { readTrackedQualityContractAtHead } from '../quality/tracked-contract.js';

export type LoopPreflightResult =
  | { status: 'failed'; exitCode: number }
  | {
      status: 'ready';
      statePath: string;
      guard: ReturnType<typeof createManagedPrdGuard>;
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
      gitHead: string;
      validationEnvironmentDigest: string;
      validationRuntimeIdentity: StoryValidationRuntimeIdentity;
      validationAdditionalRefs: string[];
      validationReferenceAliases: Array<{ ref: string; target: string }>;
      defaultBranchGitHead: string;
      bootResolved: boolean;
    };

export async function runLoopPreflight(
  cfg: LoopConfig,
  session: WorkspaceSession,
  termination?: ManagedGateContext['termination'],
): Promise<LoopPreflightResult> {
  // The lease has already resolved and authenticated the workspace directory. From this point on,
  // every read, rendered instruction and result path must use that same canonical authority. A
  // relative CLI value would otherwise be reinterpreted after Validator moves into its checkout.
  const workspace = session.writer.workspacePath;
  const prdPath = join(workspace, 'prd.json');
  const statePath = join(workspace, 'state.json');
  const guard = createManagedPrdGuard(prdPath, session.writer);
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
  const actualCodingXVersion = cfg.actualVersion ?? CODING_X_VERSION;
  const runtime = assessQualityRuntime(
    qualityRead.contract,
    actualCodingXVersion,
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

  const bootPrd = (await guard.read()).prd;
  if (bootPrd) {
    const storySet = validatePrdStorySet(bootPrd);
    if (!storySet.valid) {
      console.error(`❌ PRD Story 集合无效：${storySet.message}`);
      return { status: 'failed', exitCode: 2 };
    }
  }
  // 正式运行必须先绑定一个非空提交身份。这个检查发生在 state 创建/迁移、模型目录读取
  // 和任何 Agent 启动之前；失败时不得改变既有 Story 状态。
  const bootGitHead = readGitHead(projectRoot);
  if (!bootGitHead) {
    console.error('❌ 无法读取当前 Git HEAD；正式运行必须在至少有一个提交的 Git 仓库中执行');
    return { status: 'failed', exitCode: 2 };
  }
  if (!cfg.qualityContractReader) {
    const trackedQuality = await readTrackedQualityContractAtHead({
      projectRoot,
      head: bootGitHead,
      session,
      ...(termination ? { termination } : {}),
    });
    if (trackedQuality.status !== 'ready' || trackedQuality.digest !== qualityRead.digest) {
      const observed =
        trackedQuality.status === 'ready'
          ? trackedQuality.digest
          : trackedQuality.status === 'invalid'
            ? trackedQuality.errors.join('；')
            : trackedQuality.status === 'missing'
              ? 'missing'
              : trackedQuality.error;
      console.error(
        `❌ 工作树质量契约未绑定当前 HEAD（工作树 ${qualityRead.digest}，HEAD ${observed}）；` +
          '请先提交质量契约并重新运行',
      );
      return { status: 'failed', exitCode: 2 };
    }
  }

  const defaultBranchRead = cfg.qualityContractReader
    ? {
        status: 'ready' as const,
        gitHead: cfg.defaultBranchGitHeadForTests ?? bootGitHead,
      }
    : await readDefaultBranchGitHead({
        projectRoot,
        defaultBranch: qualityRead.contract.repository.defaultBranch,
        session,
        ...(termination ? { termination } : {}),
      });
  if (defaultBranchRead.status !== 'ready') {
    console.error(
      `❌ 无法固定 origin/${qualityRead.contract.repository.defaultBranch} 验证基线：` +
        `${defaultBranchRead.message}。请先执行 git fetch origin ${qualityRead.contract.repository.defaultBranch} 后重试。`,
    );
    return { status: 'failed', exitCode: 2 };
  }
  const defaultBranchGitHead = defaultBranchRead.gitHead;
  const tddRead = readTddConfig(bootPrd);
  const validationPolicy = candidateStoryValidationEnvironmentPolicy(
    tddRead.status === 'enabled' ? tddRead.config : null,
    qualityRead.contract,
    defaultBranchGitHead,
  );
  const validationAdditionalRefs = validationPolicy.additionalRefs;
  const validationReferenceAliases = validationPolicy.referenceAliases;
  const validationRuntimeIdentity: StoryValidationRuntimeIdentity = {
    mode: runtime.mode,
    actualCodingXVersion,
  };
  const currentValidationEnvironmentDigest =
    cfg.validationEnvironmentDigestForTests !== undefined
      ? bindStoryValidationRuntimeIdentity(
          cfg.validationEnvironmentDigestForTests,
          validationRuntimeIdentity,
        )
      : digestCandidateStoryValidationEnvironment({
          contract: qualityRead.contract,
          headSha: bootGitHead,
          defaultBranchGitHead,
          tddConfig: tddRead.status === 'enabled' ? tddRead.config : null,
          runtimeIdentity: validationRuntimeIdentity,
        });

  // 先只在内存准备状态。文件缺失时从 legacy PRD 抽取候选；文件存在但损坏时按
  // 全未开始失败关闭。只有全部启动预检通过后才创建或迁移 state.json。
  const stateExisted = existsSync(statePath);
  const parsedBootState = bootPrd && stateExisted ? tryReadState(statePath) : null;
  let bootState = bootPrd
    ? (parsedBootState ?? (stateExisted ? blankStateFor(bootPrd) : initialStateFor(bootPrd)))
    : null;
  let bootInvalidatedStoryIds: string[] = [];
  let bootFinalReviewNeedsInvalidation = false;
  // 旧 Final Review 自身仍按提交失效，但它不再决定 Story 是否过期；Story 当前性只由
  // 自己的结构化凭证、当前 PRD 与当前 HEAD 裁决。
  if (bootState && bootPrd) {
    const previousReview = readFinalReviewState(workspace);
    if (previousReview.status === 'ready' && previousReview.state.binding.headSha !== bootGitHead) {
      bootFinalReviewNeedsInvalidation = true;
    }
    const reconciled = reconcileValidationReceipts(
      bootPrd,
      bootState,
      bootGitHead,
      currentValidationEnvironmentDigest,
    );
    bootState = reconciled.state;
    bootInvalidatedStoryIds = reconciled.invalidatedStoryIds;
  }

  const agentEnv: NodeJS.ProcessEnv = {
    CODING_X_WORKSPACE: workspace,
    CODING_X_PROJECT_ROOT: projectRoot,
  };
  let tddConfig: TddConfig | null = null;
  if (tddRead.status === 'invalid') {
    const diagnostic = clipEvidenceDiagnostic(tddRead.error);
    try {
      await appendEvidenceWithWriter(session.writer, {
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
    const policy = await checkTddPolicyManaged(tddConfig, projectRoot, {
      session,
      kind: 'tdd-check',
      ...(termination ? { termination } : {}),
    });
    const diagnostic = policy.failure
      ? clipEvidenceDiagnostic(policy.failure.outputTail).trim()
      : '';
    try {
      await appendEvidenceWithWriter(session.writer, {
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

  const instructions = renderLoopInstructions(instructionSources, workspace, tddConfig !== null);
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
  // 所有启动预检均成功后才落盘对账结果。预检失败时 Story 候选、凭证与 retry
  // 必须保持原样；parsedBootState=null 代表既有文件损坏，也不覆盖诊断现场。
  // Agent 的 add-only 截图权限必须锚定到引擎先建立的普通目录，不能让 Agent 自己
  // 创建目录或靠人工准备。全新 workspace apply-prd 后尚无该目录，因此在首轮
  // operation 基线扫描前由当前受认证 session 幂等建立。
  await session.writer.ensureDirectory('screenshots');
  if (bootState && (!stateExisted || parsedBootState)) {
    await session.writer.writeFile('state.json', JSON.stringify(bootState, null, 2));
  }
  if (bootFinalReviewNeedsInvalidation) {
    await invalidateFinalReviewState(session.writer);
  }
  if (bootInvalidatedStoryIds.length > 0) {
    console.warn(
      `⚠️  旧 Validator 凭证不再对应当前提交或验收目标，已保留实现候选并等待重验：` +
        bootInvalidatedStoryIds.join(', '),
    );
  }
  const runKind = modelPreflight.runner;
  const readyState = bootState ?? blankStateFor(bootPrd);
  const bootResolved = allStoriesResolvedAt(
    bootPrd,
    readyState,
    bootGitHead,
    currentValidationEnvironmentDigest,
  );
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
    gitHead: bootGitHead,
    validationEnvironmentDigest: currentValidationEnvironmentDigest,
    validationRuntimeIdentity,
    validationAdditionalRefs,
    validationReferenceAliases,
    defaultBranchGitHead,
    bootResolved,
  };
}
