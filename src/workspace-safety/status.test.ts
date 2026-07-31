import { lstatSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspace } from './bootstrap.js';
import { jsonBytes } from './filesystem.js';
import { acquireWorkspaceLease, type WorkspaceLeaseHandle } from './lease.js';
import { installRecoveryDomain } from './recovery-attempt.js';
import { captureRecoverySourceSnapshotDigest } from './recovery-source-snapshot.js';
import {
  inspectWorkspaceSafetyStatus,
  normalizeWorkspaceSafetyStatus,
  type WorkspaceSafetyStatus,
  type WorkspaceSafetyStatusSnapshot,
} from './status.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  WORKSPACE_MARKER_FILE,
  type OwnerRecord,
  type WorkspaceSafetyClassification,
} from './types.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-workspace-status-'));
  roots.push(root);
  return root;
}

function snapshotTree(root: string): readonly string[] {
  const entries: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
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

async function inspectReadOnly(path: string): Promise<WorkspaceSafetyStatusSnapshot> {
  const before = snapshotTree(path);
  const result = await inspectWorkspaceSafetyStatus(path);
  expect(snapshotTree(path)).toEqual(before);
  expect(result.probeEvidence).toBe('system');
  return result;
}

async function leasedWorkspace(): Promise<{ path: string; lease: WorkspaceLeaseHandle }> {
  const path = workspace();
  await bootstrapWorkspace({ workspacePath: path });
  const lease = await acquireWorkspaceLease({ workspacePath: path, command: 'run' });
  return { path, lease };
}

function ownerPath(path: string): string {
  return join(path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OWNER_FILE);
}

function rewriteOwner(path: string, mutate: (owner: OwnerRecord) => void): void {
  const target = ownerPath(path);
  const owner = JSON.parse(readFileSync(target, 'utf8')) as OwnerRecord;
  mutate(owner);
  writeFileSync(target, jsonBytes(owner));
}

function makeOwnerStale(path: string): void {
  rewriteOwner(path, (owner) => {
    owner.processIdentity.value =
      owner.processIdentity.kind === 'macos-boot-start'
        ? owner.processIdentity.value === 'Thu Jul 30 00:00:01 2026'
          ? 'Fri Jul 31 00:00:01 2026'
          : 'Thu Jul 30 00:00:01 2026'
        : owner.processIdentity.value === '1'
          ? '2'
          : '1';
  });
}

function makeOwnerForeign(path: string): void {
  rewriteOwner(path, (owner) => {
    const candidate = `sha256:${'f'.repeat(64)}`;
    owner.hostId = owner.hostId === candidate ? `sha256:${'e'.repeat(64)}` : candidate;
  });
}

describe('workspace safety read-only status adapter', () => {
  it.each([
    ['uninitialized-empty', 'uninitialized'],
    ['ready', 'ready'],
    ['active', 'active'],
    ['recoverable', 'recoverable'],
    ['isolated', 'isolated'],
    ['legacy', 'legacy'],
    ['invalid', 'invalid'],
    ['recovering', 'active'],
  ] satisfies ReadonlyArray<[WorkspaceSafetyClassification, WorkspaceSafetyStatus]>)(
    'normalizes %s as %s',
    (classification, expected) => {
      expect(normalizeWorkspaceSafetyStatus(classification)).toBe(expected);
    },
  );

  it('reads empty, legacy, invalid, and ready disk states without changing their bytes', async () => {
    const empty = workspace();
    await expect(inspectReadOnly(empty)).resolves.toMatchObject({
      status: 'uninitialized',
      observedClassification: 'uninitialized-empty',
      reason: 'none',
      display: { label: '未初始化' },
    });

    const legacy = workspace();
    writeFileSync(join(legacy, 'state.json'), '{}');
    await expect(inspectReadOnly(legacy)).resolves.toMatchObject({
      status: 'legacy',
      observedClassification: 'legacy',
      reason: 'legacy-runtime-artifacts',
      display: { label: '旧版工作区' },
    });

    const invalid = workspace();
    writeFileSync(join(invalid, WORKSPACE_MARKER_FILE), '{}');
    await expect(inspectReadOnly(invalid)).resolves.toMatchObject({
      status: 'invalid',
      observedClassification: 'invalid',
      reason: 'invalid-safety-record',
      display: { label: '状态无效' },
    });

    const ready = workspace();
    await bootstrapWorkspace({ workspacePath: ready });
    await expect(inspectReadOnly(ready)).resolves.toMatchObject({
      status: 'ready',
      observedClassification: 'ready',
      reason: 'none',
      display: { label: '就绪', guidance: null },
    });
  });

  it('uses the system probe for a real production lease and remains read-only', async () => {
    const { path, lease } = await leasedWorkspace();
    const status = await inspectReadOnly(path);

    // macOS cannot prove PID reuse safety from its second-resolution process identity, so the
    // production evaluator intentionally isolates even the current process. Other supported
    // platforms can prove the exact live owner and report active.
    if (process.platform === 'darwin') {
      expect(status).toMatchObject({
        status: 'isolated',
        observedClassification: 'isolated',
      });
    } else {
      expect(status).toMatchObject({
        status: 'active',
        observedClassification: 'active',
        display: { label: '使用中' },
      });
    }

    await lease.release();
  });

  it('reports stale, foreign, and recovering production records through one vocabulary', async () => {
    const stale = await leasedWorkspace();
    makeOwnerStale(stale.path);
    await expect(inspectReadOnly(stale.path)).resolves.toMatchObject({
      status: 'recoverable',
      observedClassification: 'recoverable',
      display: { label: '可恢复' },
    });

    const foreign = await leasedWorkspace();
    makeOwnerForeign(foreign.path);
    await expect(inspectReadOnly(foreign.path)).resolves.toMatchObject({
      status: 'isolated',
      observedClassification: 'isolated',
      reason: 'foreign-host',
      display: { label: '已隔离' },
    });

    const recovering = await leasedWorkspace();
    makeOwnerStale(recovering.path);
    const expectedSourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(recovering.path);
    await installRecoveryDomain({
      workspacePath: recovering.path,
      expectedSourceSnapshotDigest,
    });
    await expect(inspectReadOnly(recovering.path)).resolves.toMatchObject({
      status: 'active',
      observedClassification: 'recovering',
      display: { label: '恢复中' },
    });
  });
});
