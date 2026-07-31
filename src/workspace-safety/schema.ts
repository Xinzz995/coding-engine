import { createHash } from 'node:crypto';
import type {
  OwnerCommand,
  OwnerRecord,
  ProcessIdentity,
  ProcessIdentityKind,
  ProtocolRecord,
  WorkspaceMarker,
} from './types.js';
import {
  OWNER_SCHEMA_VERSION,
  PROTOCOL_SCHEMA_VERSION,
  WORKSPACE_MARKER_SCHEMA_VERSION,
  WORKSPACE_PROTOCOL,
  WORKSPACE_SAFETY_VERSION,
  WorkspaceSafetyError,
} from './types.js';

export const MAX_SAFETY_RECORD_BYTES = 64 * 1024;
export const MAX_SAFETY_STRING_LENGTH = 4096;
export const MAX_SAFETY_PID = 0xffff_ffff;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const ISO_MILLISECOND_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const UNSIGNED_64_MAX = 0xffff_ffff_ffff_ffffn;
const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MONTHS = [
  'Jan',
  'Feb',
  'Mar',
  'Apr',
  'May',
  'Jun',
  'Jul',
  'Aug',
  'Sep',
  'Oct',
  'Nov',
  'Dec',
] as const;

const OWNER_COMMANDS = new Set<OwnerCommand>([
  'workspace-init',
  'run',
  'repair',
  'report',
  'apply-prd',
  'review-decision',
]);

const PROCESS_IDENTITY_KINDS = new Set<ProcessIdentityKind>([
  'linux-boot-start',
  'macos-boot-start',
  'windows-filetime',
]);

type StrictRecord = Record<string, unknown>;
export type SafetyRecordParser<T> = (value: unknown) => T;

export interface CoreRecordBindings {
  marker: WorkspaceMarker;
  protocol: ProtocolRecord;
  owner?: OwnerRecord;
  protocolBytes: string | Buffer;
  canonicalWorkspaceIdentity: string;
}

function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', `Invalid workspace safety record: ${message}`);
}

