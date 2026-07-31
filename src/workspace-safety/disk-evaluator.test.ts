import { linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from './workspace-authority-test-seam.js';
import { captureBootstrapRecoverySourceSnapshotDigest } from './bootstrap-recovery.js';
import { type WorkspaceSafetyDiskProbeAdapter } from './disk-evaluator.js';
import { digestBytes } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from './workspace-authority-test-seam.js';
import { runWorkspaceMutationWithAuthority as runWorkspaceMutation } from './mutation-authority-test-seam.js';
import { ACTIVE_CHILD_FILE, DELEGATED_BASELINE_FILE, parseActiveChildRecord } from './operation.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from './operation-authority-test-seam.js';
import {
  createQuarantineRecordBytes,
  QUARANTINE_FILE,
  upgradeContainmentQuarantine,
} from './quarantine.js';
import { encodeSupervisorStart } from './supervisor-protocol.js';
import { createWorkspaceSession } from './session.js';
import { captureRecoverySourceSnapshotDigest, readRecoveryDomain } from './recovery.js';
import {
  finalizePrestartRecoveryWithAuthority as finalizePrestartRecovery,
  installBootstrapRecoveryDomainWithAuthority as installBootstrapRecoveryDomain,
  installDelegatedFinalizeRecoveryWithAuthority as installDelegatedFinalizeRecovery,
  installMutationRecoveryDomainWithAuthority as installMutationRecoveryDomain,
  installPrestartRecoveryWithAuthority as installPrestartRecovery,
  installRecoveryDomainWithAuthority as installRecoveryDomain,
  installRecoveryDomainWithModeAuthority,
  evaluateWorkspaceSafetyDiskWithAuthority as evaluateWorkspaceSafetyDisk,
} from './recovery-authority-test-seam.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  WORKSPACE_MARKER_FILE,
  type IdentityVerdict,
  type ProcessIdentitySnapshot,
} from './types.js';
import {
  defaultOptions,
  driveToArmed,
  HELPER_BYTES,
  operationPath,
  setupOperationTest,
  supervisor,
} from './__fixtures__/operation-test-support.js';

const roots: string[] = [];
const HOST_A = `sha256:${'a'.repeat(64)}`;
const HOST_B = `sha256:${'b'.repeat(64)}`;
const BOOT = `sha256:${'c'.repeat(64)}`;
const OWNER_ID = '00000000-0000-4000-8000-000000000010';
const RECOVERY_ID = '00000000-0000-4000-8000-000000000020';
const ATTEMPT_ID = '00000000-0000-4000-8000-000000000030';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function workspace(prefix = 'coding-x-disk-evaluator-'): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  roots.push(path);
  return path;
}

function identity(
  platform: WorkspaceSafetyDiskProbeAdapter['platform'] = 'linux',
  hostId = HOST_A,
  pid = 101,
): ProcessIdentitySnapshot {
  return {
    pid,
    processIdentity: {
      kind:
        platform === 'linux'
          ? 'linux-boot-start'
          : platform === 'darwin'
            ? 'macos-boot-start'
            : 'windows-filetime',
      value: platform === 'darwin' ? 'Thu Jul 30 00:00:01 2026' : String(1_000_000 + pid),
    },
    bootIdentity: BOOT,
    hostId,
  };
}

function fixtureProbe(
  options: {
    readonly platform?: WorkspaceSafetyDiskProbeAdapter['platform'];
    readonly owner?: IdentityVerdict;
    readonly currentHost?: string;
    readonly supervisor?: 'alive' | 'dead' | 'unknown';
    readonly containment?: 'empty' | 'alive' | 'unknown';
    readonly onOwnerProbe?: () => void;
  } = {},
): WorkspaceSafetyDiskProbeAdapter {
  const platform = options.platform ?? 'linux';
  return {
    platform,
    evidenceKind: 'fixture',
    currentIdentity: () => identity(platform, options.currentHost ?? HOST_A, 900),
    probeOwner: () => {
      options.onOwnerProbe?.();
      return options.owner ?? 'dead';
    },
    probeSupervisor: () => options.supervisor ?? 'dead',
    probeContainment: () => options.containment ?? 'empty',
  };
}

