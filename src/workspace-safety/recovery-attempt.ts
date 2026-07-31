import { randomUUID } from 'node:crypto';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertExactFile,
  createStagingDirectory,
  digestBytes,
  installDirectoryNoReplace,
  moveDirectoryNoReplace,
  pathExists,
  writeNewFile,
} from './filesystem.js';
import { captureExactCurrentIdentityAuthority, createIdentityProbe } from './identity.js';
import {
  loadRecoveryContext,
  readRecoveryAttemptDirectory,
  readRecoveryDomainAtPath,
  type RecoveryDomain,
} from './recovery-domain.js';
import {
  RECOVERY_ATTEMPTS_DIR,
  RECOVERY_ATTEMPT_LEASE_DIR,
  RECOVERY_CLAIM_FILE,
  RECOVERY_STATE_FILE,
  createRecoveryAttemptOwnerBytes,
  createRecoveryClaimBytes,
  createRecoveryStateBytes,
  parseRecoveryAttemptOwner,
  recoveryAttemptLeaseDigest,
  recoveryDigest,
  recoveryInvalid,
  recoveryUuid,
  type RecoveryAttemptOwner,
  type DelegatedRecoveryOperationBinding,
  type PrestartRecoveryOperationBinding,
  type RecoveryRebootProof,
} from './recovery-records.js';
import {
  assertMechanicalEmptyEligibility,
  captureRecoverySourceFromRecords,
  createSourceOwnerProbe,
  requireDeadSourceOwner,
} from './recovery-source-snapshot.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  OWNER_SCHEMA_VERSION,
  PROTOCOL_ROOT_DIR,
  type IdentityVerdict,
  type MutationPhase,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  type RecoveryMode,
  WorkspaceSafetyError,
} from './types.js';

export interface RecoveryDomainHooks {
  readonly beforeRecoveryInstall?: (stagingPath: string) => void | Promise<void>;
  readonly afterRecoveryInstalled?: (recoveryPath: string) => void | Promise<void>;
}

