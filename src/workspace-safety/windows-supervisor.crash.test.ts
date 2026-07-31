import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_ROOT,
  containmentDigestFor,
  createSupervisor,
  createWindowsWorkspace,
  DIGEST,
  PARENT_CRASH_PARENT,
  installArmedAuthority,
  installPreparedAuthority,
  OPERATION_ID,
  runOuterJobScenario,
  sendData,
  sendEmbedded,
  trackActiveChild,
  waitForChildExit,
  waitForFile,
  waitForProcessGone,
} from './windows-supervisor.test-support.js';
import { windowsTestTargetEnvironment } from './windows-test-environment.js';
import { readWindowsProcessIdentity } from './windows-identity-transport.js';

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;

interface CleanupProcessReference {
  readonly identity?: string;
  readonly label: string;
  readonly pid: number;
}

function processReferencesFrom(path: string): CleanupProcessReference[] {
  if (!existsSync(path)) return [];
  const state = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  let inspectorPid = state.inspectorPid;
  let inspectorIdentity = state.inspectorIdentity;
  const inspectorIdentityPath = state.inspectorIdentityPath;
  if (
    (typeof inspectorIdentity !== 'string' || !/^[0-9]+$/u.test(inspectorIdentity)) &&
    typeof inspectorIdentityPath === 'string' &&
    existsSync(inspectorIdentityPath)
  ) {
    const handshake = JSON.parse(readFileSync(inspectorIdentityPath, 'utf8')) as Record<
      string,
      unknown
    >;
    const handshakePid = handshake.pid;
    if (
      Number.isSafeInteger(handshakePid) &&
      Number(handshakePid) > 0 &&
      (inspectorPid === undefined || inspectorPid === handshakePid)
    ) {
      inspectorPid = handshakePid;
      inspectorIdentity = handshake.processIdentity;
    }
  }
  const normalizedState: Record<string, unknown> = {
    ...state,
    inspectorPid,
    inspectorIdentity,
  };
  const fields = [
    ['supervisorPid', 'supervisorIdentity', 'supervisor'],
    ['rootPid', 'rootIdentity', 'root target'],
    ['descendantPid', 'descendantIdentity', 'descendant target'],
    ['inspectorPid', 'inspectorIdentity', 'snapshot inspector'],
  ] as const;
  return fields.flatMap(([pidKey, identityKey, label]) => {
    const pid = normalizedState[pidKey];
    if (!Number.isSafeInteger(pid) || Number(pid) <= 0) return [];
    const identity = identityKey ? normalizedState[identityKey] : undefined;
    return [
      {
        pid: Number(pid),
        label,
        ...(typeof identity === 'string' && /^[0-9]+$/u.test(identity) ? { identity } : {}),
      },
    ];
  });
}

function exactProcessRemains(reference: CleanupProcessReference): boolean | undefined {
  if (!reference.identity) return undefined;
  const observed = readWindowsProcessIdentity(reference.pid);
  if (observed.status === 'unknown') return undefined;
  return observed.status === 'found' && observed.value === reference.identity;
}

function readHandleInventory(path: unknown): Record<string, unknown> {
  if (typeof path !== 'string' || path.length === 0) {
    throw new Error('handle inventory path is invalid');
  }
  return JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
}

function inventoryHandles(inventory: Record<string, unknown>, label: string): string[] {
  if (
    !Array.isArray(inventory.handles) ||
    inventory.handles.some((value) => typeof value !== 'string' || !/^[0-9]+$/u.test(value))
  ) {
    throw new Error(`${label} handle inventory is invalid`);
  }
  const handles = inventory.handles as string[];
  expect(handles, label).toHaveLength(3);
  expect(new Set(handles).size, label).toBe(3);
  return handles;
}

