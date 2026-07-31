import { randomUUID } from 'node:crypto';
import { basename, join } from 'node:path';
import type { DelegatedSemanticCandidate } from '../contracts/delegated-operation-contract.js';
import { evaluateDelegatedDelta } from './baseline.js';
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
} from './filesystem.js';
import { captureExactCurrentIdentityAuthority, createIdentityProbe } from './identity.js';
import { readActiveLeaseOwner, readReadyWorkspaceRecords } from './lease.js';
import { SETTLED_OPERATIONS_DIR, assertOrdinaryDirectory } from './operation-records.js';
import type { RecoveryAttemptHandle } from './recovery-attempt.js';
import {
  loadRecoveryContext,
  readRecoveryDomainAtPath,
  type RecoveryContext,
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
import { installQuarantineNoReplace, upgradeContainmentQuarantine } from './quarantine.js';
import { parseJsonRecord, parseOwnerRecord, validateCoreRecordBindings } from './schema.js';
import {
  OWNER_FILE,
  RECOVERY_DIR,
  type ProcessIdentitySnapshot,
  WorkspaceSafetyError,
} from './types.js';
import {
  activeLeasePath,
  assertDelegatedLeaseShape,
  assertExactDelegatedContainment,
  assertRebootQuarantineAuthority,
  createRecoveryIntegrityQuarantineBytes,
  evaluateDelegatedRecoveryDelta,
  invalid,
  isolated,
  readStableDelegatedOperation,
  sameSnapshot,
  type DelegatedDeltaAcceptance,
  type DelegatedOperationSnapshot,
  type DelegatedRecoveryProbeOptions,
} from './delegated-recovery.js';

export interface DelegatedRecoveryFinalizationHooks {
  readonly beforeOperationSettle?: (targetPath: string) => void | Promise<void>;
  readonly afterOperationSettled?: (settledPath: string) => void | Promise<void>;
  readonly afterVerified?: () => void | Promise<void>;
  readonly beforeFinalManifestSourceUnlink?: () => void | Promise<void>;
  readonly afterFinalManifestInstalled?: () => void | Promise<void>;
  readonly afterFinalizing?: () => void | Promise<void>;
  readonly beforeFinalRename?: () => void | Promise<void>;
}

export interface ControlledFinalizeDelegatedRecoveryOptions extends DelegatedRecoveryProbeOptions {
  readonly now?: () => Date;
  /** Exact test/coordinator identity; omitted callers keep the real platform read. */
  readonly attemptIdentity?: ProcessIdentitySnapshot;
  readonly hooks?: DelegatedRecoveryFinalizationHooks;
  /** dark-only coordinator 的最终同步裁决点；抛错会在 rename 前保留 recovery。 */
  readonly finalRenameCommitCheck?: () => void;
}

/** Formal finalization has no caller-controlled clock, callbacks, probes, or commit barrier. */
export type FinalizeDelegatedRecoveryOptions = undefined;

export interface DelegatedRecoveryCompletion {
  readonly workspacePath: string;
  readonly targetArchive: string;
  readonly archivePath: string;
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly finalManifestDigest: string;
  readonly settledOperationPath: string;
  readonly candidateDigest: string | null;
  readonly candidate?: DelegatedSemanticCandidate;
}

export interface VerifyDelegatedRecoveryArchiveOptions {
  readonly workspacePath: string;
  readonly targetArchive: string;
}

interface DelegatedRecoveryAuthorityBinding {
  readonly workspacePath: string;
  readonly claimBytes: Buffer;
  readonly attemptOwnerBytes: Buffer;
  readonly processIdentity: ProcessIdentitySnapshot;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

interface AuthorizedDelegatedRecovery {
  readonly context: RecoveryContext;
  readonly domain: RecoveryDomain;
  readonly snapshot: DelegatedOperationSnapshot;
  readonly sourceSnapshotDigest: string;
}

function requireCurrentAttemptOwner(
  owner: RecoveryAttemptOwner | undefined,
  current: DelegatedRecoveryAuthorityBinding['processIdentity'],
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
      'delegated finalization is not running as the exact recovery attempt owner',
    );
  }
}

