import { existsSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspace } from './bootstrap.js';
import { acquireWorkspaceLease } from './lease.js';
import { QUARANTINE_FILE } from './quarantine.js';
import { createWorkspaceSession } from './session.js';
import {
  canonicalManagedProcessPath,
  environmentEntries,
  runManagedWorkspaceProcess,
} from './coordinator.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from './types.js';

const roots: string[] = [];

async function within<T>(promise: Promise<T>, milliseconds = 5_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('operation did not return')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

async function readySession() {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-managed-process-'));
  roots.push(workspace);
  await bootstrapWorkspace({ workspacePath: workspace });
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, command: 'run' });
  return { workspace, session: createWorkspaceSession(lease) };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe.runIf(
  process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32',
)('managed workspace process coordinator', () => {
  it('runs a read-only command through the fixed supervisor and settles the operation', async () => {
    const { workspace, session } = await readySession();
    const result = await runManagedWorkspaceProcess(session, {
      kind: 'quality-check',
      delegation: 'read-only-v1',
      executable: process.execPath,
      args: ['-e', "process.stdout.write('managed-ok');process.stderr.write('managed-err')"],
      cwd: workspace,
      environment: environmentEntries(process.env),
      timeoutMs: 5_000,
    });

    expect(result).toMatchObject({
      verdict: 'completed',
      exitCode: 0,
      timedOut: false,
      processTreeNotEmpty: false,
    });
    expect(result.stdout.toString('utf8')).toBe('managed-ok');
    expect(result.stderr.toString('utf8')).toBe('managed-err');
    await session.close();
  }, 20_000);

  it('rejects an unavailable target before installing an operation', async () => {
    const { workspace, session } = await readySession();
    const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);

    await expect(
      runManagedWorkspaceProcess(session, {
        kind: 'quality-check',
        delegation: 'read-only-v1',
        executable: join(workspace, 'missing-executable'),
        args: [],
        cwd: workspace,
        environment: environmentEntries(process.env),
        timeoutMs: 5_000,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    expect(existsSync(operation)).toBe(false);
    expect(session.state).toBe('open');
    await session.close();
    expect(session.state).toBe('closed');
  });

  it('rejects a read-only command that changes workspace bytes', async () => {
    const { workspace, session } = await readySession();
    const target = join(workspace, 'must-not-exist.txt');

    await expect(
      within(
        runManagedWorkspaceProcess(session, {
          kind: 'quality-check',
          delegation: 'read-only-v1',
          executable: process.execPath,
          args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'unexpected')`],
          cwd: workspace,
          environment: environmentEntries(process.env),
          timeoutMs: 5_000,
        }),
      ),
    ).rejects.toMatchObject({ code: 'isolated' });

    expect(existsSync(target)).toBe(true);
    expect(session.state).toBe('isolated');
    const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
    expect(existsSync(operation)).toBe(true);
    expect(existsSync(join(operation, QUARANTINE_FILE))).toBe(true);
    await expect(within(session.writer.writeFile('late.txt', 'never'))).rejects.toMatchObject({
      code: 'isolated',
    });
    await expect(within(session.close())).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
  }, 20_000);

  it('maps a supervised timeout without accepting the root result', async () => {
    const { workspace, session } = await readySession();
    const result = await runManagedWorkspaceProcess(session, {
      kind: 'quality-check',
      delegation: 'read-only-v1',
      executable: process.execPath,
      args: ['-e', 'setInterval(() => {}, 1000)'],
      cwd: workspace,
      environment: environmentEntries(process.env),
      timeoutMs: 50,
      supervisorTimeouts: {
        naturalDrainMs: 10,
        termMs: 100,
        killMs: 3_000,
        pollMs: 10,
      },
    });

    expect(result).toMatchObject({
      verdict: 'terminated',
      timedOut: true,
      terminationReason: 'timeout',
      exitCode: null,
    });
    await session.close();
  }, 20_000);
});

describe('managed process environment', () => {
  it.runIf(process.platform !== 'win32')(
    'resolves a target alias through the native realpath boundary',
    () => {
      const target = mkdtempSync(join(tmpdir(), 'coding-x-managed-target-'));
      const alias = `${target}-alias`;
      roots.push(alias, target);
      symlinkSync(target, alias, 'dir');

      expect(canonicalManagedProcessPath(alias)).toBe(realpathSync.native(target));
    },
  );

  it('sorts entries and rejects missing values without serializing undefined', () => {
    expect(environmentEntries({ ZED: '2', ALPHA: '1', EMPTY: undefined })).toEqual([
      { name: 'ALPHA', value: '1' },
      { name: 'ZED', value: '2' },
    ]);
  });
});
