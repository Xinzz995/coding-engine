import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  writeSync,
} from 'node:fs';
import type { BigIntStats } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import {
  assertRegisteredWorkspacePath,
  assertWorkspaceDirectory,
  type WorkspaceDirectoryIdentity,
} from './workspace-identity.js';

export type SafeControlFileErrorCode =
  'missing' | 'unsafe-type' | 'too-large' | 'changed' | 'invalid-encoding' | 'io-error';

/** 可由不可信进程触碰的 workspace 控制文件读取失败。 */
export class SafeControlFileError extends Error {
  readonly code: SafeControlFileErrorCode;
  readonly path: string;

  constructor(code: SafeControlFileErrorCode, path: string, detail: string) {
    super(`安全读取 ${path} 失败：${detail}`);
    this.name = 'SafeControlFileError';
    this.code = code;
    this.path = path;
  }
}

export interface SafeControlFileReadOptions {
  /** 必须显式限定最大字节数，防止控制文件成为内存放大入口。 */
  maxBytes: number;
  /** 只有真正的 ENOENT 才返回 null；软链、FIFO、目录等仍然报错。 */
  allowMissing?: boolean;
}

function errnoCode(error: unknown): string | undefined {
  return (error as NodeJS.ErrnoException | undefined)?.code;
}

