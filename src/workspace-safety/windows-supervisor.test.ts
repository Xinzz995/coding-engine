import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import {
  closeSync,
  existsSync,
  mkdtempSync,
  openSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseDelegatedBaselineBytes } from './baseline.js';
import { createWindowsSupervisorLaunch, spawnWindowsJobSupervisor } from './windows-supervisor.js';
import { windowsTestTargetEnvironment } from './windows-test-environment.js';
import {
  ASSET_ROOT,
  BREAKAWAY_SOURCE,
  BREAKAWAY_TARGET,
  containmentDigestFor,
  created,
  CTRL_C_DRIVER,
  CTRL_C_DRIVER_SOURCE,
  CTRL_C_PARENT,
  createWindowsWorkspace,
  DIGEST,
  EventReader,
  installArmedAuthority,
  installPreparedAuthority,
  OPERATION_ID,
  sendData,
  sendEmbedded,
  waitForFile,
  waitForProcessGone,
} from './windows-supervisor.test-support.js';

const windowsOnly = process.platform === 'win32' ? describe : describe.skip;

function sendEncodedData(
  child: ChildProcessWithoutNullStreams,
  workspacePath: string,
  messageBase64: string,
): void {
  child.stdin.write(
    `${JSON.stringify({
      schemaVersion: 1,
      type: 'DATA',
      workspacePath,
      messageBase64,
    })}\n`,
  );
}

