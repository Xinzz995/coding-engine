import { spawn } from 'node:child_process';

export type AgentKind = 'claude' | 'codex';

export function resolveBinary(kind: AgentKind): string {
  if (kind === 'codex') return process.env.CODING_X_CODEX_BIN ?? 'codex';
  return process.env.CODING_X_CLAUDE_BIN ?? 'claude';
}

export function buildAgentArgs(kind: AgentKind, prompt: string): string[] {
  const bin = resolveBinary(kind);
  if (kind === 'codex') {
    return [bin, 'exec', '--dangerously-bypass-approvals-and-sandbox', prompt];
  }
  return [bin, '--print', '--dangerously-skip-permissions', prompt];
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
}): Promise<RunResult> {
  // buildAgentArgs()[0] may itself be "node /path mode" when overridden by an
  // env var in tests; split it so the stub receives its trailing args.
  const argv = buildAgentArgs(opts.kind, opts.prompt);
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
