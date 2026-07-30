import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from './workspace-authority-test-seam.js';
import { digestBytes } from './filesystem.js';
import {
  ACTIVE_LEASE_DIR,
  INCIDENTS_DIR,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  WORKSPACE_MARKER_FILE,
  type ProcessIdentitySnapshot,
  type ProtocolRecord,
  type WorkspaceMarker,
} from './types.js';

const roots: string[] = [];

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-bootstrap-'));
  roots.push(root);
  return root;
}

const identity: ProcessIdentitySnapshot = {
  pid: 4242,
  processIdentity: { kind: 'linux-boot-start', value: '424210' },
  bootIdentity: `sha256:${'a'.repeat(64)}`,
  hostId: `sha256:${'b'.repeat(64)}`,
};

const BOOTSTRAP_OWNER = '00000000-0000-4000-8000-000000000001';

interface WorkerCapture {
  readonly child: ChildProcessWithoutNullStreams;
  readonly ready: Promise<void>;
  readonly installReady: Promise<void>;
  readonly result: Promise<{
    status: string;
    code?: string;
    message?: string;
    created?: boolean;
  }>;
}

function startBootstrapWorker(workspace: string, ownerId: string, pid: number): WorkerCapture {
  const fixture = fileURLToPath(new URL('./fixtures/bootstrap-worker.ts', import.meta.url));
  const child = spawn(
    process.execPath,
    ['--import=tsx', fixture, workspace, ownerId, String(pid)],
    {
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );
  let output = '';
  let markReady!: () => void;
  const ready = new Promise<void>((resolve) => {
    markReady = resolve;
  });
  let markInstallReady!: () => void;
  const installReady = new Promise<void>((resolve) => {
    markInstallReady = resolve;
  });
  let readySeen = false;
  let installReadySeen = false;
  const result = new Promise<{
    status: string;
    code?: string;
    message?: string;
    created?: boolean;
  }>((resolve, reject) => {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      output += chunk;
      if (!readySeen && output.includes('READY\n')) {
        readySeen = true;
        markReady();
      }
      if (!installReadySeen && output.includes('INSTALL_READY\n')) {
        installReadySeen = true;
        markInstallReady();
      }
    });
    child.once('error', reject);
    child.once('close', (code) => {
      if (code !== 0) {
        reject(new Error(`bootstrap worker exited ${code}: ${child.stderr.read() ?? ''}`));
        return;
      }
      const line = output.trim().split('\n').at(-1);
      if (!line || line === 'READY') {
        reject(new Error(`bootstrap worker returned no result: ${output}`));
        return;
      }
      resolve(
        JSON.parse(line) as {
          status: string;
          code?: string;
          message?: string;
          created?: boolean;
        },
      );
    });
  });
  return { child, ready, installReady, result };
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('workspace bootstrap', () => {
  it('creates a missing workspace directory before the single bootstrap competition', async () => {
    const parent = temporaryWorkspace();
    const workspace = join(parent, 'new-workspace');

    const result = await bootstrapWorkspace({
      workspacePath: workspace,
      identity,
      ownerId: BOOTSTRAP_OWNER,
    });

    expect(result.created).toBe(true);
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(true);
  });

  it('atomically installs a permanent protocol root, bound marker, and releases only the lease', async () => {
    const workspace = temporaryWorkspace();
    const result = await bootstrapWorkspace({
      workspacePath: workspace,
      identity,
      ownerId: BOOTSTRAP_OWNER,
      now: () => new Date('2026-07-30T00:00:00.000Z'),
    });

    expect(result.created).toBe(true);
    const protocolPath = join(workspace, PROTOCOL_ROOT_DIR, PROTOCOL_FILE);
    const protocolBytes = readFileSync(protocolPath);
    const protocol = JSON.parse(protocolBytes.toString('utf8')) as ProtocolRecord;
    const marker = JSON.parse(
      readFileSync(join(workspace, WORKSPACE_MARKER_FILE), 'utf8'),
    ) as WorkspaceMarker;

    expect(marker.workspaceIdentity).toBe(protocol.workspaceIdentity);
    expect(marker.protocolDigest).toBe(digestBytes(protocolBytes));
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
    expect(readdirSync(join(workspace, PROTOCOL_ROOT_DIR, INCIDENTS_DIR))).toHaveLength(1);
    expect(existsSync(protocolPath)).toBe(true);
  });

  it('re-checks an already-ready workspace without changing any bytes', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({ workspacePath: workspace, identity, ownerId: BOOTSTRAP_OWNER });
    const markerPath = join(workspace, WORKSPACE_MARKER_FILE);
    const protocolPath = join(workspace, PROTOCOL_ROOT_DIR, PROTOCOL_FILE);
    const markerBefore = readFileSync(markerPath);
    const protocolBefore = readFileSync(protocolPath);
    const incidentsBefore = readdirSync(join(workspace, PROTOCOL_ROOT_DIR, INCIDENTS_DIR));

    const result = await bootstrapWorkspace({
      workspacePath: workspace,
      identity,
      ownerId: '00000000-0000-4000-8000-000000000099',
    });

    expect(result.created).toBe(false);
    expect(readFileSync(markerPath)).toEqual(markerBefore);
    expect(readFileSync(protocolPath)).toEqual(protocolBefore);
    expect(readdirSync(join(workspace, PROTOCOL_ROOT_DIR, INCIDENTS_DIR))).toEqual(incidentsBefore);
  });

  it('refuses a non-empty legacy workspace without installing safety files', async () => {
    const workspace = temporaryWorkspace();
    writeFileSync(join(workspace, 'state.json'), '{}');

    await expect(
      bootstrapWorkspace({ workspacePath: workspace, identity, ownerId: BOOTSTRAP_OWNER }),
    ).rejects.toMatchObject({ code: 'legacy' });
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR))).toBe(false);
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(false);
  });

  it('has one winner when two initializers reach the protocol install together', async () => {
    const workspace = temporaryWorkspace();
    let arrivals = 0;
    let releaseBarrier!: () => void;
    const barrier = new Promise<void>((resolve) => {
      releaseBarrier = resolve;
    });
    const beforeProtocolRootInstall = async (): Promise<void> => {
      arrivals += 1;
      if (arrivals === 2) releaseBarrier();
      await barrier;
    };

    const results = await Promise.allSettled([
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: '00000000-0000-4000-8000-00000000000a',
        hooks: { beforeProtocolRootInstall },
      }),
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: '00000000-0000-4000-8000-00000000000b',
        hooks: { beforeProtocolRootInstall },
      }),
    ]);

    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.find((result) => result.status === 'rejected');
    expect(rejected).toMatchObject({ reason: { code: 'conflict' } });
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(true);
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, PROTOCOL_FILE))).toBe(true);
  });

  it('has one winner across two real processes', async () => {
    const workspace = temporaryWorkspace();
    const first = startBootstrapWorker(workspace, '00000000-0000-4000-8000-000000000011', 5011);
    const second = startBootstrapWorker(workspace, '00000000-0000-4000-8000-000000000012', 5012);
    await Promise.all([first.ready, second.ready]);
    first.child.stdin.write('GO\n');
    second.child.stdin.write('GO\n');
    await Promise.all([first.installReady, second.installReady]);
    first.child.stdin.end('INSTALL\n');
    second.child.stdin.end('INSTALL\n');

    const results = await Promise.all([first.result, second.result]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toEqual([
      expect.objectContaining({ code: 'conflict' }),
    ]);
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(true);
  });

  it('classifies a partial-to-ready inspection race as a concurrent bootstrap', async () => {
    const workspace = temporaryWorkspace();
    let rootInstalled!: () => void;
    const installed = new Promise<void>((resolve) => {
      rootInstalled = resolve;
    });
    let releaseWinner!: () => void;
    const winnerBarrier = new Promise<void>((resolve) => {
      releaseWinner = resolve;
    });
    const winner = bootstrapWorkspace({
      workspacePath: workspace,
      identity,
      ownerId: '00000000-0000-4000-8000-000000000021',
      hooks: {
        afterProtocolRootInstalled: async () => {
          rootInstalled();
          await winnerBarrier;
        },
      },
    });
    await installed;

    let released = false;
    const loser = bootstrapWorkspace({
      workspacePath: workspace,
      identity,
      ownerId: '00000000-0000-4000-8000-000000000022',
      hooks: {
        afterExistingPresenceRead: async ({ markerExists, protocolRootExists }) => {
          if (!released && !markerExists && protocolRootExists) {
            released = true;
            releaseWinner();
            await winner;
          }
        },
      },
    });

    await expect(loser).rejects.toMatchObject({
      code: 'conflict',
      message: expect.stringContaining('并发 bootstrap'),
    });
    await expect(winner).resolves.toMatchObject({ created: true });
  });

  it('keeps the canonical lease when bootstrap fails after installing the protocol root', async () => {
    const workspace = temporaryWorkspace();

    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: BOOTSTRAP_OWNER,
        hooks: {
          afterProtocolRootInstalled: () => {
            throw new Error('simulated crash boundary');
          },
        },
      }),
    ).rejects.toThrow('simulated crash boundary');

    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(false);
    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: '00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toMatchObject({ code: 'conflict' });
  });

  it('rechecks the empty-directory premise before installing the protocol root', async () => {
    const workspace = temporaryWorkspace();

    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: BOOTSTRAP_OWNER,
        hooks: {
          beforeProtocolRootInstall: () => {
            writeFileSync(join(workspace, 'state.json'), '{}');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'legacy' });

    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR))).toBe(false);
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(false);
    expect(readFileSync(join(workspace, 'state.json'), 'utf8')).toBe('{}');
  });

  it('rechecks the empty-directory premise after winning the protocol install', async () => {
    const workspace = temporaryWorkspace();

    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: BOOTSTRAP_OWNER,
        hooks: {
          afterProtocolRootInstalled: () => {
            writeFileSync(join(workspace, 'state.json'), '{}');
          },
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(false);
    expect(readFileSync(join(workspace, 'state.json'), 'utf8')).toBe('{}');
  });

  it('classifies a malformed unfinished bootstrap as invalid instead of replacing it', async () => {
    const workspace = temporaryWorkspace();
    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: BOOTSTRAP_OWNER,
        hooks: {
          afterProtocolRootInstalled: () => {
            throw new Error('stop after protocol install');
          },
        },
      }),
    ).rejects.toThrow('stop after protocol install');
    const ownerPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, 'owner.json');
    writeFileSync(ownerPath, '{}');

    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: '00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(readFileSync(ownerPath, 'utf8')).toBe('{}');
  });

  it('keeps a missing bootstrap owner invalid when no exact ready workspace exists', async () => {
    const workspace = temporaryWorkspace();
    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: BOOTSTRAP_OWNER,
        hooks: {
          afterProtocolRootInstalled: () => {
            throw new Error('stop before marker install');
          },
        },
      }),
    ).rejects.toThrow('stop before marker install');
    const ownerPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, 'owner.json');
    rmSync(ownerPath);

    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: '00000000-0000-4000-8000-000000000003',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(false);
  });

  it('does not report ready when the permanent protocol root has an unknown canonical entry', async () => {
    const workspace = temporaryWorkspace();
    await bootstrapWorkspace({ workspacePath: workspace, identity, ownerId: BOOTSTRAP_OWNER });
    writeFileSync(join(workspace, PROTOCOL_ROOT_DIR, 'unexpected.json'), '{}');

    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity,
        ownerId: '00000000-0000-4000-8000-000000000002',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });
});
