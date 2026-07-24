export type QualityStatus = 'passed' | 'failed' | 'unverifiable';
export type ReviewAxis = 'spec' | 'standards' | 'deep';
export type FindingSeverity = 'critical' | 'high' | 'medium' | 'low';

export interface QualityCheck {
  id: string;
  command: string;
  cwd: string;
  paths: string[];
}

export interface DeepReviewPolicy {
  highRiskPaths: string[];
  changedProductionLines: number;
  largeFileLines: number;
}

export interface ReviewPolicy {
  model: string;
  specSources: string[];
  standardsSources: string[];
  deepReview: DeepReviewPolicy;
}

export interface GitHubQualityPolicy {
  repository: string;
  defaultBranch: string;
  releaseRefs: string[];
  codingXVersion: string;
  requiredChecks: string[];
}

export interface ExceptionPolicy {
  deferrableSeverities: FindingSeverity[];
}

export interface QualityContractV1 {
  version: 1;
  checks: QualityCheck[];
  review: ReviewPolicy;
  github: GitHubQualityPolicy;
  exceptionPolicy: ExceptionPolicy;
  exceptionsFile: string;
}

export interface QualityException {
  id: string;
  findingId: string;
  reason: string;
  owner: string;
  expiresAt: string;
  followUpUrl: string;
  headSha?: string;
}

export interface DeliveryException {
  id: string;
  commitSha: string;
  reason: string;
  owner: string;
  expiresAt: string;
  followUpUrl: string;
  auditUrl: string;
  resolvedAt?: string;
}

export interface QualityExceptionsV1 {
  version: 1;
  exceptions: QualityException[];
  deliveries: DeliveryException[];
}

export interface QualityFindingDraft {
  id: string;
  axis: ReviewAxis;
  severity: FindingSeverity;
  file: string;
  line: number | null;
  title: string;
  evidence: string;
  source: string;
  impact: string;
  recommendation: string;
}

export interface QualityFinding extends QualityFindingDraft {
  headSha: string;
  round: number;
}

export interface ReviewModelOutput {
  summary: string;
  findings: QualityFindingDraft[];
}

export interface QualityError {
  code: string;
  message: string;
}

export interface QualityReceipt {
  version: 1;
  kind: 'checks' | 'review' | 'doctor';
  round: number;
  status: QualityStatus;
  at: string;
  repository: string | null;
  baseSha: string | null;
  headSha: string | null;
  contractSha256: string | null;
  axis?: ReviewAxis;
  model?: string;
  deepRequired?: boolean;
  deepReasons?: string[];
  reviewSummary?: string;
  findings: QualityFinding[];
  exceptions: string[];
  errors: QualityError[];
  durationMs: number;
}

export function exitCodeForQuality(status: QualityStatus): number {
  if (status === 'passed') return 0;
  if (status === 'failed') return 1;
  return 2;
}
