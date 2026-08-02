import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { QualityContract } from '../quality/contract.js';
import { digestQualityContract } from '../quality/contract.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession } from '../workspace-safety/session.js';
import { parseReviewDecisionRequest, recordReviewDecision } from './decision-command.js';
import { digestReviewBinding } from './binding.js';
import { digest } from './common.js';
import type { FinalReviewState, ReviewFinding } from './types.js';

const roots: string[] = [];
const HEAD = 'b'.repeat(40);

function contract(): QualityContract {
  return {
    schemaVersion: 2,
    codingXVersion: '0.34.0',
    repository: { provider: 'github', fullName: 'owner/repo', defaultBranch: 'main' },
    release: { protectedRefs: [], notApplicable: '测试仓库不发布' },
    sources: {
      specs: [{ kind: 'pull-request' }],
      acceptanceCriteria: [{ kind: 'pull-request' }],
      engineeringStandards: ['AGENTS.md'],
    },
    modules: [{ id: 'root', path: '.' }],
    generatedPaths: [],
    localValidation: { prepare: [], allowedPaths: [] },
    checks: {
      test: { notApplicable: 'fixture' },
      build: { notApplicable: 'fixture' },
      static: { notApplicable: 'fixture' },
      security: { notApplicable: 'fixture' },
    },
    risk: { defaultCategories: [], highRiskPaths: [], pathRules: [] },
    github: { jobs: [], requiredChecks: ['quality-gate', 'policy-guard-source'] },
    exceptions: {
      p1: { issueTemplate: '.github/ISSUE_TEMPLATE/quality-p1-deferral.yml', maxDays: 30 },
      policy: { issueTemplate: '.github/ISSUE_TEMPLATE/quality-policy-exception.yml', maxDays: 7 },
    },
  };
}

function finding(overrides: Partial<ReviewFinding> = {}): ReviewFinding {
  return {
    id: 'engineering-P1-example',
    axis: 'engineering',
    severity: 'P1',
    title: 'example',
    location: { path: 'src/example.ts', line: 1 },
    ruleSource: 'AGENTS.md',
    impact: 'impact',
    recommendation: 'fix',
    requiresHumanDecision: false,
    prNumber: 1,
    baseSha: 'a'.repeat(40),
    headSha: HEAD,
    round: 1,
    ...overrides,
  };
}

function reviewState(item = finding()): FinalReviewState {
  const quality = contract();
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: ['src/example.ts'],
    changedModules: ['root'],
  };
  const riskDigest = digest(risk);
  return {
    schemaVersion: 2,
    status: 'failed',
    deliveryStatus: 'findings',
    binding: {
      prNumber: 1,
      targetBranch: 'main',
      baseSha: 'a'.repeat(40),
      headSha: HEAD,
      prTitleDigest: `sha256:${'1'.repeat(64)}`,
      prBodyDigest: `sha256:${'2'.repeat(64)}`,
      specDigest: `sha256:${'3'.repeat(64)}`,
      engineeringStandardsDigest: `sha256:${'4'.repeat(64)}`,
      qualityContractDigest: digestQualityContract(quality),
      validationEnvironmentDigest: `sha256:${'0'.repeat(64)}`,
      codingXVersion: '0.34.0',
      runner: 'codex',
      model: 'model',
      runnerVersion: '1',
      reviewRulesVersion: '1.1.0',
      reviewRulesDigest: `sha256:${'5'.repeat(64)}`,
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
        status: 'failed',
        summary: 'found',
        findings: [item],
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
    completedAt: '2026-07-31T00:00:01.000Z',
  };
}

