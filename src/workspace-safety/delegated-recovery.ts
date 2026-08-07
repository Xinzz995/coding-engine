import { readdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DelegatedSemanticCandidate } from '../contracts/delegated-operation-contract.js';
import { evaluateDelegatedDelta, type DelegatedBaseline } from './baseline.js';
import {
  digestBytes,
  jsonBytes,
  pathExists,
  readExactFile,
  type WorkspaceDirectory,
} from './filesystem.js';
import {
  classifySameHostRebootIdentity,
  captureExactCurrentIdentityAuthority,
  createIdentityProbe,
  createSystemIdentityAdapter,
} from './identity.js';
import {
  ACTIVE_CHILD_FILE,
  DELEGATED_BASELINE_FILE,
  DRAINED_RECEIPT_FILE,
  RECEIPT_STAGING_PATTERN,
  SETTLED_OPERATIONS_DIR,
  assertOrdinaryDirectory,
  parseActiveChildRecord,
  parseDelegatedBaselineRecord,
  readOperationInstalledFact,
  recoverOperationInstalledFact,
  settledOperationDirectoryName,
  type ArmedActiveChild,
} from './operation-records.js';
import { probePosixProcessGroup } from './posix-containment.js';
import {
  acquireRecoveryAttemptControlled,
  assertRecoveryRebootIdentityBeforeWrite,
  installRecoveryDomainControlled,
  type ControlledAcquireRecoveryAttemptOptions,
  type ControlledInstallRecoveryDomainOptions,
  type RecoveryAttemptHandle,
  type RecoveryModeAuthority,
} from './recovery-attempt.js';
import {
  loadRecoveryContext,
  readRecoveryDomainAtPath,
  type RecoveryContext,
  type RecoveryDomain,
} from './recovery-domain.js';
import {
  captureRecoverySourceFromRecords,
  createSourceOwnerProbe,
  requireDeadSourceOwner,
} from './recovery-source-snapshot.js';
import {
  assertExactContainmentQuarantine,
  createQuarantineRecordBytes,
  inspectQuarantinePresence,
  isQuarantineStagingName,
  parseQuarantineRecord,
  QUARANTINE_FILE,
  type ExactContainmentQuarantine,
  type QuarantineRecord,
} from './quarantine.js';
import { MAX_SAFETY_RECORD_BYTES } from './schema.js';
import {
  type DelegatedRecoveryOperationBinding,
  type RecoveryRebootProof,
} from './recovery-records.js';
import { parseDrainedReceipt, type DrainedReceipt } from './supervisor-protocol.js';
import {
  ACTIVE_LEASE_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  type IdentityVerdict,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  type QuarantineReason,
  WorkspaceSafetyError,
} from './types.js';

export type SupervisorDeathVerdict = 'dead' | 'alive' | 'unknown';
export type DelegatedContainmentVerdict = 'empty' | 'alive' | 'unknown';

