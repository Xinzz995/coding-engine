import { fork, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCrossProcessFixtureTracker,
  typeScriptFixtureExecArgv,
} from './cross-process-fixture.test-support.js';
import { digestBytes, jsonBytes } from './filesystem.js';
import { createQuarantineRecordBytes, QUARANTINE_FILE } from './quarantine.js';
import {
  captureRecoverySourceSnapshotDigest,
  createRecoveryClaimBytes,
  createRecoveryFinalManifestBytes,
  createRecoveryStateBytes,
  parseRecoveryAttemptOwner,
  parseRecoveryClaim,
  parseRecoveryFinalManifest,
  parseRecoveryState,
  readRecoveryDomain,
} from './recovery.js';
import {
  acquireRecoveryAttemptWithAuthority as acquireRecoveryAttemptControlled,
  installRecoveryDomainWithAuthority as installRecoveryDomainControlled,
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

const roots: string[] = [];
const fixtureProcesses = createCrossProcessFixtureTracker();
const RECOVERY_ID = '00000000-0000-4000-8000-0000000000a1';
const ATTEMPT_A = '00000000-0000-4000-8000-0000000000b1';
const ATTEMPT_B = '00000000-0000-4000-8000-0000000000b2';
const ATTEMPT_C = '00000000-0000-4000-8000-0000000000b3';
const DIGEST_A = `sha256:${'a'.repeat(64)}`;
const DIGEST_B = `sha256:${'b'.repeat(64)}`;
const TIMESTAMP = '2026-07-30T00:10:00.000Z';

afterEach(async () => {
  try {
    await fixtureProcesses.settle();
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { force: true, recursive: true });
  }
});

function temporaryWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'workspace-recovery-'));
  roots.push(root);
  return root;
}

function identity(pid: number): ProcessIdentitySnapshot {
  return {
    pid,
    processIdentity: { kind: 'linux-boot-start', value: String(100_000 + pid) },
    bootIdentity: DIGEST_A,
    hostId: DIGEST_B,
  };
}

function installRecoveryDomain(
  options: Parameters<typeof installRecoveryDomainControlled>[0],
): ReturnType<typeof installRecoveryDomainControlled> {
  return installRecoveryDomainControlled({
    ...options,
    probeSourceOwner: options.probeSourceOwner ?? (() => 'dead'),
  });
}

function acquireRecoveryAttempt(
  options: Parameters<typeof acquireRecoveryAttemptControlled>[0],
): ReturnType<typeof acquireRecoveryAttemptControlled> {
  return acquireRecoveryAttemptControlled({
    ...options,
    probeSourceOwner: options.probeSourceOwner ?? (() => 'dead'),
    probeAttemptOwner: options.probeAttemptOwner ?? (() => 'dead'),
  });
}

async function workspaceWithDeadOwner(): Promise<string> {
  const workspace = temporaryWorkspace();
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity: identity(1),
    ownerId: '00000000-0000-4000-8000-000000000001',
  });
  await acquireWorkspaceLease({
    workspacePath: workspace,
    identity: identity(2_000_000_000),
    ownerId: '00000000-0000-4000-8000-000000000002',
    command: 'run',
  });
  return workspace;
}

async function workspaceWithLiveOwner(): Promise<string> {
  const workspace = temporaryWorkspace();
  const current = identity(2);
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity: current,
    ownerId: '00000000-0000-4000-8000-000000000011',
  });
  await acquireWorkspaceLease({
    workspacePath: workspace,
    identity: current,
    ownerId: '00000000-0000-4000-8000-000000000012',
    command: 'run',
  });
  return workspace;
}

function activeLeasePath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
}

function recoveryStagingEntries(workspace: string): string[] {
  return readdirSync(activeLeasePath(workspace)).filter((name) =>
    name.startsWith('recovery.prepare-'),
  );
}

function claimBytes(mode: 'mechanical-empty' | 'mutation-resume' = 'mechanical-empty'): Buffer {
  return createRecoveryClaimBytes({
    recoveryId: RECOVERY_ID,
    sourceSnapshotDigest: DIGEST_A,
    mode,
    rebootProof: null,
    createdAt: new Date(TIMESTAMP),
  });
}

