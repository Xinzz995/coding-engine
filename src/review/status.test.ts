import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { QualityContract } from '../quality/contract.js';
import { validationEnvironmentDigest } from '../quality/validation-environment.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { GITHUB_ACTIONS_APP_ID } from '../quality/github.js';
import { buildManagedRulesetPayload } from '../quality/ruleset.js';
import { renderStatusReport, type StatusReport } from '../status/status.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { createReviewBinding } from './binding.js';
import { digest } from './common.js';
import type { ReviewPreflightContext } from './preflight.js';
import { applyReviewerRequestedDeepReview, assessReviewRisk } from './risk.js';
import type { readRunnerVersion } from './runner.js';
import { collectCurrentReviewStatus, runnerVersionStaleReason } from './status.js';
import { observeCurrentReviewRunnerVersion } from './runner-version-observation.js';
import type { FinalReviewState, ReviewAxisResult } from './types.js';

const roots: string[] = [];
const STORY_VALIDATION_DIGEST = `sha256:${'c'.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeReadyReview(workspace: string): void {
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: ['src/demo.ts'],
    changedModules: ['root'],
  };
  const riskDigest = digest(risk);
  writeFileSync(
    join(workspace, 'final-review.json'),
    `${JSON.stringify(
      {
        schemaVersion: 2,
        status: 'passed',
        deliveryStatus: 'ready',
        binding: {
          prNumber: 1,
          targetBranch: 'main',
          baseSha: 'a'.repeat(40),
          headSha: 'b'.repeat(40),
          prTitleDigest: 'title',
          prBodyDigest: 'body',
          specDigest: 'spec',
          engineeringStandardsDigest: 'standards',
          qualityContractDigest: 'contract',
          validationEnvironmentDigest: `sha256:${'0'.repeat(64)}`,
          storyValidationDigest: STORY_VALIDATION_DIGEST,
          codingXVersion: '0.34.0',
          runner: 'codex',
          model: 'review-model',
          runnerVersion: 'codex 1.2.3',
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
          checkedAt: '2026-07-31T00:00:00.000Z',
        },
        round: 1,
        shadow: false,
        startedAt: '2026-07-31T00:00:00.000Z',
        completedAt: '2026-07-31T00:01:00.000Z',
      },
      null,
      2,
    )}\n`,
  );
}

function session(workspacePath: string): WorkspaceSession {
  return { writer: { workspacePath } } as WorkspaceSession;
}

function reviewContext(): ReviewPreflightContext {
  const baseContract = {
    repository: { provider: 'github', fullName: 'owner/repo', defaultBranch: 'main' },
    github: { requiredChecks: ['quality-gate'], requiredCodeScanning: [] },
    release: { protectedRefs: [] },
    modules: [{ id: 'root', path: '.' }],
    generatedPaths: [],
    risk: { defaultCategories: [], highRiskPaths: [], pathRules: [] },
  } as unknown as QualityContract;
  return {
    root: '/project',
    branch: 'feature/review',
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    pullRequest: {
      number: 7,
      headSha: 'b'.repeat(40),
      baseBranch: 'main',
      baseSha: 'a'.repeat(40),
      url: 'https://example.test/pull/7',
      title: 'feat: review',
      body: 'complete intent',
      labels: [],
    },
    baseContract,
    baseContractDigest: 'sha256:contract',
    changedFiles: ['docs/demo.md'],
    files: [{ path: 'docs/demo.md', base: 'old', head: 'new' }],
    diff: '-old\n+new\n',
    specs: [{ path: 'docs/spec.md', content: '# Spec' }],
    engineeringStandards: [{ path: 'AGENTS.md', content: '# Rules' }],
    history: `${'b'.repeat(40)}\tfeat: review`,
    prSections: {
      本次目标: 'review',
      明确的非目标: 'none',
      'Spec 与验收标准来源': 'docs/spec.md',
      验证方式: 'tests',
      风险说明: 'low',
    },
  };
}

function writeBoundReview(
  workspace: string,
  context: ReviewPreflightContext,
  requestDeepReview = false,
): void {
  const primaryAxes: ReviewAxisResult[] = [
    {
      axis: 'spec',
      status: 'passed',
      summary: 'ok',
      findings: [],
      requestDeepReview,
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
  ];
  const risk = applyReviewerRequestedDeepReview(assessReviewRisk(context), primaryAxes);
  const axes = risk.triggered
    ? [
        ...primaryAxes,
        {
          axis: 'deep' as const,
          status: 'passed' as const,
          summary: 'ok',
          findings: [],
          requestDeepReview: false,
          durationMs: 1,
          attempts: 1,
        },
      ]
    : primaryAxes;
  const state: FinalReviewState = {
    schemaVersion: 2,
    status: 'passed',
    deliveryStatus: 'ready',
    binding: createReviewBinding({
      context,
      risk,
      codingXVersion: 'test-version',
      runner: 'codex',
      model: 'review-model',
      runnerVersion: 'codex 1.2.3',
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      validationEnvironmentDigest: validationEnvironmentDigest({
        contract: context.baseContract,
        head: context.headSha,
      }),
    }),
    risk,
    axes,
    remote: {
      status: 'ready',
      checks: [],
      rulesetErrors: [],
      checkedAt: '2026-07-31T00:00:00.000Z',
    },
    round: 1,
    shadow: false,
    startedAt: '2026-07-31T00:00:00.000Z',
    completedAt: '2026-07-31T00:01:00.000Z',
  };
  writeFileSync(join(workspace, 'final-review.json'), `${JSON.stringify(state, null, 2)}\n`);
}

describe('Runner version currentness observation', () => {
  it('fails closed when the managed observation is absent, fails, or reports another version', () => {
    const binding = { runner: 'codex' as const, runnerVersion: 'codex 1.2.3' };
    expect(runnerVersionStaleReason(binding, undefined)).toContain('未经过受控只读观察');
    expect(
      runnerVersionStaleReason(binding, {
        status: 'unverifiable',
        runner: 'codex',
        message: '版本核对超时',
      }),
    ).toContain('版本核对超时');
    expect(
      runnerVersionStaleReason(binding, {
        status: 'ready',
        runner: 'codex',
        version: 'codex 2.0.0',
      }),
    ).toBe('Runner 版本已变化');
    expect(
      runnerVersionStaleReason(binding, {
        status: 'ready',
        runner: 'codex',
        version: 'codex 1.2.3',
      }),
    ).toBeNull();
  });

  it('uses the supervised version reader in a transient safety domain outside the project', async () => {
    const projectRoot = temporaryDirectory('review-status-project-');
    const workspace = join(projectRoot, '.workspace');
    mkdirSync(workspace);
    writeReadyReview(workspace);
    const safetyWorkspace = temporaryDirectory('review-status-safety-');
    const readVersion = vi.fn(
      async (_options: Parameters<typeof readRunnerVersion>[0]) => 'codex 1.2.3',
    );

    await expect(
      observeCurrentReviewRunnerVersion({
        workspace,
        projectRoot,
        session: session(safetyWorkspace),
        readVersion,
      }),
    ).resolves.toEqual({ status: 'ready', runner: 'codex', version: 'codex 1.2.3' });
    expect(readVersion).toHaveBeenCalledOnce();
    expect(readVersion.mock.calls[0][0]).toMatchObject({ runner: 'codex' });
  });

  it('does not launch a Runner when the safety domain could write inside the project', async () => {
    const projectRoot = temporaryDirectory('review-status-project-boundary-');
    const workspace = join(projectRoot, '.workspace');
    const unsafeSafetyWorkspace = join(projectRoot, '.status-safety');
    mkdirSync(workspace);
    mkdirSync(unsafeSafetyWorkspace);
    writeReadyReview(workspace);
    const readVersion = vi.fn(
      async (_options: Parameters<typeof readRunnerVersion>[0]) => 'codex 1.2.3',
    );

    const observation = await observeCurrentReviewRunnerVersion({
      workspace,
      projectRoot,
      session: session(unsafeSafetyWorkspace),
      readVersion,
    });

    expect(observation).toMatchObject({ status: 'unverifiable' });
    expect(readVersion).not.toHaveBeenCalled();
  });
});

describe('collectCurrentReviewStatus currentness binding', () => {
  it('旧 Review 可读取但会失效，当前凭证集合摘要变化也会失效', () => {
    const workspace = temporaryDirectory('review-status-story-binding-');
    const context = reviewContext();
    writeBoundReview(workspace, context);
    const reviewPath = join(workspace, 'final-review.json');
    const legacy = JSON.parse(readFileSync(reviewPath, 'utf8')) as {
      schemaVersion: number;
      binding: {
        validationEnvironmentDigest?: string;
        storyValidationDigest?: string;
      };
    };
    legacy.schemaVersion = 1;
    delete legacy.binding.validationEnvironmentDigest;
    delete legacy.binding.storyValidationDigest;
    writeFileSync(reviewPath, JSON.stringify(legacy));

    const baseOptions = {
      workspace,
      projectRoot: '/project',
      codingXVersion: 'test-version',
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      runnerVersionObservation: {
        status: 'ready' as const,
        runner: 'codex' as const,
        version: 'codex 1.2.3',
      },
      preflight: () => ({ status: 'ready' as const, context }),
    };
    expect(collectCurrentReviewStatus(baseOptions)).toMatchObject({
      current: false,
      staleReasons: ['旧 Final Review schema 已失效'],
    });

    writeBoundReview(workspace, context);
    expect(
      collectCurrentReviewStatus({
        ...baseOptions,
        storyValidationDigest: `sha256:${'d'.repeat(64)}`,
      }),
    ).toMatchObject({
      current: false,
      staleReasons: ['Story 验收凭证集合 已变化'],
    });
  });

  it('fails closed without a project root or supervised Runner observation', () => {
    const workspace = temporaryDirectory('review-status-currentness-');
    const context = reviewContext();
    writeBoundReview(workspace, context);

    const missingRoot = collectCurrentReviewStatus({ workspace });
    expect(missingRoot.current).toBe(false);
    expect(missingRoot.staleReasons).toContain('缺少项目根目录，无法核对最终 Review 当前性');

    const missingObservation = collectCurrentReviewStatus({
      workspace,
      projectRoot: '/project',
      codingXVersion: 'test-version',
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      preflight: () => ({ status: 'ready', context }),
    });
    expect(missingObservation.current).toBe(false);
    expect(missingObservation.staleReasons).toContain('Runner 版本未经过受控只读观察');
  });

  it('invalidates a saved Review after the observed Runner version changes', () => {
    const workspace = temporaryDirectory('review-status-version-change-');
    const context = reviewContext();
    writeBoundReview(workspace, context);

    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: '/project',
      codingXVersion: 'test-version',
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      runnerVersionObservation: { status: 'ready', runner: 'codex', version: 'codex 2.0.0' },
      preflight: () => ({ status: 'ready', context }),
    });

    expect(result.current).toBe(false);
    expect(result.staleReasons).toContain('Runner 版本已变化');
  });

  it('rebuilds reviewer-request escalation from saved primary axes without false staleness', () => {
    const workspace = temporaryDirectory('review-status-reviewer-risk-');
    const context = reviewContext();
    writeBoundReview(workspace, context, true);

    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: '/project',
      codingXVersion: 'test-version',
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      runnerVersionObservation: { status: 'ready', runner: 'codex', version: 'codex 1.2.3' },
      preflight: () => ({ status: 'ready', context }),
    });

    expect(result).toMatchObject({ current: true, staleReasons: [] });
  });

  it('invalidates and discards refreshed remote state when PR intent changes during remote reads', () => {
    const workspace = temporaryDirectory('review-status-remote-race-');
    const context = reviewContext();
    writeBoundReview(workspace, context);
    let currentBody = context.pullRequest.body;
    const events: string[] = [];
    const ruleset = {
      id: 1,
      ...buildManagedRulesetPayload(null, [
        { context: 'quality-gate', integration_id: GITHUB_ACTIONS_APP_ID },
      ]),
    };
    const client = {
      listRulesets: () => [ruleset],
      listCheckRuns: () => {
        events.push('remote-checks');
        currentBody = 'changed while checks were queried';
        return [
          {
            id: 1,
            name: 'quality-gate',
            headSha: context.headSha,
            status: 'completed',
            conclusion: 'success',
            app: { id: GITHUB_ACTIONS_APP_ID, slug: 'github-actions', name: 'GitHub Actions' },
          },
        ];
      },
    } as unknown as GitHubQualityClient;

    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: '/project',
      client,
      refreshRemote: true,
      codingXVersion: 'test-version',
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      runnerVersionObservation: { status: 'ready', runner: 'codex', version: 'codex 1.2.3' },
      preflight: () => ({ status: 'ready', context }),
      revalidate: (_current, _workspace, _client) => {
        events.push('revalidate');
        return currentBody === context.pullRequest.body
          ? { ok: true }
          : { ok: false, message: '评审期间 PR 标题或正文发生变化' };
      },
    });

    expect(events).toEqual(['remote-checks', 'revalidate']);
    expect(result).toMatchObject({
      current: false,
      staleReasons: ['评审期间 PR 标题或正文发生变化'],
    });
    expect(result).not.toHaveProperty('refreshedRemote');

    const rendered = renderStatusReport({
      status: 'ok',
      prd: { project: 'demo', branchName: 'feature/review' },
      stories: [
        {
          id: 'US-001',
          title: 'done',
          priority: 1,
          passes: true,
          validated: true,
          notes: '',
          retryCount: 0,
          blocked: false,
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
        gitHead: context.headSha,
        current: true,
        invalidStoryIds: [],
        configurationError: null,
      },
      finalReview: result,
    } as unknown as StatusReport);
    expect(rendered.exitCode).toBe(6);
  });
});
