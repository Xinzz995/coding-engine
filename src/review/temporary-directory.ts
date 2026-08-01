import { randomUUID } from 'node:crypto';
import type { BigIntStats } from 'node:fs';
import {
  chmodSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  mkdtempSync,
  openSync,
  opendirSync,
  readSync,
  realpathSync,
  renameSync,
  rmSync,
  rmdirSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import {
  assertWindowsSafetyTreeHasNoReparsePoints,
  assertWindowsWorkspacePathAncestry,
} from '../workspace-safety/windows-path-attributes.js';

const MAX_EXACT_TREE_ENTRIES = 64;
const MAX_SAFE_TREE_ENTRIES = 4096;
const MAX_SAFE_TREE_DEPTH = 32;
const MAX_SAFE_FILE_BYTES = 4 * 1024 * 1024;
const MAX_SAFE_TREE_BYTES = 16 * 1024 * 1024;

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
}

interface FileSnapshot extends DirectoryIdentity {
  readonly nlink: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

interface ExactFileRecord {
  readonly relativePath: string;
  readonly path: string;
  readonly maximumBytes: number;
  readonly expectedBytes: Buffer;
  readonly snapshot: FileSnapshot;
  descriptor: number | undefined;
}

interface ExactDirectoryRecord {
  readonly relativePath: string;
  readonly path: string;
  readonly identity: DirectoryIdentity;
  descriptor: number | undefined;
}

type ReviewTemporaryTreeMode = 'unsealed' | 'exact' | 'safe' | 'failed';
type ReviewTemporaryLifecycle =
  'available' | 'prepared' | 'running' | 'settled' | 'unsafe' | 'closed';

export interface ReviewTemporaryFileSpec {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly maximumBytes: number;
}

export interface ReviewTemporaryExactTree {
  readonly files: readonly ReviewTemporaryFileSpec[];
  readonly directories?: readonly string[];
}

export type ReviewTemporaryCleanupResult =
  | { readonly status: 'removed' }
  | { readonly status: 'retained'; readonly path: string; readonly reason: string };

export class ReviewTemporaryDirectoryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ReviewTemporaryDirectoryError';
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { readonly code?: unknown }).code)
    : undefined;
}

function safeFilesystemFailure(error: unknown, operation: string): ReviewTemporaryDirectoryError {
  if (error instanceof ReviewTemporaryDirectoryError) return error;
  const code = errorCode(error);
  return new ReviewTemporaryDirectoryError(
    code === undefined ? `${operation}失败` : `${operation}失败（${code}）`,
  );
}

function sameIdentity(left: DirectoryIdentity, right: DirectoryIdentity): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function fileSnapshot(info: BigIntStats): FileSnapshot {
  return {
    dev: info.dev,
    ino: info.ino,
    nlink: info.nlink,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function sameFileSnapshot(left: FileSnapshot, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function pathWithin(parent: string, candidate: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!value.startsWith('..') && !isAbsolute(value));
}

function safeRelativePath(value: string): string {
  if (
    value.length === 0 ||
    value.length > 512 ||
    value.includes('\0') ||
    isAbsolute(value) ||
    value.split(/[\\/]/u).some((part) => part === '' || part === '.' || part === '..')
  ) {
    throw new ReviewTemporaryDirectoryError('Reviewer 临时域相对路径无效');
  }
  return value.split(/[\\/]/u).join(sep);
}

function directoryIdentity(path: string, label: string): DirectoryIdentity {
  const info = lstatSync(path, { bigint: true });
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw new ReviewTemporaryDirectoryError(`${label} 不是普通目录：${path}`);
  }
  return { dev: info.dev, ino: info.ino };
}

function optionalDirectoryDescriptor(path: string): number | undefined {
  if (process.platform === 'win32') return undefined;
  const directory = typeof constants.O_DIRECTORY === 'number' ? constants.O_DIRECTORY : 0;
  const noFollow = typeof constants.O_NOFOLLOW === 'number' ? constants.O_NOFOLLOW : 0;
  const nonBlock = typeof constants.O_NONBLOCK === 'number' ? constants.O_NONBLOCK : 0;
  return openSync(path, constants.O_RDONLY | directory | noFollow | nonBlock);
}

function openFileNoFollow(path: string): number {
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  const nonBlock = process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0);
  return openSync(path, constants.O_RDONLY | noFollow | nonBlock);
}

