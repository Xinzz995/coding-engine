import { spawn, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DelegatedSemanticCandidate } from '../contracts/delegated-operation-contract.js';
import { createSystemIdentityAdapter } from './identity.js';
import {
  DRAINED_RECEIPT_FILE,
  type WorkspaceOperationHandleControlled,
} from './operation.js';
import {
  inspectPosixProcessPlacement,
  probePosixProcessGroup,
  type PosixProcessPlacement,
} from './posix-containment.js';
import {
  posixLauncherHelperPath,
  posixSupervisorHelperPath,
  readFixedPosixHelperBundle,
} from './posix-supervisor-assets.js';
import {
  encodeSupervisorAcknowledgement,
  encodeSupervisorAbortBeforeStart,
  encodeSupervisorData,
  encodeSupervisorDrainedReference,
  encodeSupervisorStart,
  encodeSupervisorTerminate,
  parseContainmentDescriptor,
  parseDrainedReceipt,
  parseSupervisorDrained,
  parseSupervisorPrestartDrained,
  type BoundSupervisorDescriptor,
  type ContainmentDescriptor,
  type DrainedReceipt,
  type SupervisorTarget,
  type SupervisorTerminationReason,
} from './supervisor-protocol.js';
import { digestBytes } from './filesystem.js';
import { MonotonicDeadline } from './deadline.js';
import { WorkspaceSafetyError } from './types.js';
export {
  readDarkPosixHelperBundle,
  readPosixHelperBundleFromPaths,
} from './posix-supervisor-assets.js';

const SUPERVISOR_HELPER_PATH = posixSupervisorHelperPath();
const LAUNCHER_HELPER_PATH = posixLauncherHelperPath();
const MAX_EVENT_STRING = 16_384;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
type PosixOutputStream = 'stdout' | 'stderr';

export interface PosixSupervisorTimeouts {
  readonly handshakeMs?: number;
  readonly naturalDrainMs?: number;
  readonly termMs?: number;
  readonly killMs?: number;
  readonly ackMs?: number;
  readonly pollMs?: number;
}

interface ResolvedTimeouts {
  readonly handshakeMs: number;
  readonly naturalDrainMs: number;
  readonly termMs: number;
  readonly killMs: number;
  readonly ackMs: number;
  readonly pollMs: number;
}

export interface PosixSupervisorHooks {
  /** @internal Deterministic fault-injection seam; production never drops protocol events. */
  readonly onProtocolEvent?: (event: {
    readonly type: ProtocolEvent['type'];
  }) => 'deliver' | 'drop';
  readonly onBound?: (facts: {
    readonly supervisorPid: number;
    readonly placement: PosixProcessPlacement;
  }) => void | Promise<void>;
  readonly onArmed?: (facts: {
    readonly supervisorPid: number;
    readonly containment: ContainmentDescriptor;
  }) => void | Promise<void>;
  /** Fault-injection seam after START is dispatched but before its acknowledgement is trusted. */
  readonly onStartDeliveryAttempted?: (facts: {
    readonly startWasMarked: boolean;
  }) => Error | undefined;
  readonly onStarted?: (facts: {
    readonly supervisorPid: number;
    readonly containment: ContainmentDescriptor;
    readonly targetPid: number;
  }) => void | Promise<void>;
  readonly onRootResult?: (facts: {
    readonly supervisorPid: number;
    readonly containment: ContainmentDescriptor;
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }) => void | Promise<void>;
  readonly onTerminating?: (facts: {
    readonly supervisorPid: number;
    readonly containment: ContainmentDescriptor;
    readonly reason: SupervisorTerminationReason;
  }) => void | Promise<void>;
  readonly onDrained?: (facts: {
    readonly supervisorPid: number;
    readonly containment: ContainmentDescriptor;
    readonly receipt: DrainedReceipt;
  }) => void | Promise<void>;
}

export interface RunDarkPosixSupervisedOperationOptions {
  readonly target: SupervisorTarget;
  readonly posixProcessDomain?: 'process-group' | 'opaque-runner';
  readonly commandTimeoutMs?: number;
  readonly termination?: {
    readonly signal: AbortSignal;
    readonly reason: Exclude<SupervisorTerminationReason, 'timeout' | 'output-failure'>;
  };
  readonly timeouts?: PosixSupervisorTimeouts;
  readonly hooks?: PosixSupervisorHooks;
  /**
   * Opt-in streaming output. Each callback is acknowledged to the supervisor only after it
   * resolves, so downstream backpressure propagates into the target process.
   */
  readonly onOutput?: (stream: PosixOutputStream, chunk: Buffer) => Promise<void>;
  /** Release a streaming sink that is waiting for downstream drain before termination. */
  readonly onOutputDiscard?: () => void;
  /** Signals an asynchronous downstream sink failure between output callbacks. */
  readonly outputFailureSignal?: AbortSignal;
}

export interface PosixInvocationOutcome {
  readonly verdict: 'completed' | 'root-failed' | 'process-tree-not-empty' | 'terminated';
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly leftover: boolean;
  readonly terminationReason: SupervisorTerminationReason | null;
  readonly receipt: DrainedReceipt;
  readonly settledPath: string;
  readonly candidate?: DelegatedSemanticCandidate;
  readonly supervisorPid: number;
  readonly containment: PosixContainment;
}

type StrictRecord = Record<string, unknown>;
type PosixContainment = Extract<ContainmentDescriptor, { platform: 'posix-process-group-v1' }>;

interface BoundEvent {
  readonly type: 'BOUND';
  readonly supervisorPid: number;
  readonly supervisorIdentity: string;
  readonly helperDigest: string;
}

interface ArmedEvent {
  readonly type: 'ARMED';
  readonly containment: ContainmentDescriptor;
}

interface StartedEvent {
  readonly type: 'STARTED';
  readonly targetPid: number;
}

interface ResultEvent {
  readonly type: 'RESULT';
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}

interface DrainedEvent {
  readonly type: 'DRAINED';
  readonly messageBytes: Buffer;
}

interface PrestartDrainedEvent {
  readonly type: 'PRESTART_DRAINED';
  readonly messageBytes: Buffer;
}

type ProtocolEvent =
  BoundEvent | ArmedEvent | StartedEvent | ResultEvent | DrainedEvent | PrestartDrainedEvent;

function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', `Invalid POSIX supervisor integration: ${message}`);
}

