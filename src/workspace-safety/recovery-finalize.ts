import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  assertExactFile,
  createStagingDirectory,
  digestBytes,
  installFileNoReplace,
  moveDirectoryNoReplace,
  readExactFile,
  recoverLinkedFileInstall,
  replaceFileFromStaging,
  resolveWorkspaceRelativePath,
  writeNewFile,
  type WorkspaceDirectory,
} from './filesystem.js';
import {
  readActiveLeaseOwner,
  readReadyWorkspaceRecords,
  type ReadyWorkspaceRecords,
} from './lease.js';
import {
  loadRecoveryContext,
  readRecoveryDomainAtPath,
  type RecoveryDomain,
} from './recovery-domain.js';
import { captureExactCurrentIdentityAuthority, createIdentityProbe } from './identity.js';
import { readQuarantinePresence, type ExactContainmentQuarantine } from './quarantine.js';
import {
  RECOVERY_FINAL_MANIFEST_FILE,
  RECOVERY_STATE_FILE,
  createRecoveryFinalManifestBytes,
  createRecoveryStateBytes,
  recoveryInvalid,
  type RecoveryAttemptOwner,
} from './recovery-records.js';
import {
  assertMechanicalEmptyEligibility,
  assertMechanicalEmptyLeaseEligibility,
  captureRecoverySourceAtLeasePath,
  captureRecoverySourceFromRecords,
  createSourceOwnerProbe,
  requireDeadSourceOwner,
} from './recovery-source-snapshot.js';
import { parseJsonRecord, parseOwnerRecord, validateCoreRecordBindings } from './schema.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  type IdentityVerdict,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  WorkspaceSafetyError,
} from './types.js';
import type { RecoveryAttemptHandle } from './recovery-attempt.js';

export interface RecoveryFinalizationHooks {
  readonly afterVerified?: () => void | Promise<void>;
  readonly beforeFinalManifestSourceUnlink?: () => void | Promise<void>;
  readonly afterFinalManifestInstalled?: () => void | Promise<void>;
  readonly afterFinalizing?: () => void | Promise<void>;
  readonly beforeFinalRename?: () => void | Promise<void>;
}

