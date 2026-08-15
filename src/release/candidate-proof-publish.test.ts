import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { CandidateDogfoodProof } from './candidate-proof.js';
import { CANDIDATE_PROOF_FILE, candidateDogfoodProofDigest } from './candidate-proof.js';
import {
  CANDIDATE_PROOF_COMMENT_MARKER,
  publishCandidateProof,
  type CandidateProofCommandInvocation,
} from './candidate-proof-publish.js';
import { candidateIdentityDigest } from './candidate-identity.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function proof(headSha = 'b'.repeat(40)): CandidateDogfoodProof {
  const candidateBase = {
    schemaVersion: 1 as const,
    packageName: 'coding-x' as const,
    version: '0.36.0',
    commit: 'a'.repeat(40),
    candidateWorkflowRunId: '123',
    tarballSha256: `sha256:${'1'.repeat(64)}`,
    runtimeTreeDigest: `sha256:${'2'.repeat(64)}`,
  };
  const candidate = { ...candidateBase, digest: candidateIdentityDigest(candidateBase) };
  const base = {
    schemaVersion: 1 as const,
    status: 'passed' as const,
    repository: {
      provider: 'github' as const,
      fullName: 'Xinzz995/example',
      defaultBranch: 'main',
    },
    candidate,
    review: {
      prNumber: 42,
      baseSha: 'c'.repeat(40),
      headSha,
      bindingDigest: `sha256:${'3'.repeat(64)}`,
      storyValidationDigest: `sha256:${'4'.repeat(64)}`,
      storyValidationEnvironmentDigest: `sha256:${'5'.repeat(64)}`,
      remoteStatus: 'ready' as const,
      remoteCheckedAt: '2026-08-15T00:00:00.000Z',
      checks: [
        {
          name: 'quality-gate',
          status: 'completed' as const,
          conclusion: 'success' as const,
          appId: 15_368 as const,
          appSlug: 'github-actions',
        },
      ],
    },
    completedAt: '2026-08-15T00:01:00.000Z',
  };
  return { ...base, proofDigest: candidateDogfoodProofDigest(base) };
}

function fixture(candidate = proof()): { root: string; workspace: string } {
  const root = mkdtempSync(join(tmpdir(), 'candidate-proof-publish-'));
  roots.push(root);
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, CANDIDATE_PROOF_FILE), JSON.stringify(candidate));
  return { root, workspace };
}

function executor(options: { existing?: boolean; head?: string } = {}) {
  const calls: CandidateProofCommandInvocation[] = [];
  const execute = (invocation: CandidateProofCommandInvocation): string => {
    calls.push(invocation);
    const args = invocation.args.join(' ');
    if (invocation.command === 'git' && args === 'rev-parse HEAD') {
      return options.head ?? 'b'.repeat(40);
    }
    if (invocation.command === 'git') return 'agent/issue-42';
    if (args.startsWith('repo view')) {
      return JSON.stringify({
        nameWithOwner: 'Xinzz995/example',
        defaultBranchRef: { name: 'main' },
      });
    }
    if (args === 'api user') return JSON.stringify({ login: 'Xinzz995' });
    if (args.startsWith('pr view')) {
      return JSON.stringify({
        number: 42,
        state: 'OPEN',
        isDraft: false,
        headRefOid: 'b'.repeat(40),
        baseRefName: 'main',
        baseRefOid: 'c'.repeat(40),
        mergeStateStatus: 'CLEAN',
        url: 'https://example.test/pr/42',
      });
    }
    if (args.includes('--paginate')) {
      return JSON.stringify(
        options.existing
          ? [
              [
                {
                  id: 9,
                  body: `${CANDIDATE_PROOF_COMMENT_MARKER}\nold`,
                  html_url: 'https://example.test/comment/9',
                  user: { login: 'Xinzz995' },
                  author_association: 'OWNER',
                },
              ],
            ]
          : [[]],
      );
    }
    if (args.includes('--method POST')) {
      return JSON.stringify({ html_url: 'https://example.test/comment/10' });
    }
    if (args.includes('--method PATCH')) return '{}';
    throw new Error(`unexpected command: ${invocation.command} ${args}`);
  };
  return { calls, execute };
}

describe('publishCandidateProof', () => {
  it('creates the single owner proof comment after binding repository, PR and head', () => {
    const paths = fixture();
    const fake = executor();
    const result = publishCandidateProof({ ...paths, executor: fake.execute });
    expect(result).toMatchObject({ status: 'created', pullRequest: 42 });
    const post = fake.calls.find((call) => call.args.includes('POST'));
    expect(post?.args.join('\n')).toContain(CANDIDATE_PROOF_COMMENT_MARKER);
    expect(post?.args.join('\n')).toContain(proof().proofDigest);
  });

  it('updates the existing owner proof comment instead of creating another', () => {
    const paths = fixture();
    const fake = executor({ existing: true });
    const result = publishCandidateProof({ ...paths, executor: fake.execute });
    expect(result).toMatchObject({ status: 'updated', url: 'https://example.test/comment/9' });
    expect(fake.calls.some((call) => call.args.includes('PATCH'))).toBe(true);
    expect(fake.calls.some((call) => call.args.includes('POST'))).toBe(false);
  });

  it('refuses to publish when the current head differs from the proof', () => {
    const paths = fixture();
    const fake = executor({ head: 'd'.repeat(40) });
    expect(() => publishCandidateProof({ ...paths, executor: fake.execute })).toThrow(
      '当前提交与候选证明绑定的提交不一致',
    );
    expect(fake.calls.every((call) => call.command === 'git')).toBe(true);
  });
});