function isolated(message: string): never {
  throw new WorkspaceSafetyError(
    'isolated',
    `POSIX supervisor did not prove completion: ${message}`,
  );
}

function asRecord(value: unknown, name: string): StrictRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return invalid(`${name} must be an object`);
  }
  return value as StrictRecord;
}

function exactKeys(record: StrictRecord, expected: readonly string[], name: string): void {
  const keys = Reflect.ownKeys(record);
  if (
    keys.some((key) => typeof key !== 'string' || !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    invalid(`${name} has unknown or missing fields`);
  }
}

function boundedString(value: unknown, field: string): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > MAX_EVENT_STRING ||
    value.includes('\0')
  ) {
    return invalid(`${field} must be a bounded string`);
  }
  return value;
}

function positiveInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 0x7fff_ffff) {
    return invalid(`${field} must be a positive process id`);
  }
  return value as number;
}

function resolveTimeouts(input: PosixSupervisorTimeouts = {}): ResolvedTimeouts {
  const bounded = (
    value: number | undefined,
    fallback: number,
    minimum: number,
    field: string,
  ): number => {
    const resolved = value ?? fallback;
    if (!Number.isSafeInteger(resolved) || resolved < minimum || resolved > 60_000) {
      invalid(`${field} is outside the supported range`);
    }
    return resolved;
  };
  const killMs = bounded(input.killMs, 10_000, 1, 'killMs');
  const termMs = bounded(
    input.termMs,
    Math.min(5000, Math.floor(killMs / 2)),
    0,
    'termMs',
  );
  if (termMs > killMs) invalid('termMs must fit inside the total killMs deadline');
  return {
    handshakeMs: bounded(input.handshakeMs, 10_000, 10, 'handshakeMs'),
    naturalDrainMs: bounded(input.naturalDrainMs, 5000, 0, 'naturalDrainMs'),
    termMs,
    killMs,
    ackMs: bounded(input.ackMs, 10_000, 10, 'ackMs'),
    pollMs: bounded(input.pollMs, 25, 1, 'pollMs'),
  };
}

function posixDeadlineError(label: string): WorkspaceSafetyError {
  return new WorkspaceSafetyError(
    'isolated',
    `POSIX supervisor did not prove completion before the ${label} deadline`,
  );
}

interface InstalledReceiptObserver {
  readonly promise: Promise<DrainedEvent>;
  dispose(): void;
}

function observeInstalledDrainedReceipt(
  operation: WorkspaceOperationHandleControlled,
  pollMs: number,
): InstalledReceiptObserver {
  const receiptPath = join(operation.operationPath, DRAINED_RECEIPT_FILE);
  const intervalMs = Math.max(10, Math.min(250, pollMs * 10));
  let disposed = false;
  let timer: NodeJS.Timeout | undefined;
  let resolveReceipt!: (event: DrainedEvent) => void;
  let rejectReceipt!: (error: unknown) => void;
  const promise = new Promise<DrainedEvent>((resolve, reject) => {
    resolveReceipt = resolve;
    rejectReceipt = reject;
  });
  const check = (): void => {
    if (disposed) return;
    if (!existsSync(receiptPath)) {
      timer = setTimeout(check, intervalMs);
      timer.unref();
      return;
    }
    try {
      const receiptBytes = readFileSync(receiptPath);
      const receipt = parseDrainedReceipt(receiptBytes);
      const messageBytes = encodeSupervisorDrainedReference(
        receipt.operationId,
        digestBytes(receiptBytes),
        receipt.proof,
      );
      disposed = true;
      resolveReceipt({ type: 'DRAINED', messageBytes });
    } catch (error) {
      disposed = true;
      rejectReceipt(error);
    }
  };
  queueMicrotask(check);
  return {
    promise,
    dispose: () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    },
  };
}

interface OperationDeadlineState {
  timedOut: boolean;
}

async function runOperationStepBefore<T>(
  deadline: MonotonicDeadline,
  state: OperationDeadlineState,
  label: string,
  operation: () => T | PromiseLike<T>,
): Promise<T> {
  let started = false;
  let finished = false;
  try {
    return await deadline.run(async () => {
      started = true;
      try {
        return await operation();
      } finally {
        finished = true;
      }
    }, () => posixDeadlineError(label));
  } catch (error) {
    if (started && !finished && deadline.expired) state.timedOut = true;
    throw error;
  }
}

function helperBundleBytes(): Buffer {
  return readFixedPosixHelperBundle();
}

function processIdentity(pid: number): string {
  const observed = createSystemIdentityAdapter().readProcessIdentity(pid);
  if (observed.status !== 'found') isolated(`process identity is unavailable for pid ${pid}`);
  return observed.value;
}