function createDelegatedFinalizationBinding(
  domain: RecoveryDomain,
  attemptIdentity?: ProcessIdentitySnapshot,
  verifySystemAuthority?: () => void | Promise<void>,
): DelegatedRecoveryAuthorityBinding {
  if (!domain.attemptOwnerBytes) {
    throw recoveryInvalid('delegated finalization requires an active recovery attempt');
  }
  const processIdentity = attemptIdentity ?? createIdentityProbe().current();
  requireCurrentAttemptOwner(domain.attemptOwner, processIdentity);
  return {
    workspacePath: domain.workspace.path,
    claimBytes: Buffer.from(domain.claimBytes),
    attemptOwnerBytes: Buffer.from(domain.attemptOwnerBytes),
    processIdentity,
    ...(verifySystemAuthority ? { verifySystemAuthority } : {}),
  };
}

function assertDelegatedAttemptBinding(
  binding: DelegatedRecoveryAuthorityBinding,
  domain: RecoveryDomain,
  expectedStateBytes?: Buffer,
  expectedManifestBytes?: Buffer,
): void {
  if (domain.claim.mode !== 'delegated-finalize' || !domain.claim.delegatedOperation) {
    throw new WorkspaceSafetyError(
      'unsupported',
      `Recovery is not eligible: ${domain.claim.mode} is not delegated-finalize`,
    );
  }
  if (!domain.claimBytes.equals(binding.claimBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'delegated recovery claim binding changed');
  }
  if (!domain.attemptOwnerBytes?.equals(binding.attemptOwnerBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'delegated recovery attempt ownership changed');
  }
  requireCurrentAttemptOwner(domain.attemptOwner, binding.processIdentity);
  if (expectedStateBytes && !domain.stateBytes.equals(expectedStateBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'delegated recovery state changed');
  }
  if (expectedManifestBytes && !domain.finalManifestBytes?.equals(expectedManifestBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'delegated final manifest binding changed');
  }
}

async function readAuthorizedDelegatedRecovery(
  binding: DelegatedRecoveryAuthorityBinding,
  probes: DelegatedRecoveryProbeOptions,
  expectedStateBytes?: Buffer,
  expectedManifestBytes?: Buffer,
): Promise<AuthorizedDelegatedRecovery> {
  await binding.verifySystemAuthority?.();
  const context = await loadRecoveryContext(binding.workspacePath);
  const domain = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  assertDelegatedAttemptBinding(binding, domain, expectedStateBytes, expectedManifestBytes);
  const sourceOwnerProbe = createSourceOwnerProbe(probes.probeSourceOwner);
  requireDeadSourceOwner(context.sourceOwner, sourceOwnerProbe);
  await assertDelegatedLeaseShape(context);
  const snapshot = await readStableDelegatedOperation(
    context,
    domain.claim.delegatedOperation ?? undefined,
    domain,
  );
  if (snapshot.linkedReceiptSource) {
    throw invalid('delegated recovery retained a drained-receipt staging identity');
  }
  if (snapshot.quarantine?.reason === 'workspace-integrity-violation') {
    throw isolated('workspace-integrity-violation');
  }
  assertRebootQuarantineAuthority(snapshot, probes, domain);
  assertExactDelegatedContainment(snapshot, probes);
  const sourceSnapshotDigest = await captureRecoverySourceFromRecords(context.records);
  if (
    snapshot.location === 'active' &&
    sourceSnapshotDigest !== domain.claim.sourceSnapshotDigest
  ) {
    throw invalid('active delegated source no longer matches the immutable claim');
  }
  if (snapshot.location === 'active' && domain.state.phase !== 'claimed') {
    throw recoveryInvalid('verified delegated recovery still has an active operation');
  }
  if (
    snapshot.location === 'settled' &&
    domain.finalManifest &&
    domain.finalManifest.finalSourceSnapshotDigest !== sourceSnapshotDigest
  ) {
    throw recoveryInvalid('settled delegated source no longer matches its final manifest');
  }
  return { context, domain, snapshot, sourceSnapshotDigest };
}

