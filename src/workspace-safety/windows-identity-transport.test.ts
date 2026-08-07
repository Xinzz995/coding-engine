import type { SpawnSyncOptionsWithBufferEncoding, SpawnSyncReturns } from 'node:child_process';
import { uptime } from 'node:os';
import { inspect } from 'node:util';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  readWindowsIdentitySnapshotControlled,
  type WindowsIdentityTransportRuntime,
} from './windows-identity-transport-test-seam.js';
import {
  WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
  WINDOWS_IDENTITY_MAX_CAPTURE_BYTES,
  WINDOWS_IDENTITY_SNAPSHOT_SCRIPT,
  WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS,
} from './windows-identity-protocol.js';
import { WorkspaceSafetyError } from './types.js';

interface SpawnStep {
  readonly elapsedMs: number;
  readonly result?: SpawnSyncReturns<Buffer>;
  readonly thrown?: Error;
}

function validBootIdentity(): string {
  return new Date(Date.now() - uptime() * 1000).toISOString();
}

function snapshotBytes(
  hostIdentity: string,
  processValue: string,
  bootIdentity = validBootIdentity(),
): Buffer {
  return Buffer.from(
    JSON.stringify({
      processStatus: 'found',
      processValue,
      bootIdentity,
      hostIdentity,
    }),
  );
}

function stageBytes(stage: string, suffix = ''): Buffer {
  return Buffer.from(`CXWI_STAGE_V1 stage=${stage}\n${suffix}`);
}

function spawnResult(options: {
  readonly stdout?: Buffer;
  readonly stderr?: Buffer;
  readonly status?: number | null;
  readonly signal?: NodeJS.Signals | null;
  readonly error?: Error;
}): SpawnSyncReturns<Buffer> {
  const stdout = options.stdout ?? Buffer.alloc(0);
  const stderr = options.stderr ?? Buffer.alloc(0);
  return {
    pid: 1234,
    output: [null, stdout, stderr],
    stdout,
    stderr,
    status: options.status === undefined ? 0 : options.status,
    signal: options.signal ?? null,
    ...(options.error ? { error: options.error } : {}),
  };
}

function timeoutError(message = 'spawn timed out'): Error {
  return Object.assign(new Error(message), { code: 'ETIMEDOUT' });
}

function testRuntime(steps: readonly SpawnStep[]): {
  readonly runtime: WindowsIdentityTransportRuntime;
  readonly spawn: ReturnType<typeof vi.fn>;
  readonly warn: ReturnType<typeof vi.fn>;
} {
  let currentTime = 0;
  let index = 0;
  const spawn = vi.fn(
    (
      _command: string,
      _args: string[],
      _options: SpawnSyncOptionsWithBufferEncoding,
    ): SpawnSyncReturns<Buffer> => {
      const step = steps[index];
      index += 1;
      if (!step) throw new Error('unexpected extra spawn');
      currentTime += step.elapsedMs;
      if (step.thrown) throw step.thrown;
      return step.result!;
    },
  );
  const warn = vi.fn();
  return {
    runtime: { now: () => currentTime, spawn, warn },
    spawn,
    warn,
  };
}

function captureFailure(operation: () => unknown): WorkspaceSafetyError {
  try {
    operation();
  } catch (error) {
    expect(error).toBeInstanceOf(WorkspaceSafetyError);
    return error as WorkspaceSafetyError;
  }
  throw new Error('expected operation to fail');
}

