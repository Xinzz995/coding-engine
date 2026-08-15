import { createHash } from 'node:crypto';
import type { QualityContract } from '../quality/contract.js';
import { GITHUB_ACTIONS_APP_ID } from '../quality/github.js';
import { digestReviewBinding } from '../review/binding.js';
import type { FinalReviewState } from '../review/types.js';
import type { VerifiedCandidateIdentity } from './candidate-identity.js';
import { candidateIdentityDigest } from './candidate-identity.js';

export const CANDIDATE_PROOF_FILE = 'candidate-proof.json' as const;
export const CANDIDATE_PROOF_SCHEMA_VERSION = 1 as const;
export const CANDIDATE_PROOF_DOMAIN = 'coding-x-candidate-dogfood-proof-v1' as const;

export interface CandidateDogfoodProof {
  readonly schemaVersion: typeof CANDIDATE_PROOF_SCHEMA_VERSION;
  readonly status: 'passed';
  readonly repository: {
    readonly provider: 'github';
    readonly fullName: string;
    readonly defaultBranch: string;
  };
  readonly candidate: Omit<VerifiedCandidateIdentity, 'evidencePath'>;
  readonly review: {
    readonly prNumber: number;
    readonly baseSha: string;
    readonly headSha: string;
    readonly bindingDigest: string;
    readonly storyValidationDigest: string;
    readonly storyValidationEnvironmentDigest: string;
    readonly remoteStatus: 'ready';
    readonly remoteCheckedAt: string;
    readonly checks: readonly CandidateDogfoodCheck[];
  };
  readonly completedAt: string;
  readonly proofDigest: string;
}

export interface CandidateDogfoodCheck {
  readonly name: string;
  readonly status: 'completed';
  readonly conclusion: 'success';
  readonly appId: typeof GITHUB_ACTIONS_APP_ID;
  readonly appSlug: string;
}

function digest(value: unknown): string {
  return `sha256:${createHash('sha256').update(JSON.stringify(value), 'utf8').digest('hex')}`;
}

export function candidateDogfoodProofDigest(
  proof: Omit<CandidateDogfoodProof, 'proofDigest'>,
): string {
  return digest({ domain: CANDIDATE_PROOF_DOMAIN, proof });
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new Error(`${label} 必须是对象`);
  }
  return value as Record<string, unknown>;
}

function text(value: unknown, label: string): string {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`${label} 必须是非空字符串`);
  }
  return value;
}

function sha256(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^sha256:[0-9a-f]{64}$/u.test(result)) throw new Error(`${label} 不是 SHA-256 摘要`);
  return result;
}

function gitSha(value: unknown, label: string): string {
  const result = text(value, label);
  if (!/^[0-9a-f]{40}$/u.test(result)) throw new Error(`${label} 不是完整 Git commit`);
  return result;
}

function timestamp(value: unknown, label: string): string {
  const result = text(value, label);
  if (Number.isNaN(Date.parse(result))) throw new Error(`${label} 不是合法时间`);
  return result;
}

