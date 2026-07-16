import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLoop } from './engine/loop.js';
import { repairWorkspaceFiles } from './engine/repair.js';
import { acquireLock, LockConflictError } from './engine/lock.js';
import { runDoctor, renderDoctorReport } from './doctor/doctor.js';
import { collectStatus, renderStatusReport, renderStatusJson } from './status/status.js';
import { writeReport } from './report/report.js';
import type { AgentKind } from './engine/agent.js';
import * as dashboard from './dashboard/server.js';

export interface CliConfig {
  command: 'run' | 'repair' | 'dashboard' | 'doctor' | 'status' | 'report';
  kind: AgentKind;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  builderModel: string | undefined;
  validatorModel: string | undefined;
  workspace: string;
  openBrowser: boolean;
  keepOpen: boolean;
  port: number;
  staleDays: number;
  json: boolean;
}

export function parseCliArgs(argv: string[]): CliConfig {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      'max-iter': { type: 'string' },
      'dev-timeout': { type: 'string' },
      'val-timeout': { type: 'string' },
      'builder-model': { type: 'string' },
      'validator-model': { type: 'string' },
      workspace: { type: 'string' },
      'no-open': { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      port: { type: 'string' },
      'stale-days': { type: 'string' },
      json: { type: 'boolean' },
    },
  });

  const first = positionals[0];
  const command: CliConfig['command'] =
    first === 'repair' ? 'repair'
    : first === 'dashboard' ? 'dashboard'
    : first === 'doctor' ? 'doctor'
    : first === 'status' ? 'status'
    : first === 'report' ? 'report'
    : 'run';
  const kind: AgentKind = first === 'codex' ? 'codex' : 'claude';
  const min = (s: string | undefined, d: number) => (s ? Number(s) : d) * 60 * 1000;

  let staleDays = 30;
  if (values['stale-days'] !== undefined) {
    const raw = values['stale-days'];
    // 字面量校验：只接受纯十进制数字串，排除 Number() 会静默接受的 ''/0x10/1e2 等写法
    if (command === 'doctor' && !/^\d+$/.test(raw)) {
      throw new Error(`❌ --stale-days 必须是非负整数，收到「${raw}」`);
    }
    staleDays = Number(raw);
  }

  return {
    command,
    kind,
    maxIterations: values['max-iter'] ? Number(values['max-iter']) : 50,
    devTimeoutMs: min(values['dev-timeout'], 30),
    valTimeoutMs: min(values['val-timeout'], 60),
    builderModel: values['builder-model'],
    validatorModel: values['validator-model'],
    workspace: values.workspace ?? '.workspace',
    openBrowser: !values['no-open'],
    keepOpen: values['keep-open'] ?? false,
    port: values.port ? Number(values.port) : 7331,
    staleDays,
    json: values.json ?? false,
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
  let cfg: CliConfig;
  try {
    cfg = parseCliArgs(argv);
  } catch (err) {
    console.error(err instanceof Error ? err.message : String(err));
    return 1;
  }

  if (cfg.command === 'repair') {
    // repair 重写 prd.json/state.json，与运行中的引擎互踩——与 run 同锁互斥（ADR-008）
    let lock;
    try {
      lock = acquireLock(cfg.workspace, 'repair');
    } catch (err) {
      if (err instanceof LockConflictError) {
        console.error(err.message);
        return 2;
      }
      throw err;
    }
    try {
      const repaired = repairWorkspaceFiles(cfg.workspace);
      console.log(`✅ 已修复: ${repaired.join('、')}`);
      return 0;
    } finally {
      lock.release();
    }
  }

  if (cfg.command === 'doctor') {
    const { text, exitCode } = renderDoctorReport(runDoctor(process.cwd(), { staleDays: cfg.staleDays, workspace: cfg.workspace }));
    console.log(text);
    return exitCode;
  }

  if (cfg.command === 'status') {
    const report = collectStatus(cfg.workspace);
    // 警告走 stderr：--json 模式下不污染 stdout，人类可读模式同样适用
    if (report.status === 'ok' && report.stateCorrupted) {
      console.error('⚠️  state.json 已损坏，已按 prd.json 内嵌旧格式状态回退显示。建议运行 npx coding-x repair。');
    }
    const { text, exitCode } = cfg.json ? renderStatusJson(report) : renderStatusReport(report);
    console.log(text);
    return exitCode;
  }

  if (cfg.command === 'report') {
    try {
      const result = writeReport(cfg.workspace, new Date());
      if (result.status === 'missing') {
        console.error(`❌ 未找到工作区：${join(cfg.workspace, 'prd.json')} 不存在。建议先用 prd-to-json 从源 PRD 生成工作区。`);
        return 2;
      }
      if (result.status === 'unparsable') {
        console.error(`❌ 无法解析 ${join(cfg.workspace, 'prd.json')}。建议运行 npx coding-x repair 修复后重试。`);
        return 2;
      }
      console.log(`📄 验证报告: ${result.path}`);
      return 0;
    } catch (err) {
      console.error(`❌ 验证报告生成失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
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
    builderModel: cfg.builderModel,
    validatorModel: cfg.validatorModel,
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
