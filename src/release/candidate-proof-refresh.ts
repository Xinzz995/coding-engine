import { performance } from 'node:perf_hooks';
import {
  collectManagedStatusQuality,
  type ManagedStatusQualityResult,
} from '../review/managed-status.js';
import type { ManagedReviewTermination } from '../review/managed-observation.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import type { VerifiedCandidateIdentity } from './candidate-identity.js';
import {
  CANDIDATE_PROOF_FILE,
  createCandidateDogfoodProof,
  type CandidateDogfoodProof,
} from './candidate-proof.js';

export interface CandidateProofRefreshResult {
  readonly proof: CandidateDogfoodProof;
  readonly durationMs: number;
}

interface CandidateProofRefreshAdapters {
  readonly collect: typeof collectManagedStatusQuality;
  readonly now: () => Date;
  readonly monotonicNow: () => number;
}

const DEFAULT_ADAPTERS: CandidateProofRefreshAdapters = {
  collect: collectManagedStatusQuality,
  now: () => new Date(),
  monotonicNow: () => performance.now(),
};

function reviewProblem(quality: ManagedStatusQualityResult): string {
  const review = quality.finalReview;
  if (review.read.status === 'missing') return '缺少已完成的 Shadow Final Review';
  if (review.read.status === 'invalid') return `Final Review 状态损坏：${review.read.error}`;
  if (!review.current) {
    return review.staleReasons.length > 0
      ? `Final Review 已失效：${review.staleReasons.join('；')}`
      : 'Final Review 已失效';
  }
  return 'Final Review 无法用于候选凭证补签';
}

/**
 * 把一次已经完成并仍然当前的 Shadow Review 与本次受管远端快照组合成候选证明。
 * 这里不运行质量检查或 Review；生产调用方只能传入 collectManagedStatusQuality 的结果。
 */
export function createRefreshedCandidateDogfoodProof(options: {
  readonly identity: VerifiedCandidateIdentity;
  readonly quality: ManagedStatusQualityResult;
  readonly completedAt: string;
}): CandidateDogfoodProof {
  const { finalReview, storyValidation } = options.quality;
  if (finalReview.read.status !== 'ready' || !finalReview.current) {
    throw new Error(reviewProblem(options.quality));
  }
  const review = finalReview.read.state;
  if (review.schemaVersion !== 2) throw new Error('旧版 Final Review 不能补签候选证明');
  if (!review.shadow || review.status !== 'passed' || review.deliveryStatus !== 'shadow') {
    throw new Error('只有已通过且仍为 Shadow 的 Final Review 可以补签候选证明');
  }
  const remote = finalReview.refreshedRemote;
  if (remote === undefined) throw new Error('候选凭证补签没有取得新的远端状态');
  if (remote.status !== 'ready') {
    throw new Error(`远端总闸仍为 ${remote.status}，不能补签候选证明`);
  }
  if (storyValidation.status !== 'ready') {
    throw new Error(`Story 验收当前性无法验证：${storyValidation.message}`);
  }
  if (
    storyValidation.headSha !== review.binding.headSha ||
    storyValidation.storyValidationDigest !== review.binding.storyValidationDigest
  ) {
    throw new Error('Story 验收结果与 Final Review 绑定不一致，不能补签候选证明');
  }

  return createCandidateDogfoodProof({
    identity: options.identity,
    contract: storyValidation.workingContract,
    review: { ...review, remote },
    storyValidationEnvironmentDigest: storyValidation.storyValidationEnvironmentDigest,
    completedAt: options.completedAt,
  });
}

export async function refreshCandidateDogfoodProof(options: {
  readonly session: WorkspaceSession;
  readonly root: string;
  readonly workspace: string;
  readonly identity: VerifiedCandidateIdentity;
  readonly termination?: ManagedReviewTermination;
  /** @internal Deterministic observation and clock seams. */
  readonly adapters?: Partial<CandidateProofRefreshAdapters>;
}): Promise<CandidateProofRefreshResult> {
  const adapters = { ...DEFAULT_ADAPTERS, ...options.adapters };
  const startedAt = adapters.monotonicNow();
  const quality = await adapters.collect({
    session: options.session,
    workspace: options.workspace,
    projectRoot: options.root,
    refreshRemote: true,
    codingXVersion: options.identity.version,
    candidateIdentityDigest: options.identity.digest,
    ...(options.termination === undefined ? {} : { termination: options.termination }),
  });
  const proof = createRefreshedCandidateDogfoodProof({
    identity: options.identity,
    quality,
    completedAt: adapters.now().toISOString(),
  });
  await options.session.writer.writeFile(
    CANDIDATE_PROOF_FILE,
    `${JSON.stringify(proof, null, 2)}\n`,
  );
  return {
    proof,
    durationMs: Math.max(0, Math.round(adapters.monotonicNow() - startedAt)),
  };
}
