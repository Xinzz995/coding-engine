import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { lstat, mkdir, open, readdir, unlink } from 'node:fs/promises';
import { basename, dirname, join, relative, sep } from 'node:path';
import { canonicalJson, compareCanonicalStrings } from './baseline-contract.js';
import {
  assertExactFile,
  createStagingDirectory,
  digestBytes,
  ensureSafeParentDirectory,
  installDirectoryNoReplace,
  pathExists,
  readExactFile,
  replaceFileFromStaging,
  resolveWorkspaceRelativePath,
  writeNewFile,
  type WorkspaceDirectory,
} from './filesystem.js';
import type { OwnerRecord } from './types.js';
import {
  MUTATION_ARCHIVE_MANIFEST_FILE,
  MUTATION_APPLY_DIR,
  MUTATION_INPUT_DIR,
  MUTATION_INPUT_MANIFEST_FILE,
  MUTATION_LIMITS,
  MUTATION_PAYLOADS_DIR,
  MUTATION_STATE_FILE,
  mutationArchiveManifestBytes,
  mutationArchivePath,
  mutationBaseSnapshotDigest,
  mutationInvalid,
  mutationManifestBytes,
  mutationStateBytes,
  parseMutationInputManifest,
  parseMutationState,
  type MutationArchiveEntry,
  type MutationFileSnapshot,
  type MutationInputManifest,
  type MutationState,
} from './mutation-records.js';
import {
  ACTIVE_LEASE_DIR,
  MUTATION_DIR,
  PROTOCOL_ROOT_DIR,
  WorkspaceSafetyError,
} from './types.js';

export interface MutationDomain {
  readonly workspace: WorkspaceDirectory;
  readonly path: string;
  readonly state: MutationState;
  readonly stateBytes: Buffer;
  readonly manifest: MutationInputManifest;
  readonly manifestBytes: Buffer;
  readonly payloads: ReadonlyMap<string, Buffer>;
}

export type MutationWriteScope =
  | { readonly kind: 'mutation-state'; readonly path: string }
  | { readonly kind: 'archive'; readonly path: string }
  | { readonly kind: 'business-write' | 'business-delete'; readonly path: string };

const MUTATION_WRITER_AUTHORITY = Symbol('mutation-writer-authority');

/** Opaque low-level write authority. Only fixed mutation coordinators may create one. */
export class MutationWriterAuthorityControlled {
  readonly workspace: WorkspaceDirectory;
  readonly #verify: (domain: MutationDomain, write?: MutationWriteScope) => Promise<void>;
  readonly #afterStateTransition?: (
    previous: MutationDomain,
    next: MutationDomain,
  ) => Promise<void>;

  constructor(
    authority: typeof MUTATION_WRITER_AUTHORITY,
    options: {
      readonly workspace: WorkspaceDirectory;
      readonly verify: (domain: MutationDomain, write?: MutationWriteScope) => Promise<void>;
      readonly afterStateTransition?: (
        previous: MutationDomain,
        next: MutationDomain,
      ) => Promise<void>;
    },
  ) {
    if (authority !== MUTATION_WRITER_AUTHORITY) {
      throw mutationInvalid('mutation writer authority token is invalid');
    }
    this.workspace = options.workspace;
    this.#verify = options.verify;
    this.#afterStateTransition = options.afterStateTransition;
  }

  verify(domain: MutationDomain, write?: MutationWriteScope): Promise<void> {
    return this.#verify(domain, write);
  }

  afterStateTransition(previous: MutationDomain, next: MutationDomain): Promise<void> | undefined {
    return this.#afterStateTransition?.(previous, next);
  }
}

/** @internal Fixed coordinator construction boundary; production imports are statically allowlisted. */
export function createMutationWriterAuthorityControlled(options: {
  readonly workspace: WorkspaceDirectory;
  readonly verify: (domain: MutationDomain, write?: MutationWriteScope) => Promise<void>;
  readonly afterStateTransition?: (previous: MutationDomain, next: MutationDomain) => Promise<void>;
}): MutationWriterAuthorityControlled {
  return new MutationWriterAuthorityControlled(MUTATION_WRITER_AUTHORITY, options);
}

export interface MutationAdvanceHooks {
  readonly afterArchivingState?: () => void | Promise<void>;
  readonly duringArchiveCopy?: (entry: MutationArchiveEntry) => void | Promise<void>;
  readonly afterArchiveInstalled?: () => void | Promise<void>;
  readonly afterApplyingState?: () => void | Promise<void>;
  readonly afterBusinessStep?: (path: string) => void | Promise<void>;
  readonly afterCommittedState?: () => void | Promise<void>;
  /** Destructive-test barrier for the exact mutation-state/outer-recovery-state crash window. */
  readonly afterMutationStateInstalled?: (phase: MutationState['phase']) => void | Promise<void>;
}

