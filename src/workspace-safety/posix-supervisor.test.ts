import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { once } from 'node:events';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  recordPosixTestContainment,
  terminateRecordedPosixTestGroup,
  type RecordedPosixTestGroup,
} from './__fixtures__/posix-test-process-group.js';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from './workspace-authority-test-seam.js';
import { createIdentityProbe } from './identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from './workspace-authority-test-seam.js';
import { DRAINED_RECEIPT_FILE } from './operation.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from './operation-authority-test-seam.js';
import {
  inspectPosixProcessPlacement,
  probePosixProcessGroup,
  waitForPosixProcessGroupEmpty,
} from './posix-containment.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from './posix-supervisor.js';
import { parseQuarantineRecord, QUARANTINE_FILE } from './quarantine.js';
import { createWorkspaceSession, type WorkspaceSession } from './session.js';
import { parseDrainedReceipt, type ContainmentDescriptor } from './supervisor-protocol.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from './types.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000010';
const OPERATION_ID = '00000000-0000-4000-8000-000000000020';
const roots: string[] = [];
const groups = new Map<number, RecordedPosixTestGroup>();
const workers = new Set<ChildProcessWithoutNullStreams>();

interface Setup {
  readonly workspace: string;
  readonly session: WorkspaceSession;
}

interface PosixFdInventory {
  readonly schemaVersion: 1;
  readonly pid: number;
  readonly processConnected: boolean;
  readonly processChannelFd: number | null;
  readonly nodeChannelFd: string | null;
  readonly descriptorSource: '/proc/self/fd' | '/dev/fd';
  readonly descriptors: readonly {
    readonly descriptor: number;
    readonly type: 'socket' | 'fifo' | 'character' | 'block' | 'directory' | 'file' | 'other';
  }[];
}

async function setup(): Promise<Setup> {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-posix-supervisor-'));
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
  return {
    workspace,
    session: createWorkspaceSession(lease),
  };
}

function operationOptions() {
  return {
    operationId: OPERATION_ID,
    kind: 'final-review' as const,
    delegation: 'read-only-v1' as const,
    platform: 'posix-process-group-v1' as const,
    helperBytes: readDarkPosixHelperBundle(),
  };
}

function target(source: string, cwd: string) {
  return {
    executable: process.execPath,
    args: ['-e', source],
    cwd,
    environment: [] as const,
  };
}

function operationPath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
}

