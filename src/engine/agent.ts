import { accessSync, constants, realpathSync } from 'node:fs';
import { delimiter, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { EVIDENCE_DIAGNOSTIC_CHARS } from './evidence.js';
import { createRunnerInvocation } from '../review/runner-invocation.js';
import {
  describeReviewTemporaryRetention,
  ReviewTemporaryDirectoryError,
  type ReviewTemporaryCleanupResult,
} from '../review/temporary-directory.js';
import { environmentEntries, runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import type { OperationDelegationScope } from '../workspace-safety/operation.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import type { SupervisorTerminationReason } from '../workspace-safety/supervisor-protocol.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';

export type AgentKind = 'claude' | 'codex' | 'cursor';

export function permissionWarning(kind: AgentKind): string {
  const flag =
    kind === 'codex'
      ? '--dangerously-bypass-approvals-and-sandbox'
      : kind === 'cursor'
        ? '--force'
        : '--dangerously-skip-permissions';
  return [
    '',
    '⚠️  coding-x 将以【跳过权限】模式自动运行 AI agent：',
    `   使用 ${kind} ${flag}`,
    '   它会在无人确认的情况下读写文件、执行命令、提交代码。',
    '   请确认当前目录是你信任的项目工作区。',
    '',
  ].join('\n');
}

function executableOnPath(name: string, environment: NodeJS.ProcessEnv): boolean {
  const path = environmentValue(environment, 'PATH', process.platform) ?? '';
  const extensions =
    process.platform === 'win32' && extname(name) === ''
      ? (environmentValue(environment, 'PATHEXT', process.platform) ?? '.COM;.EXE;.BAT;.CMD').split(
          ';',
        )
      : [''];
  const pathDelimiter = process.platform === 'win32' ? ';' : delimiter;
  for (const dir of path.split(pathDelimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        accessSync(join(dir, `${name}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return false;
}

function environmentValue(
  environment: NodeJS.ProcessEnv,
  name: string,
  platform: NodeJS.Platform,
): string | undefined {
  if (platform !== 'win32') return environment[name];

  // Windows treats environment names as case-insensitive. Use the exact same
  // normalization as the environment passed to the supervised child so binary
  // resolution and execution can never observe different PATH values.
  const expected = name.toUpperCase();
  return environmentEntries(environment).find(({ name: key }) => key.toUpperCase() === expected)
    ?.value;
}

export function resolveExecutablePath(
  name: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const candidates: string[] = [];
  if (isAbsolute(name)) {
    candidates.push(name);
  } else if (name.includes('/') || name.includes('\\')) {
    candidates.push(resolve(cwd, name));
  } else {
    const extensions =
      platform === 'win32' && extname(name) === ''
        ? (environmentValue(environment, 'PATHEXT', platform) ?? '.COM;.EXE;.BAT;.CMD').split(';')
        : [''];
    const pathDelimiter = platform === 'win32' ? ';' : delimiter;
    for (const directory of (environmentValue(environment, 'PATH', platform) ?? '')
      .split(pathDelimiter)
      .filter(Boolean)) {
      for (const extension of extensions) candidates.push(join(directory, `${name}${extension}`));
    }
  }
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.X_OK);
      return realpathSync.native(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  throw new Error(`找不到可执行文件：${name}`);
}

/**
 * AI Runner 的提示词和配置不能交给 Windows shell 脚本重新解析。
 * 项目质量检查仍使用通用解析器，并继续支持经过受管执行器约束的 .cmd/.bat。
 */
export function resolveRunnerExecutablePath(
  kind: AgentKind,
  name: string,
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const executable = resolveExecutablePath(name, cwd, environment, platform);
  const extension = extname(executable).toLowerCase();
  if (platform === 'win32' && (extension === '.cmd' || extension === '.bat')) {
    const variable =
      kind === 'codex'
        ? 'CODING_X_CODEX_BIN'
        : kind === 'cursor'
          ? 'CODING_X_CURSOR_BIN'
          : 'CODING_X_CLAUDE_BIN';
    throw new WorkspaceSafetyError(
      'unsupported',
      `Windows 上的 ${kind} AI Runner 不支持 .cmd/.bat 脚本包装器；` +
        `请将 ${variable} 指向该工具的原生可执行文件`,
    );
  }
  return executable;
}

/** @internal 保留历史测试使用的 `node <fixture> [mode]`，真实完整路径始终优先。 */
export function resolveRunnerInvocation(
  kind: AgentKind,
  command: string,
  trailingArgs: readonly string[],
  cwd: string,
  environment: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): { readonly executable: string; readonly args: string[] } {
  try {
    return {
      executable: resolveRunnerExecutablePath(kind, command, cwd, environment, platform),
      args: [...trailingArgs],
    };
  } catch (error) {
    if (error instanceof WorkspaceSafetyError || !command.includes(' ')) throw error;
    const [head, ...leadingArgs] = command.split(' ').filter(Boolean);
    if (!head) throw error;
    return {
      executable: resolveRunnerExecutablePath(kind, head, cwd, environment, platform),
      args: [...leadingArgs, ...trailingArgs],
    };
  }
}

export function resolveBinary(
  kind: AgentKind,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  if (kind === 'codex') return environment.CODING_X_CODEX_BIN ?? 'codex';
  if (kind === 'cursor') {
    if (environment.CODING_X_CURSOR_BIN) return environment.CODING_X_CURSOR_BIN;
    // Cursor's install docs currently use `agent`; older installs expose
    // `cursor-agent`. Prefer the unambiguous legacy name when both exist.
    return executableOnPath('cursor-agent', environment) ? 'cursor-agent' : 'agent';
  }
  return environment.CODING_X_CLAUDE_BIN ?? 'claude';
}

export function buildManagedAgentArgs(
  kind: AgentKind,
  model?: string,
  environment: NodeJS.ProcessEnv = process.env,
): string[] {
  const bin = resolveBinary(kind, environment);
  const modelArgs = model ? ['--model', model] : [];
  if (kind === 'codex') {
    return [bin, 'exec', '--dangerously-bypass-approvals-and-sandbox', ...modelArgs, '-'];
  }
  if (kind === 'cursor') return [bin, '-p', '--force', ...modelArgs];
  return [bin, '--print', '--dangerously-skip-permissions', ...modelArgs];
}

export interface RunResult {
  timedOut: boolean;
  exitCode: number | null;
  /** 从 spawn 前到 runner stdio 关闭的墙钟耗时；超时路径含平台受管进程集合终止等待。 */
  durationMs: number;
  /** 受控进程完成收口后转发 stdout/stderr，并保留有界合并尾部。 */
  outputTail: string;
  /** 根进程成功/失败后仍有后代；本轮结果必须丢弃。 */
  processTreeNotEmpty?: boolean;
  /** timeout 以外的受控终止来源。 */
  terminationReason?: SupervisorTerminationReason | null;
}

export function agentTemporaryRetentionFailure(
  failure: unknown,
  cleanup: Exclude<ReviewTemporaryCleanupResult, { readonly status: 'removed' }>,
): Error {
  const retentionMessage = `Agent Runner 临时域${describeReviewTemporaryRetention(cleanup)}：${cleanup.reason}`;
  if (failure instanceof WorkspaceSafetyError) {
    const preserved = new WorkspaceSafetyError(
      failure.code,
      `${failure.message}；${retentionMessage}`,
    );
    Object.defineProperty(preserved, 'cause', { value: failure, configurable: true });
    return preserved;
  }
  const wrapped = new ReviewTemporaryDirectoryError(
    retentionMessage +
      (failure === undefined
        ? ''
        : `；原始失败：${failure instanceof Error ? failure.message : '非 Error 失败'}`),
  );
  if (failure instanceof Error) {
    Object.defineProperty(wrapped, 'cause', { value: failure, configurable: true });
  }
  return wrapped;
}

function pathWithin(parent: string, candidate: string): boolean {
  const value = relative(realpathSync.native(parent), realpathSync.native(candidate));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

export async function runAgent(opts: {
  kind: AgentKind;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** 透传给 agent CLI 的 --model；undefined = 不传（用户 CLI 默认模型） */
  model?: string;
  /** coding-x 运行上下文等显式子进程环境；其余环境原样继承。 */
  env?: NodeJS.ProcessEnv;
  /** 干净验证传 false，避免被删除的项目级环境从父进程重新出现。 */
  inheritProcessEnvironment?: boolean;
  /** Validator clean checkout rejects a Runner executable resolved from the developer tree. */
  forbiddenExecutableRoot?: string;
  /** 所有 agent/reviewer 子进程都必须绑定当前 workspace owner domain。 */
  managed: {
    readonly session: WorkspaceSession;
    readonly operation: OperationDelegationScope;
    readonly termination?: {
      readonly signal: AbortSignal;
      readonly reason: Exclude<SupervisorTerminationReason, 'timeout'>;
    };
  };
}): Promise<RunResult> {
  const environment = {
    ...(opts.inheritProcessEnvironment === false ? {} : process.env),
    ...opts.env,
  };
  const argv = buildManagedAgentArgs(opts.kind, opts.model, environment);

  let executable: string;
  let args: string[];
  let cwd: string;
  try {
    ({ executable, args } = resolveRunnerInvocation(
      opts.kind,
      argv[0],
      argv.slice(1),
      opts.cwd,
      environment,
    ));
    if (opts.forbiddenExecutableRoot && pathWithin(opts.forbiddenExecutableRoot, executable)) {
      throw new Error('AI Runner executable 解析到开发工作树内，不能用于干净 Validator');
    }
    cwd = realpathSync(opts.cwd);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`\n❌ Agent 错误: ${message}`);
    return {
      timedOut: false,
      exitCode: 1,
      durationMs: 0,
      outputTail: message.slice(-EVIDENCE_DIAGNOSTIC_CHARS),
      processTreeNotEmpty: false,
      terminationReason: null,
    };
  }

  let invocation: ReturnType<typeof createRunnerInvocation>;
  try {
    invocation = createRunnerInvocation({
      runner: opts.kind,
      executable,
      args,
      cwd,
      prompt: opts.prompt,
      projectRoot: opts.cwd,
      prefix: 'coding-x-agent-invocation-',
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failure = new WorkspaceSafetyError(
      error instanceof ReviewTemporaryDirectoryError ? 'isolated' : 'invalid',
      `Agent Runner 受保护调用无法建立：${message}`,
    );
    if (error instanceof Error) {
      Object.defineProperty(failure, 'cause', { value: error, configurable: true });
    }
    throw failure;
  }

  let result: Awaited<ReturnType<typeof runManagedWorkspaceProcess>> | undefined;
  let failure: unknown;
  try {
    invocation.temporary.prepareManagedUse();
    invocation.temporary.beginManagedUse();
    result = await runManagedWorkspaceProcess(opts.managed.session, {
      ...opts.managed.operation,
      executable: resolveExecutablePath(process.execPath, cwd, environment),
      args: [invocation.proxyPath, invocation.configPath],
      cwd,
      environment: environmentEntries(environment),
      timeoutMs: opts.timeoutMs,
      termination: opts.managed.termination,
    });
    if (result.processTreeNotEmpty) {
      throw new WorkspaceSafetyError(
        'isolated',
        'Agent Runner 根进程退出时仍有后代进程；workspace 与临时域都必须保留',
      );
    }
    invocation.temporary.confirmManagedUseSettled();
  } catch (error) {
    failure = error;
  }

  const cleanup = invocation.cleanup();
  if (cleanup.status !== 'removed') {
    throw agentTemporaryRetentionFailure(failure, cleanup);
  }
  if (failure instanceof Error) throw failure;
  if (failure !== undefined) throw new Error('Agent Runner 返回了非 Error 失败');
  if (result === undefined) throw new Error('Agent Runner 未返回受管进程结果');

  process.stdout.write(result.stdout);
  process.stderr.write(result.stderr);
  const outputTail = Buffer.concat([result.stdout, result.stderr])
    .toString('utf8')
    .slice(-EVIDENCE_DIAGNOSTIC_CHARS);
  return {
    timedOut: result.timedOut,
    exitCode: result.processTreeNotEmpty ? 1 : result.exitCode,
    durationMs: result.durationMs,
    outputTail,
    processTreeNotEmpty: result.processTreeNotEmpty,
    terminationReason: result.terminationReason,
  };
}
