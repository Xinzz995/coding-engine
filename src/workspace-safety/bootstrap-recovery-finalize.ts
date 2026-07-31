import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import {
  assertExactFile,
  createStagingDirectory,
  digestBytes,
  installFileNoReplace,
  jsonBytes,
  moveDirectoryNoReplace,
  pathExists,
  readExactFile,
  recoverLinkedFileInstall,
  replaceFileFromStaging,
  resolveWorkspaceRelativePath,
  writeNewFile,
} from './filesystem.js';
import { captureExactCurrentIdentityAuthority, createIdentityProbe } from './identity.js';
import { readReadyWorkspaceRecords } from './lease.js';
import {
  RECOVERY_FINAL_MANIFEST_FILE,
  RECOVERY_STATE_FILE,
  createRecoveryFinalManifestBytes,
  createRecoveryStateBytes,
  recoveryInvalid,
  type RecoveryAttemptOwner,
} from './recovery-records.js';
import { parseJsonRecord, parseOwnerRecord, validateCoreRecordBindings } from './schema.js';
import {
  BootstrapRecoveryAttemptHandle,
  asBootstrapSourceOwnerProbe,
  assertBootstrapOrdinaryDirectory,
  bootstrapRecoveryConflict,
  captureBootstrapSource,
  expectedBootstrapMarker,
  inspectBootstrapMarkerInstall,
  readBootstrapRecoveryDomainAtPath,
  readStableBootstrapSource,
  requireDeadBootstrapSourceOwner,
  type BootstrapRecords,
  type BootstrapRecoveryDomain,
} from './bootstrap-recovery.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  WORKSPACE_MARKER_FILE,
  type IdentityVerdict,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  WorkspaceSafetyError,
} from './types.js';

const RECOVERY_STAGING = /^recovery\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

interface AuthorizedBootstrapRecovery {
  readonly records: BootstrapRecords;
  readonly domain: BootstrapRecoveryDomain;
  readonly sourceSnapshotDigest: string;
}