describe('strict recovery records', () => {
  it('round-trips canonical claim/state/final-manifest/attempt records with exact bindings', () => {
    const claim = parseRecoveryClaim(claimBytes());
    const claimDigest = digestBytes(claimBytes());
    expect(claim.targetArchive).toBe(
      `engine.lock/incidents/recovery-${RECOVERY_ID}-${'a'.repeat(16)}`,
    );

    const stateBytes = createRecoveryStateBytes({
      recoveryId: RECOVERY_ID,
      claimDigest,
      phase: 'claimed',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: null,
      updatedAt: new Date(TIMESTAMP),
    });
    expect(parseRecoveryState(stateBytes).phase).toBe('claimed');

    const manifestBytes = createRecoveryFinalManifestBytes({
      recoveryId: RECOVERY_ID,
      claimDigest,
      workspaceMarkerDigest: DIGEST_A,
      protocolDigest: DIGEST_B,
      finalSourceSnapshotDigest: DIGEST_A,
      mutationSnapshotDigest: null,
      createdAt: new Date(TIMESTAMP),
    });
    expect(parseRecoveryFinalManifest(manifestBytes).statePhase).toBe('finalizing');

    const attemptBytes = jsonBytes({
      schemaVersion: 1,
      attemptId: ATTEMPT_A,
      recoveryId: RECOVERY_ID,
      pid: 42,
      processIdentity: { kind: 'linux-boot-start', value: '1234' },
      bootIdentity: DIGEST_A,
      hostId: DIGEST_B,
      workspaceIdentity: DIGEST_A,
      startedAt: TIMESTAMP,
    });
    expect(parseRecoveryAttemptOwner(attemptBytes).attemptId).toBe(ATTEMPT_A);
  });

  it('accepts mutation-resume only as a strictly bound record shape', () => {
    const claim = parseRecoveryClaim(claimBytes('mutation-resume'));
    const state = parseRecoveryState(
      createRecoveryStateBytes({
        recoveryId: RECOVERY_ID,
        claimDigest: digestBytes(claimBytes('mutation-resume')),
        phase: 'claimed',
        expectedMutationPhase: 'applying',
        expectedMutationDigest: DIGEST_B,
        finalManifestDigest: null,
        updatedAt: new Date(TIMESTAMP),
      }),
    );
    expect(claim.mode).toBe('mutation-resume');
    expect(state.expectedMutationPhase).toBe('applying');
  });

  it.each([
    ['unknown field', (value: Record<string, unknown>) => ({ ...value, command: 'secret' })],
    [
      'wrong archive',
      (value: Record<string, unknown>) => ({ ...value, targetArchive: '../escape' }),
    ],
    [
      'bad digest',
      (value: Record<string, unknown>) => ({ ...value, sourceSnapshotDigest: 'sha256:no' }),
    ],
  ])('rejects a non-canonical or malformed claim: %s', (_name, mutate) => {
    const parsed = JSON.parse(claimBytes().toString('utf8')) as Record<string, unknown>;
    expect(() => parseRecoveryClaim(jsonBytes(mutate(parsed)))).toThrow(/recovery|invalid/i);
  });

  it('rejects valid JSON whose byte representation is not canonical', () => {
    const compact = Buffer.from(JSON.stringify(JSON.parse(claimBytes().toString('utf8'))), 'utf8');
    expect(() => parseRecoveryClaim(compact)).toThrow(/canonical/i);
  });

  it('rejects oversized records before parsing their fields', () => {
    expect(() => parseRecoveryClaim(Buffer.alloc(64 * 1024 + 1, 0x20))).toThrow(/too large/i);
  });

  it('requires state mutation and final-manifest bindings as complete pairs', () => {
    expect(() =>
      createRecoveryStateBytes({
        recoveryId: RECOVERY_ID,
        claimDigest: DIGEST_A,
        phase: 'claimed',
        expectedMutationPhase: 'applying',
        expectedMutationDigest: null,
        finalManifestDigest: null,
        updatedAt: new Date(TIMESTAMP),
      }),
    ).toThrow(/both/i);
    expect(() =>
      createRecoveryStateBytes({
        recoveryId: RECOVERY_ID,
        claimDigest: DIGEST_A,
        phase: 'verified',
        expectedMutationPhase: null,
        expectedMutationDigest: null,
        finalManifestDigest: DIGEST_B,
        updatedAt: new Date(TIMESTAMP),
      }),
    ).toThrow(/only finalizing/i);
  });

  it('strictly binds reboot proof to a changed boot on the same host', () => {
    const parsed = parseRecoveryClaim(
      createRecoveryClaimBytes({
        recoveryId: RECOVERY_ID,
        sourceSnapshotDigest: DIGEST_A,
        mode: 'mechanical-empty',
        rebootProof: {
          schemaVersion: 1,
          kind: 'same-host-boot-changed-v1',
          hostId: DIGEST_A,
          previousBootIdentity: DIGEST_A,
          currentBootIdentity: DIGEST_B,
          verifiedAt: TIMESTAMP,
        },
        createdAt: new Date(TIMESTAMP),
      }),
    );
    expect(parsed.rebootProof?.currentBootIdentity).toBe(DIGEST_B);
    expect(() =>
      createRecoveryClaimBytes({
        recoveryId: RECOVERY_ID,
        sourceSnapshotDigest: DIGEST_A,
        mode: 'mechanical-empty',
        rebootProof: {
          schemaVersion: 1,
          kind: 'same-host-boot-changed-v1',
          hostId: DIGEST_A,
          previousBootIdentity: DIGEST_A,
          currentBootIdentity: DIGEST_A,
          verifiedAt: TIMESTAMP,
        },
        createdAt: new Date(TIMESTAMP),
      }),
    ).toThrow(/different boot/i);
  });
});

