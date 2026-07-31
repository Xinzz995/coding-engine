import { randomUUID } from 'node:crypto';
import { lstat, readdir, realpath } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import {
  assertExactFile,
  digestBytes,
  installFileNoReplace,
  jsonBytes,
  readLinkedFileInstall,
  readExactFile,
  recoverLinkedFileInstall,
  replaceFileFromStaging,
  writeNewFile,
} from './filesystem.js';
import { parseJsonRecord } from './schema.js';
import type { QuarantineReason } from './types.js';
import { WorkspaceSafetyError } from './types.js';

export const QUARANTINE_FILE = 'quarantine.json';
export const QUARANTINE_SCHEMA_VERSION = 1 as const;

const QUARANTINE_STAGING_PATTERN =
  /^quarantine\.(?:prepare|upgrade)-([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\.json$/u;

const containerTails = new Map<string, Promise<void>>();

export type QuarantineCreatorKind = 'owner' | 'recovery-attempt';

export interface QuarantineCreator {
  readonly kind: QuarantineCreatorKind;
  readonly id: string;
  readonly recordDigest: string;
}

export interface QuarantineRecord {
  readonly schemaVersion: typeof QUARANTINE_SCHEMA_VERSION;
  readonly ownerId: string;
  readonly operationId: string | null;
  readonly activeChildDigest: string | null;
  readonly delegatedBaselineDigest: string | null;
  readonly creator: QuarantineCreator;
  readonly reason: QuarantineReason;
  readonly priorQuarantineDigest: string | null;
  readonly createdAt: string;
}

export interface CreateQuarantineRecordOptions extends Omit<
  QuarantineRecord,
  'schemaVersion' | 'createdAt'
> {
  readonly createdAt: Date | string;
}

export interface QuarantineInstallOptions {
  readonly containerPath: string;
  readonly recordBytes: Uint8Array;
  readonly verifyAuthority: () => void | Promise<void>;
}

export interface RecoverLinkedQuarantineOptions {
  readonly containerPath: string;
  readonly linkedSource: string;
  readonly expectedBytes: Uint8Array;
  readonly verifyAuthority: () => void | Promise<void>;
}

/**
 * Internal, fail-closed authority for continuing one exact containment quarantine.
 * The bytes are carried as well as their digest so a caller cannot turn this into
 * a reason-only or boolean bypass.
 */
export interface ExactContainmentQuarantine {
  readonly bytes: Uint8Array;
  readonly digest: string;
}

type StrictRecord = Record<string, unknown>;

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const DIGEST_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const REASONS = new Set<QuarantineReason>([
  'containment-unconfirmed',
  'operation-proof-missing',
  'workspace-integrity-violation',
]);
const CREATOR_KINDS = new Set<QuarantineCreatorKind>(['owner', 'recovery-attempt']);

function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', `Invalid quarantine record: ${message}`);
}

function record(value: unknown, label: string): StrictRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${label} must be a plain object`);
  }
  return value as StrictRecord;
}

function exactKeys(value: StrictRecord, expected: readonly string[], label: string): void {
  const expectedSet = new Set(expected);
  for (const key of Reflect.ownKeys(value)) {
    if (typeof key !== 'string' || !expectedSet.has(key)) {
      invalid(`${label} contains an unknown field`);
    }
  }
  for (const key of expected) {
    if (!Object.hasOwn(value, key)) invalid(`${label} is missing field ${key}`);
  }
}

function uuid(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
    return invalid(`${label} must be a canonical UUID`);
  }
  return value;
}

function digest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !DIGEST_PATTERN.test(value)) {
    return invalid(`${label} must be a SHA-256 digest`);
  }
  return value;
}

function nullableDigest(value: unknown, label: string): string | null {
  return value === null ? null : digest(value, label);
}

function timestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !TIMESTAMP_PATTERN.test(value)) {
    return invalid(`${label} must be a canonical UTC timestamp`);
  }
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString() !== value) {
    return invalid(`${label} must be a real UTC timestamp`);
  }
  return value;
}

function parseCreator(value: unknown): QuarantineCreator {
  const source = record(value, 'creator');
  exactKeys(source, ['kind', 'id', 'recordDigest'], 'creator');
  if (typeof source.kind !== 'string' || !CREATOR_KINDS.has(source.kind as QuarantineCreatorKind)) {
    invalid('creator.kind has an unsupported value');
  }
  return {
    kind: source.kind as QuarantineCreatorKind,
    id: uuid(source.id, 'creator.id'),
    recordDigest: digest(source.recordDigest, 'creator.recordDigest'),
  };
}

function parseQuarantineValue(value: unknown): QuarantineRecord {
  const source = record(value, 'quarantine');
  exactKeys(
    source,
    [
      'schemaVersion',
      'ownerId',
      'operationId',
      'activeChildDigest',
      'delegatedBaselineDigest',
      'creator',
      'reason',
      'priorQuarantineDigest',
      'createdAt',
    ],
    'quarantine',
  );
  if (source.schemaVersion !== QUARANTINE_SCHEMA_VERSION) {
    invalid('schemaVersion has an unsupported value');
  }
  if (typeof source.reason !== 'string' || !REASONS.has(source.reason as QuarantineReason)) {
    invalid('reason has an unsupported value');
  }
  const operationId = source.operationId === null ? null : uuid(source.operationId, 'operationId');
  const activeChildDigest = nullableDigest(source.activeChildDigest, 'activeChildDigest');
  const delegatedBaselineDigest = nullableDigest(
    source.delegatedBaselineDigest,
    'delegatedBaselineDigest',
  );
  if (
    (operationId === null) !== (activeChildDigest === null) ||
    (operationId === null) !== (delegatedBaselineDigest === null)
  ) {
    invalid('operationId and frozen operation digests must be present or absent together');
  }
  const priorQuarantineDigest = nullableDigest(
    source.priorQuarantineDigest,
    'priorQuarantineDigest',
  );
  if (priorQuarantineDigest !== null && source.reason !== 'workspace-integrity-violation') {
    invalid('only an integrity violation may bind a prior quarantine');
  }
  const creator = parseCreator(source.creator);
  const ownerId = uuid(source.ownerId, 'ownerId');
  if (creator.kind === 'owner' && creator.id !== ownerId) {
    invalid('owner creator must bind the quarantine ownerId');
  }
  if (creator.kind === 'recovery-attempt' && source.reason !== 'workspace-integrity-violation') {
    invalid('recovery attempt may only create an integrity quarantine');
  }
  return {
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    ownerId,
    operationId,
    activeChildDigest,
    delegatedBaselineDigest,
    creator,
    reason: source.reason as QuarantineReason,
    priorQuarantineDigest,
    createdAt: timestamp(source.createdAt, 'createdAt'),
  };
}

export function isQuarantineStagingName(name: string): boolean {
  return QUARANTINE_STAGING_PATTERN.test(name);
}

/**
 * Validates every canonical or prepared quarantine byte before reporting
 * presence. Callers decide whether valid presence means isolated/unsupported;
 * malformed safety evidence always throws `invalid` first.
 */
export interface QuarantinePresenceInspection {
  readonly present: boolean;
  readonly canonical?: {
    readonly bytes: Buffer;
    readonly record: QuarantineRecord;
    readonly linkedSource?: string;
  };
}

export async function readQuarantinePresence(
  containerPath: string,
): Promise<QuarantinePresenceInspection> {
  await assertOrdinaryContainer(containerPath);
  const names = await readdir(containerPath);
  let present = false;
  const staging: Array<{
    readonly name: string;
    readonly path: string;
    readonly creatorId: string;
    readonly dev: bigint;
    readonly ino: bigint;
    readonly nlink: bigint;
  }> = [];
  for (const name of names) {
    if (name === QUARANTINE_FILE || !name.startsWith('quarantine.')) continue;
    const match = QUARANTINE_STAGING_PATTERN.exec(name);
    if (!match) invalid(`quarantine staging name is invalid: ${name}`);
    const path = join(containerPath, name);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile() || (info.nlink !== 1n && info.nlink !== 2n)) {
      invalid('quarantine staging is not an ordinary one-link or controlled two-link file');
    }
    staging.push({
      name,
      path,
      creatorId: match[1],
      dev: info.dev,
      ino: info.ino,
      nlink: info.nlink,
    });
    present = true;
  }
  if (!names.includes(QUARANTINE_FILE)) {
    if (staging.some((candidate) => candidate.nlink !== 1n)) {
      invalid('linked quarantine staging is missing its canonical target');
    }
    for (const candidate of staging) {
      const record = parseQuarantineRecord(await readExactFile(candidate.path));
      if (record.creator.id !== candidate.creatorId) {
        invalid('quarantine staging name does not bind its creator');
      }
    }
    return { present };
  }

  const target = join(containerPath, QUARANTINE_FILE);
  const targetInfo = await lstat(target, { bigint: true });
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    invalid('canonical quarantine is not an ordinary file');
  }
  let bytes: Buffer;
  let linkedSource: string | undefined;
  if (targetInfo.nlink === 1n) {
    if (staging.some((candidate) => candidate.nlink !== 1n)) {
      invalid('canonical quarantine has unrelated linked staging');
    }
    bytes = await readExactFile(target);
  } else if (targetInfo.nlink === 2n) {
    const linked = staging.filter(
      (candidate) =>
        candidate.nlink === 2n &&
        candidate.dev === targetInfo.dev &&
        candidate.ino === targetInfo.ino,
    );
    if (
      linked.length !== 1 ||
      staging.some((candidate) => candidate.nlink === 2n && candidate !== linked[0])
    ) {
      invalid('canonical quarantine lacks one unique controlled staging source');
    }
    linkedSource = linked[0].path;
    bytes = await readLinkedFileInstall({ source: linkedSource, target, maxBytes: 64 * 1024 });
  } else {
    invalid('canonical quarantine has an unsupported link count');
  }
  const record = parseQuarantineRecord(bytes);
  if (linkedSource) {
    const source = staging.find((candidate) => candidate.path === linkedSource);
    if (!source || record.creator.id !== source.creatorId) {
      invalid('linked quarantine staging name does not bind its creator');
    }
  }
  for (const candidate of staging) {
    if (candidate.path === linkedSource) continue;
    const staged = parseQuarantineRecord(await readExactFile(candidate.path));
    if (staged.creator.id !== candidate.creatorId) {
      invalid('quarantine staging name does not bind its creator');
    }
  }
  return {
    present: true,
    canonical: {
      bytes,
      record,
      ...(linkedSource ? { linkedSource } : {}),
    },
  };
}

export async function inspectQuarantinePresence(containerPath: string): Promise<boolean> {
  return (await readQuarantinePresence(containerPath)).present;
}

export async function recoverLinkedQuarantineInstall(
  options: RecoverLinkedQuarantineOptions,
): Promise<QuarantineRecord> {
  const expectedBytes = Buffer.from(options.expectedBytes);
  const expected = parseQuarantineRecord(expectedBytes);
  return await withQuarantineContainerExclusive(options.containerPath, async () => {
    await recoverLinkedFileInstall({
      source: options.linkedSource,
      target: join(options.containerPath, QUARANTINE_FILE),
      expectedBytes,
      authorize: async () => {
        await options.verifyAuthority();
        const current = await readQuarantinePresence(options.containerPath);
        if (
          current.canonical?.linkedSource !== options.linkedSource ||
          !current.canonical.bytes.equals(expectedBytes)
        ) {
          invalid('linked quarantine install changed before recovery commit');
        }
      },
    });
    const installed = parseQuarantineRecord(
      await readExactFile(join(options.containerPath, QUARANTINE_FILE)),
    );
    if (JSON.stringify(installed) !== JSON.stringify(expected)) {
      invalid('recovered quarantine does not match the authorized record');
    }
    return installed;
  });
}

/**
 * Serializes quarantine commits and ordinary lease release inside one process.
 * Exact owner/recovery identity checks exclude a second honest process from the
 * same authority domain; this lock closes the remaining same-owner async race.
 */
export async function withQuarantineContainerExclusive<T>(
  containerPath: string,
  action: () => Promise<T>,
): Promise<T> {
  const key = await realpath(resolve(containerPath));
  const previous = containerTails.get(key) ?? Promise.resolve();
  let releaseCurrent!: () => void;
  const current = new Promise<void>((resolveCurrent) => {
    releaseCurrent = resolveCurrent;
  });
  containerTails.set(key, current);
  await previous;
  try {
    return await action();
  } finally {
    releaseCurrent();
    if (containerTails.get(key) === current) containerTails.delete(key);
  }
}

export function parseQuarantineRecord(input: string | Buffer): QuarantineRecord {
  return parseJsonRecord(input, parseQuarantineValue);
}

export function createQuarantineRecordBytes(options: CreateQuarantineRecordOptions): Buffer {
  const createdAt =
    options.createdAt instanceof Date ? options.createdAt.toISOString() : options.createdAt;
  const bytes = jsonBytes({
    schemaVersion: QUARANTINE_SCHEMA_VERSION,
    ownerId: options.ownerId,
    operationId: options.operationId,
    activeChildDigest: options.activeChildDigest,
    delegatedBaselineDigest: options.delegatedBaselineDigest,
    creator: options.creator,
    reason: options.reason,
    priorQuarantineDigest: options.priorQuarantineDigest,
    createdAt,
  });
  parseQuarantineRecord(bytes);
  return bytes;
}

export function assertExactContainmentQuarantine(
  expected: ExactContainmentQuarantine,
  actualBytes: Uint8Array,
): QuarantineRecord {
  const expectedBytes = Buffer.from(expected.bytes);
  const actual = Buffer.from(actualBytes);
  const expectedRecord = parseQuarantineRecord(expectedBytes);
  if (
    expectedRecord.reason !== 'containment-unconfirmed' ||
    expectedRecord.priorQuarantineDigest !== null ||
    expected.digest !== digestBytes(expectedBytes) ||
    !actual.equals(expectedBytes)
  ) {
    invalid('exact containment authority does not match canonical quarantine bytes');
  }
  return expectedRecord;
}

async function assertOrdinaryContainer(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    invalid('quarantine container must be an ordinary directory');
  }
}

export async function installQuarantineNoReplace(
  options: QuarantineInstallOptions,
): Promise<QuarantineRecord> {
  const bytes = Buffer.from(options.recordBytes);
  const parsed = parseQuarantineRecord(bytes);
  if (parsed.priorQuarantineDigest !== null) {
    invalid('a prior-bound recovery record must use the one-way upgrade path');
  }
  return await withQuarantineContainerExclusive(options.containerPath, async () => {
    await options.verifyAuthority();
    await assertOrdinaryContainer(options.containerPath);
    const target = join(options.containerPath, QUARANTINE_FILE);
    try {
      const installed = await readExactFile(target);
      parseQuarantineRecord(installed);
      throw new WorkspaceSafetyError('conflict', 'quarantine already exists');
    } catch (error) {
      if (!(error instanceof WorkspaceSafetyError) || error.code !== 'invalid') throw error;
      const cause = Object.getOwnPropertyDescriptor(error, 'cause')?.value as
        NodeJS.ErrnoException | undefined;
      if (cause?.code !== 'ENOENT') throw error;
    }
    const staging = join(
      options.containerPath,
      `quarantine.prepare-${parsed.creator.id}-${randomUUID()}.json`,
    );
    await writeNewFile(staging, bytes);
    await assertExactFile(staging, bytes);
    await options.verifyAuthority();
    try {
      await installFileNoReplace(staging, target);
    } catch (error) {
      if (error instanceof WorkspaceSafetyError && error.code === 'conflict') {
        parseQuarantineRecord(await readExactFile(target));
      }
      throw error;
    }
    await assertExactFile(target, bytes);
    return parsed;
  });
}

function sameFrozenBinding(left: QuarantineRecord, right: QuarantineRecord): boolean {
  return (
    left.ownerId === right.ownerId &&
    left.operationId === right.operationId &&
    left.activeChildDigest === right.activeChildDigest &&
    left.delegatedBaselineDigest === right.delegatedBaselineDigest
  );
}

export async function upgradeContainmentQuarantine(
  options: QuarantineInstallOptions & { readonly priorBytes: Uint8Array },
): Promise<QuarantineRecord> {
  const priorBytes = Buffer.from(options.priorBytes);
  const nextBytes = Buffer.from(options.recordBytes);
  const prior = parseQuarantineRecord(priorBytes);
  const next = parseQuarantineRecord(nextBytes);
  if (
    prior.reason !== 'containment-unconfirmed' ||
    next.reason !== 'workspace-integrity-violation' ||
    next.creator.kind !== 'recovery-attempt' ||
    next.priorQuarantineDigest !== digestBytes(priorBytes) ||
    !sameFrozenBinding(prior, next)
  ) {
    invalid('quarantine upgrade is not the one-way containment-to-integrity transition');
  }
  return await withQuarantineContainerExclusive(options.containerPath, async () => {
    await options.verifyAuthority();
    await assertOrdinaryContainer(options.containerPath);
    const target = join(options.containerPath, QUARANTINE_FILE);
    await assertExactFile(target, priorBytes);
    const staging = join(
      options.containerPath,
      `quarantine.upgrade-${next.creator.id}-${randomUUID()}.json`,
    );
    await writeNewFile(staging, nextBytes);
    await assertExactFile(staging, nextBytes);
    await options.verifyAuthority();
    await assertExactFile(target, priorBytes);
    await replaceFileFromStaging(staging, target);
    const installed = await readExactFile(target);
    if (!installed.equals(nextBytes)) invalid('quarantine upgrade readback mismatch');
    return next;
  });
}
