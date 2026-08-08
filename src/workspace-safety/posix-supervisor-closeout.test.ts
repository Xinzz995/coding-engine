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
  DRAINED_RECEIPT_FILE,
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
import {
  ACTIVE_LEASE_DIR,
  OPERATION_DIR,
  PROTOCOL_ROOT_DIR,
  WorkspaceSafetyError,
} from './types.js';

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
  it('bounds one absolute prepare phase and retains either proof or a write fence', async () => {
    const state = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-prepare-deadline-'));
    roots.push(controlRoot);
    const marker = join(controlRoot, 'must-not-run.txt');
    const startedAt = performance.now();
    let boundHookRan = false;

    let failure: unknown;
    try {
      await runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(marker, state.workspace),
          timeouts: {
            handshakeMs: 3000,
            termMs: 50,
            killMs: 300,
            ackMs: 100,
            pollMs: 10,
          },
          hooks: {
            onBound: ({ supervisorPid }) => {
              boundHookRan = true;
              process.kill(supervisorPid, 'SIGSTOP');
            },
          },
        }),
      );
    } catch (error) {
      failure = error;
    }

    expect(boundHookRan).toBe(true);
    expect(failure).toMatchObject({
      code: 'isolated',
      message: expect.stringMatching(/prepare|prestart/u),
    });

    const elapsedMs = performance.now() - startedAt;
    expect(elapsedMs).toBeGreaterThanOrEqual(2500);
    expect(elapsedMs).toBeLessThan(8000);
    expect(existsSync(marker)).toBe(false);
    const active = operationPath(state.workspace);
    if (existsSync(active)) {
      expect(existsSync(join(active, DRAINED_RECEIPT_FILE))).toBe(false);
      expect(existsSync(join(active, QUARANTINE_FILE))).toBe(false);
      expect(state.session.state).toBe('isolated');
      await expect(state.session.close()).rejects.toMatchObject({ code: 'isolated' });
    } else {
      const abort = parsePrestartAbortRecord(
        readFileSync(join(settledOperationPath(state.workspace), PRESTART_ABORT_FILE)),
      );
      expect(abort.reason).toBe('setup-failed');
      if (abort.proof === 'supervisor-never-bound-v1') {
        expect(abort.prestartDrainedDigest).toBeNull();
      } else {
        expect(abort.proof).toBe('supervisor-prestart-empty-v1');
        expect(abort.prestartDrainedDigest).toMatch(/^sha256:[a-f0-9]{64}$/u);
      }
      await state.session.close();
    }
  });

  it('returns after a canonical operation step times out without queueing closeout behind it', async () => {
    const state = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-operation-deadline-'));
    roots.push(controlRoot);
    const marker = join(controlRoot, 'must-not-run.txt');
    const startedAt = performance.now();
    let releaseLateStep = (): void => undefined;
    const lateStep = new Promise<void>((resolve) => {
      releaseLateStep = resolve;
    });
    let confirmLateCommit = (): void => undefined;
    const lateCommit = new Promise<void>((resolve) => {
      confirmLateCommit = resolve;
    });

    await expect(
      runWorkspaceOperation(
        state.session,
        operationOptions({
          beforeActiveCommit: (activeState) =>
            activeState === 'prepared-bound' ? lateStep : Promise.resolve(),
          afterActiveCommitted: (activeState) => {
            if (activeState === 'prepared-bound') confirmLateCommit();
          },
        }),
        (operation) =>
          runDarkPosixSupervisedOperation(operation, {
            target: target(marker, state.workspace),
            timeouts: {
              handshakeMs: 1000,
              termMs: 50,
              killMs: 300,
              ackMs: 100,
              pollMs: 10,
            },
          }),
      ),
    ).rejects.toMatchObject({
      code: 'isolated',
      message: expect.stringMatching(/prepare binding deadline/u),
    });

    expect(performance.now() - startedAt).toBeLessThan(1500);
    expect(state.session.state).toBe('isolated');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(operationPath(state.workspace))).toBe(true);
    expect(existsSync(join(operationPath(state.workspace), PRESTART_ABORT_FILE))).toBe(false);
    expect(existsSync(join(operationPath(state.workspace), QUARANTINE_FILE))).toBe(false);
    releaseLateStep();
    await lateCommit;
    expect(state.session.state).toBe('isolated');
    expect(existsSync(marker)).toBe(false);
    expect(existsSync(operationPath(state.workspace))).toBe(true);
    expect(
      readdirSync(join(state.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, 'settled-operations')),
    ).toHaveLength(0);
    await expect(state.session.close()).rejects.toMatchObject({ code: 'isolated' });
  });

  it('bounds a live supervisor that never emits DRAINED and preserves the write fence', async () => {
    const state = await setup();
    let pgid: number | undefined;
    let armedAt: number | undefined;
    let failedAt: number | undefined;

    try {
      await expect(
        runWorkspaceOperation(state.session, operationOptions(), (operation) =>
          runDarkPosixSupervisedOperation(operation, {
            target: {
              executable: process.execPath,
              args: ['-e', 'setInterval(() => {}, 1000)'],
              cwd: state.workspace,
              environment: [],
            },
            commandTimeoutMs: 50,
            timeouts: { handshakeMs: 2000, termMs: 50, killMs: 300, ackMs: 100, pollMs: 10 },
            hooks: {
              onArmed: ({ supervisorPid, containment }) => {
                if (containment.platform === 'posix-process-group-v1') pgid = containment.pgid;
                armedAt = performance.now();
                process.kill(supervisorPid, 'SIGSTOP');
              },
            },
          }),
        ),
      ).rejects.toMatchObject({
        code: 'isolated',
        message: expect.stringMatching(/termination and drain|deadline/u),
      });
      failedAt = performance.now();
    } finally {
      if (pgid !== undefined) {
        try {
          process.kill(-pgid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        expect(await waitForPosixProcessGroupEmpty(pgid, 3000, 10)).toBe(true);
      }
    }

    expect(armedAt).toBeTypeOf('number');
    if (armedAt === undefined) throw new Error('POSIX supervisor never reached ARMED');
    expect(failedAt).toBeTypeOf('number');
    expect(failedAt - armedAt).toBeLessThan(1000);
    const active = operationPath(state.workspace);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(join(active, DRAINED_RECEIPT_FILE))).toBe(false);
    const quarantinePath = join(active, QUARANTINE_FILE);
    if (existsSync(quarantinePath)) {
      expect(parseQuarantineRecord(readFileSync(quarantinePath))).toMatchObject({
        ownerId: OWNER_ID,
        operationId: OPERATION_ID,
        activeChildDigest: digestBytes(readFileSync(join(active, ACTIVE_CHILD_FILE))),
        delegatedBaselineDigest: digestBytes(readFileSync(join(active, DELEGATED_BASELINE_FILE))),
        reason: 'containment-unconfirmed',
        creator: { kind: 'owner', id: OWNER_ID },
      });
    }
    expect(state.session.state).toBe('isolated');
    await expect(state.session.close()).rejects.toMatchObject({ code: 'isolated' });
  });

  it('bounds ACK/final exit when a drained supervisor remains alive', async () => {
    const state = await setup();
    let drainedAt: number | undefined;
    let drainedSupervisorPid: number | undefined;
    let failure: unknown;

    try {
      await runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: {
            executable: process.execPath,
            args: ['-e', 'process.exit(0)'],
            cwd: state.workspace,
            environment: [],
          },
          commandTimeoutMs: 2000,
          timeouts: { handshakeMs: 2000, termMs: 50, killMs: 300, ackMs: 1000, pollMs: 10 },
          hooks: {
            onDrained: ({ supervisorPid }) => {
              drainedAt = performance.now();
              drainedSupervisorPid = supervisorPid;
              process.kill(supervisorPid, 'SIGSTOP');
            },
          },
        }),
      );
    } catch (error) {
      failure = error;
    }
    const failedAt = performance.now();

    expect(drainedAt).toBeTypeOf('number');
    expect(drainedSupervisorPid).toBeTypeOf('number');
    if (drainedAt === undefined || drainedSupervisorPid === undefined) {
      throw new Error('POSIX supervisor never reached the onDrained fault injection');
    }
    expect(drainedSupervisorPid).toBeGreaterThan(0);
    if (!(failure instanceof WorkspaceSafetyError)) {
      if (failure instanceof Error) throw failure;
      throw new Error(
        failure === undefined
          ? 'POSIX closeout unexpectedly completed after SIGSTOP'
          : 'POSIX closeout rejected with a non-Error value',
      );
    }
    expect(failure.code).toBe('isolated');
    expect(failure.message, `完整 POSIX closeout 错误：${failure.message}`).toMatch(
      /post-drain|ACK|exit/u,
    );
    expect(failedAt - drainedAt).toBeLessThan(1500);
    const active = operationPath(state.workspace);
    expect(existsSync(join(active, DRAINED_RECEIPT_FILE))).toBe(true);
    expect(existsSync(join(active, QUARANTINE_FILE))).toBe(false);
    expect(state.session.state).toBe('isolated');
    await expect(state.session.close()).rejects.toMatchObject({ code: 'isolated' });
  });

  it('fails within the shared closeout deadline when escaped output never reaches EOF', async () => {
    const state = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-output-deadline-'));
    roots.push(controlRoot);
    const escapedPidPath = join(controlRoot, 'escaped.pid');
    const escapedSource = [
      "const {spawn}=require('node:child_process');",
      "const fs=require('node:fs');",
      `const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',1,'ignore']});`,
      `fs.writeFileSync(${JSON.stringify(escapedPidPath)},String(child.pid));`,
      'child.unref();',
    ].join('');
    let closeoutStartedAt: number | undefined;
    let failedAt: number | undefined;

    try {
      await expect(
        runWorkspaceOperation(state.session, operationOptions(), (operation) =>
          runDarkPosixSupervisedOperation(operation, {
            target: {
              executable: process.execPath,
              args: ['-e', escapedSource],
              cwd: state.workspace,
              environment: [],
            },
            commandTimeoutMs: 2000,
            timeouts: {
              handshakeMs: 2000,
              naturalDrainMs: 50,
              termMs: 50,
              killMs: 300,
              ackMs: 100,
              pollMs: 10,
            },
            hooks: {
              onRootResult: () => {
                closeoutStartedAt = performance.now();
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'isolated' });
      failedAt = performance.now();
    } finally {
      if (existsSync(escapedPidPath)) {
        const escapedPid = Number(readFileSync(escapedPidPath, 'utf8'));
        if (Number.isSafeInteger(escapedPid) && escapedPid > 0) {
          try {
            process.kill(escapedPid, 'SIGKILL');
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
          expect(await waitForPosixProcessGroupEmpty(escapedPid, 3000, 10)).toBe(true);
        }
      }
    }

    expect(closeoutStartedAt).toBeTypeOf('number');
    if (closeoutStartedAt === undefined) throw new Error('POSIX supervisor never reported RESULT');
    expect(failedAt).toBeTypeOf('number');
    expect(failedAt - closeoutStartedAt).toBeLessThan(1500);
    const active = operationPath(state.workspace);
    expect(existsSync(active)).toBe(true);
    expect(existsSync(join(active, DRAINED_RECEIPT_FILE))).toBe(false);
    const quarantinePath = join(active, QUARANTINE_FILE);
    if (existsSync(quarantinePath)) {
      expect(parseQuarantineRecord(readFileSync(quarantinePath))).toMatchObject({
        ownerId: OWNER_ID,
        operationId: OPERATION_ID,
        activeChildDigest: digestBytes(readFileSync(join(active, ACTIVE_CHILD_FILE))),
        delegatedBaselineDigest: digestBytes(readFileSync(join(active, DELEGATED_BASELINE_FILE))),
        reason: 'operation-proof-missing',
        creator: { kind: 'owner', id: OWNER_ID },
      });
    }
    expect(state.session.state).toBe('isolated');
    await expect(state.session.close()).rejects.toMatchObject({ code: 'isolated' });
  });

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

  it.each([
    ['process-group', 'containment-unconfirmed'],
    ['opaque-runner', 'operation-proof-missing'],
  ] as const)(
    'uses %s quarantine semantics after START when termination acknowledgement becomes uncertain',
    async (posixProcessDomain, expectedReason) => {
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
            posixProcessDomain,
            termination: { signal: controller.signal, reason: 'user-interrupt' },
            timeouts: { termMs: 100, killMs: 3000, pollMs: 20 },
            hooks: {
              onArmed: ({ containment }) => {
                if (containment.platform === 'posix-process-group-v1') pgid = containment.pgid;
              },
              onStarted: () => {
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
      ).toBe(expectedReason);
      if (pgid !== undefined) {
        expect(await waitForPosixProcessGroupEmpty(pgid, 5000, 20)).toBe(true);
      }
    },
  );
});
