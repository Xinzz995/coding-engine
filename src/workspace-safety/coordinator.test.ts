import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspace } from './bootstrap.js';
import { acquireWorkspaceLease } from './lease.js';
import { observeManagedProcessSettlement, SETTLED_OPERATIONS_DIR } from './operation.js';
import { inspectPosixProcessPlacement } from './posix-containment.js';
import { parseQuarantineRecord, QUARANTINE_FILE } from './quarantine.js';
import { createWorkspaceSession } from './session.js';
import {
  canonicalManagedProcessPath,
  environmentEntries,
  runManagedWorkspaceProcess,
} from './coordinator.js';
import {
  ACTIVE_LEASE_DIR,
  type OwnerCommand,
  OPERATION_DIR,
  PROTOCOL_ROOT_DIR,
} from './types.js';

const roots: string[] = [];
const escapedFixtures: Array<{
  readonly controlRoot: string;
  readonly stopPath: string;
  readonly exitedPath: string;
  readonly nonce: string;
}> = [];

async function waitUntil(predicate: () => boolean, timeoutMs = 5_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition timed out');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readCompleteJson<T>(path: string, timeoutMs = 5_000): Promise<T> {
  let parsed: T | undefined;
  await waitUntil(() => {
    try {
      parsed = JSON.parse(readFileSync(path, 'utf8')) as T;
      return true;
    } catch (error) {
      if (
        error instanceof SyntaxError ||
        (error instanceof Error && (error as NodeJS.ErrnoException).code === 'ENOENT')
      ) {
        return false;
      }
      throw error;
    }
  }, timeoutMs);
  if (parsed === undefined) throw new Error('JSON marker completed without a value');
  return parsed;
}

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

async function readySession(command: Exclude<OwnerCommand, 'workspace-init'> = 'run') {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-managed-process-'));
  roots.push(workspace);
  await bootstrapWorkspace({ workspacePath: workspace });
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, command });
  return { workspace, session: createWorkspaceSession(lease) };
}

afterEach(async () => {
  const retainedRoots = new Set<string>();
  let cleanupFailure: Error | undefined;
  for (const fixture of escapedFixtures) {
    try {
      writeFileSync(fixture.stopPath, fixture.nonce, { flag: 'wx' });
    } catch {
      // The nonce-bound exit marker below still decides whether cleanup completed safely.
    }
    try {
      const exited = await readCompleteJson<{ nonce: string; reason: string }>(fixture.exitedPath);
      if (exited.nonce !== fixture.nonce || exited.reason !== 'stop-marker') {
        throw new Error('detached fixture exited without the nonce-bound stop marker');
      }
    } catch (error) {
      retainedRoots.add(fixture.controlRoot);
      cleanupFailure ??= error instanceof Error ? error : new Error('fixture cleanup failed');
    }
  }
  escapedFixtures.splice(0);
  for (const root of roots.splice(0)) {
    if (!retainedRoots.has(root)) rmSync(root, { recursive: true, force: true });
  }
  if (cleanupFailure) throw cleanupFailure;
});

