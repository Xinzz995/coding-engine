import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODING_X_VERSION } from '../version.js';
import { acceptanceHash } from '../contracts/validation-contract.js';
import { tryReadPrd } from '../engine/prd.js';
import { evaluateStoryValidationReceiptSet, tryReadState } from '../engine/state.js';
import {
  digestCandidateStoryValidationEnvironment,
  digestFinalReviewMechanicalEnvironment,
  evaluateStoryValidationCurrentness,
} from '../engine/story-validation-currentness.js';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import { createReviewBinding, digestReviewBinding } from '../review/binding.js';
import { digest } from '../review/common.js';
import type { ManagedReviewObservation } from '../review/managed-observation.js';
import type { ReviewPreflightContext } from '../review/preflight.js';
import { applyReviewerRequestedDeepReview, assessReviewRisk } from '../review/risk.js';
import type { FinalReviewState, ReviewAxisResult, ReviewRemoteState } from '../review/types.js';
import type { WorkspaceSession, WorkspaceWriteData } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { writeCurrentReportWithSession } from './current-report.js';
import type {
  StoryValidationObservation,
  StoryValidationObservationOptions,
} from '../review/story-validation-observation.js';

const roots: string[] = [];
const FORMAL_RUNTIME = {
  mode: 'formal',
  actualCodingXVersion: CODING_X_VERSION,
} as const;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'current-report-test-'));
  roots.push(root);
  const currentQuality = quality();
  const head = 'b'.repeat(40);
  writeFileSync(
    join(root, 'prd.json'),
    JSON.stringify({
      project: 'report-currentness',
      branchName: 'feature/report',
      description: 'test',
      qualityContractDigest: currentQuality.digest,
      qualityChecks: currentQuality.contract.checks,
      userStories: [
        {
          id: 'US-001',
          title: 'report',
          description: 'test',
          acceptanceCriteria: ['report is current'],
          priority: 1,
        },
      ],
    }),
  );
  writeFileSync(
    join(root, 'state.json'),
    JSON.stringify({
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt: {
          schemaVersion: 3,
          requestId: 'report-test-request',
          gitHead: head,
          acceptanceHash: acceptanceHash('US-001', ['report is current']),
          validationEnvironmentDigest: digestCandidateStoryValidationEnvironment({
            contract: currentQuality.contract,
            headSha: head,
            tddConfig: null,
            runtimeIdentity: FORMAL_RUNTIME,
          }),
          runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
          canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
        },
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    }),
  );
  return root;
}

function quality(): { contract: QualityContract; digest: string } {
  const result = readQualityContract(process.cwd());
  if (result.status !== 'ready') throw new Error(`quality contract unavailable: ${result.status}`);
  return { contract: result.contract, digest: result.digest };
}

function context(
  baseContract: QualityContract,
  baseContractDigest: string,
): ReviewPreflightContext {
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  return {
    root: process.cwd(),
    branch: 'feature/report',
    baseSha,
    headSha,
    pullRequest: {
      number: 88,
      headSha,
      baseBranch: 'main',
      baseSha,
      url: 'https://example.test/pull/88',
      title: 'feat: current report',
      body: [
        '## 本次目标',
        'current report',
        '## 明确的非目标',
        'none',
        '## Spec 与验收标准来源',
        'docs/specs/report.md',
        '## 验证方式',
        'tests',
        '## 风险说明',
        'report only',
      ].join('\n'),
      labels: [],
    },
    baseContract,
    baseContractDigest,
    changedFiles: ['README.md'],
    files: [{ path: 'README.md', base: 'old', head: 'new' }],
    diff: '-old\n+new\n',
    specs: [{ path: 'docs/specs/report.md', content: '# Current report' }],
    engineeringStandards: [{ path: 'AGENTS.md', content: '# Rules' }],
    history: `${headSha}\tfeat: current report`,
    prSections: {
      本次目标: 'current report',
      明确的非目标: 'none',
      'Spec 与验收标准来源': 'docs/specs/report.md',
      验证方式: 'tests',
      风险说明: 'report only',
    },
  };
}

function readyRemote(): ReviewRemoteState {
  return {
    status: 'ready',
    checks: [],
    rulesetErrors: [],
    checkedAt: '2026-07-31T00:00:00.000Z',
  };
}

