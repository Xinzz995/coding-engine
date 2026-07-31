import { randomUUID } from 'node:crypto';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertExactFile,
  assertWorkspaceDirectoryUnchanged,
  canonicalizeWorkspaceDirectory,
  createStagingDirectory,
  digestBytes,
  installDirectoryNoReplace,
  jsonBytes,
  moveDirectoryNoReplace,
  pathExists,
  readExactFile,
  writeNewFile,
  type WorkspaceDirectory,
} from './filesystem.js';
import { captureExactCurrentIdentityAuthority } from './identity.js';
import {
  parseJsonRecord,
  parseOwnerRecord,
  parseProtocolRecord,
  parseWorkspaceMarker,
  validateCoreRecordBindings,
} from './schema.js';
import {
  readCanonicalMutationDomain,
  verifyMutationArchive,
  verifyMutationFinalSnapshot,
} from './mutation-domain.js';
import { inspectQuarantinePresence, withQuarantineContainerExclusive } from './quarantine.js';
import {
  ACTIVE_LEASE_DIR,
  INCIDENTS_DIR,
  MUTATION_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  OWNER_SCHEMA_VERSION,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  WORKSPACE_MARKER_FILE,
  type OwnerCommand,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  type ProtocolRecord,
  type WorkspaceMarker,
  WorkspaceSafetyError,
} from './types.js';
import { assertWindowsSafetyTreeHasNoReparsePoints } from './windows-path-attributes.js';

export interface ReadyWorkspaceRecords {
  readonly workspace: WorkspaceDirectory;
  readonly marker: WorkspaceMarker;
  readonly markerBytes: Buffer;
  readonly protocol: ProtocolRecord;
  readonly protocolBytes: Buffer;
}

export interface LeaseHooks {
  readonly beforeLeaseInstall?: (stagingPath: string) => void | Promise<void>;
  readonly afterLeaseInstalled?: () => void | Promise<void>;
}

export interface ControlledAcquireWorkspaceLeaseOptions {
  readonly workspacePath: string;
  readonly identity: ProcessIdentitySnapshot;
  readonly command: Exclude<OwnerCommand, 'workspace-init'>;
  readonly ownerId?: string;
  readonly now?: () => Date;
  readonly hooks?: LeaseHooks;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal lease input. Authority, identifiers, clocks, and barriers are never caller data. */
export interface AcquireWorkspaceLeaseOptions {
  readonly workspacePath: string;
  readonly command: Exclude<OwnerCommand, 'workspace-init'>;
}

interface AttachWorkspaceLeaseOptions extends ReadyWorkspaceRecords {
  readonly owner: OwnerRecord;
  readonly ownerBytes: Buffer;
  readonly verifySystemAuthority: () => void | Promise<void>;
}

type LeaseHandleState = 'open' | 'releasing' | 'released' | 'lost';

const LEASE_STAGING_PATTERN = /^lease\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;
const LEASE_HANDLE_CONSTRUCTOR_TOKEN: unique symbol = Symbol('workspace-lease-handle');

function lost(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError('lease-lost', message);
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  }
  return error;
}

async function assertStrictDirectory(
  path: string,
  label: string,
  requireNonEmpty = false,
): Promise<void> {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw new WorkspaceSafetyError('invalid', `${label} 不是普通目录`);
    }
    if (requireNonEmpty && (await readdir(path)).length === 0) {
      throw new WorkspaceSafetyError('invalid', `${label} 不能为空`);
    }
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    const wrapped = new WorkspaceSafetyError('invalid', `${label} 缺失或不可读取`);
    Object.defineProperty(wrapped, 'cause', { value: error, enumerable: false });
    throw wrapped;
  }
}