interface FileReadSnapshot {
  readonly bytes: Buffer;
  readonly snapshot: MutationFileSnapshot;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

function sameDirectory(left: Awaited<ReturnType<typeof lstat>>, right: typeof left): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.mtimeMs === right.mtimeMs &&
    left.ctimeMs === right.ctimeMs
  );
}

async function assertOrdinaryDirectory(path: string, label: string): Promise<string[]> {
  try {
    const before = await lstat(path);
    if (before.isSymbolicLink() || !before.isDirectory()) {
      throw mutationInvalid(`${label} is not an ordinary directory`);
    }
    const entries = await readdir(path);
    const after = await lstat(path);
    if (after.isSymbolicLink() || !after.isDirectory() || !sameDirectory(before, after)) {
      throw mutationInvalid(`${label} changed while it was read`);
    }
    return entries;
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw mutationInvalid(`${label} is missing or unreadable`, error);
  }
}

async function assertSafeExistingParents(workspace: string, target: string): Promise<boolean> {
  const fromRoot = relative(workspace, target);
  const parts = fromRoot.split(sep).slice(0, -1);
  let current = workspace;
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw mutationInvalid(`workspace target parent is not an ordinary directory: ${current}`);
      }
    } catch (error) {
      if (error instanceof WorkspaceSafetyError) throw error;
      if (errorCode(error) === 'ENOENT') return false;
      throw mutationInvalid(`workspace target parent is unreadable: ${current}`, error);
    }
  }
  return true;
}

export async function assertMutationWriteParentExists(
  workspacePath: string,
  relativePath: string,
): Promise<void> {
  const target = resolveWorkspaceRelativePath(workspacePath, relativePath);
  if (!(await assertSafeExistingParents(workspacePath, target))) {
    throw mutationInvalid(`business target parent must already exist: ${relativePath}`);
  }
}

export async function readMutationFileSnapshot(
  workspacePath: string,
  relativePath: string,
): Promise<FileReadSnapshot> {
  const target = resolveWorkspaceRelativePath(workspacePath, relativePath);
  if (!(await assertSafeExistingParents(workspacePath, target))) {
    return { bytes: Buffer.alloc(0), snapshot: { kind: 'missing' } };
  }
  try {
    const info = await lstat(target, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
      throw mutationInvalid(`mutation target is not an ordinary single-link file: ${relativePath}`);
    }
    if (info.size > BigInt(MUTATION_LIMITS.fileBytes)) {
      throw mutationInvalid(`mutation target exceeds the per-file budget: ${relativePath}`);
    }
    const bytes = await readExactFile(target);
    return {
      bytes,
      snapshot: { kind: 'file', digest: digestBytes(bytes), byteLength: bytes.byteLength },
    };
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    if (errorCode(error) === 'ENOENT') {
      return { bytes: Buffer.alloc(0), snapshot: { kind: 'missing' } };
    }
    throw mutationInvalid(`mutation target is unreadable: ${relativePath}`, error);
  }
}

function sameSnapshot(left: MutationFileSnapshot, right: MutationFileSnapshot): boolean {
  return (
    left.kind === right.kind &&
    (left.kind === 'missing' ||
      (right.kind === 'file' &&
        left.digest === right.digest &&
        left.byteLength === right.byteLength))
  );
}

interface ArchiveScanBudget {
  entries: number;
  bytes: number;
}

