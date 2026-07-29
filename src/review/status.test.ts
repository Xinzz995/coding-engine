import { afterEach, describe, expect, it } from 'vitest';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQualityContract } from '../quality/contract.js';
import type { GitHubIssueInfo, GitHubQualityClient } from '../quality/github.js';
import { CODING_X_VERSION } from '../version.js';
import { digest, normalizeText, reviewRoutingDigest } from './common.js';
import { applyReviewerDeepReviewRequest } from './risk.js';
import type { ReviewPreflightContext } from './preflight.js';
import { assessReviewRisk } from './risk.js';
import { REVIEW_RULES_DIGEST } from './rules.js';
import { reviewDecisionsDigest, writeFinalReviewState } from './state.js';
import { collectCurrentReviewStatus } from './status.js';
import {
  REVIEW_RULES_VERSION,
  REVIEW_STATE_SCHEMA_VERSION,
  type FinalReviewState,
  type ReviewRemoteState,
} from './types.js';

const roots: string[] = [];
const originalCodexBinary = process.env.CODING_X_CODEX_BIN;
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  if (originalCodexBinary === undefined) delete process.env.CODING_X_CODEX_BIN;
  else process.env.CODING_X_CODEX_BIN = originalCodexBinary;
});

const STORY_VALIDATION_DIGEST = `sha256:${'c'.repeat(64)}`;
const REVIEW_ROUTING_DIGEST = reviewRoutingDigest(undefined);
const RUNNER_VERSION = 'codex-test';
const readyRemote: ReviewRemoteState = {
  status: 'ready',
  checks: [],
  rulesetErrors: [],
  checkedAt: '2026-07-29T00:00:00.000Z',
};

function fixture(): {
  workspace: string;
  context: ReviewPreflightContext;
  state: FinalReviewState;
} {
  const contractRead = readQualityContract(process.cwd());
  if (contractRead.status !== 'ready')
    throw new Error(`contract unavailable: ${contractRead.status}`);
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  const context: ReviewPreflightContext = {
    root: process.cwd(),
    workspace: join(process.cwd(), '.workspace'),
    branch: 'feature/status-currentness',
    baseSha,
    headSha,
    pullRequest: {
      number: 42,
      headSha,
      baseBranch: 'main',
      baseSha,
      url: 'https://example.test/42',
      title: 'fix: keep status current',
      body: [
        '## 本次目标',
        'current status',
        '## 明确的非目标',
        'no model in CI',
        '## Spec 与验收标准来源',
        'docs/specs/review.md',
        '## 验证方式',
        'tests',
        '## 风险说明',
        'remote state',
      ].join('\n'),
      labels: [],
    },
    baseContract: contractRead.contract,
    baseContractDigest: 'sha256:base-contract',
    changedFiles: ['README.md'],
    files: [{ path: 'README.md', base: 'old', head: 'new' }],
    diff: '-old\n+new\n',
    specs: [{ path: 'docs/specs/review.md', content: '# Review' }],
    engineeringStandards: [{ path: 'AGENTS.md', content: '# Rules' }],
    history: `${headSha}\tfix: keep status current`,
    prSections: {
      本次目标: 'current status',
      明确的非目标: 'no model in CI',
      'Spec 与验收标准来源': 'docs/specs/review.md',
      验证方式: 'tests',
      风险说明: 'remote state',
    },
  };
  const risk = assessReviewRisk(context);
  const state: FinalReviewState = {
    schemaVersion: REVIEW_STATE_SCHEMA_VERSION,
    status: 'passed',
    deliveryStatus: 'ready',
    binding: {
      prNumber: context.pullRequest.number,
      targetBranch: context.pullRequest.baseBranch,
      baseSha,
      headSha,
      prTitleDigest: digest(normalizeText(context.pullRequest.title)),
      prBodyDigest: digest(normalizeText(context.pullRequest.body)),
      specDigest: digest(context.specs),
      engineeringStandardsDigest: digest(context.engineeringStandards),
      qualityContractDigest: context.baseContractDigest,
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewDecisionsDigest: reviewDecisionsDigest(null),
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      codingXVersion: CODING_X_VERSION,
      runner: 'codex',
      model: 'review-model',
      runnerVersion: RUNNER_VERSION,
      reviewRulesVersion: REVIEW_RULES_VERSION,
      reviewRulesDigest: REVIEW_RULES_DIGEST,
      riskDigest: risk.digest,
    },
    risk,
    axes: (['spec', 'engineering'] as const).map((axis) => ({
      axis,
      status: 'passed' as const,
      summary: `${axis} passed`,
      findings: [],
      requestDeepReview: false,
      durationMs: 1,
      attempts: 1,
    })),
    remote: readyRemote,
    round: 1,
    shadow: false,
    startedAt: '2026-07-29T00:00:00.000Z',
    completedAt: '2026-07-29T00:01:00.000Z',
  };
  const workspace = mkdtempSync(join(tmpdir(), 'review-status-'));
  roots.push(workspace);
  writeFinalReviewState(workspace, state);
  return { workspace, context, state };
}

