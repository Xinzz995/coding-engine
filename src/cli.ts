import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { join, dirname } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLoop } from './engine/loop.js';
import { repairWorkspaceFiles } from './engine/repair.js';
import { acquireLock, LockConflictError } from './engine/lock.js';
import { runDoctor, renderDoctorJson, renderDoctorReport } from './doctor/doctor.js';
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
import {
  runCursorHookAction,
  type CursorHookAction,
} from './cursor-hooks.js';
import * as dashboard from './dashboard/server.js';
import { CODING_X_VERSION } from './version.js';
import { runQualityInit } from './quality/init.js';

export interface CliConfig {
  command: 'run' | 'init' | 'repair' | 'dashboard' | 'doctor' | 'status' | 'report' | 'models' | 'config' | 'hooks';
  /** 全局帮助请求；先于任何子命令校验与副作用处理。 */
  help: boolean;
  configAction: 'path' | 'init' | 'validate' | null;
  hooksAction: CursorHookAction | null;
  kind: AgentKind;
  /** 用户是否通过位置参数显式选择 runner；models.runner 自动选择依赖此信息。 */
  kindExplicit: boolean;
  maxIterations: number;
  devTimeoutMs: number;
  valTimeoutMs: number;
  builderModel: string | undefined;
  validatorModel: string | undefined;
  reviewModel: string | undefined;
  escalationModel: string | undefined;
  workspace: string;
  openBrowser: boolean;
  keepOpen: boolean;
  port: number;
  staleDays: number;
  json: boolean;
  stallLimit: number;
  /** 候选版本 Dogfood；成功也固定返回 7，不能表示可交付。 */
  shadow: boolean;
  /** init 从用户确认过的文件读取契约；相对路径基于项目根。 */
  contractFile: string | undefined;
  /** init 明确跳过是/否提示；不会替用户填写不适用理由。 */
  yes: boolean;
  /** doctor 只检查本地状态，不查询 GitHub。 */
  local: boolean;
}

export const CLI_HELP = `coding-x — Ralph 自动化编码 harness

用法:
  coding-x [claude|codex|cursor] [选项]
  coding-x <命令> [选项]
  coding-x help | --help | -h

runner:
  claude                         使用 Claude Code（默认）
  codex                          使用 Codex
  cursor                         使用 Cursor Agent

命令:
  init                           初始化质量契约与 GitHub 交付门禁
  repair                         修复 workspace 中的 prd.json/state.json
  dashboard                      启动只读离线仪表盘
  doctor                         检查文档、门禁、模型与 workspace 健康度
  status                         输出实现、最终 Review 与 GitHub 交付状态（退出码 0–7 见下方）
  report                         生成静态验证报告 report.html
  models [claude|codex|cursor]   查询全局模型目录
  config path|init|validate      查看、初始化或校验全局模型配置
  hooks cursor install|status|remove
                                 安装、检查或移除当前项目的 Cursor TDD 提交前检查
  help                           显示本帮助

选项:
  --max-iter <n>                 最大迭代轮数（默认 50）
  --dev-timeout <分钟>           Builder 超时（默认 30）
  --val-timeout <分钟>           Validator 超时（默认 60）
  --builder-model <id>           临时覆盖初始 Builder 模型
  --validator-model <id>         临时覆盖 Validator 模型
  --review-model <id>            临时固定最终三层 Review 模型（缺省复用 Validator）
  --escalation-model <id>        临时覆盖升级 Builder 模型
  --workspace <dir>              workspace 路径（默认 .workspace）
  --no-open                      不自动打开仪表盘
  --keep-open                    循环结束后保留仪表盘
  --port <n>                     仪表盘端口（仅接受 0–65535 的十进制整数；0 由系统选择可用端口；默认 7331）
  --stall-limit <n>              连续无进展轮熔断阈值（默认 3，仅 run）
  --stale-days <n>               active 文档过期阈值（默认 30；doctor 跳过冷档案）
  --json                         JSON 输出（doctor/status/models）
  --shadow                       候选版本 Dogfood；永远不产生可交付结论
  --contract <file>              init 使用已确认的质量契约文件
  --yes                          init 接受已展示的远端和文件变更
  --local                        doctor 只检查本地状态，不查询 GitHub
  -h, --help                     显示本帮助并退出

status 退出码:
  0                              实现验证、本地 Review 与 GitHub 交付条件均已就绪
  1                              Story 未完成、state 损坏或 PRD 没有 Story
  2                              workspace 不可读或最终 Review 状态损坏
  3                              存在 blocked Story
  4                              最终 Review 有待人工处理的 finding
  5                              最终 Review 无法可靠验证
  6                              最终 Review 未完成或已失效，或 GitHub CI / Ruleset 未就绪
  7                              Shadow 已完成，但不能表示可交付

更多说明: https://github.com/Xinzz995/coding-engine#readme`;

