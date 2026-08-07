import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import type { WorkspaceSession } from './session.js';

const mocks = vi.hoisted(() => ({
  runWorkspaceOperationControlled: vi.fn(),
  runSupervisor: vi.fn(),
}));

vi.mock('./operation.js', () => ({
  runWorkspaceOperationControlled: mocks.runWorkspaceOperationControlled,
}));

vi.mock('./posix-supervisor.js', () => ({
  readDarkPosixHelperBundle: () => Buffer.from('posix-helper'),
  runDarkPosixSupervisedOperation: mocks.runSupervisor,
}));

vi.mock('./windows-supervisor.js', () => ({
  readDarkWindowsHelperBundle: () => Buffer.from('windows-helper'),
  runDarkWindowsSupervisedOperation: mocks.runSupervisor,
}));

import { environmentEntries, runManagedWorkspaceProcess } from './coordinator.js';

describe('managed output coordinator lifecycle', () => {
  it('releases upstream but safely owns a late sink callback when the operation throws', async () => {
    let pendingOutput: Promise<void> | undefined;
    let releaseStdout: ((error?: Error | null) => void) | undefined;
    mocks.runWorkspaceOperationControlled.mockImplementation(
      async (...args: readonly unknown[]): Promise<unknown> => {
        const execute = args[2] as (operation: object) => Promise<unknown>;
        return await execute({});
      },
    );
    mocks.runSupervisor.mockImplementation(async (...args: readonly unknown[]): Promise<never> => {
      const options = args[1] as {
        readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => Promise<void>;
      };
      pendingOutput = options.onOutput?.('stdout', Buffer.from('pending-output'));
      await vi.waitFor(() => expect(pendingOutput).toBeDefined());
      throw new Error('controlled-operation-failed');
    });

    const stdout = new Writable({
      write(_chunk, _encoding, callback): void {
        // Delay physical acknowledgement beyond coordinator cleanup. Upstream must be released,
        // while a bounded guard continues owning the caller-owned sink callback.
        releaseStdout = callback;
      },
    });
    const stderr = new Writable({
      write(_chunk, _encoding, callback): void {
        callback();
      },
    });
    const listenerCounts = (sink: Writable): readonly number[] =>
      ['drain', 'error', 'close'].map((event) => sink.listenerCount(event));
    const stdoutBefore = listenerCounts(stdout);
    const stderrBefore = listenerCounts(stderr);

    await expect(
      runManagedWorkspaceProcess({} as WorkspaceSession, {
        kind: 'quality-check',
        delegation: 'read-only-v1',
        executable: process.execPath,
        args: [],
        cwd: process.cwd(),
        environment: environmentEntries(process.env),
        timeoutMs: 5_000,
        output: { mode: 'stream', stdout, stderr },
      }),
    ).rejects.toThrow('controlled-operation-failed');

    await expect(pendingOutput).resolves.toBeUndefined();
    expect(listenerCounts(stdout)).toEqual([
      stdoutBefore[0],
      (stdoutBefore[1] ?? 0) + 1,
      stdoutBefore[2],
    ]);
    expect(listenerCounts(stderr)).toEqual(stderrBefore);

    releaseStdout?.(new Error('late-coordinator-callback-error'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(listenerCounts(stdout)).toEqual(stdoutBefore);
  });

  it('preserves a timeout when discarded output acknowledges successfully after 300ms', async () => {
    let releaseStdout: ((error?: Error | null) => void) | undefined;
    mocks.runWorkspaceOperationControlled.mockImplementation(
      async (...args: readonly unknown[]): Promise<unknown> => {
        const execute = args[2] as (operation: object) => Promise<unknown>;
        return await execute({});
      },
    );
    mocks.runSupervisor.mockImplementation(
      async (...args: readonly unknown[]): Promise<unknown> => {
        const options = args[1] as {
          readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => Promise<void>;
          readonly onOutputDiscard?: () => void;
        };
        const pendingOutput = options.onOutput?.('stdout', Buffer.from('timeout-output'));
        await vi.waitFor(() => expect(releaseStdout).toBeDefined());
        options.onOutputDiscard?.();
        setTimeout(() => releaseStdout?.(), 300);
        await pendingOutput;
        return {
          verdict: 'terminated',
          code: null,
          signal: null,
          stdout: Buffer.alloc(0),
          stderr: Buffer.alloc(0),
          leftover: false,
          terminationReason: 'timeout',
        };
      },
    );

    const stdout = new Writable({
      write(_chunk, _encoding, callback): void {
        releaseStdout = callback;
      },
    });
    const stderr = new Writable({
      write(_chunk, _encoding, callback): void {
        callback();
      },
    });
    const stdoutErrorListenersBefore = stdout.listenerCount('error');
    const result = await runManagedWorkspaceProcess({} as WorkspaceSession, {
      kind: 'quality-check',
      delegation: 'read-only-v1',
      executable: process.execPath,
      args: [],
      cwd: process.cwd(),
      environment: environmentEntries(process.env),
      timeoutMs: 5_000,
      output: { mode: 'stream', stdout, stderr },
    });

    expect(result).toMatchObject({
      verdict: 'terminated',
      timedOut: true,
      terminationReason: 'timeout',
      outputFailure: null,
    });
    expect(stdout.listenerCount('error')).toBe(stdoutErrorListenersBefore + 1);
    await new Promise((resolve) => setTimeout(resolve, 75));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stdout.listenerCount('error')).toBe(stdoutErrorListenersBefore);
  });
});
