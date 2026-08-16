import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { StoryValidationRuntimeIdentity } from '../engine/story-validation-currentness.js';
import {
  collectManagedStatusQuality,
  type ManagedStatusQualityResult,
} from '../review/managed-status.js';
import { digest } from '../review/common.js';
import type { FinalReviewState, ReviewRemoteState } from '../review/types.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import type { VerifiedCandidateIdentity } from './candidate-identity.js';
import { candidateIdentityDigest } from './candidate-identity.js';
import {
  createRefreshedCandidateDogfoodProof,
  refreshCandidateDogfoodProof,
} from './candidate-proof-refresh.js';

const identityFields = {
  schemaVersion: 1 as const,
  packageName: 'coding-x' as const,
  version: '1.2.3',
  commit: 'a'.repeat(40),
  candidateWorkflowRunId: '123',
  tarballSha256: `sha256:${'b'.repeat(64)}`,
  runtimeTreeDigest: `sha256:${'c'.repeat(64)}`,
};
const identity: VerifiedCandidateIdentity = {
  ...identityFields,
  digest: candidateIdentityDigest(identityFields),
  evidencePath: '/outside/packed.json',
};

const readyRemote: ReviewRemoteState = {
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
  checkedAt: '2026-08-17T00:02:00.000Z',
};

function review(): FinalReviewState {
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: [],
    changedModules: [],
  };
  const riskDigest = digest(risk);
  return {
    schemaVersion: 2,
    status: 'passed',
    deliveryStatus: 'shadow',
    binding: {
      prNumber: 7,
      targetBranch: 'main',
      baseSha: 'd'.repeat(40),
      headSha: 'e'.repeat(40),
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
      riskDigest,
    },
    risk: { ...risk, digest: riskDigest },
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
      status: 'pending',
      checks: [],
      rulesetErrors: [],
      checkedAt: '2026-08-17T00:00:00.000Z',
    },
    round: 1,
    shadow: true,
    startedAt: '2026-08-17T00:00:00.000Z',
    completedAt: '2026-08-17T00:01:00.000Z',
  };
}

function quality(
  options: {
    current?: boolean;
    refreshedRemote?: ReviewRemoteState;
    storyHead?: string;
    storyDigest?: string | null;
  } = {},
): ManagedStatusQualityResult {
  const state = review();
  return {
    runnerVersionObservation: { status: 'ready', runner: 'codex', version: 'codex 1.0.0' },
    storyValidation: {
      status: 'ready',
      headSha: options.storyHead ?? state.binding.headSha,
      storyValidationDigest:
        options.storyDigest === undefined
          ? state.binding.storyValidationDigest
          : options.storyDigest,
      storyValidationEnvironmentDigest: `sha256:${'f'.repeat(64)}`,
      workingContract: {
        repository: {
          provider: 'github',
          fullName: 'Xinzz995/fixture',
          defaultBranch: 'main',
        },
      },
    } as ManagedStatusQualityResult['storyValidation'],
    finalReview: {
      read: { status: 'ready', state },
      current: options.current ?? true,
      staleReasons: options.current === false ? ['当前提交已变化'] : [],
      ...(options.refreshedRemote === undefined
        ? { refreshedRemote: readyRemote }
        : { refreshedRemote: options.refreshedRemote }),
    },
  };
}

