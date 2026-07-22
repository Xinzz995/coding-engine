import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const TERMINATION_GRACE_MS = 5000;
const TERMINATION_CONFIRM_MS = 5000;
const PROCESS_GROUP_POLL_MS = 25;

/** POSIX agent 独占进程组是否仍有成员；非 ESRCH 错误按“仍存活”保守处理。 */
function isProcessGroupAlive(pid: number): boolean {
  try {
    process.kill(-pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== 'ESRCH';
  }
}

function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  try {
    process.kill(-pid, signal);
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== 'ESRCH') throw err;
  }
}

function waitForProcessGroupExit(pid: number, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve) => {
    const probe = () => {
      if (!isProcessGroupAlive(pid)) return resolve(true);
      if (Date.now() >= deadline) return resolve(false);
      setTimeout(probe, PROCESS_GROUP_POLL_MS);
    };
    probe();
  });
}

/** Windows 没有 POSIX 负 pid 进程组信号；taskkill /T /F 是明确的整树强杀语义。 */
function taskkill(pid: number): Promise<void> {
  return new Promise((resolve, reject) => {
    const killer = spawn('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true,
    });
    let settled = false;
    const finish = (err?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err); else resolve();
    };
    const timer = setTimeout(() => {
      killer.kill('SIGKILL');
      finish(new Error('taskkill 执行超时'));
    }, TERMINATION_CONFIRM_MS);
    killer.once('error', (err) => finish(new Error(`taskkill 启动失败：${err.message}`)));
    killer.once('exit', (code) => {
      if (code === 0) finish();
      else finish(new Error(`taskkill 退出码 ${code}`));
    });
  });
}

/**
 * 超时合同：只有 agent 整棵进程树停止后才允许引擎继续读写 workspace。
 * POSIX 先给独占进程组优雅退出窗口，再整组 SIGKILL；Windows 等待 taskkill /T /F。
 */
async function terminateProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    child.kill('SIGKILL');
    return;
  }
  if (process.platform === 'win32') {
    await taskkill(pid);
    return;
  }

  signalProcessGroup(pid, 'SIGTERM');
  if (await waitForProcessGroupExit(pid, TERMINATION_GRACE_MS)) return;
  signalProcessGroup(pid, 'SIGKILL');
  if (!await waitForProcessGroupExit(pid, TERMINATION_CONFIRM_MS)) {
    // 不允许引擎在无法确认单写者的情况下继续回写 workspace；交给 loop 的 finally 收口资源。
    throw new Error(`Agent 进程组 ${pid} 在 SIGKILL 后仍未确认退出`);
  }
}

/** detached agent 不再天然接收终端 Ctrl+C；父进程退出时同步兜底清理。 */
function forceKillProcessTreeOnExit(child: ChildProcess): void {
  const pid = child.pid;
  if (pid === undefined) return;
  if (process.platform === 'win32') {
    const result = spawnSync('taskkill.exe', ['/PID', String(pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: TERMINATION_CONFIRM_MS,
    });
    if (result.status !== 0) child.kill('SIGKILL');
    return;
  }
  try { process.kill(-pid, 'SIGKILL'); } catch { /* 已退出 */ }
}

export type AgentKind = 'claude' | 'codex' | 'cursor';

export function permissionWarning(kind: AgentKind): string {
  const flag = kind === 'codex' ? '--dangerously-bypass-approvals-and-sandbox'
    : kind === 'cursor' ? '--force'
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

export function resolveBinary(kind: AgentKind): string {
  if (kind === 'codex') return process.env.CODING_X_CODEX_BIN ?? 'codex';
  if (kind === 'cursor') return process.env.CODING_X_CURSOR_BIN ?? 'cursor-agent';
  return process.env.CODING_X_CLAUDE_BIN ?? 'claude';
}

export function buildAgentArgs(kind: AgentKind, prompt: string, model?: string): string[] {
  const bin = resolveBinary(kind);
  const modelArgs = model ? ['--model', model] : [];
  if (kind === 'codex') {
    return [bin, 'exec', '--dangerously-bypass-approvals-and-sandbox', ...modelArgs, prompt];
  }
  if (kind === 'cursor') return [bin, '-p', '--force', ...modelArgs, prompt];
  return [bin, '--print', '--dangerously-skip-permissions', ...modelArgs, prompt];
}

export interface RunResult {
  timedOut: boolean;
  exitCode: number | null;
}

export function runAgent(opts: {
  kind: AgentKind;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** 透传给 agent CLI 的 --model；undefined = 不传（用户 CLI 默认模型） */
  model?: string;
}): Promise<RunResult> {
  // buildAgentArgs()[0] may itself be "node /path mode" when overridden by an
  // env var in tests; split it so the stub receives its trailing args.
  const argv = buildAgentArgs(opts.kind, opts.prompt, opts.model);
  const head = argv[0].split(' ');
  const cmd = head[0];
  const args = [...head.slice(1), ...argv.slice(1)];

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd: opts.cwd, stdio: 'inherit', detached: process.platform !== 'win32',
    });
    let settled = false;
    let terminating = false;
    const killOnParentExit = () => forceKillProcessTreeOnExit(child);
    process.once('exit', killOnParentExit);

    const finish = (result: RunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', killOnParentExit);
      resolve(result);
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 终止失败时保持 exit hook；趁根 pid 尚在同步补杀整树，避免 Windows 先杀根后遗失孙进程。
      forceKillProcessTreeOnExit(child);
      reject(err);
    };

    const timer = setTimeout(() => {
      if (settled || terminating) return;
      terminating = true;
      void terminateProcessTree(child).then(() => {
        finish({ timedOut: true, exitCode: null });
      }, fail);
    }, opts.timeoutMs);

    child.once('exit', (code) => {
      if (terminating) return;
      finish({ timedOut: false, exitCode: code });
    });

    child.once('error', (err) => {
      if (terminating) return;
      console.error(`\n❌ Agent 错误: ${err.message}`);
      finish({ timedOut: false, exitCode: 1 });
    });
  });
}
