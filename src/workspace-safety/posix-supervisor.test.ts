import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process';
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
import { createIdentityProbe, createSystemIdentityAdapter } from './identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from './workspace-authority-test-seam.js';
import { DRAINED_RECEIPT_FILE } from './operation.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from './operation-authority-test-seam.js';
import {
  inspectPosixProcessPlacement,
  probePosixProcessGroup,
  waitForPosixProcessGroupEmpty,
} from './posix-containment.js';
import {
  parsePosixSupervisorEventControlled,
  readDarkPosixHelperBundle,
  runDarkPosixSupervisedOperation,
} from './posix-supervisor.js';
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

function processIsGoneOrZombie(pid: number, expectedIdentity: string): boolean {
  const observed = createSystemIdentityAdapter().readProcessIdentity(pid);
  if (observed.status !== 'found' || observed.value !== expectedIdentity) return true;
  const state = spawnSync('/bin/ps', ['-p', String(pid), '-o', 'state='], {
    encoding: 'utf8',
    env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
    timeout: 1000,
  });
  return !state.error && state.status === 0 && state.stdout.trimStart().startsWith('Z');
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
  it.each([
    ['rejects neither code nor signal', null, null, false],
    ['rejects both code and signal', 0, 'SIGTERM', false],
    ['accepts a numeric exit', 23, null, true],
    ['accepts a signal exit', null, 'SIGTERM', true],
  ] as const)('%s in a RESULT event', (_label, code, signal, accepted) => {
    const event = { schemaVersion: 1, type: 'RESULT', code, signal };
    if (!accepted) {
      expect(() => parsePosixSupervisorEventControlled(event)).toThrow(/exactly one/u);
      return;
    }
    expect(parsePosixSupervisorEventControlled(event)).toEqual({ type: 'RESULT', code, signal });
  });

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

  it('performs an immediate natural-drain observation when the configured grace is zero', async () => {
    const setupState = await setup();

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target('process.exit(0)', setupState.workspace),
          commandTimeoutMs: 2000,
          timeouts: {
            naturalDrainMs: 0,
            termMs: 100,
            killMs: 3000,
            ackMs: 1000,
            pollMs: 20,
          },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome).toMatchObject({
      verdict: 'completed',
      leftover: false,
      receipt: { drainReason: 'natural' },
    });
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
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

  it('streams multi-MiB stdout and stderr through a slow consumer without loss or duplication', async () => {
    const setupState = await setup();
    const stdoutBytes = 3 * 1024 * 1024 + 17;
    const stderrBytes = 2 * 1024 * 1024 + 31;
    const observed = { stdout: [] as Buffer[], stderr: [] as Buffer[] };
    const expectedStdout = Buffer.concat([
      ...Array.from({ length: 384 }, (_, index) => Buffer.alloc(8192, index % 251)),
      Buffer.alloc(17, 384 % 251),
    ]);
    const expectedStderr = Buffer.concat([
      ...Array.from({ length: 256 }, (_, index) => Buffer.alloc(8192, (index + 73) % 251)),
      Buffer.alloc(31, (256 + 73) % 251),
    ]);

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            [
              'for(let i=0;i<384;i+=1)process.stdout.write(Buffer.alloc(8192,i%251));',
              'process.stdout.write(Buffer.alloc(17,384%251));',
              'for(let i=0;i<256;i+=1)process.stderr.write(Buffer.alloc(8192,(i+73)%251));',
              'process.stderr.write(Buffer.alloc(31,(256+73)%251));',
            ].join(''),
            setupState.workspace,
          ),
          onOutput: async (stream, chunk) => {
            await new Promise((resolve) => setTimeout(resolve, 1));
            observed[stream].push(Buffer.from(chunk));
          },
          timeouts: { naturalDrainMs: 5000, termMs: 100, killMs: 5000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome).toMatchObject({
      verdict: 'completed',
      terminationReason: null,
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    expect(expectedStdout).toHaveLength(stdoutBytes);
    expect(expectedStderr).toHaveLength(stderrBytes);
    expect(Buffer.concat(observed.stdout)).toEqual(expectedStdout);
    expect(Buffer.concat(observed.stderr)).toEqual(expectedStderr);
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 30_000);

  it('does not install DRAINED until the slow output consumer releases its ACK', async () => {
    const setupState = await setup();
    let releaseOutput = (): void => undefined;
    const outputBlocked = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    let callbackStarted = false;
    let rootResultObserved = false;
    let operationSettled = false;

    const running = runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target("process.stdout.write('waiting-for-ack')", setupState.workspace),
          onOutput: async () => {
            callbackStarted = true;
            await outputBlocked;
          },
          timeouts: { naturalDrainMs: 2000, termMs: 100, killMs: 5000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
            onRootResult: () => {
              rootResultObserved = true;
            },
          },
        }),
    ).finally(() => {
      operationSettled = true;
    });

    await waitUntil(() => callbackStarted && rootResultObserved);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(operationSettled).toBe(false);
    expect(existsSync(join(operationPath(setupState.workspace), DRAINED_RECEIPT_FILE))).toBe(false);

    releaseOutput();
    const outcome = await running;
    groups.delete(outcome.containment.pgid);
    expect(outcome.verdict).toBe('completed');
    expect(outcome.stdout).toEqual(Buffer.alloc(0));
    await setupState.session.close();
  }, 20_000);

  it('applies the fixed output-credit window back to a target blocked on a large write', async () => {
    const setupState = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-output-credit-'));
    roots.push(controlRoot);
    const writeCompleted = join(controlRoot, 'write-completed');
    let releaseOutput = (): void => undefined;
    const outputBlocked = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    let callbackStarted = false;

    const running = runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            [
              "const fs=require('node:fs');",
              `process.stdout.write(Buffer.alloc(4*1024*1024,97),()=>fs.writeFileSync(${JSON.stringify(writeCompleted)},'done'));`,
            ].join(''),
            setupState.workspace,
          ),
          onOutput: async () => {
            callbackStarted = true;
            await outputBlocked;
          },
          timeouts: { naturalDrainMs: 2000, termMs: 100, killMs: 5000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    await waitUntil(() => callbackStarted);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(existsSync(writeCompleted)).toBe(false);

    releaseOutput();
    const outcome = await running;
    groups.delete(outcome.containment.pgid);
    expect(outcome.verdict).toBe('completed');
    expect(readFileSync(writeCompleted, 'utf8')).toBe('done');
    await setupState.session.close();
  }, 30_000);

  it('terminates with output-failure and drains after a streaming callback rejects', async () => {
    const setupState = await setup();
    let discardCalls = 0;
    let callbackCalls = 0;

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            'const chunk=Buffer.alloc(64*1024,97);for(let i=0;i<128;i+=1){process.stdout.write(chunk);process.stderr.write(chunk)}',
            setupState.workspace,
          ),
          onOutput: async () => {
            callbackCalls += 1;
            throw new Error('slow consumer failed');
          },
          onOutputDiscard: () => {
            discardCalls += 1;
          },
          timeouts: { naturalDrainMs: 500, termMs: 100, killMs: 5000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(callbackCalls).toBeGreaterThan(0);
    expect(discardCalls).toBe(1);
    expect(outcome).toMatchObject({
      verdict: 'terminated',
      terminationReason: 'output-failure',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
      leftover: false,
      receipt: { drainReason: 'output-failure' },
    });
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 30_000);

  it('lets a delayed output-failure win after root exit instead of reporting a leaked tree', async () => {
    const setupState = await setup();

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target("process.stdout.write('late-output-failure')", setupState.workspace),
          onOutput: async () => {
            await new Promise((resolve) => setTimeout(resolve, 250));
            throw new Error('consumer failed after root exit');
          },
          timeouts: { naturalDrainMs: 50, termMs: 100, killMs: 5000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome).toMatchObject({
      verdict: 'terminated',
      terminationReason: 'output-failure',
      leftover: false,
      receipt: { drainReason: 'output-failure' },
    });
    await setupState.session.close();
  }, 20_000);

  it('sends no late OUTPUT_ACK when cancellation discards an in-flight callback after root exit', async () => {
    const setupState = await setup();
    const controller = new AbortController();
    let releaseOutput = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    let callbackStarted = false;
    let discardCalls = 0;

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target("process.stdout.write('blocked-after-root-exit')", setupState.workspace),
          termination: { signal: controller.signal, reason: 'user-interrupt' },
          onOutput: async () => {
            callbackStarted = true;
            await blocked;
          },
          onOutputDiscard: () => {
            discardCalls += 1;
            releaseOutput();
          },
          timeouts: { naturalDrainMs: 50, termMs: 100, killMs: 5000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
            onRootResult: async () => {
              await waitUntil(() => callbackStarted, 2000);
              controller.abort();
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(callbackStarted).toBe(true);
    expect(discardCalls).toBe(1);
    expect(outcome).toMatchObject({
      verdict: 'terminated',
      terminationReason: 'user-interrupt',
      leftover: false,
      receipt: { drainReason: 'user-interrupt' },
    });
    await setupState.session.close();
  }, 20_000);

  it('releases a permanently backpressured output callback before timeout termination', async () => {
    const setupState = await setup();
    let releaseOutput = (): void => undefined;
    const blocked = new Promise<void>((resolve) => {
      releaseOutput = resolve;
    });
    let discardCalls = 0;

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(
            "process.stdout.write('blocked');setInterval(()=>{},1000)",
            setupState.workspace,
          ),
          commandTimeoutMs: 200,
          onOutput: async () => blocked,
          onOutputDiscard: () => {
            discardCalls += 1;
            releaseOutput();
          },
          timeouts: { naturalDrainMs: 100, termMs: 100, killMs: 5000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(discardCalls).toBe(1);
    expect(outcome).toMatchObject({
      verdict: 'terminated',
      terminationReason: 'timeout',
      stdout: Buffer.alloc(0),
      stderr: Buffer.alloc(0),
    });
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 20_000);

  it('accepts a bounded DATA contract whose canonical base64 exceeds the generic event limit', async () => {
    const setupState = await setup();
    const environment = Array.from({ length: 48 }, (_, index) => ({
      name: `CODING_X_LARGE_ENV_${String(index).padStart(2, '0')}`,
      value: `${index}:`.padEnd(320, 'x'),
    }));
    const controlBytes = Buffer.from(
      `${JSON.stringify(
        {
          schemaVersion: 1,
          type: 'DATA',
          operationId: OPERATION_ID,
          target: { ...target('', setupState.workspace), environment },
        },
        null,
        2,
      )}\n`,
      'utf8',
    );
    expect(controlBytes.length).toBeLessThanOrEqual(64 * 1024);
    expect(controlBytes.toString('base64').length).toBeGreaterThan(16_384);

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: {
            ...target(
              "process.stdout.write(process.env.CODING_X_LARGE_ENV_47 ?? 'missing')",
              setupState.workspace,
            ),
            environment,
          },
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
    expect(outcome.stdout.toString('utf8')).toBe(environment[47].value);
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 15_000);

  it('fails closed and drains containment when aggregate capture output exceeds 16 MiB', async () => {
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

  it('settles an opaque runner that exits naturally with a numeric non-zero code', async () => {
    const setupState = await setup();

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target('process.exit(23)', setupState.workspace),
          posixProcessDomain: 'opaque-runner',
          timeouts: { naturalDrainMs: 100, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome).toMatchObject({
      verdict: 'root-failed',
      code: 23,
      signal: null,
      terminationReason: null,
      leftover: false,
      receipt: { drainReason: 'natural' },
    });
    expect(existsSync(outcome.settledPath)).toBe(true);
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 15_000);

  it.each([
    ['natural signal exit', "process.kill(process.pid, 'SIGTERM')"],
    [
      'natural process-tree residue',
      "require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'}).unref();process.exit(0)",
    ],
  ] as const)(
    'permanently isolates an opaque runner after %s',
    async (_label, source) => {
      const setupState = await setup();
      let containment: ContainmentDescriptor | undefined;

      await expect(
        runWorkspaceOperation(setupState.session, operationOptions(), async (operation) =>
          runDarkPosixSupervisedOperation(operation, {
            target: target(source, setupState.workspace),
            posixProcessDomain: 'opaque-runner',
            timeouts: { naturalDrainMs: 100, termMs: 100, killMs: 3000, pollMs: 20 },
            hooks: {
              onArmed: ({ containment: armed }) => {
                containment = armed;
                trackGroup(armed);
              },
            },
          }),
        ),
      ).rejects.toMatchObject({ code: 'isolated' });

      expect(existsSync(join(operationPath(setupState.workspace), DRAINED_RECEIPT_FILE))).toBe(
        false,
      );
      expect(
        parseQuarantineRecord(
          readFileSync(join(operationPath(setupState.workspace), QUARANTINE_FILE)),
        ).reason,
      ).toBe('operation-proof-missing');
      if (containment?.platform === 'posix-process-group-v1') {
        expect(await waitForPosixProcessGroupEmpty(containment.pgid, 5000, 20)).toBe(true);
        groups.delete(containment.pgid);
      }
    },
    15_000,
  );

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

  it('lets TERMINATE win for an opaque runner before START and proves that the target never started', async () => {
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
          posixProcessDomain: 'opaque-runner',
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

  it('honors a user interrupt that arrives while a completed root is naturally draining', async () => {
    const setupState = await setup();
    const controller = new AbortController();
    const descendant = 'setInterval(() => {}, 1000)';
    const root = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});`,
      'process.exit(0);',
    ].join('');

    const startedAt = performance.now();
    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(root, setupState.workspace),
          termination: { signal: controller.signal, reason: 'user-interrupt' },
          timeouts: { naturalDrainMs: 5000, termMs: 100, killMs: 1000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
            onRootResult: async () => {
              await new Promise((resolve) => setTimeout(resolve, 200));
              controller.abort();
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome).toMatchObject({
      verdict: 'terminated',
      terminationReason: 'user-interrupt',
      code: null,
      signal: null,
      leftover: false,
    });
    expect(outcome.receipt.drainReason).toBe('user-interrupt');
    expect(performance.now() - startedAt).toBeLessThan(3000);
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 15_000);

  it('tightens late termination even when the parent can no longer enforce helper cleanup', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-posix-natural-terminate-'));
    roots.push(workspace);
    const workerPath = fileURLToPath(
      new URL('./__fixtures__/posix-natural-drain-terminate-worker.ts', import.meta.url),
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

    let containmentRecord: RecordedPosixTestGroup | undefined;
    let supervisorFacts: { readonly pid: number; readonly identity: string } | undefined;
    try {
      await waitUntil(() => stdout.trim().split('\n').length >= 2, 10_000);
      const lines = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      const facts = lines[0] as {
        phase: 'started';
        supervisorPid: number;
        supervisorIdentity: string;
        pgid: number;
        launcherPid: number;
        launcherIdentity: string;
      };
      expect(facts.phase).toBe('started');
      expect(lines[1]).toEqual({ phase: 'terminate-sent', reason: 'user-interrupt' });
      supervisorFacts = { pid: facts.supervisorPid, identity: facts.supervisorIdentity };
      containmentRecord = trackGroup({
        platform: 'posix-process-group-v1',
        pgid: facts.pgid,
        launcherPid: facts.launcherPid,
        launcherIdentity: facts.launcherIdentity,
      });

      const parentStoppedAt = performance.now();
      worker.kill('SIGSTOP');
      await waitUntil(
        () => processIsGoneOrZombie(facts.supervisorPid, facts.supervisorIdentity),
        2000,
      );
      expect(performance.now() - parentStoppedAt).toBeLessThan(2000);
      expect(existsSync(join(operationPath(workspace), DRAINED_RECEIPT_FILE))).toBe(false);
      expect(stderr).toBe('');
    } finally {
      if (worker.exitCode === null && worker.signalCode === null) {
        worker.kill('SIGKILL');
        await once(worker, 'exit');
      }
      workers.delete(worker);
      if (containmentRecord && probePosixProcessGroup(containmentRecord.pgid) !== 'empty') {
        await terminateRecordedPosixTestGroup(containmentRecord, {
          termTimeoutMs: 50,
          killTimeoutMs: 3000,
          pollIntervalMs: 10,
        });
        groups.delete(containmentRecord.pgid);
      }
      if (supervisorFacts) {
        const observed = createSystemIdentityAdapter().readProcessIdentity(supervisorFacts.pid);
        if (observed.status === 'found' && observed.value === supervisorFacts.identity) {
          process.kill(supervisorFacts.pid, 'SIGKILL');
        }
      }
    }
  }, 20_000);

  it('accepts a natural receipt that wins before a late user interrupt', async () => {
    const setupState = await setup();
    const controller = new AbortController();

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target('process.exit(0)', setupState.workspace),
          termination: { signal: controller.signal, reason: 'user-interrupt' },
          timeouts: { naturalDrainMs: 5000, termMs: 100, killMs: 1000, ackMs: 1000 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
            onRootResult: async () => {
              await waitUntil(
                () => existsSync(join(operationPath(setupState.workspace), DRAINED_RECEIPT_FILE)),
                5000,
              );
              controller.abort();
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(controller.signal.aborted).toBe(true);
    expect(outcome).toMatchObject({
      verdict: 'completed',
      terminationReason: null,
      code: 0,
      signal: null,
      leftover: false,
    });
    expect(outcome.receipt.drainReason).toBe('natural');
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 15_000);

  it('tightens an active natural drain when the parent disconnects', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-posix-natural-parent-crash-'));
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-natural-parent-control-'));
    roots.push(workspace, controlRoot);
    const escapedPidPath = join(controlRoot, 'escaped.pid');
    const workerPath = fileURLToPath(
      new URL('./__fixtures__/posix-natural-drain-parent-worker.ts', import.meta.url),
    );
    const worker = spawn(
      process.execPath,
      ['--import', 'tsx', workerPath, workspace, escapedPidPath],
      {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
      },
    );
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

    let escapedPid: number | undefined;
    let containmentRecord: RecordedPosixTestGroup | undefined;
    let supervisorFacts: { readonly pid: number; readonly identity: string } | undefined;
    try {
      await waitUntil(() => stdout.trim().split('\n').length >= 2, 10_000);
      const lines = stdout
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(lines[1]).toEqual({ phase: 'natural-drain' });
      const facts = lines[0] as {
        phase: 'started';
        supervisorPid: number;
        supervisorIdentity: string;
        pgid: number;
        launcherPid: number;
        launcherIdentity: string;
      };
      expect(facts.phase).toBe('started');
      supervisorFacts = { pid: facts.supervisorPid, identity: facts.supervisorIdentity };
      containmentRecord = trackGroup({
        platform: 'posix-process-group-v1',
        pgid: facts.pgid,
        launcherPid: facts.launcherPid,
        launcherIdentity: facts.launcherIdentity,
      });
      await waitUntil(() => existsSync(escapedPidPath), 5000);
      escapedPid = Number(readFileSync(escapedPidPath, 'utf8'));
      expect(escapedPid).toBeGreaterThan(0);
      process.kill(facts.launcherPid, 'SIGSTOP');

      const disconnectedAt = performance.now();
      worker.kill('SIGKILL');
      await once(worker, 'exit');
      workers.delete(worker);
      await waitUntil(() => {
        try {
          process.kill(facts.supervisorPid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      }, 2500);
      expect(performance.now() - disconnectedAt).toBeLessThan(2500);
      await terminateRecordedPosixTestGroup(containmentRecord, {
        termTimeoutMs: 50,
        killTimeoutMs: 3000,
        pollIntervalMs: 10,
      });
      expect(await waitForPosixProcessGroupEmpty(facts.pgid, 1000, 10)).toBe(true);
      groups.delete(facts.pgid);
      expect(existsSync(join(operationPath(workspace), DRAINED_RECEIPT_FILE))).toBe(false);
      expect(stderr).toBe('');
    } finally {
      if (containmentRecord && probePosixProcessGroup(containmentRecord.pgid) !== 'empty') {
        await terminateRecordedPosixTestGroup(containmentRecord, {
          termTimeoutMs: 50,
          killTimeoutMs: 3000,
          pollIntervalMs: 10,
        });
        groups.delete(containmentRecord.pgid);
      }
      if (escapedPid && Number.isSafeInteger(escapedPid)) {
        try {
          process.kill(escapedPid, 'SIGKILL');
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
        }
        await waitForPosixProcessGroupEmpty(escapedPid, 3000, 10);
      }
      if (supervisorFacts) {
        const observed = createSystemIdentityAdapter().readProcessIdentity(supervisorFacts.pid);
        if (observed.status === 'found' && observed.value === supervisorFacts.identity) {
          process.kill(supervisorFacts.pid, 'SIGKILL');
        }
      }
    }
  }, 20_000);

  it('keeps a timely RESULT successful when natural drain finishes after the command deadline', async () => {
    const setupState = await setup();
    const descendant = 'setTimeout(() => process.exit(0), 5000)';
    const root = [
      "const {spawn}=require('node:child_process');",
      `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});`,
      'process.exit(0);',
    ].join('');

    const outcome = await runWorkspaceOperation(
      setupState.session,
      operationOptions(),
      async (operation) =>
        runDarkPosixSupervisedOperation(operation, {
          target: target(root, setupState.workspace),
          commandTimeoutMs: 3000,
          timeouts: { naturalDrainMs: 7000, termMs: 100, killMs: 3000, pollMs: 20 },
          hooks: {
            onArmed: ({ containment }) => {
              trackGroup(containment);
            },
          },
        }),
    );

    groups.delete(outcome.containment.pgid);
    expect(outcome).toMatchObject({
      verdict: 'completed',
      terminationReason: null,
      code: 0,
      signal: null,
      leftover: false,
    });
    expect(outcome.receipt.drainReason).toBe('natural');
    expect(probePosixProcessGroup(outcome.containment.pgid)).toBe('empty');
    await setupState.session.close();
  }, 20_000);

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
