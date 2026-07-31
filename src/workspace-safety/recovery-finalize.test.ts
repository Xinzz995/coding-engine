import { fork, type ChildProcess } from 'node:child_process';
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
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { digestBytes } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import {
  captureRecoverySourceSnapshotDigest,
  createRecoveryFinalManifestBytes,
  readRecoveryDomain,
  verifyMechanicalEmptyRecoveryArchive,
  type RecoveryAttemptHandle,
} from './recovery.js';
import type { RecoveryFinalizationHooks } from './recovery-finalize.js';
import {
  acquireRecoveryAttemptWithAuthority as acquireRecoveryAttempt,
  createRecoverySessionWithAuthority,
  finalizeMechanicalEmptyRecoveryWithAuthority as finalizeMechanicalEmptyRecovery,
  installRecoveryDomainWithAuthority as installRecoveryDomain,
} from './recovery-authority-test-seam.js';
import {
  acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease,
  bootstrapWorkspaceWithAuthority as bootstrapWorkspace,
} from './workspace-authority-test-seam.js';
import {
  ACTIVE_LEASE_DIR,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  WORKSPACE_MARKER_FILE,
  type ProcessIdentitySnapshot,
} from './types.js';

const RECOVERY_ID = '00000000-0000-4000-8000-0000000000a1';
const ATTEMPT_A = '00000000-0000-4000-8000-0000000000b1';
const ATTEMPT_B = '00000000-0000-4000-8000-0000000000b2';
const ATTEMPT_C = '00000000-0000-4000-8000-0000000000b3';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const TIMESTAMP = '2026-07-30T00:10:00.000Z';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
});

function temporaryDirectory(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

async function workspaceWithDeadOwner(): Promise<string> {
  const workspace = temporaryDirectory('workspace-recovery-finalize-');
  const current = createIdentityProbe().current();
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity: current,
    ownerId: '00000000-0000-4000-8000-000000000001',
  });
  await acquireWorkspaceLease({
    workspacePath: workspace,
    identity: { ...current, pid: 2_000_000_000 },
    ownerId: '00000000-0000-4000-8000-000000000002',
    command: 'run',
  });
  return workspace;
}

async function installMechanicalRecovery(
  attemptIdentity: ProcessIdentitySnapshot = createIdentityProbe().current(),
): Promise<{ workspace: string; handle: RecoveryAttemptHandle }> {
  const workspace = await workspaceWithDeadOwner();
  const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
  const handle = await installRecoveryDomain({
    workspacePath: workspace,
    expectedSourceSnapshotDigest: sourceSnapshotDigest,
    recoveryId: RECOVERY_ID,
    attemptId: ATTEMPT_A,
    identity: attemptIdentity,
    mode: 'mechanical-empty',
    now: () => new Date(TIMESTAMP),
  });
  return { workspace, handle };
}

async function takeOver(workspace: string, attemptId: string): Promise<RecoveryAttemptHandle> {
  return await acquireRecoveryAttempt({
    workspacePath: workspace,
    attemptId,
    identity: createIdentityProbe().current(),
    probeAttemptOwner: () => 'dead',
    now: () => new Date(TIMESTAMP),
  });
}

function activeLeasePath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
}

