import { digestBytes, jsonBytes } from './filesystem.js';
import {
  MAX_SAFETY_PID,
  MAX_SAFETY_STRING_LENGTH,
  parseJsonRecord,
  parseOwnerRecord,
} from './schema.js';
import {
  OWNER_SCHEMA_VERSION,
  PROTOCOL_ROOT_DIR,
  type MutationPhase,
  type ProcessIdentity,
  type ProcessIdentitySnapshot,
  type RecoveryMode,
  WorkspaceSafetyError,
} from './types.js';

export const RECOVERY_SCHEMA_VERSION = 1 as const;
export const RECOVERY_CLAIM_FILE = 'claim.json';
export const RECOVERY_STATE_FILE = 'state.json';
export const RECOVERY_FINAL_MANIFEST_FILE = 'final-manifest.json';
export const RECOVERY_ATTEMPTS_DIR = 'attempts';
export const RECOVERY_ATTEMPT_LEASE_DIR = 'lease';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ISO_MILLISECOND_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

export const PREPARED_ATTEMPT_PATTERN = /^prepared-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/u;
export const ABANDONED_ATTEMPT_PATTERN = /^abandoned-([0-9a-f]{64})$/u;

const RECOVERY_MODES = new Set<RecoveryMode>([
  'mechanical-empty',
  'delegated-finalize',
  'bootstrap-complete',
  'mutation-resume',
]);
const RECOVERY_PHASES = new Set<RecoveryState['phase']>(['claimed', 'verified', 'finalizing']);
const MUTATION_PHASES = new Set<MutationPhase>(['staged', 'archiving', 'applying', 'committed']);

type StrictRecord = Record<string, unknown>;

export interface RecoveryRebootProof {
  readonly schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  readonly kind: 'same-host-boot-changed-v1';
  readonly hostId: string;
  readonly previousBootIdentity: string;
  readonly currentBootIdentity: string;
  readonly verifiedAt: string;
}

export interface RecoveryClaim {
  readonly schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  readonly recoveryId: string;
  readonly sourceKind: 'new-lock';
  readonly sourceSnapshotDigest: string;
  readonly mode: RecoveryMode;
  readonly targetArchive: string;
  readonly delegatedOperation: DelegatedRecoveryOperationBinding | null;
  readonly prestartOperation: PrestartRecoveryOperationBinding | null;
  readonly rebootProof: RecoveryRebootProof | null;
  readonly createdAt: string;
}

export interface DelegatedRecoveryOperationBinding {
  readonly operationId: string;
  readonly activeChildDigest: string;
  readonly delegatedBaselineDigest: string;
  readonly drainedReceiptDigest: string;
}

/**
 * Immutable proof that a mechanical-empty claim is allowed to perform one narrowly bounded
 * prepared/prepared-bound operation closeout before archiving the otherwise-empty lease.
 */
export interface PrestartRecoveryOperationBinding {
  readonly kind: 'prestart-operation-v1';
  readonly operationId: string;
  readonly activeState: 'prepared' | 'prepared-bound';
  readonly proof:
    'canonical-prepared-start-never-authorized-v1' | 'supervisor-exact-dead-never-armed-v1';
  readonly activeChildDigest: string;
  readonly delegatedBaselineDigest: string;
  readonly helperDigest: string;
  readonly prestartDrainedDigest: string | null;
  readonly existingAbortDigest: string | null;
}

export interface RecoveryState {
  readonly schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly phase: 'claimed' | 'verified' | 'finalizing';
  readonly expectedMutationPhase: MutationPhase | null;
  readonly expectedMutationDigest: string | null;
  readonly finalManifestDigest: string | null;
  readonly updatedAt: string;
}

export interface RecoveryFinalManifest {
  readonly schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly statePhase: 'finalizing';
  readonly workspaceMarkerDigest: string;
  readonly protocolDigest: string;
  readonly finalSourceSnapshotDigest: string;
  readonly mutationSnapshotDigest: string | null;
  /** Digest of an unsigned delegated semantic candidate; null for non-delegated recovery. */
  readonly delegatedCandidateDigest: string | null;
  readonly createdAt: string;
}

