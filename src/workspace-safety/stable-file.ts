import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  type BigIntStats,
} from 'node:fs';

export const STABLE_FILE_DEFAULT_MAX_BYTES = 16 * 1024 * 1024;

export interface StableFileReadHooks {
  /** @internal Deterministic replacement seam; production callers must omit hooks. */
  readonly afterOpen?: () => void;
}

export type StableFileRead =
  | { status: 'ready'; bytes: Buffer; fingerprint: string }
  | { status: 'missing'; fingerprint: 'missing' }
  | { status: 'invalid'; fingerprint: string; diagnostic: string };

function sha256(bytes: string | Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}

function sameFileSnapshot(left: BigIntStats, right: BigIntStats): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.nlink === right.nlink &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

function invalid(diagnostic: string): Extract<StableFileRead, { status: 'invalid' }> {
  return { status: 'invalid', fingerprint: sha256(diagnostic), diagnostic };
}

function errorCode(error: unknown): string | null {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : null;
}

/**
 * Read one local authority/display file without following links or waiting on a FIFO. The opened
 * descriptor and the path must keep the same exact identity and size through an explicit EOF read.
 */
export function readStableFile(
  path: string,
  options: {
    readonly label?: string;
    readonly maxBytes?: number;
    readonly hooks?: StableFileReadHooks;
  } = {},
): StableFileRead {
  const label = options.label ?? 'workspace 文件';
  const maxBytes = options.maxBytes ?? STABLE_FILE_DEFAULT_MAX_BYTES;
  if (!Number.isSafeInteger(maxBytes) || maxBytes < 0) {
    return invalid(`${label} 的读取上限非法`);
  }

  let before: BigIntStats;
  try {
    before = lstatSync(path, { bigint: true });
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return { status: 'missing', fingerprint: 'missing' };
    return invalid(`${label} 无法检查：${error instanceof Error ? error.message : String(error)}`);
  }

  if (before.isSymbolicLink() || !before.isFile() || before.nlink !== 1n) {
    return invalid(`${label} 不是独立普通文件`);
  }
  if (before.size > BigInt(maxBytes)) return invalid(`${label} 超过 ${maxBytes} bytes`);

  let descriptor: number | null = null;
  try {
    const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
    const nonBlock = process.platform === 'win32' ? 0 : (constants.O_NONBLOCK ?? 0);
    descriptor = openSync(path, constants.O_RDONLY | noFollow | nonBlock);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > BigInt(maxBytes)) {
      return invalid(`${label} 不是有界独立普通文件`);
    }

    options.hooks?.afterOpen?.();
    const openedPath = lstatSync(path, { bigint: true });
    if (
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      openedPath.nlink !== 1n ||
      !sameFileSnapshot(opened, openedPath)
    ) {
      return invalid(`${label} 身份在打开期间发生变化`);
    }

    const bytes = Buffer.allocUnsafe(Number(opened.size));
    let offset = 0;
    while (offset < bytes.length) {
      const count = readSync(descriptor, bytes, offset, bytes.length - offset, null);
      if (count === 0) break;
      offset += count;
    }
    const trailing = Buffer.allocUnsafe(1);
    const hasTrailingByte = readSync(descriptor, trailing, 0, 1, null) !== 0;
    const afterHandle = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      offset !== bytes.length ||
      hasTrailingByte ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink !== 1n ||
      !sameFileSnapshot(opened, afterHandle) ||
      !sameFileSnapshot(afterHandle, afterPath)
    ) {
      return invalid(`${label} 在读取期间发生变化`);
    }
    return { status: 'ready', bytes, fingerprint: sha256(bytes) };
  } catch (error) {
    return invalid(
      `${label} 无法稳定读取：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}