function expectSuspendedHandleBinding({
  snapshot,
  runtime,
  snapshotRole,
  runtimeRole,
  pid,
  processIdentity,
}: {
  snapshot: Record<string, unknown>;
  runtime: Record<string, unknown>;
  snapshotRole: string;
  runtimeRole: string;
  pid: unknown;
  processIdentity: unknown;
}): void {
  expect(snapshot).toMatchObject({
    kind: 'suspended-handle-snapshot-v1',
    role: snapshotRole,
    pid,
    processIdentity,
  });
  expect([4, 8]).toContain(snapshot.pointerSize);
  expect(snapshot.entrySize).toBe(Number(snapshot.pointerSize) * 3 + 16);
  expect(runtime).toMatchObject({
    kind: 'runtime-standard-handles-v1',
    role: runtimeRole,
    pid,
    processIdentity,
  });
  const snapshotHandles = inventoryHandles(snapshot, `${snapshotRole} snapshot`);
  const runtimeHandles = inventoryHandles(runtime, `${runtimeRole} runtime`);
  expect(runtimeHandles).toEqual(snapshotHandles);
}

async function settleParentCrashProcesses(
  parent: ReturnType<typeof spawn>,
  cleanupStatePath: string,
): Promise<void> {
  const cleanupErrors: Error[] = [];
  if (parent.exitCode === null && parent.signalCode === null) parent.kill('SIGKILL');
  try {
    await waitForChildExit(parent, 5_000);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
  }
  let recordedProcesses: CleanupProcessReference[] = [];
  try {
    recordedProcesses = processReferencesFrom(cleanupStatePath);
  } catch (error) {
    cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
  }
  const processIds = [...new Set(recordedProcesses.map((reference) => reference.pid))].filter(
    (pid) => pid !== process.pid && pid !== parent.pid,
  );
  const naturalResults = await Promise.allSettled(
    processIds.map(async (pid) => await waitForProcessGone(pid, 5_000)),
  );
  const lingeringIds = processIds.filter(
    (_pid, index) => naturalResults[index]?.status === 'rejected',
  );
  const forced: CleanupProcessReference[] = [];
  for (const pid of lingeringIds) {
    const reference = recordedProcesses.find((item) => item.pid === pid)!;
    const remains = exactProcessRemains(reference);
    if (remains !== true) {
      if (remains === undefined) {
        cleanupErrors.push(
          new Error(`refused to kill ${reference.label} ${String(pid)} without exact identity`),
        );
      }
      continue;
    }
    try {
      process.kill(pid, 'SIGKILL');
      forced.push(reference);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ESRCH') {
        cleanupErrors.push(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }
  const forcedResults = await Promise.allSettled(
    forced.map(async ({ pid }) => await waitForProcessGone(pid, 5_000)),
  );
  for (const [index, result] of forcedResults.entries()) {
    const reference = forced[index];
    if (result.status === 'rejected' && exactProcessRemains(reference) === true) {
      cleanupErrors.push(
        new Error(`could not clean up ${reference.label} ${String(reference.pid)}`),
      );
    }
  }
  if (forced.length > 0) {
    cleanupErrors.push(
      new Error(
        `parent-crash fixture required forced cleanup for processes ${forced
          .map(({ pid }) => String(pid))
          .join(', ')}`,
      ),
    );
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, 'parent-crash fixture cleanup failed');
  }
}

windowsOnly(
  'real Windows crash and outer-Job behavior',
  { timeout: 120_000, concurrent: false },
  () => {
    it('reads a live process identity through the fixed inspector and observes exact death', async () => {
      const child = trackActiveChild(
        spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
          stdio: 'ignore',
          windowsHide: true,
        }),
      );
      expect(child.pid).toBeTypeOf('number');
      const live = readWindowsProcessIdentity(child.pid!);
      expect(live).toMatchObject({ status: 'found' });
      if (live.status === 'found') expect(live.value).toMatch(/^[1-9]\d{0,19}$/u);

      child.kill('SIGKILL');
      await waitForChildExit(child, 5_000);

      const afterExit = readWindowsProcessIdentity(child.pid!);
      expect(afterExit.status).not.toBe('unknown');
      if (afterExit.status === 'found' && live.status === 'found') {
        expect(afterExit.value).not.toBe(live.value);
      }
    });

    it('keeps a valid receipt when the supervisor is hard-killed between DRAINED and ACK', async () => {
      const workspace = createWindowsWorkspace('ack-crash');
      const { launch, child, events } = createSupervisor();
      const bound = await events.next('BOUND');
      const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
      sendData(
        child,
        workspace,
        realpathSync(process.execPath),
        ['-e', 'process.exit(0)'],
        windowsTestTargetEnvironment(),
      );
      const armedEvent = await events.next('ARMED');
      const containment = armedEvent.containment as Record<string, unknown>;
      const armedBytes = installArmedAuthority(authority, containment);
      sendEmbedded(child, 'START', {
        schemaVersion: 1,
        type: 'START',
        operationId: OPERATION_ID,
        activeChildDigest: DIGEST(armedBytes),
      });
      await events.next('STARTED');
      await events.next('RESULT');
      const drained = await events.next('DRAINED');
      const drainedMessage = JSON.parse(
        Buffer.from(String(drained.messageBase64), 'base64').toString('utf8'),
      ) as Record<string, unknown>;
      const receiptPath = join(
        workspace,
        'engine.lock',
        'lease',
        'operation',
        'drained-receipt.json',
      );
      const receiptBytes = readFileSync(receiptPath);
      expect(DIGEST(receiptBytes)).toBe(drainedMessage.receiptDigest);

      expect(child.kill('SIGKILL')).toBe(true);
      await events.exit;
      expect(readFileSync(receiptPath)).toEqual(receiptBytes);
      expect(DIGEST(readFileSync(receiptPath))).toBe(drainedMessage.receiptDigest);
      await waitForProcessGone(Number(containment.targetPid));
    });

    it('uses KILL_ON_CLOSE for a hard-killed prestart supervisor without fabricating a receipt', async () => {
      const workspace = createWindowsWorkspace('hard-kill-prestart');
      const marker = join(workspace, 'target-ran.txt');
      const { launch, child, events } = createSupervisor();
      const bound = await events.next('BOUND');
      const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
      sendData(
        child,
        workspace,
        realpathSync(process.execPath),
        ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
        windowsTestTargetEnvironment(),
      );
      const armedEvent = await events.next('ARMED');
      const containment = armedEvent.containment as Record<string, unknown>;
      const armedBytes = Buffer.from(
        JSON.stringify({
          ...authority.prepared,
          state: 'armed',
          containment,
          containmentDigest: containmentDigestFor(containment),
        }),
        'utf8',
      );
      writeFileSync(authority.activePath, armedBytes);
      expect(child.kill('SIGKILL')).toBe(true);
      await events.exit;
      await waitForProcessGone(Number(containment.targetPid));
      expect(existsSync(marker)).toBe(false);
      expect(
        existsSync(join(workspace, 'engine.lock', 'lease', 'operation', 'drained-receipt.json')),
      ).toBe(false);
    });

    it('drains the full Job after a hard parent kill and binds exactly three inherited handles', async () => {
      const workspace = createWindowsWorkspace('parent-crash');
      const parentReadyPath = join(workspace, 'parent-ready.json');
      const cleanupStatePath = join(workspace, 'parent-cleanup.json');
      const handleInventoryExecutable = process.env.CODING_X_WINDOWS_HANDLE_INVENTORY_EXECUTABLE;
      if (!handleInventoryExecutable)
        throw new Error('Windows handle inventory executable was not prepared');
      const parent = trackActiveChild(
        spawn(
          realpathSync(process.execPath),
          [
            PARENT_CRASH_PARENT,
            ASSET_ROOT,
            workspace,
            parentReadyPath,
            cleanupStatePath,
            realpathSync(handleInventoryExecutable),
          ],
          {
            cwd: workspace,
            env: {
              SystemRoot: process.env.SystemRoot,
              TEMP: process.env.TEMP,
              TMP: process.env.TMP,
            },
            shell: false,
            windowsHide: true,
            stdio: ['ignore', 'ignore', 'pipe'],
          },
        ),
      );
      let stderr = '';
      parent.stderr.setEncoding('utf8');
      parent.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      let bodyError: Error | undefined;
      try {
        await waitForFile(parentReadyPath, 60_000);
        const ready = JSON.parse(readFileSync(parentReadyPath, 'utf8')) as Record<string, unknown>;
        expect(ready.error, stderr).toBeUndefined();
        const rootInventory = readHandleInventory(ready.rootInventoryPath);
        const rootRuntimeInventory = readHandleInventory(ready.rootRuntimeInventoryPath);
        const descendantInventory = readHandleInventory(ready.descendantInventoryPath);
        const descendantRuntimeInventory = readHandleInventory(
          ready.descendantRuntimeInventoryPath,
        );
        expectSuspendedHandleBinding({
          snapshot: rootInventory,
          runtime: rootRuntimeInventory,
          snapshotRole: 'root-prestart',
          runtimeRole: 'root-runtime',
          pid: ready.rootPid,
          processIdentity: ready.rootIdentity,
        });
        expectSuspendedHandleBinding({
          snapshot: descendantInventory,
          runtime: descendantRuntimeInventory,
          snapshotRole: 'descendant-prestart',
          runtimeRole: 'descendant-runtime',
          pid: ready.descendantPid,
          processIdentity: ready.descendantIdentity,
        });
        expect(ready.rootPid).not.toBe(ready.descendantPid);

        expect(parent.kill('SIGKILL')).toBe(true);
        const parentExit = await waitForChildExit(parent, 10_000);
        expect(parentExit.code === 0 && parentExit.signal === null).toBe(false);

        await Promise.all([
          waitForProcessGone(Number(ready.supervisorPid), 30_000),
          waitForProcessGone(Number(ready.rootPid), 30_000),
          waitForProcessGone(Number(ready.descendantPid), 30_000),
        ]);
        const receiptPath = join(
          workspace,
          'engine.lock',
          'lease',
          'operation',
          'drained-receipt.json',
        );
        await waitForFile(receiptPath, 5_000);
        const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
        expect(receipt).toMatchObject({
          drainReason: 'parent-shutdown',
          proof: 'windows-job-zero-and-pipes-eof-v1',
        });
        expect(existsSync(parentReadyPath)).toBe(true);
      } catch (error) {
        bodyError = error instanceof Error ? error : new Error(String(error));
      } finally {
        try {
          await settleParentCrashProcesses(parent, cleanupStatePath);
        } catch (cleanupError) {
          const normalizedCleanupError =
            cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError));
          bodyError = bodyError
            ? new AggregateError(
                [bodyError, normalizedCleanupError],
                'parent-crash proof and cleanup failed',
              )
            : normalizedCleanupError;
        }
      }
      if (bodyError) throw bodyError;
    });

    it('fails atomically before target execution in an incompatible outer Job', async () => {
      const { exit, stderr, result } = await runOuterJobScenario('incompatible');
      expect(exit, stderr).toEqual({ code: 0, signal: null });
      expect(result).toMatchObject({
        mode: 'incompatible',
        helperExitCode: 2,
        targetExecuted: false,
        receiptCreated: false,
        failureStage: 'CreateProcessW',
      });
    });

    it('runs and drains inside a compatible outer Job', async () => {
      const { exit, stderr, result } = await runOuterJobScenario('compatible');
      expect(exit, stderr).toEqual({ code: 0, signal: null });
      expect(result).toMatchObject({
        mode: 'compatible',
        helperExitCode: 0,
        targetExecuted: true,
        receiptCreated: true,
        proof: 'windows-job-zero-and-pipes-eof-v1',
      });
    });
  },
);
