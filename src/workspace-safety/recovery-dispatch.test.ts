import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { evaluateWorkspaceSafetyDisk } from './disk-evaluator.js';
import { digestBytes } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import { runWorkspaceMutationWithAuthority as runWorkspaceMutation } from './mutation-authority-test-seam.js';
import { createQuarantineRecordBytes, QUARANTINE_FILE } from './quarantine.js';
import { runWorkspaceRecover, runWorkspaceResumeMutation } from './recovery-dispatch.js';
import { captureRecoverySourceSnapshotDigest } from './recovery.js';
import {
  installMutationRecoveryDomainWithAuthority,
  installRecoveryDomainWithAuthority,
} from './recovery-authority-test-seam.js';
import { createWorkspaceSession } from './session.js';
import {
  acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease,
  bootstrapWorkspaceWithAuthority as bootstrapWorkspace,
} from './workspace-authority-test-seam.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  type ProcessIdentitySnapshot,
} from './types.js';

const roots: string[] = [];
let deadPidOffset = 0;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryDirectory(prefix = 'workspace-recovery-dispatch-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function snapshotTree(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((left, right) =>
      left.name.localeCompare(right.name, 'en'),
    )) {
      const path = join(directory, entry.name);
      const name = relative(root, path).replaceAll('\\', '/');
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) {
        entries.push(`directory:${name}`);
        walk(path);
      } else if (info.isFile() && !info.isSymbolicLink()) {
        entries.push(`file:${name}:${readFileSync(path).toString('base64')}`);
      } else {
        entries.push(`other:${name}:${info.mode}`);
      }
    }
  };
  walk(root);
  return entries;
}

function deadIdentity(): ProcessIdentitySnapshot {
  deadPidOffset += 1;
  return {
    ...createIdentityProbe().current(),
    pid: 2_000_000_000 + deadPidOffset,
  };
}

async function readyWorkspace(): Promise<string> {
  const root = temporaryDirectory();
  await bootstrapWorkspace({
    workspacePath: root,
    identity: createIdentityProbe().current(),
  });
  return root;
}

async function deadLeaseWorkspace(command: 'run' | 'repair' = 'run'): Promise<string> {
  const root = await readyWorkspace();
  await acquireWorkspaceLease({
    workspacePath: root,
    identity: deadIdentity(),
    command,
  });
  return root;
}