async function waitUntil(predicate: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function readFdInventory(path: string): PosixFdInventory {
  return JSON.parse(readFileSync(path, 'utf8')) as PosixFdInventory;
}

function trackGroup(containment: ContainmentDescriptor): RecordedPosixTestGroup {
  const record = recordPosixTestContainment(containment);
  groups.set(record.pgid, record);
  return record;
}

afterEach(async () => {
  const liveWorkers = [...workers].filter(
    (worker) => worker.exitCode === null && worker.signalCode === null,
  );
  for (const worker of liveWorkers) worker.kill('SIGKILL');
  await Promise.allSettled(liveWorkers.map((worker) => once(worker, 'exit')));
  workers.clear();
  for (const record of groups.values()) {
    try {
      await terminateRecordedPosixTestGroup(record, {
        termTimeoutMs: 100,
        killTimeoutMs: 3000,
        pollIntervalMs: 20,
      });
    } catch {
      // Preserve the original test failure while still attempting every cleanup.
    }
  }
  groups.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(process.platform !== 'win32')('dark POSIX supervisor integration', () => {
  it('detects a deliberate IPC control descriptor in the inventory positive control', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-fd-positive-'));
    roots.push(controlRoot);
    const inventoryPath = join(controlRoot, 'inventory.json');
    const inventoryTarget = fileURLToPath(
      new URL('./__fixtures__/posix-fd-inventory-target.mjs', import.meta.url),
    );
    const child = spawn(process.execPath, [inventoryTarget, inventoryPath], {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    });
    let stderr = '';
    child.stderr?.setEncoding('utf8');
    child.stderr?.on('data', (chunk: string) => {
      stderr += chunk;
    });
    try {
      await waitUntil(() => existsSync(inventoryPath));
      const inventory = readFdInventory(inventoryPath);
      expect(inventory.processConnected).toBe(true);
      expect(inventory.processChannelFd).toBeGreaterThan(2);
      expect(inventory.descriptors).toContainEqual({
        descriptor: inventory.processChannelFd,
        type: 'socket',
      });
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const exited = once(child, 'exit');
        child.kill('SIGTERM');
        await exited;
      }
    }
    expect(stderr).toBe('');
  });

  it('keeps the target behind START and completes only after receipt, ACK, EOF, and exact process death', async () => {
    const marker = 'target-started.txt';
    const setupState = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-control-'));
    roots.push(controlRoot);
    const markerPath = join(controlRoot, marker);
    let drainedSupervisorWasAlive = false;

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            [
              "const fs = require('node:fs');",
              `fs.writeFileSync(${JSON.stringify(markerPath)}, 'started');`,
              "process.stdout.write('stdout-complete');",
              "process.stderr.write('stderr-complete');",
            ].join(''),
            setupState.workspace,
          ),
          timeouts: { naturalDrainMs: 500, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              expect(existsSync(markerPath)).toBe(false);
              trackGroup(containment);
            },
            onStarted: async () => waitUntil(() => existsSync(markerPath)),
            onDrained: ({ supervisorPid }) => {
              expect(() => process.kill(supervisorPid, 0)).not.toThrow();
              drainedSupervisorWasAlive = true;
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(drainedSupervisorWasAlive).toBe(true);
    expect(outcome.verdict).toBe('completed');
    expect(outcome.leftover).toBe(false);
    expect(outcome.stdout.toString('utf8')).toBe('stdout-complete');
    expect(outcome.stderr.toString('utf8')).toBe('stderr-complete');
    expect(outcome.receipt.proof).toBe('posix-group-empty-and-pipes-eof-v1');
    expect(outcome.receipt.drainReason).toBe('natural');
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    expect(existsSync(outcome.settledPath)).toBe(true);
    expect(existsSync(operationPath(setupState.workspace))).toBe(false);
    await setupState.session.close();
  }, 15_000);

  it('preserves large stdout and stderr across multiple bounded OUTPUT events', async () => {
    const setupState = await setup();
    const stdoutBytes = 96 * 1024 + 17;
    const stderrBytes = 80 * 1024 + 31;

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            `process.stdout.write(Buffer.alloc(${stdoutBytes},120));process.stderr.write(Buffer.alloc(${stderrBytes},121));`,
            setupState.workspace,
          ),
          timeouts: { naturalDrainMs: 500, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome.verdict).toBe('completed');
    expect(outcome.stdout).toEqual(Buffer.alloc(stdoutBytes, 120));
    expect(outcome.stderr).toEqual(Buffer.alloc(stderrBytes, 121));
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 20_000);

  it('fails closed and drains containment when aggregate output exceeds 16 MiB', async () => {
    const setupState = await setup();
    let containment: ContainmentDescriptor | undefined;
    const bytesOverBudget = 16 * 1024 * 1024 + 1;

    await expect(
      runWorkspaceOperation(setupState.session, operationOptions(), async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            `process.stdout.write(Buffer.alloc(${bytesOverBudget},122));`,
            setupState.workspace,
          ),
          timeouts: { naturalDrainMs: 500, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment: armed }) => {
              containment = armed;
              trackGroup(armed);
            },
          },
        }),
      ),
    ).rejects.toMatchObject({
      code: 'isolated',
      message: expect.stringMatching(/output exceeded the bound/u),
    });

    if (containment?.platform !== 'posix-process-group-v1') {
      throw new Error('POSIX containment was not observed');
    }
    expect(await waitForPosixProcessGroupEmpty(containment.pgid, 10_000, 20)).toBe(true);
    groups.delete(containment.pgid);
  }, 30_000);

  it('treats root exit with a live grandchild as leftover and waits for inherited output EOF', async () => {
    const setupState = await setup();
    const grandchild = [
      "process.on('SIGTERM', () => {});",
      "process.stdout.write('grandchild-alive\\n');",
      'setInterval(() => {}, 1000);',
    ].join('');
    const root = [
      "const { spawn } = require('node:child_process');",
      `spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], { stdio: ['ignore', 1, 2] });`,
      "process.stdout.write('root-exiting\\n');",
      'setTimeout(() => process.exit(0), 50);',
    ].join('');

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(root, setupState.workspace),
          timeouts: { naturalDrainMs: 100, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome.verdict).toBe('process-tree-not-empty');
    expect(outcome.leftover).toBe(true);
    expect(outcome.receipt.drainReason).toBe('process-tree-not-empty');
    expect(outcome.stdout.toString('utf8')).toContain('root-exiting');
    expect(outcome.stdout.toString('utf8')).toContain('grandchild-alive');
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 15_000);

  it('independently re-reads canonical armed bytes before START and leaves target at zero execution on mismatch', async () => {
    const marker = 'must-not-run.txt';
    const setupState = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-control-'));
    roots.push(controlRoot);
    const markerPath = join(controlRoot, marker);
    let pgid: number | undefined;

    await expect(
      runWorkspaceOperation(setupState.session, operationOptions(), async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
            setupState.workspace,
          ),
          timeouts: { naturalDrainMs: 100, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              if (containment.platform === 'posix-process-group-v1') {
                pgid = containment.pgid;
                trackGroup(containment);
              }
              const activePath = join(operationPath(setupState.workspace), 'active-child.json');
              writeFileSync(activePath, `${readFileSync(activePath, 'utf8')}\n`);
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid|isolated/) });

    expect(existsSync(markerPath)).toBe(false);
    expect(existsSync(join(operationPath(setupState.workspace), DRAINED_RECEIPT_FILE))).toBe(false);
    expect(existsSync(join(operationPath(setupState.workspace), QUARANTINE_FILE))).toBe(false);
    if (pgid !== undefined) {
      await waitForPosixProcessGroupEmpty(pgid, 3000, 20);
      groups.delete(pgid);
    }
  }, 15_000);

  it('lets TERMINATE win after armed and proves that the target never started', async () => {
    const setupState = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-control-'));
    roots.push(controlRoot);
    const markerPath = join(controlRoot, 'must-stay-absent.txt');
    const controller = new AbortController();

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'ran')`,
            setupState.workspace,
          ),
          termination: { signal: controller.signal, reason: 'user-interrupt' },
          timeouts: { naturalDrainMs: 100, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
              controller.abort();
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(existsSync(markerPath)).toBe(false);
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
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 15_000);

  it('times out and drains a confirmed-live stubborn root and grandchild', async () => {
    const setupState = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-timeout-'));
    roots.push(controlRoot);
    const grandchildReady = join(controlRoot, 'grandchild-ready');
    const stubbornGrandchild = [
      "const fs = require('node:fs');",
      "process.on('SIGTERM', () => {});",
      `fs.writeFileSync(${JSON.stringify(grandchildReady)}, 'ready');`,
      'setInterval(() => {}, 1000);',
    ].join('');
    const stubbornRoot = [
      "const { spawn } = require('node:child_process');",
      "process.on('SIGTERM', () => {});",
      `spawn(process.execPath, ['-e', ${JSON.stringify(stubbornGrandchild)}], { stdio: ['ignore', 1, 2] });`,
      "process.stdout.write('stubborn-started');",
      'setInterval(() => {}, 1000);',
    ].join('');

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(stubbornRoot, setupState.workspace),
          commandTimeoutMs: 5000,
          timeouts: { naturalDrainMs: 100, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
            onStarted: async () => {
              await waitUntil(() => existsSync(grandchildReady), 4000);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome.verdict).toBe('terminated');
    expect(outcome.terminationReason).toBe('timeout');
    expect(outcome.leftover).toBe(false);
    expect(readFileSync(grandchildReady, 'utf8')).toBe('ready');
    expect(outcome.stdout.toString('utf8')).toContain('stubborn-started');
    expect(outcome.receipt.drainReason).toBe('timeout');
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 20_000);

  it.each([
    ['SIGINT', 130],
    ['SIGTERM', 143],
  ] as const)(
    'turns a real parent %s into a complete receipt/ACK/empty-group close before exit %i',
    async (signal, expectedExitCode) => {
      const workspace = mkdtempSync(join(tmpdir(), 'coding-x-posix-signal-'));
      roots.push(workspace);
      const workerPath = fileURLToPath(
        new URL('./__fixtures__/posix-signal-worker.ts', import.meta.url),
      );
      const worker = spawn(process.execPath, ['--import', 'tsx', workerPath, workspace, signal], {
        detached: true,
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      });
      workers.add(worker);
      let stdout = '';
      let stderr = '';
      worker.stdout.setEncoding('utf8');
      worker.stderr.setEncoding('utf8');
      worker.stdout.on('data', (chunk: string) => {
        stdout += chunk;
      });
      worker.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      await waitUntil(() => stdout.includes('"type":"ready"'));
      const ready = JSON.parse(stdout.trim().split('\n')[0]) as {
        supervisorPid: number;
        pgid: number;
        launcherPid: number;
        launcherIdentity: string;
      };
      trackGroup({
        platform: 'posix-process-group-v1',
        pgid: ready.pgid,
        launcherPid: ready.launcherPid,
        launcherIdentity: ready.launcherIdentity,
      });
      if (worker.pid === undefined) throw new Error('signal worker pid is unavailable');
      const workerPlacement = inspectPosixProcessPlacement(worker.pid);
      expect(workerPlacement).toMatchObject({ pgid: worker.pid, sessionId: worker.pid });
      process.kill(-worker.pid, signal);
      const [code, exitSignal] = (await once(worker, 'exit')) as [
        number | null,
        NodeJS.Signals | null,
      ];
      workers.delete(worker);

      expect(code).toBe(expectedExitCode);
      expect(exitSignal).toBeNull();
      const lines = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const finished = lines.find((line) => line.type === 'finished');
      expect(finished).toMatchObject({
        supervisorPid: ready.supervisorPid,
        pgid: ready.pgid,
        verdict: 'terminated',
        terminationReason: 'user-interrupt',
        proof: 'posix-group-empty-and-pipes-eof-v1',
        drainReason: 'user-interrupt',
        settledExistedBeforeClose: true,
      });
      expect(existsSync(String(finished?.settledPath))).toBe(false);
      expect(probePosixProcessGroup(ready.pgid)).toBe('empty');
      groups.delete(ready.pgid);
      expect(stderr).toBe('');
    },
    20_000,
  );

  it('never reports completion when the supervisor is hard-killed before receipt', async () => {
    const setupState = await setup();
    let containment: ContainmentDescriptor | undefined;
    const root = 'setTimeout(() => process.exit(0), 30);';

    await expect(
      runWorkspaceOperation(setupState.session, operationOptions(), async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(root, setupState.workspace),
          timeouts: { naturalDrainMs: 1000, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: (facts) => {
              containment = facts.containment;
              trackGroup(facts.containment);
            },
            onRootResult: ({ supervisorPid }) => {
              process.kill(supervisorPid, 'SIGKILL');
            },
          },
        }),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid|isolated/) });

    expect(existsSync(join(operationPath(setupState.workspace), DRAINED_RECEIPT_FILE))).toBe(false);
    expect(existsSync(operationPath(setupState.workspace))).toBe(true);
    expect(
      parseQuarantineRecord(
        readFileSync(join(operationPath(setupState.workspace), QUARANTINE_FILE)),
      ).reason,
    ).toBe('operation-proof-missing');
    if (containment?.platform === 'posix-process-group-v1') {
      expect(await waitForPosixProcessGroupEmpty(containment.pgid, 3000, 20)).toBe(true);
      groups.delete(containment.pgid);
    }
  }, 15_000);

  it('lets the detached supervisor drain and persist a bound receipt after its parent is SIGKILLed', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-posix-parent-crash-'));
    roots.push(workspace);
    const workerPath = fileURLToPath(
      new URL('./__fixtures__/posix-parent-worker.ts', import.meta.url),
    );
    const worker = spawn(process.execPath, ['--import', 'tsx', workerPath, workspace], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
    });
    workers.add(worker);
    let stdout = '';
    let stderr = '';
    worker.stdout.setEncoding('utf8');
    worker.stderr.setEncoding('utf8');
    worker.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    worker.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    await waitUntil(() => stdout.includes('\n'));
    const line = stdout.slice(0, stdout.indexOf('\n'));
    const facts = JSON.parse(line) as {
      supervisorPid: number;
      targetPid: number;
      pgid: number;
      launcherPid: number;
      launcherIdentity: string;
      markerPath: string;
      inventoryPath: string;
    };
    roots.push(dirname(facts.markerPath));
    trackGroup({
      platform: 'posix-process-group-v1',
      pgid: facts.pgid,
      launcherPid: facts.launcherPid,
      launcherIdentity: facts.launcherIdentity,
    });
    await waitUntil(() => existsSync(facts.markerPath));
    const inventory = readFdInventory(facts.inventoryPath);
    expect(inventory).toMatchObject({
      schemaVersion: 1,
      pid: facts.targetPid,
      processConnected: false,
      processChannelFd: null,
      nodeChannelFd: null,
    });
    expect(inventory.descriptors.map((entry) => entry.descriptor)).toEqual(
      expect.arrayContaining([0, 1, 2]),
    );
    expect(
      inventory.descriptors
        .filter((entry) => entry.type === 'socket')
        .every((entry) => entry.descriptor === 1 || entry.descriptor === 2),
    ).toBe(true);
    worker.kill('SIGKILL');
    await once(worker, 'exit');
    workers.delete(worker);

    const receiptPath = join(operationPath(workspace), DRAINED_RECEIPT_FILE);
    await waitUntil(() => existsSync(receiptPath), 10_000);
    await waitUntil(() => {
      try {
        process.kill(facts.supervisorPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    }, 10_000);
    expect(await waitForPosixProcessGroupEmpty(facts.pgid, 5000, 20)).toBe(true);
    groups.delete(facts.pgid);
    expect(parseDrainedReceipt(readFileSync(receiptPath))).toMatchObject({
      proof: 'posix-group-empty-and-pipes-eof-v1',
      drainReason: 'parent-shutdown',
    });
    expect(stderr).toBe('');
  }, 30_000);
});