/** Internal-only authority input used by trusted coordinators and the explicit test seam. */
export interface ControlledFinalizeMechanicalEmptyRecoveryOptions {
  readonly now?: () => Date;
  /** Exact test/coordinator identity; omitted callers keep the real platform read. */
  readonly attemptIdentity?: ProcessIdentitySnapshot;
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly hooks?: RecoveryFinalizationHooks;
  /** dark-only coordinator 的最终同步裁决点；抛错会在 rename 前完整保留 recovery。 */
  readonly finalRenameCommitCheck?: () => void;
  /** Exact dark-only authority carried by the same-host reboot coordinator. */
  readonly expectedRebootQuarantine?: ExactContainmentQuarantine;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal finalization has no caller-controlled clock, callbacks, probes, or commit barrier. */
export type FinalizeMechanicalEmptyRecoveryOptions = undefined;

export interface MechanicalEmptyRecoveryCompletion {
  readonly workspacePath: string;
  readonly targetArchive: string;
  readonly archivePath: string;
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly finalManifestDigest: string;
}

export interface VerifyMechanicalEmptyRecoveryArchiveOptions {
  readonly workspacePath: string;
  readonly targetArchive: string;
}

interface RecoveryAuthorityBinding {
  readonly workspacePath: string;
  readonly claimBytes: Buffer;
  readonly attemptOwnerBytes: Buffer;
  readonly processIdentity: ProcessIdentitySnapshot;
  readonly expectedRebootQuarantine?: ExactContainmentQuarantine;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

interface AuthorizedRecovery {
  readonly records: ReadyWorkspaceRecords;
  readonly domain: RecoveryDomain;
  readonly sourceSnapshotDigest: string;
}

function conflict(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('conflict', `Recovery conflict: ${message}`);
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  }
  return error;
}

function unsupportedMode(mode: string): WorkspaceSafetyError {
  return new WorkspaceSafetyError(
    'unsupported',
    `Recovery is not eligible: ${mode} finalization is not active`,
  );
}

function activeLeasePath(workspace: WorkspaceDirectory): string {
  return join(workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
}

function requireCurrentAttemptOwner(
  owner: RecoveryAttemptOwner | undefined,
  current: ProcessIdentitySnapshot,
): void {
  if (!owner) throw new WorkspaceSafetyError('lease-lost', 'recovery attempt owner is missing');
  if (
    owner.pid !== current.pid ||
    owner.bootIdentity !== current.bootIdentity ||
    owner.hostId !== current.hostId ||
    owner.processIdentity.kind !== current.processIdentity.kind ||
    owner.processIdentity.value !== current.processIdentity.value
  ) {
    throw new WorkspaceSafetyError(
      'lease-lost',
      'recovery finalization is not running as the exact attempt owner',
    );
  }
}

function createBinding(
  handle: RecoveryAttemptHandle,
  domain: RecoveryDomain,
  expectedRebootQuarantine?: ExactContainmentQuarantine,
  attemptIdentity?: ProcessIdentitySnapshot,
  verifySystemAuthority?: () => void | Promise<void>,
): RecoveryAuthorityBinding {
  if (!domain.attemptOwnerBytes) {
    throw recoveryInvalid('mechanical-empty finalization requires an active recovery attempt');
  }
  const processIdentity = attemptIdentity ?? createIdentityProbe().current();
  requireCurrentAttemptOwner(domain.attemptOwner, processIdentity);
  if ((domain.claim.rebootProof !== null) !== (expectedRebootQuarantine !== undefined)) {
    throw recoveryInvalid('mechanical containment authority does not match rebootProof presence');
  }
  return {
    workspacePath: handle.workspacePath,
    claimBytes: Buffer.from(domain.claimBytes),
    attemptOwnerBytes: Buffer.from(domain.attemptOwnerBytes),
    processIdentity,
    ...(expectedRebootQuarantine ? { expectedRebootQuarantine } : {}),
    ...(verifySystemAuthority ? { verifySystemAuthority } : {}),
  };
}

async function readAuthorizedRecovery(
  binding: RecoveryAuthorityBinding,
  probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict,
  expectedStateBytes?: Buffer,
  expectedManifestBytes?: Buffer,
): Promise<AuthorizedRecovery> {
  await binding.verifySystemAuthority?.();
  const context = await loadRecoveryContext(binding.workspacePath);
  const domain = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  if (domain.claim.mode !== 'mechanical-empty') {
    throw unsupportedMode(domain.claim.mode);
  }
  if (domain.claim.prestartOperation !== null) {
    throw new WorkspaceSafetyError(
      'unsupported',
      'Recovery is not eligible: prestart operation claims require dedicated finalization',
    );
  }
  if (!domain.claimBytes.equals(binding.claimBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'recovery claim binding changed');
  }
  if (!domain.attemptOwnerBytes?.equals(binding.attemptOwnerBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'recovery attempt ownership changed');
  }
  requireCurrentAttemptOwner(domain.attemptOwner, binding.processIdentity);
  if (expectedStateBytes && !domain.stateBytes.equals(expectedStateBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'recovery state changed outside this attempt');
  }
  if (expectedManifestBytes && !domain.finalManifestBytes?.equals(expectedManifestBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'recovery final manifest binding changed');
  }
  requireDeadSourceOwner(context.sourceOwner, probeSourceOwner);
  await assertMechanicalEmptyEligibility(
    context.records,
    context.sourceOwner,
    true,
    binding.expectedRebootQuarantine,
  );
  const sourceSnapshotDigest = await captureRecoverySourceFromRecords(context.records);
  if (sourceSnapshotDigest !== domain.claim.sourceSnapshotDigest) {
    throw conflict('mechanical-empty source no longer matches the immutable claim');
  }
  requireDeadSourceOwner(context.sourceOwner, probeSourceOwner);
  return { records: context.records, domain, sourceSnapshotDigest };
}

async function stageRecoveryFile(
  records: ReadyWorkspaceRecords,
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  const staging = await createStagingDirectory(
    activeLeasePath(records.workspace),
    'recovery.prepare-',
    randomUUID(),
  );
  const filePath = join(staging, fileName);
  await writeNewFile(filePath, bytes);
  await assertExactFile(filePath, bytes);
  return filePath;
}

function expectedManifestBytes(authorized: AuthorizedRecovery): Buffer {
  const { records, domain, sourceSnapshotDigest } = authorized;
  return createRecoveryFinalManifestBytes({
    recoveryId: domain.claim.recoveryId,
    claimDigest: digestBytes(domain.claimBytes),
    workspaceMarkerDigest: digestBytes(records.markerBytes),
    protocolDigest: digestBytes(records.protocolBytes),
    finalSourceSnapshotDigest: sourceSnapshotDigest,
    mutationSnapshotDigest: null,
    // Preserve the verified timestamp through finalizing so a replacement attempt can
    // deterministically recompute the exact same manifest bytes.
    createdAt: new Date(domain.state.updatedAt),
  });
}

async function replaceRecoveryState(
  binding: RecoveryAuthorityBinding,
  probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict,
  previousStateBytes: Buffer,
  nextStateBytes: Buffer,
): Promise<AuthorizedRecovery> {
  const before = await readAuthorizedRecovery(binding, probeSourceOwner, previousStateBytes);
  const stagedState = await stageRecoveryFile(before.records, RECOVERY_STATE_FILE, nextStateBytes);
  const commitAuthority = await readAuthorizedRecovery(
    binding,
    probeSourceOwner,
    previousStateBytes,
  );
  await replaceFileFromStaging(
    stagedState,
    join(activeLeasePath(commitAuthority.records.workspace), RECOVERY_DIR, RECOVERY_STATE_FILE),
  );
  return await readAuthorizedRecovery(binding, probeSourceOwner, nextStateBytes);
}

async function installFinalManifest(
  binding: RecoveryAuthorityBinding,
  probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict,
  stateBytes: Buffer,
  manifestBytes: Buffer,
  beforeSourceUnlink?: () => void | Promise<void>,
): Promise<AuthorizedRecovery> {
  const before = await readAuthorizedRecovery(binding, probeSourceOwner, stateBytes);
  if (before.domain.finalManifestBytes) {
    if (!before.domain.finalManifestBytes.equals(manifestBytes)) {
      throw recoveryInvalid('verified recovery contains a conflicting final manifest');
    }
    if (before.domain.linkedFinalManifestSource) {
      const linkedSource = before.domain.linkedFinalManifestSource;
      await recoverLinkedFileInstall({
        source: linkedSource,
        target: join(
          activeLeasePath(before.records.workspace),
          RECOVERY_DIR,
          RECOVERY_FINAL_MANIFEST_FILE,
        ),
        expectedBytes: manifestBytes,
        authorize: async () => {
          const current = await readAuthorizedRecovery(binding, probeSourceOwner, stateBytes);
          if (current.domain.linkedFinalManifestSource !== linkedSource) {
            throw new WorkspaceSafetyError(
              'lease-lost',
              'controlled recovery final-manifest install pair changed',
            );
          }
        },
      });
      return await readAuthorizedRecovery(binding, probeSourceOwner, stateBytes, manifestBytes);
    }
    return before;
  }
  const stagedManifest = await stageRecoveryFile(
    before.records,
    RECOVERY_FINAL_MANIFEST_FILE,
    manifestBytes,
  );
  const commitAuthority = await readAuthorizedRecovery(binding, probeSourceOwner, stateBytes);
  if (commitAuthority.domain.finalManifestBytes) {
    throw conflict('final manifest appeared during no-replace installation');
  }
  await installFileNoReplace(
    stagedManifest,
    join(
      activeLeasePath(commitAuthority.records.workspace),
      RECOVERY_DIR,
      RECOVERY_FINAL_MANIFEST_FILE,
    ),
    { beforeSourceUnlink },
  );
  return await readAuthorizedRecovery(binding, probeSourceOwner, stateBytes, manifestBytes);
}

function completionFromDomain(
  records: ReadyWorkspaceRecords,
  domain: RecoveryDomain,
  manifestBytes: Buffer,
): MechanicalEmptyRecoveryCompletion {
  const archivePath = resolveWorkspaceRelativePath(
    records.workspace.path,
    domain.claim.targetArchive,
  );
  return {
    workspacePath: records.workspace.path,
    targetArchive: domain.claim.targetArchive,
    archivePath,
    recoveryId: domain.claim.recoveryId,
    claimDigest: digestBytes(domain.claimBytes),
    finalManifestDigest: digestBytes(manifestBytes),
  };
}

/** @internal Trusted coordinator core. Production callers use finalizeMechanicalEmptyRecovery. */
export async function finalizeMechanicalEmptyRecoveryControlled(
  handle: RecoveryAttemptHandle,
  options: ControlledFinalizeMechanicalEmptyRecoveryOptions = {},
): Promise<MechanicalEmptyRecoveryCompletion> {
  const initial = await handle.verify();
  if (initial.claim.mode !== 'mechanical-empty') throw unsupportedMode(initial.claim.mode);
  if (initial.claim.prestartOperation !== null) {
    throw new WorkspaceSafetyError(
      'unsupported',
      'Recovery is not eligible: prestart operation claims require dedicated finalization',
    );
  }
  const binding = createBinding(
    handle,
    initial,
    options.expectedRebootQuarantine,
    options.attemptIdentity,
    options.verifySystemAuthority,
  );
  const probeSourceOwner = createSourceOwnerProbe(options.probeSourceOwner);
  const now = options.now ?? (() => new Date());
  let authorized = await readAuthorizedRecovery(
    binding,
    probeSourceOwner,
    initial.stateBytes,
    initial.finalManifestBytes,
  );

  if (authorized.domain.state.phase === 'claimed') {
    if (authorized.domain.finalManifestBytes) {
      throw recoveryInvalid('claimed recovery cannot contain a final manifest');
    }
    const verifiedStateBytes = createRecoveryStateBytes({
      recoveryId: authorized.domain.claim.recoveryId,
      claimDigest: digestBytes(authorized.domain.claimBytes),
      phase: 'verified',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: null,
      updatedAt: now(),
    });
    authorized = await replaceRecoveryState(
      binding,
      probeSourceOwner,
      authorized.domain.stateBytes,
      verifiedStateBytes,
    );
    await options.hooks?.afterVerified?.();
  }

  let manifestBytes: Buffer;
  if (authorized.domain.state.phase === 'verified') {
    manifestBytes = expectedManifestBytes(authorized);
    const alreadyInstalled = authorized.domain.finalManifestBytes !== undefined;
    authorized = await installFinalManifest(
      binding,
      probeSourceOwner,
      authorized.domain.stateBytes,
      manifestBytes,
      options.hooks?.beforeFinalManifestSourceUnlink,
    );
    if (!alreadyInstalled) await options.hooks?.afterFinalManifestInstalled?.();
    const finalizingStateBytes = createRecoveryStateBytes({
      recoveryId: authorized.domain.claim.recoveryId,
      claimDigest: digestBytes(authorized.domain.claimBytes),
      phase: 'finalizing',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: digestBytes(manifestBytes),
      updatedAt: new Date(authorized.domain.state.updatedAt),
    });
    authorized = await replaceRecoveryState(
      binding,
      probeSourceOwner,
      authorized.domain.stateBytes,
      finalizingStateBytes,
    );
    if (!authorized.domain.finalManifestBytes?.equals(manifestBytes)) {
      throw recoveryInvalid('finalizing state lost its exact final manifest');
    }
    await options.hooks?.afterFinalizing?.();
  }

  if (authorized.domain.state.phase !== 'finalizing' || !authorized.domain.finalManifestBytes) {
    throw recoveryInvalid('mechanical-empty finalization did not reach finalizing');
  }
  manifestBytes = expectedManifestBytes(authorized);
  if (!authorized.domain.finalManifestBytes.equals(manifestBytes)) {
    throw recoveryInvalid('finalizing recovery manifest conflicts with recomputed source');
  }
  if (authorized.domain.state.finalManifestDigest !== digestBytes(manifestBytes)) {
    throw recoveryInvalid('finalizing recovery state does not bind the exact manifest');
  }

  await options.hooks?.beforeFinalRename?.();

  // This is the final authority read. Everything required for the return value is materialized
  // before the rename; the successful rename below must be the writer's last workspace action.
  const finalAuthority = await readAuthorizedRecovery(
    binding,
    probeSourceOwner,
    authorized.domain.stateBytes,
    manifestBytes,
  );
  const recomputedManifest = expectedManifestBytes(finalAuthority);
  if (!recomputedManifest.equals(manifestBytes)) {
    throw recoveryInvalid('final manifest became stale before the archive commit');
  }
  const completion = completionFromDomain(
    finalAuthority.records,
    finalAuthority.domain,
    manifestBytes,
  );
  await moveDirectoryNoReplace(
    activeLeasePath(finalAuthority.records.workspace),
    completion.archivePath,
    { commitCheck: options.finalRenameCommitCheck },
  );

  // Do not add reads, cleanup, hooks, logging sinks, or writes that touch workspace below here.
  return completion;
}

export async function finalizeMechanicalEmptyRecovery(
  handle: RecoveryAttemptHandle,
): Promise<MechanicalEmptyRecoveryCompletion> {
  const system = captureExactCurrentIdentityAuthority();
  return await finalizeMechanicalEmptyRecoveryControlled(handle, {
    attemptIdentity: system.identity,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

async function readArchivedSourceOwner(
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

export async function verifyMechanicalEmptyRecoveryArchive(
  options: VerifyMechanicalEmptyRecoveryArchiveOptions,
): Promise<MechanicalEmptyRecoveryCompletion> {
  const records = await readReadyWorkspaceRecords(options.workspacePath);
  if ((await readActiveLeaseOwner(records)) !== undefined) {
    throw conflict('active lease still exists; recovery archive is not the ready fact');
  }
  const archivePath = resolveWorkspaceRelativePath(records.workspace.path, options.targetArchive);
  const sourceOwner = await readArchivedSourceOwner(records, archivePath);
  const recoveryPath = join(archivePath, RECOVERY_DIR);
  const domain = await readRecoveryDomainAtPath(records, sourceOwner, recoveryPath);
  if (domain.claim.mode !== 'mechanical-empty') throw unsupportedMode(domain.claim.mode);
  if (domain.claim.prestartOperation !== null) {
    throw new WorkspaceSafetyError(
      'unsupported',
      'Recovery is not eligible: prestart operation archive requires dedicated verification',
    );
  }
  if (domain.claim.targetArchive !== options.targetArchive) {
    throw recoveryInvalid('archive path does not match its immutable recovery claim');
  }
  const quarantine = await readQuarantinePresence(archivePath);
  const expectedContainment = domain.claim.rebootProof
    ? quarantine.canonical && !quarantine.canonical.linkedSource
      ? {
          bytes: quarantine.canonical.bytes,
          digest: digestBytes(quarantine.canonical.bytes),
        }
      : undefined
    : undefined;
  if (domain.claim.rebootProof && !expectedContainment) {
    throw recoveryInvalid('reboot archive lost its canonical containment quarantine');
  }
  await assertMechanicalEmptyLeaseEligibility(archivePath, sourceOwner, true, expectedContainment);
  if (domain.state.phase !== 'finalizing' || !domain.finalManifestBytes) {
    throw recoveryInvalid('archive does not contain a complete finalizing recovery');
  }
  const sourceSnapshotDigest = await captureRecoverySourceAtLeasePath(records, archivePath);
  if (
    sourceSnapshotDigest !== domain.claim.sourceSnapshotDigest ||
    sourceSnapshotDigest !== domain.finalManifest?.finalSourceSnapshotDigest
  ) {
    throw recoveryInvalid('archive source does not match claim and final manifest');
  }
  const expectedManifest = expectedManifestBytes({ records, domain, sourceSnapshotDigest });
  if (!domain.finalManifestBytes.equals(expectedManifest)) {
    throw recoveryInvalid('archive final manifest is not the deterministic verified manifest');
  }
  return completionFromDomain(records, domain, expectedManifest);
}
