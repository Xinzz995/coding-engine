import { randomUUID } from 'node:crypto';
import {
  existsSync,
  linkSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  ACCEPTANCE_HASH,
  OPERATION_ID,
  OWNER_ID,
  STORY_ID,
  defaultOptions,
  driveToArmed,
  operationPath,
  readOnlyOptions,
  setupOperationTest,
  type OperationTestSetup,
} from './__fixtures__/operation-test-support.js';
import { verifyDelegatedRecoveryArchive } from './delegated-recovery.js';
import {
  acquireDelegatedFinalizeRecoveryWithAuthority as acquireDelegatedFinalizeRecovery,
  finalizeDelegatedRecoveryWithAuthority as finalizeDelegatedRecovery,
  inspectDelegatedRecoveryEligibilityWithAuthority as inspectDelegatedRecoveryEligibility,
  installDelegatedFinalizeRecoveryWithAuthority as installDelegatedFinalizeRecovery,
} from './recovery-authority-test-seam.js';
import { digestBytes, jsonBytes } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import { ACTIVE_CHILD_FILE, DELEGATED_BASELINE_FILE, DRAINED_RECEIPT_FILE } from './operation.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from './operation-authority-test-seam.js';
import { readRecoveryDomain } from './recovery-domain.js';
import {
  QUARANTINE_FILE,
  createQuarantineRecordBytes,
  parseQuarantineRecord,
} from './quarantine.js';
import { encodeSupervisorStart } from './supervisor-protocol.js';
import { ACTIVE_LEASE_DIR, OWNER_FILE, PROTOCOL_ROOT_DIR, RECOVERY_DIR } from './types.js';

const roots: string[] = [];
const RECOVERY_ID = '00000000-0000-4000-8000-0000000000e1';
const ATTEMPT_A = '00000000-0000-4000-8000-0000000000e2';
const ATTEMPT_B = '00000000-0000-4000-8000-0000000000e3';

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function recoveryPath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, RECOVERY_DIR);
}

function fakeAttemptIdentity(pid: number) {
  const current = createIdentityProbe().current();
  return {
    ...current,
    pid,
  };
}

async function armedWorkspace(
  change: 'none' | 'legal' | 'read-only' = 'none',
): Promise<OperationTestSetup> {
  const setup = await setupOperationTest(roots);
  let resolveReceipt!: () => void;
  const receiptInstalled = new Promise<void>((resolve) => {
    resolveReceipt = resolve;
  });
  const options = change === 'read-only' ? readOnlyOptions() : defaultOptions();
  void runWorkspaceOperation(setup.session, options, async (operation) => {
    const { machine, armed } = await driveToArmed(operation);
    machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
    if (change === 'legal') {
      const state = JSON.parse(readFileSync(join(setup.workspace, 'state.json'), 'utf8')) as Record<
        string,
        Record<string, unknown>
      >;
      state[STORY_ID].passes = true;
      state[STORY_ID].notes = `${ACCEPTANCE_HASH}: recovered candidate`;
      writeFileSync(join(setup.workspace, 'state.json'), JSON.stringify(state));
    }
    const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
    await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
    resolveReceipt();
    return await new Promise<never>(() => undefined);
  });
  await receiptInstalled;
  return setup;
}

const exactProbes = {
  probeSourceOwner: () => 'dead' as const,
  probeSupervisor: () => 'dead' as const,
  probeContainment: () => 'empty' as const,
};