async function readDelegatedAttemptAuthorityWithoutSource(
  binding: DelegatedRecoveryAuthorityBinding,
  probes: DelegatedRecoveryProbeOptions,
  expectedStateBytes: Buffer,
  expectedSnapshot: DelegatedOperationSnapshot,
): Promise<AuthorizedDelegatedRecovery> {
  await binding.verifySystemAuthority?.();
  const context = await loadRecoveryContext(binding.workspacePath);
  const domain = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  assertDelegatedAttemptBinding(binding, domain, expectedStateBytes);
  requireDeadSourceOwner(context.sourceOwner, createSourceOwnerProbe(probes.probeSourceOwner));
  await assertDelegatedLeaseShape(context);
  const snapshot = await readStableDelegatedOperation(
    context,
    domain.claim.delegatedOperation ?? undefined,
    domain,
  );
  if (!sameSnapshot(snapshot, expectedSnapshot)) {
    throw new WorkspaceSafetyError('lease-lost', 'delegated operation authority changed');
  }
  assertRebootQuarantineAuthority(snapshot, probes, domain);
  assertExactDelegatedContainment(snapshot, probes);
  return {
    context,
    domain,
    snapshot,
    sourceSnapshotDigest: domain.claim.sourceSnapshotDigest,
  };
}

async function stageDelegatedRecoveryFile(
  authorized: AuthorizedDelegatedRecovery,
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  const staging = await createStagingDirectory(
    activeLeasePath(authorized.context.records.workspace),
    'recovery.prepare-',
    randomUUID(),
  );
  const path = join(staging, fileName);
  await writeNewFile(path, bytes);
  await assertExactFile(path, bytes);
  return path;
}

async function replaceDelegatedRecoveryState(
  binding: DelegatedRecoveryAuthorityBinding,
  probes: DelegatedRecoveryProbeOptions,
  previousStateBytes: Buffer,
  nextStateBytes: Buffer,
): Promise<AuthorizedDelegatedRecovery> {
  const before = await readAuthorizedDelegatedRecovery(binding, probes, previousStateBytes);
  const staged = await stageDelegatedRecoveryFile(before, RECOVERY_STATE_FILE, nextStateBytes);
  const commit = await readAuthorizedDelegatedRecovery(binding, probes, previousStateBytes);
  await replaceFileFromStaging(
    staged,
    join(activeLeasePath(commit.context.records.workspace), RECOVERY_DIR, RECOVERY_STATE_FILE),
  );
  return await readAuthorizedDelegatedRecovery(binding, probes, nextStateBytes);
}

function expectedDelegatedManifestBytes(
  authorized: AuthorizedDelegatedRecovery,
  acceptance: DelegatedDeltaAcceptance,
): Buffer {
  return createRecoveryFinalManifestBytes({
    recoveryId: authorized.domain.claim.recoveryId,
    claimDigest: digestBytes(authorized.domain.claimBytes),
    workspaceMarkerDigest: digestBytes(authorized.context.records.markerBytes),
    protocolDigest: digestBytes(authorized.context.records.protocolBytes),
    finalSourceSnapshotDigest: authorized.sourceSnapshotDigest,
    mutationSnapshotDigest: null,
    delegatedCandidateDigest: acceptance.candidateDigest,
    createdAt: new Date(authorized.domain.state.updatedAt),
  });
}

