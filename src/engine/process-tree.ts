import { spawn, spawnSync, type ChildProcess } from 'node:child_process';

const TERMINATION_GRACE_MS = 5000;
const TERMINATION_CONFIRM_MS = 5000;
const PROCESS_GROUP_POLL_MS = 25;

/** POSIX 独占进程组是否仍有成员；非 ESRCH 错误按“仍存活”保守处理。 */
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
 * 超时合同：只有整棵进程树停止后调用方才可继续读写 workspace。
 * POSIX 先给独占进程组优雅退出窗口，再整组 SIGKILL；Windows 等待 taskkill /T /F。
 */
export async function terminateProcessTree(child: ChildProcess): Promise<void> {
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
    throw new Error(`进程组 ${pid} 在 SIGKILL 后仍未确认退出`);
  }
}

/** detached 子进程不再天然接收终端 Ctrl+C；父进程退出时同步兜底清理。 */
export function forceKillProcessTreeOnExit(child: ChildProcess): void {
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
