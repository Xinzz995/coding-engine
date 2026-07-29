import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import { runFinalReview } from './final-review.js';
import { reviewRoutingDigest } from './common.js';
import type { ReviewPreflightContext } from './preflight.js';
import { freezeReviewRunner, RUNNER_TOOL_POLICY_VERSION } from './runner.js';
import { freezeReviewDecisions, readFinalReviewState } from './state.js';
import type { ReviewAxis, ReviewRemoteState } from './types.js';

const roots: string[] = [];
const originalCodexBinary = process.env.CODING_X_CODEX_BIN;
afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
  if (originalCodexBinary === undefined) delete process.env.CODING_X_CODEX_BIN;
  else process.env.CODING_X_CODEX_BIN = originalCodexBinary;
});

function executable(path: string, source: string): void {
  writeFileSync(path, source, 'utf8');
  chmodSync(path, 0o755);
}

function nativeRunner(path: string): void {
  if (process.platform === 'win32') {
    copyFileSync(process.execPath, path);
  } else {
    const source = `${path}.c`;
    writeFileSync(source, `
#include <stdio.h>
#include <string.h>
int main(int argc, char **argv) {
  for (int i = 1; i < argc; i += 1) {
    if (strcmp(argv[i], "--version") == 0) {
      puts("native-review-runner 1.0.0");
      return 0;
    }
  }
  return 0;
}
`);
    execFileSync('cc', [source, '-o', path]);
  }
  chmodSync(path, 0o755);
}

function fakeCodexVersionSource(version: string, marker?: string): string {
  return `#!/usr/bin/env node
${marker ? `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'executed\\n');` : ''}
if (process.argv.includes('--version')) {
  console.log(${JSON.stringify(version)});
  process.exit(0);
}
process.exit(8);
`;
}

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
    root: process.cwd(),
    workspace: join(process.cwd(), '.workspace'),
    branch: 'feature/review',
    baseSha,
    headSha,
    pullRequest: {
      number: 42,
      headSha,
      baseBranch: 'main',
      baseSha,
      url: 'https://example.test/42',
      title: 'feat: review',
      labels: [],
      body: [
        '## 本次目标',
        'review',
        '## 明确的非目标',
        'github ai',
        '## Spec 与验收标准来源',
        'docs/specs/review.md',
        '## 验证方式',
        'tests',
        '## 风险说明',
        'local only',
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
      本次目标: 'review',
      明确的非目标: 'github ai',
      'Spec 与验收标准来源': 'docs/specs/review.md',
      验证方式: 'tests',
      风险说明: 'local only',
    },
    ...over,
  };
}