function deferredP1Fixture(): ReturnType<typeof fixture> {
  const result = fixture();
  const finding = {
    id: 'finding-p1-deferred',
    axis: 'engineering' as const,
    severity: 'P1' as const,
    title: '应在期限内治理',
    location: { path: 'src/example.ts', line: 1 },
    ruleSource: 'docs/patterns.md',
    impact: '长期保留会增加维护风险',
    recommendation: '在延期 Issue 到期前完成治理',
    requiresHumanDecision: false,
    prNumber: result.context.pullRequest.number,
    baseSha: result.context.baseSha,
    headSha: result.context.headSha,
    round: 1,
  };
  result.state.axes[1].status = 'failed';
  result.state.axes[1].findings = [finding];
  const raw = JSON.stringify({
    schemaVersion: 1,
    decisions: [
      {
        findingId: finding.id,
        headSha: result.context.headSha,
        action: 'p1-deferred',
        operator: 'maintainer',
        at: '2026-07-29T00:02:00.000Z',
        issue: 90,
      },
    ],
  });
  writeFileSync(join(result.workspace, 'review-decisions.json'), raw);
  result.state.binding.reviewDecisionsDigest = reviewDecisionsDigest(raw);
  writeFinalReviewState(result.workspace, result.state);
  return result;
}

function deferralIssue(state: GitHubIssueInfo['state'] = 'open'): GitHubIssueInfo {
  const expiry = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
  return {
    number: 90,
    state,
    title: '延期治理 P1',
    body: [
      '### 负责人',
      'maintainer',
      '### 原因',
      '需要独立变更完成治理',
      '### 到期日',
      expiry,
      '### 跟进事项',
      '提交后续修复 PR',
    ].join('\n'),
    labels: ['quality-p1-deferral'],
    url: 'https://example.test/issues/90',
    isPullRequest: false,
  };
}

function issueClient(issue: GitHubIssueInfo, calls: { count: number }): GitHubQualityClient {
  return {
    getIssue: () => {
      calls.count += 1;
      return issue;
    },
  } as unknown as GitHubQualityClient;
}

