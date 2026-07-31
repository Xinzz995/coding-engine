import {
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from './workspace-authority-test-seam.js';
import { createIdentityProbe } from './identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from './workspace-authority-test-seam.js';
import {
  readCanonicalMutationDomain,
  readMutationDomainAtPath,
  verifyMutationArchive,
  verifyMutationFinalSnapshot,
} from './mutation-domain.js';
import { verifyMutationRecoveryArchive } from './mutation-recovery.js';
import {
  acquireMutationRecoveryAttemptWithAuthority as acquireMutationRecoveryAttempt,
  installMutationRecoveryDomainWithAuthority as installMutationRecoveryDomain,
  resumeMutationRecoveryWithAuthority as resumeMutationRecovery,
} from './recovery-authority-test-seam.js';
import { mutationArchivePath } from './mutation-records.js';
import { runWorkspaceMutationWithAuthority as runWorkspaceMutation } from './mutation-authority-test-seam.js';
import { inspectCommittedWorkspaceMutation } from './mutation.js';
import { createWorkspaceSession, type WorkspaceSession } from './session.js';
import { readRecoveryDomain } from './recovery.js';
import { ACTIVE_LEASE_DIR, PROTOCOL_ROOT_DIR, RECOVERY_DIR } from './types.js';

const roots: string[] = [];
const crashWorker = fileURLToPath(
  new URL('./__fixtures__/mutation-crash-worker.ts', import.meta.url),
);

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function sessionWithFiles(): Promise<{ root: string; session: WorkspaceSession }> {
  const root = mkdtempSync(join(tmpdir(), 'workspace-mutation-'));
  roots.push(root);
  const identity = createIdentityProbe().current();
  await bootstrapWorkspace({ workspacePath: root, identity });
  writeFileSync(join(root, 'state.json'), 'before-state');
  writeFileSync(join(root, 'obsolete.txt'), 'obsolete');
  mkdirSync(join(root, 'archive-me'));
  writeFileSync(join(root, 'archive-me', 'old.txt'), 'old archive bytes');
  const lease = await acquireWorkspaceLease({
    workspacePath: root,
    identity,
    command: 'repair',
  });
  return { root, session: createWorkspaceSession(lease) };
}

async function workspaceWithFiles(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), 'workspace-mutation-crash-'));
  roots.push(root);
  await bootstrapWorkspace({ workspacePath: root, identity: createIdentityProbe().current() });
  writeFileSync(join(root, 'state.json'), 'before');
  writeFileSync(join(root, 'obsolete.txt'), 'obsolete');
  mkdirSync(join(root, 'archive-me'));
  writeFileSync(join(root, 'archive-me', 'old.txt'), 'old');
  return root;
}

function waitForMessage(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error(`worker did not reach ${expected}`)), 10_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    function finish(error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function onMessage(message: unknown): void {
      if (message === expected) finish();
    }
    function onError(error: Error): void {
      finish(error);
    }
    function onExit(code: number | null): void {
      finish(new Error(`worker exited early with ${String(code)}`));
    }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}

function waitForAcceptedMessage(
  child: ChildProcess,
  accepted: ReadonlySet<string>,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(undefined, new Error('worker result timed out')), 10_000);
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

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
}

async function hardKillWorker(
  mode: 'normal' | 'resume',
  root: string,
  barrier: string,
): Promise<void> {
  const child = fork(crashWorker, [mode, root, barrier], {
    execArgv: ['--import', 'tsx'],
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
  });
  await waitForMessage(child, `reached:${barrier}`);
  const exited = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', () => resolve());
  });
  child.kill('SIGKILL');
  await exited;
}