function candidateChecks(value: unknown, label: string): CandidateDogfoodCheck[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${label} 必须是非空数组`);
  }
  const checks: CandidateDogfoodCheck[] = value.map((entry, index) => {
    const item = record(entry, `${label}[${index}]`);
    if (
      item.status !== 'completed' ||
      item.conclusion !== 'success' ||
      item.appId !== GITHUB_ACTIONS_APP_ID
    ) {
      throw new Error(`${label}[${index}] 不是 GitHub Actions 成功检查`);
    }
    return {
      name: text(item.name, `${label}[${index}].name`),
      status: 'completed' as const,
      conclusion: 'success' as const,
      appId: GITHUB_ACTIONS_APP_ID,
      appSlug: text(item.appSlug, `${label}[${index}].appSlug`),
    };
  });
  if (new Set(checks.map((check) => check.name)).size !== checks.length) {
    throw new Error(`${label} 含重复检查名`);
  }
  return checks.sort((left, right) => left.name.localeCompare(right.name));
}

export function parseCandidateDogfoodProof(value: unknown): CandidateDogfoodProof {
  const root = record(value, 'candidate-proof.json');
  if (root.schemaVersion !== CANDIDATE_PROOF_SCHEMA_VERSION || root.status !== 'passed') {
    throw new Error('candidate-proof.json schema 或状态非法');
  }
  const repositoryValue = record(root.repository, 'candidate-proof.repository');
  if (repositoryValue.provider !== 'github') throw new Error('候选证明只支持 GitHub 仓库');
  const repository = {
    provider: 'github' as const,
    fullName: text(repositoryValue.fullName, 'candidate-proof.repository.fullName'),
    defaultBranch: text(repositoryValue.defaultBranch, 'candidate-proof.repository.defaultBranch'),
  };
  const candidateValue = record(root.candidate, 'candidate-proof.candidate');
  if (candidateValue.schemaVersion !== 1 || candidateValue.packageName !== 'coding-x') {
    throw new Error('candidate-proof.candidate schema 或包名非法');
  }
  const candidate = {
    schemaVersion: 1 as const,
    packageName: 'coding-x' as const,
    version: text(candidateValue.version, 'candidate-proof.candidate.version'),
    commit: gitSha(candidateValue.commit, 'candidate-proof.candidate.commit'),
    candidateWorkflowRunId: text(
      candidateValue.candidateWorkflowRunId,
      'candidate-proof.candidate.candidateWorkflowRunId',
    ),
    tarballSha256: sha256(candidateValue.tarballSha256, 'candidate-proof.candidate.tarballSha256'),
    runtimeTreeDigest: sha256(
      candidateValue.runtimeTreeDigest,
      'candidate-proof.candidate.runtimeTreeDigest',
    ),
    digest: sha256(candidateValue.digest, 'candidate-proof.candidate.digest'),
  };
  if (!/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/u.test(candidate.version)) {
    throw new Error('candidate-proof.candidate.version 非法');
  }
  if (!/^[1-9]\d*$/u.test(candidate.candidateWorkflowRunId)) {
    throw new Error('candidate-proof.candidate.candidateWorkflowRunId 非法');
  }
  if (candidate.digest !== candidateIdentityDigest(candidate)) {
    throw new Error('candidate-proof.candidate.digest 与候选身份不一致');
  }
  const reviewValue = record(root.review, 'candidate-proof.review');
  if (!Number.isSafeInteger(reviewValue.prNumber) || (reviewValue.prNumber as number) < 1) {
    throw new Error('candidate-proof.review.prNumber 非法');
  }
  if (reviewValue.remoteStatus !== 'ready') {
    throw new Error('candidate-proof.review.remoteStatus 不是 ready');
  }
  const review = {
    prNumber: reviewValue.prNumber as number,
    baseSha: gitSha(reviewValue.baseSha, 'candidate-proof.review.baseSha'),
    headSha: gitSha(reviewValue.headSha, 'candidate-proof.review.headSha'),
    bindingDigest: sha256(reviewValue.bindingDigest, 'candidate-proof.review.bindingDigest'),
    storyValidationDigest: sha256(
      reviewValue.storyValidationDigest,
      'candidate-proof.review.storyValidationDigest',
    ),
    storyValidationEnvironmentDigest: sha256(
      reviewValue.storyValidationEnvironmentDigest,
      'candidate-proof.review.storyValidationEnvironmentDigest',
    ),
    remoteStatus: 'ready' as const,
    remoteCheckedAt: timestamp(
      reviewValue.remoteCheckedAt,
      'candidate-proof.review.remoteCheckedAt',
    ),
    checks: candidateChecks(reviewValue.checks, 'candidate-proof.review.checks'),
  };
  const completedAt = timestamp(root.completedAt, 'candidate-proof.completedAt');
  const normalized = {
    schemaVersion: CANDIDATE_PROOF_SCHEMA_VERSION,
    status: 'passed' as const,
    repository,
    candidate,
    review,
    completedAt,
  };
  const proofDigest = sha256(root.proofDigest, 'candidate-proof.proofDigest');
  if (proofDigest !== candidateDogfoodProofDigest(normalized)) {
    throw new Error('candidate-proof.proofDigest 与证明内容不一致');
  }
  return { ...normalized, proofDigest };
}

export function createCandidateDogfoodProof(options: {
  readonly identity: VerifiedCandidateIdentity;
  readonly contract: Pick<QualityContract, 'repository'>;
  readonly review: FinalReviewState;
  readonly storyValidationEnvironmentDigest: string;
  readonly completedAt?: string;
}): CandidateDogfoodProof {
  const { identity, review } = options;
  if (
    identity.schemaVersion !== 1 ||
    identity.packageName !== 'coding-x' ||
    identity.digest !== candidateIdentityDigest(identity)
  ) {
    throw new Error('候选 Dogfood 身份本身未通过摘要闭环');
  }
  if (!review.shadow || review.status !== 'passed' || review.deliveryStatus !== 'shadow') {
    throw new Error('候选 Dogfood 证明只接受已通过的 Shadow Final Review');
  }
  if (review.remote.status !== 'ready') {
    throw new Error('候选 Dogfood 证明要求当前 PR 的远端总闸已经 ready');
  }
  const checks = candidateChecks(review.remote.checks, '候选 Dogfood 远端检查');
  if (review.binding.codingXVersion !== identity.version) {
    throw new Error('候选 Dogfood Review 使用的 coding-x 版本与候选身份不一致');
  }
  if (!/^sha256:[0-9a-f]{64}$/u.test(options.storyValidationEnvironmentDigest)) {
    throw new Error('候选 Dogfood Story 验收环境摘要非法');
  }
  const { evidencePath: _evidencePath, ...portableIdentity } = identity;
  const proof = {
    schemaVersion: CANDIDATE_PROOF_SCHEMA_VERSION,
    status: 'passed' as const,
    repository: {
      provider: options.contract.repository.provider,
      fullName: options.contract.repository.fullName,
      defaultBranch: options.contract.repository.defaultBranch,
    },
    candidate: portableIdentity,
    review: {
      prNumber: review.binding.prNumber,
      baseSha: review.binding.baseSha,
      headSha: review.binding.headSha,
      bindingDigest: digestReviewBinding(review.binding),
      storyValidationDigest: review.binding.storyValidationDigest,
      storyValidationEnvironmentDigest: options.storyValidationEnvironmentDigest,
      remoteStatus: 'ready' as const,
      remoteCheckedAt: review.remote.checkedAt,
      checks,
    },
    completedAt: options.completedAt ?? new Date().toISOString(),
  };
  return { ...proof, proofDigest: candidateDogfoodProofDigest(proof) };
}