/** TEST-ONLY controlled parser entrypoint; production events still enter through the supervisor. */
export function parsePosixSupervisorEventControlled(
  value: unknown,
):
  | ProtocolEvent
  | {
      type: 'OUTPUT';
      operationId: string;
      sequence: number;
      bytes: number;
      stream: PosixOutputStream;
      data: Buffer;
    } {
  const record = asRecord(value, 'supervisor event');
  if (record.schemaVersion !== 1 || typeof record.type !== 'string') {
    invalid('supervisor event version/type is invalid');
  }
  if (record.type === 'BOUND') {
    exactKeys(
      record,
      ['schemaVersion', 'type', 'supervisorPid', 'supervisorIdentity', 'helperDigest'],
      'BOUND',
    );
    return {
      type: 'BOUND',
      supervisorPid: positiveInteger(record.supervisorPid, 'BOUND.supervisorPid'),
      supervisorIdentity: boundedString(record.supervisorIdentity, 'BOUND.supervisorIdentity'),
      helperDigest: boundedString(record.helperDigest, 'BOUND.helperDigest'),
    };
  }
  if (record.type === 'ARMED') {
    exactKeys(record, ['schemaVersion', 'type', 'containment'], 'ARMED');
    return { type: 'ARMED', containment: parseContainmentDescriptor(record.containment) };
  }
  if (record.type === 'STARTED') {
    exactKeys(record, ['schemaVersion', 'type', 'targetPid'], 'STARTED');
    return { type: 'STARTED', targetPid: positiveInteger(record.targetPid, 'STARTED.targetPid') };
  }
  if (record.type === 'RESULT') {
    exactKeys(record, ['schemaVersion', 'type', 'code', 'signal'], 'RESULT');
    if (record.code !== null && !Number.isSafeInteger(record.code))
      invalid('RESULT.code is invalid');
    if (record.signal !== null && typeof record.signal !== 'string') {
      invalid('RESULT.signal is invalid');
    }
    if ((record.code === null) === (record.signal === null)) {
      invalid('RESULT must contain exactly one of code or signal');
    }
    return {
      type: 'RESULT',
      code: record.code as number | null,
      signal: record.signal as NodeJS.Signals | null,
    };
  }
  if (record.type === 'DRAINED') {
    exactKeys(record, ['schemaVersion', 'type', 'messageBase64'], 'DRAINED');
    const encoded = boundedString(record.messageBase64, 'DRAINED.messageBase64');
    const messageBytes = Buffer.from(encoded, 'base64');
    if (messageBytes.toString('base64') !== encoded) {
      invalid('DRAINED envelope is invalid');
    }
    parseSupervisorDrained(messageBytes);
    return { type: 'DRAINED', messageBytes };
  }
  if (record.type === 'PRESTART_DRAINED') {
    exactKeys(record, ['schemaVersion', 'type', 'messageBase64'], 'PRESTART_DRAINED');
    const encoded = boundedString(record.messageBase64, 'PRESTART_DRAINED.messageBase64');
    const messageBytes = Buffer.from(encoded, 'base64');
    if (messageBytes.toString('base64') !== encoded) {
      invalid('PRESTART_DRAINED envelope is invalid');
    }
    parseSupervisorPrestartDrained(messageBytes);
    return { type: 'PRESTART_DRAINED', messageBytes };
  }
  if (record.type === 'OUTPUT') {
    exactKeys(
      record,
      ['schemaVersion', 'type', 'operationId', 'sequence', 'bytes', 'stream', 'data'],
      'OUTPUT',
    );
    const operationId = boundedString(record.operationId, 'OUTPUT.operationId');
    const sequence = positiveInteger(record.sequence, 'OUTPUT.sequence');
    const bytes = positiveInteger(record.bytes, 'OUTPUT.bytes');
    if (record.stream !== 'stdout' && record.stream !== 'stderr')
      invalid('OUTPUT stream is invalid');
    const encoded = boundedString(record.data, 'OUTPUT.data');
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded) invalid('OUTPUT data is not canonical base64');
    if (data.length !== bytes) invalid('OUTPUT bytes do not match decoded data');
    return { type: 'OUTPUT', operationId, sequence, bytes, stream: record.stream, data };
  }
  if (record.type === 'FAILURE') {
    exactKeys(record, ['schemaVersion', 'type', 'message'], 'FAILURE');
    return isolated(boundedString(record.message, 'FAILURE.message'));
  }
  return invalid('supervisor event type is unsupported');
}

class PosixSupervisorProcess {
  readonly pid: number;
  readonly stdout: Buffer[] = [];
  readonly stderr: Buffer[] = [];