async function scanArchivePath(
  workspacePath: string,
  relativePath: string,
  output: MutationArchiveEntry[],
  budget: ArchiveScanBudget,
  depth: number,
): Promise<void> {
  if (depth > MUTATION_LIMITS.depth) throw mutationInvalid('archive scan exceeds depth budget');
  const target = resolveWorkspaceRelativePath(workspacePath, relativePath);
  if (!(await assertSafeExistingParents(workspacePath, target))) {
    output.push({ path: relativePath, kind: 'missing' });
    return;
  }
  let info;
  try {
    info = await lstat(target, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      output.push({ path: relativePath, kind: 'missing' });
      return;
    }
    throw mutationInvalid(`archive source is unreadable: ${relativePath}`, error);
  }
  if (info.isSymbolicLink()) throw mutationInvalid(`archive source is a symlink: ${relativePath}`);
  if (info.isFile()) {
    if (info.nlink !== 1n) throw mutationInvalid(`archive source is a hardlink: ${relativePath}`);
    if (info.size > BigInt(MUTATION_LIMITS.fileBytes)) {
      throw mutationInvalid(`archive source exceeds the per-file budget: ${relativePath}`);
    }
    const bytes = await readExactFile(target);
    budget.bytes += bytes.byteLength;
    if (budget.bytes > MUTATION_LIMITS.totalBytes) {
      throw mutationInvalid('archive source exceeds the total byte budget');
    }
    output.push({
      path: relativePath,
      kind: 'file',
      digest: digestBytes(bytes),
      byteLength: bytes.byteLength,
    });
  } else if (info.isDirectory()) {
    output.push({ path: relativePath, kind: 'directory' });
    const names = (await assertOrdinaryDirectory(target, `archive directory ${relativePath}`)).sort(
      compareCanonicalStrings,
    );
    for (const name of names) {
      const child = `${relativePath}/${name}`;
      // Reuse the public path validator and protocol exclusion for every observed component.
      resolveWorkspaceRelativePath(workspacePath, child);
      await scanArchivePath(workspacePath, child, output, budget, depth + 1);
    }
  } else {
    throw mutationInvalid(`archive source has an unsupported type: ${relativePath}`);
  }
  budget.entries += 1;
  if (budget.entries > MUTATION_LIMITS.archiveEntries) {
    throw mutationInvalid('archive source exceeds the bounded entry count');
  }
}

export async function captureMutationArchiveEntries(
  workspacePath: string,
  archivePaths: readonly string[],
): Promise<MutationArchiveEntry[]> {
  const entries: MutationArchiveEntry[] = [];
  const budget: ArchiveScanBudget = { entries: 0, bytes: 0 };
  for (const path of archivePaths) await scanArchivePath(workspacePath, path, entries, budget, 0);
  entries.sort((left, right) => compareCanonicalStrings(left.path, right.path));
  return entries;
}

function exactEntrySet(
  actual: readonly string[],
  expected: readonly string[],
  label: string,
): void {
  const sorted = [...actual].sort(compareCanonicalStrings);
  if (
    sorted.length !== expected.length ||
    sorted.some((entry, index) => entry !== expected[index])
  ) {
    throw mutationInvalid(`${label} contains missing or unknown entries`);
  }
}

async function readPayloads(
  inputPath: string,
  manifest: MutationInputManifest,
): Promise<ReadonlyMap<string, Buffer>> {
  const payloadsPath = join(inputPath, MUTATION_PAYLOADS_DIR);
  const entries = await assertOrdinaryDirectory(payloadsPath, 'mutation payloads');
  const expectedFiles = [...manifest.writes.map((write) => write.payloadFile)].sort(
    compareCanonicalStrings,
  );
  exactEntrySet(entries, expectedFiles, 'mutation payloads');
  const payloads = new Map<string, Buffer>();
  for (const write of manifest.writes) {
    if (basename(write.payloadFile) !== write.payloadFile) {
      throw mutationInvalid('payloadFile must be one direct file name');
    }
    const bytes = await readExactFile(join(payloadsPath, write.payloadFile));
    if (bytes.byteLength !== write.byteLength || digestBytes(bytes) !== write.payloadDigest) {
      throw mutationInvalid(`payload bytes conflict with manifest: ${write.payloadFile}`);
    }
    payloads.set(write.payloadFile, bytes);
  }
  return payloads;
}

async function readApplyStaging(
  mutationPath: string,
  manifest: MutationInputManifest,
  payloads: ReadonlyMap<string, Buffer>,
): Promise<void> {
  const applyPath = join(mutationPath, MUTATION_APPLY_DIR);
  const entries = await assertOrdinaryDirectory(applyPath, 'mutation apply staging');
  const allowed = new Map<string, MutationInputManifest['writes'][number]>(
    manifest.writes.map((write) => [`write-${write.payloadFile}`, write] as const),
  );
  const preparedPattern = /^prepared-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}-(\d{8}\.bin)$/u;
  if (entries.length > manifest.writes.length + MUTATION_LIMITS.plannedPaths) {
    throw mutationInvalid('mutation apply staging exceeds the bounded entry count');
  }
  let preparedBytes = 0;
  for (const entry of entries) {
    const write = allowed.get(entry);
    if (write) {
      const expected = payloads.get(write.payloadFile);
      if (!expected) {
        throw mutationInvalid(`mutation apply staging lost payload ${write.payloadFile}`);
      }
      await assertExactFile(join(applyPath, entry), expected);
      continue;
    }
    const prepared = preparedPattern.exec(entry);
    const preparedWrite = prepared ? allowed.get(`write-${prepared[1]}`) : undefined;
    if (!preparedWrite) {
      throw mutationInvalid(`mutation apply staging contains unknown entry ${entry}`);
    }
    const info = await lstat(join(applyPath, entry), { bigint: true });
    if (info.isSymbolicLink() || !info.isFile() || info.nlink !== 1n) {
      throw mutationInvalid(`mutation apply prepared entry is not a single-link file: ${entry}`);
    }
    if (info.size > BigInt(preparedWrite.byteLength)) {
      throw mutationInvalid(`mutation apply prepared entry exceeds its payload: ${entry}`);
    }
    preparedBytes += Number(info.size);
    if (preparedBytes > MUTATION_LIMITS.totalBytes) {
      throw mutationInvalid('mutation apply prepared entries exceed the total byte budget');
    }
  }
}

