import type { RunState, StoryState } from '../contracts/run-state-contract.js';
import { isGitHead, isSha256Digest } from '../contracts/validation-contract.js';
import {
  qualityChecksMatchContract,
  type QualityContract,
  type QualityContractReadResult,
  type QualityPlatform,
} from '../quality/contract.js';
import { validationEnvironmentDigest } from '../quality/validation-environment.js';
import type { Prd, TddConfig } from './prd.js';
import { validatePrdStorySet } from './prd.js';
import {
  evaluateStoryValidationDisplay,
  evaluateStoryValidationReceiptSet,
  type StoryValidationDisplayEvaluation,
  type StoryValidationReceiptSetEvaluation,
} from './state.js';
import { readTddConfig, type TddConfigReadResult } from './tdd-gate.js';

export const STORY_VALIDATION_ENVIRONMENT_DOMAIN = 'story-validation-v1' as const;
export const FINAL_REVIEW_MECHANICAL_ENVIRONMENT_DOMAIN = 'final-review-mechanical-v1' as const;

export function candidateStoryValidationEnvironmentPolicy(tddConfig: TddConfig | null): {
  additionalRefs: string[];
  additionalPolicy: {
    domain: typeof STORY_VALIDATION_ENVIRONMENT_DOMAIN;
    tdd: TddConfig | null;
  };
} {
  return {
    additionalRefs: tddConfig ? [tddConfig.baselineRef] : [],
    additionalPolicy: {
      domain: STORY_VALIDATION_ENVIRONMENT_DOMAIN,
      tdd: tddConfig,
    },
  };
}

export function finalReviewMechanicalEnvironmentPolicy(): {
  additionalPolicy: { domain: typeof FINAL_REVIEW_MECHANICAL_ENVIRONMENT_DOMAIN };
} {
  return {
    additionalPolicy: { domain: FINAL_REVIEW_MECHANICAL_ENVIRONMENT_DOMAIN },
  };
}

export type StoryValidationStateStatus = 'ready' | 'missing' | 'invalid';

export interface StoryValidationCurrentnessInput {
  prd: Prd | null;
  state: RunState;
  stateStatus: StoryValidationStateStatus;
  headSha: string | null;
  workingContract: QualityContractReadResult;
  trackedContract: QualityContractReadResult;
  platform: QualityPlatform;
  /** 受管观察会把本次严格解析结果传入，避免纯裁决与撕裂核验使用两种 TDD 解释。 */
  tddRead?: TddConfigReadResult;
  /** @internal 只兼容 Loop 的固定摘要测试夹具；正式调用必须省略。 */
  storyValidationEnvironmentDigestForTests?: string;
}

interface StoryValidationCurrentnessBase {
  headSha: string | null;
  prd: Prd | null;
  /** 仅内存视图；配置问题会撤销全部验收绿灯，调用方不得回写。 */
  state: RunState;
  display: StoryValidationDisplayEvaluation | null;
  /** 候选 Story 验收环境；不是默认分支机械 Final Review 环境。 */
  storyValidationEnvironmentDigest: string | null;
  /** 全部非 blocked Story 的有序验收凭证集合摘要。 */
  storyValidationDigest: string | null;
  workingContract: QualityContract | null;
  trackedContract: QualityContract | null;
  workingContractDigest: string | null;
  trackedContractDigest: string | null;
}

export interface ReadyStoryValidationCurrentness extends StoryValidationCurrentnessBase {
  status: 'ready';
  prd: Prd;
  display: StoryValidationDisplayEvaluation;
  storyValidationEnvironmentDigest: string;
  workingContract: QualityContract;
  trackedContract: QualityContract;
  tddConfig: TddConfig | null;
  receiptSet: StoryValidationReceiptSetEvaluation;
}

export type StoryValidationUnverifiableReason =
  | 'prd-unreadable'
  | 'state-missing'
  | 'state-invalid'
  | 'story-set-invalid'
  | 'head-unreadable'
  | 'working-contract-unavailable'
  | 'tracked-contract-unavailable'
  | 'contract-mismatch'
  | 'prd-contract-digest-mismatch'
  | 'prd-quality-checks-mismatch'
  | 'tdd-invalid'
  | 'observation-drift'
  | 'evaluation-error';

export interface UnverifiableStoryValidationCurrentness extends StoryValidationCurrentnessBase {
  status: 'unverifiable';
  reason: StoryValidationUnverifiableReason;
  message: string;
  storyValidationEnvironmentDigest: null;
  storyValidationDigest: null;
  workingContract: QualityContract | null;
  trackedContract: QualityContract | null;
}

