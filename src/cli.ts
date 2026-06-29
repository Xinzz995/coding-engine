import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runLoop } from './engine/loop.js';
import { repairPrdFile } from './engine/repair.js';
import type { AgentKind } from './engine/agent.js';

export interface CliConfig {
  command: 'run' | 'repair';
  kind: AgentKind;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  workspace: string;
  openBrowser: boolean;
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
    },
  });

  const first = positionals[0];
  const command: 'run' | 'repair' = first === 'repair' ? 'repair' : 'run';
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

export async function main(argv: string[]): Promise<number> {
  const cfg = parseCliArgs(argv);

  if (cfg.command === 'repair') {
    repairPrdFile(join(cfg.workspace, 'prd.json'));
    console.log('✅ prd.json 已修复');
    return 0;
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
    openBrowser: cfg.openBrowser,
  });
}

// Entry: run when executed directly (not when imported by tests).
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