windowsOnly('real Windows Job supervisor', { timeout: 90_000, concurrent: false }, () => {
  it('fails before BOUND when the fixed helper digest is wrong', async () => {
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const args = [...launch.args];
    args[args.indexOf('--expected-helper-digest') + 1] = `sha256:${'0'.repeat(64)}`;
    const child = spawn(launch.command, args, {
      cwd: launch.cwd,
      env: { ...launch.env },
      detached: launch.detached,
      windowsHide: launch.windowsHide,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stdin.end();
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    expect(exit).toEqual({ code: 2, signal: null });
    expect(stdout).not.toContain('BOUND');
  });

  it.each([
    ['extra', (args: readonly string[]) => [...args, '--unexpected']],
    ['reordered', (args: readonly string[]) => [args[2], args[3], args[0], args[1]]],
    ['missing', (args: readonly string[]) => args.slice(0, 2)],
  ] as const)('rejects %s executable arguments before BOUND', async (_label, mutate) => {
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawn(launch.command, mutate(launch.args), {
      cwd: launch.cwd,
      env: { ...launch.env },
      detached: launch.detached,
      windowsHide: launch.windowsHide,
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    expect(exit).toEqual({ code: 2, signal: null });
    expect(stdout).not.toContain('BOUND');
  });

  it('rejects a non-pipe protocol handle before BOUND', async () => {
    const workspace = createWindowsWorkspace('non-pipe-stdio');
    const outputPath = join(workspace, 'supervisor-output.log');
    const output = openSync(outputPath, 'w');
    try {
      const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
      const child = spawn(launch.command, [...launch.args], {
        cwd: launch.cwd,
        env: { ...launch.env },
        detached: launch.detached,
        windowsHide: launch.windowsHide,
        shell: false,
        stdio: ['pipe', output, 'pipe'],
      });
      child.stdin?.end();
      const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
        (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
      );
      expect(exit).toEqual({ code: 2, signal: null });
    } finally {
      closeSync(output);
    }
    expect(readFileSync(outputPath, 'utf8')).not.toContain('BOUND');
  });

  it('rejects case-insensitive duplicate target environment before target creation', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-env-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`],
      [
        { name: 'TEMP', value: 'one' },
        { name: 'temp', value: 'two' },
      ],
    );
    await expect(events.next('ARMED')).rejects.toThrow(/environment/u);
    await expect(events.exit).resolves.toEqual({ code: 2, signal: null });
    expect(existsSync(marker)).toBe(false);
  });

  it('accepts canonical DATA base64 above 4096 chars while decoded DATA remains within 64 KiB', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-large-data-')));
    created.push(workspace);
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    const environment = [
      ...windowsTestTargetEnvironment(),
      { name: 'CODING_X_PAD_A', value: 'a'.repeat(3000) },
      { name: 'CODING_X_PAD_B', value: 'b'.repeat(3000) },
    ];
    const message = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        type: 'DATA',
        operationId: OPERATION_ID,
        target: {
          executable: realpathSync(process.execPath),
          args: ['-e', 'process.exit(0)'],
          cwd: workspace,
          environment,
        },
      }),
      'utf8',
    );
    expect(message.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(message.toString('base64').length).toBeGreaterThan(4096);

    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      ['-e', 'process.exit(0)'],
      environment,
    );
    await events.next('ARMED');
    sendEmbedded(child, 'ABORT_BEFORE_START', {
      schemaVersion: 1,
      type: 'ABORT_BEFORE_START',
      operationId: OPERATION_ID,
    });
    await events.next('PRESTART_DRAINED');
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it('rejects DATA decoded to exactly 64 KiB plus one byte before starting the target', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-data-limit-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    const padding = Array.from({ length: 16 }, (_unused, index) => ({
      name: `CODING_X_LIMIT_${String(index).padStart(2, '0')}`,
      value: index < 15 ? 'x'.repeat(4096) : '',
    }));
    const message = {
      schemaVersion: 1,
      type: 'DATA',
      operationId: OPERATION_ID,
      target: {
        executable: realpathSync(process.execPath),
        args: [
          '-e',
          `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        ],
        cwd: workspace,
        environment: [...windowsTestTargetEnvironment(), ...padding],
      },
    };
    let messageBytes = Buffer.from(JSON.stringify(message), 'utf8');
    const remaining = 64 * 1024 + 1 - messageBytes.byteLength;
    expect(remaining).toBeGreaterThan(0);
    expect(remaining).toBeLessThanOrEqual(4096);
    padding[15].value = 'y'.repeat(remaining);
    messageBytes = Buffer.from(JSON.stringify(message), 'utf8');
    expect(messageBytes.byteLength).toBe(64 * 1024 + 1);

    sendEncodedData(child, workspace, messageBytes.toString('base64'));
    await expect(events.next('ARMED')).rejects.toThrow(/too large/u);
    await expect(events.exit).resolves.toEqual({ code: 2, signal: null });
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects non-canonical DATA base64 before starting the target', async () => {
    const workspace = realpathSync(
      mkdtempSync(join(tmpdir(), 'coding-x-windows-data-canonical-')),
    );
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    const messageBytes = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        type: 'DATA',
        operationId: OPERATION_ID,
        target: {
          executable: realpathSync(process.execPath),
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
          ],
          cwd: workspace,
          environment: windowsTestTargetEnvironment(),
        },
      }),
      'utf8',
    );

    sendEncodedData(child, workspace, `${messageBytes.toString('base64')}\n`);
    await expect(events.next('ARMED')).rejects.toThrow(/non-canonical/u);
    await expect(events.exit).resolves.toEqual({ code: 2, signal: null });
    expect(existsSync(marker)).toBe(false);
  });

  it('keeps the target suspended until START and drains it on prestart abort', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-prestart-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      [
        '-e',
        `if(process.argv[1] !== '雪' || process.argv[2] !== '') process.exit(9);require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        '雪',
        '',
      ],
      windowsTestTargetEnvironment(),
    );
    await events.next('ARMED');
    expect(existsSync(marker)).toBe(false);
    sendEmbedded(child, 'ABORT_BEFORE_START', {
      schemaVersion: 1,
      type: 'ABORT_BEFORE_START',
      operationId: OPERATION_ID,
    });
    await events.next('PRESTART_DRAINED');
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
    expect(existsSync(marker)).toBe(false);
    expect(
      existsSync(join(workspace, 'engine.lock', 'lease', 'operation', 'drained-receipt.json')),
    ).toBe(false);
  });

  it('accepts a bound abort before DATA without creating containment or a target', async () => {
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');

    sendEmbedded(child, 'ABORT_BEFORE_START', {
      schemaVersion: 1,
      type: 'ABORT_BEFORE_START',
      operationId: OPERATION_ID,
    });
    const drained = await events.next('PRESTART_DRAINED');
    expect(drained.messageBase64).toEqual(expect.any(String));
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
    expect(bound.supervisorPid).toBe(child.pid);
  });

  it.each([
    {
      label: 'Builder',
      fixture: {
        kind: 'builder',
        delegation: 'builder-v1',
        semantic: {
          version: 'builder-state-v1',
          storyId: 'US-001',
          acceptanceHash: DIGEST('acceptance'),
          checkCount: 2,
        },
      },
    },
    {
      label: 'Validator',
      fixture: {
        kind: 'validator',
        delegation: 'validator-v1',
        semantic: {
          version: 'validator-result-v1',
          requestId: OPERATION_ID,
          storyId: 'US-001',
          acceptanceHash: DIGEST('acceptance'),
          checkCount: 2,
          gitHead: 'b'.repeat(40),
        },
      },
    },
  ] as const)('binds a persisted $label semantic contract before DATA', async ({ fixture }) => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-semantic-')));
    created.push(workspace);
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound, fixture);
    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      ['-e', 'process.exit(0)'],
      windowsTestTargetEnvironment(),
    );
    await events.next('ARMED');
    sendEmbedded(child, 'ABORT_BEFORE_START', {
      schemaVersion: 1,
      type: 'ABORT_BEFORE_START',
      operationId: OPERATION_ID,
    });
    await events.next('PRESTART_DRAINED');
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it('runs only after the frozen armed digest and closes the Job only after receipt ACK', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-start-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      [
        '-e',
        `if(process.argv[1] !== '雪' || process.argv[2] !== ''){process.stderr.write(JSON.stringify(process.argv));process.exit(9)}require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
        '雪',
        '',
      ],
      windowsTestTargetEnvironment(),
    );
    const armedEvent = await events.next('ARMED');
    expect(existsSync(marker)).toBe(false);
    const containment = armedEvent.containment as Record<string, unknown>;
    const armed = {
      ...authority.prepared,
      state: 'armed',
      containment,
      containmentDigest: containmentDigestFor(containment),
    };
    const armedBytes = Buffer.from(JSON.stringify(armed), 'utf8');
    writeFileSync(authority.activePath, armedBytes);
    sendEmbedded(child, 'START', {
      schemaVersion: 1,
      type: 'START',
      operationId: OPERATION_ID,
      activeChildDigest: DIGEST(armedBytes),
    });
    await events.next('STARTED');
    const result = await events.next('RESULT');
    expect(
      result.code,
      `target stdout: ${events.outputTail.stdout}\ntarget stderr: ${events.outputTail.stderr}\nmarker exists: ${existsSync(marker)}`,
    ).toBe(0);
    const drained = await events.next('DRAINED');
    const message = JSON.parse(
      Buffer.from(String(drained.messageBase64), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const receiptPath = join(
      workspace,
      'engine.lock',
      'lease',
      'operation',
      'drained-receipt.json',
    );
    expect(existsSync(marker)).toBe(true);
    expect(DIGEST(readFileSync(receiptPath))).toBe(message.receiptDigest);
    sendEmbedded(child, 'ACK', {
      schemaVersion: 1,
      type: 'ACK',
      operationId: OPERATION_ID,
      receiptDigest: message.receiptDigest,
    });
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it('accepts a delegated baseline above the control-message JSON limit', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-baseline-')));
    created.push(workspace);
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const entries = Array.from({ length: 1_000 }, (_, index) => ({
      path: `${String(index).padStart(4, '0')}-${'x'.repeat(160)}`,
      type: 'file',
      bytes: 0,
      digest: DIGEST(`large-baseline-${String(index)}`),
    }));
    const authority = installPreparedAuthority(
      workspace,
      launch.assets.helperDigest,
      bound,
      {
        kind: 'final-review',
        delegation: 'read-only-v1',
        semantic: { version: 'read-only-v1' },
      },
      entries,
    );
    expect(authority.baselineBytes.byteLength).toBeGreaterThan(128 * 1024);
    expect(() => parseDelegatedBaselineBytes(authority.baselineBytes)).not.toThrow();
    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      ['-e', 'process.exit(0)'],
      windowsTestTargetEnvironment(),
    );
    await events.next('ARMED');
    sendEmbedded(child, 'ABORT_BEFORE_START', {
      schemaVersion: 1,
      type: 'ABORT_BEFORE_START',
      operationId: OPERATION_ID,
    });
    await events.next('PRESTART_DRAINED');
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it('rejects an armed containment identity mismatch before resuming the target', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-identity-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      ['-e', `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`],
      windowsTestTargetEnvironment(),
    );
    const armedEvent = await events.next('ARMED');
    const observed = armedEvent.containment as Record<string, unknown>;
    const forged = { ...observed, targetIdentity: `${String(observed.targetIdentity)}-forged` };
    const armedBytes = installArmedAuthority(authority, forged);
    sendEmbedded(child, 'START', {
      schemaVersion: 1,
      type: 'START',
      operationId: OPERATION_ID,
      activeChildDigest: DIGEST(armedBytes),
    });

    await expect(events.next('STARTED')).rejects.toThrow(/containment binding/u);
    await expect(events.exit).resolves.toEqual({ code: 2, signal: null });
    await waitForProcessGone(Number(observed.targetPid));
    expect(existsSync(marker)).toBe(false);
    expect(
      existsSync(join(workspace, 'engine.lock', 'lease', 'operation', 'drained-receipt.json')),
    ).toBe(false);
  });

  it('rejects an ACK derived from corrupted receipt bytes', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-receipt-')));
    created.push(workspace);
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
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
    const original = readFileSync(receiptPath);
    expect(DIGEST(original)).toBe(drainedMessage.receiptDigest);
    const corrupted = Buffer.concat([original, Buffer.from('\n')]);
    writeFileSync(receiptPath, corrupted);
    sendEmbedded(child, 'ACK', {
      schemaVersion: 1,
      type: 'ACK',
      operationId: OPERATION_ID,
      receiptDigest: DIGEST(corrupted),
    });

    await expect(events.next('ACK-REJECTED')).rejects.toThrow(/ACK binding/u);
    await expect(events.exit).resolves.toEqual({ code: 2, signal: null });
    expect(readFileSync(receiptPath)).toEqual(corrupted);
  });

  it('lets the first TERMINATE beat START, freezes its reason, and proves zero execution', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-term-first-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
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
    sendEmbedded(child, 'TERMINATE', {
      schemaVersion: 1,
      type: 'TERMINATE',
      operationId: OPERATION_ID,
      reason: 'user-interrupt',
    });
    sendEmbedded(child, 'START', {
      schemaVersion: 1,
      type: 'START',
      operationId: OPERATION_ID,
      activeChildDigest: DIGEST(armedBytes),
    });
    const drained = await events.next('DRAINED');
    const message = JSON.parse(
      Buffer.from(String(drained.messageBase64), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    const receiptPath = join(
      workspace,
      'engine.lock',
      'lease',
      'operation',
      'drained-receipt.json',
    );
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    expect(receipt.proof).toBe('never-started-containment-empty-v1');
    expect(receipt.drainReason).toBe('user-interrupt');
    expect(existsSync(marker)).toBe(false);
    sendEmbedded(child, 'TERMINATE', {
      schemaVersion: 1,
      type: 'TERMINATE',
      operationId: OPERATION_ID,
      reason: 'timeout',
    });
    sendEmbedded(child, 'ACK', {
      schemaVersion: 1,
      type: 'ACK',
      operationId: OPERATION_ID,
      receiptDigest: message.receiptDigest,
    });
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
    expect(
      (JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>).drainReason,
    ).toBe('user-interrupt');
  });

  it('uses the fixed cmd.exe subset for an absolute .cmd target', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-cmd-')));
    created.push(workspace);
    const command = join(workspace, 'target.cmd');
    const marker = join(workspace, 'cmd-ran.txt');
    writeFileSync(command, '@echo off\r\n> "%~1" echo ran\r\nexit /b 0\r\n');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(child, workspace, command, [marker], windowsTestTargetEnvironment());
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
    sendEmbedded(child, 'START', {
      schemaVersion: 1,
      type: 'START',
      operationId: OPERATION_ID,
      activeChildDigest: DIGEST(armedBytes),
    });
    await events.next('STARTED');
    expect((await events.next('RESULT')).code).toBe(0);
    const drained = await events.next('DRAINED');
    const message = JSON.parse(
      Buffer.from(String(drained.messageBase64), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(existsSync(marker)).toBe(true);
    sendEmbedded(child, 'ACK', {
      schemaVersion: 1,
      type: 'ACK',
      operationId: OPERATION_ID,
      receiptDigest: message.receiptDigest,
    });
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it('preserves nested quotes for the fixed cmd.exe /d /s /c target shape', async () => {
    const workspace = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'coding-x-windows-cmd-shell-')),
    );
    created.push(workspace);
    const marker = join(workspace, 'cmd-shell-ran.txt');
    const commandProcessor = realpathSync.native(
      join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
    );
    const node = realpathSync.native(process.execPath);
    const script =
      `${JSON.stringify(node)} -e ` +
      `"require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'quoted-ok')"`;
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      commandProcessor,
      ['/d', '/s', '/c', script],
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
    expect((await events.next('RESULT')).code).toBe(0);
    const drained = await events.next('DRAINED');
    const message = JSON.parse(
      Buffer.from(String(drained.messageBase64), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(readFileSync(marker, 'utf8')).toBe('quoted-ok');
    sendEmbedded(child, 'ACK', {
      schemaVersion: 1,
      type: 'ACK',
      operationId: OPERATION_ID,
      receiptDigest: message.receiptDigest,
    });
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it.each([
    ['missing /s', ['/d', '/c']],
    ['reordered /s and /c', ['/d', '/c', '/s']],
    ['extra argument', ['/d', '/s', '/c', 'extra']],
  ] as const)('rejects a system cmd.exe target with %s before ARMED', async (_label, prefix) => {
    const workspace = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'coding-x-windows-cmd-shape-')),
    );
    created.push(workspace);
    const marker = join(workspace, 'cmd-shape-ran.txt');
    const commandProcessor = realpathSync.native(
      join(process.env.SystemRoot!, 'System32', 'cmd.exe'),
    );
    const script = `echo rejected>${JSON.stringify(marker)}`;
    const args = [...prefix, script];
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      commandProcessor,
      args,
      windowsTestTargetEnvironment(),
    );
    await expect(events.next('ARMED')).rejects.toThrow(/fixed \/d \/s \/c shape/u);
    await expect(events.exit).resolves.toEqual({ code: 2, signal: null });
    expect(existsSync(marker)).toBe(false);
  });

  it('rejects a non-system executable named cmd.exe before ARMED', async () => {
    const workspace = realpathSync.native(
      mkdtempSync(join(tmpdir(), 'coding-x-windows-fake-cmd-')),
    );
    created.push(workspace);
    const commandProcessor = join(workspace, 'cmd.exe');
    const marker = join(workspace, 'fake-cmd-ran.txt');
    writeFileSync(commandProcessor, '');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      commandProcessor,
      ['/d', '/s', '/c', `echo rejected>${JSON.stringify(marker)}`],
      windowsTestTargetEnvironment(),
    );
    await expect(events.next('ARMED')).rejects.toThrow(/fixed system cmd\.exe/u);
    await expect(events.exit).resolves.toEqual({ code: 2, signal: null });
    expect(existsSync(marker)).toBe(false);
  });

  it('drains large stdout and stderr without hiding EOF behind a green root result', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-output-')));
    created.push(workspace);
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      [
        '-e',
        'process.stdout.write(Buffer.alloc(2*1024*1024,65));process.stderr.write(Buffer.alloc(2*1024*1024,66))',
      ],
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
    sendEmbedded(child, 'START', {
      schemaVersion: 1,
      type: 'START',
      operationId: OPERATION_ID,
      activeChildDigest: DIGEST(armedBytes),
    });
    await events.next('STARTED');
    expect((await events.next('RESULT')).code).toBe(0);
    const drained = await events.next('DRAINED');
    expect(events.outputBytes).toEqual({ stdout: 2 * 1024 * 1024, stderr: 2 * 1024 * 1024 });
    const message = JSON.parse(
      Buffer.from(String(drained.messageBase64), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    sendEmbedded(child, 'ACK', {
      schemaVersion: 1,
      type: 'ACK',
      operationId: OPERATION_ID,
      receiptDigest: message.receiptDigest,
    });
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
  });

  it('rejects a real CREATE_BREAKAWAY_FROM_JOB attempt', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-breakaway-')));
    created.push(workspace);
    const escapeMarker = join(workspace, 'escaped.txt');
    const outcomePath = join(workspace, 'breakaway-outcome.json');
    const breakawayAssembly = process.env.CODING_X_WINDOWS_BREAKAWAY_ASSEMBLY;
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    // Hosted Windows does not guarantee PowerShell, CLR, and assembly loading within 15 seconds.
    // Keep the previously proven native-scenario budget; this is execution allowance, not a
    // safety verdict. The assertions below still require a real access-denied result and prove
    // that no escaped process wrote the marker.
    const events = new EventReader(child, 60_000);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    const powershell = win32.join(
      process.env.SystemRoot!,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    sendData(
      child,
      workspace,
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        BREAKAWAY_TARGET,
        '-SourcePath',
        BREAKAWAY_SOURCE,
        '-AssemblyPath',
        breakawayAssembly ?? '',
        '-NodePath',
        realpathSync(process.execPath),
        '-EscapeMarker',
        escapeMarker,
        '-OutcomePath',
        outcomePath,
      ],
      [
        { name: 'SystemRoot', value: process.env.SystemRoot! },
        { name: 'TEMP', value: process.env.TEMP! },
        { name: 'TMP', value: process.env.TMP! },
      ],
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
    const result = await events.next('RESULT');
    const outcome = existsSync(outcomePath)
      ? (JSON.parse(readFileSync(outcomePath, 'utf8')) as Record<string, unknown>)
      : undefined;
    expect(
      result.code,
      JSON.stringify({
        outcome,
        stdout: events.outputTail.stdout,
        stderr: events.outputTail.stderr,
      }),
    ).toBe(0);
    const drained = await events.next('DRAINED');
    const drainedMessage = JSON.parse(
      Buffer.from(String(drained.messageBase64), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(outcome).toMatchObject({
      allowed: false,
      error: 5,
    });
    expect(existsSync(escapeMarker)).toBe(false);
    sendEmbedded(child, 'ACK', {
      schemaVersion: 1,
      type: 'ACK',
      operationId: OPERATION_ID,
      receiptDigest: drainedMessage.receiptDigest,
    });
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
  }, 90_000);

  it('treats parent EOF as shutdown and drains a live root plus grandchild without ACK', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-eof-')));
    created.push(workspace);
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const ready = join(workspace, 'grandchild-ready.txt');
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(
      child,
      workspace,
      realpathSync(process.execPath),
      [
        '-e',
        `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
      ],
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
    sendEmbedded(child, 'START', {
      schemaVersion: 1,
      type: 'START',
      operationId: OPERATION_ID,
      activeChildDigest: DIGEST(armedBytes),
    });
    await events.next('STARTED');
    await waitForFile(ready);
    child.stdin.end();
    await expect(events.exit).resolves.toEqual({ code: 0, signal: null });
    const receiptPath = join(
      workspace,
      'engine.lock',
      'lease',
      'operation',
      'drained-receipt.json',
    );
    const receipt = JSON.parse(readFileSync(receiptPath, 'utf8')) as Record<string, unknown>;
    expect(receipt.proof).toBe('windows-job-zero-and-pipes-eof-v1');
    expect(receipt.drainReason).toBe('parent-shutdown');
  });

  it('delivers a real CTRL_C_EVENT to the parent, returns 130, and drains only through IPC', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-ctrl-c-')));
    created.push(workspace);
    const ready = join(workspace, 'driver-ready.txt');
    const outcome = join(workspace, 'ctrl-c-outcome.json');
    const powershell = win32.join(
      process.env.SystemRoot!,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const driver = spawn(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        CTRL_C_DRIVER,
        '-SourcePath',
        CTRL_C_DRIVER_SOURCE,
        '-AssemblyPath',
        process.env.CODING_X_WINDOWS_CTRL_C_DRIVER_ASSEMBLY ?? '',
        '-NodePath',
        realpathSync(process.execPath),
        '-WorkerPath',
        CTRL_C_PARENT,
        '-AssetRoot',
        ASSET_ROOT,
        '-Workspace',
        workspace,
        '-ReadyPath',
        ready,
        '-OutcomePath',
        outcome,
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
    driver.stderr.setEncoding('utf8');
    driver.stderr.on('data', (chunk: string) => {
      stderr += chunk;
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => driver.once('exit', (code, signal) => resolve({ code, signal })),
    );
    expect(exit, stderr).toEqual({ code: 0, signal: null });
    const result = JSON.parse(readFileSync(outcome, 'utf8')) as Record<string, unknown>;
    expect(result).toMatchObject({
      parentExitCode: 130,
      drainReason: 'user-interrupt',
      proof: 'windows-job-zero-and-pipes-eof-v1',
      targetSawCtrlC: false,
    });
  }, 90_000);
});