function boundedDescriptorBytes(descriptor: number, maximumBytes: number): Buffer {
  const opened = fstatSync(descriptor, { bigint: true });
  if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(maximumBytes)) {
    throw new ReviewTemporaryDirectoryError('Reviewer 临时域文件类型或大小超出边界');
  }
  const length = Number(opened.size);
  const bytes = Buffer.alloc(length);
  let offset = 0;
  while (offset < length) {
    const count = readSync(descriptor, bytes, offset, length - offset, offset);
    if (count === 0) break;
    offset += count;
  }
  const trailing = Buffer.allocUnsafe(1);
  const hasTrailingByte = readSync(descriptor, trailing, 0, 1, offset) !== 0;
  if (offset !== length || hasTrailingByte) {
    throw new ReviewTemporaryDirectoryError('Reviewer 临时域文件读取长度发生变化');
  }
  return bytes;
}

function listTree(root: string, maximumEntries: number, maximumDepth: number): string[] {
  const paths: string[] = [];
  const visit = (relativeRoot: string, depth: number): void => {
    if (depth > maximumDepth) {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域目录深度超过安全上限');
    }
    const absoluteRoot = relativeRoot === '' ? root : join(root, relativeRoot);
    const directory = opendirSync(absoluteRoot);
    try {
      for (;;) {
        const entry = directory.readSync();
        if (entry === null) break;
        const relativePath = relativeRoot === '' ? entry.name : join(relativeRoot, entry.name);
        paths.push(relativePath);
        if (paths.length > maximumEntries) {
          throw new ReviewTemporaryDirectoryError('Reviewer 临时域目录项超过安全上限');
        }
        const info = lstatSync(join(root, relativePath), { bigint: true });
        if (info.isSymbolicLink()) {
          throw new ReviewTemporaryDirectoryError('Reviewer 临时域包含链接');
        }
        if (info.isDirectory()) visit(relativePath, depth + 1);
      }
    } finally {
      directory.closeSync();
    }
  };
  try {
    visit('', 0);
    return paths.sort();
  } catch (error) {
    throw safeFilesystemFailure(error, 'Reviewer 临时域目录树读取');
  }
}

function closeDescriptor(descriptor: number | undefined): string | null {
  if (descriptor === undefined) return null;
  try {
    closeSync(descriptor);
    return null;
  } catch (error) {
    return errorMessage(error);
  }
}

export class ReviewTemporaryDirectory {
  readonly root: string;
  readonly parent: string;
  readonly prefix: string;

