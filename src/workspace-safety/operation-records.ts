import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  parseDelegatedSemanticContract,
  type DelegatedSemanticContract,
} from '../contracts/delegated-operation-contract.js';
import {
  DELEGATION_LIMITS,
  parseDelegatedBaselineBytes,
  type BaselineScanHooks,
  type DelegatedBaseline,
  type DelegationContract,
} from './baseline.js';
import { digestBytes, jsonBytes, pathExists, readExactFile } from './filesystem.js';
import { MAX_SAFETY_PID, MAX_SAFETY_STRING_LENGTH, parseJsonRecord } from './schema.js';
import {
  parseContainmentDescriptor,
  type BoundSupervisorDescriptor,
  type ContainmentDescriptor,
  type OperationPlatform,
  type SignalIsolation,
} from './supervisor-protocol.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, WorkspaceSafetyError } from './types.js';

export {
  ABORT_STAGING_PATTERN,
  RECEIPT_STAGING_PATTERN,
  readOperationInstalledFact,
  recoverOperationInstalledFact,
} from './operation-installed-fact.js';
export type {
  OperationInstalledFact,
  ReadOperationInstalledFactOptions,
} from './operation-installed-fact.js';

export const ACTIVE_CHILD_FILE = 'active-child.json';
export const DELEGATED_BASELINE_FILE = 'delegated-baseline.json';
export const PRESTART_ABORT_FILE = 'prestart-abort.json';
export const DRAINED_RECEIPT_FILE = 'drained-receipt.json';
export const SETTLED_OPERATIONS_DIR = 'settled-operations';

export const ACTIVE_CHILD_SCHEMA_VERSION = 2 as const;
export const PRESTART_ABORT_SCHEMA_VERSION = 1 as const;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const ISO_MILLISECOND_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
export const OPERATION_STAGING_PATTERN =
  /^operation\.prepare-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const LEASE_STAGING_PATTERN =
  /^lease\.prepare-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const INERT_ACTIVE_LEASE_STAGING_PATTERN =
  /^(?:operation|mutation|recovery)\.prepare-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
export const ACTIVE_STAGING_PREFIX = 'active-child.prepare-';
export const RECEIPT_STAGING_PREFIX = 'drained-receipt.prepare-';
export const ABORT_STAGING_PREFIX = 'prestart-abort.prepare-';

export function settledOperationDirectoryName(
  operationIdValue: string,
  authorityFiles: readonly (readonly [string, Uint8Array])[],
): string {
  const operationId = uuid(operationIdValue, 'settled operationId');
  const operationDigest = digestBytes(
    Buffer.concat(
      [...authorityFiles]
        .sort(([left], [right]) => left.localeCompare(right, 'en'))
        .flatMap(([name, bytes]) => [Buffer.from(`${name}\0`, 'utf8'), Buffer.from(bytes)]),
    ),
  );
  return `${operationId}-${operationDigest.slice('sha256:'.length, 'sha256:'.length + 16)}`;
}

export type OperationKind =
  'builder' | 'validator' | 'quality-check' | 'tdd-check' | 'final-review';
export type OperationDelegation = 'builder-v1' | 'validator-v1' | 'read-only-v1';

interface ActiveChildBase {
  readonly schemaVersion: typeof ACTIVE_CHILD_SCHEMA_VERSION;
  readonly ownerId: string;
  readonly operationId: string;
  readonly kind: OperationKind;
  readonly delegation: OperationDelegation;
  readonly platform: OperationPlatform;
  readonly helperDigest: string;
  readonly delegatedBaselineDigest: string;
  readonly delegationContractDigest: string;
  readonly startedAt: string;
  readonly updatedAt: string;
}

export interface PreparedActiveChild extends ActiveChildBase {
  readonly state: 'prepared';
}

export interface PreparedBoundActiveChild extends ActiveChildBase {
  readonly state: 'prepared-bound';
  readonly supervisorPid: number;
  readonly supervisorIdentity: string;
  readonly signalIsolation: SignalIsolation;
}

export interface ArmedActiveChild extends ActiveChildBase {
  readonly state: 'armed';
  readonly supervisorPid: number;
  readonly supervisorIdentity: string;
  readonly signalIsolation: SignalIsolation;
  readonly containment: ContainmentDescriptor;
  readonly containmentDigest: string;
}

export type ActiveChildRecord = PreparedActiveChild | PreparedBoundActiveChild | ArmedActiveChild;