describe('Windows identity snapshot transport retry', () => {
  beforeEach(() => {
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('PROJECT_SECRET', 'project-secret-canary');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it('retries one explicit timeout with a fresh complete snapshot and emits a safe warning', () => {
    const firstError = timeoutError('timeout cause contains cause-secret-canary');
    const { runtime, spawn, warn } = testRuntime([
      {
        elapsedMs: 60_000,
        result: spawnResult({
          error: firstError,
          status: null,
          signal: 'SIGTERM',
          stdout: snapshotBytes('first-host-secret', '111'),
          stderr: stageBytes('boot-read', 'stderr-secret-canary'),
        }),
      },
      {
        elapsedMs: 125,
        result: spawnResult({
          stdout: snapshotBytes('second-host', '222'),
          stderr: stageBytes('response-write'),
        }),
      },
    ]);

    expect(readWindowsIdentitySnapshotControlled(4321, runtime)).toEqual({
      hostIdentity: 'second-host',
      bootIdentity: expect.any(String),
      processIdentity: { status: 'found', value: '222' },
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(spawn.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({
        encoding: 'buffer',
        maxBuffer: WINDOWS_IDENTITY_MAX_CAPTURE_BYTES,
        shell: false,
        timeout: WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
        windowsHide: true,
        env: {
          SystemRoot: 'C:\\Windows',
          windir: 'C:\\Windows',
          PSModulePath: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\Modules',
          CODING_X_WINDOWS_IDENTITY_PID: '4321',
        },
      }),
    );
    expect(spawn.mock.calls[1]?.[2]).toEqual(
      expect.objectContaining({ timeout: WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS }),
    );
    expect(JSON.stringify(spawn.mock.calls[0]?.[2])).not.toContain('project-secret-canary');
    expect(warn).toHaveBeenCalledTimes(1);
    const warning = String(warn.mock.calls[0]?.[0]);
    expect(warning).toContain('firstCode=ETIMEDOUT');
    expect(warning).toContain('firstStage=boot-read');
    expect(warning).toContain('firstElapsedMs=60000');
    expect(warning).toContain('totalElapsedMs=60125');
    expect(warning).not.toMatch(/first-host-secret|stderr-secret-canary|cause-secret-canary/u);
  });

  it('fails after two explicit timeouts with bounded final fields and no raw cause', () => {
    const firstError = timeoutError('first-cause-secret');
    const secondError = Object.assign(timeoutError('second-cause-secret'), {
      spawnargs: [WINDOWS_IDENTITY_SNAPSHOT_SCRIPT, 'spawnarg-secret'],
    });
    const { runtime, spawn, warn } = testRuntime([
      {
        elapsedMs: 60_000,
        result: spawnResult({
          error: firstError,
          status: null,
          signal: 'SIGTERM',
          stdout: Buffer.from('first-stdout-secret'),
          stderr: stageBytes('boot-read', 'first-stderr-secret'),
        }),
      },
      {
        elapsedMs: 60_000,
        result: spawnResult({
          error: secondError,
          status: null,
          signal: 'SIGTERM',
          stdout: Buffer.from('second-stdout-secret'),
          stderr: stageBytes('host-read', 'second-stderr-secret'),
        }),
      },
    ]);

    const failure = captureFailure(() => readWindowsIdentitySnapshotControlled(4321, runtime));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(failure.code).toBe('unsupported');
    expect(failure.message).toContain('attempt=1/2 reason=timeout code=ETIMEDOUT stage=boot-read');
    expect(failure.message).toContain('attempt=2/2 reason=timeout code=ETIMEDOUT stage=host-read');
    expect(failure.message).toContain('totalElapsedMs=120000');
    expect(failure.message).not.toMatch(/stdout-secret|stderr-secret|cause-secret|project-secret/u);
    expect((failure as Error).cause).toBeUndefined();
    const rendered = [
      String(failure),
      failure.stack ?? '',
      inspect(failure, { depth: 5, showHidden: true }),
      JSON.stringify(failure),
    ].join('\n');
    expect(rendered).not.toMatch(
      /Get-CimInstance|spawnarg-secret|stdout-secret|stderr-secret|cause-secret|project-secret/u,
    );
  });

  it.each([
    {
      name: 'a non-timeout spawn code',
      result: spawnResult({
        error: Object.assign(new Error('access denied'), { code: 'EACCES' }),
        status: null,
      }),
      reason: 'spawn-error',
    },
    {
      name: 'an ETIMEDOUT error paired with a non-null status',
      result: spawnResult({ error: timeoutError(), status: 1 }),
      reason: 'spawn-error',
    },
    {
      name: 'a timeout-shaped message without the exact code',
      result: spawnResult({ error: new Error('ETIMEDOUT'), status: null }),
      reason: 'spawn-error',
    },
    {
      name: 'a signal without the exact timeout error',
      result: spawnResult({ status: null, signal: 'SIGTERM' }),
      reason: 'process-exit',
    },
    {
      name: 'a non-zero PowerShell status',
      result: spawnResult({ status: 7, stderr: stageBytes('process-read') }),
      reason: 'process-exit',
    },
  ])('does not retry $name', ({ result, reason }) => {
    const { runtime, spawn, warn } = testRuntime([{ elapsedMs: 10, result }]);

    const failure = captureFailure(() => readWindowsIdentitySnapshotControlled(4321, runtime));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(failure.message).toContain(`reason=${reason}`);
  });

  it.each([
    {
      name: 'invalid UTF-8',
      result: spawnResult({ stdout: Buffer.from([0xc3, 0x28]) }),
      reason: 'response-decode',
    },
    {
      name: 'malformed JSON',
      result: spawnResult({ stdout: Buffer.from('{') }),
      reason: 'response-parse',
    },
    {
      name: 'a boot identity disagreement',
      result: spawnResult({ stdout: snapshotBytes('host', '123', '2000-01-01T00:00:00.000Z') }),
      reason: 'boot-validation',
    },
  ])('does not retry $name', ({ result, reason }) => {
    const { runtime, spawn } = testRuntime([{ elapsedMs: 5, result }]);

    const failure = captureFailure(() => readWindowsIdentitySnapshotControlled(4321, runtime));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(failure.message).toContain(`reason=${reason}`);
  });

  it.each([
    {
      name: 'a non-zero exit',
      result: spawnResult({ status: 7, stderr: stageBytes('host-read') }),
      reason: 'process-exit',
    },
    {
      name: 'a malformed response',
      result: spawnResult({ stdout: Buffer.from('{') }),
      reason: 'response-parse',
    },
  ])('does not make a third attempt when the retry ends with $name', ({ result, reason }) => {
    const { runtime, spawn, warn } = testRuntime([
      {
        elapsedMs: 60_000,
        result: spawnResult({
          error: timeoutError(),
          status: null,
          signal: 'SIGTERM',
          stderr: stageBytes('boot-read'),
        }),
      },
      { elapsedMs: 5, result },
    ]);

    const failure = captureFailure(() => readWindowsIdentitySnapshotControlled(4321, runtime));

    expect(spawn).toHaveBeenCalledTimes(2);
    expect(warn).not.toHaveBeenCalled();
    expect(failure.message).toContain(`attempt=2/2 reason=${reason}`);
  });

  it('does not reset the shared absolute budget before the retry', () => {
    const { runtime, spawn } = testRuntime([
      {
        elapsedMs: WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS,
        result: spawnResult({
          error: timeoutError(),
          status: null,
          signal: 'SIGTERM',
          stderr: stageBytes('boot-read'),
        }),
      },
    ]);

    const failure = captureFailure(() => readWindowsIdentitySnapshotControlled(4321, runtime));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(failure.message).toContain('reason=total-budget-exhausted');
    expect(failure.message).toContain('totalElapsedMs=120000');
  });

  it('fails before spawning when the monotonic clock is not finite', () => {
    const spawn = vi.fn();
    const failure = captureFailure(() =>
      readWindowsIdentitySnapshotControlled(4321, {
        now: () => Number.NaN,
        spawn,
        warn: vi.fn(),
      }),
    );

    expect(spawn).not.toHaveBeenCalled();
    expect(failure.message).toContain('reason=clock-invalid');
  });

  it('does not start a retry when the monotonic clock moves backwards', () => {
    const readings = [100, 100, 110, 109];
    const spawn = vi.fn(() =>
      spawnResult({
        error: timeoutError(),
        status: null,
        signal: 'SIGTERM',
        stderr: stageBytes('boot-read'),
      }),
    );
    const failure = captureFailure(() =>
      readWindowsIdentitySnapshotControlled(4321, {
        now: () => readings.shift()!,
        spawn,
        warn: vi.fn(),
      }),
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(failure.message).toContain('reason=clock-invalid');
  });

  it('fails once when the system command throws without exposing the original error', () => {
    const thrown = Object.assign(new Error('spawn-threw-secret'), {
      spawnargs: [WINDOWS_IDENTITY_SNAPSHOT_SCRIPT, 'spawnarg-secret'],
    });
    const { runtime, spawn, warn } = testRuntime([{ elapsedMs: 2, thrown }]);

    const failure = captureFailure(() => readWindowsIdentitySnapshotControlled(4321, runtime));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(failure.message).toContain('reason=spawn-error');
    expect(failure.message).toContain('code=threw');
    expect((failure as Error).cause).toBeUndefined();
    expect(inspect(failure, { depth: 5, showHidden: true })).not.toMatch(
      /Get-CimInstance|spawn-threw-secret|spawnarg-secret/u,
    );
  });

  it('shrinks the retry timeout to the remaining shared budget', () => {
    const { runtime, spawn } = testRuntime([
      {
        elapsedMs: 75_000,
        result: spawnResult({
          error: timeoutError(),
          status: null,
          signal: 'SIGTERM',
          stderr: stageBytes('boot-read'),
        }),
      },
      {
        elapsedMs: 20,
        result: spawnResult({
          stdout: snapshotBytes('second-host', '321'),
          stderr: stageBytes('response-write'),
        }),
      },
    ]);

    expect(readWindowsIdentitySnapshotControlled(4321, runtime)).toMatchObject({
      hostIdentity: 'second-host',
      processIdentity: { status: 'found', value: '321' },
    });
    expect(spawn.mock.calls[0]?.[2]).toEqual(
      expect.objectContaining({ timeout: WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS }),
    );
    expect(spawn.mock.calls[1]?.[2]).toEqual(expect.objectContaining({ timeout: 45_000 }));
  });

  it('rejects a nominally successful result that reaches the absolute deadline', () => {
    const { runtime, spawn, warn } = testRuntime([
      {
        elapsedMs: WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS,
        result: spawnResult({
          stdout: snapshotBytes('late-host-secret', '999'),
          stderr: stageBytes('response-write', 'late-stderr-secret'),
        }),
      },
    ]);

    const failure = captureFailure(() => readWindowsIdentitySnapshotControlled(4321, runtime));

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
    expect(failure.message).toContain('reason=total-budget-exhausted');
    expect(failure.message).toContain('code=deadline');
    expect(failure.message).toContain('stage=response-write');
    expect(failure.message).toContain('totalElapsedMs=120000');
    expect(failure.message).not.toMatch(/late-host-secret|late-stderr-secret/u);
  });

  it('rejects a result when complete validation reaches the absolute deadline', () => {
    const readings = [
      0,
      0,
      WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS - 2,
      WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS,
    ];
    const spawn = vi.fn(() =>
      spawnResult({
        stdout: snapshotBytes('validated-too-late-secret', '999'),
        stderr: stageBytes('response-write'),
      }),
    );
    const failure = captureFailure(() =>
      readWindowsIdentitySnapshotControlled(4321, {
        now: () => readings.shift()!,
        spawn,
        warn: vi.fn(),
      }),
    );

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(failure.message).toContain('reason=total-budget-exhausted');
    expect(failure.message).toContain('code=deadline');
    expect(failure.message).toContain('totalElapsedMs=120000');
    expect(failure.message).not.toContain('validated-too-late-secret');
  });

  it('uses powershell-startup for malformed or oversized stage diagnostics without echoing them', () => {
    const { runtime } = testRuntime([
      {
        elapsedMs: 3,
        result: spawnResult({
          status: 9,
          stderr: Buffer.concat([
            stageBytes('attacker-controlled', 'stage-secret-canary'),
            Buffer.alloc(WINDOWS_IDENTITY_MAX_CAPTURE_BYTES, 120),
          ]),
        }),
      },
    ]);

    const failure = captureFailure(() => readWindowsIdentitySnapshotControlled(4321, runtime));

    expect(failure.message).toContain('stage=powershell-startup');
    expect(failure.message).not.toMatch(/attacker-controlled|stage-secret-canary/u);
  });

  it('does not emit a retry warning when the first complete snapshot succeeds', () => {
    const { runtime, spawn, warn } = testRuntime([
      { elapsedMs: 2, result: spawnResult({ stdout: snapshotBytes('host', '456') }) },
    ]);

    expect(readWindowsIdentitySnapshotControlled(4321, runtime)).toMatchObject({
      hostIdentity: 'host',
      processIdentity: { status: 'found', value: '456' },
    });
    expect(spawn).toHaveBeenCalledTimes(1);
    expect(warn).not.toHaveBeenCalled();
  });

  it('keeps a validated retry result when the safe warning sink throws', () => {
    const { runtime, spawn, warn } = testRuntime([
      {
        elapsedMs: 60_000,
        result: spawnResult({
          error: timeoutError(),
          status: null,
          signal: 'SIGTERM',
          stderr: stageBytes('boot-read'),
        }),
      },
      {
        elapsedMs: 10,
        result: spawnResult({
          stdout: snapshotBytes('replacement-host', '654'),
          stderr: stageBytes('response-write'),
        }),
      },
    ]);
    warn.mockImplementationOnce(() => {
      throw new Error('diagnostics-sink-secret');
    });

    expect(readWindowsIdentitySnapshotControlled(4321, runtime)).toMatchObject({
      hostIdentity: 'replacement-host',
      processIdentity: { status: 'found', value: '654' },
    });
    expect(spawn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});
