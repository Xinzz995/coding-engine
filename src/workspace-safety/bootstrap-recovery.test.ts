import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from './workspace-authority-test-seam.js';
import { readExactFile } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import {
  captureBootstrapRecoverySourceSnapshotDigest,
  evaluateBootstrapRecoveryDiskState,
  verifyBootstrapRecoveryArchive,
} from './recovery.js';
import {
  acquireBootstrapRecoveryAttemptWithAuthority as acquireBootstrapRecoveryAttempt,
  finalizeBootstrapRecoveryWithAuthority as finalizeBootstrapRecovery,
  installBootstrapRecoveryDomainWithAuthority as installBootstrapRecoveryDomain,
  evaluateBootstrapRecoveryDiskStateWithAuthority,
} from './recovery-authority-test-seam.js';
import {
  ACTIVE_LEASE_DIR,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  WORKSPACE_MARKER_FILE,
  type ProcessIdentitySnapshot,
} from './types.js';

const RECOVERY_ID = '00000000-0000-4000-8000-0000000000d1';
const ATTEMPT_A = '00000000-0000-4000-8000-0000000000e1';
const ATTEMPT_B = '00000000-0000-4000-8000-0000000000e2';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryWorkspace(): string {
  const workspace = mkdtempSync(join(tmpdir(), 'bootstrap-recovery-'));
  roots.push(workspace);
  return workspace;
}

function deadIdentity(): ProcessIdentitySnapshot {
  const current = createIdentityProbe().current();
  return { ...current, pid: 2_000_000_000 };
}

async function unfinishedBootstrap(stage: 'root' | 'marker' = 'root'): Promise<string> {
  const workspace = temporaryWorkspace();
  await expect(
    bootstrapWorkspace({
      workspacePath: workspace,
      identity: deadIdentity(),
      ownerId: '00000000-0000-4000-8000-000000000001',
      now: () => new Date('2026-07-30T00:00:00.000Z'),
      hooks:
        stage === 'root'
          ? { afterProtocolRootInstalled: () => Promise.reject(new Error('crash-after-root')) }
          : { afterMarkerInstalled: () => Promise.reject(new Error('crash-after-marker')) },
    }),
  ).rejects.toThrow(/crash-after/);
  return workspace;
}

async function installFirstAttempt(
  workspace: string,
  identity: ProcessIdentitySnapshot = createIdentityProbe().current(),
) {
  const sourceSnapshotDigest = await captureBootstrapRecoverySourceSnapshotDigest(workspace);
  return await installBootstrapRecoveryDomain({
    workspacePath: workspace,
    expectedSourceSnapshotDigest: sourceSnapshotDigest,
    recoveryId: RECOVERY_ID,
    attemptId: ATTEMPT_A,
    identity,
    probeSourceOwner: () => 'dead',
    now: () => new Date('2026-07-30T00:10:00.000Z'),
  });
}