export interface RecoveryAttemptOwner {
  readonly schemaVersion: typeof RECOVERY_SCHEMA_VERSION;
  readonly attemptId: string;
  readonly recoveryId: string;
  readonly pid: number;
  readonly processIdentity: ProcessIdentity;
  readonly bootIdentity: string;
  readonly hostId: string;
  readonly workspaceIdentity: string;
  readonly startedAt: string;
}

export interface CreateRecoveryClaimOptions {
  readonly recoveryId: string;
  readonly sourceSnapshotDigest: string;
  readonly mode: RecoveryMode;
  readonly delegatedOperation?: DelegatedRecoveryOperationBinding | null;
  readonly prestartOperation?: PrestartRecoveryOperationBinding | null;
  readonly rebootProof: RecoveryRebootProof | null;
  readonly createdAt: Date;
}

export interface CreateRecoveryStateOptions {
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly phase: RecoveryState['phase'];
  readonly expectedMutationPhase: MutationPhase | null;
  readonly expectedMutationDigest: string | null;
  readonly finalManifestDigest: string | null;
  readonly updatedAt: Date;
}

export interface CreateRecoveryFinalManifestOptions {
  readonly recoveryId: string;
  readonly claimDigest: string;
  readonly workspaceMarkerDigest: string;
  readonly protocolDigest: string;
  readonly finalSourceSnapshotDigest: string;
  readonly mutationSnapshotDigest: string | null;
  readonly delegatedCandidateDigest?: string | null;
  readonly createdAt: Date;
}

export function recoveryInvalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('invalid', `Invalid recovery protocol: ${message}`);
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  }
  return error;
}

function asRecord(value: unknown, label: string): StrictRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw recoveryInvalid(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw recoveryInvalid(`${label} must be a plain object`);
  }
  return value as StrictRecord;
}

function exactKeys(record: StrictRecord, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !expectedSet.has(key)) {
      throw recoveryInvalid(`${label} contains an unknown field`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(record, key)) throw recoveryInvalid(`${label} is missing ${key}`);
  }
}

function literal<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw recoveryInvalid(`${field} has an unsupported value`);
  return expected;
}