export async function readMutationDomainAtPath(options: {
  readonly workspace: WorkspaceDirectory;
  readonly mutationPath: string;
  readonly expectedOwner?: OwnerRecord;
}): Promise<MutationDomain> {
  const entries = await assertOrdinaryDirectory(options.mutationPath, 'mutation domain');
  exactEntrySet(
    entries,
    [MUTATION_APPLY_DIR, MUTATION_INPUT_DIR, MUTATION_STATE_FILE],
    'mutation domain',
  );
  const statePath = join(options.mutationPath, MUTATION_STATE_FILE);
  const stateBytes = await readExactFile(statePath);
  const state = parseMutationState(stateBytes);
  const inputPath = join(options.mutationPath, MUTATION_INPUT_DIR);
  const inputEntries = await assertOrdinaryDirectory(inputPath, 'mutation input');
  exactEntrySet(
    inputEntries,
    [MUTATION_INPUT_MANIFEST_FILE, MUTATION_PAYLOADS_DIR],
    'mutation input',
  );
  const manifestPath = join(inputPath, MUTATION_INPUT_MANIFEST_FILE);
  const manifestBytes = await readExactFile(manifestPath);
  const manifest = parseMutationInputManifest(manifestBytes);
  const payloads = await readPayloads(inputPath, manifest);
  await readApplyStaging(options.mutationPath, manifest, payloads);
  if (
    state.ownerId !== manifest.ownerId ||
    state.mutationId !== manifest.mutationId ||
    state.kind !== manifest.kind ||
    state.inputDigest !== digestBytes(manifestBytes) ||
    state.baseSnapshotDigest !== manifest.baseSnapshotDigest ||
    manifest.workspaceIdentity !== options.workspace.identity
  ) {
    throw mutationInvalid('state and input manifest bindings do not match');
  }
  if (options.expectedOwner && state.ownerId !== options.expectedOwner.ownerId) {
    throw mutationInvalid('mutation does not bind the canonical lease owner');
  }
  const planned = [
    ...manifest.writes.map((item) => item.path),
    ...manifest.deletes.map((item) => item.path),
  ].sort(compareCanonicalStrings);
  if (
    planned.length !== state.plannedPaths.length ||
    planned.some((path, index) => path !== state.plannedPaths[index])
  ) {
    throw mutationInvalid('state plannedPaths do not match immutable input');
  }
  if (mutationBaseSnapshotDigest(manifest) !== manifest.baseSnapshotDigest) {
    throw mutationInvalid('input base snapshot digest does not match the manifest');
  }
  await assertExactFile(statePath, stateBytes);
  await assertExactFile(manifestPath, manifestBytes);
  return {
    workspace: options.workspace,
    path: options.mutationPath,
    state,
    stateBytes,
    manifest,
    manifestBytes,
    payloads,
  };
}

export async function readCanonicalMutationDomain(options: {
  readonly workspace: WorkspaceDirectory;
  readonly expectedOwner?: OwnerRecord;
}): Promise<MutationDomain> {
  return await readMutationDomainAtPath({
    ...options,
    mutationPath: join(options.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, MUTATION_DIR),
  });
}

async function verifyBaseSnapshot(domain: MutationDomain): Promise<void> {
  for (const write of domain.manifest.writes) {
    const current = await readMutationFileSnapshot(domain.workspace.path, write.path);
    if (!sameSnapshot(current.snapshot, write.before)) {
      throw mutationInvalid(`base snapshot changed before mutation install: ${write.path}`);
    }
  }
  for (const deletion of domain.manifest.deletes) {
    const current = await readMutationFileSnapshot(domain.workspace.path, deletion.path);
    if (!sameSnapshot(current.snapshot, deletion.before)) {
      throw mutationInvalid(`base snapshot changed before mutation install: ${deletion.path}`);
    }
  }
  const archiveEntries = await captureMutationArchiveEntries(
    domain.workspace.path,
    domain.manifest.archivePaths,
  );
  if (
    JSON.stringify(archiveEntries) !== JSON.stringify(domain.manifest.archiveEntries) ||
    mutationBaseSnapshotDigest({ ...domain.manifest, archiveEntries }) !==
      domain.manifest.baseSnapshotDigest
  ) {
    throw mutationInvalid('archive source changed before mutation install');
  }
}

