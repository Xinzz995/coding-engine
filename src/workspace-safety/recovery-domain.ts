import { lstat, readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import {
  digestBytes,
  pathExists,
  readLinkedFileInstall,
  readExactFile,
  type WorkspaceDirectory,
} from './filesystem.js';
import {
  readActiveLeaseOwner,
  readReadyWorkspaceRecords,
  type ReadyWorkspaceRecords,
} from './lease.js';
import {
  ABANDONED_ATTEMPT_PATTERN,
  PREPARED_ATTEMPT_PATTERN,
  RECOVERY_ATTEMPTS_DIR,
  RECOVERY_ATTEMPT_LEASE_DIR,
  RECOVERY_CLAIM_FILE,
  RECOVERY_FINAL_MANIFEST_FILE,
  RECOVERY_STATE_FILE,
  parseRecoveryAttemptOwner,
  parseRecoveryClaim,
  parseRecoveryFinalManifest,
  parseRecoveryState,
  recoveryAttemptLeaseDigest,
  recoveryInvalid,
  type RecoveryAttemptOwner,
  type RecoveryClaim,
  type RecoveryFinalManifest,
  type RecoveryState,
} from './recovery-records.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  type OwnerRecord,
  WorkspaceSafetyError,
} from './types.js';

const MAX_RECOVERY_ATTEMPTS = 4096;
const RECOVERY_STAGING_PATTERN = /^recovery\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