async function installDelegatedFinalManifest(
  binding: DelegatedRecoveryAuthorityBinding,
  probes: DelegatedRecoveryProbeOptions,
  stateBytes: Buffer,
  manifestBytes: Buffer,
  beforeSourceUnlink?: () => void | Promise<void>,
): Promise<AuthorizedDelegatedRecovery> {
  const before = await readAuthorizedDelegatedRecovery(binding, probes, stateBytes);
  if (before.domain.finalManifestBytes) {
    if (!before.domain.finalManifestBytes.equals(manifestBytes)) {
      throw recoveryInvalid('verified delegated recovery has a conflicting final manifest');
    }
    if (before.domain.linkedFinalManifestSource) {
      const linkedSource = before.domain.linkedFinalManifestSource;
      await recoverLinkedFileInstall({
        source: linkedSource,
        target: join(
          activeLeasePath(before.context.records.workspace),
          RECOVERY_DIR,
          RECOVERY_FINAL_MANIFEST_FILE,
        ),
        expectedBytes: manifestBytes,
        beforeSourceUnlink,
        authorize: async () => {
          const current = await readAuthorizedDelegatedRecovery(binding, probes, stateBytes);
          if (current.domain.linkedFinalManifestSource !== linkedSource) {
            throw new WorkspaceSafetyError(
              'lease-lost',
              'controlled delegated final-manifest install pair changed',
            );
          }
        },
      });
      return await readAuthorizedDelegatedRecovery(binding, probes, stateBytes, manifestBytes);
    }
    return before;
  }
  const staged = await stageDelegatedRecoveryFile(
    before,
    RECOVERY_FINAL_MANIFEST_FILE,
    manifestBytes,
  );
  const commit = await readAuthorizedDelegatedRecovery(binding, probes, stateBytes);
  if (commit.domain.finalManifestBytes) {
    throw new WorkspaceSafetyError(
      'conflict',
      'Recovery conflict: delegated final manifest appeared during installation',
    );
  }
  await installFileNoReplace(
    staged,
    join(
      activeLeasePath(commit.context.records.workspace),
      RECOVERY_DIR,
      RECOVERY_FINAL_MANIFEST_FILE,
    ),
    { beforeSourceUnlink },
  );
  return await readAuthorizedDelegatedRecovery(binding, probes, stateBytes, manifestBytes);
}

async function installDelegatedIntegrityQuarantine(
  binding: DelegatedRecoveryAuthorityBinding,
  probes: DelegatedRecoveryProbeOptions,
  authorized: AuthorizedDelegatedRecovery,
  now: () => Date,
  cause?: unknown,
  expectedManifestBytes?: Buffer,
): Promise<never> {
  const quarantineBytes = createRecoveryIntegrityQuarantineBytes({
    context: authorized.context,
    domain: authorized.domain,
    snapshot: authorized.snapshot,
    createdAt: now(),
  });
  const verifyAuthority = async (): Promise<void> => {
    const current = await readDelegatedAttemptAuthorityWithoutSource(
      binding,
      probes,
      authorized.domain.stateBytes,
      authorized.snapshot,
    );
    let violationStillPresent: boolean;
    if (expectedManifestBytes) {
      violationStillPresent =
        current.domain.finalManifestBytes !== undefined &&
        !current.domain.finalManifestBytes.equals(expectedManifestBytes);
    } else {
      try {
        violationStillPresent = !evaluateDelegatedDelta(
          current.context.records.workspace.path,
          current.snapshot.baseline,
          {
            requireUnchanged:
              current.snapshot.receipt.proof === 'never-started-containment-empty-v1',
          },
        ).accepted;
      } catch {
        violationStillPresent = true;
      }
    }
    if (!violationStillPresent) {
      throw new WorkspaceSafetyError(
        'conflict',
        'Recovery conflict: delegated integrity violation disappeared before quarantine commit',
      );
    }
  };
  if (authorized.snapshot.quarantineBytes) {
    await upgradeContainmentQuarantine({
      containerPath: authorized.snapshot.operationPath,
      priorBytes: authorized.snapshot.quarantineBytes,
      recordBytes: quarantineBytes,
      verifyAuthority,
    });
  } else {
    await installQuarantineNoReplace({
      containerPath: authorized.snapshot.operationPath,
      recordBytes: quarantineBytes,
      verifyAuthority,
    });
  }
  throw isolated('workspace-integrity-violation', cause);
}

