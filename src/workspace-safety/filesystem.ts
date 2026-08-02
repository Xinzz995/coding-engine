import { createHash, randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  constants,
  link,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  stat,
  unlink,
} from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, parse, relative, resolve, sep } from 'node:path';
import { PROTOCOL_ROOT_DIR, WorkspaceSafetyError } from './types.js';
import {
  assertNoWindowsReparsePoints,
  assertWindowsRequestedPathAncestryBeforeCreate,
  assertWindowsSafetyTreeHasNoReparsePoints,
  assertWindowsWorkspacePathAncestry,
  assertWindowsWorkspaceTreeHasNoReparsePoints,
} from './windows-path-attributes.js';

export interface WorkspaceDirectory {
  readonly requestedPath: string;
  readonly path: string;
  readonly identity: string;
  readonly device: bigint;
  readonly inode: bigint;
  readonly requestedDevice: bigint;
  readonly requestedInode: bigint;
  readonly requestedKind: 'directory' | 'symlink';
}

export interface CanonicalizeWorkspaceOptions {
  readonly create?: boolean;
}

export interface WorkspaceDirectoryIdentitySource {
  readonly dev: bigint;
  readonly ino: bigint;
}

export interface StableOrdinaryDirectoryIdentity {
  readonly dev: number;
  readonly ino: number;
}

export interface StableReadHooks {
  readonly afterOpen?: () => void | Promise<void>;
  readonly afterRead?: () => void | Promise<void>;
}

export interface InstallFileNoReplaceHooks {
  readonly beforeLink?: () => void | Promise<void>;
  readonly afterLink?: () => void | Promise<void>;
  /** Test seam: deterministically changes a path between preflight and handle acquisition. */
  readonly beforeLinkedOpen?: () => void | Promise<void>;
  readonly afterLinkedRead?: () => void | Promise<void>;
  readonly beforeSourceUnlink?: () => void | Promise<void>;
}

export interface RecoverLinkedFileInstallOptions {
  readonly source: string;
  readonly target: string;
  readonly expectedBytes: Uint8Array;
  /** Revalidates the caller's exact recovery writer authority; called before inspection and commit. */
  readonly authorize: () => void | Promise<void>;
  readonly beforeSourceUnlink?: () => void | Promise<void>;
}

export type InspectLinkedFileInstallOptions = Pick<
  RecoverLinkedFileInstallOptions,
  'source' | 'target' | 'expectedBytes'
>;

export interface ReadLinkedFileInstallOptions {
  readonly source: string;
  readonly target: string;
  readonly maxBytes: number;
}

function safetyError(
  code: WorkspaceSafetyError['code'],
  message: string,
  cause?: unknown,
): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError(code, message);
  if (cause !== undefined) {
    Object.defineProperty(error, 'cause', { value: cause, enumerable: false });
  }
  return error;
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function digestBytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

/**
 * Bind a workspace record to the directory object, not to an unstable Windows path spelling.
 *
 * Windows may expose one directory as either an 8.3 path or its long path depending on which
 * Node filesystem API resolved it. Both spellings name the same volume/file ID, so including the
 * spelling would make a valid persistent record unreadable by another API in the same process.
 * POSIX retains the canonical path component because its realpath spelling is stable.
 */
export function workspaceDirectoryIdentity(
  canonicalPath: string,
  source: WorkspaceDirectoryIdentitySource,
  platform: NodeJS.Platform = process.platform,
): string {
  const stablePath = platform === 'win32' ? 'windows-file-id' : canonicalPath;
  return digestBytes(
    Buffer.from(`${stablePath}\0${source.dev.toString()}\0${source.ino.toString()}`, 'utf8'),
  );
}