export type StoryValidationCurrentness =
  ReadyStoryValidationCurrentness | UnverifiableStoryValidationCurrentness;

function clearValidationGreens(state: RunState): {
  state: RunState;
  invalidatedStoryIds: string[];
} {
  let next = state;
  const invalidatedStoryIds: string[] = [];
  for (const [storyId, current] of Object.entries(state)) {
    if (!current.validated && (current.validationReceipt ?? null) === null) continue;
    next = {
      ...next,
      [storyId]: {
        ...current,
        validated: false,
        validationReceipt: null,
      } satisfies StoryState,
    };
    invalidatedStoryIds.push(storyId);
  }
  return { state: next, invalidatedStoryIds };
}

function readyContract(
  result: QualityContractReadResult,
): Extract<QualityContractReadResult, { status: 'ready' }> | null {
  return result.status === 'ready' ? result : null;
}

function contractDiagnostic(result: QualityContractReadResult): string {
  switch (result.status) {
    case 'ready':
      return result.digest;
    case 'missing':
      return 'missing';
    case 'invalid':
      return result.errors.join('；');
    case 'invalid-json':
    case 'io-error':
      return result.error;
  }
}

/** 候选 Story Validator 使用的环境域：绑定候选 HEAD 契约与完整 TDD 政策。 */
export function digestCandidateStoryValidationEnvironment(options: {
  contract: Pick<QualityContract, 'checks' | 'generatedPaths' | 'localValidation'>;
  headSha: string;
  tddConfig: TddConfig | null;
  platform?: QualityPlatform;
}): string {
  const policy = candidateStoryValidationEnvironmentPolicy(options.tddConfig);
  return validationEnvironmentDigest({
    contract: options.contract,
    head: options.headSha,
    ...(options.platform ? { platform: options.platform } : {}),
    ...policy,
  });
}

/** 默认分支旧契约裁决的机械 Final Review 环境；禁止拿它核对 Story 凭证。 */
export function digestFinalReviewMechanicalEnvironment(options: {
  contract: Pick<QualityContract, 'checks' | 'generatedPaths' | 'localValidation'>;
  headSha: string;
  platform?: QualityPlatform;
}): string {
  return validationEnvironmentDigest({
    contract: options.contract,
    head: options.headSha,
    ...(options.platform ? { platform: options.platform } : {}),
    ...finalReviewMechanicalEnvironmentPolicy(),
  });
}

/**
 * 对任何配置或观察异常统一失败关闭。两个可绑定摘要必须同时为空，所有持久绿灯只在
 * 返回的内存视图中撤销，绝不据此改写 state.json。
 */
export function unverifiableStoryValidationCurrentness(
  input: StoryValidationCurrentnessInput,
  reason: StoryValidationUnverifiableReason,
  message: string,
): UnverifiableStoryValidationCurrentness {
  const cleared = clearValidationGreens(input.state);
  const display: StoryValidationDisplayEvaluation | null = input.prd
    ? {
        state: cleared.state,
        digest: null,
        currentness: {
          gitHead: input.headSha,
          current: false,
          invalidStoryIds: cleared.invalidatedStoryIds,
          configurationError: message,
        },
      }
    : null;
  return {
    status: 'unverifiable',
    reason,
    message,
    headSha: input.headSha,
    prd: input.prd,
    state: cleared.state,
    display,
    storyValidationEnvironmentDigest: null,
    storyValidationDigest: null,
    workingContract: readyContract(input.workingContract)?.contract ?? null,
    trackedContract: readyContract(input.trackedContract)?.contract ?? null,
    workingContractDigest: readyContract(input.workingContract)?.digest ?? null,
    trackedContractDigest: readyContract(input.trackedContract)?.digest ?? null,
  };
}

/**
 * Story 验收当前性的纯裁决核心。读取层只负责提供同一稳定观察窗口内的值；所有规则
 * （Story 集合、PRD 快照、契约、TDD、环境与凭证）都在这里按同一顺序失败关闭。
 */