describe('dark workspace mutation core', () => {
  it('installs immutable input before the first business write and commits exact targets', async () => {
    const { root, session } = await sessionWithFiles();
    let installedObservedBefore = '';
    const domain = await runWorkspaceMutation(session, {
      kind: 'generic-v1',
      writes: [
        { path: 'state.json', data: 'after-state' },
        { path: 'created.txt', data: 'created' },
      ],
      deletes: ['obsolete.txt'],
      archivePaths: ['archive-me', 'state.json'],
      hooks: {
        afterMutationInstalled: () => {
          installedObservedBefore = readFileSync(join(root, 'state.json'), 'utf8');
        },
      },
    });

    expect(installedObservedBefore).toBe('before-state');
    expect(domain.state.phase).toBe('committed');
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('after-state');
    expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('created');
    expect(() => readFileSync(join(root, 'obsolete.txt'))).toThrow();
    await verifyMutationFinalSnapshot(domain);
    const archive = await verifyMutationArchive(domain);
    expect(archive).toBe(
      join(
        domain.workspace.path,
        mutationArchivePath(domain.state.mutationId, domain.state.baseSnapshotDigest),
      ),
    );
    expect(readFileSync(join(archive, 'data', 'state.json'), 'utf8')).toBe('before-state');
    expect(readFileSync(join(archive, 'data', 'archive-me', 'old.txt'), 'utf8')).toBe(
      'old archive bytes',
    );
    expect((await inspectCommittedWorkspaceMutation(session)).state.phase).toBe('committed');
  });

  it('ordinary close mechanically verifies committed mutation and archives the whole lease', async () => {
    const { root, session } = await sessionWithFiles();
    const committed = await runWorkspaceMutation(session, {
      kind: 'generic-v1',
      writes: [{ path: 'state.json', data: 'after-state' }],
      deletes: ['obsolete.txt'],
      archivePaths: ['archive-me', 'state.json'],
    });

    const close = session.close();
    await expect(
      session.writer.writeFile('late-before-release.txt', 'never'),
    ).rejects.toMatchObject({ code: 'closed' });
    const incident = await close;

    expect(existsSync(join(root, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
    const archived = await readMutationDomainAtPath({
      workspace: session.lease.workspace,
      mutationPath: join(incident, 'mutation'),
      expectedOwner: session.lease.owner,
    });
    expect(archived.stateBytes).toEqual(committed.stateBytes);
    expect(archived.manifestBytes).toEqual(committed.manifestBytes);
    expect(archived.state.phase).toBe('committed');
    await verifyMutationArchive(archived);
    await verifyMutationFinalSnapshot(archived);

    const next = await acquireWorkspaceLease({
      workspacePath: root,
      identity: createIdentityProbe().current(),
      command: 'repair',
    });
    await expect(
      session.writer.writeFile('late-after-new-owner.txt', 'never'),
    ).rejects.toMatchObject({ code: 'closed' });
    expect(existsSync(join(root, 'late-before-release.txt'))).toBe(false);
    expect(existsSync(join(root, 'late-after-new-owner.txt'))).toBe(false);
    await next.release();
  });

  it('ordinary close rejects an incomplete mutation and preserves its exact recovery input', async () => {
    const { root, session } = await sessionWithFiles();
    await expect(
      runWorkspaceMutation(session, {
        kind: 'generic-v1',
        writes: [{ path: 'state.json', data: 'after-state' }],
        deletes: ['obsolete.txt'],
        archivePaths: ['state.json'],
        hooks: { afterApplyingState: () => Promise.reject(new Error('fixture stop')) },
      }),
    ).rejects.toThrow(/fixture stop/u);
    const beforeClose = await readCanonicalMutationDomain({
      workspace: session.lease.workspace,
      expectedOwner: session.lease.owner,
    });
    expect(beforeClose.state.phase).toBe('applying');

    await expect(session.close()).rejects.toMatchObject({ code: 'isolated' });

    expect(existsSync(join(root, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('before-state');
    expect(readFileSync(join(root, 'obsolete.txt'), 'utf8')).toBe('obsolete');
    const afterClose = await readCanonicalMutationDomain({
      workspace: session.lease.workspace,
      expectedOwner: session.lease.owner,
    });
    expect(afterClose.stateBytes).toEqual(beforeClose.stateBytes);
    expect(afterClose.manifestBytes).toEqual(beforeClose.manifestBytes);
  });

  it('archives nested sibling roots without inventing an implicit business directory', async () => {
    const { root, session } = await sessionWithFiles();
    mkdirSync(join(root, 'nested'));
    mkdirSync(join(root, 'nested', 'directory'));
    writeFileSync(join(root, 'nested', 'directory', 'deep.txt'), 'deep');
    writeFileSync(join(root, 'nested', 'file.txt'), 'sibling');

    const domain = await runWorkspaceMutation(session, {
      kind: 'generic-v1',
      writes: [{ path: 'state.json', data: 'after-state' }],
      deletes: [],
      archivePaths: ['nested/directory', 'nested/file.txt'],
    });
    const archive = await verifyMutationArchive(domain);

    expect(readFileSync(join(archive, 'data', 'nested', 'directory', 'deep.txt'), 'utf8')).toBe(
      'deep',
    );
    expect(readFileSync(join(archive, 'data', 'nested', 'file.txt'), 'utf8')).toBe('sibling');
  });

  it('rejects path collisions and a hard-linked source before installing mutation', async () => {
    const first = await sessionWithFiles();
    await expect(
      runWorkspaceMutation(first.session, {
        kind: 'generic-v1',
        writes: [{ path: 'same.txt', data: 'x' }],
        deletes: ['same.txt'],
        archivePaths: [],
      }),
    ).rejects.toThrow(/collision|duplicate/i);

    const second = await sessionWithFiles();
    linkSync(join(second.root, 'state.json'), join(second.root, 'hardlink.txt'));
    await expect(
      runWorkspaceMutation(second.session, {
        kind: 'generic-v1',
        writes: [{ path: 'hardlink.txt', data: 'new' }],
        deletes: [],
        archivePaths: ['hardlink.txt'],
      }),
    ).rejects.toThrow(/single-link|hardlink/i);
  });

  it('rejects safety paths, internal staging names, and implicit business directories', async () => {
    for (const forbidden of [
      'engine.lock/protocol.json',
      'workspace-safety.json',
      '.coding-x-hidden',
      '.state.coding-x-owner-1.tmp',
    ]) {
      const fixture = await sessionWithFiles();
      await expect(
        runWorkspaceMutation(fixture.session, {
          kind: 'generic-v1',
          writes: [{ path: forbidden, data: 'escape' }],
          deletes: [],
          archivePaths: [],
        }),
      ).rejects.toThrow(/protocol|safety|staging|relative/i);
      expect(existsSync(join(fixture.root, PROTOCOL_ROOT_DIR, 'lease', 'mutation'))).toBe(false);
    }

    const missingParent = await sessionWithFiles();
    await expect(
      runWorkspaceMutation(missingParent.session, {
        kind: 'generic-v1',
        writes: [{ path: 'new-parent/file.txt', data: 'not-created' }],
        deletes: [],
        archivePaths: [],
      }),
    ).rejects.toThrow(/parent.*exist/i);
    expect(() => readFileSync(join(missingParent.root, 'new-parent', 'file.txt'))).toThrow();
  });

  it('rejects a hard-linked prepared apply file inside the canonical mutation', async () => {
    const { root, session } = await sessionWithFiles();
    await expect(
      runWorkspaceMutation(session, {
        kind: 'generic-v1',
        writes: [{ path: 'state.json', data: 'after' }],
        deletes: [],
        archivePaths: ['state.json'],
        hooks: { afterApplyingState: () => Promise.reject(new Error('fixture stop')) },
      }),
    ).rejects.toThrow(/fixture stop/);
    const outside = join(root, 'outside.bin');
    writeFileSync(outside, 'x');
    const prepared = join(
      root,
      PROTOCOL_ROOT_DIR,
      ACTIVE_LEASE_DIR,
      'mutation',
      'apply',
      'prepared-00000000-0000-4000-8000-000000000099-00000000.bin',
    );
    linkSync(outside, prepared);
    await expect(
      readCanonicalMutationDomain({
        workspace: session.lease.workspace,
        expectedOwner: session.lease.owner,
      }),
    ).rejects.toThrow(/single-link/i);
  });

  it('resumes only the frozen input and atomically finalizes the dead owner lease', async () => {
    const { root, session } = await sessionWithFiles();
    await expect(
      runWorkspaceMutation(session, {
        kind: 'repair-v1',
        writes: [
          { path: 'created.txt', data: 'created' },
          { path: 'state.json', data: 'after-state' },
        ],
        deletes: ['obsolete.txt'],
        archivePaths: ['archive-me', 'state.json'],
        hooks: {
          afterBusinessStep: () => {
            throw new Error('fixture interruption');
          },
        },
      }),
    ).rejects.toThrow(/fixture interruption/);

    const identity = { ...createIdentityProbe().current(), pid: 2_000_000_006 };
    const handle = await installMutationRecoveryDomain({
      workspacePath: root,
      identity,
      probeSourceOwner: () => 'dead',
    });
    const completion = await resumeMutationRecovery(handle, {
      attemptIdentity: identity,
      probeSourceOwner: () => 'dead',
    });

    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('after-state');
    expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('created');
    expect(() => readFileSync(join(root, 'obsolete.txt'))).toThrow();
    expect(
      await verifyMutationRecoveryArchive({
        workspacePath: root,
        targetArchive: completion.targetArchive,
      }),
    ).toEqual(completion);
  });

  it.each([
    'staged',
    'archiving',
    'archive-mid-copy',
    'applying',
    'business-step-1',
    'business-step-2',
    'business-step-3',
    'committed',
  ] as const)(
    'resumes a real SIGKILL from %s without replacing the frozen input',
    async (barrier) => {
      const root = await workspaceWithFiles();
      await hardKillWorker('normal', root, barrier);
      const handle = await installMutationRecoveryDomain({
        workspacePath: root,
        identity: createIdentityProbe().current(),
      });
      const completion = await resumeMutationRecovery(handle);
      expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('after');
      expect(readFileSync(join(root, 'created.txt'), 'utf8')).toBe('created');
      expect(() => readFileSync(join(root, 'obsolete.txt'))).toThrow();
      await expect(
        verifyMutationRecoveryArchive({
          workspacePath: root,
          targetArchive: completion.targetArchive,
        }),
      ).resolves.toEqual(completion);
    },
    30_000,
  );

  it('recovers a second SIGKILL between mutation state and recovery state', async () => {
    const root = await workspaceWithFiles();
    await hardKillWorker('normal', root, 'applying');
    const current = createIdentityProbe().current();
    await installMutationRecoveryDomain({
      workspacePath: root,
      identity: { ...current, pid: 2_000_000_001 },
    });
    await hardKillWorker('resume', root, 'mutation-state-committed');

    const replacement = await acquireMutationRecoveryAttempt({
      workspacePath: root,
      identity: current,
    });
    const completion = await resumeMutationRecovery(replacement);
    await expect(
      verifyMutationRecoveryArchive({
        workspacePath: root,
        targetArchive: completion.targetArchive,
      }),
    ).resolves.toEqual(completion);
  }, 30_000);

  it('recovers the exact controlled final-manifest hardlink after SIGKILL', async () => {
    const root = await workspaceWithFiles();
    await hardKillWorker('normal', root, 'committed');
    const current = createIdentityProbe().current();
    await installMutationRecoveryDomain({
      workspacePath: root,
      identity: { ...current, pid: 2_000_000_001 },
    });
    await hardKillWorker('resume', root, 'final-manifest-linked');
    const linkedManifest = join(
      root,
      PROTOCOL_ROOT_DIR,
      ACTIVE_LEASE_DIR,
      RECOVERY_DIR,
      'final-manifest.json',
    );
    expect(statSync(linkedManifest, { bigint: true }).nlink).toBe(2n);

    const replacement = await acquireMutationRecoveryAttempt({
      workspacePath: root,
      identity: current,
    });
    const completion = await resumeMutationRecovery(replacement);
    expect(
      statSync(join(completion.archivePath, RECOVERY_DIR, 'final-manifest.json'), {
        bigint: true,
      }).nlink,
    ).toBe(1n);
  }, 30_000);

  it('resumes a real SIGKILL from the finalizing window without business rewrites', async () => {
    const root = await workspaceWithFiles();
    await hardKillWorker('normal', root, 'committed');
    const current = createIdentityProbe().current();
    await installMutationRecoveryDomain({
      workspacePath: root,
      identity: { ...current, pid: 2_000_000_001 },
    });
    await hardKillWorker('resume', root, 'finalizing');
    const businessBefore = readFileSync(join(root, 'state.json'));
    const replacement = await acquireMutationRecoveryAttempt({
      workspacePath: root,
      identity: current,
    });
    const completion = await resumeMutationRecovery(replacement);
    expect(readFileSync(join(root, 'state.json'))).toEqual(businessBefore);
    await expect(
      verifyMutationRecoveryArchive({
        workspacePath: root,
        targetArchive: completion.targetArchive,
      }),
    ).resolves.toEqual(completion);
  }, 30_000);

  it('allows only one of two real resume processes to become the writer', async () => {
    const root = await workspaceWithFiles();
    await hardKillWorker('normal', root, 'applying');
    const current = createIdentityProbe().current();
    await installMutationRecoveryDomain({
      workspacePath: root,
      identity: { ...current, pid: 2_000_000_001 },
    });
    const control = mkdtempSync(join(tmpdir(), 'mutation-race-control-'));
    roots.push(control);
    const barrier = join(control, 'go');
    const workers = [0, 1].map(() =>
      fork(crashWorker, ['race', root, barrier], {
        execArgv: ['--import', 'tsx'],
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
    );
    await Promise.all(workers.map((worker) => waitForMessage(worker, 'ready')));
    const results = workers.map((worker) =>
      waitForAcceptedMessage(worker, new Set(['completed', 'rejected'])),
    );
    writeFileSync(barrier, 'go');
    const outcomes = await Promise.all(results);
    await Promise.all(workers.map(waitForExit));
    expect(outcomes.filter((outcome) => outcome === 'completed')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome === 'rejected')).toHaveLength(1);
    expect(existsSync(join(root, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
    expect(
      readdirSync(join(root, PROTOCOL_ROOT_DIR, 'incidents')).filter((name) =>
        name.startsWith('recovery-'),
      ),
    ).toHaveLength(1);
  }, 30_000);

  it('rejects an unexplained source conflict and preserves an interrupted finalizing recovery', async () => {
    const conflicted = await workspaceWithFiles();
    await hardKillWorker('normal', conflicted, 'applying');
    writeFileSync(join(conflicted, 'state.json'), 'unexplained-third-state');
    await expect(
      installMutationRecoveryDomain({
        workspacePath: conflicted,
        identity: createIdentityProbe().current(),
      }),
    ).rejects.toThrow(/neither exact before nor exact after/i);
    expect(existsSync(join(conflicted, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);

    const interrupted = await workspaceWithFiles();
    await hardKillWorker('normal', interrupted, 'committed');
    const handle = await installMutationRecoveryDomain({
      workspacePath: interrupted,
      identity: createIdentityProbe().current(),
    });
    await expect(
      resumeMutationRecovery(handle, {
        hooks: { beforeFinalRename: () => Promise.reject(new Error('user interrupt')) },
      }),
    ).rejects.toThrow(/user interrupt/);
    expect((await readRecoveryDomain(interrupted)).state.phase).toBe('finalizing');
    expect(existsSync(join(interrupted, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
  }, 30_000);

  it.each(['candidate', 'archive'] as const)(
    'fails closed when the frozen %s bytes drift after a hard crash',
    async (kind) => {
      const root = await workspaceWithFiles();
      await hardKillWorker('normal', root, 'applying');
      if (kind === 'candidate') {
        writeFileSync(
          join(
            root,
            PROTOCOL_ROOT_DIR,
            ACTIVE_LEASE_DIR,
            'mutation',
            'input',
            'payloads',
            '00000000.bin',
          ),
          'tampered-candidate',
        );
      } else {
        const archive = readdirSync(join(root, PROTOCOL_ROOT_DIR, 'incidents')).find((name) =>
          name.startsWith('mutation-data-'),
        );
        if (!archive) throw new Error('fixture mutation archive is missing');
        writeFileSync(
          join(root, PROTOCOL_ROOT_DIR, 'incidents', archive, 'data', 'state.json'),
          'tampered-archive',
        );
      }
      await expect(
        installMutationRecoveryDomain({
          workspacePath: root,
          identity: createIdentityProbe().current(),
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(existsSync(join(root, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
    },
    30_000,
  );
});
import { fork, type ChildProcess } from 'node:child_process';