const gate = async () => ({
  ok: true,
  failure: null,
  total: 1,
  ran: 1,
  ms: 1,
  skipped: [],
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
  status: 'ready',
  checks: [],
  rulesetErrors: [],
  checkedAt: '2026-07-26T00:00:00.000Z',
};
const STORY_VALIDATION_DIGEST = `sha256:${'c'.repeat(64)}`;

function output(
  axis: ReviewAxis,
  mode: 'passed' | 'p1' | 'unverifiable' | 'p2' = 'passed',
  requestDeepReview = false,
) {
  if (mode === 'unverifiable')
    return {
      runner: 'codex' as const,
      model: 'review-model',
      runnerVersion: 'codex-test',
      durationMs: 1,
      attempts: 1,
      output: {
        status: 'unverifiable' as const,
        summary: `${axis} incomplete`,
        requestDeepReview,
        unverifiableReason: 'missing evidence',
        findings: [],
      },
    };
  const finding =
    mode === 'passed'
      ? []
      : [
          {
            severity: mode === 'p1' ? ('P1' as const) : ('P2' as const),
            title: `${axis} issue`,
            location: { path: 'README.md', line: 1 },
            ruleSource: 'fixture rule',
            impact: 'fixture impact',
            recommendation: 'fixture fix',
            requiresHumanDecision: false,
          },
        ];
  return {
    runner: 'codex' as const,
    model: 'review-model',
    runnerVersion: 'codex-test',
    durationMs: 1,
    attempts: 1,
    output: {
      status: mode === 'p1' ? ('failed' as const) : ('passed' as const),
      summary: `${axis} complete`,
      requestDeepReview,
      findings: finding,
    },
  };
}

function options(ws: string, ctx: ReviewPreflightContext) {
  return {
    root: process.cwd(),
    workspace: ws,
    currentContract: ctx.baseContract,
    runner: 'codex' as const,
    model: 'review-model',
    runnerVersion: 'codex-test',
    unsafeSkipReviewerExecutableFreezeForTests: true as const,
    preflight: () => ({ status: 'ready' as const, context: ctx }),
    gate,
    probe: probe as typeof import('./runner.js').probeRunnerIsolation,
    axisRunner: async (request: Parameters<NonNullable<
      Parameters<typeof runFinalReview>[0]['axisRunner']
    >>[0]) => output(request.axis),
    remote: () => readyRemote,
    validateStoryReceipts: () => ({ ok: true as const, digest: STORY_VALIDATION_DIGEST }),
    reviewDecisions: freezeReviewDecisions(ws),
    reviewRoutingDigest: reviewRoutingDigest(undefined),
  };
}

describe('runFinalReview', () => {
  it('requires an explicit, bindable review model before any model call', async () => {
    const ctx = context();
    const result = await runFinalReview({
      ...options(workspace(), ctx),
      model: undefined,
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('明确模型');
  });

  it('requires a Story receipt validator before the gate and any model work', async () => {
    const base = options(workspace(), context());
    const { validateStoryReceipts: _validation, ...withoutValidation } = base;
    let gateCalls = 0;
    let probeCalls = 0;
    let axisCalls = 0;
    const result = await runFinalReview({
      ...withoutValidation,
      gate: async () => {
        gateCalls += 1;
        return gate();
      },
      probe: (async (request) => {
        probeCalls += 1;
        return probe({ ...request, runner: 'codex' });
      }) as typeof import('./runner.js').probeRunnerIsolation,
      axisRunner: async (request) => {
        axisCalls += 1;
        return output(request.axis);
      },
    });
    expect(result).toMatchObject({ exitCode: 5 });
    expect(result.message).toContain('Story Validator 凭证核对');
    expect(gateCalls).toBe(0);
    expect(probeCalls).toBe(0);
    expect(axisCalls).toBe(0);
  });

  it('fails closed before model work when Story receipts are already invalid', async () => {
    let gateCalls = 0;
    let probeCalls = 0;
    let axisCalls = 0;
    const result = await runFinalReview({
      ...options(workspace(), context()),
      validateStoryReceipts: () => ({ ok: false, message: 'US-001 凭证绑定了旧 HEAD' }),
      gate: async () => {
        gateCalls += 1;
        return gate();
      },
      probe: (async (request) => {
        probeCalls += 1;
        return probe({ ...request, runner: 'codex' });
      }) as typeof import('./runner.js').probeRunnerIsolation,
      axisRunner: async (request) => {
        axisCalls += 1;
        return output(request.axis);
      },
    });
    expect(result).toMatchObject({ exitCode: 5 });
    expect(result.message).toContain('US-001 凭证绑定了旧 HEAD');
    expect(gateCalls).toBe(0);
    expect(probeCalls).toBe(0);
    expect(axisCalls).toBe(0);
  });

  it('rejects a mechanical gate that replaces the frozen Story receipt identity', async () => {
    let validationCalls = 0;
    let probeCalls = 0;
    let axisCalls = 0;
    const result = await runFinalReview({
      ...options(workspace(), context()),
      validateStoryReceipts: () => {
        validationCalls += 1;
        return {
          ok: true,
          digest: validationCalls === 1 ? STORY_VALIDATION_DIGEST : `sha256:${'d'.repeat(64)}`,
        };
      },
      probe: (async (request) => {
        probeCalls += 1;
        return probe({ ...request, runner: 'codex' });
      }) as typeof import('./runner.js').probeRunnerIsolation,
      axisRunner: async (request) => {
        axisCalls += 1;
        return output(request.axis);
      },
    });

    expect(validationCalls).toBe(2);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('最终机械检查后');
    expect(result.message).toContain('凭证身份发生变化');
    expect(probeCalls).toBe(0);
    expect(axisCalls).toBe(0);
  });

  it.runIf(process.platform !== 'win32')('does not start any model work when the mechanical gate replaces the frozen Reviewer', async () => {
    const ws = workspace();
    const ctx = context();
    const runnerPath = join(ws, 'trusted-codex');
    const changedRunnerMarker = join(ws, 'changed-runner-was-executed');
    nativeRunner(runnerPath);
    process.env.CODING_X_CODEX_BIN = runnerPath;
    const frozenRunner = freezeReviewRunner('codex', { projectRoot: ctx.root });
    const base = options(ws, ctx);
    const {
      unsafeSkipReviewerExecutableFreezeForTests: _testBypass,
      runnerVersion: _untrustedVersion,
      ...formal
    } = base;
    let probeCalls = 0;
    let axisCalls = 0;

    const result = await runFinalReview({
      ...formal,
      frozenRunner,
      gate: async () => {
        executable(
          runnerPath,
          fakeCodexVersionSource('codex-test 9.9.9', changedRunnerMarker),
        );
        return gate();
      },
      probe: (async (request) => {
        probeCalls += 1;
        return probe({ ...request, runner: 'codex' });
      }) as typeof import('./runner.js').probeRunnerIsolation,
      axisRunner: async (request) => {
        axisCalls += 1;
        return output(request.axis);
      },
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('最终机械检查后');
    expect(result.message).toContain('Reviewer 已失效');
    expect(probeCalls).toBe(0);
    expect(axisCalls).toBe(0);
    expect(existsSync(changedRunnerMarker)).toBe(false);
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('rejects worktree changes left by a successful mechanical gate before model work', async () => {
    const ws = workspace();
    let gateFinished = false;
    let probeCalls = 0;
    let axisCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      gate: async () => {
        gateFinished = true;
        return gate();
      },
      revalidate: () =>
        gateFinished
          ? { ok: false, message: '评审期间工作树出现未允许改动：src/a.ts' }
          : { ok: true },
      probe: (async (request) => {
        probeCalls += 1;
        return probe({ ...request, runner: 'codex' });
      }) as typeof import('./runner.js').probeRunnerIsolation,
      axisRunner: async (request) => {
        axisCalls += 1;
        return output(request.axis);
      },
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('src/a.ts');
    expect(result.message).toContain('最终机械检查后');
    expect(probeCalls).toBe(0);
    expect(axisCalls).toBe(0);
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('restores and rejects Review decisions changed by the final mechanical gate', async () => {
    const ws = workspace();
    let axisCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      gate: async () => {
        writeFileSync(
          join(ws, 'review-decisions.json'),
          JSON.stringify({
            schemaVersion: 1,
            decisions: [],
          }),
        );
        return gate();
      },
      axisRunner: async (request) => {
        axisCalls += 1;
        return output(request.axis);
      },
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('机械检查期间');
    expect(axisCalls).toBe(0);
    expect(() => readFileSync(join(ws, 'review-decisions.json'), 'utf8')).toThrow();
  });

  it('removes a forged Final Review and restores the full state snapshot after the final gate', async () => {
    const ws = workspace();
    const statePath = join(ws, 'state.json');
    const expectedState = '{"US-001":{"passes":true,"notes":"safe"}}\n';
    writeFileSync(statePath, expectedState);
    let axisCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      gate: async () => {
        writeFileSync(statePath, '{"US-001":{"passes":true,"blocked":true,"notes":"forged"}}\n');
        writeFileSync(join(ws, 'final-review.json'), JSON.stringify({ schemaVersion: 2 }));
        return {
          ok: false,
          failure: { command: 'forging gate', exitCode: 1, timedOut: false, outputTail: '' },
          total: 1,
          ran: 1,
          ms: 1,
          skipped: [],
        };
      },
      axisRunner: async (request) => {
        axisCalls += 1;
        return output(request.axis);
      },
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('引擎独占状态');
    expect(axisCalls).toBe(0);
    expect(readFileSync(statePath, 'utf8')).toBe(expectedState);
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('restores and rejects Review decisions changed while model axes are running', async () => {
    const ws = workspace();
    let changed = false;
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => {
        if (!changed) {
          changed = true;
          writeFileSync(
            join(ws, 'review-decisions.json'),
            JSON.stringify({
              schemaVersion: 1,
              decisions: [],
            }),
          );
        }
        return output(request.axis);
      },
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('写入最终结果前');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
    expect(() => readFileSync(join(ws, 'review-decisions.json'), 'utf8')).toThrow();
  });

  it('removes a Final Review forged while model axes are running', async () => {
    const ws = workspace();
    let changed = false;
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => {
        if (!changed) {
          changed = true;
          writeFileSync(join(ws, 'final-review.json'), JSON.stringify({ schemaVersion: 2 }));
        }
        return output(request.axis);
      },
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('模型评审期间');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
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
    expect(result.state).toMatchObject({
      schemaVersion: 2,
      status: 'passed',
      deliveryStatus: 'ready',
      binding: {
        storyValidationDigest: STORY_VALIDATION_DIGEST,
        reviewDecisionsDigest: freezeReviewDecisions(ws).digest,
        reviewRoutingDigest: reviewRoutingDigest(undefined),
      },
    });
  });

  it('persists Reviewer-triggered deep risk as a reproducible ready state', async () => {
    const ws = workspace();
    const calls: ReviewAxis[] = [];
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => {
        calls.push(request.axis);
        return output(request.axis, 'passed', request.axis === 'spec');
      },
    });

    expect(calls).toEqual(['spec', 'engineering', 'deep']);
    expect(result.exitCode).toBe(0);
    expect(result.state?.risk).toMatchObject({
      triggered: true,
      categories: expect.arrayContaining(['reviewer-request']),
      reasons: expect.arrayContaining(['Spec 或工程 Reviewer 主动升级为深度结构评审']),
    });
    expect(readFinalReviewState(ws).status).toBe('ready');
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
      severity: 'P1',
      headSha: ctx.headSha,
      prNumber: 42,
      round: 1,
    });
  });

  it('treats model uncertainty as unverifiable even when other axes pass', async () => {
    const ws = workspace();
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) =>
        output(request.axis, request.axis === 'spec' ? 'unverifiable' : 'passed'),
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
    expect(result.state?.axes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ axis: 'spec', status: 'unverifiable' }),
        expect.objectContaining({ axis: 'engineering', status: 'passed' }),
      ]),
    );
  });

  it('invalidates all model results when the bound commit or PR changes during Review', async () => {
    const calls: ReviewAxis[] = [];
    let revalidationCalls = 0;
    const result = await runFinalReview({
      ...options(workspace(), context()),
      axisRunner: async (request) => {
        calls.push(request.axis);
        return output(request.axis);
      },
      revalidate: () => {
        revalidationCalls += 1;
        return revalidationCalls === 1
          ? { ok: true }
          : { ok: false, message: '评审期间 PR 正文发生变化' };
      },
    });
    expect(calls).toEqual(['spec', 'engineering']);
    expect(revalidationCalls).toBe(2);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('本轮 Review 已作废');
    expect(result.state).toBeUndefined();
  });

  it('invalidates completed axes when Story receipts become invalid during Review', async () => {
    const calls: ReviewAxis[] = [];
    let validationCalls = 0;
    const result = await runFinalReview({
      ...options(workspace(), context()),
      validateStoryReceipts: () => {
        validationCalls += 1;
        return validationCalls <= 2
          ? { ok: true, digest: STORY_VALIDATION_DIGEST }
          : { ok: false, message: 'US-001 凭证在评审期间失效' };
      },
      axisRunner: async (request) => {
        calls.push(request.axis);
        return output(request.axis);
      },
    });
    expect(calls).toEqual(['spec', 'engineering']);
    expect(validationCalls).toBe(3);
    expect(result).toMatchObject({ exitCode: 5 });
    expect(result.message).toContain('US-001 凭证在评审期间失效');
    expect(result.state).toBeUndefined();
  });

  it('invalidates completed axes when the Story receipt digest changes during Review', async () => {
    const calls: ReviewAxis[] = [];
    let validationCalls = 0;
    const result = await runFinalReview({
      ...options(workspace(), context()),
      validateStoryReceipts: () => ({
        ok: true,
        digest: validationCalls++ < 2 ? STORY_VALIDATION_DIGEST : `sha256:${'d'.repeat(64)}`,
      }),
      axisRunner: async (request) => {
        calls.push(request.axis);
        return output(request.axis);
      },
    });
    expect(calls).toEqual(['spec', 'engineering']);
    expect(validationCalls).toBe(3);
    expect(result).toMatchObject({ exitCode: 5 });
    expect(result.message).toContain('凭证身份发生变化');
    expect(result.state).toBeUndefined();
  });

  it('revalidates PR identity again after remote queries and before writing the result', async () => {
    const ws = workspace();
    let revalidationCalls = 0;
    let remoteCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => output(request.axis),
      remote: () => {
        remoteCalls += 1;
        return readyRemote;
      },
      revalidate: () => {
        revalidationCalls += 1;
        return revalidationCalls <= 2
          ? { ok: true }
          : { ok: false, message: '远端查询期间 PR head 发生变化' };
      },
    });

    expect(remoteCalls).toBe(1);
    expect(revalidationCalls).toBe(3);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('写入最终结果前');
    expect(readFinalReviewState(ws).status).toBe('missing');
  });

  it('does not persist an isolation-failure result after its PR identity becomes stale', async () => {
    const ws = workspace();
    let revalidationCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      probe: async (request) => ({
        ok: false,
        runner: request.runner,
        model: request.model,
        runnerVersion: request.runnerVersion ?? 'codex-test',
        policyVersion: RUNNER_TOOL_POLICY_VERSION,
        durationMs: 1,
        failures: ['fixture isolation failure'],
      }),
      revalidate: () => {
        revalidationCalls += 1;
        return revalidationCalls === 1
          ? { ok: true }
          : { ok: false, message: '隔离失败后的远端查询期间 PR 已变化' };
      },
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('写入前已失效');
    expect(readFinalReviewState(ws).status).toBe('missing');
  });

  it('revalidates Story receipts again after remote queries and before writing the result', async () => {
    const ws = workspace();
    let validationCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => output(request.axis),
      validateStoryReceipts: () => {
        validationCalls += 1;
        return validationCalls < 4
          ? { ok: true, digest: STORY_VALIDATION_DIGEST }
          : { ok: false, message: 'US-001 在远端查询期间失效' };
      },
    });

    expect(validationCalls).toBe(4);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('写入最终结果前');
    expect(readFinalReviewState(ws).status).toBe('missing');
  });

  it('deletes a just-written result when Story receipts change in the final persistence window', async () => {
    const ws = workspace();
    let validationCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => output(request.axis),
      validateStoryReceipts: () => {
        validationCalls += 1;
        return validationCalls < 5
          ? { ok: true, digest: STORY_VALIDATION_DIGEST }
          : { ok: false, message: 'US-001 在结果写入后失效' };
      },
    });

    expect(validationCalls).toBe(5);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('最终结果写入后');
    expect(readFinalReviewState(ws).status).toBe('missing');
  });

  it('deletes a just-written result when its file changes before return', async () => {
    const ws = workspace();
    let revalidationCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => output(request.axis),
      revalidate: () => {
        revalidationCalls += 1;
        if (revalidationCalls === 4) {
          writeFileSync(join(ws, 'final-review.json'), JSON.stringify({ schemaVersion: 1 }));
        }
        return { ok: true };
      },
    });

    expect(revalidationCalls).toBe(4);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('最终结果写入后发生变化');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('deletes a just-written result when a final identity callback throws', async () => {
    const ws = workspace();
    let revalidationCalls = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => output(request.axis),
      revalidate: () => {
        revalidationCalls += 1;
        if (revalidationCalls === 4) throw new Error('fixture callback crashed after write');
        return { ok: true };
      },
    });

    expect(revalidationCalls).toBe(4);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('fixture callback crashed after write');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('returns unverifiable instead of throwing when complete context exceeds the model limit', async () => {
    const ctx = context({ diff: 'x'.repeat(3 * 1024 * 1024) });
    const result = await runFinalReview({
      ...options(workspace(), ctx),
      axisRunner: async (request) => output(request.axis),
    });
    expect(result.exitCode).toBe(5);
    expect(result.state?.axes).toEqual(
      expect.arrayContaining([expect.objectContaining({ status: 'unverifiable', attempts: 0 })]),
    );
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
      ...options(workspace(), ctx),
      shadow: true,
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
      axisRunner: async (request) =>
        output(request.axis, request.axis === 'engineering' ? 'p1' : 'passed'),
    });
    expect(first.exitCode).toBe(4);
    const findingId = first.state!.axes.flatMap((axis) => axis.findings)[0].id;
    writeFileSync(
      join(ws, 'review-decisions.json'),
      JSON.stringify({
        schemaVersion: 1,
        decisions: [
          {
            findingId,
            headSha: ctx.headSha,
            action: 'counterevidence',
            operator: 'maintainer',
            at: '2026-07-26T00:00:00.000Z',
            evidence: '该路径只用于测试夹具，生产入口有独立失败传播断言。',
          },
        ],
      }),
    );
    expect(p1.severity).toBe('P1');
    const second = await runFinalReview({
      ...options(ws, ctx),
      axisRunner: async (request) =>
        output(request.axis, request.axis === 'engineering' ? 'p1' : 'passed'),
    });
    expect(second.exitCode).toBe(0);
    expect(second.state?.round).toBe(2);
  });
});
