import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  freezeReviewDecisions,
  readFinalReviewState,
  restoreReviewDecisionsSnapshot,
  reviewDecisionsDigest,
  reviewDecisionsSnapshotIsValid,
  writeFinalReviewState,
} from './state.js';
import { digest, reviewRoutingDigest } from './common.js';
import { applyReviewerDeepReviewRequest } from './risk.js';
import type { FinalReviewState, ReviewFinding } from './types.js';

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
    schemaVersion: 2,
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
      storyValidationDigest: 'story-validation',
      reviewDecisionsDigest: 'review-decisions',
      reviewRoutingDigest: reviewRoutingDigest(undefined),
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

function withWorkspace(run: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), 'review-state-'));
  try {
    run(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

describe('readFinalReviewState', () => {
  it('round-trips a complete engine-written state', () =>
    withWorkspace((workspace) => {
      writeFinalReviewState(workspace, state());
      expect(readFinalReviewState(workspace)).toMatchObject({
        status: 'ready',
        state: { status: 'passed', deliveryStatus: 'ready', round: 1 },
      });
    }));

  it.skipIf(process.platform === 'win32')('never follows a final-review.json symlink', () =>
    withWorkspace((workspace) => {
      const outside = join(workspace, 'outside-review.json');
      writeFileSync(outside, JSON.stringify(state()));
      symlinkSync(outside, join(workspace, 'final-review.json'));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }),
  );

  it('never leaves an authoritative JSON result when the Markdown write fails', () =>
    withWorkspace((workspace) => {
      mkdirSync(join(workspace, 'final-review.md'));

      expect(() => writeFinalReviewState(workspace, state())).toThrow();
      expect(existsSync(join(workspace, 'final-review.json'))).toBe(false);
      expect(readFinalReviewState(workspace)).toEqual({ status: 'missing' });
    }));

  it('marks the v1 state as unsupported instead of corrupted', () =>
    withWorkspace((workspace) => {
      const legacy = { ...state(), schemaVersion: 1 };
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(legacy));
      expect(readFinalReviewState(workspace)).toEqual({ status: 'unsupported', schemaVersion: 1 });
    }));

  it('still rejects a malformed current-version marker', () =>
    withWorkspace((workspace) => {
      const malformed = { ...state(), schemaVersion: '2' };
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(malformed));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }));

  it('rejects a v2 binding without the Story Validator digest', () =>
    withWorkspace((workspace) => {
      const broken = state();
      delete (broken.binding as unknown as Record<string, unknown>).storyValidationDigest;
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(broken));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }));

  it('rejects a v2 binding without the frozen Review decisions digest', () =>
    withWorkspace((workspace) => {
      const broken = state();
      delete (broken.binding as unknown as Record<string, unknown>).reviewDecisionsDigest;
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(broken));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }));

  it('rejects a v2 binding without the frozen PRD model-routing digest', () =>
    withWorkspace((workspace) => {
      const broken = state();
      delete (broken.binding as unknown as Record<string, unknown>).reviewRoutingDigest;
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(broken));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }));

  it('rejects duplicate or missing independent axes and inconsistent risk binding', () =>
    withWorkspace((workspace) => {
      const broken = state();
      broken.axes = [broken.axes[0], { ...broken.axes[0] }];
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(broken));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });

      broken.axes = state().axes;
      broken.binding.riskDigest = 'different';
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(broken));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }));

  it('keeps Reviewer deep-review requests consistent with persisted risk', () =>
    withWorkspace((workspace) => {
      const requested = state();
      requested.axes[0].requestDeepReview = true;
      requested.risk = applyReviewerDeepReviewRequest(requested.risk, true);
      requested.binding.riskDigest = requested.risk.digest;
      requested.axes.push({
        axis: 'deep',
        status: 'passed',
        summary: 'deep ok',
        findings: [],
        requestDeepReview: false,
        durationMs: 1,
        attempts: 1,
      });
      writeFinalReviewState(workspace, requested);
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'ready' });

      requested.axes[0].requestDeepReview = false;
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(requested));
      expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
    }));

  it('rejects a finding copied from another commit', () =>
    withWorkspace((workspace) => {
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
});

describe('frozen Review decisions', () => {
  it('treats absence as an explicit identity and removes a file created during the run', () =>
    withWorkspace((workspace) => {
      const snapshot = freezeReviewDecisions(workspace);
      expect(snapshot).toMatchObject({ raw: null, value: { schemaVersion: 1, decisions: [] } });
      expect(snapshot.digest).toBe(reviewDecisionsDigest(null));
      expect(reviewDecisionsSnapshotIsValid(snapshot)).toBe(true);
      writeFileSync(join(workspace, 'review-decisions.json'), '{"forged":true}');
      expect(restoreReviewDecisionsSnapshot(workspace, snapshot)).toMatchObject({ changed: true });
      expect(existsSync(join(workspace, 'review-decisions.json'))).toBe(false);
    }));

  it.skipIf(process.platform === 'win32')(
    'removes a forged decisions symlink without reading or changing its target',
    () =>
      withWorkspace((workspace) => {
        const target = join(workspace, 'outside-decisions.json');
        const raw = '{"schemaVersion":1,"decisions":[]}\n';
        writeFileSync(target, raw);
        const snapshot = freezeReviewDecisions(workspace);
        symlinkSync(target, join(workspace, 'review-decisions.json'));

        expect(restoreReviewDecisionsSnapshot(workspace, snapshot)).toMatchObject({
          changed: true,
        });
        expect(existsSync(join(workspace, 'review-decisions.json'))).toBe(false);
        expect(readFileSync(target, 'utf8')).toBe(raw);
      }),
  );

  it('restores the exact valid bytes frozen before the run', () =>
    withWorkspace((workspace) => {
      const path = join(workspace, 'review-decisions.json');
      const original = '{"schemaVersion":1,"decisions":[]}\n';
      writeFileSync(path, original);
      const snapshot = freezeReviewDecisions(workspace);
      writeFileSync(path, '{"schemaVersion":1,"decisions":[ ]}');
      const restored = restoreReviewDecisionsSnapshot(workspace, snapshot);
      expect(restored.changed).toBe(true);
      expect(readFileSync(path, 'utf8')).toBe(original);
    }));

  it('fails closed when the startup file is malformed', () =>
    withWorkspace((workspace) => {
      writeFileSync(join(workspace, 'review-decisions.json'), '{broken');
      expect(() => freezeReviewDecisions(workspace)).toThrow('无法解析 review-decisions.json');
    }));

  it('rejects a snapshot whose parsed value does not belong to its raw bytes', () =>
    withWorkspace((workspace) => {
      const snapshot = freezeReviewDecisions(workspace);
      snapshot.value.decisions.push({
        findingId: 'forged',
        headSha: 'a'.repeat(40),
        action: 'counterevidence',
        operator: 'forged',
        at: '2026-07-29T00:00:00.000Z',
        evidence: 'forged evidence',
      });
      expect(reviewDecisionsSnapshotIsValid(snapshot)).toBe(false);
    }));
});