function deferred(): { readonly promise: Promise<void>; readonly resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

describe('mechanical-empty recovery finalization', () => {
  it('coalesces two finalization calls for the same attempt into one commit', async () => {
    const { workspace, handle } = await installMechanicalRecovery();
    const session = createRecoverySessionWithAuthority(handle, {
      now: () => new Date('2026-07-30T00:20:00.000Z'),
    });
    const first = session.finalize();
    const second = session.finalize();

    expect(second).toBe(first);
    const [left, right] = await Promise.all([first, second]);
    expect(right).toEqual(left);
    expect(session.state).toBe('ready');
    await expect(
      verifyMechanicalEmptyRecoveryArchive({
        workspacePath: workspace,
        targetArchive: left.targetArchive,
      }),
    ).resolves.toEqual(left);
  });

  it('preserves finalizing recovery when interrupt wins before the final rename', async () => {
    const { workspace, handle } = await installMechanicalRecovery();
    const reachedRename = deferred();
    const releaseRename = deferred();
    const session = createRecoverySessionWithAuthority(handle, {
      now: () => new Date(TIMESTAMP),
      hooks: {
        beforeFinalRename: async () => {
          reachedRename.resolve();
          await releaseRename.promise;
        },
      },
    });
    const finalization = session.finalize();
    await reachedRename.promise;
    const interrupt = session.requestInterrupt();
    releaseRename.resolve();

    await expect(finalization).rejects.toMatchObject({ code: 'closed' });
    await expect(interrupt).resolves.toEqual({
      status: 'preserved',
      reason: 'user-interrupt',
    });
    expect(session.state).toBe('preserved');
    const domain = await readRecoveryDomain(workspace);
    expect(domain.state.phase).toBe('finalizing');
    expect(existsSync(activeLeasePath(workspace))).toBe(true);
    expect(existsSync(join(workspace, ...domain.claim.targetArchive.split('/')))).toBe(false);
  });

  it('reports ready when interrupt arrives after the final rename', async () => {
    const { workspace, handle } = await installMechanicalRecovery();
    const session = createRecoverySessionWithAuthority(handle, {
      now: () => new Date(TIMESTAMP),
    });
    const completion = await session.finalize();

    await expect(session.requestInterrupt()).resolves.toEqual({
      status: 'ready',
      reason: 'user-interrupt',
      completion,
    });
    expect(session.state).toBe('ready');
    expect(existsSync(activeLeasePath(workspace))).toBe(false);
    await expect(
      verifyMechanicalEmptyRecoveryArchive({
        workspacePath: workspace,
        targetArchive: completion.targetArchive,
      }),
    ).resolves.toEqual(completion);
  });

  it('commits claimed through verified and finalizing, then archives the whole active lease', async () => {
    const attemptIdentity = { ...createIdentityProbe().current(), pid: 2_000_000_001 };
    const { workspace, handle } = await installMechanicalRecovery(attemptIdentity);
    writeFileSync(join(workspace, 'business.txt'), 'unchanged');

    const completion = await finalizeMechanicalEmptyRecovery(handle, {
      attemptIdentity,
      probeSourceOwner: () => 'dead',
      now: () => new Date(TIMESTAMP),
    });

    expect(existsSync(activeLeasePath(workspace))).toBe(false);
    expect(existsSync(completion.archivePath)).toBe(true);
    expect(readFileSync(join(workspace, 'business.txt'), 'utf8')).toBe('unchanged');
    const verified = await verifyMechanicalEmptyRecoveryArchive({
      workspacePath: workspace,
      targetArchive: completion.targetArchive,
    });
    expect(verified).toEqual(completion);
    await expect(handle.verify()).rejects.toMatchObject({ code: 'lease-lost' });
  });

  it.each([
    ['afterVerified', 'verified', false, ATTEMPT_B],
    ['afterFinalManifestInstalled', 'verified', true, ATTEMPT_B],
    ['afterFinalizing', 'finalizing', true, ATTEMPT_C],
  ] as const)(
    'resumes exactly after a crash at %s with a replacement attempt owner',
    async (hookName, expectedPhase, manifestExists, replacementAttempt) => {
      const { workspace, handle } = await installMechanicalRecovery();
      const hooks = {
        [hookName]: () => Promise.reject(new Error(`crash-${hookName}`)),
      } as RecoveryFinalizationHooks;

      await expect(
        finalizeMechanicalEmptyRecovery(handle, {
          now: () => new Date(TIMESTAMP),
          hooks,
        }),
      ).rejects.toThrow(`crash-${hookName}`);

      const crashed = await readRecoveryDomain(workspace);
      expect(crashed.state.phase).toBe(expectedPhase);
      expect(crashed.finalManifest !== undefined).toBe(manifestExists);

      const resumed = await takeOver(workspace, replacementAttempt);
      const completion = await finalizeMechanicalEmptyRecovery(resumed, {
        now: () => new Date('2026-07-30T00:20:00.000Z'),
      });
      expect(
        await verifyMechanicalEmptyRecoveryArchive({
          workspacePath: workspace,
          targetArchive: completion.targetArchive,
        }),
      ).toEqual(completion);
    },
  );

  it('rejects a conflicting manifest in verified without overwriting it', async () => {
    const { workspace, handle } = await installMechanicalRecovery();
    await expect(
      finalizeMechanicalEmptyRecovery(handle, {
        now: () => new Date(TIMESTAMP),
        hooks: { afterVerified: () => Promise.reject(new Error('crash-after-verified')) },
      }),
    ).rejects.toThrow(/crash-after-verified/);

    const recovery = join(activeLeasePath(workspace), RECOVERY_DIR);
    const domain = await readRecoveryDomain(workspace);
    const conflicting = createRecoveryFinalManifestBytes({
      recoveryId: domain.claim.recoveryId,
      claimDigest: digestBytes(domain.claimBytes),
      workspaceMarkerDigest: digestBytes(readFileSync(join(workspace, WORKSPACE_MARKER_FILE))),
      protocolDigest: digestBytes(readFileSync(join(workspace, PROTOCOL_ROOT_DIR, PROTOCOL_FILE))),
      finalSourceSnapshotDigest: DIGEST_A,
      mutationSnapshotDigest: null,
      createdAt: new Date(domain.state.updatedAt),
    });
    writeFileSync(join(recovery, 'final-manifest.json'), conflicting);
    const replacement = await takeOver(workspace, ATTEMPT_B);

    await expect(finalizeMechanicalEmptyRecovery(replacement)).rejects.toThrow(/manifest/i);
    expect(readFileSync(join(recovery, 'final-manifest.json')).equals(conflicting)).toBe(true);
    expect(existsSync(activeLeasePath(workspace))).toBe(true);
  });

  it('fails closed when the deterministic target archive already exists', async () => {
    const { workspace, handle } = await installMechanicalRecovery();
    await expect(
      finalizeMechanicalEmptyRecovery(handle, {
        now: () => new Date(TIMESTAMP),
        hooks: { afterFinalizing: () => Promise.reject(new Error('crash-after-finalizing')) },
      }),
    ).rejects.toThrow(/crash-after-finalizing/);
    const domain = await readRecoveryDomain(workspace);
    const archivePath = join(workspace, ...domain.claim.targetArchive.split('/'));
    mkdirSync(archivePath);
    const replacement = await takeOver(workspace, ATTEMPT_B);

    await expect(finalizeMechanicalEmptyRecovery(replacement)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(existsSync(activeLeasePath(workspace))).toBe(true);
  });

  it('rechecks the source after the last hook and refuses a stale final manifest', async () => {
    const { workspace, handle } = await installMechanicalRecovery();
    await expect(
      finalizeMechanicalEmptyRecovery(handle, {
        now: () => new Date(TIMESTAMP),
        hooks: {
          beforeFinalRename: () => {
            const settled = join(activeLeasePath(workspace), 'settled-operations');
            mkdirSync(settled);
            writeFileSync(join(settled, 'late.json'), '{}\n');
          },
        },
      }),
    ).rejects.toThrow(/source|manifest/i);
    expect(existsSync(activeLeasePath(workspace))).toBe(true);
    expect((await readRecoveryDomain(workspace)).state.phase).toBe('finalizing');
  });

  it('allows only one of two real processes to finalize the recovery', async () => {
    const current = createIdentityProbe().current();
    const { workspace } = await installMechanicalRecovery({
      ...current,
      pid: 2_000_000_001,
    });
    const controlRoot = temporaryDirectory('workspace-recovery-finalize-control-');
    const barrier = join(controlRoot, 'start');
    const workerPath = fileURLToPath(
      new URL('./__fixtures__/recovery-finalize-worker.ts', import.meta.url),
    );
    const workers = [ATTEMPT_B, ATTEMPT_C].map((attemptId) =>
      fork(workerPath, [workspace, attemptId, barrier], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
    );
    await Promise.all(workers.map((worker) => waitForWorker(worker, new Set(['ready']))));
    const results = workers.map((worker) =>
      waitForWorker(worker, new Set(['completed', 'rejected'])),
    );
    writeFileSync(barrier, 'go');
    const outcomes = await Promise.all(results);
    await Promise.all(workers.map(waitForExit));

    expect(outcomes.filter((outcome) => outcome === 'completed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'rejected')).toHaveLength(1);
    expect(existsSync(activeLeasePath(workspace))).toBe(false);
    const incidentName = readdirSync(join(workspace, PROTOCOL_ROOT_DIR, 'incidents')).find((name) =>
      name.startsWith(`recovery-${RECOVERY_ID}-`),
    );
    expect(incidentName).toBeDefined();
    await expect(
      verifyMechanicalEmptyRecoveryArchive({
        workspacePath: workspace,
        targetArchive: `${PROTOCOL_ROOT_DIR}/incidents/${incidentName!}`,
      }),
    ).resolves.toMatchObject({ recoveryId: RECOVERY_ID });
  }, 20_000);

  it('lets a new attempt finish a real hard crash in the final-manifest link window', async () => {
    const { workspace } = await createLinkedFinalManifestCrash();
    const domain = await readRecoveryDomain(workspace);
    const manifestPath = join(activeLeasePath(workspace), RECOVERY_DIR, 'final-manifest.json');
    expect(domain.state.phase).toBe('verified');
    expect(domain.linkedFinalManifestSource).toBeDefined();
    expect(statSync(manifestPath, { bigint: true }).nlink).toBe(2n);

    const resumed = await acquireRecoveryAttempt({
      workspacePath: workspace,
      attemptId: ATTEMPT_C,
      identity: createIdentityProbe().current(),
    });
    const completed = await finalizeMechanicalEmptyRecovery(resumed);

    expect(
      statSync(join(completed.archivePath, RECOVERY_DIR, 'final-manifest.json'), {
        bigint: true,
      }).nlink,
    ).toBe(1n);
    await expect(
      verifyMechanicalEmptyRecoveryArchive({
        workspacePath: workspace,
        targetArchive: completed.targetArchive,
      }),
    ).resolves.toEqual(completed);
  }, 20_000);

  it.each(['wrong-source', 'extra-link', 'wrong-bytes'] as const)(
    'rejects an unsafe mechanical final-manifest link window: %s',
    async (failure) => {
      const { workspace } = await createLinkedFinalManifestCrash();
      const domain = await readRecoveryDomain(workspace);
      const source = domain.linkedFinalManifestSource!;
      const target = join(activeLeasePath(workspace), RECOVERY_DIR, 'final-manifest.json');
      if (failure === 'wrong-source') {
        renameSync(source, join(dirname(source), 'unknown.json'));
      } else if (failure === 'extra-link') {
        linkSync(target, join(dirname(source), 'extra-link.json'));
      } else {
        writeFileSync(target, '{"wrong":true}\n');
      }

      await expect(readRecoveryDomain(workspace)).rejects.toMatchObject({ code: 'invalid' });
      expect(existsSync(activeLeasePath(workspace))).toBe(true);
    },
    20_000,
  );
});

async function createLinkedFinalManifestCrash(): Promise<{ workspace: string }> {
  const current = createIdentityProbe().current();
  const { workspace } = await installMechanicalRecovery({
    ...current,
    pid: 2_000_000_001,
  });
  const fixture = fileURLToPath(
    new URL('./__fixtures__/recovery-linked-finalize-worker.ts', import.meta.url),
  );
  const child = fork(fixture, [workspace, ATTEMPT_B], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await waitForWorker(child, new Set(['linked']));
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  child.kill('SIGKILL');
  await exited;
  return { workspace };
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('worker timed out while exiting')), 10_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    function finish(error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function onError(error: Error): void {
      finish(error);
    }
    function onExit(code: number | null): void {
      if (code === 0) finish();
      else finish(new Error(`worker exited with ${String(code)}`));
    }
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null) onExit(child.exitCode);
  });
}

function waitForWorker(child: ChildProcess, accepted: ReadonlySet<string>): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(undefined, new Error('worker message timed out')),
      10_000,
    );
    function cleanup(): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    function finish(value?: string, error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve(value!);
    }
    function onMessage(message: unknown): void {
      if (typeof message === 'string' && accepted.has(message)) finish(message);
    }
    function onError(error: Error): void {
      finish(undefined, error);
    }
    function onExit(code: number | null): void {
      finish(undefined, new Error(`worker exited before result: ${String(code)}`));
    }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