export interface RecoveryDomain {
  readonly workspace: WorkspaceDirectory;
  readonly sourceOwner: OwnerRecord;
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

export interface RecoveryContext {
  readonly records: ReadyWorkspaceRecords;
  readonly sourceOwner: OwnerRecord;
  readonly recoveryPath: string;
}

async function assertDirectory(path: string, label: string): Promise<string[]> {
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

async function readFinalManifestInstall(options: {
  readonly recoveryPath: string;
}): Promise<{ bytes?: Buffer; linkedSource?: string }> {
  const target = join(options.recoveryPath, RECOVERY_FINAL_MANIFEST_FILE);
  const sourceCandidates: Array<{ path: string; info: Awaited<ReturnType<typeof lstat>> }> = [];
  const leasePath = dirname(options.recoveryPath);
  for (const entry of await readdir(leasePath)) {
    if (!RECOVERY_STAGING_PATTERN.test(entry)) continue;
    const staging = join(leasePath, entry);
    const stagingEntries = await assertDirectory(staging, `recovery staging ${entry}`);
    if (!stagingEntries.includes(RECOVERY_FINAL_MANIFEST_FILE)) continue;
    if (stagingEntries.length !== 1) {
      throw recoveryInvalid('final-manifest staging must contain exactly one file');
    }
    const source = join(staging, RECOVERY_FINAL_MANIFEST_FILE);
    const info = await lstat(source, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) {
      throw recoveryInvalid('final-manifest staging is not an ordinary file');
    }
    if (info.nlink === 1n) {
      const stagedBytes = await readExactFile(source);
      parseRecoveryFinalManifest(stagedBytes);
    } else if (info.nlink !== 2n) {
      throw recoveryInvalid('final-manifest staging has an unsupported link count');
    }
    sourceCandidates.push({ path: source, info });
  }

  if (!(await pathExists(target))) {
    if (sourceCandidates.some((candidate) => candidate.info.nlink !== 1n)) {
      throw recoveryInvalid('linked final manifest is missing its canonical target');
    }
    return {};
  }
  const targetInfo = await lstat(target, { bigint: true });
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    throw recoveryInvalid('final manifest target is not an ordinary file');
  }
  if (targetInfo.nlink === 1n) {
    const bytes = await readExactFile(target);
    if (sourceCandidates.some((candidate) => candidate.info.nlink !== 1n)) {
      throw recoveryInvalid('final manifest has an unrelated linked staging file');
    }
    return { bytes };
  }
  if (targetInfo.nlink !== 2n) {
    throw recoveryInvalid('final manifest target has an unsupported link count');
  }
  const linked = sourceCandidates.filter(
    (candidate) => candidate.info.dev === targetInfo.dev && candidate.info.ino === targetInfo.ino,
  );
  if (
    linked.length !== 1 ||
    sourceCandidates.some(
      (candidate) => candidate.info.nlink === 2n && candidate.path !== linked[0].path,
    )
  ) {
    throw recoveryInvalid('final manifest is not paired with one controlled staging source');
  }
  const bytes = await readLinkedFileInstall({
    source: linked[0].path,
    target,
    maxBytes: 64 * 1024,
  });
  parseRecoveryFinalManifest(bytes);
  return { bytes, linkedSource: linked[0].path };
}

export async function readRecoveryAttemptDirectory(
  path: string,
  expectedRecoveryId: string,
  workspaceIdentity: string,
  label: string,
): Promise<{ owner: RecoveryAttemptOwner; ownerBytes: Buffer }> {
  const entries = await assertDirectory(path, label);
  if (entries.length !== 1 || entries[0] !== OWNER_FILE) {
    throw recoveryInvalid(`${label} must contain exactly owner.json`);
  }
  const ownerBytes = await readExactFile(join(path, OWNER_FILE));
  const owner = parseRecoveryAttemptOwner(ownerBytes);
  if (owner.recoveryId !== expectedRecoveryId || owner.workspaceIdentity !== workspaceIdentity) {
    throw recoveryInvalid(`${label} does not bind the current recovery and workspace`);
  }
  return { owner, ownerBytes };
}

function validateRebootBindings(
  claim: RecoveryClaim,
  sourceOwner: OwnerRecord,
  attemptOwner: RecoveryAttemptOwner | undefined,
): void {
  const proof = claim.rebootProof;
  if (proof === null) return;
  if (
    proof.hostId !== sourceOwner.hostId ||
    proof.previousBootIdentity !== sourceOwner.bootIdentity
  ) {
    throw recoveryInvalid('rebootProof does not bind the source owner');
  }
  if (
    attemptOwner &&
    (attemptOwner.hostId !== proof.hostId ||
      attemptOwner.bootIdentity !== proof.currentBootIdentity)
  ) {
    throw recoveryInvalid('rebootProof does not bind the active recovery attempt');
  }
}

export async function readRecoveryDomainAtPath(
  records: ReadyWorkspaceRecords,
  sourceOwner: OwnerRecord,
  recoveryPath: string,
): Promise<RecoveryDomain> {
  const entries = await assertDirectory(recoveryPath, 'recovery domain');
  const allowed = new Set([
    RECOVERY_CLAIM_FILE,
    RECOVERY_STATE_FILE,
    RECOVERY_FINAL_MANIFEST_FILE,
    RECOVERY_ATTEMPTS_DIR,
    RECOVERY_ATTEMPT_LEASE_DIR,
  ]);
  for (const entry of entries) {
    if (!allowed.has(entry)) {
      throw recoveryInvalid(`recovery domain contains unknown entry ${entry}`);
    }
  }
  for (const required of [RECOVERY_CLAIM_FILE, RECOVERY_STATE_FILE, RECOVERY_ATTEMPTS_DIR]) {
    if (!entries.includes(required)) {
      throw recoveryInvalid(`recovery domain is missing ${required}`);
    }
  }

  const claimBytes = await readExactFile(join(recoveryPath, RECOVERY_CLAIM_FILE));
  const claim = parseRecoveryClaim(claimBytes);
  const stateBytes = await readExactFile(join(recoveryPath, RECOVERY_STATE_FILE));
  const state = parseRecoveryState(stateBytes);
  if (state.recoveryId !== claim.recoveryId || state.claimDigest !== digestBytes(claimBytes)) {
    throw recoveryInvalid('recovery state does not bind the immutable claim');
  }
  const hasMutationBinding = state.expectedMutationPhase !== null;
  if ((claim.mode === 'mutation-resume') !== hasMutationBinding) {
    throw recoveryInvalid('recovery state mutation binding does not match claim mode');
  }

  const attemptsPath = join(recoveryPath, RECOVERY_ATTEMPTS_DIR);
  const attemptEntries = await assertDirectory(attemptsPath, 'recovery attempts');
  if (attemptEntries.length > MAX_RECOVERY_ATTEMPTS) {
    throw recoveryInvalid('recovery attempts exceed the bounded record count');
  }
  const seenAttemptIds = new Set<string>();
  for (const entry of attemptEntries) {
    const prepared = PREPARED_ATTEMPT_PATTERN.exec(entry);
    const abandoned = ABANDONED_ATTEMPT_PATTERN.exec(entry);
    if (!prepared && !abandoned) {
      throw recoveryInvalid(`recovery attempts contains unknown entry ${entry}`);
    }
    const attempt = await readRecoveryAttemptDirectory(
      join(attemptsPath, entry),
      claim.recoveryId,
      records.workspace.identity,
      `recovery attempt ${entry}`,
    );
    if (seenAttemptIds.has(attempt.owner.attemptId)) {
      throw recoveryInvalid('recovery attemptId appears more than once');
    }
    seenAttemptIds.add(attempt.owner.attemptId);
    if (prepared && attempt.owner.attemptId !== prepared[1]) {
      throw recoveryInvalid('prepared recovery attempt name does not bind owner attemptId');
    }
    if (abandoned && recoveryAttemptLeaseDigest(attempt.ownerBytes).slice(7) !== abandoned[1]) {
      throw recoveryInvalid(
        'abandoned recovery attempt name does not bind its complete lease digest',
      );
    }
  }

  let attemptOwner: RecoveryAttemptOwner | undefined;
  let attemptOwnerBytes: Buffer | undefined;
  if (entries.includes(RECOVERY_ATTEMPT_LEASE_DIR)) {
    const attempt = await readRecoveryAttemptDirectory(
      join(recoveryPath, RECOVERY_ATTEMPT_LEASE_DIR),
      claim.recoveryId,
      records.workspace.identity,
      'active recovery attempt',
    );
    if (seenAttemptIds.has(attempt.owner.attemptId)) {
      throw recoveryInvalid('active recovery attemptId duplicates attempt history');
    }
    attemptOwner = attempt.owner;
    attemptOwnerBytes = attempt.ownerBytes;
  }
  validateRebootBindings(claim, sourceOwner, attemptOwner);

  let finalManifest: RecoveryFinalManifest | undefined;
  let finalManifestBytes: Buffer | undefined;
  let linkedFinalManifestSource: string | undefined;
  const finalManifestInstall =
    claim.mode === 'mechanical-empty' ||
    claim.mode === 'delegated-finalize' ||
    claim.mode === 'mutation-resume'
      ? await readFinalManifestInstall({ recoveryPath })
      : undefined;
  if (entries.includes(RECOVERY_FINAL_MANIFEST_FILE)) {
    if (finalManifestInstall) {
      finalManifestBytes = finalManifestInstall.bytes;
      linkedFinalManifestSource = finalManifestInstall.linkedSource;
    } else {
      finalManifestBytes = await readExactFile(join(recoveryPath, RECOVERY_FINAL_MANIFEST_FILE));
    }
    if (!finalManifestBytes) throw recoveryInvalid('final manifest target disappeared');
    finalManifest = parseRecoveryFinalManifest(finalManifestBytes);
    if (
      finalManifest.recoveryId !== claim.recoveryId ||
      finalManifest.claimDigest !== digestBytes(claimBytes) ||
      finalManifest.workspaceMarkerDigest !== digestBytes(records.markerBytes) ||
      finalManifest.protocolDigest !== digestBytes(records.protocolBytes) ||
      (claim.mode === 'mutation-resume') !== (finalManifest.mutationSnapshotDigest !== null)
    ) {
      throw recoveryInvalid('final manifest does not bind the current recovery inputs');
    }
    if (claim.mode !== 'delegated-finalize' && finalManifest.delegatedCandidateDigest !== null) {
      throw recoveryInvalid('non-delegated recovery cannot bind a delegated candidate');
    }
  }
  if (!entries.includes(RECOVERY_FINAL_MANIFEST_FILE) && finalManifestInstall?.bytes) {
    throw recoveryInvalid('final manifest target appeared during recovery domain inspection');
  }
  if (state.phase === 'claimed' && finalManifest) {
    throw recoveryInvalid('claimed recovery cannot contain a final manifest');
  }
  if (state.phase === 'finalizing') {
    if (!finalManifestBytes || state.finalManifestDigest !== digestBytes(finalManifestBytes)) {
      throw recoveryInvalid('finalizing recovery does not bind an exact final manifest');
    }
  }
  if (linkedFinalManifestSource && state.phase !== 'verified') {
    throw recoveryInvalid('linked final manifest is only valid in the verified crash window');
  }

  return {
    workspace: records.workspace,
    sourceOwner,
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

export async function loadRecoveryContext(workspacePath: string): Promise<RecoveryContext> {
  const records = await readReadyWorkspaceRecords(workspacePath);
  const active = await readActiveLeaseOwner(records);
  if (!active) throw recoveryInvalid('recovery requires a canonical active source lease');
  return {
    records,
    sourceOwner: active.owner,
    recoveryPath: join(records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, RECOVERY_DIR),
  };
}

export async function readRecoveryDomain(workspacePath: string): Promise<RecoveryDomain> {
  const context = await loadRecoveryContext(workspacePath);
  return await readRecoveryDomainAtPath(context.records, context.sourceOwner, context.recoveryPath);
}
