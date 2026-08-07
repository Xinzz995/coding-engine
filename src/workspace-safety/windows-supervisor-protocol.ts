import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import type { DelegatedSemanticCandidate } from '../contracts/delegated-operation-contract.js';
import { parseJsonRecord } from './schema.js';
import {
  parseContainmentDescriptor,
  parseSupervisorDrained,
  parseSupervisorPrestartDrained,
  type ContainmentDescriptor,
  type DrainedReceipt,
  type SupervisorTarget,
  type SupervisorTerminationReason,
} from './supervisor-protocol.js';
import type { WindowsSupervisorTimeouts } from './windows-supervisor-launch.js';
import { MonotonicDeadline } from './deadline.js';
import { WorkspaceSafetyError } from './types.js';

const MAX_EVENT_LINE_BYTES = 64 * 1024;
const MAX_EVENT_STRING = 16_384;
const MAX_OUTPUT_CHUNK_BYTES = 16 * 1024;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;
const MAX_PENDING_OUTPUT_BYTES = 256 * 1024;
const MAX_PENDING_OUTPUT_FRAMES = 1024;
const MAX_HELPER_STDERR_BYTES = 1024 * 1024;
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/u;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;

export type WindowsContainment = Extract<ContainmentDescriptor, { platform: 'windows-job-v1' }>;
type WindowsSupervisorTarget = Omit<SupervisorTarget, 'executableArgv0'> & {
  readonly executableArgv0?: never;
};
type StrictRecord = Record<string, unknown>;

export interface WindowsSupervisorHooks {
  readonly onBound?: (facts: {
    readonly supervisorPid: number;
    readonly supervisorIdentity: string;
  }) => void | Promise<void>;
  readonly onArmed?: (facts: {
    readonly supervisorPid: number;
    readonly containment: WindowsContainment;
  }) => void | Promise<void>;
  readonly onStarted?: (facts: {
    readonly supervisorPid: number;
    readonly containment: WindowsContainment;
    readonly targetPid: number;
  }) => void | Promise<void>;
  readonly onRootResult?: (facts: {
    readonly supervisorPid: number;
    readonly containment: WindowsContainment;
    readonly code: number;
    readonly signal: null;
  }) => void | Promise<void>;
  readonly onTerminating?: (facts: {
    readonly supervisorPid: number;
    readonly containment: WindowsContainment;
    readonly reason: SupervisorTerminationReason;
  }) => void | Promise<void>;
  readonly onDrained?: (facts: {
    readonly supervisorPid: number;
    readonly containment: WindowsContainment;
    readonly receipt: DrainedReceipt;
  }) => void | Promise<void>;
}

export interface RunDarkWindowsSupervisedOperationOptions {
  readonly target: WindowsSupervisorTarget;
  readonly commandTimeoutMs?: number;
  readonly termination?: {
    readonly signal: AbortSignal;
    readonly reason: Exclude<SupervisorTerminationReason, 'timeout' | 'output-failure'>;
  };
  readonly timeouts?: Partial<WindowsSupervisorTimeouts>;
  readonly hooks?: WindowsSupervisorHooks;
  readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void | Promise<void>;
  readonly onOutputDiscard?: () => void;
  /** Signals an asynchronous downstream sink failure between output callbacks. */
  readonly outputFailureSignal?: AbortSignal;
}

export interface WindowsInvocationOutcome {
  readonly verdict: 'completed' | 'root-failed' | 'process-tree-not-empty' | 'terminated';
  readonly code: number | null;
  readonly signal: null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly leftover: boolean;
  readonly terminationReason: SupervisorTerminationReason | null;
  readonly receipt: DrainedReceipt;
  readonly settledPath: string;
  readonly candidate?: DelegatedSemanticCandidate;
  readonly supervisorPid: number;
  readonly containment: WindowsContainment;
}

