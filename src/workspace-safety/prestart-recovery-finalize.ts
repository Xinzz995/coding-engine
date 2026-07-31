import { randomUUID } from 'node:crypto';
import { unlink } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateDelegatedDelta } from './baseline.js';
import {
  assertExactFile,
  createStagingDirectory,
  digestBytes,
  installFileNoReplace,
  moveDirectoryNoReplace,
  recoverLinkedFileInstall,
  replaceFileFromStaging,
  resolveWorkspaceRelativePath,
  writeNewFile,
} from './filesystem.js';
import { readFixedPlatformHelperBundle } from './fixed-platform-helper.js';
import { captureExactCurrentIdentityAuthority, createIdentityProbe } from './identity.js';
import {
  PRESTART_ABORT_FILE,
  SETTLED_OPERATIONS_DIR,
  assertOrdinaryDirectory,
  recoverOperationInstalledFact,
} from './operation-records.js';
import type { RecoveryAttemptHandle } from './recovery-attempt.js';
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
  type PrestartRecoveryOperationBinding,
  type RecoveryAttemptOwner,
} from './recovery-records.js';
import {
  captureRecoverySourceFromRecords,
  createSourceOwnerProbe,
  requireDeadSourceOwner,
} from './recovery-source-snapshot.js';
import {
  createQuarantineRecordBytes,
  installQuarantineNoReplace,
  upgradeContainmentQuarantine,
} from './quarantine.js';
import {
  activeLeasePath,
  assertClaimBinding,
  assertLeaseShape,
  deterministicSettledPath,
  expectedAbortBytes,
  originalSourceDigest,
  readStableSnapshot,
  sameSnapshot,
  type PrestartOperationSnapshot,
  type PrestartRecoveryProbeOptions,
} from './prestart-recovery.js';
import { RECOVERY_DIR, type ProcessIdentitySnapshot, WorkspaceSafetyError } from './types.js';

export interface PrestartRecoveryFinalizationHooks {
  readonly beforeAbortSourceUnlink?: () => void | Promise<void>;
  readonly beforeAbortInstallSourceUnlink?: () => void | Promise<void>;
  readonly afterAbortInstalled?: () => void | Promise<void>;
  readonly beforeOperationSettle?: (targetPath: string) => void | Promise<void>;
  readonly afterOperationSettled?: (settledPath: string) => void | Promise<void>;
  readonly afterVerified?: () => void | Promise<void>;
  readonly beforeFinalManifestSourceUnlink?: () => void | Promise<void>;
  readonly afterFinalManifestInstalled?: () => void | Promise<void>;
  readonly afterFinalizing?: () => void | Promise<void>;
  readonly beforeFinalRename?: () => void | Promise<void>;
}

export interface ControlledFinalizePrestartRecoveryOptions extends PrestartRecoveryProbeOptions {
  readonly now?: () => Date;
  /** Exact test/coordinator identity; omitted callers keep the real platform read. */
  readonly attemptIdentity?: ProcessIdentitySnapshot;
  readonly hooks?: PrestartRecoveryFinalizationHooks;
  readonly finalRenameCommitCheck?: () => void;
}

export type FinalizePrestartRecoveryOptions = undefined;

export interface PrestartRecoveryCompletion {
  readonly workspacePath: string;
  readonly targetArchive: string;
  readonly archivePath: string;
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly finalManifestDigest: string;
  readonly settledOperationPath: string;
}

interface PrestartAttemptBinding {
  readonly workspacePath: string;
  readonly claimBytes: Buffer;
  readonly attemptOwnerBytes: Buffer;
  readonly processIdentity: ProcessIdentitySnapshot;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

interface AuthorizedPrestartRecovery {
  readonly context: Awaited<ReturnType<typeof loadRecoveryContext>>;
  readonly domain: RecoveryDomain;
  readonly snapshot: PrestartOperationSnapshot;
  readonly finalSourceSnapshotDigest?: string;
}

function invalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('invalid', `Invalid prestart recovery: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function isolated(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('isolated', `Prestart recovery is isolated: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
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
    throw new WorkspaceSafetyError('lease-lost', 'prestart recovery attempt identity changed');
  }
}

