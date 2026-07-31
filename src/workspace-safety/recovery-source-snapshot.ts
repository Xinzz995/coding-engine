import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertExactFile,
  assertWorkspaceDirectoryUnchanged,
  digestBytes,
  jsonBytes,
  readExactFile,
} from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import {
  assertExactContainmentQuarantine,
  inspectQuarantinePresence,
  isQuarantineStagingName,
  readQuarantinePresence,
  QUARANTINE_FILE,
  type ExactContainmentQuarantine,
  parseQuarantineRecord,
} from './quarantine.js';
import {
  readActiveLeaseOwner,
  readReadyWorkspaceRecords,
  type ReadyWorkspaceRecords,
} from './lease.js';
import { RECOVERY_SCHEMA_VERSION, recoveryInvalid } from './recovery-records.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  WORKSPACE_MARKER_FILE,
  type IdentityVerdict,
  type OwnerRecord,
  WorkspaceSafetyError,
} from './types.js';

const SAFE_PROTOCOL_ENTRY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/u;
const RECOVERY_STAGING_PATTERN = /^recovery\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const OPERATION_STAGING_PATTERN =
  /^operation\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const MUTATION_STAGING_PATTERN = /^mutation\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

const SOURCE_CANONICAL_ENTRIES = new Set([
  OWNER_FILE,
  'operation',
  'settled-operations',
  'mutation',
  'bootstrap-input',
  QUARANTINE_FILE,
]);
const MAX_SOURCE_ENTRIES = 100_000;
const MAX_SOURCE_FILE_BYTES = 64 * 1024 * 1024;
const MAX_SOURCE_TOTAL_BYTES = 256 * 1024 * 1024;
const MAX_SOURCE_PATH_BYTES = 1024;
const MAX_SOURCE_MANIFEST_BYTES = 32 * 1024 * 1024;

interface SourceEntry {
  readonly path: string;
  readonly kind: 'directory' | 'file';
  readonly size?: number;
  readonly digest?: string;
}

interface SourceBudget {
  bytes: number;
}

function compareCodePoints(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSafeProtocolEntry(name: string, relativePath: string): void {
  if (!SAFE_PROTOCOL_ENTRY_PATTERN.test(name)) {
    throw recoveryInvalid(`source snapshot contains an unsafe path: ${relativePath}`);
  }
  if (Buffer.byteLength(relativePath, 'utf8') > MAX_SOURCE_PATH_BYTES) {
    throw recoveryInvalid(`source snapshot path is too long: ${relativePath}`);
  }
}

async function assertExcludedDirectory(path: string, relativePath: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw recoveryInvalid(`excluded source path is not an ordinary directory: ${relativePath}`);
  }
}

async function scanSourceDirectory(
  directory: string,
  relativeDirectory: string,
  entries: SourceEntry[],
  budget: SourceBudget,
): Promise<void> {
  const names = (await readdir(directory)).sort(compareCodePoints);
  for (const name of names) {
    const relativePath = relativeDirectory ? `${relativeDirectory}/${name}` : name;
    assertSafeProtocolEntry(name, relativePath);
    const path = join(directory, name);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) {
      throw recoveryInvalid(`source snapshot contains a symlink: ${relativePath}`);
    }
    if (info.isDirectory()) {
      entries.push({ path: relativePath, kind: 'directory' });
      if (entries.length > MAX_SOURCE_ENTRIES) {
        throw recoveryInvalid('source snapshot exceeds the bounded entry count');
      }
      await scanSourceDirectory(path, relativePath, entries, budget);
      continue;
    }
    if (!info.isFile()) {
      throw recoveryInvalid(`source snapshot contains an unsupported entry: ${relativePath}`);
    }
    if (info.size > BigInt(MAX_SOURCE_FILE_BYTES)) {
      throw recoveryInvalid(`source snapshot file is too large: ${relativePath}`);
    }
    const bytes = await readExactFile(path);
    budget.bytes += bytes.byteLength;
    if (budget.bytes > MAX_SOURCE_TOTAL_BYTES) {
      throw recoveryInvalid('source snapshot exceeds the bounded total file bytes');
    }
    entries.push({
      path: relativePath,
      kind: 'file',
      size: bytes.byteLength,
      digest: digestBytes(bytes),
    });
    if (entries.length > MAX_SOURCE_ENTRIES) {
      throw recoveryInvalid('source snapshot exceeds the bounded entry count');
    }
  }
}