function reviewState(
  reviewContext: ReviewPreflightContext,
  workspacePath: string,
  headOverride?: string,
): FinalReviewState {
  const primaryAxes: ReviewAxisResult[] = [
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
  ];
  const prd = tryReadPrd(join(workspacePath, 'prd.json'));
  const runState = tryReadState(join(workspacePath, 'state.json'));
  const expectedStoryEnvironment = digestCandidateStoryValidationEnvironment({
    contract: reviewContext.baseContract,
    headSha: reviewContext.headSha,
    tddConfig: null,
    runtimeIdentity: FORMAL_RUNTIME,
  });
  const storyValidation =
    prd && runState
      ? evaluateStoryValidationReceiptSet(
          prd,
          runState,
          reviewContext.headSha,
          expectedStoryEnvironment,
        )
      : null;
  if (!storyValidation?.digest) throw new Error('expected current Story validation fixture');
  const risk = applyReviewerRequestedDeepReview(assessReviewRisk(reviewContext), primaryAxes);
  const binding = createReviewBinding({
    context: reviewContext,
    risk,
    codingXVersion: CODING_X_VERSION,
    runner: 'codex',
    model: 'review-model',
    runnerVersion: 'codex 1.2.3',
    storyValidationDigest: storyValidation.digest,
    validationEnvironmentDigest: digestFinalReviewMechanicalEnvironment({
      contract: reviewContext.baseContract,
      headSha: reviewContext.headSha,
    }),
  });
  if (headOverride !== undefined) binding.headSha = headOverride;
  return {
    schemaVersion: 2,
    status: 'passed',
    deliveryStatus: 'ready',
    binding,
    risk,
    axes: risk.triggered
      ? [
          ...primaryAxes,
          {
            axis: 'deep',
            status: 'passed',
            summary: 'ok',
            findings: [],
            requestDeepReview: false,
            durationMs: 1,
            attempts: 1,
          },
        ]
      : primaryAxes,
    remote: readyRemote(),
    round: 1,
    shadow: false,
    startedAt: '2026-07-31T00:00:00.000Z',
    completedAt: '2026-07-31T00:01:00.000Z',
  };
}

function writeReview(workspacePath: string, state: FinalReviewState): void {
  writeFileSync(join(workspacePath, 'final-review.json'), `${JSON.stringify(state)}\n`);
}

function session(workspacePath: string): WorkspaceSession {
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
      },
      removeFile: async (relativePath: string) => {
        rmSync(join(workspacePath, relativePath), { force: true });
      },
    },
  } as unknown as WorkspaceSession;
}

function sessionMutatingAfterReportWrites(
  workspacePath: string,
  mutateAfterWrites: number[],
): WorkspaceSession {
  let reportWrites = 0;
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
        if (relativePath !== 'report.html') return;
        reportWrites += 1;
        if (!mutateAfterWrites.includes(reportWrites)) return;
        const statePath = join(workspacePath, 'state.json');
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<
          string,
          { validationReceipt: { requestId: string } }
        >;
        state['US-001'].validationReceipt.requestId = `post-write-${reportWrites}`;
        writeFileSync(statePath, JSON.stringify(state));
      },
      removeFile: async (relativePath: string) => {
        rmSync(join(workspacePath, relativePath), { force: true });
      },
    },
  } as unknown as WorkspaceSession;
}

function observation(gitHead: () => string): ManagedReviewObservation {
  return {
    git: async (args) => {
      if (
        args.length === 3 &&
        args[0] === 'rev-parse' &&
        args[1] === '--verify' &&
        args[2] === 'HEAD'
      ) {
        return `${gitHead()}\n`;
      }
      throw new Error('unexpected git call in deterministic seam');
    },
    github: {} as ManagedReviewObservation['github'],
  };
}

