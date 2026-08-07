import { StringDecoder } from 'node:string_decoder';
import type { Writable } from 'node:stream';

export const MANAGED_OUTPUT_MAX_BYTES = 16 * 1024 * 1024;
export const MANAGED_OUTPUT_DIAGNOSTIC_MAX_CHARACTERS = 2000;

export type ManagedOutputStream = 'stdout' | 'stderr';

export type ManagedOutputFailure =
  | {
      readonly code: 'output-limit-exceeded';
      readonly limitBytes: number;
      readonly observedBytes: number;
    }
  | {
      readonly code: 'sink-error';
      readonly stream: ManagedOutputStream;
      readonly diagnostic: string;
    }
  | {
      readonly code: 'sink-closed';
      readonly stream: ManagedOutputStream;
    }
  | {
      readonly code: 'supervisor-output-failure';
      readonly diagnostic: string;
    };

export interface ManagedOutputSnapshot {
  readonly totalBytes: number;
  readonly diagnosticTail: string;
  readonly discarded: boolean;
  readonly failure: ManagedOutputFailure | null;
}

export interface ManagedOutputControllerOptions {
  readonly stdout: Writable;
  readonly stderr: Writable;
  readonly onFailure?: (failure: ManagedOutputFailure) => void;
}

interface StreamState {
  readonly sink: Writable;
  readonly decoder: StringDecoder;
  readonly drainWaiters: Set<() => void>;
  readonly writeWaiters: Set<WriteWaiter>;
  readonly submittedWrites: Set<SubmittedWriteTracker>;
  queue: Promise<void>;
  readonly onDrain: () => void;
  readonly onError: (error: Error) => void;
  readonly onClose: () => void;
}

interface WriteWaiter {
  readonly resolve: () => void;
  readonly reject: (error: ManagedOutputError) => void;
}

interface SinkErrorGuard {
  count: number;
  readonly onError: () => void;
}

const MANAGED_OUTPUT_DISCARD_SETTLE_TIMEOUT_MS = 250;
const sinkErrorGuards = new WeakMap<Writable, SinkErrorGuard>();

/**
 * A caller-owned Writable retains the callback passed to `write` until it settles. Keep one
 * process-safe error observer on that sink for exactly the same physical lifetime, even after the
 * controller has stopped waiting for it. This does not end or destroy the caller-owned sink.
 */
function acquireSinkErrorGuard(sink: Writable): () => void {
  let guard = sinkErrorGuards.get(sink);
  if (guard === undefined) {
    guard = { count: 0, onError: (): void => undefined };
    sinkErrorGuards.set(sink, guard);
    sink.on('error', guard.onError);
  }
  guard.count += 1;
  let released = false;
  return (): void => {
    if (released) return;
    released = true;
    // Writable may forward a callback error to `error` after invoking the callback. The guard owns
    // that notification until a complete event-loop turn after physical callback settlement.
    setImmediate(() => {
      const current = sinkErrorGuards.get(sink);
      if (current !== guard) return;
      current.count -= 1;
      if (current.count !== 0) return;
      sink.off('error', current.onError);
      sinkErrorGuards.delete(sink);
    });
  };
}

/**
 * Owns only the callback physically retained by a caller-owned Writable. Before discard, `owner`
 * reports settlement to the controller. Discard removes that reference, so a broken Writable that
 * never settles can retain only this small tracker, the shared sink guard and Node's unavoidable
 * callback/chunk. It cannot retain the controller, stream state or copied input buffer.
 *
 * Node's Writable contract requires an implementation to eventually invoke its callback or report
 * error/close. We cannot repair a sink that violates that contract without destroying caller-owned
 * state, so the shared guard makes such a violation process-safe while remaining listener-bounded.
 */
class SubmittedWriteTracker {
  readonly #releaseSinkErrorGuard: () => void;
  readonly #settledListeners = new Set<() => void>();
  #owner: ((error: Error | null | undefined) => void) | null;
  #settled = false;

  constructor(sink: Writable, owner: (error: Error | null | undefined) => void) {
    this.#releaseSinkErrorGuard = acquireSinkErrorGuard(sink);
    this.#owner = owner;
  }

  get settled(): boolean {
    return this.#settled;
  }

