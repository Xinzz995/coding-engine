import { realpathSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import type { Writable } from 'node:stream';
import type { DelegatedSemanticCandidate } from '../contracts/delegated-operation-contract.js';
import { runWorkspaceOperationControlled, type OperationDelegationScope } from './operation.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from './posix-supervisor.js';
import type { WorkspaceSession } from './session.js';
import type { SupervisorTerminationReason } from './supervisor-protocol.js';
import {
  mapManagedTimeoutsToPosix,
  mapManagedTimeoutsToWindows,
  type ManagedSupervisorTimeouts,
} from './supervisor-timeouts.js';
import { WorkspaceSafetyError } from './types.js';
import {
  ManagedOutputController,
  type ManagedOutputFailure,
  type ManagedOutputSnapshot,
} from './managed-output.js';
import {
  readDarkWindowsHelperBundle,
  runDarkWindowsSupervisedOperation,
} from './windows-supervisor.js';

export type { ManagedSupervisorTimeouts } from './supervisor-timeouts.js';

type ManagedWorkspaceProcessBaseOptions = OperationDelegationScope & {
  readonly executable: string;
  /**
   * POSIX 目标进程看到的绝对 argv[0]。真实执行文件仍由 executable 的 canonical path 固定；
   * 该字段只保留 Python venv 等依赖链接入口路径的运行时语义。
   */
  readonly executableArgv0?: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly environment: readonly { readonly name: string; readonly value: string }[];
  readonly timeoutMs: number;
  /**
   * Opaque runners may create command processes outside the POSIX launcher group. Windows Job
   * Objects still contain them, but POSIX external termination cannot use the outer group as a
   * complete settlement proof.
   */
  readonly posixProcessDomain?: 'process-group' | 'opaque-runner';
  readonly termination?: {
    readonly signal: AbortSignal;
    readonly reason: Exclude<SupervisorTerminationReason, 'timeout' | 'output-failure'>;
  };
  readonly supervisorTimeouts?: ManagedSupervisorTimeouts;
};

export type ManagedWorkspaceProcessOptions = ManagedWorkspaceProcessBaseOptions & {
  readonly output?: {
    readonly mode: 'stream';
    readonly stdout: Writable;
    readonly stderr: Writable;
  };
};

interface ManagedWorkspaceProcessBaseResult {
  readonly verdict: 'completed' | 'root-failed' | 'process-tree-not-empty' | 'terminated';
  readonly exitCode: number | null;
  readonly signal: NodeJS.Signals | null;
  readonly timedOut: boolean;
  readonly processTreeNotEmpty: boolean;
  readonly terminationReason: SupervisorTerminationReason | null;
  readonly durationMs: number;
  readonly candidate?: DelegatedSemanticCandidate;
}

export interface ManagedWorkspaceProcessResult extends ManagedWorkspaceProcessBaseResult {
  readonly stdout: Buffer;
  readonly stderr: Buffer;
  /** Present only when options.output.mode is stream; stdout/stderr are then empty compatibility buffers. */
  readonly outputBytes?: number;
  readonly outputTail?: string;
  readonly outputFailure?: ManagedOutputFailure | null;
}

/** 固定 supervisor 只接收操作系统解析后的真实目标，拒绝短路径和符号链接别名漂移。 */
export function canonicalManagedProcessPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new WorkspaceSafetyError('invalid', `受管子进程路径不可用：${detail}`);
  }
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
  const executable = canonicalManagedProcessPath(options.executable);
  let executableArgv0: string | undefined;
  if (options.executableArgv0 !== undefined) {
    if (!isAbsolute(options.executableArgv0)) {
      throw new WorkspaceSafetyError('invalid', '受管子进程 argv[0] 必须是绝对路径');
    }
    executableArgv0 = resolve(options.executableArgv0);
    if (canonicalManagedProcessPath(executableArgv0) !== executable) {
      throw new WorkspaceSafetyError('invalid', '受管子进程 argv[0] 与真实执行文件不一致');
    }
  }
  const target = {
    executable,
    args: options.args,
    cwd: canonicalManagedProcessPath(options.cwd),
    environment: options.environment,
  };
  const helperBytes =
    platform === 'windows-job-v1' ? readDarkWindowsHelperBundle() : readDarkPosixHelperBundle();
  const outputFailureController = options.output?.mode === 'stream' ? new AbortController() : null;
  const outputController =
    options.output?.mode === 'stream'
      ? new ManagedOutputController({
          stdout: options.output.stdout,
          stderr: options.output.stderr,
          onFailure: () => outputFailureController!.abort(),
        })
      : null;
  const startedAt = Date.now();
  const outcome = await (async () => {
    let operationCompleted = false;
    try {
      const result = await runWorkspaceOperationControlled(
        session,
        {
          ...options,
          platform,
          helperBytes,
        },
        async (operation) => {
          if (platform === 'windows-job-v1') {
            return await runDarkWindowsSupervisedOperation(operation, {
              target,
              commandTimeoutMs: options.timeoutMs,
              termination: options.termination,
              timeouts: mapManagedTimeoutsToWindows(options.supervisorTimeouts),
              ...(outputController
                ? {
                    onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) =>
                      outputController.write(stream, chunk),
                    onOutputDiscard: () => outputController.discard(),
                    outputFailureSignal: outputFailureController!.signal,
                  }
                : {}),
            });
          }
          return await runDarkPosixSupervisedOperation(operation, {
            target: { ...target, executableArgv0: executableArgv0 ?? executable },
            posixProcessDomain: options.posixProcessDomain,
            commandTimeoutMs: options.timeoutMs,
            termination: options.termination,
            timeouts: mapManagedTimeoutsToPosix(options.supervisorTimeouts),
            ...(outputController
              ? {
                  onOutput: (stream: 'stdout' | 'stderr', chunk: Buffer) =>
                    outputController.write(stream, chunk),
                  onOutputDiscard: () => outputController.discard(),
                  outputFailureSignal: outputFailureController!.signal,
                }
              : {}),
          });
        },
      );
      operationCompleted = true;
      return result;
    } finally {
      if (!operationCompleted && outputController) {
        outputController.discard();
        await outputController.finish().catch(() => undefined);
      }
    }
  })();

  const baseResult: ManagedWorkspaceProcessBaseResult = {
    verdict: outcome.verdict,
    exitCode: outcome.code,
    signal: outcome.signal,
    timedOut: outcome.terminationReason === 'timeout',
    processTreeNotEmpty: outcome.leftover,
    terminationReason: outcome.terminationReason,
    durationMs: Math.max(0, Date.now() - startedAt),
    ...(outcome.candidate ? { candidate: outcome.candidate } : {}),
  };
  if (!outputController) {
    return { ...baseResult, stdout: outcome.stdout, stderr: outcome.stderr };
  }

  let outputSnapshot: ManagedOutputSnapshot;
  try {
    outputSnapshot = await outputController.finish();
  } catch {
    outputSnapshot = outputController.snapshot;
  }
  const outputFailure =
    outputSnapshot.failure ??
    (outcome.terminationReason === 'output-failure'
      ? ({
          code: 'supervisor-output-failure',
          diagnostic: '受管输出超过固定上限或平台输出通道失败',
        } as const)
      : null);
  return {
    ...baseResult,
    stdout: Buffer.alloc(0),
    stderr: Buffer.alloc(0),
    outputBytes: outputSnapshot.totalBytes,
    outputTail: outputSnapshot.diagnosticTail,
    outputFailure,
  };
}
