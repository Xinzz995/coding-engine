import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, expectTypeOf, it } from 'vitest';
import { bootstrapWorkspace, type BootstrapWorkspaceOptions } from './bootstrap.js';
import type {
  AcquireBootstrapRecoveryAttemptOptions,
  InstallBootstrapRecoveryOptions,
} from './bootstrap-recovery.js';
import { BootstrapRecoveryAttemptHandle } from './bootstrap-recovery.js';
import type { FinalizeBootstrapRecoveryOptions } from './bootstrap-recovery-finalize.js';
import type {
  AcquireDelegatedFinalizeRecoveryOptions,
  InstallDelegatedFinalizeRecoveryOptions,
} from './delegated-recovery.js';
import type { FinalizeDelegatedRecoveryOptions } from './delegated-recovery-finalize.js';
import { digestBytes } from './filesystem.js';
import {
  evaluateWorkspaceSafetyDisk,
  type EvaluateWorkspaceSafetyDiskOptions,
  type WorkspaceSafetyDiskProbeAdapter,
} from './disk-evaluator.js';
import { createIdentityProbe } from './identity.js';
import {
  acquireWorkspaceLease,
  type AcquireWorkspaceLeaseOptions,
  WorkspaceLeaseHandle,
} from './lease.js';
import type {
  AcquireMutationRecoveryAttemptOptions,
  InstallMutationRecoveryOptions,
  ResumeMutationRecoveryOptions,
} from './mutation-recovery.js';
import type {
  AcquirePrestartRecoveryOptions,
  InstallPrestartRecoveryOptions,
} from './prestart-recovery.js';
import type { FinalizePrestartRecoveryOptions } from './prestart-recovery-finalize.js';
import { installRecoveryDomainWithAuthority } from './recovery-authority-test-seam.js';
import { acquireWorkspaceLeaseWithAuthority } from './workspace-authority-test-seam.js';
import type {
  AcquireRecoveryAttemptOptions,
  InstallRecoveryDomainOptions,
} from './recovery-attempt.js';
import { RecoveryAttemptHandle } from './recovery-attempt.js';
import { RecoverySession } from './recovery-session.js';
import type { FinalizeMechanicalEmptyRecoveryOptions } from './recovery-finalize.js';
import {
  captureRecoverySourceSnapshotDigest,
  finalizeMechanicalEmptyRecovery,
  installRecoveryDomain,
} from './recovery.js';
import type {
  AcquireSameHostRebootRecoveryOptions,
  FinalizeSameHostRebootRecoveryOptions,
  InstallSameHostRebootRecoveryOptions,
} from './reboot-recovery.js';
import { SameHostRebootRecoveryHandle } from './reboot-recovery.js';
import { finalizeSameHostRebootRecovery } from './reboot-recovery.js';
import { createWorkspaceSession, WorkspaceSession } from './session.js';
import {
  ACTIVE_LEASE_DIR,
  INCIDENTS_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  type OwnerRecord,
} from './types.js';

type ForbiddenAuthorityKey =
  | 'identity'
  | 'identityProbe'
  | 'attemptIdentity'
  | 'readCurrentIdentity'
  | 'probeSourceOwner'
  | 'probeAttemptOwner'
  | 'probeSupervisor'
  | 'probeContainment'
  | 'authority'
  | 'verifySystemAuthority'
  | 'expectedRebootQuarantine'
  | 'hooks'
  | 'now'
  | 'ownerId'
  | 'attemptId'
  | 'recoveryId'
  | 'helperBytes'
  | 'finalRenameCommitCheck'
  | 'beforeReceiptSourceUnlink'
  | 'beforeClaimInstall'
  | 'rebootProof';

const TEST_SEAM_PATHS = new Set([
  'workspace-safety/identity-authority-test-seam.ts',
  'workspace-safety/mutation-authority-test-seam.ts',
  'workspace-safety/operation-authority-test-seam.ts',
  'workspace-safety/recovery-authority-test-seam.ts',
  'workspace-safety/workspace-authority-test-seam.ts',
]);

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function treeDigest(root: string): string {
  const rows: string[] = [];
  const visit = (path: string, relative: string): void => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const childRelative = relative ? `${relative}/${name}` : name;
      const info = statSync(child);
      if (info.isDirectory()) {
        rows.push(`d\0${childRelative}`);
        visit(child, childRelative);
      } else {
        rows.push(`f\0${childRelative}\0${digestBytes(readFileSync(child))}`);
      }
    }
  };
  visit(root, '');
  return digestBytes(Buffer.from(rows.join('\n'), 'utf8'));
}

