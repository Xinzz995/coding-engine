import { Writable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  MANAGED_OUTPUT_DIAGNOSTIC_MAX_CHARACTERS,
  MANAGED_OUTPUT_MAX_BYTES,
  ManagedOutputController,
  ManagedOutputError,
} from './managed-output.js';

class ControlledWritable extends Writable {
  readonly writes: Buffer[] = [];
  readonly #callbacks: Array<(error?: Error | null) => void> = [];

  constructor(highWaterMark = 1) {
    super({ highWaterMark });
  }

  override _write(
    chunk: Buffer,
    _encoding: BufferEncoding,
    callback: (error?: Error | null) => void,
  ): void {
    this.writes.push(Buffer.from(chunk));
    this.#callbacks.push(callback);
  }

  releaseOne(error?: Error): void {
    const callback = this.#callbacks.shift();
    if (callback === undefined) throw new Error('no pending write');
    callback(error);
  }
}

function collectingSink(highWaterMark = 32 * 1024 * 1024): {
  readonly sink: Writable;
  readonly chunks: Buffer[];
} {
  const chunks: Buffer[] = [];
  return {
    chunks,
    sink: new Writable({
      highWaterMark,
      write(chunk: Buffer, _encoding, callback): void {
        chunks.push(Buffer.from(chunk));
        callback();
      },
    }),
  };
}