  readonly callback = (error: Error | null | undefined): void => {
    if (this.#settled) return;
    this.#settled = true;
    const owner = this.#owner;
    this.#owner = null;
    try {
      owner?.(error);
    } finally {
      for (const listener of this.#settledListeners) listener();
      this.#settledListeners.clear();
      this.#releaseSinkErrorGuard();
    }
  };

  detachOwner(): void {
    this.#owner = null;
  }

  onSettled(listener: () => void): () => void {
    if (this.#settled) {
      listener();
      return (): void => undefined;
    }
    this.#settledListeners.add(listener);
    return (): void => {
      this.#settledListeners.delete(listener);
    };
  }
}

export class ManagedOutputError extends Error {
  constructor(readonly failure: ManagedOutputFailure) {
    super(describeFailure(failure));
    this.name = 'ManagedOutputError';
  }
}

function describeFailure(failure: ManagedOutputFailure): string {
  if (failure.code === 'output-limit-exceeded') {
    return `受管输出超过 ${String(failure.limitBytes)} bytes（已观察 ${String(failure.observedBytes)} bytes）`;
  }
  if (failure.code === 'sink-error') {
    return `${failure.stream} 输出目标失败：${failure.diagnostic}`;
  }
  if (failure.code === 'supervisor-output-failure') return failure.diagnostic;
  return `${failure.stream} 输出目标已关闭`;
}

function takeLastCodePoints(value: string, maximum: number): string {
  let start = value.length;
  let remaining = maximum;
  while (start > 0 && remaining > 0) {
    start -= 1;
    const codeUnit = value.charCodeAt(start);
    if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff && start > 0) {
      const preceding = value.charCodeAt(start - 1);
      if (preceding >= 0xd800 && preceding <= 0xdbff) start -= 1;
    }
    remaining -= 1;
  }
  return value.slice(start);
}

function boundedDiagnostic(value: string): string {
  return takeLastCodePoints(value, MANAGED_OUTPUT_DIAGNOSTIC_MAX_CHARACTERS);
}

/**
 * Concurrent, bounded forwarding for a supervised child's stdout and stderr.
 *
 * Callers must await each stream's `write` before reading the next chunk from that stream. The
 * controller serializes accidental same-stream overlap, while stdout and stderr remain independent.
 * It does not end caller-owned sinks.
 */
export class ManagedOutputController {
  readonly #streams: Record<ManagedOutputStream, StreamState>;
  readonly #onFailure: ((failure: ManagedOutputFailure) => void) | undefined;
  #totalBytes = 0;
  #diagnosticTail = '';
  #accepting = true;
  #discarded = false;
  #finished = false;
  #failure: ManagedOutputFailure | null = null;
  #finishPromise: Promise<ManagedOutputSnapshot> | undefined;
  #discardedSubmittedWrites: SubmittedWriteTracker[] = [];

  constructor(options: ManagedOutputControllerOptions) {
    this.#onFailure = options.onFailure;
    this.#streams = {
      stdout: this.#createStream('stdout', options.stdout),
      stderr: this.#createStream('stderr', options.stderr),
    };
  }

  get snapshot(): ManagedOutputSnapshot {
    return Object.freeze({
      totalBytes: this.#totalBytes,
      diagnosticTail: this.#diagnosticTail,
      discarded: this.#discarded,
      failure: this.#failure,
    });
  }