export async function verifyMutationFinalSnapshot(domain: MutationDomain): Promise<void> {
  for (const write of domain.manifest.writes) {
    const current = await readMutationFileSnapshot(domain.workspace.path, write.path);
    const expected: MutationFileSnapshot = {
      kind: 'file',
      digest: write.payloadDigest,
      byteLength: write.byteLength,
    };
    if (!sameSnapshot(current.snapshot, expected)) {
      throw mutationInvalid(`mutation final write is incomplete or conflicting: ${write.path}`);
    }
  }
  for (const deletion of domain.manifest.deletes) {
    const current = await readMutationFileSnapshot(domain.workspace.path, deletion.path);
    if (current.snapshot.kind !== 'missing') {
      throw mutationInvalid(
        `mutation final deletion is incomplete or conflicting: ${deletion.path}`,
      );
    }
  }
}

export async function verifyMutationLegalIntermediateSnapshot(
  domain: MutationDomain,
): Promise<void> {
  if (domain.state.phase === 'staged' || domain.state.phase === 'archiving') {
    await verifyBaseSnapshot(domain);
    const archivePath = resolveWorkspaceRelativePath(
      domain.workspace.path,
      mutationArchivePath(domain.state.mutationId, domain.state.baseSnapshotDigest),
    );
    if (await pathExists(archivePath)) await verifyMutationArchive(domain);
    return;
  }
  await verifyMutationArchive(domain);
  if (domain.state.phase === 'committed') {
    await verifyMutationFinalSnapshot(domain);
    return;
  }
  for (const write of domain.manifest.writes) {
    const current = await readMutationFileSnapshot(domain.workspace.path, write.path);
    const after: MutationFileSnapshot = {
      kind: 'file',
      digest: write.payloadDigest,
      byteLength: write.byteLength,
    };
    if (!sameSnapshot(current.snapshot, write.before) && !sameSnapshot(current.snapshot, after)) {
      throw mutationInvalid(
        `applying target is neither exact before nor exact after: ${write.path}`,
      );
    }
  }
  for (const deletion of domain.manifest.deletes) {
    const current = await readMutationFileSnapshot(domain.workspace.path, deletion.path);
    if (current.snapshot.kind !== 'missing' && !sameSnapshot(current.snapshot, deletion.before)) {
      throw mutationInvalid(
        `applying delete target is neither exact before nor exact after: ${deletion.path}`,
      );
    }
  }
}

export async function captureMutationFinalSnapshotDigest(domain: MutationDomain): Promise<string> {
  await verifyMutationArchive(domain);
  await verifyMutationFinalSnapshot(domain);
  const targets: Array<{ path: string; snapshot: MutationFileSnapshot }> = [];
  for (const write of domain.manifest.writes) {
    targets.push({
      path: write.path,
      snapshot: (await readMutationFileSnapshot(domain.workspace.path, write.path)).snapshot,
    });
  }
  for (const deletion of domain.manifest.deletes) {
    targets.push({
      path: deletion.path,
      snapshot: (await readMutationFileSnapshot(domain.workspace.path, deletion.path)).snapshot,
    });
  }
  targets.sort((left, right) => compareCanonicalStrings(left.path, right.path));
  return digestBytes(
    Buffer.from(
      canonicalJson({
        stateDigest: digestBytes(domain.stateBytes),
        inputDigest: digestBytes(domain.manifestBytes),
        archiveManifestDigest: digestBytes(mutationArchiveManifestBytes(domain.manifest)),
        targets,
      }),
      'utf8',
    ),
  );
}

async function readArchiveFile(path: string, expected: MutationArchiveEntry): Promise<Buffer> {
  if (expected.kind !== 'file') throw mutationInvalid('archive file expectation is invalid');
  const bytes = await readExactFile(path);
  if (bytes.byteLength !== expected.byteLength || digestBytes(bytes) !== expected.digest) {
    throw mutationInvalid(`archive file conflicts with immutable input: ${expected.path}`);
  }
  return bytes;
}