async function evaluateOrQuarantine(
  binding: DelegatedRecoveryAuthorityBinding,
  probes: DelegatedRecoveryProbeOptions,
  authorized: AuthorizedDelegatedRecovery,
  now: () => Date,
): Promise<DelegatedDeltaAcceptance> {
  try {
    return evaluateDelegatedRecoveryDelta(
      authorized.context.records.workspace.path,
      authorized.snapshot,
    );
  } catch (error) {
    return await installDelegatedIntegrityQuarantine(binding, probes, authorized, now, error);
  }
}

async function settleDelegatedOperation(
  binding: DelegatedRecoveryAuthorityBinding,
  probes: DelegatedRecoveryProbeOptions,
  authorized: AuthorizedDelegatedRecovery,
  now: () => Date,
  hooks: DelegatedRecoveryFinalizationHooks,
): Promise<{
  authorized: AuthorizedDelegatedRecovery;
  acceptance: DelegatedDeltaAcceptance;
}> {
  if (authorized.snapshot.location === 'settled') {
    return {
      authorized,
      acceptance: await evaluateOrQuarantine(binding, probes, authorized, now),
    };
  }

  await evaluateOrQuarantine(binding, probes, authorized, now);
  await assertOrdinaryDirectory(
    join(activeLeasePath(authorized.context.records.workspace), SETTLED_OPERATIONS_DIR),
    SETTLED_OPERATIONS_DIR,
  );
  await hooks.beforeOperationSettle?.(authorized.snapshot.settledPath);
  const commit = await readAuthorizedDelegatedRecovery(
    binding,
    probes,
    authorized.domain.stateBytes,
  );
  if (commit.snapshot.location !== 'active') {
    throw new WorkspaceSafetyError(
      'conflict',
      'Recovery conflict: delegated operation settled by another writer',
    );
  }
  const acceptance = await evaluateOrQuarantine(binding, probes, commit, now);
  await moveDirectoryNoReplace(commit.snapshot.operationPath, commit.snapshot.settledPath);
  await hooks.afterOperationSettled?.(commit.snapshot.settledPath);
  const settled = await readAuthorizedDelegatedRecovery(binding, probes, commit.domain.stateBytes);
  if (settled.snapshot.location !== 'settled') {
    throw recoveryInvalid('delegated operation settlement did not become canonical');
  }
  return { authorized: settled, acceptance };
}

function delegatedCompletion(
  authorized: AuthorizedDelegatedRecovery,
  manifestBytes: Buffer,
  acceptance: DelegatedDeltaAcceptance,
): DelegatedRecoveryCompletion {
  const archivePath = resolveWorkspaceRelativePath(
    authorized.context.records.workspace.path,
    authorized.domain.claim.targetArchive,
  );
  return {
    workspacePath: authorized.context.records.workspace.path,
    targetArchive: authorized.domain.claim.targetArchive,
    archivePath,
    recoveryId: authorized.domain.claim.recoveryId,
    claimDigest: digestBytes(authorized.domain.claimBytes),
    finalManifestDigest: digestBytes(manifestBytes),
    settledOperationPath: join(
      archivePath,
      SETTLED_OPERATIONS_DIR,
      basename(authorized.snapshot.operationPath),
    ),
    candidateDigest: acceptance.candidateDigest,
    ...(acceptance.candidate ? { candidate: acceptance.candidate } : {}),
  };
}