  readonly #rootIdentity: DirectoryIdentity;
  readonly #parentIdentity: DirectoryIdentity;
  readonly #cleanupHooks: {
    readonly beforeRename?: () => void;
    readonly beforeMakeRemovable?: (path: string) => void;
    readonly beforeRemove?: (path: string) => void;
  };
  #rootDescriptor: number | undefined;
  #parentDescriptor: number | undefined;
  #files: ExactFileRecord[] = [];
  #directories: ExactDirectoryRecord[] = [];
  #treeMode: ReviewTemporaryTreeMode = 'unsealed';
  #lifecycle: ReviewTemporaryLifecycle = 'available';
  #cleanupResult: ReviewTemporaryCleanupResult | undefined;

  private constructor(options: {
    root: string;
    parent: string;
    prefix: string;
    rootIdentity: DirectoryIdentity;
    parentIdentity: DirectoryIdentity;
    rootDescriptor: number | undefined;
    parentDescriptor: number | undefined;
    cleanupHooks?: {
      readonly beforeRename?: () => void;
      readonly beforeMakeRemovable?: (path: string) => void;
      readonly beforeRemove?: (path: string) => void;
    };
  }) {
    this.root = options.root;
    this.parent = options.parent;
    this.prefix = options.prefix;
    this.#rootIdentity = options.rootIdentity;
    this.#parentIdentity = options.parentIdentity;
    this.#rootDescriptor = options.rootDescriptor;
    this.#parentDescriptor = options.parentDescriptor;
    this.#cleanupHooks = options.cleanupHooks ?? {};
  }

  static create(options: {
    readonly prefix: string;
    readonly projectRoot: string;
    /** @internal Deterministic test seam; production always uses os.tmpdir(). */
    readonly temporaryParent?: string;
    /** @internal Failure-injection seam invoked after creation identity is frozen. */
    readonly afterCreate?: (path: string) => void;
    /** @internal Deterministic cleanup failure seams; production leaves this undefined. */
    readonly cleanupHooks?: {
      readonly beforeRename?: () => void;
      readonly beforeMakeRemovable?: (path: string) => void;
      readonly beforeRemove?: (path: string) => void;
    };
  }): ReviewTemporaryDirectory {
    if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}-$/.test(options.prefix)) {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域前缀无效');
    }
    const projectRoot = realpathSync.native(resolve(options.projectRoot));
    const requestedParent = resolve(options.temporaryParent ?? tmpdir());
    const parent = realpathSync.native(requestedParent);
    const parentIdentity = directoryIdentity(parent, 'Reviewer 临时域父目录');
    if (pathWithin(projectRoot, parent)) {
      throw new ReviewTemporaryDirectoryError(
        '系统临时目录位于项目目录内；拒绝创建 Reviewer 临时域',
      );
    }
    assertWindowsWorkspacePathAncestry(requestedParent, parent);

    let createdPath: string | undefined;
    let createdIdentity: DirectoryIdentity | undefined;
    let root: string | undefined;
    let rootDescriptor: number | undefined;
    let parentDescriptor: number | undefined;
    try {
      parentDescriptor = optionalDirectoryDescriptor(parent);
      createdPath = mkdtempSync(join(parent, options.prefix));
      createdIdentity = directoryIdentity(createdPath, 'Reviewer 临时域');
      options.afterCreate?.(createdPath);
      root = realpathSync.native(createdPath);
      if (dirname(root) !== parent || !basename(root).startsWith(options.prefix)) {
        throw new ReviewTemporaryDirectoryError('Reviewer 临时域不是系统临时父目录的直接子目录');
      }
      const rootIdentity = directoryIdentity(root, 'Reviewer 临时域');
      if (!sameIdentity(createdIdentity, rootIdentity)) {
        throw new ReviewTemporaryDirectoryError('Reviewer 临时域创建身份发生变化');
      }
      assertWindowsWorkspacePathAncestry(root, root);
      assertWindowsSafetyTreeHasNoReparsePoints(root);
      rootDescriptor = optionalDirectoryDescriptor(root);
      return new ReviewTemporaryDirectory({
        root,
        parent,
        prefix: options.prefix,
        rootIdentity,
        parentIdentity,
        rootDescriptor,
        parentDescriptor,
        cleanupHooks: options.cleanupHooks,
      });
    } catch (error) {
      closeDescriptor(rootDescriptor);
      closeDescriptor(parentDescriptor);
      let retainedReason: string | undefined;
      if (createdPath !== undefined && createdIdentity !== undefined) {
        try {
          const currentParent = directoryIdentity(parent, 'Reviewer 临时域父目录');
          const info = lstatSync(createdPath, { bigint: true });
          if (!sameIdentity(parentIdentity, currentParent)) {
            retainedReason = '父目录身份发生变化';
          } else if (
            info.isSymbolicLink() ||
            !info.isDirectory() ||
            !sameIdentity(createdIdentity, info) ||
            dirname(createdPath) !== parent
          ) {
            retainedReason = '创建路径不再指向已冻结对象';
          } else {
            try {
              rmdirSync(createdPath);
            } catch (rollbackError) {
              retainedReason = `只允许删除空创建目录的回滚失败：${errorMessage(rollbackError)}`;
            }
          }
        } catch (rollbackError) {
          retainedReason = `无法核对创建身份：${errorMessage(rollbackError)}`;
        }
      }
      if (retainedReason !== undefined && createdPath !== undefined) {
        throw new ReviewTemporaryDirectoryError(
          `${errorMessage(error)}；Reviewer 临时域初始化现场已保留 ${createdPath}：${retainedReason}`,
        );
      }
      throw error;
    }
  }

  sealExactTree(spec: ReviewTemporaryExactTree): void {
    this.#assertOpenAndUnsealed();
    try {
      const directories = [...(spec.directories ?? [])].map(safeRelativePath);
      const files = spec.files.map((file) => ({ ...file, path: safeRelativePath(file.path) }));
      const all = [...directories, ...files.map((file) => file.path)];
      if (new Set(all).size !== all.length || all.length > MAX_EXACT_TREE_ENTRIES) {
        throw new ReviewTemporaryDirectoryError('Reviewer 临时域固定目录树存在重复或过多条目');
      }
      for (const file of files) {
        if (!Number.isSafeInteger(file.maximumBytes) || file.maximumBytes < 1) {
          throw new ReviewTemporaryDirectoryError(`Reviewer 临时域文件上限无效：${file.path}`);
        }
        if (file.bytes.byteLength > file.maximumBytes) {
          throw new ReviewTemporaryDirectoryError(`Reviewer 临时域文件超过上限：${file.path}`);
        }
      }
      this.#assertRootIdentity();
      assertWindowsSafetyTreeHasNoReparsePoints(this.root);
      const actual = listTree(this.root, MAX_EXACT_TREE_ENTRIES, MAX_SAFE_TREE_DEPTH);
      if (JSON.stringify(actual.sort()) !== JSON.stringify(all.sort())) {
        throw new ReviewTemporaryDirectoryError('Reviewer 临时域固定目录树不匹配');
      }

      for (const relativePath of directories) {
        const path = join(this.root, relativePath);
        const identity = directoryIdentity(path, 'Reviewer 临时域固定子目录');
        const descriptor = optionalDirectoryDescriptor(path);
        this.#directories.push({
          relativePath,
          path,
          identity,
          descriptor,
        });
      }
      for (const file of files) {
        const path = join(this.root, file.path);
        const before = lstatSync(path, { bigint: true });
        if (
          before.isSymbolicLink() ||
          !before.isFile() ||
          before.nlink !== 1n ||
          before.size > BigInt(file.maximumBytes)
        ) {
          throw new ReviewTemporaryDirectoryError(`Reviewer 临时域固定文件无效：${file.path}`);
        }
        let descriptor: number | undefined;
        try {
          descriptor = openFileNoFollow(path);
          const opened = fstatSync(descriptor, { bigint: true });
          const bytes = boundedDescriptorBytes(descriptor, file.maximumBytes);
          const after = lstatSync(path, { bigint: true });
          if (
            !sameFileSnapshot(fileSnapshot(before), opened) ||
            !sameFileSnapshot(fileSnapshot(opened), after) ||
            !bytes.equals(Buffer.from(file.bytes))
          ) {
            throw new ReviewTemporaryDirectoryError(
              `Reviewer 临时域固定文件字节或身份不匹配：${file.path}`,
            );
          }
          this.#files.push({
            relativePath: file.path,
            path,
            maximumBytes: file.maximumBytes,
            expectedBytes: Buffer.from(file.bytes),
            snapshot: fileSnapshot(opened),
            descriptor,
          });
          descriptor = undefined;
        } finally {
          closeDescriptor(descriptor);
        }
      }
      assertWindowsSafetyTreeHasNoReparsePoints(this.root);
      this.#treeMode = 'exact';
    } catch (error) {
      this.#closeContentDescriptors();
      this.#files = [];
      this.#directories = [];
      this.#treeMode = 'failed';
      throw error;
    }
  }

  sealSafeTree(): void {
    this.#assertOpenAndUnsealed();
    try {
      this.#assertRootIdentity();
      assertWindowsSafetyTreeHasNoReparsePoints(this.root);
      this.#assertSafeTree(this.root);
      this.#treeMode = 'safe';
    } catch (error) {
      this.#treeMode = 'failed';
      throw error;
    }
  }

  assertUnchanged(): void {
    this.#assertOpenAndSealed();
    try {
      this.#assertRootIdentity();
      if (this.#treeMode === 'exact') this.#assertExactTree(true, this.root);
      else this.#assertSafeTree(this.root);
    } catch (error) {
      if (this.#lifecycle === 'running' || this.#lifecycle === 'settled') {
        this.#lifecycle = 'unsafe';
      }
      throw safeFilesystemFailure(error, 'Reviewer 临时域身份核对');
    }
  }

  prepareManagedUse(): void {
    this.assertUnchanged();
    if (this.#lifecycle === 'running') {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域仍有未结算的受管进程');
    }
    this.#lifecycle = 'prepared';
  }

  beginManagedUse(): void {
    this.#assertOpenAndSealed();
    if (this.#lifecycle !== 'prepared') {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域未完成运行前身份核对');
    }
    this.#lifecycle = 'running';
  }

  confirmManagedUseSettled(): void {
    if (this.#lifecycle !== 'running') {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域没有待结算的受管调用');
    }
    this.assertUnchanged();
    this.#lifecycle = 'settled';
  }

  cleanup(): ReviewTemporaryCleanupResult {
    if (this.#cleanupResult !== undefined) return this.#cleanupResult;
    if (this.#lifecycle === 'running' || this.#lifecycle === 'unsafe') {
      return this.retain(
        this.#lifecycle === 'unsafe'
          ? '受管进程暴露后的身份核对曾失败'
          : '受管进程集合未证明已经结算',
      );
    }
    try {
      this.assertUnchangedForCleanup();
    } catch (error) {
      const closeError = this.#closeAllDescriptors();
      return this.#finish({
        status: 'retained',
        path: this.root,
        reason:
          closeError === null
            ? safeFilesystemFailure(error, 'Reviewer 临时域收口核对').message
            : `${safeFilesystemFailure(error, 'Reviewer 临时域收口核对').message}；` +
              `关闭身份句柄失败：${closeError}`,
      });
    }

    const closeError = this.#closeAllDescriptors();
    if (closeError !== null) {
      return this.#finish({
        status: 'retained',
        path: this.root,
        reason: `关闭身份句柄失败：${closeError}`,
      });
    }
    try {
      this.#assertRootIdentity(false);
      if (this.#treeMode === 'exact') this.#assertExactTree(false, this.root);
      else this.#assertSafeTree(this.root);
    } catch (error) {
      return this.#finish({
        status: 'retained',
        path: this.root,
        reason: safeFilesystemFailure(error, 'Reviewer 临时域关闭后核对').message,
      });
    }

    const tombstone = join(this.parent, `.coding-x-review-cleanup-${randomUUID()}`);
    try {
      try {
        lstatSync(tombstone);
        return this.#finish({
          status: 'retained',
          path: this.root,
          reason: '唯一清理目标已存在',
        });
      } catch (error) {
        if (errorCode(error) !== 'ENOENT') throw error;
      }
      this.#cleanupHooks.beforeRename?.();
      renameSync(this.root, tombstone);
      this.#assertParentIdentity(false);
      const moved = lstatSync(tombstone, { bigint: true });
      if (
        moved.isSymbolicLink() ||
        !moved.isDirectory() ||
        !sameIdentity(this.#rootIdentity, moved)
      ) {
        return this.#finish({
          status: 'retained',
          path: tombstone,
          reason: '清理提交后的目录身份不匹配',
        });
      }
      if (realpathSync.native(tombstone) !== tombstone) {
        return this.#finish({
          status: 'retained',
          path: tombstone,
          reason: '清理提交后的目录解析发生变化',
        });
      }
      assertWindowsWorkspacePathAncestry(tombstone, tombstone);
      if (this.#treeMode === 'exact') this.#assertExactTree(false, tombstone);
      else this.#assertSafeTree(tombstone);
      this.#cleanupHooks.beforeMakeRemovable?.(tombstone);
      this.#makeVerifiedTreeRemovable(tombstone);
      this.#cleanupHooks.beforeRemove?.(tombstone);
      rmSync(tombstone, { recursive: true, force: false, maxRetries: 2, retryDelay: 10 });
      return this.#finish({ status: 'removed' });
    } catch (error) {
      const retainedPath = (() => {
        try {
          lstatSync(tombstone);
          return tombstone;
        } catch {
          return this.root;
        }
      })();
      return this.#finish({
        status: 'retained',
        path: retainedPath,
        reason: safeFilesystemFailure(error, 'Reviewer 临时域墓碑清理').message,
      });
    }
  }

  retain(reason: string): Extract<ReviewTemporaryCleanupResult, { readonly status: 'retained' }> {
    if (this.#cleanupResult !== undefined) {
      if (this.#cleanupResult.status === 'retained') return this.#cleanupResult;
      return {
        status: 'retained',
        path: this.root,
        reason: 'Reviewer 临时域已安全删除，无法再保留',
      };
    }
    const closeError = this.#closeAllDescriptors();
    return this.#finish({
      status: 'retained',
      path: this.root,
      reason: closeError === null ? reason : `${reason}；关闭身份句柄失败：${closeError}`,
    }) as Extract<ReviewTemporaryCleanupResult, { readonly status: 'retained' }>;
  }

  private assertUnchangedForCleanup(): void {
    if (this.#treeMode === 'unsealed' || this.#treeMode === 'failed') {
      this.#assertRootIdentity();
      this.#assertSafeTree(this.root);
      return;
    }
    this.#assertRootIdentity();
    if (this.#treeMode === 'exact') this.#assertExactTree(true, this.root);
    else this.#assertSafeTree(this.root);
  }

  #assertOpenAndUnsealed(): void {
    if (this.#lifecycle === 'closed') {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域已经收口');
    }
    if (this.#treeMode !== 'unsealed') {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域目录树已经冻结');
    }
  }

  #assertOpenAndSealed(): void {
    if (this.#lifecycle === 'closed') {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域已经收口');
    }
    if (this.#lifecycle === 'unsafe') {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域已经锁定保留');
    }
    if (this.#treeMode === 'unsealed' || this.#treeMode === 'failed') {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域目录树尚未冻结');
    }
  }

  #finish(result: ReviewTemporaryCleanupResult): ReviewTemporaryCleanupResult {
    this.#lifecycle = 'closed';
    this.#cleanupResult = result;
    return result;
  }

  #assertParentIdentity(checkDescriptor = true): void {
    const current = directoryIdentity(this.parent, 'Reviewer 临时域父目录');
    if (!sameIdentity(this.#parentIdentity, current)) {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域父目录身份发生变化');
    }
    if (checkDescriptor && this.#parentDescriptor !== undefined) {
      const opened = fstatSync(this.#parentDescriptor, { bigint: true });
      if (!opened.isDirectory() || !sameIdentity(this.#parentIdentity, opened)) {
        throw new ReviewTemporaryDirectoryError('Reviewer 临时域父目录句柄身份发生变化');
      }
    }
  }

  #assertRootIdentity(checkDescriptor = true): void {
    this.#assertParentIdentity(checkDescriptor);
    const current = directoryIdentity(this.root, 'Reviewer 临时域');
    if (!sameIdentity(this.#rootIdentity, current)) {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域根目录身份发生变化');
    }
    if (dirname(this.root) !== this.parent || realpathSync.native(this.root) !== this.root) {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域根目录不再是冻结父目录的直接对象');
    }
    if (checkDescriptor && this.#rootDescriptor !== undefined) {
      const opened = fstatSync(this.#rootDescriptor, { bigint: true });
      if (!opened.isDirectory() || !sameIdentity(this.#rootIdentity, opened)) {
        throw new ReviewTemporaryDirectoryError('Reviewer 临时域根目录句柄身份发生变化');
      }
    }
    assertWindowsWorkspacePathAncestry(this.root, this.root);
  }

  #assertExactTree(useDescriptors: boolean, root: string): void {
    assertWindowsSafetyTreeHasNoReparsePoints(root);
    const expected = [
      ...this.#directories.map((entry) => entry.relativePath),
      ...this.#files.map((entry) => entry.relativePath),
    ].sort();
    const actual = listTree(root, MAX_EXACT_TREE_ENTRIES, MAX_SAFE_TREE_DEPTH).sort();
    if (JSON.stringify(actual) !== JSON.stringify(expected)) {
      throw new ReviewTemporaryDirectoryError('Reviewer 临时域固定目录树发生变化');
    }
    for (const entry of this.#directories) {
      const path = join(root, entry.relativePath);
      const info = lstatSync(path, { bigint: true });
      if (info.isSymbolicLink() || !info.isDirectory() || !sameIdentity(entry.identity, info)) {
        throw new ReviewTemporaryDirectoryError(
          `Reviewer 临时域固定子目录发生变化：${entry.relativePath}`,
        );
      }
      if (useDescriptors && entry.descriptor !== undefined) {
        const opened = fstatSync(entry.descriptor, { bigint: true });
        if (!opened.isDirectory() || !sameIdentity(entry.identity, opened)) {
          throw new ReviewTemporaryDirectoryError(
            `Reviewer 临时域固定子目录句柄发生变化：${entry.relativePath}`,
          );
        }
      }
    }
    for (const entry of this.#files) {
      const path = join(root, entry.relativePath);
      const info = lstatSync(path, { bigint: true });
      if (
        info.isSymbolicLink() ||
        !info.isFile() ||
        info.nlink !== 1n ||
        !sameFileSnapshot(entry.snapshot, info)
      ) {
        throw new ReviewTemporaryDirectoryError(
          `Reviewer 临时域固定文件发生变化：${entry.relativePath}`,
        );
      }
      if (useDescriptors) {
        if (entry.descriptor === undefined) {
          throw new ReviewTemporaryDirectoryError(
            `Reviewer 临时域固定文件句柄已关闭：${entry.relativePath}`,
          );
        }
        const opened = fstatSync(entry.descriptor, { bigint: true });
        const bytes = boundedDescriptorBytes(entry.descriptor, entry.maximumBytes);
        const after = fstatSync(entry.descriptor, { bigint: true });
        if (
          !sameFileSnapshot(entry.snapshot, opened) ||
          !sameFileSnapshot(entry.snapshot, after) ||
          !bytes.equals(entry.expectedBytes)
        ) {
          throw new ReviewTemporaryDirectoryError(
            `Reviewer 临时域固定文件字节发生变化：${entry.relativePath}`,
          );
        }
      }
    }
    assertWindowsSafetyTreeHasNoReparsePoints(root);
  }

  #assertSafeTree(root: string): void {
    assertWindowsSafetyTreeHasNoReparsePoints(root);
    const paths = listTree(root, MAX_SAFE_TREE_ENTRIES, MAX_SAFE_TREE_DEPTH);
    let totalBytes = 0n;
    for (const relativePath of paths) {
      let info: BigIntStats;
      try {
        info = lstatSync(join(root, relativePath), { bigint: true });
      } catch (error) {
        throw safeFilesystemFailure(error, 'Reviewer 临时安全域条目核对');
      }
      if (info.isDirectory()) continue;
      if (!info.isFile() || info.nlink !== 1n || info.size > BigInt(MAX_SAFE_FILE_BYTES)) {
        throw new ReviewTemporaryDirectoryError('Reviewer 临时安全域包含非法条目');
      }
      totalBytes += info.size;
      if (totalBytes > BigInt(MAX_SAFE_TREE_BYTES)) {
        throw new ReviewTemporaryDirectoryError('Reviewer 临时安全域总字节超过安全上限');
      }
    }
    assertWindowsSafetyTreeHasNoReparsePoints(root);
  }

  #makeVerifiedTreeRemovable(root: string): void {
    const entries = listTree(root, MAX_SAFE_TREE_ENTRIES, MAX_SAFE_TREE_DEPTH).map(
      (relativePath) => ({ relativePath, info: lstatSync(join(root, relativePath)) }),
    );
    chmodSync(root, 0o700);
    for (const entry of entries
      .filter((candidate) => candidate.info.isDirectory())
      .sort((left, right) => left.relativePath.length - right.relativePath.length)) {
      chmodSync(join(root, entry.relativePath), 0o700);
    }
    for (const entry of entries.filter((candidate) => candidate.info.isFile())) {
      chmodSync(join(root, entry.relativePath), 0o600);
    }
  }

  #closeContentDescriptors(): string | null {
    const errors: string[] = [];
    for (const file of this.#files) {
      const error = closeDescriptor(file.descriptor);
      file.descriptor = undefined;
      if (error !== null) errors.push(error);
    }
    for (const directory of this.#directories) {
      const error = closeDescriptor(directory.descriptor);
      directory.descriptor = undefined;
      if (error !== null) errors.push(error);
    }
    return errors.length === 0 ? null : errors.join('；');
  }

  #closeAllDescriptors(): string | null {
    const errors: string[] = [];
    const contentError = this.#closeContentDescriptors();
    if (contentError !== null) errors.push(contentError);
    const rootError = closeDescriptor(this.#rootDescriptor);
    this.#rootDescriptor = undefined;
    if (rootError !== null) errors.push(rootError);
    const parentError = closeDescriptor(this.#parentDescriptor);
    this.#parentDescriptor = undefined;
    if (parentError !== null) errors.push(parentError);
    return errors.length === 0 ? null : errors.join('；');
  }
}