export async function verifyMutationArchive(domain: MutationDomain): Promise<string> {
  const relativeArchive = mutationArchivePath(
    domain.state.mutationId,
    domain.state.baseSnapshotDigest,
  );
  const archivePath = resolveWorkspaceRelativePath(domain.workspace.path, relativeArchive);
  const rootEntries = await assertOrdinaryDirectory(archivePath, 'mutation archive');
  const expectedRootEntries = [MUTATION_ARCHIVE_MANIFEST_FILE];
  if (domain.manifest.archiveEntries.some((entry) => entry.kind !== 'missing')) {
    expectedRootEntries.push('data');
  }
  exactEntrySet(rootEntries, expectedRootEntries.sort(compareCanonicalStrings), 'mutation archive');
  await assertExactFile(
    join(archivePath, MUTATION_ARCHIVE_MANIFEST_FILE),
    mutationArchiveManifestBytes(domain.manifest),
  );
  const dataPath = join(archivePath, 'data');
  const expectedByParent = new Map<string, Set<string>>();
  const expectedDirectories = new Set<string>();
  for (const entry of domain.manifest.archiveEntries) {
    if (entry.kind === 'missing') continue;
    const parts = entry.path.split('/');
    for (let index = 0; index < parts.length; index += 1) {
      const parent = parts.slice(0, index).join('/');
      const children = expectedByParent.get(parent) ?? new Set<string>();
      children.add(parts[index]);
      expectedByParent.set(parent, children);
      if (index < parts.length - 1) expectedDirectories.add(parts.slice(0, index + 1).join('/'));
    }
    if (entry.kind === 'directory') expectedDirectories.add(entry.path);
  }
  if (expectedRootEntries.includes('data')) {
    await assertOrdinaryDirectory(dataPath, 'mutation archive data');
  }
  for (const directory of [...expectedDirectories].sort(compareCanonicalStrings)) {
    const target = resolveWorkspaceRelativePath(dataPath, directory);
    const children = await assertOrdinaryDirectory(target, `archive directory ${directory}`);
    const expected = [...(expectedByParent.get(directory) ?? [])].sort(compareCanonicalStrings);
    exactEntrySet(children, expected, `archive directory ${directory}`);
  }
  for (const entry of domain.manifest.archiveEntries) {
    if (entry.kind === 'file') {
      await readArchiveFile(resolveWorkspaceRelativePath(dataPath, entry.path), entry);
    }
  }
  const rootChildren = [...(expectedByParent.get('') ?? [])].sort(compareCanonicalStrings);
  if (expectedRootEntries.includes('data')) {
    exactEntrySet(await readdir(dataPath), rootChildren, 'mutation archive data');
  }
  return archivePath;
}

async function copyArchiveEntry(
  domain: MutationDomain,
  archiveData: string,
  entry: MutationArchiveEntry,
): Promise<void> {
  if (entry.kind === 'missing') return;
  const source = resolveWorkspaceRelativePath(domain.workspace.path, entry.path);
  const target = resolveWorkspaceRelativePath(archiveData, entry.path);
  if (entry.kind === 'directory') {
    const info = await lstat(source, { bigint: true });
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw mutationInvalid(`archive source directory changed: ${entry.path}`);
    }
    await ensureSafeParentDirectory(archiveData, target);
    await mkdir(target, { mode: 0o700 });
    return;
  }
  const bytes = await readArchiveFile(source, entry);
  await ensureSafeParentDirectory(archiveData, target);
  await writeNewFile(target, bytes);
  await assertExactFile(target, bytes);
}

async function ensureMutationArchive(
  domain: MutationDomain,
  authority: MutationWriterAuthorityControlled,
  hooks: MutationAdvanceHooks,
): Promise<void> {
  const relativeArchive = mutationArchivePath(
    domain.state.mutationId,
    domain.state.baseSnapshotDigest,
  );
  const archivePath = resolveWorkspaceRelativePath(domain.workspace.path, relativeArchive);
  if (await pathExists(archivePath)) {
    await verifyMutationArchive(domain);
    return;
  }
  const incidents = dirname(archivePath);
  const staging = await createStagingDirectory(
    incidents,
    'mutation-archive.prepare-',
    randomUUID(),
  );
  const hasData = domain.manifest.archiveEntries.some((entry) => entry.kind !== 'missing');
  const dataPath = join(staging, 'data');
  if (hasData) await mkdir(dataPath, { mode: 0o700 });
  for (const entry of domain.manifest.archiveEntries) {
    await authority.verify(domain, { kind: 'archive', path: relativeArchive });
    await copyArchiveEntry(domain, dataPath, entry);
    await hooks.duringArchiveCopy?.(entry);
  }
  const manifestBytes = mutationArchiveManifestBytes(domain.manifest);
  await writeNewFile(join(staging, MUTATION_ARCHIVE_MANIFEST_FILE), manifestBytes);
  const stagingDomain = { ...domain };
  // Verify source still matches the frozen input before the archive becomes canonical.
  await verifyBaseSnapshot(stagingDomain);
  await authority.verify(domain, { kind: 'archive', path: relativeArchive });
  await installDirectoryNoReplace(staging, archivePath);
  await verifyMutationArchive(domain);
}