  #events: ProtocolEvent[] = [];
  #waiter:
    | {
        readonly expected: readonly ProtocolEvent['type'][];
        readonly resolve: (event: ProtocolEvent) => void;
        readonly reject: (error: unknown) => void;
        readonly timer: NodeJS.Timeout | undefined;
      }
    | undefined;
  #terminalError: Error | undefined;
  #outputBytes = 0;
  #lastOutputSequence = 0;
  #discardOutput = false;
  #outputQueues: Record<PosixOutputStream, Promise<void>> = {
    stdout: Promise.resolve(),
    stderr: Promise.resolve(),
  };
  #resolveOutputFailure: (reason: SupervisorTerminationReason) => void = () => undefined;
  readonly outputFailure: Promise<SupervisorTerminationReason>;
  #exitExpected = false;
  #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    private readonly child: ChildProcess,
    private readonly timeouts: ResolvedTimeouts,
    private readonly operationId: string,
    private readonly onOutput: RunDarkPosixSupervisedOperationOptions['onOutput'],
    private readonly onProtocolEvent: PosixSupervisorHooks['onProtocolEvent'],
  ) {
    if (child.pid === undefined) isolated('supervisor spawn did not return a pid');
    this.pid = child.pid;
    this.outputFailure = new Promise((resolve) => {
      this.#resolveOutputFailure = resolve;
    });
    child.on('message', (message: unknown) => this.#push(message));
    child.once('error', (error) => this.#fail(error));
    this.#exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
        if (!this.#exitExpected) {
          this.#fail(
            new WorkspaceSafetyError(
              'isolated',
              'POSIX supervisor exited before installing and acknowledging completion',
            ),
          );
        }
      });
    });
  }

  #push(message: unknown): void {
    let event: ReturnType<typeof parsePosixSupervisorEventControlled>;
    try {
      event = parsePosixSupervisorEventControlled(message);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (event.type === 'OUTPUT') {
      if (event.operationId !== this.operationId) {
        this.#fail(new WorkspaceSafetyError('invalid', 'OUTPUT operation binding is invalid'));
        return;
      }
      if (event.sequence !== this.#lastOutputSequence + 1) {
        this.#fail(
          new WorkspaceSafetyError(
            'invalid',
            'OUTPUT sequence is duplicated, missing, or out of order',
          ),
        );
        return;
      }
      this.#lastOutputSequence = event.sequence;
      this.#outputQueues[event.stream] = this.#outputQueues[event.stream]
        .then(() => this.#consumeOutput(event))
        .catch((error: unknown) => this.#fail(error));
      return;
    }
    try {
      if (this.onProtocolEvent?.({ type: event.type }) === 'drop') return;
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (this.#waiter) {
      if (!this.#waiter.expected.includes(event.type)) {
        this.#fail(
          new WorkspaceSafetyError(
            'invalid',
            `Expected ${this.#waiter.expected.join('/')} but received ${event.type}`,
          ),
        );
        return;
      }
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    this.#events.push(event);
  }

  async #consumeOutput(
    event: Extract<ReturnType<typeof parsePosixSupervisorEventControlled>, { type: 'OUTPUT' }>,
  ): Promise<void> {
    if (!this.#discardOutput) {
      this.#outputBytes += event.data.length;
      if (this.#outputBytes > MAX_OUTPUT_BYTES) {
        if (!this.onOutput) {
          throw new WorkspaceSafetyError('isolated', 'POSIX target output exceeded the bound');
        }
        this.#discardOutput = true;
        this.#resolveOutputFailure('output-failure');
      }
    }
    if (!this.#discardOutput) {
      if (!this.onOutput) {
        (event.stream === 'stdout' ? this.stdout : this.stderr).push(event.data);
      } else {
        try {
          await this.onOutput(event.stream, event.data);
        } catch {
          this.#discardOutput = true;
          this.#resolveOutputFailure('output-failure');
        }
      }
    }

    if (!this.#discardOutput) {
      await this.send({
        schemaVersion: 1,
        type: 'OUTPUT_ACK',
        operationId: this.operationId,
        sequence: event.sequence,
        bytes: event.bytes,
      });
    }
  }

  #fail(error: unknown): void {
    if (this.#terminalError !== undefined) return;
    const normalized = error instanceof Error ? error : new Error('unknown supervisor failure');
    this.#terminalError = normalized;
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(normalized);
    }
  }

  #cancelWait(error: Error): void {
    if (!this.#waiter) return;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  cancelPendingWaitForReceiptReplay(): void {
    this.#cancelWait(new Error('installed receipt replay superseded the pending IPC wait'));
  }

  next<T extends ProtocolEvent['type']>(expected: T): Promise<Extract<ProtocolEvent, { type: T }>> {
    return this.nextAny([expected]);
  }

  nextAny<T extends ProtocolEvent['type']>(
    expected: readonly T[],
    timeoutMs: number | null = this.timeouts.handshakeMs,
  ): Promise<Extract<ProtocolEvent, { type: T }>> {
    if (this.#terminalError !== undefined) return Promise.reject(this.#terminalError);
    const queued = this.#events.shift();
    if (queued) {
      if (!expected.includes(queued.type as T)) {
        return Promise.reject(
          new WorkspaceSafetyError(
            'invalid',
            `Expected ${expected.join('/')} but received ${queued.type}`,
          ),
        );
      }
      return Promise.resolve(queued as Extract<ProtocolEvent, { type: T }>);
    }
    if (this.#waiter)
      return Promise.reject(new Error('concurrent supervisor event waits are invalid'));
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(() => {
              this.#fail(
                new WorkspaceSafetyError('isolated', `Timed out waiting for ${expected.join('/')}`),
              );
            }, timeoutMs);
      this.#waiter = {
        expected,
        resolve: (event) => resolve(event as Extract<ProtocolEvent, { type: T }>),
        reject,
        timer,
      };
    });
  }

  send(envelope: StrictRecord): Promise<void> {
    if (!this.child.connected || !this.child.send) {
      return Promise.reject(new Error('supervisor IPC is closed'));
    }
    return new Promise((resolve, reject) => {
      this.child.send(envelope, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  discardOutput(): void {
    this.#discardOutput = true;
  }

  nextBefore<T extends ProtocolEvent['type']>(
    expected: readonly T[],
    deadline: MonotonicDeadline,
    label: string,
  ): Promise<Extract<ProtocolEvent, { type: T }>> {
    return deadline.run(
      () => this.nextAny(expected, null),
      () => {
        const error = posixDeadlineError(label);
        this.#cancelWait(error);
        return error;
      },
    );
  }

  racePendingBefore<T extends ProtocolEvent['type']>(
    pending: Promise<Extract<ProtocolEvent, { type: T }>>,
    deadline: MonotonicDeadline,
    label: string,
    termination?: Promise<SupervisorTerminationReason>,
  ): Promise<
    | { readonly kind: 'event'; readonly event: Extract<ProtocolEvent, { type: T }> }
    | { readonly kind: 'termination'; readonly reason: SupervisorTerminationReason }
  > {
    const timeoutError = (): WorkspaceSafetyError => posixDeadlineError(label);
    const remaining = deadline.remainingMs();
    if (remaining === 0) {
      const error = timeoutError();
      this.#cancelWait(error);
      return Promise.reject(error);
    }
    return new Promise((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        const error = timeoutError();
        this.#cancelWait(error);
        reject(error);
      }, remaining);
      void pending.then(
        (event) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          if (deadline.expired) {
            const error = timeoutError();
            this.#cancelWait(error);
            reject(error);
          } else {
            resolve({ kind: 'event', event });
          }
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(
            deadline.expired
              ? timeoutError()
              : error instanceof Error
                ? error
                : new Error(String(error)),
          );
        },
      );
      void termination?.then(
        (reason) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          resolve({ kind: 'termination', reason });
        },
        (error: unknown) => {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          reject(error instanceof Error ? error : new Error(String(error)));
        },
      );
    });
  }

  sendBefore(
    envelope: StrictRecord,
    deadline: MonotonicDeadline,
    label: string,
    beforeSend?: () => void,
    afterSendAttempt?: () => Error | undefined,
  ): Promise<void> {
    return deadline.run(async () => {
      beforeSend?.();
      const delivery = this.send(envelope);
      let injectedFailure: Error | undefined;
      try {
        injectedFailure = afterSendAttempt?.();
      } catch (error) {
        void delivery.catch(() => undefined);
        throw error;
      }
      if (injectedFailure) {
        void delivery.catch(() => undefined);
        throw injectedFailure;
      }
      await delivery;
    }, () => posixDeadlineError(label));
  }

  disconnect(): void {
    if (this.child.connected) this.child.disconnect();
  }

  expectCleanExit(): void {
    this.#exitExpected = true;
  }

  waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return this.#exit;
  }

  waitForExitBefore(
    deadline: MonotonicDeadline,
    label: string,
  ): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    return deadline.run(() => this.#exit, () => posixDeadlineError(label));
  }

  async abort(deadline: MonotonicDeadline): Promise<void> {
    this.#exitExpected = true;
    this.#fail(posixDeadlineError('supervisor abort'));
    this.disconnect();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (deadline.expired) {
      if (this.child.exitCode === null && this.child.signalCode === null) this.child.kill('SIGKILL');
      return;
    }
    const gracefulMs = Math.min(this.timeouts.killMs, deadline.remainingMs());
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.#exit.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), gracefulMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!exited) {
      this.child.kill('SIGKILL');
      try {
        await deadline.run(() => this.#exit, () => posixDeadlineError('forced abort exit'));
      } catch {
        // The caller remains fail-closed and verifies exact death before any normal settlement.
      }
    }
  }
}

