import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { type WorkspaceSession } from './session.js';
import {
  ACTIVE_LEASE_DIR,
  INCIDENTS_DIR,
  PROTOCOL_ROOT_DIR,
  type ProcessIdentitySnapshot,
} from './types.js';
import {
  acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease,
  bootstrapWorkspaceWithAuthority as bootstrapWorkspace,
  createWorkspaceSessionWithAuthority,
} from './workspace-authority-test-seam.js';

const roots: string[] = [];

function temporaryWorkspace(prefix = 'workspace-session-'): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
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

async function openSession(
  workspace: string,
  options?: Parameters<typeof createWorkspaceSessionWithAuthority>[1],
): Promise<WorkspaceSession> {
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
  return createWorkspaceSessionWithAuthority(lease, options);
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('WorkspaceSession and WorkspaceWriter', () => {
  it('serializes an in-flight write before release and rejects every later action', async () => {
    const workspace = temporaryWorkspace();
    let tempPath = '';
    let allowCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    let tempCreated!: () => void;
    const tempReady = new Promise<void>((resolve) => {
      tempCreated = resolve;
    });
    const session = await openSession(workspace, {
      hooks: {
        afterTempCreated: async (path) => {
          tempPath = path;
          tempCreated();
          await commitBarrier;
        },
      },
    });

    const write = session.writer.writeFile('state.json', 'committed');
    await tempReady;
    expect(existsSync(tempPath)).toBe(true);
    const close = session.close();
    await expect(session.writer.writeFile('late.json', 'never')).rejects.toMatchObject({
      code: 'closed',
    });
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);

    allowCommit();
    await write;
    await close;

    expect(readFileSync(join(workspace, 'state.json'), 'utf8')).toBe('committed');
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
    const snapshot = readdirSync(workspace, { recursive: true }).map(String).sort();
    await expect(session.writer.writeFile('after-close.json', 'never')).rejects.toMatchObject({
      code: 'closed',
    });
    expect(readdirSync(workspace, { recursive: true }).map(String).sort()).toEqual(snapshot);
  });

  it('rechecks ownership before commit so an old queued writer cannot write after a new owner appears', async () => {
    const workspace = temporaryWorkspace();
    let allowCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    let tempCreated!: () => void;
    const tempReady = new Promise<void>((resolve) => {
      tempCreated = resolve;
    });
    const session = await openSession(workspace, {
      hooks: {
        afterTempCreated: async () => {
          tempCreated();
          await commitBarrier;
        },
      },
    });
    const write = session.writer.writeFile('state.json', 'stale');
    await tempReady;

    const protocolRoot = join(workspace, PROTOCOL_ROOT_DIR);
    renameSync(
      join(protocolRoot, ACTIVE_LEASE_DIR),
      join(protocolRoot, INCIDENTS_DIR, 'simulated-stale-owner'),
    );
    const current = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(3),
      ownerId: OWNER_B,
      command: 'run',
    });
    allowCommit();

    await expect(write).rejects.toMatchObject({ code: 'lease-lost' });
    expect(existsSync(join(workspace, 'state.json'))).toBe(false);
    expect(readFileSync(join(protocolRoot, ACTIVE_LEASE_DIR, 'owner.json'), 'utf8')).toContain(
      OWNER_B,
    );
    await current.release();
  });

  it('does not start an already-queued writer after an earlier write loses the lease', async () => {
    const workspace = temporaryWorkspace();
    let allowCommit!: () => void;
    const commitBarrier = new Promise<void>((resolve) => {
      allowCommit = resolve;
    });
    let tempCreated!: () => void;
    const tempReady = new Promise<void>((resolve) => {
      tempCreated = resolve;
    });
    let hookCalls = 0;
    const session = await openSession(workspace, {
      hooks: {
        afterTempCreated: async () => {
          hookCalls += 1;
          if (hookCalls === 1) {
            tempCreated();
            await commitBarrier;
          }
        },
      },
    });
    const first = session.writer.writeFile('first.json', 'stale');
    const queued = session.writer.writeFile('second.json', 'must-not-start');
    await tempReady;

    const protocolRoot = join(workspace, PROTOCOL_ROOT_DIR);
    renameSync(
      join(protocolRoot, ACTIVE_LEASE_DIR),
      join(protocolRoot, INCIDENTS_DIR, 'simulated-queued-owner-loss'),
    );
    const current = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: identity(3),
      ownerId: OWNER_B,
      command: 'run',
    });
    allowCommit();

    await expect(first).rejects.toMatchObject({ code: 'lease-lost' });
    await expect(queued).rejects.toMatchObject({ code: 'lease-lost' });
    expect(hookCalls).toBe(1);
    expect(existsSync(join(workspace, 'first.json'))).toBe(false);
    expect(existsSync(join(workspace, 'second.json'))).toBe(false);
    await current.release();
  });

  it('rejects traversal and symlink parents without writing outside the workspace', async () => {
    const workspace = temporaryWorkspace();
    const outside = temporaryWorkspace('workspace-session-outside-');
    const session = await openSession(workspace);
    symlinkSync(
      outside,
      join(workspace, 'link'),
      process.platform === 'win32' ? 'junction' : 'dir',
    );

    await expect(session.writer.writeFile('../escape.txt', 'never')).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(session.writer.writeFile('link/escape.txt', 'never')).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(session.writer.writeFile('ENGINE.LOCK/escape.txt', 'never')).rejects.toMatchObject(
      {
        code: 'invalid',
      },
    );
    await expect(session.writer.writeFile('Workspace-Safety.json', 'never')).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      session.writer.writeFile('workspace-safety.json:stream', 'never'),
    ).rejects.toMatchObject({ code: 'invalid' });
    await expect(
      session.writer.writeFile('engine.lock./escape.txt', 'never'),
    ).rejects.toMatchObject({
      code: 'invalid',
    });
    expect(existsSync(join(outside, 'escape.txt'))).toBe(false);
    await session.close();
  });
});
