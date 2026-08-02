import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  invalidateFinalReviewState,
  readFinalReviewState,
  readReviewDecisions,
  writeFinalReviewState,
} from './state.js';
import { digest } from './common.js';
import type { FinalReviewState, ReviewFinding } from './types.js';
import type { WorkspaceWriteData, WorkspaceWriter } from '../workspace-safety/session.js';
import { STABLE_FILE_DEFAULT_MAX_BYTES } from '../workspace-safety/stable-file.js';

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
      validationEnvironmentDigest: `sha256:${'0'.repeat(64)}`,
      storyValidationDigest: `sha256:${'c'.repeat(64)}`,
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
  it.runIf(process.platform !== 'win32')(
    'rejects final Review and decision FIFOs without waiting for a writer',
    async () =>
      withWorkspace(async (workspace) => {
        execFileSync('mkfifo', [join(workspace, 'final-review.json')]);
        expect(readFinalReviewState(workspace)).toMatchObject({
          status: 'invalid',
          error: expect.stringContaining('不是独立普通文件'),
        });
        rmSync(join(workspace, 'final-review.json'));

        execFileSync('mkfifo', [join(workspace, 'review-decisions.json')]);
        expect(() => readReviewDecisions(workspace)).toThrow('不是独立普通文件');
      }),
  );

  it('rejects oversized final Review and decision inputs before parsing them', async () =>
    withWorkspace(async (workspace) => {
      const oversized = Buffer.alloc(STABLE_FILE_DEFAULT_MAX_BYTES + 1);
      writeFileSync(join(workspace, 'final-review.json'), oversized);
      expect(readFinalReviewState(workspace)).toMatchObject({
        status: 'invalid',
        error: expect.stringContaining(`超过 ${STABLE_FILE_DEFAULT_MAX_BYTES} bytes`),
      });

      writeFileSync(join(workspace, 'review-decisions.json'), oversized);
      expect(() => readReviewDecisions(workspace)).toThrow(
        `超过 ${STABLE_FILE_DEFAULT_MAX_BYTES} bytes`,
      );
    }));

  it('reads both historical schema-v1 binding shapes without upgrading either one', async () =>
    withWorkspace(async (workspace) => {
      const earliest = structuredClone(state()) as unknown as {
        schemaVersion: number;
        binding: Record<string, unknown>;
      };
      earliest.schemaVersion = 1;
      delete earliest.binding.validationEnvironmentDigest;
      delete earliest.binding.storyValidationDigest;
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(earliest));
      const earliestRead = readFinalReviewState(workspace);
      expect(earliestRead).toMatchObject({
        status: 'ready',
        state: {
          schemaVersion: 1,
          status: 'passed',
          deliveryStatus: 'ready',
          round: 1,
        },
      });
      if (earliestRead.status !== 'ready') throw new Error('expected legacy Review to be readable');
      expect(earliestRead.state.binding.storyValidationDigest).toBeUndefined();

      const later = structuredClone(earliest);
      later.binding.storyValidationDigest = `sha256:${'d'.repeat(64)}`;
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(later));
      const laterRead = readFinalReviewState(workspace);
      expect(laterRead).toMatchObject({
        status: 'ready',
        state: {
          schemaVersion: 1,
          binding: { storyValidationDigest: later.binding.storyValidationDigest },
        },
      });
    }));

  it('round-trips a schema-v2 dual binding and rejects missing or malformed digests', async () =>
    withWorkspace(async (workspace) => {
      const current = state();
      await writeFinalReviewState(writer(workspace), current);
      expect(readFinalReviewState(workspace)).toMatchObject({
        status: 'ready',
        state: {
          schemaVersion: 2,
          binding: {
            storyValidationDigest: current.binding.storyValidationDigest,
            validationEnvironmentDigest: current.binding.validationEnvironmentDigest,
          },
        },
      });

      for (const key of ['storyValidationDigest', 'validationEnvironmentDigest'] as const) {
        const missing = structuredClone(current) as unknown as {
          binding: Record<string, unknown>;
        };
        delete missing.binding[key];
        writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(missing));
        expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });

        const malformed = structuredClone(current);
        malformed.binding[key] = 'not-a-digest';
        writeFileSync(join(workspace, 'final-review.json'), JSON.stringify(malformed));
        expect(readFinalReviewState(workspace)).toMatchObject({ status: 'invalid' });
      }
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

  it('refuses to write either readable schema-v1 shape as a new Review', async () =>
    withWorkspace(async (workspace) => {
      const legacy = structuredClone(state()) as unknown as {
        schemaVersion: number;
        binding: Record<string, unknown>;
      };
      legacy.schemaVersion = 1;
      delete legacy.binding.validationEnvironmentDigest;
      for (const keepStoryDigest of [true, false]) {
        const candidate = structuredClone(legacy);
        if (!keepStoryDigest) delete candidate.binding.storyValidationDigest;
        await expect(
          writeFinalReviewState(writer(workspace), candidate as unknown as FinalReviewState),
        ).rejects.toThrow('只允许写入当前 schema v2 Final Review');
      }
    }));
});