export function evaluateStoryValidationCurrentness(
  input: StoryValidationCurrentnessInput,
): StoryValidationCurrentness {
  try {
    if (!input.prd) {
      return unverifiableStoryValidationCurrentness(
        input,
        'prd-unreadable',
        'workspace prd.json 不存在、不可读或不是合法 JSON',
      );
    }
    if (input.stateStatus !== 'ready') {
      return unverifiableStoryValidationCurrentness(
        input,
        input.stateStatus === 'missing' ? 'state-missing' : 'state-invalid',
        input.stateStatus === 'missing'
          ? 'workspace state.json 不存在'
          : 'workspace state.json 不可读或结构无效',
      );
    }
    const storySet = validatePrdStorySet(input.prd);
    if (!storySet.valid) {
      return unverifiableStoryValidationCurrentness(input, 'story-set-invalid', storySet.message);
    }
    if (!input.headSha || !isGitHead(input.headSha)) {
      return unverifiableStoryValidationCurrentness(
        input,
        'head-unreadable',
        '当前 Git HEAD 不可读取或不是完整提交 ID',
      );
    }
    const working = readyContract(input.workingContract);
    if (!working) {
      return unverifiableStoryValidationCurrentness(
        input,
        'working-contract-unavailable',
        `工作树质量契约不可用：${contractDiagnostic(input.workingContract)}`,
      );
    }
    const tracked = readyContract(input.trackedContract);
    if (!tracked) {
      return unverifiableStoryValidationCurrentness(
        input,
        'tracked-contract-unavailable',
        `当前 HEAD 质量契约不可用：${contractDiagnostic(input.trackedContract)}`,
      );
    }
    if (working.digest !== tracked.digest) {
      return unverifiableStoryValidationCurrentness(
        input,
        'contract-mismatch',
        `工作树质量契约未绑定当前 HEAD（工作树 ${working.digest}，HEAD ${tracked.digest}）`,
      );
    }
    if (input.prd.qualityContractDigest !== tracked.digest) {
      return unverifiableStoryValidationCurrentness(
        input,
        'prd-contract-digest-mismatch',
        `PRD 质量契约摘要不匹配（期望 ${tracked.digest}，收到 ${input.prd.qualityContractDigest ?? 'missing'}）`,
      );
    }
    if (!qualityChecksMatchContract(input.prd.qualityChecks, tracked.contract)) {
      return unverifiableStoryValidationCurrentness(
        input,
        'prd-quality-checks-mismatch',
        'PRD 项目检查快照与当前 HEAD 质量契约不一致',
      );
    }
    const strictTddRead = readTddConfig(input.prd);
    if (
      input.tddRead !== undefined &&
      JSON.stringify(input.tddRead) !== JSON.stringify(strictTddRead)
    ) {
      return unverifiableStoryValidationCurrentness(
        input,
        'tdd-invalid',
        'PRD TDD 政策的观察结果与严格解析结果不一致',
      );
    }
    const tddRead = strictTddRead;
    if (tddRead.status === 'invalid') {
      return unverifiableStoryValidationCurrentness(
        input,
        'tdd-invalid',
        `PRD TDD 政策无效：${tddRead.error}`,
      );
    }
    const tddConfig = tddRead.status === 'enabled' ? tddRead.config : null;
    if (
      input.storyValidationEnvironmentDigestForTests !== undefined &&
      !isSha256Digest(input.storyValidationEnvironmentDigestForTests)
    ) {
      return unverifiableStoryValidationCurrentness(
        input,
        'evaluation-error',
        '测试注入的 Story 验收环境摘要非法',
      );
    }
    const storyValidationEnvironmentDigest =
      input.storyValidationEnvironmentDigestForTests ??
      digestCandidateStoryValidationEnvironment({
        contract: tracked.contract,
        headSha: input.headSha,
        tddConfig,
        platform: input.platform,
      });
    const receiptSet = evaluateStoryValidationReceiptSet(
      input.prd,
      input.state,
      input.headSha,
      storyValidationEnvironmentDigest,
    );
    const display = evaluateStoryValidationDisplay(
      input.prd,
      input.state,
      input.headSha,
      storyValidationEnvironmentDigest,
    );
    return {
      status: 'ready',
      headSha: input.headSha,
      prd: input.prd,
      state: display.state,
      display,
      storyValidationEnvironmentDigest,
      storyValidationDigest: receiptSet.digest,
      workingContract: working.contract,
      trackedContract: tracked.contract,
      workingContractDigest: working.digest,
      trackedContractDigest: tracked.digest,
      tddConfig,
      receiptSet,
    };
  } catch (error) {
    return unverifiableStoryValidationCurrentness(
      input,
      'evaluation-error',
      `Story 验收当前性裁决失败：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