describe('late candidate proof refresh', () => {
  it('combines the existing local Review with the newly ready remote snapshot', () => {
    const proof = createRefreshedCandidateDogfoodProof({
      identity,
      quality: quality(),
      completedAt: '2026-08-17T00:03:00.000Z',
    });

    expect(proof).toMatchObject({
      candidate: { digest: identity.digest },
      review: {
        headSha: 'e'.repeat(40),
        remoteStatus: 'ready',
        remoteCheckedAt: readyRemote.checkedAt,
        checks: [{ name: 'quality-gate', conclusion: 'success' }],
      },
      completedAt: '2026-08-17T00:03:00.000Z',
    });
  });

  it('refuses stale local results and non-ready refreshed remote states', () => {
    expect(() =>
      createRefreshedCandidateDogfoodProof({
        identity,
        quality: quality({ current: false }),
        completedAt: '2026-08-17T00:03:00.000Z',
      }),
    ).toThrow('Final Review 已失效');

    expect(() =>
      createRefreshedCandidateDogfoodProof({
        identity,
        quality: quality({ refreshedRemote: { ...readyRemote, status: 'pending', checks: [] } }),
        completedAt: '2026-08-17T00:03:00.000Z',
      }),
    ).toThrow('远端总闸仍为 pending');
  });

  it('refuses a Story receipt set that no longer matches the saved Review', () => {
    expect(() =>
      createRefreshedCandidateDogfoodProof({
        identity,
        quality: quality({ storyDigest: `sha256:${'0'.repeat(64)}` }),
        completedAt: '2026-08-17T00:03:00.000Z',
      }),
    ).toThrow('Story 验收结果与 Final Review 绑定不一致');
  });

  it('passes the exact candidate identity into one managed refresh and atomically writes the proof', async () => {
    const writes: Array<{ path: string; data: string }> = [];
    const session = {
      writer: {
        writeFile: async (path: string, data: string) => {
          writes.push({ path, data });
        },
      },
    } as unknown as WorkspaceSession;
    const ticks = [100, 143.6];
    let collectCount = 0;

    const result = await refreshCandidateDogfoodProof({
      session,
      root: '/project',
      workspace: '/project/workspace',
      identity,
      adapters: {
        collect: async (options) => {
          collectCount++;
          expect(options).toMatchObject({
            refreshRemote: true,
            codingXVersion: identity.version,
            candidateIdentityDigest: identity.digest,
          });
          return quality();
        },
        now: () => new Date('2026-08-17T00:03:00.000Z'),
        monotonicNow: () => ticks.shift()!,
      },
    });

    expect(collectCount).toBe(1);
    expect(result.durationMs).toBe(44);
    expect(writes).toHaveLength(1);
    expect(writes[0]?.path).toBe('candidate-proof.json');
    expect(JSON.parse(writes[0].data)).toMatchObject({
      status: 'passed',
      candidate: { digest: identity.digest },
    });
  });

  it('re-evaluates Shadow Story receipts under the exact candidate identity', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'candidate-proof-managed-status-'));
    let observedIdentity: StoryValidationRuntimeIdentity | undefined;
    try {
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(review()));
      await collectManagedStatusQuality({
        session: {} as WorkspaceSession,
        workspace,
        projectRoot: '/project',
        refreshRemote: true,
        codingXVersion: identity.version,
        candidateIdentityDigest: identity.digest,
        adapters: {
          observeStoryValidation: async (options) => {
            observedIdentity = options.runtimeIdentity;
            return {
              status: 'unverifiable',
              reason: 'evaluation-error',
              message: 'stop after observing runtime identity',
              headSha: null,
              prd: null,
              state: {},
              display: null,
              storyValidationEnvironmentDigest: null,
              storyValidationDigest: null,
              workingContract: null,
              trackedContract: null,
              workingContractDigest: null,
              trackedContractDigest: null,
              workspacePath: workspace,
              observationToken: null,
            };
          },
        },
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
    }

    expect(observedIdentity).toEqual({
      mode: 'shadow',
      actualCodingXVersion: identity.version,
      candidateIdentityDigest: identity.digest,
    });
  });

  it('does not write a proof when the managed refresh is not ready', async () => {
    const writes: string[] = [];
    const session = {
      writer: {
        writeFile: async (path: string) => {
          writes.push(path);
        },
      },
    } as unknown as WorkspaceSession;

    await expect(
      refreshCandidateDogfoodProof({
        session,
        root: '/project',
        workspace: '/project/workspace',
        identity,
        adapters: {
          collect: async () =>
            quality({ refreshedRemote: { ...readyRemote, status: 'failed', checks: [] } }),
        },
      }),
    ).rejects.toThrow('远端总闸仍为 failed');
    expect(writes).toEqual([]);
  });
});
