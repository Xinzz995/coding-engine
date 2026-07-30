import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { WorkspaceSafetyError } from './types.js';

export type PosixGroupVerdict = 'alive' | 'empty' | 'unknown';

export interface PosixProcessPlacement {
  readonly pid: number;
  readonly pgid: number;
  readonly sessionId: number;
}

function assertSupported(): void {
  if (process.platform === 'win32') {
    throw new WorkspaceSafetyError(
      'unsupported',
      'POSIX process groups are unavailable on Windows',
    );
  }
}

function assertPgid(pgid: number): void {
  if (!Number.isSafeInteger(pgid) || pgid < 2 || pgid > 0x7fff_ffff) {
    throw new WorkspaceSafetyError('invalid', 'POSIX process group id is invalid');
  }
}

function errorCode(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
}

export function inspectPosixProcessPlacement(pid: number): PosixProcessPlacement {
  assertSupported();
  assertPgid(pid);
  if (process.platform === 'linux') {
    let stat: string;
    try {
      stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch (_error) {
      throw new WorkspaceSafetyError('isolated', 'POSIX process placement is unavailable');
    }
    const commandEnd = stat.lastIndexOf(')');
    const fields = stat
      .slice(commandEnd + 1)
      .trim()
      .split(/\s+/u);
    const pgid = Number(fields[2]);
    const sessionId = Number(fields[3]);
    if (commandEnd < 2 || !Number.isSafeInteger(pgid) || !Number.isSafeInteger(sessionId)) {
      throw new WorkspaceSafetyError('isolated', 'POSIX process placement is invalid');
    }
    return { pid, pgid, sessionId };
  }
  if (process.platform === 'darwin') {
    const result = spawnSync(
      '/usr/bin/ruby',
      [
        '-e',
        'print "#{Process.getsid(ARGV[0].to_i)} #{Process.getpgid(ARGV[0].to_i)}"',
        String(pid),
      ],
      {
        encoding: 'utf8',
        env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
        timeout: 5000,
      },
    );
    const [sessionId, pgid] = (result.stdout ?? '').trim().split(/\s+/u).map(Number);
    if (
      result.error ||
      result.status !== 0 ||
      !Number.isSafeInteger(pgid) ||
      !Number.isSafeInteger(sessionId)
    ) {
      throw new WorkspaceSafetyError('isolated', 'POSIX process placement is unavailable');
    }
    return { pid, pgid, sessionId };
  }
  throw new WorkspaceSafetyError('unsupported', `Unsupported POSIX platform: ${process.platform}`);
}

export function probePosixProcessGroup(pgid: number): PosixGroupVerdict {
  assertSupported();
  assertPgid(pgid);
  try {
    process.kill(-pgid, 0);
    return 'alive';
  } catch (error) {
    const code = errorCode(error);
    if (code === 'ESRCH') return 'empty';
    if (code === 'EPERM') return 'alive';
    return 'unknown';
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function waitForPosixProcessGroupEmpty(
  pgid: number,
  timeoutMs: number,
  pollIntervalMs = 25,
): Promise<boolean> {
  assertPgid(pgid);
  if (!Number.isFinite(timeoutMs) || timeoutMs < 0 || timeoutMs > 60_000) {
    throw new WorkspaceSafetyError('invalid', 'POSIX containment timeout is invalid');
  }
  if (!Number.isFinite(pollIntervalMs) || pollIntervalMs < 1 || pollIntervalMs > 1000) {
    throw new WorkspaceSafetyError('invalid', 'POSIX containment poll interval is invalid');
  }
  const deadline = Date.now() + timeoutMs;
  do {
    const verdict = probePosixProcessGroup(pgid);
    if (verdict === 'empty') return true;
    if (verdict === 'unknown') return false;
    if (Date.now() >= deadline) return false;
    await delay(Math.min(pollIntervalMs, Math.max(1, deadline - Date.now())));
  } while (true);
}
