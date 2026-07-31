import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from './workspace-authority-test-seam.js';
import { digestBytes } from './filesystem.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from './workspace-authority-test-seam.js';
import {
  createQuarantineRecordBytes,
  installQuarantineNoReplace,
  QUARANTINE_FILE,
} from './quarantine.js';
import {
  ACTIVE_LEASE_DIR,
  INCIDENTS_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  WORKSPACE_MARKER_FILE,
  type ProcessIdentitySnapshot,
} from './types.js';

const roots: string[] = [];

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-lease-'));
  roots.push(root);
  return root;
}

function identity(pid: number): ProcessIdentitySnapshot {
  return {
    pid,
    processIdentity: { kind: 'linux-boot-start', value: String(10_000 + pid) },
    bootIdentity: `sha256:${'a'.repeat(64)}`,
    hostId: `sha256:${'b'.repeat(64)}`,
  };
}

const BOOTSTRAP_OWNER = '00000000-0000-4000-8000-000000000001';
const OWNER_A = '00000000-0000-4000-8000-00000000000a';
const OWNER_B = '00000000-0000-4000-8000-00000000000b';

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('ordinary workspace lease', () => {
  it('has one winner, keeps losing staging inert, and preserves the permanent root on release', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });

    const [first, second] = await Promise.allSettled([
      acquireWorkspaceLease({
        workspacePath: workspace,
        identity: identity(2),
        ownerId: OWNER_A,
        command: 'run',
      }),
      acquireWorkspaceLease({
        workspacePath: workspace,
        identity: identity(3),
        ownerId: OWNER_B,
        command: 'report',
      }),
    ]);

    const winner =
      first.status === 'fulfilled'
        ? first.value
        : second.status === 'fulfilled'
          ? second.value
          : undefined;
    expect(winner).toBeDefined();
    expect([first, second].filter((result) => result.status === 'rejected')).toHaveLength(1);
    const leaseRoot = join(workspace, PROTOCOL_ROOT_DIR);
    const staging = readdirSync(leaseRoot).filter((entry) => entry.startsWith('lease.prepare-'));
    expect(staging).toHaveLength(1);

    const incident = await winner!.release();
    expect(existsSync(join(leaseRoot, ACTIVE_LEASE_DIR))).toBe(false);
    expect(existsSync(join(leaseRoot, 'protocol.json'))).toBe(true);
    expect(existsSync(incident)).toBe(true);
  });

  it('does not let a stale handle verify or release a later owner lease', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    const stale = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'run',
    });
    const root = join(workspace, PROTOCOL_ROOT_DIR);
    renameSync(join(root, ACTIVE_LEASE_DIR), join(root, INCIDENTS_DIR, 'simulated-old-owner-exit'));
    const current = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(3),
      ownerId: OWNER_B,
      command: 'run',
    });
    const ownerPath = join(root, ACTIVE_LEASE_DIR, OWNER_FILE);
    const currentBytes = readFileSync(ownerPath);

    await expect(stale.verify()).rejects.toMatchObject({ code: 'lease-lost' });
    await expect(stale.release()).rejects.toMatchObject({ code: 'lease-lost' });
    expect(readFileSync(ownerPath)).toEqual(currentBytes);

    await current.release();
  });

  it('refuses release while an operation is present', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'run',
    });
    const activeLease = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
    mkdirSync(join(activeLease, OPERATION_DIR));

    await expect(lease.release()).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(activeLease)).toBe(true);
  });

  it('strictly validates and preserves a root quarantine instead of releasing around it', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'run',
    });
    const quarantinePath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, QUARANTINE_FILE);
    writeFileSync(
      quarantinePath,
      createQuarantineRecordBytes({
        ownerId: OWNER_A,
        operationId: null,
        activeChildDigest: null,
        delegatedBaselineDigest: null,
        creator: { kind: 'owner', id: OWNER_A, recordDigest: `sha256:${'c'.repeat(64)}` },
        reason: 'containment-unconfirmed',
        priorQuarantineDigest: null,
        createdAt: '2026-07-30T00:00:00.000Z',
      }),
    );

    await expect(lease.release()).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(quarantinePath)).toBe(true);

    writeFileSync(quarantinePath, '{}');
    await expect(lease.release()).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(quarantinePath)).toBe(true);
  });

  it('never releases around a valid or malformed prepared quarantine', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'run',
    });
    const activeLease = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
    const staging = join(
      activeLease,
      `quarantine.prepare-${OWNER_A}-10000000-0000-4000-8000-000000000001.json`,
    );
    writeFileSync(
      staging,
      createQuarantineRecordBytes({
        ownerId: OWNER_A,
        operationId: null,
        activeChildDigest: null,
        delegatedBaselineDigest: null,
        creator: { kind: 'owner', id: OWNER_A, recordDigest: `sha256:${'c'.repeat(64)}` },
        reason: 'containment-unconfirmed',
        priorQuarantineDigest: null,
        createdAt: '2026-07-30T00:00:00.000Z',
      }),
    );

    await expect(lease.release()).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(activeLease)).toBe(true);
    writeFileSync(staging, '{}');
    await expect(lease.release()).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(activeLease)).toBe(true);
  });

  it('serializes quarantine installation ahead of ordinary release', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'run',
    });
    const activeLease = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
    let allowCommit!: () => void;
    const commitGate = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    let staged!: () => void;
    const stagedGate = new Promise<void>((resolve) => {
      staged = resolve;
    });
    let checks = 0;
    const installation = installQuarantineNoReplace({
      containerPath: activeLease,
      recordBytes: createQuarantineRecordBytes({
        ownerId: OWNER_A,
        operationId: null,
        activeChildDigest: null,
        delegatedBaselineDigest: null,
        creator: { kind: 'owner', id: OWNER_A, recordDigest: `sha256:${'c'.repeat(64)}` },
        reason: 'containment-unconfirmed',
        priorQuarantineDigest: null,
        createdAt: '2026-07-30T00:00:00.000Z',
      }),
      verifyAuthority: async () => {
        checks += 1;
        if (checks === 2) {
          staged();
          await commitGate;
        }
      },
    });
    await stagedGate;
    const release = lease.release();
    allowCommit();

    await expect(installation).resolves.toMatchObject({ reason: 'containment-unconfirmed' });
    await expect(release).rejects.toMatchObject({ code: 'isolated' });
    expect(readFileSync(join(activeLease, QUARANTINE_FILE))).toBeDefined();
  });

  it('treats marker changes as lease loss and leaves the active lease untouched', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'repair',
    });
    const markerPath = join(workspace, WORKSPACE_MARKER_FILE);
    writeFileSync(markerPath, `${readFileSync(markerPath, 'utf8')}\n`);

    await expect(lease.verify()).rejects.toMatchObject({ code: 'lease-lost' });
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
  });

  it('does not replace a pre-existing incident destination during release', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'run',
    });
    const root = join(workspace, PROTOCOL_ROOT_DIR);
    const ownerBytes = readFileSync(join(root, ACTIVE_LEASE_DIR, OWNER_FILE));
    const collision = join(
      root,
      INCIDENTS_DIR,
      `released-${OWNER_A}-${digestBytes(ownerBytes).slice(7, 23)}`,
    );
    mkdirSync(collision);

    await expect(lease.release()).rejects.toMatchObject({ code: 'conflict' });
    expect(existsSync(join(root, ACTIVE_LEASE_DIR))).toBe(true);
    expect(readdirSync(collision)).toEqual([]);
  });

  it('treats a retargeted workspace alias as lease loss', async () => {
    const workspace = temporaryWorkspace();
    const replacement = temporaryWorkspace();
    const aliasParent = temporaryWorkspace();
    const alias = join(aliasParent, 'workspace-link');
    symlinkSync(workspace, alias, process.platform === 'win32' ? 'junction' : 'dir');
    await bootstrapWorkspace({
      workspacePath: alias,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    const lease = await acquireWorkspaceLease({
      workspacePath: alias,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'run',
    });

    unlinkSync(alias);
    symlinkSync(replacement, alias, process.platform === 'win32' ? 'junction' : 'dir');

    await expect(lease.verify()).rejects.toMatchObject({ code: 'lease-lost' });
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
  });

  it('reports a malformed existing active owner as invalid instead of a normal conflict', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: identity(1),
      ownerId: BOOTSTRAP_OWNER,
    });
    await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(2),
      ownerId: OWNER_A,
      command: 'run',
    });
    writeFileSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OWNER_FILE), '{}');

    await expect(
      acquireWorkspaceLease({
        workspacePath: workspace,
        identity: identity(3),
        ownerId: OWNER_B,
        command: 'run',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});
