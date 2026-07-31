import type { DelegatedSemanticCandidate } from '../contracts/delegated-operation-contract.js';
import { runWorkspaceOperationControlled, type OperationDelegationScope } from './operation.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from './posix-supervisor.js';
import type { WorkspaceSession } from './session.js';
import type { SupervisorTerminationReason } from './supervisor-protocol.js';
import { WorkspaceSafetyError } from './types.js';
import {
  readDarkWindowsHelperBundle,
  runDarkWindowsSupervisedOperation,
} from './windows-supervisor.js';

export interface ManagedSupervisorTimeouts {
  readonly handshakeMs?: number;
  readonly naturalDrainMs?: number;
  readonly termMs?: number;
  readonly killMs?: number;
  readonly ackMs?: number;
  readonly pollMs?: number;
}

export type ManagedWorkspaceProcessOptions = OperationDelegationScope & {
  readonly executable: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly timeoutMs: number;
  readonly termination?: {
    readonly signal: AbortSignal;
    readonly reason: Exclude<SupervisorTerminationReason, 'timeout'>;
  };
  readonly supervisorTimeouts?: ManagedSupervisorTimeouts;
};

export interface ManagedWorkspaceProcessResult {
  readonly verdict: 'completed' | 'root-failed' | 'process-tree-not-empty' | 'terminated';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  readonly timedOut: boolean;
  readonly processTreeNotEmpty: boolean;
  readonly terminationReason: SupervisorTerminationReason | null;
  readonly durationMs: number;
  readonly candidate?: DelegatedSemanticCandidate;
}

export function environmentEntries(
  environment: NodeJS.ProcessEnv,
): { readonly name: string; readonly value: string }[] {
  const names = new Set<string>();
  return (
    Object.entries(environment)
      .filter((entry): entry is [string, string] => entry[1] !== undefined)
      // npm may inject registry-derived keys such as npm_config_//host/:_authToken. They are not
      // portable environment variable names and the fixed supervisor correctly rejects them.
      .filter(([name]) => /^[A-Za-z_][A-Za-z0-9_]{0,127}$/u.test(name))
      .sort(([left], [right]) => left.localeCompare(right, 'en'))
      .filter(([name]) => {
        const canonical = name.toLowerCase();
        if (names.has(canonical)) return false;
        names.add(canonical);
        return true;
      })
      .map(([name, value]) => ({ name, value }))
  );
}

function assertSupportedPlatform(): 'posix-process-group-v1' | 'windows-job-v1' {
  if (process.platform === 'linux' || process.platform === 'darwin') {
    return 'posix-process-group-v1';
  }
  if (process.platform === 'win32') return 'windows-job-v1';
  throw new WorkspaceSafetyError(
    'unsupported',
    `当前系统 ${process.platform} 不支持 workspace 子进程隔离`,
  );
}

/**
 * Production coordinator for every project/agent/reviewer process that runs while a workspace
 * owner domain is active. The platform helper owns spawn, timeout and whole-tree closeout; callers
 * only receive a result after the operation has atomically settled.
 */
export async function runManagedWorkspaceProcess(
  session: WorkspaceSession,
  options: ManagedWorkspaceProcessOptions,
): Promise<ManagedWorkspaceProcessResult> {
  const platform = assertSupportedPlatform();
  const helperBytes =
    platform === 'windows-job-v1' ? readDarkWindowsHelperBundle() : readDarkPosixHelperBundle();
  const startedAt = Date.now();
  const outcome = await runWorkspaceOperationControlled(
    session,
    {
      ...options,
      platform,
      helperBytes,
    },
    async (operation) => {
      const target = {
        executable: options.executable,
        args: options.args,
        cwd: options.cwd,
        environment: options.environment,
      };
      if (platform === 'windows-job-v1') {
        return await runDarkWindowsSupervisedOperation(operation, {
          target,
          commandTimeoutMs: options.timeoutMs,
          termination: options.termination,
          timeouts: options.supervisorTimeouts,
        });
      }
      return await runDarkPosixSupervisedOperation(operation, {
        target,
        commandTimeoutMs: options.timeoutMs,
        termination: options.termination,
        timeouts: options.supervisorTimeouts,
      });
    },
  );

  return {
    verdict: outcome.verdict,
    exitCode: outcome.code,
    signal: outcome.signal,
    stdout: outcome.stdout,
    stderr: outcome.stderr,
    timedOut: outcome.terminationReason === 'timeout',
    processTreeNotEmpty: outcome.leftover,
    terminationReason: outcome.terminationReason,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(outcome.candidate ? { candidate: outcome.candidate } : {}),
  };
}