function sameObject(left: BigIntStats, right: BigIntStats): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function unchanged(left: BigIntStats, right: BigIntStats): boolean {
  return (
    sameObject(left, right) &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function validateOptions(path: string, options: SafeControlFileReadOptions): void {
  if (!Number.isSafeInteger(options.maxBytes) || options.maxBytes < 0) {
    throw new SafeControlFileError('io-error', path, 'maxBytes 必须是非负安全整数');
  }
}

function safeOpenFlags(path: string): number {
  if (process.platform === 'win32') return constants.O_RDONLY;
  if (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number') {
    throw new SafeControlFileError('io-error', path, '当前平台缺少安全打开文件所需标志');
  }
  return constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
}

function missingOrThrow(path: string, options: SafeControlFileReadOptions, error: unknown): null {
  if (errnoCode(error) === 'ENOENT' && options.allowMissing) return null;
  if (errnoCode(error) === 'ENOENT') {
    throw new SafeControlFileError('missing', path, '文件不存在');
  }
  if (error instanceof SafeControlFileError) throw error;
  throw new SafeControlFileError(
    'io-error',
    path,
    error instanceof Error ? error.message : String(error),
  );
}

/**
 * 从同一文件描述符完成类型、大小和内容读取。
 *
 * POSIX 的 O_NOFOLLOW 阻止最终路径软链，O_NONBLOCK 保证 FIFO/设备不会在 open
 * 阶段挂住。Windows 没有等价 open flag，因此在 open 前后都用 lstat 拒绝软链，
 * 并要求路径身份与已打开 fd 一致；无法确认时一律失败。
 */
export function readSafeControlFileSync(
  path: string,
  options: SafeControlFileReadOptions,
): Buffer | null {
  validateOptions(path, options);
  let workspaceIdentity: WorkspaceDirectoryIdentity | null;
  try {
    workspaceIdentity = assertRegisteredWorkspacePath(path);
  } catch (error) {
    throw new SafeControlFileError(
      'changed',
      path,
      error instanceof Error ? error.message : String(error),
    );
  }

  const revalidateWorkspace = (): void => {
    if (workspaceIdentity === null) return;
    try {
      assertWorkspaceDirectory(workspaceIdentity);
    } catch (error) {
      throw new SafeControlFileError(
        'changed',
        path,
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  let windowsPathBefore: BigIntStats | null = null;
  if (process.platform === 'win32') {
    try {
      windowsPathBefore = lstatSync(path, { bigint: true });
      if (windowsPathBefore.isSymbolicLink() || !windowsPathBefore.isFile()) {
        throw new SafeControlFileError('unsafe-type', path, '路径不是普通文件或是软链');
      }
    } catch (error) {
      return missingOrThrow(path, options, error);
    }
  }

  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, safeOpenFlags(path));

    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new SafeControlFileError('unsafe-type', path, '不是普通文件');
    }
    if (before.size > BigInt(options.maxBytes)) {
      throw new SafeControlFileError('too-large', path, `超过 ${options.maxBytes} bytes`);
    }
    if (windowsPathBefore !== null && !sameObject(windowsPathBefore, before)) {
      throw new SafeControlFileError('changed', path, '路径在打开期间被替换');
    }

    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= options.maxBytes) {
      const remaining = options.maxBytes + 1 - total;
      if (remaining === 0) break;
      const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, remaining));
      const read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read === 0) break;
      chunks.push(chunk.subarray(0, read));
      total += read;
    }
    if (total > options.maxBytes) {
      throw new SafeControlFileError('too-large', path, `读取时超过 ${options.maxBytes} bytes`);
    }

    const after = fstatSync(descriptor, { bigint: true });
    if (!unchanged(before, after) || BigInt(total) !== after.size) {
      throw new SafeControlFileError('changed', path, '读取期间内容或文件身份发生变化');
    }

    if (process.platform === 'win32') {
      const windowsPathAfter = lstatSync(path, { bigint: true });
      if (
        windowsPathAfter.isSymbolicLink() ||
        !windowsPathAfter.isFile() ||
        windowsPathBefore === null ||
        !sameObject(windowsPathBefore, windowsPathAfter) ||
        !sameObject(windowsPathAfter, after)
      ) {
        throw new SafeControlFileError('changed', path, '路径在读取期间被替换');
      }
    }

    revalidateWorkspace();
    return Buffer.concat(chunks, total);
  } catch (error) {
    revalidateWorkspace();
    return missingOrThrow(path, options, error);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function readSafeControlFileUtf8Sync(
  path: string,
  options: SafeControlFileReadOptions,
): string | null {
  const bytes = readSafeControlFileSync(path, options);
  if (bytes === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SafeControlFileError('invalid-encoding', path, '不是合法 UTF-8');
  }
}

function isInside(root: string, target: string): boolean {
  const rel = relative(root, target);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function canonicalExistingParent(projectRoot: string, path: string): string {
  let current = dirname(path);
  while (true) {
    try {
      return realpathSync.native(current);
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT' || current === projectRoot) throw error;
      const parent = dirname(current);
      if (parent === current || !isInside(projectRoot, parent)) throw error;
      current = parent;
    }
  }
}

/**
 * 读取项目根内的小型普通文件，并在打开前拒绝通过中间目录软链越出项目。
 * 最终路径的软链、FIFO、设备和目录仍由 readSafeControlFileUtf8Sync 拒绝。
 */
export function readSafeProjectFileUtf8Sync(
  projectRoot: string,
  path: string,
  options: SafeControlFileReadOptions,
): string | null {
  const lexicalRoot = resolve(projectRoot);
  const lexicalPath = resolve(path);
  if (!isInside(lexicalRoot, lexicalPath)) {
    throw new SafeControlFileError('unsafe-type', lexicalPath, '路径位于项目根之外');
  }

  let canonicalRoot: string;
  let parentBefore: string;
  try {
    canonicalRoot = realpathSync.native(lexicalRoot);
    parentBefore = canonicalExistingParent(lexicalRoot, lexicalPath);
  } catch (error) {
    throw new SafeControlFileError(
      'io-error',
      lexicalPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (!isInside(canonicalRoot, parentBefore)) {
    throw new SafeControlFileError('unsafe-type', lexicalPath, '父目录解析到项目根之外');
  }

  const value = readSafeControlFileUtf8Sync(lexicalPath, options);
  let parentAfter: string;
  try {
    parentAfter = canonicalExistingParent(lexicalRoot, lexicalPath);
  } catch (error) {
    throw new SafeControlFileError(
      'changed',
      lexicalPath,
      error instanceof Error ? error.message : String(error),
    );
  }
  if (parentAfter !== parentBefore || !isInside(canonicalRoot, parentAfter)) {
    throw new SafeControlFileError('changed', lexicalPath, '父目录在读取期间变化或越出项目根');
  }
  return value;
}

/**
 * 向有界普通控制文件追加 UTF-8。最终路径软链/FIFO/目录一律拒绝；已冻结
 * workspace 的父目录身份在写前后都必须保持不变。
 */
export function appendSafeControlFileUtf8Sync(
  path: string,
  value: string,
  options: Pick<SafeControlFileReadOptions, 'maxBytes'>,
): void {
  validateOptions(path, options);
  const bytes = Buffer.from(value, 'utf8');
  let workspaceIdentity: WorkspaceDirectoryIdentity | null;
  try {
    workspaceIdentity = assertRegisteredWorkspacePath(path);
  } catch (error) {
    throw new SafeControlFileError(
      'changed',
      path,
      error instanceof Error ? error.message : String(error),
    );
  }
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  const nonBlock = process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0);
  if (
    process.platform !== 'win32' &&
    (typeof constants.O_NOFOLLOW !== 'number' || typeof constants.O_NONBLOCK !== 'number')
  ) {
    throw new SafeControlFileError('io-error', path, '当前平台缺少安全追加文件所需标志');
  }

  let windowsPathBefore: BigIntStats | null = null;
  if (process.platform === 'win32') {
    try {
      windowsPathBefore = lstatSync(path, { bigint: true });
      if (windowsPathBefore.isSymbolicLink() || !windowsPathBefore.isFile()) {
        throw new SafeControlFileError('unsafe-type', path, '路径不是普通文件或是软链');
      }
    } catch (error) {
      if (errnoCode(error) !== 'ENOENT') {
        if (error instanceof SafeControlFileError) throw error;
        throw new SafeControlFileError(
          'io-error',
          path,
          error instanceof Error ? error.message : String(error),
        );
      }
    }
  }

  let descriptor: number | null = null;
  try {
    descriptor = openSync(
      path,
      constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | noFollow | nonBlock,
      0o600,
    );
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) {
      throw new SafeControlFileError('unsafe-type', path, '不是普通文件');
    }
    if (windowsPathBefore !== null && !sameObject(windowsPathBefore, before)) {
      throw new SafeControlFileError('changed', path, '路径在打开期间被替换');
    }
    if (before.size + BigInt(bytes.length) > BigInt(options.maxBytes)) {
      throw new SafeControlFileError('too-large', path, `追加后超过 ${options.maxBytes} bytes`);
    }
    let written = 0;
    while (written < bytes.length) {
      const count = writeSync(descriptor, bytes, written, bytes.length - written);
      if (count <= 0) throw new SafeControlFileError('io-error', path, '追加未取得进展');
      written += count;
    }
    const after = fstatSync(descriptor, { bigint: true });
    if (!sameObject(before, after) || after.size !== before.size + BigInt(bytes.length)) {
      throw new SafeControlFileError('changed', path, '追加期间内容或文件身份发生变化');
    }
    if (process.platform === 'win32') {
      const windowsPathAfter = lstatSync(path, { bigint: true });
      if (
        windowsPathAfter.isSymbolicLink() ||
        !windowsPathAfter.isFile() ||
        !sameObject(windowsPathAfter, after)
      ) {
        throw new SafeControlFileError('changed', path, '路径在追加期间被替换');
      }
    }
    if (workspaceIdentity) assertWorkspaceDirectory(workspaceIdentity);
  } catch (error) {
    if (workspaceIdentity) {
      try {
        assertWorkspaceDirectory(workspaceIdentity);
      } catch (identityError) {
        throw new SafeControlFileError(
          'changed',
          path,
          identityError instanceof Error ? identityError.message : String(identityError),
        );
      }
    }
    if (error instanceof SafeControlFileError) throw error;
    throw new SafeControlFileError(
      'io-error',
      path,
      error instanceof Error ? error.message : String(error),
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
