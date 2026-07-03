import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLoop } from './engine/loop.js';
import { repairWorkspaceFiles } from './engine/repair.js';
import { runDoctor, renderDoctorReport } from './doctor/doctor.js';
import type { AgentKind } from './engine/agent.js';
import * as dashboard from './dashboard/server.js';

export interface CliConfig {
  command: 'run' | 'repair' | 'dashboard' | 'doctor';
  kind: AgentKind;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  workspace: string;
  openBrowser: boolean;
  keepOpen: boolean;
  port: number;
  staleDays: number;
}

export function parseCliArgs(argv: string[]): CliConfig {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'max-iter': { type: 'string' },
      'dev-timeout': { type: 'string' },
      'val-timeout': { type: 'string' },
      workspace: { type: 'string' },
      'no-open': { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      port: { type: 'string' },
      'stale-days': { type: 'string' },
    },
  });

  const first = positionals[0];
  const command: CliConfig['command'] =
    first === 'repair' ? 'repair'
    : first === 'dashboard' ? 'dashboard'
    : first === 'doctor' ? 'doctor'
    : 'run';
  const kind: AgentKind = first === 'codex' ? 'codex' : 'claude';
  const min = (s: string | undefined, d: number) => (s ? Number(s) : d) * 60 * 1000;

  return {
    command,
    kind,
    maxIterations: values['max-iter'] ? Number(values['max-iter']) : 50,
    devTimeoutMs: min(values['dev-timeout'], 30),
    valTimeoutMs: min(values['val-timeout'], 60),
    workspace: values.workspace ?? '.workspace',
    openBrowser: !values['no-open'],
    keepOpen: values['keep-open'] ?? false,
    port: values.port ? Number(values.port) : 7331,
    staleDays: values['stale-days'] !== undefined ? Number(values['stale-days']) : 30,
  };
}

export function permissionWarning(kind: AgentKind): string {
  const flag = kind === 'codex'
    ? '--dangerously-bypass-approvals-and-sandbox'
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

/**
 * 独立仪表盘：不跑循环，只对着 workspace 起面板离线查看 prd.json / state.json / progress.md，
 * 直到 interrupt（默认 Ctrl+C）。iteration/phase 等内存态保持初始值（未在运行）。
 */
export async function runDashboard(
  opts: { workspace: string; port: number; openBrowser: boolean },
  interrupt?: Promise<void>,
): Promise<number> {
  const server = dashboard.start({
    workspace: opts.workspace,
    maxIterations: 0,
    port: opts.port,
    openBrowser: opts.openBrowser,
  });
  console.log('📊 离线查看模式（未在运行循环），按 Ctrl+C 退出。');
  try {
    await (interrupt ?? new Promise<void>((r) => process.once('SIGINT', () => r())));
    return 0;
  } finally {
    server.close();
  }
}

export async function main(argv: string[]): Promise<number> {
  const cfg = parseCliArgs(argv);

  if (cfg.command === 'repair') {
    const repaired = repairWorkspaceFiles(cfg.workspace);
    console.log(`✅ 已修复: ${repaired.join('、')}`);
    return 0;
  }

  if (cfg.command === 'doctor') {
    const { text, exitCode } = renderDoctorReport(runDoctor(process.cwd(), { staleDays: cfg.staleDays }));
    console.log(text);
    return exitCode;
  }

  if (cfg.command === 'dashboard') {
    return runDashboard({ workspace: cfg.workspace, port: cfg.port, openBrowser: cfg.openBrowser });
  }

  console.warn(permissionWarning(cfg.kind));

  const instructionsDir = join(dirname(fileURLToPath(import.meta.url)), 'instructions');
  return runLoop({
    kind: cfg.kind,
    maxIterations: cfg.maxIterations,
    devTimeoutMs: cfg.devTimeoutMs,
    valTimeoutMs: cfg.valTimeoutMs,
    workspace: cfg.workspace,
    instructionsDir,
    port: cfg.port,
    openBrowser: cfg.openBrowser,
    keepOpen: cfg.keepOpen,
  });
}

// Entry: run when executed directly (not when imported by tests).
// Compares URLs (not paths) so symlinked bin shims (npm/npx/pnpm create
// `node_modules/.bin/coding-x` as a symlink to the real module) still match:
// `process.argv[1]` may be the shim path, which `pathToFileURL` resolves to
// the same URL as `import.meta.url`. Under vitest, argv[1] is the runner, so
// the guard never fires and the suite does not hang.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
