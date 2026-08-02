import { execFileSync } from 'node:child_process';
import { lstatSync, realpathSync } from 'node:fs';
import { WorkspaceSafetyError } from './types.js';

const DARWIN_MOUNT_EXECUTABLE = '/sbin/mount';
const DARWIN_MOUNT_TIMEOUT_MS = 4_000;
const MAX_MOUNT_TABLE_BYTES = 4 * 1024 * 1024;

function invalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError(
    'invalid',
    `Invalid macOS mount-table transport: ${message}`,
  );
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

/**
 * Fixed macOS safety transport. It executes only the root-owned platform mount reader with a
 * minimal environment, bounded output and a hard deadline; project input never selects argv.
 */
export function readDarwinMountTable(): Buffer {
  if (process.platform !== 'darwin') {
    throw new WorkspaceSafetyError('unsupported', 'macOS mount table requires macOS');
  }
  let executable: string;
  try {
    executable = realpathSync.native(DARWIN_MOUNT_EXECUTABLE);
    const info = lstatSync(executable, { bigint: true });
    if (
      !info.isFile() ||
      info.isSymbolicLink() ||
      info.nlink !== 1n ||
      info.uid !== 0n ||
      (info.mode & 0o22n) !== 0n
    ) {
      throw invalid('fixed executable identity is not trusted');
    }
  } catch (error) {
    if (error instanceof WorkspaceSafetyError) throw error;
    throw invalid('fixed executable identity is unavailable', error);
  }
  try {
    return execFileSync(executable, [], {
      encoding: 'buffer',
      env: {
        LANG: 'C',
        LC_ALL: 'C',
        PATH: '/usr/bin:/bin:/usr/sbin:/sbin',
      },
      maxBuffer: MAX_MOUNT_TABLE_BYTES,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: DARWIN_MOUNT_TIMEOUT_MS,
      windowsHide: true,
    });
  } catch (error) {
    throw invalid('fixed executable did not return a complete bounded table', error);
  }
}
