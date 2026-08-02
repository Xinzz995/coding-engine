import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readGitHead } from '../engine/validation-protocol.js';
import { readQualityContract } from '../quality/contract.js';
import { CODING_X_VERSION } from '../version.js';
import { digestBytes } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import { readCanonicalMutationDomain, verifyMutationArchive } from './mutation-domain.js';
import * as productMutations from './product-mutations.js';
import {
  applyPrdV1CandidateDigest,
  runApplyPrdV1Mutation,
  runRepairV1Mutation,
  type ApplyPrdV1Candidate,
  type ApplyPrdV1Request,
} from './product-mutations.js';
import { createWorkspaceSession, type WorkspaceSession } from './session.js';
import {
  acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease,
  bootstrapWorkspaceWithAuthority as bootstrapWorkspace,
} from './workspace-authority-test-seam.js';

const roots: string[] = [];
type ReadyQuality = Extract<ReturnType<typeof readQualityContract>, { readonly status: 'ready' }>;

let QUALITY: ReadyQuality;
let QUALITY_DIGEST: string;
let HEAD: string;
let APPLY_OPTIONS: { readonly projectRoot: string; readonly runtimeMode: 'formal' };

beforeEach(() => {
  const project = gitProject();
  const quality = readQualityContract(project.root);
  if (quality.status !== 'ready') {
    throw new Error(`quality fixture unavailable: ${quality.status}`);
  }
  QUALITY = quality;
  QUALITY_DIGEST = quality.digest;
  HEAD = project.head;
  APPLY_OPTIONS = { projectRoot: project.root, runtimeMode: 'formal' };
});

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function prd(branchName: string, revision: string, extra: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        project: 'fixture',
        branchName,
        description: revision,
        qualityContractDigest: QUALITY_DIGEST,
        qualityChecks: QUALITY.contract.checks,
        userStories: [],
        ...extra,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
}

async function fixture(command: 'apply-prd' | 'repair'): Promise<{
  readonly root: string;
  readonly session: WorkspaceSession;
}> {
  const root = mkdtempSync(join(tmpdir(), 'workspace-product-mutation-'));
  roots.push(root);
  const identity = createIdentityProbe().current();
  await bootstrapWorkspace({ workspacePath: root, identity });
  const lease = await acquireWorkspaceLease({ workspacePath: root, identity, command });
  return { root, session: createWorkspaceSession(lease) };
}

function applyRequest(
  mode: ApplyPrdV1Request['mode'],
  candidate: ApplyPrdV1Candidate,
  options: { readonly staleSource?: boolean; readonly head?: string } = {},
): ApplyPrdV1Request {
  const source = Buffer.from('# source PRD\n', 'utf8');
  const head = options.head ?? HEAD;
  return {
    schemaVersion: 1,
    mode,
    source: {
      bytes: source,
      digest: options.staleSource ? `sha256:${'0'.repeat(64)}` : digestBytes(source),
    },
    git: { expectedHead: head, currentHead: head },
    quality: {
      expectedDigest: QUALITY_DIGEST,
      currentDigest: QUALITY_DIGEST,
    },
    candidate: {
      ...candidate,
      digest: applyPrdV1CandidateDigest(mode, candidate),
    },
  };
}

function gitProject(codingXVersion = CODING_X_VERSION): { readonly root: string; readonly head: string } {
  const root = mkdtempSync(join(tmpdir(), 'workspace-product-project-'));
  roots.push(root);
  mkdirSync(join(root, '.coding-x'), { recursive: true });
  const contract = JSON.parse(
    readFileSync(join(process.cwd(), '.coding-x', 'quality.json'), 'utf8'),
  ) as Record<string, unknown>;
  contract.codingXVersion = codingXVersion;
  writeFileSync(join(root, '.coding-x', 'quality.json'), `${JSON.stringify(contract, null, 2)}\n`);
  writeFileSync(join(root, 'source.txt'), '# source PRD\n');
  writeFileSync(join(root, 'README.md'), '# different source\n');
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: root });
  execFileSync('git', ['config', 'user.name', 'coding-x test'], { cwd: root });
  execFileSync('git', ['config', 'user.email', 'coding-x-test@example.invalid'], { cwd: root });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: root });
  execFileSync('git', ['add', '.coding-x/quality.json', 'source.txt', 'README.md'], { cwd: root });
  execFileSync('git', ['commit', '-q', '-m', 'test: baseline'], { cwd: root });
  return {
    root,
    head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' })
      .trim()
      .toLowerCase(),
  };
}