function spawnSupervisor(
  timeouts: ResolvedTimeouts,
  operationId: string,
  onOutput: RunDarkPosixSupervisedOperationOptions['onOutput'],
  onProtocolEvent: PosixSupervisorHooks['onProtocolEvent'],
): PosixSupervisorProcess {
  if (process.platform === 'win32') {
    throw new WorkspaceSafetyError('unsupported', 'POSIX supervisor is unavailable on Windows');
  }
  const child = spawn(
    process.execPath,
    [SUPERVISOR_HELPER_PATH, LAUNCHER_HELPER_PATH, JSON.stringify(timeouts)],
    {
      detached: true,
      stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
      env: { PATH: '/usr/bin:/bin', LANG: 'C', LC_ALL: 'C', TZ: 'UTC' },
      windowsHide: true,
    },
  );
  return new PosixSupervisorProcess(child, timeouts, operationId, onOutput, onProtocolEvent);
}

function validateSupervisorBound(
  processHandle: PosixSupervisorProcess,
  event: BoundEvent,
  helperDigest: string,
): BoundSupervisorDescriptor {
  if (
    event.supervisorPid !== processHandle.pid ||
    event.supervisorIdentity !== processIdentity(processHandle.pid) ||
    event.helperDigest !== helperDigest
  ) {
    invalid('BOUND does not match the spawned fixed supervisor');
  }
  const placement = inspectPosixProcessPlacement(processHandle.pid);
  if (placement.pgid !== processHandle.pid || placement.sessionId !== processHandle.pid) {
    isolated('supervisor is not in its own POSIX session/process group');
  }
  return {
    platform: 'posix-process-group-v1',
    supervisorPid: processHandle.pid,
    supervisorIdentity: event.supervisorIdentity,
    signalIsolation: 'posix-supervisor-session-signal-shield-v1',
    helperDigest,
  };
}

function validateContainment(supervisorPid: number, event: ArmedEvent): PosixContainment {
  const containment = event.containment;
  if (containment.platform !== 'posix-process-group-v1') invalid('ARMED is not POSIX containment');
  if (containment.launcherPid !== containment.pgid) {
    isolated('launcher pid is not the persisted process-group id');
  }
  const launcherPlacement = inspectPosixProcessPlacement(containment.launcherPid);
  const supervisorPlacement = inspectPosixProcessPlacement(supervisorPid);
  if (
    launcherPlacement.pgid !== containment.pgid ||
    launcherPlacement.sessionId !== containment.pgid ||
    processIdentity(containment.launcherPid) !== containment.launcherIdentity ||
    supervisorPlacement.pgid === containment.pgid ||
    supervisorPlacement.sessionId === containment.pgid
  ) {
    isolated('live launcher/supervisor placement does not match ARMED');
  }
  return containment;
}

function assertExactSupervisorDeath(pid: number, expectedIdentity: string): void {
  const observed = createSystemIdentityAdapter().readProcessIdentity(pid);
  if (observed.status === 'unknown') isolated('supervisor death identity is unknown');
  if (observed.status === 'found' && observed.value === expectedIdentity) {
    isolated('supervisor is still exact-live after ACK');
  }
}

interface TerminationTrigger {
  readonly promise: Promise<SupervisorTerminationReason>;
  readonly reason: SupervisorTerminationReason | undefined;
  readonly commandDeadline: MonotonicDeadline | undefined;
  startCommandTimer(): void;
  commandDeadlineExpired(): boolean;
  rootCompleted(): void;
  dispose(): void;
}

export function createTerminationTrigger(
  commandTimeoutMs: number | undefined,
  termination: RunDarkPosixSupervisedOperationOptions['termination'],
  outputFailureSignal?: AbortSignal,
): TerminationTrigger {
  if (
    commandTimeoutMs !== undefined &&
    (!Number.isSafeInteger(commandTimeoutMs) ||
      commandTimeoutMs < 1 ||
      commandTimeoutMs > 0x7fff_ffff)
  ) {
    invalid('commandTimeoutMs is outside the supported range');
  }
  let frozenReason: SupervisorTerminationReason | undefined;
  let timeout: NodeJS.Timeout | undefined;
  let commandDeadline: MonotonicDeadline | undefined;
  let resolveTrigger: (reason: SupervisorTerminationReason) => void = () => undefined;
  const promise = new Promise<SupervisorTerminationReason>((resolve) => {
    resolveTrigger = resolve;
  });
  const freeze = (reason: SupervisorTerminationReason): void => {
    if (frozenReason !== undefined) return;
    frozenReason = reason;
    if (timeout) clearTimeout(timeout);
    timeout = undefined;
    resolveTrigger(reason);
  };
  const onAbort = (): void => freeze(termination!.reason);
  const onOutputFailure = (): void => freeze('output-failure');
  if (termination) {
    termination.signal.addEventListener('abort', onAbort, { once: true });
    if (termination.signal.aborted) freeze(termination.reason);
  }
  if (outputFailureSignal) {
    outputFailureSignal.addEventListener('abort', onOutputFailure, { once: true });
    if (outputFailureSignal.aborted) freeze('output-failure');
  }
  return {
    promise,
    get reason() {
      return frozenReason;
    },
    get commandDeadline() {
      return commandDeadline;
    },
    startCommandTimer() {
      if (commandTimeoutMs !== undefined && frozenReason === undefined) {
        commandDeadline = MonotonicDeadline.after(commandTimeoutMs);
        timeout = setTimeout(() => freeze('timeout'), commandDeadline.remainingMs());
      }
    },
    commandDeadlineExpired() {
      if (!commandDeadline?.expired) return false;
      freeze('timeout');
      return frozenReason === 'timeout';
    },
    rootCompleted() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      commandDeadline = undefined;
    },
    dispose() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      termination?.signal.removeEventListener('abort', onAbort);
      outputFailureSignal?.removeEventListener('abort', onOutputFailure);
    },
  };
}

type PrestartAbortReason = 'setup-failed' | 'capability-unavailable' | 'user-interrupt';

function prestartAbortReason(
  error: unknown,
  terminationReason: SupervisorTerminationReason | undefined,
): PrestartAbortReason {
  if (terminationReason !== undefined) return 'user-interrupt';
  return error instanceof WorkspaceSafetyError && error.code === 'unsupported'
    ? 'capability-unavailable'
    : 'setup-failed';
}

function throwIfPrestartInterrupted(trigger: TerminationTrigger): void {
  if (trigger.reason === undefined) return;
  throw new WorkspaceSafetyError(
    'isolated',
    `POSIX operation was interrupted before START: ${trigger.reason}`,
  );
}