async function stageState(domain: MutationDomain, state: MutationState): Promise<string> {
  const activeLease = dirname(domain.path);
  const staging = await createStagingDirectory(activeLease, 'mutation.prepare-', randomUUID());
  const statePath = join(staging, MUTATION_STATE_FILE);
  const bytes = mutationStateBytes(state);
  await writeNewFile(statePath, bytes);
  await assertExactFile(statePath, bytes);
  return statePath;
}

async function replaceMutationState(
  domain: MutationDomain,
  nextPhase: MutationState['phase'],
  authority: MutationWriterAuthorityControlled,
  hooks: MutationAdvanceHooks,
): Promise<MutationDomain> {
  const nextState: MutationState = { ...domain.state, phase: nextPhase };
  const staged = await stageState(domain, nextState);
  await authority.verify(domain, { kind: 'mutation-state', path: MUTATION_STATE_FILE });
  await assertExactFile(join(domain.path, MUTATION_STATE_FILE), domain.stateBytes);
  await replaceFileFromStaging(staged, join(domain.path, MUTATION_STATE_FILE));
  const next = await readMutationDomainAtPath({
    workspace: domain.workspace,
    mutationPath: domain.path,
  });
  const expectedBytes = mutationStateBytes(nextState);
  if (!next.stateBytes.equals(expectedBytes)) {
    throw mutationInvalid('mutation state transition did not install the exact next state');
  }
  await hooks.afterMutationStateInstalled?.(nextPhase);
  await authority.afterStateTransition?.(domain, next);
  return next;
}

async function stageBusinessFile(
  domain: MutationDomain,
  payloadFile: string,
  bytes: Buffer,
): Promise<string> {
  const staging = join(domain.path, MUTATION_APPLY_DIR, `write-${payloadFile}`);
  if (await pathExists(staging)) {
    await assertExactFile(staging, bytes);
    return staging;
  }
  const prepared = join(domain.path, MUTATION_APPLY_DIR, `prepared-${randomUUID()}-${payloadFile}`);
  await writeNewFile(prepared, bytes);
  await assertExactFile(prepared, bytes);
  if (await pathExists(staging)) {
    await assertExactFile(staging, bytes);
    return staging;
  }
  await replaceFileFromStaging(prepared, staging);
  await assertExactFile(staging, bytes);
  return staging;
}

async function applyMutationTargets(
  domain: MutationDomain,
  authority: MutationWriterAuthorityControlled,
  hooks: MutationAdvanceHooks,
): Promise<void> {
  for (const write of domain.manifest.writes) {
    const payload = domain.payloads.get(write.payloadFile);
    if (!payload) throw mutationInvalid(`missing in-memory payload: ${write.payloadFile}`);
    const after: MutationFileSnapshot = {
      kind: 'file',
      digest: write.payloadDigest,
      byteLength: write.byteLength,
    };
    let current = await readMutationFileSnapshot(domain.workspace.path, write.path);
    if (sameSnapshot(current.snapshot, after)) continue;
    if (!sameSnapshot(current.snapshot, write.before)) {
      throw mutationInvalid(
        `business target is neither exact before nor exact after: ${write.path}`,
      );
    }
    const target = resolveWorkspaceRelativePath(domain.workspace.path, write.path);
    if (!(await assertSafeExistingParents(domain.workspace.path, target))) {
      throw mutationInvalid(`business target parent must already exist: ${write.path}`);
    }
    const staging = await stageBusinessFile(domain, write.payloadFile, payload);
    await authority.verify(domain, { kind: 'business-write', path: write.path });
    current = await readMutationFileSnapshot(domain.workspace.path, write.path);
    if (!sameSnapshot(current.snapshot, write.before)) {
      throw mutationInvalid(`business target changed before atomic write: ${write.path}`);
    }
    await replaceFileFromStaging(staging, target);
    const installed = await readMutationFileSnapshot(domain.workspace.path, write.path);
    if (!sameSnapshot(installed.snapshot, after)) {
      throw mutationInvalid(`business write did not install exact after bytes: ${write.path}`);
    }
    await hooks.afterBusinessStep?.(write.path);
  }
  for (const deletion of domain.manifest.deletes) {
    let current = await readMutationFileSnapshot(domain.workspace.path, deletion.path);
    if (current.snapshot.kind === 'missing') continue;
    if (!sameSnapshot(current.snapshot, deletion.before)) {
      throw mutationInvalid(
        `delete target is neither exact before nor exact after: ${deletion.path}`,
      );
    }
    await authority.verify(domain, { kind: 'business-delete', path: deletion.path });
    current = await readMutationFileSnapshot(domain.workspace.path, deletion.path);
    if (!sameSnapshot(current.snapshot, deletion.before)) {
      throw mutationInvalid(`delete target changed before unlink: ${deletion.path}`);
    }
    try {
      await unlink(resolveWorkspaceRelativePath(domain.workspace.path, deletion.path));
    } catch (error) {
      if (errorCode(error) !== 'ENOENT') throw error;
    }
    const removed = await readMutationFileSnapshot(domain.workspace.path, deletion.path);
    if (removed.snapshot.kind !== 'missing') {
      throw mutationInvalid(`delete target remains after unlink: ${deletion.path}`);
    }
    await hooks.afterBusinessStep?.(deletion.path);
  }
}