/** @internal Authority-controlled core. */
export async function finalizeDelegatedRecoveryControlled(
  handle: RecoveryAttemptHandle,
  options: ControlledFinalizeDelegatedRecoveryOptions = {},
): Promise<DelegatedRecoveryCompletion> {
  const initial = await handle.verify();
  if (initial.claim.mode !== 'delegated-finalize') {
    throw new WorkspaceSafetyError(
      'unsupported',
      `Recovery is not eligible: ${initial.claim.mode} is not delegated-finalize`,
    );
  }
  const binding = createDelegatedFinalizationBinding(
    initial,
    options.attemptIdentity,
    options.verifySystemAuthority,
  );
  const now = options.now ?? (() => new Date());
  const hooks = options.hooks ?? {};
  let authorized = await readAuthorizedDelegatedRecovery(
    binding,
    options,
    initial.stateBytes,
    initial.finalManifestBytes,
  );
  let acceptance: DelegatedDeltaAcceptance;

  if (authorized.domain.state.phase === 'claimed') {
    const settled = await settleDelegatedOperation(binding, options, authorized, now, hooks);
    authorized = settled.authorized;
    acceptance = settled.acceptance;
    const verifiedStateBytes = createRecoveryStateBytes({
      recoveryId: authorized.domain.claim.recoveryId,
      claimDigest: digestBytes(authorized.domain.claimBytes),
      phase: 'verified',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: null,
      updatedAt: now(),
    });
    authorized = await replaceDelegatedRecoveryState(
      binding,
      options,
      authorized.domain.stateBytes,
      verifiedStateBytes,
    );
    await hooks.afterVerified?.();
  } else {
    if (authorized.snapshot.location !== 'settled') {
      throw recoveryInvalid('delegated recovery state advanced before operation settlement');
    }
    acceptance = await evaluateOrQuarantine(binding, options, authorized, now);
  }

  let manifestBytes: Buffer;
  if (authorized.domain.state.phase === 'verified') {
    manifestBytes = expectedDelegatedManifestBytes(authorized, acceptance);
    const alreadyInstalled = authorized.domain.finalManifestBytes !== undefined;
    authorized = await installDelegatedFinalManifest(
      binding,
      options,
      authorized.domain.stateBytes,
      manifestBytes,
      hooks.beforeFinalManifestSourceUnlink,
    );
    if (!alreadyInstalled) await hooks.afterFinalManifestInstalled?.();
    const finalizingStateBytes = createRecoveryStateBytes({
      recoveryId: authorized.domain.claim.recoveryId,
      claimDigest: digestBytes(authorized.domain.claimBytes),
      phase: 'finalizing',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: digestBytes(manifestBytes),
      updatedAt: new Date(authorized.domain.state.updatedAt),
    });
    authorized = await replaceDelegatedRecoveryState(
      binding,
      options,
      authorized.domain.stateBytes,
      finalizingStateBytes,
    );
    await hooks.afterFinalizing?.();
  }

  if (authorized.domain.state.phase !== 'finalizing' || !authorized.domain.finalManifestBytes) {
    throw recoveryInvalid('delegated finalization did not reach finalizing');
  }
  acceptance = await evaluateOrQuarantine(binding, options, authorized, now);
  manifestBytes = expectedDelegatedManifestBytes(authorized, acceptance);
  if (!authorized.domain.finalManifestBytes.equals(manifestBytes)) {
    await installDelegatedIntegrityQuarantine(
      binding,
      options,
      authorized,
      now,
      recoveryInvalid('delegated candidate changed after manifest installation'),
      manifestBytes,
    );
  }
  if (authorized.domain.state.finalManifestDigest !== digestBytes(manifestBytes)) {
    throw recoveryInvalid('delegated finalizing state does not bind the exact manifest');
  }

  await hooks.beforeFinalRename?.();
  const finalAuthority = await readAuthorizedDelegatedRecovery(
    binding,
    options,
    authorized.domain.stateBytes,
    manifestBytes,
  );
  const finalAcceptance = await evaluateOrQuarantine(binding, options, finalAuthority, now);
  const recomputedManifest = expectedDelegatedManifestBytes(finalAuthority, finalAcceptance);
  if (!recomputedManifest.equals(manifestBytes)) {
    await installDelegatedIntegrityQuarantine(
      binding,
      options,
      finalAuthority,
      now,
      recoveryInvalid('delegated candidate changed before archive commit'),
      manifestBytes,
    );
  }
  const completion = delegatedCompletion(finalAuthority, manifestBytes, finalAcceptance);
  await moveDirectoryNoReplace(
    activeLeasePath(finalAuthority.context.records.workspace),
    completion.archivePath,
    { commitCheck: options.finalRenameCommitCheck },
  );

  // The successful lease rename is the final workspace write.
  return completion;
}