function currentStoryObservation(
  workspacePath: string,
  reviewContext: ReviewPreflightContext,
  headSha: string,
): StoryValidationObservation {
  const prd = tryReadPrd(join(workspacePath, 'prd.json'));
  const state = tryReadState(join(workspacePath, 'state.json'));
  const contractRead = {
    status: 'ready' as const,
    path: '/project/.coding-x/quality.json',
    contract: reviewContext.baseContract,
    digest: reviewContext.baseContractDigest,
  };
  const evaluated = evaluateStoryValidationCurrentness({
    prd,
    state: state ?? {},
    stateStatus: state === null ? 'invalid' : 'ready',
    headSha,
    workingContract: contractRead,
    trackedContract: contractRead,
    runtimeIdentity: FORMAL_RUNTIME,
    platform:
      process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : 'linux',
  });
  if (evaluated.status === 'unverifiable') {
    return { ...evaluated, workspacePath, observationToken: null };
  }
  return {
    ...evaluated,
    workspacePath,
    observationToken: digest({
      headSha,
      prd: readFileSync(join(workspacePath, 'prd.json'), 'utf8'),
      state: readFileSync(join(workspacePath, 'state.json'), 'utf8'),
      storyValidationDigest: evaluated.storyValidationDigest,
    }),
  };
}

function adapters(options: {
  reviewContext: ReviewPreflightContext;
  revalidate?: () => Promise<{ ok: true } | { ok: false; message: string }>;
  gitHead?: string | (() => string);
  observeStory?: (workspacePath: string, headSha: string) => StoryValidationObservation;
}) {
  const configuredGitHead = options.gitHead;
  const currentGitHead =
    typeof configuredGitHead === 'function'
      ? configuredGitHead
      : () => configuredGitHead ?? options.reviewContext.headSha;
  const createObservation = vi.fn(() => observation(currentGitHead));
  const readVersion = vi.fn(async (_options: { session: WorkspaceSession }) => 'codex 1.2.3');
  const remote = vi.fn(async () => readyRemote());
  const observeStoryValidation = vi.fn(async (request: StoryValidationObservationOptions) => {
    const workspacePath = request.workspace;
    if (workspacePath === undefined) throw new Error('expected observed workspace');
    return (
      options.observeStory ??
      ((target, head) => currentStoryObservation(target, options.reviewContext, head))
    )(workspacePath, currentGitHead());
  });
  return {
    value: {
      readContract: () => ({
        status: 'ready' as const,
        path: '/project/.coding-x/quality.json',
        contract: options.reviewContext.baseContract,
        digest: options.reviewContext.baseContractDigest,
      }),
      createObservation,
      preflight: async () => ({ status: 'ready' as const, context: options.reviewContext }),
      readVersion,
      remote,
      observeStoryValidation,
      revalidate: options.revalidate ?? (async () => ({ ok: true as const })),
      now: () => new Date('2026-07-31T01:00:00.000Z'),
    },
    createObservation,
    readVersion,
    remote,
    observeStoryValidation,
  };
}