function writeOldRun(root: string, branchName = 'ralph/old-feature'): void {
  writeFileSync(join(root, 'prd.json'), prd(branchName, 'old'));
  writeFileSync(join(root, 'state.json'), '{"old":true}\n');
  writeFileSync(join(root, 'progress.md'), '# old progress\n');
  writeFileSync(join(root, 'review-old.md'), '# legacy review\n');
  writeFileSync(join(root, 'final-review.json'), '{"status":"failed"}\n');
  writeFileSync(join(root, 'final-review.md'), '# final review\n');
  writeFileSync(join(root, 'review-decisions.json'), '[]\n');
  writeFileSync(join(root, 'evidence.jsonl'), '{"old":true}\n');
  writeFileSync(join(root, 'report.html'), '<p>old report</p>\n');
  writeFileSync(join(root, 'prd.tampered-20260731-010101.json'), '{"tampered":true}\n');
  writeFileSync(join(root, 'validation-result.json'), '{"temporary":true}\n');
  mkdirSync(join(root, 'screenshots', 'nested'), { recursive: true });
  writeFileSync(join(root, 'screenshots', 'old.png'), 'old screenshot');
  writeFileSync(join(root, 'screenshots', 'nested', 'old.png'), 'nested screenshot');
  writeFileSync(join(root, 'private-token.txt'), 'must stay outside archive');
}

