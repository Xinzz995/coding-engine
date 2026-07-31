import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertExactFile,
  assertWorkspaceDirectoryUnchanged,
  canonicalizeWorkspaceDirectory,
  createStagingDirectory,
  digestBytes,
  installDirectoryNoReplace,
  inspectLinkedFileInstall,
  jsonBytes,
  moveDirectoryNoReplace,
  pathExists,
  readExactFile,
  writeNewFile,
  type WorkspaceDirectory,
} from './filesystem.js';
import { captureExactCurrentIdentityAuthority, createIdentityProbe } from './identity.js';
import { inspectBootstrapFinalManifestInstall } from './bootstrap-recovery-linked.js';
import { readRecoveryAttemptDirectory } from './recovery-domain.js';
import {
  ABANDONED_ATTEMPT_PATTERN,
  PREPARED_ATTEMPT_PATTERN,
  RECOVERY_ATTEMPTS_DIR,
  RECOVERY_ATTEMPT_LEASE_DIR,
  RECOVERY_CLAIM_FILE,
  RECOVERY_FINAL_MANIFEST_FILE,
  RECOVERY_STATE_FILE,
  createRecoveryAttemptOwnerBytes,
  createRecoveryClaimBytes,
  createRecoveryStateBytes,
  parseRecoveryAttemptOwner,
  parseRecoveryClaim,
  parseRecoveryFinalManifest,
  parseRecoveryState,
  recoveryAttemptLeaseDigest,
  recoveryDigest,
  recoveryInvalid,
  recoveryUuid,
  type RecoveryAttemptOwner,
  type RecoveryClaim,
  type RecoveryFinalManifest,
  type RecoveryState,
} from './recovery-records.js';
import {
  parseJsonRecord,
  parseOwnerRecord,
  parseProtocolRecord,
  parseWorkspaceMarker,
} from './schema.js';
import {
  ACTIVE_LEASE_DIR,
  INCIDENTS_DIR,
  OWNER_FILE,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  WORKSPACE_MARKER_FILE,
  WORKSPACE_MARKER_SCHEMA_VERSION,
  WORKSPACE_SAFETY_VERSION,
  type IdentityVerdict,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  type ProtocolRecord,
  type WorkspaceMarker,
  WorkspaceSafetyError,
} from './types.js';
import { assertWindowsSafetyTreeHasNoReparsePoints } from './windows-path-attributes.js';

const BOOTSTRAP_ROOT_STAGING =
  /^engine\.lock\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const RECOVERY_STAGING = /^recovery\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MAX_RECOVERY_ATTEMPTS = 4096;
const BOOTSTRAP_RECOVERY_HANDLE_AUTHORITY = Symbol('bootstrap-recovery-handle-authority');

export interface BootstrapRecords {
  readonly workspace: WorkspaceDirectory;
  readonly protocol: ProtocolRecord;
  readonly protocolBytes: Buffer;
  readonly owner: OwnerRecord;
  readonly ownerBytes: Buffer;
  readonly expectedMarker: WorkspaceMarker;
  readonly expectedMarkerBytes: Buffer;
  readonly markerState: 'missing' | 'linked-incomplete' | 'complete';
  readonly linkedMarkerSource?: string;
  readonly bootstrapInputState: 'absent' | 'present';
  readonly activeLeasePath: string;
  readonly recoveryPath: string;
}

export interface BootstrapRecoveryDomain {
  readonly claim: RecoveryClaim;
  readonly claimBytes: Buffer;
  readonly state: RecoveryState;
  readonly stateBytes: Buffer;
  readonly finalManifest?: RecoveryFinalManifest;
  readonly finalManifestBytes?: Buffer;
  readonly linkedFinalManifestSource?: string;
  readonly attemptOwner?: RecoveryAttemptOwner;
  readonly attemptOwnerBytes?: Buffer;
}

export interface BootstrapRecoveryInstallHooks {
  readonly beforeRecoveryInstall?: (stagingPath: string) => void | Promise<void>;
  readonly afterRecoveryInstalled?: (recoveryPath: string) => void | Promise<void>;
}

