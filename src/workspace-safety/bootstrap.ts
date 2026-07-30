import { randomUUID } from 'node:crypto';
import { lstat, mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertExactFile,
  assertWorkspaceDirectoryUnchanged,
  canonicalizeWorkspaceDirectory,
  createStagingDirectory,
  digestBytes,
  installDirectoryNoReplace,
  installFileNoReplace,
  jsonBytes,
  pathExists,
  readExactFile,
  writeNewFile,
  type WorkspaceDirectory,
} from './filesystem.js';
import { captureExactCurrentIdentityAuthority } from './identity.js';
import {
  attachWorkspaceLeaseControlled,
  readActiveLeaseOwner,
  readReadyWorkspaceRecords,
} from './lease.js';
import {
  parseJsonRecord,
  parseOwnerRecord,
  parseProtocolRecord,
  parseWorkspaceMarker,
  validateCoreRecordBindings,
} from './schema.js';
import {
  ACTIVE_LEASE_DIR,
  INCIDENTS_DIR,
  OWNER_FILE,
  OWNER_SCHEMA_VERSION,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  PROTOCOL_SCHEMA_VERSION,
  WORKSPACE_MARKER_FILE,
  WORKSPACE_MARKER_SCHEMA_VERSION,
  WORKSPACE_PROTOCOL,
  WORKSPACE_SAFETY_VERSION,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
  type ProtocolRecord,
  type WorkspaceMarker,
  WorkspaceSafetyError,
} from './types.js';
import {
  assertWindowsSafetyTreeHasNoReparsePoints,
  assertWindowsWorkspaceTreeHasNoReparsePoints,
} from './windows-path-attributes.js';

export interface BootstrapHooks {
  readonly beforeProtocolRootInstall?: (stagingPath: string) => void | Promise<void>;
  readonly afterProtocolRootInstalled?: () => void | Promise<void>;
  readonly beforeMarkerSourceUnlink?: () => void | Promise<void>;
  readonly afterMarkerInstalled?: () => void | Promise<void>;
  readonly beforeRelease?: () => void | Promise<void>;
}

export interface ControlledBootstrapWorkspaceOptions {
  readonly workspacePath: string;
  readonly identity: ProcessIdentitySnapshot;
  readonly ownerId?: string;
  readonly now?: () => Date;
  readonly hooks?: BootstrapHooks;
  readonly verifySystemAuthority?: () => void | Promise<void>;
}

/** Formal bootstrap input. Authority, identifiers, clocks, and barriers are never caller data. */
export interface BootstrapWorkspaceOptions {
  readonly workspacePath: string;
}