export interface PrestartAbortRecord {
  readonly schemaVersion: typeof PRESTART_ABORT_SCHEMA_VERSION;
  readonly ownerId: string;
  readonly operationId: string;
  readonly activeChildDigest: string;
  readonly delegatedBaselineDigest: string;
  readonly reason: 'setup-failed' | 'capability-unavailable' | 'user-interrupt';
  readonly proof:
    | 'supervisor-never-bound-v1'
    | 'supervisor-prestart-empty-v1'
    | 'recovery-supervisor-exact-dead-never-armed-v1';
  readonly prestartDrainedDigest: string | null;
  readonly abortedAt: string;
}

export type PrestartAbortFacts =
  | {
      readonly reason: PrestartAbortRecord['reason'];
      readonly proof: 'supervisor-never-bound-v1';
      readonly supervisor: 'never-created' | 'dead';
      readonly containment: 'not-created';
    }
  | {
      readonly reason: PrestartAbortRecord['reason'];
      readonly proof: 'supervisor-prestart-empty-v1';
      readonly supervisor: 'dead';
      readonly containment: 'empty';
      readonly prestartDrainedBytes: Buffer;
    };

export interface ArmedSettlementFacts {
  readonly supervisor: 'dead';
  readonly containment: 'empty';
}

export interface OperationHooksControlled {
  readonly beforeOperationInstall?: (stagingPath: string) => void | Promise<void>;
  readonly afterOperationInstalled?: (operationPath: string) => void | Promise<void>;
  readonly beforeActiveCommit?: (
    state: ActiveChildRecord['state'],
    stagingPath: string,
  ) => void | Promise<void>;
  readonly afterActiveCommitted?: (state: ActiveChildRecord['state']) => void | Promise<void>;
  readonly beforeAbortInstall?: (stagingPath: string) => void | Promise<void>;
  readonly afterAbortInstalled?: () => void | Promise<void>;
  readonly beforeReceiptInstall?: (stagingPath: string) => void | Promise<void>;
  readonly afterReceiptInstalled?: () => void | Promise<void>;
  readonly beforeSettle?: (targetPath: string) => void | Promise<void>;
}

export interface PrepareWorkspaceOperationBaseOptionsControlled {
  readonly operationId?: string;
  readonly platform: OperationPlatform;
  readonly helperBytes: Uint8Array;
  readonly baselineHooks?: BaselineScanHooks;
  readonly now?: () => Date;
  readonly hooks?: OperationHooksControlled;
}

export type OperationDelegationScope =
  | {
      readonly kind: 'builder';
      readonly delegation: 'builder-v1';
      readonly storyId: string;
      readonly acceptanceHash: string;
      readonly checkCount: number;
      readonly requestId?: never;
      readonly gitHead?: never;
    }
  | {
      readonly kind: 'validator';
      readonly delegation: 'validator-v1';
      readonly storyId: string;
      readonly requestId: string;
      readonly acceptanceHash: string;
      readonly checkCount: number;
      readonly gitHead: string;
    }
  | {
      readonly kind: 'quality-check' | 'tdd-check' | 'final-review';
      readonly delegation: 'read-only-v1';
      readonly storyId?: never;
      readonly requestId?: never;
      readonly acceptanceHash?: never;
      readonly checkCount?: never;
      readonly gitHead?: never;
    };

export type PrepareWorkspaceOperationOptionsControlled =
  PrepareWorkspaceOperationBaseOptionsControlled & OperationDelegationScope;

export type OperationHandleState =
  ActiveChildRecord['state'] | 'receipt-installed' | 'quarantined' | 'settled' | 'failed';
type StrictRecord = Record<string, unknown>;

export const NEVER: Promise<never> = new Promise(() => undefined);

export function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', `Invalid workspace operation: ${message}`);
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