function createAttemptBinding(
  domain: RecoveryDomain,
  attemptIdentity?: ProcessIdentitySnapshot,
  verifySystemAuthority?: () => void | Promise<void>,
): PrestartAttemptBinding {
  if (!domain.attemptOwnerBytes) throw recoveryInvalid('prestart finalization needs an attempt');
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

function assertAttemptBinding(
  binding: PrestartAttemptBinding,
  domain: RecoveryDomain,
  expectedStateBytes?: Buffer,
  expectedManifestBytes?: Buffer,
): PrestartRecoveryOperationBinding {
  if (domain.claim.mode !== 'mechanical-empty' || !domain.claim.prestartOperation) {
    throw new WorkspaceSafetyError('unsupported', 'claim is not prestart mechanical recovery');
  }
  if (!domain.claimBytes.equals(binding.claimBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'prestart recovery claim changed');
  }
  if (!domain.attemptOwnerBytes?.equals(binding.attemptOwnerBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'prestart recovery attempt changed');
  }
  requireCurrentAttemptOwner(domain.attemptOwner, binding.processIdentity);
  if (expectedStateBytes && !domain.stateBytes.equals(expectedStateBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'prestart recovery state changed');
  }
  if (expectedManifestBytes && !domain.finalManifestBytes?.equals(expectedManifestBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'prestart final manifest changed');
  }
  return domain.claim.prestartOperation;
}

async function readAuthorized(
  attempt: PrestartAttemptBinding,
  probes: PrestartRecoveryProbeOptions,
  expectedStateBytes?: Buffer,
  expectedManifestBytes?: Buffer,
): Promise<AuthorizedPrestartRecovery> {
  await attempt.verifySystemAuthority?.();
  const context = await loadRecoveryContext(attempt.workspacePath);
  const domain = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  const claimBinding = assertAttemptBinding(
    attempt,
    domain,
    expectedStateBytes,
    expectedManifestBytes,
  );
  requireDeadSourceOwner(context.sourceOwner, createSourceOwnerProbe(probes.probeSourceOwner));
  await assertLeaseShape(context);
  const snapshot = await readStableSnapshot(context, claimBinding, domain);
  assertClaimBinding(context, domain, claimBinding, snapshot, probes);
  const reconstructed = await originalSourceDigest(context, snapshot, claimBinding);
  if (reconstructed !== domain.claim.sourceSnapshotDigest) {
    throw invalid('prestart source no longer reconstructs the immutable claim');
  }
  if (snapshot.location === 'active' && domain.state.phase !== 'claimed') {
    throw invalid('advanced recovery state still has active prestart operation');
  }
  const finalSourceSnapshotDigest =
    snapshot.location === 'settled'
      ? await captureRecoverySourceFromRecords(context.records)
      : undefined;
  if (
    domain.finalManifest &&
    domain.finalManifest.finalSourceSnapshotDigest !== finalSourceSnapshotDigest
  ) {
    throw invalid('prestart final manifest no longer matches settled source');
  }
  return { context, domain, snapshot, finalSourceSnapshotDigest };
}

async function installOrRecoverAbort(
  attempt: PrestartAttemptBinding,
  probes: PrestartRecoveryProbeOptions,
  authorized: AuthorizedPrestartRecovery,
  hooks: PrestartRecoveryFinalizationHooks,
): Promise<AuthorizedPrestartRecovery> {
  if (authorized.snapshot.location !== 'active') return authorized;
  const expected =
    authorized.domain.claim.prestartOperation?.existingAbortDigest === null
      ? expectedAbortBytes(authorized.domain, authorized.snapshot)
      : authorized.snapshot.abortBytes;
  if (!expected) throw invalid('claim expected an existing abort that is now missing');
  if (authorized.snapshot.abortBytes) {
    if (!authorized.snapshot.abortBytes.equals(expected)) throw invalid('abort bytes changed');
    if (authorized.snapshot.linkedAbortSource) {
      const source = authorized.snapshot.linkedAbortSource;
      await recoverOperationInstalledFact({
        source,
        target: join(authorized.snapshot.operationPath, PRESTART_ABORT_FILE),
        expectedBytes: expected,
        beforeSourceUnlink: hooks.beforeAbortSourceUnlink,
        authorize: async () => {
          const current = await readAuthorized(attempt, probes, authorized.domain.stateBytes);
          if (current.snapshot.linkedAbortSource !== source) {
            throw new WorkspaceSafetyError('lease-lost', 'controlled abort link pair changed');
          }
        },
      });
    }
  } else {
    const staging =
      authorized.snapshot.inertAbortSources[0]?.path ??
      join(authorized.snapshot.operationPath, `prestart-abort.prepare-${randomUUID()}.json`);
    if (authorized.snapshot.inertAbortSources.length === 0) {
      await writeNewFile(staging, expected);
      await assertExactFile(staging, expected);
    }
    const commit = await readAuthorized(attempt, probes, authorized.domain.stateBytes);
    if (commit.snapshot.abortBytes) {
      throw new WorkspaceSafetyError('conflict', 'prestart abort appeared during installation');
    }
    await installFileNoReplace(staging, join(commit.snapshot.operationPath, PRESTART_ABORT_FILE), {
      beforeSourceUnlink: hooks.beforeAbortInstallSourceUnlink,
    });
    await hooks.afterAbortInstalled?.();
  }
  let installed = await readAuthorized(attempt, probes, authorized.domain.stateBytes);
  if (!installed.snapshot.abortBytes?.equals(expected) || installed.snapshot.linkedAbortSource) {
    throw invalid('prestart abort did not become one exact canonical fact');
  }
  for (const inert of installed.snapshot.inertAbortSources) {
    const commit = await readAuthorized(attempt, probes, authorized.domain.stateBytes);
    const exact = commit.snapshot.inertAbortSources.find((entry) => entry.path === inert.path);
    if (!exact?.bytes.equals(expected)) {
      throw new WorkspaceSafetyError('lease-lost', 'orphan abort staging changed before cleanup');
    }
    await unlink(inert.path);
  }
  installed = await readAuthorized(attempt, probes, authorized.domain.stateBytes);
  if (installed.snapshot.inertAbortSources.length !== 0) {
    throw invalid('prestart abort staging cleanup did not become stable');
  }
  return installed;
}

async function installIntegrityQuarantine(
  attempt: PrestartAttemptBinding,
  probes: PrestartRecoveryProbeOptions,
  authorized: AuthorizedPrestartRecovery,
  now: () => Date,
  cause?: unknown,
): Promise<never> {
  const attemptOwner = authorized.domain.attemptOwner;
  const attemptBytes = authorized.domain.attemptOwnerBytes;
  if (!attemptOwner || !attemptBytes) throw invalid('quarantine requires recovery attempt');
  const bytes = createQuarantineRecordBytes({
    ownerId: authorized.context.sourceOwner.ownerId,
    operationId: authorized.snapshot.active.operationId,
    activeChildDigest: digestBytes(authorized.snapshot.activeBytes),
    delegatedBaselineDigest: digestBytes(authorized.snapshot.baselineBytes),
    creator: {
      kind: 'recovery-attempt',
      id: attemptOwner.attemptId,
      recordDigest: digestBytes(attemptBytes),
    },
    reason: 'workspace-integrity-violation',
    priorQuarantineDigest: authorized.snapshot.quarantineBytes
      ? digestBytes(authorized.snapshot.quarantineBytes)
      : null,
    createdAt: now(),
  });
  const installOptions = {
    containerPath: authorized.snapshot.operationPath,
    recordBytes: bytes,
    verifyAuthority: async () => {
      const current = await readAuthorized(attempt, probes, authorized.domain.stateBytes);
      if (!sameSnapshot(current.snapshot, authorized.snapshot)) {
        throw new WorkspaceSafetyError('lease-lost', 'operation changed before quarantine');
      }
    },
  };
  if (authorized.snapshot.quarantineBytes) {
    await upgradeContainmentQuarantine({
      ...installOptions,
      priorBytes: authorized.snapshot.quarantineBytes,
    });
  } else {
    await installQuarantineNoReplace(installOptions);
  }
  throw isolated('workspace-integrity-violation', cause);
}

async function requireUnchangedOrQuarantine(
  attempt: PrestartAttemptBinding,
  probes: PrestartRecoveryProbeOptions,
  authorized: AuthorizedPrestartRecovery,
  now: () => Date,
): Promise<void> {
  try {
    const delta = evaluateDelegatedDelta(
      authorized.context.records.workspace.path,
      authorized.snapshot.baseline,
      { requireUnchanged: true },
    );
    if (!delta.accepted) throw invalid('delegated baseline changed');
  } catch (error) {
    await installIntegrityQuarantine(attempt, probes, authorized, now, error);
  }
}

async function settleOperation(
  attempt: PrestartAttemptBinding,
  probes: PrestartRecoveryProbeOptions,
  authorized: AuthorizedPrestartRecovery,
  now: () => Date,
  hooks: PrestartRecoveryFinalizationHooks,
): Promise<AuthorizedPrestartRecovery> {
  if (authorized.snapshot.location === 'settled') {
    await requireUnchangedOrQuarantine(attempt, probes, authorized, now);
    return authorized;
  }
  await requireUnchangedOrQuarantine(attempt, probes, authorized, now);
  const settledRoot = join(
    activeLeasePath(authorized.context.records.workspace),
    SETTLED_OPERATIONS_DIR,
  );
  await assertOrdinaryDirectory(settledRoot, SETTLED_OPERATIONS_DIR);
  const target = deterministicSettledPath(authorized.context, authorized.snapshot);
  await hooks.beforeOperationSettle?.(target);
  const commit = await readAuthorized(attempt, probes, authorized.domain.stateBytes);
  if (commit.snapshot.location !== 'active') {
    throw new WorkspaceSafetyError('conflict', 'prestart operation settled by another writer');
  }
  await requireUnchangedOrQuarantine(attempt, probes, commit, now);
  await moveDirectoryNoReplace(commit.snapshot.operationPath, target);
  await hooks.afterOperationSettled?.(target);
  const settled = await readAuthorized(attempt, probes, commit.domain.stateBytes);
  if (settled.snapshot.location !== 'settled') {
    throw invalid('prestart operation settlement did not become canonical');
  }
  return settled;
}

async function stageRecoveryFile(
  authorized: AuthorizedPrestartRecovery,
  name: string,
  bytes: Buffer,
): Promise<string> {
  const staging = await createStagingDirectory(
    activeLeasePath(authorized.context.records.workspace),
    'recovery.prepare-',
    randomUUID(),
  );
  const path = join(staging, name);
  await writeNewFile(path, bytes);
  await assertExactFile(path, bytes);
  return path;
}

async function replaceState(
  attempt: PrestartAttemptBinding,
  probes: PrestartRecoveryProbeOptions,
  previousStateBytes: Buffer,
  nextStateBytes: Buffer,
): Promise<AuthorizedPrestartRecovery> {
  const before = await readAuthorized(attempt, probes, previousStateBytes);
  const staging = await stageRecoveryFile(before, RECOVERY_STATE_FILE, nextStateBytes);
  const commit = await readAuthorized(attempt, probes, previousStateBytes);
  await replaceFileFromStaging(
    staging,
    join(activeLeasePath(commit.context.records.workspace), RECOVERY_DIR, RECOVERY_STATE_FILE),
  );
  return await readAuthorized(attempt, probes, nextStateBytes);
}

function expectedManifestBytes(authorized: AuthorizedPrestartRecovery): Buffer {
  if (!authorized.finalSourceSnapshotDigest) throw invalid('final source digest is unavailable');
  return createRecoveryFinalManifestBytes({
    recoveryId: authorized.domain.claim.recoveryId,
    claimDigest: digestBytes(authorized.domain.claimBytes),
    workspaceMarkerDigest: digestBytes(authorized.context.records.markerBytes),
    protocolDigest: digestBytes(authorized.context.records.protocolBytes),
    finalSourceSnapshotDigest: authorized.finalSourceSnapshotDigest,
    mutationSnapshotDigest: null,
    delegatedCandidateDigest: null,
    createdAt: new Date(authorized.domain.state.updatedAt),
  });
}

async function installFinalManifest(
  attempt: PrestartAttemptBinding,
  probes: PrestartRecoveryProbeOptions,
  stateBytes: Buffer,
  manifestBytes: Buffer,
  beforeSourceUnlink?: () => void | Promise<void>,
): Promise<AuthorizedPrestartRecovery> {
  const before = await readAuthorized(attempt, probes, stateBytes);
  if (before.domain.finalManifestBytes) {
    if (!before.domain.finalManifestBytes.equals(manifestBytes)) {
      throw invalid('prestart final manifest conflicts with expected bytes');
    }
    if (before.domain.linkedFinalManifestSource) {
      const source = before.domain.linkedFinalManifestSource;
      await recoverLinkedFileInstall({
        source,
        target: join(
          activeLeasePath(before.context.records.workspace),
          RECOVERY_DIR,
          RECOVERY_FINAL_MANIFEST_FILE,
        ),
        expectedBytes: manifestBytes,
        beforeSourceUnlink,
        authorize: async () => {
          const current = await readAuthorized(attempt, probes, stateBytes);
          if (current.domain.linkedFinalManifestSource !== source) {
            throw new WorkspaceSafetyError('lease-lost', 'final manifest link pair changed');
          }
        },
      });
      return await readAuthorized(attempt, probes, stateBytes, manifestBytes);
    }
    return before;
  }
  const staging = await stageRecoveryFile(before, RECOVERY_FINAL_MANIFEST_FILE, manifestBytes);
  const commit = await readAuthorized(attempt, probes, stateBytes);
  if (commit.domain.finalManifestBytes) {
    throw new WorkspaceSafetyError('conflict', 'prestart final manifest appeared');
  }
  await installFileNoReplace(
    staging,
    join(
      activeLeasePath(commit.context.records.workspace),
      RECOVERY_DIR,
      RECOVERY_FINAL_MANIFEST_FILE,
    ),
    { beforeSourceUnlink },
  );
  return await readAuthorized(attempt, probes, stateBytes, manifestBytes);
}

function completion(
  authorized: AuthorizedPrestartRecovery,
  manifestBytes: Buffer,
): PrestartRecoveryCompletion {
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
    settledOperationPath: authorized.snapshot.operationPath,
  };
}

