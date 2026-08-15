import { describe, expect, it } from 'vitest';
import type { QualityContract } from '../quality/contract.js';
import { digest } from '../review/common.js';
import type { FinalReviewState } from '../review/types.js';
import type { VerifiedCandidateIdentity } from './candidate-identity.js';
import { candidateIdentityDigest } from './candidate-identity.js';
import { candidateDogfoodProofDigest, createCandidateDogfoodProof } from './candidate-proof.js';

const identityFields = {
  schemaVersion: 1,
  packageName: 'coding-x' as const,
  version: '1.2.3',
  commit: 'a'.repeat(40),
  candidateWorkflowRunId: '123',
  tarballSha256: `sha256:${'b'.repeat(64)}`,
  runtimeTreeDigest: `sha256:${'c'.repeat(64)}`,
} as const;
const identity: VerifiedCandidateIdentity = {
  ...identityFields,
  digest: candidateIdentityDigest(identityFields),
  evidencePath: '/tmp/packed.json',
};

const risk = {
  triggered: false,
  categories: [],
  reasons: [],
  changedFiles: ['src/a.ts'],
  changedModules: ['root'],
};

function review(overrides: Partial<FinalReviewState> = {}): FinalReviewState {
  return {
    schemaVersion: 2,
    status: 'passed',
    deliveryStatus: 'shadow',
    binding: {
      prNumber: 7,
      targetBranch: 'main',
      baseSha: 'e'.repeat(40),
      headSha: 'f'.repeat(40),
      prTitleDigest: `sha256:${'1'.repeat(64)}`,
      prBodyDigest: `sha256:${'2'.repeat(64)}`,
      specDigest: `sha256:${'3'.repeat(64)}`,
      engineeringStandardsDigest: `sha256:${'4'.repeat(64)}`,
      qualityContractDigest: `sha256:${'5'.repeat(64)}`,
      validationEnvironmentDigest: `sha256:${'6'.repeat(64)}`,
      storyValidationDigest: `sha256:${'7'.repeat(64)}`,
      codingXVersion: '1.2.3',
      runner: 'codex',
      model: 'review-model',
      runnerVersion: 'codex 1.0.0',
      reviewRulesVersion: '1.5.0',
      reviewRulesDigest: `sha256:${'8'.repeat(64)}`,
      riskDigest: digest(risk),
    },
    risk: { ...risk, digest: digest(risk) },
    axes: [
      {
        axis: 'spec',
        status: 'passed',
        summary: 'ok',
        findings: [],
        requestDeepReview: false,
        durationMs: 1,
        attempts: 1,
      },
      {
        axis: 'engineering',
        status: 'passed',
        summary: 'ok',
        findings: [],
        requestDeepReview: false,
        durationMs: 1,
        attempts: 1,
      },
    ],
    remote: {
      status: 'ready',
      checks: [
        {
          name: 'quality-gate',
          status: 'completed',
          conclusion: 'success',
          appId: 15_368,
          appSlug: 'github-actions',
        },
      ],
      rulesetErrors: [],
      checkedAt: '2026-08-15T00:00:00Z',
    },
    round: 1,
    shadow: true,
    startedAt: '2026-08-15T00:00:00Z',
    completedAt: '2026-08-15T00:01:00Z',
    ...overrides,
  };
}

const contract = {
  repository: { provider: 'github', fullName: 'Xinzz995/fixture', defaultBranch: 'main' },
} as Pick<QualityContract, 'repository'>;

describe('candidate dogfood proof', () => {
  it('binds the candidate, target repository, PR head and engine review identities', () => {
    const proof = createCandidateDogfoodProof({
      identity,
      contract,
      review: review(),
      storyValidationEnvironmentDigest: `sha256:${'9'.repeat(64)}`,
      completedAt: '2026-08-15T00:02:00Z',
    });
    expect(proof).toMatchObject({
      status: 'passed',
      repository: { fullName: 'Xinzz995/fixture' },
      candidate: { digest: identity.digest, tarballSha256: identity.tarballSha256 },
      review: {
        prNumber: 7,
        headSha: 'f'.repeat(40),
        checks: [{ name: 'quality-gate', conclusion: 'success' }],
      },
    });
    const { proofDigest, ...unsigned } = proof;
    expect(proofDigest).toBe(candidateDogfoodProofDigest(unsigned));
    expect(JSON.stringify(proof)).not.toContain(identity.evidencePath);
  });

  it('does not issue a release proof before the remote gate is ready', () => {
    expect(() =>
      createCandidateDogfoodProof({
        identity,
        contract,
        review: review({
          remote: {
            status: 'pending',
            checks: [],
            rulesetErrors: [],
            checkedAt: '2026-08-15T00:00:00Z',
          },
        }),
        storyValidationEnvironmentDigest: `sha256:${'9'.repeat(64)}`,
      }),
    ).toThrow('远端总闸已经 ready');
  });

  it('does not issue a proof for a formal or failed Review', () => {
    expect(() =>
      createCandidateDogfoodProof({
        identity,
        contract,
        review: review({ shadow: false, deliveryStatus: 'ready' }),
        storyValidationEnvironmentDigest: `sha256:${'9'.repeat(64)}`,
      }),
    ).toThrow('Shadow Final Review');
  });

  it('does not issue a proof from an identity whose digest was merely copied in', () => {
    expect(() =>
      createCandidateDogfoodProof({
        identity: { ...identity, digest: `sha256:${'d'.repeat(64)}` },
        contract,
        review: review(),
        storyValidationEnvironmentDigest: `sha256:${'9'.repeat(64)}`,
      }),
    ).toThrow('摘要闭环');
  });
});