export function uuid(value: unknown, field: string): string {
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

export function timestamp(value: unknown, field: string): string {
  const parsed = pattern(value, field, ISO_MILLISECOND_UTC_PATTERN);
  const milliseconds = Date.parse(parsed);
  if (!Number.isFinite(milliseconds) || new Date(milliseconds).toISOString() !== parsed) {
    invalid(`${field} must be a canonical UTC timestamp`);
  }
  return parsed;
}

export function parseKind(value: unknown): OperationKind {
  if (
    value === 'builder' ||
    value === 'validator' ||
    value === 'quality-check' ||
    value === 'tdd-check' ||
    value === 'final-review'
  ) {
    return value;
  }
  return invalid('kind has an unsupported value');
}

export function parseDelegation(value: unknown): OperationDelegation {
  if (value === 'builder-v1' || value === 'validator-v1' || value === 'read-only-v1') return value;
  return invalid('delegation has an unsupported value');
}

export function parsePlatform(value: unknown): OperationPlatform {
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

function expectedDelegation(kind: OperationKind): OperationDelegation {
  if (kind === 'builder') return 'builder-v1';
  if (kind === 'validator') return 'validator-v1';
  return 'read-only-v1';
}

function jsonPointerToken(value: string): string {
  return value.replaceAll('~', '~0').replaceAll('/', '~1');
}

export function delegationScope(
  kind: OperationKind,
  delegation: OperationDelegation,
  storyIdValue: unknown,
  requestIdValue: unknown,
  acceptanceHashValue: unknown,
  checkCountValue: unknown,
  gitHeadValue: unknown,
): { contract: DelegationContract; requestId?: string } {
  if (expectedDelegation(kind) !== delegation) invalid('operation kind and delegation mismatch');
  if (kind === 'builder') {
    const storyId = boundedString(storyIdValue, 'builder.storyId');
    if (requestIdValue !== undefined) invalid('builder must not declare requestId');
    if (gitHeadValue !== undefined) invalid('builder must not declare gitHead');
    const semantic = semanticContract({
      version: 'builder-state-v1',
      storyId,
      acceptanceHash: acceptanceHashValue,
      checkCount: checkCountValue,
    });
    const storyPointer = `/${jsonPointerToken(storyId)}`;
    const mutableJsonPointers = [
      `${storyPointer}/blocked`,
      `${storyPointer}/notes`,
      `${storyPointer}/passes`,
    ];
    if (
      mutableJsonPointers.some(
        (pointer) => Buffer.byteLength(pointer, 'utf8') > DELEGATION_LIMITS.pointerBytes,
      )
    ) {
      invalid('builder.storyId exceeds the delegated JSON pointer byte limit');
    }
    return {
      contract: {
        version: 'builder-v1',
        semantic,
        rules: [
          {
            path: 'evidence.jsonl',
            semantics: 'append-only',
            allow: ['create', 'modify'],
          },
          {
            path: 'progress.md',
            semantics: 'append-only',
            allow: ['create', 'modify'],
          },
          { path: 'screenshots', semantics: 'add-only-directory', allow: ['create'] },
          {
            path: 'state.json',
            semantics: 'json-mutable-pointers',
            allow: ['modify'],
            mutableJsonPointers,
          },
        ],
      },
    };
  }
  if (kind === 'validator') {
    const storyId = boundedString(storyIdValue, 'validator.storyId');
    const requestId = uuid(requestIdValue, 'validator.requestId');
    const semantic = semanticContract({
      version: 'validator-result-v1',
      requestId,
      storyId,
      acceptanceHash: acceptanceHashValue,
      checkCount: checkCountValue,
      gitHead: gitHeadValue,
    });
    return {
      requestId,
      contract: {
        version: 'validator-v1',
        semantic,
        rules: [
          {
            path: 'evidence.jsonl',
            semantics: 'append-only',
            allow: ['create', 'modify'],
          },
          { path: 'screenshots', semantics: 'add-only-directory', allow: ['create'] },
          {
            path: 'validation-result.json',
            semantics: 'whole-file',
            allow: ['create'],
          },
        ],
      },
    };
  }
  if (
    storyIdValue !== undefined ||
    requestIdValue !== undefined ||
    acceptanceHashValue !== undefined ||
    checkCountValue !== undefined ||
    gitHeadValue !== undefined
  ) {
    invalid('read-only operation must not declare business semantic identity');
  }
  return {
    contract: {
      version: 'read-only-v1',
      semantic: { version: 'read-only-v1' },
      rules: [],
    },
  };
}

function semanticContract(value: unknown): DelegatedSemanticContract {
  const parsed = parseDelegatedSemanticContract(value);
  if (!parsed.ok) invalid(parsed.diagnostic);
  return parsed.value;
}

export function delegationContractForOperation(
  options: OperationDelegationScope,
): DelegationContract {
  const kind = parseKind(options.kind);
  const delegation = parseDelegation(options.delegation);
  return delegationScope(
    kind,
    delegation,
    options.storyId,
    options.requestId,
    options.acceptanceHash,
    options.checkCount,
    options.gitHead,
  ).contract;
}

export function sameDelegationContract(
  actual: DelegationContract,
  expected: DelegationContract,
): boolean {
  return JSON.stringify(actual) === JSON.stringify(expected);
}

export function parseDelegatedBaselineRecord(input: string | Buffer): DelegatedBaseline {
  return parseDelegatedBaselineBytes(input);
}

function parseActiveBase(record: StrictRecord): ActiveChildBase {
  const kind = parseKind(record.kind);
  const delegation = parseDelegation(record.delegation);
  if (expectedDelegation(kind) !== delegation) invalid('operation kind and delegation mismatch');
  const startedAt = timestamp(record.startedAt, 'active-child.startedAt');
  const updatedAt = timestamp(record.updatedAt, 'active-child.updatedAt');
  if (Date.parse(updatedAt) < Date.parse(startedAt)) invalid('active-child time moved backwards');
  return {
    schemaVersion: literal(
      record.schemaVersion,
      ACTIVE_CHILD_SCHEMA_VERSION,
      'active-child.schemaVersion',
    ),
    ownerId: uuid(record.ownerId, 'active-child.ownerId'),
    operationId: uuid(record.operationId, 'active-child.operationId'),
    kind,
    delegation,
    platform: parsePlatform(record.platform),
    helperDigest: digest(record.helperDigest, 'active-child.helperDigest'),
    delegatedBaselineDigest: digest(
      record.delegatedBaselineDigest,
      'active-child.delegatedBaselineDigest',
    ),
    delegationContractDigest: digest(
      record.delegationContractDigest,
      'active-child.delegationContractDigest',
    ),
    startedAt,
    updatedAt,
  };
}

const ACTIVE_BASE_KEYS = [
  'schemaVersion',
  'ownerId',
  'operationId',
  'state',
  'kind',
  'delegation',
  'platform',
  'helperDigest',
  'delegatedBaselineDigest',
  'delegationContractDigest',
  'startedAt',
  'updatedAt',
] as const;

export function parseActiveChildRecord(input: string | Buffer): ActiveChildRecord {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'active-child');
    const state = record.state;
    if (state === 'prepared') {
      exactKeys(record, ACTIVE_BASE_KEYS, 'prepared active-child');
      const base = parseActiveBase(record);
      if (base.startedAt !== base.updatedAt) invalid('prepared active-child timestamps must match');
      return { ...base, state };
    }
    const boundKeys = [
      ...ACTIVE_BASE_KEYS,
      'supervisorPid',
      'supervisorIdentity',
      'signalIsolation',
    ] as const;
    if (state === 'prepared-bound') {
      exactKeys(record, boundKeys, 'prepared-bound active-child');
      return {
        ...parseActiveBase(record),
        state,
        supervisorPid: pid(record.supervisorPid, 'active-child.supervisorPid'),
        supervisorIdentity: boundedString(
          record.supervisorIdentity,
          'active-child.supervisorIdentity',
        ),
        signalIsolation: parseSignalIsolation(record.signalIsolation),
      };
    }
    if (state === 'armed') {
      exactKeys(record, [...boundKeys, 'containment', 'containmentDigest'], 'armed active-child');
      const base = parseActiveBase(record);
      const containment = parseContainmentDescriptor(record.containment);
      const containmentDigest = digest(record.containmentDigest, 'active-child.containmentDigest');
      if (
        containment.platform !== base.platform ||
        containmentDigest !== digestBytes(jsonBytes(containment))
      ) {
        invalid('active-child containment binding mismatch');
      }
      return {
        ...base,
        state,
        supervisorPid: pid(record.supervisorPid, 'active-child.supervisorPid'),
        supervisorIdentity: boundedString(
          record.supervisorIdentity,
          'active-child.supervisorIdentity',
        ),
        signalIsolation: parseSignalIsolation(record.signalIsolation),
        containment,
        containmentDigest,
      };
    }
    return invalid('active-child state has an unsupported value');
  });
}

