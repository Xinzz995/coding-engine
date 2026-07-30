import { lstat, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';
import type { DelegatedBaseline } from './baseline.js';
import {
  digestBytes,
  jsonBytes,
  pathExists,
  readExactFile,
  type WorkspaceDirectory,
} from './filesystem.js';
import { readFixedPlatformHelperBundle } from './fixed-platform-helper.js';
import {
  classifySameHostRebootIdentity,
  captureExactCurrentIdentityAuthority,
  createIdentityProbe,
  createSystemIdentityAdapter,
} from './identity.js';
import {
  ACTIVE_CHILD_FILE,
  ABORT_STAGING_PATTERN,
  DELEGATED_BASELINE_FILE,
  PRESTART_ABORT_FILE,
  PRESTART_ABORT_SCHEMA_VERSION,
  SETTLED_OPERATIONS_DIR,
  assertOrdinaryDirectory,
  parseActiveChildRecord,
  parseDelegatedBaselineRecord,
  parsePrestartAbortRecord,
  readOperationInstalledFact,
  settledOperationDirectoryName,
  type PreparedActiveChild,
  type PreparedBoundActiveChild,
  type PrestartAbortRecord,
} from './operation-records.js';
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
  type RecoveryContext,
  type RecoveryDomain,
} from './recovery-domain.js';
import type { PrestartRecoveryOperationBinding, RecoveryRebootProof } from './recovery-records.js';
import {
  captureRecoverySourceFromRecords,
  createSourceOwnerProbe,
  requireDeadSourceOwner,
} from './recovery-source-snapshot.js';
import {
  assertExactContainmentQuarantine,
  inspectQuarantinePresence,
  isQuarantineStagingName,
  readQuarantinePresence,
  QUARANTINE_FILE,
  type ExactContainmentQuarantine,
  type QuarantineRecord,
} from './quarantine.js';
import { MAX_SAFETY_RECORD_BYTES } from './schema.js';
import {
  ACTIVE_LEASE_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  type IdentityVerdict,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  WorkspaceSafetyError,
} from './types.js';

type PrestartActive = PreparedActiveChild | PreparedBoundActiveChild;
export type PrestartSupervisorVerdict = 'never-created' | 'dead' | 'alive' | 'unknown';

