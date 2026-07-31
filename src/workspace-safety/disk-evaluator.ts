import { lstat, readdir } from 'node:fs/promises';
import { basename, join } from 'node:path';
import {
  readBootstrapRecoveryDomainAtPath,
  readStableBootstrapSource,
} from './bootstrap-recovery.js';
import { classifyWorkspaceSafetyFacts, type WorkspaceSafetyFacts } from './classification.js';
import {
  type DiskSupervisorVerdict,
  inspectWorkspaceOperation,
  type OperationDiskInspection,
  type OperationDiskProbe,
} from './disk-evaluator-operation.js';
import { recoveryBindingMatches } from './disk-evaluator-recovery.js';
import {
  assertWorkspaceDirectoryUnchanged,
  canonicalizeWorkspaceDirectory,
  digestBytes,
  pathExists,
  type WorkspaceDirectory,
} from './filesystem.js';
import {
  createIdentityProbe,
  createSystemIdentityAdapter,
  type SupportedIdentityPlatform,
} from './identity.js';
import {
  readActiveLeaseOwner,
  readReadyWorkspaceRecords,
  type ReadyWorkspaceRecords,
} from './lease.js';
import {
  readCanonicalMutationDomain,
  captureMutationFinalSnapshotDigest,
  verifyMutationLegalIntermediateSnapshot,
  type MutationDomain,
} from './mutation-domain.js';
import {
  OPERATION_STAGING_PATTERN,
  PRESTART_ABORT_FILE,
  SETTLED_OPERATIONS_DIR,
  settledOperationDirectoryName,
  type ArmedActiveChild,
  type PreparedBoundActiveChild,
} from './operation-records.js';
import { probePosixProcessGroup } from './posix-containment.js';
import {
  isQuarantineStagingName,
  readQuarantinePresence,
  type QuarantineRecord,
} from './quarantine.js';
import { readRecoveryDomainAtPath, type RecoveryDomain } from './recovery-domain.js';
import type { RecoveryAttemptOwner } from './recovery-records.js';
import { captureRecoverySourceFromRecords } from './recovery-source-snapshot.js';
import {
  ACTIVE_LEASE_DIR,
  MUTATION_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  WORKSPACE_MARKER_FILE,
  type IdentityVerdict,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  type QuarantineReason,
  type WorkspaceSafetyClassification,
  WorkspaceSafetyError,
} from './types.js';
import {
  assertNoWindowsReparsePoints,
  assertWindowsSafetyTreeHasNoReparsePoints,
  assertWindowsWorkspaceTreeHasNoReparsePoints,
} from './windows-path-attributes.js';

const ROOT_BOOTSTRAP_STAGING =
  /^engine\.lock\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MUTATION_STAGING = /^mutation\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const RECOVERY_STAGING = /^recovery\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MAX_SAFETY_TREE_ENTRIES = 100_000;
const MAX_SAFETY_TREE_DEPTH = 64;
const MAX_SAFETY_PATH_BYTES = 4096;
const MAX_SAFETY_FINGERPRINT_BYTES = 16 * 1024 * 1024;
const MAX_CANONICAL_DIRECTORY_ENTRIES = 100_000;

export interface WorkspaceSafetyDiskProbeAdapter extends OperationDiskProbe {
  readonly platform: SupportedIdentityPlatform;
  readonly evidenceKind: 'system' | 'fixture';
  readonly currentIdentity: () => ProcessIdentitySnapshot;
  readonly probeOwner: (owner: OwnerRecord) => IdentityVerdict;
}

export type WorkspaceSafetyDiskReason =
  | 'none'
  | 'bootstrap-in-progress'
  | 'foreign-host'
  | 'identity-unavailable'
  | 'operation-proof-missing'
  | 'prepared-handshake-not-expired'
  | 'supervisor-not-exact-dead'
  | 'containment-not-exact-empty'
  | 'quarantine-install-incomplete'
  | 'unsupported-mutation-record'
  | 'legacy-runtime-artifacts'
  | 'unstable-probe'
  | 'invalid-safety-record'
  | QuarantineReason;

export interface WorkspaceSafetyDiskEvaluation {
  readonly classification: WorkspaceSafetyClassification;
  readonly facts: WorkspaceSafetyFacts;
  readonly reason: WorkspaceSafetyDiskReason;
  readonly operationState: 'none' | 'prepared' | 'prepared-bound' | 'armed';
  readonly operationLocation: 'none' | 'active' | 'settled';
  readonly probeEvidence: WorkspaceSafetyDiskProbeAdapter['evidenceKind'];
  readonly unsupportedCanonical: readonly 'mutation'[];
  readonly safetyFingerprint?: string;
  readonly diagnostic?: string;
}