export function parsePrestartAbortRecord(input: string | Buffer): PrestartAbortRecord {
  return parseJsonRecord(input, (value) => {
    const record = asRecord(value, 'prestart abort');
    exactKeys(
      record,
      [
        'schemaVersion',
        'ownerId',
        'operationId',
        'activeChildDigest',
        'delegatedBaselineDigest',
        'reason',
        'proof',
        'prestartDrainedDigest',
        'abortedAt',
      ],
      'prestart abort',
    );
    const reason = record.reason;
    if (
      reason !== 'setup-failed' &&
      reason !== 'capability-unavailable' &&
      reason !== 'user-interrupt'
    ) {
      invalid('prestart abort reason has an unsupported value');
    }
    const proof = record.proof;
    if (
      proof !== 'supervisor-never-bound-v1' &&
      proof !== 'supervisor-prestart-empty-v1' &&
      proof !== 'recovery-supervisor-exact-dead-never-armed-v1'
    ) {
      invalid('prestart abort proof has an unsupported value');
    }
    const prestartDrainedDigest =
      record.prestartDrainedDigest === null
        ? null
        : digest(record.prestartDrainedDigest, 'prestart abort.prestartDrainedDigest');
    if (
      ((proof === 'supervisor-never-bound-v1' ||
        proof === 'recovery-supervisor-exact-dead-never-armed-v1') &&
        prestartDrainedDigest !== null) ||
      (proof === 'supervisor-prestart-empty-v1' && prestartDrainedDigest === null)
    ) {
      invalid('prestart abort proof and drained binding mismatch');
    }
    return {
      schemaVersion: literal(
        record.schemaVersion,
        PRESTART_ABORT_SCHEMA_VERSION,
        'prestart abort.schemaVersion',
      ),
      ownerId: uuid(record.ownerId, 'prestart abort.ownerId'),
      operationId: uuid(record.operationId, 'prestart abort.operationId'),
      activeChildDigest: digest(record.activeChildDigest, 'prestart abort.activeChildDigest'),
      delegatedBaselineDigest: digest(
        record.delegatedBaselineDigest,
        'prestart abort.delegatedBaselineDigest',
      ),
      reason,
      proof,
      prestartDrainedDigest,
      abortedAt: timestamp(record.abortedAt, 'prestart abort.abortedAt'),
    };
  });
}

