import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIdentityProbe } from './identity.js';
import {
  DRAINED_RECEIPT_FILE,
  PRESTART_ABORT_FILE,
  parsePrestartAbortRecord,
} from './operation.js';
import {
  runWorkspaceOperationWithAuthority as runWorkspaceOperation,
  type OperationHooksWithAuthority as OperationHooks,
} from './operation-authority-test-seam.js';
import { parseQuarantineRecord, QUARANTINE_FILE } from './quarantine.js';
import { createWorkspaceSession, type WorkspaceSession } from './session.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from './types.js';
import {
  readDarkWindowsHelperBundle,
  runDarkWindowsSupervisedOperation,
} from './windows-supervisor.js';
import { windowsTestTargetEnvironment } from './windows-test-environment.js';
import {
  acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease,
  bootstrapWorkspaceWithAuthority as bootstrapWorkspace,
} from './workspace-authority-test-seam.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000010';
const OPERATION_ID = '00000000-0000-4000-8000-000000000020';
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function setup(): Promise<{ workspace: string; session: WorkspaceSession }> {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-windows-integration-'));
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
    platform: 'windows-job-v1' as const,
    helperBytes: readDarkWindowsHelperBundle(),
    hooks,
  };
}

function target(source: string, cwd: string) {
  return {
    executable: process.execPath,
    args: ['-e', source],
    cwd,
    environment: windowsTestTargetEnvironment(),
  };
}

function operationPath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
}

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;

