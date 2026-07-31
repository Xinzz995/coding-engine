import type { AgentKind } from '../engine/agent.js';
import type { QualityRiskCategory } from '../quality/contract.js';

export const REVIEW_STATE_SCHEMA_VERSION = 1 as const;
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
  'counterevidence' | 'p1-deferred' | 'acknowledged' | 'fix-requested';

export interface ReviewDecision {
  findingId: string;
  headSha: string;
  reviewBindingDigest: string;
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
