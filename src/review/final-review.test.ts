import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import { runFinalReview } from './final-review.js';
import type { ReviewPreflightContext } from './preflight.js';
import { RUNNER_TOOL_POLICY_VERSION } from './runner.js';
import { readFinalReviewState } from './state.js';
import type { ReviewAxis, ReviewRemoteState } from './types.js';

const roots: string[] = [];
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function contract(): QualityContract {
  const read = readQualityContract(process.cwd());
  if (read.status !== 'ready') throw new Error(`contract unavailable: ${read.status}`);
  return structuredClone(read.contract);
}

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'final-review-test-'));
  roots.push(root);
  return root;
}

function context(over: Partial<ReviewPreflightContext> = {}): ReviewPreflightContext {
  const baseContract = contract();
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  return {
    root: process.cwd(), branch: 'feature/review', baseSha, headSha,
    pullRequest: {
      number: 42, headSha, baseBranch: 'main', baseSha,
      url: 'https://example.test/42', title: 'feat: review', labels: [],
      body: [
        '## 本次目标', 'review', '## 明确的非目标', 'github ai',
        '## Spec 与验收标准来源', 'docs/specs/review.md',
        '## 验证方式', 'tests', '## 风险说明', 'local only',
      ].join('\n'),
    },
    baseContract,
    baseContractDigest: 'sha256:base',
    changedFiles: ['README.md'],
    files: [{ path: 'README.md', base: 'old', head: 'new' }],
    diff: '-old\n+new\n',
    specs: [{ path: 'docs/specs/review.md', content: '# Review' }],
    engineeringStandards: [{ path: 'AGENTS.md', content: '# Rules' }],
    history: `${headSha}\tfeat: review`,
    prSections: {
      '本次目标': 'review', '明确的非目标': 'github ai',
      'Spec 与验收标准来源': 'docs/specs/review.md', '验证方式': 'tests',
      '风险说明': 'local only',
    },
    ...over,
  };
}

const gate = async () => ({
  ok: true, failure: null, total: 1, ran: 1, ms: 1, skipped: [],
});
const probe = async (options: { runner: 'codex'; model: string; runnerVersion?: string }) => ({
  ok: true,
  runner: options.runner,
  model: options.model,
  runnerVersion: options.runnerVersion ?? 'codex-test',
  policyVersion: RUNNER_TOOL_POLICY_VERSION,
  durationMs: 1,
  failures: [],
});
const readyRemote: ReviewRemoteState = {
  status: 'ready', checks: [], rulesetErrors: [], checkedAt: '2026-07-26T00:00:00.000Z',
};

function output(axis: ReviewAxis, mode: 'passed' | 'p1' | 'unverifiable' | 'p2' = 'passed') {
  if (mode === 'unverifiable') return {
    runner: 'codex' as const, model: 'review-model', runnerVersion: 'codex-test',
    durationMs: 1, attempts: 1,
    output: {
      status: 'unverifiable' as const, summary: `${axis} incomplete`, requestDeepReview: false,
      unverifiableReason: 'missing evidence', findings: [],
    },
  };
  const finding = mode === 'passed' ? [] : [{
    severity: mode === 'p1' ? 'P1' as const : 'P2' as const,
    title: `${axis} issue`, location: { path: 'README.md', line: 1 },
    ruleSource: 'fixture rule', impact: 'fixture impact', recommendation: 'fixture fix',
    requiresHumanDecision: false,
  }];
  return {
    runner: 'codex' as const, model: 'review-model', runnerVersion: 'codex-test',
    durationMs: 1, attempts: 1,
    output: {
      status: mode === 'p1' ? 'failed' as const : 'passed' as const,
      summary: `${axis} complete`, requestDeepReview: false, findings: finding,
    },
  };
}

function options(ws: string, ctx: ReviewPreflightContext) {
  return {
    root: process.cwd(), workspace: ws, currentContract: ctx.baseContract,
    runner: 'codex' as const, model: 'review-model', runnerVersion: 'codex-test',
    preflight: () => ({ status: 'ready' as const, context: ctx }),
    gate, probe: probe as typeof import('./runner.js').probeRunnerIsolation,
    remote: () => readyRemote,
  };
}