async function sameHostRebootWorkspace(): Promise<string> {
  const root = await readyWorkspace();
  const current = createIdentityProbe().current();
  const source = deadIdentity();
  const ownerId = '00000000-0000-4000-8000-000000000071';
  await acquireWorkspaceLease({
    workspacePath: root,
    identity: {
      ...source,
      bootIdentity:
        current.bootIdentity === `sha256:${'a'.repeat(64)}`
          ? `sha256:${'b'.repeat(64)}`
          : `sha256:${'a'.repeat(64)}`,
      hostId: current.hostId,
    },
    ownerId,
    command: 'run',
  });
  const leasePath = join(root, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  const ownerBytes = readFileSync(join(leasePath, OWNER_FILE));
  writeFileSync(
    join(leasePath, QUARANTINE_FILE),
    createQuarantineRecordBytes({
      ownerId,
      operationId: null,
      activeChildDigest: null,
      delegatedBaselineDigest: null,
      creator: {
        kind: 'owner',
        id: ownerId,
        recordDigest: digestBytes(ownerBytes),
      },
      reason: 'containment-unconfirmed',
      priorQuarantineDigest: null,
      createdAt: new Date('2026-07-31T00:00:00.000Z'),
    }),
  );
  return root;
}

async function interruptedMutation(): Promise<string> {
  const root = await readyWorkspace();
  writeFileSync(join(root, 'state.json'), 'before');
  writeFileSync(join(root, 'obsolete.txt'), 'obsolete');
  const lease = await acquireWorkspaceLease({
    workspacePath: root,
    identity: deadIdentity(),
    command: 'repair',
  });
  const session = createWorkspaceSession(lease);
  await expect(
    runWorkspaceMutation(session, {
      kind: 'generic-v1',
      writes: [{ path: 'state.json', data: 'after' }],
      deletes: ['obsolete.txt'],
      archivePaths: ['state.json'],
      hooks: {
        afterApplyingState: () => Promise.reject(new Error('fixture stop')),
      },
    }),
  ).rejects.toThrow('fixture stop');
  return root;
}

describe('workspace recovery dispatch', () => {
  it('refuses a ready workspace without changing any bytes', async () => {
    const root = await readyWorkspace();
    const before = snapshotTree(root);

    const result = await runWorkspaceRecover({ workspacePath: root });

    expect(result).toEqual({
      ok: false,
      exitCode: 2,
      command: 'recover',
      code: 'already-ready',
      message: 'Workspace 已就绪，没有可恢复记录。',
      classification: 'ready',
      reason: 'none',
    });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('installs and completes the unique mechanical recovery, then refuses a second call', async () => {
    const root = await deadLeaseWorkspace();

    const first = await runWorkspaceRecover({ workspacePath: root });

    expect(first).toMatchObject({
      ok: true,
      exitCode: 0,
      command: 'recover',
      mode: 'mechanical-empty',
      message: 'Workspace 恢复完成。',
      workspacePath: realpathSync(root),
    });
    expect(first.ok && existsSync(first.archivePath)).toBe(true);
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'ready',
    });

    const beforeSecond = snapshotTree(root);
    const second = await runWorkspaceRecover({ workspacePath: root });
    expect(second).toMatchObject({
      ok: false,
      exitCode: 2,
      code: 'already-ready',
      classification: 'ready',
    });
    expect(snapshotTree(root)).toEqual(beforeSecond);
  });

  it('re-acquires a dead installed mechanical attempt and completes its recorded mode', async () => {
    const root = await deadLeaseWorkspace();
    const expectedSourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(root);
    await installRecoveryDomainWithAuthority({
      workspacePath: root,
      expectedSourceSnapshotDigest,
      identity: deadIdentity(),
      mode: 'mechanical-empty',
      probeSourceOwner: () => 'dead',
    });
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'recovering',
    });

    const result = await runWorkspaceRecover({ workspacePath: root });

    expect(result).toMatchObject({
      ok: true,
      mode: 'mechanical-empty',
      workspacePath: realpathSync(root),
    });
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'ready',
    });
  });

  it('completes an interrupted bootstrap only through bootstrap recovery', async () => {
    const root = temporaryDirectory('workspace-recovery-bootstrap-');
    await expect(
      bootstrapWorkspace({
        workspacePath: root,
        identity: deadIdentity(),
        hooks: {
          afterProtocolRootInstalled: () => Promise.reject(new Error('fixture bootstrap stop')),
        },
      }),
    ).rejects.toThrow('fixture bootstrap stop');
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'recoverable',
      facts: { bootstrapLease: true },
    });

    const result = await runWorkspaceRecover({ workspacePath: root });

    expect(result).toMatchObject({
      ok: true,
      command: 'recover',
      mode: 'bootstrap-complete',
    });
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'ready',
    });
  });

  it('accepts only a strictly proved same-host reboot route', async () => {
    const root = await sameHostRebootWorkspace();
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'isolated',
      reason: 'containment-unconfirmed',
      facts: { owner: 'dead', foreignHost: false },
    });

    const result = await runWorkspaceRecover({ workspacePath: root });

    expect(result).toMatchObject({
      ok: true,
      command: 'recover',
      mode: 'same-host-reboot',
      rebootMode: 'mechanical-empty',
    });
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'ready',
    });
  });

  it('keeps an unfinished mutation untouched under recover and resumes it only via resume-mutation', async () => {
    const root = await interruptedMutation();
    const beforeWrongCommand = snapshotTree(root);

    const wrong = await runWorkspaceRecover({ workspacePath: root });

    expect(wrong).toMatchObject({
      ok: false,
      exitCode: 2,
      command: 'recover',
      code: 'wrong-command',
      classification: 'recoverable',
    });
    expect(snapshotTree(root)).toEqual(beforeWrongCommand);

    const resumed = await runWorkspaceResumeMutation({ workspacePath: root });
    expect(resumed).toMatchObject({
      ok: true,
      exitCode: 0,
      command: 'resume-mutation',
      mode: 'mutation-resume',
      workspacePath: realpathSync(root),
    });
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('after');
    expect(existsSync(join(root, 'obsolete.txt'))).toBe(false);
    expect(resumed.ok && existsSync(resumed.archivePath)).toBe(true);
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'ready',
    });
  });

  it('re-acquires a dead installed mutation attempt and performs the exact resume', async () => {
    const root = await interruptedMutation();
    await installMutationRecoveryDomainWithAuthority({
      workspacePath: root,
      identity: deadIdentity(),
      probeSourceOwner: () => 'dead',
    });
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'recovering',
    });

    const result = await runWorkspaceResumeMutation({ workspacePath: root });

    expect(result).toMatchObject({
      ok: true,
      command: 'resume-mutation',
      mode: 'mutation-resume',
    });
    expect(readFileSync(join(root, 'state.json'), 'utf8')).toBe('after');
    expect(existsSync(join(root, 'obsolete.txt'))).toBe(false);
    expect(await evaluateWorkspaceSafetyDisk({ workspacePath: root })).toMatchObject({
      classification: 'ready',
    });
  });

  it('refuses resume-mutation for a mechanical lease without installing recovery', async () => {
    const root = await deadLeaseWorkspace();
    const before = snapshotTree(root);

    const result = await runWorkspaceResumeMutation({ workspacePath: root });

    expect(result).toMatchObject({
      ok: false,
      exitCode: 2,
      command: 'resume-mutation',
      code: 'wrong-command',
      classification: 'recoverable',
    });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('does not install a recovery domain when the command was already interrupted', async () => {
    const root = await deadLeaseWorkspace();
    const before = snapshotTree(root);
    const controller = new AbortController();
    controller.abort();

    const result = await runWorkspaceRecover({
      workspacePath: root,
      termination: { signal: controller.signal },
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: 2,
      code: 'recovery-conflict',
      classification: 'recoverable',
    });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('does not install a mutation recovery domain when the command was already interrupted', async () => {
    const root = await interruptedMutation();
    const before = snapshotTree(root);
    const controller = new AbortController();
    controller.abort();

    const result = await runWorkspaceResumeMutation({
      workspacePath: root,
      termination: { signal: controller.signal },
    });

    expect(result).toMatchObject({
      ok: false,
      exitCode: 2,
      code: 'recovery-conflict',
      classification: 'recoverable',
    });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('fails closed and writes nothing for uninitialized, legacy, invalid, and foreign-host states', async () => {
    const uninitialized = temporaryDirectory('workspace-recovery-uninitialized-');
    const legacy = temporaryDirectory('workspace-recovery-legacy-');
    writeFileSync(join(legacy, 'state.json'), '{}');
    const invalid = await readyWorkspace();
    writeFileSync(join(invalid, PROTOCOL_ROOT_DIR, 'rogue.json'), '{}');
    const isolated = await readyWorkspace();
    const foreignIdentity = {
      ...deadIdentity(),
      hostId: `sha256:${'f'.repeat(64)}`,
    };
    await acquireWorkspaceLease({
      workspacePath: isolated,
      identity: foreignIdentity,
      command: 'run',
    });

    for (const [root, classification, code] of [
      [uninitialized, 'uninitialized-empty', 'uninitialized'],
      [legacy, 'legacy', 'legacy-workspace'],
      [invalid, 'invalid', 'invalid-records'],
      [isolated, 'isolated', 'insufficient-evidence'],
    ] as const) {
      const before = snapshotTree(root);
      const result = await runWorkspaceRecover({ workspacePath: root });
      expect(result).toMatchObject({ ok: false, exitCode: 2, classification, code });
      expect(snapshotTree(root)).toEqual(before);
    }
  });

  it('rejects a live or conservatively unknown owner without writing', async () => {
    const root = await readyWorkspace();
    await acquireWorkspaceLease({
      workspacePath: root,
      identity: createIdentityProbe().current(),
      command: 'run',
    });
    const evaluation = await evaluateWorkspaceSafetyDisk({ workspacePath: root });
    expect(['active', 'isolated']).toContain(evaluation.classification);
    const before = snapshotTree(root);

    const result = await runWorkspaceRecover({ workspacePath: root });

    expect(result).toMatchObject({
      ok: false,
      exitCode: 2,
      classification: evaluation.classification,
      code: evaluation.classification === 'active' ? 'active-owner' : 'insufficient-evidence',
    });
    expect(snapshotTree(root)).toEqual(before);
  });

  it('contains no injected authority, test seam, or direct filesystem writer', () => {
    const source = readFileSync(
      fileURLToPath(new URL('./recovery-dispatch.ts', import.meta.url)),
      'utf8',
    );
    expect(source).not.toContain('Controlled');
    expect(source).not.toContain('authority-test-seam');
    expect(source).not.toContain("from 'node:fs");
    expect(source).not.toMatch(/\b(?:rm|unlink|rename)\b/u);
    for (const sessionFactory of [
      'createBootstrapRecoverySession',
      'createRecoverySession',
      'createPrestartRecoverySession',
      'createDelegatedRecoverySession',
      'createSameHostRebootRecoverySession',
      'createMutationRecoverySession',
    ]) {
      expect(source).toContain(sessionFactory);
    }
    expect(source).not.toMatch(/\bfinalize(?:Bootstrap|Delegated|Prestart|Mechanical|SameHost)/u);
    expect(source).not.toMatch(/\bresumeMutationRecovery\s*\(/u);
  });
});
