import { execFileSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import type { GitHubReviewReadClient } from '../quality/github.js';
import type { WorkspaceSession, WorkspaceWriteData } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { createManagedProcessTestSession } from '../engine/managed-process-test-support.js';
import { digestReviewBinding } from './binding.js';
import { runFinalReview } from './final-review.js';
import type { ReviewPreflightContext } from './preflight.js';
import type { ManagedReviewObservation } from './managed-observation.js';
import { RUNNER_TOOL_POLICY_VERSION } from './runner.js';
import { readFinalReviewState } from './state.js';
import { REVIEW_STATE_FILE, type ReviewAxis, type ReviewRemoteState } from './types.js';

const roots: string[] = [];
function makeFixtureRemovable(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    chmodSync(path, 0o600);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeFixtureRemovable(join(path, name));
}

afterEach(() => {
  while (roots.length > 0) {
    const root = roots.pop()!;
    makeFixtureRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
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

function gitProject(files: Record<string, string>): { root: string; head: string } {
  const root = workspace();
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'final review test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'final-review@example.invalid'], { cwd: root });
  for (const [path, contents] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), contents);
  }
  execFileSync('git', ['add', '.'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: root });
  return {
    root,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
  };
}

function session(
  workspacePath: string,
  afterWrite?: (relativePath: string) => void,
  beforeRemove?: (relativePath: string) => void,
): WorkspaceSession {
  let state: 'open' | 'isolated' = 'open';
  return {
    get state() {
      return state;
    },
    retainLeaseForIsolation: () => {
      state = 'isolated';
    },
    writer: {
      workspacePath,
      writeFile: async (relativePath: string, data: WorkspaceWriteData) => {
        writeFileSync(join(workspacePath, relativePath), data);
        afterWrite?.(relativePath);
      },
      removeFile: async (relativePath: string) => {
        beforeRemove?.(relativePath);
        rmSync(join(workspacePath, relativePath), { force: true });
      },
    },
  } as unknown as WorkspaceSession;
}

function context(over: Partial<ReviewPreflightContext> = {}): ReviewPreflightContext {
  const baseContract = contract();
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  return {
    root: process.cwd(),
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
const STORY_OBSERVATION_TOKEN = `sha256:${'d'.repeat(64)}`;
const CHANGED_STORY_OBSERVATION_TOKEN = `sha256:${'e'.repeat(64)}`;

function output(axis: ReviewAxis, mode: 'passed' | 'p1' | 'unverifiable' | 'p2' = 'passed') {
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
        requestDeepReview: false,
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
      requestDeepReview: false,
      findings: finding,
    },
  };
}

function options(ws: string, ctx: ReviewPreflightContext) {
  return {
    root: process.cwd(),
    workspace: ws,
    session: session(ws),
    currentContract: ctx.baseContract,
    runner: 'codex' as const,
    model: 'review-model',
    runnerVersion: 'codex-test',
    preflight: () => ({ status: 'ready' as const, context: ctx }),
    gate,
    probe: probe as typeof import('./runner.js').probeRunnerIsolation,
    remote: () => readyRemote,
    revalidate: () => ({ ok: true as const }),
    legacyAuthorityVerificationForTests: true,
    storyValidationDigest: STORY_VALIDATION_DIGEST,
    observeStoryValidation: () => ({
      status: 'ready' as const,
      digest: STORY_VALIDATION_DIGEST,
      observationToken: STORY_OBSERVATION_TOKEN,
    }),
  };
}

describe('runFinalReview', () => {
  it('accepts a proven alias for the session workspace before checking Review inputs', async () => {
    const ws = workspace();
    const aliasParent = workspace();
    const alias = join(aliasParent, 'workspace-alias');
    symlinkSync(ws, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const result = await runFinalReview({
      ...options(alias, context()),
      session: session(ws),
      model: undefined,
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('明确模型');
  });

  it('requires an explicit, bindable review model before any model call', async () => {
    const ctx = context();
    const result = await runFinalReview({
      ...options(workspace(), ctx),
      model: undefined,
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('明确模型');
  });

  it('runs production mechanical checks in a clean checkout and removes it afterwards', async () => {
    const project = gitProject({
      '.gitignore': '.env\n.claude/\nnode_modules/\n',
      'source.txt': 'tracked\n',
    });
    writeFileSync(join(project.root, '.env'), 'FINAL_REVIEW_SECRET=1\n');
    mkdirSync(join(project.root, '.claude'));
    writeFileSync(join(project.root, '.claude', 'settings.json'), '{}\n');
    mkdirSync(join(project.root, 'node_modules'));
    writeFileSync(join(project.root, 'node_modules', 'stale.js'), 'stale\n');
    const markerRoot = workspace();
    const marker = join(markerRoot, 'mechanical-cwd.json');
    const projectContract = contract();
    const platform =
      process.platform === 'win32'
        ? (['windows'] as const)
        : process.platform === 'darwin'
          ? (['macos'] as const)
          : (['linux'] as const);
    projectContract.generatedPaths = [];
    projectContract.localValidation = { prepare: [], allowedPaths: [] };
    projectContract.checks = {
      test: {
        checks: [
          {
            id: 'clean-cwd',
            module: 'root',
            command: {
              executable: process.execPath,
              args: [
                '-e',
                [
                  "const fs = require('node:fs')",
                  "const hidden = ['.env', '.claude', 'node_modules'].filter((path) => fs.existsSync(path))",
                  `fs.writeFileSync(${JSON.stringify(marker)}, JSON.stringify({ cwd: process.cwd(), hidden }))`,
                  'if (hidden.length > 0) process.exit(9)',
                ].join(';'),
              ],
              cwd: '.',
              platforms: [...platform],
              timeoutMs: 5_000,
            },
          },
        ],
      },
      build: { notApplicable: 'fixture' },
      static: { notApplicable: 'fixture' },
      security: { notApplicable: 'fixture' },
    };
    const base = context();
    const ctx = context({
      root: project.root,
      baseSha: project.head,
      headSha: project.head,
      baseContract: projectContract,
      pullRequest: {
        ...base.pullRequest,
        baseSha: project.head,
        headSha: project.head,
      },
      history: `${project.head}\tfixture`,
    });
    const managed = await createManagedProcessTestSession();
    try {
      const result = await runFinalReview({
        ...options(managed.workspacePath, ctx),
        root: project.root,
        workspace: managed.workspacePath,
        session: managed.session,
        gate: undefined,
        axisRunner: async (request) => output(request.axis),
      });
      expect(result.exitCode).toBe(0);
      const observed = JSON.parse(readFileSync(marker, 'utf8')) as {
        cwd: string;
        hidden: string[];
      };
      expect(relative(project.root, observed.cwd).startsWith('..')).toBe(true);
      expect(observed.hidden).toEqual([]);
      expect(existsSync(observed.cwd)).toBe(false);
    } finally {
      await managed.close();
    }
  }, 60_000);

  it('runs spec and engineering separately and skips deep review for ordinary docs', async () => {
    const ws = workspace();
    const calls: ReviewAxis[] = [];
    const base = options(ws, context());
    const result = await runFinalReview({
      ...base,
      gate: async (_contract, _root, managed) => {
        expect(managed).toEqual({ session: base.session, kind: 'final-review' });
        return await gate();
      },
      axisRunner: async (request) => {
        expect(request.session).toBe(base.session);
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

  it('stops remaining axes and records an unverifiable state when a review package is polluted', async () => {
    const calls: ReviewAxis[] = [];
    let retainedPath = '';
    const ws = workspace();
    const modelControlledSummary = 'MODEL_MUST_NOT_LEAK_SOURCE_OR_PROMPT';
    const attackerControlledName = 'PROMPT_FRAGMENT_SECRET';
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => {
        calls.push(request.axis);
        retainedPath = request.reviewPackage.root;
        roots.push(retainedPath);
        chmodSync(retainedPath, 0o755);
        writeFileSync(join(retainedPath, attackerControlledName), 'pollution\n');
        const completed = output(request.axis);
        return {
          ...completed,
          output: { ...completed.output, summary: modelControlledSummary },
        };
      },
    });

    expect(calls).toEqual(['spec']);
    expect(result.exitCode).toBe(5);
    expect(result.state).toMatchObject({
      status: 'unverifiable',
      deliveryStatus: 'unverifiable',
      remote: { status: 'invalid' },
      axes: [
        {
          axis: 'spec',
          status: 'unverifiable',
          findings: [],
          requestDeepReview: false,
        },
        { axis: 'engineering', status: 'unverifiable', attempts: 0 },
      ],
    });
    expect(result.state?.axes[0].summary).toContain('临时审查包已保留');
    expect(result.state?.axes[0].summary).toContain(retainedPath);
    expect(result.state?.axes[0].summary).not.toContain(modelControlledSummary);
    expect(result.state?.axes[0].summary).not.toContain(attackerControlledName);
    expect(result.message).not.toContain(attackerControlledName);
    expect(existsSync(retainedPath)).toBe(true);
    expect(readFinalReviewState(ws)).toMatchObject({
      status: 'ready',
      state: { status: 'unverifiable', deliveryStatus: 'unverifiable' },
    });
  });

  it('preserves the model failure and cleanup failure in one retained diagnostic', async () => {
    let retainedPath = '';
    const result = await runFinalReview({
      ...options(workspace(), context()),
      axisRunner: async (request) => {
        retainedPath = request.reviewPackage.root;
        roots.push(retainedPath);
        chmodSync(retainedPath, 0o755);
        writeFileSync(join(retainedPath, 'unexpected-file'), 'pollution\n');
        throw new Error('fixture model service failure');
      },
    });

    expect(result.exitCode).toBe(5);
    expect(result.state?.axes[0].summary).toContain('fixture model service failure');
    expect(result.state?.axes[0].summary).toContain('临时审查包已保留');
    expect(result.state?.axes[0].summary).toContain(retainedPath);
    expect(existsSync(retainedPath)).toBe(true);
  });

  it('returns exit 5 without attempting a state write after the workspace session is isolated', async () => {
    const ws = workspace();
    const base = options(ws, context());
    const result = await runFinalReview({
      ...base,
      axisRunner: async () => {
        Object.defineProperty(base.session, 'state', { value: 'isolated', configurable: true });
        throw new WorkspaceSafetyError('isolated', 'fixture session isolated');
      },
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('session 处于 isolated');
    expect(result.state).toBeUndefined();
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
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

  it('keeps all ten high-risk currentness checkpoints while batching each into one authority snapshot', async () => {
    const phases: Array<{ phase: string; includeDecisions: boolean }> = [];
    const ctx = context({
      changedFiles: ['src/review/final-review.ts'],
      files: [{ path: 'src/review/final-review.ts', base: 'old', head: 'new timeout handling' }],
      diff: '+new timeout handling',
    });
    const result = await runFinalReview({
      ...options(workspace(), ctx),
      axisRunner: async (request) => output(request.axis),
      authoritySnapshotVerifier: async (request) => {
        phases.push(request);
        return null;
      },
    });

    expect(result.exitCode).toBe(0);
    expect(phases).toEqual([
      { phase: 'Runner 隔离探测前', includeDecisions: false },
      { phase: 'Runner 隔离探测结束后', includeDecisions: false },
      { phase: 'spec Review 结束后', includeDecisions: false },
      { phase: 'engineering Review 结束后', includeDecisions: false },
      { phase: 'deep Review 结束后', includeDecisions: false },
      { phase: '评审结束时', includeDecisions: true },
      { phase: 'Review 裁决与延期 Issue 核验后', includeDecisions: true },
      { phase: '远端核验后', includeDecisions: true },
      { phase: '最终 Review 状态落盘前', includeDecisions: true },
      { phase: '最终 Review 状态落盘后', includeDecisions: true },
    ]);
  });

  it('stops before engineering when the authoritative Story inputs change during spec Review', async () => {
    const ws = workspace();
    const calls: ReviewAxis[] = [];
    let observationToken = STORY_OBSERVATION_TOKEN;
    const result = await runFinalReview({
      ...options(ws, context()),
      observeStoryValidation: () => ({
        status: 'ready' as const,
        digest: STORY_VALIDATION_DIGEST,
        observationToken,
      }),
      axisRunner: async (request) => {
        calls.push(request.axis);
        if (request.axis === 'spec') observationToken = CHANGED_STORY_OBSERVATION_TOKEN;
        return output(request.axis);
      },
    });

    expect(calls).toEqual(['spec']);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('spec Review 结束后');
    expect(result.message).toContain('Story 验收权威输入发生变化');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('stops before deep Review and persistence when authoritative Story inputs change during engineering Review', async () => {
    const ws = workspace();
    const ctx = context({
      changedFiles: ['src/engine/loop.ts'],
      files: [{ path: 'src/engine/loop.ts', base: 'old', head: 'spawn retry timeout' }],
      diff: '+spawn retry timeout',
    });
    const calls: ReviewAxis[] = [];
    let observationToken = STORY_OBSERVATION_TOKEN;
    const result = await runFinalReview({
      ...options(ws, ctx),
      observeStoryValidation: () => ({
        status: 'ready' as const,
        digest: STORY_VALIDATION_DIGEST,
        observationToken,
      }),
      axisRunner: async (request) => {
        calls.push(request.axis);
        if (request.axis === 'engineering') {
          observationToken = CHANGED_STORY_OBSERVATION_TOKEN;
        }
        return output(request.axis);
      },
    });

    expect(calls).toEqual(['spec', 'engineering']);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('engineering Review 结束后');
    expect(result.message).toContain('Story 验收权威输入发生变化');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('does not call a Reviewer model when the Story receipt set changes after mechanical checks', async () => {
    const ws = workspace();
    let modelCalls = 0;
    let observations = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      observeStoryValidation: () => {
        observations += 1;
        return {
          status: 'ready' as const,
          digest: observations === 1 ? STORY_VALIDATION_DIGEST : `sha256:${'f'.repeat(64)}`,
          observationToken: STORY_OBSERVATION_TOKEN,
        };
      },
      axisRunner: async (request) => {
        modelCalls += 1;
        return output(request.axis);
      },
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('机械检查结束后、模型调用前');
    expect(observations).toBe(2);
    expect(modelCalls).toBe(0);
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('discards all model results when the Story receipt set changes after the axes finish', async () => {
    const ws = workspace();
    let observations = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      observeStoryValidation: () => {
        observations += 1;
        return {
          status: 'ready' as const,
          digest: observations < 7 ? STORY_VALIDATION_DIGEST : `sha256:${'f'.repeat(64)}`,
          observationToken: STORY_OBSERVATION_TOKEN,
        };
      },
      axisRunner: async (request) => output(request.axis),
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('Reviewer 模型结束后');
    expect(observations).toBe(7);
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('refuses to persist a green Review when the Story receipt set changes after remote checks', async () => {
    const ws = workspace();
    let observations = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      observeStoryValidation: () => {
        observations += 1;
        return {
          status: 'ready' as const,
          digest: observations < 11 ? STORY_VALIDATION_DIGEST : `sha256:${'f'.repeat(64)}`,
          observationToken: STORY_OBSERVATION_TOKEN,
        };
      },
      axisRunner: async (request) => output(request.axis),
    });
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('最终 Review 状态落盘前');
    expect(observations).toBe(11);
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('invalidates the Review when authoritative Story inputs change while a deferral Issue is queried', async () => {
    const ws = workspace();
    const ctx = context();
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
            reviewBindingDigest: digestReviewBinding(first.state!.binding),
            action: 'p1-deferred',
            operator: 'maintainer',
            at: new Date().toISOString(),
            issue: 12,
          },
        ],
      }),
    );

    let issueCalls = 0;
    let observationToken = STORY_OBSERVATION_TOKEN;
    const expiry = new Date();
    expiry.setUTCDate(expiry.getUTCDate() + 10);
    const client = {
      getIssue: async () => {
        issueCalls += 1;
        observationToken = CHANGED_STORY_OBSERVATION_TOKEN;
        return {
          number: 12,
          state: 'open' as const,
          title: 'defer',
          body: [
            '### 负责人',
            'maintainer',
            '### 原因',
            '需要兼容窗口',
            '### 到期日',
            expiry.toISOString().slice(0, 10),
            '### 跟进事项',
            'issue-13',
          ].join('\n'),
          labels: ['quality-p1-deferral'],
          url: 'https://example.test/issues/12',
          isPullRequest: false,
        };
      },
    } as unknown as GitHubReviewReadClient;
    const second = await runFinalReview({
      ...options(ws, ctx),
      client,
      observeStoryValidation: () => ({
        status: 'ready' as const,
        digest: STORY_VALIDATION_DIGEST,
        observationToken,
      }),
      axisRunner: async (request) =>
        output(request.axis, request.axis === 'engineering' ? 'p1' : 'passed'),
    });

    expect(issueCalls).toBe(1);
    expect(second.exitCode).toBe(5);
    expect(second.message).toContain('Review 裁决与延期 Issue 核验后');
    expect(second.message).toContain('Story 验收权威输入发生变化');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('revokes a newly persisted state when authoritative Story inputs change after its write', async () => {
    const ws = workspace();
    let observationToken = STORY_OBSERVATION_TOKEN;
    const controlledSession = session(ws, (relativePath) => {
      if (relativePath === REVIEW_STATE_FILE) {
        observationToken = CHANGED_STORY_OBSERVATION_TOKEN;
      }
    });
    const result = await runFinalReview({
      ...options(ws, context()),
      session: controlledSession,
      observeStoryValidation: () => ({
        status: 'ready' as const,
        digest: STORY_VALIDATION_DIGEST,
        observationToken,
      }),
      axisRunner: async (request) => output(request.axis),
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('最终 Review 状态落盘后');
    expect(result.message).toContain('刚写入的状态已撤销');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('isolates the workspace when a changed post-write result cannot be revoked', async () => {
    const ws = workspace();
    let observationToken = STORY_OBSERVATION_TOKEN;
    let stateWritten = false;
    const controlledSession = session(
      ws,
      (relativePath) => {
        if (relativePath === REVIEW_STATE_FILE) {
          stateWritten = true;
          observationToken = CHANGED_STORY_OBSERVATION_TOKEN;
        }
      },
      (relativePath) => {
        if (stateWritten && relativePath === REVIEW_STATE_FILE) {
          throw new Error('fixture revoke failure');
        }
      },
    );
    const result = await runFinalReview({
      ...options(ws, context()),
      session: controlledSession,
      observeStoryValidation: () => ({
        status: 'ready' as const,
        digest: STORY_VALIDATION_DIGEST,
        observationToken,
      }),
      axisRunner: async (request) => output(request.axis),
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('刚写入的状态无法安全撤销');
    expect(result.message).toContain('workspace 已隔离');
    expect(controlledSession.state).toBe('isolated');
    expect(readFinalReviewState(ws).status).toBe('ready');
  });

  it('invalidates model results when the PR changes during the final remote query', async () => {
    const ws = workspace();
    let changed = false;
    let revalidations = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => output(request.axis),
      remote: async () => {
        changed = true;
        return readyRemote;
      },
      revalidate: () => {
        revalidations += 1;
        return changed
          ? { ok: false as const, message: '远端查询期间 PR 正文发生变化' }
          : { ok: true as const };
      },
    });
    expect(revalidations).toBe(7);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('远端核验后');
    expect(result.message).toContain('远端查询期间 PR 正文发生变化');
    expect(result.message).toContain('本轮 Review 已作废');
    expect(result.state).toBeUndefined();
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('checks PR identity after the closing Runner version observation', async () => {
    const ws = workspace();
    let changed = false;
    let runnerReads = 0;
    const result = await runFinalReview({
      ...options(ws, context()),
      runnerVersion: undefined,
      runnerVersionReader: async () => {
        runnerReads += 1;
        if (runnerReads === 2) changed = true;
        return 'codex-test';
      },
      revalidate: () =>
        changed
          ? { ok: false as const, message: 'Runner 版本核对期间 PR 正文发生变化' }
          : { ok: true as const },
      axisRunner: async (request) => output(request.axis),
    });

    expect(runnerReads).toBe(2);
    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('Runner 版本核对期间 PR 正文发生变化');
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
  });

  it('refuses to sign a result when a passing quality check rewrites tracked source', async () => {
    const root = workspace();
    const ws = join(root, '.workspace');
    mkdirSync(ws);
    execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
    execFileSync('git', ['config', 'user.email', 'review@test.local'], { cwd: root });
    execFileSync('git', ['config', 'user.name', 'review-test'], { cwd: root });
    writeFileSync(join(root, 'tracked.ts'), 'export const value = 1;\n');
    execFileSync('git', ['add', 'tracked.ts'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', 'base'], { cwd: root });

    const ctx = context({ root });
    const observation = {
      git: async (args: readonly string[]) => {
        if (args[0] === 'fetch') return '';
        if (args[0] === 'symbolic-ref') return ctx.branch;
        if (args[0] === 'rev-parse' && args[1] === 'HEAD') return ctx.headSha;
        if (args[0] === 'rev-parse') return ctx.baseSha;
        if (args[0] === 'status') {
          return execFileSync('git', [...args], { cwd: root, encoding: 'utf8' });
        }
        throw new Error(`unexpected git observation: ${args.join(' ')}`);
      },
      github: {
        discoverRepository: async () => ({
          fullName: ctx.baseContract.repository.fullName,
          defaultBranch: ctx.baseContract.repository.defaultBranch,
          isPrivate: false,
        }),
        findOpenPullRequest: async () => ctx.pullRequest,
      },
    } as unknown as ManagedReviewObservation;
    const result = await runFinalReview({
      ...options(ws, ctx),
      root,
      gate: async () => {
        writeFileSync(join(root, 'tracked.ts'), 'export const value = 2;\n');
        return await gate();
      },
      axisRunner: async (request) => output(request.axis),
      observation,
      revalidate: undefined,
    });

    expect(result.exitCode).toBe(5);
    expect(result.message).toContain('工作树产生未允许改动：tracked.ts');
    expect(result.state).toBeUndefined();
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

  it('isolates the workspace when an old green result cannot be revoked at startup', async () => {
    const ws = workspace();
    const first = await runFinalReview({
      ...options(ws, context()),
      axisRunner: async (request) => output(request.axis),
    });
    expect(first.exitCode).toBe(0);

    const controlledSession = session(ws, undefined, (relativePath) => {
      if (relativePath === REVIEW_STATE_FILE) throw new Error('fixture startup revoke failure');
    });
    const second = await runFinalReview({
      ...options(ws, context()),
      session: controlledSession,
      axisRunner: async (request) => output(request.axis),
    });

    expect(second.exitCode).toBe(5);
    expect(second.message).toContain('无法先撤销旧 Final Review');
    expect(second.message).toContain('workspace 已隔离');
    expect(controlledSession.state).toBe('isolated');
    expect(readFinalReviewState(ws).status).toBe('ready');
  });

  it('refuses a session that owns a different workspace', async () => {
    const ws = workspace();
    const other = workspace();
    const result = await runFinalReview({
      ...options(ws, context()),
      session: session(other),
    });
    expect(result).toEqual({
      exitCode: 2,
      message: '最终 Review 的 workspace 与受控会话不一致；拒绝读取或写入状态',
    });
    expect(readFinalReviewState(ws)).toEqual({ status: 'missing' });
    expect(readFinalReviewState(other)).toEqual({ status: 'missing' });
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
            reviewBindingDigest: digestReviewBinding(first.state!.binding),
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

  it('does not reuse a decision when PR intent changes without a new commit', async () => {
    const ws = workspace();
    const original = context();
    const first = await runFinalReview({
      ...options(ws, original),
      axisRunner: async (request) =>
        output(request.axis, request.axis === 'engineering' ? 'p1' : 'passed'),
    });
    const findingId = first.state!.axes.flatMap((axis) => axis.findings)[0].id;
    writeFileSync(
      join(ws, 'review-decisions.json'),
      JSON.stringify({
        schemaVersion: 1,
        decisions: [
          {
            findingId,
            headSha: original.headSha,
            reviewBindingDigest: digestReviewBinding(first.state!.binding),
            action: 'counterevidence',
            operator: 'maintainer',
            at: '2026-07-26T00:00:00.000Z',
            evidence: '该路径只用于测试夹具，生产入口有独立失败传播断言。',
          },
        ],
      }),
    );
    const changed = context({
      pullRequest: {
        ...original.pullRequest,
        body: `${original.pullRequest.body}\n\n补充约束：本次必须保留兼容行为。`,
      },
    });
    const second = await runFinalReview({
      ...options(ws, changed),
      axisRunner: async (request) =>
        output(request.axis, request.axis === 'engineering' ? 'p1' : 'passed'),
    });
    expect(second.exitCode).toBe(4);
    expect(second.state?.deliveryStatus).toBe('findings');
  });
});