  write(stream: ManagedOutputStream, chunk: Uint8Array): Promise<void> {
    if (this.#discarded) return Promise.resolve();
    if (this.#failure !== null) return Promise.reject(new ManagedOutputError(this.#failure));
    if (!this.#accepting) {
      return Promise.reject(new Error('受管输出已经结束'));
    }

    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const observedBytes = this.#totalBytes + bytes.byteLength;
    this.#totalBytes = observedBytes;

    if (observedBytes > MANAGED_OUTPUT_MAX_BYTES) {
      const failure = Object.freeze({
        code: 'output-limit-exceeded',
        limitBytes: MANAGED_OUTPUT_MAX_BYTES,
        observedBytes,
      } as const);
      this.#fail(failure);
      return Promise.reject(new ManagedOutputError(failure));
    }

    this.#appendDiagnostic(this.#streams[stream].decoder.write(bytes));

    // The caller may reuse its read buffer before backpressure clears.
    const ownedBytes = Buffer.from(bytes);
    const state = this.#streams[stream];
    const task = state.queue.then(async () => {
      if (this.#discarded) return;
      if (this.#failure !== null) throw new ManagedOutputError(this.#failure);
      if (state.sink.destroyed || state.sink.closed || state.sink.writableEnded) {
        const failure = Object.freeze({ code: 'sink-closed', stream } as const);
        this.#fail(failure);
        throw new ManagedOutputError(failure);
      }
      const { accepted, callback } = this.#writeToSink(stream, state, ownedBytes);
      await Promise.all([callback, accepted ? Promise.resolve() : this.#waitForDrain(state)]);
      if (this.#discarded) return;
      if (this.#failure !== null) throw new ManagedOutputError(this.#failure);
    });
    state.queue = task.catch(() => undefined);
    return task;
  }

  /** Stop forwarding immediately and release writes waiting on downstream drain. */
  discard(): void {
    if (this.#discarded || this.#finished) return;
    this.#accepting = false;
    this.#discarded = true;
    for (const state of Object.values(this.#streams)) {
      for (const tracker of state.submittedWrites) {
        tracker.detachOwner();
        this.#discardedSubmittedWrites.push(tracker);
      }
      state.submittedWrites.clear();
    }
    this.#releaseDrainWaiters();
    this.#releaseWriteWaiters();
  }

  finish(): Promise<ManagedOutputSnapshot> {
    if (this.#finishPromise !== undefined) return this.#finishPromise;
    this.#accepting = false;
    this.#finishPromise = this.#finish();
    return this.#finishPromise;
  }

  #createStream(name: ManagedOutputStream, sink: Writable): StreamState {
    const drainWaiters = new Set<() => void>();
    const writeWaiters = new Set<WriteWaiter>();
    const submittedWrites = new Set<SubmittedWriteTracker>();
    const state: StreamState = {
      sink,
      decoder: new StringDecoder('utf8'),
      drainWaiters,
      writeWaiters,
      submittedWrites,
      queue: Promise.resolve(),
      onDrain: (): void => this.#resolveDrainWaiters(drainWaiters),
      onError: (error: Error): void => {
        this.#fail(
          Object.freeze({
            code: 'sink-error',
            stream: name,
            diagnostic: boundedDiagnostic(error.message || error.name || 'unknown sink error'),
          }),
        );
      },
      onClose: (): void => this.#fail(Object.freeze({ code: 'sink-closed', stream: name })),
    };
    sink.on('drain', state.onDrain);
    sink.on('error', state.onError);
    sink.on('close', state.onClose);
    return state;
  }

  #writeToSink(
    stream: ManagedOutputStream,
    state: StreamState,
    bytes: Buffer,
  ): { readonly accepted: boolean; readonly callback: Promise<void> } {
    let waiter!: WriteWaiter;
    let settled = false;
    const callback = new Promise<void>((resolve, reject) => {
      waiter = {
        resolve: (): void => {
          if (settled) return;
          settled = true;
          state.writeWaiters.delete(waiter);
          resolve();
        },
        reject: (error): void => {
          if (settled) return;
          settled = true;
          state.writeWaiters.delete(waiter);
          reject(error);
        },
      };
      state.writeWaiters.add(waiter);
    });
    const tracker = new SubmittedWriteTracker(state.sink, (error) => {
      state.submittedWrites.delete(tracker);
      if (error) {
        const failure = Object.freeze({
          code: 'sink-error',
          stream,
          diagnostic: boundedDiagnostic(error.message || error.name || 'unknown sink error'),
        } as const);
        this.#fail(failure);
        waiter.reject(new ManagedOutputError(this.#failure ?? failure));
        return;
      }
      waiter.resolve();
    });
    state.submittedWrites.add(tracker);

    try {
      const accepted = state.sink.write(bytes, tracker.callback);
      return { accepted, callback };
    } catch (error) {
      const diagnostic =
        error instanceof Error ? error.message || error.name : boundedDiagnostic(String(error));
      const failure = Object.freeze({
        code: 'sink-error',
        stream,
        diagnostic: boundedDiagnostic(diagnostic),
      } as const);
      this.#fail(failure);
      waiter.reject(new ManagedOutputError(this.#failure ?? failure));
      state.submittedWrites.delete(tracker);
      tracker.detachOwner();
      tracker.callback(undefined);
      return { accepted: true, callback };
    }
  }

  async #finish(): Promise<ManagedOutputSnapshot> {
    try {
      await Promise.all([this.#streams.stdout.queue, this.#streams.stderr.queue]);
      this.#appendDiagnostic(this.#streams.stdout.decoder.end());
      this.#appendDiagnostic(this.#streams.stderr.decoder.end());
      if (this.#discarded) await this.#waitForSubmittedWritesAfterDiscard();
      // A successful write callback does not prove the Writable stayed healthy. Node and custom
      // sinks may emit a related error or close notification on the following event-loop turn.
      await new Promise<void>((resolve) => setImmediate(resolve));
      if (this.#failure !== null) throw new ManagedOutputError(this.#failure);
      return this.snapshot;
    } finally {
      // A sink error/close may release the logical queue without ever invoking its physical write
      // callback. Do not let that broken callback retain the controller after finish either.
      for (const state of Object.values(this.#streams)) {
        for (const tracker of state.submittedWrites) tracker.detachOwner();
        state.submittedWrites.clear();
      }
      this.#discardedSubmittedWrites = [];
      this.#finished = true;
      this.#detachSinkListeners();
    }
  }

  async #waitForSubmittedWritesAfterDiscard(): Promise<void> {
    const pending = this.#discardedSubmittedWrites.filter((tracker) => !tracker.settled);
    if (pending.length === 0) {
      this.#discardedSubmittedWrites = [];
      return;
    }

    let timeout: NodeJS.Timeout | undefined;
    let remaining = pending.length;
    let resolveSettled!: () => void;
    const settled = new Promise<void>((resolve) => {
      resolveSettled = resolve;
    });
    const unsubscribe = pending.map((tracker) =>
      tracker.onSettled(() => {
        remaining -= 1;
        if (remaining === 0) resolveSettled();
      }),
    );
    const timedOut = new Promise<'timeout'>((resolve) => {
      timeout = setTimeout(() => resolve('timeout'), MANAGED_OUTPUT_DISCARD_SETTLE_TIMEOUT_MS);
    });
    try {
      await Promise.race([settled.then(() => 'settled' as const), timedOut]);
    } finally {
      if (timeout !== undefined) clearTimeout(timeout);
      for (const removeListener of unsubscribe) removeListener();
      this.#discardedSubmittedWrites = [];
    }
  }

  async #waitForDrain(state: StreamState): Promise<void> {
    if (!state.sink.writableNeedDrain) return;
    await new Promise<void>((resolve) => {
      state.drainWaiters.add(resolve);
      if (!state.sink.writableNeedDrain || this.#discarded || this.#failure !== null) {
        state.drainWaiters.delete(resolve);
        resolve();
      }
    });
  }

  #appendDiagnostic(value: string): void {
    if (value.length === 0) return;
    const incomingTail = takeLastCodePoints(value, MANAGED_OUTPUT_DIAGNOSTIC_MAX_CHARACTERS);
    this.#diagnosticTail = takeLastCodePoints(
      this.#diagnosticTail + incomingTail,
      MANAGED_OUTPUT_DIAGNOSTIC_MAX_CHARACTERS,
    );
  }

  #fail(failure: ManagedOutputFailure): void {
    if (this.#discarded || this.#failure !== null) return;
    this.#failure = failure;
    this.#accepting = false;
    this.#releaseDrainWaiters();
    this.#rejectWriteWaiters(failure);
    try {
      this.#onFailure?.(failure);
    } catch {
      // Failure reporting must not replace the mechanical output failure.
    }
  }

  #resolveDrainWaiters(waiters: Set<() => void>): void {
    for (const resolve of waiters) resolve();
    waiters.clear();
  }

  #releaseDrainWaiters(): void {
    this.#resolveDrainWaiters(this.#streams.stdout.drainWaiters);
    this.#resolveDrainWaiters(this.#streams.stderr.drainWaiters);
  }

  #releaseWriteWaiters(): void {
    for (const state of Object.values(this.#streams)) {
      for (const waiter of state.writeWaiters) waiter.resolve();
      state.writeWaiters.clear();
    }
  }

  #rejectWriteWaiters(failure: ManagedOutputFailure): void {
    const error = new ManagedOutputError(failure);
    for (const state of Object.values(this.#streams)) {
      for (const waiter of state.writeWaiters) waiter.reject(error);
      state.writeWaiters.clear();
    }
  }

  #detachSinkListeners(): void {
    for (const state of Object.values(this.#streams)) {
      state.sink.off('drain', state.onDrain);
      state.sink.off('error', state.onError);
      state.sink.off('close', state.onClose);
    }
  }
}
