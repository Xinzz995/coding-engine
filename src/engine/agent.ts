import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { delimiter, join } from 'node:path';
import { forceKillProcessTreeOnExit, terminateProcessTree } from './process-tree.js';
import { EVIDENCE_DIAGNOSTIC_CHARS } from './evidence.js';

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

function executableOnPath(name: string): boolean {
  const path = process.env.PATH ?? '';
  const extensions = process.platform === 'win32'
    ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';')
    : [''];
  for (const dir of path.split(delimiter).filter(Boolean)) {
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

export function resolveBinary(kind: AgentKind): string {
  if (kind === 'codex') return process.env.CODING_X_CODEX_BIN ?? 'codex';
  if (kind === 'cursor') {
    if (process.env.CODING_X_CURSOR_BIN) return process.env.CODING_X_CURSOR_BIN;
    // Cursor's install docs currently use `agent`; older installs expose
    // `cursor-agent`. Prefer the unambiguous legacy name when both exist.
    return executableOnPath('cursor-agent') ? 'cursor-agent' : 'agent';
  }
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
  /** 从 spawn 前到 runner stdio 关闭的墙钟耗时；超时路径含整棵进程树终止等待。 */
  durationMs: number;
  /** stdout/stderr 实时 tee 后保留的有界合并尾部；是否持久化由 loop 按结局决定。 */
  outputTail: string;
}

export function runAgent(opts: {
  kind: AgentKind;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** 透传给 agent CLI 的 --model；undefined = 不传（用户 CLI 默认模型） */
  model?: string;
  /** coding-x 运行上下文等显式子进程环境；其余环境原样继承。 */
  env?: NodeJS.ProcessEnv;
}): Promise<RunResult> {
  // buildAgentArgs()[0] may itself be "node /path mode" when overridden by an
  // env var in tests; split it so the stub receives its trailing args.
  const argv = buildAgentArgs(opts.kind, opts.prompt, opts.model);
  const head = argv[0].split(' ');
  const cmd = head[0];
  const args = [...head.slice(1), ...argv.slice(1)];

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd: opts.cwd, stdio: ['inherit', 'pipe', 'pipe'], detached: process.platform !== 'win32',
      env: { ...process.env, ...opts.env },
    });
    let outputTail = '';
    const keep = (chunk: Buffer | string) => {
      outputTail = (outputTail + String(chunk)).slice(-EVIDENCE_DIAGNOSTIC_CHARS);
    };
    // headless runner 的 stdout/stderr 继续实时可见，同时只滚动保留最近的有界尾部。
    // 与 gate 的 tee 语义一致；不等待整段输出、不把成功 transcript 持久化。
    child.stdout?.on('data', (chunk: Buffer) => { process.stdout.write(chunk); keep(chunk); });
    child.stderr?.on('data', (chunk: Buffer) => { process.stderr.write(chunk); keep(chunk); });
    let settled = false;
    let terminating = false;
    const killOnParentExit = () => forceKillProcessTreeOnExit(child);
    process.once('exit', killOnParentExit);

    const finish = (timedOut: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', killOnParentExit);
      resolve({
        timedOut,
        exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        outputTail,
      });
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 终止失败时保持 exit hook；趁根 pid 尚在同步补杀整树，避免 Windows 先杀根后遗失孙进程。
      forceKillProcessTreeOnExit(child);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => {
      if (settled || terminating) return;
      terminating = true;
      void terminateProcessTree(child).then(() => {
        finish(true, null);
      }, fail);
    }, opts.timeoutMs);

    // close 晚于 exit，保证 pipe 中最后一段 stdout/stderr 已被 tee/采集后再写 evidence。
    child.once('close', (code) => {
      if (terminating) return;
      finish(false, code);
    });

    child.once('error', (err) => {
      if (terminating) return;
      console.error(`\n❌ Agent 错误: ${err.message}`);
      keep(err.message);
      finish(false, 1);
    });
  });
}
