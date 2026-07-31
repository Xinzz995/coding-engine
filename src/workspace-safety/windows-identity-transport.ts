import { spawnSync } from 'node:child_process';
import type { ProcessIdentityLookup } from './identity.js';
import {
  parseWindowsIdentitySnapshotOutput,
  resolveWindowsIdentityPowerShellLaunch,
  validateWindowsBootIdentity,
  WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
  WINDOWS_IDENTITY_SNAPSHOT_SCRIPT,
} from './windows-identity-protocol.js';
import { WorkspaceSafetyError } from './types.js';

export interface WindowsIdentitySnapshot {
  readonly hostIdentity: string;
  readonly bootIdentity: string;
  readonly processIdentity: ProcessIdentityLookup;
}

function probePidExistence(pid: number): 'present' | 'missing' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'missing';
    return 'unknown';
  }
}

/** Lightweight process-only lookup used by supervisor liveness checks. */
export function readWindowsProcessIdentity(pid: number): ProcessIdentityLookup {
  const launch = resolveWindowsIdentityPowerShellLaunch();
  const script = [
    `$p = Get-Process -Id ${pid} -ErrorAction SilentlyContinue`,
    'if ($null -eq $p) { exit 3 }',
    'try { [Console]::Out.Write($p.StartTime.ToUniversalTime().ToFileTimeUtc()) } catch { exit 4 }',
  ].join('; ');
  const result = spawnSync(
    launch.command,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    {
      encoding: 'utf8',
      env: launch.env,
      timeout: WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.status === 3) {
    const existence = probePidExistence(pid);
    return existence === 'missing' ? { status: 'missing' } : { status: 'unknown' };
  }
  if (result.error || result.status !== 0) return { status: 'unknown' };
  const value = (result.stdout ?? '').trim();
  return /^\d+$/u.test(value) ? { status: 'found', value } : { status: 'unknown' };
}

export function readWindowsIdentitySnapshot(pid: number): WindowsIdentitySnapshot {
  const launch = resolveWindowsIdentityPowerShellLaunch();
  const result = spawnSync(
    launch.command,
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDENTITY_SNAPSHOT_SCRIPT],
    {
      encoding: 'utf8',
      env: { ...launch.env, CODING_X_WINDOWS_IDENTITY_PID: String(pid) },
      timeout: WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
      windowsHide: true,
    },
  );
  if (result.error || result.status !== 0) {
    throw new WorkspaceSafetyError('unsupported', 'Windows identity snapshot is unavailable');
  }
  const record = parseWindowsIdentitySnapshotOutput(result.stdout ?? '');
  let processIdentity: ProcessIdentityLookup;
  if (record.processStatus === 'found') {
    processIdentity = { status: 'found', value: record.processValue! };
  } else if (record.processStatus === 'unknown') {
    processIdentity = { status: 'unknown' };
  } else {
    const existence = probePidExistence(pid);
    processIdentity = existence === 'missing' ? { status: 'missing' } : { status: 'unknown' };
  }
  return {
    processIdentity,
    bootIdentity: validateWindowsBootIdentity(record.bootIdentity),
    hostIdentity: record.hostIdentity,
  };
}