function sourcePath(root: string, path: string): string {
  return relative(root, path).replaceAll('\\', '/');
}

function productionTypeScriptFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (path: string): void => {
    for (const name of readdirSync(path)) {
      const child = join(path, name);
      const info = statSync(child);
      if (info.isDirectory()) {
        if (name !== '__fixtures__' && child !== join(root, 'workspace-safety', 'fixtures')) {
          visit(child);
        }
      } else if (
        name.endsWith('.ts') &&
        !name.endsWith('.test.ts') &&
        !name.endsWith('.test-support.ts') &&
        !TEST_SEAM_PATHS.has(sourcePath(root, child))
      ) {
        files.push(child);
      }
    }
  };
  visit(root);
  return files;
}

const AUTHORITY_CONTROLLED_MODULES = new Set([
  'bootstrap',
  'identity',
  'lease',
  'recovery-attempt',
  'recovery-finalize',
  'bootstrap-recovery',
  'bootstrap-recovery-finalize',
  'delegated-recovery',
  'delegated-recovery-finalize',
  'prestart-recovery',
  'prestart-recovery-finalize',
  'mutation-recovery',
  'reboot-recovery',
  'session',
  'recovery-session',
  'disk-evaluator',
]);

function authorityControlledModule(specifier: string): boolean {
  const name = specifier.split('/').at(-1)?.replace(/\.js$/u, '');
  return name !== undefined && AUTHORITY_CONTROLLED_MODULES.has(name);
}