describe('managed manual report currentness', () => {
  it('passes the saved shadow mode and actual candidate version to every Story observation', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    const state = reviewState(ctx, ws);
    state.shadow = true;
    state.deliveryStatus = 'shadow';
    writeReview(ws, state);
    const fake = adapters({ reviewContext: ctx });

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: false,
      codingXVersion: '0.34.0-candidate',
      adapters: fake.value,
    });

    expect(fake.observeStoryValidation).toHaveBeenCalled();
    expect(
      fake.observeStoryValidation.mock.calls.every(
        ([request]) =>
          request.runtimeIdentity.mode === 'shadow' &&
          request.runtimeIdentity.actualCodingXVersion === '0.34.0-candidate',
      ),
    ).toBe(true);
  });

  it('reports current Story receipts even when Final Review has not run yet', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: false,
      adapters: adapters({ reviewContext: ctx }).value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('Story 验证完成 1/1');
    expect(html).toContain('本地最终 Review 尚未运行');
    expect(html).not.toContain('当前 Git HEAD 不可读取');
  });

  it('accepts an alias only after proving it names the session workspace', async () => {
    const ws = workspace();
    const aliasParent = workspace();
    const alias = join(aliasParent, 'workspace-alias');
    symlinkSync(ws, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));

    await expect(
      writeCurrentReportWithSession({
        session: session(ws),
        workspace: alias,
        projectRoot: process.cwd(),
        refreshRemote: false,
        adapters: adapters({ reviewContext: ctx }).value,
      }),
    ).resolves.toMatchObject({ status: 'written' });
    expect(existsSync(join(ws, 'report.html'))).toBe(true);
    expect(existsSync(join(aliasParent, 'report.html'))).toBe(false);
  });

  it('writes a delivery-ready report only after closing Runner and context observations', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    const activeSession = session(ws);
    const fake = adapters({ reviewContext: ctx });

    await expect(
      writeCurrentReportWithSession({
        session: activeSession,
        workspace: ws,
        projectRoot: process.cwd(),
        refreshRemote: true,
        adapters: fake.value,
      }),
    ).resolves.toMatchObject({ status: 'written' });

    expect(fake.createObservation).toHaveBeenCalledWith(
      expect.objectContaining({ session: activeSession }),
    );
    expect(fake.readVersion).toHaveBeenCalledTimes(3);
    expect(fake.readVersion.mock.calls.every(([call]) => call.session === activeSession)).toBe(
      true,
    );
    expect(fake.remote).toHaveBeenCalledOnce();
    expect(readFileSync(join(ws, 'report.html'), 'utf8')).toContain(
      '本地 Review 与 GitHub 交付条件已就绪',
    );
  });

  it('removes delivery readiness when a bound P1 deferral Issue is closed', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    const state = reviewState(ctx, ws);
    const finding = {
      id: 'engineering:P1:deferred',
      axis: 'engineering' as const,
      severity: 'P1' as const,
      title: 'deferred problem',
      location: { path: 'src/demo.ts', line: 1 },
      ruleSource: 'AGENTS.md',
      impact: 'delivery remains risky',
      recommendation: 'fix it',
      requiresHumanDecision: false,
      prNumber: state.binding.prNumber,
      baseSha: state.binding.baseSha,
      headSha: state.binding.headSha,
      round: state.round,
    };
    state.axes.find((axis) => axis.axis === 'engineering')!.findings.push(finding);
    writeReview(ws, state);
    writeFileSync(
      join(ws, 'review-decisions.json'),
      `${JSON.stringify({
        schemaVersion: 1,
        decisions: [
          {
            findingId: finding.id,
            headSha: state.binding.headSha,
            reviewBindingDigest: digestReviewBinding(state.binding),
            action: 'p1-deferred',
            operator: 'owner',
            at: '2026-07-26T00:00:00.000Z',
            issue: 42,
          },
        ],
      })}\n`,
    );
    const fake = adapters({ reviewContext: ctx });
    fake.createObservation.mockReturnValue({
      ...observation(() => ctx.headSha),
      github: {
        getIssue: async () => ({
          number: 42,
          state: 'closed',
          title: 'defer',
          url: 'https://example.test/issues/42',
          labels: ['quality-p1-deferral'],
          isPullRequest: false,
          body: [
            '### 负责人',
            '@owner',
            '### 原因',
            '等待兼容窗口',
            '### 到期日',
            '2026-08-20',
            '### 跟进事项',
            '补齐实现与回归',
          ].join('\n'),
        }),
      } as unknown as ManagedReviewObservation['github'],
    });

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: fake.value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('延期引用必须是开放 Issue');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('never renders green when HEAD or PR identity changes after the first observation', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    const fake = adapters({
      reviewContext: ctx,
      revalidate: async () => ({ ok: false, message: '评审期间本地 HEAD 发生变化' }),
    });

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: fake.value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('评审期间本地 HEAD 发生变化');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('uses the final managed HEAD for both Story receipts and Review currentness', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    let finalHead = ctx.headSha;
    const fake = adapters({
      reviewContext: ctx,
      gitHead: () => finalHead,
      revalidate: async () => {
        finalHead = 'c'.repeat(40);
        return { ok: true };
      },
    });

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: fake.value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('报告收口前当前 Git HEAD 已变化');
    expect(html).toContain('Story 验收凭证已过期：US-001');
    expect(html).not.toContain('Story 验证完成 1/1');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('revalidates the context after the final Runner observation changes the repository', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    let changedDuringFinalRunner = false;
    const fake = adapters({
      reviewContext: ctx,
      revalidate: async () =>
        changedDuringFinalRunner
          ? { ok: false, message: '最终 Runner 核对期间本地 HEAD 发生变化' }
          : { ok: true },
    });
    fake.readVersion.mockImplementation(async () => {
      if (fake.readVersion.mock.calls.length === 2) changedDuringFinalRunner = true;
      return 'codex 1.2.3';
    });

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: fake.value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('最终 Runner 核对期间本地 HEAD 发生变化');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('revalidates the context after the post-decision Runner observation changes the PR', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    let changedDuringClosingRunner = false;
    const fake = adapters({
      reviewContext: ctx,
      revalidate: async () =>
        changedDuringClosingRunner
          ? { ok: false, message: '收口 Runner 核对期间 PR 正文发生变化' }
          : { ok: true },
    });
    fake.readVersion.mockImplementation(async () => {
      if (fake.readVersion.mock.calls.length === 3) changedDuringClosingRunner = true;
      return 'codex 1.2.3';
    });

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: fake.value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('收口 Runner 核对期间 PR 正文发生变化');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('never renders delivery-ready when the Validator receipt set changes during final revalidation', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    const fake = adapters({
      reviewContext: ctx,
      revalidate: async () => {
        const statePath = join(ws, 'state.json');
        const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<
          string,
          { validationReceipt: { requestId: string } }
        >;
        state['US-001'].validationReceipt.requestId = 'reissued-during-report';
        writeFileSync(statePath, JSON.stringify(state));
        return { ok: true };
      },
    });

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: fake.value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('Story 验收观察已变化');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('rewrites fail-closed when Story validation changes immediately after report persistence', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));

    await writeCurrentReportWithSession({
      session: sessionMutatingAfterReportWrites(ws, [1]),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: adapters({ reviewContext: ctx }).value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('报告写入后 Story 验收绑定发生变化');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('forces a final diagnostic report when Story validation keeps changing during rewrite', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));

    await writeCurrentReportWithSession({
      session: sessionMutatingAfterReportWrites(ws, [1, 2]),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: adapters({ reviewContext: ctx }).value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('报告持久化期间权威输入持续变化');
    expect(html).toContain('报告重写期间权威输入再次变化');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('removes the previous report before an initial Story observation can fail', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeFileSync(join(ws, 'report.html'), '<p>stale delivery-ready report</p>');
    const fake = adapters({ reviewContext: ctx });
    fake.observeStoryValidation.mockRejectedValueOnce(new Error('Story observation failed'));

    await expect(
      writeCurrentReportWithSession({
        session: session(ws),
        workspace: ws,
        projectRoot: process.cwd(),
        refreshRemote: false,
        adapters: fake.value,
      }),
    ).rejects.toThrow('Story observation failed');
    expect(existsSync(join(ws, 'report.html'))).toBe(false);
  });

  it('isolates the session when the previous report cannot be invalidated', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeFileSync(join(ws, 'report.html'), '<p>stale delivery-ready report</p>');
    let state: 'open' | 'isolated' = 'open';
    const activeSession = {
      get state() {
        return state;
      },
      retainLeaseForIsolation: () => {
        state = 'isolated';
      },
      writer: {
        workspacePath: ws,
        removeFile: async () => {
          throw new Error('cannot remove stale report');
        },
      },
    } as unknown as WorkspaceSession;

    await expect(
      writeCurrentReportWithSession({
        session: activeSession,
        workspace: ws,
        projectRoot: process.cwd(),
        refreshRemote: false,
        adapters: adapters({ reviewContext: ctx }).value,
      }),
    ).rejects.toThrow('cannot remove stale report');
    expect(state).toBe('isolated');
    expect(readFileSync(join(ws, 'report.html'), 'utf8')).toContain('stale delivery-ready');
  });

  it('removes a newly written green report when post-write observation fails', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    const fake = adapters({ reviewContext: ctx });
    fake.observeStoryValidation.mockImplementation(async (request: { workspace?: string }) => {
      if (existsSync(join(ws, 'report.html'))) throw new Error('post-write observation failed');
      const workspacePath = request.workspace;
      if (workspacePath === undefined) throw new Error('expected observed workspace');
      return currentStoryObservation(workspacePath, ctx, ctx.headSha);
    });

    await expect(
      writeCurrentReportWithSession({
        session: session(ws),
        workspace: ws,
        projectRoot: process.cwd(),
        refreshRemote: true,
        adapters: fake.value,
      }),
    ).rejects.toThrow('post-write observation failed');
    expect(existsSync(join(ws, 'report.html'))).toBe(false);
  });

  it('isolates the session and clears the first report when a fail-closed rewrite throws', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    let state: 'open' | 'isolated' = 'open';
    let reportWrites = 0;
    const activeSession = {
      get state() {
        return state;
      },
      retainLeaseForIsolation: () => {
        state = 'isolated';
      },
      writer: {
        workspacePath: ws,
        removeFile: async (relativePath: string) => {
          rmSync(join(ws, relativePath), { force: true });
        },
        writeFile: async (relativePath: string, data: WorkspaceWriteData) => {
          if (relativePath !== 'report.html') {
            writeFileSync(join(ws, relativePath), data);
            return;
          }
          reportWrites += 1;
          if (reportWrites === 2) throw new Error('rewrite failed');
          writeFileSync(join(ws, relativePath), data);
          const statePath = join(ws, 'state.json');
          const runState = JSON.parse(readFileSync(statePath, 'utf8')) as Record<
            string,
            { validationReceipt: { requestId: string } }
          >;
          runState['US-001'].validationReceipt.requestId = 'changed-after-green-write';
          writeFileSync(statePath, JSON.stringify(runState));
        },
      },
    } as unknown as WorkspaceSession;

    await expect(
      writeCurrentReportWithSession({
        session: activeSession,
        workspace: ws,
        projectRoot: process.cwd(),
        refreshRemote: true,
        adapters: adapters({ reviewContext: ctx }).value,
      }),
    ).rejects.toThrow('rewrite failed');
    expect(state).toBe('isolated');
    expect(existsSync(join(ws, 'report.html'))).toBe(false);
  });

  it('isolates the session when a fail-closed rewrite has no readable PRD', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    let state: 'open' | 'isolated' = 'open';
    const activeSession = {
      get state() {
        return state;
      },
      retainLeaseForIsolation: () => {
        state = 'isolated';
      },
      writer: {
        workspacePath: ws,
        removeFile: async (relativePath: string) => {
          rmSync(join(ws, relativePath), { force: true });
        },
        writeFile: async (relativePath: string, data: WorkspaceWriteData) => {
          writeFileSync(join(ws, relativePath), data);
          if (relativePath === 'report.html') rmSync(join(ws, 'prd.json'));
        },
      },
    } as unknown as WorkspaceSession;

    await expect(
      writeCurrentReportWithSession({
        session: activeSession,
        workspace: ws,
        projectRoot: process.cwd(),
        refreshRemote: true,
        adapters: adapters({ reviewContext: ctx }).value,
      }),
    ).resolves.toMatchObject({ status: 'missing' });
    expect(state).toBe('isolated');
    expect(existsSync(join(ws, 'report.html'))).toBe(false);
  });

  it('never renders green when final-review binding is replaced after currentness observation', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    const fake = adapters({
      reviewContext: ctx,
      revalidate: async () => {
        writeReview(ws, reviewState(ctx, ws, 'c'.repeat(40)));
        return { ok: true };
      },
    });

    await writeCurrentReportWithSession({
      session: session(ws),
      workspace: ws,
      projectRoot: process.cwd(),
      refreshRemote: true,
      adapters: fake.value,
    });

    const html = readFileSync(join(ws, 'report.html'), 'utf8');
    expect(html).toContain('当前性核验后最终 Review 状态已变化');
    expect(html).not.toContain('本地 Review 与 GitHub 交付条件已就绪');
  });

  it('propagates workspace safety failures and does not write a report', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx, ws));
    const fake = adapters({ reviewContext: ctx });
    const failure = new WorkspaceSafetyError('lease-lost', 'report lease changed');
    fake.readVersion.mockRejectedValue(failure);

    await expect(
      writeCurrentReportWithSession({
        session: session(ws),
        workspace: ws,
        projectRoot: process.cwd(),
        refreshRemote: true,
        adapters: fake.value,
      }),
    ).rejects.toBe(failure);
    expect(existsSync(join(ws, 'report.html'))).toBe(false);
  });
});