async function abortPreparedPosixOperation(
  operation: WorkspaceOperationHandleControlled,
  processHandle: PosixSupervisorProcess | undefined,
  supervisorIdentity: string | undefined,
  reason: PrestartAbortReason,
  operationDeadline: OperationDeadlineState,
  deadline: MonotonicDeadline,
): Promise<void> {
  if (processHandle) {
    if (!supervisorIdentity) isolated('spawned supervisor identity was never established');
    await processHandle.abort(deadline);
    assertExactSupervisorDeath(processHandle.pid, supervisorIdentity);
  }
  await runOperationStepBefore(
    deadline,
    operationDeadline,
    'prestart settlement',
    () =>
      operation.abortPrestartControlled({
        reason,
        proof: 'supervisor-never-bound-v1',
        supervisor: processHandle ? 'dead' : 'never-created',
        containment: 'not-created',
      }),
  );
}

async function abortPreparedBoundPosixOperation(
  operation: WorkspaceOperationHandleControlled,
  processHandle: PosixSupervisorProcess,
  descriptor: BoundSupervisorDescriptor,
  reason: PrestartAbortReason,
  operationDeadline: OperationDeadlineState,
  deadline: MonotonicDeadline,
): Promise<void> {
  processHandle.expectCleanExit();
  await processHandle.sendBefore(
    {
      schemaVersion: 1,
      type: 'ABORT_BEFORE_START',
      messageBase64: encodeSupervisorAbortBeforeStart(operation.operationId).toString('base64'),
    },
    deadline,
    'prestart abort delivery',
  );
  const event = await processHandle.nextBefore(
    ['PRESTART_DRAINED'],
    deadline,
    'prestart drain',
  );
  const drained = parseSupervisorPrestartDrained(event.messageBytes);
  if (
    drained.operationId !== operation.operationId ||
    drained.supervisorPid !== processHandle.pid ||
    drained.supervisorIdentity !== descriptor.supervisorIdentity
  ) {
    invalid('PRESTART_DRAINED does not bind the prepared-bound supervisor');
  }
  processHandle.disconnect();
  const exit = await processHandle.waitForExitBefore(deadline, 'prestart supervisor exit');
  if (exit.code !== 0 || exit.signal !== null) {
    isolated('supervisor did not close cleanly after prestart abort');
  }
  assertExactSupervisorDeath(processHandle.pid, descriptor.supervisorIdentity);
  await runOperationStepBefore(
    deadline,
    operationDeadline,
    'prestart settlement',
    () =>
      operation.abortPrestartControlled({
        reason,
        proof: 'supervisor-prestart-empty-v1',
        supervisor: 'dead',
        containment: 'empty',
        prestartDrainedBytes: event.messageBytes,
      }),
  );
}

async function quarantineUnfinishedPosixOperation(
  operation: WorkspaceOperationHandleControlled,
  reason: 'containment-unconfirmed' | 'operation-proof-missing',
  deadline: MonotonicDeadline,
  operationDeadline: OperationDeadlineState,
): Promise<void> {
  if (!deadline.expired && !operation.settled && !operation.quarantined) {
    await runOperationStepBefore(deadline, operationDeadline, 'quarantine installation', () =>
      operation.installQuarantineControlled(reason),
    );
  }
}