async function fixture(item = finding()) {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-decision-'));
  roots.push(root);
  const workspace = join(root, '.workspace');
  await bootstrapWorkspace({ workspacePath: workspace });
  const review = reviewState(item);
  writeFileSync(join(workspace, 'final-review.json'), `${JSON.stringify(review, null, 2)}\n`);
  const lease = await acquireWorkspaceLease({
    workspacePath: workspace,
    command: 'review-decision',
  });
  return {
    root,
    workspace,
    session: createWorkspaceSession(lease),
    contract: contract(),
    binding: review.binding,
    readBinding: () => review.binding,
  };
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('recordReviewDecision', () => {
  it('issues head and time itself and preserves prior decisions', async () => {
    const ctx = await fixture(finding({ severity: 'P2', id: 'engineering-P2-example' }));
    writeFileSync(
      join(ctx.workspace, 'review-decisions.json'),
      JSON.stringify({
        schemaVersion: 1,
        decisions: [
          {
            findingId: 'old',
            headSha: 'a'.repeat(40),
            reviewBindingDigest: digestReviewBinding(ctx.binding),
            action: 'fix-requested',
            operator: 'maintainer',
            at: '2026-07-30T00:00:00.000Z',
          },
        ],
      }),
    );
    await recordReviewDecision({
      ...ctx,
      request: {
        schemaVersion: 1,
        findingId: 'engineering-P2-example',
        action: 'acknowledged',
        operator: 'maintainer',
      },
      readHead: () => HEAD,
      now: () => new Date('2026-07-31T01:02:03.000Z'),
    });
    const saved = JSON.parse(readFileSync(join(ctx.workspace, 'review-decisions.json'), 'utf8'));
    expect(saved.decisions).toHaveLength(2);
    expect(saved.decisions[1]).toEqual({
      findingId: 'engineering-P2-example',
      headSha: HEAD,
      reviewBindingDigest: digestReviewBinding(ctx.binding),
      action: 'acknowledged',
      operator: 'maintainer',
      at: '2026-07-31T01:02:03.000Z',
    });
    await ctx.session.close();
  });

  it('fails with zero writes when HEAD changes immediately before commit', async () => {
    const ctx = await fixture();
    let head = HEAD;
    await expect(
      recordReviewDecision({
        ...ctx,
        request: {
          schemaVersion: 1,
          findingId: 'engineering-P1-example',
          action: 'counterevidence',
          operator: 'maintainer',
          evidence: '这是可以独立复核、包含具体事实且长度充分的反证材料。',
        },
        readHead: () => head,
        beforeCommit: () => {
          head = 'c'.repeat(40);
        },
      }),
    ).rejects.toThrow('Git HEAD 发生变化');
    expect(() => readFileSync(join(ctx.workspace, 'review-decisions.json'))).toThrow();
    await ctx.session.close();
  });

  it.each([
    ['PR body', 'prBodyDigest', `sha256:${'9'.repeat(64)}`],
    ['base SHA', 'baseSha', 'c'.repeat(40)],
  ] as const)(
    'fails with zero writes when %s changes immediately before commit',
    async (_label, field, value) => {
      const ctx = await fixture();
      let current = ctx.binding;
      await expect(
        recordReviewDecision({
          ...ctx,
          request: {
            schemaVersion: 1,
            findingId: 'engineering-P1-example',
            action: 'counterevidence',
            operator: 'maintainer',
            evidence: '这是可以独立复核、包含具体事实且长度充分的反证材料。',
          },
          readHead: () => HEAD,
          readBinding: () => current,
          beforeCommit: () => {
            current = { ...current, [field]: value };
          },
        }),
      ).rejects.toThrow('Final Review binding 已变化');
      expect(() => readFileSync(join(ctx.workspace, 'review-decisions.json'))).toThrow();
      await ctx.session.close();
    },
  );

  it('rejects blocking findings disguised as acknowledgement', async () => {
    const ctx = await fixture();
    await expect(
      recordReviewDecision({
        ...ctx,
        request: {
          schemaVersion: 1,
          findingId: 'engineering-P1-example',
          action: 'acknowledged',
          operator: 'maintainer',
        },
        readHead: () => HEAD,
      }),
    ).rejects.toThrow('只适用于');
    await ctx.session.close();
  });

  it('validates P1 deferral against the configured GitHub issue policy', async () => {
    const ctx = await fixture();
    const client = {
      getIssue: () => ({
        number: 12,
        state: 'open',
        title: 'defer',
        body: [
          '### 负责人',
          'maintainer',
          '### 原因',
          '需要兼容窗口',
          '### 到期日',
          '2026-08-10',
          '### 跟进事项',
          'issue-13',
        ].join('\n'),
        labels: ['quality-p1-deferral'],
        url: 'https://example.test/issues/12',
        isPullRequest: false,
      }),
    } as unknown as GitHubQualityClient;
    await recordReviewDecision({
      ...ctx,
      client,
      request: {
        schemaVersion: 1,
        findingId: 'engineering-P1-example',
        action: 'p1-deferred',
        operator: 'maintainer',
        issue: 12,
      },
      readHead: () => HEAD,
      now: () => new Date('2026-07-31T00:00:00.000Z'),
    });
    const saved = JSON.parse(readFileSync(join(ctx.workspace, 'review-decisions.json'), 'utf8'));
    expect(saved.decisions[0].issue).toBe(12);
    await ctx.session.close();
  });
});

describe('parseReviewDecisionRequest', () => {
  it('rejects caller-controlled head, time, or output paths', () => {
    expect(() =>
      parseReviewDecisionRequest({
        schemaVersion: 1,
        findingId: 'x',
        action: 'fix-requested',
        operator: 'maintainer',
        headSha: HEAD,
      }),
    ).toThrow('未知字段 headSha');
  });
});
