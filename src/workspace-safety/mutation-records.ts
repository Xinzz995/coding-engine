import { Buffer } from 'node:buffer';
import {
  asStrictRecord,
  canonicalJson,
  compareCanonicalStrings,
  parseStrictJson,
  requireDigest,
  requireExactKeys,
  requireTimestamp,
  requireUuid,
  validateRelativePath,
  workspacePathCollisionKey,
} from './baseline-contract.js';
import { digestBytes, jsonBytes } from './filesystem.js';
import { type MutationPhase, WORKSPACE_MARKER_FILE, WorkspaceSafetyError } from './types.js';

export const MUTATION_SCHEMA_VERSION = 1 as const;
export const MUTATION_STATE_FILE = 'state.json';
export const MUTATION_INPUT_DIR = 'input';
export const MUTATION_INPUT_MANIFEST_FILE = 'manifest.json';
export const MUTATION_PAYLOADS_DIR = 'payloads';
export const MUTATION_APPLY_DIR = 'apply';
export const MUTATION_ARCHIVE_MANIFEST_FILE = 'archive-manifest.json';

export const MUTATION_LIMITS = Object.freeze({
  plannedPaths: 4096,
  archiveEntries: 100_000,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  manifestBytes: 32 * 1024 * 1024,
  depth: 128,
});

/** generic-v1 is reserved for dark fixtures; production callers retain their durable purpose. */
export type MutationKind = 'apply-prd-v1' | 'repair-v1' | 'generic-v1';

export type MutationFileSnapshot =
  | { readonly kind: 'missing' }
  | { readonly kind: 'file'; readonly digest: string; readonly byteLength: number };

export type MutationArchiveEntry =
  | { readonly path: string; readonly kind: 'missing' | 'directory' }
  | {
      readonly path: string;
      readonly kind: 'file';
      readonly digest: string;
      readonly byteLength: number;
    };

export interface MutationWriteInput {
  readonly path: string;
  readonly payloadFile: string;
  readonly payloadDigest: string;
  readonly byteLength: number;
  readonly before: MutationFileSnapshot;
}

export interface MutationDeleteInput {
  readonly path: string;
  readonly before: MutationFileSnapshot;
}

export interface MutationInputManifest {
  readonly schemaVersion: typeof MUTATION_SCHEMA_VERSION;
  readonly domain: 'coding-x-workspace-mutation-input-v1';
  readonly workspaceIdentity: string;
  readonly ownerId: string;
  readonly mutationId: string;
  readonly kind: MutationKind;
  readonly writes: readonly MutationWriteInput[];
  readonly deletes: readonly MutationDeleteInput[];
  readonly archivePaths: readonly string[];
  readonly archiveEntries: readonly MutationArchiveEntry[];
  readonly baseSnapshotDigest: string;
}

export interface MutationState {
  readonly schemaVersion: typeof MUTATION_SCHEMA_VERSION;
  readonly domain: 'coding-x-workspace-mutation-state-v1';
  readonly ownerId: string;
  readonly mutationId: string;
  readonly kind: MutationKind;
  readonly inputDigest: string;
  readonly baseSnapshotDigest: string;
  readonly phase: MutationPhase;
  readonly plannedPaths: readonly string[];
  readonly startedAt: string;
}

const PHASES = new Set<MutationPhase>(['staged', 'archiving', 'applying', 'committed']);
const KINDS = new Set<MutationKind>(['apply-prd-v1', 'repair-v1', 'generic-v1']);

export function mutationInvalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('invalid', `Invalid mutation protocol: ${message}`);
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function exactKeys(record: Record<string, unknown>, keys: readonly string[], label: string): void {
  try {
    requireExactKeys(record, keys, label);
  } catch (error) {
    throw mutationInvalid(`${label} has an invalid field set`, error);
  }
}

function natural(value: unknown, field: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0 || (value as number) > maximum) {
    throw mutationInvalid(`${field} must be a bounded non-negative integer`);
  }
  return value as number;
}