describe('recovery domain installation and takeover', () => {
  it('rejects a live or unknown source owner before writing recovery staging', async () => {
    const workspace = await workspaceWithLiveOwner();
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);

    await expect(
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
        probeSourceOwner: () => 'alive',
      }),
    ).rejects.toThrow(/source owner.*(alive|unknown)/i);
    expect(recoveryStagingEntries(workspace)).toEqual([]);
    expect(existsSync(join(activeLeasePath(workspace), RECOVERY_DIR))).toBe(false);
  });

  it.each(['operation', 'mutation', 'bootstrap-input'])(
    'rejects mechanical-empty with %s before writing recovery staging',
    async (forbiddenEntry) => {
      const workspace = await workspaceWithDeadOwner();
      const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
      mkdirSync(join(activeLeasePath(workspace), forbiddenEntry));

      await expect(
        installRecoveryDomain({
          workspacePath: workspace,
          expectedSourceSnapshotDigest: sourceSnapshotDigest,
          recoveryId: RECOVERY_ID,
          attemptId: ATTEMPT_A,
          identity: identity(101),
          mode: 'mechanical-empty',
        }),
      ).rejects.toThrow(/mechanical-empty/i);
      expect(recoveryStagingEntries(workspace)).toEqual([]);
      expect(existsSync(join(activeLeasePath(workspace), RECOVERY_DIR))).toBe(false);
    },
  );

  it('strictly snapshots a root quarantine and never lets mechanical recovery consume it', async () => {
    const workspace = await workspaceWithDeadOwner();
    const quarantinePath = join(activeLeasePath(workspace), QUARANTINE_FILE);
    writeFileSync(
      quarantinePath,
      createQuarantineRecordBytes({
        ownerId: '00000000-0000-4000-8000-000000000002',
        operationId: null,
        activeChildDigest: null,
        delegatedBaselineDigest: null,
        creator: {
          kind: 'owner',
          id: '00000000-0000-4000-8000-000000000002',
          recordDigest: DIGEST_A,
        },
        reason: 'containment-unconfirmed',
        priorQuarantineDigest: null,
        createdAt: TIMESTAMP,
      }),
    );
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    await expect(
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
      }),
    ).rejects.toThrow(/mechanical-empty/i);

    writeFileSync(quarantinePath, '{}');
    await expect(captureRecoverySourceSnapshotDigest(workspace)).rejects.toMatchObject({
      code: 'invalid',
    });
    await expect(
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(recoveryStagingEntries(workspace)).toEqual([]);
  });

  it('rejects a workspace-init source owner before writing recovery staging', async () => {
    const workspace = temporaryWorkspace();
    await expect(
      bootstrapWorkspace({
        workspacePath: workspace,
        identity: identity(21),
        ownerId: '00000000-0000-4000-8000-000000000021',
        hooks: { beforeRelease: () => Promise.reject(new Error('keep-bootstrap-owner')) },
      }),
    ).rejects.toThrow(/keep-bootstrap-owner/);
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);

    await expect(
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
        probeSourceOwner: () => 'dead',
      }),
    ).rejects.toThrow(/workspace-init/i);
    expect(recoveryStagingEntries(workspace)).toEqual([]);
  });

  it.each(['delegated-finalize', 'bootstrap-complete', 'mutation-resume'] as const)(
    'parses but does not activate %s without its proof implementation',
    async (mode) => {
      const workspace = await workspaceWithDeadOwner();
      const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
      await expect(
        installRecoveryDomain({
          workspacePath: workspace,
          expectedSourceSnapshotDigest: sourceSnapshotDigest,
          recoveryId: RECOVERY_ID,
          attemptId: ATTEMPT_A,
          identity: identity(101),
          mode,
        }),
      ).rejects.toMatchObject({ code: 'unsupported' });
      expect(recoveryStagingEntries(workspace)).toEqual([]);
    },
  );

  it('allows settled operation history in mechanical-empty source', async () => {
    const workspace = await workspaceWithDeadOwner();
    mkdirSync(join(activeLeasePath(workspace), 'settled-operations'));
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    const handle = await installRecoveryDomain({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: sourceSnapshotDigest,
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_A,
      identity: identity(101),
      mode: 'mechanical-empty',
    });
    await handle.verify();
  });

  it('rechecks eligibility after whole-domain staging', async () => {
    const workspace = await workspaceWithDeadOwner();
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    await expect(
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
        hooks: {
          beforeRecoveryInstall: () => {
            mkdirSync(join(activeLeasePath(workspace), 'mutation'));
          },
        },
      }),
    ).rejects.toThrow(/mechanical-empty/i);
    expect(existsSync(join(activeLeasePath(workspace), RECOVERY_DIR))).toBe(false);
    expect(recoveryStagingEntries(workspace)).toHaveLength(1);
  });

  it('rechecks the exact source digest after whole-domain staging', async () => {
    const workspace = await workspaceWithDeadOwner();
    const settled = join(activeLeasePath(workspace), 'settled-operations');
    mkdirSync(settled);
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    await expect(
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
        hooks: {
          beforeRecoveryInstall: () => {
            writeFileSync(join(settled, 'late-source.json'), '{}\n');
          },
        },
      }),
    ).rejects.toThrow(/source snapshot (?:changed|no longer matches)/i);
    expect(existsSync(join(activeLeasePath(workspace), RECOVERY_DIR))).toBe(false);
    expect(recoveryStagingEntries(workspace)).toHaveLength(1);
  });

  it('rechecks exact-dead source ownership immediately before installation', async () => {
    const workspace = await workspaceWithDeadOwner();
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    let probes = 0;
    await expect(
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
        probeSourceOwner: () => {
          probes += 1;
          return probes === 1 ? 'dead' : 'alive';
        },
      }),
    ).rejects.toThrow(/source owner is alive/i);
    expect(probes).toBe(2);
    expect(existsSync(join(activeLeasePath(workspace), RECOVERY_DIR))).toBe(false);
    expect(recoveryStagingEntries(workspace)).toHaveLength(1);
  });

  it('installs claim/state/attempt as one no-replace recovery directory and rechecks source', async () => {
    const workspace = await workspaceWithDeadOwner();
    writeFileSync(join(workspace, 'business.txt'), 'unchanged');
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);

    const handle = await installRecoveryDomain({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: sourceSnapshotDigest,
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_A,
      identity: identity(101),
      mode: 'mechanical-empty',
      now: () => new Date(TIMESTAMP),
    });

    await handle.verify();
    const domain = await readRecoveryDomain(workspace);
    expect(domain.claim.recoveryId).toBe(RECOVERY_ID);
    expect(domain.state.phase).toBe('claimed');
    expect(domain.attemptOwner?.attemptId).toBe(ATTEMPT_A);
    expect(readFileSync(join(workspace, 'business.txt'), 'utf8')).toBe('unchanged');
  });

  it('reads a finalizing manifest only when all immutable digests bind exactly', async () => {
    const workspace = await workspaceWithDeadOwner();
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    await installRecoveryDomain({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: sourceSnapshotDigest,
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_A,
      identity: identity(101),
      mode: 'mechanical-empty',
      now: () => new Date(TIMESTAMP),
    });
    const recovery = join(activeLeasePath(workspace), RECOVERY_DIR);
    const claimOnDisk = readFileSync(join(recovery, 'claim.json'));
    const manifestBytes = createRecoveryFinalManifestBytes({
      recoveryId: RECOVERY_ID,
      claimDigest: digestBytes(claimOnDisk),
      workspaceMarkerDigest: digestBytes(readFileSync(join(workspace, WORKSPACE_MARKER_FILE))),
      protocolDigest: digestBytes(readFileSync(join(workspace, PROTOCOL_ROOT_DIR, PROTOCOL_FILE))),
      finalSourceSnapshotDigest: sourceSnapshotDigest,
      mutationSnapshotDigest: null,
      createdAt: new Date(TIMESTAMP),
    });
    writeFileSync(join(recovery, 'final-manifest.json'), manifestBytes);
    writeFileSync(
      join(recovery, 'state.json'),
      createRecoveryStateBytes({
        recoveryId: RECOVERY_ID,
        claimDigest: digestBytes(claimOnDisk),
        phase: 'finalizing',
        expectedMutationPhase: null,
        expectedMutationDigest: null,
        finalManifestDigest: digestBytes(manifestBytes),
        updatedAt: new Date(TIMESTAMP),
      }),
    );

    expect((await readRecoveryDomain(workspace)).finalManifest?.statePhase).toBe('finalizing');
    const forged = JSON.parse(manifestBytes.toString('utf8')) as Record<string, unknown>;
    writeFileSync(
      join(recovery, 'final-manifest.json'),
      jsonBytes({ ...forged, protocolDigest: DIGEST_A }),
    );
    await expect(readRecoveryDomain(workspace)).rejects.toThrow(/final manifest/i);
  });

  it('has one recovery-domain winner and leaves losing whole staging inert', async () => {
    const workspace = await workspaceWithDeadOwner();
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    const attempts = await Promise.allSettled([
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
      }),
      installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: '00000000-0000-4000-8000-0000000000a2',
        attemptId: ATTEMPT_B,
        identity: identity(102),
        mode: 'mechanical-empty',
      }),
    ]);
    expect(attempts.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(attempts.filter((result) => result.status === 'rejected')).toHaveLength(1);
    const lease = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
    expect(existsSync(join(lease, RECOVERY_DIR))).toBe(true);
    expect(readdirSync(lease).filter((name) => name.startsWith('recovery.prepare-'))).toHaveLength(
      1,
    );
    expect(await captureRecoverySourceSnapshotDigest(workspace)).toBe(sourceSnapshotDigest);
  });

  it('atomically abandons a dead attempt and resumes after a crash between move and install', async () => {
    const workspace = await workspaceWithDeadOwner();
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    await installRecoveryDomain({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: sourceSnapshotDigest,
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_A,
      identity: identity(101),
      mode: 'mechanical-empty',
    });

    await expect(
      acquireRecoveryAttempt({
        workspacePath: workspace,
        attemptId: ATTEMPT_B,
        identity: identity(102),
        probeAttemptOwner: () => 'dead',
        hooks: { afterOldAttemptAbandoned: () => Promise.reject(new Error('simulated-crash')) },
      }),
    ).rejects.toThrow(/simulated-crash/);

    const recovery = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, RECOVERY_DIR);
    expect(existsSync(join(recovery, 'lease'))).toBe(false);
    expect(
      readdirSync(join(recovery, 'attempts')).some((name) => name.startsWith('abandoned-')),
    ).toBe(true);

    const resumed = await acquireRecoveryAttempt({
      workspacePath: workspace,
      attemptId: ATTEMPT_C,
      identity: identity(103),
      probeAttemptOwner: () => 'dead',
    });
    await resumed.verify();
    expect((await readRecoveryDomain(workspace)).attemptOwner?.attemptId).toBe(ATTEMPT_C);
  });

  it.each(['alive', 'unknown'] as const)(
    'does not move an %s recovery attempt owner',
    async (verdict) => {
      const workspace = await workspaceWithDeadOwner();
      const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
      await installRecoveryDomain({
        workspacePath: workspace,
        expectedSourceSnapshotDigest: sourceSnapshotDigest,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        identity: identity(101),
        mode: 'mechanical-empty',
      });

      await expect(
        acquireRecoveryAttempt({
          workspacePath: workspace,
          attemptId: ATTEMPT_B,
          identity: identity(102),
          probeAttemptOwner: () => verdict,
        }),
      ).rejects.toThrow(new RegExp(verdict, 'i'));
      const domain = await readRecoveryDomain(workspace);
      expect(domain.attemptOwner?.attemptId).toBe(ATTEMPT_A);
      expect(
        readdirSync(join(activeLeasePath(workspace), RECOVERY_DIR, 'attempts')).filter((name) =>
          name.startsWith('abandoned-'),
        ),
      ).toEqual([]);
      expect(
        readdirSync(join(activeLeasePath(workspace), RECOVERY_DIR, 'attempts')).filter((name) =>
          name.startsWith('prepared-'),
        ),
      ).toEqual([]);
    },
  );

  it('allows only one of two real processes to replace a dead recovery attempt', async () => {
    const workspace = await workspaceWithDeadOwner();
    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    await installRecoveryDomain({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: sourceSnapshotDigest,
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_A,
      identity: identity(2_000_000_001),
      mode: 'mechanical-empty',
    });

    const workerPath = fileURLToPath(
      new URL('./__fixtures__/recovery-attempt-worker.ts', import.meta.url),
    );
    const barrier = join(workspace, 'start-workers');
    const workers = [ATTEMPT_B, ATTEMPT_C].map((attemptId) =>
      fixtureProcesses.track(
        fork(workerPath, [workspace, attemptId, barrier], {
          execArgv: typeScriptFixtureExecArgv(),
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        }),
      ),
    );
    await Promise.all(workers.map(waitForReady));
    const resultPromises = workers.map(waitForResult);
    writeFileSync(barrier, 'go');
    const results = await Promise.all(resultPromises);
    await Promise.all(
      results.map((result, index) =>
        result === 'acquired' ? sendWorkerMessage(workers[index], 'stop') : Promise.resolve(),
      ),
    );
    await Promise.all(workers.map(waitForExit));
    expect(results.filter((result) => result === 'acquired')).toHaveLength(1);
    expect(results.filter((result) => result === 'rejected')).toHaveLength(1);
  }, 60_000);
});

