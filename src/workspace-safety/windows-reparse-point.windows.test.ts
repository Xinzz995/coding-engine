import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { captureDelegatedBaseline, evaluateDelegatedDelta } from './baseline.js';
import { OPERATION_ID, OWNER_ID, genericContract } from './__fixtures__/baseline-test-support.js';
import { bootstrapWorkspace } from './bootstrap.js';
import { readStableBootstrapSource } from './bootstrap-recovery.js';
import { evaluateWorkspaceSafetyDisk } from './disk-evaluator.js';
import { createIdentityProbe } from './identity.js';
import { readReadyWorkspaceRecords } from './lease.js';
import { PROTOCOL_FILE, PROTOCOL_ROOT_DIR, WORKSPACE_MARKER_FILE } from './types.js';
import { bootstrapWorkspaceWithAuthority } from './workspace-authority-test-seam.js';
import {
  WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT,
  assertWindowsSafetyTreeHasNoReparsePoints,
  assertWindowsWorkspaceTreeHasNoReparsePoints,
  inspectWindowsPathAttributes,
} from './windows-path-attributes.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function temporaryRoot(label: string): string {
  const root = mkdtempSync(join(tmpdir(), `coding-x-${label}-Unicode 空格-`));
  roots.push(root);
  return root;
}

function compactWithWof(path: string): void {
  const systemRoot = Object.entries(process.env).find(
    ([name]) => name.toLowerCase() === 'systemroot',
  )?.[1];
  if (!systemRoot) throw new Error('SystemRoot is unavailable');
  const result = spawnSync(
    win32.join(systemRoot, 'System32', 'compact.exe'),
    ['/C', '/EXE:LZX', '/F', path],
    { encoding: 'utf8', windowsHide: true, shell: false, timeout: 60_000 },
  );
  if (result.error) throw result.error;
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
}

function expectNodeBlindWof(path: string): void {
  const [record] = inspectWindowsPathAttributes([path]);
  expect(record).toMatchObject({ status: 'found' });
  if (record.status !== 'found') throw new Error('WOF proof path disappeared');
  expect(record.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT).toBe(
    WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT,
  );
  const node = lstatSync(path);
  expect(node.isSymbolicLink()).toBe(false);
  expect(node.isFile()).toBe(true);
  expect(readFileSync(path).byteLength).toBeGreaterThan(0);
}

function replaceSafetyRootWithJunction(container: string, workspace: string): string {
  const protocolRoot = join(workspace, PROTOCOL_ROOT_DIR);
  const target = join(container, `${WORKSPACE_MARKER_FILE} ordinary target`);
  renameSync(protocolRoot, target);
  symlinkSync(target, protocolRoot, 'junction');
  expect(lstatSync(protocolRoot).isSymbolicLink()).toBe(true);
  const child = join(protocolRoot, PROTOCOL_FILE);
  expect(lstatSync(child).isSymbolicLink()).toBe(false);
  expect(readFileSync(child).byteLength).toBeGreaterThan(0);
  return child;
}

