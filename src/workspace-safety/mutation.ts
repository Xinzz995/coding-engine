import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  compareCanonicalStrings,
  validateRelativePath,
  workspacePathCollisionKey,
} from './baseline-contract.js';
import { digestBytes, pathExists } from './filesystem.js';
import { inspectQuarantinePresence, isQuarantineStagingName } from './quarantine.js';
import type { WorkspaceSession, WorkspaceWriteData } from './session.js';
import {
  advanceWorkspaceMutationControlled,
  assertMutationWriteParentExists,
  captureMutationArchiveEntries,
  createMutationWriterAuthorityControlled,
  installMutationStagingControlled,
  readCanonicalMutationDomain,
  readMutationFileSnapshot,
  verifyMutationBaseBeforeInstall,
  writeMutationInputStagingControlled,
  type MutationAdvanceHooks,
  type MutationDomain,
  type MutationWriterAuthorityControlled,
  type MutationWriteScope,
} from './mutation-domain.js';
import {
  MUTATION_LIMITS,
  mutationBaseSnapshotDigest,
  mutationInvalid,
  mutationManifestBytes,
  parseMutationInputManifest,
  parseMutationState,
  type MutationDeleteInput,
  type MutationInputManifest,
  type MutationKind,
  type MutationState,
  type MutationWriteInput,
} from './mutation-records.js';
import {
  ACTIVE_LEASE_DIR,
  MUTATION_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  WORKSPACE_MARKER_FILE,
  WorkspaceSafetyError,
} from './types.js';
import { assertWindowsWorkspaceTreeHasNoReparsePoints } from './windows-path-attributes.js';

export interface WorkspaceMutationWrite {
  readonly path: string;
  readonly data: WorkspaceWriteData;
}

export interface WorkspaceMutationPlanControlled {
  readonly kind: MutationKind;
  readonly writes: readonly WorkspaceMutationWrite[];
  readonly deletes: readonly string[];
  readonly archivePaths: readonly string[];
  readonly mutationId?: string;
  readonly now?: () => Date;
  readonly hooks?: MutationAdvanceHooks & {
    readonly afterMutationInstalled?: (domain: MutationDomain) => void | Promise<void>;
  };
}

const STAGING_PATTERNS = [
  /^mutation\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
  /^operation\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
  /^recovery\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u,
];

function safePath(value: string, label: string): string {
  try {
    const path = validateRelativePath(value, label);
    if (workspacePathCollisionKey(path) === workspacePathCollisionKey(WORKSPACE_MARKER_FILE)) {
      throw mutationInvalid(`${label} cannot target the workspace safety marker`);
    }
    if (
      path
        .split('/')
        .some(
          (part) =>
            part.startsWith('.coding-x-') || /^\..+\.(?:coding-x|mutation)-.+\.tmp$/u.test(part),
        )
    ) {
      throw mutationInvalid(`${label} cannot target an internal staging name`);
    }
    return path;
  } catch (error) {
    if (error instanceof WorkspaceSafetyError && error.message.startsWith('Invalid mutation')) {
      throw error;
    }
    throw mutationInvalid(`${label} is not a safe workspace-relative path`, error);
  }
}

function assertNoPathConflicts(paths: readonly string[], label: string): void {
  const exact = new Set<string>();
  const collision = new Set<string>();
  for (const path of paths) {
    if (exact.has(path) || collision.has(workspacePathCollisionKey(path))) {
      throw mutationInvalid(`${label} contains a duplicate or platform path collision`);
    }
    exact.add(path);
    collision.add(workspacePathCollisionKey(path));
  }
  for (const path of paths) {
    const parts = path.split('/');
    for (let index = 1; index < parts.length; index += 1) {
      if (exact.has(parts.slice(0, index).join('/'))) {
        throw mutationInvalid(`${label} contains an ancestor/descendant conflict`);
      }
    }
  }
}

function canonicalDate(now: () => Date): string {
  const value = now();
  const timestamp = value.toISOString();
  if (new Date(timestamp).toISOString() !== timestamp) {
    throw mutationInvalid('mutation timestamp is invalid');
  }
  return timestamp;
}

