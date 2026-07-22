import { parseArgs } from 'node:util';
import { join, dirname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLoop } from './engine/loop.js';
import { repairWorkspaceFiles } from './engine/repair.js';
import { acquireLock, LockConflictError } from './engine/lock.js';
import { runDoctor, renderDoctorReport } from './doctor/doctor.js';
import { collectStatus, renderStatusReport, renderStatusJson } from './status/status.js';
import { writeReport } from './report/report.js';
import { permissionWarning as agentPermissionWarning, type AgentKind } from './engine/agent.js';
import { tryReadPrd } from './engine/prd.js';
import { readModelRouting } from './engine/models.js';
import {
  initializeGlobalModelConfig,
  listConfiguredModels,
  readGlobalModelConfig,
  renderModelCatalogJson,
  renderModelCatalogText,
  resolveGlobalConfigPath,
} from './engine/model-catalog.js';
import * as dashboard from './dashboard/server.js';

export interface CliConfig {
  command: 'run' | 'repair' | 'dashboard' | 'doctor' | 'status' | 'report' | 'models' | 'config';
  configAction: 'path' | 'init' | 'validate' | null;
  kind: AgentKind;
  /** 用户是否通过位置参数显式选择 runner；models.runner 自动选择依赖此信息。 */
  kindExplicit: boolean;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  builderModel: string | undefined;
  validatorModel: string | undefined;
  escalationModel: string | undefined;
  workspace: string;
  openBrowser: boolean;
  keepOpen: boolean;
  port: number;
  staleDays: number;
  json: boolean;
  stallLimit: number;
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
      'escalation-model': { type: 'string' },
      workspace: { type: 'string' },
      'no-open': { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      port: { type: 'string' },
      'stale-days': { type: 'string' },
      json: { type: 'boolean' },
      'stall-limit': { type: 'string' },
    },
  });

  const first = positionals[0];
  const command: CliConfig['command'] =
    first === 'repair' ? 'repair'
    : first === 'dashboard' ? 'dashboard'
    : first === 'doctor' ? 'doctor'
    : first === 'status' ? 'status'
    : first === 'report' ? 'report'
    : first === 'models' ? 'models'
    : first === 'config' ? 'config'
    : 'run';
  let configAction: CliConfig['configAction'] = null;
  if (command === 'config') {
    const rawAction = positionals[1];
    if (rawAction !== 'path' && rawAction !== 'init' && rawAction !== 'validate') {
      throw new Error('❌ config 子命令必须是 path、init 或 validate');
    }
    configAction = rawAction;
  }
  if (command === 'config' && positionals.length > 2) {
    throw new Error(`❌ config ${configAction} 不接受额外位置参数`);
  }
  const runnerPositional = command === 'models' ? positionals[1] : first;
  if (command === 'models' && runnerPositional !== undefined
    && runnerPositional !== 'claude' && runnerPositional !== 'codex' && runnerPositional !== 'cursor') {
    throw new Error(`❌ models runner 必须是 claude、codex 或 cursor，收到「${runnerPositional}」`);
  }
  if (command === 'models' && positionals.length > 2) {
    throw new Error('❌ models 不接受 runner 以外的额外位置参数');
  }
  const kind: AgentKind = runnerPositional === 'codex' ? 'codex' : runnerPositional === 'cursor' ? 'cursor' : 'claude';
  const kindExplicit = runnerPositional === 'claude' || runnerPositional === 'codex' || runnerPositional === 'cursor';
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

  let stallLimit = 3;
  if (values['stall-limit'] !== undefined) {
    const raw = values['stall-limit'];
    if (command === 'run' && !/^[1-9]\d*$/.test(raw)) {
      throw new Error(`❌ --stall-limit 必须是正整数，收到「${raw}」`);
    }
    stallLimit = Number(raw);
  }

  return {
    command,
    configAction,
    kind,
    kindExplicit,
    maxIterations: values['max-iter'] ? Number(values['max-iter']) : 50,
    devTimeoutMs: min(values['dev-timeout'], 30),
    valTimeoutMs: min(values['val-timeout'], 60),
    builderModel: values['builder-model'],
    validatorModel: values['validator-model'],
    escalationModel: values['escalation-model'],
    workspace: values.workspace ?? '.workspace',
    openBrowser: !values['no-open'],
    keepOpen: values['keep-open'] ?? false,
    port: values.port ? Number(values.port) : 7331,
    staleDays,
    json: values.json ?? false,
    stallLimit,
  };
}

