import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { evaluateDelegatedDelta } from './baseline.js';
import { digestBytes, pathExists, readExactFile } from './filesystem.js';
import {
  ABORT_STAGING_PATTERN,
  ACTIVE_CHILD_FILE,
  DELEGATED_BASELINE_FILE,
  DRAINED_RECEIPT_FILE,
  PRESTART_ABORT_FILE,
  RECEIPT_STAGING_PATTERN,
  parseActiveChildRecord,
  parseDelegatedBaselineRecord,
  parsePrestartAbortRecord,
  readOperationInstalledFact,
  type ActiveChildRecord,
  type ArmedActiveChild,
  type PreparedBoundActiveChild,
} from './operation-records.js';
import {
  isQuarantineStagingName,
  readQuarantinePresence,
  type QuarantineRecord,
} from './quarantine.js';
import { MAX_SAFETY_RECORD_BYTES } from './schema.js';
import { parseDrainedReceipt, type DrainedReceipt } from './supervisor-protocol.js';
import type { OwnerRecord } from './types.js';
import { WorkspaceSafetyError } from './types.js';

const MAX_OPERATION_ENTRIES = 4096;
const MAX_PREPARED_HANDSHAKE_MS = 60_000;

export type DiskSupervisorVerdict = 'alive' | 'dead' | 'unknown';
export type DiskContainmentVerdict = 'not-applicable' | 'empty' | 'alive' | 'unknown';

export interface OperationDiskProbe {
  readonly probeSupervisor: (
    active: PreparedBoundActiveChild | ArmedActiveChild,
  ) => DiskSupervisorVerdict;
  readonly probeContainment: (
    active: ArmedActiveChild,
    receipt: DrainedReceipt,
  ) => Exclude<DiskContainmentVerdict, 'not-applicable'>;
}

export interface OperationQuarantineEvidence {
  readonly location: 'operation';
  readonly record: QuarantineRecord;
  readonly bytes: Buffer;
}

export interface OperationDiskInspection {
  readonly state: ActiveChildRecord['state'];
  readonly active: ActiveChildRecord;
  readonly activeBytes: Buffer;
  readonly baselineBytes: Buffer;
  readonly receipt?: DrainedReceipt;
  readonly receiptBytes?: Buffer;
  readonly prestartAbortBytes?: Buffer;
  readonly quarantine?: OperationQuarantineEvidence;
  readonly quarantineInstallIncomplete: boolean;
  readonly containment: DiskContainmentVerdict;
  readonly recoveryInputs: 'valid' | 'insufficient';
  readonly reason?:
    | 'prepared-handshake-not-expired'
    | 'supervisor-not-exact-dead'
    | 'containment-not-exact-empty'
    | 'operation-proof-missing'
    | 'quarantine-install-incomplete';
}

interface InspectOperationOptions {
  readonly operationPath: string;
  readonly workspacePath: string;
  readonly workspaceIdentity: string;
  readonly protocolBytes: Buffer;
  readonly owner: OwnerRecord;
  readonly ownerBytes: Buffer;
  readonly ownerVerdict: 'alive' | 'dead' | 'unknown';
  readonly now: Date;
  readonly probe: OperationDiskProbe;
}

function invalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('invalid', `Invalid workspace disk operation: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function patternMatches(pattern: RegExp, value: string): boolean {
  pattern.lastIndex = 0;
  const matches = pattern.test(value);
  pattern.lastIndex = 0;
  return matches;
}

async function assertOrdinaryDirectory(path: string, label: string): Promise<string[]> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) throw invalid(`${label} is not ordinary`);
    const names = await readdir(path);
    if (names.length > MAX_OPERATION_ENTRIES) throw invalid(`${label} exceeds its entry budget`);
    return names.sort((left, right) => left.localeCompare(right, 'en'));
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw invalid(`${label} is missing, changing, or unreadable`, error);
  }
}

function assertFrozenBindings(input: {
  readonly active: ActiveChildRecord;
  readonly baseline: ReturnType<typeof parseDelegatedBaselineRecord>;
  readonly baselineBytes: Buffer;
  readonly owner: OwnerRecord;
  readonly workspaceIdentity: string;
}): void {
  const { active, baseline, baselineBytes, owner, workspaceIdentity } = input;
  if (
    active.ownerId !== owner.ownerId ||
    baseline.ownerId !== owner.ownerId ||
    active.operationId !== baseline.operationId ||
    baseline.workspaceIdentity !== workspaceIdentity ||
    baseline.contract.version !== active.delegation ||
    baseline.contractDigest !== active.delegationContractDigest ||
    active.delegatedBaselineDigest !== digestBytes(baselineBytes)
  ) {
    throw invalid('active child and delegated baseline binding mismatch');
  }
}

function assertPrestartAbortBinding(input: {
  readonly active: ActiveChildRecord;
  readonly activeBytes: Buffer;
  readonly baselineBytes: Buffer;
  readonly bytes: Buffer;
}): void {
  const abort = parsePrestartAbortRecord(input.bytes);
  if (
    abort.ownerId !== input.active.ownerId ||
    abort.operationId !== input.active.operationId ||
    abort.activeChildDigest !== digestBytes(input.activeBytes) ||
    abort.delegatedBaselineDigest !== digestBytes(input.baselineBytes)
  ) {
    throw invalid('prestart abort does not bind the frozen operation');
  }
  if (
    (input.active.state === 'prepared' && abort.proof !== 'supervisor-never-bound-v1') ||
    (input.active.state === 'prepared-bound' &&
      abort.proof !== 'supervisor-prestart-empty-v1' &&
      abort.proof !== 'recovery-supervisor-exact-dead-never-armed-v1') ||
    input.active.state === 'armed'
  ) {
    throw invalid('prestart abort proof does not match the active child state');
  }
}

function parseAndBindReceipt(input: {
  readonly bytes: Buffer;
  readonly active: ArmedActiveChild;
  readonly activeBytes: Buffer;
  readonly baselineBytes: Buffer;
  readonly protocolBytes: Buffer;
  readonly owner: OwnerRecord;
  readonly ownerBytes: Buffer;
}): DrainedReceipt | undefined {
  try {
    const receipt = parseDrainedReceipt(input.bytes);
    if (
      receipt.ownerId !== input.owner.ownerId ||
      receipt.operationId !== input.active.operationId ||
      receipt.ownerRecordDigest !== digestBytes(input.ownerBytes) ||
      receipt.protocolDigest !== digestBytes(input.protocolBytes) ||
      receipt.activeChildDigest !== digestBytes(input.activeBytes) ||
      receipt.delegatedBaselineDigest !== digestBytes(input.baselineBytes) ||
      receipt.delegationContractDigest !== input.active.delegationContractDigest ||
      receipt.containmentDigest !== input.active.containmentDigest ||
      receipt.helperDigest !== input.active.helperDigest ||
      receipt.supervisorIdentity !== input.active.supervisorIdentity ||
      (input.active.platform === 'posix-process-group-v1' &&
        (receipt.proof === 'windows-job-zero-and-pipes-eof-v1' ||
          receipt.proof === 'windows-job-zero-pipes-eof-output-settled-v2')) ||
      (input.active.platform === 'windows-job-v1' &&
        receipt.proof === 'posix-group-empty-and-pipes-eof-v1')
    ) {
      return undefined;
    }
    return receipt;
  } catch {
    return undefined;
  }
}

function assertOwnerQuarantineBinding(
  record: QuarantineRecord,
  bytes: Buffer,
  owner: OwnerRecord,
  ownerBytes: Buffer,
  active: ActiveChildRecord,
  activeBytes: Buffer,
  baselineBytes: Buffer,
): void {
  if (
    record.ownerId !== owner.ownerId ||
    record.operationId !== active.operationId ||
    record.activeChildDigest !== digestBytes(activeBytes) ||
    record.delegatedBaselineDigest !== digestBytes(baselineBytes)
  ) {
    throw invalid('operation quarantine does not bind the frozen operation');
  }
  if (
    record.creator.kind === 'owner' &&
    (record.creator.id !== owner.ownerId ||
      record.creator.recordDigest !== digestBytes(ownerBytes) ||
      record.priorQuarantineDigest !== null)
  ) {
    throw invalid('owner-created operation quarantine has invalid authority');
  }
  // A recovery attempt may install integrity isolation directly (prior=null) or upgrade an
  // existing containment quarantine (prior=digest). The upgraded bytes replace the prior file,
  // so this observer can validate the strict schema and creator authority but must not pretend
  // that the no-longer-present prior bytes were independently re-read here.
  if (bytes.byteLength > MAX_SAFETY_RECORD_BYTES) {
    throw invalid('operation quarantine exceeds its byte budget');
  }
}

async function readOptionalInstalledFact<T>(options: {
  readonly operationPath: string;
  readonly canonicalName: string;
  readonly stagingPattern: RegExp;
  readonly parse: (bytes: Buffer) => T;
}): Promise<{ readonly value?: T; readonly bytes?: Buffer; readonly stagingOnly: boolean }> {
  const names = await readdir(options.operationPath);
  const stagingNames = names.filter((name) => patternMatches(options.stagingPattern, name));
  const canonical = join(options.operationPath, options.canonicalName);
  if (!(await pathExists(canonical))) {
    for (const name of stagingNames)
      options.parse(await readExactFile(join(options.operationPath, name)));
    return { stagingOnly: stagingNames.length > 0 };
  }
  const installed = await readOperationInstalledFact({
    operationPath: options.operationPath,
    canonicalName: options.canonicalName,
    stagingPattern: options.stagingPattern,
    maxBytes: MAX_SAFETY_RECORD_BYTES,
  });
  const value = options.parse(installed.bytes);
  for (const name of stagingNames) {
    const path = join(options.operationPath, name);
    if (path !== installed.linkedSource) options.parse(await readExactFile(path));
  }
  return { value, bytes: installed.bytes, stagingOnly: false };
}

export async function inspectWorkspaceOperation(
  options: InspectOperationOptions,
): Promise<OperationDiskInspection> {
  const names = await assertOrdinaryDirectory(options.operationPath, 'operation');
  const allowedCanonical = new Set([
    ACTIVE_CHILD_FILE,
    DELEGATED_BASELINE_FILE,
    PRESTART_ABORT_FILE,
    DRAINED_RECEIPT_FILE,
    'quarantine.json',
  ]);
  for (const name of names) {
    if (
      allowedCanonical.has(name) ||
      patternMatches(ABORT_STAGING_PATTERN, name) ||
      patternMatches(RECEIPT_STAGING_PATTERN, name) ||
      isQuarantineStagingName(name)
    ) {
      continue;
    }
    throw invalid(`operation contains unknown entry ${name}`);
  }
  if (!names.includes(ACTIVE_CHILD_FILE) || !names.includes(DELEGATED_BASELINE_FILE)) {
    throw invalid('operation is missing its active child or baseline');
  }

  const baselineBytes = await readExactFile(join(options.operationPath, DELEGATED_BASELINE_FILE));
  const baseline = parseDelegatedBaselineRecord(baselineBytes);
  const activeBytes = await readExactFile(join(options.operationPath, ACTIVE_CHILD_FILE));
  const active = parseActiveChildRecord(activeBytes);
  assertFrozenBindings({
    active,
    baseline,
    baselineBytes,
    owner: options.owner,
    workspaceIdentity: options.workspaceIdentity,
  });

  const abort = await readOptionalInstalledFact({
    operationPath: options.operationPath,
    canonicalName: PRESTART_ABORT_FILE,
    stagingPattern: ABORT_STAGING_PATTERN,
    parse: (bytes) => parsePrestartAbortRecord(bytes),
  });
  if (abort.bytes) {
    assertPrestartAbortBinding({ active, activeBytes, baselineBytes, bytes: abort.bytes });
  }

  const receiptFact = await readOptionalInstalledFact({
    operationPath: options.operationPath,
    canonicalName: DRAINED_RECEIPT_FILE,
    stagingPattern: RECEIPT_STAGING_PATTERN,
    parse: (bytes) => parseDrainedReceipt(bytes),
  });
  if (active.state !== 'armed' && receiptFact.bytes) {
    throw invalid('a prestart operation cannot contain a drained receipt');
  }
  if (active.state === 'armed' && abort.bytes) {
    throw invalid('an armed operation cannot contain a prestart abort');
  }

  const quarantinePresence = await readQuarantinePresence(options.operationPath);
  let quarantine: OperationQuarantineEvidence | undefined;
  if (quarantinePresence.canonical) {
    assertOwnerQuarantineBinding(
      quarantinePresence.canonical.record,
      quarantinePresence.canonical.bytes,
      options.owner,
      options.ownerBytes,
      active,
      activeBytes,
      baselineBytes,
    );
    quarantine = {
      location: 'operation',
      record: quarantinePresence.canonical.record,
      bytes: quarantinePresence.canonical.bytes,
    };
  }
  const quarantineInstallIncomplete =
    quarantinePresence.present && quarantinePresence.canonical === undefined;

  if (active.state === 'prepared' || active.state === 'prepared-bound') {
    const delta = evaluateDelegatedDelta(options.workspacePath, baseline, {
      requireUnchanged: true,
    });
    if (!delta.accepted) throw invalid('prestart business bytes no longer match the baseline');
    if (receiptFact.stagingOnly) {
      throw invalid('a prestart operation contains a staged drained receipt');
    }
    if (abort.stagingOnly || quarantineInstallIncomplete) {
      return {
        state: active.state,
        active,
        activeBytes,
        baselineBytes,
        ...(abort.bytes ? { prestartAbortBytes: abort.bytes } : {}),
        ...(quarantine ? { quarantine } : {}),
        quarantineInstallIncomplete,
        containment: 'unknown',
        recoveryInputs: 'insufficient',
        reason: quarantineInstallIncomplete
          ? 'quarantine-install-incomplete'
          : 'operation-proof-missing',
      };
    }
    if (active.state === 'prepared') {
      const expired =
        abort.bytes !== undefined ||
        options.now.getTime() - Date.parse(active.updatedAt) >= MAX_PREPARED_HANDSHAKE_MS;
      return {
        state: active.state,
        active,
        activeBytes,
        baselineBytes,
        ...(abort.bytes ? { prestartAbortBytes: abort.bytes } : {}),
        ...(quarantine ? { quarantine } : {}),
        quarantineInstallIncomplete,
        containment: 'not-applicable',
        recoveryInputs: expired ? 'valid' : 'insufficient',
        ...(expired ? {} : { reason: 'prepared-handshake-not-expired' as const }),
      };
    }
    const supervisor = options.probe.probeSupervisor(active);
    return {
      state: active.state,
      active,
      activeBytes,
      baselineBytes,
      ...(abort.bytes ? { prestartAbortBytes: abort.bytes } : {}),
      ...(quarantine ? { quarantine } : {}),
      quarantineInstallIncomplete,
      containment:
        supervisor === 'dead' ? 'not-applicable' : supervisor === 'alive' ? 'alive' : 'unknown',
      recoveryInputs: supervisor === 'dead' ? 'valid' : 'insufficient',
      ...(supervisor === 'dead' ? {} : { reason: 'supervisor-not-exact-dead' as const }),
    };
  }

  if (receiptFact.stagingOnly || quarantineInstallIncomplete) {
    return {
      state: active.state,
      active,
      activeBytes,
      baselineBytes,
      ...(quarantine ? { quarantine } : {}),
      quarantineInstallIncomplete,
      containment: 'unknown',
      recoveryInputs: 'insufficient',
      reason: quarantineInstallIncomplete
        ? 'quarantine-install-incomplete'
        : 'operation-proof-missing',
    };
  }
  const receipt = receiptFact.bytes
    ? parseAndBindReceipt({
        bytes: receiptFact.bytes,
        active,
        activeBytes,
        baselineBytes,
        protocolBytes: options.protocolBytes,
        owner: options.owner,
        ownerBytes: options.ownerBytes,
      })
    : undefined;
  if (!receipt) {
    return {
      state: active.state,
      active,
      activeBytes,
      baselineBytes,
      ...(receiptFact.bytes ? { receiptBytes: receiptFact.bytes } : {}),
      ...(quarantine ? { quarantine } : {}),
      quarantineInstallIncomplete,
      containment: 'unknown',
      recoveryInputs: 'insufficient',
      reason: 'operation-proof-missing',
    };
  }
  const supervisor = options.probe.probeSupervisor(active);
  const containment = options.probe.probeContainment(active, receipt);
  const exact = supervisor === 'dead' && containment === 'empty';
  return {
    state: active.state,
    active,
    activeBytes,
    baselineBytes,
    receipt,
    receiptBytes: receiptFact.bytes,
    ...(quarantine ? { quarantine } : {}),
    quarantineInstallIncomplete,
    containment,
    recoveryInputs: exact ? 'valid' : 'insufficient',
    ...(exact
      ? {}
      : {
          reason:
            supervisor === 'dead'
              ? ('containment-not-exact-empty' as const)
              : ('supervisor-not-exact-dead' as const),
        }),
  };
}