function boundedString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SAFETY_STRING_LENGTH) {
    throw recoveryInvalid(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function pattern(value: unknown, field: string, expression: RegExp): string {
  const parsed = boundedString(value, field);
  if (!expression.test(parsed)) throw recoveryInvalid(`${field} has an invalid format`);
  return parsed;
}

export function recoveryUuid(value: unknown, field: string): string {
  return pattern(value, field, UUID_PATTERN);
}

export function recoveryDigest(value: unknown, field: string): string {
  return pattern(value, field, SHA256_PATTERN);
}

function timestamp(value: unknown, field: string): string {
  const parsed = pattern(value, field, ISO_MILLISECOND_UTC_PATTERN);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    throw recoveryInvalid(`${field} is not a canonical UTC timestamp`);
  }
  return parsed;
}

function enumValue<T extends string>(value: unknown, allowed: ReadonlySet<T>, field: string): T {
  if (typeof value !== 'string' || !allowed.has(value as T)) {
    throw recoveryInvalid(`${field} has an unsupported value`);
  }
  return value as T;
}

function nullableDigest(value: unknown, field: string): string | null {
  return value === null ? null : recoveryDigest(value, field);
}

function dateTimestamp(value: Date, field: string): string {
  try {
    return timestamp(value.toISOString(), field);
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw recoveryInvalid(`${field} is invalid`, error);
  }
}

function targetArchive(recoveryId: string, sourceSnapshotDigest: string): string {
  return `${PROTOCOL_ROOT_DIR}/incidents/recovery-${recoveryId}-${sourceSnapshotDigest.slice(7, 23)}`;
}

function parseRebootProof(value: unknown): RecoveryRebootProof | null {
  if (value === null) return null;
  const record = asRecord(value, 'rebootProof');
  exactKeys(
    record,
    [
      'schemaVersion',
      'kind',
      'hostId',
      'previousBootIdentity',
      'currentBootIdentity',
      'verifiedAt',
    ],
    'rebootProof',
  );
  const previousBootIdentity = recoveryDigest(
    record.previousBootIdentity,
    'rebootProof.previousBootIdentity',
  );
  const currentBootIdentity = recoveryDigest(
    record.currentBootIdentity,
    'rebootProof.currentBootIdentity',
  );
  if (previousBootIdentity === currentBootIdentity) {
    throw recoveryInvalid('rebootProof must bind two different boot identities');
  }
  return {
    schemaVersion: literal(
      record.schemaVersion,
      RECOVERY_SCHEMA_VERSION,
      'rebootProof.schemaVersion',
    ),
    kind: literal(record.kind, 'same-host-boot-changed-v1', 'rebootProof.kind'),
    hostId: recoveryDigest(record.hostId, 'rebootProof.hostId'),
    previousBootIdentity,
    currentBootIdentity,
    verifiedAt: timestamp(record.verifiedAt, 'rebootProof.verifiedAt'),
  };
}

function canonicalRecord<T>(
  input: string | Buffer,
  parser: (value: unknown) => T,
  label: string,
): T {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  const parsed = parseJsonRecord(bytes, parser);
  const canonical = jsonBytes(parsed);
  if (!bytes.equals(canonical)) throw recoveryInvalid(`${label} bytes are not canonical JSON`);
  return parsed;
}

function parseRecoveryClaimValue(value: unknown): RecoveryClaim {
  const record = asRecord(value, 'claim');
  exactKeys(
    record,
    [
      'schemaVersion',
      'recoveryId',
      'sourceKind',
      'sourceSnapshotDigest',
      'mode',
      'targetArchive',
      'delegatedOperation',
      'prestartOperation',
      'rebootProof',
      'createdAt',
    ],
    'claim',
  );
  const recoveryId = recoveryUuid(record.recoveryId, 'claim.recoveryId');
  const sourceSnapshotDigest = recoveryDigest(
    record.sourceSnapshotDigest,
    'claim.sourceSnapshotDigest',
  );
  const archive = boundedString(record.targetArchive, 'claim.targetArchive');
  if (archive !== targetArchive(recoveryId, sourceSnapshotDigest)) {
    throw recoveryInvalid('claim.targetArchive does not match its immutable bindings');
  }
  const mode = enumValue(record.mode, RECOVERY_MODES, 'claim.mode');
  let delegatedOperation: DelegatedRecoveryOperationBinding | null = null;
  if (record.delegatedOperation !== null) {
    const delegated = asRecord(record.delegatedOperation, 'claim.delegatedOperation');
    exactKeys(
      delegated,
      ['operationId', 'activeChildDigest', 'delegatedBaselineDigest', 'drainedReceiptDigest'],
      'claim.delegatedOperation',
    );
    delegatedOperation = {
      operationId: recoveryUuid(delegated.operationId, 'claim.delegatedOperation.operationId'),
      activeChildDigest: recoveryDigest(
        delegated.activeChildDigest,
        'claim.delegatedOperation.activeChildDigest',
      ),
      delegatedBaselineDigest: recoveryDigest(
        delegated.delegatedBaselineDigest,
        'claim.delegatedOperation.delegatedBaselineDigest',
      ),
      drainedReceiptDigest: recoveryDigest(
        delegated.drainedReceiptDigest,
        'claim.delegatedOperation.drainedReceiptDigest',
      ),
    };
  }
  if ((mode === 'delegated-finalize') !== (delegatedOperation !== null)) {
    throw recoveryInvalid('claim delegated operation binding does not match recovery mode');
  }
  let prestartOperation: PrestartRecoveryOperationBinding | null = null;
  if (record.prestartOperation !== null) {
    const prestart = asRecord(record.prestartOperation, 'claim.prestartOperation');
    exactKeys(
      prestart,
      [
        'kind',
        'operationId',
        'activeState',
        'proof',
        'activeChildDigest',
        'delegatedBaselineDigest',
        'helperDigest',
        'prestartDrainedDigest',
        'existingAbortDigest',
      ],
      'claim.prestartOperation',
    );
    const existingAbortDigest = nullableDigest(
      prestart.existingAbortDigest,
      'claim.prestartOperation.existingAbortDigest',
    );
    const activeState = enumValue(
      prestart.activeState,
      new Set(['prepared', 'prepared-bound'] as const),
      'claim.prestartOperation.activeState',
    );
    const prestartDrainedDigest = nullableDigest(
      prestart.prestartDrainedDigest,
      'claim.prestartOperation.prestartDrainedDigest',
    );
    if (prestartDrainedDigest !== null) {
      throw recoveryInvalid(
        'claim prestart recovery cannot depend on caller-supplied drained bytes',
      );
    }
    const proof = enumValue(
      prestart.proof,
      new Set([
        'canonical-prepared-start-never-authorized-v1',
        'supervisor-exact-dead-never-armed-v1',
      ] as const),
      'claim.prestartOperation.proof',
    );
    if (
      (activeState === 'prepared') !==
      (proof === 'canonical-prepared-start-never-authorized-v1')
    ) {
      throw recoveryInvalid('claim prestart state and recovery proof mismatch');
    }
    prestartOperation = {
      kind: literal(prestart.kind, 'prestart-operation-v1', 'claim.prestartOperation.kind'),
      operationId: recoveryUuid(prestart.operationId, 'claim.prestartOperation.operationId'),
      activeState,
      proof,
      activeChildDigest: recoveryDigest(
        prestart.activeChildDigest,
        'claim.prestartOperation.activeChildDigest',
      ),
      delegatedBaselineDigest: recoveryDigest(
        prestart.delegatedBaselineDigest,
        'claim.prestartOperation.delegatedBaselineDigest',
      ),
      helperDigest: recoveryDigest(prestart.helperDigest, 'claim.prestartOperation.helperDigest'),
      prestartDrainedDigest,
      existingAbortDigest,
    };
  }
  if (prestartOperation !== null && mode !== 'mechanical-empty') {
    throw recoveryInvalid('claim prestart operation binding requires mechanical-empty mode');
  }
  return {
    schemaVersion: literal(record.schemaVersion, RECOVERY_SCHEMA_VERSION, 'claim.schemaVersion'),
    recoveryId,
    sourceKind: literal(record.sourceKind, 'new-lock', 'claim.sourceKind'),
    sourceSnapshotDigest,
    mode,
    targetArchive: archive,
    delegatedOperation,
    prestartOperation,
    rebootProof: parseRebootProof(record.rebootProof),
    createdAt: timestamp(record.createdAt, 'claim.createdAt'),
  };
}

export function parseRecoveryClaim(input: string | Buffer): RecoveryClaim {
  return canonicalRecord(input, parseRecoveryClaimValue, 'claim');
}

function parseRecoveryStateValue(value: unknown): RecoveryState {
  const record = asRecord(value, 'state');
  exactKeys(
    record,
    [
      'schemaVersion',
      'recoveryId',
      'claimDigest',
      'phase',
      'expectedMutationPhase',
      'expectedMutationDigest',
      'finalManifestDigest',
      'updatedAt',
    ],
    'state',
  );
  const phase = enumValue(record.phase, RECOVERY_PHASES, 'state.phase');
  const expectedMutationPhase =
    record.expectedMutationPhase === null
      ? null
      : enumValue(record.expectedMutationPhase, MUTATION_PHASES, 'state.expectedMutationPhase');
  const expectedMutationDigest = nullableDigest(
    record.expectedMutationDigest,
    'state.expectedMutationDigest',
  );
  if ((expectedMutationPhase === null) !== (expectedMutationDigest === null)) {
    throw recoveryInvalid('state mutation phase and digest must both be null or both be present');
  }
  const finalManifestDigest = nullableDigest(
    record.finalManifestDigest,
    'state.finalManifestDigest',
  );
  if (phase === 'finalizing' && finalManifestDigest === null) {
    throw recoveryInvalid('finalizing state must bind a final manifest');
  }
  if (phase !== 'finalizing' && finalManifestDigest !== null) {
    throw recoveryInvalid('only finalizing state may bind a final manifest');
  }
  return {
    schemaVersion: literal(record.schemaVersion, RECOVERY_SCHEMA_VERSION, 'state.schemaVersion'),
    recoveryId: recoveryUuid(record.recoveryId, 'state.recoveryId'),
    claimDigest: recoveryDigest(record.claimDigest, 'state.claimDigest'),
    phase,
    expectedMutationPhase,
    expectedMutationDigest,
    finalManifestDigest,
    updatedAt: timestamp(record.updatedAt, 'state.updatedAt'),
  };
}

export function parseRecoveryState(input: string | Buffer): RecoveryState {
  return canonicalRecord(input, parseRecoveryStateValue, 'state');
}

function parseRecoveryFinalManifestValue(value: unknown): RecoveryFinalManifest {
  const record = asRecord(value, 'final manifest');
  exactKeys(
    record,
    [
      'schemaVersion',
      'recoveryId',
      'claimDigest',
      'statePhase',
      'workspaceMarkerDigest',
      'protocolDigest',
      'finalSourceSnapshotDigest',
      'mutationSnapshotDigest',
      'delegatedCandidateDigest',
      'createdAt',
    ],
    'final manifest',
  );
  return {
    schemaVersion: literal(
      record.schemaVersion,
      RECOVERY_SCHEMA_VERSION,
      'finalManifest.schemaVersion',
    ),
    recoveryId: recoveryUuid(record.recoveryId, 'finalManifest.recoveryId'),
    claimDigest: recoveryDigest(record.claimDigest, 'finalManifest.claimDigest'),
    statePhase: literal(record.statePhase, 'finalizing', 'finalManifest.statePhase'),
    workspaceMarkerDigest: recoveryDigest(
      record.workspaceMarkerDigest,
      'finalManifest.workspaceMarkerDigest',
    ),
    protocolDigest: recoveryDigest(record.protocolDigest, 'finalManifest.protocolDigest'),
    finalSourceSnapshotDigest: recoveryDigest(
      record.finalSourceSnapshotDigest,
      'finalManifest.finalSourceSnapshotDigest',
    ),
    mutationSnapshotDigest: nullableDigest(
      record.mutationSnapshotDigest,
      'finalManifest.mutationSnapshotDigest',
    ),
    delegatedCandidateDigest: nullableDigest(
      record.delegatedCandidateDigest,
      'finalManifest.delegatedCandidateDigest',
    ),
    createdAt: timestamp(record.createdAt, 'finalManifest.createdAt'),
  };
}

export function parseRecoveryFinalManifest(input: string | Buffer): RecoveryFinalManifest {
  return canonicalRecord(input, parseRecoveryFinalManifestValue, 'final manifest');
}

function parseRecoveryAttemptOwnerValue(value: unknown): RecoveryAttemptOwner {
  const record = asRecord(value, 'attempt owner');
  exactKeys(
    record,
    [
      'schemaVersion',
      'attemptId',
      'recoveryId',
      'pid',
      'processIdentity',
      'bootIdentity',
      'hostId',
      'workspaceIdentity',
      'startedAt',
    ],
    'attempt owner',
  );
  const attemptId = recoveryUuid(record.attemptId, 'attemptOwner.attemptId');
  const recoveryId = recoveryUuid(record.recoveryId, 'attemptOwner.recoveryId');
  const surrogate = parseOwnerRecord({
    schemaVersion: OWNER_SCHEMA_VERSION,
    ownerId: attemptId,
    pid: record.pid,
    processIdentity: record.processIdentity,
    bootIdentity: record.bootIdentity,
    hostId: record.hostId,
    workspaceIdentity: record.workspaceIdentity,
    startedAt: record.startedAt,
    command: 'repair',
  });
  return {
    schemaVersion: literal(
      record.schemaVersion,
      RECOVERY_SCHEMA_VERSION,
      'attemptOwner.schemaVersion',
    ),
    attemptId,
    recoveryId,
    pid: surrogate.pid,
    processIdentity: surrogate.processIdentity,
    bootIdentity: surrogate.bootIdentity,
    hostId: surrogate.hostId,
    workspaceIdentity: surrogate.workspaceIdentity,
    startedAt: surrogate.startedAt,
  };
}

export function parseRecoveryAttemptOwner(input: string | Buffer): RecoveryAttemptOwner {
  return canonicalRecord(input, parseRecoveryAttemptOwnerValue, 'attempt owner');
}

export function createRecoveryClaimBytes(options: CreateRecoveryClaimOptions): Buffer {
  const recoveryId = recoveryUuid(options.recoveryId, 'claim.recoveryId');
  const sourceSnapshotDigest = recoveryDigest(
    options.sourceSnapshotDigest,
    'claim.sourceSnapshotDigest',
  );
  const claim: RecoveryClaim = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    recoveryId,
    sourceKind: 'new-lock',
    sourceSnapshotDigest,
    mode: enumValue(options.mode, RECOVERY_MODES, 'claim.mode'),
    targetArchive: targetArchive(recoveryId, sourceSnapshotDigest),
    delegatedOperation: options.delegatedOperation ?? null,
    prestartOperation: options.prestartOperation ?? null,
    rebootProof: parseRebootProof(options.rebootProof),
    createdAt: dateTimestamp(options.createdAt, 'claim.createdAt'),
  };
  const bytes = jsonBytes(claim);
  parseRecoveryClaim(bytes);
  return bytes;
}

