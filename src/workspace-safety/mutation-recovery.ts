import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  assertExactFile,
  createStagingDirectory,
  digestBytes,
  installFileNoReplace,
  moveDirectoryNoReplace,
  pathExists,
  readExactFile,
  recoverLinkedFileInstall,
  replaceFileFromStaging,
  resolveWorkspaceRelativePath,
  writeNewFile,
} from './filesystem.js';
import { captureExactCurrentIdentityAuthority, createIdentityProbe } from './identity.js';
import { inspectQuarantinePresence } from './quarantine.js';
import {
  readActiveLeaseOwner,
  readReadyWorkspaceRecords,
  type ReadyWorkspaceRecords,
} from './lease.js';
import {
  advanceWorkspaceMutationControlled,
  captureMutationFinalSnapshotDigest,
  createMutationWriterAuthorityControlled,
  readCanonicalMutationDomain,
  readMutationDomainAtPath,
  verifyMutationLegalIntermediateSnapshot,
  type MutationAdvanceHooks,
  type MutationDomain,
  type MutationWriterAuthorityControlled,
  type MutationWriteScope,
} from './mutation-domain.js';
import { mutationArchivePath, mutationStateBytes } from './mutation-records.js';
import {
  acquireRecoveryAttemptControlled,
  installRecoveryDomainControlled,
  type ControlledAcquireRecoveryAttemptOptions,
  type ControlledInstallRecoveryDomainOptions,
  type RecoveryAttemptHandle,
  type RecoveryModeAuthority,
} from './recovery-attempt.js';
import {
  loadRecoveryContext,
  readRecoveryDomainAtPath,
  type RecoveryDomain,
} from './recovery-domain.js';
import {
  RECOVERY_FINAL_MANIFEST_FILE,
  RECOVERY_STATE_FILE,
  createRecoveryFinalManifestBytes,
  createRecoveryStateBytes,
  recoveryInvalid,
  type RecoveryAttemptOwner,
} from './recovery-records.js';
import {
  captureRecoverySourceAtLeasePath,
  captureRecoverySourceFromRecords,
  createSourceOwnerProbe,
  requireDeadSourceOwner,
} from './recovery-source-snapshot.js';
import { parseJsonRecord, parseOwnerRecord, validateCoreRecordBindings } from './schema.js';
import {
  ACTIVE_LEASE_DIR,
  MUTATION_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  type IdentityVerdict,
  type MutationPhase,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  WorkspaceSafetyError,
} from './types.js';
import { assertWindowsWorkspaceTreeHasNoReparsePoints } from './windows-path-attributes.js';

export interface MutationRecoveryHooks extends MutationAdvanceHooks {
  readonly afterRecoveryVerified?: () => void | Promise<void>;
  readonly beforeFinalManifestSourceUnlink?: () => void | Promise<void>;
  readonly afterFinalManifestInstalled?: () => void | Promise<void>;
  readonly afterRecoveryFinalizing?: () => void | Promise<void>;
  readonly beforeFinalRename?: () => void | Promise<void>;
}

