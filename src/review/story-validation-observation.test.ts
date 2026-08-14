import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { acceptanceHash } from '../contracts/validation-contract.js';
import { CODING_X_VERSION } from '../version.js';
import type { RunState } from '../contracts/run-state-contract.js';
import type { Prd, TddConfig } from '../engine/prd.js';
import {
  bindStoryValidationRuntimeIdentity,
  digestCandidateStoryValidationEnvironment,
} from '../engine/story-validation-currentness.js';
import type { QualityContract, QualityContractReadResult } from '../quality/contract.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import {
  observeStoryValidationCurrentnessControlled,
  readStoryValidationAuthorityBytes,
  readWorkingQualityContractAuthority,
  STORY_VALIDATION_AUTHORITY_MAX_BYTES,
  type StoryValidationFileSnapshot,
  type StoryValidationObservationReaders,
} from './story-validation-observation.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const DEFAULT_BRANCH_HEAD = 'e'.repeat(40);
const STORY_BASE_HEAD = 'f'.repeat(40);
const QUALITY_A = `sha256:${'c'.repeat(64)}`;
const QUALITY_B = `sha256:${'d'.repeat(64)}`;
const FORMAL_RUNTIME = {
  mode: 'formal',
  actualCodingXVersion: CODING_X_VERSION,
} as const;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function authorityFile(name = 'prd.json'): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'story-validation-authority-'));
  roots.push(root);
  return { root, path: join(root, name) };
}

const contract = {
  checks: {
    test: { notApplicable: 'fixture' },
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
  },
  generatedPaths: [],
  localValidation: { prepare: [], allowedPaths: [] },
  repository: { defaultBranch: 'main' },
} as unknown as QualityContract;

function contractRead(digest = QUALITY_A): QualityContractReadResult {
  return {
    status: 'ready',
    path: '/project/.coding-x/quality.json',
    contract,
    digest,
  };
}

function prd(title = 'Story'): Prd {
  return {
    project: 'fixture',
    branchName: 'feature/observer',
    description: 'fixture',
    qualityContractDigest: QUALITY_A,
    qualityChecks: structuredClone(contract.checks),
    userStories: [
      {
        id: 'US-001',
        title,
        description: 'Description',
        acceptanceCriteria: ['works'],
        priority: 1,
      },
    ],
  };
}

function state(
  notes = '',
  environment = digestCandidateStoryValidationEnvironment({
    contract,
    headSha: HEAD_A,
    defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
    tddConfig: null,
    runtimeIdentity: FORMAL_RUNTIME,
    platform: 'linux',
  }),
): RunState {
  return {
    'US-001': {
      passes: true,
      validated: true,
      validationReceipt: {
        schemaVersion: 4,
        requestId: 'request-1',
        gitHead: HEAD_A,
        acceptanceHash: acceptanceHash('US-001', ['works']),
        validationEnvironmentDigest: environment,
        runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
        canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
        storyBaseGitHead: STORY_BASE_HEAD,
        changeManifestDigest: `sha256:${'f'.repeat(64)}`,
        changedPathCount: 1,
      },
      storyBaseGitHead: STORY_BASE_HEAD,
      notes,
      retryCount: 0,
      blocked: false,
      escalated: false,
    },
  };
}

const disabledTdd = { status: 'disabled' as const };
const enabledTdd: { status: 'enabled'; config: TddConfig } = {
  status: 'enabled',
  config: {
    coverageCheck: 'test',
    sourcePathspecs: ['src/**'],
    policyFiles: [],
    baselineRef: HEAD_A,
    forbiddenAddedPatterns: ['istanbul ignore'],
  },
};

function file<T>(value: T, fingerprint: string): StoryValidationFileSnapshot<T> {
  return { status: 'ready', value, fingerprint };
}

function sequence<T>(before: T, after: T): () => T {
  let calls = 0;
  return () => (calls++ === 0 ? before : after);
}

function fakeSession(): WorkspaceSession {
  return { writer: { workspacePath: '/workspace' } } as unknown as WorkspaceSession;
}