describe('collectCurrentReviewStatus currentness', () => {
  it('marks status stale without executing a Runner located inside the project root', () => {
    const { workspace, context } = fixture();
    const projectRoot = mkdtempSync(join(tmpdir(), 'review-status-project-runner-'));
    roots.push(projectRoot);
    mkdirSync(join(projectRoot, '.coding-x'), { recursive: true });
    writeFileSync(
      join(projectRoot, '.coding-x', 'quality.json'),
      JSON.stringify(context.baseContract),
    );
    const marker = join(projectRoot, 'runner-was-executed');
    const runner = join(projectRoot, process.platform === 'win32' ? 'codex.cmd' : 'codex');
    if (process.platform === 'win32') {
      writeFileSync(runner, `@echo off\r\necho executed>${marker}\r\nexit /b 0\r\n`);
    } else {
      writeFileSync(
        runner,
        `#!/bin/sh\nprintf executed > ${JSON.stringify(marker)}\nprintf 'codex-test\\n'\n`,
      );
      chmodSync(runner, 0o755);
    }
    process.env.CODING_X_CODEX_BIN = runner;

    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot,
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: false,
      preflight: () => ({ status: 'ready', context: { ...context, root: projectRoot } }),
    });

    expect(result.current).toBe(false);
    expect(result.staleReasons.join('；')).toContain('位于不可信项目根内');
    expect(existsSync(marker)).toBe(false);
  });

  it('reconstructs Reviewer-triggered deep risk from persisted axes without going stale', () => {
    const { workspace, context, state } = fixture();
    state.axes[0].requestDeepReview = true;
    state.risk = applyReviewerDeepReviewRequest(state.risk, true);
    state.binding.riskDigest = state.risk.digest;
    state.axes.push({
      axis: 'deep',
      status: 'passed',
      summary: 'deep passed',
      findings: [],
      requestDeepReview: false,
      durationMs: 1,
      attempts: 1,
    });
    writeFinalReviewState(workspace, state);

    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: false,
      preflight: () => ({ status: 'ready', context }),
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(result.current).toBe(true);
    expect(result.staleReasons).toEqual([]);
  });

  it('invalidates a saved Review only when the PRD routing policy changes', () => {
    const { workspace, state } = fixture();
    state.binding.model = 'cli-review-override';
    writeFinalReviewState(workspace, state);
    const unchanged = collectCurrentReviewStatus({
      workspace,
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
    });
    expect(unchanged.current).toBe(true);

    const changed = collectCurrentReviewStatus({
      workspace,
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: reviewRoutingDigest({
        runner: 'codex',
        builder: { low: 'low', medium: 'medium', high: 'high' },
        validator: 'validator',
        escalation: 'escalation',
      }),
    });
    expect(changed.current).toBe(false);
    expect(changed.staleReasons).toContain('PRD 模型路由已变化');
  });

  it('revalidates the Git and PR context on both sides of the remote query', () => {
    const { workspace, context } = fixture();
    let revalidationCalls = 0;
    let remoteCalls = 0;

    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: true,
      preflight: () => ({ status: 'ready', context }),
      revalidate: () => {
        revalidationCalls += 1;
        return revalidationCalls === 1
          ? { ok: true }
          : { ok: false, message: '远端查询期间本地 HEAD 发生变化' };
      },
      remote: () => {
        remoteCalls += 1;
        return readyRemote;
      },
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(remoteCalls).toBe(1);
    expect(revalidationCalls).toBe(2);
    expect(result.current).toBe(false);
    expect(result.staleReasons).toEqual(['远端查询期间本地 HEAD 发生变化']);
    expect(result.refreshedRemote).toEqual(readyRemote);
  });

  it('does not query remote checks when the pre-query revalidation already fails', () => {
    const { workspace, context } = fixture();
    let remoteCalls = 0;

    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: true,
      preflight: () => ({ status: 'ready', context }),
      revalidate: () => ({ ok: false, message: '查询前 PR head 已变化' }),
      remote: () => {
        remoteCalls += 1;
        return readyRemote;
      },
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(remoteCalls).toBe(0);
    expect(result.current).toBe(false);
    expect(result.staleReasons).toEqual(['查询前 PR head 已变化']);
    expect(result.refreshedRemote).toBeUndefined();
  });

  it('marks the saved Review stale when decisions change during the remote query', () => {
    const { workspace, context } = fixture();
    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: true,
      preflight: () => ({ status: 'ready', context }),
      revalidate: () => ({ ok: true }),
      remote: () => {
        writeFileSync(
          join(workspace, 'review-decisions.json'),
          JSON.stringify({
            schemaVersion: 1,
            decisions: [],
          }),
        );
        return readyRemote;
      },
      runnerVersion: () => RUNNER_VERSION,
    });
    expect(result.current).toBe(false);
    expect(result.staleReasons).toContain('Review 裁决记录已变化');
  });

  it('does not return an old green result when another Review invalidates it during the remote query', () => {
    const { workspace, context } = fixture();
    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      localIdentity: () => ({
        storyValidationDigest: STORY_VALIDATION_DIGEST,
        reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      }),
      refreshRemote: true,
      preflight: () => ({ status: 'ready', context }),
      revalidate: () => ({ ok: true }),
      remote: () => {
        rmSync(join(workspace, 'final-review.json'), { force: true });
        return readyRemote;
      },
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(result.current).toBe(false);
    expect(result.staleReasons).toContain('远端查询期间本地最终 Review 状态已变化');
    expect(result.refreshedRemote).toEqual(readyRemote);
  });

  it('re-reads Story receipts and PRD routing after the remote query', () => {
    const { workspace, context } = fixture();
    let changed = false;
    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      localIdentity: () =>
        changed
          ? {
              storyValidationDigest: `sha256:${'d'.repeat(64)}`,
              reviewRoutingDigest: `sha256:${'e'.repeat(64)}`,
            }
          : {
              storyValidationDigest: STORY_VALIDATION_DIGEST,
              reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
            },
      refreshRemote: true,
      preflight: () => ({ status: 'ready', context }),
      revalidate: () => ({ ok: true }),
      remote: () => {
        changed = true;
        return readyRemote;
      },
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(result.current).toBe(false);
    expect(result.staleReasons).toEqual(
      expect.arrayContaining([
        '远端查询期间Story Validator 凭证已变化',
        '远端查询期间PRD 模型路由已变化',
      ]),
    );
  });

  it('does not reuse a P1 deferral without refreshing its Issue', () => {
    const { workspace, context } = deferredP1Fixture();
    const calls = { count: 0 };
    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      client: issueClient(deferralIssue(), calls),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: false,
      preflight: () => ({ status: 'ready', context }),
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(calls.count).toBe(0);
    expect(result.current).toBe(false);
    expect(result.staleReasons).toContain('P1 延期 Issue 尚未重新核验');
  });

  it('keeps a Review current only after its P1 deferral Issue is freshly valid', () => {
    const { workspace, context } = deferredP1Fixture();
    const calls = { count: 0 };
    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      client: issueClient(deferralIssue(), calls),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: true,
      preflight: () => ({ status: 'ready', context }),
      revalidate: () => ({ ok: true }),
      remote: () => readyRemote,
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(calls.count).toBe(1);
    expect(result.current).toBe(true);
    expect(result.staleReasons).toEqual([]);
  });

  it('invalidates a saved Review when its P1 deferral Issue is closed', () => {
    const { workspace, context } = deferredP1Fixture();
    const calls = { count: 0 };
    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      client: issueClient(deferralIssue('closed'), calls),
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: true,
      preflight: () => ({ status: 'ready', context }),
      revalidate: () => ({ ok: true }),
      remote: () => readyRemote,
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(calls.count).toBe(1);
    expect(result.current).toBe(false);
    expect(result.staleReasons).toContain(
      'P1 延期 Issue 已失效：finding-p1-deferred：延期引用必须是开放 Issue',
    );
  });

  it('rechecks local decisions after the P1 Issue query completes', () => {
    const { workspace, context } = deferredP1Fixture();
    const client = {
      getIssue: () => {
        writeFileSync(
          join(workspace, 'review-decisions.json'),
          JSON.stringify({ schemaVersion: 1, decisions: [] }),
        );
        return deferralIssue();
      },
    } as unknown as GitHubQualityClient;
    const result = collectCurrentReviewStatus({
      workspace,
      projectRoot: process.cwd(),
      client,
      storyValidationDigest: STORY_VALIDATION_DIGEST,
      reviewRoutingDigest: REVIEW_ROUTING_DIGEST,
      refreshRemote: true,
      preflight: () => ({ status: 'ready', context }),
      revalidate: () => ({ ok: true }),
      remote: () => readyRemote,
      runnerVersion: () => RUNNER_VERSION,
    });

    expect(result.current).toBe(false);
    expect(result.staleReasons).toContain('Review 裁决记录已变化');
  });
});
