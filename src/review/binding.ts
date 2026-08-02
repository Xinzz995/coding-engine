import { digest, normalizeText } from './common.js';
import type { ReviewPreflightContext } from './preflight.js';
import { REVIEW_RULES_DIGEST } from './rules.js';
import { REVIEW_RULES_VERSION, type ReviewBinding, type ReviewRiskAssessment } from './types.js';

/** Builds the complete machine binding shared by Final Review and user decisions. */
export function createReviewBinding(options: {
  context: ReviewPreflightContext;
  risk: ReviewRiskAssessment;
  codingXVersion: string;
  runner: ReviewBinding['runner'];
  model: string;
  runnerVersion: string;
  storyValidationDigest: string;
  validationEnvironmentDigest: string;
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
    validationEnvironmentDigest: options.validationEnvironmentDigest,
    codingXVersion: options.codingXVersion,
    runner: options.runner,
    model: options.model,
    runnerVersion: options.runnerVersion,
    reviewRulesVersion: REVIEW_RULES_VERSION,
    reviewRulesDigest: REVIEW_RULES_DIGEST,
    riskDigest: options.risk.digest,
    storyValidationDigest: options.storyValidationDigest,
  };
}

/** Stable identity used to prevent a decision from being reused by another Review context. */
export function digestReviewBinding(binding: ReviewBinding): string {
  if (
    !/^sha256:[a-f0-9]{64}$/u.test(binding.storyValidationDigest) ||
    !/^sha256:[a-f0-9]{64}$/u.test(binding.validationEnvironmentDigest)
  ) {
    throw new Error('schema v2 Review binding 缺少合法的双重验证摘要');
  }
  return digest(binding);
}