interface ReaderChanges {
  head?: [string | null, string | null];
  defaultBranchHead?: [string | null, string | null];
  prd?: [StoryValidationFileSnapshot<Prd>, StoryValidationFileSnapshot<Prd>];
  state?: [StoryValidationFileSnapshot<RunState>, StoryValidationFileSnapshot<RunState>];
  working?: [QualityContractReadResult, QualityContractReadResult];
  tracked?: [QualityContractReadResult, QualityContractReadResult];
  tdd?: [typeof disabledTdd | typeof enabledTdd, typeof disabledTdd | typeof enabledTdd];
}

function readers(changes: ReaderChanges = {}): StoryValidationObservationReaders {
  const readHead = sequence(...(changes.head ?? [HEAD_A, HEAD_A]));
  const readDefaultBranchHead = sequence(
    ...(changes.defaultBranchHead ?? [DEFAULT_BRANCH_HEAD, DEFAULT_BRANCH_HEAD]),
  );
  const readPrd = sequence(...(changes.prd ?? [file(prd(), 'prd-a'), file(prd(), 'prd-a')]));
  const readState = sequence(
    ...(changes.state ?? [file(state(), 'state-a'), file(state(), 'state-a')]),
  );
  const readWorking = sequence(...(changes.working ?? [contractRead(), contractRead()]));
  const readTracked = sequence(...(changes.tracked ?? [contractRead(), contractRead()]));
  const readTdd = sequence(...(changes.tdd ?? [disabledTdd, disabledTdd]));
  return {
    readHead: vi.fn(readHead),
    readDefaultBranchHead: vi.fn(async () => readDefaultBranchHead()),
    readPrd: vi.fn(readPrd),
    readState: vi.fn(readState),
    readWorkingContract: vi.fn(readWorking),
    readTrackedContract: vi.fn(async () => readTracked()),
    readTdd: vi.fn(readTdd),
  };
}

const options = () => ({
  projectRoot: '/project',
  session: fakeSession(),
  platform: 'linux' as const,
  runtimeIdentity: FORMAL_RUNTIME,
});