describe('workspace authority boundary', () => {
  it('keeps authority facts out of every formal bootstrap, lease, and recovery option type', () => {
    expectTypeOf<
      Extract<keyof BootstrapWorkspaceOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AcquireWorkspaceLeaseOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof InstallRecoveryDomainOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AcquireRecoveryAttemptOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof FinalizeMechanicalEmptyRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof InstallBootstrapRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AcquireBootstrapRecoveryAttemptOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof FinalizeBootstrapRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof InstallDelegatedFinalizeRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AcquireDelegatedFinalizeRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof FinalizeDelegatedRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof InstallPrestartRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AcquirePrestartRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof FinalizePrestartRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof InstallMutationRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AcquireMutationRecoveryAttemptOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof ResumeMutationRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof InstallSameHostRebootRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof AcquireSameHostRebootRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof FinalizeSameHostRebootRecoveryOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
    expectTypeOf<
      Extract<keyof EvaluateWorkspaceSafetyDiskOptions, ForbiddenAuthorityKey>
    >().toEqualTypeOf<never>();
  });

  it('forbids production code from importing any test-only authority seam', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const offenders = productionTypeScriptFiles(sourceRoot).filter((path) =>
      /from\s+['"][^'"]*(?:identity|recovery|workspace)-authority-test-seam(?:\.js)?['"]/u.test(
        readFileSync(path, 'utf8'),
      ),
    );
    expect(offenders).toEqual([]);
  });

  it('allows direct Controlled imports only inside the fixed trusted coordinators', () => {
    const workspaceSafety = fileURLToPath(new URL('.', import.meta.url));
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const allowed = new Set([
      'workspace-safety/delegated-recovery.ts|./recovery-attempt.js',
      'workspace-safety/prestart-recovery.ts|./recovery-attempt.js',
      'workspace-safety/mutation-recovery.ts|./recovery-attempt.js',
      'workspace-safety/reboot-recovery.ts|./recovery-attempt.js',
      'workspace-safety/reboot-recovery.ts|./recovery-finalize.js',
      'workspace-safety/reboot-recovery.ts|./delegated-recovery.js',
      'workspace-safety/reboot-recovery.ts|./delegated-recovery-finalize.js',
      'workspace-safety/reboot-recovery.ts|./prestart-recovery.js',
      'workspace-safety/reboot-recovery.ts|./prestart-recovery-finalize.js',
      'workspace-safety/recovery-session.ts|./recovery-finalize.js',
      'workspace-safety/bootstrap.ts|./lease.js',
      'workspace-safety/mutation-recovery.ts|./mutation-domain.js',
      'workspace-safety/mutation.ts|./mutation-domain.js',
      'workspace-safety/operation.ts|./operation-records.js',
      'workspace-safety/posix-supervisor.ts|./operation.js',
      'workspace-safety/windows-supervisor-integration.ts|./operation.js',
    ]);
    const offenders: string[] = [];
    for (const path of productionTypeScriptFiles(sourceRoot)) {
      const source = readFileSync(path, 'utf8');
      const imports = source.matchAll(
        /import\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gu,
      );
      for (const match of imports) {
        if (!match[1].includes('Controlled')) continue;
        const key = `${sourcePath(sourceRoot, path)}|${match[2]}`;
        if (!allowed.has(key)) offenders.push(key);
      }
    }
    expect(offenders).toEqual([]);
    const identityAuthorityOffenders = productionTypeScriptFiles(sourceRoot)
      .filter((path) => sourcePath(sourceRoot, path) !== 'workspace-safety/identity.ts')
      .filter((path) =>
        readFileSync(path, 'utf8').includes('captureExactCurrentIdentityAuthorityControlled'),
      )
      .map((path) => sourcePath(sourceRoot, path));
    expect(identityAuthorityOffenders).toEqual([]);
    expect(readFileSync(join(workspaceSafety, 'recovery.ts'), 'utf8')).not.toContain('Controlled');
  });

  it('forbids broad and re-export access to every authority-controlled module', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const offenders: string[] = [];
    const broadAccess = [
      /import\s+\*\s+as\s+[^\s]+\s+from\s+['"]([^'"]+)['"]/gu,
      /import\s+[A-Za-z_$][\w$]*\s+from\s+['"]([^'"]+)['"]/gu,
      /export\s+\*\s+from\s+['"]([^'"]+)['"]/gu,
      /import\s*\(\s*['"]([^'"]+)['"]\s*\)/gu,
    ];
    for (const path of productionTypeScriptFiles(sourceRoot)) {
      const filename = sourcePath(sourceRoot, path);
      const source = readFileSync(path, 'utf8');
      for (const pattern of broadAccess) {
        for (const match of source.matchAll(pattern)) {
          if (authorityControlledModule(match[1])) offenders.push(`${filename}|${match[1]}`);
        }
      }
      for (const match of source.matchAll(
        /export\s+(?:type\s+)?\{([^}]*)\}\s+from\s+['"]([^'"]+)['"]/gu,
      )) {
        if (match[1].includes('Controlled') && authorityControlledModule(match[2])) {
          offenders.push(`${filename}|${match[2]}`);
        }
      }
    }
    expect(offenders).toEqual([]);
  });

  it('threads the exact system owner probe through every formal attempt acquisition', () => {
    const workspaceSafety = fileURLToPath(new URL('.', import.meta.url));
    const wrappers = [
      ['recovery-attempt.ts', 'acquireRecoveryAttempt'],
      ['bootstrap-recovery.ts', 'acquireBootstrapRecoveryAttempt'],
      ['delegated-recovery.ts', 'acquireDelegatedFinalizeRecovery'],
      ['prestart-recovery.ts', 'acquirePrestartRecovery'],
      ['mutation-recovery.ts', 'acquireMutationRecoveryAttempt'],
    ] as const;

    for (const [filename, functionName] of wrappers) {
      const source = readFileSync(join(workspaceSafety, filename), 'utf8');
      const start = source.indexOf(`export async function ${functionName}(`);
      expect(start, `${functionName} formal wrapper is missing`).toBeGreaterThanOrEqual(0);
      const nextExport = source.indexOf('\nexport ', start + 1);
      const body = source.slice(start, nextExport < 0 ? undefined : nextExport);
      expect(body, `${functionName} can fall back to a separate attempt-owner probe`).toContain(
        'probeAttemptOwner: system.probeOwner',
      );
    }
  });

  it('keeps workspace owner cores and handle construction inside their fixed modules', () => {
    const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
    const allowedByAuthorityName = new Map<string, ReadonlySet<string>>([
      ['bootstrapWorkspaceControlled', new Set(['workspace-safety/bootstrap.ts'])],
      ['acquireWorkspaceLeaseControlled', new Set(['workspace-safety/lease.ts'])],
      [
        'attachWorkspaceLeaseControlled',
        new Set(['workspace-safety/bootstrap.ts', 'workspace-safety/lease.ts']),
      ],
      ['createWorkspaceSessionControlled', new Set(['workspace-safety/session.ts'])],
    ]);
    const authorityOffenders: string[] = [];
    const constructorOffenders: string[] = [];
    const constructorOwners = new Map<string, string>([
      ['WorkspaceLeaseHandle', 'workspace-safety/lease.ts'],
      ['WorkspaceSession', 'workspace-safety/session.ts'],
      ['RecoveryAttemptHandle', 'workspace-safety/recovery-attempt.ts'],
      ['BootstrapRecoveryAttemptHandle', 'workspace-safety/bootstrap-recovery.ts'],
      ['RecoverySession', 'workspace-safety/recovery-session.ts'],
      ['SameHostRebootRecoveryHandle', 'workspace-safety/reboot-recovery.ts'],
    ]);
    for (const path of productionTypeScriptFiles(sourceRoot)) {
      const filename = sourcePath(sourceRoot, path);
      const source = readFileSync(path, 'utf8');
      for (const [name, allowedFiles] of allowedByAuthorityName) {
        if (source.includes(name) && !allowedFiles.has(filename)) {
          authorityOffenders.push(`${filename}|${name}`);
        }
      }
      for (const [name, owner] of constructorOwners) {
        if (
          new RegExp(`new\\s+(?:[A-Za-z_$][\\w$]*\\.)?${name}\\s*\\(`, 'u').test(source) &&
          filename !== owner
        ) {
          constructorOffenders.push(`${filename}|${name}`);
        }
      }
    }
    expect(authorityOffenders).toEqual([]);
    expect(constructorOffenders).toEqual([]);
  });

  it('does not allow callers to construct an unbound lease handle', () => {
    expect(
      () => new WorkspaceLeaseHandle(Symbol('forged-authority') as never, {} as never),
    ).toThrow(/authority token is invalid/u);
    expect(
      () => new WorkspaceSession(Symbol('forged-session-authority') as never, {} as never, {}),
    ).toThrow(/authority token is invalid/u);
    expect(
      () => new RecoveryAttemptHandle(Symbol('forged-recovery-authority') as never, {} as never),
    ).toThrow(/authority token is invalid/u);
    expect(
      () =>
        new BootstrapRecoveryAttemptHandle(
          Symbol('forged-bootstrap-recovery-authority') as never,
          {} as never,
        ),
    ).toThrow(/authority token is invalid/u);
    expect(
      () =>
        new RecoverySession(Symbol('forged-recovery-session-authority') as never, {} as never, {}),
    ).toThrow(/authority token is invalid/u);
    expect(
      () =>
        new SameHostRebootRecoveryHandle(
          Symbol('forged-reboot-recovery-authority') as never,
          {} as never,
        ),
    ).toThrow(/authority token is invalid/u);
  });

  it('rejects a same-host reboot handle forged through its public prototype', async () => {
    const forged = Object.create(
      SameHostRebootRecoveryHandle.prototype,
    ) as SameHostRebootRecoveryHandle;
    await expect(finalizeSameHostRebootRecovery(forged)).rejects.toThrow(/engine-issued/u);
  });

  it('drops runtime-injected hooks, clocks, and identifiers at formal workspace entrypoints', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-formal-hook-boundary-'));
    roots.push(workspace);
    const unauthorized = join(workspace, 'unauthorized.txt');
    let bootstrapHookCalled = false;
    await bootstrapWorkspace({
      workspacePath: workspace,
      ownerId: '00000000-0000-4000-8000-0000000000e2',
      now: () => new Date(0),
      hooks: {
        afterMarkerInstalled: () => {
          bootstrapHookCalled = true;
          writeFileSync(unauthorized, 'should never run');
        },
      },
    } as unknown as BootstrapWorkspaceOptions);
    expect(bootstrapHookCalled).toBe(false);
    expect(existsSync(unauthorized)).toBe(false);

    let leaseHookCalled = false;
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      command: 'run',
      ownerId: '00000000-0000-4000-8000-0000000000e3',
      now: () => new Date(0),
      hooks: {
        afterLeaseInstalled: () => {
          leaseHookCalled = true;
        },
      },
    } as unknown as AcquireWorkspaceLeaseOptions);
    expect(leaseHookCalled).toBe(false);
    expect(lease.owner.ownerId).not.toBe('00000000-0000-4000-8000-0000000000e3');
    await lease.release();
  });

  it('ignores runtime-injected owner identity and keeps the real live writer authoritative', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-live-owner-authority-'));
    roots.push(workspace);
    const actual = createIdentityProbe().current();
    const forged = { ...actual, pid: 2_000_000_000 };
    const bootstrapOwnerId = '00000000-0000-4000-8000-0000000000e1';
    await bootstrapWorkspace({
      workspacePath: workspace,
      ownerId: bootstrapOwnerId,
      identity: forged,
    } as unknown as BootstrapWorkspaceOptions);
    const bootstrapArchive = readdirSync(join(workspace, PROTOCOL_ROOT_DIR, INCIDENTS_DIR));
    expect(bootstrapArchive).toHaveLength(1);
    const archivedOwner = JSON.parse(
      readFileSync(
        join(workspace, PROTOCOL_ROOT_DIR, INCIDENTS_DIR, bootstrapArchive[0], OWNER_FILE),
        'utf8',
      ),
    ) as OwnerRecord;
    expect(archivedOwner).toMatchObject(actual);
    expect(archivedOwner.pid).not.toBe(forged.pid);
    expect(archivedOwner.ownerId).not.toBe(bootstrapOwnerId);

    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      command: 'repair',
      identity: forged,
    } as unknown as AcquireWorkspaceLeaseOptions);
    expect(lease.owner).toMatchObject(actual);
    expect(lease.owner.pid).not.toBe(forged.pid);
    const sourceSession = createWorkspaceSession(lease);
    const source = await captureRecoverySourceSnapshotDigest(workspace);
    const before = treeDigest(workspace);

    await expect(
      installRecoveryDomain({ workspacePath: workspace, expectedSourceSnapshotDigest: source }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(treeDigest(workspace)).toBe(before);
    expect(
      readdirSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR)).filter(
        (name) => name === RECOVERY_DIR || name.startsWith('recovery.prepare-'),
      ),
    ).toEqual([]);
    await sourceSession.writer.writeFile('source-owner-still-live.txt', 'still-authoritative');
    expect(readFileSync(join(workspace, 'source-owner-still-live.txt'), 'utf8')).toBe(
      'still-authoritative',
    );
    await sourceSession.close();
  });

  it('does not forward runtime-only recovery IDs, clocks, or hooks', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-formal-recovery-hook-boundary-'));
    roots.push(workspace);
    const current = createIdentityProbe().current();
    await bootstrapWorkspace({ workspacePath: workspace });
    await acquireWorkspaceLeaseWithAuthority({
      workspacePath: workspace,
      command: 'repair',
      identity: {
        ...current,
        pid: 2_000_000_000,
      },
    });
    const source = await captureRecoverySourceSnapshotDigest(workspace);
    let hookCalled = false;
    const handle = await installRecoveryDomain({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: source,
      recoveryId: '00000000-0000-4000-8000-0000000000e4',
      attemptId: '00000000-0000-4000-8000-0000000000e5',
      now: () => new Date(0),
      hooks: {
        afterRecoveryInstalled: () => {
          hookCalled = true;
        },
      },
    } as unknown as InstallRecoveryDomainOptions);
    expect(hookCalled).toBe(false);
    expect(handle.owner.attemptId).not.toBe('00000000-0000-4000-8000-0000000000e5');
  });

  it('does not let a runtime-injected disk probe rewrite the formal evaluation', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-formal-disk-evaluator-boundary-'));
    roots.push(workspace);
    await bootstrapWorkspace({ workspacePath: workspace });
    const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
    const expected = await evaluateWorkspaceSafetyDisk({ workspacePath: workspace });
    const forgedProbe = {
      platform: process.platform,
      evidenceKind: 'fixture',
      currentIdentity: () => createIdentityProbe().current(),
      probeOwner: () => 'dead',
      probeProcessIdentity: () => ({ status: 'missing' }),
      probeSupervisor: () => 'dead',
      probeContainment: () => 'empty',
    } as unknown as WorkspaceSafetyDiskProbeAdapter;
    const injected = await evaluateWorkspaceSafetyDisk({
      workspacePath: workspace,
      probe: forgedProbe,
      now: () => new Date(0),
    } as unknown as EvaluateWorkspaceSafetyDiskOptions);
    expect(injected).toEqual(expected);
    await lease.release();
  });

  it('does not let a fixture-forged claim make the formal finalizer archive a live owner', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-live-owner-finalize-'));
    roots.push(workspace);
    const identity = createIdentityProbe().current();
    await bootstrapWorkspace({ workspacePath: workspace });
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      command: 'repair',
    });
    const sourceSession = createWorkspaceSession(lease);
    const source = await captureRecoverySourceSnapshotDigest(workspace);
    const handle = await installRecoveryDomainWithAuthority({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: source,
      identity,
      mode: 'mechanical-empty',
      probeSourceOwner: () => 'dead',
    });
    const before = treeDigest(workspace);

    await expect(finalizeMechanicalEmptyRecovery(handle)).rejects.toMatchObject({
      code: 'conflict',
    });

    expect(treeDigest(workspace)).toBe(before);
    expect(readdirSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toContain(
      RECOVERY_DIR,
    );
    await sourceSession.writer.writeFile('source-owner-still-live.txt', 'still-authoritative');
    expect(readFileSync(join(workspace, 'source-owner-still-live.txt'), 'utf8')).toBe(
      'still-authoritative',
    );
  });
});