export interface PrestartRecoveryProbeOptions {
  readonly helperBytes: Uint8Array;
  readonly probeSourceOwner?: (owner: OwnerRecord) => IdentityVerdict;
  readonly probeSupervisor?: (active: PrestartActive) => PrestartSupervisorVerdict;
  /** Exact dark-only authority carried by the same-host reboot coordinator. */
  readonly expectedRebootQuarantine?: ExactContainmentQuarantine;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

export type InspectPrestartRecoveryOptions = undefined;

export interface ControlledInstallPrestartRecoveryOptions
  extends
    Omit<
      ControlledInstallRecoveryDomainOptions,
      'expectedSourceSnapshotDigest' | 'mode' | 'delegatedOperation' | 'prestartOperation'
    >,
    PrestartRecoveryProbeOptions {}

export interface InstallPrestartRecoveryOptions {
  readonly workspacePath: string;
}

export interface ControlledAcquirePrestartRecoveryOptions
  extends ControlledAcquireRecoveryAttemptOptions, PrestartRecoveryProbeOptions {}

export interface AcquirePrestartRecoveryOptions {
  readonly workspacePath: string;
}

export interface PrestartOperationSnapshot {
  readonly location: 'active' | 'settled';
  readonly operationPath: string;
  readonly baseline: DelegatedBaseline;
  readonly baselineBytes: Buffer;
  readonly active: PrestartActive;
  readonly activeBytes: Buffer;
  readonly abort?: PrestartAbortRecord;
  readonly abortBytes?: Buffer;
  readonly linkedAbortSource?: string;
  readonly inertAbortSources: readonly { readonly path: string; readonly bytes: Buffer }[];
  readonly settledPath?: string;
  readonly quarantine?: QuarantineRecord;
  readonly quarantineBytes?: Buffer;
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

function defaultSupervisorProbe(active: PrestartActive): PrestartSupervisorVerdict {
  if (active.state === 'prepared') return 'unknown';
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

function assertExactPrestartProof(
  snapshot: PrestartOperationSnapshot,
  probes: PrestartRecoveryProbeOptions,
): void {
  if (snapshot.active.state === 'prepared') {
    // DATA and START are both unreachable until prepared-bound is committed. The canonical
    // prepared record is therefore the complete durable proof; an unbound fixed helper cannot
    // execute project code.
    return;
  }
  const supervisor = (probes.probeSupervisor ?? defaultSupervisorProbe)(snapshot.active);
  if (supervisor !== 'dead') {
    throw isolated(`prepared-bound supervisor is ${supervisor}, not exact dead`);
  }
}

function assertCoreBindings(context: RecoveryContext, snapshot: PrestartOperationSnapshot): void {
  const { active, activeBytes, baseline, baselineBytes } = snapshot;
  if (
    active.ownerId !== context.sourceOwner.ownerId ||
    baseline.ownerId !== context.sourceOwner.ownerId ||
    baseline.operationId !== active.operationId ||
    baseline.workspaceIdentity !== context.records.workspace.identity ||
    baseline.contract.version !== active.delegation ||
    baseline.contractDigest !== active.delegationContractDigest ||
    active.delegatedBaselineDigest !== digestBytes(baselineBytes)
  ) {
    throw invalid('owner, workspace, operation, baseline, or delegation binding mismatch');
  }
  if (snapshot.abort) {
    if (
      snapshot.abort.ownerId !== active.ownerId ||
      snapshot.abort.operationId !== active.operationId ||
      snapshot.abort.activeChildDigest !== digestBytes(activeBytes) ||
      snapshot.abort.delegatedBaselineDigest !== digestBytes(baselineBytes) ||
      (active.state === 'prepared' &&
        (snapshot.abort.proof !== 'supervisor-never-bound-v1' ||
          snapshot.abort.prestartDrainedDigest !== null)) ||
      (active.state === 'prepared-bound' &&
        !(
          (snapshot.abort.proof === 'supervisor-prestart-empty-v1' &&
            snapshot.abort.prestartDrainedDigest !== null) ||
          (snapshot.abort.proof === 'recovery-supervisor-exact-dead-never-armed-v1' &&
            snapshot.abort.prestartDrainedDigest === null)
        ))
    ) {
      throw invalid('prestart abort does not bind the frozen operation');
    }
  }
}

async function readOperationAtPath(
  context: RecoveryContext,
  operationPath: string,
  location: PrestartOperationSnapshot['location'],
): Promise<PrestartOperationSnapshot> {
  await assertOrdinaryDirectory(operationPath, `${location} prestart operation`);
  const names = (await readdir(operationPath)).sort();
  const allowed = new Set([
    ACTIVE_CHILD_FILE,
    DELEGATED_BASELINE_FILE,
    PRESTART_ABORT_FILE,
    QUARANTINE_FILE,
  ]);
  if (
    names.some(
      (name) =>
        !allowed.has(name) &&
        !(
          location === 'active' &&
          (ABORT_STAGING_PATTERN.test(name) || isQuarantineStagingName(name))
        ),
    )
  ) {
    throw invalid(`${location} prestart operation contains unknown facts`);
  }
  const baselineBytes = await readExactFile(join(operationPath, DELEGATED_BASELINE_FILE));
  const baseline = parseDelegatedBaselineRecord(baselineBytes);
  const activeBytes = await readExactFile(join(operationPath, ACTIVE_CHILD_FILE));
  const parsed = parseActiveChildRecord(activeBytes);
  if (parsed.state === 'armed') throw isolated('armed operation requires delegated-finalize');
  const base: PrestartOperationSnapshot = {
    location,
    operationPath,
    baseline,
    baselineBytes,
    active: parsed,
    activeBytes,
    inertAbortSources: [],
  };
  const stagingNames = names.filter((name) => ABORT_STAGING_PATTERN.test(name));
  if (location === 'settled' && stagingNames.length !== 0) {
    throw invalid('settled prestart operation retains abort staging');
  }
  if (!names.includes(PRESTART_ABORT_FILE)) {
    const inertAbortSources: Array<{ readonly path: string; readonly bytes: Buffer }> = [];
    for (const name of stagingNames) {
      const path = join(operationPath, name);
      const info = await lstat(path, { bigint: true });
      if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
        throw invalid('orphan prestart abort staging is not one ordinary unlinked file');
      }
      const bytes = await readExactFile(path);
      if (bytes.byteLength > MAX_SAFETY_RECORD_BYTES) {
        throw invalid('orphan prestart abort staging exceeds its byte bound');
      }
      inertAbortSources.push({ path, bytes });
    }
    const withoutAbort = await withOperationQuarantine(context, {
      ...base,
      inertAbortSources,
    });
    assertCoreBindings(context, withoutAbort);
    return withoutAbort;
  }
  const fact = await readOperationInstalledFact({
    operationPath,
    canonicalName: PRESTART_ABORT_FILE,
    stagingPattern: ABORT_STAGING_PATTERN,
    maxBytes: MAX_SAFETY_RECORD_BYTES,
  });
  const withAbort = await withOperationQuarantine(context, {
    ...base,
    abort: parsePrestartAbortRecord(fact.bytes),
    abortBytes: fact.bytes,
    ...(fact.linkedSource ? { linkedAbortSource: fact.linkedSource } : {}),
    inertAbortSources: await Promise.all(
      stagingNames
        .map((name) => join(operationPath, name))
        .filter((path) => path !== fact.linkedSource)
        .map(async (path) => {
          const info = await lstat(path, { bigint: true });
          if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
            throw invalid('extra abort staging is not one ordinary unlinked file');
          }
          return { path, bytes: await readExactFile(path) };
        }),
    ),
  });
  assertCoreBindings(context, withAbort);
  return withAbort;
}

async function withOperationQuarantine(
  context: RecoveryContext,
  snapshot: PrestartOperationSnapshot,
): Promise<PrestartOperationSnapshot> {
  const presence = await readQuarantinePresence(snapshot.operationPath);
  if (!presence.canonical) return snapshot;
  const ownerBytes = await readExactFile(
    join(activeLeasePath(context.records.workspace), OWNER_FILE),
  );
  const quarantine = presence.canonical.record;
  if (
    quarantine.ownerId !== context.sourceOwner.ownerId ||
    quarantine.operationId !== snapshot.active.operationId ||
    quarantine.activeChildDigest !== digestBytes(snapshot.activeBytes) ||
    quarantine.delegatedBaselineDigest !== digestBytes(snapshot.baselineBytes) ||
    (quarantine.creator.kind === 'owner' &&
      (quarantine.creator.id !== context.sourceOwner.ownerId ||
        quarantine.creator.recordDigest !== digestBytes(ownerBytes)))
  ) {
    throw invalid('operation quarantine does not bind owner, operation, active, and baseline');
  }
  return {
    ...snapshot,
    quarantine,
    quarantineBytes: presence.canonical.bytes,
  };
}

async function settledCandidate(
  context: RecoveryContext,
  operationId: string,
): Promise<string | undefined> {
  const root = join(activeLeasePath(context.records.workspace), SETTLED_OPERATIONS_DIR);
  if (!(await pathExists(root))) return undefined;
  await assertOrdinaryDirectory(root, SETTLED_OPERATIONS_DIR);
  const matches = (await readdir(root)).filter((name) => name.startsWith(`${operationId}-`));
  if (matches.length > 1) throw invalid('settled prestart operation identity is ambiguous');
  return matches[0] ? join(root, matches[0]) : undefined;
}

async function readPrestartOperation(
  context: RecoveryContext,
  binding?: PrestartRecoveryOperationBinding,
): Promise<PrestartOperationSnapshot> {
  const canonical = join(activeLeasePath(context.records.workspace), OPERATION_DIR);
  const activeExists = await pathExists(canonical);
  const settled = binding ? await settledCandidate(context, binding.operationId) : undefined;
  if (activeExists && settled) throw invalid('prestart operation is both active and settled');
  if (!activeExists && !settled) throw invalid('prestart operation is missing');
  const snapshot = await readOperationAtPath(
    context,
    activeExists ? canonical : (settled as string),
    activeExists ? 'active' : 'settled',
  );
  return snapshot;
}

export function expectedAbortBytes(
  domain: RecoveryDomain,
  snapshot: PrestartOperationSnapshot,
): Buffer {
  const record: PrestartAbortRecord = {
    schemaVersion: PRESTART_ABORT_SCHEMA_VERSION,
    ownerId: snapshot.active.ownerId,
    operationId: snapshot.active.operationId,
    activeChildDigest: digestBytes(snapshot.activeBytes),
    delegatedBaselineDigest: digestBytes(snapshot.baselineBytes),
    reason: 'setup-failed',
    proof:
      snapshot.active.state === 'prepared'
        ? 'supervisor-never-bound-v1'
        : 'recovery-supervisor-exact-dead-never-armed-v1',
    prestartDrainedDigest: null,
    abortedAt: domain.claim.createdAt,
  };
  const bytes = jsonBytes(record);
  parsePrestartAbortRecord(bytes);
  return bytes;
}

function authorityFiles(
  snapshot: PrestartOperationSnapshot,
): readonly (readonly [string, Buffer])[] {
  if (!snapshot.abortBytes) throw invalid('settlement requires an exact prestart abort');
  const files: Array<readonly [string, Buffer]> = [
    [DELEGATED_BASELINE_FILE, snapshot.baselineBytes],
    [ACTIVE_CHILD_FILE, snapshot.activeBytes],
    [PRESTART_ABORT_FILE, snapshot.abortBytes],
  ];
  if (snapshot.quarantineBytes) files.push([QUARANTINE_FILE, snapshot.quarantineBytes]);
  return files;
}

export function deterministicSettledPath(
  context: RecoveryContext,
  snapshot: PrestartOperationSnapshot,
): string {
  return join(
    activeLeasePath(context.records.workspace),
    SETTLED_OPERATIONS_DIR,
    settledOperationDirectoryName(snapshot.active.operationId, authorityFiles(snapshot)),
  );
}

function createClaimBinding(
  snapshot: PrestartOperationSnapshot,
  helperBytes: Uint8Array,
): PrestartRecoveryOperationBinding {
  const helperDigest = digestBytes(helperBytes);
  if (helperDigest !== snapshot.active.helperDigest) {
    throw isolated('fixed helper digest does not match the frozen operation');
  }
  return {
    kind: 'prestart-operation-v1',
    operationId: snapshot.active.operationId,
    activeState: snapshot.active.state,
    proof:
      snapshot.active.state === 'prepared'
        ? 'canonical-prepared-start-never-authorized-v1'
        : 'supervisor-exact-dead-never-armed-v1',
    activeChildDigest: digestBytes(snapshot.activeBytes),
    delegatedBaselineDigest: digestBytes(snapshot.baselineBytes),
    helperDigest,
    prestartDrainedDigest: null,
    existingAbortDigest: snapshot.abortBytes ? digestBytes(snapshot.abortBytes) : null,
  };
}

export async function assertLeaseShape(context: RecoveryContext): Promise<void> {
  const lease = activeLeasePath(context.records.workspace);
  if (await inspectQuarantinePresence(lease)) throw isolated('active lease is quarantined');
  const allowed = new Set([OWNER_FILE, OPERATION_DIR, SETTLED_OPERATIONS_DIR, RECOVERY_DIR]);
  for (const name of await readdir(lease)) {
    if (
      allowed.has(name) ||
      /^operation\.prepare-/u.test(name) ||
      /^recovery\.prepare-/u.test(name) ||
      isQuarantineStagingName(name)
    ) {
      continue;
    }
    throw invalid(`prestart recovery cannot consume active lease entry ${name}`);
  }
}

async function scanFrozenPrestartTree(
  context: RecoveryContext,
  excludedOperationPath: string,
): Promise<string> {
  const root = join(context.records.workspace.path, PROTOCOL_ROOT_DIR);
  const excluded = relative(root, excludedOperationPath).replaceAll('\\', '/');
  const observations: string[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const names = (await readdir(directory)).sort();
    for (const name of names) {
      const rel = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (
        rel === excluded ||
        rel === `${ACTIVE_LEASE_DIR}/${RECOVERY_DIR}` ||
        (relativeDirectory === ACTIVE_LEASE_DIR && /^recovery\.prepare-/u.test(name)) ||
        (relativeDirectory === ACTIVE_LEASE_DIR && /^operation\.prepare-/u.test(name)) ||
        (relativeDirectory === ACTIVE_LEASE_DIR && isQuarantineStagingName(name))
      ) {
        continue;
      }
      const path = join(directory, name);
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw invalid(`frozen safety path is a symlink: ${rel}`);
      if (info.isDirectory()) {
        observations.push(`directory\0${rel}`);
        await walk(path, rel);
      } else if (info.isFile()) {
        observations.push(`file\0${rel}\0${digestBytes(await readExactFile(path))}`);
      } else {
        throw invalid(`frozen safety path has an unsupported type: ${rel}`);
      }
    }
  };
  await walk(root, '');
  return digestBytes(Buffer.from(observations.join('\n'), 'utf8'));
}

export async function originalSourceDigest(
  context: RecoveryContext,
  snapshot: PrestartOperationSnapshot,
  binding: PrestartRecoveryOperationBinding,
): Promise<string> {
  const frozenFirst = await scanFrozenPrestartTree(context, snapshot.operationPath);
  const frozenSecond = await scanFrozenPrestartTree(context, snapshot.operationPath);
  if (frozenFirst !== frozenSecond) throw invalid('frozen prestart source changed during read');
  const ownerBytes = await readExactFile(
    join(activeLeasePath(context.records.workspace), OWNER_FILE),
  );
  const existingAbortBytes =
    binding.existingAbortDigest === null ? null : (snapshot.abortBytes ?? null);
  if (
    existingAbortBytes !== null &&
    digestBytes(existingAbortBytes) !== binding.existingAbortDigest
  ) {
    throw invalid('existing prestart abort no longer matches the immutable claim');
  }
  return digestBytes(
    jsonBytes({
      schemaVersion: 1,
      domain: 'coding-x-prestart-recovery-source-v1',
      markerDigest: digestBytes(context.records.markerBytes),
      protocolDigest: digestBytes(context.records.protocolBytes),
      ownerDigest: digestBytes(ownerBytes),
      frozenSafetyTreeDigest: frozenFirst,
      operation: binding,
      existingAbortDigest: existingAbortBytes ? digestBytes(existingAbortBytes) : null,
      quarantineDigest: snapshot.quarantineBytes ? digestBytes(snapshot.quarantineBytes) : null,
    }),
  );
}

export function sameSnapshot(
  left: PrestartOperationSnapshot,
  right: PrestartOperationSnapshot,
): boolean {
  const sameAbort =
    (left.abortBytes === undefined && right.abortBytes === undefined) ||
    (left.abortBytes !== undefined &&
      right.abortBytes !== undefined &&
      left.abortBytes.equals(right.abortBytes));
  const sameInert =
    left.inertAbortSources.length === right.inertAbortSources.length &&
    left.inertAbortSources.every(
      (entry, index) =>
        entry.path === right.inertAbortSources[index]?.path &&
        entry.bytes.equals(right.inertAbortSources[index]?.bytes),
    );
  const sameQuarantine =
    (left.quarantineBytes === undefined && right.quarantineBytes === undefined) ||
    (left.quarantineBytes !== undefined &&
      right.quarantineBytes !== undefined &&
      left.quarantineBytes.equals(right.quarantineBytes));
  return (
    left.location === right.location &&
    left.operationPath === right.operationPath &&
    left.activeBytes.equals(right.activeBytes) &&
    left.baselineBytes.equals(right.baselineBytes) &&
    sameAbort &&
    sameInert &&
    left.linkedAbortSource === right.linkedAbortSource &&
    sameQuarantine
  );
}

export async function readStableSnapshot(
  context: RecoveryContext,
  binding?: PrestartRecoveryOperationBinding,
  domain?: RecoveryDomain,
): Promise<PrestartOperationSnapshot> {
  const first = await readPrestartOperation(context, binding);
  const second = await readPrestartOperation(context, binding);
  if (!sameSnapshot(first, second)) throw invalid('prestart operation changed during stable read');
  if (domain && second.quarantine?.creator.kind === 'recovery-attempt') {
    if (
      !domain.attemptOwner ||
      !domain.attemptOwnerBytes ||
      second.quarantine.creator.id !== domain.attemptOwner.attemptId ||
      second.quarantine.creator.recordDigest !== digestBytes(domain.attemptOwnerBytes)
    ) {
      throw invalid('recovery quarantine does not bind the active recovery attempt');
    }
  }
  return second;
}

export function assertPrestartRebootQuarantineAuthority(
  snapshot: PrestartOperationSnapshot,
  probes: PrestartRecoveryProbeOptions,
  domain?: RecoveryDomain,
): void {
  const expected = probes.expectedRebootQuarantine;
  if (!expected) {
    if (snapshot.quarantine) throw isolated(snapshot.quarantine.reason);
    return;
  }
  if (!snapshot.quarantineBytes) throw isolated('expected containment quarantine is missing');
  assertExactContainmentQuarantine(expected, snapshot.quarantineBytes);
  if (domain && domain.claim.rebootProof === null) {
    throw invalid('containment recovery claim is missing rebootProof');
  }
}

export function assertClaimBinding(
  context: RecoveryContext,
  domain: RecoveryDomain | undefined,
  expected: PrestartRecoveryOperationBinding,
  snapshot: PrestartOperationSnapshot,
  probes: PrestartRecoveryProbeOptions,
): void {
  assertPrestartRebootQuarantineAuthority(snapshot, probes, domain);
  const actual = domain?.claim.prestartOperation ?? expected;
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw invalid('prestart operation claim binding changed');
  }
  if (
    snapshot.active.operationId !== actual.operationId ||
    snapshot.active.state !== actual.activeState ||
    digestBytes(snapshot.activeBytes) !== actual.activeChildDigest ||
    digestBytes(snapshot.baselineBytes) !== actual.delegatedBaselineDigest ||
    snapshot.active.helperDigest !== actual.helperDigest ||
    digestBytes(probes.helperBytes) !== actual.helperDigest
  ) {
    throw invalid('prestart operation no longer matches the immutable claim');
  }
  assertExactPrestartProof(snapshot, probes);
  if (actual.prestartDrainedDigest !== null) {
    throw invalid('prestart recovery cannot depend on caller-supplied drained bytes');
  }
  if (actual.existingAbortDigest !== null) {
    if (!snapshot.abortBytes || digestBytes(snapshot.abortBytes) !== actual.existingAbortDigest) {
      throw invalid('existing abort no longer matches the immutable claim');
    }
  } else if (snapshot.abortBytes && domain) {
    const expectedAbort = expectedAbortBytes(domain, snapshot);
    if (!snapshot.abortBytes.equals(expectedAbort)) {
      throw invalid('recovery-authored abort is not deterministic');
    }
  } else if (snapshot.abortBytes) {
    throw invalid('an abort appeared before the recovery claim');
  }
  if (snapshot.inertAbortSources.length !== 0) {
    if (!domain || actual.existingAbortDigest !== null || snapshot.location !== 'active') {
      throw invalid('orphan abort staging is outside the recovery-authored install window');
    }
    const expectedAbort = expectedAbortBytes(domain, snapshot);
    if (snapshot.inertAbortSources.some((entry) => !entry.bytes.equals(expectedAbort))) {
      throw invalid('orphan abort staging does not match deterministic recovery bytes');
    }
  }
  if (snapshot.location === 'settled') {
    if (snapshot.linkedAbortSource)
      throw invalid('settled operation retained an abort link window');
    const target = deterministicSettledPath(context, snapshot);
    if (snapshot.operationPath !== target) {
      throw invalid('settled operation path does not bind its complete authority digest');
    }
  }
}