export interface ControlledResumeMutationRecoveryOptions {
  readonly now?: () => Date;
  /** Exact test/coordinator identity; omitted callers keep the real platform read. */
  readonly attemptIdentity?: ProcessIdentitySnapshot;
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly hooks?: MutationRecoveryHooks;
  readonly finalRenameCommitCheck?: () => void;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal resume has no caller-controlled clock, callbacks, probes, or commit barrier. */
export type ResumeMutationRecoveryOptions = undefined;

export interface MutationRecoveryCompletion {
  readonly workspacePath: string;
  readonly targetArchive: string;
  readonly archivePath: string;
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly finalManifestDigest: string;
  readonly mutationSnapshotDigest: string;
}

interface MutableRecoveryBinding {
  readonly workspacePath: string;
  readonly claimBytes: Buffer;
  stateBytes: Buffer;
  readonly attemptOwnerBytes: Buffer;
  readonly processIdentity: ProcessIdentitySnapshot;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

interface AuthorizedMutationRecovery {
  readonly records: ReadyWorkspaceRecords;
  readonly recovery: RecoveryDomain;
  readonly mutation: MutationDomain;
  readonly relation: 'exact' | 'one-step-ahead';
}

function conflict(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('conflict', `Mutation recovery conflict: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function activeLeasePath(records: ReadyWorkspaceRecords): string {
  return join(records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
}

function nextPhase(phase: MutationPhase): MutationPhase | undefined {
  if (phase === 'staged') return 'archiving';
  if (phase === 'archiving') return 'applying';
  if (phase === 'applying') return 'committed';
  return undefined;
}

function requireCurrentAttemptOwner(
  owner: RecoveryAttemptOwner | undefined,
  current: ProcessIdentitySnapshot,
): void {
  if (
    !owner ||
    owner.pid !== current.pid ||
    owner.hostId !== current.hostId ||
    owner.bootIdentity !== current.bootIdentity ||
    owner.processIdentity.kind !== current.processIdentity.kind ||
    owner.processIdentity.value !== current.processIdentity.value
  ) {
    throw new WorkspaceSafetyError(
      'lease-lost',
      'mutation recovery is not running as the exact recovery attempt owner',
    );
  }
}

async function assertMutationRecoverySourceShape(
  records: ReadyWorkspaceRecords,
  sourceOwner: OwnerRecord,
): Promise<MutationDomain> {
  const activeLease = activeLeasePath(records);
  if (await pathExists(join(activeLease, OPERATION_DIR))) {
    throw recoveryInvalid('mutation recovery cannot consume an active operation');
  }
  if (await inspectQuarantinePresence(activeLease)) {
    throw recoveryInvalid('mutation recovery cannot consume quarantine');
  }
  const mutation = await readCanonicalMutationDomain({
    workspace: records.workspace,
    expectedOwner: sourceOwner,
  });
  await verifyMutationLegalIntermediateSnapshot(mutation);
  return mutation;
}

function mutationRelation(
  recovery: RecoveryDomain,
  mutation: MutationDomain,
): 'exact' | 'one-step-ahead' {
  const expectedPhase = recovery.state.expectedMutationPhase;
  const expectedDigest = recovery.state.expectedMutationDigest;
  if (expectedPhase === null || expectedDigest === null) {
    throw recoveryInvalid('mutation recovery state is missing its exact mutation binding');
  }
  const currentDigest = digestBytes(mutation.stateBytes);
  if (mutation.state.phase === expectedPhase && currentDigest === expectedDigest) return 'exact';
  if (nextPhase(expectedPhase) !== mutation.state.phase) {
    throw recoveryInvalid('canonical mutation is not at the expected or immediately next phase');
  }
  const reconstructedPrevious = mutationStateBytes({ ...mutation.state, phase: expectedPhase });
  if (digestBytes(reconstructedPrevious) !== expectedDigest) {
    throw recoveryInvalid('canonical mutation cannot be derived from the expected prior state');
  }
  return 'one-step-ahead';
}

function createMutationRecoveryAuthority(initial?: {
  readonly phase: MutationPhase;
  readonly digest: string;
}): RecoveryModeAuthority {
  return {
    mode: 'mutation-resume',
    verifySource: async ({ context, domain, expectedSourceSnapshotDigest, phase }) => {
      const mutation = await assertMutationRecoverySourceShape(
        context.records,
        context.sourceOwner,
      );
      if (domain) {
        if (
          domain.claim.mode !== 'mutation-resume' ||
          domain.claim.delegatedOperation !== null ||
          domain.claim.prestartOperation !== null
        ) {
          throw recoveryInvalid('mutation recovery claim contains incompatible authority');
        }
        mutationRelation(domain, mutation);
      } else {
        if (!initial) throw recoveryInvalid('mutation install authority is missing its binding');
        if (
          mutation.state.phase !== initial.phase ||
          digestBytes(mutation.stateBytes) !== initial.digest
        ) {
          throw conflict('mutation changed before recovery installation');
        }
      }
      if (phase === 'before-install' || phase === 'before-commit' || phase === 'after-install') {
        const sourceDigest = await captureRecoverySourceFromRecords(context.records);
        if (sourceDigest !== expectedSourceSnapshotDigest) {
          throw conflict('recovery source changed during mutation recovery installation');
        }
      }
    },
  };
}

export type ControlledInstallMutationRecoveryOptions = Omit<
  ControlledInstallRecoveryDomainOptions,
  | 'mode'
  | 'expectedSourceSnapshotDigest'
  | 'delegatedOperation'
  | 'prestartOperation'
  | 'expectedMutationPhase'
  | 'expectedMutationDigest'
>;

/** Formal mutation-recovery input. Mutation identity and source proof are read from disk. */
export interface InstallMutationRecoveryOptions {
  readonly workspacePath: string;
}

/** @internal Authority-controlled core. */
export async function installMutationRecoveryDomainControlled(
  options: ControlledInstallMutationRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  const context = await loadRecoveryContext(options.workspacePath);
  const mutation = await assertMutationRecoverySourceShape(context.records, context.sourceOwner);
  const expectedSourceSnapshotDigest = await captureRecoverySourceFromRecords(context.records);
  const expectedMutationDigest = digestBytes(mutation.stateBytes);
  return await installRecoveryDomainControlled(
    {
      ...options,
      mode: 'mutation-resume',
      expectedSourceSnapshotDigest,
      delegatedOperation: null,
      prestartOperation: null,
      expectedMutationPhase: mutation.state.phase,
      expectedMutationDigest,
    },
    createMutationRecoveryAuthority({
      phase: mutation.state.phase,
      digest: expectedMutationDigest,
    }),
  );
}

export async function installMutationRecoveryDomain(
  options: InstallMutationRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await installMutationRecoveryDomainControlled({
    workspacePath: options.workspacePath,
    identity: system.identity,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

export type ControlledAcquireMutationRecoveryAttemptOptions =
  ControlledAcquireRecoveryAttemptOptions;
export interface AcquireMutationRecoveryAttemptOptions {
  readonly workspacePath: string;
}

/** @internal Authority-controlled core. */
export async function acquireMutationRecoveryAttemptControlled(
  options: ControlledAcquireMutationRecoveryAttemptOptions,
): Promise<RecoveryAttemptHandle> {
  return await acquireRecoveryAttemptControlled(options, createMutationRecoveryAuthority());
}

export async function acquireMutationRecoveryAttempt(
  options: AcquireMutationRecoveryAttemptOptions,
): Promise<RecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await acquireMutationRecoveryAttemptControlled({
    workspacePath: options.workspacePath,
    identity: system.identity,
    probeSourceOwner: system.probeOwner,
    probeAttemptOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

function createBinding(
  handle: RecoveryAttemptHandle,
  domain: RecoveryDomain,
  attemptIdentity?: ProcessIdentitySnapshot,
  verifySystemAuthority?: () => void | Promise<void>,
): MutableRecoveryBinding {
  if (!domain.attemptOwnerBytes) throw recoveryInvalid('mutation recovery has no active attempt');
  const processIdentity = attemptIdentity ?? createIdentityProbe().current();
  requireCurrentAttemptOwner(domain.attemptOwner, processIdentity);
  return {
    workspacePath: handle.workspacePath,
    claimBytes: Buffer.from(domain.claimBytes),
    stateBytes: Buffer.from(domain.stateBytes),
    attemptOwnerBytes: Buffer.from(domain.attemptOwnerBytes),
    processIdentity,
    ...(verifySystemAuthority ? { verifySystemAuthority } : {}),
  };
}

async function readAuthorizedMutationRecovery(
  binding: MutableRecoveryBinding,
  probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict,
  expectedManifestBytes?: Buffer,
): Promise<AuthorizedMutationRecovery> {
  await binding.verifySystemAuthority?.();
  const context = await loadRecoveryContext(binding.workspacePath);
  const recovery = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  if (
    recovery.claim.mode !== 'mutation-resume' ||
    !recovery.claimBytes.equals(binding.claimBytes) ||
    !recovery.stateBytes.equals(binding.stateBytes) ||
    !recovery.attemptOwnerBytes?.equals(binding.attemptOwnerBytes)
  ) {
    throw new WorkspaceSafetyError('lease-lost', 'mutation recovery authority binding changed');
  }
  if (expectedManifestBytes && !recovery.finalManifestBytes?.equals(expectedManifestBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'mutation recovery final manifest changed');
  }
  requireCurrentAttemptOwner(recovery.attemptOwner, binding.processIdentity);
  requireDeadSourceOwner(context.sourceOwner, probeSourceOwner);
  const mutation = await assertMutationRecoverySourceShape(context.records, context.sourceOwner);
  const relation = mutationRelation(recovery, mutation);
  requireDeadSourceOwner(context.sourceOwner, probeSourceOwner);
  return { records: context.records, recovery, mutation, relation };
}

async function stageRecoveryState(records: ReadyWorkspaceRecords, bytes: Buffer): Promise<string> {
  const staging = await createStagingDirectory(
    activeLeasePath(records),
    'recovery.prepare-',
    randomUUID(),
  );
  const statePath = join(staging, RECOVERY_STATE_FILE);
  await writeNewFile(statePath, bytes);
  await assertExactFile(statePath, bytes);
  return statePath;
}

async function replaceRecoveryState(
  binding: MutableRecoveryBinding,
  probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict,
  nextBytes: Buffer,
): Promise<AuthorizedMutationRecovery> {
  const before = await readAuthorizedMutationRecovery(binding, probeSourceOwner);
  const staged = await stageRecoveryState(before.records, nextBytes);
  const commit = await readAuthorizedMutationRecovery(binding, probeSourceOwner);
  await replaceFileFromStaging(
    staged,
    join(activeLeasePath(commit.records), RECOVERY_DIR, RECOVERY_STATE_FILE),
  );
  binding.stateBytes = Buffer.from(nextBytes);
  return await readAuthorizedMutationRecovery(binding, probeSourceOwner);
}

async function reconcileMutationBinding(
  binding: MutableRecoveryBinding,
  probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict,
  now: () => Date,
): Promise<AuthorizedMutationRecovery> {
  let authorized = await readAuthorizedMutationRecovery(binding, probeSourceOwner);
  if (authorized.relation === 'exact') return authorized;
  if (authorized.recovery.state.phase !== 'claimed') {
    throw recoveryInvalid('only claimed recovery may reconcile a forward mutation step');
  }
  const nextBytes = createRecoveryStateBytes({
    recoveryId: authorized.recovery.claim.recoveryId,
    claimDigest: digestBytes(authorized.recovery.claimBytes),
    phase: 'claimed',
    expectedMutationPhase: authorized.mutation.state.phase,
    expectedMutationDigest: digestBytes(authorized.mutation.stateBytes),
    finalManifestDigest: null,
    updatedAt: now(),
  });
  authorized = await replaceRecoveryState(binding, probeSourceOwner, nextBytes);
  if (authorized.relation !== 'exact') {
    throw recoveryInvalid('mutation recovery state did not reconcile the forward step');
  }
  return authorized;
}

function scopeAllowed(domain: MutationDomain, scope: MutationWriteScope): boolean {
  if (scope.kind === 'mutation-state') return scope.path === 'state.json';
  if (scope.kind === 'archive') {
    return (
      scope.path === mutationArchivePath(domain.state.mutationId, domain.state.baseSnapshotDigest)
    );
  }
  if (scope.kind === 'business-write') {
    return domain.manifest.writes.some((write) => write.path === scope.path);
  }
  return domain.manifest.deletes.some((deletion) => deletion.path === scope.path);
}

function recoveryWriterAuthority(options: {
  readonly binding: MutableRecoveryBinding;
  readonly probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict;
  readonly now: () => Date;
  readonly mutation: MutationDomain;
}): MutationWriterAuthorityControlled {
  return createMutationWriterAuthorityControlled({
    workspace: options.mutation.workspace,
    verify: async (expected, scope) => {
      const current = await readAuthorizedMutationRecovery(
        options.binding,
        options.probeSourceOwner,
      );
      if (
        current.relation !== 'exact' ||
        !current.mutation.stateBytes.equals(expected.stateBytes) ||
        !current.mutation.manifestBytes.equals(expected.manifestBytes)
      ) {
        throw new WorkspaceSafetyError('lease-lost', 'RecoveryWriter mutation binding changed');
      }
      if (scope && !scopeAllowed(current.mutation, scope)) {
        throw recoveryInvalid('RecoveryWriter rejected an out-of-plan write');
      }
    },
    afterStateTransition: async (_previous, next) => {
      let current = await readAuthorizedMutationRecovery(options.binding, options.probeSourceOwner);
      if (
        current.relation !== 'one-step-ahead' ||
        !current.mutation.stateBytes.equals(next.stateBytes)
      ) {
        throw new WorkspaceSafetyError(
          'lease-lost',
          'RecoveryWriter did not observe the exact next mutation state',
        );
      }
      const nextRecoveryBytes = createRecoveryStateBytes({
        recoveryId: current.recovery.claim.recoveryId,
        claimDigest: digestBytes(current.recovery.claimBytes),
        phase: 'claimed',
        expectedMutationPhase: next.state.phase,
        expectedMutationDigest: digestBytes(next.stateBytes),
        finalManifestDigest: null,
        updatedAt: options.now(),
      });
      current = await replaceRecoveryState(
        options.binding,
        options.probeSourceOwner,
        nextRecoveryBytes,
      );
      if (current.relation !== 'exact') {
        throw recoveryInvalid('RecoveryWriter failed to bind the exact next mutation state');
      }
    },
  });
}

async function installFinalManifest(options: {
  readonly binding: MutableRecoveryBinding;
  readonly probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict;
  readonly manifestBytes: Buffer;
  readonly beforeSourceUnlink?: () => void | Promise<void>;
}): Promise<AuthorizedMutationRecovery> {
  let authorized = await readAuthorizedMutationRecovery(options.binding, options.probeSourceOwner);
  if (authorized.recovery.finalManifestBytes) {
    if (!authorized.recovery.finalManifestBytes.equals(options.manifestBytes)) {
      throw recoveryInvalid('mutation recovery has a conflicting final manifest');
    }
    if (authorized.recovery.linkedFinalManifestSource) {
      const linkedSource = authorized.recovery.linkedFinalManifestSource;
      await recoverLinkedFileInstall({
        source: linkedSource,
        target: join(
          activeLeasePath(authorized.records),
          RECOVERY_DIR,
          RECOVERY_FINAL_MANIFEST_FILE,
        ),
        expectedBytes: options.manifestBytes,
        authorize: async () => {
          const current = await readAuthorizedMutationRecovery(
            options.binding,
            options.probeSourceOwner,
          );
          if (current.recovery.linkedFinalManifestSource !== linkedSource) {
            throw new WorkspaceSafetyError('lease-lost', 'linked final manifest source changed');
          }
        },
      });
      authorized = await readAuthorizedMutationRecovery(
        options.binding,
        options.probeSourceOwner,
        options.manifestBytes,
      );
    }
    return authorized;
  }
  const staging = await createStagingDirectory(
    activeLeasePath(authorized.records),
    'recovery.prepare-',
    randomUUID(),
  );
  const source = join(staging, RECOVERY_FINAL_MANIFEST_FILE);
  await writeNewFile(source, options.manifestBytes);
  await assertExactFile(source, options.manifestBytes);
  authorized = await readAuthorizedMutationRecovery(options.binding, options.probeSourceOwner);
  await installFileNoReplace(
    source,
    join(activeLeasePath(authorized.records), RECOVERY_DIR, RECOVERY_FINAL_MANIFEST_FILE),
    { beforeSourceUnlink: options.beforeSourceUnlink },
  );
  return await readAuthorizedMutationRecovery(
    options.binding,
    options.probeSourceOwner,
    options.manifestBytes,
  );
}

async function expectedFinalManifest(
  authorized: AuthorizedMutationRecovery,
): Promise<{ readonly bytes: Buffer; readonly mutationSnapshotDigest: string }> {
  if (authorized.mutation.state.phase !== 'committed' || authorized.relation !== 'exact') {
    throw recoveryInvalid('finalization requires one exactly bound committed mutation');
  }
  const sourceSnapshotDigest = await captureRecoverySourceFromRecords(authorized.records);
  const mutationSnapshotDigest = await captureMutationFinalSnapshotDigest(authorized.mutation);
  return {
    bytes: createRecoveryFinalManifestBytes({
      recoveryId: authorized.recovery.claim.recoveryId,
      claimDigest: digestBytes(authorized.recovery.claimBytes),
      workspaceMarkerDigest: digestBytes(authorized.records.markerBytes),
      protocolDigest: digestBytes(authorized.records.protocolBytes),
      finalSourceSnapshotDigest: sourceSnapshotDigest,
      mutationSnapshotDigest,
      createdAt: new Date(authorized.recovery.state.updatedAt),
    }),
    mutationSnapshotDigest,
  };
}

function completion(
  authorized: AuthorizedMutationRecovery,
  manifestBytes: Buffer,
  mutationSnapshotDigest: string,
): MutationRecoveryCompletion {
  const archivePath = resolveWorkspaceRelativePath(
    authorized.records.workspace.path,
    authorized.recovery.claim.targetArchive,
  );
  return {
    workspacePath: authorized.records.workspace.path,
    targetArchive: authorized.recovery.claim.targetArchive,
    archivePath,
    recoveryId: authorized.recovery.claim.recoveryId,
    claimDigest: digestBytes(authorized.recovery.claimBytes),
    finalManifestDigest: digestBytes(manifestBytes),
    mutationSnapshotDigest,
  };
}

/** @internal Authority-controlled core. */
export async function resumeMutationRecoveryControlled(
  handle: RecoveryAttemptHandle,
  options: ControlledResumeMutationRecoveryOptions = {},
): Promise<MutationRecoveryCompletion> {
  assertWindowsWorkspaceTreeHasNoReparsePoints(handle.workspacePath);
  const initial = await handle.verify();
  if (initial.claim.mode !== 'mutation-resume') {
    throw new WorkspaceSafetyError('unsupported', 'recovery mode is not mutation-resume');
  }
  const binding = createBinding(
    handle,
    initial,
    options.attemptIdentity,
    options.verifySystemAuthority,
  );
  const probeSourceOwner = createSourceOwnerProbe(options.probeSourceOwner);
  const now = options.now ?? (() => new Date());
  let authorized = await reconcileMutationBinding(binding, probeSourceOwner, now);

  if (authorized.recovery.state.phase === 'claimed') {
    const authority = recoveryWriterAuthority({
      binding,
      probeSourceOwner,
      now,
      mutation: authorized.mutation,
    });
    authorized = await readAuthorizedMutationRecovery(binding, probeSourceOwner);
    assertWindowsWorkspaceTreeHasNoReparsePoints(binding.workspacePath);
    await advanceWorkspaceMutationControlled(authorized.mutation, authority, options.hooks);
    assertWindowsWorkspaceTreeHasNoReparsePoints(binding.workspacePath);
    authorized = await reconcileMutationBinding(binding, probeSourceOwner, now);
    if (authorized.mutation.state.phase !== 'committed') {
      throw recoveryInvalid('mutation resume did not reach committed');
    }
    const verifiedState = createRecoveryStateBytes({
      recoveryId: authorized.recovery.claim.recoveryId,
      claimDigest: digestBytes(authorized.recovery.claimBytes),
      phase: 'verified',
      expectedMutationPhase: 'committed',
      expectedMutationDigest: digestBytes(authorized.mutation.stateBytes),
      finalManifestDigest: null,
      updatedAt: now(),
    });
    authorized = await replaceRecoveryState(binding, probeSourceOwner, verifiedState);
    await options.hooks?.afterRecoveryVerified?.();
  }

  let expected = await expectedFinalManifest(authorized);
  if (authorized.recovery.state.phase === 'verified') {
    const alreadyInstalled = authorized.recovery.finalManifestBytes !== undefined;
    authorized = await installFinalManifest({
      binding,
      probeSourceOwner,
      manifestBytes: expected.bytes,
      beforeSourceUnlink: options.hooks?.beforeFinalManifestSourceUnlink,
    });
    if (!alreadyInstalled) await options.hooks?.afterFinalManifestInstalled?.();
    const finalizingState = createRecoveryStateBytes({
      recoveryId: authorized.recovery.claim.recoveryId,
      claimDigest: digestBytes(authorized.recovery.claimBytes),
      phase: 'finalizing',
      expectedMutationPhase: 'committed',
      expectedMutationDigest: digestBytes(authorized.mutation.stateBytes),
      finalManifestDigest: digestBytes(expected.bytes),
      updatedAt: new Date(authorized.recovery.state.updatedAt),
    });
    authorized = await replaceRecoveryState(binding, probeSourceOwner, finalizingState);
    await options.hooks?.afterRecoveryFinalizing?.();
  }
  if (authorized.recovery.state.phase !== 'finalizing') {
    throw recoveryInvalid('mutation recovery did not reach finalizing');
  }
  expected = await expectedFinalManifest(authorized);
  if (
    !authorized.recovery.finalManifestBytes?.equals(expected.bytes) ||
    authorized.recovery.state.finalManifestDigest !== digestBytes(expected.bytes)
  ) {
    throw recoveryInvalid('finalizing mutation recovery lost its deterministic manifest binding');
  }
  await options.hooks?.beforeFinalRename?.();
  assertWindowsWorkspaceTreeHasNoReparsePoints(binding.workspacePath);
  const finalAuthority = await readAuthorizedMutationRecovery(
    binding,
    probeSourceOwner,
    expected.bytes,
  );
  const finalExpected = await expectedFinalManifest(finalAuthority);
  if (!finalExpected.bytes.equals(expected.bytes)) {
    throw recoveryInvalid('mutation recovery final manifest became stale before rename');
  }
  const result = completion(finalAuthority, expected.bytes, finalExpected.mutationSnapshotDigest);
  await moveDirectoryNoReplace(activeLeasePath(finalAuthority.records), result.archivePath, {
    commitCheck: options.finalRenameCommitCheck,
  });
  // Successful rename is the last workspace action by this recovery attempt.
  return result;
}

export async function resumeMutationRecovery(
  handle: RecoveryAttemptHandle,
): Promise<MutationRecoveryCompletion> {
  const system = captureExactCurrentIdentityAuthority();
  return await resumeMutationRecoveryControlled(handle, {
    attemptIdentity: system.identity,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

async function readArchivedOwner(
  records: ReadyWorkspaceRecords,
  archivePath: string,
): Promise<OwnerRecord> {
  const ownerBytes = await readExactFile(join(archivePath, OWNER_FILE));
  const owner = parseJsonRecord(ownerBytes, parseOwnerRecord);
  validateCoreRecordBindings({
    marker: records.marker,
    protocol: records.protocol,
    owner,
    protocolBytes: records.protocolBytes,
    canonicalWorkspaceIdentity: records.workspace.identity,
  });
  return owner;
}

export async function verifyMutationRecoveryArchive(options: {
  readonly workspacePath: string;
  readonly targetArchive: string;
}): Promise<MutationRecoveryCompletion> {
  const records = await readReadyWorkspaceRecords(options.workspacePath);
  if ((await readActiveLeaseOwner(records)) !== undefined) {
    throw conflict('active lease still exists; mutation recovery is not finalized');
  }
  const archivePath = resolveWorkspaceRelativePath(records.workspace.path, options.targetArchive);
  const sourceOwner = await readArchivedOwner(records, archivePath);
  const recovery = await readRecoveryDomainAtPath(
    records,
    sourceOwner,
    join(archivePath, RECOVERY_DIR),
  );
  if (
    recovery.claim.mode !== 'mutation-resume' ||
    recovery.claim.targetArchive !== options.targetArchive ||
    recovery.state.phase !== 'finalizing' ||
    !recovery.finalManifestBytes
  ) {
    throw recoveryInvalid('archive is not a complete mutation recovery');
  }
  const mutation = await readMutationDomainAtPath({
    workspace: records.workspace,
    mutationPath: join(archivePath, MUTATION_DIR),
    expectedOwner: sourceOwner,
  });
  if (
    mutation.state.phase !== 'committed' ||
    recovery.state.expectedMutationPhase !== 'committed' ||
    recovery.state.expectedMutationDigest !== digestBytes(mutation.stateBytes)
  ) {
    throw recoveryInvalid('archive does not bind an exact committed mutation');
  }
  const sourceSnapshotDigest = await captureRecoverySourceAtLeasePath(records, archivePath);
  const mutationSnapshotDigest = await captureMutationFinalSnapshotDigest(mutation);
  const expectedManifest = createRecoveryFinalManifestBytes({
    recoveryId: recovery.claim.recoveryId,
    claimDigest: digestBytes(recovery.claimBytes),
    workspaceMarkerDigest: digestBytes(records.markerBytes),
    protocolDigest: digestBytes(records.protocolBytes),
    finalSourceSnapshotDigest: sourceSnapshotDigest,
    mutationSnapshotDigest,
    createdAt: new Date(recovery.state.updatedAt),
  });
  if (
    !recovery.finalManifestBytes.equals(expectedManifest) ||
    recovery.state.finalManifestDigest !== digestBytes(expectedManifest)
  ) {
    throw recoveryInvalid('archive final manifest is not the deterministic mutation manifest');
  }
  return completion(
    { records, recovery, mutation, relation: 'exact' },
    expectedManifest,
    mutationSnapshotDigest,
  );
}