export async function advanceWorkspaceMutationControlled(
  initial: MutationDomain,
  authority: MutationWriterAuthorityControlled,
  hooks: MutationAdvanceHooks = {},
): Promise<MutationDomain> {
  if (initial.workspace.identity !== authority.workspace.identity) {
    throw mutationInvalid('mutation authority belongs to a different workspace');
  }
  let domain = initial;
  await authority.verify(domain);
  if (domain.state.phase === 'staged') {
    await verifyBaseSnapshot(domain);
    domain = await replaceMutationState(domain, 'archiving', authority, hooks);
    await hooks.afterArchivingState?.();
  }
  if (domain.state.phase === 'archiving') {
    await ensureMutationArchive(domain, authority, hooks);
    await hooks.afterArchiveInstalled?.();
    domain = await replaceMutationState(domain, 'applying', authority, hooks);
    await hooks.afterApplyingState?.();
  }
  if (domain.state.phase === 'applying') {
    await verifyMutationArchive(domain);
    await applyMutationTargets(domain, authority, hooks);
    await verifyMutationFinalSnapshot(domain);
    domain = await replaceMutationState(domain, 'committed', authority, hooks);
    await hooks.afterCommittedState?.();
  }
  if (domain.state.phase !== 'committed') {
    throw mutationInvalid('mutation did not reach committed');
  }
  await verifyMutationArchive(domain);
  await verifyMutationFinalSnapshot(domain);
  await authority.verify(domain);
  return domain;
}

export async function verifyMutationBaseBeforeInstall(domain: MutationDomain): Promise<void> {
  await verifyBaseSnapshot(domain);
}

export async function writeMutationInputStagingControlled(options: {
  readonly workspace: WorkspaceDirectory;
  readonly owner: OwnerRecord;
  readonly mutationId: string;
  readonly state: MutationState;
  readonly manifest: MutationInputManifest;
  readonly payloads: ReadonlyMap<string, Buffer>;
}): Promise<{ readonly staging: string; readonly domain: MutationDomain }> {
  const activeLease = join(options.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  const staging = await createStagingDirectory(
    activeLease,
    'mutation.prepare-',
    options.mutationId,
  );
  const input = join(staging, MUTATION_INPUT_DIR);
  const payloadsPath = join(input, MUTATION_PAYLOADS_DIR);
  const applyPath = join(staging, MUTATION_APPLY_DIR);
  await mkdir(input, { mode: 0o700 });
  await mkdir(payloadsPath, { mode: 0o700 });
  await mkdir(applyPath, { mode: 0o700 });
  for (const write of options.manifest.writes) {
    const payload = options.payloads.get(write.payloadFile);
    if (!payload) throw mutationInvalid(`caller omitted payload ${write.payloadFile}`);
    await writeNewFile(join(payloadsPath, write.payloadFile), payload);
  }
  const manifestBytes = mutationManifestBytes(options.manifest);
  await writeNewFile(join(input, MUTATION_INPUT_MANIFEST_FILE), manifestBytes);
  await writeNewFile(join(staging, MUTATION_STATE_FILE), mutationStateBytes(options.state));
  const domain = await readMutationDomainAtPath({
    workspace: options.workspace,
    mutationPath: staging,
    expectedOwner: options.owner,
  });
  return { staging, domain };
}

export async function installMutationStagingControlled(
  staging: string,
  workspace: WorkspaceDirectory,
): Promise<MutationDomain> {
  const target = join(workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, MUTATION_DIR);
  await installDirectoryNoReplace(staging, target);
  return await readMutationDomainAtPath({ workspace, mutationPath: target });
}

/** Used only by destructive fixtures to ensure a hard-killed child leaves no open temp handle. */
export async function fsyncMutationFixtureFile(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}