export interface DelegatedRecoveryProbeOptions {
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly probeSupervisor?: (active: ArmedActiveChild) => SupervisorDeathVerdict;
  readonly probeContainment?: (
    active: ArmedActiveChild,
    receipt: DrainedReceipt,
  ) => DelegatedContainmentVerdict;
  /** Exact dark-only authority carried by the same-host reboot coordinator. */
  readonly expectedRebootQuarantine?: ExactContainmentQuarantine;
  /** Trusted coordinator revalidation; never exposed by the production wrapper. */
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

export interface ControlledInstallDelegatedFinalizeRecoveryOptions
  extends
    Omit<
      ControlledInstallRecoveryDomainOptions,
      'expectedSourceSnapshotDigest' | 'mode' | 'delegatedOperation'
    >,
    DelegatedRecoveryProbeOptions {
  readonly beforeReceiptSourceUnlink?: () => void | Promise<void>;
}

export interface InstallDelegatedFinalizeRecoveryOptions {
  readonly workspacePath: string;
}

export interface ControlledAcquireDelegatedFinalizeRecoveryOptions
  extends ControlledAcquireRecoveryAttemptOptions, DelegatedRecoveryProbeOptions {}

export interface AcquireDelegatedFinalizeRecoveryOptions {
  readonly workspacePath: string;
}

export interface DelegatedOperationSnapshot {
  readonly location: 'active' | 'settled';
  readonly operationPath: string;
  readonly settledPath: string;
  readonly baseline: DelegatedBaseline;
  readonly baselineBytes: Buffer;
  readonly active: ArmedActiveChild;
  readonly activeBytes: Buffer;
  readonly receipt: DrainedReceipt;
  readonly receiptBytes: Buffer;
  readonly linkedReceiptSource?: string;
  readonly quarantine?: QuarantineRecord;
  readonly quarantineBytes?: Buffer;
  readonly authorityFiles: readonly (readonly [string, Buffer])[];
  readonly binding: DelegatedRecoveryOperationBinding;
}

export interface DelegatedDeltaAcceptance {
  readonly candidate?: DelegatedSemanticCandidate;
  readonly candidateDigest: string | null;
}

export function invalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('invalid', `Invalid delegated recovery: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

export function isolated(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('isolated', `Delegated recovery is isolated: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function operationProofMissing(cause?: unknown): WorkspaceSafetyError {
  return isolated('operation-proof-missing', cause);
}

function assertSystemRebootAuthority(input: {
  readonly context: RecoveryContext;
  readonly identity: ProcessIdentitySnapshot;
  readonly proof: RecoveryRebootProof | null | undefined;
  readonly expected: ExactContainmentQuarantine | undefined;
}): void {
  if (!input.expected) return;
  const current = createIdentityProbe().current();
  if (!jsonBytes(current).equals(jsonBytes(input.identity))) {
    throw isolated('reboot attempt identity was not read from the current system');
  }
  if (
    classifySameHostRebootIdentity(input.context.sourceOwner, current) !==
      'same-host-boot-changed' ||
    !input.proof ||
    input.proof.hostId !== current.hostId ||
    input.proof.previousBootIdentity !== input.context.sourceOwner.bootIdentity ||
    input.proof.currentBootIdentity !== current.bootIdentity
  ) {
    throw isolated('reboot proof does not match current system identity');
  }
}

export function activeLeasePath(workspace: WorkspaceDirectory): string {
  return join(workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
}

function defaultSupervisorProbe(active: ArmedActiveChild): SupervisorDeathVerdict {
  try {
    const adapter = createSystemIdentityAdapter();
    const expectedPlatform =
      active.platform === 'windows-job-v1'
        ? 'win32'
        : process.platform === 'win32'
          ? null
          : process.platform;
    if (expectedPlatform === null || adapter.platform !== expectedPlatform) return 'unknown';
    const observed = adapter.readProcessIdentity(active.supervisorPid);
    if (observed.status === 'missing') return 'dead';
    if (observed.status === 'unknown') return 'unknown';
    if (observed.value !== active.supervisorIdentity) return 'dead';
    return adapter.platform === 'darwin' ? 'unknown' : 'alive';
  } catch {
    return 'unknown';
  }
}

function defaultContainmentProbe(
  active: ArmedActiveChild,
  receipt: DrainedReceipt,
): DelegatedContainmentVerdict {
  if (active.platform === 'posix-process-group-v1') {
    if (process.platform === 'win32') return 'unknown';
    if (active.containment.platform !== 'posix-process-group-v1') return 'unknown';
    return probePosixProcessGroup(active.containment.pgid);
  }
  if (process.platform !== 'win32') return 'unknown';
  return receipt.proof === 'windows-job-zero-and-pipes-eof-v1' ||
    receipt.proof === 'windows-job-zero-pipes-eof-output-settled-v2' ||
    receipt.proof === 'never-started-containment-empty-v1'
    ? 'empty'
    : 'unknown';
}

function assertReceiptBinding(input: {
  readonly context: RecoveryContext;
  readonly baseline: DelegatedBaseline;
  readonly baselineBytes: Buffer;
  readonly active: ArmedActiveChild;
  readonly activeBytes: Buffer;
  readonly receipt: DrainedReceipt;
  readonly ownerBytes: Buffer;
}): void {
  const { context, baseline, baselineBytes, active, activeBytes, receipt, ownerBytes } = input;
  if (
    baseline.ownerId !== context.sourceOwner.ownerId ||
    baseline.operationId !== active.operationId ||
    baseline.workspaceIdentity !== context.records.workspace.identity ||
    baseline.contract.version !== active.delegation ||
    baseline.contractDigest !== active.delegationContractDigest ||
    active.ownerId !== context.sourceOwner.ownerId ||
    active.delegatedBaselineDigest !== digestBytes(baselineBytes) ||
    receipt.ownerId !== context.sourceOwner.ownerId ||
    receipt.operationId !== active.operationId ||
    receipt.ownerRecordDigest !== digestBytes(ownerBytes) ||
    receipt.protocolDigest !== digestBytes(context.records.protocolBytes) ||
    receipt.activeChildDigest !== digestBytes(activeBytes) ||
    receipt.delegatedBaselineDigest !== digestBytes(baselineBytes) ||
    receipt.delegationContractDigest !== baseline.contractDigest ||
    receipt.containmentDigest !== active.containmentDigest ||
    receipt.helperDigest !== active.helperDigest ||
    receipt.supervisorIdentity !== active.supervisorIdentity
  ) {
    throw operationProofMissing();
  }
  if (
    (active.platform === 'posix-process-group-v1' &&
      (receipt.proof === 'windows-job-zero-and-pipes-eof-v1' ||
        receipt.proof === 'windows-job-zero-pipes-eof-output-settled-v2')) ||
    (active.platform === 'windows-job-v1' && receipt.proof === 'posix-group-empty-and-pipes-eof-v1')
  ) {
    throw operationProofMissing();
  }
}

function assertQuarantineBinding(
  quarantine: QuarantineRecord,
  context: RecoveryContext,
  snapshot: Omit<DelegatedOperationSnapshot, 'quarantine' | 'quarantineBytes'>,
  ownerBytes: Buffer,
  domain?: RecoveryDomain,
): void {
  const frozenBindingMismatch =
    quarantine.ownerId !== context.sourceOwner.ownerId ||
    quarantine.operationId !== snapshot.active.operationId ||
    quarantine.activeChildDigest !== digestBytes(snapshot.activeBytes) ||
    quarantine.delegatedBaselineDigest !== digestBytes(snapshot.baselineBytes);
  if (frozenBindingMismatch) {
    throw invalid('operation quarantine binding is invalid');
  }
  if (quarantine.creator.kind === 'owner') {
    if (
      quarantine.creator.id !== context.sourceOwner.ownerId ||
      quarantine.creator.recordDigest !== digestBytes(ownerBytes) ||
      quarantine.priorQuarantineDigest !== null ||
      quarantine.reason !== 'containment-unconfirmed'
    ) {
      throw invalid('owner quarantine binding is invalid');
    }
    return;
  }
  if (
    quarantine.reason !== 'workspace-integrity-violation' ||
    !domain?.attemptOwner ||
    !domain.attemptOwnerBytes ||
    quarantine.creator.id !== domain.attemptOwner.attemptId ||
    quarantine.creator.recordDigest !== digestBytes(domain.attemptOwnerBytes)
  ) {
    throw invalid('recovery quarantine binding is invalid');
  }
}

async function settledCandidatePath(
  activeLease: string,
  binding: DelegatedRecoveryOperationBinding,
): Promise<string | undefined> {
  const settledRoot = join(activeLease, SETTLED_OPERATIONS_DIR);
  if (!(await pathExists(settledRoot))) return undefined;
  await assertOrdinaryDirectory(settledRoot, SETTLED_OPERATIONS_DIR);
  const prefix = `${binding.operationId}-`;
  const matches = (await readdir(settledRoot)).filter((name) => name.startsWith(prefix));
  if (matches.length > 1) throw invalid('settled operation identity is ambiguous');
  return matches[0] ? join(settledRoot, matches[0]) : undefined;
}

async function readOperationAtPath(
  context: RecoveryContext,
  operationPath: string,
  location: DelegatedOperationSnapshot['location'],
  domain?: RecoveryDomain,
): Promise<DelegatedOperationSnapshot> {
  await assertOrdinaryDirectory(operationPath, `${location} delegated operation`);
  const names = (await readdir(operationPath)).sort();
  const allowed = new Set([
    ACTIVE_CHILD_FILE,
    DELEGATED_BASELINE_FILE,
    DRAINED_RECEIPT_FILE,
    QUARANTINE_FILE,
  ]);
  if (
    names.some(
      (name) =>
        !allowed.has(name) &&
        !(location === 'active' && RECEIPT_STAGING_PATTERN.test(name)) &&
        !isQuarantineStagingName(name),
    )
  ) {
    throw invalid(`${location} operation contains unknown or staged facts`);
  }
  if (!names.includes(ACTIVE_CHILD_FILE) || !names.includes(DELEGATED_BASELINE_FILE)) {
    throw invalid(`${location} operation is missing frozen active or baseline facts`);
  }
  const baselineBytes = await readExactFile(join(operationPath, DELEGATED_BASELINE_FILE));
  const baseline = parseDelegatedBaselineRecord(baselineBytes);
  const activeBytes = await readExactFile(join(operationPath, ACTIVE_CHILD_FILE));
  const parsedActive = parseActiveChildRecord(activeBytes);
  if (parsedActive.state !== 'armed') throw invalid('delegated-finalize requires armed state');
  let receiptBytes: Buffer;
  let receipt: DrainedReceipt;
  let linkedReceiptSource: string | undefined;
  try {
    const installedReceipt = await readOperationInstalledFact({
      operationPath,
      canonicalName: DRAINED_RECEIPT_FILE,
      stagingPattern: RECEIPT_STAGING_PATTERN,
      maxBytes: MAX_SAFETY_RECORD_BYTES,
    });
    receiptBytes = installedReceipt.bytes;
    linkedReceiptSource = installedReceipt.linkedSource;
    receipt = parseDrainedReceipt(receiptBytes);
  } catch (error) {
    throw operationProofMissing(error);
  }
  const ownerBytes = await readExactFile(join(dirname(context.recoveryPath), OWNER_FILE));
  assertReceiptBinding({
    context,
    baseline,
    baselineBytes,
    active: parsedActive,
    activeBytes,
    receipt,
    ownerBytes,
  });
  const authorityFiles: Array<readonly [string, Buffer]> = [
    [DELEGATED_BASELINE_FILE, baselineBytes],
    [ACTIVE_CHILD_FILE, activeBytes],
    [DRAINED_RECEIPT_FILE, receiptBytes],
  ];
  const binding: DelegatedRecoveryOperationBinding = {
    operationId: parsedActive.operationId,
    activeChildDigest: digestBytes(activeBytes),
    delegatedBaselineDigest: digestBytes(baselineBytes),
    drainedReceiptDigest: digestBytes(receiptBytes),
  };
  const settledRoot = join(dirname(context.recoveryPath), SETTLED_OPERATIONS_DIR);
  const settledPath = join(
    settledRoot,
    settledOperationDirectoryName(parsedActive.operationId, authorityFiles),
  );
  const baseSnapshot: DelegatedOperationSnapshot = {
    location,
    operationPath,
    settledPath,
    baseline,
    baselineBytes,
    active: parsedActive,
    activeBytes,
    receipt,
    receiptBytes,
    ...(linkedReceiptSource ? { linkedReceiptSource } : {}),
    authorityFiles,
    binding,
  };
  if (!names.includes(QUARANTINE_FILE)) return baseSnapshot;
  const quarantineBytes = await readExactFile(join(operationPath, QUARANTINE_FILE));
  const quarantine = parseQuarantineRecord(quarantineBytes);
  assertQuarantineBinding(quarantine, context, baseSnapshot, ownerBytes, domain);
  return {
    ...baseSnapshot,
    quarantine,
    quarantineBytes,
    authorityFiles: [...authorityFiles, [QUARANTINE_FILE, quarantineBytes]],
    settledPath: join(
      settledRoot,
      settledOperationDirectoryName(parsedActive.operationId, [
        ...authorityFiles,
        [QUARANTINE_FILE, quarantineBytes],
      ]),
    ),
  };
}

async function readDelegatedOperation(
  context: RecoveryContext,
  binding?: DelegatedRecoveryOperationBinding,
  domain?: RecoveryDomain,
): Promise<DelegatedOperationSnapshot> {
  const activeLease = dirname(context.recoveryPath);
  const canonical = join(activeLease, OPERATION_DIR);
  const hasCanonical = await pathExists(canonical);
  const settled = binding ? await settledCandidatePath(activeLease, binding) : undefined;
  if (hasCanonical && settled) throw invalid('delegated operation is both active and settled');
  if (!hasCanonical && !settled) throw invalid('delegated operation is missing');
  const snapshot = await readOperationAtPath(
    context,
    hasCanonical ? canonical : (settled as string),
    hasCanonical ? 'active' : 'settled',
    domain,
  );
  if (
    binding &&
    (snapshot.binding.operationId !== binding.operationId ||
      snapshot.binding.activeChildDigest !== binding.activeChildDigest ||
      snapshot.binding.delegatedBaselineDigest !== binding.delegatedBaselineDigest ||
      snapshot.binding.drainedReceiptDigest !== binding.drainedReceiptDigest)
  ) {
    throw invalid('delegated operation no longer matches the immutable recovery claim');
  }
  if (snapshot.location === 'settled' && snapshot.operationPath !== snapshot.settledPath) {
    if (
      snapshot.quarantine?.reason !== 'workspace-integrity-violation' ||
      snapshot.quarantine.creator.kind !== 'recovery-attempt'
    ) {
      throw invalid('settled operation path does not bind its complete authority digest');
    }
  }
  return snapshot;
}

export async function assertDelegatedLeaseShape(context: RecoveryContext): Promise<void> {
  const lease = activeLeasePath(context.records.workspace);
  if (await inspectQuarantinePresence(lease)) {
    throw isolated('active lease has a root quarantine');
  }
  const allowed = new Set([OWNER_FILE, OPERATION_DIR, SETTLED_OPERATIONS_DIR, 'recovery']);
  for (const name of await readdir(lease)) {
    if (
      allowed.has(name) ||
      /^operation\.prepare-/u.test(name) ||
      /^recovery\.prepare-/u.test(name) ||
      /^quarantine\.(?:prepare|upgrade)-/u.test(name)
    ) {
      continue;
    }
    throw invalid(`delegated-finalize cannot consume active lease entry ${name}`);
  }
}

export function assertExactDelegatedContainment(
  snapshot: DelegatedOperationSnapshot,
  probes: DelegatedRecoveryProbeOptions,
): void {
  const supervisor = (probes.probeSupervisor ?? defaultSupervisorProbe)(snapshot.active);
  if (supervisor !== 'dead') throw isolated(`supervisor is ${supervisor}, not exact dead`);
  const containment = (probes.probeContainment ?? defaultContainmentProbe)(
    snapshot.active,
    snapshot.receipt,
  );
  if (containment !== 'empty') throw isolated(`containment is ${containment}, not exact empty`);
}

export function assertRebootQuarantineAuthority(
  snapshot: DelegatedOperationSnapshot,
  probes: DelegatedRecoveryProbeOptions,
  domain?: RecoveryDomain,
): void {
  const expected = probes.expectedRebootQuarantine;
  if (!expected) {
    if (snapshot.quarantine?.reason === 'containment-unconfirmed') {
      throw isolated('containment-unconfirmed requires exact same-host reboot authority');
    }
    return;
  }
  if (!snapshot.quarantineBytes) {
    throw isolated('expected containment quarantine is missing');
  }
  assertExactContainmentQuarantine(expected, snapshot.quarantineBytes);
  if (domain && domain.claim.rebootProof === null) {
    throw invalid('containment recovery claim is missing rebootProof');
  }
}

export function sameSnapshot(
  left: DelegatedOperationSnapshot,
  right: DelegatedOperationSnapshot,
): boolean {
  return (
    left.location === right.location &&
    left.operationPath === right.operationPath &&
    left.settledPath === right.settledPath &&
    left.linkedReceiptSource === right.linkedReceiptSource &&
    JSON.stringify(left.binding) === JSON.stringify(right.binding) &&
    left.authorityFiles.length === right.authorityFiles.length &&
    left.authorityFiles.every(
      ([name, bytes], index) =>
        name === right.authorityFiles[index]?.[0] && bytes.equals(right.authorityFiles[index]?.[1]),
    )
  );
}

export async function readStableDelegatedOperation(
  context: RecoveryContext,
  binding?: DelegatedRecoveryOperationBinding,
  domain?: RecoveryDomain,
): Promise<DelegatedOperationSnapshot> {
  const first = await readDelegatedOperation(context, binding, domain);
  const second = await readDelegatedOperation(context, binding, domain);
  if (!sameSnapshot(first, second))
    throw invalid('delegated operation changed during recovery read');
  return second;
}

async function readEligibleDelegatedOperation(
  workspacePath: string,
  probes: DelegatedRecoveryProbeOptions,
): Promise<{ context: RecoveryContext; snapshot: DelegatedOperationSnapshot }> {
  await probes.verifySystemAuthority?.();
  const context = await loadRecoveryContext(workspacePath);
  const sourceOwnerProbe = createSourceOwnerProbe(probes.probeSourceOwner);
  requireDeadSourceOwner(context.sourceOwner, sourceOwnerProbe);
  await assertDelegatedLeaseShape(context);
  if (await pathExists(context.recoveryPath)) {
    throw new WorkspaceSafetyError('conflict', 'a canonical recovery domain already exists');
  }
  const snapshot = await readStableDelegatedOperation(context);
  assertRebootQuarantineAuthority(snapshot, probes);
  assertExactDelegatedContainment(snapshot, probes);
  return { context, snapshot };
}

async function collapseLinkedReceiptBeforeClaim(
  initialContext: RecoveryContext,
  initial: DelegatedOperationSnapshot,
  probes: DelegatedRecoveryProbeOptions,
  beforeSourceUnlink?: () => void | Promise<void>,
): Promise<void> {
  if (!initial.linkedReceiptSource) return;
  const sourceOwnerProbe = createSourceOwnerProbe(probes.probeSourceOwner);
  const linkedSource = initial.linkedReceiptSource;
  await recoverOperationInstalledFact({
    source: linkedSource,
    target: join(initial.operationPath, DRAINED_RECEIPT_FILE),
    expectedBytes: initial.receiptBytes,
    beforeSourceUnlink,
    authorize: async () => {
      await probes.verifySystemAuthority?.();
      const currentContext = await loadRecoveryContext(initialContext.records.workspace.path);
      requireDeadSourceOwner(currentContext.sourceOwner, sourceOwnerProbe);
      await assertDelegatedLeaseShape(currentContext);
      if (await pathExists(currentContext.recoveryPath)) {
        throw invalid('recovery appeared before receipt installation was closed');
      }
      const current = await readStableDelegatedOperation(currentContext, initial.binding);
      if (!sameSnapshot(initial, current) || current.linkedReceiptSource !== linkedSource) {
        throw invalid('controlled drained-receipt install pair changed');
      }
      assertExactDelegatedContainment(current, probes);
    },
  });
  const closed = await readStableDelegatedOperation(initialContext, initial.binding);
  if (closed.linkedReceiptSource) {
    throw invalid('drained-receipt install did not close its controlled link window');
  }
}

function delegatedAuthority(
  probes: DelegatedRecoveryProbeOptions,
  sourceOwnerProbe: (owner: OwnerRecord) => IdentityVerdict,
): RecoveryModeAuthority {
  return {
    mode: 'delegated-finalize',
    verifySource: async ({ context, domain, expectedSourceSnapshotDigest, phase }) => {
      await probes.verifySystemAuthority?.();
      requireDeadSourceOwner(context.sourceOwner, sourceOwnerProbe);
      await assertDelegatedLeaseShape(context);
      const binding = domain?.claim.delegatedOperation ?? undefined;
      const snapshot = await readStableDelegatedOperation(context, binding, domain);
      if (snapshot.linkedReceiptSource) {
        throw invalid('delegated recovery claim cannot retain receipt staging identity');
      }
      if (snapshot.quarantine?.reason === 'workspace-integrity-violation') {
        throw isolated('workspace-integrity-violation');
      }
      assertRebootQuarantineAuthority(snapshot, probes, domain);
      assertExactDelegatedContainment(snapshot, probes);
      const actual = await captureRecoverySourceFromRecords(context.records);
      if (snapshot.location === 'active') {
        if (actual !== expectedSourceSnapshotDigest) {
          throw invalid('active delegated source no longer matches the immutable claim');
        }
        return;
      }
      if (phase === 'before-install' || phase === 'before-commit' || phase === 'after-install') {
        throw invalid('a new delegated claim cannot start from an already-settled operation');
      }
      if (domain?.finalManifest && domain.finalManifest.finalSourceSnapshotDigest !== actual) {
        throw invalid('settled delegated source no longer matches the final manifest');
      }
    },
  };
}

/** @internal Authority-controlled read used by recovery coordinators and deterministic tests. */
export async function inspectDelegatedRecoveryEligibilityControlled(
  workspacePath: string,
  probes: DelegatedRecoveryProbeOptions = {},
): Promise<{ snapshot: DelegatedOperationSnapshot; sourceSnapshotDigest: string }> {
  const { context, snapshot } = await readEligibleDelegatedOperation(workspacePath, probes);
  if (snapshot.linkedReceiptSource) {
    throw invalid('drained receipt is still in its controlled install crash window');
  }
  return {
    snapshot,
    sourceSnapshotDigest: await captureRecoverySourceFromRecords(context.records),
  };
}

export async function inspectDelegatedRecoveryEligibility(
  workspacePath: string,
): Promise<{ snapshot: DelegatedOperationSnapshot; sourceSnapshotDigest: string }> {
  const system = captureExactCurrentIdentityAuthority();
  return await inspectDelegatedRecoveryEligibilityControlled(workspacePath, {
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

/** @internal Authority-controlled core. */
export async function installDelegatedFinalizeRecoveryControlled(
  options: ControlledInstallDelegatedFinalizeRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  const initial = await readEligibleDelegatedOperation(options.workspacePath, options);
  assertSystemRebootAuthority({
    context: initial.context,
    identity: options.identity,
    proof: options.rebootProof,
    expected: options.expectedRebootQuarantine,
  });
  if (options.expectedRebootQuarantine && !options.rebootProof) {
    throw invalid('exact containment authority requires rebootProof before claim installation');
  }
  assertRecoveryRebootIdentityBeforeWrite(
    options.rebootProof,
    initial.context.sourceOwner,
    options.identity,
  );
  await collapseLinkedReceiptBeforeClaim(
    initial.context,
    initial.snapshot,
    options,
    options.beforeReceiptSourceUnlink,
  );
  const inspected = await inspectDelegatedRecoveryEligibilityControlled(
    options.workspacePath,
    options,
  );
  const sourceOwnerProbe = createSourceOwnerProbe(options.probeSourceOwner);
  return await installRecoveryDomainControlled(
    {
      workspacePath: options.workspacePath,
      expectedSourceSnapshotDigest: inspected.sourceSnapshotDigest,
      recoveryId: options.recoveryId,
      attemptId: options.attemptId,
      identity: options.identity,
      mode: 'delegated-finalize',
      delegatedOperation: inspected.snapshot.binding,
      rebootProof: options.rebootProof,
      now: options.now,
      probeSourceOwner: options.probeSourceOwner,
      hooks: options.hooks,
      verifySystemAuthority: options.verifySystemAuthority,
    },
    delegatedAuthority(options, sourceOwnerProbe),
  );
}

export async function installDelegatedFinalizeRecovery(
  options: InstallDelegatedFinalizeRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await installDelegatedFinalizeRecoveryControlled({
    workspacePath: options.workspacePath,
    identity: system.identity,
    rebootProof: null,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

/** @internal Authority-controlled core. */
export async function acquireDelegatedFinalizeRecoveryControlled(
  options: ControlledAcquireDelegatedFinalizeRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  if (options.expectedRebootQuarantine) {
    const context = await loadRecoveryContext(options.workspacePath);
    const domain = await readRecoveryDomainAtPath(
      context.records,
      context.sourceOwner,
      context.recoveryPath,
    );
    assertSystemRebootAuthority({
      context,
      identity: options.identity,
      proof: domain.claim.rebootProof,
      expected: options.expectedRebootQuarantine,
    });
  }
  const sourceOwnerProbe = createSourceOwnerProbe(options.probeSourceOwner);
  return await acquireRecoveryAttemptControlled(
    options,
    delegatedAuthority(options, sourceOwnerProbe),
  );
}

export async function acquireDelegatedFinalizeRecovery(
  options: AcquireDelegatedFinalizeRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await acquireDelegatedFinalizeRecoveryControlled({
    workspacePath: options.workspacePath,
    identity: system.identity,
    probeSourceOwner: system.probeOwner,
    probeAttemptOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

export function evaluateDelegatedRecoveryDelta(
  workspacePath: string,
  snapshot: DelegatedOperationSnapshot,
): DelegatedDeltaAcceptance {
  const result = evaluateDelegatedDelta(workspacePath, snapshot.baseline, {
    requireUnchanged: snapshot.receipt.proof === 'never-started-containment-empty-v1',
  });
  if (!result.accepted) throw isolated('workspace-integrity-violation');
  if (!result.candidate) return { candidateDigest: null };
  return {
    candidate: result.candidate,
    candidateDigest: digestBytes(jsonBytes(result.candidate)),
  };
}

export function createRecoveryIntegrityQuarantineBytes(input: {
  readonly context: RecoveryContext;
  readonly domain: RecoveryDomain;
  readonly snapshot: DelegatedOperationSnapshot;
  readonly reason?: Extract<QuarantineReason, 'workspace-integrity-violation'>;
  readonly createdAt: Date;
}): Buffer {
  const attemptBytes = input.domain.attemptOwnerBytes;
  if (!attemptBytes || input.domain.attemptOwner?.attemptId === undefined) {
    throw invalid('integrity quarantine requires the active recovery attempt');
  }
  return createQuarantineRecordBytes({
    ownerId: input.context.sourceOwner.ownerId,
    operationId: input.snapshot.active.operationId,
    activeChildDigest: digestBytes(input.snapshot.activeBytes),
    delegatedBaselineDigest: digestBytes(input.snapshot.baselineBytes),
    creator: {
      kind: 'recovery-attempt',
      id: input.domain.attemptOwner.attemptId,
      recordDigest: digestBytes(attemptBytes),
    },
    reason: input.reason ?? 'workspace-integrity-violation',
    priorQuarantineDigest: input.snapshot.quarantineBytes
      ? digestBytes(input.snapshot.quarantineBytes)
      : null,
    createdAt: input.createdAt,
  });
}

export {
  finalizeDelegatedRecovery,
  verifyDelegatedRecoveryArchive,
} from './delegated-recovery-finalize.js';
export type {
  DelegatedRecoveryCompletion,
  FinalizeDelegatedRecoveryOptions,
  VerifyDelegatedRecoveryArchiveOptions,
} from './delegated-recovery-finalize.js';
