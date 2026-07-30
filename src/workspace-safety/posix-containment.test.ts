import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordDetachedPosixTestChild,
  terminateRecordedPosixTestGroup,
  type RecordedPosixTestGroup,
} from './__fixtures__/posix-test-process-group.js';
import {
  inspectPosixProcessPlacement,
  probePosixProcessGroup,
  waitForPosixProcessGroupEmpty,
} from './posix-containment.js';

const groups = new Map<number, RecordedPosixTestGroup>();
const children = new Set<ChildProcess>();

async function spawnFixture(): Promise<{ child: ChildProcess; record: RecordedPosixTestGroup }> {
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], {
    detached: true,
    stdio: 'ignore',
  });
  children.add(child);
  await once(child, 'spawn');
  const record = recordDetachedPosixTestChild(child);
  groups.set(record.pgid, record);
  return { child, record };
}

afterEach(async () => {
  for (const record of groups.values()) {
    try {
      await terminateRecordedPosixTestGroup(record);
    } catch {
      // Preserve the original assertion while attempting every identity-bound fixture cleanup.
    }
  }
  await Promise.allSettled(
    [...children]
      .filter((child) => child.exitCode === null && child.signalCode === null)
      .map((child) => once(child, 'exit')),
  );
  groups.clear();
  children.clear();
});

describe.runIf(process.platform !== 'win32')('read-only POSIX process-group inspection', () => {
  it('measures an isolated test fixture without exposing a production spawn API', async () => {
    const { child, record } = await spawnFixture();
    const childExit = once(child, 'exit');
    expect(inspectPosixProcessPlacement(record.launcherPid)).toEqual({
      pid: record.launcherPid,
      pgid: record.pgid,
      sessionId: record.pgid,
    });
    expect(probePosixProcessGroup(record.pgid)).toBe('alive');

    await terminateRecordedPosixTestGroup(record, { termTimeoutMs: 3000 });
    groups.delete(record.pgid);
    await childExit;
    expect(await waitForPosixProcessGroupEmpty(record.pgid, 100, 10)).toBe(true);
  });

  it('rejects invalid group identifiers instead of probing the caller group', () => {
    expect(() => probePosixProcessGroup(0)).toThrow(/invalid/i);
    expect(() => probePosixProcessGroup(-process.pid)).toThrow(/invalid/i);
  });
});