async function readyWorkspace(
  platform: WorkspaceSafetyDiskProbeAdapter['platform'] = 'linux',
): Promise<string> {
  const path = workspace();
  await bootstrapWorkspace({
    workspacePath: path,
    identity: identity(platform, HOST_A, 100),
    ownerId: '00000000-0000-4000-8000-000000000001',
  });
  return path;
}

async function activeWorkspace(
  platform: WorkspaceSafetyDiskProbeAdapter['platform'] = 'linux',
): Promise<string> {
  const path = await readyWorkspace(platform);
  await acquireWorkspaceLease({
    workspacePath: path,
    identity: identity(platform, HOST_A, 101),
    ownerId: OWNER_ID,
    command: 'run',
  });
  return path;
}

function leasePath(path: string): string {
  return join(path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
}

async function inspectInsideOperation(
  drive: (operation: Parameters<Parameters<typeof runWorkspaceOperation>[2]>[0]) => Promise<void>,
  probe: WorkspaceSafetyDiskProbeAdapter,
): Promise<Awaited<ReturnType<typeof evaluateWorkspaceSafetyDisk>>> {
  const { workspace: path, session } = await setupOperationTest(roots);
  return await new Promise((resolve, reject) => {
    void runWorkspaceOperation(session, defaultOptions(), async (operation) => {
      try {
        await drive(operation);
        resolve(
          await evaluateWorkspaceSafetyDisk({
            workspacePath: path,
            probe,
            now: () => new Date('2026-07-30T00:01:02.000Z'),
          }),
        );
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      return await new Promise<never>(() => undefined);
    }).catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}

async function armedReceiptedWorkspace(sourceIdentity?: ProcessIdentitySnapshot): Promise<string> {
  const { workspace: path, session } = await setupOperationTest(roots, sourceIdentity);
  return await new Promise((resolve, reject) => {
    void runWorkspaceOperation(session, defaultOptions(), async (operation) => {
      try {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(
          encodeSupervisorStart(armed.operationId, armed.activeChildDigest),
          armed,
        );
        const drained = machine.drain(
          'posix-group-empty-and-pipes-eof-v1',
          'natural',
          new Date('2026-07-30T00:00:03.000Z'),
        );
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        resolve(path);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
      return await new Promise<never>(() => undefined);
    }).catch((error: unknown) => reject(error instanceof Error ? error : new Error(String(error))));
  });
}

async function installDelegatedRecoveryWithOptionalContainment(
  withContainment: boolean,
): Promise<{ path: string; priorBytes?: Buffer }> {
  const path = await armedReceiptedWorkspace();
  const operation = operationPath(path);
  const activeBytes = readFileSync(join(operation, ACTIVE_CHILD_FILE));
  const active = parseActiveChildRecord(activeBytes);
  const baselineBytes = readFileSync(join(operation, DELEGATED_BASELINE_FILE));
  const ownerBytes = readFileSync(join(leasePath(path), OWNER_FILE));
  let priorBytes: Buffer | undefined;
  await installDelegatedFinalizeRecovery({
    workspacePath: path,
    recoveryId: RECOVERY_ID,
    attemptId: ATTEMPT_ID,
    identity: identity('linux', HOST_B, 202),
    probeSourceOwner: () => 'dead',
    probeSupervisor: () => 'dead',
    probeContainment: () => 'empty',
  });
  if (withContainment) {
    priorBytes = createQuarantineRecordBytes({
      ownerId: OWNER_ID,
      operationId: active.operationId,
      activeChildDigest: digestBytes(activeBytes),
      delegatedBaselineDigest: digestBytes(baselineBytes),
      creator: { kind: 'owner', id: OWNER_ID, recordDigest: digestBytes(ownerBytes) },
      reason: 'containment-unconfirmed',
      priorQuarantineDigest: null,
      createdAt: '2026-07-30T00:00:04.000Z',
    });
    writeFileSync(join(operation, QUARANTINE_FILE), priorBytes);
  }
  return { path, ...(priorBytes ? { priorBytes } : {}) };
}

describe('internal workspace safety disk evaluator', () => {
  it('maps strict empty, legacy artifacts, and initialized idle workspaces', async () => {
    const empty = workspace();
    expect(
      await evaluateWorkspaceSafetyDisk({ workspacePath: empty, probe: fixtureProbe() }),
    ).toMatchObject({ classification: 'uninitialized-empty', reason: 'none' });

    const legacy = workspace();
    writeFileSync(join(legacy, 'state.json'), '{}');
    expect(
      await evaluateWorkspaceSafetyDisk({ workspacePath: legacy, probe: fixtureProbe() }),
    ).toMatchObject({ classification: 'legacy', reason: 'legacy-runtime-artifacts' });

    const ready = await readyWorkspace();
    expect(
      await evaluateWorkspaceSafetyDisk({ workspacePath: ready, probe: fixtureProbe() }),
    ).toMatchObject({ classification: 'ready', operationState: 'none' });
  });

  it('classifies an ordinary legacy lock file before requiring the new permanent directory', async () => {
    const path = workspace();
    const legacyBytes = JSON.stringify({
      pid: 123,
      startedAt: '2026-07-16T00:00:00.000Z',
      command: 'run',
    });
    writeFileSync(join(path, PROTOCOL_ROOT_DIR), legacyBytes);

    await expect(
      evaluateWorkspaceSafetyDisk({ workspacePath: path, probe: fixtureProbe() }),
    ).resolves.toMatchObject({
      classification: 'legacy',
      reason: 'legacy-runtime-artifacts',
      diagnostic: expect.stringContaining('永久协议根'),
      safetyFingerprint: expect.stringMatching(/^sha256:[0-9a-f]{64}$/u),
    });
    expect(readFileSync(join(path, PROTOCOL_ROOT_DIR), 'utf8')).toBe(legacyBytes);
  });

  it('fails closed when a legacy lock changes after its initial bound snapshot', async () => {
    const path = workspace();
    const lockPath = join(path, PROTOCOL_ROOT_DIR);
    writeFileSync(lockPath, JSON.stringify({ pid: 123 }));
    let changed = false;

    const result = await evaluateWorkspaceSafetyDisk({
      workspacePath: path,
      probe: fixtureProbe(),
      hooks: {
        afterInitialSafetySnapshot: () => {
          if (changed) return;
          changed = true;
          writeFileSync(lockPath, JSON.stringify({ pid: 456, changed: true }));
        },
      },
    });

    expect(result).toMatchObject({
      classification: 'invalid',
      reason: 'invalid-safety-record',
      diagnostic: expect.stringMatching(/safety (?:records|root structure) changed/u),
    });
  });

  it.each(['linux', 'darwin', 'win32'] as const)(
    'uses an injected %s adapter fixture without claiming a host platform proof',
    async (platform) => {
      const path = await activeWorkspace(platform);
      const result = await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ platform, owner: 'alive' }),
      });
      expect(result).toMatchObject({
        classification: 'active',
        probeEvidence: 'fixture',
        facts: { owner: 'alive', foreignHost: false },
      });
    },
  );

  it('requires exact owner death and same-host evidence for idle recovery', async () => {
    const path = await activeWorkspace();
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead' }),
      }),
    ).toMatchObject({ classification: 'recoverable', facts: { owner: 'dead' } });
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead', currentHost: HOST_B }),
      }),
    ).toMatchObject({ classification: 'isolated', reason: 'foreign-host' });
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'unknown' }),
      }),
    ).toMatchObject({ classification: 'isolated', facts: { owner: 'unknown' } });
  });

  it('recognizes the legal marker-missing bootstrap lease and its recovery domain', async () => {
    const path = workspace();
    await expect(
      bootstrapWorkspace({
        workspacePath: path,
        identity: identity(),
        ownerId: OWNER_ID,
        hooks: { afterProtocolRootInstalled: () => Promise.reject(new Error('crash')) },
      }),
    ).rejects.toThrow('crash');

    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead' }),
      }),
    ).toMatchObject({
      classification: 'recoverable',
      reason: 'bootstrap-in-progress',
      facts: { bootstrapLease: true, marker: 'absent', protocol: 'valid', lease: 'valid' },
    });

    const source = await captureBootstrapRecoverySourceSnapshotDigest(path);
    await installBootstrapRecoveryDomain({
      workspacePath: path,
      expectedSourceSnapshotDigest: source,
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_ID,
      identity: identity('linux', HOST_A, 202),
      probeSourceOwner: () => 'dead',
    });
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead' }),
      }),
    ).toMatchObject({
      classification: 'recovering',
      reason: 'bootstrap-in-progress',
      facts: { bootstrapLease: true, recovery: 'valid' },
    });

    const linked = workspace();
    await expect(
      bootstrapWorkspace({
        workspacePath: linked,
        identity: identity(),
        ownerId: OWNER_ID,
        hooks: { beforeMarkerSourceUnlink: () => Promise.reject(new Error('linked crash')) },
      }),
    ).rejects.toThrow('linked crash');
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: linked,
        probe: fixtureProbe({ owner: 'dead' }),
      }),
    ).toMatchObject({
      classification: 'recoverable',
      reason: 'bootstrap-in-progress',
      facts: { bootstrapLease: true, marker: 'valid' },
    });
  });

  it('reports a strictly installed recovery as recovering', async () => {
    const path = await activeWorkspace();
    const source = await captureRecoverySourceSnapshotDigest(path);
    await installRecoveryDomain({
      workspacePath: path,
      expectedSourceSnapshotDigest: source,
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_ID,
      identity: identity('linux', HOST_A, 202),
      mode: 'mechanical-empty',
      probeSourceOwner: () => 'dead',
    });
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead' }),
      }),
    ).toMatchObject({ classification: 'recovering', facts: { recovery: 'valid' } });
  });

  it('preserves terminal quarantine priority and lets valid recovery outrank containment quarantine', async () => {
    for (const reason of ['operation-proof-missing', 'containment-unconfirmed'] as const) {
      const path = await activeWorkspace();
      const ownerBytes = readFileSync(join(leasePath(path), OWNER_FILE));
      writeFileSync(
        join(leasePath(path), QUARANTINE_FILE),
        createQuarantineRecordBytes({
          ownerId: OWNER_ID,
          operationId: null,
          activeChildDigest: null,
          delegatedBaselineDigest: null,
          creator: { kind: 'owner', id: OWNER_ID, recordDigest: digestBytes(ownerBytes) },
          reason,
          priorQuarantineDigest: null,
          createdAt: '2026-07-30T00:00:02.000Z',
        }),
      );
      const source = await captureRecoverySourceSnapshotDigest(path);
      await installRecoveryDomainWithModeAuthority(
        {
          workspacePath: path,
          expectedSourceSnapshotDigest: source,
          recoveryId: RECOVERY_ID,
          attemptId: ATTEMPT_ID,
          identity: identity('linux', HOST_A, 202),
          mode: 'mechanical-empty',
          probeSourceOwner: () => 'dead',
        },
        { mode: 'mechanical-empty', verifySource: async () => undefined },
      );
      const result = await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead' }),
      });
      expect(result.classification).toBe(
        reason === 'containment-unconfirmed' ? 'recovering' : 'isolated',
      );
    }
  });

  it('fails closed for unknown canonical entries, hard links, and records changing during a probe', async () => {
    const unknown = await readyWorkspace();
    writeFileSync(join(unknown, PROTOCOL_ROOT_DIR, 'rogue.json'), '{}');
    expect(
      await evaluateWorkspaceSafetyDisk({ workspacePath: unknown, probe: fixtureProbe() }),
    ).toMatchObject({ classification: 'invalid' });

    const linked = await readyWorkspace();
    linkSync(join(linked, WORKSPACE_MARKER_FILE), join(linked, 'marker-alias'));
    expect(
      await evaluateWorkspaceSafetyDisk({ workspacePath: linked, probe: fixtureProbe() }),
    ).toMatchObject({ classification: 'invalid' });

    const changing = await activeWorkspace();
    const ownerPath = join(leasePath(changing), OWNER_FILE);
    const ownerBytes = readFileSync(ownerPath);
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: changing,
        probe: fixtureProbe({
          owner: 'dead',
          onOwnerProbe: () => writeFileSync(ownerPath, ownerBytes),
        }),
      }),
    ).toMatchObject({ classification: 'invalid' });
  });

  it('strictly observes valid mutation and mutation-resume domains', async () => {
    const path = await readyWorkspace();
    writeFileSync(join(path, 'state.json'), 'before');
    const lease = await acquireWorkspaceLease({
      workspacePath: path,
      identity: identity('linux', HOST_A, 101),
      ownerId: OWNER_ID,
      command: 'repair',
    });
    const session = createWorkspaceSession(lease);
    await expect(
      runWorkspaceMutation(session, {
        kind: 'repair-v1',
        writes: [{ path: 'state.json', data: 'after' }],
        deletes: [],
        archivePaths: ['state.json'],
        hooks: { afterApplyingState: () => Promise.reject(new Error('fixture stop')) },
      }),
    ).rejects.toThrow(/fixture stop/);
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead' }),
      }),
    ).toMatchObject({
      classification: 'recoverable',
      facts: { recoveryInputs: 'valid', recovery: 'absent' },
      unsupportedCanonical: [],
    });

    await installMutationRecoveryDomain({
      workspacePath: path,
      identity: identity('linux', HOST_A, 900),
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_ID,
      probeSourceOwner: () => 'dead',
    });
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead' }),
      }),
    ).toMatchObject({ classification: 'recovering', facts: { recovery: 'valid' } });
  });

  it('fails closed for a malformed fixed mutation instead of treating it as recoverable', async () => {
    const path = await activeWorkspace();
    mkdirSync(join(leasePath(path), 'mutation'));
    writeFileSync(join(leasePath(path), 'mutation', 'state.json'), '{}');
    expect(
      await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({ owner: 'dead' }),
      }),
    ).toMatchObject({ classification: 'invalid', reason: 'invalid-safety-record' });
  });

  it('validates prepared and prepared-bound baselines before reporting recoverable', async () => {
    const prepared = await inspectInsideOperation(
      async () => undefined,
      fixtureProbe({ owner: 'dead', currentHost: HOST_B }),
    );
    expect(prepared).toMatchObject({
      classification: 'recoverable',
      operationState: 'prepared',
      facts: { recoveryInputs: 'valid', containment: 'not-applicable' },
    });

    const preparedBound = await inspectInsideOperation(
      async (operation) => {
        await operation.bindSupervisorControlled(supervisor);
      },
      fixtureProbe({ owner: 'dead', currentHost: HOST_B, supervisor: 'dead' }),
    );
    expect(preparedBound).toMatchObject({
      classification: 'recoverable',
      operationState: 'prepared-bound',
      facts: { recoveryInputs: 'valid', containment: 'not-applicable' },
    });
  });

  it('observes a real prepared-bound recovery before and after operation settlement', async () => {
    const setup = await setupOperationTest(roots);
    let preparedBound!: () => void;
    const ready = new Promise<void>((resolve) => {
      preparedBound = resolve;
    });
    void runWorkspaceOperation(setup.session, defaultOptions(), async (operation) => {
      await operation.bindSupervisorControlled(supervisor);
      preparedBound();
      return await new Promise<never>(() => undefined);
    });
    await ready;
    const probes = {
      helperBytes: HELPER_BYTES,
      probeSourceOwner: () => 'dead' as const,
      probeSupervisor: () => 'dead' as const,
    };
    const handle = await installPrestartRecovery({
      workspacePath: setup.workspace,
      identity: createIdentityProbe().current(),
      ...probes,
    });
    await expect(
      evaluateWorkspaceSafetyDisk({
        workspacePath: setup.workspace,
        probe: fixtureProbe({ owner: 'dead', supervisor: 'dead' }),
      }),
    ).resolves.toMatchObject({
      classification: 'recovering',
      operationState: 'prepared-bound',
      operationLocation: 'active',
    });

    let settledEvaluation: Awaited<ReturnType<typeof evaluateWorkspaceSafetyDisk>> | undefined;
    await finalizePrestartRecovery(handle, {
      ...probes,
      hooks: {
        afterOperationSettled: async () => {
          settledEvaluation = await evaluateWorkspaceSafetyDisk({
            workspacePath: setup.workspace,
            probe: fixtureProbe({ owner: 'dead', supervisor: 'dead' }),
          });
        },
      },
    });
    expect(settledEvaluation).toMatchObject({
      classification: 'recovering',
      operationState: 'prepared-bound',
      operationLocation: 'settled',
    });
    await expect(
      evaluateWorkspaceSafetyDisk({ workspacePath: setup.workspace, probe: fixtureProbe() }),
    ).resolves.toMatchObject({ classification: 'ready' });
  });

  it('keeps armed work isolated without exact receipt proof and accepts exact drained proof', async () => {
    const liveMissing = await inspectInsideOperation(
      async (operation) => {
        await driveToArmed(operation);
      },
      fixtureProbe({
        owner: 'alive',
        currentHost: HOST_B,
        supervisor: 'alive',
        containment: 'alive',
      }),
    );
    expect(liveMissing).toMatchObject({
      classification: 'active',
      reason: 'none',
      operationState: 'armed',
      facts: { quarantine: null },
    });

    const missing = await inspectInsideOperation(
      async (operation) => {
        await driveToArmed(operation);
      },
      fixtureProbe({
        owner: 'dead',
        currentHost: HOST_B,
        supervisor: 'dead',
        containment: 'empty',
      }),
    );
    expect(missing).toMatchObject({
      classification: 'isolated',
      reason: 'operation-proof-missing',
      operationState: 'armed',
      facts: {
        quarantine: 'operation-proof-missing',
        recoveryInputs: 'insufficient',
      },
    });

    const receipted = await inspectInsideOperation(
      async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(
          encodeSupervisorStart(armed.operationId, armed.activeChildDigest),
          armed,
        );
        const drained = machine.drain(
          'posix-group-empty-and-pipes-eof-v1',
          'natural',
          new Date('2026-07-30T00:00:03.000Z'),
        );
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
      },
      fixtureProbe({
        owner: 'dead',
        currentHost: HOST_B,
        supervisor: 'dead',
        containment: 'empty',
      }),
    );
    expect(receipted).toMatchObject({
      classification: 'recoverable',
      operationState: 'armed',
      facts: { recoveryInputs: 'valid', containment: 'empty' },
    });
  });

  it.each([false, true])(
    'accepts recovery-created integrity quarantine with prior containment=%s',
    async (withPrior) => {
      const { path, priorBytes } = await installDelegatedRecoveryWithOptionalContainment(withPrior);
      const operation = operationPath(path);
      const activeBytes = readFileSync(join(operation, ACTIVE_CHILD_FILE));
      const active = parseActiveChildRecord(activeBytes);
      const baselineBytes = readFileSync(join(operation, DELEGATED_BASELINE_FILE));
      const domain = await readRecoveryDomain(path);
      if (!domain.attemptOwner || !domain.attemptOwnerBytes) {
        throw new Error('test recovery attempt is missing');
      }
      const integrityBytes = createQuarantineRecordBytes({
        ownerId: OWNER_ID,
        operationId: active.operationId,
        activeChildDigest: digestBytes(activeBytes),
        delegatedBaselineDigest: digestBytes(baselineBytes),
        creator: {
          kind: 'recovery-attempt',
          id: domain.attemptOwner.attemptId,
          recordDigest: digestBytes(domain.attemptOwnerBytes),
        },
        reason: 'workspace-integrity-violation',
        priorQuarantineDigest: priorBytes ? digestBytes(priorBytes) : null,
        createdAt: '2026-07-30T00:00:05.000Z',
      });
      if (priorBytes) {
        await upgradeContainmentQuarantine({
          containerPath: operation,
          priorBytes,
          recordBytes: integrityBytes,
          verifyAuthority: () => undefined,
        });
      } else {
        writeFileSync(join(operation, QUARANTINE_FILE), integrityBytes);
      }

      const evaluated = await evaluateWorkspaceSafetyDisk({
        workspacePath: path,
        probe: fixtureProbe({
          owner: 'dead',
          currentHost: domain.sourceOwner.hostId,
          supervisor: 'dead',
          containment: 'empty',
        }),
      });
      expect(evaluated).toMatchObject({
        classification: 'isolated',
        reason: 'workspace-integrity-violation',
        facts: {
          quarantine: 'workspace-integrity-violation',
          recovery: 'valid',
        },
      });
    },
    45_000,
  );
});