function literal<T extends string | number>(value: unknown, expected: T, field: string): T {
  if (value !== expected) throw mutationInvalid(`${field} has an unsupported value`);
  return expected;
}

function mutationKind(value: unknown): MutationKind {
  if (typeof value !== 'string' || !KINDS.has(value as MutationKind)) {
    throw mutationInvalid('kind has an unsupported value');
  }
  return value as MutationKind;
}

function mutationPhase(value: unknown): MutationPhase {
  if (typeof value !== 'string' || !PHASES.has(value as MutationPhase)) {
    throw mutationInvalid('phase has an unsupported value');
  }
  return value as MutationPhase;
}

function safePath(value: unknown, field: string): string {
  try {
    const path = validateRelativePath(value, field);
    if (workspacePathCollisionKey(path) === workspacePathCollisionKey(WORKSPACE_MARKER_FILE)) {
      throw mutationInvalid(`${field} cannot target the workspace safety marker`);
    }
    if (
      path
        .split('/')
        .some(
          (part) =>
            part.startsWith('.coding-x-') || /^\..+\.(?:coding-x|mutation)-.+\.tmp$/u.test(part),
        )
    ) {
      throw mutationInvalid(`${field} cannot target an internal staging name`);
    }
    return path;
  } catch (error) {
    if (error instanceof WorkspaceSafetyError && error.message.startsWith('Invalid mutation')) {
      throw error;
    }
    throw mutationInvalid(`${field} is not a safe workspace-relative path`, error);
  }
}

function uuid(value: unknown, field: string): string {
  try {
    return requireUuid(value, field);
  } catch (error) {
    throw mutationInvalid(`${field} is not a canonical UUID`, error);
  }
}

function digest(value: unknown, field: string): string {
  try {
    return requireDigest(value, field);
  } catch (error) {
    throw mutationInvalid(`${field} is not a canonical digest`, error);
  }
}

function timestamp(value: unknown, field: string): string {
  try {
    return requireTimestamp(value, field);
  } catch (error) {
    throw mutationInvalid(`${field} is not a canonical timestamp`, error);
  }
}

function strictRecord(value: unknown, label: string): Record<string, unknown> {
  try {
    return asStrictRecord(value, label);
  } catch (error) {
    throw mutationInvalid(`${label} must be a plain object`, error);
  }
}

function parseFileSnapshot(value: unknown, label: string): MutationFileSnapshot {
  const record = strictRecord(value, label);
  if (record.kind === 'missing') {
    exactKeys(record, ['kind'], label);
    return { kind: 'missing' };
  }
  if (record.kind !== 'file') throw mutationInvalid(`${label}.kind is unsupported`);
  exactKeys(record, ['kind', 'digest', 'byteLength'], label);
  return {
    kind: 'file',
    digest: digest(record.digest, `${label}.digest`),
    byteLength: natural(record.byteLength, `${label}.byteLength`, MUTATION_LIMITS.fileBytes),
  };
}

function parseArchiveEntry(value: unknown, index: number): MutationArchiveEntry {
  const label = `archiveEntries[${index}]`;
  const record = strictRecord(value, label);
  const path = safePath(record.path, `${label}.path`);
  if (record.kind === 'missing' || record.kind === 'directory') {
    exactKeys(record, ['path', 'kind'], label);
    return { path, kind: record.kind };
  }
  if (record.kind !== 'file') throw mutationInvalid(`${label}.kind is unsupported`);
  exactKeys(record, ['path', 'kind', 'digest', 'byteLength'], label);
  return {
    path,
    kind: 'file',
    digest: digest(record.digest, `${label}.digest`),
    byteLength: natural(record.byteLength, `${label}.byteLength`, MUTATION_LIMITS.fileBytes),
  };
}

function assertSortedUniquePaths(paths: readonly string[], label: string): void {
  const collisionKeys = new Set<string>();
  for (let index = 0; index < paths.length; index += 1) {
    if (index > 0 && compareCanonicalStrings(paths[index - 1], paths[index]) >= 0) {
      throw mutationInvalid(`${label} must be strictly sorted and unique`);
    }
    const collision = workspacePathCollisionKey(paths[index]);
    if (collisionKeys.has(collision)) throw mutationInvalid(`${label} contains a path collision`);
    collisionKeys.add(collision);
  }
}

