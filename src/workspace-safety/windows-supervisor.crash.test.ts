import { spawn } from 'node:child_process';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  ASSET_ROOT,
  createSupervisor,
  createWindowsWorkspace,
  DIGEST,
  HANDLE_INVENTORY_SOURCE,
  HANDLE_INVENTORY_TARGET,
  PARENT_CRASH_PARENT,
  installArmedAuthority,
  installPreparedAuthority,
  OPERATION_ID,
  runOuterJobScenario,
  sendData,
  sendEmbedded,
  waitForFile,
  waitForProcessGone,
} from './windows-supervisor.test-support.js';
import { windowsTestTargetEnvironment } from './windows-test-environment.js';

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;

windowsOnly(
  'real Windows crash and outer-Job behavior',
  { timeout: 120_000, concurrent: false },
  () => {
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
          containmentDigest: DIGEST(JSON.stringify(containment)),
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

    it('drains the full Job after a hard parent kill and exposes only three inheritable handles', async () => {
      const workspace = createWindowsWorkspace('parent-crash');
      const parentReadyPath = join(workspace, 'parent-ready.json');
      const parent = spawn(
        realpathSync(process.execPath),
        [
          PARENT_CRASH_PARENT,
          ASSET_ROOT,
          workspace,
          parentReadyPath,
          HANDLE_INVENTORY_TARGET,
          HANDLE_INVENTORY_SOURCE,
          process.env.CODING_X_WINDOWS_HANDLE_INVENTORY_ASSEMBLY ?? '',
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
      );
      let stderr = '';
      parent.stderr.setEncoding('utf8');
      parent.stderr.on('data', (chunk: string) => {
        stderr += chunk;
      });
      await waitForFile(parentReadyPath, 60_000);
      const ready = JSON.parse(readFileSync(parentReadyPath, 'utf8')) as Record<string, unknown>;
      expect(ready.error, stderr).toBeUndefined();
      const rootInventory = JSON.parse(
        readFileSync(String(ready.rootInventoryPath), 'utf8'),
      ) as Record<string, unknown>;
      const descendantInventory = JSON.parse(
        readFileSync(String(ready.descendantInventoryPath), 'utf8'),
      ) as Record<string, unknown>;
      for (const inventory of [rootInventory, descendantInventory]) {
        expect(inventory).toMatchObject({
          inheritableCount: 3,
          stdinIncluded: true,
          stdoutIncluded: true,
          stderrIncluded: true,
        });
      }

      expect(parent.kill('SIGKILL')).toBe(true);
      const parentExit = await new Promise<{
        code: number | null;
        signal: NodeJS.Signals | null;
      }>((resolve) => parent.once('exit', (code, signal) => resolve({ code, signal })));
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
      await waitForFile(receiptPath, 30_000);
      const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        drainReason: 'parent-shutdown',
        proof: 'windows-job-zero-and-pipes-eof-v1',
      });
      expect(existsSync(parentReadyPath)).toBe(true);
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