function discardingSink(): Writable {
  return new Writable({
    highWaterMark: MANAGED_OUTPUT_MAX_BYTES + 1,
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
}

describe('ManagedOutputController', () => {
  it('waits for the write callback even when the sink does not request drain', async () => {
    const stdout = new ControlledWritable(1024);
    const stderr = collectingSink();
    const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
    let settled = false;
    const write = controller.write('stdout', Buffer.from('callback-gated')).then(() => {
      settled = true;
    });

    await vi.waitFor(() => expect(stdout.writes.map(String)).toEqual(['callback-gated']));
    await Promise.resolve();
    expect(stdout.writableNeedDrain).toBe(false);
    expect(settled).toBe(false);

    stdout.releaseOne();
    await write;
    expect(settled).toBe(true);
    await controller.finish();
  });

  it('drains stdout and stderr concurrently while preserving each stream order', async () => {
    const stdout = new ControlledWritable();
    const stderr = new ControlledWritable();
    const controller = new ManagedOutputController({ stdout, stderr });

    const stdoutFirst = controller.write('stdout', Buffer.from('out-1'));
    const stdoutSecond = controller.write('stdout', Buffer.from('out-2'));
    const stderrFirst = controller.write('stderr', Buffer.from('err-1'));

    await vi.waitFor(() => {
      expect(stdout.writes.map(String)).toEqual(['out-1']);
      expect(stderr.writes.map(String)).toEqual(['err-1']);
    });
    stdout.releaseOne();
    stderr.releaseOne();
    await Promise.all([stdoutFirst, stderrFirst]);

    await vi.waitFor(() => expect(stdout.writes.map(String)).toEqual(['out-1', 'out-2']));
    stdout.releaseOne();
    await stdoutSecond;
    await controller.finish();
  });

  it('accepts exactly 16 MiB across both streams and fails on one additional byte', async () => {
    const exact = new ManagedOutputController({
      stdout: discardingSink(),
      stderr: discardingSink(),
    });
    await exact.write('stdout', Buffer.alloc(MANAGED_OUTPUT_MAX_BYTES - 1, 0x61));
    await exact.write('stderr', Buffer.from('b'));
    await expect(exact.finish()).resolves.toMatchObject({
      totalBytes: MANAGED_OUTPUT_MAX_BYTES,
      failure: null,
    });

    const failures: unknown[] = [];
    const controller = new ManagedOutputController({
      stdout: discardingSink(),
      stderr: discardingSink(),
      onFailure: (failure) => failures.push(failure),
    });

    await controller.write('stdout', Buffer.alloc(MANAGED_OUTPUT_MAX_BYTES - 1, 0x61));
    await controller.write('stderr', Buffer.from('b'));
    expect(controller.snapshot.totalBytes).toBe(MANAGED_OUTPUT_MAX_BYTES);

    await expect(controller.write('stderr', Buffer.from('c'))).rejects.toMatchObject({
      failure: {
        code: 'output-limit-exceeded',
        limitBytes: MANAGED_OUTPUT_MAX_BYTES,
        observedBytes: MANAGED_OUTPUT_MAX_BYTES + 1,
      },
    });
    expect(failures).toHaveLength(1);
    await expect(controller.finish()).rejects.toBeInstanceOf(ManagedOutputError);
  });

  it('keeps a 2000-code-point UTF-8 tail without corrupting split characters', async () => {
    const stdout = collectingSink();
    const stderr = collectingSink();
    const controller = new ManagedOutputController({ stdout: stdout.sink, stderr: stderr.sink });
    const prefix = Buffer.from('€🙂尾', 'utf8');

    await controller.write('stdout', prefix.subarray(0, 1));
    await controller.write('stderr', Buffer.from('stderr|'));
    await controller.write('stdout', prefix.subarray(1, 4));
    await controller.write('stdout', prefix.subarray(4));
    await controller.write('stderr', Buffer.from(`|${'🙂'.repeat(2001)}终`));
    const snapshot = await controller.finish();

    expect(Array.from(snapshot.diagnosticTail)).toHaveLength(
      MANAGED_OUTPUT_DIAGNOSTIC_MAX_CHARACTERS,
    );
    expect(snapshot.diagnosticTail).toBe(`${'🙂'.repeat(1999)}终`);
    expect(snapshot.diagnosticTail).not.toContain('�');
  });

  it('reports sink errors and closes while releasing a blocked peer stream', async () => {
    const stdout = new ControlledWritable();
    const stderr = new ControlledWritable();
    const observed: unknown[] = [];
    const controller = new ManagedOutputController({
      stdout,
      stderr,
      onFailure: (failure) => observed.push(failure),
    });
    const blocked = controller.write('stdout', Buffer.from('blocked'));

    await vi.waitFor(() => expect(stdout.writes).toHaveLength(1));
    stderr.destroy(new Error('sink-broken'));

    await expect(blocked).rejects.toMatchObject({
      failure: { code: 'sink-error', stream: 'stderr', diagnostic: 'sink-broken' },
    });
    expect(observed).toEqual([{ code: 'sink-error', stream: 'stderr', diagnostic: 'sink-broken' }]);
    stdout.releaseOne();
    await expect(controller.finish()).rejects.toBeInstanceOf(ManagedOutputError);
  });

  it('reports an asynchronous write callback error', async () => {
    const stdout = new ControlledWritable(1024);
    const stderr = collectingSink();
    const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
    const writing = controller.write('stdout', Buffer.from('callback-error'));

    await vi.waitFor(() => expect(stdout.writes).toHaveLength(1));
    stdout.releaseOne(new Error('callback-broken'));

    await expect(writing).rejects.toMatchObject({
      failure: { code: 'sink-error', stream: 'stdout', diagnostic: 'callback-broken' },
    });
    await expect(controller.finish()).rejects.toMatchObject({
      failure: { code: 'sink-error', stream: 'stdout', diagnostic: 'callback-broken' },
    });
  });

  it('safely adopts a discarded write error without replacing the prior termination boundary', async () => {
    const stdout = new ControlledWritable(1024);
    const stderr = collectingSink();
    const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
    const writing = controller.write('stdout', Buffer.from('late-callback-error'));

    await vi.waitFor(() => expect(stdout.writes).toHaveLength(1));
    controller.discard();
    const finishing = controller.finish();
    await expect(writing).resolves.toBeUndefined();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    stdout.releaseOne(new Error('late-callback-broken'));

    await expect(finishing).resolves.toMatchObject({ discarded: true, failure: null });
  });

  it('bounds cleanup without turning a callback delayed beyond 250ms into a failure', async () => {
    const stdout = new ControlledWritable(1024);
    const stderr = collectingSink();
    const stdoutErrorListenersBefore = stdout.listenerCount('error');
    const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
    const writing = controller.write('stdout', Buffer.from('never-acknowledged-yet'));

    await vi.waitFor(() => expect(stdout.writes).toHaveLength(1));
    controller.discard();
    const startedAt = Date.now();
    const finishing = controller.finish();
    await expect(writing).resolves.toBeUndefined();
    const snapshot = await finishing;
    expect(snapshot).toMatchObject({ discarded: true, failure: null });
    expect(Date.now() - startedAt).toBeGreaterThanOrEqual(225);
    expect(Date.now() - startedAt).toBeLessThan(2_000);
    // The controller listener is gone, but one shared physical-write guard remains.
    expect(stdout.listenerCount('error')).toBe(stdoutErrorListenersBefore + 1);

    await new Promise((resolve) => setTimeout(resolve, 75));
    stdout.releaseOne();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(stdout.listenerCount('error')).toBe(stdoutErrorListenersBefore);
  });

  it('safely catches a callback error after bounded cleanup has already completed', async () => {
    const stdout = new ControlledWritable(1024);
    const stderr = collectingSink();
    const stdoutErrorListenersBefore = stdout.listenerCount('error');
    const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
    const writing = controller.write('stdout', Buffer.from('error-after-cleanup-bound'));

    await vi.waitFor(() => expect(stdout.writes).toHaveLength(1));
    controller.discard();
    await expect(writing).resolves.toBeUndefined();
    await expect(controller.finish()).resolves.toMatchObject({ discarded: true, failure: null });
    expect(stdout.listenerCount('error')).toBe(stdoutErrorListenersBefore + 1);

    stdout.releaseOne(new Error('after-finish-callback-broken'));
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    expect(controller.snapshot.failure).toBeNull();
    expect(stdout.listenerCount('error')).toBe(stdoutErrorListenersBefore);
  });

  it('uses one shared safety guard across repeated broken-sink controllers', async () => {
    const stdout = new ControlledWritable(1024);
    const stderr = collectingSink();
    const stdoutErrorListenersBefore = stdout.listenerCount('error');

    for (let index = 0; index < 4; index += 1) {
      const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
      const writing = controller.write('stdout', Buffer.from(`broken-${String(index)}`));
      await vi.waitFor(() =>
        expect(stdout.listenerCount('error')).toBe(stdoutErrorListenersBefore + 2),
      );
      controller.discard();
      await expect(writing).resolves.toBeUndefined();
      await expect(controller.finish()).resolves.toMatchObject({
        discarded: true,
        failure: null,
      });
      expect(stdout.listenerCount('error')).toBe(stdoutErrorListenersBefore + 1);
      expect(stdout.listenerCount('drain')).toBe(0);
      expect(stdout.listenerCount('close')).toBe(0);
    }
  });

  it.each(['error', 'close'] as const)(
    'includes a %s event emitted one turn after a successful write callback',
    async (event) => {
      const stdout = new Writable({
        write(_chunk, _encoding, callback): void {
          callback();
          setImmediate(() => {
            if (event === 'error') this.emit('error', new Error('after-callback-error'));
            else this.emit('close');
          });
        },
      });
      const stderr = collectingSink();
      const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });

      await controller.write('stdout', Buffer.from('callback-then-event'));
      await expect(controller.finish()).rejects.toMatchObject({
        failure:
          event === 'error'
            ? { code: 'sink-error', stream: 'stdout', diagnostic: 'after-callback-error' }
            : { code: 'sink-closed', stream: 'stdout' },
      });
    },
  );

  it('releases a write whose sink closes before invoking its callback', async () => {
    const stdout = new ControlledWritable(1024);
    const stderr = collectingSink();
    const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
    const writing = controller.write('stdout', Buffer.from('close-before-callback'));

    await vi.waitFor(() => expect(stdout.writes).toHaveLength(1));
    stdout.emit('close');

    await expect(writing).rejects.toMatchObject({
      failure: { code: 'sink-closed', stream: 'stdout' },
    });
    await expect(controller.finish()).rejects.toMatchObject({
      failure: { code: 'sink-closed', stream: 'stdout' },
    });
  });

  it('reports a sink that closes without an error', async () => {
    const stdout = collectingSink();
    const stderr = collectingSink();
    const controller = new ManagedOutputController({ stdout: stdout.sink, stderr: stderr.sink });

    stderr.sink.emit('close');

    await expect(controller.write('stdout', Buffer.from('ignored'))).rejects.toMatchObject({
      failure: { code: 'sink-closed', stream: 'stderr' },
    });
    await expect(controller.finish()).rejects.toMatchObject({
      failure: { code: 'sink-closed', stream: 'stderr' },
    });
  });

  it('discard releases downstream backpressure and prevents queued or future sink writes', async () => {
    const stdout = new ControlledWritable();
    const stderr = collectingSink();
    const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
    const first = controller.write('stdout', Buffer.from('first'));
    const queued = controller.write('stdout', Buffer.from('queued'));

    await vi.waitFor(() => expect(stdout.writes.map(String)).toEqual(['first']));
    const finishing = controller.finish();
    controller.discard();

    await Promise.all([first, queued, controller.write('stderr', Buffer.from('future'))]);
    stdout.releaseOne();
    const snapshot = await finishing;
    expect(snapshot.discarded).toBe(true);
    expect(stdout.writes.map(String)).toEqual(['first']);
    expect(stderr.chunks).toEqual([]);
  });

  it('copies accepted input so caller buffer reuse cannot change queued output', async () => {
    const stdout = new ControlledWritable();
    const stderr = collectingSink();
    const controller = new ManagedOutputController({ stdout, stderr: stderr.sink });
    const first = controller.write('stdout', Buffer.from('first'));
    const reused = Buffer.from('second');
    const second = controller.write('stdout', reused);
    reused.fill(0x78);

    await vi.waitFor(() => expect(stdout.writes.map(String)).toEqual(['first']));
    stdout.releaseOne();
    await first;
    await vi.waitFor(() => expect(stdout.writes.map(String)).toEqual(['first', 'second']));
    stdout.releaseOne();
    await second;
    await controller.finish();
  });
});