export interface WindowsBoundEvent {
  readonly type: 'BOUND';
  readonly supervisorPid: number;
  readonly supervisorIdentity: string;
  readonly helperDigest: string;
}

export interface WindowsArmedEvent {
  readonly type: 'ARMED';
  readonly containment: ContainmentDescriptor;
}

export interface WindowsStartedEvent {
  readonly type: 'STARTED';
  readonly targetPid: number;
}

export interface WindowsResultEvent {
  readonly type: 'RESULT';
  readonly code: number;
  readonly signal: null;
}

export interface WindowsDrainedEvent {
  readonly type: 'DRAINED';
  readonly messageBytes: Buffer;
}

export interface WindowsPrestartDrainedEvent {
  readonly type: 'PRESTART_DRAINED';
  readonly messageBytes: Buffer;
}

export interface WindowsOutputEvent {
  readonly type: 'OUTPUT';
  readonly operationId: string;
  readonly sequence: number;
  readonly bytes: number;
  readonly stream: 'stdout' | 'stderr';
  readonly data: Buffer;
}

export type WindowsProtocolEvent =
  | WindowsBoundEvent
  | WindowsArmedEvent
  | WindowsStartedEvent
  | WindowsResultEvent
  | WindowsDrainedEvent
  | WindowsPrestartDrainedEvent;

export type WindowsParsedEvent = WindowsProtocolEvent | WindowsOutputEvent;

export function protocolInvalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', `Invalid Windows supervisor integration: ${message}`);
}

export function protocolIsolated(message: string): never {
  throw new WorkspaceSafetyError(
    'isolated',
    `Windows supervisor did not prove completion: ${message}`,
  );
}

function strictRecord(value: unknown, name: string): StrictRecord {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return protocolInvalid(`${name} must be an object`);
  }
  return value as StrictRecord;
}

function exactEventKeys(record: StrictRecord, expected: readonly string[], name: string): void {
  const keys = Reflect.ownKeys(record);
  if (
    keys.some((key) => typeof key !== 'string' || !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(record, key))
  ) {
    protocolInvalid(`${name} has unknown or missing fields`);
  }
}

function eventString(value: unknown, field: string, maximum = MAX_EVENT_STRING): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length > maximum ||
    value.includes('\0')
  ) {
    return protocolInvalid(`${field} must be a bounded string`);
  }
  return value;
}

function eventPid(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1 || (value as number) > 0xffff_ffff) {
    return protocolInvalid(`${field} must be an unsigned 32-bit process id`);
  }
  return value as number;
}

function eventPositiveSafeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    return protocolInvalid(`${field} must be a positive safe integer`);
  }
  return value as number;
}

function canonicalBase64(value: unknown, field: string): Buffer {
  const encoded = eventString(value, field, MAX_EVENT_LINE_BYTES);
  const bytes = Buffer.from(encoded, 'base64');
  if (bytes.toString('base64') !== encoded) protocolInvalid(`${field} is not canonical base64`);
  return bytes;
}

