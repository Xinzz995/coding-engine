import { describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  invalidateFinalReviewState,
  readFinalReviewState,
  writeFinalReviewState,
} from './state.js';
import { digest } from './common.js';
import type { FinalReviewState, ReviewFinding } from './types.js';
import type { WorkspaceWriteData, WorkspaceWriter } from '../workspace-safety/session.js';

function state(): FinalReviewState {
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: ['src/a.ts'],
    changedModules: ['root'],
  };
  const riskDigest = digest(risk);
  return {
    schemaVersion: 1,
    status: 'passed',
    deliveryStatus: 'ready',
    binding: {
      prNumber: 1,
      targetBranch: 'main',
      baseSha,
      headSha,
      prTitleDigest: 'title',
      prBodyDigest: 'body',
      specDigest: 'spec',
      engineeringStandardsDigest: 'standards',
      qualityContractDigest: 'contract',
      codingXVersion: '0.30.0',
      runner: 'codex',
      model: 'review-model',
      runnerVersion: 'codex-test',
      reviewRulesVersion: '1.0.0',
      reviewRulesDigest: 'rules',
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
    remote: { status: 'ready', checks: [], rulesetErrors: [], checkedAt: '2026-07-26T00:00:00Z' },
    round: 1,
    shadow: false,
    startedAt: '2026-07-26T00:00:00Z',
    completedAt: '2026-07-26T00:01:00Z',
  };
}

function writer(workspace: string): WorkspaceWriter {
  return {
    workspacePath: workspace,
    writeFile: async (relativePath: string, data: WorkspaceWriteData) => {
      writeFileSync(join(workspace, relativePath), data);
    },
    removeFile: async (relativePath: string) => {
      rmSync(join(workspace, relativePath), { force: true });
    },
  } as unknown as WorkspaceWriter;
}

async function withWorkspace(run: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), 'review-state-'));
  try {
    await run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe('readFinalReviewState', () => {
  it('round-trips a complete engine-written state', async () =>
    withWorkspace(async (workspace) => {
      await writeFinalReviewState(writer(workspace), state());
      expect(readFinalReviewState(workspace)).toMatchObject({
        status: 'ready',
        state: { status: 'passed', deliveryStatus: 'ready', round: 1 },
      });
    }));

  it('rejects duplicate or missing independent axes and inconsistent risk binding', async () =>
    withWorkspace(async (workspace) => {
      const broken = state();
      broken.axes = [broken.axes[0], { ...broken.axes[0] }];
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(broken));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });

      broken.axes = state().axes;
      broken.binding.riskDigest = 'different';
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(broken));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }));

  it('rejects a finding copied from another commit', async () =>
    withWorkspace(async (workspace) => {
      const broken = state();
      const finding: ReviewFinding = {
        id: 'RV-SPEC-1',
        axis: 'spec',
        severity: 'P1',
        title: 'wrong commit',
        location: { path: 'src/a.ts', line: 1 },
        ruleSource: 'spec',
        impact: 'incorrect behavior',
        recommendation: 'fix',
        requiresHumanDecision: false,
        prNumber: 1,
        baseSha: broken.binding.baseSha,
        headSha: 'c'.repeat(40),
        round: 1,
      };
      broken.axes[0].status = 'failed';
      broken.axes[0].findings = [finding];
      broken.status = 'failed';
      broken.deliveryStatus = 'findings';
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(broken));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }));

  it('invalidates both machine state and local markdown through the writer', async () =>
    withWorkspace(async (workspace) => {
      const controlledWriter = writer(workspace);
      await writeFinalReviewState(controlledWriter, state());
      await invalidateFinalReviewState(controlledWriter);
      expect(readFinalReviewState(workspace)).toEqual({ status: 'missing' });
      expect(() =>
        writeFileSync(join(workspace, 'final-review.md'), '', { flag: 'wx' }),
      ).not.toThrow();
    }));

  it('writes the machine-readable commit marker only after the readable projection', async () => {
    const writes: string[] = [];
    const controlledWriter = {
      writeFile: async (relativePath: string) => {
        writes.push(relativePath);
      },
    } as unknown as WorkspaceWriter;

    await writeFinalReviewState(controlledWriter, state());
    expect(writes).toEqual(['final-review.md', 'final-review.json']);
  });
});
