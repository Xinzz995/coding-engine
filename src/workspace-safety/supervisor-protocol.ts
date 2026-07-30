import { digestBytes, jsonBytes } from './filesystem.js';
import { MAX_SAFETY_PID, MAX_SAFETY_STRING_LENGTH, parseJsonRecord } from './schema.js';
import { WorkspaceSafetyError } from './types.js';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ISO_MILLISECOND_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const ENVIRONMENT_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u;
const MAX_ARGUMENTS = 256;
const MAX_ENVIRONMENT_ENTRIES = 256;

export type OperationPlatform = 'posix-process-group-v1' | 'windows-job-v1';
export type SignalIsolation =
  'posix-supervisor-session-signal-shield-v1' | 'windows-new-process-group-ctrl-c-ignore-v1';
export type DrainedProof =
  | 'posix-group-empty-and-pipes-eof-v1'
  | 'windows-job-zero-and-pipes-eof-v1'
  | 'never-started-containment-empty-v1';
export type SupervisorTerminationReason = 'timeout' | 'user-interrupt' | 'parent-shutdown';
export type DrainedReason = 'natural' | 'process-tree-not-empty' | SupervisorTerminationReason;

export interface BoundSupervisorDescriptor {
  readonly platform: OperationPlatform;
  readonly supervisorPid: number;
  readonly supervisorIdentity: string;
  readonly signalIsolation: SignalIsolation;
  readonly helperDigest: string;
}

export type ContainmentDescriptor =
  | {
      readonly platform: 'posix-process-group-v1';
      readonly pgid: number;
      readonly launcherPid: number;
      readonly launcherIdentity: string;
    }
  | {
      readonly platform: 'windows-job-v1';
      readonly targetPid: number;
      readonly targetIdentity: string;
    };

export interface SupervisorTarget {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
}

export interface SupervisorDataMessage {
  readonly schemaVersion: 1;
  readonly type: 'DATA';
  readonly operationId: string;
  readonly target: SupervisorTarget;
}

export interface SupervisorStartMessage {
  readonly schemaVersion: 1;
  readonly type: 'START';
  readonly operationId: string;
  readonly activeChildDigest: string;
}

export interface SupervisorTerminateMessage {
  readonly schemaVersion: 1;
  readonly type: 'TERMINATE';
  readonly operationId: string;
  readonly reason: SupervisorTerminationReason;
}

export interface SupervisorAbortBeforeStartMessage {
  readonly schemaVersion: 1;
  readonly type: 'ABORT_BEFORE_START';
  readonly operationId: string;
}

export interface SupervisorPrestartDrainedMessage {
  readonly schemaVersion: 1;
  readonly type: 'PRESTART_DRAINED';
  readonly operationId: string;
  readonly supervisorPid: number;
  readonly supervisorIdentity: string;
  readonly proof: 'prestart-containment-empty-and-pipes-eof-v1';
  readonly drainedAt: string;
}

export interface SupervisorDrainedMessage {
  readonly schemaVersion: 1;
  readonly type: 'DRAINED';
  readonly operationId: string;
  readonly receiptDigest: string;
  readonly proof: DrainedProof;
}

export interface SupervisorAcknowledgementMessage {
  readonly schemaVersion: 1;
  readonly type: 'ACK';
  readonly operationId: string;
  readonly receiptDigest: string;
}

export interface PreparedBoundSafetyBinding {
  readonly ownerId: string;
  readonly operationId: string;
  readonly ownerRecordDigest: string;
  readonly protocolDigest: string;
  readonly activeChildDigest: string;
  readonly delegatedBaselineDigest: string;
  readonly delegationContractDigest: string;
  readonly helperDigest: string;
  readonly supervisor: BoundSupervisorDescriptor;
}

export interface ArmedSafetyBinding extends PreparedBoundSafetyBinding {
  readonly containmentDigest: string;
  readonly containment: ContainmentDescriptor;
}