/** @internal Authority-controlled core. */
export async function finalizePrestartRecoveryControlled(
  handle: RecoveryAttemptHandle,
  options: ControlledFinalizePrestartRecoveryOptions,
): Promise<PrestartRecoveryCompletion> {
  const initial = await handle.verify();
  if (initial.claim.mode !== 'mechanical-empty' || !initial.claim.prestartOperation) {
    throw new WorkspaceSafetyError('unsupported', 'claim is not prestart mechanical recovery');
  }
  const attempt = createAttemptBinding(
    initial,
    options.attemptIdentity,
    options.verifySystemAuthority,
  );
  const now = options.now ?? (() => new Date());
  const hooks = options.hooks ?? {};
  let authorized = await readAuthorized(
    attempt,
    options,
    initial.stateBytes,
    initial.finalManifestBytes,
  );

  if (authorized.domain.state.phase === 'claimed') {
    authorized = await installOrRecoverAbort(attempt, options, authorized, hooks);
    authorized = await settleOperation(attempt, options, authorized, now, hooks);
    const verifiedState = createRecoveryStateBytes({
      recoveryId: authorized.domain.claim.recoveryId,
      claimDigest: digestBytes(authorized.domain.claimBytes),
      phase: 'verified',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: null,
      updatedAt: now(),
    });
    authorized = await replaceState(attempt, options, authorized.domain.stateBytes, verifiedState);
    await hooks.afterVerified?.();
  } else if (authorized.snapshot.location !== 'settled') {
    throw invalid('advanced prestart recovery has not settled its operation');
  }

  let manifestBytes: Buffer;
  if (authorized.domain.state.phase === 'verified') {
    manifestBytes = expectedManifestBytes(authorized);
    const alreadyInstalled = authorized.domain.finalManifestBytes !== undefined;
    authorized = await installFinalManifest(
      attempt,
      options,
      authorized.domain.stateBytes,
      manifestBytes,
      hooks.beforeFinalManifestSourceUnlink,
    );
    if (!alreadyInstalled) await hooks.afterFinalManifestInstalled?.();
    const finalizingState = createRecoveryStateBytes({
      recoveryId: authorized.domain.claim.recoveryId,
      claimDigest: digestBytes(authorized.domain.claimBytes),
      phase: 'finalizing',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: digestBytes(manifestBytes),
      updatedAt: new Date(authorized.domain.state.updatedAt),
    });
    authorized = await replaceState(
      attempt,
      options,
      authorized.domain.stateBytes,
      finalizingState,
    );
    await hooks.afterFinalizing?.();
  }
  if (authorized.domain.state.phase !== 'finalizing' || !authorized.domain.finalManifestBytes) {
    throw invalid('prestart recovery did not reach finalizing');
  }
  manifestBytes = expectedManifestBytes(authorized);
  if (!authorized.domain.finalManifestBytes.equals(manifestBytes)) {
    throw invalid('prestart final manifest is stale');
  }
  await hooks.beforeFinalRename?.();
  const finalAuthority = await readAuthorized(
    attempt,
    options,
    authorized.domain.stateBytes,
    manifestBytes,
  );
  const result = completion(finalAuthority, manifestBytes);
  await moveDirectoryNoReplace(
    activeLeasePath(finalAuthority.context.records.workspace),
    result.archivePath,
    { commitCheck: options.finalRenameCommitCheck },
  );
  return result;
}

export async function finalizePrestartRecovery(
  handle: RecoveryAttemptHandle,
): Promise<PrestartRecoveryCompletion> {
  const system = captureExactCurrentIdentityAuthority();
  return await finalizePrestartRecoveryControlled(handle, {
    attemptIdentity: system.identity,
    helperBytes: readFixedPlatformHelperBundle(),
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}