function prestartAuthority(
  probes: PrestartRecoveryProbeOptions,
  expectedBinding: PrestartRecoveryOperationBinding,
): RecoveryModeAuthority {
  return {
    mode: 'mechanical-empty',
    verifySource: async ({ context, domain, expectedSourceSnapshotDigest, phase }) => {
      await probes.verifySystemAuthority?.();
      requireDeadSourceOwner(context.sourceOwner, createSourceOwnerProbe(probes.probeSourceOwner));
      await assertLeaseShape(context);
      const binding = domain?.claim.prestartOperation;
      if (domain && binding === null) throw invalid('mechanical claim lost its prestart binding');
      const snapshot = await readStableSnapshot(context, binding ?? expectedBinding, domain);
      assertClaimBinding(context, domain, expectedBinding, snapshot, probes);
      if (
        snapshot.location === 'settled' &&
        (phase === 'before-install' || phase === 'before-commit' || phase === 'after-install')
      ) {
        throw invalid('a new prestart claim cannot begin from settled history');
      }
      const reconstructed = await originalSourceDigest(
        context,
        snapshot,
        binding ?? expectedBinding,
      );
      if (reconstructed !== expectedSourceSnapshotDigest) {
        throw invalid('prestart source no longer reconstructs the immutable claim');
      }
      if (snapshot.location === 'active' && domain && domain.state.phase !== 'claimed') {
        throw invalid('advanced recovery state still has an active prestart operation');
      }
      if (snapshot.location === 'settled' && domain?.finalManifest) {
        const current = await captureRecoverySourceFromRecords(context.records);
        if (domain.finalManifest.finalSourceSnapshotDigest !== current) {
          throw invalid('settled prestart source no longer matches the final manifest');
        }
      }
    },
  };
}