function assertNoAncestorConflicts(paths: readonly string[], label: string): void {
  const pathSet = new Set(paths);
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (pathSet.has(parts.slice(0, index).join('/'))) {
        throw mutationInvalid(`${label} contains an ancestor/descendant conflict`);
      }
    }
  }
}

function parseManifestValue(value: unknown): MutationInputManifest {
  const record = strictRecord(value, 'mutation input manifest');
  exactKeys(
    record,
    [
      'schemaVersion',
      'domain',
      'workspaceIdentity',
      'ownerId',
      'mutationId',
      'kind',
      'writes',
      'deletes',
      'archivePaths',
      'archiveEntries',
      'baseSnapshotDigest',
    ],
    'mutation input manifest',
  );
  if (!Array.isArray(record.writes) || !Array.isArray(record.deletes)) {
    throw mutationInvalid('writes and deletes must be arrays');
  }
  if (!Array.isArray(record.archivePaths) || !Array.isArray(record.archiveEntries)) {
    throw mutationInvalid('archive paths and entries must be arrays');
  }
  if (record.archivePaths.length > MUTATION_LIMITS.plannedPaths) {
    throw mutationInvalid('archive paths exceed the bounded count');
  }
  if (record.writes.length + record.deletes.length > MUTATION_LIMITS.plannedPaths) {
    throw mutationInvalid('planned paths exceed the bounded count');
  }
  if (record.archiveEntries.length > MUTATION_LIMITS.archiveEntries) {
    throw mutationInvalid('archive entries exceed the bounded count');
  }
  let payloadBytes = 0;
  let baseTargetBytes = 0;
  const writes = record.writes.map((value, index): MutationWriteInput => {
    const label = `writes[${index}]`;
    const item = strictRecord(value, label);
    exactKeys(item, ['path', 'payloadFile', 'payloadDigest', 'byteLength', 'before'], label);
    const byteLength = natural(item.byteLength, `${label}.byteLength`, MUTATION_LIMITS.fileBytes);
    payloadBytes += byteLength;
    if (payloadBytes > MUTATION_LIMITS.totalBytes) {
      throw mutationInvalid('payloads exceed the bounded total bytes');
    }
    const before = parseFileSnapshot(item.before, `${label}.before`);
    if (before.kind === 'file') baseTargetBytes += before.byteLength;
    return {
      path: safePath(item.path, `${label}.path`),
      payloadFile: safePath(item.payloadFile, `${label}.payloadFile`),
      payloadDigest: digest(item.payloadDigest, `${label}.payloadDigest`),
      byteLength,
      before,
    };
  });
  const deletes = record.deletes.map((value, index): MutationDeleteInput => {
    const label = `deletes[${index}]`;
    const item = strictRecord(value, label);
    exactKeys(item, ['path', 'before'], label);
    const before = parseFileSnapshot(item.before, `${label}.before`);
    if (before.kind === 'file') baseTargetBytes += before.byteLength;
    return {
      path: safePath(item.path, `${label}.path`),
      before,
    };
  });
  const archivePaths = record.archivePaths.map((item, index) =>
    safePath(item, `archivePaths[${index}]`),
  );
  const archiveEntries = record.archiveEntries.map(parseArchiveEntry);
  if (baseTargetBytes > MUTATION_LIMITS.totalBytes) {
    throw mutationInvalid('base targets exceed the bounded total bytes');
  }
  const archiveBytes = archiveEntries.reduce(
    (sum, entry) => sum + (entry.kind === 'file' ? entry.byteLength : 0),
    0,
  );
  if (archiveBytes > MUTATION_LIMITS.totalBytes) {
    throw mutationInvalid('archive entries exceed the bounded total bytes');
  }
  assertSortedUniquePaths(
    writes.map((write) => write.path),
    'writes',
  );
  assertSortedUniquePaths(
    deletes.map((deletion) => deletion.path),
    'deletes',
  );
  writes.forEach((write, index) => {
    if (write.payloadFile !== `${String(index).padStart(8, '0')}.bin`) {
      throw mutationInvalid('payload files do not use the deterministic input index');
    }
  });
  const planned = [...writes.map((item) => item.path), ...deletes.map((item) => item.path)].sort(
    compareCanonicalStrings,
  );
  assertSortedUniquePaths(planned, 'planned paths');
  assertNoAncestorConflicts(planned, 'planned paths');
  assertSortedUniquePaths(archivePaths, 'archivePaths');
  assertNoAncestorConflicts(archivePaths, 'archivePaths');
  assertSortedUniquePaths(
    archiveEntries.map((entry) => entry.path),
    'archiveEntries',
  );
  const payloadFiles = writes.map((item) => item.payloadFile).sort(compareCanonicalStrings);
  assertSortedUniquePaths(payloadFiles, 'payload files');
  const archiveByPath = new Map(archiveEntries.map((entry) => [entry.path, entry]));
  for (const root of archivePaths) {
    const rootEntry = archiveByPath.get(root);
    if (!rootEntry) throw mutationInvalid(`archive root has no exact entry: ${root}`);
    if (
      rootEntry.kind !== 'directory' &&
      archiveEntries.some((entry) => entry.path.startsWith(`${root}/`))
    ) {
      throw mutationInvalid(`non-directory archive root has descendants: ${root}`);
    }
  }
  for (const entry of archiveEntries) {
    const root = archivePaths.find(
      (candidate) => entry.path === candidate || entry.path.startsWith(`${candidate}/`),
    );
    if (!root) throw mutationInvalid(`archive entry is outside every archive root: ${entry.path}`);
    if (entry.path !== root) {
      const relativeParts = entry.path.slice(root.length + 1).split('/');
      for (let index = 1; index < relativeParts.length; index += 1) {
        const parent = `${root}/${relativeParts.slice(0, index).join('/')}`;
        if (archiveByPath.get(parent)?.kind !== 'directory') {
          throw mutationInvalid(`archive entry has no directory parent: ${entry.path}`);
        }
      }
    }
  }
  return {
    schemaVersion: literal(record.schemaVersion, MUTATION_SCHEMA_VERSION, 'manifest.schemaVersion'),
    domain: literal(record.domain, 'coding-x-workspace-mutation-input-v1', 'manifest.domain'),
    workspaceIdentity: digest(record.workspaceIdentity, 'manifest.workspaceIdentity'),
    ownerId: uuid(record.ownerId, 'manifest.ownerId'),
    mutationId: uuid(record.mutationId, 'manifest.mutationId'),
    kind: mutationKind(record.kind),
    writes,
    deletes,
    archivePaths,
    archiveEntries,
    baseSnapshotDigest: digest(record.baseSnapshotDigest, 'manifest.baseSnapshotDigest'),
  };
}