export function permissionWarning(kind: AgentKind): string {
  return agentPermissionWarning(kind);
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
      console.error('⚠️  state.json 已损坏，所有 story 已按未验证状态保守显示。建议运行 npx coding-x repair。');
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
      if (result.stateCorrupted) {
        console.error('❌ state.json 已损坏：已生成保守诊断报告，所有 story 按未验证处理。请运行 npx coding-x repair 后重新生成。');
        return 1;
      }
      return 0;
    } catch (err) {
      console.error(`❌ 验证报告生成失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }

  if (cfg.command === 'config') {
    const path = resolveGlobalConfigPath();
    if (cfg.configAction === 'path') {
      console.log(path);
      return 0;
    }
    if (cfg.configAction === 'init') {
      const result = initializeGlobalModelConfig(path);
      if (result.status === 'created') {
        console.log(`✅ 已创建全局模型配置：${result.path}`);
        return 0;
      }
      if (result.status === 'exists') {
        console.error(`❌ 全局模型配置已存在，不会覆盖：${result.path}`);
        return 1;
      }
      console.error(`❌ ${result.error}`);
      return 1;
    }
    const result = readGlobalModelConfig(path);
    if (result.status === 'error') {
      console.error(`❌ 全局模型配置无效：${result.errors.join('；')}`);
      return 1;
    }
    const counts = (['claude', 'codex', 'cursor'] as const)
      .map((runner) => `${runner}=${result.config.models[runner]?.length ?? 0}`)
      .join(' · ');
    console.log(`✅ 全局模型配置有效：${result.path}\n   ${counts}`);
    return 0;
  }

  if (cfg.command === 'models') {
    const configPath = resolveGlobalConfigPath();
    let runner = cfg.kind;
    if (!cfg.kindExplicit) {
      const prdPath = join(cfg.workspace, 'prd.json');
      const prd = tryReadPrd(prdPath);
      const invalidRoot = prd !== null && (typeof prd !== 'object' || Array.isArray(prd));
      if ((prd === null || invalidRoot) && existsSync(prdPath)) {
        const message = `❌ 无法从现有 prd.json 推断 runner：${prdPath} 无法解析`;
        if (cfg.json) console.log(JSON.stringify({ status: 'error', runner, configPath, error: message }, null, 2));
        else console.error(message);
        return 1;
      }
      const routing = readModelRouting(prd);
      if (routing.status === 'invalid') {
        const message = `❌ 无法从现有 prd.json 推断 runner：${routing.errors.join('；')}`;
        if (cfg.json) console.log(JSON.stringify({ status: 'error', runner, configPath, error: message }, null, 2));
        else console.error(message);
        return 1;
      }
      if (routing.status === 'enabled') runner = routing.config.runner;
    }
    const result = listConfiguredModels(runner, configPath);
    if (cfg.json) console.log(renderModelCatalogJson(result));
    else if (result.status === 'error') console.error(renderModelCatalogText(result));
    else console.log(renderModelCatalogText(result));
    return result.status === 'error' ? 1 : 0;
  }

  if (cfg.command === 'dashboard') {
    return runDashboard({ workspace: cfg.workspace, port: cfg.port, openBrowser: cfg.openBrowser });
  }

  const instructionsDir = join(dirname(fileURLToPath(import.meta.url)), 'instructions');
  return runLoop({
    kind: cfg.kind,
    kindExplicit: cfg.kindExplicit,
    maxIterations: cfg.maxIterations,
    devTimeoutMs: cfg.devTimeoutMs,
    valTimeoutMs: cfg.valTimeoutMs,
    builderModel: cfg.builderModel,
    validatorModel: cfg.validatorModel,
    escalationModel: cfg.escalationModel,
    workspace: cfg.workspace,
    instructionsDir,
    port: cfg.port,
    openBrowser: cfg.openBrowser,
    keepOpen: cfg.keepOpen,
    stallLimit: cfg.stallLimit,
  });
}

// Entry: run when executed directly (not when imported by tests).
// argv[1] must go through realpathSync before comparing: npm/npx bin shims are
// symlinks (`node_modules/.bin/coding-x` → dist/cli.js) and macOS `/tmp` is an
// alias of `/private/tmp`, while the ESM loader resolves `import.meta.url` to
// the realpath — a plain pathToFileURL(argv[1]) comparison never matches in
// those cases and the CLI silently exits 0 (the long-standing "npx coding-x
// 静默不执行" trap, root-caused 2026-07-20). Under vitest, argv[1] is the
// runner, so the guard never fires and the suite does not hang.
export function isDirectInvocation(argv1: string | undefined, moduleUrl: string): boolean {
  if (!argv1) return false;
  try {
    return moduleUrl === pathToFileURL(realpathSync(argv1)).href;
  } catch {
    return false; // argv[1] 不存在/不可解析：按非直接执行处理
  }
}

if (isDirectInvocation(process.argv[1], import.meta.url)) {
  main(process.argv.slice(2)).then((code) => process.exit(code));
}