export async function runDarkPosixSupervisedOperation(
  operation: WorkspaceOperationHandleControlled,
  options: RunDarkPosixSupervisedOperationOptions,
): Promise<PosixInvocationOutcome> {
  let terminationTrigger: TerminationTrigger | undefined;
  let processHandle: PosixSupervisorProcess | undefined;
  let receiptObserver: InstalledReceiptObserver | undefined;
  let supervisorIdentity: string | undefined;
  let descriptor: BoundSupervisorDescriptor | undefined;
  let terminationAttempted = false;
  let completed = false;
  let resolvedTimeouts: ResolvedTimeouts | undefined;
  let failureCloseoutDeadline: MonotonicDeadline | undefined;
  let outputDiscarded = false;
  let startSent = false;
  const operationDeadline: OperationDeadlineState = { timedOut: false };
  const discardManagedOutput = (): void => {
    if (outputDiscarded) return;
    outputDiscarded = true;
    try {
      options.onOutputDiscard?.();
    } catch {
      // Cleanup must continue even if the optional downstream release hook is faulty.
    }
    processHandle?.discardOutput();
  };
  try {
    terminationTrigger = createTerminationTrigger(
      options.commandTimeoutMs,
      options.termination,
      options.outputFailureSignal,
    );
    throwIfPrestartInterrupted(terminationTrigger);
    const target = {
      ...options.target,
      executableArgv0: options.target.executableArgv0 ?? options.target.executable,
    };
    if (
      !isAbsolute(target.executable) ||
      !isAbsolute(target.executableArgv0) ||
      !isAbsolute(target.cwd)
    ) {
      invalid('target executable, argv0 and cwd must be absolute');
    }
    const timeouts = resolveTimeouts(options.timeouts);
    resolvedTimeouts = timeouts;
    const prepareDeadline = MonotonicDeadline.after(timeouts.handshakeMs);
    const helperBytes = helperBundleBytes();
    const helperDigest = digestBytes(helperBytes);
    processHandle = spawnSupervisor(
      timeouts,
      operation.operationId,
      options.onOutput,
      options.hooks?.onProtocolEvent,
    );
    supervisorIdentity = processIdentity(processHandle.pid);
    throwIfPrestartInterrupted(terminationTrigger);
    const boundEvent = await processHandle.nextBefore(['BOUND'], prepareDeadline, 'prepare');
    descriptor = validateSupervisorBound(processHandle, boundEvent, helperDigest);
    await prepareDeadline.run(
      () =>
        options.hooks?.onBound?.({
          supervisorPid: processHandle!.pid,
          placement: inspectPosixProcessPlacement(processHandle!.pid),
        }),
      () => posixDeadlineError('prepare hook'),
    );
    throwIfPrestartInterrupted(terminationTrigger);
    await runOperationStepBefore(
      prepareDeadline,
      operationDeadline,
      'prepare binding',
      () => operation.bindSupervisorControlled(descriptor!),
    );
    await runOperationStepBefore(
      prepareDeadline,
      operationDeadline,
      'prepare authority read',
      () => operation.readPreparedBoundBindingControlled(helperBytes),
    );
    throwIfPrestartInterrupted(terminationTrigger);

    const dataBytes = encodeSupervisorData({
      operationId: operation.operationId,
      target,
    });
    await processHandle.sendBefore(
      {
        schemaVersion: 1,
        type: 'DATA',
        workspacePath: operation.workspacePath,
        posixProcessDomain: options.posixProcessDomain ?? 'process-group',
        messageBase64: dataBytes.toString('base64'),
      },
      prepareDeadline,
      'DATA delivery',
    );

    const armedEvent = await processHandle.nextBefore(['ARMED'], prepareDeadline, 'prepare');
    const containment = validateContainment(processHandle.pid, armedEvent);
    throwIfPrestartInterrupted(terminationTrigger);
    await runOperationStepBefore(
      prepareDeadline,
      operationDeadline,
      'prepare containment binding',
      () => operation.armContainmentControlled(containment),
    );
    const armedBinding = await runOperationStepBefore(
      prepareDeadline,
      operationDeadline,
      'prepare armed authority read',
      () => operation.readArmedBindingControlled(helperBytes),
    );
    await prepareDeadline.run(
      () => options.hooks?.onArmed?.({ supervisorPid: processHandle!.pid, containment }),
      () => posixDeadlineError('prepare hook'),
    );
    let terminationSent: SupervisorTerminationReason | undefined;
    let started: StartedEvent | undefined;
    let result: ResultEvent | undefined;
    let drained: DrainedEvent | undefined;
    let closeoutDeadline: MonotonicDeadline | undefined;
    const runningSupervisor = processHandle;

    const sendTermination = async (reason: SupervisorTerminationReason): Promise<void> => {
      if (terminationSent !== undefined) return;
      discardManagedOutput();
      if (closeoutDeadline) closeoutDeadline.tightenAfter(timeouts.killMs);
      else closeoutDeadline = MonotonicDeadline.after(timeouts.killMs);
      failureCloseoutDeadline = closeoutDeadline;
      terminationSent = reason;
      terminationAttempted = true;
      await runningSupervisor.sendBefore(
        {
          schemaVersion: 1,
          type: 'TERMINATE',
          messageBase64: encodeSupervisorTerminate(operation.operationId, reason).toString('base64'),
        },
        closeoutDeadline,
        'termination delivery',
      );
      await closeoutDeadline.run(
        () =>
          options.hooks?.onTerminating?.({
            supervisorPid: runningSupervisor.pid,
            containment,
            reason,
          }),
        () => posixDeadlineError('termination hook'),
      );
    };

    if (terminationTrigger.reason !== undefined) {
      await sendTermination(terminationTrigger.reason);
    } else {
      const startBytes = encodeSupervisorStart(
        operation.operationId,
        armedBinding.activeChildDigest,
      );
      await processHandle.sendBefore(
        {
          schemaVersion: 1,
          type: 'START',
          messageBase64: startBytes.toString('base64'),
        },
        prepareDeadline,
        'START delivery',
        () => {
          // Once START delivery begins, the helper may accept it even if the parent-side send
          // later fails. Treat that window conservatively as a started opaque runner domain.
          startSent = true;
        },
        () => options.hooks?.onStartDeliveryAttempted?.({ startWasMarked: startSent }),
      );
      terminationTrigger.startCommandTimer();
    }

    const anyTermination = Promise.race([
      terminationTrigger.promise,
      processHandle.outputFailure,
    ]);
    receiptObserver = observeInstalledDrainedReceipt(operation, timeouts.pollMs);
    const receiptReplay = receiptObserver.promise.then((event) => ({
      kind: 'receipt' as const,
      event,
    }));
    let replayedInstalledReceipt = false;
    let pendingEvent = processHandle.nextAny(['STARTED', 'RESULT', 'DRAINED'] as const, null);
    while (!drained) {
      if (terminationSent === undefined && terminationTrigger.reason !== undefined) {
        await sendTermination(terminationTrigger.reason);
      }
      const next = closeoutDeadline
        ? await Promise.race([
            processHandle.racePendingBefore(
              pendingEvent,
              closeoutDeadline,
              'termination and drain',
              terminationSent === undefined ? anyTermination : undefined,
            ),
            receiptReplay,
          ])
        : await Promise.race([
            pendingEvent.then((event) => ({ kind: 'event' as const, event })),
            anyTermination.then((reason) => ({
              kind: 'termination' as const,
              reason,
            })),
            receiptReplay,
          ]);
      if (next.kind === 'receipt') {
        replayedInstalledReceipt = true;
        processHandle.cancelPendingWaitForReceiptReplay();
        drained = next.event;
        break;
      }
      if (next.kind === 'termination') {
        await sendTermination(next.reason);
        continue;
      }
      const event = next.event;
      if (terminationSent === undefined && terminationTrigger.commandDeadlineExpired()) {
        await sendTermination('timeout');
      }
      if (event.type === 'STARTED') {
        if (started || result) invalid('STARTED is duplicated or follows RESULT');
        started = event;
        if (options.hooks?.onStarted && terminationSent === undefined) {
          const startedHook = () =>
            options.hooks!.onStarted!({
              supervisorPid: processHandle!.pid,
              containment,
              targetPid: event.targetPid,
            });
          if (terminationTrigger.commandDeadline) {
            await terminationTrigger.commandDeadline.run(startedHook, () =>
              posixDeadlineError('command hook'),
            );
          } else {
            await startedHook();
          }
        }
      } else if (event.type === 'RESULT') {
        if (!started || result) invalid('RESULT is duplicated or precedes STARTED');
        result = event;
        terminationTrigger.rootCompleted();
        closeoutDeadline ??= MonotonicDeadline.after(
          terminationTrigger.reason === undefined
            ? timeouts.naturalDrainMs + timeouts.killMs
            : timeouts.killMs,
        );
        failureCloseoutDeadline = closeoutDeadline;
        await closeoutDeadline.run(
          () =>
            options.hooks?.onRootResult?.({
              supervisorPid: processHandle!.pid,
              containment,
              code: event.code,
              signal: event.signal,
            }),
          () => posixDeadlineError('natural drain hook'),
        );
      } else {
        drained = event;
      }
      if (!drained) {
        pendingEvent = processHandle.nextAny(['STARTED', 'RESULT', 'DRAINED'] as const, null);
      }
    }
    receiptObserver.dispose();
    terminationTrigger.dispose();
    const ackExitDeadline = MonotonicDeadline.after(timeouts.ackMs);
    failureCloseoutDeadline = ackExitDeadline;
    const drainedMessage = parseSupervisorDrained(drained.messageBytes);
    const receipt = await runOperationStepBefore(
      ackExitDeadline,
      operationDeadline,
      'receipt acceptance',
      () => operation.acceptInstalledDrainedReceiptControlled(drained.messageBytes),
    );
    const receiptPath = join(operation.operationPath, 'drained-receipt.json');
    if (
      drainedMessage.operationId !== operation.operationId ||
      drainedMessage.receiptDigest !== digestBytes(readFileSync(receiptPath))
    ) {
      invalid('DRAINED does not bind the installed receipt');
    }
    parseDrainedReceipt(readFileSync(receiptPath));
    const externallyTerminated =
      receipt.drainReason === 'timeout' ||
      receipt.drainReason === 'user-interrupt' ||
      receipt.drainReason === 'parent-shutdown' ||
      receipt.drainReason === 'output-failure';
    if (
      ((receipt.drainReason === 'natural' || receipt.drainReason === 'process-tree-not-empty') &&
        !startSent) ||
      (receipt.proof === 'never-started-containment-empty-v1' &&
        (startSent || started !== undefined || result !== undefined)) ||
      (receipt.proof !== 'never-started-containment-empty-v1' && !startSent) ||
      (externallyTerminated &&
        (terminationSent === undefined || terminationSent !== receipt.drainReason))
    ) {
      invalid('receipt drain reason does not match observed POSIX events');
    }
    await ackExitDeadline.run(
      () => options.hooks?.onDrained?.({ supervisorPid: processHandle!.pid, containment, receipt }),
      () => posixDeadlineError('post-drain hook'),
    );
    processHandle.expectCleanExit();
    await processHandle.sendBefore(
      {
        schemaVersion: 1,
        type: 'ACK',
        messageBase64: encodeSupervisorAcknowledgement(
          operation.operationId,
          drainedMessage.receiptDigest,
        ).toString('base64'),
      },
      ackExitDeadline,
      'ACK delivery',
    );
    const supervisorExit = await processHandle.waitForExitBefore(
      ackExitDeadline,
      'supervisor exit after ACK',
    );
    if (supervisorExit.code !== 0 || supervisorExit.signal !== null) {
      isolated('supervisor did not close cleanly after ACK');
    }
    assertExactSupervisorDeath(processHandle.pid, descriptor.supervisorIdentity);
    if (probePosixProcessGroup(containment.pgid) !== 'empty') {
      isolated('target process group is not empty after supervisor close');
    }
    const settlement = await runOperationStepBefore(
      ackExitDeadline,
      operationDeadline,
      'final settlement',
      () =>
        operation.settleArmedControlled({
          supervisor: 'dead',
          containment: 'empty',
        }),
    );
    completed = true;
    if (
      result === undefined &&
      (receipt.drainReason === 'natural' || receipt.drainReason === 'process-tree-not-empty')
    ) {
      throw new WorkspaceSafetyError(
        'invalid',
        `POSIX root RESULT event is missing after safety settlement${
          replayedInstalledReceipt ? ' through installed receipt replay' : ''
        }`,
      );
    }
    const leftover = receipt.drainReason === 'process-tree-not-empty';
    const terminationReason = externallyTerminated ? receipt.drainReason : null;
    return {
      verdict: leftover
        ? 'process-tree-not-empty'
        : terminationReason
          ? 'terminated'
          : result?.code === 0
            ? 'completed'
            : 'root-failed',
      code: terminationReason ? null : (result?.code ?? null),
      signal: terminationReason ? null : (result?.signal ?? null),
      stdout: Buffer.concat(processHandle.stdout),
      stderr: Buffer.concat(processHandle.stderr),
      leftover,
      terminationReason,
      receipt,
      settledPath: settlement.settledPath,
      ...(settlement.candidate ? { candidate: settlement.candidate } : {}),
      supervisorPid: processHandle.pid,
      containment,
    };
  } catch (error) {
    if (operation.activeState === 'armed') discardManagedOutput();
    let closeoutError: unknown;
    const failureTimeouts = resolvedTimeouts ?? resolveTimeouts(options.timeouts);
    failureCloseoutDeadline ??= MonotonicDeadline.after(
      operationDeadline.timedOut ? 0 : failureTimeouts.killMs + failureTimeouts.ackMs,
    );
    try {
      if (!operationDeadline.timedOut && !operation.settled && !operation.quarantined) {
        const reason = prestartAbortReason(error, terminationTrigger?.reason);
        if (operation.activeState === 'prepared') {
          await abortPreparedPosixOperation(
            operation,
            processHandle,
            supervisorIdentity,
            reason,
            operationDeadline,
            failureCloseoutDeadline,
          );
        } else if (operation.activeState === 'prepared-bound') {
          if (!processHandle || !descriptor) {
            isolated('prepared-bound operation lost its supervisor binding in memory');
          }
          await abortPreparedBoundPosixOperation(
            operation,
            processHandle,
            descriptor,
            reason,
            operationDeadline,
            failureCloseoutDeadline,
          );
        } else {
          const quarantineReason =
            options.posixProcessDomain === 'opaque-runner' &&
            startSent &&
            !operation.receiptInstalled
              ? 'operation-proof-missing'
              : terminationAttempted || operation.receiptInstalled
                ? 'containment-unconfirmed'
                : 'operation-proof-missing';
          await quarantineUnfinishedPosixOperation(
            operation,
            quarantineReason,
            failureCloseoutDeadline,
            operationDeadline,
          );
        }
      }
    } catch (failure) {
      closeoutError = failure;
      if (!operationDeadline.timedOut && !operation.settled && !operation.quarantined) {
        try {
          const quarantineReason =
            options.posixProcessDomain === 'opaque-runner' &&
            startSent &&
            !operation.receiptInstalled
              ? 'operation-proof-missing'
              : 'containment-unconfirmed';
          await quarantineUnfinishedPosixOperation(
            operation,
            quarantineReason,
            failureCloseoutDeadline,
            operationDeadline,
          );
        } catch (quarantineError) {
          closeoutError = quarantineError;
        }
      }
    }
    throw closeoutError ?? error;
  } finally {
    receiptObserver?.dispose();
    terminationTrigger?.dispose();
    if (!completed && processHandle) {
      await processHandle.abort(failureCloseoutDeadline ?? MonotonicDeadline.after(0));
    }
  }
}