describe.runIf(
  process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32',
)('managed workspace process coordinator', () => {
  it('waits for a complete JSON control marker instead of treating path existence as ready', async () => {
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-partial-json-marker-'));
    roots.push(controlRoot);
    const markerPath = join(controlRoot, 'ready.json');
    writeFileSync(markerPath, '', { flag: 'wx' });

    const reading = readCompleteJson<{ ready: boolean }>(markerPath);
    await new Promise((resolve) => setTimeout(resolve, 20));
    writeFileSync(markerPath, '{"ready":true}\n');

    await expect(reading).resolves.toEqual({ ready: true });
  });

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

  it('runs a managed status probe through the fixed supervisor under a candidate-proof owner', async () => {
    const { workspace, session } = await readySession('candidate-proof');
    const result = await runManagedWorkspaceProcess(session, {
      kind: 'quality-check',
      delegation: 'read-only-v1',
      executable: process.execPath,
      args: ['-e', "process.stdout.write('candidate-proof-owner-ok')"],
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
    expect(result.stdout.toString('utf8')).toBe('candidate-proof-owner-ok');
    await session.close();
  }, 20_000);

  it.runIf(process.platform !== 'win32')(
    'executes the canonical target while preserving a verified symlink argv0',
    async () => {
      const executableRoot = mkdtempSync(join(tmpdir(), 'coding-x-managed-argv0-'));
      roots.push(executableRoot);
      const executableArgv0 = join(executableRoot, 'venv-python-shape');
      symlinkSync(process.execPath, executableArgv0);
      const { session, workspace } = await readySession();
      const result = await runManagedWorkspaceProcess(session, {
        kind: 'quality-check',
        delegation: 'read-only-v1',
        executable: process.execPath,
        executableArgv0,
        args: ['-e', 'process.stdout.write(process.argv0)'],
        cwd: workspace,
        environment: environmentEntries(process.env),
        timeoutMs: 5_000,
      });

      expect(result).toMatchObject({ verdict: 'completed', exitCode: 0 });
      expect(result.stdout.toString('utf8')).toBe(executableArgv0);
      await session.close();
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'rejects argv0 that does not resolve to the fixed executable',
    async () => {
      const executableRoot = mkdtempSync(join(tmpdir(), 'coding-x-managed-wrong-argv0-'));
      roots.push(executableRoot);
      const executableArgv0 = join(executableRoot, 'wrong-runtime');
      symlinkSync('/bin/sh', executableArgv0);
      const { session, workspace } = await readySession();

      await expect(
        runManagedWorkspaceProcess(session, {
          kind: 'quality-check',
          delegation: 'read-only-v1',
          executable: process.execPath,
          executableArgv0,
          args: [],
          cwd: workspace,
          environment: environmentEntries(process.env),
          timeoutMs: 5_000,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(session.state).toBe('open');
      await session.close();
    },
  );

  it('rejects an unavailable target before installing an operation', async () => {
    const { workspace, session } = await readySession();
    const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);

    const failure = await runManagedWorkspaceProcess(session, {
      kind: 'quality-check',
      delegation: 'read-only-v1',
      executable: join(workspace, 'missing-executable'),
      args: [],
      cwd: workspace,
      environment: environmentEntries(process.env),
      timeoutMs: 5_000,
    }).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'invalid' });
    expect(observeManagedProcessSettlement(failure)).toEqual({ status: 'unknown' });

    expect(existsSync(operation)).toBe(false);
    expect(session.state).toBe('open');
    await session.close();
    expect(session.state).toBe('closed');
  });

  it('rejects a read-only command that changes workspace bytes', async () => {
    const { workspace, session } = await readySession();
    const target = join(workspace, 'must-not-exist.txt');

    const failure = await within(
      runManagedWorkspaceProcess(session, {
        kind: 'quality-check',
        delegation: 'read-only-v1',
        executable: process.execPath,
        args: ['-e', `require('node:fs').writeFileSync(${JSON.stringify(target)}, 'unexpected')`],
        cwd: workspace,
        environment: environmentEntries(process.env),
        timeoutMs: 5_000,
      }),
    ).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({ code: 'isolated' });
    expect(observeManagedProcessSettlement(failure)).toMatchObject({
      status: 'confirmed',
      drainReason: 'natural',
    });

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
        terminateDrainMs: 3_000,
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

  it.runIf(process.platform !== 'win32').each([
    ['timeout', 'timeout'],
    ['user interrupt', 'user-interrupt'],
  ] as const)(
    'permanently isolates an opaque POSIX runner after %s even when its detached no-stdio descendant escapes the launcher group',
    async (_label, terminationReason) => {
      const { workspace, session } = await readySession();
      const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-opaque-runner-control-'));
      roots.push(controlRoot);
      const readyPath = join(controlRoot, 'detached-ready.json');
      const stopPath = join(controlRoot, 'detached-stop');
      const exitedPath = join(controlRoot, 'detached-exited.json');
      const nonce = randomUUID();
      const escapedFixture = { controlRoot, stopPath, exitedPath, nonce };
      escapedFixtures.push(escapedFixture);
      const targetPath = fileURLToPath(
        new URL('./__fixtures__/posix-opaque-runner-target.mjs', import.meta.url),
      );
      const controller = new AbortController();
      const options = {
        kind: 'final-review' as const,
        delegation: 'read-only-v1' as const,
        executable: process.execPath,
        args: [targetPath, readyPath, stopPath, exitedPath, nonce],
        cwd: workspace,
        environment: environmentEntries(process.env),
        timeoutMs: terminationReason === 'timeout' ? 1_500 : 10_000,
        ...(terminationReason === 'user-interrupt'
          ? {
              termination: {
                signal: controller.signal,
                reason: 'user-interrupt' as const,
              },
            }
          : {}),
        supervisorTimeouts: {
          naturalDrainMs: 100,
          terminateDrainMs: 3_000,
          ackExitMs: 1_000,
          pollMs: 20,
        },
        posixProcessDomain: 'opaque-runner' as const,
      };

      const running = runManagedWorkspaceProcess(session, options);
      const ready = await readCompleteJson<{
        pid: number;
        nonce: string;
      }>(readyPath);
      expect(ready.nonce).toBe(nonce);
      const detachedPid = ready.pid;
      expect(inspectPosixProcessPlacement(detachedPid)).toMatchObject({
        pid: detachedPid,
        pgid: detachedPid,
        sessionId: detachedPid,
      });
      if (terminationReason === 'user-interrupt') controller.abort();

      const observed = await running.then(
        (result) => ({ kind: 'resolved' as const, result }),
        (error: unknown) => ({ kind: 'rejected' as const, error }),
      );
      expect(observed).toMatchObject({ kind: 'rejected', error: { code: 'isolated' } });
      if (observed.kind !== 'rejected') {
        throw new Error('opaque POSIX runner unexpectedly settled');
      }
      const failure = observed.error;
      expect(observeManagedProcessSettlement(failure)).toEqual({ status: 'unknown' });
      expect(() => process.kill(detachedPid, 0)).not.toThrow();

      const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
      expect(existsSync(operation)).toBe(true);
      expect(parseQuarantineRecord(readFileSync(join(operation, QUARANTINE_FILE))).reason).toBe(
        'operation-proof-missing',
      );
      expect(
        readdirSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, SETTLED_OPERATIONS_DIR)),
      ).toEqual([]);
      expect(session.state).toBe('isolated');
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'permanently isolates an opaque POSIX runner after managed output fails',
    async () => {
      const { workspace, session } = await readySession();
      const stdout = new Writable({
        write(_chunk, _encoding, callback): void {
          callback(new Error('controlled-output-failure'));
        },
      });
      stdout.on('error', () => undefined);
      const stderr = new Writable({
        write(_chunk, _encoding, callback): void {
          callback();
        },
      });

      const failure = await runManagedWorkspaceProcess(session, {
        kind: 'final-review',
        delegation: 'read-only-v1',
        executable: process.execPath,
        args: ['-e', "setInterval(()=>process.stdout.write('output'),10)"],
        cwd: workspace,
        environment: environmentEntries(process.env),
        timeoutMs: 10_000,
        posixProcessDomain: 'opaque-runner',
        output: { mode: 'stream', stdout, stderr },
        supervisorTimeouts: {
          naturalDrainMs: 100,
          terminateDrainMs: 3_000,
          ackExitMs: 1_000,
          pollMs: 20,
        },
      }).then(
        () => undefined,
        (error: unknown) => error,
      );

      expect(failure).toMatchObject({ code: 'isolated' });
      expect(observeManagedProcessSettlement(failure)).toEqual({ status: 'unknown' });
      const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
      expect(parseQuarantineRecord(readFileSync(join(operation, QUARANTINE_FILE))).reason).toBe(
        'operation-proof-missing',
      );
      expect(
        readdirSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, SETTLED_OPERATIONS_DIR)),
      ).toEqual([]);
      expect(session.state).toBe('isolated');
      await expect(session.close()).rejects.toMatchObject({ code: 'isolated' });
    },
    20_000,
  );
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
