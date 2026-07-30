import { spawn } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, win32 } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createWindowsSupervisorLaunch, spawnWindowsJobSupervisor } from './windows-supervisor.js';
import {
  ASSET_ROOT,
  BREAKAWAY_SOURCE,
  BREAKAWAY_TARGET,
  CONSTRAINED_LANGUAGE_DRIVER,
  created,
  CTRL_C_DRIVER,
  CTRL_C_DRIVER_SOURCE,
  CTRL_C_PARENT,
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

windowsOnly('real Windows Job supervisor', { timeout: 90_000, concurrent: false }, () => {
  it('fails before BOUND when the fixed helper digest is wrong', async () => {
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const args = [...launch.args];
    args[args.indexOf('-ExpectedHelperDigest') + 1] = `sha256:${'0'.repeat(64)}`;
    const child = spawn(launch.command, args, {
      cwd: launch.cwd,
      env: { ...launch.env },
      detached: true,
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

  it('fails before BOUND under ConstrainedLanguage without starting a target', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-constrained-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const sourcePaths = launch.assets.sourcePaths;
    const powershell = win32.join(
      process.env.SystemRoot!,
      'System32',
      'WindowsPowerShell',
      'v1.0',
      'powershell.exe',
    );
    const child = spawn(
      powershell,
      [
        '-NoLogo',
        '-NoProfile',
        '-NonInteractive',
        '-File',
        CONSTRAINED_LANGUAGE_DRIVER,
        '-SupervisorPath',
        join(ASSET_ROOT, 'windows-job-supervisor.ps1'),
        '-SourcePath',
        sourcePaths[0],
        '-ProcessSourcePath',
        sourcePaths[1],
        '-AuthoritySourcePath',
        sourcePaths[2],
        '-ExpectedHelperDigest',
        launch.assets.helperDigest,
        '-TimeoutsBase64',
        launch.args[launch.args.indexOf('-TimeoutsBase64') + 1],
      ],
      {
        cwd: workspace,
        env: { ...launch.env },
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    );
    let stdout = '';
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
    });
    const exit = await new Promise<{ code: number | null; signal: NodeJS.Signals | null }>(
      (resolve) => child.once('exit', (code, signal) => resolve({ code, signal })),
    );
    expect(exit.code).not.toBe(0);
    expect(stdout).not.toContain('BOUND');
    expect(existsSync(marker)).toBe(false);
  });

  it('fails before BOUND when Add-Type cannot compile the fixed source bundle', async () => {
    const copy = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-add-type-')));
    created.push(copy);
    cpSync(ASSET_ROOT, copy, { recursive: true });
    const brokenSource = join(copy, 'WindowsJobProcess.cs');
    writeFileSync(
      brokenSource,
      Buffer.concat([readFileSync(brokenSource), Buffer.from('\nthis is not valid C sharp\n')]),
    );
    const launch = createWindowsSupervisorLaunch({ assetRoot: copy });
    const child = spawnWindowsJobSupervisor(launch);
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

  it('keeps the target suspended until START and drains it on prestart abort', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-prestart-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(child, workspace, realpathSync(process.execPath), [
      '-e',
      `if(process.argv[1] !== '雪' || process.argv[2] !== '') process.exit(9);require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      '雪',
      '',
    ]);
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
    expect(bound.supervisorPid).toBeGreaterThan(0);
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
    sendData(child, workspace, realpathSync(process.execPath), ['-e', 'process.exit(0)']);
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
    sendData(child, workspace, realpathSync(process.execPath), [
      '-e',
      `if(process.argv[1] !== '雪' || process.argv[2] !== '') process.exit(9);require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
      '雪',
      '',
    ]);
    const armedEvent = await events.next('ARMED');
    expect(existsSync(marker)).toBe(false);
    const containment = armedEvent.containment as Record<string, unknown>;
    const armed = {
      ...authority.prepared,
      state: 'armed',
      containment,
      containmentDigest: DIGEST(JSON.stringify(containment)),
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
    expect(result.code).toBe(0);
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

  it('rejects an armed containment identity mismatch before resuming the target', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-identity-')));
    created.push(workspace);
    const marker = join(workspace, 'target-ran.txt');
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(child, workspace, realpathSync(process.execPath), [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)},'ran')`,
    ]);
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
    sendData(child, workspace, realpathSync(process.execPath), ['-e', 'process.exit(0)']);
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
    sendData(child, workspace, realpathSync(process.execPath), [
      '-e',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`,
    ]);
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
    sendData(child, workspace, command, [marker]);
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

  it('drains large stdout and stderr without hiding EOF behind a green root result', async () => {
    const workspace = realpathSync(mkdtempSync(join(tmpdir(), 'coding-x-windows-output-')));
    created.push(workspace);
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
    const bound = await events.next('BOUND');
    const authority = installPreparedAuthority(workspace, launch.assets.helperDigest, bound);
    sendData(child, workspace, realpathSync(process.execPath), [
      '-e',
      'process.stdout.write(Buffer.alloc(2*1024*1024,65));process.stderr.write(Buffer.alloc(2*1024*1024,66))',
    ]);
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
    const launch = createWindowsSupervisorLaunch({ assetRoot: ASSET_ROOT });
    const child = spawnWindowsJobSupervisor(launch);
    const events = new EventReader(child);
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
    expect((await events.next('RESULT')).code).toBe(0);
    const drained = await events.next('DRAINED');
    const drainedMessage = JSON.parse(
      Buffer.from(String(drained.messageBase64), 'base64').toString('utf8'),
    ) as Record<string, unknown>;
    expect(JSON.parse(readFileSync(outcomePath, 'utf8'))).toMatchObject({
      allowed: false,
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
    sendData(child, workspace, realpathSync(process.execPath), [
      '-e',
      `require('node:child_process').spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:['ignore','inherit','inherit']});require('node:fs').writeFileSync(${JSON.stringify(ready)},'ready');setInterval(()=>{},1000)`,
    ]);
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
