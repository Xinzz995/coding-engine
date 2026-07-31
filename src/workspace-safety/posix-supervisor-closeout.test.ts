import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from './workspace-authority-test-seam.js';
import { digestBytes } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from './workspace-authority-test-seam.js';
import {
  ACTIVE_CHILD_FILE,
  DELEGATED_BASELINE_FILE,
  PRESTART_ABORT_FILE,
  parsePrestartAbortRecord,
} from './operation.js';
import {
  runWorkspaceOperationWithAuthority as runWorkspaceOperation,
  type OperationHooksWithAuthority as OperationHooks,
} from './operation-authority-test-seam.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from './posix-supervisor.js';
import { waitForPosixProcessGroupEmpty } from './posix-containment.js';
import { parseQuarantineRecord, QUARANTINE_FILE } from './quarantine.js';
import { createWorkspaceSession, type WorkspaceSession } from './session.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from './types.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000010';
const OPERATION_ID = '00000000-0000-4000-8000-000000000020';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<{ workspace: string; session: WorkspaceSession }> {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-posix-closeout-'));
  roots.push(workspace);
  const identity = createIdentityProbe().current();
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity,
    ownerId: '00000000-0000-4000-8000-000000000001',
  });
  const lease = await acquireWorkspaceLease({
    workspacePath: workspace,
    identity,
    ownerId: OWNER_ID,
    command: 'run',
  });
  return { workspace, session: createWorkspaceSession(lease) };
}

function operationOptions(hooks: OperationHooks = {}) {
  return {
    operationId: OPERATION_ID,
    kind: 'final-review' as const,
    delegation: 'read-only-v1' as const,
    platform: 'posix-process-group-v1' as const,
    helperBytes: readDarkPosixHelperBundle(),
    hooks,
  };
}

function target(marker: string, cwd: string) {
  return {
    executable: process.execPath,
    args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
    cwd,
    environment: [] as const,
  };
}

function operationPath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
}

function settledOperationPath(workspace: string): string {
  const settledRoot = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, 'settled-operations');
  const entries = readdirSync(settledRoot);
  expect(entries).toHaveLength(1);
  return join(settledRoot, entries[0]);
}

describe.runIf(process.platform !== 'win32')('POSIX supervisor failure closeout', () => {
  it('settles a setup failure from prepared with zero project execution', async () => {
    const state = await setup();

    await expect(
      runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: { ...target('unused', state.workspace), executable: 'relative-node' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });

    expect(existsSync(operationPath(state.workspace))).toBe(false);
    const abort = parsePrestartAbortRecord(
      readFileSync(join(settledOperationPath(state.workspace), PRESTART_ABORT_FILE)),
    );
    expect(abort).toMatchObject({
      reason: 'setup-failed',
      proof: 'supervisor-never-bound-v1',
      prestartDrainedDigest: null,
    });
    await state.session.close();
  });

  it('uses the real prepared-bound ABORT/PRESTART_DRAINED handshake after a bound commit failure', async () => {
    const state = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-closeout-control-'));
    roots.push(controlRoot);
    const marker = join(controlRoot, 'must-not-run.txt');

    await expect(
      runWorkspaceOperation(
        state.session,
        operationOptions({
          afterActiveCommitted: (activeState) => {
            if (activeState === 'prepared-bound') throw new Error('bound test stop');
          },
        }),
        (operation) =>
          runDarkPosixSupervisedOperation(operation, { target: target(marker, state.workspace) }),
      ),
    ).rejects.toThrow(/bound test stop/u);

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(operationPath(state.workspace))).toBe(false);
    const abort = parsePrestartAbortRecord(
      readFileSync(join(settledOperationPath(state.workspace), PRESTART_ABORT_FILE)),
    );
    expect(abort.proof).toBe('supervisor-prestart-empty-v1');
    expect(abort.prestartDrainedDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
    await state.session.close();
  });

  it('settles an already-requested prestart interrupt without spawning project code', async () => {
    const state = await setup();
    const controller = new AbortController();
    controller.abort();

    await expect(
      runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target('unused', state.workspace),
          termination: { signal: controller.signal, reason: 'user-interrupt' },
        }),
      ),
    ).rejects.toMatchObject({ code: 'isolated' });

    const abort = parsePrestartAbortRecord(
      readFileSync(join(settledOperationPath(state.workspace), PRESTART_ABORT_FILE)),
    );
    expect(abort).toMatchObject({ reason: 'user-interrupt', proof: 'supervisor-never-bound-v1' });
    await state.session.close();
  });

  it('installs a strictly operation-bound integrity quarantine when baseline changes prestart', async () => {
    const state = await setup();
    const marker = join(
      mkdtempSync(join(tmpdir(), 'coding-x-posix-closeout-target-')),
      'target.txt',
    );
    roots.push(join(marker, '..'));
    const canonical = operationPath(state.workspace);

    await expect(
      runWorkspaceOperation(
        state.session,
        operationOptions({
          afterActiveCommitted: (activeState) => {
            if (activeState === 'prepared-bound') {
              writeFileSync(join(state.workspace, 'unexpected.txt'), 'changed');
            }
          },
        }),
        (operation) =>
          runDarkPosixSupervisedOperation(operation, { target: target(marker, state.workspace) }),
      ),
    ).rejects.toMatchObject({ code: 'isolated' });

    expect(existsSync(marker)).toBe(false);
    const activeBytes = readFileSync(join(canonical, ACTIVE_CHILD_FILE));
    const baselineBytes = readFileSync(join(canonical, DELEGATED_BASELINE_FILE));
    const quarantine = parseQuarantineRecord(readFileSync(join(canonical, QUARANTINE_FILE)));
    expect(quarantine).toMatchObject({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      activeChildDigest: digestBytes(activeBytes),
      delegatedBaselineDigest: digestBytes(baselineBytes),
      reason: 'workspace-integrity-violation',
      creator: { kind: 'owner', id: OWNER_ID },
      priorQuarantineDigest: null,
    });
  });

  it('uses containment quarantine when termination acknowledgement becomes uncertain', async () => {
    const state = await setup();
    const controller = new AbortController();
    let pgid: number | undefined;

    await expect(
      runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: {
            executable: process.execPath,
            args: ['-e', 'setInterval(() => {}, 1000)'],
            cwd: state.workspace,
            environment: [],
          },
          termination: { signal: controller.signal, reason: 'user-interrupt' },
          timeouts: { termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              if (containment.platform === 'posix-process-group-v1') pgid = containment.pgid;
              controller.abort();
            },
            onTerminating: () => {
              throw new Error('termination acknowledgement lost');
            },
          },
        }),
      ),
    ).rejects.toThrow(/termination acknowledgement lost/u);

    expect(
      parseQuarantineRecord(readFileSync(join(operationPath(state.workspace), QUARANTINE_FILE)))
        .reason,
    ).toBe('containment-unconfirmed');
    if (pgid !== undefined) {
      expect(await waitForPosixProcessGroupEmpty(pgid, 5000, 20)).toBe(true);
    }
  });
});
