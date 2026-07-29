import { lstatSync, realpathSync, unlinkSync, type BigIntStats } from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';

export interface WorkspaceDirectoryIdentity {
  readonly absolutePath: string;
  readonly realPath: string;
  readonly device: string;
  readonly inode: string;
}

export class WorkspaceIdentityError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WorkspaceIdentityError';
  }
}

const registered = new Map<string, WorkspaceDirectoryIdentity>();

function inside(root: string, path: string): boolean {
  const value = relative(root, path);
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function directoryIdentity(path: string): BigIntStats {
  let stats: BigIntStats;
  try {
    stats = lstatSync(path, { bigint: true });
  } catch (error) {
    throw new WorkspaceIdentityError(
      `工作区目录不可核对：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    throw new WorkspaceIdentityError(`工作区必须是真实目录，不能是软链或其他文件：${path}`);
  }
  return stats;
}

function sameDirectory(stats: BigIntStats, identity: WorkspaceDirectoryIdentity): boolean {
  return stats.dev.toString() === identity.device && stats.ino.toString() === identity.inode;
}

/**
 * 冻结 workspace 最终目录本身。祖先路径可以包含系统提供的稳定软链；workspace
 * 这个最终路径必须是普通目录，且后续仍解析到同一个目录对象。
 */
export function freezeWorkspaceDirectory(workspace: string): WorkspaceDirectoryIdentity {
  const absolutePath = resolve(workspace);
  const previous = registered.get(absolutePath);
  if (previous) {
    assertWorkspaceDirectory(previous);
    return previous;
  }
  const stats = directoryIdentity(absolutePath);
  let realPath: string;
  try {
    realPath = realpathSync.native(absolutePath);
  } catch (error) {
    throw new WorkspaceIdentityError(
      `工作区真实路径不可核对：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const realStats = directoryIdentity(realPath);
  if (stats.dev !== realStats.dev || stats.ino !== realStats.ino) {
    throw new WorkspaceIdentityError('工作区路径与真实目录身份不一致');
  }
  const identity = Object.freeze({
    absolutePath,
    realPath,
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
  });
  registered.set(absolutePath, identity);
  return identity;
}

export function assertWorkspaceDirectory(identity: WorkspaceDirectoryIdentity): void {
  const stats = directoryIdentity(identity.absolutePath);
  if (!sameDirectory(stats, identity)) {
    throw new WorkspaceIdentityError('工作区目录已被移动或替换，拒绝继续读写');
  }
  let currentReal: string;
  try {
    currentReal = realpathSync.native(identity.absolutePath);
  } catch (error) {
    throw new WorkspaceIdentityError(
      `工作区真实路径不可复核：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (currentReal !== identity.realPath) {
    throw new WorkspaceIdentityError('工作区祖先路径或真实目标已变化，拒绝继续读写');
  }
  const realStats = directoryIdentity(identity.realPath);
  if (!sameDirectory(realStats, identity)) {
    throw new WorkspaceIdentityError('工作区真实目录已被替换，拒绝继续读写');
  }
}

/** 若路径位于已冻结 workspace 内，先核对并返回其身份；否则返回 null。 */
export function assertRegisteredWorkspacePath(path: string): WorkspaceDirectoryIdentity | null {
  const absolutePath = resolve(path);
  const identity = [...registered.values()]
    .filter((candidate) => inside(candidate.absolutePath, absolutePath))
    .sort((left, right) => right.absolutePath.length - left.absolutePath.length)[0];
  if (!identity) return null;
  assertWorkspaceDirectory(identity);
  return identity;
}

/** 删除单个 workspace 文件/软链；父 workspace 身份变化时不触碰新目标。 */
export function removeRegisteredWorkspaceFileSync(path: string, allowMissing = false): void {
  const identity = assertRegisteredWorkspacePath(path);
  try {
    unlinkSync(path);
  } catch (error) {
    if (allowMissing && (error as NodeJS.ErrnoException).code === 'ENOENT') {
      if (identity) assertWorkspaceDirectory(identity);
      return;
    }
    throw error;
  }
  if (identity) assertWorkspaceDirectory(identity);
}