export function parseWindowsSupervisorEvent(input: string | Buffer): WindowsParsedEvent {
  const record = parseJsonRecord(input, (value) => strictRecord(value, 'supervisor event'));
  if (record.schemaVersion !== 1 || typeof record.type !== 'string') {
    protocolInvalid('supervisor event version/type is invalid');
  }
  if (record.type === 'BOUND') {
    exactEventKeys(
      record,
      ['schemaVersion', 'type', 'supervisorPid', 'supervisorIdentity', 'helperDigest'],
      'BOUND',
    );
    const helperDigest = eventString(record.helperDigest, 'BOUND.helperDigest');
    if (!SHA256_PATTERN.test(helperDigest)) protocolInvalid('BOUND.helperDigest is invalid');
    return {
      type: 'BOUND',
      supervisorPid: eventPid(record.supervisorPid, 'BOUND.supervisorPid'),
      supervisorIdentity: eventString(record.supervisorIdentity, 'BOUND.supervisorIdentity'),
      helperDigest,
    };
  }
  if (record.type === 'ARMED') {
    exactEventKeys(record, ['schemaVersion', 'type', 'containment'], 'ARMED');
    return { type: 'ARMED', containment: parseContainmentDescriptor(record.containment) };
  }
  if (record.type === 'STARTED') {
    exactEventKeys(record, ['schemaVersion', 'type', 'targetPid'], 'STARTED');
    return { type: 'STARTED', targetPid: eventPid(record.targetPid, 'STARTED.targetPid') };
  }
  if (record.type === 'RESULT') {
    exactEventKeys(record, ['schemaVersion', 'type', 'code', 'signal'], 'RESULT');
    if (
      !Number.isSafeInteger(record.code) ||
      (record.code as number) < 0 ||
      (record.code as number) > 0xffff_ffff ||
      record.signal !== null
    ) {
      protocolInvalid('RESULT code/signal is invalid');
    }
    return { type: 'RESULT', code: record.code as number, signal: null };
  }
  if (record.type === 'DRAINED') {
    exactEventKeys(record, ['schemaVersion', 'type', 'messageBase64'], 'DRAINED');
    const messageBytes = canonicalBase64(record.messageBase64, 'DRAINED.messageBase64');
    parseSupervisorDrained(messageBytes);
    return { type: 'DRAINED', messageBytes };
  }
  if (record.type === 'PRESTART_DRAINED') {
    exactEventKeys(record, ['schemaVersion', 'type', 'messageBase64'], 'PRESTART_DRAINED');
    const messageBytes = canonicalBase64(record.messageBase64, 'PRESTART_DRAINED.messageBase64');
    parseSupervisorPrestartDrained(messageBytes);
    return { type: 'PRESTART_DRAINED', messageBytes };
  }
  if (record.type === 'OUTPUT') {
    exactEventKeys(
      record,
      ['schemaVersion', 'type', 'operationId', 'sequence', 'bytes', 'stream', 'data'],
      'OUTPUT',
    );
    const operationId = eventString(record.operationId, 'OUTPUT.operationId');
    if (!UUID_PATTERN.test(operationId)) protocolInvalid('OUTPUT.operationId is invalid');
    const sequence = eventPositiveSafeInteger(record.sequence, 'OUTPUT.sequence');
    const bytes = eventPositiveSafeInteger(record.bytes, 'OUTPUT.bytes');
    if (record.stream !== 'stdout' && record.stream !== 'stderr') {
      protocolInvalid('OUTPUT.stream is invalid');
    }
    const data = canonicalBase64(record.data, 'OUTPUT.data');
    if (data.length === 0 || data.length > MAX_OUTPUT_CHUNK_BYTES) {
      protocolInvalid('OUTPUT chunk is outside the fixed bound');
    }
    if (bytes !== data.length) protocolInvalid('OUTPUT.bytes does not match decoded data');
    return { type: 'OUTPUT', operationId, sequence, bytes, stream: record.stream, data };
  }
  if (record.type === 'FAILURE') {
    exactEventKeys(record, ['schemaVersion', 'type', 'message'], 'FAILURE');
    return protocolIsolated(eventString(record.message, 'FAILURE.message', 512));
  }
  return protocolInvalid('supervisor event type is unsupported');
}

type WindowsEventOrderState =
  'initial' | 'bound' | 'armed' | 'started' | 'result' | 'drained' | 'prestart-drained';

export class WindowsSupervisorEventOrder {
  #state: WindowsEventOrderState = 'initial';

  get state(): WindowsEventOrderState {
    return this.#state;
  }