export interface EvaluateWorkspaceSafetyDiskOptions {
  readonly workspacePath: string;
}

export interface ControlledEvaluateWorkspaceSafetyDiskOptions extends EvaluateWorkspaceSafetyDiskOptions {
  readonly probe?: WorkspaceSafetyDiskProbeAdapter;
  readonly now?: () => Date;
}

interface QuarantineEvidence {
  readonly location: 'lease' | 'operation';
  readonly record: QuarantineRecord;
  readonly bytes: Buffer;
}

interface LogicalEvaluation extends Omit<WorkspaceSafetyDiskEvaluation, 'safetyFingerprint'> {
  readonly safetyFingerprint: string;
}

interface LeaseInspection {
  readonly operation?: OperationDiskInspection;
  readonly operationLocation: 'none' | 'active' | 'settled';
  readonly recovery?: RecoveryDomain;
  readonly mutation?: MutationDomain;
  readonly quarantine?: QuarantineEvidence;
  readonly quarantineInstallIncomplete: boolean;
}

function defaultFacts(): WorkspaceSafetyFacts {
  return {
    canonical: 'valid',
    quarantine: null,
    recovery: 'absent',
    bootstrapLease: false,
    legacyArtifacts: false,
    owner: 'absent',
    containment: 'not-applicable',
    recoveryInputs: 'valid',
    foreignHost: false,
    protocol: 'absent',
    marker: 'absent',
    lease: 'absent',
    directoryEmpty: false,
  };
}

function invalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('invalid', `Invalid workspace disk state: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function invalidEvaluation(
  probeEvidence: WorkspaceSafetyDiskProbeAdapter['evidenceKind'],
  diagnostic: string,
  unsupportedCanonical: readonly 'mutation'[] = [],
): WorkspaceSafetyDiskEvaluation {
  const facts = { ...defaultFacts(), canonical: 'invalid' as const };
  return {
    classification: classifyWorkspaceSafetyFacts(facts),
    facts,
    reason:
      unsupportedCanonical.length > 0 ? 'unsupported-mutation-record' : 'invalid-safety-record',
    operationState: 'none',
    operationLocation: 'none',
    probeEvidence,
    unsupportedCanonical,
    diagnostic,
  };
}

function strictDirectoryEntries(path: string, label: string): Promise<string[]> {
  return (async () => {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw invalid(`${label} is not ordinary`);
    const names = await readdir(path);
    if (names.length > MAX_CANONICAL_DIRECTORY_ENTRIES) {
      throw invalid(`${label} exceeds its entry budget`);
    }
    return names.sort((left, right) => left.localeCompare(right, 'en'));
  })();
}

async function appendTreeFingerprint(
  path: string,
  relativePath: string,
  depth: number,
  observations: string[],
  budget: { entries: number; bytes: number },
): Promise<void> {
  if (depth > MAX_SAFETY_TREE_DEPTH) throw invalid('safety tree exceeds its depth budget');
  if (Buffer.byteLength(relativePath, 'utf8') > MAX_SAFETY_PATH_BYTES) {
    throw invalid('safety tree path exceeds its byte budget');
  }
  const info = await lstat(path, { bigint: true });
  budget.entries += 1;
  if (budget.entries > MAX_SAFETY_TREE_ENTRIES) {
    throw invalid('safety tree exceeds its entry budget');
  }
  const kind = info.isSymbolicLink()
    ? 'symlink'
    : info.isDirectory()
      ? 'directory'
      : info.isFile()
        ? 'file'
        : 'unsupported';
  if (kind === 'symlink' || kind === 'unsupported') {
    throw invalid(`safety tree contains an unsupported path: ${relativePath}`);
  }
  const line = [
    kind,
    relativePath,
    info.dev.toString(),
    info.ino.toString(),
    info.nlink.toString(),
    info.size.toString(),
    info.mtimeNs.toString(),
    info.ctimeNs.toString(),
  ].join('\0');
  budget.bytes += Buffer.byteLength(line, 'utf8');
  if (budget.bytes > MAX_SAFETY_FINGERPRINT_BYTES) {
    throw invalid('safety fingerprint exceeds its byte budget');
  }
  observations.push(line);
  if (!info.isDirectory()) return;
  const names = (await readdir(path)).sort((left, right) => left.localeCompare(right, 'en'));
  for (const name of names) {
    await appendTreeFingerprint(
      join(path, name),
      `${relativePath}/${name}`,
      depth + 1,
      observations,
      budget,
    );
  }
}

async function safetyFingerprint(workspace: WorkspaceDirectory): Promise<string> {
  await assertWorkspaceDirectoryUnchanged(workspace);
  const observations: string[] = [];
  const budget = { entries: 0, bytes: 0 };
  const rootNames = await readdir(workspace.path);
  const safetyNames = rootNames
    .filter(
      (name) =>
        name === WORKSPACE_MARKER_FILE ||
        name === PROTOCOL_ROOT_DIR ||
        ROOT_BOOTSTRAP_STAGING.test(name),
    )
    .sort((left, right) => left.localeCompare(right, 'en'));
  for (const name of safetyNames) {
    await appendTreeFingerprint(join(workspace.path, name), name, 0, observations, budget);
  }
  await assertWorkspaceDirectoryUnchanged(workspace);
  return digestBytes(Buffer.from(JSON.stringify(observations), 'utf8'));
}

function defaultProbeAdapter(): WorkspaceSafetyDiskProbeAdapter {
  const adapter = createSystemIdentityAdapter();
  const identity = createIdentityProbe(adapter);
  const probeSupervisor = (
    active: PreparedBoundActiveChild | ArmedActiveChild,
  ): DiskSupervisorVerdict => {
    const expected = active.platform === 'windows-job-v1' ? 'win32' : adapter.platform;
    if (active.platform === 'posix-process-group-v1' && adapter.platform === 'win32')
      return 'unknown';
    if (expected !== adapter.platform) return 'unknown';
    const observed = adapter.readProcessIdentity(active.supervisorPid);
    if (observed.status === 'missing') return 'dead';
    if (observed.status === 'unknown') return 'unknown';
    if (observed.value !== active.supervisorIdentity) return 'dead';
    return adapter.platform === 'darwin' ? 'unknown' : 'alive';
  };
  return {
    platform: adapter.platform,
    evidenceKind: 'system',
    currentIdentity: () => identity.current(),
    probeOwner: (owner) => identity.probe(owner),
    probeSupervisor,
    probeContainment: (active, receipt) => {
      if (active.platform === 'posix-process-group-v1') {
        if (adapter.platform === 'win32' || active.containment.platform !== active.platform) {
          return 'unknown';
        }
        return probePosixProcessGroup(active.containment.pgid);
      }
      if (adapter.platform !== 'win32') return 'unknown';
      return receipt.proof === 'windows-job-zero-and-pipes-eof-v1' ||
        receipt.proof === 'never-started-containment-empty-v1'
        ? 'empty'
        : 'unknown';
    },
  };
}

function ownerObservation(
  owner: OwnerRecord,
  probe: WorkspaceSafetyDiskProbeAdapter,
): { owner: IdentityVerdict; foreignHost: boolean; probeUnavailable: boolean } {
  let current: ProcessIdentitySnapshot;
  try {
    current = probe.currentIdentity();
  } catch {
    return { owner: 'unknown', foreignHost: false, probeUnavailable: true };
  }
  const foreignHost = current.hostId !== owner.hostId;
  let verdict: IdentityVerdict;
  try {
    verdict = probe.probeOwner(owner);
  } catch {
    verdict = 'unknown';
  }
  return { owner: verdict, foreignHost, probeUnavailable: false };
}

function assertRootQuarantineBinding(
  evidence: QuarantineEvidence,
  owner: OwnerRecord,
  ownerBytes: Buffer,
): void {
  const { record } = evidence;
  if (
    record.ownerId !== owner.ownerId ||
    record.operationId !== null ||
    record.activeChildDigest !== null ||
    record.delegatedBaselineDigest !== null
  ) {
    throw invalid('lease quarantine does not bind the active owner');
  }
  if (
    record.creator.kind === 'owner' &&
    (record.creator.id !== owner.ownerId ||
      record.creator.recordDigest !== digestBytes(ownerBytes) ||
      record.priorQuarantineDigest !== null)
  ) {
    throw invalid('owner-created lease quarantine has invalid authority');
  }
  // Recovery may install integrity isolation directly or upgrade a prior containment record.
  // The immutable creator binding is verified below once the recovery domain has been read.
}

function assertRecoveryQuarantineCreator(
  evidence: QuarantineEvidence | undefined,
  attemptOwner: RecoveryAttemptOwner | undefined,
  attemptOwnerBytes: Buffer | undefined,
): void {
  if (!evidence || evidence.record.creator.kind !== 'recovery-attempt') return;
  if (
    !attemptOwner ||
    !attemptOwnerBytes ||
    evidence.record.creator.id !== attemptOwner.attemptId ||
    evidence.record.creator.recordDigest !== digestBytes(attemptOwnerBytes)
  ) {
    throw invalid(`${evidence.location} quarantine does not bind the recovery attempt`);
  }
}

async function inspectSettledDelegatedOperation(options: {
  readonly leasePath: string;
  readonly workspacePath: string;
  readonly records: ReadyWorkspaceRecords;
  readonly owner: OwnerRecord;
  readonly ownerBytes: Buffer;
  readonly ownerVerdict: IdentityVerdict;
  readonly recovery: RecoveryDomain;
  readonly now: Date;
  readonly probe: WorkspaceSafetyDiskProbeAdapter;
}): Promise<OperationDiskInspection | undefined> {
  const binding = options.recovery.claim.delegatedOperation;
  if (!binding) return undefined;
  const settledRoot = join(options.leasePath, SETTLED_OPERATIONS_DIR);
  if (!(await pathExists(settledRoot))) return undefined;
  const names = await strictDirectoryEntries(settledRoot, SETTLED_OPERATIONS_DIR);
  const matches = names.filter((name) => name.startsWith(`${binding.operationId}-`));
  if (matches.length !== 1) throw invalid('delegated recovery settled operation is ambiguous');
  const path = join(settledRoot, matches[0]);
  const operation = await inspectWorkspaceOperation({
    operationPath: path,
    workspacePath: options.workspacePath,
    workspaceIdentity: options.records.workspace.identity,
    protocolBytes: options.records.protocolBytes,
    owner: options.owner,
    ownerBytes: options.ownerBytes,
    ownerVerdict: options.ownerVerdict,
    now: options.now,
    probe: options.probe,
  });
  if (operation.state !== 'armed' || !operation.receiptBytes) {
    throw invalid('delegated recovery settled operation is not armed and receipted');
  }
  const authority: Array<readonly [string, Buffer]> = [
    ['delegated-baseline.json', operation.baselineBytes],
    ['active-child.json', operation.activeBytes],
    ['drained-receipt.json', operation.receiptBytes],
  ];
  if (operation.quarantine) authority.push(['quarantine.json', operation.quarantine.bytes]);
  if (basename(path) !== settledOperationDirectoryName(binding.operationId, authority)) {
    throw invalid('settled operation name does not bind its complete authority bytes');
  }
  return operation;
}

async function inspectSettledPrestartOperation(options: {
  readonly leasePath: string;
  readonly workspacePath: string;
  readonly records: ReadyWorkspaceRecords;
  readonly owner: OwnerRecord;
  readonly ownerBytes: Buffer;
  readonly ownerVerdict: IdentityVerdict;
  readonly recovery: RecoveryDomain;
  readonly now: Date;
  readonly probe: WorkspaceSafetyDiskProbeAdapter;
}): Promise<OperationDiskInspection | undefined> {
  const binding = options.recovery.claim.prestartOperation;
  if (!binding) return undefined;
  const settledRoot = join(options.leasePath, SETTLED_OPERATIONS_DIR);
  if (!(await pathExists(settledRoot))) return undefined;
  const names = await strictDirectoryEntries(settledRoot, SETTLED_OPERATIONS_DIR);
  const matches = names.filter((name) => name.startsWith(`${binding.operationId}-`));
  if (matches.length !== 1) throw invalid('prestart recovery settled operation is ambiguous');
  const path = join(settledRoot, matches[0]);
  const operation = await inspectWorkspaceOperation({
    operationPath: path,
    workspacePath: options.workspacePath,
    workspaceIdentity: options.records.workspace.identity,
    protocolBytes: options.records.protocolBytes,
    owner: options.owner,
    ownerBytes: options.ownerBytes,
    ownerVerdict: options.ownerVerdict,
    now: options.now,
    probe: options.probe,
  });
  if (operation.state === 'armed' || !operation.prestartAbortBytes) {
    throw invalid('prestart recovery settled operation is not an aborted prestart operation');
  }
  const authority: Array<readonly [string, Buffer]> = [
    ['delegated-baseline.json', operation.baselineBytes],
    ['active-child.json', operation.activeBytes],
    [PRESTART_ABORT_FILE, operation.prestartAbortBytes],
  ];
  if (basename(path) !== settledOperationDirectoryName(binding.operationId, authority)) {
    throw invalid('settled prestart operation name does not bind its complete authority bytes');
  }
  return operation;
}

async function inspectActiveLease(options: {
  readonly records: ReadyWorkspaceRecords;
  readonly owner: OwnerRecord;
  readonly ownerBytes: Buffer;
  readonly ownerVerdict: IdentityVerdict;
  readonly now: Date;
  readonly probe: WorkspaceSafetyDiskProbeAdapter;
}): Promise<LeaseInspection> {
  const leasePath = join(options.records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  const names = await strictDirectoryEntries(leasePath, 'active lease');
  const fixedAllowed = new Set([
    OWNER_FILE,
    OPERATION_DIR,
    SETTLED_OPERATIONS_DIR,
    MUTATION_DIR,
    RECOVERY_DIR,
    'quarantine.json',
  ]);
  for (const name of names) {
    if (
      fixedAllowed.has(name) ||
      OPERATION_STAGING_PATTERN.test(name) ||
      MUTATION_STAGING.test(name) ||
      RECOVERY_STAGING.test(name) ||
      isQuarantineStagingName(name)
    ) {
      continue;
    }
    throw invalid(`active lease contains unknown entry ${name}`);
  }
  for (const name of names) {
    if (
      OPERATION_STAGING_PATTERN.test(name) ||
      MUTATION_STAGING.test(name) ||
      RECOVERY_STAGING.test(name) ||
      name === SETTLED_OPERATIONS_DIR
    ) {
      await strictDirectoryEntries(join(leasePath, name), `active lease entry ${name}`);
    }
  }

  const rootQuarantinePresence = await readQuarantinePresence(leasePath);
  let quarantine: QuarantineEvidence | undefined;
  if (rootQuarantinePresence.canonical) {
    quarantine = {
      location: 'lease',
      record: rootQuarantinePresence.canonical.record,
      bytes: rootQuarantinePresence.canonical.bytes,
    };
    assertRootQuarantineBinding(quarantine, options.owner, options.ownerBytes);
  }
  const rootQuarantineIncomplete =
    rootQuarantinePresence.present && rootQuarantinePresence.canonical === undefined;

  let operation: OperationDiskInspection | undefined;
  if (names.includes(OPERATION_DIR)) {
    operation = await inspectWorkspaceOperation({
      operationPath: join(leasePath, OPERATION_DIR),
      workspacePath: options.records.workspace.path,
      workspaceIdentity: options.records.workspace.identity,
      protocolBytes: options.records.protocolBytes,
      owner: options.owner,
      ownerBytes: options.ownerBytes,
      ownerVerdict: options.ownerVerdict,
      now: options.now,
      probe: options.probe,
    });
    if (operation.quarantine) {
      if (quarantine) throw invalid('lease and operation both contain canonical quarantine');
      quarantine = operation.quarantine;
    }
  }

  let mutation: MutationDomain | undefined;
  if (names.includes(MUTATION_DIR)) {
    if (operation) throw invalid('active lease cannot contain operation and mutation together');
    mutation = await readCanonicalMutationDomain({
      workspace: options.records.workspace,
      expectedOwner: options.owner,
    });
    await verifyMutationLegalIntermediateSnapshot(mutation);
  }

  let recovery: RecoveryDomain | undefined;
  if (names.includes(RECOVERY_DIR)) {
    recovery = await readRecoveryDomainAtPath(
      options.records,
      options.owner,
      join(leasePath, RECOVERY_DIR),
    );
    if (recovery.claim.mode === 'delegated-finalize' && !operation) {
      operation = await inspectSettledDelegatedOperation({
        leasePath,
        workspacePath: options.records.workspace.path,
        records: options.records,
        owner: options.owner,
        ownerBytes: options.ownerBytes,
        ownerVerdict: options.ownerVerdict,
        recovery,
        now: options.now,
        probe: options.probe,
      });
    }
    if (
      recovery.claim.mode === 'mechanical-empty' &&
      recovery.claim.prestartOperation &&
      !operation
    ) {
      operation = await inspectSettledPrestartOperation({
        leasePath,
        workspacePath: options.records.workspace.path,
        records: options.records,
        owner: options.owner,
        ownerBytes: options.ownerBytes,
        ownerVerdict: options.ownerVerdict,
        recovery,
        now: options.now,
        probe: options.probe,
      });
    }
    if (!recoveryBindingMatches(recovery, operation, mutation)) {
      throw invalid('recovery mode does not bind the canonical operation state');
    }
    if (recovery.claim.mode === 'mutation-resume' && mutation && recovery.finalManifest) {
      if (
        recovery.finalManifest.mutationSnapshotDigest !==
          (await captureMutationFinalSnapshotDigest(mutation)) ||
        recovery.finalManifest.finalSourceSnapshotDigest !==
          (await captureRecoverySourceFromRecords(options.records))
      ) {
        throw invalid('mutation recovery final manifest no longer binds its exact final source');
      }
    }
    if (
      recovery.claim.mode === 'mechanical-empty' &&
      recovery.claim.prestartOperation === null &&
      (await captureRecoverySourceFromRecords(options.records)) !==
        recovery.claim.sourceSnapshotDigest
    ) {
      throw invalid('mechanical recovery no longer binds its immutable source snapshot');
    }
    assertRecoveryQuarantineCreator(quarantine, recovery.attemptOwner, recovery.attemptOwnerBytes);
  } else {
    assertRecoveryQuarantineCreator(quarantine, undefined, undefined);
  }

  return {
    ...(operation ? { operation } : {}),
    operationLocation: operation ? (names.includes(OPERATION_DIR) ? 'active' : 'settled') : 'none',
    ...(recovery ? { recovery } : {}),
    ...(mutation ? { mutation } : {}),
    ...(quarantine ? { quarantine } : {}),
    quarantineInstallIncomplete:
      rootQuarantineIncomplete || operation?.quarantineInstallIncomplete === true,
  };
}

function resultFromFacts(options: {
  readonly facts: WorkspaceSafetyFacts;
  readonly reason: WorkspaceSafetyDiskReason;
  readonly operation?: OperationDiskInspection;
  readonly operationLocation?: LeaseInspection['operationLocation'];
  readonly probe: WorkspaceSafetyDiskProbeAdapter;
  readonly fingerprint: string;
}): LogicalEvaluation {
  return {
    classification: classifyWorkspaceSafetyFacts(options.facts),
    facts: options.facts,
    reason: options.reason,
    operationState: options.operation?.state ?? 'none',
    operationLocation: options.operationLocation ?? 'none',
    probeEvidence: options.probe.evidenceKind,
    unsupportedCanonical: [],
    safetyFingerprint: options.fingerprint,
  };
}

function reasonForOwner(options: {
  readonly owner: IdentityVerdict;
  readonly foreignHost: boolean;
  readonly probeUnavailable: boolean;
  readonly operation?: OperationDiskInspection;
  readonly quarantineIncomplete: boolean;
  readonly quarantine: QuarantineReason | null;
}): WorkspaceSafetyDiskReason {
  if (options.foreignHost) return 'foreign-host';
  if (options.probeUnavailable) return 'identity-unavailable';
  if (options.quarantine) return options.quarantine;
  if (options.quarantineIncomplete) return 'quarantine-install-incomplete';
  if (options.owner === 'alive') return 'none';
  return options.operation?.reason ?? 'none';
}

async function evaluateBootstrapState(options: {
  readonly workspace: WorkspaceDirectory;
  readonly probe: WorkspaceSafetyDiskProbeAdapter;
  readonly fingerprint: string;
}): Promise<LogicalEvaluation> {
  const source = await readStableBootstrapSource(options.workspace.path);
  const observed = ownerObservation(source.records.owner, options.probe);
  const hasRecovery = await pathExists(source.records.recoveryPath);
  if (hasRecovery) {
    const recovery = await readBootstrapRecoveryDomainAtPath(
      source.records,
      source.records.recoveryPath,
    );
    if (recovery.claim.sourceSnapshotDigest !== source.digest) {
      throw invalid('bootstrap recovery no longer binds its immutable source snapshot');
    }
  }
  const facts: WorkspaceSafetyFacts = {
    ...defaultFacts(),
    protocol: 'valid',
    marker: source.records.markerState === 'missing' ? 'absent' : 'valid',
    lease: 'valid',
    bootstrapLease: true,
    recovery: hasRecovery ? 'valid' : 'absent',
    owner: observed.owner,
    foreignHost: observed.foreignHost,
  };
  return resultFromFacts({
    facts,
    reason: observed.foreignHost
      ? 'foreign-host'
      : observed.probeUnavailable
        ? 'identity-unavailable'
        : 'bootstrap-in-progress',
    probe: options.probe,
    fingerprint: options.fingerprint,
  });
}

async function rootShape(workspace: WorkspaceDirectory): Promise<{
  readonly semanticEmpty: boolean;
  readonly hasRuntimeArtifacts: boolean;
}> {
  const first = (await readdir(workspace.path)).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  const nonInert: string[] = [];
  for (const name of first) {
    if (!ROOT_BOOTSTRAP_STAGING.test(name)) {
      nonInert.push(name);
      continue;
    }
    await strictDirectoryEntries(join(workspace.path, name), `bootstrap staging ${name}`);
  }
  const second = (await readdir(workspace.path)).sort((left, right) =>
    left.localeCompare(right, 'en'),
  );
  if (JSON.stringify(first) !== JSON.stringify(second))
    throw invalid('workspace root changed during read');
  return { semanticEmpty: nonInert.length === 0, hasRuntimeArtifacts: nonInert.length > 0 };
}

async function evaluateOnce(
  workspacePath: string,
  probe: WorkspaceSafetyDiskProbeAdapter,
  now: Date,
): Promise<LogicalEvaluation> {
  const workspace = await canonicalizeWorkspaceDirectory(workspacePath);
  assertNoWindowsReparsePoints(
    [
      join(workspace.path, WORKSPACE_MARKER_FILE),
      join(workspace.path, PROTOCOL_ROOT_DIR),
    ],
    { allowMissing: true },
  );
  const before = await safetyFingerprint(workspace);
  const markerExists = await pathExists(join(workspace.path, WORKSPACE_MARKER_FILE));
  const protocolRootExists = await pathExists(join(workspace.path, PROTOCOL_ROOT_DIR));

  if (markerExists && protocolRootExists) {
    assertWindowsSafetyTreeHasNoReparsePoints(workspace.path);
  }

  let logical: Omit<LogicalEvaluation, 'safetyFingerprint'>;
  if (!markerExists && !protocolRootExists) {
    assertWindowsWorkspaceTreeHasNoReparsePoints(workspace.path);
    const shape = await rootShape(workspace);
    assertWindowsWorkspaceTreeHasNoReparsePoints(workspace.path);
    const facts: WorkspaceSafetyFacts = {
      ...defaultFacts(),
      directoryEmpty: shape.semanticEmpty,
      legacyArtifacts: shape.hasRuntimeArtifacts,
    };
    logical = {
      classification: classifyWorkspaceSafetyFacts(facts),
      facts,
      reason: shape.hasRuntimeArtifacts ? 'legacy-runtime-artifacts' : 'none',
      operationState: 'none',
      operationLocation: 'none',
      probeEvidence: probe.evidenceKind,
      unsupportedCanonical: [],
    };
  } else if (!markerExists && protocolRootExists) {
    const rootInfo = await lstat(join(workspace.path, PROTOCOL_ROOT_DIR));
    if (
      rootInfo.isSymbolicLink() ||
      !rootInfo.isDirectory() ||
      !(await pathExists(join(workspace.path, PROTOCOL_ROOT_DIR, PROTOCOL_FILE)))
    ) {
      const facts = { ...defaultFacts(), legacyArtifacts: true };
      logical = {
        classification: classifyWorkspaceSafetyFacts(facts),
        facts,
        reason: 'legacy-runtime-artifacts',
        operationState: 'none',
        operationLocation: 'none',
        probeEvidence: probe.evidenceKind,
        unsupportedCanonical: [],
      };
    } else {
      assertWindowsSafetyTreeHasNoReparsePoints(workspace.path);
      const bootstrapping = await evaluateBootstrapState({ workspace, probe, fingerprint: before });
      logical = bootstrapping;
    }
  } else {
    if (!protocolRootExists) throw invalid('workspace marker exists without the permanent root');
    let bootstrapping: LogicalEvaluation | undefined;
    try {
      // A legal bootstrap file-install crash already has the marker target, but it still has two
      // controlled links. The ordinary ready reader rejects every hard link, so the bootstrap
      // observer must get the first chance to prove that exact owner-bound install window.
      bootstrapping = await evaluateBootstrapState({ workspace, probe, fingerprint: before });
    } catch {
      bootstrapping = undefined;
    }
    if (bootstrapping) {
      logical = bootstrapping;
    } else {
      const records = await readReadyWorkspaceRecords(workspace);
      const active = await readActiveLeaseOwner(records);
      if (!active) {
        const facts: WorkspaceSafetyFacts = {
          ...defaultFacts(),
          protocol: 'valid',
          marker: 'valid',
        };
        logical = {
          classification: classifyWorkspaceSafetyFacts(facts),
          facts,
          reason: 'none',
          operationState: 'none',
          operationLocation: 'none',
          probeEvidence: probe.evidenceKind,
          unsupportedCanonical: [],
        };
      } else if (active.owner.command === 'workspace-init') {
        const bootstrapping = await evaluateBootstrapState({
          workspace,
          probe,
          fingerprint: before,
        });
        logical = bootstrapping;
      } else {
        const observed = ownerObservation(active.owner, probe);
        const lease = await inspectActiveLease({
          records,
          owner: active.owner,
          ownerBytes: active.ownerBytes,
          ownerVerdict: observed.owner,
          now,
          probe,
        });
        const diskQuarantine = lease.quarantine?.record.reason ?? null;
        const operationProofMissing =
          lease.operation?.reason === 'operation-proof-missing' &&
          (observed.owner !== 'alive' || lease.operation.receiptBytes !== undefined);
        const quarantine =
          diskQuarantine === 'workspace-integrity-violation' ||
          diskQuarantine === 'operation-proof-missing'
            ? diskQuarantine
            : operationProofMissing
              ? 'operation-proof-missing'
              : diskQuarantine;
        const recoveryInputs = operationProofMissing
          ? 'insufficient'
          : lease.quarantineInstallIncomplete
            ? 'insufficient'
            : (lease.operation?.recoveryInputs ?? 'valid');
        const facts: WorkspaceSafetyFacts = {
          ...defaultFacts(),
          protocol: 'valid',
          marker: 'valid',
          lease: 'valid',
          recovery: lease.recovery ? 'valid' : 'absent',
          owner: observed.owner,
          containment: lease.operation?.containment ?? 'not-applicable',
          recoveryInputs,
          foreignHost: observed.foreignHost,
          quarantine,
        };
        logical = {
          classification: classifyWorkspaceSafetyFacts(facts),
          facts,
          reason: reasonForOwner({
            owner: observed.owner,
            foreignHost: observed.foreignHost,
            probeUnavailable: observed.probeUnavailable,
            operation: lease.operation,
            quarantineIncomplete: lease.quarantineInstallIncomplete,
            quarantine,
          }),
          operationState: lease.operation?.state ?? 'none',
          operationLocation: lease.operationLocation,
          probeEvidence: probe.evidenceKind,
          unsupportedCanonical: [],
        };
      }
    }
  }

  const after = await safetyFingerprint(workspace);
  if (before !== after) throw invalid('safety records changed during evaluation');
  if (protocolRootExists) {
    const rootInfo = await lstat(join(workspace.path, PROTOCOL_ROOT_DIR));
    if (!rootInfo.isSymbolicLink() && rootInfo.isDirectory()) {
      assertWindowsSafetyTreeHasNoReparsePoints(workspace.path);
    }
  }
  await assertWorkspaceDirectoryUnchanged(workspace);
  return { ...logical, safetyFingerprint: after };
}

function sameLogical(left: LogicalEvaluation, right: LogicalEvaluation): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function unstableProbeResult(
  first: LogicalEvaluation,
  second: LogicalEvaluation,
): WorkspaceSafetyDiskEvaluation {
  const invariant = (value: LogicalEvaluation) => ({
    safetyFingerprint: value.safetyFingerprint,
    canonical: value.facts.canonical,
    quarantine: value.facts.quarantine,
    recovery: value.facts.recovery,
    bootstrapLease: value.facts.bootstrapLease,
    legacyArtifacts: value.facts.legacyArtifacts,
    protocol: value.facts.protocol,
    marker: value.facts.marker,
    lease: value.facts.lease,
    directoryEmpty: value.facts.directoryEmpty,
    operationState: value.operationState,
    operationLocation: value.operationLocation,
    unsupportedCanonical: value.unsupportedCanonical,
  });
  if (JSON.stringify(invariant(first)) !== JSON.stringify(invariant(second))) {
    return {
      ...invalidEvaluation(
        second.probeEvidence,
        'disk-derived safety facts changed between the two complete reads',
      ),
      safetyFingerprint: second.safetyFingerprint,
    };
  }
  const facts: WorkspaceSafetyFacts = {
    ...second.facts,
    owner: second.facts.owner === 'absent' ? 'absent' : 'unknown',
    foreignHost: first.facts.foreignHost || second.facts.foreignHost,
    containment: second.facts.containment === 'not-applicable' ? 'not-applicable' : 'unknown',
    recoveryInputs: second.facts.owner === 'absent' ? second.facts.recoveryInputs : 'insufficient',
  };
  return {
    ...second,
    classification: classifyWorkspaceSafetyFacts(facts),
    facts,
    reason: 'unstable-probe',
    diagnostic: 'external identity or containment probe changed between stable disk reads',
  };
}

/**
 * Internal-only disk evaluator. It never mutates the workspace and deliberately has no CLI,
 * doctor, status, or report wiring in the dark foundation release.
 */
export async function evaluateWorkspaceSafetyDiskControlled(
  options: ControlledEvaluateWorkspaceSafetyDiskOptions,
): Promise<WorkspaceSafetyDiskEvaluation> {
  const probe = options.probe ?? defaultProbeAdapter();
  const now = options.now ?? (() => new Date());
  try {
    const first = await evaluateOnce(options.workspacePath, probe, now());
    const second = await evaluateOnce(options.workspacePath, probe, now());
    return sameLogical(first, second) ? second : unstableProbeResult(first, second);
  } catch (error) {
    const message = errorMessage(error);
    return invalidEvaluation(
      probe.evidenceKind,
      message,
      message.includes('unsupported-mutation-record') ? ['mutation'] : [],
    );
  }
}

export async function evaluateWorkspaceSafetyDisk(
  options: EvaluateWorkspaceSafetyDiskOptions,
): Promise<WorkspaceSafetyDiskEvaluation> {
  return await evaluateWorkspaceSafetyDiskControlled({ workspacePath: options.workspacePath });
}