export interface ControlledInstallBootstrapRecoveryOptions {
  readonly workspacePath: string;
  readonly expectedSourceSnapshotDigest: string;
  readonly recoveryId?: string;
  readonly attemptId?: string;
  readonly identity: ProcessIdentitySnapshot;
  readonly now?: () => Date;
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly hooks?: BootstrapRecoveryInstallHooks;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal bootstrap-recovery input; generated IDs, time, hooks, and OS authority are internal. */
export interface InstallBootstrapRecoveryOptions {
  readonly workspacePath: string;
  readonly expectedSourceSnapshotDigest: string;
}

export interface BootstrapRecoveryAttemptHooks {
  readonly afterOldAttemptAbandoned?: (abandonedPath: string) => void | Promise<void>;
}

export interface ControlledAcquireBootstrapRecoveryAttemptOptions {
  readonly workspacePath: string;
  readonly attemptId?: string;
  readonly identity: ProcessIdentitySnapshot;
  readonly now?: () => Date;
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly probeAttemptOwner?: (owner: RecoveryAttemptOwner) => IdentityVerdict;
  readonly hooks?: BootstrapRecoveryAttemptHooks;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal bootstrap-recovery continuation input. */
export interface AcquireBootstrapRecoveryAttemptOptions {
  readonly workspacePath: string;
}

export interface BootstrapRecoveryDiskState {
  readonly classification: 'active' | 'recoverable' | 'recovering' | 'isolated';
  readonly markerState: BootstrapRecords['markerState'];
  readonly sourceOwnerVerdict: IdentityVerdict;
  readonly phase?: RecoveryState['phase'];
}

export function bootstrapRecoveryConflict(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('conflict', `Bootstrap recovery conflict: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

export function asBootstrapSourceOwnerProbe(
  configured: ((owner: OwnerRecord) => IdentityVerdict) | undefined,
): (owner: OwnerRecord) => IdentityVerdict {
  if (configured) return configured;
  const probe = createIdentityProbe();
  return (owner) => probe.probe(owner);
}

export function requireDeadBootstrapSourceOwner(
  owner: OwnerRecord,
  probe: (owner: OwnerRecord) => IdentityVerdict,
): void {
  const verdict = probe(owner);
  if (verdict !== 'dead') {
    throw bootstrapRecoveryConflict(`source owner is ${verdict}, not exact dead`);
  }
}

export async function assertBootstrapOrdinaryDirectory(
  path: string,
  label: string,
): Promise<string[]> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw recoveryInvalid(`${label} is not an ordinary directory`);
    }
    return await readdir(path);
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw recoveryInvalid(`${label} is missing or unreadable`, error);
  }
}

function parseCanonical<T>(bytes: Buffer, parser: (value: unknown) => T, label: string): T {
  const parsed = parseJsonRecord(bytes, parser);
  if (!bytes.equals(jsonBytes(parsed))) throw recoveryInvalid(`${label} is not canonical JSON`);
  return parsed;
}

export function expectedBootstrapMarker(
  protocol: ProtocolRecord,
  protocolBytes: Buffer,
): WorkspaceMarker {
  return {
    schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
    initializedBy: WORKSPACE_SAFETY_VERSION,
    workspaceIdentity: protocol.workspaceIdentity,
    protocolDigest: digestBytes(protocolBytes),
    initializedAt: protocol.createdAt,
  };
}

interface BootstrapMarkerInstallInspection {
  readonly markerState: BootstrapRecords['markerState'];
  readonly linkedMarkerSource?: string;
  readonly bootstrapInputState: BootstrapRecords['bootstrapInputState'];
}

async function inspectBootstrapMarkerInstallInternal(options: {
  readonly activeLeasePath: string;
  readonly markerPath: string;
  readonly expectedMarkerBytes: Buffer;
}): Promise<BootstrapMarkerInstallInspection> {
  const candidatePaths: string[] = [];
  const inputPath = join(options.activeLeasePath, 'bootstrap-input');
  let bootstrapInputState: BootstrapRecords['bootstrapInputState'] = 'absent';
  if (await pathExists(inputPath)) {
    bootstrapInputState = 'present';
    const entries = await assertBootstrapOrdinaryDirectory(inputPath, 'bootstrap-input');
    if (entries.length > 1 || (entries.length === 1 && entries[0] !== WORKSPACE_MARKER_FILE)) {
      throw recoveryInvalid('bootstrap-input must be empty or contain only the exact marker');
    }
    if (entries.length === 1) candidatePaths.push(join(inputPath, WORKSPACE_MARKER_FILE));
  }

  const leaseEntries = await readdir(options.activeLeasePath);
  for (const entry of leaseEntries) {
    if (!RECOVERY_STAGING.test(entry)) continue;
    const stagingPath = join(options.activeLeasePath, entry);
    const entries = await assertBootstrapOrdinaryDirectory(
      stagingPath,
      `recovery staging ${entry}`,
    );
    if (!entries.includes(WORKSPACE_MARKER_FILE)) continue;
    if (entries.length !== 1) {
      throw recoveryInvalid('marker recovery staging must contain exactly the marker file');
    }
    candidatePaths.push(join(stagingPath, WORKSPACE_MARKER_FILE));
  }

  const candidates = await Promise.all(
    candidatePaths.map(async (path) => ({ path, info: await lstat(path, { bigint: true }) })),
  );
  for (const candidate of candidates) {
    if (candidate.info.isSymbolicLink() || !candidate.info.isFile()) {
      throw recoveryInvalid('controlled marker staging is not an ordinary file');
    }
    if (candidate.info.nlink === 1n) {
      await assertExactFile(candidate.path, options.expectedMarkerBytes);
    } else if (candidate.info.nlink !== 2n) {
      throw recoveryInvalid('controlled marker staging has an unsupported link count');
    }
  }

  if (!(await pathExists(options.markerPath))) {
    if (candidates.some((candidate) => candidate.info.nlink !== 1n)) {
      throw recoveryInvalid('linked marker target is missing from its controlled install pair');
    }
    return { markerState: 'missing', bootstrapInputState };
  }
  const target = await lstat(options.markerPath, { bigint: true });
  if (target.isSymbolicLink() || !target.isFile()) {
    throw recoveryInvalid('workspace marker is not an ordinary file');
  }
  if (target.nlink === 1n) {
    await assertExactFile(options.markerPath, options.expectedMarkerBytes);
    if (candidates.some((candidate) => candidate.info.nlink !== 1n)) {
      throw recoveryInvalid('workspace marker has an unrelated linked staging file');
    }
    return { markerState: 'complete', bootstrapInputState };
  }
  if (target.nlink !== 2n) {
    throw recoveryInvalid('workspace marker has an unsupported link count');
  }
  const linked = candidates.filter(
    (candidate) => candidate.info.dev === target.dev && candidate.info.ino === target.ino,
  );
  if (
    linked.length !== 1 ||
    candidates.some((candidate) => candidate.info.nlink === 2n && candidate !== linked[0])
  ) {
    throw recoveryInvalid('workspace marker is not paired with one controlled staging path');
  }
  await inspectLinkedFileInstall({
    source: linked[0].path,
    target: options.markerPath,
    expectedBytes: options.expectedMarkerBytes,
  });
  return {
    markerState: 'linked-incomplete',
    linkedMarkerSource: linked[0].path,
    bootstrapInputState,
  };
}

export async function inspectBootstrapMarkerInstall(options: {
  readonly activeLeasePath: string;
  readonly markerPath: string;
  readonly expectedMarkerBytes: Buffer;
}): Promise<BootstrapMarkerInstallInspection> {
  try {
    return await inspectBootstrapMarkerInstallInternal(options);
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw recoveryInvalid('controlled bootstrap marker install is changing or unreadable', error);
  }
}

async function readBootstrapRecords(workspacePath: string): Promise<BootstrapRecords> {
  const workspace = await canonicalizeWorkspaceDirectory(workspacePath);
  await assertWorkspaceDirectoryUnchanged(workspace);
  const rootEntries = await readdir(workspace.path);
  for (const entry of rootEntries) {
    if (entry === PROTOCOL_ROOT_DIR || entry === WORKSPACE_MARKER_FILE) continue;
    if (!BOOTSTRAP_ROOT_STAGING.test(entry)) {
      throw recoveryInvalid(`unfinished bootstrap workspace contains business entry ${entry}`);
    }
    await assertBootstrapOrdinaryDirectory(
      join(workspace.path, entry),
      `bootstrap staging ${entry}`,
    );
  }

  const protocolRoot = join(workspace.path, PROTOCOL_ROOT_DIR);
  const protocolEntries = await assertBootstrapOrdinaryDirectory(
    protocolRoot,
    'permanent protocol root',
  );
  const protocolAllowed = new Set([PROTOCOL_FILE, INCIDENTS_DIR, ACTIVE_LEASE_DIR]);
  for (const entry of protocolEntries) {
    if (!protocolAllowed.has(entry)) {
      throw recoveryInvalid(`permanent protocol root contains unknown entry ${entry}`);
    }
  }
  for (const required of protocolAllowed) {
    if (!protocolEntries.includes(required)) {
      throw recoveryInvalid(`permanent protocol root is missing ${required}`);
    }
  }
  const incidentEntries = await assertBootstrapOrdinaryDirectory(
    join(protocolRoot, INCIDENTS_DIR),
    'bootstrap incidents',
  );
  if (incidentEntries.length !== 0) {
    throw recoveryInvalid('unfinished bootstrap incidents must still be empty');
  }

  const protocolBytes = await readExactFile(join(protocolRoot, PROTOCOL_FILE));
  const protocol = parseCanonical(protocolBytes, parseProtocolRecord, 'bootstrap protocol');
  if (protocol.workspaceIdentity !== workspace.identity) {
    throw recoveryInvalid('bootstrap protocol does not bind the canonical workspace');
  }
  const activeLeasePath = join(protocolRoot, ACTIVE_LEASE_DIR);
  const ownerBytes = await readExactFile(join(activeLeasePath, OWNER_FILE));
  const owner = parseCanonical(ownerBytes, parseOwnerRecord, 'bootstrap owner');
  if (
    owner.command !== 'workspace-init' ||
    owner.workspaceIdentity !== workspace.identity ||
    owner.startedAt !== protocol.createdAt
  ) {
    throw recoveryInvalid('bootstrap owner does not bind the installed protocol root');
  }

  const marker = expectedBootstrapMarker(protocol, protocolBytes);
  const expectedMarkerBytes = jsonBytes(marker);
  parseCanonical(expectedMarkerBytes, parseWorkspaceMarker, 'expected bootstrap marker');
  const recoveryPath = join(activeLeasePath, RECOVERY_DIR);
  const leaseEntries = await assertBootstrapOrdinaryDirectory(
    activeLeasePath,
    'bootstrap active lease',
  );
  for (const entry of leaseEntries) {
    if (
      entry !== OWNER_FILE &&
      entry !== 'bootstrap-input' &&
      entry !== RECOVERY_DIR &&
      !RECOVERY_STAGING.test(entry)
    ) {
      throw recoveryInvalid(`bootstrap active lease contains forbidden entry ${entry}`);
    }
    if (RECOVERY_STAGING.test(entry)) {
      await assertBootstrapOrdinaryDirectory(
        join(activeLeasePath, entry),
        `recovery staging ${entry}`,
      );
    }
  }
  const markerInspection = await inspectBootstrapMarkerInstall({
    activeLeasePath,
    markerPath: join(workspace.path, WORKSPACE_MARKER_FILE),
    expectedMarkerBytes,
  });
  const records: BootstrapRecords = {
    workspace,
    protocol,
    protocolBytes,
    owner,
    ownerBytes,
    expectedMarker: marker,
    expectedMarkerBytes,
    ...markerInspection,
    activeLeasePath,
    recoveryPath,
  };
  await assertExactFile(join(protocolRoot, PROTOCOL_FILE), protocolBytes);
  await assertExactFile(join(activeLeasePath, OWNER_FILE), ownerBytes);
  await assertWorkspaceDirectoryUnchanged(workspace);
  return records;
}

export function captureBootstrapSource(records: BootstrapRecords): string {
  return digestBytes(
    jsonBytes({
      schemaVersion: 1,
      domain: 'coding-x-bootstrap-recovery-source-v1',
      workspaceIdentity: records.workspace.identity,
      protocolDigest: digestBytes(records.protocolBytes),
      expectedMarkerDigest: digestBytes(records.expectedMarkerBytes),
      entries: [
        { path: OWNER_FILE, digest: digestBytes(records.ownerBytes) },
        { path: 'bootstrap-input', kind: records.bootstrapInputState },
      ],
    }),
  );
}

export async function readStableBootstrapSource(
  workspacePath: string,
): Promise<{ records: BootstrapRecords; digest: string }> {
  const canonical = await canonicalizeWorkspaceDirectory(workspacePath);
  assertWindowsSafetyTreeHasNoReparsePoints(canonical.path);
  const firstRecords = await readBootstrapRecords(workspacePath);
  const first = captureBootstrapSource(firstRecords);
  const secondRecords = await readBootstrapRecords(workspacePath);
  const second = captureBootstrapSource(secondRecords);
  if (
    first !== second ||
    !firstRecords.protocolBytes.equals(secondRecords.protocolBytes) ||
    !firstRecords.ownerBytes.equals(secondRecords.ownerBytes) ||
    firstRecords.markerState !== secondRecords.markerState ||
    firstRecords.linkedMarkerSource !== secondRecords.linkedMarkerSource ||
    firstRecords.bootstrapInputState !== secondRecords.bootstrapInputState
  ) {
    throw recoveryInvalid('bootstrap recovery source changed during stable capture');
  }
  assertWindowsSafetyTreeHasNoReparsePoints(canonical.path);
  await assertWorkspaceDirectoryUnchanged(canonical);
  return { records: secondRecords, digest: second };
}

export async function captureBootstrapRecoverySourceSnapshotDigest(
  workspacePath: string,
): Promise<string> {
  return (await readStableBootstrapSource(workspacePath)).digest;
}

export async function readBootstrapRecoveryDomainAtPath(
  records: BootstrapRecords,
  recoveryPath: string,
): Promise<BootstrapRecoveryDomain> {
  const entries = await assertBootstrapOrdinaryDirectory(recoveryPath, 'bootstrap recovery domain');
  const allowed = new Set([
    RECOVERY_CLAIM_FILE,
    RECOVERY_STATE_FILE,
    RECOVERY_FINAL_MANIFEST_FILE,
    RECOVERY_ATTEMPTS_DIR,
    RECOVERY_ATTEMPT_LEASE_DIR,
  ]);
  for (const entry of entries) {
    if (!allowed.has(entry)) throw recoveryInvalid(`recovery contains unknown entry ${entry}`);
  }
  for (const required of [RECOVERY_CLAIM_FILE, RECOVERY_STATE_FILE, RECOVERY_ATTEMPTS_DIR]) {
    if (!entries.includes(required)) throw recoveryInvalid(`recovery is missing ${required}`);
  }

  const claimBytes = await readExactFile(join(recoveryPath, RECOVERY_CLAIM_FILE));
  const claim = parseRecoveryClaim(claimBytes);
  if (claim.mode !== 'bootstrap-complete' || claim.rebootProof !== null) {
    throw recoveryInvalid('bootstrap recovery claim has the wrong mode or reboot proof');
  }
  const stateBytes = await readExactFile(join(recoveryPath, RECOVERY_STATE_FILE));
  const state = parseRecoveryState(stateBytes);
  if (
    state.recoveryId !== claim.recoveryId ||
    state.claimDigest !== digestBytes(claimBytes) ||
    state.expectedMutationPhase !== null ||
    state.expectedMutationDigest !== null
  ) {
    throw recoveryInvalid('bootstrap recovery state does not bind its claim');
  }

  const attemptsPath = join(recoveryPath, RECOVERY_ATTEMPTS_DIR);
  const attemptEntries = await assertBootstrapOrdinaryDirectory(
    attemptsPath,
    'bootstrap recovery attempts',
  );
  if (attemptEntries.length > MAX_RECOVERY_ATTEMPTS) {
    throw recoveryInvalid('bootstrap recovery attempts exceed the bounded count');
  }
  const seenAttemptIds = new Set<string>();
  for (const entry of attemptEntries) {
    const prepared = PREPARED_ATTEMPT_PATTERN.exec(entry);
    const abandoned = ABANDONED_ATTEMPT_PATTERN.exec(entry);
    if (!prepared && !abandoned) {
      throw recoveryInvalid(`bootstrap recovery attempts contains unknown entry ${entry}`);
    }
    const attempt = await readRecoveryAttemptDirectory(
      join(attemptsPath, entry),
      claim.recoveryId,
      records.workspace.identity,
      `bootstrap recovery attempt ${entry}`,
    );
    if (seenAttemptIds.has(attempt.owner.attemptId)) {
      throw recoveryInvalid('bootstrap recovery attemptId appears more than once');
    }
    seenAttemptIds.add(attempt.owner.attemptId);
    if (prepared && prepared[1] !== attempt.owner.attemptId) {
      throw recoveryInvalid('prepared attempt name does not bind attemptId');
    }
    if (abandoned && abandoned[1] !== recoveryAttemptLeaseDigest(attempt.ownerBytes).slice(7)) {
      throw recoveryInvalid('abandoned attempt name does not bind its lease digest');
    }
  }

  let attemptOwner: RecoveryAttemptOwner | undefined;
  let attemptOwnerBytes: Buffer | undefined;
  if (entries.includes(RECOVERY_ATTEMPT_LEASE_DIR)) {
    const attempt = await readRecoveryAttemptDirectory(
      join(recoveryPath, RECOVERY_ATTEMPT_LEASE_DIR),
      claim.recoveryId,
      records.workspace.identity,
      'active bootstrap recovery attempt',
    );
    if (seenAttemptIds.has(attempt.owner.attemptId)) {
      throw recoveryInvalid('active bootstrap recovery attempt duplicates history');
    }
    attemptOwner = attempt.owner;
    attemptOwnerBytes = attempt.ownerBytes;
  }

  let finalManifest: RecoveryFinalManifest | undefined;
  let finalManifestBytes: Buffer | undefined;
  let linkedFinalManifestSource: string | undefined;
  const installedFinalManifest = await inspectBootstrapFinalManifestInstall({
    records,
    recoveryPath,
    claim,
    claimBytes,
    state,
  });
  if (entries.includes(RECOVERY_FINAL_MANIFEST_FILE)) {
    finalManifestBytes = installedFinalManifest.bytes;
    linkedFinalManifestSource = installedFinalManifest.linkedSource;
    if (!finalManifestBytes) throw recoveryInvalid('bootstrap final manifest target disappeared');
    finalManifest = parseRecoveryFinalManifest(finalManifestBytes);
    if (
      finalManifest.recoveryId !== claim.recoveryId ||
      finalManifest.claimDigest !== digestBytes(claimBytes) ||
      finalManifest.workspaceMarkerDigest !== digestBytes(records.expectedMarkerBytes) ||
      finalManifest.protocolDigest !== digestBytes(records.protocolBytes) ||
      finalManifest.mutationSnapshotDigest !== null ||
      finalManifest.delegatedCandidateDigest !== null
    ) {
      throw recoveryInvalid('bootstrap final manifest does not bind its exact inputs');
    }
  }
  if (!entries.includes(RECOVERY_FINAL_MANIFEST_FILE) && installedFinalManifest.bytes) {
    throw recoveryInvalid('bootstrap final manifest appeared during domain inspection');
  }
  if (state.phase === 'claimed' && finalManifest) {
    throw recoveryInvalid('claimed bootstrap recovery cannot contain a final manifest');
  }
  if (state.phase === 'finalizing') {
    if (!finalManifestBytes || state.finalManifestDigest !== digestBytes(finalManifestBytes)) {
      throw recoveryInvalid('finalizing bootstrap recovery lacks its exact manifest');
    }
  }
  if (linkedFinalManifestSource && state.phase !== 'verified') {
    throw recoveryInvalid('linked bootstrap final manifest is only valid while verified');
  }
  if (state.phase !== 'claimed' && records.markerState !== 'complete') {
    throw recoveryInvalid('verified bootstrap recovery is missing the exact workspace marker');
  }

  return {
    claim,
    claimBytes,
    state,
    stateBytes,
    finalManifest,
    finalManifestBytes,
    linkedFinalManifestSource,
    attemptOwner,
    attemptOwnerBytes,
  };
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
    'prepared bootstrap recovery attempt',
  );
  if (parsed.owner.attemptId !== attemptId) {
    throw recoveryInvalid('prepared bootstrap recovery attempt does not bind its name');
  }
  return staging;
}

function asProbeOwner(owner: RecoveryAttemptOwner): OwnerRecord {
  return {
    schemaVersion: 2,
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

/** @internal Authority-controlled core. */
export async function installBootstrapRecoveryDomainControlled(
  options: ControlledInstallBootstrapRecoveryOptions,
): Promise<BootstrapRecoveryAttemptHandle> {
  await options.verifySystemAuthority?.();
  const expectedDigest = recoveryDigest(
    options.expectedSourceSnapshotDigest,
    'expectedSourceSnapshotDigest',
  );
  const initial = await readStableBootstrapSource(options.workspacePath);
  const probeSourceOwner = asBootstrapSourceOwnerProbe(options.probeSourceOwner);
  requireDeadBootstrapSourceOwner(initial.records.owner, probeSourceOwner);
  if (await pathExists(initial.records.recoveryPath)) {
    await readBootstrapRecoveryDomainAtPath(initial.records, initial.records.recoveryPath);
    throw bootstrapRecoveryConflict('a canonical recovery domain is already installed');
  }
  if (initial.digest !== expectedDigest) {
    throw bootstrapRecoveryConflict('source snapshot no longer matches');
  }

  const recoveryId = recoveryUuid(options.recoveryId ?? randomUUID(), 'recoveryId');
  const attemptId = recoveryUuid(options.attemptId ?? randomUUID(), 'attemptId');
  const now = options.now ?? (() => new Date());
  const claimBytes = createRecoveryClaimBytes({
    recoveryId,
    sourceSnapshotDigest: expectedDigest,
    mode: 'bootstrap-complete',
    rebootProof: null,
    createdAt: now(),
  });
  const stateBytes = createRecoveryStateBytes({
    recoveryId,
    claimDigest: digestBytes(claimBytes),
    phase: 'claimed',
    expectedMutationPhase: null,
    expectedMutationDigest: null,
    finalManifestDigest: null,
    updatedAt: now(),
  });
  const attemptOwnerBytes = createRecoveryAttemptOwnerBytes(
    recoveryId,
    attemptId,
    options.identity,
    initial.records.workspace.identity,
    now,
  );
  const staging = await createStagingDirectory(
    initial.records.activeLeasePath,
    'recovery.prepare-',
    recoveryId,
  );
  await writeNewFile(join(staging, RECOVERY_CLAIM_FILE), claimBytes);
  await writeNewFile(join(staging, RECOVERY_STATE_FILE), stateBytes);
  const attemptsPath = join(staging, RECOVERY_ATTEMPTS_DIR);
  await mkdir(attemptsPath, { mode: 0o700 });
  const attemptStaging = await writeAttemptStaging(
    attemptsPath,
    attemptId,
    attemptOwnerBytes,
    recoveryId,
    initial.records.workspace.identity,
  );
  await installDirectoryNoReplace(attemptStaging, join(staging, RECOVERY_ATTEMPT_LEASE_DIR));
  await readBootstrapRecoveryDomainAtPath(initial.records, staging);
  await options.hooks?.beforeRecoveryInstall?.(staging);

  await options.verifySystemAuthority?.();
  const commit = await readStableBootstrapSource(options.workspacePath);
  requireDeadBootstrapSourceOwner(commit.records.owner, probeSourceOwner);
  if (commit.digest !== expectedDigest) {
    throw bootstrapRecoveryConflict('source changed before recovery install');
  }
  if (await pathExists(commit.records.recoveryPath)) {
    throw bootstrapRecoveryConflict('another recovery domain won installation');
  }
  await installDirectoryNoReplace(staging, commit.records.recoveryPath);
  await options.hooks?.afterRecoveryInstalled?.(commit.records.recoveryPath);
  await options.verifySystemAuthority?.();
  const installedRecords = (await readStableBootstrapSource(options.workspacePath)).records;
  const installed = await readBootstrapRecoveryDomainAtPath(
    installedRecords,
    installedRecords.recoveryPath,
  );
  if (
    !installed.claimBytes.equals(claimBytes) ||
    !installed.stateBytes.equals(stateBytes) ||
    !installed.attemptOwnerBytes?.equals(attemptOwnerBytes)
  ) {
    throw recoveryInvalid('installed bootstrap recovery bytes changed');
  }
  return new BootstrapRecoveryAttemptHandle(BOOTSTRAP_RECOVERY_HANDLE_AUTHORITY, {
    workspacePath: installedRecords.workspace.path,
    sourceSnapshotDigest: expectedDigest,
    claimBytes,
    stateBytes,
    attemptOwnerBytes,
    verifySystemAuthority: options.verifySystemAuthority,
  });
}

export async function installBootstrapRecoveryDomain(
  options: InstallBootstrapRecoveryOptions,
): Promise<BootstrapRecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await installBootstrapRecoveryDomainControlled({
    workspacePath: options.workspacePath,
    expectedSourceSnapshotDigest: options.expectedSourceSnapshotDigest,
    identity: system.identity,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

/** @internal Authority-controlled core. */
export async function acquireBootstrapRecoveryAttemptControlled(
  options: ControlledAcquireBootstrapRecoveryAttemptOptions,
): Promise<BootstrapRecoveryAttemptHandle> {
  await options.verifySystemAuthority?.();
  const initial = await readStableBootstrapSource(options.workspacePath);
  const initialDomain = await readBootstrapRecoveryDomainAtPath(
    initial.records,
    initial.records.recoveryPath,
  );
  const probeSourceOwner = asBootstrapSourceOwnerProbe(options.probeSourceOwner);
  requireDeadBootstrapSourceOwner(initial.records.owner, probeSourceOwner);
  if (initial.digest !== initialDomain.claim.sourceSnapshotDigest) {
    throw bootstrapRecoveryConflict('source no longer matches the immutable claim');
  }
  const identityProbe = createIdentityProbe();
  const probeAttemptOwner =
    options.probeAttemptOwner ??
    ((owner: RecoveryAttemptOwner): IdentityVerdict => identityProbe.probe(asProbeOwner(owner)));
  if (initialDomain.attemptOwner) {
    const verdict = probeAttemptOwner(initialDomain.attemptOwner);
    if (verdict !== 'dead') {
      throw bootstrapRecoveryConflict(`existing recovery attempt is ${verdict}`);
    }
  }

  const attemptId = recoveryUuid(options.attemptId ?? randomUUID(), 'attemptId');
  const now = options.now ?? (() => new Date());
  const ownerBytes = createRecoveryAttemptOwnerBytes(
    initialDomain.claim.recoveryId,
    attemptId,
    options.identity,
    initial.records.workspace.identity,
    now,
  );
  const attemptsPath = join(initial.records.recoveryPath, RECOVERY_ATTEMPTS_DIR);
  const staging = await writeAttemptStaging(
    attemptsPath,
    attemptId,
    ownerBytes,
    initialDomain.claim.recoveryId,
    initial.records.workspace.identity,
  );
  const leasePath = join(initial.records.recoveryPath, RECOVERY_ATTEMPT_LEASE_DIR);

  for (let competition = 0; competition < 16; competition += 1) {
    await options.verifySystemAuthority?.();
    const current = await readStableBootstrapSource(options.workspacePath);
    requireDeadBootstrapSourceOwner(current.records.owner, probeSourceOwner);
    if (current.digest !== initialDomain.claim.sourceSnapshotDigest) {
      throw bootstrapRecoveryConflict('source changed during recovery attempt acquisition');
    }
    const domain = await readBootstrapRecoveryDomainAtPath(
      current.records,
      current.records.recoveryPath,
    );
    if (
      !domain.claimBytes.equals(initialDomain.claimBytes) ||
      !domain.stateBytes.equals(initialDomain.stateBytes)
    ) {
      throw bootstrapRecoveryConflict('recovery claim or state changed during attempt acquisition');
    }
    if (domain.attemptOwner && domain.attemptOwnerBytes) {
      const verdict = probeAttemptOwner(domain.attemptOwner);
      if (verdict !== 'dead') {
        throw bootstrapRecoveryConflict(`existing recovery attempt is ${verdict}`);
      }
      const digest = recoveryAttemptLeaseDigest(domain.attemptOwnerBytes);
      const abandonedPath = join(attemptsPath, `abandoned-${digest.slice(7)}`);
      if (await pathExists(abandonedPath)) {
        throw recoveryInvalid('dead bootstrap recovery attempt already has an archive');
      }
      try {
        await moveDirectoryNoReplace(leasePath, abandonedPath);
      } catch (error) {
        if (!(await pathExists(leasePath)) && (await pathExists(abandonedPath))) continue;
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
    const installed = await readStableBootstrapSource(options.workspacePath);
    const installedDomain = await readBootstrapRecoveryDomainAtPath(
      installed.records,
      installed.records.recoveryPath,
    );
    if (!installedDomain.attemptOwnerBytes?.equals(ownerBytes)) {
      throw recoveryInvalid('winning bootstrap recovery attempt bytes changed');
    }
    if (installed.digest !== initialDomain.claim.sourceSnapshotDigest) {
      throw recoveryInvalid('source changed while installing recovery attempt');
    }
    return new BootstrapRecoveryAttemptHandle(BOOTSTRAP_RECOVERY_HANDLE_AUTHORITY, {
      workspacePath: installed.records.workspace.path,
      sourceSnapshotDigest: initialDomain.claim.sourceSnapshotDigest,
      claimBytes: initialDomain.claimBytes,
      stateBytes: initialDomain.stateBytes,
      attemptOwnerBytes: ownerBytes,
      verifySystemAuthority: options.verifySystemAuthority,
    });
  }
  throw bootstrapRecoveryConflict('recovery attempt competition did not reach one winner');
}

export async function acquireBootstrapRecoveryAttempt(
  options: AcquireBootstrapRecoveryAttemptOptions,
): Promise<BootstrapRecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await acquireBootstrapRecoveryAttemptControlled({
    workspacePath: options.workspacePath,
    identity: system.identity,
    probeSourceOwner: system.probeOwner,
    probeAttemptOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

interface BootstrapRecoveryHandleOptions {
  readonly workspacePath: string;
  readonly sourceSnapshotDigest: string;
  readonly claimBytes: Buffer;
  readonly stateBytes: Buffer;
  readonly attemptOwnerBytes: Buffer;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

export class BootstrapRecoveryAttemptHandle {
  readonly workspacePath: string;
  readonly owner: RecoveryAttemptOwner;
  readonly #sourceSnapshotDigest: string;
  readonly #claimBytes: Buffer;
  readonly #stateBytes: Buffer;
  readonly #attemptOwnerBytes: Buffer;
  readonly #verifySystemAuthority?: () => void | Promise<void>;

  constructor(
    token: typeof BOOTSTRAP_RECOVERY_HANDLE_AUTHORITY,
    options: BootstrapRecoveryHandleOptions,
  ) {
    if (token !== BOOTSTRAP_RECOVERY_HANDLE_AUTHORITY) {
      throw new WorkspaceSafetyError(
        'invalid',
        'bootstrap recovery attempt handle authority token is invalid',
      );
    }
    this.workspacePath = options.workspacePath;
    this.#sourceSnapshotDigest = options.sourceSnapshotDigest;
    this.#claimBytes = Buffer.from(options.claimBytes);
    this.#stateBytes = Buffer.from(options.stateBytes);
    this.#attemptOwnerBytes = Buffer.from(options.attemptOwnerBytes);
    this.#verifySystemAuthority = options.verifySystemAuthority;
    this.owner = parseRecoveryAttemptOwner(this.#attemptOwnerBytes);
  }

  async verify(): Promise<void> {
    try {
      await this.#verifySystemAuthority?.();
      const source = await readStableBootstrapSource(this.workspacePath);
      const domain = await readBootstrapRecoveryDomainAtPath(
        source.records,
        source.records.recoveryPath,
      );
      if (
        source.digest !== this.#sourceSnapshotDigest ||
        !domain.claimBytes.equals(this.#claimBytes) ||
        !domain.stateBytes.equals(this.#stateBytes) ||
        !domain.attemptOwnerBytes?.equals(this.#attemptOwnerBytes)
      ) {
        throw new WorkspaceSafetyError('lease-lost', 'bootstrap recovery binding changed');
      }
    } catch (error) {
      if (error instanceof WorkspaceSafetyError && error.code === 'lease-lost') throw error;
      const lost = new WorkspaceSafetyError(
        'lease-lost',
        'bootstrap recovery attempt is no longer canonical',
      );
      Object.defineProperty(lost, 'cause', { value: error });
      throw lost;
    }
  }

  binding(): { claimBytes: Buffer; attemptOwnerBytes: Buffer; stateBytes: Buffer } {
    return {
      claimBytes: Buffer.from(this.#claimBytes),
      attemptOwnerBytes: Buffer.from(this.#attemptOwnerBytes),
      stateBytes: Buffer.from(this.#stateBytes),
    };
  }
}

/** @internal Deterministic evaluator seam. */
export async function evaluateBootstrapRecoveryDiskStateControlled(
  workspacePath: string,
  probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict,
): Promise<BootstrapRecoveryDiskState> {
  const source = await readStableBootstrapSource(workspacePath);
  const verdict = asBootstrapSourceOwnerProbe(probeSourceOwner)(source.records.owner);
  if (await pathExists(source.records.recoveryPath)) {
    const domain = await readBootstrapRecoveryDomainAtPath(
      source.records,
      source.records.recoveryPath,
    );
    return {
      classification: 'recovering',
      markerState: source.records.markerState,
      sourceOwnerVerdict: verdict,
      phase: domain.state.phase,
    };
  }
  return {
    classification:
      verdict === 'dead' ? 'recoverable' : verdict === 'alive' ? 'active' : 'isolated',
    markerState: source.records.markerState,
    sourceOwnerVerdict: verdict,
  };
}

export async function evaluateBootstrapRecoveryDiskState(
  workspacePath: string,
): Promise<BootstrapRecoveryDiskState> {
  const system = captureExactCurrentIdentityAuthority();
  system.verifyCurrent();
  return await evaluateBootstrapRecoveryDiskStateControlled(workspacePath, system.probeOwner);
}
