/**
 * TEST-ONLY transport selected by the ordinary Windows Vitest config.
 *
 * It preserves deterministic host and boot comparisons without starting PowerShell for every
 * fixture. Live process identity still comes from the reviewed native inspector, so a real fixed
 * supervisor and the parent observe the same Windows creation FILETIME. Every verification reads
 * the native FILETIME again: PID liveness alone cannot prove that a PID still names the same
 * process after reuse.
 */
import type { ProcessIdentityLookup } from './identity.js';
import type { WindowsIdentitySnapshot } from './windows-identity-transport.js';
import { inspectWindowsProcessIdentity } from './windows-path-attributes.js';

const TEST_HOST_IDENTITY = 'coding-x-windows-test-host-v1';
const TEST_BOOT_IDENTITY = 'coding-x-windows-test-boot-v1';
const MAX_TEST_INVOCATIONS = 10_000;
let invocationCount = 0;

function recordInvocation(): void {
  invocationCount += 1;
  if (invocationCount > MAX_TEST_INVOCATIONS) {
    throw new Error('deterministic Windows identity transport invocation limit exceeded');
  }
}

function pidPresence(pid: number): 'present' | 'missing' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? 'missing' : 'unknown';
  }
}

function fixtureProcessIdentity(pid: number): string {
  return (100_000_000_000_000_000n + BigInt(pid)).toString();
}

function processIdentity(pid: number): ProcessIdentityLookup {
  // Cross-platform unit tests import this Windows-only transport directly. They still need a
  // deterministic fixture identity when no Windows inspector can run. Ordinary Windows Vitest,
  // however, must use the native identity so it can supervise the real fixed executable.
  if (process.platform !== 'win32') {
    const presence = pidPresence(pid);
    return presence === 'present'
      ? { status: 'found', value: fixtureProcessIdentity(pid) }
      : { status: presence };
  }
  try {
    const observed = inspectWindowsProcessIdentity(pid);
    return observed.status === 'found'
      ? { status: 'found', value: observed.value }
      : { status: observed.status };
  } catch {
    return { status: 'unknown' };
  }
}

export function readWindowsProcessIdentity(pid: number): ProcessIdentityLookup {
  recordInvocation();
  return processIdentity(pid);
}

export function readWindowsIdentitySnapshot(pid: number): WindowsIdentitySnapshot {
  recordInvocation();
  return {
    hostIdentity: TEST_HOST_IDENTITY,
    bootIdentity: TEST_BOOT_IDENTITY,
    processIdentity: processIdentity(pid),
  };
}