export async function readReadyWorkspaceRecords(
  workspacePath: string | WorkspaceDirectory,
): Promise<ReadyWorkspaceRecords> {
  const workspace =
    typeof workspacePath === 'string'
      ? await canonicalizeWorkspaceDirectory(workspacePath)
      : workspacePath;
  await assertWorkspaceDirectoryUnchanged(workspace);
  assertWindowsSafetyTreeHasNoReparsePoints(workspace.path);
  const protocolRoot = join(workspace.path, PROTOCOL_ROOT_DIR);
  await assertStrictDirectory(protocolRoot, '永久协议根');
  const rootEntries = await readdir(protocolRoot);
  for (const entry of rootEntries) {
    if (
      entry !== PROTOCOL_FILE &&
      entry !== INCIDENTS_DIR &&
      entry !== ACTIVE_LEASE_DIR &&
      !LEASE_STAGING_PATTERN.test(entry)
    ) {
      throw new WorkspaceSafetyError('invalid', `永久协议根包含未知条目：${entry}`);
    }
    if (entry === ACTIVE_LEASE_DIR || LEASE_STAGING_PATTERN.test(entry)) {
      await assertStrictDirectory(
        join(protocolRoot, entry),
        `lease 路径 ${entry}`,
        entry === ACTIVE_LEASE_DIR,
      );
    }
  }
  await assertStrictDirectory(join(protocolRoot, INCIDENTS_DIR), 'incidents');
  const markerBytes = await readExactFile(join(workspace.path, WORKSPACE_MARKER_FILE));
  const protocolBytes = await readExactFile(join(workspace.path, PROTOCOL_ROOT_DIR, PROTOCOL_FILE));
  const marker = parseJsonRecord(markerBytes, parseWorkspaceMarker);
  const protocol = parseJsonRecord(protocolBytes, parseProtocolRecord);
  validateCoreRecordBindings({
    marker,
    protocol,
    protocolBytes,
    canonicalWorkspaceIdentity: workspace.identity,
  });
  assertWindowsSafetyTreeHasNoReparsePoints(workspace.path);
  return { workspace, marker, markerBytes, protocol, protocolBytes };
}

export async function readActiveLeaseOwner(
  records: ReadyWorkspaceRecords,
): Promise<{ owner: OwnerRecord; ownerBytes: Buffer } | undefined> {
  const ownerPath = join(records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OWNER_FILE);
  if (!(await pathExists(join(records.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR)))) {
    return undefined;
  }
  const ownerBytes = await readExactFile(ownerPath);
  const owner = parseJsonRecord(ownerBytes, parseOwnerRecord);
  validateCoreRecordBindings({
    marker: records.marker,
    protocol: records.protocol,
    owner,
    protocolBytes: records.protocolBytes,
    canonicalWorkspaceIdentity: records.workspace.identity,
  });
  return { owner, ownerBytes };
}

async function assertReadyWorkspaceRecordsUnchanged(records: ReadyWorkspaceRecords): Promise<void> {
  await assertWorkspaceDirectoryUnchanged(records.workspace);
  await assertExactFile(join(records.workspace.path, WORKSPACE_MARKER_FILE), records.markerBytes);
  await assertExactFile(
    join(records.workspace.path, PROTOCOL_ROOT_DIR, PROTOCOL_FILE),
    records.protocolBytes,
  );
}

function createOwnerRecord(
  records: ReadyWorkspaceRecords,
  identity: ProcessIdentitySnapshot,
  ownerId: string,
  command: OwnerCommand,
  now: () => Date,
): { owner: OwnerRecord; ownerBytes: Buffer } {
  const owner: OwnerRecord = {
    schemaVersion: OWNER_SCHEMA_VERSION,
    ownerId,
    pid: identity.pid,
    processIdentity: identity.processIdentity,
    bootIdentity: identity.bootIdentity,
    hostId: identity.hostId,
    workspaceIdentity: records.workspace.identity,
    startedAt: now().toISOString(),
    command,
  };
  const ownerBytes = jsonBytes(owner);
  const parsed = parseJsonRecord(ownerBytes, parseOwnerRecord);
  validateCoreRecordBindings({
    marker: records.marker,
    protocol: records.protocol,
    owner: parsed,
    protocolBytes: records.protocolBytes,
    canonicalWorkspaceIdentity: records.workspace.identity,
  });
  return { owner: parsed, ownerBytes };
}

/** @internal Authority-controlled core. */
export async function acquireWorkspaceLeaseControlled(
  options: ControlledAcquireWorkspaceLeaseOptions,
): Promise<WorkspaceLeaseHandle> {
  await options.verifySystemAuthority?.();
  const records = await readReadyWorkspaceRecords(options.workspacePath);
  const ownerId = options.ownerId ?? randomUUID();
  const { owner, ownerBytes } = createOwnerRecord(
    records,
    options.identity,
    ownerId,
    options.command,
    options.now ?? (() => new Date()),
  );
  const protocolRoot = join(records.workspace.path, PROTOCOL_ROOT_DIR);
  const staging = await createStagingDirectory(protocolRoot, 'lease.prepare-', ownerId);
  await writeNewFile(join(staging, OWNER_FILE), ownerBytes);
  await assertExactFile(join(staging, OWNER_FILE), ownerBytes);
  await options.hooks?.beforeLeaseInstall?.(staging);
  await options.verifySystemAuthority?.();
  await assertReadyWorkspaceRecordsUnchanged(records);

  const activeLease = join(protocolRoot, ACTIVE_LEASE_DIR);
  try {
    await installDirectoryNoReplace(staging, activeLease);
  } catch (error) {
    if (error instanceof WorkspaceSafetyError && error.code === 'conflict') {
      await readActiveLeaseOwner(records);
    }
    throw error;
  }
  await options.hooks?.afterLeaseInstalled?.();
  await options.verifySystemAuthority?.();
  return await attachWorkspaceLeaseControlled({
    ...records,
    owner,
    ownerBytes,
    verifySystemAuthority: options.verifySystemAuthority ?? (() => undefined),
  });
}