export function sameWorkspaceDirectoryEntry(
  left: WorkspaceDirectoryIdentitySource,
  right: WorkspaceDirectoryIdentitySource,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/**
 * Resolve both inputs independently and require that they remain stable before comparing their
 * directory identities. Callers must use their already-authorized session path after this check;
 * the user-supplied alias is never promoted into a second write authority.
 */
export async function workspacePathsReferToSameDirectory(
  leftPath: string,
  rightPath: string,
): Promise<boolean> {
  const left = await canonicalizeWorkspaceDirectory(leftPath);
  const right = await canonicalizeWorkspaceDirectory(rightPath);
  await assertWorkspaceDirectoryUnchanged(left);
  await assertWorkspaceDirectoryUnchanged(right);
  return sameWorkspaceDirectoryEntry(
    { dev: left.device, ino: left.inode },
    { dev: right.device, ino: right.inode },
  );
}

export function jsonBytes(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return false;
    throw error;
  }
}

export async function readStableOrdinaryDirectoryIdentity(
  target: string,
  label: string,
  before?: StableOrdinaryDirectoryIdentity,
): Promise<StableOrdinaryDirectoryIdentity> {
  let current;
  try {
    current = await lstat(target);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') {
      throw safetyError('lease-lost', `${label} 在确认期间消失`, error);
    }
    throw error;
  }
  if (current.isSymbolicLink() || !current.isDirectory()) {
    throw safetyError(before ? 'lease-lost' : 'invalid', `${label} 不是稳定的普通目录`);
  }
  assertNoWindowsReparsePoints([target]);
  if (before && (current.dev !== before.dev || current.ino !== before.ino)) {
    throw safetyError('lease-lost', `${label} 在确认期间发生变化`);
  }
  return { dev: current.dev, ino: current.ino };
}

export async function canonicalizeWorkspaceDirectory(
  workspacePath: string,
  options: CanonicalizeWorkspaceOptions = {},
): Promise<WorkspaceDirectory> {
  if (workspacePath.length === 0 || workspacePath.includes('\0')) {
    throw safetyError('invalid', 'workspace 路径无效');
  }

  const requestedPath = resolve(workspacePath);
  let requestedInfo: BigIntStats;
  try {
    requestedInfo = await lstat(requestedPath, { bigint: true });
    if (!requestedInfo.isSymbolicLink() && !requestedInfo.isDirectory()) {
      throw safetyError('invalid', 'workspace 必须是目录或指向目录的符号链接');
    }
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    if (errorCode(error) !== 'ENOENT' || options.create !== true) {
      throw safetyError('invalid', 'workspace 目录不存在或不可读取', error);
    }
    assertWindowsRequestedPathAncestryBeforeCreate(requestedPath);
    await mkdir(requestedPath, { recursive: true, mode: 0o700 });
    const created = await lstat(requestedPath, { bigint: true });
    if (created.isSymbolicLink() || !created.isDirectory()) {
      throw safetyError('invalid', 'workspace 创建后不是普通目录');
    }
    requestedInfo = created;
  }

  const canonicalPath = await realpath(requestedPath);
  assertWindowsWorkspacePathAncestry(requestedPath, canonicalPath);
  const first = await stat(canonicalPath, { bigint: true });
  if (!first.isDirectory()) {
    throw safetyError('invalid', 'workspace canonical path 不是目录');
  }
  const secondPath = await realpath(requestedPath);
  const second = await stat(secondPath, { bigint: true });
  const secondRequested = await lstat(requestedPath, { bigint: true });
  assertWindowsWorkspacePathAncestry(requestedPath, secondPath);
  if (
    secondPath !== canonicalPath ||
    second.dev !== first.dev ||
    second.ino !== first.ino ||
    secondRequested.dev !== requestedInfo.dev ||
    secondRequested.ino !== requestedInfo.ino ||
    secondRequested.isSymbolicLink() !== requestedInfo.isSymbolicLink() ||
    secondRequested.isDirectory() !== requestedInfo.isDirectory()
  ) {
    throw safetyError('invalid', 'workspace 路径身份在解析期间发生变化');
  }

  return {
    requestedPath,
    path: canonicalPath,
    identity: workspaceDirectoryIdentity(canonicalPath, first),
    device: first.dev,
    inode: first.ino,
    requestedDevice: requestedInfo.dev,
    requestedInode: requestedInfo.ino,
    requestedKind: requestedInfo.isSymbolicLink() ? 'symlink' : 'directory',
  };
}

