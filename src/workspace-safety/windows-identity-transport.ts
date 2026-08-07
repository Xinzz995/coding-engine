import {
  spawnSync,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { TextDecoder } from 'node:util';
import type { ProcessIdentityLookup } from './identity.js';
import {
  parseWindowsIdentitySnapshotOutput,
  resolveWindowsIdentityPowerShellLaunch,
  validateWindowsBootIdentity,
  WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
  WINDOWS_IDENTITY_FAILURE_STAGES,
  WINDOWS_IDENTITY_MAX_ATTEMPTS,
  WINDOWS_IDENTITY_MAX_CAPTURE_BYTES,
  WINDOWS_IDENTITY_SNAPSHOT_SCRIPT,
  WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS,
  type WindowsIdentityFailureStage,
} from './windows-identity-protocol.js';
import { inspectWindowsProcessIdentity } from './windows-path-attributes.js';
import { WorkspaceSafetyError } from './types.js';

export interface WindowsIdentitySnapshot {
  readonly hostIdentity: string;
  readonly bootIdentity: string;
  readonly processIdentity: ProcessIdentityLookup;
}

export interface WindowsIdentityTransportRuntime {
  readonly now: () => number;
  readonly spawn: (
    command: string,
    args: string[],
    options: SpawnSyncOptionsWithBufferEncoding,
  ) => SpawnSyncReturns<Buffer>;
  readonly warn: (message: string) => void;
}

type WindowsIdentityFailureReason =
  | 'timeout'
  | 'total-budget-exhausted'
  | 'spawn-error'
  | 'process-exit'
  | 'response-decode'
  | 'response-parse'
  | 'boot-validation';

interface WindowsIdentityAttemptFailure {
  readonly attempt: number;
  readonly reason: WindowsIdentityFailureReason;
  readonly stage: WindowsIdentityFailureStage;
  readonly code: string;
  readonly status: number | null;
  readonly signal: string;
  readonly elapsedMs: number;
}

const FAILURE_STAGE_SET = new Set<WindowsIdentityFailureStage>(WINDOWS_IDENTITY_FAILURE_STAGES);
const STAGE_MARKER_PATTERN = /^CXWI_STAGE_V1 stage=([a-z-]+)$/u;

const SYSTEM_RUNTIME: WindowsIdentityTransportRuntime = Object.freeze({
  now: () => performance.now(),
  spawn: spawnSync,
  warn: (message: string) => console.warn(message),
});

function safeToken(value: unknown): string {
  return typeof value === 'string' && /^[A-Z0-9_]{1,64}$/u.test(value) ? value : 'unknown';
}

function safeSignal(value: unknown): string {
  return typeof value === 'string' && /^SIG[A-Z0-9]{1,32}$/u.test(value) ? value : 'none';
}

function errorCode(value: unknown): unknown {
  return typeof value === 'object' && value !== null && 'code' in value ? value.code : undefined;
}

function strictUtf8(bytes: Buffer): string {
  return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
}

function lastFailureStage(stderr: Buffer): WindowsIdentityFailureStage {
  if (stderr.byteLength === 0 || stderr.byteLength > WINDOWS_IDENTITY_MAX_CAPTURE_BYTES) {
    return 'powershell-startup';
  }
  let text: string;
  try {
    text = strictUtf8(stderr);
  } catch {
    return 'powershell-startup';
  }
  let stage: WindowsIdentityFailureStage = 'powershell-startup';
  for (const line of text.split(/\r?\n/u)) {
    const match = STAGE_MARKER_PATTERN.exec(line.trim());
    if (match && FAILURE_STAGE_SET.has(match[1] as WindowsIdentityFailureStage)) {
      stage = match[1] as WindowsIdentityFailureStage;
    }
  }
  return stage;
}

function elapsedMilliseconds(startedAt: number, finishedAt: number): number {
  return Math.max(0, Math.ceil(finishedAt - startedAt));
}

function readMonotonicNow(runtime: WindowsIdentityTransportRuntime, previous?: number): number {
  const value = runtime.now();
  if (!Number.isFinite(value) || (previous !== undefined && value < previous)) {
    throw new WorkspaceSafetyError(
      'unsupported',
      'Windows identity snapshot is unavailable (reason=clock-invalid)',
    );
  }
  return value;
}

function describeFailure(failure: WindowsIdentityAttemptFailure): string {
  return [
    `attempt=${String(failure.attempt)}/${String(WINDOWS_IDENTITY_MAX_ATTEMPTS)}`,
    `reason=${failure.reason}`,
    `code=${failure.code}`,
    `stage=${failure.stage}`,
    `status=${String(failure.status)}`,
    `signal=${failure.signal}`,
    `elapsedMs=${String(failure.elapsedMs)}`,
  ].join(' ');
}

function unavailable(
  failures: readonly WindowsIdentityAttemptFailure[],
  totalElapsedMs: number,
  suffix?: string,
): WorkspaceSafetyError {
  const details = failures.map(describeFailure).join('; ');
  return new WorkspaceSafetyError(
    'unsupported',
    `Windows identity snapshot is unavailable (${details || 'attempt=none'}; totalElapsedMs=${String(totalElapsedMs)}${suffix ? `; ${suffix}` : ''})`,
  );
}

function recoveredWarning(timeout: WindowsIdentityAttemptFailure, totalElapsedMs: number): string {
  return [
    'Windows identity snapshot recovered after one bounded retry',
    `firstCode=${timeout.code}`,
    `firstStage=${timeout.stage}`,
    `firstElapsedMs=${String(timeout.elapsedMs)}`,
    `totalElapsedMs=${String(totalElapsedMs)}`,
  ].join(' ');
}

function warnRecoveredSnapshot(
  runtime: WindowsIdentityTransportRuntime,
  timeout: WindowsIdentityAttemptFailure,
  totalElapsedMs: number,
): void {
  try {
    runtime.warn(recoveredWarning(timeout, totalElapsedMs));
  } catch {
    // The complete replacement snapshot is already validated. A broken diagnostics sink must not
    // discard that safe result or trigger another identity read.
  }
}

function isExplicitTimeout(result: SpawnSyncReturns<Buffer>): boolean {
  return (
    result.status === null && result.error !== undefined && errorCode(result.error) === 'ETIMEDOUT'
  );
}

function resultBuffer(value: unknown): Buffer {
  return Buffer.isBuffer(value) ? value : Buffer.alloc(0);
}

function probePidExistence(pid: number): 'present' | 'missing' | 'unknown' {
  try {
    process.kill(pid, 0);
    return 'present';
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ESRCH') return 'missing';
    return 'unknown';
  }
}

/** Lightweight process-only lookup used by supervisor liveness checks. */
export function readWindowsProcessIdentity(pid: number): ProcessIdentityLookup {
  try {
    const identity = inspectWindowsProcessIdentity(pid);
    return identity.status === 'found'
      ? { status: 'found', value: identity.value }
      : { status: identity.status };
  } catch {
    return { status: 'unknown' };
  }
}

/** @internal Exposed only through windows-identity-transport-test-seam.ts. */
export function readWindowsIdentitySnapshotControlled(
  pid: number,
  runtime: WindowsIdentityTransportRuntime,
): WindowsIdentitySnapshot {
  const totalStartedAt = readMonotonicNow(runtime);
  const launch = resolveWindowsIdentityPowerShellLaunch();
  const failures: WindowsIdentityAttemptFailure[] = [];
  let lastObservedAt = totalStartedAt;

  for (let attempt = 1; attempt <= WINDOWS_IDENTITY_MAX_ATTEMPTS; attempt += 1) {
    const attemptStartedAt = readMonotonicNow(runtime, lastObservedAt);
    lastObservedAt = attemptStartedAt;
    const totalElapsedBeforeAttempt = elapsedMilliseconds(totalStartedAt, attemptStartedAt);
    const remainingMs = WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS - totalElapsedBeforeAttempt;
    if (remainingMs <= 0) {
      throw unavailable(failures, totalElapsedBeforeAttempt, 'reason=total-budget-exhausted');
    }
    const timeoutMs = Math.min(WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS, remainingMs);
    let result: SpawnSyncReturns<Buffer>;
    try {
      result = runtime.spawn(
        launch.command,
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', WINDOWS_IDENTITY_SNAPSHOT_SCRIPT],
        {
          encoding: 'buffer',
          env: { ...launch.env, CODING_X_WINDOWS_IDENTITY_PID: String(pid) },
          maxBuffer: WINDOWS_IDENTITY_MAX_CAPTURE_BYTES,
          shell: false,
          timeout: timeoutMs,
          windowsHide: true,
        },
      );
    } catch {
      const finishedAt = readMonotonicNow(runtime, lastObservedAt);
      lastObservedAt = finishedAt;
      failures.push({
        attempt,
        reason: 'spawn-error',
        stage: 'powershell-startup',
        code: 'threw',
        status: null,
        signal: 'none',
        elapsedMs: elapsedMilliseconds(attemptStartedAt, finishedAt),
      });
      throw unavailable(failures, elapsedMilliseconds(totalStartedAt, finishedAt));
    }

    const finishedAt = readMonotonicNow(runtime, lastObservedAt);
    lastObservedAt = finishedAt;
    const elapsedMs = elapsedMilliseconds(attemptStartedAt, finishedAt);
    const stage = lastFailureStage(resultBuffer(result.stderr));
    const code = safeToken(errorCode(result.error));
    const status = typeof result.status === 'number' ? result.status : null;
    const signal = safeSignal(result.signal);

    if (isExplicitTimeout(result)) {
      failures.push({
        attempt,
        reason: 'timeout',
        stage,
        code,
        status,
        signal,
        elapsedMs,
      });
      if (attempt < WINDOWS_IDENTITY_MAX_ATTEMPTS) continue;
      throw unavailable(failures, elapsedMilliseconds(totalStartedAt, finishedAt));
    }

    if (result.error) {
      failures.push({
        attempt,
        reason: 'spawn-error',
        stage,
        code,
        status,
        signal,
        elapsedMs,
      });
      throw unavailable(failures, elapsedMilliseconds(totalStartedAt, finishedAt));
    }
    if (result.status !== 0 || result.signal !== null) {
      failures.push({
        attempt,
        reason: 'process-exit',
        stage,
        code,
        status,
        signal,
        elapsedMs,
      });
      throw unavailable(failures, elapsedMilliseconds(totalStartedAt, finishedAt));
    }

    const totalElapsedAfterAttempt = elapsedMilliseconds(totalStartedAt, finishedAt);
    if (totalElapsedAfterAttempt >= WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS) {
      failures.push({
        attempt,
        reason: 'total-budget-exhausted',
        stage,
        code: 'deadline',
        status,
        signal,
        elapsedMs,
      });
      throw unavailable(failures, totalElapsedAfterAttempt);
    }

    let output: string;
    try {
      output = strictUtf8(resultBuffer(result.stdout));
    } catch {
      failures.push({
        attempt,
        reason: 'response-decode',
        stage: 'response-decode',
        code: 'invalid-utf8',
        status,
        signal,
        elapsedMs,
      });
      throw unavailable(failures, elapsedMilliseconds(totalStartedAt, finishedAt));
    }

    let record: ReturnType<typeof parseWindowsIdentitySnapshotOutput>;
    try {
      record = parseWindowsIdentitySnapshotOutput(output);
    } catch {
      failures.push({
        attempt,
        reason: 'response-parse',
        stage: 'response-parse',
        code: 'malformed',
        status,
        signal,
        elapsedMs,
      });
      throw unavailable(failures, elapsedMilliseconds(totalStartedAt, finishedAt));
    }

    let bootIdentity: string;
    try {
      bootIdentity = validateWindowsBootIdentity(record.bootIdentity);
    } catch {
      failures.push({
        attempt,
        reason: 'boot-validation',
        stage: 'boot-validation',
        code: 'disagreed',
        status,
        signal,
        elapsedMs,
      });
      throw unavailable(failures, elapsedMilliseconds(totalStartedAt, finishedAt));
    }

    let processIdentity: ProcessIdentityLookup;
    if (record.processStatus === 'found') {
      processIdentity = { status: 'found', value: record.processValue! };
    } else if (record.processStatus === 'unknown') {
      processIdentity = { status: 'unknown' };
    } else {
      const existence = probePidExistence(pid);
      processIdentity = existence === 'missing' ? { status: 'missing' } : { status: 'unknown' };
    }
    const snapshot = {
      processIdentity,
      bootIdentity,
      hostIdentity: record.hostIdentity,
    };
    const completedAt = readMonotonicNow(runtime, lastObservedAt);
    lastObservedAt = completedAt;
    const totalElapsedAtCompletion = elapsedMilliseconds(totalStartedAt, completedAt);
    if (totalElapsedAtCompletion >= WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS) {
      failures.push({
        attempt,
        reason: 'total-budget-exhausted',
        stage,
        code: 'deadline',
        status,
        signal,
        elapsedMs: elapsedMilliseconds(attemptStartedAt, completedAt),
      });
      throw unavailable(failures, totalElapsedAtCompletion);
    }
    if (failures.length > 0) {
      warnRecoveredSnapshot(runtime, failures[0], totalElapsedAtCompletion);
    }
    return snapshot;
  }

  throw unavailable(failures, elapsedMilliseconds(totalStartedAt, lastObservedAt));
}

export function readWindowsIdentitySnapshot(pid: number): WindowsIdentitySnapshot {
  return readWindowsIdentitySnapshotControlled(pid, SYSTEM_RUNTIME);
}