describe('bootstrap-complete recovery', () => {
  it('installs the exact missing marker and archives the bootstrap lease as its final write', async () => {
    const workspace = await unfinishedBootstrap();
    const attemptIdentity = { ...deadIdentity(), pid: 2_000_000_001 };
    expect(
      await evaluateBootstrapRecoveryDiskStateWithAuthority(workspace, () => 'dead'),
    ).toMatchObject({
      classification: 'recoverable',
      markerState: 'missing',
    });

    const handle = await installFirstAttempt(workspace, attemptIdentity);
    expect(
      await evaluateBootstrapRecoveryDiskStateWithAuthority(workspace, () => 'dead'),
    ).toMatchObject({
      classification: 'recovering',
      phase: 'claimed',
    });
    const completed = await finalizeBootstrapRecovery(handle, {
      attemptIdentity,
      probeSourceOwner: () => 'dead',
      now: () => new Date('2026-07-30T00:20:00.000Z'),
    });

    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(true);
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
    await expect(
      verifyBootstrapRecoveryArchive({
        workspacePath: workspace,
        targetArchive: completed.targetArchive,
      }),
    ).resolves.toEqual(completed);
  });

  it('only revalidates an already complete marker and preserves its exact file identity', async () => {
    const workspace = await unfinishedBootstrap('marker');
    const markerPath = join(workspace, WORKSPACE_MARKER_FILE);
    const beforeBytes = await readExactFile(markerPath);
    const before = statSync(markerPath, { bigint: true });
    const handle = await installFirstAttempt(workspace);

    const completed = await finalizeBootstrapRecovery(handle, {
      probeSourceOwner: () => 'dead',
      now: () => new Date('2026-07-30T00:20:00.000Z'),
    });

    const afterBytes = await readExactFile(markerPath);
    const after = statSync(markerPath, { bigint: true });
    expect(afterBytes).toEqual(beforeBytes);
    expect(after.ino).toBe(before.ino);
    expect(after.mtimeNs).toBe(before.mtimeNs);
    await expect(
      verifyBootstrapRecoveryArchive({
        workspacePath: workspace,
        targetArchive: completed.targetArchive,
      }),
    ).resolves.toEqual(completed);
  });

  it('treats partial canonical or staged marker bytes as invalid without installing recovery', async () => {
    const canonical = await unfinishedBootstrap();
    writeFileSync(join(canonical, WORKSPACE_MARKER_FILE), '{"schemaVersion":2');
    await expect(captureBootstrapRecoverySourceSnapshotDigest(canonical)).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(existsSync(join(canonical, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, RECOVERY_DIR))).toBe(
      false,
    );

    const staged = await unfinishedBootstrap();
    const input = join(staged, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, 'bootstrap-input');
    mkdirSync(input);
    writeFileSync(join(input, WORKSPACE_MARKER_FILE), '{"schemaVersion":2');
    await expect(captureBootstrapRecoverySourceSnapshotDigest(staged)).rejects.toMatchObject({
      code: 'invalid',
    });
  });

  it('keeps the immutable source binding across a replacement attempt', async () => {
    const workspace = await unfinishedBootstrap();
    await installFirstAttempt(workspace);
    writeFileSync(
      join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, 'unexpected-business.json'),
      '{}\n',
    );

    await expect(
      acquireBootstrapRecoveryAttempt({
        workspacePath: workspace,
        attemptId: ATTEMPT_B,
        identity: createIdentityProbe().current(),
        probeSourceOwner: () => 'dead',
        probeAttemptOwner: () => 'dead',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
  });

  it('rejects a stale initial source digest before creating recovery staging', async () => {
    const workspace = await unfinishedBootstrap();
    await expect(
      installBootstrapRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: `sha256:${'f'.repeat(64)}`,
        identity: createIdentityProbe().current(),
        probeSourceOwner: () => 'dead',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(
      readdirSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR)).filter((entry) =>
        entry.startsWith('recovery.prepare-'),
      ),
    ).toEqual([]);
  });

  it('moves one dead attempt aside without changing the immutable claim or source', async () => {
    const workspace = await unfinishedBootstrap();
    await installFirstAttempt(workspace);
    const recoveryPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, RECOVERY_DIR);
    const claimBefore = readFileSync(join(recoveryPath, 'claim.json'));
    const stateBefore = readFileSync(join(recoveryPath, 'state.json'));
    const sourceBefore = await captureBootstrapRecoverySourceSnapshotDigest(workspace);

    const replacement = await acquireBootstrapRecoveryAttempt({
      workspacePath: workspace,
      attemptId: ATTEMPT_B,
      identity: createIdentityProbe().current(),
      probeSourceOwner: () => 'dead',
      probeAttemptOwner: () => 'dead',
    });

    expect(readFileSync(join(recoveryPath, 'claim.json'))).toEqual(claimBefore);
    expect(readFileSync(join(recoveryPath, 'state.json'))).toEqual(stateBefore);
    expect(await captureBootstrapRecoverySourceSnapshotDigest(workspace)).toBe(sourceBefore);
    expect(
      readdirSync(join(recoveryPath, 'attempts')).filter((entry) => entry.startsWith('abandoned-')),
    ).toHaveLength(1);
    await expect(replacement.verify()).resolves.toBeUndefined();
  });
});

interface Worker {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
}

function startWorker(workspace: string, mode: string, barrier?: string): Worker {
  const fixture = fileURLToPath(
    new URL('./__fixtures__/bootstrap-recovery-worker.ts', import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ['--import=tsx', fixture, mode, workspace, ...(barrier ? [barrier] : [])],
    { stdio: ['pipe', 'pipe', 'pipe'] },
  );
  let output = '';
  const ready = new Promise<void>((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (output.includes('READY:')) resolve();
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (!output.includes('READY:')) {
        reject(new Error(`worker exited ${code}: ${child.stderr.read() ?? ''}`));
      }
    });
  });
  return { child, ready };
}

async function hardKill(worker: Worker): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    worker.child.once('error', reject);
    worker.child.once('close', () => resolve());
  });
  worker.child.kill('SIGKILL');
  await closed;
}

async function realCrashedBootstrap(
  mode: 'bootstrap-root' | 'bootstrap-linked' = 'bootstrap-root',
): Promise<string> {
  const workspace = temporaryWorkspace();
  const worker = startWorker(workspace, mode);
  await worker.ready;
  await hardKill(worker);
  return workspace;
}

