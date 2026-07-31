import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import {
  createCrossProcessFixtureTracker,
  typeScriptFixtureExecArgv,
  typeScriptFixtureNodeArgs,
} from './cross-process-fixture.test-support.js';

describe('cross-process fixture support', () => {
  it('adds the isolated resolver only to ordinary Windows TypeScript workers', () => {
    const windows = typeScriptFixtureExecArgv({ platform: 'win32' });
    expect(windows.slice(0, 3)).toEqual(['--import', 'tsx', '--import']);
    expect(windows[3]).toMatch(/^file:.*\/ordinary-windows-test-register\.mjs$/u);
    const nativeIdentity = typeScriptFixtureExecArgv({
      platform: 'win32',
      windowsIdentity: 'production',
    });
    expect(nativeIdentity[3]).toMatch(/^file:.*\/ordinary-windows-path-test-register\.mjs$/u);
    expect(typeScriptFixtureExecArgv({ platform: 'linux' })).toEqual(['--import', 'tsx']);
    expect(typeScriptFixtureNodeArgs('/fixture.ts', ['one'], { platform: 'darwin' })).toEqual([
      '--import',
      'tsx',
      '/fixture.ts',
      'one',
    ]);
  });

  it('terminates and awaits a fixture left alive by a failed test', async () => {
    const tracker = createCrossProcessFixtureTracker();
    const child = tracker.track(
      spawn(process.execPath, ['-e', 'setInterval(() => undefined, 1000)'], {
        stdio: 'ignore',
      }),
    );
    expect(child.pid).toBeTypeOf('number');

    await tracker.settle();

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('keeps tracking a live fixture after an IPC error', async () => {
    const tracker = createCrossProcessFixtureTracker();
    const child = tracker.track(
      spawn(process.execPath, ['-e', 'process.disconnect(); setInterval(() => undefined, 1000)'], {
        stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      }),
    );
    await new Promise<void>((resolve) => child.once('disconnect', resolve));
    const ipcError = new Promise<void>((resolve) => child.once('error', () => resolve()));
    child.send({ probe: true });
    await ipcError;

    await tracker.settle();

    expect(child.exitCode !== null || child.signalCode !== null).toBe(true);
  });

  it('settles a fixture that could not be spawned without an unhandled error', async () => {
    const tracker = createCrossProcessFixtureTracker();
    const child = tracker.track(
      spawn('coding-x-definitely-missing-test-command-8c2600ad', [], { stdio: 'ignore' }),
    );

    await expect(tracker.settle()).resolves.toBeUndefined();

    expect(child.pid).toBeUndefined();
  });

  it('waits for inherited pipes to close after the direct fixture exits', async () => {
    const tracker = createCrossProcessFixtureTracker();
    const parentScript = [
      "const { spawn } = require('node:child_process');",
      `const child = spawn(${JSON.stringify(process.execPath)}, ['-e', 'setTimeout(() => process.exit(0), 300)'],`,
      "  { detached: true, stdio: ['ignore', 1, 'ignore'] });",
      'child.unref();',
    ].join('\n');
    const child = tracker.track(
      spawn(process.execPath, ['-e', parentScript], { stdio: ['ignore', 'pipe', 'ignore'] }),
    );
    let closed = false;
    child.once('close', () => {
      closed = true;
    });
    await new Promise<void>((resolve, reject) => {
      child.once('error', reject);
      child.once('exit', () => resolve());
    });
    expect(closed).toBe(false);

    await tracker.settle();

    expect(closed).toBe(true);
  });
});