/** Internal-only input. Production entrypoints must obtain identity and liveness from the OS. */
export interface ControlledInstallRecoveryDomainOptions {
  readonly workspacePath: string;
  readonly expectedSourceSnapshotDigest: string;
  readonly recoveryId?: string;
  readonly attemptId?: string;
  readonly identity: ProcessIdentitySnapshot;
  readonly mode: RecoveryMode;
  readonly delegatedOperation?: DelegatedRecoveryOperationBinding | null;
  readonly prestartOperation?: PrestartRecoveryOperationBinding | null;
  readonly expectedMutationPhase?: MutationPhase | null;
  readonly expectedMutationDigest?: string | null;
  readonly rebootProof?: RecoveryRebootProof | null;
  readonly now?: () => Date;
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly hooks?: RecoveryDomainHooks;
  /** Trusted coordinator check, repeated immediately before every authority-sensitive write. */
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal mechanical recovery input. Generated IDs, time, hooks, and authority stay internal. */
export interface InstallRecoveryDomainOptions {
  readonly workspacePath: string;
  readonly expectedSourceSnapshotDigest: string;
}

export interface RecoveryAttemptHooks {
  readonly afterOldAttemptAbandoned?: (abandonedPath: string) => void | Promise<void>;
}

/** Internal-only input. Production entrypoints must obtain identity and liveness from the OS. */
export interface ControlledAcquireRecoveryAttemptOptions {
  readonly workspacePath: string;
  readonly attemptId?: string;
  readonly identity: ProcessIdentitySnapshot;
  readonly now?: () => Date;
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly probeAttemptOwner?: (owner: RecoveryAttemptOwner) => IdentityVerdict;
  readonly hooks?: RecoveryAttemptHooks;
  /** Trusted coordinator check, repeated immediately before every authority-sensitive write. */
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal attempt input. Attempt identity and competition probes are derived from the OS. */
export interface AcquireRecoveryAttemptOptions {
  readonly workspacePath: string;
}

/**
 * Internal recovery-mode authority. Public recovery entrypoints keep choosing a fixed mode;
 * this contract only lets another fully specified recovery mode reuse the one claim/attempt
 * installation protocol without copying its crash and competition handling.
 */
export interface RecoveryModeAuthority {
  readonly mode: RecoveryMode;
  readonly verifySource: (input: {
    readonly context: Awaited<ReturnType<typeof loadRecoveryContext>>;
    readonly domain?: RecoveryDomain;
    readonly expectedSourceSnapshotDigest: string;
    readonly phase:
      'before-install' | 'before-commit' | 'after-install' | 'attempt-acquire' | 'handle-verify';
  }) => Promise<void>;
}

const RECOVERY_ATTEMPT_HANDLE_AUTHORITY = Symbol('recovery-attempt-handle-authority');

function conflict(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('conflict', `Recovery conflict: ${message}`);
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  }
  return error;
}

function unsupported(message: string): WorkspaceSafetyError {
  return new WorkspaceSafetyError('unsupported', `Recovery is not eligible: ${message}`);
}

export function assertRecoveryRebootIdentityBeforeWrite(
  proof: RecoveryRebootProof | null | undefined,
  sourceOwner: OwnerRecord,
  identity: ProcessIdentitySnapshot,
): void {
  if (proof === null || proof === undefined) return;
  if (
    proof.hostId !== sourceOwner.hostId ||
    proof.previousBootIdentity !== sourceOwner.bootIdentity ||
    proof.hostId !== identity.hostId ||
    proof.currentBootIdentity !== identity.bootIdentity
  ) {
    throw recoveryInvalid('rebootProof does not bind source owner and new attempt identity');
  }
}

async function writeAttemptStaging(
  attemptsPath: string,
  attemptId: string,
  ownerBytes: Buffer,
  recoveryId: string,
  workspaceIdentity: string,
): Promise<string> {
  const staging = await createStagingDirectory(attemptsPath, 'prepared-', attemptId);
  await writeNewFile(join(staging, OWNER_FILE), ownerBytes);
  await assertExactFile(join(staging, OWNER_FILE), ownerBytes);
  const parsed = await readRecoveryAttemptDirectory(
    staging,
    recoveryId,
    workspaceIdentity,
    'prepared recovery attempt',
  );
  if (parsed.owner.attemptId !== attemptId) {
    throw recoveryInvalid('prepared recovery attempt does not bind its staging name');
  }
  return staging;
}

/** @internal Trusted mode coordinator core. Not a public or test-injection entrypoint. */
export async function installRecoveryDomainControlled(
  options: ControlledInstallRecoveryDomainOptions,
  authority: RecoveryModeAuthority,
): Promise<RecoveryAttemptHandle> {
  if (options.mode !== authority.mode) {
    throw unsupported(`${options.mode} does not match the selected recovery authority`);
  }
  const expectedSourceSnapshotDigest = recoveryDigest(
    options.expectedSourceSnapshotDigest,
    'expectedSourceSnapshotDigest',
  );
  const context = await loadRecoveryContext(options.workspacePath);
  const probeSourceOwner = createSourceOwnerProbe(options.probeSourceOwner);
  await options.verifySystemAuthority?.();
  requireDeadSourceOwner(context.sourceOwner, probeSourceOwner);
  assertRecoveryRebootIdentityBeforeWrite(
    options.rebootProof,
    context.sourceOwner,
    options.identity,
  );
  if (await pathExists(context.recoveryPath)) {
    await readRecoveryDomainAtPath(context.records, context.sourceOwner, context.recoveryPath);
    throw conflict('a canonical recovery domain is already installed');
  }
  await authority.verifySource({
    context,
    expectedSourceSnapshotDigest,
    phase: 'before-install',
  });
  const recoveryId = recoveryUuid(options.recoveryId ?? randomUUID(), 'recoveryId');
  const attemptId = recoveryUuid(options.attemptId ?? randomUUID(), 'attemptId');
  const now = options.now ?? (() => new Date());
  const expectedMutationPhase = options.expectedMutationPhase ?? null;
  const expectedMutationDigest =
    options.expectedMutationDigest === null || options.expectedMutationDigest === undefined
      ? null
      : recoveryDigest(options.expectedMutationDigest, 'expectedMutationDigest');
  if (
    (expectedMutationPhase === null) !== (expectedMutationDigest === null) ||
    (options.mode === 'mutation-resume') !== (expectedMutationPhase !== null)
  ) {
    throw recoveryInvalid(
      'mutation-resume requires one complete expected mutation phase and digest binding',
    );
  }
  const claimBytes = createRecoveryClaimBytes({
    recoveryId,
    sourceSnapshotDigest: expectedSourceSnapshotDigest,
    mode: options.mode,
    delegatedOperation: options.delegatedOperation ?? null,
    prestartOperation: options.prestartOperation ?? null,
    rebootProof: options.rebootProof ?? null,
    createdAt: now(),
  });
  const stateBytes = createRecoveryStateBytes({
    recoveryId,
    claimDigest: digestBytes(claimBytes),
    phase: 'claimed',
    expectedMutationPhase,
    expectedMutationDigest,
    finalManifestDigest: null,
    updatedAt: now(),
  });
  const attemptOwnerBytes = createRecoveryAttemptOwnerBytes(
    recoveryId,
    attemptId,
    options.identity,
    context.records.workspace.identity,
    now,
  );

  const activeLease = join(context.records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  const staging = await createStagingDirectory(activeLease, 'recovery.prepare-', recoveryId);
  await writeNewFile(join(staging, RECOVERY_CLAIM_FILE), claimBytes);
  await writeNewFile(join(staging, RECOVERY_STATE_FILE), stateBytes);
  const attemptsPath = join(staging, RECOVERY_ATTEMPTS_DIR);
  await mkdir(attemptsPath, { mode: 0o700 });
  const attemptStaging = await writeAttemptStaging(
    attemptsPath,
    attemptId,
    attemptOwnerBytes,
    recoveryId,
    context.records.workspace.identity,
  );
  await installDirectoryNoReplace(attemptStaging, join(staging, RECOVERY_ATTEMPT_LEASE_DIR));
  await readRecoveryDomainAtPath(context.records, context.sourceOwner, staging);
  await options.hooks?.beforeRecoveryInstall?.(staging);
  await options.verifySystemAuthority?.();
  requireDeadSourceOwner(context.sourceOwner, probeSourceOwner);
  await authority.verifySource({
    context,
    expectedSourceSnapshotDigest,
    phase: 'before-commit',
  });

  await installDirectoryNoReplace(staging, context.recoveryPath);
  await options.hooks?.afterRecoveryInstalled?.(context.recoveryPath);
  await options.verifySystemAuthority?.();
  const installed = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  await authority.verifySource({
    context,
    domain: installed,
    expectedSourceSnapshotDigest,
    phase: 'after-install',
  });
  if (
    !installed.claimBytes.equals(claimBytes) ||
    !installed.stateBytes.equals(stateBytes) ||
    !installed.attemptOwnerBytes?.equals(attemptOwnerBytes)
  ) {
    throw recoveryInvalid('installed recovery domain does not match staged bytes');
  }
  return new RecoveryAttemptHandle(RECOVERY_ATTEMPT_HANDLE_AUTHORITY, {
    workspacePath: context.records.workspace.path,
    expectedSourceSnapshotDigest,
    claimBytes,
    stateBytes,
    attemptOwnerBytes,
    authority,
    verifySystemAuthority: options.verifySystemAuthority,
  });
}

const mechanicalEmptyAuthority: RecoveryModeAuthority = {
  mode: 'mechanical-empty',
  verifySource: async ({ context, domain, expectedSourceSnapshotDigest, phase }) => {
    if (domain?.claim.rebootProof !== null && domain?.claim.rebootProof !== undefined) {
      throw unsupported('same-host reboot claims require the dedicated reboot coordinator');
    }
    if (domain?.claim.prestartOperation !== null && domain?.claim.prestartOperation !== undefined) {
      throw unsupported('prestart operation claims require the dedicated recovery authority');
    }
    await assertMechanicalEmptyEligibility(
      context.records,
      context.sourceOwner,
      domain !== undefined,
    );
    const actual = await captureRecoverySourceFromRecords(context.records);
    if (actual === expectedSourceSnapshotDigest) return;
    if (phase === 'after-install' || phase === 'handle-verify') {
      throw recoveryInvalid('source snapshot changed while recovery authority was installed');
    }
    if (phase === 'before-commit') {
      throw conflict('source snapshot changed before recovery installation');
    }
    throw conflict('source snapshot no longer matches recovery eligibility');
  },
};

/** @internal Test seam for mechanical-empty with injected OS facts. */
export async function installMechanicalRecoveryDomainControlled(
  options: ControlledInstallRecoveryDomainOptions,
): Promise<RecoveryAttemptHandle> {
  if (options.mode !== 'mechanical-empty') {
    throw unsupported(`${options.mode} records are parseable but their proof path is not active`);
  }
  if (options.prestartOperation !== null && options.prestartOperation !== undefined) {
    throw unsupported('prestart operation claims require the dedicated recovery entrypoint');
  }
  if (options.rebootProof !== null && options.rebootProof !== undefined) {
    throw unsupported('same-host reboot claims require the dedicated reboot coordinator');
  }
  return await installRecoveryDomainControlled(options, mechanicalEmptyAuthority);
}

export async function installRecoveryDomain(
  options: InstallRecoveryDomainOptions,
): Promise<RecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await installMechanicalRecoveryDomainControlled({
    workspacePath: options.workspacePath,
    expectedSourceSnapshotDigest: options.expectedSourceSnapshotDigest,
    identity: system.identity,
    mode: 'mechanical-empty',
    delegatedOperation: null,
    prestartOperation: null,
    expectedMutationPhase: null,
    expectedMutationDigest: null,
    rebootProof: null,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

function asProbeOwner(owner: RecoveryAttemptOwner): OwnerRecord {
  return {
    schemaVersion: OWNER_SCHEMA_VERSION,
    ownerId: owner.attemptId,
    pid: owner.pid,
    processIdentity: owner.processIdentity,
    bootIdentity: owner.bootIdentity,
    hostId: owner.hostId,
    workspaceIdentity: owner.workspaceIdentity,
    startedAt: owner.startedAt,
    command: 'repair',
  };
}

/** @internal Trusted mode coordinator core. Not a public or test-injection entrypoint. */
export async function acquireRecoveryAttemptControlled(
  options: ControlledAcquireRecoveryAttemptOptions,
  authority: RecoveryModeAuthority,
): Promise<RecoveryAttemptHandle> {
  await options.verifySystemAuthority?.();
  const context = await loadRecoveryContext(options.workspacePath);
  const initialDomain = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  if (initialDomain.claim.mode !== authority.mode) {
    throw unsupported(
      `${initialDomain.claim.mode} records are parseable but attempt execution is not active`,
    );
  }
  const probeSourceOwner = createSourceOwnerProbe(options.probeSourceOwner);
  requireDeadSourceOwner(context.sourceOwner, probeSourceOwner);
  assertRecoveryRebootIdentityBeforeWrite(
    initialDomain.claim.rebootProof,
    context.sourceOwner,
    options.identity,
  );
  await authority.verifySource({
    context,
    domain: initialDomain,
    expectedSourceSnapshotDigest: initialDomain.claim.sourceSnapshotDigest,
    phase: 'attempt-acquire',
  });
  const identityProbe = createIdentityProbe();
  const probeAttemptOwner =
    options.probeAttemptOwner ??
    ((owner: RecoveryAttemptOwner): IdentityVerdict => identityProbe.probe(asProbeOwner(owner)));
  if (initialDomain.attemptOwner) {
    const verdict = probeAttemptOwner(initialDomain.attemptOwner);
    if (verdict !== 'dead') throw conflict(`existing recovery attempt is ${verdict}`);
  }
  const attemptId = recoveryUuid(options.attemptId ?? randomUUID(), 'attemptId');
  const now = options.now ?? (() => new Date());
  const attemptOwnerBytes = createRecoveryAttemptOwnerBytes(
    initialDomain.claim.recoveryId,
    attemptId,
    options.identity,
    context.records.workspace.identity,
    now,
  );
  const attemptsPath = join(context.recoveryPath, RECOVERY_ATTEMPTS_DIR);
  const staging = await writeAttemptStaging(
    attemptsPath,
    attemptId,
    attemptOwnerBytes,
    initialDomain.claim.recoveryId,
    context.records.workspace.identity,
  );
  const leasePath = join(context.recoveryPath, RECOVERY_ATTEMPT_LEASE_DIR);

  for (let competition = 0; competition < 16; competition += 1) {
    await options.verifySystemAuthority?.();
    requireDeadSourceOwner(context.sourceOwner, probeSourceOwner);
    const domain = await readRecoveryDomainAtPath(
      context.records,
      context.sourceOwner,
      context.recoveryPath,
    );
    if (
      !domain.claimBytes.equals(initialDomain.claimBytes) ||
      !domain.stateBytes.equals(initialDomain.stateBytes)
    ) {
      throw conflict('recovery claim or state changed during attempt acquisition');
    }
    await authority.verifySource({
      context,
      domain,
      expectedSourceSnapshotDigest: initialDomain.claim.sourceSnapshotDigest,
      phase: 'attempt-acquire',
    });
    if (domain.attemptOwner && domain.attemptOwnerBytes) {
      const verdict = probeAttemptOwner(domain.attemptOwner);
      if (verdict !== 'dead') throw conflict(`existing recovery attempt is ${verdict}`);
      const leaseDigest = recoveryAttemptLeaseDigest(domain.attemptOwnerBytes);
      const abandonedPath = join(attemptsPath, `abandoned-${leaseDigest.slice(7)}`);
      if (await pathExists(abandonedPath)) {
        throw recoveryInvalid('dead recovery attempt already has a conflicting abandoned digest');
      }
      try {
        await moveDirectoryNoReplace(leasePath, abandonedPath);
      } catch (error) {
        if (!(await pathExists(leasePath)) && (await pathExists(abandonedPath))) {
          await readRecoveryDomainAtPath(
            context.records,
            context.sourceOwner,
            context.recoveryPath,
          );
          continue;
        }
        throw error;
      }
      await options.hooks?.afterOldAttemptAbandoned?.(abandonedPath);
    }

    try {
      await options.verifySystemAuthority?.();
      await installDirectoryNoReplace(staging, leasePath);
    } catch (error) {
      if (error instanceof WorkspaceSafetyError && error.code === 'conflict') continue;
      throw error;
    }
    const installed = await readRecoveryDomainAtPath(
      context.records,
      context.sourceOwner,
      context.recoveryPath,
    );
    if (!installed.attemptOwnerBytes?.equals(attemptOwnerBytes)) {
      throw recoveryInvalid('winning recovery attempt bytes changed after installation');
    }
    await authority.verifySource({
      context,
      domain: installed,
      expectedSourceSnapshotDigest: initialDomain.claim.sourceSnapshotDigest,
      phase: 'attempt-acquire',
    });
    return new RecoveryAttemptHandle(RECOVERY_ATTEMPT_HANDLE_AUTHORITY, {
      workspacePath: context.records.workspace.path,
      expectedSourceSnapshotDigest: initialDomain.claim.sourceSnapshotDigest,
      claimBytes: initialDomain.claimBytes,
      stateBytes: initialDomain.stateBytes,
      attemptOwnerBytes,
      authority,
      verifySystemAuthority: options.verifySystemAuthority,
    });
  }
  throw conflict('recovery attempt competition did not reach a stable winner');
}

export async function acquireRecoveryAttempt(
  options: AcquireRecoveryAttemptOptions,
): Promise<RecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await acquireMechanicalRecoveryAttemptControlled({
    workspacePath: options.workspacePath,
    identity: system.identity,
    probeSourceOwner: system.probeOwner,
    probeAttemptOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

/** @internal Test seam for mechanical-empty with injected OS facts. */
export async function acquireMechanicalRecoveryAttemptControlled(
  options: ControlledAcquireRecoveryAttemptOptions,
): Promise<RecoveryAttemptHandle> {
  return await acquireRecoveryAttemptControlled(options, mechanicalEmptyAuthority);
}

interface RecoveryAttemptHandleOptions {
  readonly workspacePath: string;
  readonly expectedSourceSnapshotDigest: string;
  readonly claimBytes: Buffer;
  readonly stateBytes: Buffer;
  readonly attemptOwnerBytes: Buffer;
  readonly authority: RecoveryModeAuthority;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

export class RecoveryAttemptHandle {
  readonly workspacePath: string;
  readonly owner: RecoveryAttemptOwner;

  readonly #expectedSourceSnapshotDigest: string;
  readonly #claimBytes: Buffer;
  readonly #stateBytes: Buffer;
  readonly #attemptOwnerBytes: Buffer;
  readonly #authority: RecoveryModeAuthority;
  readonly #verifySystemAuthority?: () => void | Promise<void>;

  constructor(
    token: typeof RECOVERY_ATTEMPT_HANDLE_AUTHORITY,
    options: RecoveryAttemptHandleOptions,
  ) {
    if (token !== RECOVERY_ATTEMPT_HANDLE_AUTHORITY) {
      throw new WorkspaceSafetyError(
        'invalid',
        'recovery attempt handle authority token is invalid',
      );
    }
    this.workspacePath = options.workspacePath;
    this.#expectedSourceSnapshotDigest = options.expectedSourceSnapshotDigest;
    this.#claimBytes = Buffer.from(options.claimBytes);
    this.#stateBytes = Buffer.from(options.stateBytes);
    this.#attemptOwnerBytes = Buffer.from(options.attemptOwnerBytes);
    this.#authority = options.authority;
    this.#verifySystemAuthority = options.verifySystemAuthority;
    this.owner = parseRecoveryAttemptOwner(this.#attemptOwnerBytes);
  }

  async verify(): Promise<RecoveryDomain> {
    try {
      await this.#verifySystemAuthority?.();
      const context = await loadRecoveryContext(this.workspacePath);
      const domain = await readRecoveryDomainAtPath(
        context.records,
        context.sourceOwner,
        context.recoveryPath,
      );
      if (
        !domain.claimBytes.equals(this.#claimBytes) ||
        !domain.stateBytes.equals(this.#stateBytes) ||
        !domain.attemptOwnerBytes?.equals(this.#attemptOwnerBytes)
      ) {
        throw new WorkspaceSafetyError('lease-lost', 'recovery attempt binding changed');
      }
      await this.#authority.verifySource({
        context,
        domain,
        expectedSourceSnapshotDigest: this.#expectedSourceSnapshotDigest,
        phase: 'handle-verify',
      });
      return domain;
    } catch (error) {
      if (error instanceof WorkspaceSafetyError && error.code === 'lease-lost') throw error;
      const lost = new WorkspaceSafetyError(
        'lease-lost',
        'recovery attempt is no longer canonical',
      );
      Object.defineProperty(lost, 'cause', { value: error, enumerable: false });
      throw lost;
    }
  }
}