function waitForReady(child: ChildProcess): Promise<void> {
  return waitForWorkerMessage(child, new Set(['ready']), 'ready').then(() => undefined);
}

function waitForExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('worker timed out while stopping')), 30_000);
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
      else finish(new Error(`worker failed while stopping: ${String(code)}`));
    }
    child.once('error', onError);
    child.once('exit', onExit);
    if (child.exitCode !== null) onExit(child.exitCode);
  });
}

function sendWorkerMessage(child: ChildProcess, message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (!child.connected) {
      reject(new Error('worker IPC closed before stop acknowledgement'));
      return;
    }
    child.send(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

function waitForResult(child: ChildProcess): Promise<string> {
  return waitForWorkerMessage(child, new Set(['acquired', 'rejected']), 'result');
}

function waitForWorkerMessage(
  child: ChildProcess,
  accepted: ReadonlySet<string>,
  phase: string,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(undefined, new Error(`worker timed out before ${phase}`)),
      30_000,
    );
    function cleanup(): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', onError);
      child.off('exit', onExit);
    }
    function finish(result?: string, error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve(result!);
    }
    function onMessage(message: unknown): void {
      if (typeof message === 'string' && accepted.has(message)) finish(message);
    }
    function onError(error: Error): void {
      finish(undefined, error);
    }
    function onExit(code: number | null): void {
      finish(undefined, new Error(`worker exited before ${phase}: ${String(code)}`));
    }
    child.on('message', onMessage);
    child.once('error', onError);
    child.once('exit', onExit);
  });
}