export async function finalizeDelegatedRecovery(
  handle: RecoveryAttemptHandle,
): Promise<DelegatedRecoveryCompletion> {
  const system = captureExactCurrentIdentityAuthority();
  return await finalizeDelegatedRecoveryControlled(handle, {
    attemptIdentity: system.identity,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

export async function verifyDelegatedRecoveryArchive(
  options: VerifyDelegatedRecoveryArchiveOptions,
): Promise<DelegatedRecoveryCompletion> {
  const records = await readReadyWorkspaceRecords(options.workspacePath);
  if ((await readActiveLeaseOwner(records)) !== undefined) {
    throw recoveryInvalid('active lease still exists; delegated archive is not the ready fact');
  }
  const archivePath = resolveWorkspaceRelativePath(records.workspace.path, options.targetArchive);
  const ownerBytes = await readExactFile(join(archivePath, OWNER_FILE));
  const sourceOwner = parseJsonRecord(ownerBytes, parseOwnerRecord);
  validateCoreRecordBindings({
    marker: records.marker,
    protocol: records.protocol,
    owner: sourceOwner,
    protocolBytes: records.protocolBytes,
    canonicalWorkspaceIdentity: records.workspace.identity,
  });
  const recoveryPath = join(archivePath, RECOVERY_DIR);
  const domain = await readRecoveryDomainAtPath(records, sourceOwner, recoveryPath);
  if (domain.claim.mode !== 'delegated-finalize' || !domain.claim.delegatedOperation) {
    throw recoveryInvalid('archive is not a delegated-finalize recovery');
  }
  if (domain.claim.targetArchive !== options.targetArchive) {
    throw recoveryInvalid('archive path does not match its immutable delegated claim');
  }
  if (
    domain.state.phase !== 'finalizing' ||
    !domain.finalManifestBytes ||
    !domain.finalManifest ||
    domain.linkedFinalManifestSource
  ) {
    throw recoveryInvalid('archive does not contain a complete delegated finalizing fact');
  }
  const context: RecoveryContext = { records, sourceOwner, recoveryPath };
  const snapshot = await readStableDelegatedOperation(
    context,
    domain.claim.delegatedOperation,
    domain,
  );
  if (snapshot.location !== 'settled') {
    throw recoveryInvalid('delegated archive does not contain its settled operation');
  }
  if (snapshot.quarantine?.reason === 'workspace-integrity-violation') {
    throw recoveryInvalid('delegated archive contains a terminal integrity quarantine');
  }
  if (
    snapshot.quarantine?.reason === 'containment-unconfirmed' &&
    domain.claim.rebootProof === null
  ) {
    throw recoveryInvalid('containment archive is missing its same-host reboot proof');
  }
  const sourceSnapshotDigest = await captureRecoverySourceAtLeasePath(records, archivePath);
  if (domain.finalManifest.finalSourceSnapshotDigest !== sourceSnapshotDigest) {
    throw recoveryInvalid('delegated archive source does not match its final manifest');
  }
  let acceptance: DelegatedDeltaAcceptance;
  try {
    acceptance = evaluateDelegatedRecoveryDelta(records.workspace.path, snapshot);
  } catch (error) {
    throw recoveryInvalid('delegated archive semantic delta is no longer acceptable', error);
  }
  const authorized: AuthorizedDelegatedRecovery = {
    context,
    domain,
    snapshot,
    sourceSnapshotDigest,
  };
  const expectedManifest = expectedDelegatedManifestBytes(authorized, acceptance);
  if (!domain.finalManifestBytes.equals(expectedManifest)) {
    throw recoveryInvalid('delegated archive final manifest is not deterministic');
  }
  if (domain.finalManifest.delegatedCandidateDigest !== acceptance.candidateDigest) {
    throw recoveryInvalid('delegated archive candidate digest does not match semantic output');
  }
  return delegatedCompletion(authorized, expectedManifest, acceptance);
}
