import { spawn, type ChildProcess } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import type { DelegatedSemanticCandidate } from '../contracts/delegated-operation-contract.js';
import { createSystemIdentityAdapter } from './identity.js';
import type { WorkspaceOperationHandleControlled } from './operation.js';
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
import { WorkspaceSafetyError } from './types.js';
export {
  readDarkPosixHelperBundle,
  readPosixHelperBundleFromPaths,
} from './posix-supervisor-assets.js';

const SUPERVISOR_HELPER_PATH = posixSupervisorHelperPath();
const LAUNCHER_HELPER_PATH = posixLauncherHelperPath();
const MAX_EVENT_STRING = 16_384;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

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
  readonly onBound?: (facts: {
    readonly supervisorPid: number;
    readonly placement: PosixProcessPlacement;
  }) => void | Promise<void>;
  readonly onArmed?: (facts: {
    readonly supervisorPid: number;
    readonly containment: ContainmentDescriptor;
  }) => void | Promise<void>;
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
  readonly commandTimeoutMs?: number;
  readonly termination?: {
    readonly signal: AbortSignal;
    readonly reason: Exclude<SupervisorTerminationReason, 'timeout'>;
  };
  readonly timeouts?: PosixSupervisorTimeouts;
  readonly hooks?: PosixSupervisorHooks;
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
  return {
    handshakeMs: bounded(input.handshakeMs, 10_000, 10, 'handshakeMs'),
    naturalDrainMs: bounded(input.naturalDrainMs, 5000, 0, 'naturalDrainMs'),
    termMs: bounded(input.termMs, 5000, 0, 'termMs'),
    killMs: bounded(input.killMs, 5000, 1, 'killMs'),
    ackMs: bounded(input.ackMs, 10_000, 10, 'ackMs'),
    pollMs: bounded(input.pollMs, 25, 1, 'pollMs'),
  };
}

function helperBundleBytes(): Buffer {
  return readFixedPosixHelperBundle();
}

function processIdentity(pid: number): string {
  const observed = createSystemIdentityAdapter().readProcessIdentity(pid);
  if (observed.status !== 'found') isolated(`process identity is unavailable for pid ${pid}`);
  return observed.value;
}

function parseEvent(
  value: unknown,
): ProtocolEvent | { type: 'OUTPUT'; stream: string; data: Buffer } {
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
    exactKeys(record, ['schemaVersion', 'type', 'stream', 'data'], 'OUTPUT');
    if (record.stream !== 'stdout' && record.stream !== 'stderr')
      invalid('OUTPUT stream is invalid');
    const encoded = boundedString(record.data, 'OUTPUT.data');
    const data = Buffer.from(encoded, 'base64');
    if (data.toString('base64') !== encoded) invalid('OUTPUT data is not canonical base64');
    return { type: 'OUTPUT', stream: record.stream, data };
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
  #exitExpected = false;
  #exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;

  constructor(
    private readonly child: ChildProcess,
    private readonly timeouts: ResolvedTimeouts,
  ) {
    if (child.pid === undefined) isolated('supervisor spawn did not return a pid');
    this.pid = child.pid;
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
    let event: ReturnType<typeof parseEvent>;
    try {
      event = parseEvent(message);
    } catch (error) {
      this.#fail(error);
      return;
    }
    if (event.type === 'OUTPUT') {
      this.#outputBytes += event.data.length;
      if (this.#outputBytes > MAX_OUTPUT_BYTES) {
        this.#fail(new WorkspaceSafetyError('isolated', 'POSIX target output exceeded the bound'));
        return;
      }
      (event.stream === 'stdout' ? this.stdout : this.stderr).push(event.data);
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
    if (!this.child.connected) return Promise.reject(new Error('supervisor IPC is closed'));
    return new Promise((resolve, reject) => {
      this.child.send?.(envelope, (error) => {
        if (error) reject(error);
        else resolve();
      });
    });
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

  async abort(): Promise<void> {
    this.#exitExpected = true;
    this.disconnect();
    const waitMs = this.timeouts.termMs + this.timeouts.killMs + this.timeouts.handshakeMs;
    let timer: NodeJS.Timeout | undefined;
    const exited = await Promise.race([
      this.#exit.then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), waitMs);
      }),
    ]);
    if (timer) clearTimeout(timer);
    if (!exited) {
      this.child.kill('SIGKILL');
      await this.#exit;
    }
  }
}

