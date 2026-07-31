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

/** Stable identity used to prevent a decision from being reused by another Review context. */
export function digestReviewBinding(binding: ReviewBinding): string {
  return digest(binding);
}
