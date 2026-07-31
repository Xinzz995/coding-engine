import { createIdentityProbe, type IdentityProbeAdapter } from '../identity.js';
import {
  OWNER_SCHEMA_VERSION,
  type IdentityVerdict,
  type OwnerRecord,
  type ProcessIdentitySnapshot,
} from '../types.js';
import { readWindowsIdentitySnapshot } from '../windows-identity-test-transport.js';

/**
 * Keeps ordinary Windows Vitest workers and their separately launched fixture processes on the
 * same deterministic identity source. This is not a production transport or a PID-reuse proof;
 * the required standard-user native suites continue to use the real Windows transport.
 */
export function createCrossProcessTestIdentityProbe(): ReturnType<typeof createIdentityProbe> {
  if (process.platform !== 'win32') return createIdentityProbe();
  const adapter: IdentityProbeAdapter = {
    platform: 'win32',
    pid: process.pid,
    readHostIdentity: () => {
      throw new Error('combined Windows test identity snapshot must be used');
    },
    readBootIdentity: () => {
      throw new Error('combined Windows test identity snapshot must be used');
    },
    readProcessIdentity: () => {
      throw new Error('combined Windows test identity snapshot must be used');
    },
    readIdentitySnapshot: readWindowsIdentitySnapshot,
  };
  return createIdentityProbe(adapter);
}

export function currentCrossProcessTestIdentity(): ProcessIdentitySnapshot {
  return createCrossProcessTestIdentityProbe().current();
}

export function probeCrossProcessTestIdentity(
  record: Pick<OwnerRecord, 'pid' | 'processIdentity' | 'bootIdentity' | 'hostId'>,
): IdentityVerdict {
  return createCrossProcessTestIdentityProbe().probe({
    schemaVersion: OWNER_SCHEMA_VERSION,
    ownerId: '00000000-0000-4000-8000-000000000001',
    workspaceIdentity: `sha256:${'0'.repeat(64)}`,
    startedAt: '1970-01-01T00:00:00.000Z',
    command: 'repair',
    ...record,
  });
}