describe('runFinalReview', () => {
  it('requires an explicit, bindable review model before any model call', async () => {
    const ctx = context();
    const result = await runFinalReview({
      ...options(workspace(), ctx), model: undefined,
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('明确模型');
  });

  it('runs spec and engineering separately and skips deep review for ordinary docs', async () => {
    const ws = workspace();
    const calls: ReviewAxis[] = [];
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => {
        calls.push(request.axis);
        const input = JSON.parse(request.reviewPackage.input) as Record<string, unknown>;
        expect(input).toMatchObject({
          verificationBoundary: {
            mechanicalChecks: {
              status: 'passed',
              headSha: context().headSha,
              scope: 'all-current-platform-applicable-contract-checks',
            },
            allReviewAxes: { owner: 'engine' },
            githubDelivery: { owner: 'engine' },
          },
        });
        return output(request.axis, request.axis === 'engineering' ? 'p2' : 'passed');
      },
    });
    expect(result.exitCode).toBe(0);
    expect(calls).toEqual(['spec', 'engineering']);
    expect(result.state).toMatchObject({ status: 'passed', deliveryStatus: 'ready' });
  });

  it('runs risk-triggered deep review and blocks P1 until human handling', async () => {
    const ws = workspace();
    const ctx = context({
      changedFiles: ['src/engine/loop.ts'],
      files: [{ path: 'src/engine/loop.ts', base: 'old', head: 'spawn retry timeout' }],
      diff: '+spawn retry timeout',
    });
    const calls: ReviewAxis[] = [];
    const result = await runFinalReview({
      ...options(ws, ctx),
      axisRunner: async (request) => {
        calls.push(request.axis);
        return output(request.axis, request.axis === 'deep' ? 'p1' : 'passed');
      },
    });
    expect(calls).toEqual(['spec', 'engineering', 'deep']);
    expect(result.exitCode).toBe(4);
    expect(result.state?.axes[2].findings[0]).toMatchObject({
      severity: 'P1', headSha: ctx.headSha, prNumber: 42, round: 1,
    });
  });

  it('treats model uncertainty as unverifiable even when other axes pass', async () => {
    const ws = workspace();
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => output(
        request.axis,
        request.axis === 'spec' ? 'unverifiable' : 'passed',
      ),
    });
    expect(result.exitCode).toBe(5);
    expect(result.state?.status).toBe('unverifiable');
  });

  it('keeps the three axes independent when one model call fails', async () => {
    const calls: ReviewAxis[] = [];
    const result = await runFinalReview({
      ...options(workspace(), context()),
      axisRunner: async (request) => {
        calls.push(request.axis);
        if (request.axis === 'spec') throw new Error('spec service unavailable');
        return output(request.axis);
      },
    });
    expect(calls).toEqual(['spec', 'engineering']);
    expect(result.exitCode).toBe(5);
    expect(result.state?.axes).toEqual(expect.arrayContaining([
      expect.objectContaining({ axis: 'spec', status: 'unverifiable' }),
      expect.objectContaining({ axis: 'engineering', status: 'passed' }),
    ]));
  });

  it('invalidates all model results when the bound commit or PR changes during Review', async () => {
    const result = await runFinalReview({
      ...options(workspace(), context()),
      axisRunner: async (request) => output(request.axis),
      revalidate: () => ({ ok: false, message: '评审期间 PR 正文发生变化' }),
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('本轮 Review 已作废');
    expect(result.state).toBeUndefined();
  });

  it('returns unverifiable instead of throwing when complete context exceeds the model limit', async () => {
    const ctx = context({ diff: 'x'.repeat(3 * 1024 * 1024) });
    const result = await runFinalReview({
      ...options(workspace(), ctx),
      axisRunner: async (request) => output(request.axis),
    });
    expect(result.exitCode).toBe(5);
    expect(result.state?.axes).toEqual(expect.arrayContaining([
      expect.objectContaining({ status: 'unverifiable', attempts: 0 }),
    ]));
  });

  it('separates local pass from pending GitHub delivery and from shadow completion', async () => {
    const ctx = context();
    const pending = await runFinalReview({
      ...options(workspace(), ctx),
      axisRunner: async (request) => output(request.axis),
      remote: () => ({ ...readyRemote, status: 'pending' }),
    });
    expect(pending.exitCode).toBe(6);
    expect(pending.state).toMatchObject({ status: 'passed', deliveryStatus: 'remote-pending' });

    const shadow = await runFinalReview({
      ...options(workspace(), ctx), shadow: true,
      axisRunner: async (request) => output(request.axis),
      remote: () => ({ ...readyRemote, status: 'pending' }),
    });
    expect(shadow.exitCode).toBe(7);
    expect(shadow.state).toMatchObject({
      deliveryStatus: 'shadow',
      remote: { status: 'pending' },
    });
  });

  it('invalidates an old green result before a new attempt can fail', async () => {
    const ws = workspace();
    const ctx = context();
    const first = await runFinalReview({
      ...options(ws, ctx),
      axisRunner: async (request) => output(request.axis),
    });
    expect(first.exitCode).toBe(0);
    expect(readFinalReviewState(ws).status).toBe('ready');

    const second = await runFinalReview({
      ...options(ws, ctx),
      gate: async () => ({
        ok: false,
        failure: { command: 'fixture check', exitCode: 1, timedOut: false, outputTail: '' },
        total: 1,
        ran: 1,
        ms: 1,
        skipped: [],
      }),
      axisRunner: async (request) => output(request.axis),
    });
    expect(second.exitCode).toBe(1);
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('accepts concrete counterevidence only for the current head', async () => {
    const ws = workspace();
    const ctx = context();
    const p1 = output('engineering', 'p1').output.findings[0];
    // Stable finding ID is computed by the engine; first run exposes it for explicit user decision.
    const first = await runFinalReview({
      ...options(ws, ctx),
      axisRunner: async (request) => output(request.axis, request.axis === 'engineering' ? 'p1' : 'passed'),
    });
    expect(first.exitCode).toBe(4);
    const findingId = first.state!.axes.flatMap((axis) => axis.findings)[0].id;
    writeFileSync(join(ws, 'review-decisions.json'), JSON.stringify({
      schemaVersion: 1,
      decisions: [{
        findingId, headSha: ctx.headSha, action: 'counterevidence', operator: 'maintainer',
        at: '2026-07-26T00:00:00.000Z',
        evidence: '该路径只用于测试夹具，生产入口有独立失败传播断言。',
      }],
    }));
    expect(p1.severity).toBe('P1');
    const second = await runFinalReview({
      ...options(ws, ctx),
      axisRunner: async (request) => output(request.axis, request.axis === 'engineering' ? 'p1' : 'passed'),
    });
    expect(second.exitCode).toBe(0);
    expect(second.state?.round).toBe(2);
  });
});