async function assertNormalMutationStart(session: WorkspaceSession): Promise<void> {
  await session.lease.verify();
  const activeLease = join(session.lease.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
  for (const fixed of [OPERATION_DIR, MUTATION_DIR, RECOVERY_DIR]) {
    if (await pathExists(join(activeLease, fixed))) {
      throw new WorkspaceSafetyError('isolated', `存在 active ${fixed}，不能开始 mutation`);
    }
  }
  if (await inspectQuarantinePresence(activeLease)) {
    throw new WorkspaceSafetyError('isolated', '存在 quarantine，不能开始 mutation');
  }
  for (const entry of await readdir(activeLease)) {
    if (
      entry === OWNER_FILE ||
      entry === 'settled-operations' ||
      STAGING_PATTERNS.some((pattern) => pattern.test(entry)) ||
      isQuarantineStagingName(entry)
    ) {
      continue;
    }
    throw mutationInvalid(`active lease contains an unknown entry before mutation: ${entry}`);
  }
}

async function buildMutationInput(
  session: WorkspaceSession,
  plan: WorkspaceMutationPlanControlled,
): Promise<{
  readonly state: MutationState;
  readonly manifest: MutationInputManifest;
  readonly payloads: ReadonlyMap<string, Buffer>;
}> {
  if (plan.writes.length + plan.deletes.length === 0) {
    throw mutationInvalid('a mutation must contain at least one business write or delete');
  }
  if (plan.writes.length + plan.deletes.length > MUTATION_LIMITS.plannedPaths) {
    throw mutationInvalid('mutation planned paths exceed the bounded count');
  }
  if (plan.archivePaths.length > MUTATION_LIMITS.plannedPaths) {
    throw mutationInvalid('mutation archive paths exceed the bounded count');
  }
  const writes = plan.writes
    .map((write) => ({ path: safePath(write.path, 'write.path'), data: Buffer.from(write.data) }))
    .sort((left, right) => compareCanonicalStrings(left.path, right.path));
  const deletes = plan.deletes
    .map((path) => safePath(path, 'delete.path'))
    .sort(compareCanonicalStrings);
  const archivePaths = plan.archivePaths
    .map((path) => safePath(path, 'archivePath'))
    .sort(compareCanonicalStrings);
  assertNoPathConflicts(
    [...writes.map((write) => write.path), ...deletes],
    'mutation planned paths',
  );
  assertNoPathConflicts(archivePaths, 'mutation archive paths');

  let totalPayloadBytes = 0;
  let totalBeforeBytes = 0;
  const payloads = new Map<string, Buffer>();
  const manifestWrites: MutationWriteInput[] = [];
  for (const [index, write] of writes.entries()) {
    await assertMutationWriteParentExists(session.lease.workspace.path, write.path);
    if (write.data.byteLength > MUTATION_LIMITS.fileBytes) {
      throw mutationInvalid(`write payload exceeds the per-file budget: ${write.path}`);
    }
    totalPayloadBytes += write.data.byteLength;
    if (totalPayloadBytes > MUTATION_LIMITS.totalBytes) {
      throw mutationInvalid('write payloads exceed the total byte budget');
    }
    const before = await readMutationFileSnapshot(session.lease.workspace.path, write.path);
    totalBeforeBytes += before.bytes.byteLength;
    if (totalBeforeBytes > MUTATION_LIMITS.totalBytes) {
      throw mutationInvalid('mutation base targets exceed the total byte budget');
    }
    const payloadFile = `${String(index).padStart(8, '0')}.bin`;
    payloads.set(payloadFile, write.data);
    manifestWrites.push({
      path: write.path,
      payloadFile,
      payloadDigest: digestBytes(write.data),
      byteLength: write.data.byteLength,
      before: before.snapshot,
    });
  }
  const manifestDeletes: MutationDeleteInput[] = [];
  for (const path of deletes) {
    const before = await readMutationFileSnapshot(session.lease.workspace.path, path);
    totalBeforeBytes += before.bytes.byteLength;
    if (totalBeforeBytes > MUTATION_LIMITS.totalBytes) {
      throw mutationInvalid('mutation base targets exceed the total byte budget');
    }
    manifestDeletes.push({ path, before: before.snapshot });
  }
  const archiveEntries = await captureMutationArchiveEntries(
    session.lease.workspace.path,
    archivePaths,
  );
  const mutationId = plan.mutationId ?? randomUUID();
  const manifestWithoutDigest = {
    schemaVersion: 1 as const,
    domain: 'coding-x-workspace-mutation-input-v1' as const,
    workspaceIdentity: session.lease.workspace.identity,
    ownerId: session.lease.owner.ownerId,
    mutationId,
    kind: plan.kind,
    writes: manifestWrites,
    deletes: manifestDeletes,
    archivePaths,
    archiveEntries,
  };
  const baseSnapshotDigest = mutationBaseSnapshotDigest({
    writes: manifestWrites,
    deletes: manifestDeletes,
    archivePaths,
    archiveEntries,
  });
  const manifest = parseMutationInputManifest(
    mutationManifestBytes({ ...manifestWithoutDigest, baseSnapshotDigest }),
  );
  const state = parseMutationState(
    Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          domain: 'coding-x-workspace-mutation-state-v1',
          ownerId: session.lease.owner.ownerId,
          mutationId,
          kind: plan.kind,
          inputDigest: digestBytes(mutationManifestBytes(manifest)),
          baseSnapshotDigest,
          phase: 'staged',
          plannedPaths: [...manifestWrites.map((write) => write.path), ...deletes].sort(
            compareCanonicalStrings,
          ),
          startedAt: canonicalDate(plan.now ?? (() => new Date())),
        },
        null,
        2,
      )}\n`,
      'utf8',
    ),
  );
  return { state, manifest, payloads };
}

function scopeIsAllowed(domain: MutationDomain, scope: MutationWriteScope): boolean {
  if (scope.kind === 'mutation-state') return scope.path === 'state.json';
  if (scope.kind === 'archive') {
    return scope.path.startsWith('engine.lock/incidents/mutation-data-');
  }
  if (scope.kind === 'business-write') {
    return domain.manifest.writes.some((write) => write.path === scope.path);
  }
  return domain.manifest.deletes.some((deletion) => deletion.path === scope.path);
}

function normalAuthority(session: WorkspaceSession): MutationWriterAuthorityControlled {
  return createMutationWriterAuthorityControlled({
    workspace: session.lease.workspace,
    verify: async (expected, scope) => {
      await session.lease.verify();
      const current = await readCanonicalMutationDomain({
        workspace: session.lease.workspace,
        expectedOwner: session.lease.owner,
      });
      if (
        !current.stateBytes.equals(expected.stateBytes) ||
        !current.manifestBytes.equals(expected.manifestBytes)
      ) {
        throw new WorkspaceSafetyError('lease-lost', 'mutation authority binding changed');
      }
      if (scope && !scopeIsAllowed(current, scope)) {
        throw mutationInvalid('mutation authority rejected an out-of-plan write');
      }
      await session.lease.verify();
    },
  });
}

/**
 * Dark generic mutation producer. It deliberately does not close/release the caller's session;
 * the caller remains responsible for the command lifecycle after committed is returned.
 */
export async function runWorkspaceMutationControlled(
  session: WorkspaceSession,
  plan: WorkspaceMutationPlanControlled,
): Promise<MutationDomain> {
  return await session.withExclusiveAction(async () => {
    assertWindowsWorkspaceTreeHasNoReparsePoints(session.lease.workspace.path);
    await assertNormalMutationStart(session);
    const input = await buildMutationInput(session, plan);
    const prepared = await writeMutationInputStagingControlled({
      workspace: session.lease.workspace,
      owner: session.lease.owner,
      mutationId: input.state.mutationId,
      ...input,
    });
    await verifyMutationBaseBeforeInstall(prepared.domain);
    await session.lease.verify();
    const installed = await installMutationStagingControlled(
      prepared.staging,
      session.lease.workspace,
    );
    await plan.hooks?.afterMutationInstalled?.(installed);
    assertWindowsWorkspaceTreeHasNoReparsePoints(session.lease.workspace.path);
    const committed = await advanceWorkspaceMutationControlled(
      installed,
      normalAuthority(session),
      plan.hooks,
    );
    assertWindowsWorkspaceTreeHasNoReparsePoints(session.lease.workspace.path);
    return committed;
  });
}

export async function inspectCommittedWorkspaceMutation(
  session: WorkspaceSession,
): Promise<MutationDomain> {
  return await session.withExclusiveAction(async () => {
    await session.lease.verify();
    const domain = await readCanonicalMutationDomain({
      workspace: session.lease.workspace,
      expectedOwner: session.lease.owner,
    });
    if (domain.state.phase !== 'committed') {
      throw new WorkspaceSafetyError('isolated', 'mutation 尚未 committed');
    }
    return domain;
  });
}

export async function assertMutationStagingIsOrdinary(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw mutationInvalid('mutation staging is not an ordinary directory');
  }
}