describe('fixed apply-prd-v1 product mutation', () => {
  it('exposes only the two fixed product actions and their candidate digest helper', () => {
    expect(Object.keys(productMutations).sort()).toEqual([
      'applyPrdV1CandidateDigest',
      'runApplyPrdV1Mutation',
      'runRepairV1Mutation',
    ]);
  });

  it('keeps a version mismatch zero-write in formal mode but permits only the same request in shadow mode', async () => {
    const project = gitProject('9.9.9');
    const quality = readQualityContract(project.root);
    if (quality.status !== 'ready') throw new Error(`quality fixture unavailable: ${quality.status}`);
    QUALITY = quality;
    QUALITY_DIGEST = quality.digest;
    HEAD = project.head;
    const candidate = {
      prd: prd('ralph/shadow-feature', 'candidate'),
      state: null,
      progress: Buffer.from('# candidate progress\n'),
    };
    const request = applyRequest('replace-feature', candidate);

    const formal = await fixture('apply-prd');
    writeOldRun(formal.root);
    const originalPrd = readFileSync(join(formal.root, 'prd.json'));
    await expect(runApplyPrdV1Mutation(formal.session, request, {
      projectRoot: project.root,
      runtimeMode: 'formal',
    })).rejects.toThrow(/requires coding-x 9\.9\.9/u);
    expect(readFileSync(join(formal.root, 'prd.json'))).toEqual(originalPrd);
    expect(existsSync(join(formal.root, 'state.json'))).toBe(true);
    await expect(formal.session.close()).resolves.toContain('released-');

    const shadow = await fixture('apply-prd');
    const committed = await runApplyPrdV1Mutation(shadow.session, request, {
      projectRoot: project.root,
      runtimeMode: 'shadow',
    });
    expect(committed.state.kind).toBe('apply-prd-shadow-v1');
    expect(committed.state.phase).toBe('committed');
    expect(readFileSync(join(shadow.root, 'prd.json'))).toEqual(candidate.prd);
    expect(readFileSync(join(shadow.root, 'progress.md'))).toEqual(candidate.progress);
    expect(existsSync(join(shadow.root, 'state.json'))).toBe(false);
    await expect(shadow.session.close()).resolves.toContain('released-');
  });

  it('does not let shadow bypass a stale quality-check snapshot', async () => {
    const project = gitProject('9.9.9');
    const quality = readQualityContract(project.root);
    if (quality.status !== 'ready') throw new Error(`quality fixture unavailable: ${quality.status}`);
    QUALITY = quality;
    QUALITY_DIGEST = quality.digest;
    HEAD = project.head;
    const { root, session } = await fixture('apply-prd');
    writeOldRun(root);
    const originalPrd = readFileSync(join(root, 'prd.json'));
    const candidate = {
      prd: prd('ralph/shadow-feature', 'candidate', { qualityChecks: ['not-derived'] }),
      state: null,
      progress: Buffer.from('# candidate progress\n'),
    };

    await expect(runApplyPrdV1Mutation(
      session,
      applyRequest('replace-feature', candidate),
      { projectRoot: project.root, runtimeMode: 'shadow' },
    )).rejects.toThrow(/qualityChecks/u);
    expect(readFileSync(join(root, 'prd.json'))).toEqual(originalPrd);
    await expect(session.close()).resolves.toContain('released-');
  });

  it('archives a complete old feature, resets its run material, and never archives an unlisted file', async () => {
    const { root, session } = await fixture('apply-prd');
    writeOldRun(root);
    const nextPrd = prd('ralph/new-feature', 'new');
    const nextProgress = Buffer.from('# fresh progress\n', 'utf8');
    const request = applyRequest('replace-feature', {
      prd: nextPrd,
      state: null,
      progress: nextProgress,
    });

    const committed = await runApplyPrdV1Mutation(session, request, APPLY_OPTIONS);
    const archive = await verifyMutationArchive(committed);

    expect(committed.state.kind).toBe('apply-prd-v1');
    expect(committed.manifest.archivePaths).toEqual([
      'evidence.jsonl',
      'final-review.json',
      'final-review.md',
      'prd.json',
      'prd.tampered-20260731-010101.json',
      'progress.md',
      'report.html',
      'review-decisions.json',
      'review-old.md',
      'screenshots',
      'state.json',
    ]);
    for (const path of [
      'prd.json',
      'state.json',
      'progress.md',
      'review-old.md',
      'final-review.json',
      'final-review.md',
      'review-decisions.json',
      'evidence.jsonl',
      'report.html',
      'prd.tampered-20260731-010101.json',
      'screenshots/old.png',
      'screenshots/nested/old.png',
    ]) {
      expect(existsSync(join(archive, 'data', path)), path).toBe(true);
    }
    expect(existsSync(join(archive, 'data', 'validation-result.json'))).toBe(false);
    expect(existsSync(join(archive, 'data', 'private-token.txt'))).toBe(false);

    expect(readFileSync(join(root, 'prd.json'))).toEqual(nextPrd);
    expect(readFileSync(join(root, 'progress.md'))).toEqual(nextProgress);
    for (const path of [
      'state.json',
      'review-old.md',
      'final-review.json',
      'final-review.md',
      'review-decisions.json',
      'evidence.jsonl',
      'report.html',
      'prd.tampered-20260731-010101.json',
      'validation-result.json',
      'screenshots/old.png',
      'screenshots/nested/old.png',
    ]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
    expect(readFileSync(join(root, 'private-token.txt'), 'utf8')).toBe('must stay outside archive');
  });

  it('rederives the same feature while preserving progress, screenshots, and tamper evidence', async () => {
    const { root, session } = await fixture('apply-prd');
    writeOldRun(root, 'ralph/same-feature');
    const nextPrd = prd('ralph/same-feature', 'rederived');
    const nextState = Buffer.from('{}\n', 'utf8');
    const progressBefore = readFileSync(join(root, 'progress.md'));
    const request = applyRequest('rederive-feature', {
      prd: nextPrd,
      state: nextState,
      progress: null,
    });

    const committed = await runApplyPrdV1Mutation(session, request, APPLY_OPTIONS);
    const archive = await verifyMutationArchive(committed);

    expect(committed.manifest.archivePaths).toEqual([
      'evidence.jsonl',
      'final-review.json',
      'final-review.md',
      'prd.json',
      'review-decisions.json',
      'review-old.md',
      'state.json',
    ]);
    expect(existsSync(join(archive, 'data', 'report.html'))).toBe(false);
    expect(existsSync(join(archive, 'data', 'screenshots'))).toBe(false);
    expect(existsSync(join(archive, 'data', 'prd.tampered-20260731-010101.json'))).toBe(false);

    expect(readFileSync(join(root, 'prd.json'))).toEqual(nextPrd);
    expect(readFileSync(join(root, 'state.json'))).toEqual(nextState);
    expect(readFileSync(join(root, 'progress.md'))).toEqual(progressBefore);
    expect(readFileSync(join(root, 'screenshots', 'old.png'), 'utf8')).toBe('old screenshot');
    expect(readFileSync(join(root, 'prd.tampered-20260731-010101.json'), 'utf8')).toContain(
      'tampered',
    );
    for (const path of [
      'review-old.md',
      'final-review.json',
      'final-review.md',
      'review-decisions.json',
      'evidence.jsonl',
      'report.html',
      'validation-result.json',
    ]) {
      expect(existsSync(join(root, path)), path).toBe(false);
    }
  });

  it('rejects a stale source binding and a mode/branch mismatch before installing mutation state', async () => {
    const stale = await fixture('apply-prd');
    writeOldRun(stale.root);
    const staleRequest = applyRequest(
      'replace-feature',
      {
        prd: prd('ralph/new-feature', 'new'),
        state: null,
        progress: Buffer.from('# fresh\n'),
      },
      { staleSource: true },
    );
    await expect(runApplyPrdV1Mutation(stale.session, staleRequest, APPLY_OPTIONS)).rejects.toThrow(
      /source.*digest/i,
    );
    await expect(
      readCanonicalMutationDomain({
        workspace: stale.session.lease.workspace,
        expectedOwner: stale.session.lease.owner,
      }),
    ).rejects.toThrow();

    const callerSelectedPaths = {
      ...applyRequest('replace-feature', {
        prd: prd('ralph/new-feature', 'new'),
        state: null,
        progress: Buffer.from('# fresh\n'),
      }),
      archivePaths: ['private-token.txt'],
    } as ApplyPrdV1Request;
    await expect(
      runApplyPrdV1Mutation(stale.session, callerSelectedPaths, APPLY_OPTIONS),
    ).rejects.toThrow(/field|request.*invalid/i);

    const wrongMode = await fixture('apply-prd');
    writeOldRun(wrongMode.root, 'ralph/same-feature');
    const request = applyRequest('replace-feature', {
      prd: prd('ralph/same-feature', 'same'),
      state: null,
      progress: Buffer.from('# fresh\n'),
    });
    await expect(runApplyPrdV1Mutation(wrongMode.session, request, APPLY_OPTIONS)).rejects.toThrow(
      /mode|branch/i,
    );
  });

  it('rejects incomplete PRD and state candidates before any business write', async () => {
    const malformedPrd = await fixture('apply-prd');
    writeOldRun(malformedPrd.root);
    const originalPrd = readFileSync(join(malformedPrd.root, 'prd.json'));
    const incomplete = Buffer.from(
      `${JSON.stringify({
        branchName: 'ralph/new-feature',
        qualityContractDigest: QUALITY_DIGEST,
        qualityChecks: QUALITY.contract.checks,
      })}\n`,
    );
    await expect(
      runApplyPrdV1Mutation(
        malformedPrd.session,
        applyRequest('replace-feature', {
          prd: incomplete,
          state: null,
          progress: Buffer.from('# fresh\n'),
        }),
        APPLY_OPTIONS,
      ),
    ).rejects.toThrow(/missing|project|description|userStories/i);
    expect(readFileSync(join(malformedPrd.root, 'prd.json'))).toEqual(originalPrd);
    await expect(
      readCanonicalMutationDomain({
        workspace: malformedPrd.session.lease.workspace,
        expectedOwner: malformedPrd.session.lease.owner,
      }),
    ).rejects.toThrow();
    await expect(malformedPrd.session.close()).resolves.toContain('released-');

    const malformedState = await fixture('apply-prd');
    writeOldRun(malformedState.root, 'ralph/same-feature');
    await expect(
      runApplyPrdV1Mutation(
        malformedState.session,
        applyRequest('rederive-feature', {
          prd: prd('ralph/same-feature', 'rederived'),
          state: Buffer.from('{"ghost":true}\n'),
          progress: null,
        }),
        APPLY_OPTIONS,
      ),
    ).rejects.toThrow(/candidate\\.state|state story|schema/i);
    expect(readFileSync(join(malformedState.root, 'prd.json'), 'utf8')).toContain('"old"');
    await expect(
      readCanonicalMutationDomain({
        workspace: malformedState.session.lease.workspace,
        expectedOwner: malformedState.session.lease.owner,
      }),
    ).rejects.toThrow();
    await expect(malformedState.session.close()).resolves.toContain('released-');
  });

  it('honors a pending user interruption before installing mutation state', async () => {
    const { root, session } = await fixture('apply-prd');
    writeOldRun(root);
    const oldPrd = readFileSync(join(root, 'prd.json'));
    const controller = new AbortController();
    controller.abort();

    await expect(
      runApplyPrdV1Mutation(
        session,
        applyRequest('replace-feature', {
          prd: prd('ralph/new-feature', 'new'),
          state: null,
          progress: Buffer.from('# fresh\n'),
        }),
        {
          ...APPLY_OPTIONS,
          termination: { signal: controller.signal },
        },
      ),
    ).rejects.toThrow(/中断/u);
    expect(readFileSync(join(root, 'prd.json'))).toEqual(oldPrd);
    await expect(
      readCanonicalMutationDomain({
        workspace: session.lease.workspace,
        expectedOwner: session.lease.owner,
      }),
    ).rejects.toThrow();
    await expect(session.close()).resolves.toContain('released-');
  });

  it('rechecks the live Git head instead of trusting matching request fields', async () => {
    const { root, session } = await fixture('apply-prd');
    writeOldRun(root);
    const candidate = {
      prd: prd('ralph/new-feature', 'new'),
      state: null,
      progress: Buffer.from('# fresh\n'),
    };
    const request = applyRequest('replace-feature', candidate);
    const forgedHead = HEAD.startsWith('a') ? 'b'.repeat(40) : 'a'.repeat(40);
    const stale = {
      ...request,
      git: { expectedHead: forgedHead, currentHead: forgedHead },
    };

    await expect(runApplyPrdV1Mutation(session, stale, APPLY_OPTIONS)).rejects.toThrow(/Git HEAD/u);
    expect(readFileSync(join(root, 'prd.json'), 'utf8')).toContain('"old"');
    await expect(
      readCanonicalMutationDomain({
        workspace: session.lease.workspace,
        expectedOwner: session.lease.owner,
      }),
    ).rejects.toThrow();
    await expect(session.close()).resolves.toContain('released-');
  });

  it('rechecks repository source PRD bytes when the candidate names a source file', async () => {
    const { root, session } = await fixture('apply-prd');
    writeOldRun(root);
    const candidate = {
      prd: prd('ralph/new-feature', 'new', { sourcePrd: 'README.md' }),
      state: null,
      progress: Buffer.from('# fresh\n'),
    };

    await expect(
      runApplyPrdV1Mutation(session, applyRequest('replace-feature', candidate), APPLY_OPTIONS),
    ).rejects.toThrow(/sourcePrd changed/u);
    expect(readFileSync(join(root, 'prd.json'), 'utf8')).toContain('"old"');
    await expect(session.close()).resolves.toContain('released-');
  });

  it('reruns an enabled TDD baseline before installing any business mutation', async () => {
    const { root, session } = await fixture('apply-prd');
    writeOldRun(root);
    const candidate = {
      prd: prd('ralph/new-feature', 'new', {
        tdd: {
          coverageCheck: `${JSON.stringify(process.execPath)} -e "process.exit(9)"`,
          sourcePathspecs: ['src/**'],
          policyFiles: [],
          baselineRef: HEAD,
          forbiddenAddedPatterns: ['istanbul ignore'],
        },
      }),
      state: null,
      progress: Buffer.from('# fresh\n'),
    };

    await expect(
      runApplyPrdV1Mutation(session, applyRequest('replace-feature', candidate), APPLY_OPTIONS),
    ).rejects.toThrow(/TDD baseline.*failed/u);
    expect(readFileSync(join(root, 'prd.json'), 'utf8')).toContain('"old"');
    await expect(
      readCanonicalMutationDomain({
        workspace: session.lease.workspace,
        expectedOwner: session.lease.owner,
      }),
    ).rejects.toThrow();
    await expect(session.close()).resolves.toContain('released-');
  });

  it('rechecks every binding after a successful TDD command before installing mutation', async () => {
    const project = gitProject();
    const nextHead = execFileSync(
      'git',
      [
        'commit-tree',
        `${project.head}^{tree}`,
        '-p',
        project.head,
        '-m',
        'test: prebuilt TDD HEAD drift',
      ],
      {
        cwd: project.root,
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z',
          GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z',
        },
      },
    )
      .trim()
      .toLowerCase();
    const { root, session } = await fixture('apply-prd');
    writeOldRun(root);
    const candidate = {
      prd: prd('ralph/new-feature', 'new', {
        tdd: {
          coverageCheck: `git update-ref HEAD ${nextHead} ${project.head}`,
          sourcePathspecs: ['src/**'],
          policyFiles: [],
          baselineRef: project.head,
          forbiddenAddedPatterns: ['istanbul ignore'],
        },
      }),
      state: null,
      progress: Buffer.from('# fresh\n'),
    };

    await expect(
      runApplyPrdV1Mutation(
        session,
        applyRequest('replace-feature', candidate, { head: project.head }),
        { projectRoot: project.root, runtimeMode: 'formal' },
      ),
    ).rejects.toThrow(/Git HEAD no longer matches/u);
    expect(readGitHead(project.root)).toBe(nextHead);
    expect(readFileSync(join(root, 'prd.json'), 'utf8')).toContain('"old"');
    await expect(
      readCanonicalMutationDomain({
        workspace: session.lease.workspace,
        expectedOwner: session.lease.owner,
      }),
    ).rejects.toThrow();
    await expect(session.close()).resolves.toContain('released-');
  }, 10_000);

  it.each([
    {
      binding: 'Git HEAD',
      expected: /Git HEAD no longer matches/u,
      mutate: (projectRoot: string) => {
        execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'test: race head'], {
          cwd: projectRoot,
        });
      },
    },
    {
      binding: 'quality contract',
      expected: /quality contract changed/u,
      mutate: (projectRoot: string) => {
        const path = join(projectRoot, '.coding-x', 'quality.json');
        const contract = JSON.parse(readFileSync(path, 'utf8')) as {
          repository: { fullName: string };
        };
        contract.repository.fullName = 'fixture/changed-during-planning';
        writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
      },
    },
    {
      binding: 'source PRD',
      expected: /sourcePrd changed/u,
      mutate: (projectRoot: string) => {
        writeFileSync(join(projectRoot, 'source.txt'), '# changed during planning\n');
      },
    },
  ])(
    'rejects a $binding race during workspace planning before any business mutation is installed',
    async ({ expected, mutate }) => {
      const project = gitProject();
      const { root, session } = await fixture('apply-prd');
      writeOldRun(root);
      const oldPrd = readFileSync(join(root, 'prd.json'));
      const candidate = {
        prd: prd('ralph/new-feature', 'new', { sourcePrd: 'source.txt' }),
        state: null,
        progress: Buffer.from('# fresh\n'),
      };
      const originalVerify = session.lease.verify.bind(session.lease);
      let raced = false;
      const verify = vi.spyOn(session.lease, 'verify').mockImplementation(async () => {
        await originalVerify();
        if (!raced) {
          raced = true;
          mutate(project.root);
        }
      });

      try {
        await expect(
          runApplyPrdV1Mutation(
            session,
            applyRequest('replace-feature', candidate, { head: project.head }),
            { projectRoot: project.root, runtimeMode: 'formal' },
          ),
        ).rejects.toThrow(expected);
      } finally {
        verify.mockRestore();
      }

      expect(raced).toBe(true);
      expect(readFileSync(join(root, 'prd.json'))).toEqual(oldPrd);
      expect(readFileSync(join(root, 'progress.md'), 'utf8')).toBe('# old progress\n');
      await expect(
        readCanonicalMutationDomain({
          workspace: session.lease.workspace,
          expectedOwner: session.lease.owner,
        }),
      ).rejects.toThrow();
      await expect(session.close()).resolves.toContain('released-');
    },
  );
});

