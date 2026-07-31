import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WorkspaceSafetyError } from './types.js';

function fixedHelperPath(name: string): string {
  const distributed = fileURLToPath(new URL(`./workspace-safety/${name}`, import.meta.url));
  if (existsSync(distributed)) return distributed;
  const source = fileURLToPath(new URL(`../../assets/workspace-safety/${name}`, import.meta.url));
  if (existsSync(source)) return source;
  throw new WorkspaceSafetyError('unsupported', `Fixed POSIX helper asset is missing: ${name}`);
}

const SUPERVISOR_HELPER_PATH = fixedHelperPath('posix-supervisor-helper.mjs');
const SUPERVISOR_CORE_PATH = fixedHelperPath('posix-supervisor-core.mjs');
const LAUNCHER_HELPER_PATH = fixedHelperPath('posix-launcher-helper.mjs');

function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', `Invalid POSIX supervisor integration: ${message}`);
}

function stableHelperBytes(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
    descriptor = openSync(path, flags);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || opened.size > 4n * 1024n * 1024n) {
      invalid('fixed POSIX helper must be an ordinary bounded single-link file');
    }
    const openedPath = lstatSync(path, { bigint: true });
    if (
      openedPath.isSymbolicLink() ||
      !openedPath.isFile() ||
      openedPath.nlink !== 1n ||
      opened.dev !== openedPath.dev ||
      opened.ino !== openedPath.ino ||
      opened.nlink !== openedPath.nlink ||
      opened.size !== openedPath.size ||
      opened.mtimeNs !== openedPath.mtimeNs ||
      opened.ctimeNs !== openedPath.ctimeNs
    ) {
      invalid('fixed POSIX helper identity changed after open');
    }
    const bytes = readFileSync(descriptor);
    const afterHandle = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterHandle.nlink !== 1n ||
      afterPath.nlink !== 1n ||
      opened.dev !== afterHandle.dev ||
      opened.ino !== afterHandle.ino ||
      opened.size !== afterHandle.size ||
      opened.mtimeNs !== afterHandle.mtimeNs ||
      opened.ctimeNs !== afterHandle.ctimeNs ||
      afterHandle.dev !== afterPath.dev ||
      afterHandle.ino !== afterPath.ino ||
      afterHandle.size !== afterPath.size ||
      afterHandle.mtimeNs !== afterPath.mtimeNs ||
      afterHandle.ctimeNs !== afterPath.ctimeNs ||
      afterHandle.size > 4n * 1024n * 1024n ||
      BigInt(bytes.length) !== afterHandle.size
    ) {
      invalid('fixed POSIX helper changed during read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function readPosixHelperBundleFromPaths(paths: readonly [string, string, string]): Buffer {
  const [supervisorPath, corePath, launcherPath] = paths;
  return Buffer.concat([
    Buffer.from('coding-x-posix-supervisor-v1\0', 'utf8'),
    stableHelperBytes(supervisorPath),
    Buffer.from('\0coding-x-posix-supervisor-core-v1\0', 'utf8'),
    stableHelperBytes(corePath),
    Buffer.from('\0coding-x-posix-launcher-v1\0', 'utf8'),
    stableHelperBytes(launcherPath),
  ]);
}

export function readFixedPosixHelperBundle(): Buffer {
  return readPosixHelperBundleFromPaths([
    SUPERVISOR_HELPER_PATH,
    SUPERVISOR_CORE_PATH,
    LAUNCHER_HELPER_PATH,
  ]);
}

export function readDarkPosixHelperBundle(): Buffer {
  if (process.platform === 'win32') {
    throw new WorkspaceSafetyError('unsupported', 'POSIX helper bundle is unavailable on Windows');
  }
  return readFixedPosixHelperBundle();
}

export function posixSupervisorHelperPath(): string {
  return SUPERVISOR_HELPER_PATH;
}

export function posixLauncherHelperPath(): string {
  return LAUNCHER_HELPER_PATH;
}