export function createRecoveryStateBytes(options: CreateRecoveryStateOptions): Buffer {
  const state: RecoveryState = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    recoveryId: recoveryUuid(options.recoveryId, 'state.recoveryId'),
    claimDigest: recoveryDigest(options.claimDigest, 'state.claimDigest'),
    phase: enumValue(options.phase, RECOVERY_PHASES, 'state.phase'),
    expectedMutationPhase:
      options.expectedMutationPhase === null
        ? null
        : enumValue(options.expectedMutationPhase, MUTATION_PHASES, 'state.expectedMutationPhase'),
    expectedMutationDigest:
      options.expectedMutationDigest === null
        ? null
        : recoveryDigest(options.expectedMutationDigest, 'state.expectedMutationDigest'),
    finalManifestDigest:
      options.finalManifestDigest === null
        ? null
        : recoveryDigest(options.finalManifestDigest, 'state.finalManifestDigest'),
    updatedAt: dateTimestamp(options.updatedAt, 'state.updatedAt'),
  };
  const bytes = jsonBytes(state);
  parseRecoveryState(bytes);
  return bytes;
}

export function createRecoveryFinalManifestBytes(
  options: CreateRecoveryFinalManifestOptions,
): Buffer {
  const manifest: RecoveryFinalManifest = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    recoveryId: recoveryUuid(options.recoveryId, 'finalManifest.recoveryId'),
    claimDigest: recoveryDigest(options.claimDigest, 'finalManifest.claimDigest'),
    statePhase: 'finalizing',
    workspaceMarkerDigest: recoveryDigest(
      options.workspaceMarkerDigest,
      'finalManifest.workspaceMarkerDigest',
    ),
    protocolDigest: recoveryDigest(options.protocolDigest, 'finalManifest.protocolDigest'),
    finalSourceSnapshotDigest: recoveryDigest(
      options.finalSourceSnapshotDigest,
      'finalManifest.finalSourceSnapshotDigest',
    ),
    mutationSnapshotDigest:
      options.mutationSnapshotDigest === null
        ? null
        : recoveryDigest(options.mutationSnapshotDigest, 'finalManifest.mutationSnapshotDigest'),
    delegatedCandidateDigest:
      options.delegatedCandidateDigest === undefined || options.delegatedCandidateDigest === null
        ? null
        : recoveryDigest(
            options.delegatedCandidateDigest,
            'finalManifest.delegatedCandidateDigest',
          ),
    createdAt: dateTimestamp(options.createdAt, 'finalManifest.createdAt'),
  };
  const bytes = jsonBytes(manifest);
  parseRecoveryFinalManifest(bytes);
  return bytes;
}