export function parseCliArgs(argv: string[]): CliConfig {
  const normalizedArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--port') {
      normalizedArgs.push(arg);
      continue;
    }
    const raw = argv[i + 1];
    if (raw === undefined || raw === '--help' || raw === '-h' || raw === 'help' || raw.startsWith('--')) {
      normalizedArgs.push('--port=');
      continue;
    }
    if (raw.startsWith('-')) {
      normalizedArgs.push(`--port=${raw}`);
      i++;
      continue;
    }
    normalizedArgs.push(arg);
  }

  const { values, positionals } = parseArgs({
    args: normalizedArgs,
    allowPositionals: true,
    options: {
      'max-iter': { type: 'string' },
      'dev-timeout': { type: 'string' },
      'val-timeout': { type: 'string' },
      'builder-model': { type: 'string' },
      'validator-model': { type: 'string' },
      'review-model': { type: 'string' },
      'escalation-model': { type: 'string' },
      workspace: { type: 'string' },
      'no-open': { type: 'boolean' },
      'keep-open': { type: 'boolean' },
      port: { type: 'string' },
      'stale-days': { type: 'string' },
      json: { type: 'boolean' },
      'stall-limit': { type: 'string' },
      shadow: { type: 'boolean' },
      contract: { type: 'string' },
      yes: { type: 'boolean' },
      local: { type: 'boolean' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const first = positionals[0];
  const help = values.help === true || positionals.includes('help');
  const command: CliConfig['command'] =
    first === 'init' ? 'init'
    : first === 'repair' ? 'repair'
    : first === 'dashboard' ? 'dashboard'
    : first === 'doctor' ? 'doctor'
    : first === 'status' ? 'status'
    : first === 'report' ? 'report'
    : first === 'models' ? 'models'
    : first === 'config' ? 'config'
    : first === 'hooks' ? 'hooks'
    : 'run';
  if (!help && command === 'init' && positionals.length > 1) {
    throw new Error('❌ init 不接受额外位置参数');
  }
  if (!help && values.contract !== undefined && command !== 'init') {
    throw new Error('❌ --contract 只能用于 init');
  }
  if (!help && values.yes === true && command !== 'init') {
    throw new Error('❌ --yes 只能用于 init');
  }
  if (!help && values.local === true && command !== 'doctor') {
    throw new Error('❌ --local 只能用于 doctor');
  }
  let configAction: CliConfig['configAction'] = null;
  if (command === 'config') {
    const rawAction = positionals[1];
    if (rawAction === 'path' || rawAction === 'init' || rawAction === 'validate') {
      configAction = rawAction;
    } else if (!help) {
      throw new Error('❌ config 子命令必须是 path、init 或 validate');
    }
  }
  if (!help && command === 'config' && positionals.length > 2) {
    throw new Error(`❌ config ${configAction} 不接受额外位置参数`);
  }
  let hooksAction: CursorHookAction | null = null;
  if (command === 'hooks') {
    const host = positionals[1];
    const rawAction = positionals[2];
    if (host === 'cursor'
        && (rawAction === 'install' || rawAction === 'status' || rawAction === 'remove')) {
      hooksAction = rawAction;
    } else if (!help) {
      throw new Error('❌ hooks 子命令必须是 cursor install、cursor status 或 cursor remove');
    }
  }
  if (!help && command === 'hooks' && positionals.length > 3) {
    throw new Error(`❌ hooks cursor ${hooksAction} 不接受额外位置参数`);
  }
  const runnerPositional = command === 'models' ? positionals[1] : first;
  if (!help && command === 'models' && runnerPositional !== undefined
    && runnerPositional !== 'claude' && runnerPositional !== 'codex' && runnerPositional !== 'cursor') {
    throw new Error(`❌ models runner 必须是 claude、codex 或 cursor，收到「${runnerPositional}」`);
  }
  if (!help && command === 'models' && positionals.length > 2) {
    throw new Error('❌ models 不接受 runner 以外的额外位置参数');
  }
  const kind: AgentKind = runnerPositional === 'codex' ? 'codex' : runnerPositional === 'cursor' ? 'cursor' : 'claude';
  const kindExplicit = runnerPositional === 'claude' || runnerPositional === 'codex' || runnerPositional === 'cursor';
  const min = (s: string | undefined, d: number) => (s ? Number(s) : d) * 60 * 1000;

  let staleDays = 30;
  if (values['stale-days'] !== undefined) {
    const raw = values['stale-days'];
    // 字面量校验：只接受纯十进制数字串，排除 Number() 会静默接受的 ''/0x10/1e2 等写法
    if (!help && command === 'doctor' && !/^\d+$/.test(raw)) {
      throw new Error(`❌ --stale-days 必须是非负整数，收到「${raw}」`);
    }
    staleDays = Number(raw);
  }

  let stallLimit = 3;
  if (values['stall-limit'] !== undefined) {
    const raw = values['stall-limit'];
    if (!help && command === 'run' && !/^[1-9]\d*$/.test(raw)) {
      throw new Error(`❌ --stall-limit 必须是正整数，收到「${raw}」`);
    }
    stallLimit = Number(raw);
  }

  let port = 7331;
  if (values.port !== undefined) {
    const raw = values.port;
    const parsed = Number(raw);
    const valid = /^\d+$/.test(raw) && parsed <= 65535;
    if (!help && !valid) {
      throw new Error(`❌ --port 必须是 0 到 65535（含边界）的十进制整数，收到「${raw}」`);
    }
    if (valid) port = parsed;
  }

  return {
    command,
    help,
    configAction,
    hooksAction,
    kind,
    kindExplicit,
    maxIterations: values['max-iter'] ? Number(values['max-iter']) : 50,
    devTimeoutMs: min(values['dev-timeout'], 30),
    valTimeoutMs: min(values['val-timeout'], 60),
    builderModel: values['builder-model'],
    validatorModel: values['validator-model'],
    reviewModel: values['review-model'],
    escalationModel: values['escalation-model'],
    workspace: values.workspace ?? '.workspace',
    openBrowser: !values['no-open'],
    keepOpen: values['keep-open'] ?? false,
    port,
    staleDays,
    json: values.json ?? false,
    stallLimit,
    shadow: values.shadow ?? false,
    contractFile: values.contract,
    yes: values.yes ?? false,
    local: values.local ?? false,
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
  await server.ready;
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

  if (cfg.help) {
    console.log(CLI_HELP);
    return 0;
  }

  if (cfg.command === 'hooks') {
    const here = dirname(fileURLToPath(import.meta.url));
    const bundledCandidates = [
      join(here, 'hooks', 'tdd-commit-check.mjs'),
      join(here, '..', 'hooks', 'tdd-commit-check.mjs'),
    ];
    const bundle = bundledCandidates.find((candidate) => existsSync(candidate))
      ?? bundledCandidates[0];
    const hookResult = runCursorHookAction(cfg.hooksAction!, {
      root: process.cwd(),
      bundle,
    });
    if (hookResult.exitCode === 0) console.log(hookResult.message);
    else console.error(hookResult.message);
    return hookResult.exitCode;
  }

  if (cfg.command === 'init') {
    if (!cfg.yes && !process.stdin.isTTY) {
      const message = '❌ init 需要交互确认；无终端环境请先核对契约，再显式使用 --yes';
      if (cfg.json) console.log(JSON.stringify({ status: 'error', exitCode: 2, message }, null, 2));
      else console.error(message);
      return 2;
    }
    const prompt = cfg.yes
      ? null
      : createInterface({ input: process.stdin, output: process.stderr });
    const emit = (message: string) => {
      if (cfg.json) console.error(message);
      else console.log(message);
    };
    try {
      const initResult = await runQualityInit({
        root: process.cwd(),
        actualVersion: CODING_X_VERSION,
        contractFile: cfg.contractFile,
        emit,
        confirm: async (summary) => {
          emit(summary);
          if (cfg.yes) return true;
          const answer = await prompt!.question('确认继续？[y/N] ');
          return /^(?:y|yes)$/i.test(answer.trim());
        },
        ask: async (question) => {
          if (cfg.yes) {
            throw new Error(`${question} --yes 不会替用户填写理由；请交互运行或提供 --contract`);
          }
          return prompt!.question(`${question} `);
        },
      });
      if (cfg.json) console.log(JSON.stringify(initResult, null, 2));
      else if (initResult.exitCode === 0) console.log(`✅ ${initResult.message}`);
      else console.error(`⏳ ${initResult.message}`);
      return initResult.exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cfg.json) console.log(JSON.stringify({ status: 'error', exitCode: 2, message }, null, 2));
      else console.error(`❌ 初始化失败：${message}`);
      return 2;
    } finally {
      prompt?.close();
    }
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
    const report = runDoctor(process.cwd(), {
      staleDays: cfg.staleDays,
      workspace: cfg.workspace,
      local: cfg.local,
    });
    const { text, exitCode } = cfg.json ? renderDoctorJson(report) : renderDoctorReport(report);
    console.log(text);
    return exitCode;
  }

  if (cfg.command === 'status') {
    const report = collectStatus(cfg.workspace, {
      projectRoot: process.cwd(),
      refreshRemote: !cfg.local,
    });
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
    reviewModel: cfg.reviewModel,
    escalationModel: cfg.escalationModel,
    workspace: cfg.workspace,
    instructionsDir,
    port: cfg.port,
    openBrowser: cfg.openBrowser,
    keepOpen: cfg.keepOpen,
    stallLimit: cfg.stallLimit,
    shadow: cfg.shadow,
    actualVersion: CODING_X_VERSION,
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
  void main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      console.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    },
  );
}