describe('internal delegated-finalize recovery eligibility and attempt authority', () => {
  it('installs one claim bound to the canonical armed operation and supports recovery-of-recovery', async () => {
    const setup = await armedWorkspace('legal');
    const inspected = await inspectDelegatedRecoveryEligibility(setup.workspace, exactProbes);
    expect(inspected.snapshot).toMatchObject({
      location: 'active',
      binding: { operationId: OPERATION_ID },
    });

    await installDelegatedFinalizeRecovery({
      workspacePath: setup.workspace,
      identity: fakeAttemptIdentity(2_000_000_001),
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_A,
      now: () => new Date('2026-07-30T01:00:00.000Z'),
      ...exactProbes,
    });
    const installed = await readRecoveryDomain(setup.workspace);
    expect(installed.claim).toMatchObject({
      mode: 'delegated-finalize',
      delegatedOperation: inspected.snapshot.binding,
    });

    const replacement = await acquireDelegatedFinalizeRecovery({
      workspacePath: setup.workspace,
      identity: createIdentityProbe().current(),
      attemptId: ATTEMPT_B,
      now: () => new Date('2026-07-30T01:01:00.000Z'),
      probeAttemptOwner: () => 'dead',
      ...exactProbes,
    });
    await expect(replacement.verify()).resolves.toMatchObject({
      attemptOwner: { attemptId: ATTEMPT_B },
    });
    expect(
      readdirSync(join(recoveryPath(setup.workspace), 'attempts')).some((name) =>
        name.startsWith('abandoned-'),
      ),
    ).toBe(true);
  });

  it.each(['missing', 'wrong-binding'] as const)(
    'classifies a %s cached receipt as operation-proof-missing and never creates a claim',
    async (failure) => {
      const setup = await armedWorkspace();
      const receiptPath = join(operationPath(setup.workspace), DRAINED_RECEIPT_FILE);
      if (failure === 'missing') {
        unlinkSync(receiptPath);
      } else {
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        receipt.ownerId = randomUUID();
        writeFileSync(receiptPath, jsonBytes(receipt));
      }

      await expect(
        installDelegatedFinalizeRecovery({
          workspacePath: setup.workspace,
          identity: createIdentityProbe().current(),
          ...exactProbes,
        }),
      ).rejects.toMatchObject({
        code: 'isolated',
        message: expect.stringMatching(/proof-missing/u),
      });
      expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
    },
  );

  it.each([
    ['supervisor alive', { probeSupervisor: () => 'alive' as const }],
    ['containment unknown', { probeContainment: () => 'unknown' as const }],
  ])('does not install a claim while %s', async (_label, override) => {
    const setup = await armedWorkspace();
    await expect(
      installDelegatedFinalizeRecovery({
        workspacePath: setup.workspace,
        identity: createIdentityProbe().current(),
        ...exactProbes,
        ...override,
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
  });

  it('rejects a reboot proof before writing when it does not bind the new attempt identity', async () => {
    const setup = await armedWorkspace();
    const receipt = join(operationPath(setup.workspace), DRAINED_RECEIPT_FILE);
    const receiptStaging = join(
      operationPath(setup.workspace),
      `drained-receipt.prepare-${randomUUID()}.json`,
    );
    linkSync(receipt, receiptStaging);
    const current = createIdentityProbe().current();
    await expect(
      installDelegatedFinalizeRecovery({
        workspacePath: setup.workspace,
        identity: current,
        rebootProof: {
          schemaVersion: 1,
          kind: 'same-host-boot-changed-v1',
          hostId: current.hostId,
          previousBootIdentity: `sha256:${'1'.repeat(64)}`,
          currentBootIdentity: `sha256:${'2'.repeat(64)}`,
          verifiedAt: '2026-07-30T01:00:00.000Z',
        },
        ...exactProbes,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
    expect(existsSync(receiptStaging)).toBe(true);
    expect(statSync(receipt, { bigint: true }).nlink).toBe(2n);
    expect(
      readdirSync(join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR)).filter((name) =>
        name.startsWith('recovery.prepare-'),
      ),
    ).toEqual([]);
  });

  it('keeps the immutable source owner and operation identities separate', async () => {
    const setup = await armedWorkspace();
    const inspected = await inspectDelegatedRecoveryEligibility(setup.workspace, exactProbes);
    expect(inspected.snapshot.active.ownerId).toBe(OWNER_ID);
    expect(inspected.snapshot.active.operationId).toBe(OPERATION_ID);
    expect(inspected.snapshot.active.ownerId).not.toBe(inspected.snapshot.active.operationId);
  });

  it('closes the unique controlled drained-receipt hardlink window before installing a claim', async () => {
    const setup = await armedWorkspace('legal');
    const canonical = join(operationPath(setup.workspace), DRAINED_RECEIPT_FILE);
    const staging = join(
      operationPath(setup.workspace),
      `drained-receipt.prepare-${randomUUID()}.json`,
    );
    linkSync(canonical, staging);
    let commitChecks = 0;

    const handle = await installDelegatedFinalizeRecovery({
      workspacePath: setup.workspace,
      identity: createIdentityProbe().current(),
      beforeReceiptSourceUnlink: () => {
        commitChecks += 1;
      },
      ...exactProbes,
    });

    expect(commitChecks).toBe(1);
    expect(existsSync(staging)).toBe(false);
    await expect(handle.verify()).resolves.toMatchObject({
      claim: { mode: 'delegated-finalize' },
    });
  });
});

describe('internal delegated-finalize recovery finalization', () => {
  async function install(
    setup: OperationTestSetup,
    attemptId = ATTEMPT_A,
    identity = createIdentityProbe().current(),
  ) {
    return await installDelegatedFinalizeRecovery({
      workspacePath: setup.workspace,
      identity,
      recoveryId: RECOVERY_ID,
      attemptId,
      now: () => new Date('2026-07-30T02:00:00.000Z'),
      ...exactProbes,
    });
  }

  it.each([
    ['legal candidate', 'legal' as const, true],
    ['read-only operation', 'read-only' as const, false],
  ])(
    'settles and archives a %s without ordinary outcome evidence',
    async (_label, change, hasCandidate) => {
      const setup = await armedWorkspace(change);
      const attemptIdentity = fakeAttemptIdentity(2_000_000_004);
      const completion = await finalizeDelegatedRecovery(
        await install(setup, ATTEMPT_A, attemptIdentity),
        {
          attemptIdentity,
          now: () => new Date('2026-07-30T02:01:00.000Z'),
          ...exactProbes,
        },
      );

      expect(existsSync(join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
      expect(existsSync(completion.archivePath)).toBe(true);
      expect(completion.candidateDigest === null).toBe(!hasCandidate);
      expect(Boolean(completion.candidate)).toBe(hasCandidate);
      const archiveEntries = readdirSync(completion.archivePath);
      expect(archiveEntries).not.toContain('outcome.json');
      expect(archiveEntries).not.toContain('evidence.json');
      const manifest = JSON.parse(
        readFileSync(join(completion.archivePath, RECOVERY_DIR, 'final-manifest.json'), 'utf8'),
      ) as Record<string, unknown>;
      expect(manifest.delegatedCandidateDigest).toBe(completion.candidateDigest);
      expect(
        digestBytes(
          readFileSync(join(completion.archivePath, RECOVERY_DIR, 'final-manifest.json')),
        ),
      ).toBe(completion.finalManifestDigest);
      await expect(
        verifyDelegatedRecoveryArchive({
          workspacePath: setup.workspace,
          targetArchive: completion.targetArchive,
        }),
      ).resolves.toEqual(completion);
    },
  );

  it('installs a recovery-attempt integrity quarantine and leaves the lease active on a forbidden delta', async () => {
    const setup = await armedWorkspace();
    const handle = await install(setup);
    writeFileSync(join(setup.workspace, 'forbidden.txt'), 'not delegated');

    await expect(
      finalizeDelegatedRecovery(handle, {
        now: () => new Date('2026-07-30T02:01:00.000Z'),
        ...exactProbes,
      }),
    ).rejects.toMatchObject({
      code: 'isolated',
      message: expect.stringMatching(/workspace-integrity-violation/u),
    });
    expect(existsSync(join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
    const quarantine = JSON.parse(
      readFileSync(join(operationPath(setup.workspace), QUARANTINE_FILE), 'utf8'),
    ) as Record<string, unknown>;
    expect(quarantine).toMatchObject({
      reason: 'workspace-integrity-violation',
      creator: { kind: 'recovery-attempt', id: ATTEMPT_A },
    });
    expect((await readRecoveryDomain(setup.workspace)).state.phase).toBe('claimed');
  });

  it('quarantines a semantic parser failure instead of treating it as a recoverable exception', async () => {
    const setup = await armedWorkspace('legal');
    const handle = await install(setup);
    writeFileSync(join(setup.workspace, 'state.json'), '{invalid-json');

    await expect(
      finalizeDelegatedRecovery(handle, {
        now: () => new Date('2026-07-30T02:01:00.000Z'),
        ...exactProbes,
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(
      parseQuarantineRecord(readFileSync(join(operationPath(setup.workspace), QUARANTINE_FILE))),
    ).toMatchObject({
      reason: 'workspace-integrity-violation',
      creator: { kind: 'recovery-attempt', id: ATTEMPT_A },
    });
  });

  it('does not consume a bound containment quarantine without exact reboot authority', async () => {
    const setup = await armedWorkspace();
    const canonicalOperation = operationPath(setup.workspace);
    const activeBytes = readFileSync(join(canonicalOperation, ACTIVE_CHILD_FILE));
    const baselineBytes = readFileSync(join(canonicalOperation, DELEGATED_BASELINE_FILE));
    const ownerBytes = readFileSync(
      join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OWNER_FILE),
    );
    const prior = createQuarantineRecordBytes({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      activeChildDigest: digestBytes(activeBytes),
      delegatedBaselineDigest: digestBytes(baselineBytes),
      creator: { kind: 'owner', id: OWNER_ID, recordDigest: digestBytes(ownerBytes) },
      reason: 'containment-unconfirmed',
      priorQuarantineDigest: null,
      createdAt: new Date('2026-07-30T02:00:00.000Z'),
    });
    writeFileSync(join(canonicalOperation, QUARANTINE_FILE), prior);
    await expect(install(setup)).rejects.toMatchObject({ code: 'isolated' });
    expect(readFileSync(join(canonicalOperation, QUARANTINE_FILE))).toEqual(prior);
    expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
  });

  it('quarantines a still-valid candidate that changes after its final manifest is installed', async () => {
    const setup = await armedWorkspace('legal');
    const handle = await install(setup);

    await expect(
      finalizeDelegatedRecovery(handle, {
        now: () => new Date('2026-07-30T02:01:00.000Z'),
        hooks: {
          afterFinalManifestInstalled: () => {
            const statePath = join(setup.workspace, 'state.json');
            const state = JSON.parse(readFileSync(statePath, 'utf8')) as Record<
              string,
              Record<string, unknown>
            >;
            state[STORY_ID].notes = `${ACCEPTANCE_HASH}: changed after manifest`;
            writeFileSync(statePath, JSON.stringify(state));
          },
        },
        ...exactProbes,
      }),
    ).rejects.toMatchObject({ code: 'isolated' });

    const settledRoot = join(
      setup.workspace,
      PROTOCOL_ROOT_DIR,
      ACTIVE_LEASE_DIR,
      'settled-operations',
    );
    const settled = readdirSync(settledRoot);
    expect(settled).toHaveLength(1);
    expect(
      parseQuarantineRecord(readFileSync(join(settledRoot, settled[0], QUARANTINE_FILE))),
    ).toMatchObject({
      reason: 'workspace-integrity-violation',
      creator: { kind: 'recovery-attempt' },
    });
    expect(existsSync(join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
    await expect(
      acquireDelegatedFinalizeRecovery({
        workspacePath: setup.workspace,
        identity: createIdentityProbe().current(),
        probeAttemptOwner: () => 'dead',
        ...exactProbes,
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
  });

  it.each(['settled', 'verified', 'manifest-linked', 'finalizing'] as const)(
    'continues recovery-of-recovery from the %s crash window',
    async (window) => {
      const setup = await armedWorkspace('legal');
      const first = await installDelegatedFinalizeRecovery({
        workspacePath: setup.workspace,
        identity: createIdentityProbe().current(),
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        now: () => new Date('2026-07-30T02:00:00.000Z'),
        ...exactProbes,
      });
      const stop = new Error(`stop-${window}`);
      await expect(
        finalizeDelegatedRecovery(first, {
          now: () => new Date('2026-07-30T02:01:00.000Z'),
          hooks: {
            ...(window === 'settled' ? { afterOperationSettled: () => Promise.reject(stop) } : {}),
            ...(window === 'verified' ? { afterVerified: () => Promise.reject(stop) } : {}),
            ...(window === 'manifest-linked'
              ? { beforeFinalManifestSourceUnlink: () => Promise.reject(stop) }
              : {}),
            ...(window === 'finalizing' ? { afterFinalizing: () => Promise.reject(stop) } : {}),
          },
          ...exactProbes,
        }),
      ).rejects.toBe(stop);

      const replacement = await acquireDelegatedFinalizeRecovery({
        workspacePath: setup.workspace,
        identity: createIdentityProbe().current(),
        attemptId: ATTEMPT_B,
        now: () => new Date('2026-07-30T02:02:00.000Z'),
        probeAttemptOwner: () => 'dead',
        ...exactProbes,
      });
      const completion = await finalizeDelegatedRecovery(replacement, {
        now: () => new Date('2026-07-30T02:03:00.000Z'),
        ...exactProbes,
      });
      expect(completion.candidateDigest).not.toBeNull();
      expect(existsSync(completion.archivePath)).toBe(true);
    },
  );
});
