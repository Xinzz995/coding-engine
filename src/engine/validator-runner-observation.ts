import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import type { ManagedWorkspaceProcessOptions } from '../workspace-safety/coordinator.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { readRunnerVersion } from '../review/runner.js';
import { resolveBinary, resolveRunnerExecutablePath, type AgentKind } from './agent.js';

type ManagedTermination = ManagedWorkspaceProcessOptions['termination'];

/** 引擎在构建 Validator Runner profile 前对可执行文件的机械观察。 */
export interface ValidatorRunnerObservation {
  /** 受监督 `--version` 输出的首行原文。 */
  readonly runnerVersion: string;
  /** 实际将被执行的 canonical 绝对路径。 */
  readonly executablePath: string;
  /** 该路径文件字节的 SHA-256（raw hex）。 */
  readonly executableSha256: string;
  readonly platform: NodeJS.Platform;
  readonly architecture: string;
}

export type ValidatorRunnerObservationOutcome =
  | { readonly status: 'observed'; readonly observation: ValidatorRunnerObservation }
  | { readonly status: 'unobservable'; readonly message: string };

function hashFileBytes(path: string): Promise<string> {
  return new Promise((resolvePromise, rejectPromise) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk));
    stream.on('error', rejectPromise);
    stream.on('end', () => resolvePromise(hash.digest('hex')));
  });
}

/**
 * 解析、哈希并受监督探测 Validator Runner 的版本。sealed invocation 只能执行单一
 * 可执行文件；带前置参数的包装命令（如 `node script.mjs`）无法进入固定 argv 模型，
 * 按不可观察返回，与 Windows .cmd 包装器拒绝语义一致。
 */
export async function observeValidatorRunner(options: {
  readonly session: WorkspaceSession;
  readonly runner: AgentKind;
  readonly projectRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly timeoutMs?: number;
  readonly termination?: ManagedTermination;
}): Promise<ValidatorRunnerObservationOutcome> {
  const environment = options.environment ?? process.env;
  const command = resolveBinary(options.runner, environment);
  let executablePath: string;
  try {
    executablePath = resolveRunnerExecutablePath(
      options.runner,
      command,
      options.projectRoot,
      environment,
    );
  } catch (error) {
    return {
      status: 'unobservable',
      message:
        `${options.runner} Runner 可执行文件无法解析为单一原生入口：` +
        `${error instanceof Error ? error.message : String(error)}` +
        (command.includes(' ') ? '；包装命令不能用于隔离 Validator' : ''),
    };
  }
  let executableSha256: string;
  try {
    executableSha256 = await hashFileBytes(executablePath);
  } catch (error) {
    return {
      status: 'unobservable',
      message: `${options.runner} Runner 可执行文件无法读取以计算摘要：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  let runnerVersion: string;
  try {
    runnerVersion = await readRunnerVersion({
      session: options.session,
      runner: options.runner,
      projectRoot: options.projectRoot,
      timeoutMs: options.timeoutMs,
      termination: options.termination,
    });
  } catch (error) {
    return {
      status: 'unobservable',
      message: `${options.runner} Runner 版本无法受监督核对：${error instanceof Error ? error.message : String(error)}`,
    };
  }
  return {
    status: 'observed',
    observation: {
      runnerVersion,
      executablePath,
      executableSha256,
      platform: process.platform,
      architecture: process.arch,
    },
  };
}
