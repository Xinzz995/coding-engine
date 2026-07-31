/**
 * TEST-ONLY transport selected by the ordinary Windows Vitest config.
 *
 * It preserves deterministic live/dead, platform-kind, host, and boot comparisons without
 * starting PowerShell for every fixture. It cannot prove PID reuse because its process identity is
 * derived from the PID; reuse-sensitive behavior remains covered by injected identity tests and
 * the required standard-user Windows proof, which always resolves the production transport.
 */
import type { ProcessIdentityLookup } from './identity.js';
import type { WindowsIdentitySnapshot } from './windows-identity-transport.js';

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

function fixtureProcessIdentity(pid: number): string {
  return (100_000_000_000_000_000n + BigInt(pid)).toString();
}

function processIdentity(pid: number): ProcessIdentityLookup {
  try {
    process.kill(pid, 0);
    return { status: 'found', value: fixtureProcessIdentity(pid) };
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ESRCH' ? { status: 'missing' } : { status: 'unknown' };
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
