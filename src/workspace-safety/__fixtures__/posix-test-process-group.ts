import type { ChildProcess } from 'node:child_process';
import { createSystemIdentityAdapter } from '../identity.js';
import {
  inspectPosixProcessPlacement,
  probePosixProcessGroup,
  waitForPosixProcessGroupEmpty,
} from '../posix-containment.js';
import type { ContainmentDescriptor } from '../supervisor-protocol.js';

export interface RecordedPosixTestGroup {
  readonly pgid: number;
  readonly launcherPid: number;
  readonly launcherIdentity: string;
}

function requireExactLiveIdentity(record: RecordedPosixTestGroup): void {
  const observed = createSystemIdentityAdapter().readProcessIdentity(record.launcherPid);
  if (observed.status !== 'found' || observed.value !== record.launcherIdentity) {
    throw new Error(
      'refusing test cleanup because the recorded launcher identity is not exact-live',
    );
  }
  const placement = inspectPosixProcessPlacement(record.launcherPid);
  if (
    placement.pid !== record.launcherPid ||
    placement.pgid !== record.pgid ||
    placement.sessionId !== record.pgid
  ) {
    throw new Error('refusing test cleanup because the recorded launcher placement changed');
  }
}

export function recordDetachedPosixTestChild(child: ChildProcess): RecordedPosixTestGroup {
  if (child.pid === undefined) throw new Error('test fixture pid is unavailable');
  const placement = inspectPosixProcessPlacement(child.pid);
  if (placement.pgid !== child.pid || placement.sessionId !== child.pid) {
    throw new Error('test fixture is not an isolated POSIX process-group leader');
  }
  const observed = createSystemIdentityAdapter().readProcessIdentity(child.pid);
  if (observed.status !== 'found') throw new Error('test fixture identity is unavailable');
  return { pgid: child.pid, launcherPid: child.pid, launcherIdentity: observed.value };
}

export function recordPosixTestContainment(
  containment: ContainmentDescriptor,
): RecordedPosixTestGroup {
  if (
    containment.platform !== 'posix-process-group-v1' ||
    containment.launcherPid !== containment.pgid
  ) {
    throw new Error('test containment is not a POSIX launcher-led process group');
  }
  requireExactLiveIdentity(containment);
  return containment;
}

function signalRecordedTestGroup(
  record: RecordedPosixTestGroup,
  signal: 'SIGTERM' | 'SIGKILL',
): void {
  requireExactLiveIdentity(record);
  try {
    process.kill(-record.pgid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
  }
}

export async function terminateRecordedPosixTestGroup(
  record: RecordedPosixTestGroup,
  options: {
    readonly termTimeoutMs?: number;
    readonly killTimeoutMs?: number;
    readonly pollIntervalMs?: number;
  } = {},
): Promise<void> {
  if (probePosixProcessGroup(record.pgid) === 'empty') return;
  const pollIntervalMs = options.pollIntervalMs ?? 20;
  signalRecordedTestGroup(record, 'SIGTERM');
  if (
    await waitForPosixProcessGroupEmpty(record.pgid, options.termTimeoutMs ?? 100, pollIntervalMs)
  ) {
    return;
  }
  signalRecordedTestGroup(record, 'SIGKILL');
  if (
    !(await waitForPosixProcessGroupEmpty(
      record.pgid,
      options.killTimeoutMs ?? 3000,
      pollIntervalMs,
    ))
  ) {
    throw new Error('recorded test process group could not be confirmed empty');
  }
}