export interface BootstrapWorkspaceResult {
  readonly created: boolean;
  readonly workspacePath: string;
  readonly workspaceIdentity: string;
  readonly protocolDigest: string;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

async function isStrictInertBootstrapStaging(
  workspacePath: string,
  entry: string,
): Promise<boolean> {
  if (!/^engine\.lock\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u.test(entry)) {
    return false;
  }
  try {
    const info = await lstat(join(workspacePath, entry));
    return info.isDirectory() && !info.isSymbolicLink();
  } catch {
    return false;
  }
}

async function assertBootstrapEligible(
  workspacePath: string,
  options: { readonly allowProtocolRoot?: boolean; readonly code?: 'legacy' | 'invalid' } = {},
): Promise<void> {
  const entries = await readdir(workspacePath);
  for (const entry of entries) {
    if (options.allowProtocolRoot === true && entry === PROTOCOL_ROOT_DIR) continue;
    if (!(await isStrictInertBootstrapStaging(workspacePath, entry))) {
      throw new WorkspaceSafetyError(
        options.code ?? 'legacy',
        '非空 workspace 没有新版安全标记，不能自动初始化或迁移',
      );
    }
  }
}

async function inspectExistingWorkspace(
  workspace: WorkspaceDirectory,
): Promise<BootstrapWorkspaceResult | undefined> {
  const workspacePath = workspace.path;
  const markerPath = join(workspacePath, WORKSPACE_MARKER_FILE);
  const protocolRoot = join(workspacePath, PROTOCOL_ROOT_DIR);
  const markerExists = await pathExists(markerPath);
  const protocolRootExists = await pathExists(protocolRoot);

  if (markerExists && protocolRootExists) {
    const records = await readReadyWorkspaceRecords(workspacePath);
    if ((await readActiveLeaseOwner(records)) !== undefined) {
      throw new WorkspaceSafetyError('conflict', 'workspace 已有 active lease，初始化不能接管');
    }
    return {
      created: false,
      workspacePath: records.workspace.path,
      workspaceIdentity: records.workspace.identity,
      protocolDigest: digestBytes(records.protocolBytes),
    };
  }

  if (markerExists) {
    throw new WorkspaceSafetyError('invalid', 'workspace marker 存在但永久协议根缺失');
  }
  if (protocolRootExists) {
    const info = await lstat(protocolRoot);
    if (!info.isDirectory() || info.isSymbolicLink()) {
      throw new WorkspaceSafetyError('legacy', '检测到旧版或非法 engine.lock');
    }
    const protocolBytes = await readExactFile(join(protocolRoot, PROTOCOL_FILE));
    const protocol = parseJsonRecord(protocolBytes, parseProtocolRecord);
    const ownerBytes = await readExactFile(join(protocolRoot, ACTIVE_LEASE_DIR, OWNER_FILE));
    const owner = parseJsonRecord(ownerBytes, parseOwnerRecord);
    const incidentsInfo = await lstat(join(protocolRoot, INCIDENTS_DIR));
    if (
      incidentsInfo.isSymbolicLink() ||
      !incidentsInfo.isDirectory() ||
      protocol.workspaceIdentity !== workspace.identity ||
      owner.workspaceIdentity !== workspace.identity ||
      owner.command !== 'workspace-init'
    ) {
      throw new WorkspaceSafetyError('invalid', '未完成的 bootstrap 协议绑定无效');
    }
    throw new WorkspaceSafetyError(
      'conflict',
      'workspace bootstrap 已开始但尚未完成，必须走显式恢复',
    );
  }
  return undefined;
}

async function assertInitialBootstrapEligibility(workspace: WorkspaceDirectory): Promise<void> {
  try {
    await assertBootstrapEligible(workspace.path);
  } catch (error) {
    const concurrent = await inspectExistingWorkspace(workspace);
    if (concurrent !== undefined) {
      throw new WorkspaceSafetyError(
        'conflict',
        'workspace 已由并发 bootstrap 完成，当前初始化不能继续',
      );
    }
    throw error;
  }
}

/** @internal Authority-controlled core. */
export async function bootstrapWorkspaceControlled(
  options: ControlledBootstrapWorkspaceOptions,
): Promise<BootstrapWorkspaceResult> {
  await options.verifySystemAuthority?.();
  const workspace = await canonicalizeWorkspaceDirectory(options.workspacePath, { create: true });
  assertWindowsWorkspaceTreeHasNoReparsePoints(workspace.path);
  const existing = await inspectExistingWorkspace(workspace);
  if (existing !== undefined) return existing;
  await assertInitialBootstrapEligibility(workspace);
  await assertWorkspaceDirectoryUnchanged(workspace);

  const ownerId = options.ownerId ?? randomUUID();
  const timestamp = (options.now ?? (() => new Date()))().toISOString();
  const protocol: ProtocolRecord = {
    schemaVersion: PROTOCOL_SCHEMA_VERSION,
    protocol: WORKSPACE_PROTOCOL,
    workspaceIdentity: workspace.identity,
    createdBy: WORKSPACE_SAFETY_VERSION,
    createdAt: timestamp,
  };
  const protocolBytes = jsonBytes(protocol);
  const parsedProtocol = parseJsonRecord(protocolBytes, parseProtocolRecord);
  const owner: OwnerRecord = {
    schemaVersion: OWNER_SCHEMA_VERSION,
    ownerId,
    pid: options.identity.pid,
    processIdentity: options.identity.processIdentity,
    bootIdentity: options.identity.bootIdentity,
    hostId: options.identity.hostId,
    workspaceIdentity: workspace.identity,
    startedAt: timestamp,
    command: 'workspace-init',
  };
  const ownerBytes = jsonBytes(owner);
  const parsedOwner = parseJsonRecord(ownerBytes, parseOwnerRecord);

  await options.verifySystemAuthority?.();
  const staging = await createStagingDirectory(workspace.path, 'engine.lock.prepare-', ownerId);
  await writeNewFile(join(staging, PROTOCOL_FILE), protocolBytes);
  await mkdir(join(staging, INCIDENTS_DIR), { mode: 0o700 });
  const stagedLease = join(staging, ACTIVE_LEASE_DIR);
  await mkdir(stagedLease, { mode: 0o700 });
  await writeNewFile(join(stagedLease, OWNER_FILE), ownerBytes);
  await assertExactFile(join(staging, PROTOCOL_FILE), protocolBytes);
  await assertExactFile(join(stagedLease, OWNER_FILE), ownerBytes);
  await options.hooks?.beforeProtocolRootInstall?.(staging);

  await options.verifySystemAuthority?.();
  const protocolRoot = join(workspace.path, PROTOCOL_ROOT_DIR);
  if (!(await pathExists(protocolRoot))) {
    await assertInitialBootstrapEligibility(workspace);
  }
  assertWindowsWorkspaceTreeHasNoReparsePoints(workspace.path);
  await installDirectoryNoReplace(staging, protocolRoot);
  await options.hooks?.afterProtocolRootInstalled?.();
  await assertBootstrapEligible(workspace.path, { allowProtocolRoot: true, code: 'invalid' });
  await assertWorkspaceDirectoryUnchanged(workspace);
  await assertExactFile(join(protocolRoot, PROTOCOL_FILE), protocolBytes);
  await assertExactFile(join(protocolRoot, ACTIVE_LEASE_DIR, OWNER_FILE), ownerBytes);

  const marker: WorkspaceMarker = {
    schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
    initializedBy: WORKSPACE_SAFETY_VERSION,
    workspaceIdentity: workspace.identity,
    protocolDigest: digestBytes(protocolBytes),
    initializedAt: timestamp,
  };
  const markerBytes = jsonBytes(marker);
  const parsedMarker = parseJsonRecord(markerBytes, parseWorkspaceMarker);
  validateCoreRecordBindings({
    marker: parsedMarker,
    protocol: parsedProtocol,
    owner: parsedOwner,
    protocolBytes,
    canonicalWorkspaceIdentity: workspace.identity,
  });

  const bootstrapInput = join(protocolRoot, ACTIVE_LEASE_DIR, 'bootstrap-input');
  await options.verifySystemAuthority?.();
  try {
    await mkdir(bootstrapInput, { mode: 0o700 });
  } catch (error) {
    if (errorCode(error) !== 'EEXIST') throw error;
    throw new WorkspaceSafetyError('invalid', 'bootstrap marker staging 已异常存在');
  }
  const stagedMarker = join(bootstrapInput, WORKSPACE_MARKER_FILE);
  await writeNewFile(stagedMarker, markerBytes);
  await assertExactFile(stagedMarker, markerBytes);
  await options.verifySystemAuthority?.();
  assertWindowsSafetyTreeHasNoReparsePoints(workspace.path);
  await installFileNoReplace(stagedMarker, join(workspace.path, WORKSPACE_MARKER_FILE), {
    beforeSourceUnlink: options.hooks?.beforeMarkerSourceUnlink,
  });
  await assertExactFile(join(workspace.path, WORKSPACE_MARKER_FILE), markerBytes);
  await options.hooks?.afterMarkerInstalled?.();

  const records = await readReadyWorkspaceRecords(workspace);
  const lease = await attachWorkspaceLeaseControlled({
    ...records,
    owner: parsedOwner,
    ownerBytes,
    verifySystemAuthority: options.verifySystemAuthority ?? (() => undefined),
  });
  await options.hooks?.beforeRelease?.();
  await lease.release();
  assertWindowsWorkspaceTreeHasNoReparsePoints(workspace.path);

  return {
    created: true,
    workspacePath: workspace.path,
    workspaceIdentity: workspace.identity,
    protocolDigest: digestBytes(protocolBytes),
  };
}

export async function bootstrapWorkspace(
  options: BootstrapWorkspaceOptions,
): Promise<BootstrapWorkspaceResult> {
  const system = captureExactCurrentIdentityAuthority();
  return await bootstrapWorkspaceControlled({
    workspacePath: options.workspacePath,
    identity: system.identity,
    verifySystemAuthority: system.verifyCurrent,
  });
}
