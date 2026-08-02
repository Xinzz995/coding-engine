import { mkdtempSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession } from '../workspace-safety/session.js';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { inspectWorkspaceSafetyStatus } from '../workspace-safety/status.js';
import { readQualityContract } from '../quality/contract.js';
import { tryReadPrd } from '../engine/prd.js';
import { acceptanceHash, readGitHead } from '../engine/validation-protocol.js';
import {
  evaluateStoryValidationDisplay,
  evaluateStoryValidationReceiptSet,
  readDisplayState,
} from '../engine/state.js';
import type { StoryValidationObservation } from '../review/story-validation-observation.js';
import { readFinalReviewState } from '../review/state.js';
import { digest } from '../review/common.js';
import type { FinalReviewState } from '../review/types.js';
import {
  collectStatus,
  collectStatusWithWorkspaceSafety,
  collectStatusWithWorkspaceSafetyControlled,
  renderStatusReport,
} from './status.js';

const roots: string[] = [];
const CURRENT_GIT_HEAD = (() => {
  const head = readGitHead(process.cwd());
  if (head === null) throw new Error('status race tests require a Git HEAD');
  return head;
})();
const CURRENT_QUALITY = (() => {
  const quality = readQualityContract(process.cwd());
  if (quality.status !== 'ready') {
    throw new Error(`status race tests require a quality contract: ${quality.status}`);
  }
  return quality;
})();
const STORY_ENVIRONMENT_DIGEST = `sha256:${'e'.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-status-race-'));
  roots.push(workspace);
  return workspace;
}

function state(notes: string, retryCount: number): string {
  return JSON.stringify({
    'US-001': {
      passes: false,
      validated: false,
      notes,
      retryCount,
      blocked: false,
      escalated: false,
    },
  });
}

function readyObservation(workspace: string): StoryValidationObservation {
  const prd = tryReadPrd(join(workspace, 'prd.json'));
  if (prd === null) throw new Error('status race fixture PRD is unreadable');
  const runState = readDisplayState(join(workspace, 'state.json'), prd).state;
  const display = evaluateStoryValidationDisplay(
    prd,
    runState,
    CURRENT_GIT_HEAD,
    STORY_ENVIRONMENT_DIGEST,
  );
  const receiptSet = evaluateStoryValidationReceiptSet(
    prd,
    runState,
    CURRENT_GIT_HEAD,
    STORY_ENVIRONMENT_DIGEST,
  );
  return {
    status: 'ready',
    workspacePath: workspace,
    observationToken: `sha256:${'f'.repeat(64)}`,
    headSha: CURRENT_GIT_HEAD,
    prd,
    state: display.state,
    display,
    storyValidationEnvironmentDigest: STORY_ENVIRONMENT_DIGEST,
    storyValidationDigest: receiptSet.digest,
    workingContract: CURRENT_QUALITY.contract,
    trackedContract: CURRENT_QUALITY.contract,
    workingContractDigest: CURRENT_QUALITY.digest,
    trackedContractDigest: CURRENT_QUALITY.digest,
    tddConfig: null,
    receiptSet,
  };
}

function collectObservedStatus(workspace: string): ReturnType<typeof collectStatus> {
  return collectStatus(workspace, {
    currentGitHead: CURRENT_GIT_HEAD,
    storyValidationObservation: readyObservation(workspace),
  });
}

async function writeWithFormalSession(
  workspace: string,
  writes: Readonly<Record<string, string>>,
): Promise<void> {
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
  const session = createWorkspaceSession(lease);
  for (const [path, bytes] of Object.entries(writes)) {
    await session.writer.writeFile(path, bytes);
  }
  await session.close();
}

async function readyWorkspace(): Promise<string> {
  const workspace = temporaryWorkspace();
  await bootstrapWorkspace({ workspacePath: workspace });
  await writeWithFormalSession(workspace, {
    'prd.json': JSON.stringify({
      project: 'status-race',
      branchName: 'feature/status-race',
      description: 'status race fixture',
      qualityContractDigest: CURRENT_QUALITY.digest,
      qualityChecks: CURRENT_QUALITY.contract.checks,
      userStories: [
        {
          id: 'US-001',
          title: 'status race',
          description: 'status race',
          acceptanceCriteria: ['status is stable'],
          priority: 1,
        },
      ],
    }),
    'state.json': state('before', 0),
  });
  return workspace;
}

function readyFinalReview(storyValidationDigest: string): FinalReviewState {
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: ['src/status.ts'],
    changedModules: ['src'],
  };
  const riskDigest = digest(risk);
  return {
    schemaVersion: 2,
    status: 'passed',
    deliveryStatus: 'ready',
    binding: {
      prNumber: 42,
      targetBranch: 'main',
      baseSha: 'a'.repeat(40),
      headSha: CURRENT_GIT_HEAD,
      prTitleDigest: 'title',
      prBodyDigest: 'body',
      specDigest: 'spec',
      engineeringStandardsDigest: 'standards',
      qualityContractDigest: CURRENT_QUALITY.digest,
      validationEnvironmentDigest: STORY_ENVIRONMENT_DIGEST,
      storyValidationDigest,
      codingXVersion: 'test-version',
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
    remote: {
      status: 'ready',
      checks: [],
      rulesetErrors: [],
      checkedAt: '2026-08-02T00:00:00.000Z',
    },
    round: 1,
    shadow: false,
    startedAt: '2026-08-02T00:00:00.000Z',
    completedAt: '2026-08-02T00:01:00.000Z',
  };
}

describe('collectStatusWithWorkspaceSafety consistency window', () => {
  it('re-reads Final Review after the managed observation and rejects a removed result', async () => {
    const workspace = await readyWorkspace();
    await writeWithFormalSession(workspace, {
      'state.json': JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          validationReceipt: {
            schemaVersion: 2,
            requestId: 'status-final-review-race',
            gitHead: CURRENT_GIT_HEAD,
            acceptanceHash: acceptanceHash('US-001', ['status is stable']),
            validationEnvironmentDigest: STORY_ENVIRONMENT_DIGEST,
          },
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    });
    const storyObservation = readyObservation(workspace);
    const storyDigest = storyObservation.storyValidationDigest;
    if (storyObservation.status !== 'ready' || storyDigest === null) {
      throw new Error('expected ready Story observation');
    }
    await writeWithFormalSession(workspace, {
      'final-review.json': JSON.stringify(readyFinalReview(storyDigest)),
    });
    const observedRead = readFinalReviewState(workspace);
    expect(observedRead.status).toBe('ready');

    const result = await collectStatusWithWorkspaceSafety(workspace, {
      projectRoot: process.cwd(),
      currentGitHead: CURRENT_GIT_HEAD,
      statusQualityObserver: async () => {
        rmSync(join(workspace, 'final-review.json'));
        return {
          storyValidation: storyObservation,
          runnerVersionObservation: {
            status: 'ready',
            runner: 'codex',
            version: 'codex-test',
          },
          finalReview: { read: observedRead, current: true, staleReasons: [] },
          error: null,
        };
      },
    });

    expect(result.status).toBe('ok');
    if (result.status !== 'ok') return;
    expect(result.finalReview).toMatchObject({
      read: { status: 'missing' },
      current: false,
    });
    expect(renderStatusReport(result).exitCode).not.toBe(0);
  });

  it.runIf(process.platform !== 'win32')(
    'production entry rejects special display files without blocking or preserving green state',
    async () => {
      const workspace = await readyWorkspace();
      const observation = readyObservation(workspace);
      for (const filename of ['state.json', 'progress.md', 'evidence.jsonl', 'final-review.json']) {
        rmSync(join(workspace, filename), { force: true });
        execFileSync('mkfifo', [join(workspace, filename)]);
      }

      const result = await collectStatusWithWorkspaceSafety(workspace, {
        currentGitHead: CURRENT_GIT_HEAD,
        storyValidationObservation: observation,
      });

      expect(result.status).toBe('ok');
      if (result.status !== 'ok') return;
      expect(result.stateCorrupted).toBe(true);
      expect(result.storyValidation.current).toBe(false);
      expect(result.latestProgress).toBeNull();
      expect(result.evidenceUnavailable).toBe(true);
      expect(result.finalReview.read.status).toBe('invalid');
      expect(renderStatusReport(result).exitCode).not.toBe(0);
    },
  );

  it.runIf(process.platform !== 'win32')(
    'production entry rejects a PRD FIFO without waiting for a writer',
    async () => {
      const workspace = await readyWorkspace();
      const observation = readyObservation(workspace);
      rmSync(join(workspace, 'prd.json'));
      execFileSync('mkfifo', [join(workspace, 'prd.json')]);

      const result = await collectStatusWithWorkspaceSafety(workspace, {
        currentGitHead: CURRENT_GIT_HEAD,
        storyValidationObservation: observation,
      });

      expect(result.status).toBe('unparsable');
      expect(renderStatusReport(result).exitCode).toBe(2);
    },
  );

  it('retries the complete business read when a writer starts and finishes during it', async () => {
    const workspace = await readyWorkspace();
    const initial = await inspectWorkspaceSafetyStatus(workspace);
    let collections = 0;

    const result = await collectStatusWithWorkspaceSafetyControlled({
      inspect: async () => await inspectWorkspaceSafetyStatus(workspace),
      collect: async () => {
        collections += 1;
        if (collections === 1) {
          await writeWithFormalSession(workspace, { 'state.json': state('after', 1) });
        }
        return collectObservedStatus(workspace);
      },
    });

    expect(collections).toBe(2);
    expect(result.workspaceSafety.status).toBe('ready');
    expect(result.workspaceSafety.safetyFingerprint).not.toBe(initial.safetyFingerprint);
    if (result.status !== 'ok') throw new Error(`expected ok, got ${result.status}`);
    expect(result.stories[0]).toMatchObject({ notes: 'after', retryCount: 1 });
    expect(renderStatusReport(result).exitCode).not.toBe(2);
  });

  it('fails closed after one retry when each business read overlaps a completed writer', async () => {
    const workspace = await readyWorkspace();
    let collections = 0;

    const result = await collectStatusWithWorkspaceSafetyControlled({
      inspect: async () => await inspectWorkspaceSafetyStatus(workspace),
      collect: async () => {
        collections += 1;
        await writeWithFormalSession(workspace, {
          'state.json': state(`attempt-${collections}`, collections),
        });
        return collectObservedStatus(workspace);
      },
    });

    expect(collections).toBe(2);
    expect(result.workspaceSafety).toMatchObject({
      status: 'invalid',
      observedClassification: 'invalid',
      reason: 'unstable-probe',
    });
    expect(result.workspaceSafety.diagnostic).toContain('did not stabilize after one retry');
    expect(renderStatusReport(result).exitCode).toBe(2);
  });
});