export async function assertOrdinaryDirectory(path: string, label: string): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory())
      invalid(`${label} must be an ordinary directory`);
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    const wrapped = new WorkspaceSafetyError('invalid', `${label} is missing or unreadable`);
    Object.defineProperty(wrapped, 'cause', { value: error, enumerable: false });
    throw wrapped;
  }
}

export async function ensureSettledDirectory(activeLease: string): Promise<string> {
  const path = join(activeLease, SETTLED_OPERATIONS_DIR);
  try {
    await mkdir(path, { mode: 0o700 });
  } catch (error) {
    if (!(await pathExists(path))) throw error;
  }
  await assertOrdinaryDirectory(path, SETTLED_OPERATIONS_DIR);
  return path;
}

async function scanFrozenSafetyTree(protocolRoot: string): Promise<string> {
  await assertOrdinaryDirectory(protocolRoot, 'protocol root');
  const observations: string[] = [];
  const walk = async (directory: string, relativeDirectory: string): Promise<void> => {
    const names = (await readdir(directory)).sort((left, right) => left.localeCompare(right, 'en'));
    for (const name of names) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
      if (relativePath === `${ACTIVE_LEASE_DIR}/${OPERATION_DIR}`) continue;
      const path = join(directory, name);
      if (
        (relativeDirectory === '' && LEASE_STAGING_PATTERN.test(name)) ||
        (relativeDirectory === ACTIVE_LEASE_DIR && INERT_ACTIVE_LEASE_STAGING_PATTERN.test(name))
      ) {
        await assertOrdinaryDirectory(path, `inert staging ${relativePath}`);
        continue;
      }
      const info = await lstat(path);
      if (info.isSymbolicLink()) invalid(`frozen safety path is a symlink: ${relativePath}`);
      if (info.isDirectory()) {
        observations.push(`directory\0${relativePath}`);
        await walk(path, relativePath);
        continue;
      }
      if (!info.isFile()) invalid(`frozen safety path has an unsupported type: ${relativePath}`);
      observations.push(`file\0${relativePath}\0${digestBytes(await readExactFile(path))}`);
    }
  };
  await walk(protocolRoot, '');
  return digestBytes(Buffer.from(observations.join('\n'), 'utf8'));
}

export async function captureStableFrozenSafetyTree(protocolRoot: string): Promise<string> {
  const first = await scanFrozenSafetyTree(protocolRoot);
  const second = await scanFrozenSafetyTree(protocolRoot);
  if (first !== second) invalid('frozen safety paths changed during verification');
  return first;
}

export function descriptorFromActive(
  active: PreparedBoundActiveChild | ArmedActiveChild,
): BoundSupervisorDescriptor {
  return {
    platform: active.platform,
    supervisorPid: active.supervisorPid,
    supervisorIdentity: active.supervisorIdentity,
    signalIsolation: active.signalIsolation,
    helperDigest: active.helperDigest,
  };
}