  accept(event: WindowsParsedEvent): void {
    if (event.type === 'OUTPUT') {
      if (
        this.#state === 'initial' ||
        this.#state === 'bound' ||
        this.#state === 'drained' ||
        this.#state === 'prestart-drained'
      ) {
        protocolInvalid(`OUTPUT is not allowed in state ${this.#state}`);
      }
      return;
    }
    if (event.type === 'BOUND' && this.#state === 'initial') this.#state = 'bound';
    else if (event.type === 'ARMED' && this.#state === 'bound') this.#state = 'armed';
    else if (event.type === 'STARTED' && this.#state === 'armed') this.#state = 'started';
    else if (event.type === 'RESULT' && this.#state === 'started') this.#state = 'result';
    else if (event.type === 'DRAINED' && (this.#state === 'armed' || this.#state === 'result')) {
      this.#state = 'drained';
    } else if (
      event.type === 'PRESTART_DRAINED' &&
      (this.#state === 'bound' || this.#state === 'armed')
    ) {
      this.#state = 'prestart-drained';
    } else {
      protocolInvalid(`${event.type} is not allowed in state ${this.#state}`);
    }
  }
}

export class WindowsSupervisorProcess {
  readonly pid: number;
  readonly stdout: Buffer[] = [];
  readonly stderr: Buffer[] = [];

  #line = Buffer.alloc(0);
  #outputBytes = 0;
  #unacknowledgedOutputBytes = 0;
  #nextOutputSequence = 1;
  #boundOutputOperationId: string | undefined;
  readonly #pendingOutput = new Map<
    number,
    {
      readonly event: WindowsOutputEvent;
      acknowledgement: Promise<void> | undefined;
    }
  >();
  #outputDiscarded = false;
  #outputFailure: Error | undefined;
  readonly #outputQueues: Record<'stdout' | 'stderr', Promise<void>> = {
    stdout: Promise.resolve(),
    stderr: Promise.resolve(),
  };
  #helperStderrBytes = 0;
  #events: WindowsProtocolEvent[] = [];
  #waiter:
    | {
        readonly expected: readonly WindowsProtocolEvent['type'][];
        readonly resolve: (event: WindowsProtocolEvent) => void;
        readonly reject: (error: unknown) => void;
        readonly timer: NodeJS.Timeout | undefined;
      }
    | undefined;
  #terminalError: Error | undefined;
  #exitExpected = false;
  readonly #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly #stdoutEnd: Promise<void>;
  readonly #order = new WindowsSupervisorEventOrder();

  constructor(
    private readonly child: ChildProcessWithoutNullStreams,
    private readonly handshakeMs: number,
    private readonly output?: {
      readonly onOutput?: (stream: 'stdout' | 'stderr', chunk: Buffer) => void | Promise<void>;
      readonly onFailure: (error: Error) => void;
    },
    expectedOperationId?: string,
  ) {
    if (child.pid === undefined) protocolIsolated('supervisor spawn did not return a pid');
    if (expectedOperationId !== undefined && !UUID_PATTERN.test(expectedOperationId)) {
      protocolInvalid('expected output operation id is invalid');
    }
    this.#boundOutputOperationId = expectedOperationId;
    this.pid = child.pid;
    child.stdout.on('data', (chunk: Buffer) => this.#consume(chunk));
    this.#stdoutEnd = new Promise((resolve) => {
      child.stdout.once('end', () => {
        if (this.#line.length !== 0) this.#fail(protocolError('truncated final protocol frame'));
        resolve();
      });
    });
    child.stderr.on('data', (chunk: Buffer) => {
      this.#helperStderrBytes += chunk.length;
      if (this.#helperStderrBytes > MAX_HELPER_STDERR_BYTES) {
        this.#fail(protocolError('helper stderr exceeded the bound'));
      }
    });
    child.once('error', (error) => this.#fail(error));
    this.#exit = new Promise((resolve) => {
      child.once('exit', (code, signal) => {
        resolve({ code, signal });
        if (!this.#exitExpected) {
          this.#fail(protocolError('supervisor exited before acknowledged completion'));
        }
      });
    });
  }

  #consume(chunk: Buffer): void {
    try {
      this.#line = Buffer.concat([this.#line, chunk]);
      this.#drainProtocolFrames();
    } catch (error) {
      this.#fail(error);
    }
  }

  #drainProtocolFrames(): void {
    try {
      let newline = this.#line.indexOf(0x0a);
      while (newline !== -1) {
        let line = this.#line.subarray(0, newline);
        this.#line = this.#line.subarray(newline + 1);
        if (line.at(-1) === 0x0d) line = line.subarray(0, -1);
        if (line.length === 0 || line.length > MAX_EVENT_LINE_BYTES) {
          protocolInvalid('protocol frame is empty or oversized');
        }
        this.#push(parseWindowsSupervisorEvent(line));
        newline = this.#line.indexOf(0x0a);
      }
      if (this.#line.length > MAX_EVENT_LINE_BYTES) {
        protocolInvalid('protocol frame exceeds the line bound');
      }
    } catch (error) {
      this.#fail(error);
    }
  }

  #push(event: WindowsParsedEvent): void {
    if (
      event.type === 'DRAINED' &&
      !this.#outputDiscarded &&
      this.#pendingOutput.size > 0
    ) {
      protocolInvalid('DRAINED arrived before every OUTPUT was acknowledged');
    }
    this.#order.accept(event);
    if (event.type === 'OUTPUT') {
      const expectedOperationId = this.#boundOutputOperationId ?? event.operationId;
      this.#boundOutputOperationId = expectedOperationId;
      if (event.operationId !== expectedOperationId) {
        protocolInvalid('OUTPUT is bound to a different operation');
      }
      if (event.sequence !== this.#nextOutputSequence) {
        protocolInvalid('OUTPUT sequence is not globally consecutive');
      }
      this.#nextOutputSequence += 1;
      if (this.#outputDiscarded) return;
      this.#outputBytes += event.bytes;
      const frame = { event, acknowledgement: undefined as Promise<void> | undefined };
      this.#pendingOutput.set(event.sequence, frame);
      this.#unacknowledgedOutputBytes += event.bytes;
      if (
        this.#unacknowledgedOutputBytes > MAX_PENDING_OUTPUT_BYTES ||
        this.#pendingOutput.size > MAX_PENDING_OUTPUT_FRAMES
      ) {
        protocolInvalid('OUTPUT exceeded the fixed unacknowledged credit window');
      }
      if (this.#outputBytes > MAX_OUTPUT_BYTES) {
        if (!this.output) protocolIsolated('target output exceeded the total bound');
        this.#beginOutputFailure(protocolError('target output exceeded the total bound'));
        return;
      }
      const owned = Buffer.from(event.data);
      if (!this.output?.onOutput) {
        (event.stream === 'stdout' ? this.stdout : this.stderr).push(owned);
        const stream = event.stream;
        this.#outputQueues[stream] = this.#outputQueues[stream]
          .then(() => {
            if (!this.#outputDiscarded) return this.#acknowledgeOutput(frame);
          })
          .catch((error: unknown) => this.#fail(error));
        return;
      }
      const stream = event.stream;
      this.#outputQueues[stream] = this.#outputQueues[stream]
        .then(async () => {
          if (this.#outputDiscarded) return;
          try {
            await this.output!.onOutput!(stream, owned);
          } catch (error) {
            this.#beginOutputFailure(
              error instanceof Error ? error : new Error('unknown Windows output callback failure'),
            );
            return;
          }
          if (!this.#outputDiscarded) await this.#acknowledgeOutput(frame);
        })
        .catch((error: unknown) => this.#fail(error));
      return;
    }
    if (this.#waiter) {
      if (!this.#waiter.expected.includes(event.type)) {
        protocolInvalid(`Expected ${this.#waiter.expected.join('/')} but received ${event.type}`);
      }
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.resolve(event);
      return;
    }
    this.#events.push(event);
  }

  #acknowledgeOutput(frame: {
    readonly event: WindowsOutputEvent;
    acknowledgement: Promise<void> | undefined;
  }): Promise<void> {
    if (frame.acknowledgement) return frame.acknowledgement;
    // The helper may consume a submitted ACK and refill its credit before Node invokes the
    // corresponding write callback. Release the mirrored credit at submission, while the
    // per-stream queue still requires the write callback to settle successfully.
    if (!this.#pendingOutput.delete(frame.event.sequence)) {
      protocolInvalid('OUTPUT acknowledgement state was already released');
    }
    this.#unacknowledgedOutputBytes -= frame.event.bytes;
    frame.acknowledgement = this.send({
      schemaVersion: 1,
      type: 'OUTPUT_ACK',
      operationId: frame.event.operationId,
      sequence: frame.event.sequence,
      bytes: frame.event.bytes,
    });
    frame.acknowledgement.catch((error: unknown) => this.#fail(error));
    return frame.acknowledgement;
  }

  #beginOutputFailure(error: Error): void {
    if (this.#outputFailure !== undefined) return;
    this.#outputFailure = error;
    this.discardOutput();
    try {
      this.output?.onFailure(error);
    } catch {
      // Output failure notification cannot replace the mechanical failure.
    }
  }

  discardOutput(): void {
    if (this.#outputDiscarded) return;
    this.#outputDiscarded = true;
  }

  async waitForOutputConsumption(deadline: MonotonicDeadline): Promise<void> {
    if (this.#outputDiscarded) return;
    await deadline.run(
      () => Promise.all([this.#outputQueues.stdout, this.#outputQueues.stderr]),
      () => protocolError('output consumption timed out'),
    );
    if (this.#pendingOutput.size > 0) {
      throw protocolError('consumed output has no acknowledgement');
    }
    if (this.#terminalError) throw this.#terminalError;
    if (this.#outputFailure) throw this.#outputFailure;
  }

  #fail(error: unknown): void {
    if (this.#terminalError !== undefined) return;
    this.#terminalError = error instanceof Error ? error : new Error('unknown supervisor failure');
    if (this.#waiter) {
      const waiter = this.#waiter;
      this.#waiter = undefined;
      if (waiter.timer) clearTimeout(waiter.timer);
      waiter.reject(this.#terminalError);
    }
  }

  #cancelWait(error: Error): void {
    if (!this.#waiter) return;
    const waiter = this.#waiter;
    this.#waiter = undefined;
    if (waiter.timer) clearTimeout(waiter.timer);
    waiter.reject(error);
  }

  next<T extends WindowsProtocolEvent['type']>(
    expected: T,
  ): Promise<Extract<WindowsProtocolEvent, { type: T }>> {
    return this.nextAny([expected]);
  }

  nextAny<T extends WindowsProtocolEvent['type']>(
    expected: readonly T[],
    timeoutMs: number | null = this.handshakeMs,
  ): Promise<Extract<WindowsProtocolEvent, { type: T }>> {
    if (this.#terminalError) return Promise.reject(this.#terminalError);
    const queued = this.#events.shift();
    if (queued) {
      if (!expected.includes(queued.type as T)) {
        return Promise.reject(
          protocolError(`Expected ${expected.join('/')} but received ${queued.type}`),
        );
      }
      return Promise.resolve(queued as Extract<WindowsProtocolEvent, { type: T }>);
    }
    if (this.#waiter) return Promise.reject(protocolError('concurrent event waits are invalid'));
    return new Promise((resolve, reject) => {
      const timer =
        timeoutMs === null
          ? undefined
          : setTimeout(
              () => this.#fail(protocolError(`Timed out waiting for ${expected.join('/')}`)),
              timeoutMs,
            );
      this.#waiter = {
        expected,
        resolve: (event) => resolve(event as Extract<WindowsProtocolEvent, { type: T }>),
        reject,
        timer,
      };
    });
  }

  send(envelope: StrictRecord): Promise<void> {
    if (this.child.stdin.destroyed)
      return Promise.reject(protocolError('supervisor stdin is closed'));
    const bytes = Buffer.from(`${JSON.stringify(envelope)}\n`, 'utf8');
    if (bytes.length > MAX_EVENT_LINE_BYTES)
      return Promise.reject(protocolError('control frame too large'));
    return new Promise((resolve, reject) => {
      this.child.stdin.write(bytes, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
  }

  nextBefore<T extends WindowsProtocolEvent['type']>(
    expected: readonly T[],
    deadline: MonotonicDeadline,
    label: string,
  ): Promise<Extract<WindowsProtocolEvent, { type: T }>> {
    return deadline.run(
      () => this.nextAny(expected, null),
      () => {
        const error = protocolError(`${label} timed out`);
        this.#cancelWait(error);
        return error;
      },
    );
  }

  racePendingBefore<T extends WindowsProtocolEvent['type']>(
    pending: Promise<Extract<WindowsProtocolEvent, { type: T }>>,
    deadline: MonotonicDeadline,
    label: string,
    termination?: Promise<SupervisorTerminationReason>,
  ): Promise<
    | { readonly kind: 'event'; readonly event: Extract<WindowsProtocolEvent, { type: T }> }
    | { readonly kind: 'termination'; readonly reason: SupervisorTerminationReason }
  > {
    const timeoutError = (): WorkspaceSafetyError => protocolError(`${label} timed out`);
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

  sendBefore(envelope: StrictRecord, deadline: MonotonicDeadline, label: string): Promise<void> {
    return deadline.run(
      () => this.send(envelope),
      () => protocolError(`${label} timed out`),
    );
  }

  expectCleanExit(): void {
    this.#exitExpected = true;
  }

  async waitForCleanExit(deadline: MonotonicDeadline): Promise<void> {
    const exit = await deadline.run(
      () => this.#exit,
      () => protocolError('supervisor exit after ACK timed out'),
    );
    await deadline.run(
      () => this.#stdoutEnd,
      () => protocolError('supervisor stdout close after ACK timed out'),
    );
    if (exit.code !== 0 || exit.signal !== null) {
      protocolIsolated('supervisor did not exit cleanly after ACK');
    }
    if (this.#terminalError) throw this.#terminalError;
    if (this.#events.length !== 0 || this.#order.state !== 'drained') {
      protocolInvalid('supervisor emitted unconsumed or incomplete protocol events');
    }
  }

  async waitForPrestartExit(deadline: MonotonicDeadline): Promise<void> {
    const exit = await deadline.run(
      () => this.#exit,
      () => protocolError('supervisor exit after prestart abort timed out'),
    );
    await deadline.run(
      () => this.#stdoutEnd,
      () => protocolError('supervisor stdout close after prestart abort timed out'),
    );
    if (exit.code !== 0 || exit.signal !== null) {
      protocolIsolated('supervisor did not exit cleanly after prestart abort');
    }
    if (this.#terminalError) throw this.#terminalError;
    if (this.#events.length !== 0 || this.#order.state !== 'prestart-drained') {
      protocolInvalid('supervisor emitted unconsumed or incomplete prestart events');
    }
  }

  async abort(deadline: MonotonicDeadline): Promise<void> {
    this.#exitExpected = true;
    this.#fail(protocolError('supervisor aborted'));
    this.child.stdin.destroy();
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    if (this.child.exitCode === null) this.child.kill('SIGKILL');
    if (deadline.expired) return;
    try {
      await deadline.run(
        () => this.#exit,
        () => protocolError('failed supervisor termination timed out'),
      );
    } catch {
      // The caller already fails closed and leaves the canonical operation fence.
    }
  }
}

function protocolError(message: string): WorkspaceSafetyError {
  return new WorkspaceSafetyError(
    'isolated',
    `Windows supervisor did not prove completion: ${message}`,
  );
}
