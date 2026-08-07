import {
  spawnSync,
  type SpawnSyncOptionsWithBufferEncoding,
  type SpawnSyncReturns,
} from 'node:child_process';
import { performance } from 'node:perf_hooks';
import { describe, expect, it } from 'vitest';
import {
  parseWindowsIdentitySnapshotOutput,
  WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS,
  WINDOWS_IDENTITY_SNAPSHOT_SCRIPT,
  WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS,
} from './windows-identity-protocol.js';
import {
  readWindowsIdentitySnapshotControlled,
  type WindowsIdentityTransportRuntime,
} from './windows-identity-transport-test-seam.js';

const NATIVE_TIMEOUT_MS = 10_000;
const NATIVE_SLEEP_MS = 30_000;
const NATIVE_TEST_TIMEOUT_MS = NATIVE_TIMEOUT_MS + WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS + 20_000;
const TIMEOUT_STAGE = 'boot-read';
const TIMEOUT_STAGE_MARKER = `CXWI_STAGE_V1 stage=${TIMEOUT_STAGE}`;
const TIMEOUT_DECOY_HOST = 'coding-x-timeout-decoy';
const TIMEOUT_DECOY_BOOT = '1970-01-01T00:00:00.000Z';
const TIMEOUT_DECOY_JSON = JSON.stringify({
  hostIdentity: TIMEOUT_DECOY_HOST,
  bootIdentity: TIMEOUT_DECOY_BOOT,
  processStatus: 'found',
  processValue: '1',
});
const SAFE_RECOVERY_WARNING =
  /^Windows identity snapshot recovered after one bounded retry firstCode=ETIMEDOUT firstStage=(powershell-startup|process-read|boot-read|host-read|response-write) firstElapsedMs=(\d{1,6}) totalElapsedMs=(\d{1,6})$/u;
const NATIVE_TIMEOUT_SCRIPT = [
  "$ErrorActionPreference = 'Stop'",
  `$stageBytes = [Text.Encoding]::UTF8.GetBytes("${TIMEOUT_STAGE_MARKER}\`n")`,
  '$stageStream = [Console]::OpenStandardError()',
  '$stageStream.Write($stageBytes, 0, $stageBytes.Length)',
  '$stageStream.Flush()',
  `[Console]::Out.Write('${TIMEOUT_DECOY_JSON}')`,
  '[Console]::Out.Flush()',
  'Get-CimInstance -ClassName Win32_OperatingSystem -Property LastBootUpTime | Out-Null',
  `Start-Sleep -Milliseconds ${String(NATIVE_SLEEP_MS)}`,
].join('\n');

interface FirstAttemptFacts {
  readonly usedProductionPowerShellInvocation: boolean;
  readonly code: string | null;
  readonly status: number | null;
  readonly stageMarkerVisible: boolean;
  readonly decoySnapshotVisible: boolean;
}

interface SecondAttemptFacts {
  readonly usedUnchangedProductionInvocation: boolean;
  readonly status: number | null;
  readonly code: string | null;
}