describe.skipIf(process.platform !== 'win32')('Windows reparse point native proof', () => {
  it('counts directory depth without rejecting root-level leaf files', () => {
    const workspace = temporaryRoot('depth-proof');
    writeFileSync(join(workspace, 'root file.txt'), 'ordinary');
    expect(() =>
      assertWindowsWorkspaceTreeHasNoReparsePoints(workspace, { maxDepth: 0 }),
    ).not.toThrow();
    mkdirSync(join(workspace, 'nested'));
    expect(() => assertWindowsWorkspaceTreeHasNoReparsePoints(workspace, { maxDepth: 0 })).toThrow(
      /Windows path attribute|depth/u,
    );
  });

  it('keeps business and safety traversal budgets independent', () => {
    const workspace = temporaryRoot('independent-budgets');
    const protocolRoot = join(workspace, PROTOCOL_ROOT_DIR);
    mkdirSync(protocolRoot);
    writeFileSync(join(workspace, WORKSPACE_MARKER_FILE), 'marker');
    writeFileSync(join(protocolRoot, 'child.txt'), 'safety child');

    expect(
      assertWindowsWorkspaceTreeHasNoReparsePoints(workspace, {
        maxBusinessEntries: 0,
        maxSafetyEntries: 3,
      }),
    ).toMatchObject({ businessEntries: 0, safetyEntries: 3, complete: true });
    expect(() =>
      assertWindowsWorkspaceTreeHasNoReparsePoints(workspace, {
        maxBusinessEntries: 0,
        maxSafetyEntries: 2,
      }),
    ).toThrow(/Windows path attribute|boundary/u);

    writeFileSync(join(workspace, 'business.txt'), 'business');
    expect(() =>
      assertWindowsWorkspaceTreeHasNoReparsePoints(workspace, {
        maxBusinessEntries: 0,
        maxSafetyEntries: 3,
      }),
    ).toThrow(/Windows path attribute|boundary/u);
  });

  it('rejects Windows-equivalent safety names with non-canonical spelling', () => {
    const lockVariant = temporaryRoot('lock-case');
    mkdirSync(join(lockVariant, 'Engine.Lock'));
    expect(() => assertWindowsSafetyTreeHasNoReparsePoints(lockVariant)).toThrow(
      /Windows path attribute|canonical spelling/u,
    );

    const markerVariant = temporaryRoot('marker-case');
    writeFileSync(join(markerVariant, 'Workspace-Safety.json'), 'marker');
    expect(() => assertWindowsSafetyTreeHasNoReparsePoints(markerVariant)).toThrow(
      /Windows path attribute|canonical spelling/u,
    );
  });

  it('rejects a business file that becomes Node-blind WOF after baseline capture', () => {
    const workspace = temporaryRoot('post-baseline-wof');
    const business = join(workspace, 'generated.bin');
    writeFileSync(business, Buffer.alloc(1024 * 1024, 0x60));
    const baseline = captureDelegatedBaseline(
      workspace,
      OWNER_ID,
      OPERATION_ID,
      genericContract([]),
    );

    compactWithWof(business);
    expectNodeBlindWof(business);
    expect(() => evaluateDelegatedDelta(workspace, baseline)).toThrow(
      /Windows path attribute|reparse/u,
    );
  });

  it('rejects Node-blind WOF before ordinary workspace bootstrap leaves safety state', async () => {
    const workspace = temporaryRoot('bootstrap-entry-wof');
    const business = join(workspace, 'business WOF.bin');
    writeFileSync(business, Buffer.alloc(1024 * 1024, 0x65));
    compactWithWof(business);
    expectNodeBlindWof(business);

    await expect(bootstrapWorkspace({ workspacePath: workspace })).rejects.toThrow(
      /Windows path attribute|reparse/u,
    );
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR))).toBe(false);
    expect(existsSync(join(workspace, WORKSPACE_MARKER_FILE))).toBe(false);
  });

  it('rejects WOF files that Node reports as ordinary in every high-level reader', async () => {
    const workspace = temporaryRoot('wof-proof');
    const protocolRoot = join(workspace, PROTOCOL_ROOT_DIR);
    mkdirSync(protocolRoot);
    const business = join(workspace, 'business WOF.bin');
    const safety = join(protocolRoot, 'safety WOF.bin');
    writeFileSync(business, Buffer.alloc(1024 * 1024, 0x61));
    writeFileSync(safety, Buffer.alloc(1024 * 1024, 0x62));
    compactWithWof(business);
    compactWithWof(safety);

    expectNodeBlindWof(business);
    expectNodeBlindWof(safety);
    expect(() =>
      captureDelegatedBaseline(workspace, OWNER_ID, OPERATION_ID, genericContract([])),
    ).toThrow(/Windows path attribute|reparse/u);
    expect(() => assertWindowsSafetyTreeHasNoReparsePoints(workspace)).toThrow(
      /Windows path attribute|reparse/u,
    );

    const ready = temporaryRoot('wof-ready');
    await bootstrapWorkspace({ workspacePath: ready });
    const readyWof = join(ready, PROTOCOL_ROOT_DIR, 'incidents', 'ready safety WOF.bin');
    writeFileSync(readyWof, Buffer.alloc(1024 * 1024, 0x63));
    compactWithWof(readyWof);
    expectNodeBlindWof(readyWof);
    await expect(readReadyWorkspaceRecords(ready)).rejects.toThrow(
      /Windows path attribute|reparse/u,
    );
    await expect(evaluateWorkspaceSafetyDisk({ workspacePath: ready })).resolves.toMatchObject({
      facts: { canonical: 'invalid' },
      reason: 'invalid-safety-record',
    });

    const interrupted = temporaryRoot('wof-bootstrap');
    await expect(
      bootstrapWorkspaceWithAuthority({
        workspacePath: interrupted,
        identity: createIdentityProbe().current(),
        hooks: {
          afterProtocolRootInstalled: () => {
            throw new Error('intentional WOF bootstrap interruption');
          },
        },
      }),
    ).rejects.toThrow(/intentional WOF bootstrap interruption/u);
    const bootstrapWof = join(
      interrupted,
      PROTOCOL_ROOT_DIR,
      'incidents',
      'bootstrap safety WOF.bin',
    );
    writeFileSync(bootstrapWof, Buffer.alloc(1024 * 1024, 0x64));
    compactWithWof(bootstrapWof);
    expectNodeBlindWof(bootstrapWof);
    await expect(readStableBootstrapSource(interrupted)).rejects.toThrow(
      /Windows path attribute|reparse/u,
    );
  });

  it('rejects a reparse parent even when its child is an ordinary readable file', async () => {
    const readyContainer = temporaryRoot('junction-ready');
    const ready = join(readyContainer, 'ready workspace');
    mkdirSync(ready);
    await bootstrapWorkspace({ workspacePath: ready });
    replaceSafetyRootWithJunction(readyContainer, ready);

    await expect(readReadyWorkspaceRecords(ready)).rejects.toThrow(
      /Windows path attribute|reparse/u,
    );
    await expect(evaluateWorkspaceSafetyDisk({ workspacePath: ready })).resolves.toMatchObject({
      facts: { canonical: 'invalid' },
      reason: 'invalid-safety-record',
    });

    const bootstrapContainer = temporaryRoot('junction-bootstrap');
    const bootstrapping = join(bootstrapContainer, 'bootstrap workspace');
    mkdirSync(bootstrapping);
    await expect(
      bootstrapWorkspaceWithAuthority({
        workspacePath: bootstrapping,
        identity: createIdentityProbe().current(),
        hooks: {
          afterProtocolRootInstalled: () => {
            throw new Error('intentional bootstrap interruption');
          },
        },
      }),
    ).rejects.toThrow(/intentional bootstrap interruption/u);
    replaceSafetyRootWithJunction(bootstrapContainer, bootstrapping);
    await expect(readStableBootstrapSource(bootstrapping)).rejects.toThrow(
      /Windows path attribute|reparse/u,
    );
  });
});