describe('observeStoryValidationCurrentnessControlled', () => {
  it('returns one stable token only after every authority is read twice', async () => {
    const source = readers();
    const result = await observeStoryValidationCurrentnessControlled(options(), source);

    expect(result).toMatchObject({
      status: 'ready',
      observationToken: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      authorityInputDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      storyValidationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
    expect(source.readHead).toHaveBeenCalledTimes(2);
    expect(source.readPrd).toHaveBeenCalledTimes(2);
    expect(source.readState).toHaveBeenCalledTimes(2);
    expect(source.readWorkingContract).toHaveBeenCalledTimes(2);
    expect(source.readTrackedContract).toHaveBeenCalledTimes(2);
    expect(source.readTdd).toHaveBeenCalledTimes(2);
  });

  it('keeps the existing Loop fixed-digest test seam without weakening production reads', async () => {
    const fixedDigest = `sha256:${'e'.repeat(64)}`;
    const boundDigest = bindStoryValidationRuntimeIdentity(fixedDigest, FORMAL_RUNTIME);
    const fixedState = file(state('', boundDigest), 'state-fixed');
    const result = await observeStoryValidationCurrentnessControlled(
      { ...options(), validationEnvironmentDigestForTests: fixedDigest },
      readers({ state: [fixedState, fixedState] }),
    );

    expect(result).toMatchObject({
      status: 'ready',
      storyValidationEnvironmentDigest: boundDigest,
      storyValidationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it.each([
    ['HEAD', { head: [HEAD_A, HEAD_B] }],
    ['PRD', { prd: [file(prd(), 'prd-a'), file(prd('Changed title'), 'prd-b')] }],
    ['state', { state: [file(state(), 'state-a'), file(state('changed'), 'state-b')] }],
    ['working contract', { working: [contractRead(), contractRead(QUALITY_B)] }],
    ['tracked contract', { tracked: [contractRead(), contractRead(QUALITY_B)] }],
    ['TDD', { tdd: [disabledTdd, enabledTdd] }],
  ] as const)('rejects a torn %s observation', async (_name, changes) => {
    const result = await observeStoryValidationCurrentnessControlled(
      options(),
      readers(changes as ReaderChanges),
    );

    expect(result).toMatchObject({
      status: 'unverifiable',
      reason: 'observation-drift',
      observationToken: null,
      storyValidationEnvironmentDigest: null,
      storyValidationDigest: null,
      display: {
        state: { 'US-001': { validated: false, validationReceipt: null } },
      },
    });
  });

  it('changes the stable token for a PRD-only change between independent observations', async () => {
    const first = await observeStoryValidationCurrentnessControlled(options(), readers());
    const changedPrd = file(prd('Changed title only'), 'prd-b');
    const second = await observeStoryValidationCurrentnessControlled(
      options(),
      readers({ prd: [changedPrd, changedPrd] }),
    );

    expect(first.status).toBe('ready');
    expect(second.status).toBe('ready');
    expect(second.observationToken).not.toBe(first.observationToken);
    expect(second.storyValidationDigest).toBe(first.storyValidationDigest);
  });
});

describe('readStoryValidationAuthorityBytes', () => {
  it('reads one bounded stable ordinary file', () => {
    const target = authorityFile();
    writeFileSync(target.path, '{"project":"fixture"}');

    expect(readStoryValidationAuthorityBytes(target.path)).toMatchObject({
      status: 'ready',
      bytes: Buffer.from('{"project":"fixture"}'),
      fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
    });
  });

  it.runIf(process.platform !== 'win32')('rejects a symbolic link without following it', () => {
    const target = authorityFile();
    const outside = join(target.root, 'outside.json');
    writeFileSync(outside, '{}');
    symlinkSync(outside, target.path);

    expect(readStoryValidationAuthorityBytes(target.path)).toMatchObject({
      status: 'invalid',
      diagnostic: expect.stringContaining('不是独立普通文件'),
    });
  });

  it.runIf(process.platform !== 'win32')('rejects a FIFO without blocking', () => {
    const target = authorityFile('state.json');
    execFileSync('mkfifo', [target.path]);

    expect(readStoryValidationAuthorityBytes(target.path)).toMatchObject({
      status: 'invalid',
      diagnostic: expect.stringContaining('不是独立普通文件'),
    });
  });

  it('rejects an authority file above the public byte limit before reading it', () => {
    const target = authorityFile('state.json');
    writeFileSync(target.path, Buffer.alloc(STORY_VALIDATION_AUTHORITY_MAX_BYTES + 1));

    expect(readStoryValidationAuthorityBytes(target.path)).toMatchObject({
      status: 'invalid',
      diagnostic: expect.stringContaining(`超过 ${STORY_VALIDATION_AUTHORITY_MAX_BYTES} bytes`),
    });
  });

  it('rejects a path replacement after acquiring the file handle', () => {
    const target = authorityFile('state.json');
    const displaced = join(target.root, 'state-original.json');
    writeFileSync(target.path, '{"value":"before"}');

    const result = readStoryValidationAuthorityBytes(target.path, {
      afterOpen: () => {
        renameSync(target.path, displaced);
        writeFileSync(target.path, '{"value":"after"}');
      },
    });

    expect(result).toMatchObject({
      status: 'invalid',
      diagnostic: expect.stringContaining('身份在打开期间发生变化'),
    });
  });
});

describe('readWorkingQualityContractAuthority', () => {
  it.runIf(process.platform !== 'win32')('rejects a FIFO contract without blocking', () => {
    const target = authorityFile('quality.json');
    const contractDirectory = join(target.root, '.coding-x');
    const contractPath = join(contractDirectory, 'quality.json');
    mkdirSync(contractDirectory, { recursive: true });
    execFileSync('mkfifo', [contractPath]);

    expect(readWorkingQualityContractAuthority(target.root)).toMatchObject({
      status: 'io-error',
      error: expect.stringContaining('不是独立普通文件'),
    });
  });

  it('rejects an oversized contract before parsing it', () => {
    const target = authorityFile('quality.json');
    const contractDirectory = join(target.root, '.coding-x');
    mkdirSync(contractDirectory, { recursive: true });
    writeFileSync(
      join(contractDirectory, 'quality.json'),
      Buffer.alloc(STORY_VALIDATION_AUTHORITY_MAX_BYTES + 1),
    );

    expect(readWorkingQualityContractAuthority(target.root)).toMatchObject({
      status: 'io-error',
      error: expect.stringContaining(`超过 ${STORY_VALIDATION_AUTHORITY_MAX_BYTES} bytes`),
    });
  });
});