windowsOnly('Windows production operation executor', { timeout: 90_000 }, () => {
  it.each([
    ['completed', 0],
    ['root-failed', 7],
  ] as const)(
    'settles a fully bound %s result only after ACK and exact death',
    async (verdict, code) => {
      const state = await setup();
      let drainedSupervisorWasAlive = false;
      const stdoutBytes = 96 * 1024 + 17;
      const stderrBytes = 80 * 1024 + 31;

      const outcome = await runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkWindowsSupervisedOperation(operation, {
          target: target(
            `process.stdout.write(Buffer.alloc(${stdoutBytes},120));process.stderr.write(Buffer.alloc(${stderrBytes},121));process.exit(${code});`,
            state.workspace,
          ),
          hooks: {
            onDrained: ({ supervisorPid }) => {
              expect(() => process.kill(supervisorPid, 0)).not.toThrow();
              drainedSupervisorWasAlive = true;
            },
          },
        }),
      );

      expect(drainedSupervisorWasAlive).toBe(true);
      expect(outcome.verdict).toBe(verdict);
      expect(outcome.code).toBe(code);
      expect(outcome.stdout).toEqual(Buffer.alloc(stdoutBytes, 120));
      expect(outcome.stderr).toEqual(Buffer.alloc(stderrBytes, 121));
      expect(outcome.receipt).toMatchObject({
        proof: 'windows-job-zero-and-pipes-eof-v1',
        drainReason: 'natural',
      });
      expect(existsSync(outcome.settledPath)).toBe(true);
      expect(existsSync(operationPath(state.workspace))).toBe(false);
      await state.session.close();
    },
  );

  it('lets termination win while the target is still suspended', async () => {
    const state = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-windows-control-'));
    roots.push(controlRoot);
    const marker = join(controlRoot, 'must-not-run.txt');
    const controller = new AbortController();

    const outcome = await runWorkspaceOperation(state.session, operationOptions(), (operation) =>
      runDarkWindowsSupervisedOperation(operation, {
        target: target(
          `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
          state.workspace,
        ),
        termination: { signal: controller.signal, reason: 'user-interrupt' },
        hooks: { onArmed: () => controller.abort() },
      }),
    );

    expect(existsSync(marker)).toBe(false);
    expect(outcome).toMatchObject({
      verdict: 'terminated',
      terminationReason: 'user-interrupt',
      code: null,
      signal: null,
      leftover: false,
    });
    expect(outcome.receipt).toMatchObject({
      proof: 'never-started-containment-empty-v1',
      drainReason: 'user-interrupt',
    });
    await state.session.close();
  });

  it('uses real ABORT/PRESTART_DRAINED after prepared-bound commit failure', async () => {
    const state = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-windows-control-'));
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
          runDarkWindowsSupervisedOperation(operation, {
            target: target(
              `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
              state.workspace,
            ),
          }),
      ),
    ).rejects.toThrow(/bound test stop/u);

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(operationPath(state.workspace))).toBe(false);
    const settledRoot = join(
      state.workspace,
      PROTOCOL_ROOT_DIR,
      ACTIVE_LEASE_DIR,
      'settled-operations',
    );
    const settled = readdirSync(settledRoot);
    expect(settled).toHaveLength(1);
    expect(
      parsePrestartAbortRecord(readFileSync(join(settledRoot, settled[0], PRESTART_ABORT_FILE)))
        .proof,
    ).toBe('supervisor-prestart-empty-v1');
    await state.session.close();
  });

  it('times out and drains a stubborn root plus descendant', async () => {
    const state = await setup();
    const descendant = 'setInterval(() => {}, 1000)';
    const source = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});`,
      "process.stdout.write('stubborn-started');",
      'setInterval(() => {}, 1000);',
    ].join('');

    const outcome = await runWorkspaceOperation(state.session, operationOptions(), (operation) =>
      runDarkWindowsSupervisedOperation(operation, {
        target: target(source, state.workspace),
        commandTimeoutMs: 500,
        timeouts: { terminateMs: 5000, pollMs: 20 },
      }),
    );

    expect(outcome).toMatchObject({
      verdict: 'terminated',
      terminationReason: 'timeout',
      leftover: false,
    });
    expect(outcome.stdout.toString('utf8')).toContain('stubborn-started');
    expect(outcome.receipt).toMatchObject({
      proof: 'windows-job-zero-and-pipes-eof-v1',
      drainReason: 'timeout',
    });
    await state.session.close();
  });

  it('classifies a live descendant after root exit as leftover, then proves the Job empty', async () => {
    const state = await setup();
    const descendant = "process.stdout.write('descendant-alive\\n');setInterval(() => {},1000);";
    const source = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});`,
      "process.stdout.write('root-exiting\\n');",
      'setTimeout(() => process.exit(0),50);',
    ].join('');

    const outcome = await runWorkspaceOperation(state.session, operationOptions(), (operation) =>
      runDarkWindowsSupervisedOperation(operation, {
        target: target(source, state.workspace),
        timeouts: { naturalDrainMs: 100, terminateMs: 5000, pollMs: 20 },
      }),
    );

    expect(outcome.verdict).toBe('process-tree-not-empty');
    expect(outcome.leftover).toBe(true);
    expect(outcome.receipt.drainReason).toBe('process-tree-not-empty');
    expect(outcome.stdout.toString('utf8')).toContain('root-exiting');
    expect(outcome.stdout.toString('utf8')).toContain('descendant-alive');
    await state.session.close();
  });

  it('fails closed without settling when the supervisor dies before installing a receipt', async () => {
    const state = await setup();

    await expect(
      runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkWindowsSupervisedOperation(operation, {
          target: target('process.exit(0)', state.workspace),
          hooks: {
            onRootResult: ({ supervisorPid }) => {
              process.kill(supervisorPid, 'SIGKILL');
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid|isolated/) });

    expect(existsSync(operationPath(state.workspace))).toBe(true);
    expect(existsSync(join(operationPath(state.workspace), DRAINED_RECEIPT_FILE))).toBe(false);
    expect(
      parseQuarantineRecord(readFileSync(join(operationPath(state.workspace), QUARANTINE_FILE)))
        .reason,
    ).toBe('operation-proof-missing');
  });

  it('fails closed when aggregate target output exceeds the total budget', async () => {
    const state = await setup();

    await expect(
      runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkWindowsSupervisedOperation(operation, {
          target: target(
            `process.stdout.write(Buffer.alloc(${16 * 1024 * 1024 + 1},122));`,
            state.workspace,
          ),
        }),
      ),
    ).rejects.toMatchObject({
      code: 'isolated',
      message: expect.stringMatching(/output exceeded the total bound/i),
    });
    expect(existsSync(operationPath(state.workspace))).toBe(true);
  });

  it('re-reads canonical armed authority before START and keeps the target at zero execution', async () => {
    const state = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-windows-control-'));
    roots.push(controlRoot);
    const marker = join(controlRoot, 'must-not-run.txt');

    await expect(
      runWorkspaceOperation(state.session, operationOptions(), (operation) =>
        runDarkWindowsSupervisedOperation(operation, {
          target: target(
            `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
            state.workspace,
          ),
          hooks: {
            onArmed: () => {
              const active = join(operationPath(state.workspace), 'active-child.json');
              writeFileSync(active, `${readFileSync(active, 'utf8')}\n`);
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid|isolated/) });

    expect(existsSync(marker)).toBe(false);
    expect(existsSync(operationPath(state.workspace))).toBe(true);
    expect(existsSync(join(operationPath(state.workspace), QUARANTINE_FILE))).toBe(false);
  });
});
