import { CODING_X_VERSION } from '../version.js';
import type { AgentKind } from '../engine/agent.js';
import { digestFinalReviewMechanicalEnvironment } from '../engine/story-validation-currentness.js';
import { digest, normalizeText } from './common.js';
import type { ReviewPreflightContext } from './preflight.js';
import { applyReviewerRequestedDeepReview, assessReviewRisk } from './risk.js';
import { REVIEW_RULES_DIGEST } from './rules.js';
import type { ReviewStateRead } from './state.js';
import { REVIEW_RULES_VERSION, type ReviewBinding, type ReviewRemoteState } from './types.js';

export type RunnerVersionObservation =
  | { status: 'not-required' }
  | { status: 'ready'; runner: AgentKind; version: string }
  | { status: 'unverifiable'; runner?: AgentKind; message: string };

export function runnerVersionStaleReason(
  binding: Pick<ReviewBinding, 'runner' | 'runnerVersion'>,
  observation: RunnerVersionObservation | undefined,
): string | null {
  if (observation === undefined || observation.status === 'not-required') {
    return 'Runner 版本未经过受控只读观察';
  }
  if (observation.status === 'unverifiable') {
    return `Runner 版本无法验证：${observation.message}`;
  }
  if (observation.runner !== binding.runner) return 'Runner 类型已变化';
  return observation.version === binding.runnerVersion ? null : 'Runner 版本已变化';
}

export interface CurrentReviewStatus {
  read: ReviewStateRead;
  current: boolean;
  staleReasons: string[];
  refreshedRemote?: ReviewRemoteState;
}

/**
 * Pure currentness verdict shared by read-only status and the managed manual-report session.
 * The caller owns every observation (preflight, Runner version and optional remote refresh), so
 * this function can never launch a process or silently choose an unmanaged transport.
 */
export function evaluateCurrentReviewStatus(options: {
  read: ReviewStateRead;
  context: ReviewPreflightContext;
  runnerVersionObservation?: RunnerVersionObservation;
  codingXVersion?: string;
  refreshedRemote?: ReviewRemoteState;
  /** 当前 PRD/state/HEAD 计算出的 Story 凭证集合摘要；null 表示当前集合不可验证。 */
  storyValidationDigest: string | null;
}): CurrentReviewStatus {
  const { read, context } = options;
  if (read.status !== 'ready') return { read, current: false, staleReasons: [] };
  const saved = read.state.binding;
  const staleReasons: string[] = [];
  const compare = (name: string, actual: string, expected: string) => {
    if (actual !== expected) staleReasons.push(`${name} 已变化`);
  };
  if (saved.prNumber !== context.pullRequest.number) staleReasons.push('PR 编号已变化');
  compare('目标分支', saved.targetBranch, context.pullRequest.baseBranch);
  compare('base SHA', saved.baseSha, context.baseSha);
  compare('head SHA', saved.headSha, context.headSha);
  compare('PR 标题', saved.prTitleDigest, digest(normalizeText(context.pullRequest.title)));
  compare('PR 正文', saved.prBodyDigest, digest(normalizeText(context.pullRequest.body)));
  compare('Spec', saved.specDigest, digest(context.specs));
  compare('工程规范', saved.engineeringStandardsDigest, digest(context.engineeringStandards));
  compare('质量契约', saved.qualityContractDigest, context.baseContractDigest);
  compare('coding-x 版本', saved.codingXVersion, options.codingXVersion ?? CODING_X_VERSION);
  compare('Review 规则版本', saved.reviewRulesVersion, REVIEW_RULES_VERSION);
  compare('Review 规则', saved.reviewRulesDigest, REVIEW_RULES_DIGEST);
  if (read.state.schemaVersion === 1) {
    staleReasons.push('旧 Final Review schema 已失效');
  } else {
    const currentSaved = read.state.binding;
    compare(
      '机械验证环境',
      currentSaved.validationEnvironmentDigest,
      digestFinalReviewMechanicalEnvironment({
        contract: context.baseContract,
        headSha: context.headSha,
        defaultBranchGitHead: context.baseSha,
      }),
    );
    if (options.storyValidationDigest === undefined) {
      staleReasons.push('Story 验收凭证集合未经过当前性核对');
    } else if (options.storyValidationDigest === null) {
      staleReasons.push('当前 Story 验收凭证集合无法验证');
    } else {
      compare(
        'Story 验收凭证集合',
        currentSaved.storyValidationDigest,
        options.storyValidationDigest,
      );
    }
  }
  const currentRisk = applyReviewerRequestedDeepReview(assessReviewRisk(context), read.state.axes);
  compare('风险判断', saved.riskDigest, currentRisk.digest);
  const runnerStaleReason = runnerVersionStaleReason(saved, options.runnerVersionObservation);
  if (runnerStaleReason !== null) staleReasons.push(runnerStaleReason);
  const current = staleReasons.length === 0;
  return {
    read,
    current,
    staleReasons,
    ...(options.refreshedRemote === undefined ? {} : { refreshedRemote: options.refreshedRemote }),
  };
}
