import { spawn } from 'node:child_process';

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

  return new Promise((resolve) => {
    const child = spawn(cmd, args, { cwd: opts.cwd, stdio: 'inherit' });
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => clearTimeout(killTimer));
      resolve({ timedOut: true, exitCode: null });
    }, opts.timeoutMs);

    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ timedOut: false, exitCode: code });
    });

    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      console.error(`\n❌ Agent 错误: ${err.message}`);
      resolve({ timedOut: false, exitCode: 1 });
    });
  });
}
