import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-authority-test-seam.js';
import { digestBytes } from '../filesystem.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import {
  runWorkspaceOperationWithAuthority as runWorkspaceOperation,
  type OperationHooksWithAuthority as OperationHooks,
} from '../operation-authority-test-seam.js';
import { createWorkspaceSession, type WorkspaceSession } from '../session.js';
import {
  SupervisorProtocol,
  encodeSupervisorData,
  type BoundSupervisorDescriptor,
  type ContainmentDescriptor,
} from '../supervisor-protocol.js';
import {
  ACTIVE_LEASE_DIR,
  OPERATION_DIR,
  PROTOCOL_ROOT_DIR,
  type ProcessIdentitySnapshot,
} from '../types.js';

export const OWNER_ID = '00000000-0000-4000-8000-000000000010';
export const OPERATION_ID = '00000000-0000-4000-8000-000000000020';
export const STORY_ID = 'US-001';
export const ACCEPTANCE_HASH = `sha256:${'c'.repeat(64)}`;
export const GIT_HEAD = 'd'.repeat(40);
export const STORY_BASE_GIT_HEAD = 'e'.repeat(40);
export const CHANGE_MANIFEST_DIGEST = `sha256:${'f'.repeat(64)}`;
export const HELPER_BYTES = Buffer.from('fixed-supervisor-helper-v1');

function identity(pid: number): ProcessIdentitySnapshot {
  return {
    pid,
    processIdentity: { kind: 'linux-boot-start', value: String(10_000 + pid) },
    bootIdentity: `sha256:${'a'.repeat(64)}`,
    hostId: `sha256:${'b'.repeat(64)}`,
  };
}

export const supervisor: BoundSupervisorDescriptor = {
  platform: 'posix-process-group-v1',
  supervisorPid: 410,
  supervisorIdentity: '410001',
  signalIsolation: 'posix-supervisor-session-signal-shield-v1',
  helperDigest: digestBytes(HELPER_BYTES),
};

export const containment: ContainmentDescriptor = {
  platform: 'posix-process-group-v1',
  pgid: 510,
  launcherPid: 510,
  launcherIdentity: '510001',
};

export interface OperationTestSetup {
  readonly workspace: string;
  readonly session: WorkspaceSession;
}

export async function setupOperationTest(
  roots: string[],
  leaseIdentity: ProcessIdentitySnapshot = identity(2),
): Promise<OperationTestSetup> {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-operation-'));
  roots.push(workspace);
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity: identity(1),
    ownerId: '00000000-0000-4000-8000-000000000001',
  });
  const lease = await acquireWorkspaceLease({
    workspacePath: workspace,
    identity: leaseIdentity,
    ownerId: OWNER_ID,
    command: 'run',
  });
  writeFileSync(
    join(workspace, 'state.json'),
    JSON.stringify({
      [STORY_ID]: {
        passes: false,
        validated: false,
        validationReceipt: null,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    }),
  );
  mkdirSync(join(workspace, 'screenshots'));
  return { workspace, session: createWorkspaceSession(lease) };
}

export function operationPath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
}

export function defaultOptions(hooks?: OperationHooks) {
  return {
    operationId: OPERATION_ID,
    kind: 'builder' as const,
    delegation: 'builder-v1' as const,
    storyId: STORY_ID,
    acceptanceHash: ACCEPTANCE_HASH,
    checkCount: 1,
    platform: 'posix-process-group-v1' as const,
    helperBytes: HELPER_BYTES,
    now: () => new Date('2026-07-30T00:00:01.000Z'),
    hooks,
  };
}

export function validatorOptions(hooks?: OperationHooks) {
  return {
    operationId: OPERATION_ID,
    kind: 'validator' as const,
    delegation: 'validator-v1' as const,
    storyId: STORY_ID,
    requestId: OPERATION_ID,
    acceptanceHash: ACCEPTANCE_HASH,
    checkCount: 1,
    gitHead: GIT_HEAD,
    storyBaseGitHead: STORY_BASE_GIT_HEAD,
    changeManifestDigest: CHANGE_MANIFEST_DIGEST,
    changedPathCount: 1,
    platform: 'posix-process-group-v1' as const,
    helperBytes: HELPER_BYTES,
    now: () => new Date('2026-07-30T00:00:01.000Z'),
    hooks,
  };
}

export function readOnlyOptions(hooks?: OperationHooks) {
  return {
    operationId: OPERATION_ID,
    kind: 'final-review' as const,
    delegation: 'read-only-v1' as const,
    platform: 'posix-process-group-v1' as const,
    helperBytes: HELPER_BYTES,
    now: () => new Date('2026-07-30T00:00:01.000Z'),
    hooks,
  };
}

function dataBytes(): Buffer {
  return encodeSupervisorData({
    operationId: OPERATION_ID,
    target: {
      executable: '/usr/bin/node',
      args: ['dist/cli.js'],
      cwd: '/tmp/package-owned-cwd',
      environment: [],
    },
  });
}

export async function driveToArmed(
  operation: Parameters<Parameters<typeof runWorkspaceOperation>[2]>[0],
): Promise<{
  machine: SupervisorProtocol;
  armed: Awaited<ReturnType<typeof operation.readArmedBindingControlled>>;
}> {
  await operation.bindSupervisorControlled(supervisor);
  const bound = await operation.readPreparedBoundBindingControlled(HELPER_BYTES);
  const machine = new SupervisorProtocol({
    ownerId: OWNER_ID,
    operationId: OPERATION_ID,
    supervisor,
  });
  machine.acceptData(dataBytes(), bound);
  machine.containmentReady(containment);
  await operation.armContainmentControlled(containment);
  const armed = await operation.readArmedBindingControlled(HELPER_BYTES);
  return { machine, armed };
}