function parseStateValue(value: unknown): MutationState {
  const record = strictRecord(value, 'mutation state');
  exactKeys(
    record,
    [
      'schemaVersion',
      'domain',
      'ownerId',
      'mutationId',
      'kind',
      'inputDigest',
      'baseSnapshotDigest',
      'phase',
      'plannedPaths',
      'startedAt',
    ],
    'mutation state',
  );
  if (!Array.isArray(record.plannedPaths)) {
    throw mutationInvalid('state.plannedPaths must be an array');
  }
  if (record.plannedPaths.length > MUTATION_LIMITS.plannedPaths) {
    throw mutationInvalid('state.plannedPaths exceeds the bounded count');
  }
  const plannedPaths = record.plannedPaths.map((item, index) =>
    safePath(item, `state.plannedPaths[${index}]`),
  );
  assertSortedUniquePaths(plannedPaths, 'state.plannedPaths');
  assertNoAncestorConflicts(plannedPaths, 'state.plannedPaths');
  return {
    schemaVersion: literal(record.schemaVersion, MUTATION_SCHEMA_VERSION, 'state.schemaVersion'),
    domain: literal(record.domain, 'coding-x-workspace-mutation-state-v1', 'state.domain'),
    ownerId: uuid(record.ownerId, 'state.ownerId'),
    mutationId: uuid(record.mutationId, 'state.mutationId'),
    kind: mutationKind(record.kind),
    inputDigest: digest(record.inputDigest, 'state.inputDigest'),
    baseSnapshotDigest: digest(record.baseSnapshotDigest, 'state.baseSnapshotDigest'),
    phase: mutationPhase(record.phase),
    plannedPaths,
    startedAt: timestamp(record.startedAt, 'state.startedAt'),
  };
}