async function initialEligibility(
  options: PrestartRecoveryProbeOptions & { readonly workspacePath: string },
): Promise<{
  context: RecoveryContext;
  snapshot: PrestartOperationSnapshot;
  binding: PrestartRecoveryOperationBinding;
  sourceSnapshotDigest: string;
}> {
  await options.verifySystemAuthority?.();
  const context = await loadRecoveryContext(options.workspacePath);
  requireDeadSourceOwner(context.sourceOwner, createSourceOwnerProbe(options.probeSourceOwner));
  await assertLeaseShape(context);
  if (await pathExists(context.recoveryPath)) {
    throw new WorkspaceSafetyError('conflict', 'a canonical recovery domain already exists');
  }
  const snapshot = await readStableSnapshot(context);
  assertPrestartRebootQuarantineAuthority(snapshot, options);
  if (snapshot.location !== 'active') throw invalid('new prestart claim requires active operation');
  assertExactPrestartProof(snapshot, options);
  const binding = createClaimBinding(snapshot, options.helperBytes);
  const sourceSnapshotDigest = await originalSourceDigest(context, snapshot, binding);
  return { context, snapshot, binding, sourceSnapshotDigest };
}

/** @internal Authority-controlled read used by recovery coordinators and deterministic tests. */
export async function inspectPrestartRecoveryEligibilityControlled(
  workspacePath: string,
  probes: PrestartRecoveryProbeOptions,
): Promise<{ binding: PrestartRecoveryOperationBinding; sourceSnapshotDigest: string }> {
  const inspected = await initialEligibility({ workspacePath, ...probes });
  return { binding: inspected.binding, sourceSnapshotDigest: inspected.sourceSnapshotDigest };
}

