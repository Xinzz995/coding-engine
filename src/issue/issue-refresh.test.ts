import { describe, expect, it, vi } from 'vitest';
import type { FinalReviewState, ReviewRemoteState } from '../review/types.js';
import type { StatusReportWithWorkspaceSafety } from '../status/status.js';
import { issueRemoteRefreshResult, refreshReadyIssueReview } from './issue-refresh.js';

function remote(status: ReviewRemoteState['status']): ReviewRemoteState {
  return { status, checks: [], rulesetErrors: [], checkedAt: '2026-08-19T00:00:00.000Z' };
}

function report(status: ReviewRemoteState['status']): StatusReportWithWorkspaceSafety {
  const binding = {
    prNumber: 289,
    targetBranch: 'main',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    prTitleDigest: `sha256:${'1'.repeat(64)}`,
    prBodyDigest: `sha256:${'2'.repeat(64)}`,
    specDigest: `sha256:${'3'.repeat(64)}`,
    engineeringStandardsDigest: `sha256:${'4'.repeat(64)}`,
    qualityContractDigest: `sha256:${'5'.repeat(64)}`,
    validationEnvironmentDigest: `sha256:${'6'.repeat(64)}`,
    storyValidationDigest: `sha256:${'7'.repeat(64)}`,
    codingXVersion: '0.37.0',
    runner: 'codex' as const,
    model: 'review-model',
    runnerVersion: 'codex-cli 0.147.0',
    reviewRulesVersion: '1.5.0',
    reviewRulesDigest: `sha256:${'8'.repeat(64)}`,
    riskDigest: `sha256:${'9'.repeat(64)}`,
  };
  const state = {
    schemaVersion: 2,
    status: 'passed',
    shadow: false,
    binding,
    remote: remote('pending'),
  } as unknown as FinalReviewState;
  return {
    status: 'ok',
    prd: { project: 'fixture', branchName: 'codex/issue-288', userStories: [] },
    stories: [
      {
        id: 'US-001',
        title: 'refresh',
        priority: 1,
        passes: true,
        validated: true,
        blocked: false,
        notes: '',
        retryCount: 0,
        escalated: false,
      },
    ],
    currentStoryId: null,
    latestProgress: null,
    modelRouting: { status: 'disabled' },
    recentActual: {},
    recentValidation: {},
    evidenceSkippedLines: 0,
    evidenceUnavailable: false,
    stateCorrupted: false,
    storyValidation: {
      gitHead: binding.headSha,
      current: true,
      invalidStoryIds: [],
      configurationError: null,
    },
    finalReview: {
      read: { status: 'ready', state },
      current: true,
      staleReasons: [],
      refreshedRemote: remote(status),
    },
    workspaceSafety: {
      status: 'ready',
      display: { label: '安全', summary: 'ready', guidance: null },
    },
  } as unknown as StatusReportWithWorkspaceSafety;
}

describe('ready Issue remote-only refresh', () => {
  it('reuses a current passed Review and reports the measured refresh', () => {
    expect(issueRemoteRefreshResult(report('ready'), 42.4)).toMatchObject({
      exitCode: 0,
      evidence: {
        reusedFinalReview: true,
        remoteRefreshDurationMs: 42,
        storyValidationDigest: `sha256:${'7'.repeat(64)}`,
      },
    });
    expect(issueRemoteRefreshResult(report('pending'), 50)).toMatchObject({
      exitCode: 6,
      message: expect.stringContaining('pending'),
    });
    expect(issueRemoteRefreshResult(report('failed'), 51)).toMatchObject({
      exitCode: 6,
      message: expect.stringContaining('failed'),
    });
  });

  it('falls back when any trusted local input or workspace safety is stale', () => {
    const stale = report('ready');
    if (stale.status === 'ok') stale.finalReview.current = false;
    expect(issueRemoteRefreshResult(stale, 10)).toBeNull();

    const safe = report('ready');
    const unsafe = {
      ...safe,
      workspaceSafety: { ...safe.workspaceSafety, status: 'isolated' as const },
    };
    expect(issueRemoteRefreshResult(unsafe, 10)).toBeNull();

    const unrefreshed = report('ready');
    if (unrefreshed.status === 'ok') delete unrefreshed.finalReview.refreshedRemote;
    expect(issueRemoteRefreshResult(unrefreshed, 10)).toBeNull();
  });

  it('skips observation without a prior Review and otherwise uses the managed collector once', async () => {
    const collectStatus = vi.fn(async () => report('ready'));
    await expect(
      refreshReadyIssueReview({
        workspace: '/fixture/workspace',
        projectRoot: '/fixture/project',
        collectStatus,
        readReview: () => ({ status: 'missing' }),
      }),
    ).resolves.toBeNull();
    expect(collectStatus).not.toHaveBeenCalled();

    const existing = report('ready');
    if (existing.status !== 'ok' || existing.finalReview.read.status !== 'ready') {
      throw new Error('invalid fixture');
    }
    const times = [100, 145];
    await expect(
      refreshReadyIssueReview({
        workspace: '/fixture/workspace',
        projectRoot: '/fixture/project',
        collectStatus,
        readReview: () => existing.finalReview.read,
        monotonicNow: () => times.shift()!,
      }),
    ).resolves.toMatchObject({
      exitCode: 0,
      evidence: { remoteRefreshDurationMs: 45 },
    });
    expect(collectStatus).toHaveBeenCalledOnce();
    expect(collectStatus).toHaveBeenCalledWith('/fixture/workspace', {
      projectRoot: '/fixture/project',
      refreshRemote: true,
    });
  });
});
