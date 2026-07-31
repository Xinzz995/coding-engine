import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CODING_X_VERSION } from '../version.js';
import { acceptanceHash } from '../contracts/validation-contract.js';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import { createReviewBinding } from '../review/binding.js';
import type { ManagedReviewObservation } from '../review/managed-observation.js';
import type { ReviewPreflightContext } from '../review/preflight.js';
import { applyReviewerRequestedDeepReview, assessReviewRisk } from '../review/risk.js';
import type { FinalReviewState, ReviewAxisResult, ReviewRemoteState } from '../review/types.js';
import type { WorkspaceSession, WorkspaceWriteData } from '../workspace-safety/session.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';
import { writeCurrentReportWithSession } from './current-report.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'current-report-test-'));
  roots.push(root);
  writeFileSync(
    join(root, 'prd.json'),
    JSON.stringify({
      project: 'report-currentness',
      branchName: 'feature/report',
      description: 'test',
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
          schemaVersion: 1,
          requestId: 'report-test-request',
          gitHead: 'b'.repeat(40),
          acceptanceHash: acceptanceHash('US-001', ['report is current']),
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
  const risk = applyReviewerRequestedDeepReview(assessReviewRisk(reviewContext), primaryAxes);
  const binding = createReviewBinding({
    context: reviewContext,
    risk,
    codingXVersion: CODING_X_VERSION,
    runner: 'codex',
    model: 'review-model',
    runnerVersion: 'codex 1.2.3',
  });
  if (headOverride !== undefined) binding.headSha = headOverride;
  return {
    schemaVersion: 1,
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
  return {
    writer: {
      workspacePath,
      writeFile: async (relativePath: string, data: WorkspaceWriteData) => {
        writeFileSync(join(workspacePath, relativePath), data);
      },
    },
  } as unknown as WorkspaceSession;
}

function observation(): ManagedReviewObservation {
  return {
    git: async () => {
      throw new Error('unexpected git call in deterministic seam');
    },
    github: {} as ManagedReviewObservation['github'],
  };
}

function adapters(options: {
  reviewContext: ReviewPreflightContext;
  revalidate?: () => Promise<{ ok: true } | { ok: false; message: string }>;
}) {
  const createObservation = vi.fn(() => observation());
  const readVersion = vi.fn(async (_options: { session: WorkspaceSession }) => 'codex 1.2.3');
  const remote = vi.fn(async () => readyRemote());
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
      revalidate: options.revalidate ?? (async () => ({ ok: true as const })),
      now: () => new Date('2026-07-31T01:00:00.000Z'),
    },
    createObservation,
    readVersion,
    remote,
  };
}

describe('managed manual report currentness', () => {
  it('accepts an alias only after proving it names the session workspace', async () => {
    const ws = workspace();
    const aliasParent = workspace();
    const alias = join(aliasParent, 'workspace-alias');
    symlinkSync(ws, alias, process.platform === 'win32' ? 'junction' : 'dir');
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx));

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

  it('writes a delivery-ready report only after two Runner observations and final context validation', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx));
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
    expect(fake.readVersion).toHaveBeenCalledTimes(2);
    expect(fake.readVersion.mock.calls.every(([call]) => call.session === activeSession)).toBe(
      true,
    );
    expect(fake.remote).toHaveBeenCalledOnce();
    expect(readFileSync(join(ws, 'report.html'), 'utf8')).toContain(
      '本地 Review 与 GitHub 交付条件已就绪',
    );
  });

  it('never renders green when HEAD or PR identity changes after the first observation', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx));
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

  it('revalidates the context after the final Runner observation changes the repository', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx));
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

  it('never renders green when final-review binding is replaced after currentness observation', async () => {
    const ws = workspace();
    const q = quality();
    const ctx = context(q.contract, q.digest);
    writeReview(ws, reviewState(ctx));
    const fake = adapters({
      reviewContext: ctx,
      revalidate: async () => {
        writeReview(ws, reviewState(ctx, 'c'.repeat(40)));
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
    writeReview(ws, reviewState(ctx));
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