export async function acquireWorkspaceLease(
  options: AcquireWorkspaceLeaseOptions,
): Promise<WorkspaceLeaseHandle> {
  const system = captureExactCurrentIdentityAuthority();
  return await acquireWorkspaceLeaseControlled({
    workspacePath: options.workspacePath,
    command: options.command,
    identity: system.identity,
    verifySystemAuthority: system.verifyCurrent,
  });
}

/** @internal Only bootstrap and the controlled acquisition core may attach a lease. */
export async function attachWorkspaceLeaseControlled(
  options: AttachWorkspaceLeaseOptions,
): Promise<WorkspaceLeaseHandle> {
  const handle = new WorkspaceLeaseHandle(LEASE_HANDLE_CONSTRUCTOR_TOKEN, options);
  await handle.verify();
  return handle;
}

export class WorkspaceLeaseHandle {
  readonly workspace: WorkspaceDirectory;
  readonly owner: OwnerRecord;

  #state: LeaseHandleState = 'open';
  #releasePromise: Promise<string> | undefined;
  readonly #ownerBytes: Buffer;
  readonly #markerBytes: Buffer;
  readonly #protocolBytes: Buffer;
  readonly #marker: WorkspaceMarker;
  readonly #protocol: ProtocolRecord;
  readonly #verifySystemAuthority: () => void | Promise<void>;

  constructor(token: typeof LEASE_HANDLE_CONSTRUCTOR_TOKEN, options: AttachWorkspaceLeaseOptions) {
    if (token !== LEASE_HANDLE_CONSTRUCTOR_TOKEN) {
      throw new WorkspaceSafetyError(
        'invalid',
        'workspace lease handle authority token is invalid',
      );
    }
    this.workspace = options.workspace;
    this.owner = options.owner;
    this.#ownerBytes = Buffer.from(options.ownerBytes);
    this.#markerBytes = Buffer.from(options.markerBytes);
    this.#protocolBytes = Buffer.from(options.protocolBytes);
    this.#marker = options.marker;
    this.#protocol = options.protocol;
    this.#verifySystemAuthority = options.verifySystemAuthority;
  }

  get state(): LeaseHandleState {
    return this.#state;
  }

  async #verifyDisk(allowReleasing: boolean): Promise<void> {
    if (this.#state === 'released' || (this.#state === 'releasing' && !allowReleasing)) {
      throw new WorkspaceSafetyError('closed', 'workspace lease 已释放或正在释放');
    }
    if (this.#state === 'lost') {
      throw lost('workspace lease 已失效');
    }

