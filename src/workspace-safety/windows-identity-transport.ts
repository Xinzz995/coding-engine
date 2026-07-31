import { spawnSync } from 'node:child_process';
import type { ProcessIdentityLookup } from './identity.js';
import {
  parseWindowsIdentitySnapshotOutput,
  resolveWindowsIdentityPowerShellLaunch,
  validateWindowsBootIdentity,
  WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
  WINDOWS_IDENTITY_SNAPSHOT_SCRIPT,
} from './windows-identity-protocol.js';
import { inspectWindowsProcessIdentity } from './windows-path-attributes.js';
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
  try {
    const identity = inspectWindowsProcessIdentity(pid);
    return identity.status === 'found'
      ? { status: 'found', value: identity.value }
      : { status: identity.status };
  } catch {
    return { status: 'unknown' };
  }
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