async function scanRecoverySource(activeLease: string): Promise<string> {
  await assertExcludedDirectory(activeLease, 'recovery source lease');
  await inspectQuarantinePresence(activeLease);
  const rootEntries = (await readdir(activeLease)).sort(compareCodePoints);
  const entries: SourceEntry[] = [];
  const budget: SourceBudget = { bytes: 0 };
  for (const name of rootEntries) {
    if (
      name === RECOVERY_DIR ||
      RECOVERY_STAGING_PATTERN.test(name) ||
      OPERATION_STAGING_PATTERN.test(name) ||
      MUTATION_STAGING_PATTERN.test(name) ||
      isQuarantineStagingName(name)
    ) {
      if (isQuarantineStagingName(name)) continue;
      await assertExcludedDirectory(join(activeLease, name), name);
      continue;
    }
    if (!SOURCE_CANONICAL_ENTRIES.has(name)) {
      throw recoveryInvalid(`active lease contains unknown source entry ${name}`);
    }
    assertSafeProtocolEntry(name, name);
    const path = join(activeLease, name);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink()) {
      throw recoveryInvalid(`source snapshot contains a symlink: ${name}`);
    }
    if (info.isDirectory()) {
      entries.push({ path: name, kind: 'directory' });
      await scanSourceDirectory(path, name, entries, budget);
      continue;
    }
    if (!info.isFile() || (name !== OWNER_FILE && name !== QUARANTINE_FILE)) {
      throw recoveryInvalid(`source snapshot contains an invalid canonical entry: ${name}`);
    }
    if (info.size > BigInt(MAX_SOURCE_FILE_BYTES)) {
      throw recoveryInvalid(`source snapshot file is too large: ${name}`);
    }
    const bytes = await readExactFile(path);
    if (name === QUARANTINE_FILE) parseQuarantineRecord(bytes);
    budget.bytes += bytes.byteLength;
    if (budget.bytes > MAX_SOURCE_TOTAL_BYTES) {
      throw recoveryInvalid('source snapshot exceeds the bounded total file bytes');
    }
    entries.push({ path: name, kind: 'file', size: bytes.byteLength, digest: digestBytes(bytes) });
  }
  if (!entries.some((entry) => entry.path === OWNER_FILE && entry.kind === 'file')) {
    throw recoveryInvalid('source snapshot is missing the active owner');
  }
  const manifestBytes = jsonBytes({
    schemaVersion: RECOVERY_SCHEMA_VERSION,
    domain: 'coding-x-recovery-source-v1',
    entries,
  });
  if (manifestBytes.byteLength > MAX_SOURCE_MANIFEST_BYTES) {
    throw recoveryInvalid('source snapshot manifest exceeds its bounded size');
  }
  return digestBytes(manifestBytes);
}