export function createRecoveryAttemptOwnerBytes(
  recoveryId: string,
  attemptId: string,
  identity: ProcessIdentitySnapshot,
  workspaceIdentity: string,
  now: () => Date,
): Buffer {
  if (!Number.isSafeInteger(identity.pid) || identity.pid < 1 || identity.pid > MAX_SAFETY_PID) {
    throw recoveryInvalid('attemptOwner.pid is invalid');
  }
  const owner: RecoveryAttemptOwner = {
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    attemptId: recoveryUuid(attemptId, 'attemptOwner.attemptId'),
    recoveryId: recoveryUuid(recoveryId, 'attemptOwner.recoveryId'),
    pid: identity.pid,
    processIdentity: identity.processIdentity,
    bootIdentity: identity.bootIdentity,
    hostId: identity.hostId,
    workspaceIdentity,
    startedAt: dateTimestamp(now(), 'attemptOwner.startedAt'),
  };
  const bytes = jsonBytes(owner);
  parseRecoveryAttemptOwner(bytes);
  return bytes;
}

export function recoveryAttemptLeaseDigest(ownerBytes: Buffer): string {
  return digestBytes(
    Buffer.concat([
      Buffer.from('coding-x-recovery-attempt-lease-v1\0owner.json\0', 'utf8'),
      ownerBytes,
    ]),
  );
}