interface BootstrapAuthorityBinding {
  readonly workspacePath: string;
  readonly claimBytes: Buffer;
  readonly attemptOwnerBytes: Buffer;
  readonly processIdentity: ProcessIdentitySnapshot;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

export interface BootstrapRecoveryFinalizationHooks {
  readonly beforeMarkerInstall?: () => void | Promise<void>;
  readonly beforeMarkerSourceUnlink?: () => void | Promise<void>;
  readonly afterMarkerInstalled?: () => void | Promise<void>;
  readonly afterVerified?: () => void | Promise<void>;
  readonly beforeFinalManifestSourceUnlink?: () => void | Promise<void>;
  readonly afterFinalManifestInstalled?: () => void | Promise<void>;
  readonly afterFinalizing?: () => void | Promise<void>;
  readonly beforeFinalRename?: () => void | Promise<void>;
}

export interface ControlledFinalizeBootstrapRecoveryOptions {
  readonly now?: () => Date;
  /** Exact test/coordinator identity; omitted callers keep the real platform read. */
  readonly attemptIdentity?: ProcessIdentitySnapshot;
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly hooks?: BootstrapRecoveryFinalizationHooks;
  readonly finalRenameCommitCheck?: () => void;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal finalization has no caller-controlled clock, callbacks, or commit barrier. */
export type FinalizeBootstrapRecoveryOptions = undefined;

export interface BootstrapRecoveryCompletion {
  readonly workspacePath: string;
  readonly targetArchive: string;
  readonly archivePath: string;
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly finalManifestDigest: string;
}

function requireCurrentAttemptOwner(
  owner: RecoveryAttemptOwner | undefined,
  current: ProcessIdentitySnapshot,
): void {
  if (
    !owner ||
    owner.pid !== current.pid ||
    owner.bootIdentity !== current.bootIdentity ||
    owner.hostId !== current.hostId ||
    owner.processIdentity.kind !== current.processIdentity.kind ||
    owner.processIdentity.value !== current.processIdentity.value
  ) {
    throw new WorkspaceSafetyError('lease-lost', 'bootstrap recovery attempt owner changed');
  }
}

async function readAuthorized(
  binding: BootstrapAuthorityBinding,
  probeSourceOwner: (owner: OwnerRecord) => IdentityVerdict,
  expectedStateBytes?: Buffer,
  expectedManifestBytes?: Buffer,
): Promise<AuthorizedBootstrapRecovery> {
  await binding.verifySystemAuthority?.();
  const source = await readStableBootstrapSource(binding.workspacePath);
  const domain = await readBootstrapRecoveryDomainAtPath(
    source.records,
    source.records.recoveryPath,
  );
  if (!domain.claimBytes.equals(binding.claimBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'bootstrap recovery claim changed');
  }
  if (!domain.attemptOwnerBytes?.equals(binding.attemptOwnerBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'bootstrap recovery attempt changed');
  }
  requireCurrentAttemptOwner(domain.attemptOwner, binding.processIdentity);
  if (expectedStateBytes && !domain.stateBytes.equals(expectedStateBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'bootstrap recovery state changed');
  }
  if (expectedManifestBytes && !domain.finalManifestBytes?.equals(expectedManifestBytes)) {
    throw new WorkspaceSafetyError('lease-lost', 'bootstrap recovery manifest changed');
  }
  requireDeadBootstrapSourceOwner(source.records.owner, probeSourceOwner);
  if (source.digest !== domain.claim.sourceSnapshotDigest) {
    throw bootstrapRecoveryConflict('bootstrap source no longer matches the immutable claim');
  }
  return { records: source.records, domain, sourceSnapshotDigest: source.digest };
}

async function stageRecoveryFile(
  records: BootstrapRecords,
  fileName: string,
  bytes: Buffer,
): Promise<string> {
  const staging = await createStagingDirectory(
    records.activeLeasePath,
    'recovery.prepare-',
    randomUUID(),
  );
  const filePath = join(staging, fileName);
  await writeNewFile(filePath, bytes);
  await assertExactFile(filePath, bytes);
  return filePath;
}

async function replaceState(
  binding: BootstrapAuthorityBinding,
  probe: (owner: OwnerRecord) => IdentityVerdict,
  previous: Buffer,
  next: Buffer,
): Promise<AuthorizedBootstrapRecovery> {
  const before = await readAuthorized(binding, probe, previous);
  const staged = await stageRecoveryFile(before.records, RECOVERY_STATE_FILE, next);
  const commit = await readAuthorized(binding, probe, previous);
  await replaceFileFromStaging(staged, join(commit.records.recoveryPath, RECOVERY_STATE_FILE));
  return await readAuthorized(binding, probe, next);
}

async function installManifest(
  binding: BootstrapAuthorityBinding,
  probe: (owner: OwnerRecord) => IdentityVerdict,
  stateBytes: Buffer,
  manifestBytes: Buffer,
  beforeSourceUnlink?: () => void | Promise<void>,
): Promise<AuthorizedBootstrapRecovery> {
  const before = await readAuthorized(binding, probe, stateBytes);
  if (before.domain.finalManifestBytes) {
    if (!before.domain.finalManifestBytes.equals(manifestBytes)) {
      throw recoveryInvalid('verified bootstrap recovery has a conflicting manifest');
    }
    if (before.domain.linkedFinalManifestSource) {
      const linkedSource = before.domain.linkedFinalManifestSource;
      await recoverLinkedFileInstall({
        source: linkedSource,
        target: join(before.records.recoveryPath, RECOVERY_FINAL_MANIFEST_FILE),
        expectedBytes: manifestBytes,
        authorize: async () => {
          const current = await readAuthorized(binding, probe, stateBytes);
          if (current.domain.linkedFinalManifestSource !== linkedSource) {
            throw new WorkspaceSafetyError(
              'lease-lost',
              'controlled bootstrap final-manifest install pair changed',
            );
          }
        },
      });
      return await readAuthorized(binding, probe, stateBytes, manifestBytes);
    }
    return before;
  }
  const staged = await stageRecoveryFile(
    before.records,
    RECOVERY_FINAL_MANIFEST_FILE,
    manifestBytes,
  );
  const commit = await readAuthorized(binding, probe, stateBytes);
  if (commit.domain.finalManifestBytes) {
    throw bootstrapRecoveryConflict('final manifest appeared concurrently');
  }
  await installFileNoReplace(
    staged,
    join(commit.records.recoveryPath, RECOVERY_FINAL_MANIFEST_FILE),
    { beforeSourceUnlink },
  );
  return await readAuthorized(binding, probe, stateBytes, manifestBytes);
}

function manifestBytes(authorized: AuthorizedBootstrapRecovery): Buffer {
  return createRecoveryFinalManifestBytes({
    recoveryId: authorized.domain.claim.recoveryId,
    claimDigest: digestBytes(authorized.domain.claimBytes),
    workspaceMarkerDigest: digestBytes(authorized.records.expectedMarkerBytes),
    protocolDigest: digestBytes(authorized.records.protocolBytes),
    finalSourceSnapshotDigest: authorized.sourceSnapshotDigest,
    mutationSnapshotDigest: null,
    createdAt: new Date(authorized.domain.state.updatedAt),
  });
}

function completion(
  records: BootstrapRecords,
  domain: BootstrapRecoveryDomain,
  manifest: Buffer,
): BootstrapRecoveryCompletion {
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
    finalManifestDigest: digestBytes(manifest),
  };
}

/** @internal Authority-controlled core. */
export async function finalizeBootstrapRecoveryControlled(
  handle: BootstrapRecoveryAttemptHandle,
  options: ControlledFinalizeBootstrapRecoveryOptions = {},
): Promise<BootstrapRecoveryCompletion> {
  await handle.verify();
  const handleBinding = handle.binding();
  const binding: BootstrapAuthorityBinding = {
    workspacePath: handle.workspacePath,
    claimBytes: handleBinding.claimBytes,
    attemptOwnerBytes: handleBinding.attemptOwnerBytes,
    processIdentity: options.attemptIdentity ?? createIdentityProbe().current(),
    verifySystemAuthority: options.verifySystemAuthority,
  };
  const probe = asBootstrapSourceOwnerProbe(options.probeSourceOwner);
  const now = options.now ?? (() => new Date());
  let authorized = await readAuthorized(binding, probe, handleBinding.stateBytes);

  if (authorized.domain.state.phase === 'claimed') {
    if (authorized.domain.finalManifestBytes) {
      throw recoveryInvalid('claimed bootstrap recovery cannot contain a manifest');
    }
    if (authorized.records.markerState === 'linked-incomplete') {
      const linkedMarkerSource = authorized.records.linkedMarkerSource;
      if (!linkedMarkerSource) {
        throw recoveryInvalid('linked bootstrap marker is missing its controlled source path');
      }
      await recoverLinkedFileInstall({
        source: linkedMarkerSource,
        target: join(authorized.records.workspace.path, WORKSPACE_MARKER_FILE),
        expectedBytes: authorized.records.expectedMarkerBytes,
        authorize: async () => {
          const current = await readAuthorized(binding, probe, authorized.domain.stateBytes);
          if (
            current.records.markerState !== 'linked-incomplete' ||
            current.records.linkedMarkerSource !== linkedMarkerSource
          ) {
            throw new WorkspaceSafetyError(
              'lease-lost',
              'controlled bootstrap marker install pair changed',
            );
          }
        },
      });
      authorized = await readAuthorized(binding, probe, authorized.domain.stateBytes);
      if (authorized.records.markerState !== 'complete') {
        throw recoveryInvalid('controlled marker install cleanup did not reach one exact file');
      }
    }
    if (authorized.records.markerState === 'missing') {
      const stagedMarker = await stageRecoveryFile(
        authorized.records,
        WORKSPACE_MARKER_FILE,
        authorized.records.expectedMarkerBytes,
      );
      await options.hooks?.beforeMarkerInstall?.();
      const commit = await readAuthorized(binding, probe, authorized.domain.stateBytes);
      if (commit.records.markerState !== 'missing') {
        throw bootstrapRecoveryConflict('workspace marker appeared before no-replace installation');
      }
      await installFileNoReplace(
        stagedMarker,
        join(commit.records.workspace.path, WORKSPACE_MARKER_FILE),
        { beforeSourceUnlink: options.hooks?.beforeMarkerSourceUnlink },
      );
      authorized = await readAuthorized(binding, probe, authorized.domain.stateBytes);
      if (authorized.records.markerState !== 'complete') {
        throw recoveryInvalid('BootstrapRecoveryWriter did not install the exact marker');
      }
      await options.hooks?.afterMarkerInstalled?.();
    } else if (authorized.records.markerState === 'complete') {
      await assertExactFile(
        join(authorized.records.workspace.path, WORKSPACE_MARKER_FILE),
        authorized.records.expectedMarkerBytes,
      );
    }
    const verifiedState = createRecoveryStateBytes({
      recoveryId: authorized.domain.claim.recoveryId,
      claimDigest: digestBytes(authorized.domain.claimBytes),
      phase: 'verified',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: null,
      updatedAt: now(),
    });
    authorized = await replaceState(binding, probe, authorized.domain.stateBytes, verifiedState);
    await options.hooks?.afterVerified?.();
  }

  let expectedManifest: Buffer;
  if (authorized.domain.state.phase === 'verified') {
    expectedManifest = manifestBytes(authorized);
    const alreadyInstalled = authorized.domain.finalManifestBytes !== undefined;
    authorized = await installManifest(
      binding,
      probe,
      authorized.domain.stateBytes,
      expectedManifest,
      options.hooks?.beforeFinalManifestSourceUnlink,
    );
    if (!alreadyInstalled) await options.hooks?.afterFinalManifestInstalled?.();
    const finalizingState = createRecoveryStateBytes({
      recoveryId: authorized.domain.claim.recoveryId,
      claimDigest: digestBytes(authorized.domain.claimBytes),
      phase: 'finalizing',
      expectedMutationPhase: null,
      expectedMutationDigest: null,
      finalManifestDigest: digestBytes(expectedManifest),
      updatedAt: new Date(authorized.domain.state.updatedAt),
    });
    authorized = await replaceState(binding, probe, authorized.domain.stateBytes, finalizingState);
    await options.hooks?.afterFinalizing?.();
  }

  if (authorized.domain.state.phase !== 'finalizing' || !authorized.domain.finalManifestBytes) {
    throw recoveryInvalid('bootstrap recovery did not reach finalizing');
  }
  expectedManifest = manifestBytes(authorized);
  if (
    !authorized.domain.finalManifestBytes.equals(expectedManifest) ||
    authorized.domain.state.finalManifestDigest !== digestBytes(expectedManifest)
  ) {
    throw recoveryInvalid('bootstrap recovery final manifest is stale or unbound');
  }
  await options.hooks?.beforeFinalRename?.();

  const finalAuthority = await readAuthorized(
    binding,
    probe,
    authorized.domain.stateBytes,
    expectedManifest,
  );
  const recomputed = manifestBytes(finalAuthority);
  if (!recomputed.equals(expectedManifest)) {
    throw recoveryInvalid('bootstrap final manifest changed before archive commit');
  }
  const result = completion(finalAuthority.records, finalAuthority.domain, expectedManifest);
  await moveDirectoryNoReplace(finalAuthority.records.activeLeasePath, result.archivePath, {
    commitCheck: options.finalRenameCommitCheck,
  });

  // The successful active-lease rename above is deliberately the final workspace action.
  return result;
}

export async function finalizeBootstrapRecovery(
  handle: BootstrapRecoveryAttemptHandle,
): Promise<BootstrapRecoveryCompletion> {
  const system = captureExactCurrentIdentityAuthority();
  return await finalizeBootstrapRecoveryControlled(handle, {
    attemptIdentity: system.identity,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

async function readArchivedBootstrapRecords(
  workspacePath: string,
  archivePath: string,
): Promise<BootstrapRecords> {
  const ready = await readReadyWorkspaceRecords(workspacePath);
  const ownerBytes = await readExactFile(join(archivePath, OWNER_FILE));
  const owner = parseJsonRecord(ownerBytes, parseOwnerRecord);
  if (!ownerBytes.equals(jsonBytes(owner))) {
    throw recoveryInvalid('archived bootstrap owner is not canonical JSON');
  }
  validateCoreRecordBindings({
    marker: ready.marker,
    protocol: ready.protocol,
    owner,
    protocolBytes: ready.protocolBytes,
    canonicalWorkspaceIdentity: ready.workspace.identity,
  });
  if (owner.command !== 'workspace-init' || owner.startedAt !== ready.protocol.createdAt) {
    throw recoveryInvalid('archived owner is not the bootstrap source owner');
  }
  const expectedMarkerBytes = jsonBytes(
    expectedBootstrapMarker(ready.protocol, ready.protocolBytes),
  );
  const markerInspection = await inspectBootstrapMarkerInstall({
    activeLeasePath: archivePath,
    markerPath: join(ready.workspace.path, WORKSPACE_MARKER_FILE),
    expectedMarkerBytes,
  });
  if (markerInspection.markerState !== 'complete') {
    throw recoveryInvalid('completed bootstrap recovery archive lacks one exact marker');
  }
  const records: BootstrapRecords = {
    workspace: ready.workspace,
    protocol: ready.protocol,
    protocolBytes: ready.protocolBytes,
    owner,
    ownerBytes,
    expectedMarker: ready.marker,
    expectedMarkerBytes,
    ...markerInspection,
    activeLeasePath: archivePath,
    recoveryPath: join(archivePath, RECOVERY_DIR),
  };
  const entries = await assertBootstrapOrdinaryDirectory(archivePath, 'bootstrap recovery archive');
  for (const entry of entries) {
    if (
      entry !== OWNER_FILE &&
      entry !== 'bootstrap-input' &&
      entry !== RECOVERY_DIR &&
      !RECOVERY_STAGING.test(entry)
    ) {
      throw recoveryInvalid(`bootstrap recovery archive contains forbidden entry ${entry}`);
    }
  }
  return records;
}

export async function verifyBootstrapRecoveryArchive(options: {
  readonly workspacePath: string;
  readonly targetArchive: string;
}): Promise<BootstrapRecoveryCompletion> {
  const ready = await readReadyWorkspaceRecords(options.workspacePath);
  if (await pathExists(join(ready.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))) {
    throw bootstrapRecoveryConflict('active lease still exists');
  }
  const archivePath = resolveWorkspaceRelativePath(ready.workspace.path, options.targetArchive);
  const records = await readArchivedBootstrapRecords(ready.workspace.path, archivePath);
  const domain = await readBootstrapRecoveryDomainAtPath(records, records.recoveryPath);
  if (domain.claim.targetArchive !== options.targetArchive) {
    throw recoveryInvalid('bootstrap archive path does not match its claim');
  }
  if (domain.state.phase !== 'finalizing' || !domain.finalManifestBytes) {
    throw recoveryInvalid('bootstrap archive is not a completed finalization');
  }
  const sourceDigest = captureBootstrapSource(records);
  if (
    sourceDigest !== domain.claim.sourceSnapshotDigest ||
    sourceDigest !== domain.finalManifest?.finalSourceSnapshotDigest
  ) {
    throw recoveryInvalid('bootstrap archive source does not match claim and manifest');
  }
  const expected = manifestBytes({ records, domain, sourceSnapshotDigest: sourceDigest });
  if (!domain.finalManifestBytes.equals(expected)) {
    throw recoveryInvalid('bootstrap archive manifest is not deterministic');
  }
  return completion(records, domain, expected);
}