describe('bootstrap recovery real hard-crash barriers', () => {
  it.each([
    ['before-marker', false, 'claimed'],
    ['linked-marker', true, 'claimed'],
    ['after-marker', true, 'claimed'],
    ['linked-final-manifest', true, 'verified'],
    ['before-final-rename', true, 'finalizing'],
  ] as const)(
    'resumes after a real process hard crash at %s',
    async (barrier, markerExpected, expectedPhase) => {
      const workspace = await realCrashedBootstrap();
      const recovery = startWorker(workspace, 'recover', barrier);
      await recovery.ready;
      await hardKill(recovery);

      expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(markerExpected);
      if (barrier === 'linked-marker') {
        expect(statSync(join(workspace, WORKSPACE_MARKER_FILE), { bigint: true }).nlink).toBe(2n);
      }
      if (barrier === 'linked-final-manifest') {
        expect(
          statSync(
            join(
              workspace,
              PROTOCOL_ROOT_DIR,
              ACTIVE_LEASE_DIR,
              RECOVERY_DIR,
              'final-manifest.json',
            ),
            { bigint: true },
          ).nlink,
        ).toBe(2n);
      }
      expect(await evaluateBootstrapRecoveryDiskState(workspace)).toMatchObject({
        classification: 'recovering',
        sourceOwnerVerdict: 'dead',
        phase: expectedPhase,
      });

      const resumed = await acquireBootstrapRecoveryAttempt({
        workspacePath: workspace,
        identity: createIdentityProbe().current(),
      });
      const completed = await finalizeBootstrapRecovery(resumed);
      await expect(
        verifyBootstrapRecoveryArchive({
          workspacePath: workspace,
          targetArchive: completed.targetArchive,
        }),
      ).resolves.toEqual(completed);
    },
    30_000,
  );

  it('recovers a real bootstrap writer killed in the controlled linked-file window', async () => {
    const workspace = await realCrashedBootstrap('bootstrap-linked');
    expect(statSync(join(workspace, WORKSPACE_MARKER_FILE), { bigint: true }).nlink).toBe(2n);
    expect(await evaluateBootstrapRecoveryDiskState(workspace)).toMatchObject({
      classification: 'recoverable',
      markerState: 'linked-incomplete',
      sourceOwnerVerdict: 'dead',
    });
    const sourceSnapshotDigest = await captureBootstrapRecoverySourceSnapshotDigest(workspace);
    const handle = await installBootstrapRecoveryDomain({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: sourceSnapshotDigest,
      identity: createIdentityProbe().current(),
    });
    const completed = await finalizeBootstrapRecovery(handle);
    expect(statSync(join(workspace, WORKSPACE_MARKER_FILE), { bigint: true }).nlink).toBe(1n);
    await expect(
      verifyBootstrapRecoveryArchive({
        workspacePath: workspace,
        targetArchive: completed.targetArchive,
      }),
    ).resolves.toEqual(completed);
  });

  it.each(['extra-hardlink', 'wrong-bytes'] as const)(
    'rejects an unsafe bootstrap marker install window: %s',
    async (failure) => {
      const workspace = await realCrashedBootstrap('bootstrap-linked');
      const markerPath = join(workspace, WORKSPACE_MARKER_FILE);
      if (failure === 'extra-hardlink') {
        linkSync(markerPath, join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, 'third-link'));
      } else {
        writeFileSync(markerPath, '{"wrong":true}\n');
      }

      await expect(evaluateBootstrapRecoveryDiskState(workspace)).rejects.toMatchObject({
        code: 'invalid',
      });
      expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
    },
  );

  it.each(['wrong-source', 'extra-link', 'wrong-bytes'] as const)(
    'rejects an unsafe bootstrap final-manifest link window: %s',
    async (failure) => {
      const workspace = await realCrashedBootstrap();
      const recovery = startWorker(workspace, 'recover', 'linked-final-manifest');
      await recovery.ready;
      await hardKill(recovery);
      const leasePath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
      const target = join(leasePath, RECOVERY_DIR, 'final-manifest.json');
      const source = readdirSync(leasePath)
        .filter((entry) => entry.startsWith('recovery.prepare-'))
        .map((entry) => join(leasePath, entry, 'final-manifest.json'))
        .find((path) => existsSync(path) && statSync(path, { bigint: true }).nlink === 2n)!;
      expect(source).toBeDefined();
      if (failure === 'wrong-source') {
        renameSync(source, join(source, '..', 'unknown.json'));
      } else if (failure === 'extra-link') {
        linkSync(target, join(source, '..', 'extra-link.json'));
      } else {
        writeFileSync(target, '{"wrong":true}\n');
      }

      await expect(evaluateBootstrapRecoveryDiskState(workspace)).rejects.toMatchObject({
        code: 'invalid',
      });
      expect(existsSync(leasePath)).toBe(true);
    },
    30_000,
  );
});