function parseCanonical<T>(
  input: string | Buffer,
  label: string,
  maximumBytes: number,
  parser: (value: unknown) => T,
  serializer: (value: T) => Buffer,
): T {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.byteLength > maximumBytes) throw mutationInvalid(`${label} exceeds its byte budget`);
  let parsed: T;
  try {
    parsed = parser(parseStrictJson(bytes, label));
  } catch (error) {
    if (error instanceof WorkspaceSafetyError && error.message.startsWith('Invalid mutation')) {
      throw error;
    }
    throw mutationInvalid(`${label} is not valid strict JSON`, error);
  }
  if (!bytes.equals(serializer(parsed))) throw mutationInvalid(`${label} is not canonical JSON`);
  return parsed;
}

export function mutationManifestBytes(manifest: MutationInputManifest): Buffer {
  return Buffer.from(`${canonicalJson(manifest)}\n`, 'utf8');
}

export function parseMutationInputManifest(input: string | Buffer): MutationInputManifest {
  return parseCanonical(
    input,
    'mutation input manifest',
    MUTATION_LIMITS.manifestBytes,
    parseManifestValue,
    mutationManifestBytes,
  );
}

export function mutationStateBytes(state: MutationState): Buffer {
  const bytes = jsonBytes(state);
  parseStateValue(JSON.parse(bytes.toString('utf8')) as unknown);
  return bytes;
}

export function parseMutationState(input: string | Buffer): MutationState {
  return parseCanonical(input, 'mutation state', 64 * 1024, parseStateValue, mutationStateBytes);
}

export function mutationBaseSnapshotDigest(manifest: {
  readonly writes: readonly MutationWriteInput[];
  readonly deletes: readonly MutationDeleteInput[];
  readonly archivePaths: readonly string[];
  readonly archiveEntries: readonly MutationArchiveEntry[];
}): string {
  return digestBytes(
    Buffer.from(
      canonicalJson({
        writes: manifest.writes.map(({ path, before }) => ({ path, before })),
        deletes: manifest.deletes,
        archivePaths: manifest.archivePaths,
        archiveEntries: manifest.archiveEntries,
      }),
      'utf8',
    ),
  );
}

export function mutationArchiveManifestBytes(manifest: MutationInputManifest): Buffer {
  return Buffer.from(
    `${canonicalJson({
      schemaVersion: MUTATION_SCHEMA_VERSION,
      domain: 'coding-x-workspace-mutation-archive-v1',
      mutationId: manifest.mutationId,
      inputDigest: digestBytes(mutationManifestBytes(manifest)),
      baseSnapshotDigest: manifest.baseSnapshotDigest,
      archivePaths: manifest.archivePaths,
      entries: manifest.archiveEntries,
    })}\n`,
    'utf8',
  );
}

export function mutationArchivePath(mutationId: string, baseSnapshotDigest: string): string {
  return `engine.lock/incidents/mutation-data-${uuid(mutationId, 'mutationId')}-${digest(
    baseSnapshotDigest,
    'baseSnapshotDigest',
  ).slice(7, 23)}`;
}

export function mutationStateDigest(stateBytes: Buffer): string {
  parseMutationState(stateBytes);
  return digestBytes(stateBytes);
}