export async function inspectPrestartRecoveryEligibility(
  workspacePath: string,
): Promise<{ binding: PrestartRecoveryOperationBinding; sourceSnapshotDigest: string }> {
  const system = captureExactCurrentIdentityAuthority();
  return await inspectPrestartRecoveryEligibilityControlled(workspacePath, {
    helperBytes: readFixedPlatformHelperBundle(),
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

/** @internal Authority-controlled core. */
export async function installPrestartRecoveryControlled(
  options: ControlledInstallPrestartRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  const inspected = await initialEligibility(options);
  assertSystemRebootAuthority({
    context: inspected.context,
    identity: options.identity,
    proof: options.rebootProof,
    expected: options.expectedRebootQuarantine,
  });
  if (options.expectedRebootQuarantine && !options.rebootProof) {
    throw invalid('exact containment authority requires rebootProof before claim installation');
  }
  return await installRecoveryDomainControlled(
    {
      workspacePath: options.workspacePath,
      expectedSourceSnapshotDigest: inspected.sourceSnapshotDigest,
      recoveryId: options.recoveryId,
      attemptId: options.attemptId,
      identity: options.identity,
      mode: 'mechanical-empty',
      delegatedOperation: null,
      prestartOperation: inspected.binding,
      rebootProof: options.rebootProof,
      now: options.now,
      probeSourceOwner: options.probeSourceOwner,
      hooks: options.hooks,
      verifySystemAuthority: options.verifySystemAuthority,
    },
    prestartAuthority(options, inspected.binding),
  );
}

export async function installPrestartRecovery(
  options: InstallPrestartRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await installPrestartRecoveryControlled({
    workspacePath: options.workspacePath,
    helperBytes: readFixedPlatformHelperBundle(),
    identity: system.identity,
    rebootProof: null,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}

/** @internal Authority-controlled core. */
export async function acquirePrestartRecoveryControlled(
  options: ControlledAcquirePrestartRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  await options.verifySystemAuthority?.();
  const context = await loadRecoveryContext(options.workspacePath);
  const domain = await readRecoveryDomainAtPath(
    context.records,
    context.sourceOwner,
    context.recoveryPath,
  );
  if (domain.claim.mode !== 'mechanical-empty' || !domain.claim.prestartOperation) {
    throw new WorkspaceSafetyError(
      'unsupported',
      'Recovery is not eligible: claim is not a prestart mechanical recovery',
    );
  }
  assertSystemRebootAuthority({
    context,
    identity: options.identity,
    proof: domain.claim.rebootProof,
    expected: options.expectedRebootQuarantine,
  });
  return await acquireRecoveryAttemptControlled(
    options,
    prestartAuthority(options, domain.claim.prestartOperation),
  );
}

export async function acquirePrestartRecovery(
  options: AcquirePrestartRecoveryOptions,
): Promise<RecoveryAttemptHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await acquirePrestartRecoveryControlled({
    workspacePath: options.workspacePath,
    helperBytes: readFixedPlatformHelperBundle(),
    identity: system.identity,
    probeSourceOwner: system.probeOwner,
    verifySystemAuthority: system.verifyCurrent,
  });
}