export interface DrainedReceipt {
  readonly schemaVersion: 1;
  readonly ownerId: string;
  readonly operationId: string;
  readonly ownerRecordDigest: string;
  readonly protocolDigest: string;
  readonly activeChildDigest: string;
  readonly delegatedBaselineDigest: string;
  readonly delegationContractDigest: string;
  readonly containmentDigest: string;
  readonly helperDigest: string;
  readonly supervisorIdentity: string;
  readonly proof: DrainedProof;
  readonly drainReason: DrainedReason;
  readonly drainedAt: string;
}

export interface DrainedProtocolOutput {
  readonly receipt: DrainedReceipt;
  readonly receiptBytes: Buffer;
  readonly receiptDigest: string;
  readonly message: SupervisorDrainedMessage;
  readonly messageBytes: Buffer;
}

export type SupervisorProtocolState =
  | 'bound'
  | 'data-accepted'
  | 'containment-ready'
  | 'start-accepted'
  | 'termination-requested-before-start'
  | 'termination-requested-after-start'
  | 'drained'
  | 'acknowledged'
  | 'prestart-drained'
  | 'failed';

type StrictRecord = Record<string, unknown>;

function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', `Invalid supervisor protocol: ${message}`);
}

function asRecord(value: unknown, name: string): StrictRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${name} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${name} must be a plain object`);
  }
  return value as StrictRecord;
}

function exactKeys(record: StrictRecord, expected: readonly string[], name: string): void {
  const keys = Reflect.ownKeys(record);
  if (
    keys.some((key) => typeof key !== 'string' || !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    invalid(`${name} has unknown or missing fields`);
  }
}

function literal<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) invalid(`${field} has an unsupported value`);
  return expected;
}

function boundedString(value: unknown, field: string, allowEmpty = false): string {
  if (
    typeof value !== 'string' ||
    (!allowEmpty && value.length === 0) ||
    value.length > MAX_SAFETY_STRING_LENGTH ||
    value.includes('\0')
  ) {
    return invalid(`${field} must be a bounded string`);
  }
  return value;
}

function pattern(value: unknown, field: string, expected: RegExp): string {
  const parsed = boundedString(value, field);
  if (!expected.test(parsed)) invalid(`${field} has an invalid format`);
  return parsed;
}

function uuid(value: unknown, field: string): string {
  return pattern(value, field, UUID_PATTERN);
}

function digest(value: unknown, field: string): string {
  return pattern(value, field, SHA256_PATTERN);
}

function pid(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_SAFETY_PID) {
    return invalid(`${field} must be an unsigned 32-bit process id`);
  }
  return value as number;
}

function timestamp(value: unknown, field: string): string {
  const parsed = pattern(value, field, ISO_MILLISECOND_UTC_PATTERN);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    invalid(`${field} must be a canonical UTC timestamp`);
  }
  return parsed;
}

function parsePlatform(value: unknown): OperationPlatform {
  if (value === 'posix-process-group-v1' || value === 'windows-job-v1') return value;
  return invalid('platform has an unsupported value');
}

function parseSignalIsolation(value: unknown): SignalIsolation {
  if (
    value === 'posix-supervisor-session-signal-shield-v1' ||
    value === 'windows-new-process-group-ctrl-c-ignore-v1'
  ) {
    return value;
  }
  return invalid('signalIsolation has an unsupported value');
}

function parseProof(value: unknown): DrainedProof {
  if (
    value === 'posix-group-empty-and-pipes-eof-v1' ||
    value === 'windows-job-zero-and-pipes-eof-v1' ||
    value === 'never-started-containment-empty-v1'
  ) {
    return value;
  }
  return invalid('proof has an unsupported value');
}

function parseTerminationReason(value: unknown): SupervisorTerminationReason {
  if (value === 'timeout' || value === 'user-interrupt' || value === 'parent-shutdown') {
    return value;
  }
  return invalid('TERMINATE.reason has an unsupported value');
}

function parseDrainedReason(value: unknown): DrainedReason {
  if (value === 'natural' || value === 'process-tree-not-empty') return value;
  return parseTerminationReason(value);
}

function assertDescriptorConsistency(descriptor: BoundSupervisorDescriptor): void {
  parsePlatform(descriptor.platform);
  parseSignalIsolation(descriptor.signalIsolation);
  pid(descriptor.supervisorPid, 'supervisorPid');
  boundedString(descriptor.supervisorIdentity, 'supervisorIdentity');
  digest(descriptor.helperDigest, 'helperDigest');
  if (
    (descriptor.platform === 'posix-process-group-v1' &&
      descriptor.signalIsolation !== 'posix-supervisor-session-signal-shield-v1') ||
    (descriptor.platform === 'windows-job-v1' &&
      descriptor.signalIsolation !== 'windows-new-process-group-ctrl-c-ignore-v1')
  ) {
    invalid('signal isolation does not match platform');
  }
}

export function parseContainmentDescriptor(value: unknown): ContainmentDescriptor {
  const record = asRecord(value, 'containment');
  const platform = parsePlatform(record.platform);
  if (platform === 'posix-process-group-v1') {
    exactKeys(record, ['platform', 'pgid', 'launcherPid', 'launcherIdentity'], 'POSIX containment');
    return {
      platform,
      pgid: pid(record.pgid, 'pgid'),
      launcherPid: pid(record.launcherPid, 'launcherPid'),
      launcherIdentity: boundedString(record.launcherIdentity, 'launcherIdentity'),
    };
  }
  exactKeys(record, ['platform', 'targetPid', 'targetIdentity'], 'Windows containment');
  return {
    platform,
    targetPid: pid(record.targetPid, 'targetPid'),
    targetIdentity: boundedString(record.targetIdentity, 'targetIdentity'),
  };
}

function parseTarget(value: unknown): SupervisorTarget {
  const record = asRecord(value, 'target');
  exactKeys(record, ['executable', 'args', 'cwd', 'environment'], 'target');
  if (!Array.isArray(record.args) || record.args.length > MAX_ARGUMENTS) {
    return invalid('target.args must be a bounded array');
  }
  if (!Array.isArray(record.environment) || record.environment.length > MAX_ENVIRONMENT_ENTRIES) {
    return invalid('target.environment must be a bounded array');
  }
  const names = new Set<string>();
  const environment = record.environment.map((entry, index) => {
    const item = asRecord(entry, `target.environment[${index}]`);
    exactKeys(item, ['name', 'value'], `target.environment[${index}]`);
    const name = pattern(item.name, `target.environment[${index}].name`, ENVIRONMENT_NAME_PATTERN);
    const canonicalName = name.toLowerCase();
    if (names.has(canonicalName)) invalid('target.environment contains a duplicate name');
    names.add(canonicalName);
    return {
      name,
      value: boundedString(item.value, `target.environment[${index}].value`, true),
    };
  });
  return {
    executable: boundedString(record.executable, 'target.executable'),
    args: record.args.map((entry, index) => boundedString(entry, `target.args[${index}]`, true)),
    cwd: boundedString(record.cwd, 'target.cwd'),
    environment,
  };
}

export function parseSupervisorData(input: string | Buffer): SupervisorDataMessage {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'DATA');
    exactKeys(record, ['schemaVersion', 'type', 'operationId', 'target'], 'DATA');
    return {
      schemaVersion: literal(record.schemaVersion, 1, 'DATA.schemaVersion'),
      type: literal(record.type, 'DATA', 'DATA.type'),
      operationId: uuid(record.operationId, 'DATA.operationId'),
      target: parseTarget(record.target),
    };
  });
}

export function parseSupervisorStart(input: string | Buffer): SupervisorStartMessage {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'START');
    exactKeys(record, ['schemaVersion', 'type', 'operationId', 'activeChildDigest'], 'START');
    return {
      schemaVersion: literal(record.schemaVersion, 1, 'START.schemaVersion'),
      type: literal(record.type, 'START', 'START.type'),
      operationId: uuid(record.operationId, 'START.operationId'),
      activeChildDigest: digest(record.activeChildDigest, 'START.activeChildDigest'),
    };
  });
}

export function parseSupervisorTerminate(input: string | Buffer): SupervisorTerminateMessage {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'TERMINATE');
    exactKeys(record, ['schemaVersion', 'type', 'operationId', 'reason'], 'TERMINATE');
    return {
      schemaVersion: literal(record.schemaVersion, 1, 'TERMINATE.schemaVersion'),
      type: literal(record.type, 'TERMINATE', 'TERMINATE.type'),
      operationId: uuid(record.operationId, 'TERMINATE.operationId'),
      reason: parseTerminationReason(record.reason),
    };
  });
}

export function parseSupervisorAbortBeforeStart(
  input: string | Buffer,
): SupervisorAbortBeforeStartMessage {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'ABORT_BEFORE_START');
    exactKeys(record, ['schemaVersion', 'type', 'operationId'], 'ABORT_BEFORE_START');
    return {
      schemaVersion: literal(record.schemaVersion, 1, 'ABORT_BEFORE_START.schemaVersion'),
      type: literal(record.type, 'ABORT_BEFORE_START', 'ABORT_BEFORE_START.type'),
      operationId: uuid(record.operationId, 'ABORT_BEFORE_START.operationId'),
    };
  });
}

export function parseSupervisorPrestartDrained(
  input: string | Buffer,
): SupervisorPrestartDrainedMessage {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'PRESTART_DRAINED');
    exactKeys(
      record,
      [
        'schemaVersion',
        'type',
        'operationId',
        'supervisorPid',
        'supervisorIdentity',
        'proof',
        'drainedAt',
      ],
      'PRESTART_DRAINED',
    );
    return {
      schemaVersion: literal(record.schemaVersion, 1, 'PRESTART_DRAINED.schemaVersion'),
      type: literal(record.type, 'PRESTART_DRAINED', 'PRESTART_DRAINED.type'),
      operationId: uuid(record.operationId, 'PRESTART_DRAINED.operationId'),
      supervisorPid: pid(record.supervisorPid, 'PRESTART_DRAINED.supervisorPid'),
      supervisorIdentity: boundedString(
        record.supervisorIdentity,
        'PRESTART_DRAINED.supervisorIdentity',
      ),
      proof: literal(
        record.proof,
        'prestart-containment-empty-and-pipes-eof-v1',
        'PRESTART_DRAINED.proof',
      ),
      drainedAt: timestamp(record.drainedAt, 'PRESTART_DRAINED.drainedAt'),
    };
  });
}

export function parseSupervisorDrained(input: string | Buffer): SupervisorDrainedMessage {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'DRAINED');
    exactKeys(
      record,
      ['schemaVersion', 'type', 'operationId', 'receiptDigest', 'proof'],
      'DRAINED',
    );
    return {
      schemaVersion: literal(record.schemaVersion, 1, 'DRAINED.schemaVersion'),
      type: literal(record.type, 'DRAINED', 'DRAINED.type'),
      operationId: uuid(record.operationId, 'DRAINED.operationId'),
      receiptDigest: digest(record.receiptDigest, 'DRAINED.receiptDigest'),
      proof: parseProof(record.proof),
    };
  });
}

export function parseSupervisorAcknowledgement(
  input: string | Buffer,
): SupervisorAcknowledgementMessage {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'ACK');
    exactKeys(record, ['schemaVersion', 'type', 'operationId', 'receiptDigest'], 'ACK');
    return {
      schemaVersion: literal(record.schemaVersion, 1, 'ACK.schemaVersion'),
      type: literal(record.type, 'ACK', 'ACK.type'),
      operationId: uuid(record.operationId, 'ACK.operationId'),
      receiptDigest: digest(record.receiptDigest, 'ACK.receiptDigest'),
    };
  });
}

export function parseDrainedReceipt(input: string | Buffer): DrainedReceipt {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'drained receipt');
    exactKeys(
      record,
      [
        'schemaVersion',
        'ownerId',
        'operationId',
        'ownerRecordDigest',
        'protocolDigest',
        'activeChildDigest',
        'delegatedBaselineDigest',
        'delegationContractDigest',
        'containmentDigest',
        'helperDigest',
        'supervisorIdentity',
        'proof',
        'drainReason',
        'drainedAt',
      ],
      'drained receipt',
    );
    const ownerId = uuid(record.ownerId, 'drained receipt.ownerId');
    const operationId = uuid(record.operationId, 'drained receipt.operationId');
    if (ownerId === operationId) invalid('receipt owner and operation binding must differ');
    const proof = parseProof(record.proof);
    const drainReason = parseDrainedReason(record.drainReason);
    if (
      (proof === 'never-started-containment-empty-v1' &&
        drainReason !== 'timeout' &&
        drainReason !== 'user-interrupt' &&
        drainReason !== 'parent-shutdown') ||
      (proof !== 'never-started-containment-empty-v1' &&
        drainReason !== 'natural' &&
        drainReason !== 'process-tree-not-empty' &&
        drainReason !== 'timeout' &&
        drainReason !== 'user-interrupt' &&
        drainReason !== 'parent-shutdown')
    ) {
      invalid('drained receipt proof and drainReason are inconsistent');
    }
    return {
      schemaVersion: literal(record.schemaVersion, 1, 'drained receipt.schemaVersion'),
      ownerId,
      operationId,
      ownerRecordDigest: digest(record.ownerRecordDigest, 'drained receipt.ownerRecordDigest'),
      protocolDigest: digest(record.protocolDigest, 'drained receipt.protocolDigest'),
      activeChildDigest: digest(record.activeChildDigest, 'drained receipt.activeChildDigest'),
      delegatedBaselineDigest: digest(
        record.delegatedBaselineDigest,
        'drained receipt.delegatedBaselineDigest',
      ),
      delegationContractDigest: digest(
        record.delegationContractDigest,
        'drained receipt.delegationContractDigest',
      ),
      containmentDigest: digest(record.containmentDigest, 'drained receipt.containmentDigest'),
      helperDigest: digest(record.helperDigest, 'drained receipt.helperDigest'),
      supervisorIdentity: boundedString(
        record.supervisorIdentity,
        'drained receipt.supervisorIdentity',
      ),
      proof,
      drainReason,
      drainedAt: timestamp(record.drainedAt, 'drained receipt.drainedAt'),
    };
  });
}

function encodeAndCheck<T>(value: T, parser: (bytes: Buffer) => T): Buffer {
  const bytes = jsonBytes(value);
  parser(bytes);
  return bytes;
}

export function encodeSupervisorData(input: {
  readonly operationId: string;
  readonly target: SupervisorTarget;
}): Buffer {
  return encodeAndCheck(
    { schemaVersion: 1 as const, type: 'DATA' as const, ...input },
    parseSupervisorData,
  );
}

export function encodeSupervisorStart(operationId: string, activeChildDigest: string): Buffer {
  return encodeAndCheck(
    { schemaVersion: 1 as const, type: 'START' as const, operationId, activeChildDigest },
    parseSupervisorStart,
  );
}

export function encodeSupervisorTerminate(
  operationId: string,
  reason: SupervisorTerminationReason,
): Buffer {
  return encodeAndCheck(
    { schemaVersion: 1 as const, type: 'TERMINATE' as const, operationId, reason },
    parseSupervisorTerminate,
  );
}

export function encodeSupervisorAbortBeforeStart(operationId: string): Buffer {
  return encodeAndCheck(
    { schemaVersion: 1 as const, type: 'ABORT_BEFORE_START' as const, operationId },
    parseSupervisorAbortBeforeStart,
  );
}

export function encodeSupervisorAcknowledgement(
  operationId: string,
  receiptDigest: string,
): Buffer {
  return encodeAndCheck(
    { schemaVersion: 1 as const, type: 'ACK' as const, operationId, receiptDigest },
    parseSupervisorAcknowledgement,
  );
}

function sameValue(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function assertBindingShape(binding: PreparedBoundSafetyBinding): void {
  uuid(binding.ownerId, 'binding.ownerId');
  uuid(binding.operationId, 'binding.operationId');
  digest(binding.ownerRecordDigest, 'binding.ownerRecordDigest');
  digest(binding.protocolDigest, 'binding.protocolDigest');
  digest(binding.activeChildDigest, 'binding.activeChildDigest');
  digest(binding.delegatedBaselineDigest, 'binding.delegatedBaselineDigest');
  digest(binding.delegationContractDigest, 'binding.delegationContractDigest');
  digest(binding.helperDigest, 'binding.helperDigest');
  assertDescriptorConsistency(binding.supervisor);
}

export class SupervisorProtocol {
  #state: SupervisorProtocolState = 'bound';
  #preparedBinding: PreparedBoundSafetyBinding | undefined;
  #containment: ContainmentDescriptor | undefined;
  #armedBinding: ArmedSafetyBinding | undefined;
  #receiptDigest: string | undefined;
  #terminationReason: SupervisorTerminationReason | undefined;

  constructor(
    private readonly context: {
      readonly ownerId: string;
      readonly operationId: string;
      readonly supervisor: BoundSupervisorDescriptor;
    },
  ) {
    uuid(context.ownerId, 'context.ownerId');
    uuid(context.operationId, 'context.operationId');
    if (context.ownerId === context.operationId) invalid('ownerId and operationId must differ');
    assertDescriptorConsistency(context.supervisor);
  }

  get state(): SupervisorProtocolState {
    return this.#state;
  }

  get containmentDigest(): string {
    if (this.#containment === undefined)
      return this.#fail('containment is not ready in this state');
    return digestBytes(jsonBytes(this.#containment));
  }

  get terminationReason(): SupervisorTerminationReason | undefined {
    return this.#terminationReason;
  }

  #fail(message: string): never {
    this.#state = 'failed';
    return invalid(message);
  }

  #expectState(expected: SupervisorProtocolState): void {
    if (this.#state !== expected) this.#fail(`message is not allowed in state ${this.#state}`);
  }

  #expectOperation(operationId: string): void {
    if (operationId !== this.context.operationId) this.#fail('message operation binding mismatch');
  }

  acceptData(input: string | Buffer, binding: PreparedBoundSafetyBinding): SupervisorTarget {
    this.#expectState('bound');
    let message: SupervisorDataMessage;
    try {
      message = parseSupervisorData(input);
      assertBindingShape(binding);
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    this.#expectOperation(message.operationId);
    if (
      binding.ownerId !== this.context.ownerId ||
      binding.operationId !== this.context.operationId ||
      binding.helperDigest !== this.context.supervisor.helperDigest ||
      !sameValue(binding.supervisor, this.context.supervisor)
    ) {
      this.#fail('prepared-bound safety binding mismatch');
    }
    this.#preparedBinding = structuredClone(binding);
    this.#state = 'data-accepted';
    return structuredClone(message.target);
  }

  containmentReady(containment: ContainmentDescriptor): void {
    this.#expectState('data-accepted');
    let parsed: ContainmentDescriptor;
    try {
      parsed = parseContainmentDescriptor(containment);
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    if (parsed.platform !== this.context.supervisor.platform) {
      this.#fail('containment platform does not match bound supervisor');
    }
    this.#containment = structuredClone(parsed);
    this.#state = 'containment-ready';
  }

  #validateArmedBinding(binding: ArmedSafetyBinding): void {
    assertBindingShape(binding);
    const prepared = this.#preparedBinding;
    const containment = this.#containment;
    if (!prepared || !containment) this.#fail('prepared or containment binding is unavailable');
    if (
      binding.ownerId !== prepared.ownerId ||
      binding.operationId !== prepared.operationId ||
      binding.ownerRecordDigest !== prepared.ownerRecordDigest ||
      binding.protocolDigest !== prepared.protocolDigest ||
      binding.delegatedBaselineDigest !== prepared.delegatedBaselineDigest ||
      binding.delegationContractDigest !== prepared.delegationContractDigest ||
      binding.helperDigest !== prepared.helperDigest ||
      !sameValue(binding.supervisor, prepared.supervisor) ||
      !sameValue(binding.containment, containment) ||
      binding.containmentDigest !== digestBytes(jsonBytes(containment))
    ) {
      this.#fail('armed safety binding mismatch');
    }
  }

  acceptStart(input: string | Buffer, binding: ArmedSafetyBinding): boolean {
    if (
      this.#state !== 'containment-ready' &&
      this.#state !== 'termination-requested-before-start'
    ) {
      this.#fail(`message is not allowed in state ${this.#state}`);
    }
    let message: SupervisorStartMessage;
    try {
      message = parseSupervisorStart(input);
      this.#validateArmedBinding(binding);
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    this.#expectOperation(message.operationId);
    if (message.activeChildDigest !== binding.activeChildDigest) {
      this.#fail('START active-child digest mismatch');
    }
    if (this.#state === 'termination-requested-before-start') return false;
    this.#armedBinding = structuredClone(binding);
    this.#state = 'start-accepted';
    return true;
  }

  acceptTerminate(
    input: string | Buffer,
    armedBinding?: ArmedSafetyBinding,
  ): SupervisorTerminationReason {
    let message: SupervisorTerminateMessage;
    try {
      message = parseSupervisorTerminate(input);
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    this.#expectOperation(message.operationId);
    if (
      this.#state === 'termination-requested-before-start' ||
      this.#state === 'termination-requested-after-start' ||
      this.#state === 'drained' ||
      this.#state === 'acknowledged'
    ) {
      return this.#terminationReason ?? message.reason;
    }
    if (this.#state === 'containment-ready') {
      if (!armedBinding) this.#fail('armed safety binding is required before START');
      try {
        this.#validateArmedBinding(armedBinding);
      } catch (error) {
        this.#state = 'failed';
        throw error;
      }
      this.#armedBinding = structuredClone(armedBinding);
      this.#terminationReason = message.reason;
      this.#state = 'termination-requested-before-start';
      return message.reason;
    }
    if (this.#state !== 'start-accepted') {
      this.#fail(`TERMINATE is not allowed in state ${this.#state}`);
    }
    this.#terminationReason = message.reason;
    this.#state = 'termination-requested-after-start';
    return message.reason;
  }

  abortBeforeStart(
    input: string | Buffer,
    drainedAt: Date = new Date(),
  ): SupervisorPrestartDrainedMessage {
    if (!['bound', 'data-accepted', 'containment-ready'].includes(this.#state)) {
      this.#fail(`ABORT_BEFORE_START is not allowed in state ${this.#state}`);
    }
    let message: SupervisorAbortBeforeStartMessage;
    try {
      message = parseSupervisorAbortBeforeStart(input);
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    this.#expectOperation(message.operationId);
    const output: SupervisorPrestartDrainedMessage = {
      schemaVersion: 1,
      type: 'PRESTART_DRAINED',
      operationId: this.context.operationId,
      supervisorPid: this.context.supervisor.supervisorPid,
      supervisorIdentity: this.context.supervisor.supervisorIdentity,
      proof: 'prestart-containment-empty-and-pipes-eof-v1',
      drainedAt: drainedAt.toISOString(),
    };
    parseSupervisorPrestartDrained(jsonBytes(output));
    this.#state = 'prestart-drained';
    return output;
  }

  drain(
    proof: Exclude<DrainedProof, 'never-started-containment-empty-v1'>,
    drainReason: 'natural' | 'process-tree-not-empty' = 'natural',
    drainedAt = new Date(),
  ): DrainedProtocolOutput {
    this.#expectState('start-accepted');
    if (
      (this.context.supervisor.platform === 'posix-process-group-v1' &&
        proof !== 'posix-group-empty-and-pipes-eof-v1') ||
      (this.context.supervisor.platform === 'windows-job-v1' &&
        proof !== 'windows-job-zero-and-pipes-eof-v1')
    ) {
      this.#fail('drained proof does not match platform');
    }
    return this.#buildDrained(proof, drainReason, drainedAt);
  }

  drainNeverStartedAfterParentShutdown(
    binding: ArmedSafetyBinding,
    drainedAt = new Date(),
  ): DrainedProtocolOutput {
    this.#expectState('containment-ready');
    try {
      this.#validateArmedBinding(binding);
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    this.#armedBinding = structuredClone(binding);
    return this.#buildDrained('never-started-containment-empty-v1', 'parent-shutdown', drainedAt);
  }

  drainAfterTermination(proof: DrainedProof, drainedAt = new Date()): DrainedProtocolOutput {
    if (
      this.#state !== 'termination-requested-before-start' &&
      this.#state !== 'termination-requested-after-start'
    ) {
      this.#fail(`termination drain is not allowed in state ${this.#state}`);
    }
    const beforeStart = this.#state === 'termination-requested-before-start';
    if (
      (beforeStart && proof !== 'never-started-containment-empty-v1') ||
      (!beforeStart && proof === 'never-started-containment-empty-v1')
    ) {
      this.#fail('termination drain proof does not match START acceptance');
    }
    if (
      proof !== 'never-started-containment-empty-v1' &&
      ((this.context.supervisor.platform === 'posix-process-group-v1' &&
        proof !== 'posix-group-empty-and-pipes-eof-v1') ||
        (this.context.supervisor.platform === 'windows-job-v1' &&
          proof !== 'windows-job-zero-and-pipes-eof-v1'))
    ) {
      this.#fail('termination drain proof does not match platform');
    }
    const reason = this.#terminationReason;
    if (!reason) this.#fail('termination reason is unavailable');
    return this.#buildDrained(proof, reason, drainedAt);
  }

  #buildDrained(
    proof: DrainedProof,
    drainReason: DrainedReason,
    drainedAt: Date,
  ): DrainedProtocolOutput {
    const binding = this.#armedBinding;
    if (!binding) this.#fail('armed binding is unavailable for receipt');
    const receipt: DrainedReceipt = {
      schemaVersion: 1,
      ownerId: binding.ownerId,
      operationId: binding.operationId,
      ownerRecordDigest: binding.ownerRecordDigest,
      protocolDigest: binding.protocolDigest,
      activeChildDigest: binding.activeChildDigest,
      delegatedBaselineDigest: binding.delegatedBaselineDigest,
      delegationContractDigest: binding.delegationContractDigest,
      containmentDigest: binding.containmentDigest,
      helperDigest: binding.helperDigest,
      supervisorIdentity: binding.supervisor.supervisorIdentity,
      proof,
      drainReason,
      drainedAt: drainedAt.toISOString(),
    };
    const receiptBytes = encodeAndCheck(receipt, parseDrainedReceipt);
    const receiptDigest = digestBytes(receiptBytes);
    const message: SupervisorDrainedMessage = {
      schemaVersion: 1,
      type: 'DRAINED',
      operationId: binding.operationId,
      receiptDigest,
      proof,
    };
    const messageBytes = encodeAndCheck(message, parseSupervisorDrained);
    this.#receiptDigest = receiptDigest;
    this.#state = 'drained';
    return { receipt, receiptBytes, receiptDigest, message, messageBytes };
  }

  acknowledge(input: string | Buffer): void {
    this.#expectState('drained');
    let message: SupervisorAcknowledgementMessage;
    try {
      message = parseSupervisorAcknowledgement(input);
    } catch (error) {
      this.#state = 'failed';
      throw error;
    }
    this.#expectOperation(message.operationId);
    if (message.receiptDigest !== this.#receiptDigest) this.#fail('ACK receipt digest mismatch');
    this.#state = 'acknowledged';
  }
}