function errorCode(error: Error | undefined): string | null {
  if (!error || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}

function contains(buffer: Buffer | null | undefined, value: string): boolean {
  return Buffer.isBuffer(buffer) && buffer.includes(Buffer.from(value, 'utf8'));
}

function recoveryWarningFacts(message: string): {
  readonly safe: boolean;
  readonly stageWasBootRead: boolean;
} {
  const match = SAFE_RECOVERY_WARNING.exec(message);
  if (!match) return { safe: false, stageWasBootRead: false };
  const firstElapsedMs = Number(match[2]);
  const totalElapsedMs = Number(match[3]);
  return {
    safe:
      firstElapsedMs < WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS &&
      totalElapsedMs < WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS &&
      firstElapsedMs <= totalElapsedMs,
    stageWasBootRead: match[1] === TIMEOUT_STAGE,
  };
}

function isSystemWindowsPowerShell(command: string): boolean {
  return command
    .toLocaleLowerCase('en-US')
    .endsWith('\\system32\\windowspowershell\\v1.0\\powershell.exe');
}

describe.skipIf(process.platform !== 'win32')(
  'Windows identity snapshot native timeout proof',
  () => {
    it(
      'observes the real spawnSync timeout tuple and adopts only a fresh production snapshot',
      () => {
        let calls = 0;
        let firstAttempt: FirstAttemptFacts | undefined;
        let secondAttempt: SecondAttemptFacts | undefined;
        let secondOutput: Buffer | undefined;
        let warningCount = 0;
        let warningWasSafe = true;
        let warningStageWasBootRead = true;
        let warningExcludedDecoy = true;

        const spawn = (
          command: string,
          args: string[],
          options: SpawnSyncOptionsWithBufferEncoding,
        ): SpawnSyncReturns<Buffer> => {
          calls += 1;
          if (calls === 1) {
            const fixtureArgs = [...args.slice(0, -1), NATIVE_TIMEOUT_SCRIPT];
            const result = spawnSync(command, fixtureArgs, {
              ...options,
              timeout: NATIVE_TIMEOUT_MS,
            });
            firstAttempt = {
              usedProductionPowerShellInvocation:
                isSystemWindowsPowerShell(command) &&
                args.at(-1) === WINDOWS_IDENTITY_SNAPSHOT_SCRIPT &&
                options.timeout === WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS &&
                options.shell === false,
              code: errorCode(result.error),
              status: result.status,
              stageMarkerVisible: contains(result.stderr, TIMEOUT_STAGE_MARKER),
              decoySnapshotVisible: contains(result.stdout, TIMEOUT_DECOY_HOST),
            };
            return result;
          }

          const result = spawnSync(command, args, options);
          secondAttempt = {
            usedUnchangedProductionInvocation:
              isSystemWindowsPowerShell(command) &&
              args.at(-1) === WINDOWS_IDENTITY_SNAPSHOT_SCRIPT &&
              options.timeout === WINDOWS_IDENTITY_COMMAND_TIMEOUT_MS &&
              options.shell === false,
            status: result.status,
            code: errorCode(result.error),
          };
          if (Buffer.isBuffer(result.stdout)) secondOutput = result.stdout;
          return result;
        };

        const runtime: WindowsIdentityTransportRuntime = {
          now: () => performance.now(),
          spawn,
          warn: (message) => {
            const facts = recoveryWarningFacts(message);
            warningCount += 1;
            warningWasSafe &&= facts.safe;
            warningStageWasBootRead &&= facts.stageWasBootRead;
            warningExcludedDecoy &&= !message.includes(TIMEOUT_DECOY_HOST);
          },
        };
        const snapshot = readWindowsIdentitySnapshotControlled(process.pid, runtime);

        expect(calls).toBe(2);
        expect(firstAttempt).toEqual({
          usedProductionPowerShellInvocation: true,
          code: 'ETIMEDOUT',
          status: null,
          stageMarkerVisible: true,
          decoySnapshotVisible: true,
        });
        expect(secondAttempt).toEqual({
          usedUnchangedProductionInvocation: true,
          status: 0,
          code: null,
        });
        expect({
          warningCount,
          warningWasSafe,
          warningStageWasBootRead,
          warningExcludedDecoy,
        }).toEqual({
          warningCount: 1,
          warningWasSafe: true,
          warningStageWasBootRead: true,
          warningExcludedDecoy: true,
        });

        const fresh = parseWindowsIdentitySnapshotOutput(secondOutput?.toString('utf8') ?? '');
        const returnedOnlyFreshSnapshot =
          snapshot.hostIdentity === fresh.hostIdentity &&
          snapshot.bootIdentity === fresh.bootIdentity &&
          snapshot.processIdentity.status === 'found' &&
          fresh.processStatus === 'found' &&
          snapshot.processIdentity.value === fresh.processValue;
        expect(returnedOnlyFreshSnapshot).toBe(true);
        expect(snapshot.hostIdentity === TIMEOUT_DECOY_HOST).toBe(false);
        expect(snapshot.bootIdentity === TIMEOUT_DECOY_BOOT).toBe(false);
      },
      NATIVE_TEST_TIMEOUT_MS,
    );
  },
);