export async function assertWorkspaceDirectoryUnchanged(
  workspace: WorkspaceDirectory,
): Promise<void> {
  try {
    const requested = await lstat(workspace.requestedPath, { bigint: true });
    const currentPath = await realpath(workspace.requestedPath);
    assertWindowsWorkspacePathAncestry(workspace.requestedPath, currentPath);
    const current = await stat(currentPath, { bigint: true });
    if (
      currentPath !== workspace.path ||
      !current.isDirectory() ||
      current.dev !== workspace.device ||
      current.ino !== workspace.inode ||
      requested.dev !== workspace.requestedDevice ||
      requested.ino !== workspace.requestedInode ||
      (workspace.requestedKind === 'symlink') !== requested.isSymbolicLink() ||
      (workspace.requestedKind === 'directory') !== requested.isDirectory()
    ) {
      throw safetyError('lease-lost', 'workspace 目录身份已变化');
    }
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw safetyError('lease-lost', 'workspace 目录已丢失或不可读取', error);
  }
}

function validateStagingPart(value: string, label: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(value)) {
    throw safetyError('invalid', `${label} 不是安全的 staging 名称`);
  }
}

export async function createStagingDirectory(
  parent: string,
  prefix: string,
  id: string = randomUUID(),
): Promise<string> {
  validateStagingPart(prefix.replace(/-$/, ''), 'staging prefix');
  validateStagingPart(id, 'staging id');
  const path = join(parent, `${prefix}${id}`);
  try {
    await mkdir(path, { mode: 0o700 });
    return path;
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw safetyError('conflict', `staging 已存在：${path}`, error);
    }
    throw error;
  }
}

