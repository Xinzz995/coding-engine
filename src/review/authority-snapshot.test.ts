import { createHash } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextEncoder } from 'node:util';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createManagedProcessTestSession } from '../engine/managed-process-test-support.js';
import { readTddConfig } from '../engine/tdd-gate.js';
import { readQualityContract } from '../quality/contract.js';
import { runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import { ACTIVE_LEASE_DIR, PROTOCOL_ROOT_DIR } from '../workspace-safety/types.js';
import { observeManagedProcessSettlement } from '../workspace-safety/operation.js';
import {
  evaluateReviewAuthoritySnapshot,
  parseReviewAuthoritySnapshotResult,
  REVIEW_AUTHORITY_SNAPSHOT_MAX_OUTPUT_BYTES,
  verifyReviewAuthoritySnapshot,
  type ReviewAuthoritySnapshotResult,
} from './authority-snapshot.js';
import { runFinalReview } from './final-review.js';
import type { ReviewPreflightContext } from './preflight.js';
import { RUNNER_TOOL_POLICY_VERSION } from './runner.js';
import { ReviewTemporaryDirectory } from './temporary-directory.js';

const REQUEST_DIGEST = `sha256:${'1'.repeat(64)}`;
const STORY_DIGEST = `sha256:${'2'.repeat(64)}`;
const DECISIONS_DIGEST = `sha256:${'3'.repeat(64)}`;
const BASE_SHA = 'a'.repeat(40);
const HEAD_SHA = 'b'.repeat(40);
const roots: string[] = [];

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

function contract() {
  const read = readQualityContract(process.cwd());
  if (read.status !== 'ready') throw new Error(`quality contract unavailable: ${read.status}`);
  return structuredClone(read.contract);
}

function context(): ReviewPreflightContext {
  const baseContract = contract();
  return {
    root: process.cwd(),
    branch: 'feature/authority',
    baseSha: BASE_SHA,
    headSha: HEAD_SHA,
    pullRequest: {
      number: 151,
      headSha: HEAD_SHA,
      baseBranch: baseContract.repository.defaultBranch,
      baseSha: BASE_SHA,
      url: 'https://example.test/pull/151',
      title: 'fix: batch authority snapshot',
      body: 'review intent',
      labels: ['policy-approved'],
    },
    baseContract,
    baseContractDigest: 'sha256:base',
    changedFiles: ['src/review/authority-snapshot.ts'],
    files: [],
    diff: '+snapshot',
    specs: [],
    engineeringStandards: [],
    history: '',
    prSections: {
      本次目标: 'batch',
      明确的非目标: 'cache',
      'Spec 与验收标准来源': 'issue 151',
      验证方式: 'tests',
      风险说明: 'review authority',
    },
  };
}

function result(ctx = context()): ReviewAuthoritySnapshotResult {
  return {
    schemaVersion: 1,
    requestDigest: REQUEST_DIGEST,
    childProcessCount: 14,
    storyBeforeDigest: STORY_DIGEST,
    storyAfterDigest: STORY_DIGEST,
    runnerVersion: 'codex 1.2.3',
    branchBefore: ctx.branch,
    branchAfter: ctx.branch,
    headSha: ctx.headSha,
    baseSha: ctx.baseSha,
    repositoryJson: JSON.stringify({
      nameWithOwner: ctx.baseContract.repository.fullName,
      defaultBranchRef: { name: ctx.baseContract.repository.defaultBranch },
      isPrivate: false,
    }),
    repositoryAfterJson: JSON.stringify({
      nameWithOwner: ctx.baseContract.repository.fullName,
      defaultBranchRef: { name: ctx.baseContract.repository.defaultBranch },
      isPrivate: false,
    }),
    pullRequestJson: JSON.stringify({
      number: ctx.pullRequest.number,
      head: { sha: ctx.pullRequest.headSha, ref: ctx.branch },
      base: { sha: ctx.pullRequest.baseSha, ref: ctx.pullRequest.baseBranch },
      html_url: ctx.pullRequest.url,
      title: ctx.pullRequest.title,
      body: ctx.pullRequest.body,
      labels: ctx.pullRequest.labels.map((name) => ({ name })),
    }),
    pullRequestState: 'open',
    statusBeforeBase64: '',
    statusBase64: '',
    decisionsDigest: DECISIONS_DIGEST,
  };
}

function evaluate(value: ReviewAuthoritySnapshotResult): string | null {
  return evaluateReviewAuthoritySnapshot(value, {
    context: context(),
    workspace: `${process.cwd()}/.workspace`,
    expectedRunnerVersion: 'codex 1.2.3',
    expectedStoryAuthorityInputDigest: STORY_DIGEST,
    expectedDecisionsDigest: DECISIONS_DIGEST,
    includeDecisions: true,
  });
}

describe('authority snapshot result protocol', () => {
  it('accepts only a request-bound exact schema', () => {
    const value = result();
    expect(
      parseReviewAuthoritySnapshotResult(
        new TextEncoder().encode(JSON.stringify(value)),
        REQUEST_DIGEST,
      ),
    ).toEqual(value);

    expect(() =>
      parseReviewAuthoritySnapshotResult(
        new TextEncoder().encode(JSON.stringify({ ...value, extra: true })),
        REQUEST_DIGEST,
      ),
    ).toThrow('schema 非法');
    expect(() =>
      parseReviewAuthoritySnapshotResult(
        new TextEncoder().encode(JSON.stringify(value)),
        `sha256:${'9'.repeat(64)}`,
      ),
    ).toThrow('未绑定当前请求');
    expect(() =>
      parseReviewAuthoritySnapshotResult(
        new TextEncoder().encode(JSON.stringify({ ...value, childProcessCount: 15 })),
        REQUEST_DIGEST,
      ),
    ).toThrow('子进程预算非法');
  });

  it('rejects malformed UTF-8 and output beyond the global budget', () => {
    expect(() =>
      parseReviewAuthoritySnapshotResult(Uint8Array.from([0xc3, 0x28]), REQUEST_DIGEST),
    ).toThrow('严格 UTF-8 JSON');
    expect(() =>
      parseReviewAuthoritySnapshotResult(
        new Uint8Array(REVIEW_AUTHORITY_SNAPSHOT_MAX_OUTPUT_BYTES + 1),
        REQUEST_DIGEST,
      ),
    ).toThrow('超过');
  });
});

describe('authority snapshot currentness verdict', () => {
  it.each([
    [
      'Story double snapshot',
      (value: ReviewAuthoritySnapshotResult) => ({
        ...value,
        storyAfterDigest: `sha256:${'9'.repeat(64)}`,
      }),
      'Story 验收权威输入发生变化',
    ],
    [
      'Runner version',
      (value: ReviewAuthoritySnapshotResult) => ({ ...value, runnerVersion: 'codex 9.9.9' }),
      'Runner 版本发生变化',
    ],
    [
      'branch',
      (value: ReviewAuthoritySnapshotResult) => ({ ...value, branchAfter: 'main' }),
      '本地功能分支身份发生变化',
    ],
    [
      'head',
      (value: ReviewAuthoritySnapshotResult) => ({ ...value, headSha: 'c'.repeat(40) }),
      '本地 HEAD 发生变化',
    ],
    [
      'base',
      (value: ReviewAuthoritySnapshotResult) => ({ ...value, baseSha: 'c'.repeat(40) }),
      'base SHA 发生变化',
    ],
    [
      'PR state',
      (value: ReviewAuthoritySnapshotResult) => ({ ...value, pullRequestState: 'closed' }),
      '开放 PR 消失',
    ],
    [
      'decisions',
      (value: ReviewAuthoritySnapshotResult) => ({
        ...value,
        decisionsDigest: `sha256:${'8'.repeat(64)}`,
      }),
      '裁决记录发生变化',
    ],
  ])('fails closed when %s changes', (_name, mutate, message) => {
    expect(evaluate(mutate(result()))).toContain(message);
  });

  it('rejects repository, PR intent, labels and dirty worktree drift independently', () => {
    const repository = result();
    repository.repositoryJson = JSON.stringify({
      nameWithOwner: 'other/repository',
      defaultBranchRef: { name: 'main' },
      isPrivate: false,
    });
    expect(evaluate(repository)).toContain('GitHub 仓库或默认分支身份发生变化');

    const intent = result();
    intent.pullRequestJson = JSON.stringify({
      ...JSON.parse(intent.pullRequestJson),
      title: 'changed',
    });
    expect(evaluate(intent)).toContain('PR 标题或正文发生变化');

    const changedLabels = result();
    changedLabels.pullRequestJson = JSON.stringify({
      ...JSON.parse(changedLabels.pullRequestJson),
      labels: [{ name: 'changed' }],
    });
    expect(evaluate(changedLabels)).toContain('PR 标签发生变化');

    const dirty = result();
    dirty.statusBase64 = Buffer.from(' M src/index.ts\0').toString('base64');
    expect(evaluate(dirty)).toContain('工作树产生未允许改动：src/index.ts');
  });

  it('binds the pull request source branch to the local feature branch', () => {
    const branch = result();
    branch.pullRequestJson = JSON.stringify({
      ...JSON.parse(branch.pullRequestJson),
      head: { sha: HEAD_SHA, ref: 'other/branch' },
    });
    expect(evaluate(branch)).toContain('PR 来源分支发生变化');
  });
});

function sha256(value: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function executable(path: string, body: string): string {
  writeFileSync(path, `#!/usr/bin/env node\n${body}\n`);
  chmodSync(path, 0o755);
  return path;
}

function managedFixtureContext(projectRoot: string, head: string): ReviewPreflightContext {
  const value = context();
  return {
    ...value,
    root: projectRoot,
    branch: 'feature/authority',
    baseSha: head,
    headSha: head,
    pullRequest: {
      ...value.pullRequest,
      headSha: head,
      baseSha: head,
      baseBranch: value.baseContract.repository.defaultBranch,
    },
  };
}

function inlinePayload(args: readonly string[]): {
  payload: string;
  request: Record<string, unknown>;
} {
  const sourceCount = Number(args[3]);
  const payloadCount = Number(args[4]);
  const payloadStart = 5 + sourceCount;
  const encoded = args.slice(payloadStart, payloadStart + payloadCount).join('');
  const payload = Buffer.from(encoded, 'base64url').toString('utf8');
  return { payload, request: JSON.parse(payload) as Record<string, unknown> };
}

function fakeGh(path: string, ctx: ReviewPreflightContext): string {
  const repository = JSON.stringify({
    nameWithOwner: ctx.baseContract.repository.fullName,
    defaultBranchRef: { name: ctx.baseContract.repository.defaultBranch },
    isPrivate: false,
  });
  const branch = JSON.stringify({ commit: { sha: ctx.baseSha } });
  const pullRequest = JSON.stringify({
    state: 'open',
    number: ctx.pullRequest.number,
    head: { sha: ctx.pullRequest.headSha, ref: ctx.branch },
    base: { sha: ctx.pullRequest.baseSha, ref: ctx.pullRequest.baseBranch },
    html_url: ctx.pullRequest.url,
    title: ctx.pullRequest.title,
    body: ctx.pullRequest.body,
    labels: ctx.pullRequest.labels.map((name) => ({ name })),
  });
  return executable(
    path,
    `const { execFileSync } = require('node:child_process');
const args = process.argv.slice(2);
if (args[0] === 'repo') {
  const origin = execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  process.stdout.write(origin === ${JSON.stringify(`https://github.com/${ctx.baseContract.repository.fullName}.git`)} ? ${JSON.stringify(repository)} : JSON.stringify({ nameWithOwner: 'other/repository', defaultBranchRef: { name: 'main' }, isPrivate: false }));
}
else if (args.at(-1).includes('/branches/')) process.stdout.write(${JSON.stringify(branch)});
else if (args.at(-1).includes('/pulls/')) process.stdout.write(${JSON.stringify(pullRequest)});
else process.exit(9);`,
  );
}

function flakyGh(options: {
  path: string;
  delegate: string;
  failCalls: readonly number[];
  detail: string;
}): { executable: string; counter: string } {
  const counter = `${options.path}.count`;
  return {
    counter,
    executable: executable(
      options.path,
      `const { existsSync, readFileSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const counter = ${JSON.stringify(counter)};
const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) + 1 : 1;
writeFileSync(counter, String(count));
if (${JSON.stringify([...options.failCalls])}.includes(count)) {
  process.stderr.write(${JSON.stringify(options.detail)});
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(options.delegate)}, process.argv.slice(2), { encoding: 'buffer', env: process.env });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);`,
    ),
  };
}

function armedFlakyGh(options: { path: string; delegate: string; arm: string; detail: string }): {
  executable: string;
  failure: string;
} {
  const failure = `${options.path}.failed`;
  return {
    failure,
    executable: executable(
      options.path,
      `const { existsSync, writeFileSync } = require('node:fs');
const { spawnSync } = require('node:child_process');
const failure = ${JSON.stringify(failure)};
if (existsSync(${JSON.stringify(options.arm)}) && !existsSync(failure)) {
  writeFileSync(failure, 'failed once');
  process.stderr.write(${JSON.stringify(options.detail)});
  process.exit(1);
}
const result = spawnSync(${JSON.stringify(options.delegate)}, process.argv.slice(2), { encoding: 'buffer', env: process.env });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);`,
    ),
  };
}

type ManagedResult = Awaited<ReturnType<typeof runManagedWorkspaceProcess>>;

function managedResult(overrides: Partial<ManagedResult> = {}): ManagedResult {
  return {
    verdict: 'completed',
    exitCode: 0,
    signal: null,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    timedOut: false,
    processTreeNotEmpty: false,
    terminationReason: null,
    durationMs: 1,
    ...overrides,
  };
}

async function realManagedFixture(
  runnerBody: string,
  prdValue: Record<string, unknown> = { stories: [] },
) {
  const projectRoot = mkdtempSync(join(tmpdir(), 'authority-snapshot-project-'));
  const executableRoot = mkdtempSync(join(tmpdir(), 'authority-snapshot-bin-'));
  roots.push(projectRoot, executableRoot);
  const quality = JSON.stringify(contract());
  mkdirSync(join(projectRoot, '.coding-x'), { recursive: true });
  writeFileSync(join(projectRoot, '.coding-x', 'quality.json'), quality);
  execFileSync('git', ['init', '-q', '-b', 'feature/authority'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'authority test'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.email', 'authority@example.invalid'], { cwd: projectRoot });
  execFileSync('git', ['add', '.coding-x/quality.json'], { cwd: projectRoot });
  execFileSync('git', ['commit', '-q', '-m', 'fixture'], { cwd: projectRoot });
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: projectRoot,
    encoding: 'utf8',
  }).trim();
  const ctx = managedFixtureContext(projectRoot, head);
  execFileSync(
    'git',
    ['remote', 'add', 'origin', `https://github.com/${ctx.baseContract.repository.fullName}.git`],
    { cwd: projectRoot },
  );
  execFileSync(
    'git',
    ['update-ref', `refs/remotes/origin/${ctx.baseContract.repository.defaultBranch}`, head],
    { cwd: projectRoot },
  );
  const managed = await createManagedProcessTestSession();
  writeFileSync(join(managed.workspacePath, 'prd.json'), `${JSON.stringify(prdValue)}\n`);
  writeFileSync(join(managed.workspacePath, 'state.json'), '{}\n');
  const identity = {
    workspacePath: realpathSync.native(managed.workspacePath),
    head,
    defaultBranchGitHead: head,
    prd: `ready:${sha256(readFileSync(join(managed.workspacePath, 'prd.json')))}`,
    state: `ready:${sha256(readFileSync(join(managed.workspacePath, 'state.json')))}`,
    workingContract: sha256(readFileSync(join(projectRoot, '.coding-x', 'quality.json'))),
    trackedContract: sha256(readFileSync(join(projectRoot, '.coding-x', 'quality.json'))),
    tdd: sha256(JSON.stringify(readTddConfig(prdValue as never))),
  };
  return {
    managed,
    projectRoot,
    executableRoot,
    ctx,
    expectedStoryDigest: sha256(JSON.stringify(identity)),
    git: execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim(),
    gh: fakeGh(join(executableRoot, 'fake-gh'), ctx),
    runner: executable(join(executableRoot, 'fake-runner'), runnerBody),
  };
}