    try {
      await this.#verifySystemAuthority();
      await assertWorkspaceDirectoryUnchanged(this.workspace);
      assertWindowsSafetyTreeHasNoReparsePoints(this.workspace.path);
      const markerPath = join(this.workspace.path, WORKSPACE_MARKER_FILE);
      const protocolPath = join(this.workspace.path, PROTOCOL_ROOT_DIR, PROTOCOL_FILE);
      const ownerPath = join(this.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OWNER_FILE);
      const markerBytes = await readExactFile(markerPath);
      const protocolBytes = await readExactFile(protocolPath);
      const ownerBytes = await readExactFile(ownerPath);
      if (
        !markerBytes.equals(this.#markerBytes) ||
        !protocolBytes.equals(this.#protocolBytes) ||
        !ownerBytes.equals(this.#ownerBytes)
      ) {
        throw lost('workspace lease 的缓存绑定与磁盘字节不一致');
      }
      const marker = parseJsonRecord(markerBytes, parseWorkspaceMarker);
      const protocol = parseJsonRecord(protocolBytes, parseProtocolRecord);
      const owner = parseJsonRecord(ownerBytes, parseOwnerRecord);
      validateCoreRecordBindings({
        marker,
        protocol,
        owner,
        protocolBytes: this.#protocolBytes,
        canonicalWorkspaceIdentity: this.workspace.identity,
      });
      if (
        owner.ownerId !== this.owner.ownerId ||
        marker.initializedAt !== this.#marker.initializedAt ||
        protocol.createdAt !== this.#protocol.createdAt
      ) {
        throw lost('workspace lease 绑定已变化');
      }
      assertWindowsSafetyTreeHasNoReparsePoints(this.workspace.path);
    } catch (error) {
      if (error instanceof WorkspaceSafetyError && error.code === 'closed') throw error;
      this.#state = 'lost';
      throw lost('workspace lease owner 或协议记录已变化', error);
    }
  }

  verify(): Promise<void> {
    return this.#verifyDisk(false);
  }

  async #verifyMutationForRelease(activeLease: string): Promise<void> {
    if (!(await pathExists(join(activeLease, MUTATION_DIR)))) return;
    const mutation = await readCanonicalMutationDomain({
      workspace: this.workspace,
      expectedOwner: this.owner,
    });
    if (mutation.state.phase !== 'committed') {
      throw new WorkspaceSafetyError('isolated', 'mutation 尚未 committed，不能释放 lease');
    }
    await verifyMutationArchive(mutation);
    await verifyMutationFinalSnapshot(mutation);
  }

  async #verifyReleaseDomain(activeLease: string): Promise<void> {
    await this.#verifyDisk(true);
    if (await pathExists(join(activeLease, OPERATION_DIR))) {
      throw new WorkspaceSafetyError('isolated', '存在 active operation，不能释放 lease');
    }
    if (await pathExists(join(activeLease, RECOVERY_DIR))) {
      throw new WorkspaceSafetyError('isolated', '存在 active recovery，不能走普通 release');
    }
    if (await inspectQuarantinePresence(activeLease)) {
      throw new WorkspaceSafetyError('isolated', '存在 quarantine，不能释放 lease');
    }
    await this.#verifyMutationForRelease(activeLease);
  }

  release(): Promise<string> {
    if (this.#releasePromise !== undefined) return this.#releasePromise;
    if (this.#state === 'released' || this.#state === 'releasing') {
      return Promise.reject(new WorkspaceSafetyError('closed', 'workspace lease 已释放'));
    }
    if (this.#state === 'lost') {
      return Promise.reject(lost('workspace lease 已失效'));
    }

    this.#state = 'releasing';
    this.#releasePromise = this.#release().catch((error: unknown) => {
      this.#releasePromise = undefined;
      if (error instanceof WorkspaceSafetyError && error.code === 'lease-lost') {
        this.#state = 'lost';
      } else if (this.#state === 'releasing') {
        this.#state = 'open';
      }
      throw error;
    });
    return this.#releasePromise;
  }

  async #release(): Promise<string> {
    const activeLease = join(this.workspace.path, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
    return await withQuarantineContainerExclusive(activeLease, async () => {
      await this.#verifyReleaseDomain(activeLease);

      try {
        await assertStrictDirectory(activeLease, 'canonical lease', true);
      } catch (error) {
        this.#state = 'lost';
        throw lost('canonical lease 已丢失或不再是普通非空目录', error);
      }
      const incidentName = `released-${this.owner.ownerId}-${digestBytes(this.#ownerBytes).slice(7, 23)}`;
      const incident = join(this.workspace.path, PROTOCOL_ROOT_DIR, INCIDENTS_DIR, incidentName);
      const incidentsRoot = join(this.workspace.path, PROTOCOL_ROOT_DIR, INCIDENTS_DIR);
      try {
        await assertStrictDirectory(incidentsRoot, 'incidents');
      } catch (error) {
        this.#state = 'lost';
        throw lost('incidents 已丢失或不再是固定普通目录', error);
      }
      try {
        await moveDirectoryNoReplace(activeLease, incident, {
          beforeRename: async () => {
            // 最终移动前重新机械读取 owner、活动域与 committed mutation；调用方不能用布尔参数绕过。
            await this.#verifyReleaseDomain(activeLease);
          },
        });
      } catch (error) {
        if (
          error instanceof WorkspaceSafetyError &&
          (error.code === 'conflict' || error.code === 'isolated' || error.code === 'invalid')
        ) {
          throw error;
        }
        this.#state = 'lost';
        throw lost('lease 最终移动失败且 owner 状态不再可信', error);
      }

      // rename 是旧 owner 的最后一次 workspace 写；成功后禁止任何回读、清理或补记。
      this.#state = 'released';
      return incident;
    });
  }
}