export async function assertMechanicalEmptyEligibility(
  records: ReadyWorkspaceRecords,
  sourceOwner: OwnerRecord,
  allowInstalledRecovery: boolean,
  expectedContainment?: ExactContainmentQuarantine,
): Promise<void> {
  const activeLease = join(records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  await assertMechanicalEmptyLeaseEligibility(
    activeLease,
    sourceOwner,
    allowInstalledRecovery,
    expectedContainment,
  );
}

export async function assertMechanicalEmptyLeaseEligibility(
  leasePath: string,
  sourceOwner: OwnerRecord,
  allowInstalledRecovery: boolean,
  expectedContainment?: ExactContainmentQuarantine,
): Promise<void> {
  const quarantinePresence = await readQuarantinePresence(leasePath);
  if (!expectedContainment && quarantinePresence.present) {
    throw new WorkspaceSafetyError(
      'unsupported',
      `Recovery is not eligible: mechanical-empty cannot consume ${QUARANTINE_FILE}`,
    );
  }
  if (expectedContainment) {
    const canonical = quarantinePresence.canonical;
    if (!canonical || canonical.linkedSource) {
      throw recoveryInvalid(
        'reboot mechanical recovery requires one complete canonical quarantine',
      );
    }
    const quarantine = assertExactContainmentQuarantine(expectedContainment, canonical.bytes);
    const ownerBytes = await readExactFile(join(leasePath, OWNER_FILE));
    if (
      quarantine.ownerId !== sourceOwner.ownerId ||
      quarantine.operationId !== null ||
      quarantine.activeChildDigest !== null ||
      quarantine.delegatedBaselineDigest !== null ||
      quarantine.creator.kind !== 'owner' ||
      quarantine.creator.id !== sourceOwner.ownerId ||
      quarantine.creator.recordDigest !== digestBytes(ownerBytes)
    ) {
      throw recoveryInvalid('root containment quarantine does not bind the exact source owner');
    }
  }
  if (sourceOwner.command === 'workspace-init') {
    throw new WorkspaceSafetyError(
      'unsupported',
      'Recovery is not eligible: workspace-init owners require bootstrap-complete proof',
    );
  }
  await assertExcludedDirectory(leasePath, 'mechanical-empty source lease');
  const entries = await readdir(leasePath);
  if (expectedContainment && entries.some((entry) => isQuarantineStagingName(entry))) {
    throw recoveryInvalid('reboot mechanical recovery cannot consume quarantine staging');
  }
  for (const entry of entries) {
    if (
      entry === OWNER_FILE ||
      (expectedContainment !== undefined && entry === QUARANTINE_FILE) ||
      entry === 'settled-operations' ||
      RECOVERY_STAGING_PATTERN.test(entry) ||
      OPERATION_STAGING_PATTERN.test(entry) ||
      MUTATION_STAGING_PATTERN.test(entry) ||
      isQuarantineStagingName(entry) ||
      (allowInstalledRecovery && entry === RECOVERY_DIR)
    ) {
      continue;
    }
    if (
      entry === 'operation' ||
      entry === 'mutation' ||
      entry === 'bootstrap-input' ||
      entry === RECOVERY_DIR
    ) {
      throw new WorkspaceSafetyError(
        'unsupported',
        `Recovery is not eligible: mechanical-empty cannot consume ${entry}`,
      );
    }
    throw recoveryInvalid(`active lease contains unknown source entry ${entry}`);
  }
}

export function createSourceOwnerProbe(
  configured: ((owner: OwnerRecord) => IdentityVerdict) | undefined,
): (owner: OwnerRecord) => IdentityVerdict {
  if (configured) return configured;
  const identityProbe = createIdentityProbe();
  return (owner) => identityProbe.probe(owner);
}

export function requireDeadSourceOwner(
  owner: OwnerRecord,
  probe: (owner: OwnerRecord) => IdentityVerdict,
): void {
  const verdict = probe(owner);
  if (verdict !== 'dead') {
    throw new WorkspaceSafetyError(
      'conflict',
      `Recovery conflict: source owner is ${verdict}, not exact dead`,
    );
  }
}

export async function captureRecoverySourceFromRecords(
  records: ReadyWorkspaceRecords,
): Promise<string> {
  const activeLease = join(records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  return await captureRecoverySourceAtLeasePath(records, activeLease);
}

export async function captureRecoverySourceAtLeasePath(
  records: ReadyWorkspaceRecords,
  leasePath: string,
): Promise<string> {
  try {
    await assertWorkspaceDirectoryUnchanged(records.workspace);
    const first = await scanRecoverySource(leasePath);
    const second = await scanRecoverySource(leasePath);
    if (first !== second) {
      throw recoveryInvalid('recovery source changed during stable snapshot capture');
    }
    await assertExactFile(
      join(records.workspace.path, PROTOCOL_ROOT_DIR, PROTOCOL_FILE),
      records.protocolBytes,
    );
    await assertExactFile(join(records.workspace.path, WORKSPACE_MARKER_FILE), records.markerBytes);
    await assertWorkspaceDirectoryUnchanged(records.workspace);
    return first;
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw recoveryInvalid('recovery source is missing, changing, or unreadable', error);
  }
}

export async function captureRecoverySourceSnapshotDigest(workspacePath: string): Promise<string> {
  const records = await readReadyWorkspaceRecords(workspacePath);
  if (!(await readActiveLeaseOwner(records))) {
    throw recoveryInvalid('source snapshot requires a canonical active lease owner');
  }
  return await captureRecoverySourceFromRecords(records);
}