function registerRealManagedAuthoritySnapshotTests(): void {
  it('records exactly ten managed operations for a complete high-risk Final Review', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    try {
      const settled = join(
        fixture.managed.workspacePath,
        PROTOCOL_ROOT_DIR,
        ACTIVE_LEASE_DIR,
        'settled-operations',
      );
      const storyValidationDigest = `sha256:${'4'.repeat(64)}`;
      const outcome = await runFinalReview({
        root: fixture.projectRoot,
        workspace: fixture.managed.workspacePath,
        session: fixture.managed.session,
        currentContract: fixture.ctx.baseContract,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex 1.2.3',
        storyValidationDigest,
        observeStoryValidation: () => ({
          status: 'ready' as const,
          digest: storyValidationDigest,
          observationToken: `sha256:${'5'.repeat(64)}`,
          authorityInputDigest: fixture.expectedStoryDigest,
        }),
        preflight: () => ({ status: 'ready' as const, context: fixture.ctx }),
        gate: async () => ({
          ok: true,
          failure: null,
          total: 1,
          ran: 1,
          ms: 1,
          skipped: [],
        }),
        probe: async () => ({
          ok: true,
          runner: 'codex',
          model: 'review-model',
          runnerVersion: 'codex 1.2.3',
          policyVersion: RUNNER_TOOL_POLICY_VERSION,
          durationMs: 1,
          failures: [],
        }),
        axisRunner: async ({ axis }) => ({
          runner: 'codex',
          model: 'review-model',
          runnerVersion: 'codex 1.2.3',
          durationMs: 1,
          attempts: 1,
          output: {
            status: 'passed',
            summary: `${axis} passed`,
            requestDeepReview: false,
            findings: [],
          },
        }),
        remote: () => ({
          status: 'ready',
          checks: [],
          rulesetErrors: [],
          checkedAt: '2026-08-04T00:00:00.000Z',
        }),
        authoritySnapshotExecutablesForTests: {
          git: fixture.git,
          gh: fixture.gh,
          runner: fixture.runner,
        },
      });

      expect(outcome.exitCode).toBe(0);
      expect(readdirSync(settled)).toHaveLength(10);
    } finally {
      await fixture.managed.close();
    }
  }, 30_000);

  it('retries a transient closing snapshot without rerunning any Review axis', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const arm = join(fixture.executableRoot, 'arm-closing-snapshot');
    const gh = armedFlakyGh({
      path: join(fixture.executableRoot, 'closing-snapshot-eof-gh'),
      delegate: fixture.gh,
      arm,
      detail: 'Post "https://api.github.com/graphql": EOF',
    });
    const settled = join(
      fixture.managed.workspacePath,
      PROTOCOL_ROOT_DIR,
      ACTIVE_LEASE_DIR,
      'settled-operations',
    );
    const storyValidationDigest = `sha256:${'4'.repeat(64)}`;
    const axes: string[] = [];
    try {
      const outcome = await runFinalReview({
        root: fixture.projectRoot,
        workspace: fixture.managed.workspacePath,
        session: fixture.managed.session,
        currentContract: fixture.ctx.baseContract,
        runner: 'codex',
        model: 'review-model',
        runnerVersion: 'codex 1.2.3',
        storyValidationDigest,
        observeStoryValidation: () => ({
          status: 'ready' as const,
          digest: storyValidationDigest,
          observationToken: `sha256:${'5'.repeat(64)}`,
          authorityInputDigest: fixture.expectedStoryDigest,
        }),
        preflight: () => ({ status: 'ready' as const, context: fixture.ctx }),
        gate: async () => ({
          ok: true,
          failure: null,
          total: 1,
          ran: 1,
          ms: 1,
          skipped: [],
        }),
        probe: async () => ({
          ok: true,
          runner: 'codex',
          model: 'review-model',
          runnerVersion: 'codex 1.2.3',
          policyVersion: RUNNER_TOOL_POLICY_VERSION,
          durationMs: 1,
          failures: [],
        }),
        axisRunner: async ({ axis }) => {
          axes.push(axis);
          return {
            runner: 'codex',
            model: 'review-model',
            runnerVersion: 'codex 1.2.3',
            durationMs: 1,
            attempts: 1,
            output: {
              status: 'passed',
              summary: `${axis} passed`,
              requestDeepReview: false,
              findings: [],
            },
          };
        },
        remote: () => {
          writeFileSync(arm, 'armed');
          return {
            status: 'ready',
            checks: [],
            rulesetErrors: [],
            checkedAt: '2026-08-05T00:00:00.000Z',
          };
        },
        authoritySnapshotExecutablesForTests: {
          git: fixture.git,
          gh: gh.executable,
          runner: fixture.runner,
        },
      });

      expect(outcome.exitCode).toBe(0);
      expect(axes).toEqual(['spec', 'engineering', 'deep']);
      expect(readdirSync(settled)).toHaveLength(11);
      expect(readFileSync(gh.failure, 'utf8')).toBe('failed once');
    } finally {
      await fixture.managed.close();
    }
  }, 60_000);

  it('uses exactly one managed operation for all authority reads', async () => {
    const fixture = await realManagedFixture(
      `if (process.argv[2] !== '--version') process.exit(8); process.stdout.write('codex 1.2.3\\n');`,
    );
    try {
      const requests: Array<{
        payload: string;
        request: Record<string, unknown>;
        resultDigest: string;
        childProcessCount: number | undefined;
        operationTimeoutMs: number;
      }> = [];
      const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
        const decoded = inlinePayload(options.args);
        const outcome = await runManagedWorkspaceProcess(session, options);
        const observed = JSON.parse(outcome.stdout.toString('utf8')) as {
          requestDigest: string;
          childProcessCount?: number;
        };
        requests.push({
          ...decoded,
          resultDigest: observed.requestDigest,
          childProcessCount: observed.childProcessCount,
          operationTimeoutMs: options.timeoutMs,
        });
        return outcome;
      };
      const settled = join(
        fixture.managed.workspacePath,
        PROTOCOL_ROOT_DIR,
        ACTIVE_LEASE_DIR,
        'settled-operations',
      );
      expect(existsSync(settled) ? readdirSync(settled) : []).toHaveLength(0);
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'first checkpoint',
          managedProcess,
          executablesForTests: {
            git: fixture.git,
            gh: fixture.gh,
            runner: fixture.runner,
          },
        }),
      ).resolves.toBeNull();
      expect(readdirSync(settled)).toHaveLength(1);
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'second checkpoint',
          managedProcess,
          executablesForTests: {
            git: fixture.git,
            gh: fixture.gh,
            runner: fixture.runner,
          },
        }),
      ).resolves.toBeNull();
      expect(readdirSync(settled)).toHaveLength(2);
      expect(requests.map((entry) => entry.request.phase)).toEqual([
        'first checkpoint',
        'second checkpoint',
      ]);
      expect(requests[0].request.nonce).toMatch(/^[0-9a-f-]{36}$/u);
      expect(requests[1].request.nonce).toMatch(/^[0-9a-f-]{36}$/u);
      expect(requests[0].request.nonce).not.toBe(requests[1].request.nonce);
      expect(requests[0].resultDigest).toBe(sha256(requests[0].payload));
      expect(requests[1].resultDigest).toBe(sha256(requests[1].payload));
      expect(requests[0].resultDigest).not.toBe(requests[1].resultDigest);
      expect(requests[0].request.timeoutMs).toBe(30_000);
      expect(requests[0].operationTimeoutMs).toBeGreaterThan(30_000);
      expect(requests[1].operationTimeoutMs).toBe(requests[0].operationTimeoutMs);
      expect(requests.map((entry) => entry.childProcessCount)).toEqual([14, 14]);
    } finally {
      await fixture.managed.close();
    }
  }, 15_000);

  it('retries one complete authority snapshot after a transient GraphQL EOF', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const gh = flakyGh({
      path: join(fixture.executableRoot, 'flaky-gh'),
      delegate: fixture.gh,
      failCalls: [1],
      detail: 'Post "https://api.github.com/graphql": EOF',
    });
    const attempts: Array<{
      root: string;
      nonce: unknown;
      requestDigest?: string;
      childProcessCount?: number;
    }> = [];
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      const decoded = inlinePayload(options.args);
      const outcome = await runManagedWorkspaceProcess(session, options);
      let output: { requestDigest?: string; childProcessCount?: number } = {};
      if (outcome.exitCode === 0) {
        output = JSON.parse(outcome.stdout.toString('utf8')) as typeof output;
      }
      attempts.push({
        root: options.cwd,
        nonce: decoded.request.nonce,
        ...output,
      });
      return outcome;
    };
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'transient GraphQL checkpoint',
          managedProcess,
          executablesForTests: { git: fixture.git, gh: gh.executable, runner: fixture.runner },
        }),
      ).resolves.toBeNull();

      expect(attempts).toHaveLength(2);
      expect(attempts[0].root).not.toBe(attempts[1].root);
      expect(attempts[0].nonce).not.toBe(attempts[1].nonce);
      expect(attempts[1]).toMatchObject({ childProcessCount: 14 });
      expect(attempts[1].requestDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      for (const attempt of attempts) expect(existsSync(attempt.root)).toBe(false);
    } finally {
      await fixture.managed.close();
    }
  }, 20_000);

  it('stops during the real authority backoff without starting another managed read', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const gh = flakyGh({
      path: join(fixture.executableRoot, 'backoff-interruption-gh'),
      delegate: fixture.gh,
      failCalls: [1],
      detail: 'Post "https://api.github.com/graphql": EOF',
    });
    const controller = new AbortController();
    const attemptRoots: string[] = [];
    let managedCalls = 0;
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      managedCalls++;
      attemptRoots.push(options.cwd);
      const outcome = await runManagedWorkspaceProcess(session, options);
      if (managedCalls === 1) setImmediate(() => controller.abort());
      return outcome;
    };
    const settled = join(
      fixture.managed.workspacePath,
      PROTOCOL_ROOT_DIR,
      ACTIVE_LEASE_DIR,
      'settled-operations',
    );
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'backoff interruption checkpoint',
          termination: { signal: controller.signal, reason: 'user-interrupt' },
          managedProcess,
          executablesForTests: { git: fixture.git, gh: gh.executable, runner: fixture.runner },
        }),
      ).rejects.toThrow(/Review 权威快照已被中断/u);

      expect(managedCalls).toBe(1);
      expect(attemptRoots).toHaveLength(1);
      expect(existsSync(attemptRoots[0])).toBe(false);
      expect(readdirSync(settled)).toHaveLength(1);
      expect(readFileSync(gh.counter, 'utf8')).toBe('1');
    } finally {
      await fixture.managed.close();
    }
  }, 20_000);

  it('fails closed when local authority identity changes before the retry', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const gh = flakyGh({
      path: join(fixture.executableRoot, 'local-drift-gh'),
      delegate: fixture.gh,
      failCalls: [1],
      detail: 'Post "https://api.github.com/graphql": EOF',
    });
    let calls = 0;
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      calls++;
      const outcome = await runManagedWorkspaceProcess(session, options);
      if (calls === 1) {
        writeFileSync(join(fixture.managed.workspacePath, 'state.json'), '{"changed":true}\n');
      }
      return outcome;
    };
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'local drift after EOF checkpoint',
          managedProcess,
          executablesForTests: { git: fixture.git, gh: gh.executable, runner: fixture.runner },
        }),
      ).resolves.toContain('Story 验收权威输入发生变化');
      expect(calls).toBe(2);
    } finally {
      await fixture.managed.close();
    }
  }, 20_000);

  it('fails closed when remote pull request identity changes before the retry', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const changedContext: ReviewPreflightContext = {
      ...fixture.ctx,
      pullRequest: { ...fixture.ctx.pullRequest, body: 'changed during retry' },
    };
    const changedGh = fakeGh(join(fixture.executableRoot, 'changed-pr-gh'), changedContext);
    const gh = flakyGh({
      path: join(fixture.executableRoot, 'remote-drift-gh'),
      delegate: changedGh,
      failCalls: [1],
      detail: 'Post "https://api.github.com/graphql": EOF',
    });
    let calls = 0;
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      calls++;
      return await runManagedWorkspaceProcess(session, options);
    };
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'remote drift after EOF checkpoint',
          managedProcess,
          executablesForTests: { git: fixture.git, gh: gh.executable, runner: fixture.runner },
        }),
      ).resolves.toContain('PR 标题或正文发生变化');
      expect(calls).toBe(2);
    } finally {
      await fixture.managed.close();
    }
  }, 20_000);

  it('does not retry a GitHub EOF after authority temporary cleanup becomes unverifiable', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const gh = flakyGh({
      path: join(fixture.executableRoot, 'cleanup-failure-gh'),
      delegate: fixture.gh,
      failCalls: [1],
      detail: 'Post "https://api.github.com/graphql": EOF',
    });
    const temporaries: ReviewTemporaryDirectory[] = [];
    const cleanupSpies: Array<ReturnType<typeof vi.spyOn>> = [];
    let calls = 0;
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'cleanup failure after EOF checkpoint',
          managedProcess: async (session, options) => {
            calls++;
            return await runManagedWorkspaceProcess(session, options);
          },
          executablesForTests: { git: fixture.git, gh: gh.executable, runner: fixture.runner },
          createTemporaryForTests: (options) => {
            const temporary = ReviewTemporaryDirectory.create(options);
            temporaries.push(temporary);
            cleanupSpies.push(
              vi.spyOn(temporary, 'cleanup').mockImplementationOnce(() => ({
                status: 'unverifiable',
                location: { status: 'unverifiable', candidates: [temporary.root] },
                reason: 'injected authority cleanup failure',
                protection: { status: 'unverifiable', reason: 'identity-or-tree-unverified' },
              })),
            );
            return temporary;
          },
        }),
      ).rejects.toThrow(/injected authority cleanup failure/u);
      expect(calls).toBe(1);
    } finally {
      for (const cleanupSpy of cleanupSpies) cleanupSpy.mockRestore();
      for (const temporary of temporaries) {
        expect(temporary.cleanup()).toEqual({ status: 'removed' });
      }
      await fixture.managed.close();
    }
  }, 20_000);

  it('does not retry a signalled helper even when stderr starts with a GitHub EOF', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    let calls = 0;
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'signalled GitHub EOF checkpoint',
          managedProcess: async () => {
            calls++;
            return managedResult({
              verdict: 'root-failed',
              exitCode: null,
              signal: 'SIGTERM',
              stderr: Buffer.from(
                'github-repository: exited null: Post "https://api.github.com/graphql": EOF',
              ),
            });
          },
          executablesForTests: { git: fixture.git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).rejects.toThrow(/github-repository.*EOF/su);
      expect(calls).toBe(1);
    } finally {
      await fixture.managed.close();
    }
  });

  it('fails closed after three transient authority snapshot attempts', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const gh = flakyGh({
      path: join(fixture.executableRoot, 'always-eof-gh'),
      delegate: fixture.gh,
      failCalls: [1, 2, 3],
      detail: 'Post "https://api.github.com/graphql": EOF',
    });
    const roots: string[] = [];
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      roots.push(options.cwd);
      return await runManagedWorkspaceProcess(session, options);
    };
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'exhausted GraphQL checkpoint',
          managedProcess,
          executablesForTests: { git: fixture.git, gh: gh.executable, runner: fixture.runner },
        }),
      ).rejects.toThrow(/连续 3 次失败.*EOF/su);
      expect(roots).toHaveLength(3);
      for (const root of roots) expect(existsSync(root)).toBe(false);
    } finally {
      await fixture.managed.close();
    }
  }, 20_000);

  it('does not retry a permanent GitHub error or a non-GitHub EOF', async () => {
    const fixture = await realManagedFixture(
      `process.stderr.write('runner EOF\\ngithub-repository: Post https://api.github.com/graphql: EOF'); process.exit(23);`,
    );
    const forbidden = flakyGh({
      path: join(fixture.executableRoot, 'forbidden-gh'),
      delegate: fixture.gh,
      failCalls: [1],
      detail: 'gh: HTTP 403: Resource not accessible by integration',
    });
    let managedCalls = 0;
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      managedCalls += 1;
      return await runManagedWorkspaceProcess(session, options);
    };
    const base = {
      session: fixture.managed.session,
      context: fixture.ctx,
      workspace: fixture.managed.workspacePath,
      runner: 'codex' as const,
      expectedRunnerVersion: 'codex 1.2.3',
      expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
      expectedDecisionsDigest: DECISIONS_DIGEST,
      includeDecisions: false,
      phase: 'permanent checkpoint',
      managedProcess,
    };
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          ...base,
          executablesForTests: {
            git: fixture.git,
            gh: forbidden.executable,
            runner: executable(
              join(fixture.executableRoot, 'passing-runner'),
              `process.stdout.write('codex 1.2.3\\n');`,
            ),
          },
        }),
      ).rejects.toThrow(/权限不足|403/u);
      expect(managedCalls).toBe(1);

      await expect(
        verifyReviewAuthoritySnapshot({
          ...base,
          executablesForTests: { git: fixture.git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).rejects.toThrow(/runner EOF/u);
      expect(managedCalls).toBe(2);
    } finally {
      await fixture.managed.close();
    }
  }, 20_000);

  it('gives runner, git and gh only their required credential environments', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const runnerEnvironmentPath = join(fixture.executableRoot, 'runner-environment.json');
    const gitEnvironmentPath = join(fixture.executableRoot, 'git-environment.json');
    const ghEnvironmentPath = join(fixture.executableRoot, 'gh-environment.json');
    const delegate = (path: string, target: string, capturePath: string): string =>
      executable(
        path,
        `const { spawnSync } = require('node:child_process');
require('node:fs').writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify(process.env));
const result = spawnSync(${JSON.stringify(target)}, process.argv.slice(2), { encoding: 'buffer', env: process.env });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);`,
      );
    const git = delegate(
      join(fixture.executableRoot, 'capturing-git'),
      fixture.git,
      gitEnvironmentPath,
    );
    const gh = delegate(
      join(fixture.executableRoot, 'capturing-gh'),
      fixture.gh,
      ghEnvironmentPath,
    );
    const runner = executable(
      join(fixture.executableRoot, 'capturing-runner'),
      `require('node:fs').writeFileSync(${JSON.stringify(runnerEnvironmentPath)}, JSON.stringify(process.env)); process.stdout.write('codex 1.2.3\\n');`,
    );
    const injected = {
      CODEX_API_KEY: 'codex-secret',
      OPENAI_API_KEY: 'openai-secret',
      CODEX_HOME: fixture.executableRoot,
      GH_TOKEN: 'gh-secret',
      GITHUB_TOKEN: 'github-secret',
      GH_ENTERPRISE_TOKEN: 'enterprise-secret',
      GH_HOST: 'github.example.invalid',
    } as const;
    const previous = Object.fromEntries(
      Object.keys(injected).map((name) => [name, process.env[name]]),
    );
    Object.assign(process.env, injected);
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'credential environment checkpoint',
          executablesForTests: { git, gh, runner },
        }),
      ).resolves.toBeNull();

      const runnerEnvironment = JSON.parse(readFileSync(runnerEnvironmentPath, 'utf8')) as Record<
        string,
        string
      >;
      const gitEnvironment = JSON.parse(readFileSync(gitEnvironmentPath, 'utf8')) as Record<
        string,
        string
      >;
      const ghEnvironment = JSON.parse(readFileSync(ghEnvironmentPath, 'utf8')) as Record<
        string,
        string
      >;
      expect(runnerEnvironment).toMatchObject({
        CODEX_API_KEY: injected.CODEX_API_KEY,
        OPENAI_API_KEY: injected.OPENAI_API_KEY,
        CODEX_HOME: injected.CODEX_HOME,
      });
      for (const name of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GH_HOST']) {
        expect(runnerEnvironment[name]).toBeUndefined();
        expect(gitEnvironment[name]).toBeUndefined();
      }
      for (const name of ['CODEX_API_KEY', 'OPENAI_API_KEY', 'CODEX_HOME']) {
        expect(gitEnvironment[name]).toBeUndefined();
        expect(ghEnvironment[name]).toBeUndefined();
      }
      expect(ghEnvironment).toMatchObject({
        GH_TOKEN: injected.GH_TOKEN,
        GITHUB_TOKEN: injected.GITHUB_TOKEN,
        GH_ENTERPRISE_TOKEN: injected.GH_ENTERPRISE_TOKEN,
        GH_HOST: injected.GH_HOST,
      });
    } finally {
      for (const [name, value] of Object.entries(previous)) {
        if (value === undefined) delete process.env[name];
        else process.env[name] = value;
      }
      await fixture.managed.close();
    }
  }, 20_000);

  it('reports a settled helper failure without misclassifying the process lifecycle', async () => {
    const fixture = await realManagedFixture(
      `require('node:fs').writeSync(2, 'authority-root-failed-marker:' + 'x'.repeat(3000) + ':tail-marker\\n'); process.exit(23);`,
    );
    let authorityRoot = '';
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      authorityRoot = options.cwd;
      return await runManagedWorkspaceProcess(session, options);
    };
    const settled = join(
      fixture.managed.workspacePath,
      PROTOCOL_ROOT_DIR,
      ACTIVE_LEASE_DIR,
      'settled-operations',
    );
    try {
      let failure: unknown;
      try {
        await verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'settled root failure checkpoint',
          managedProcess,
          executablesForTests: {
            git: fixture.git,
            gh: fixture.gh,
            runner: fixture.runner,
          },
        });
      } catch (error) {
        failure = error;
      }

      expect(failure).toBeInstanceOf(Error);
      const message = (failure as Error).message;
      expect(message).toContain('authority-root-failed-marker');
      expect(message).toContain('tail-marker');
      expect(message).toContain('runner-version');
      expect(message).toContain('exited 23');
      expect(message).not.toContain('process-unsettled');
      expect(message).not.toContain('未完整结算');

      const operations = readdirSync(settled);
      expect(operations).toHaveLength(1);
      const receipt = JSON.parse(
        readFileSync(join(settled, operations[0], 'drained-receipt.json'), 'utf8'),
      ) as { drainReason?: string; proof?: string };
      expect(receipt).toMatchObject({
        drainReason: 'natural',
        proof: 'posix-group-empty-and-pipes-eof-v1',
      });

      expect(authorityRoot).not.toBe('');
      expect(existsSync(authorityRoot)).toBe(false);
    } finally {
      await fixture.managed.close().catch(() => undefined);
    }
  });

  it('enforces a hard per-child timeout when the Runner ignores SIGTERM', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('unused\\n');`);
    const target = join(fixture.executableRoot, 'ignore-term-runner.mjs');
    writeFileSync(
      target,
      `process.on('SIGTERM', () => {}); setTimeout(() => process.stdout.write('codex 1.2.3\\n'), 3000);\n`,
    );
    writeFileSync(
      fixture.runner,
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(target)}
`,
    );
    chmodSync(fixture.runner, 0o755);
    let helperDurationMs = 0;
    const directProcess: typeof runManagedWorkspaceProcess = async (_session, options) => {
      const startedAt = Date.now();
      const outcome = spawnSync(options.executable, options.args, {
        cwd: options.cwd,
        env: Object.fromEntries(options.environment.map(({ name, value }) => [name, value])),
        encoding: 'buffer',
        timeout: 5_000,
        killSignal: 'SIGKILL',
      });
      helperDurationMs = Date.now() - startedAt;
      return {
        verdict: 'completed',
        exitCode: outcome.status,
        signal: outcome.signal,
        stdout: Buffer.from(outcome.stdout ?? []),
        stderr: Buffer.from(outcome.stderr ?? []),
        timedOut: false,
        processTreeNotEmpty: false,
        terminationReason: null,
        durationMs: helperDurationMs,
      };
    };
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'hard child timeout checkpoint',
          timeoutMs: 1_000,
          managedProcess: directProcess,
          executablesForTests: { git: fixture.git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).rejects.toThrow(/authority snapshot/u);
      expect(helperDurationMs).toBeLessThan(2_200);
    } finally {
      await fixture.managed.close();
    }
  });

  it('lets the outer supervisor discover and settle descendants after a hard child timeout', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('unused\\n');`);
    let authorityRoot = '';
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      authorityRoot = options.cwd;
      return await runManagedWorkspaceProcess(session, options);
    };
    const target = join(fixture.executableRoot, 'timeout-descendant-runner.mjs');
    writeFileSync(
      target,
      `import { spawn } from 'node:child_process';
process.on('SIGTERM', () => {});
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' });
child.unref();
setTimeout(() => process.stdout.write('codex 1.2.3\\n'), 9000);
`,
    );
    writeFileSync(
      fixture.runner,
      `#!/bin/sh
exec ${JSON.stringify(process.execPath)} ${JSON.stringify(target)}
`,
    );
    chmodSync(fixture.runner, 0o755);
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'hard timeout descendant checkpoint',
          timeoutMs: 3_000,
          managedProcess,
          executablesForTests: { git: fixture.git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).rejects.toThrow(/后代进程|未完整结算|临时域/u);
      await expect(fixture.managed.close()).resolves.toBeUndefined();
    } finally {
      await fixture.managed.close().catch(() => undefined);
      if (authorityRoot !== '' && existsSync(authorityRoot)) {
        chmodSync(authorityRoot, 0o700);
        roots.push(authorityRoot);
      }
    }
  }, 20_000);

  it('fails closed when the Runner version command writes into the project', async () => {
    const fixture = await realManagedFixture(
      `require('node:fs').writeFileSync(${JSON.stringify('/placeholder')}, 'pollution'); process.stdout.write('codex 1.2.3\\n');`,
    );
    const pollution = join(fixture.projectRoot, 'runner-pollution.txt');
    writeFileSync(
      fixture.runner,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(pollution)}, 'pollution'); process.stdout.write('codex 1.2.3\\n');\n`,
    );
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'test checkpoint',
          executablesForTests: { git: fixture.git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).resolves.toContain('工作树产生未允许改动：runner-pollution.txt');
    } finally {
      await fixture.managed.close();
    }
  }, 20_000);

  it('fails closed when a child survives the helper root process', async () => {
    const fixture = await realManagedFixture(
      `const { spawn } = require('node:child_process');
const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { detached: false, stdio: 'ignore' });
child.unref(); process.stdout.write('codex 1.2.3\\n');`,
    );
    let authorityRoot = '';
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      authorityRoot = options.cwd;
      return await runManagedWorkspaceProcess(session, options);
    };
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'test checkpoint',
          timeoutMs: 10_000,
          managedProcess,
          executablesForTests: { git: fixture.git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).rejects.toThrow(/后代进程|未完整结算/u);
    } finally {
      await fixture.managed.close().catch(() => undefined);
      if (authorityRoot !== '' && existsSync(authorityRoot)) {
        chmodSync(authorityRoot, 0o700);
        roots.push(authorityRoot);
      }
    }
  }, 30_000);

  it('fails closed when the Runner writes into its sealed temporary domain', async () => {
    const fixture = await realManagedFixture(
      `require('node:fs').writeFileSync(require('node:path').join(process.cwd(), 'pollution'), 'x'); process.stdout.write('codex 1.2.3\\n');`,
    );
    let authorityRoot = '';
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      authorityRoot = options.cwd;
      return await runManagedWorkspaceProcess(session, options);
    };
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'temporary write checkpoint',
          managedProcess,
          executablesForTests: { git: fixture.git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).rejects.toThrow(/runner-version[\s\S]*(?:EACCES|permission denied)/u);
      expect(authorityRoot).not.toBe('');
      expect(existsSync(authorityRoot)).toBe(false);
    } finally {
      await fixture.managed.close().catch(() => undefined);
    }
  });

  it('fails closed when a descendant writes an undelegated workspace file', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    let authorityRoot = '';
    const managedProcess: typeof runManagedWorkspaceProcess = async (session, options) => {
      authorityRoot = options.cwd;
      return await runManagedWorkspaceProcess(session, options);
    };
    const rogue = join(fixture.managed.workspacePath, 'rogue.txt');
    writeFileSync(
      fixture.runner,
      `#!/usr/bin/env node\nrequire('node:fs').writeFileSync(${JSON.stringify(rogue)}, 'rogue'); process.stdout.write('codex 1.2.3\\n');\n`,
    );
    try {
      let failure: unknown;
      try {
        await verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'workspace write checkpoint',
          managedProcess,
          executablesForTests: { git: fixture.git, gh: fixture.gh, runner: fixture.runner },
        });
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('semantic delta was not accepted');
      expect((failure as Error).message).not.toContain('临时域已保留');
      expect(observeManagedProcessSettlement(failure)).toMatchObject({
        status: 'confirmed',
        drainReason: 'natural',
      });
      expect(authorityRoot).not.toBe('');
      expect(existsSync(authorityRoot)).toBe(false);
    } finally {
      await fixture.managed.close().catch(() => undefined);
      if (authorityRoot !== '' && existsSync(authorityRoot)) {
        chmodSync(authorityRoot, 0o700);
        roots.push(authorityRoot);
      }
    }
  });

  it('binds the local origin default-branch commit into Story authority', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    try {
      const tree = execFileSync('git', ['rev-parse', `${fixture.ctx.headSha}^{tree}`], {
        cwd: fixture.projectRoot,
        encoding: 'utf8',
      }).trim();
      const changedDefaultBranchHead = execFileSync(
        'git',
        ['commit-tree', tree, '-p', fixture.ctx.headSha],
        {
          cwd: fixture.projectRoot,
          encoding: 'utf8',
          input: 'move default branch authority\n',
        },
      ).trim();
      execFileSync(
        'git',
        [
          'update-ref',
          `refs/remotes/origin/${fixture.ctx.baseContract.repository.defaultBranch}`,
          changedDefaultBranchHead,
        ],
        { cwd: fixture.projectRoot },
      );

      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'default branch authority checkpoint',
          executablesForTests: {
            git: fixture.git,
            gh: fixture.gh,
            runner: fixture.runner,
          },
        }),
      ).resolves.toContain('Story 验收权威输入发生变化');
    } finally {
      await fixture.managed.close();
    }
  });

  it('binds the TDD authority and local origin repository at every snapshot', async () => {
    const tddFixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    try {
      writeFileSync(
        join(tddFixture.managed.workspacePath, 'prd.json'),
        JSON.stringify({
          stories: [],
          tdd: {
            coverageCheck: 'go test ./...',
            sourcePathspecs: ['src/**'],
            policyFiles: [],
            baselineRef: 'a'.repeat(40),
            forbiddenAddedPatterns: ['skip'],
          },
        }),
      );
      await expect(
        verifyReviewAuthoritySnapshot({
          session: tddFixture.managed.session,
          context: tddFixture.ctx,
          workspace: tddFixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: tddFixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'TDD checkpoint',
          executablesForTests: {
            git: tddFixture.git,
            gh: tddFixture.gh,
            runner: tddFixture.runner,
          },
        }),
      ).resolves.toContain('Story 验收权威输入发生变化');
    } finally {
      await tddFixture.managed.close();
    }

    const originFixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    try {
      execFileSync(
        'git',
        ['remote', 'set-url', 'origin', 'https://github.com/other/repository.git'],
        {
          cwd: originFixture.projectRoot,
        },
      );
      await expect(
        verifyReviewAuthoritySnapshot({
          session: originFixture.managed.session,
          context: originFixture.ctx,
          workspace: originFixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: originFixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'origin checkpoint',
          executablesForTests: {
            git: originFixture.git,
            gh: originFixture.gh,
            runner: originFixture.runner,
          },
        }),
      ).resolves.toContain('GitHub 仓库或默认分支身份发生变化');
    } finally {
      await originFixture.managed.close();
    }
  }, 15_000);

  it('normalizes legal TDD policyFiles key order like readTddConfig', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`, {
      stories: [],
      tdd: {
        coverageCheck: 'node coverage-check.mjs',
        sourcePathspecs: ['src/**'],
        policyFiles: [{ sha256: 'f'.repeat(64), path: 'coverage-policy.json' }],
        baselineRef: 'a'.repeat(40),
        forbiddenAddedPatterns: ['istanbul ignore'],
      },
    });
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'TDD policyFiles order checkpoint',
          executablesForTests: {
            git: fixture.git,
            gh: fixture.gh,
            runner: fixture.runner,
          },
        }),
      ).resolves.toBeNull();
    } finally {
      await fixture.managed.close();
    }
  });

  it('fails closed when ordinary source changes after the first status sample', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const marker = join(fixture.executableRoot, 'status-seen');
    const lateSource = join(fixture.projectRoot, 'late-source.ts');
    const git = executable(
      join(fixture.executableRoot, 'mutating-git'),
      `const { spawnSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('status')) writeFileSync(${JSON.stringify(marker)}, 'seen');
else if (existsSync(${JSON.stringify(marker)}) && args.includes('show') && !existsSync(${JSON.stringify(lateSource)})) writeFileSync(${JSON.stringify(lateSource)}, 'late mutation');
const result = spawnSync(${JSON.stringify(fixture.git)}, args, { encoding: 'buffer' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);`,
    );
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'late source checkpoint',
          executablesForTests: { git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).resolves.toContain('工作树产生未允许改动：late-source.ts');
    } finally {
      await fixture.managed.close().catch(() => undefined);
    }
  });

  it('fails closed when an allowed generated path changes between status samples', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const marker = join(fixture.executableRoot, 'generated-status-seen');
    const generatedDirectory = join(fixture.projectRoot, 'dist');
    const generatedFile = join(generatedDirectory, 'late-generated.txt');
    mkdirSync(generatedDirectory);
    const git = executable(
      join(fixture.executableRoot, 'generated-mutating-git'),
      `const { spawnSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args.includes('status')) writeFileSync(${JSON.stringify(marker)}, 'seen');
else if (existsSync(${JSON.stringify(marker)}) && args.includes('show') && !existsSync(${JSON.stringify(generatedFile)})) writeFileSync(${JSON.stringify(generatedFile)}, 'late generated mutation');
const result = spawnSync(${JSON.stringify(fixture.git)}, args, { encoding: 'buffer' });
if (result.stdout) process.stdout.write(result.stdout);
if (result.stderr) process.stderr.write(result.stderr);
process.exit(result.status ?? 1);`,
    );
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'allowed generated mutation checkpoint',
          executablesForTests: { git, gh: fixture.gh, runner: fixture.runner },
        }),
      ).resolves.toContain('工作树状态发生变化');
    } finally {
      await fixture.managed.close().catch(() => undefined);
    }
  });

  it('fails closed when local origin changes after initial repository discovery', async () => {
    const fixture = await realManagedFixture(`process.stdout.write('codex 1.2.3\\n');`);
    const marker = join(fixture.executableRoot, 'origin-mutated');
    const repository = JSON.stringify({
      nameWithOwner: fixture.ctx.baseContract.repository.fullName,
      defaultBranchRef: { name: fixture.ctx.baseContract.repository.defaultBranch },
      isPrivate: false,
    });
    const otherRepository = JSON.stringify({
      nameWithOwner: 'other/repository',
      defaultBranchRef: { name: 'main' },
      isPrivate: false,
    });
    const branch = JSON.stringify({ commit: { sha: fixture.ctx.baseSha } });
    const pullRequest = JSON.stringify({
      state: 'open',
      number: fixture.ctx.pullRequest.number,
      head: { sha: fixture.ctx.pullRequest.headSha, ref: fixture.ctx.branch },
      base: {
        sha: fixture.ctx.pullRequest.baseSha,
        ref: fixture.ctx.pullRequest.baseBranch,
      },
      html_url: fixture.ctx.pullRequest.url,
      title: fixture.ctx.pullRequest.title,
      body: fixture.ctx.pullRequest.body,
      labels: fixture.ctx.pullRequest.labels.map((name) => ({ name })),
    });
    const gh = executable(
      join(fixture.executableRoot, 'mutating-gh'),
      `const { execFileSync } = require('node:child_process');
const { existsSync, writeFileSync } = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === 'repo') {
  const origin = execFileSync(${JSON.stringify(fixture.git)}, ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim();
  process.stdout.write(origin.includes('/other/repository') ? ${JSON.stringify(otherRepository)} : ${JSON.stringify(repository)});
  if (!existsSync(${JSON.stringify(marker)})) {
    execFileSync(${JSON.stringify(fixture.git)}, ['remote', 'set-url', 'origin', 'https://github.com/other/repository.git']);
    writeFileSync(${JSON.stringify(marker)}, 'mutated');
  }
}
else if (args.at(-1).includes('/branches/')) process.stdout.write(${JSON.stringify(branch)});
else if (args.at(-1).includes('/pulls/')) process.stdout.write(${JSON.stringify(pullRequest)});
else process.exit(9);`,
    );
    try {
      await expect(
        verifyReviewAuthoritySnapshot({
          session: fixture.managed.session,
          context: fixture.ctx,
          workspace: fixture.managed.workspacePath,
          runner: 'codex',
          expectedRunnerVersion: 'codex 1.2.3',
          expectedStoryAuthorityInputDigest: fixture.expectedStoryDigest,
          expectedDecisionsDigest: DECISIONS_DIGEST,
          includeDecisions: false,
          phase: 'origin mutation checkpoint',
          executablesForTests: { git: fixture.git, gh, runner: fixture.runner },
        }),
      ).resolves.toContain('GitHub 仓库或默认分支身份发生变化');
    } finally {
      await fixture.managed.close().catch(() => undefined);
    }
  });
}

describe.runIf(process.platform !== 'win32')(
  'real managed authority snapshot',
  { timeout: 30_000, concurrent: false },
  registerRealManagedAuthoritySnapshotTests,
);