describe('fixed repair-v1 product mutation', () => {
  it('archives only the original prd/state and installs exact repaired JSON', async () => {
    const { root, session } = await fixture('repair');
    const oldPrd = Buffer.from('{"project":"broken",}\n');
    const oldState = Buffer.from('{"US-001":{"passes":false,},}\n');
    writeFileSync(join(root, 'prd.json'), oldPrd);
    writeFileSync(join(root, 'state.json'), oldState);
    writeFileSync(join(root, 'private-token.txt'), 'not selected');
    writeFileSync(join(root, 'validation-result.json'), '{"keep":"repair does not own this"}\n');

    const committed = await runRepairV1Mutation(session, {
      schemaVersion: 1,
      source: {
        prdDigest: digestBytes(oldPrd),
        stateDigest: digestBytes(oldState),
      },
      candidate: {
        prd: Buffer.from('{"project":"repaired"}\n'),
        state: Buffer.from('{"US-001":{"passes":false}}\n'),
      },
    });
    const archive = await verifyMutationArchive(committed);

    expect(committed.state.kind).toBe('repair-v1');
    expect(committed.manifest.archivePaths).toEqual(['prd.json', 'state.json']);
    expect(readFileSync(join(archive, 'data', 'prd.json'))).toEqual(oldPrd);
    expect(readFileSync(join(archive, 'data', 'state.json'))).toEqual(oldState);
    expect(existsSync(join(archive, 'data', 'private-token.txt'))).toBe(false);
    expect(readFileSync(join(root, 'prd.json'), 'utf8')).toBe('{"project":"repaired"}\n');
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('{"US-001":{"passes":false}}\n');
    expect(readFileSync(join(root, 'private-token.txt'), 'utf8')).toBe('not selected');
    expect(readFileSync(join(root, 'validation-result.json'), 'utf8')).toContain(
      'repair does not own this',
    );
  });

  it('rejects a repaired candidate that is not strict JSON before any mutation is installed', async () => {
    const { root, session } = await fixture('repair');
    writeFileSync(join(root, 'prd.json'), '{"broken":}\n');

    await expect(
      runRepairV1Mutation(session, {
        schemaVersion: 1,
        source: { prdDigest: `sha256:${'0'.repeat(64)}`, stateDigest: null },
        candidate: { prd: Buffer.from('{"still":}\n'), state: null },
      }),
    ).rejects.toThrow(/JSON|parse/i);
    await expect(
      readCanonicalMutationDomain({
        workspace: session.lease.workspace,
        expectedOwner: session.lease.owner,
      }),
    ).rejects.toThrow();
  });

  it('repairs a workspace without state while preserving its explicit absence', async () => {
    const { root, session } = await fixture('repair');
    const oldPrd = Buffer.from('{"project":"broken",}\n');
    writeFileSync(join(root, 'prd.json'), oldPrd);

    const committed = await runRepairV1Mutation(session, {
      schemaVersion: 1,
      source: { prdDigest: digestBytes(oldPrd), stateDigest: null },
      candidate: { prd: Buffer.from('{"project":"repaired"}\n'), state: null },
    });
    const archive = await verifyMutationArchive(committed);

    expect(readFileSync(join(archive, 'data', 'prd.json'))).toEqual(oldPrd);
    expect(existsSync(join(archive, 'data', 'state.json'))).toBe(false);
    expect(existsSync(join(root, 'state.json'))).toBe(false);
  });
});