function spawnSupervisor(timeouts: ResolvedTimeouts): PosixSupervisorProcess {
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
  return new PosixSupervisorProcess(child, timeouts);
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
  startCommandTimer(): void;
  rootCompleted(): void;
  dispose(): void;
}

function createTerminationTrigger(
  commandTimeoutMs: number | undefined,
  termination: RunDarkPosixSupervisedOperationOptions['termination'],
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
  if (termination) {
    termination.signal.addEventListener('abort', onAbort, { once: true });
    if (termination.signal.aborted) freeze(termination.reason);
  }
  return {
    promise,
    get reason() {
      return frozenReason;
    },
    startCommandTimer() {
      if (commandTimeoutMs !== undefined && frozenReason === undefined) {
        timeout = setTimeout(() => freeze('timeout'), commandTimeoutMs);
      }
    },
    rootCompleted() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
    },
    dispose() {
      if (timeout) clearTimeout(timeout);
      timeout = undefined;
      termination?.signal.removeEventListener('abort', onAbort);
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
): Promise<void> {
  if (processHandle) {
    if (!supervisorIdentity) isolated('spawned supervisor identity was never established');
    await processHandle.abort();
    assertExactSupervisorDeath(processHandle.pid, supervisorIdentity);
  }
  await operation.abortPrestartControlled({
    reason,
    proof: 'supervisor-never-bound-v1',
    supervisor: processHandle ? 'dead' : 'never-created',
    containment: 'not-created',
  });
}

async function abortPreparedBoundPosixOperation(
  operation: WorkspaceOperationHandleControlled,
  processHandle: PosixSupervisorProcess,
  descriptor: BoundSupervisorDescriptor,
  reason: PrestartAbortReason,
): Promise<void> {
  processHandle.expectCleanExit();
  await processHandle.send({
    schemaVersion: 1,
    type: 'ABORT_BEFORE_START',
    messageBase64: encodeSupervisorAbortBeforeStart(operation.operationId).toString('base64'),
  });
  const event = await processHandle.next('PRESTART_DRAINED');
  const drained = parseSupervisorPrestartDrained(event.messageBytes);
  if (
    drained.operationId !== operation.operationId ||
    drained.supervisorPid !== processHandle.pid ||
    drained.supervisorIdentity !== descriptor.supervisorIdentity
  ) {
    invalid('PRESTART_DRAINED does not bind the prepared-bound supervisor');
  }
  processHandle.disconnect();
  const exit = await processHandle.waitForExit();
  if (exit.code !== 0 || exit.signal !== null) {
    isolated('supervisor did not close cleanly after prestart abort');
  }
  assertExactSupervisorDeath(processHandle.pid, descriptor.supervisorIdentity);
  await operation.abortPrestartControlled({
    reason,
    proof: 'supervisor-prestart-empty-v1',
    supervisor: 'dead',
    containment: 'empty',
    prestartDrainedBytes: event.messageBytes,
  });
}

async function quarantineUnfinishedPosixOperation(
  operation: WorkspaceOperationHandleControlled,
  reason: 'containment-unconfirmed' | 'operation-proof-missing',
): Promise<void> {
  if (!operation.settled && !operation.quarantined) {
    await operation.installQuarantineControlled(reason);
  }
}

export async function runDarkPosixSupervisedOperation(
  operation: WorkspaceOperationHandleControlled,
  options: RunDarkPosixSupervisedOperationOptions,
): Promise<PosixInvocationOutcome> {
  let terminationTrigger: TerminationTrigger | undefined;
  let processHandle: PosixSupervisorProcess | undefined;
  let supervisorIdentity: string | undefined;
  let descriptor: BoundSupervisorDescriptor | undefined;
  let terminationAttempted = false;
  let completed = false;
  try {
    terminationTrigger = createTerminationTrigger(options.commandTimeoutMs, options.termination);
    throwIfPrestartInterrupted(terminationTrigger);
    if (!isAbsolute(options.target.executable) || !isAbsolute(options.target.cwd)) {
      invalid('target executable and cwd must be absolute');
    }
    const timeouts = resolveTimeouts(options.timeouts);
    const helperBytes = helperBundleBytes();
    const helperDigest = digestBytes(helperBytes);
    processHandle = spawnSupervisor(timeouts);
    supervisorIdentity = processIdentity(processHandle.pid);
    throwIfPrestartInterrupted(terminationTrigger);
    const boundEvent = await processHandle.next('BOUND');
    descriptor = validateSupervisorBound(processHandle, boundEvent, helperDigest);
    await options.hooks?.onBound?.({
      supervisorPid: processHandle.pid,
      placement: inspectPosixProcessPlacement(processHandle.pid),
    });
    throwIfPrestartInterrupted(terminationTrigger);
    await operation.bindSupervisorControlled(descriptor);
    await operation.readPreparedBoundBindingControlled(helperBytes);
    throwIfPrestartInterrupted(terminationTrigger);

    const dataBytes = encodeSupervisorData({
      operationId: operation.operationId,
      target: options.target,
    });
    await processHandle.send({
      schemaVersion: 1,
      type: 'DATA',
      workspacePath: operation.workspacePath,
      messageBase64: dataBytes.toString('base64'),
    });

    const armedEvent = await processHandle.next('ARMED');
    const containment = validateContainment(processHandle.pid, armedEvent);
    throwIfPrestartInterrupted(terminationTrigger);
    await operation.armContainmentControlled(containment);
    const armedBinding = await operation.readArmedBindingControlled(helperBytes);
    await options.hooks?.onArmed?.({ supervisorPid: processHandle.pid, containment });
    let startSent = false;
    let terminationSent: SupervisorTerminationReason | undefined;
    let started: StartedEvent | undefined;
    let result: ResultEvent | undefined;
    let drained: DrainedEvent | undefined;
    const runningSupervisor = processHandle;

    const sendTermination = async (reason: SupervisorTerminationReason): Promise<void> => {
      if (terminationSent !== undefined) return;
      terminationSent = reason;
      terminationAttempted = true;
      await runningSupervisor.send({
        schemaVersion: 1,
        type: 'TERMINATE',
        messageBase64: encodeSupervisorTerminate(operation.operationId, reason).toString('base64'),
      });
      await options.hooks?.onTerminating?.({
        supervisorPid: runningSupervisor.pid,
        containment,
        reason,
      });
    };

    if (terminationTrigger.reason !== undefined) {
      await sendTermination(terminationTrigger.reason);
    } else {
      const startBytes = encodeSupervisorStart(
        operation.operationId,
        armedBinding.activeChildDigest,
      );
      await processHandle.send({
        schemaVersion: 1,
        type: 'START',
        messageBase64: startBytes.toString('base64'),
      });
      startSent = true;
      terminationTrigger.startCommandTimer();
    }

    let pendingEvent = processHandle.nextAny(['STARTED', 'RESULT', 'DRAINED'] as const, null);
    while (!drained) {
      if (terminationSent === undefined && terminationTrigger.reason !== undefined) {
        await sendTermination(terminationTrigger.reason);
      }
      const next =
        terminationSent === undefined
          ? await Promise.race([
              pendingEvent.then((event) => ({ kind: 'event' as const, event })),
              terminationTrigger.promise.then((reason) => ({
                kind: 'termination' as const,
                reason,
              })),
            ])
          : { kind: 'event' as const, event: await pendingEvent };
      if (next.kind === 'termination') {
        await sendTermination(next.reason);
        continue;
      }
      const event = next.event;
      if (event.type === 'STARTED') {
        if (started || result) invalid('STARTED is duplicated or follows RESULT');
        started = event;
        await options.hooks?.onStarted?.({
          supervisorPid: processHandle.pid,
          containment,
          targetPid: event.targetPid,
        });
      } else if (event.type === 'RESULT') {
        if (!started || result) invalid('RESULT is duplicated or precedes STARTED');
        result = event;
        terminationTrigger.rootCompleted();
        await options.hooks?.onRootResult?.({
          supervisorPid: processHandle.pid,
          containment,
          code: event.code,
          signal: event.signal,
        });
      } else {
        drained = event;
      }
      if (!drained) {
        pendingEvent = processHandle.nextAny(['STARTED', 'RESULT', 'DRAINED'] as const, null);
      }
    }
    terminationTrigger.dispose();
    const drainedMessage = parseSupervisorDrained(drained.messageBytes);
    const receipt = await operation.acceptInstalledDrainedReceiptControlled(drained.messageBytes);
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
      receipt.drainReason === 'parent-shutdown';
    if (
      ((receipt.drainReason === 'natural' || receipt.drainReason === 'process-tree-not-empty') &&
        (!startSent || !started || !result)) ||
      (receipt.proof === 'never-started-containment-empty-v1' &&
        (startSent || started !== undefined || result !== undefined)) ||
      (receipt.proof !== 'never-started-containment-empty-v1' && !startSent) ||
      (externallyTerminated &&
        (terminationSent === undefined || terminationSent !== receipt.drainReason))
    ) {
      invalid('receipt drain reason does not match observed POSIX events');
    }
    await options.hooks?.onDrained?.({ supervisorPid: processHandle.pid, containment, receipt });
    processHandle.expectCleanExit();
    await processHandle.send({
      schemaVersion: 1,
      type: 'ACK',
      messageBase64: encodeSupervisorAcknowledgement(
        operation.operationId,
        drainedMessage.receiptDigest,
      ).toString('base64'),
    });
    const supervisorExit = await processHandle.waitForExit();
    if (supervisorExit.code !== 0 || supervisorExit.signal !== null) {
      isolated('supervisor did not close cleanly after ACK');
    }
    assertExactSupervisorDeath(processHandle.pid, descriptor.supervisorIdentity);
    if (probePosixProcessGroup(containment.pgid) !== 'empty') {
      isolated('target process group is not empty after supervisor close');
    }
    const settlement = await operation.settleArmedControlled({
      supervisor: 'dead',
      containment: 'empty',
    });
    completed = true;
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
      code: result?.code ?? null,
      signal: result?.signal ?? null,
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
    let closeoutError: unknown;
    try {
      if (!operation.settled && !operation.quarantined) {
        const reason = prestartAbortReason(error, terminationTrigger?.reason);
        if (operation.activeState === 'prepared') {
          await abortPreparedPosixOperation(operation, processHandle, supervisorIdentity, reason);
        } else if (operation.activeState === 'prepared-bound') {
          if (!processHandle || !descriptor) {
            isolated('prepared-bound operation lost its supervisor binding in memory');
          }
          await abortPreparedBoundPosixOperation(operation, processHandle, descriptor, reason);
        } else {
          await quarantineUnfinishedPosixOperation(
            operation,
            terminationAttempted || operation.receiptInstalled
              ? 'containment-unconfirmed'
              : 'operation-proof-missing',
          );
        }
      }
    } catch (failure) {
      closeoutError = failure;
      if (!operation.settled && !operation.quarantined) {
        try {
          await operation.installQuarantineControlled('containment-unconfirmed');
        } catch (quarantineError) {
          closeoutError = quarantineError;
        }
      }
    }
    throw closeoutError ?? error;
  } finally {
    terminationTrigger?.dispose();
    if (!completed && processHandle) await processHandle.abort();
  }
}