export async function writeNewFile(path: string, bytes: Uint8Array): Promise<void> {
  let handle;
  try {
    handle = await open(path, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY, 0o600);
    await handle.writeFile(bytes);
  } catch (error) {
    if (errorCode(error) === 'EEXIST') {
      throw safetyError('conflict', `文件已存在：${path}`, error);
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function sameFileIdentity(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameFileIdentity(left, right) &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

interface ExactFileRead {
  readonly bytes: Buffer;
  readonly snapshot: BigIntStats;
}

async function readExactFileSnapshot(
  path: string,
  hooks: StableReadHooks = {},
): Promise<ExactFileRead> {
  let handle;
  try {
    // This is only a bounded type preflight. Identity is deliberately not bound here because
    // Linux filesystems may immediately reuse an inode after unlink; the opened handle below is
    // the authoritative identity anchor.
    const preflight = await lstat(path, { bigint: true });
    if (preflight.isSymbolicLink() || !preflight.isFile() || preflight.nlink !== 1n) {
      throw safetyError('invalid', `不是普通文件：${path}`);
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const nonBlock = process.platform === 'win32' ? 0 : constants.O_NONBLOCK;
    handle = await open(path, constants.O_RDONLY | noFollow | nonBlock);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n) {
      throw safetyError('invalid', `不是普通文件：${path}`);
    }
    // Hold the opened inode before observing the path. A pre-open lstat can be defeated on
    // filesystems that immediately reuse the unlinked inode number; keeping this handle open
    // prevents that reuse and gives the read a real linearization point.
    await hooks.afterOpen?.();
    const openedPath = await lstat(path, { bigint: true });
    if (
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      openedPath.nlink !== 1n ||
      !sameFileSnapshot(opened, openedPath)
    ) {
      throw safetyError('invalid', `文件身份在打开期间发生变化：${path}`);
    }
    const bytes = await handle.readFile();
    await hooks.afterRead?.();
    const afterHandle = await handle.stat({ bigint: true });
    const afterPath = await lstat(path, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterHandle.nlink !== 1n ||
      afterPath.nlink !== 1n ||
      !sameFileSnapshot(opened, afterHandle) ||
      !sameFileSnapshot(afterHandle, afterPath) ||
      BigInt(bytes.length) !== afterHandle.size
    ) {
      throw safetyError('invalid', `文件在读取期间发生变化：${path}`);
    }
    return { bytes, snapshot: afterHandle };
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw safetyError('invalid', `文件缺失或不可读取：${path}`, error);
  } finally {
    await handle?.close();
  }
}

export async function readExactFile(path: string, hooks: StableReadHooks = {}): Promise<Buffer> {
  return (await readExactFileSnapshot(path, hooks)).bytes;
}

export async function assertExactFile(path: string, expected: Uint8Array): Promise<void> {
  const actual = await readExactFile(path);
  if (!actual.equals(Buffer.from(expected))) {
    throw safetyError('invalid', `文件字节不匹配：${path}`);
  }
}

async function assertNonEmptyDirectory(path: string): Promise<void> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw safetyError('invalid', `不是普通目录：${path}`);
  }
  if ((await readdir(path)).length === 0) {
    throw safetyError('invalid', `canonical staging 不能为空：${path}`);
  }
}

function isRenameConflict(error: unknown): boolean {
  return ['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(errorCode(error) ?? '');
}

const WINDOWS_TRANSIENT_RENAME_RETRY_DELAYS_MS = [25, 50, 100] as const;

export interface DirectoryMoveHooks {
  readonly beforeRename?: () => void | Promise<void>;
  /** 最后一个同步裁决点；返回后立即提交 rename，中间不再让出事件循环。 */
  readonly commitCheck?: () => void;
  /** Test seam: production always uses the actual host platform. */
  readonly platform?: NodeJS.Platform;
  /** Test seam: production always uses node:fs/promises rename. */
  readonly renameDirectory?: (source: string, target: string) => void | Promise<void>;
  /** Test seam: production waits for the exact bounded retry delay. */
  readonly waitBeforeRetry?: (delayMs: number) => void | Promise<void>;
}

function workspaceRootForProtocolMove(
  source: string,
  target: string,
):
  | {
      readonly root: string;
      readonly includeBusinessTree: boolean;
    }
  | undefined {
  for (const path of [source, target]) {
    let current = resolve(path);
    while (true) {
      if (basename(current) === PROTOCOL_ROOT_DIR) {
        return { root: dirname(current), includeBusinessTree: false };
      }
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  const sourceName = basename(source);
  if (/^engine\.lock\.prepare-/u.test(sourceName) && basename(target) === PROTOCOL_ROOT_DIR) {
    return { root: dirname(resolve(target)), includeBusinessTree: true };
  }
  return undefined;
}

export async function moveDirectoryNoReplace(
  source: string,
  target: string,
  hooks: DirectoryMoveHooks = {},
): Promise<void> {
  await assertNonEmptyDirectory(source);
  if (await pathExists(target)) {
    throw safetyError('conflict', `目标目录已存在：${target}`);
  }
  await hooks.beforeRename?.();
  const protocolMove = workspaceRootForProtocolMove(source, target);
  const platform = hooks.platform ?? process.platform;
  const renameDirectory = hooks.renameDirectory ?? rename;
  const waitBeforeRetry =
    hooks.waitBeforeRetry ??
    ((delayMs: number) => new Promise<void>((resolveDelay) => setTimeout(resolveDelay, delayMs)));
  let retryIndex = 0;
  while (true) {
    await assertNonEmptyDirectory(source);
    if (await pathExists(target)) {
      throw safetyError('conflict', `目标目录已存在：${target}`);
    }
    if (protocolMove) {
      if (protocolMove.includeBusinessTree) {
        assertWindowsWorkspaceTreeHasNoReparsePoints(protocolMove.root);
      } else {
        assertWindowsSafetyTreeHasNoReparsePoints(protocolMove.root);
      }
    }
    hooks.commitCheck?.();
    try {
      // 协议内的 canonical 目标只能由完整非空 staging 产生；POSIX/Windows rename 都不会替换
      // 这样的目录。并发出现空目标需要另一个同账号进程绕过本协议，超出 ADR-021 信任边界。
      await renameDirectory(source, target);
      return;
    } catch (error) {
      const code = errorCode(error);
      const targetExists = await pathExists(target);
      const retryDelay = WINDOWS_TRANSIENT_RENAME_RETRY_DELAYS_MS[retryIndex];
      if (
        targetExists ||
        code === 'EEXIST' ||
        code === 'ENOTEMPTY' ||
        platform !== 'win32' ||
        !['EPERM', 'EACCES'].includes(code ?? '') ||
        retryDelay === undefined
      ) {
        if (isRenameConflict(error) || targetExists) {
          throw safetyError('conflict', `目标目录已存在或竞争失败：${target}`, error);
        }
        throw error;
      }
      retryIndex += 1;
      await waitBeforeRetry(retryDelay);
    }
  }
}

export async function installDirectoryNoReplace(source: string, target: string): Promise<void> {
  await moveDirectoryNoReplace(source, target);
  await assertNonEmptyDirectory(target);
}

async function readControlledLinkedPair(
  source: string,
  target: string,
  expectedBytes: Buffer | undefined,
  maxBytes: number,
  hooks: InstallFileNoReplaceHooks,
): Promise<ExactFileRead> {
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 1) {
    throw safetyError('invalid', '受控文件安装读取上限无效');
  }
  let sourceHandle;
  let targetHandle;
  try {
    const [sourceBefore, targetBefore] = await Promise.all([
      lstat(source, { bigint: true }),
      lstat(target, { bigint: true }),
    ]);
    if (
      sourceBefore.isSymbolicLink() ||
      targetBefore.isSymbolicLink() ||
      !sourceBefore.isFile() ||
      !targetBefore.isFile() ||
      sourceBefore.nlink !== 2n ||
      targetBefore.nlink !== 2n ||
      sourceBefore.size > BigInt(maxBytes) ||
      targetBefore.size > BigInt(maxBytes) ||
      !sameFileIdentity(sourceBefore, targetBefore)
    ) {
      throw safetyError('invalid', '文件原子安装窗口的路径身份无效');
    }

    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    const nonBlock = process.platform === 'win32' ? 0 : constants.O_NONBLOCK;
    await hooks.beforeLinkedOpen?.();
    sourceHandle = await open(source, constants.O_RDONLY | noFollow | nonBlock);
    targetHandle = await open(target, constants.O_RDONLY | noFollow | nonBlock);
    const [sourceOpened, targetOpened] = await Promise.all([
      sourceHandle.stat({ bigint: true }),
      targetHandle.stat({ bigint: true }),
    ]);
    if (
      sourceOpened.nlink !== 2n ||
      targetOpened.nlink !== 2n ||
      !sourceOpened.isFile() ||
      !targetOpened.isFile() ||
      !sameFileIdentity(sourceBefore, sourceOpened) ||
      !sameFileIdentity(targetBefore, targetOpened) ||
      !sameFileIdentity(sourceOpened, targetOpened)
    ) {
      throw safetyError('invalid', '文件原子安装窗口的打开身份无效');
    }

    const [sourceBytes, targetBytes] = await Promise.all([
      sourceHandle.readFile(),
      targetHandle.readFile(),
    ]);
    await hooks.afterLinkedRead?.();
    const [sourceAfterHandle, targetAfterHandle, sourceAfterPath, targetAfterPath] =
      await Promise.all([
        sourceHandle.stat({ bigint: true }),
        targetHandle.stat({ bigint: true }),
        lstat(source, { bigint: true }),
        lstat(target, { bigint: true }),
      ]);
    if (
      sourceAfterPath.isSymbolicLink() ||
      targetAfterPath.isSymbolicLink() ||
      !sameFileSnapshot(sourceOpened, sourceAfterHandle) ||
      !sameFileSnapshot(targetOpened, targetAfterHandle) ||
      !sameFileSnapshot(sourceAfterHandle, sourceAfterPath) ||
      !sameFileSnapshot(targetAfterHandle, targetAfterPath) ||
      !sameFileIdentity(sourceAfterPath, targetAfterPath) ||
      BigInt(sourceBytes.length) !== sourceAfterHandle.size ||
      BigInt(targetBytes.length) !== targetAfterHandle.size ||
      !sourceBytes.equals(targetBytes) ||
      (expectedBytes !== undefined && !sourceBytes.equals(expectedBytes))
    ) {
      throw safetyError('invalid', '文件原子安装窗口发生变化或字节不匹配');
    }
    return { bytes: sourceBytes, snapshot: targetAfterHandle };
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw safetyError('invalid', '文件原子安装窗口无效', error);
  } finally {
    await Promise.allSettled([sourceHandle?.close(), targetHandle?.close()]);
  }
}

async function readLinkedInstallPair(
  source: string,
  target: string,
  expected: ExactFileRead,
  hooks: InstallFileNoReplaceHooks,
): Promise<BigIntStats> {
  const linked = await readControlledLinkedPair(
    source,
    target,
    expected.bytes,
    Math.max(1, expected.bytes.byteLength),
    hooks,
  );
  if (!sameFileIdentity(expected.snapshot, linked.snapshot)) {
    throw safetyError('invalid', '文件原子安装窗口不再绑定原始 staging 文件');
  }
  return linked.snapshot;
}

/**
 * Completes the one recoverable crash window of the no-replace file installer. Strict readers
 * continue to reject hard links; callers must name both controlled paths and prove their current
 * recovery-writer authority before this helper removes the staging link.
 */
export async function recoverLinkedFileInstall(
  options: RecoverLinkedFileInstallOptions,
): Promise<void> {
  const expected = Buffer.from(options.expectedBytes);
  await options.authorize();
  const maxBytes = Math.max(1, expected.byteLength);
  const first = await readControlledLinkedPair(
    options.source,
    options.target,
    expected,
    maxBytes,
    {},
  );
  await options.beforeSourceUnlink?.();
  await options.authorize();
  const commit = await readControlledLinkedPair(
    options.source,
    options.target,
    expected,
    maxBytes,
    {},
  );
  if (!sameFileSnapshot(first.snapshot, commit.snapshot)) {
    throw safetyError('invalid', '受控文件安装窗口的身份在恢复期间发生变化');
  }
  try {
    await unlink(options.source);
  } catch (error) {
    throw safetyError('invalid', `无法收口受控文件安装窗口：${options.source}`, error);
  }
  const installed = await readExactFileSnapshot(options.target);
  if (!sameFileIdentity(commit.snapshot, installed.snapshot) || !installed.bytes.equals(expected)) {
    throw safetyError('invalid', `恢复后的安装文件身份或字节不匹配：${options.target}`);
  }
}

export async function inspectLinkedFileInstall(
  options: InspectLinkedFileInstallOptions,
): Promise<void> {
  await readControlledLinkedPair(
    options.source,
    options.target,
    Buffer.from(options.expectedBytes),
    Math.max(1, options.expectedBytes.byteLength),
    {},
  );
}

export async function readLinkedFileInstall(
  options: ReadLinkedFileInstallOptions,
): Promise<Buffer> {
  const linked = await readControlledLinkedPair(
    options.source,
    options.target,
    undefined,
    options.maxBytes,
    {},
  );
  return Buffer.from(linked.bytes);
}

export async function installFileNoReplace(
  source: string,
  target: string,
  hooks: InstallFileNoReplaceHooks = {},
): Promise<void> {
  const sourceRead = await readExactFileSnapshot(source);
  await hooks.beforeLink?.();
  try {
    await link(source, target);
  } catch (error) {
    if (errorCode(error) === 'EEXIST' || (await pathExists(target))) {
      throw safetyError('conflict', `目标文件已存在：${target}`, error);
    }
    throw error;
  }

  await hooks.afterLink?.();
  const linkedTarget = await readLinkedInstallPair(source, target, sourceRead, hooks);
  await hooks.beforeSourceUnlink?.();
  try {
    const [sourceBeforeUnlink, targetBeforeUnlink] = await Promise.all([
      lstat(source, { bigint: true }),
      lstat(target, { bigint: true }),
    ]);
    if (
      sourceBeforeUnlink.isSymbolicLink() ||
      targetBeforeUnlink.isSymbolicLink() ||
      !sourceBeforeUnlink.isFile() ||
      !targetBeforeUnlink.isFile() ||
      sourceBeforeUnlink.nlink !== 2n ||
      targetBeforeUnlink.nlink !== 2n ||
      !sameFileIdentity(linkedTarget, sourceBeforeUnlink) ||
      !sameFileIdentity(linkedTarget, targetBeforeUnlink)
    ) {
      throw safetyError('invalid', '文件原子安装窗口在收口前发生变化');
    }
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw safetyError('invalid', '文件原子安装窗口在收口前无效', error);
  }
  try {
    await unlink(source);
  } catch (error) {
    throw safetyError('invalid', `无法收口文件原子安装窗口：${source}`, error);
  }
  const installed = await readExactFileSnapshot(target);
  if (
    !sameFileIdentity(linkedTarget, installed.snapshot) ||
    !installed.bytes.equals(sourceRead.bytes)
  ) {
    throw safetyError('invalid', `最终安装文件身份或字节不匹配：${target}`);
  }
}

export function resolveWorkspaceRelativePath(root: string, relativePath: string): string {
  if (
    relativePath.length === 0 ||
    relativePath.includes('\0') ||
    isAbsolute(relativePath) ||
    parse(relativePath).root.length > 0
  ) {
    throw safetyError('invalid', 'workspace 写入路径必须是非空相对路径');
  }
  const parts = relativePath.split(/[\\/]/u);
  const windowsDevice = /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/iu;
  if (
    parts.some(
      (part) =>
        part.length === 0 ||
        part === '.' ||
        part === '..' ||
        /[<>:"|?*\u0000-\u001f]/u.test(part) ||
        /[. ]$/u.test(part) ||
        windowsDevice.test(part),
    )
  ) {
    throw safetyError('invalid', 'workspace 写入路径包含非法分段');
  }
  const target = join(root, ...parts);
  const fromRoot = relative(root, target);
  if (fromRoot.startsWith(`..${sep}`) || fromRoot === '..' || isAbsolute(fromRoot)) {
    throw safetyError('invalid', 'workspace 写入路径逃逸');
  }
  return target;
}

export async function ensureSafeParentDirectory(root: string, target: string): Promise<void> {
  const fromRoot = relative(root, target);
  const parts = fromRoot.split(sep).slice(0, -1);
  let current = root;
  const parents = [root];
  for (const part of parts) parents.push(join(parents.at(-1)!, part));
  assertNoWindowsReparsePoints([...parents, target], { allowMissing: true });
  for (const part of parts) {
    current = join(current, part);
    try {
      const info = await lstat(current);
      if (info.isSymbolicLink() || !info.isDirectory()) {
        throw safetyError('invalid', `workspace 写入父路径不是普通目录：${current}`);
      }
    } catch (error) {
      if (error instanceof WorkspaceSafetyError) throw error;
      if (errorCode(error) !== 'ENOENT') throw error;
      try {
        await mkdir(current, { mode: 0o700 });
      } catch (mkdirError) {
        if (errorCode(mkdirError) !== 'EEXIST') throw mkdirError;
      }
      const created = await lstat(current);
      if (created.isSymbolicLink() || !created.isDirectory()) {
        throw safetyError('invalid', `workspace 写入父路径存在竞争：${current}`);
      }
    }
  }
  assertNoWindowsReparsePoints(parents);
}

export async function assertWritableFileTarget(target: string): Promise<void> {
  if (!(await pathExists(target))) return;
  const current = await lstat(target);
  if (current.isSymbolicLink() || !current.isFile()) {
    throw safetyError('invalid', `workspace 写入目标不是普通文件：${target}`);
  }
}

export async function replaceFileFromStaging(source: string, target: string): Promise<void> {
  await readExactFile(source);
  await assertWritableFileTarget(target);
  await rename(source, target);
}