function asStrictRecord(value: unknown, name: string): StrictRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${name} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${name} must be a plain object`);
  }
  return value as StrictRecord;
}

function requireExactKeys(record: StrictRecord, expected: readonly string[], name: string): void {
  const expectedSet = new Set(expected);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !expectedSet.has(key)) {
      invalid(`${name} contains an unknown field`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(record, key)) invalid(`${name} is missing field ${key}`);
  }
}

function requireLiteral<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) invalid(`${field} has an unsupported value`);
  return expected;
}

function requireString(value: unknown, field: string): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_SAFETY_STRING_LENGTH) {
    return invalid(`${field} must be a bounded non-empty string`);
  }
  return value;
}

function requirePattern(value: unknown, field: string, pattern: RegExp): string {
  const parsed = requireString(value, field);
  if (!pattern.test(parsed)) invalid(`${field} has an invalid format`);
  return parsed;
}

function requireTimestamp(value: unknown, field: string): string {
  const parsed = requirePattern(value, field, ISO_MILLISECOND_UTC_PATTERN);
  const timestamp = Date.parse(parsed);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== parsed) {
    return invalid(`${field} is not a canonical UTC timestamp`);
  }
  return parsed;
}

function requirePid(value: unknown): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > MAX_SAFETY_PID) {
    return invalid('pid must be an unsigned 32-bit process id');
  }
  return value as number;
}

function requireEnum<T extends string>(value: unknown, values: ReadonlySet<T>, field: string): T {
  if (typeof value !== 'string' || !values.has(value as T)) {
    return invalid(`${field} has an unsupported value`);
  }
  return value as T;
}

function parseProcessIdentity(value: unknown): ProcessIdentity {
  const record = asStrictRecord(value, 'processIdentity');
  requireExactKeys(record, ['kind', 'value'], 'processIdentity');
  const kind = requireEnum(record.kind, PROCESS_IDENTITY_KINDS, 'processIdentity.kind');
  const identityValue = requireString(record.value, 'processIdentity.value');
  if (kind === 'macos-boot-start') {
    requireMacosStartIdentity(identityValue);
  } else if (!/^[1-9]\d{0,19}$/.test(identityValue) || BigInt(identityValue) > UNSIGNED_64_MAX) {
    invalid('processIdentity.value is not a canonical platform identity');
  }
  return {
    kind,
    value: identityValue,
  };
}

function requireMacosStartIdentity(value: string): void {
  const match =
    /^(Sun|Mon|Tue|Wed|Thu|Fri|Sat) (Jan|Feb|Mar|Apr|May|Jun|Jul|Aug|Sep|Oct|Nov|Dec) ([1-9]|[12]\d|3[01]) (\d{2}):(\d{2}):(\d{2}) (\d{4})$/.exec(
      value,
    );
  if (!match) invalid('processIdentity.value is not a canonical macOS start identity');
  const [, weekday, month, dayText, hourText, minuteText, secondText, yearText] = match;
  const monthIndex = MONTHS.indexOf(month as (typeof MONTHS)[number]);
  const date = new Date(
    Date.UTC(
      Number(yearText),
      monthIndex,
      Number(dayText),
      Number(hourText),
      Number(minuteText),
      Number(secondText),
    ),
  );
  if (
    monthIndex < 0 ||
    date.getUTCFullYear() !== Number(yearText) ||
    date.getUTCMonth() !== monthIndex ||
    date.getUTCDate() !== Number(dayText) ||
    date.getUTCHours() !== Number(hourText) ||
    date.getUTCMinutes() !== Number(minuteText) ||
    date.getUTCSeconds() !== Number(secondText) ||
    WEEKDAYS[date.getUTCDay()] !== weekday
  ) {
    invalid('processIdentity.value is not a real macOS UTC start time');
  }
}

export function parseWorkspaceMarker(value: unknown): WorkspaceMarker {
  const record = asStrictRecord(value, 'workspace marker');
  requireExactKeys(
    record,
    ['schemaVersion', 'initializedBy', 'workspaceIdentity', 'protocolDigest', 'initializedAt'],
    'workspace marker',
  );
  return {
    schemaVersion: requireLiteral(
      record.schemaVersion,
      WORKSPACE_MARKER_SCHEMA_VERSION,
      'schemaVersion',
    ),
    initializedBy: requireLiteral(record.initializedBy, WORKSPACE_SAFETY_VERSION, 'initializedBy'),
    workspaceIdentity: requirePattern(
      record.workspaceIdentity,
      'workspaceIdentity',
      SHA256_PATTERN,
    ),
    protocolDigest: requirePattern(record.protocolDigest, 'protocolDigest', SHA256_PATTERN),
    initializedAt: requireTimestamp(record.initializedAt, 'initializedAt'),
  };
}

export function parseProtocolRecord(value: unknown): ProtocolRecord {
  const record = asStrictRecord(value, 'protocol');
  requireExactKeys(
    record,
    ['schemaVersion', 'protocol', 'workspaceIdentity', 'createdBy', 'createdAt'],
    'protocol',
  );
  return {
    schemaVersion: requireLiteral(record.schemaVersion, PROTOCOL_SCHEMA_VERSION, 'schemaVersion'),
    protocol: requireLiteral(record.protocol, WORKSPACE_PROTOCOL, 'protocol'),
    workspaceIdentity: requirePattern(
      record.workspaceIdentity,
      'workspaceIdentity',
      SHA256_PATTERN,
    ),
    createdBy: requireLiteral(record.createdBy, WORKSPACE_SAFETY_VERSION, 'createdBy'),
    createdAt: requireTimestamp(record.createdAt, 'createdAt'),
  };
}

export function parseOwnerRecord(value: unknown): OwnerRecord {
  const record = asStrictRecord(value, 'owner');
  requireExactKeys(
    record,
    [
      'schemaVersion',
      'ownerId',
      'pid',
      'processIdentity',
      'bootIdentity',
      'hostId',
      'workspaceIdentity',
      'startedAt',
      'command',
    ],
    'owner',
  );
  return {
    schemaVersion: requireLiteral(record.schemaVersion, OWNER_SCHEMA_VERSION, 'schemaVersion'),
    ownerId: requirePattern(record.ownerId, 'ownerId', UUID_PATTERN),
    pid: requirePid(record.pid),
    processIdentity: parseProcessIdentity(record.processIdentity),
    bootIdentity: requirePattern(record.bootIdentity, 'bootIdentity', SHA256_PATTERN),
    hostId: requirePattern(record.hostId, 'hostId', SHA256_PATTERN),
    workspaceIdentity: requirePattern(
      record.workspaceIdentity,
      'workspaceIdentity',
      SHA256_PATTERN,
    ),
    startedAt: requireTimestamp(record.startedAt, 'startedAt'),
    command: requireEnum(record.command, OWNER_COMMANDS, 'command'),
  };
}

export function sha256SafetyBytes(input: string | Buffer): string {
  return `sha256:${createHash('sha256').update(input).digest('hex')}`;
}

export function validateCoreRecordBindings(bindings: CoreRecordBindings): void {
  const canonicalWorkspaceIdentity = requirePattern(
    bindings.canonicalWorkspaceIdentity,
    'canonicalWorkspaceIdentity',
    SHA256_PATTERN,
  );
  if (
    bindings.marker.workspaceIdentity !== canonicalWorkspaceIdentity ||
    bindings.protocol.workspaceIdentity !== canonicalWorkspaceIdentity ||
    (bindings.owner && bindings.owner.workspaceIdentity !== canonicalWorkspaceIdentity) ||
    bindings.marker.protocolDigest !== sha256SafetyBytes(bindings.protocolBytes)
  ) {
    invalid('core record binding mismatch');
  }
}

class JsonShapeScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.skipWhitespace();
    this.scanValue();
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new Error('trailing input');
  }

  private scanValue(): void {
    const character = this.text[this.index];
    if (character === '{') return this.scanObject();
    if (character === '[') return this.scanArray();
    if (character === '"') {
      this.scanString();
      return;
    }
    if (character === 't') return this.scanLiteral('true');
    if (character === 'f') return this.scanLiteral('false');
    if (character === 'n') return this.scanLiteral('null');
    this.scanNumber();
  }

  private scanObject(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume('}')) return;
    const keys = new Set<string>();
    while (true) {
      if (this.text[this.index] !== '"') throw new Error('object key must be a string');
      const key = this.scanString();
      if (keys.has(key)) throw new Error('duplicate JSON key');
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      this.scanValue();
      this.skipWhitespace();
      if (this.consume('}')) return;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private scanArray(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.consume(']')) return;
    while (true) {
      this.scanValue();
      this.skipWhitespace();
      if (this.consume(']')) return;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private scanString(): string {
    const start = this.index;
    this.expect('"');
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (character === '"') {
        return JSON.parse(this.text.slice(start, this.index)) as string;
      }
      if (character === '\\') {
        const escape = this.text[this.index++];
        if (escape === 'u') {
          const codePoint = this.text.slice(this.index, this.index + 4);
          if (!/^[0-9a-fA-F]{4}$/.test(codePoint)) throw new Error('invalid unicode escape');
          this.index += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
          throw new Error('invalid string escape');
        }
      } else if (!character || character.charCodeAt(0) < 0x20) {
        throw new Error('invalid string character');
      }
    }
    throw new Error('unterminated string');
  }

  private scanLiteral(literal: string): void {
    if (this.text.slice(this.index, this.index + literal.length) !== literal) {
      throw new Error('invalid literal');
    }
    this.index += literal.length;
  }

  private scanNumber(): void {
    const remaining = this.text.slice(this.index);
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(remaining);
    if (!match) throw new Error('invalid value');
    this.index += match[0].length;
  }

  private skipWhitespace(): void {
    while (/\s/.test(this.text[this.index] ?? '')) this.index += 1;
  }

  private consume(character: string): boolean {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.consume(character)) throw new Error(`expected ${character}`);
  }
}

export function parseJsonRecord<T>(input: string | Buffer, parser: SafetyRecordParser<T>): T {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.byteLength > MAX_SAFETY_RECORD_BYTES) {
    throw new WorkspaceSafetyError('invalid', 'Workspace safety record is too large');
  }
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    throw new WorkspaceSafetyError('invalid', 'Workspace safety record contains a UTF-8 BOM');
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new WorkspaceSafetyError('invalid', 'Workspace safety record is not valid UTF-8');
  }
  try {
    new JsonShapeScanner(text).scan();
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown parse error';
    if (message.startsWith('duplicate JSON key')) {
      throw new WorkspaceSafetyError('invalid', message);
    }
    throw new WorkspaceSafetyError('invalid', `Invalid JSON safety record: ${message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    throw new WorkspaceSafetyError('invalid', 'Invalid JSON safety record');
  }
  return parser(parsed);
}
