import type { AgentKind } from '../engine/agent.js';
import type { QualityRiskCategory } from '../quality/contract.js';

export const REVIEW_STATE_SCHEMA_VERSION = 2 as const;
export const REVIEW_DECISIONS_SCHEMA_VERSION = 1 as const;
export const REVIEW_RULES_VERSION = '1.1.0';
export const REVIEW_STATE_FILE = 'final-review.json';
export const REVIEW_DECISIONS_FILE = 'review-decisions.json';
export const REVIEW_MARKDOWN_FILE = 'final-review.md';

export type ReviewAxis = 'spec' | 'engineering' | 'deep';
export type ReviewStatus = 'passed' | 'failed' | 'unverifiable';
export type ReviewSeverity = 'P0' | 'P1' | 'P2' | 'Info';

export interface ReviewLocation {
  path: string;
  line?: number;
  symbol?: string;
}

export interface ReviewFinding {
  id: string;
  axis: ReviewAxis;
  severity: ReviewSeverity;
  title: string;
  location: ReviewLocation;
  ruleSource: string;
  impact: string;
  recommendation: string;
  requiresHumanDecision: boolean;
  prNumber: number;
  baseSha: string;
  headSha: string;
  round: number;
}

export interface ReviewRiskAssessment {
  triggered: boolean;
  categories: QualityRiskCategory[];
  reasons: string[];
  changedFiles: string[];
  changedModules: string[];
  digest: string;
}

export interface ReviewBinding {
  prNumber: number;
  targetBranch: string;
  baseSha: string;
  headSha: string;
  prTitleDigest: string;
  prBodyDigest: string;
  specDigest: string;
  engineeringStandardsDigest: string;
  qualityContractDigest: string;
  /** 全部非 blocked Story 针对当前 HEAD/AC 的持久 Validator 凭证摘要。 */
  storyValidationDigest: string;
  /** 本轮启动前冻结的人工 Review 裁决文件原始身份。 */
  reviewDecisionsDigest: string;
  /** 本轮冻结 PRD models 路由政策的规范化摘要。 */
  reviewRoutingDigest: string;
  codingXVersion: string;
  runner: AgentKind;
  model: string;
  runnerVersion: string;
  reviewRulesVersion: string;
  reviewRulesDigest: string;
  riskDigest: string;
}

export interface ReviewAxisResult {
  axis: ReviewAxis;
  status: ReviewStatus;
  summary: string;
  findings: ReviewFinding[];
  requestDeepReview: boolean;
  durationMs: number;
  attempts: number;
}

export interface ReviewRemoteState {
  status: 'ready' | 'pending' | 'failed' | 'invalid';
  checks: Array<{
    name: string;
    status: string;
    conclusion: string | null;
    appId: number;
    appSlug: string;
  }>;
  rulesetErrors: string[];
  detail?: string;
  checkedAt: string;
}

export interface FinalReviewState {
  schemaVersion: typeof REVIEW_STATE_SCHEMA_VERSION;
  status: ReviewStatus;
  deliveryStatus: 'ready' | 'findings' | 'unverifiable' | 'remote-pending' | 'shadow';
  binding: ReviewBinding;
  risk: ReviewRiskAssessment;
  axes: ReviewAxisResult[];
  remote: ReviewRemoteState;
  round: number;
  shadow: boolean;
  startedAt: string;
  completedAt: string;
}

export type ReviewDecisionAction =
  | 'counterevidence'
  | 'p1-deferred'
  | 'acknowledged'
  | 'fix-requested';

export interface ReviewDecision {
  findingId: string;
  headSha: string;
  action: ReviewDecisionAction;
  operator: string;
  at: string;
  evidence?: string;
  issue?: number;
}

export interface ReviewDecisionsFile {
  schemaVersion: typeof REVIEW_DECISIONS_SCHEMA_VERSION;
  decisions: ReviewDecision[];
}

/** 一次 coding-x 运行开始前冻结的裁决输入；raw=null 明确表示文件当时不存在。 */
export interface ReviewDecisionsSnapshot {
  raw: string | null;
  value: ReviewDecisionsFile;
  digest: string;
}

/** Model-facing shape. Binding and stable IDs are always issued by the engine. */
export interface ModelReviewOutput {
  status: ReviewStatus;
  summary: string;
  requestDeepReview: boolean;
  unverifiableReason?: string;
  findings: Array<{
    severity: ReviewSeverity;
    title: string;
    location: ReviewLocation;
    ruleSource: string;
    impact: string;
    recommendation: string;
    requiresHumanDecision: boolean;
  }>;
}

export interface FinalReviewOutcome {
  exitCode: 0 | 1 | 2 | 4 | 5 | 6 | 7;
  state?: FinalReviewState;
  message: string;
}

export type StoryValidationCheck =
  | { ok: true; digest: string }
  | { ok: false; message: string };
