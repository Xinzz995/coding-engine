import { parseArgs } from 'node:util';
import { createInterface } from 'node:readline/promises';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { existsSync, realpathSync } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { runLoop } from './engine/loop.js';
import { repairJsonString } from './engine/repair.js';
import {
  runDoctorWithWorkspaceSafety,
  renderDoctorJson,
  renderDoctorReport,
} from './doctor/doctor.js';
import {
  collectStatusWithWorkspaceSafety,
  renderStatusReport,
  renderStatusJson,
} from './status/status.js';
import { writeCurrentReportWithSession } from './report/current-report.js';
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
import { runCursorHookAction, type CursorHookAction } from './cursor-hooks.js';
import * as dashboard from './dashboard/server.js';
import { openBrowserBestEffort } from './dashboard/browser-opener.js';
import { CODING_X_VERSION } from './version.js';
import { runQualityInit } from './quality/init.js';
import { bootstrapWorkspace } from './workspace-safety/bootstrap.js';
import { digestBytes } from './workspace-safety/filesystem.js';
import { acquireWorkspaceLease } from './workspace-safety/lease.js';
import {
  runApplyPrdV1Mutation,
  runRepairV1Mutation,
  type ApplyPrdV1Request,
  type RepairV1Request,
} from './workspace-safety/product-mutations.js';
import {
  runWorkspaceRecover,
  runWorkspaceResumeMutation,
} from './workspace-safety/recovery-dispatch.js';
import { createWorkspaceSession, type WorkspaceSession } from './workspace-safety/session.js';
import { WorkspaceSafetyError, type OwnerCommand } from './workspace-safety/types.js';
import { readStableFile } from './workspace-safety/stable-file.js';
import {
  installCommandSignals,
  type CommandSignalController,
} from './workspace-safety/command-signals.js';
import {
  parseReviewDecisionRequest,
  readBoundReviewDecisionContract,
  recordReviewDecision,
} from './review/decision-command.js';
import { createManagedReviewObservation } from './review/managed-observation.js';
import {
  verifyCandidateRuntime,
  type VerifiedCandidateIdentity,
} from './release/candidate-identity.js';
import { publishCandidateProof } from './release/candidate-proof-publish.js';
import { runReadyIssue } from './issue/issue-run.js';
import { readFinalReviewState } from './review/state.js';
import { digestReviewBinding } from './review/binding.js';

export interface CliConfig {
  command:
    | 'run'
    | 'init'
    | 'repair'
    | 'dashboard'
    | 'doctor'
    | 'status'
    | 'report'
    | 'models'
    | 'config'
    | 'hooks'
    | 'workspace'
    | 'candidate'
    | 'issue';
  /** 全局帮助请求；先于任何子命令校验与副作用处理。 */
  help: boolean;
  configAction: 'path' | 'init' | 'validate' | null;
  hooksAction: CursorHookAction | null;
  candidateAction: 'publish-proof' | null;
  issueAction: 'run' | null;
  issueNumber: number | null;
  workspaceAction:
    'init' | 'apply-prd' | 'record-review-decision' | 'recover' | 'resume-mutation' | null;
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
  /** 候选构建证据；提供时必须逐文件证明当前实际 CLI 就是该候选。 */
  candidateEvidence: string | undefined;
  /** init 从用户确认过的文件读取契约；相对路径基于项目根。 */
  contractFile: string | undefined;
  /** init 明确跳过是/否提示；必须同时提供已经人工确认的 --contract。 */
  yes: boolean;
  /** doctor 只检查本地状态，不查询 GitHub。 */
  local: boolean;
  /** workspace apply-prd / record-review-decision 的严格 JSON 请求。 */
  inputFile: string | undefined;
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

  三个 runner 均可运行 Builder（开发）。可签发验收凭证的 Validator 当前仅
  codex：固定审计版本加每次调用的宿主隔离反测（ADR-025）；其余 runner 进入
  验证阶段时按不可验证保留候选并以退出码 5 停止，不降级回宽权限执行。

命令:
  init                           初始化安全 workspace、质量契约与 GitHub 交付门禁
  workspace init                只初始化一个新的空 workspace
  workspace apply-prd           原子应用已确认的 PRD 候选（需要 --input）
  workspace record-review-decision
                                 记录当前提交上的 Review 裁决（需要 --input）
  workspace recover             恢复已证明安全的中断运行
  workspace resume-mutation     继续已验证的 apply-prd / repair 原子操作
  repair                         修复 workspace 中的 prd.json/state.json
  dashboard                      启动只读离线仪表盘
  doctor                         检查文档、门禁、模型与 workspace 健康度
  status                         输出实现、最终 Review 与 GitHub 交付状态（退出码 0–7 见下方）
  report                         生成静态验证报告 report.html
  models [claude|codex|cursor]   查询全局模型目录
  config path|init|validate      查看、初始化或校验全局模型配置
  hooks cursor install|status|remove
                                 安装、检查或移除当前项目的 Cursor TDD 提交前检查
  candidate publish-proof        核对当前仓库、PR 与提交后发布候选 Dogfood 机器证明
  issue run <编号> [runner]       从 ready-for-agent Issue 继续唯一分支与 PR
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
  --no-open                      standalone dashboard 不自动打开浏览器
  --keep-open                    循环结束后保留仪表盘
  --port <n>                     仪表盘端口（仅接受 0–65535 的十进制整数；0 由系统选择可用端口；默认 7331）
  --stall-limit <n>              连续无进展轮熔断阈值（默认 3，仅 run）
  --stale-days <n>               active 文档过期阈值（默认 30；doctor 跳过冷档案）
  --json                         JSON 输出（init/workspace/doctor/status/models/issue/candidate）
  --shadow                       候选 Dogfood；仅用于 run、doctor、workspace apply-prd，永远不可交付
  --candidate-evidence <file>    候选 packed.json；与 --shadow 同用并核对当前 CLI 实际文件
  --contract <file>              init 使用已确认的质量契约文件
  --input <file>                 workspace 写命令的严格 JSON 请求文件
  --yes                          init 接受已展示的变更；必须同时提供 --contract
  --local                        doctor 只检查本地状态，不查询 GitHub
  -h, --help                     显示本帮助并退出

status 退出码:
  0                              实现验证、本地 Review 与 GitHub 交付条件均已就绪
  1                              Story 未完成、state 损坏或 PRD 没有 Story
  2                              workspace 安全状态未就绪/不可读，或最终 Review 状态损坏
  3                              存在 blocked Story
  4                              最终 Review 有待人工处理的 finding
  5                              Validator 或最终 Review 无法可靠验证（含 Runner 宿主隔离无法证明）
  6                              最终 Review 未完成或已失效，或 GitHub CI / Ruleset 未就绪
  7                              Shadow 已完成，但不能表示可交付

run 退出码:
  0                              实现验证、本地 Review 与 GitHub 交付条件均已就绪
  1                              机械检查、明确验收失败或执行未收敛
  2                              配置、状态或 workspace 安全边界无效
  3                              存在 blocked Story
  4                              最终 Review 有待人工处理的 finding
  5                              Validator 或最终 Review 无法可靠验证（含 Runner 宿主隔离无法证明）
  6                              本地已完成，但 PR、CI 或 Ruleset 未就绪
  7                              Shadow 已完成，但不能表示可交付

更多说明: https://github.com/Xinzz995/coding-engine#readme`;

export function parseCliArgs(argv: string[]): CliConfig {
  const workspaceOptionCount = argv.filter(
    (arg) => arg === '--workspace' || arg.startsWith('--workspace='),
  ).length;
  const inputOptionCount = argv.filter(
    (arg) => arg === '--input' || arg.startsWith('--input='),
  ).length;
  const normalizedArgs: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg !== '--port') {
      normalizedArgs.push(arg);
      continue;
    }
    const raw = argv[i + 1];
    if (
      raw === undefined ||
      raw === '--help' ||
      raw === '-h' ||
      raw === 'help' ||
      raw.startsWith('--')
    ) {
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
      'candidate-evidence': { type: 'string' },
      contract: { type: 'string' },
      yes: { type: 'boolean' },
      local: { type: 'boolean' },
      input: { type: 'string' },
      help: { type: 'boolean', short: 'h' },
    },
  });

  const first = positionals[0];
  const help = values.help === true || positionals.includes('help');
  const command: CliConfig['command'] =
    first === 'init'
      ? 'init'
      : first === 'repair'
        ? 'repair'
        : first === 'dashboard'
          ? 'dashboard'
          : first === 'doctor'
            ? 'doctor'
            : first === 'status'
              ? 'status'
              : first === 'report'
                ? 'report'
                : first === 'models'
                  ? 'models'
                  : first === 'config'
                    ? 'config'
                  : first === 'hooks'
                      ? 'hooks'
                      : first === 'workspace'
                        ? 'workspace'
                        : first === 'candidate'
                          ? 'candidate'
                          : first === 'issue'
                            ? 'issue'
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
  if (!help && workspaceOptionCount > 1) {
    throw new Error('❌ --workspace 只能指定一次');
  }
  if (!help && inputOptionCount > 1) {
    throw new Error('❌ --input 只能指定一次');
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
    if (
      host === 'cursor' &&
      (rawAction === 'install' || rawAction === 'status' || rawAction === 'remove')
    ) {
      hooksAction = rawAction;
    } else if (!help) {
      throw new Error('❌ hooks 子命令必须是 cursor install、cursor status 或 cursor remove');
    }
  }
  if (!help && command === 'hooks' && positionals.length > 3) {
    throw new Error(`❌ hooks cursor ${hooksAction} 不接受额外位置参数`);
  }
  let candidateAction: CliConfig['candidateAction'] = null;
  if (command === 'candidate') {
    if (positionals[1] === 'publish-proof') candidateAction = 'publish-proof';
    else if (!help) throw new Error('❌ candidate 子命令必须是 publish-proof');
  }
  if (!help && command === 'candidate' && positionals.length > 2) {
    throw new Error(`❌ candidate ${candidateAction} 不接受额外位置参数`);
  }
  let issueAction: CliConfig['issueAction'] = null;
  let issueNumber: number | null = null;
  if (command === 'issue') {
    if (positionals[1] !== 'run') {
      if (!help) throw new Error('❌ issue 子命令必须是 run <编号> [runner]');
    } else {
      issueAction = 'run';
      const rawNumber = positionals[2];
      if (!help && (rawNumber === undefined || !/^[1-9]\d*$/u.test(rawNumber))) {
        throw new Error('❌ issue run 必须指定正整数 Issue 编号');
      }
      if (rawNumber !== undefined && /^[1-9]\d*$/u.test(rawNumber)) issueNumber = Number(rawNumber);
      const issueRunner = positionals[3];
      if (
        !help &&
        issueRunner !== undefined &&
        issueRunner !== 'claude' &&
        issueRunner !== 'codex' &&
        issueRunner !== 'cursor'
      ) {
        throw new Error('❌ issue run runner 必须是 claude、codex 或 cursor');
      }
    }
  }
  if (!help && command === 'issue' && positionals.length > 4) {
    throw new Error('❌ issue run 不接受 runner 以外的额外位置参数');
  }
  if (!help && command === 'issue' && values['keep-open'] === true) {
    throw new Error('❌ issue run 不支持 --keep-open；运行结束必须写回 Issue 状态');
  }
  let workspaceAction: CliConfig['workspaceAction'] = null;
  if (command === 'workspace') {
    const rawAction = positionals[1];
    if (
      rawAction === 'init' ||
      rawAction === 'apply-prd' ||
      rawAction === 'record-review-decision' ||
      rawAction === 'recover' ||
      rawAction === 'resume-mutation'
    ) {
      workspaceAction = rawAction;
    } else if (!help) {
      throw new Error(
        '❌ workspace 子命令必须是 init、apply-prd、record-review-decision、recover 或 resume-mutation',
      );
    }
  }
  if (!help && command === 'workspace' && positionals.length > 2) {
    throw new Error(`❌ workspace ${workspaceAction} 不接受额外位置参数`);
  }
  if (
    !help &&
    values.shadow === true &&
    command !== 'run' &&
    command !== 'doctor' &&
    !(command === 'workspace' && workspaceAction === 'apply-prd')
  ) {
    throw new Error('❌ --shadow 只能用于 run、doctor 或 workspace apply-prd');
  }
  const candidateEvidenceAllowed =
    command === 'run' ||
    command === 'doctor' ||
    (command === 'workspace' && workspaceAction === 'apply-prd');
  if (!help && values['candidate-evidence'] !== undefined && !candidateEvidenceAllowed) {
    throw new Error(
      '❌ --candidate-evidence 只能用于 run、doctor 或 workspace apply-prd',
    );
  }
  if (
    !help &&
    values['candidate-evidence'] !== undefined &&
    values['candidate-evidence'].trim() === ''
  ) {
    throw new Error('❌ --candidate-evidence 必须指定 packed.json 路径');
  }
  if (!help && values['candidate-evidence'] !== undefined && values.shadow !== true) {
    throw new Error('❌ --candidate-evidence 必须与 --shadow 同时使用');
  }
  if (
    !help &&
    values.input !== undefined &&
    (command !== 'workspace' ||
      (workspaceAction !== 'apply-prd' && workspaceAction !== 'record-review-decision'))
  ) {
    throw new Error('❌ --input 只能用于 workspace apply-prd 或 record-review-decision');
  }
  if (
    !help &&
    command === 'workspace' &&
    (workspaceAction === 'apply-prd' || workspaceAction === 'record-review-decision') &&
    (values.input === undefined || values.input.trim() === '')
  ) {
    throw new Error(`❌ workspace ${workspaceAction} 必须指定 --input <file>`);
  }
  const runnerPositional =
    command === 'models' ? positionals[1] : command === 'issue' ? positionals[3] : first;
  if (
    !help &&
    command === 'models' &&
    runnerPositional !== undefined &&
    runnerPositional !== 'claude' &&
    runnerPositional !== 'codex' &&
    runnerPositional !== 'cursor'
  ) {
    throw new Error(`❌ models runner 必须是 claude、codex 或 cursor，收到「${runnerPositional}」`);
  }
  if (!help && command === 'models' && positionals.length > 2) {
    throw new Error('❌ models 不接受 runner 以外的额外位置参数');
  }
  const kind: AgentKind =
    runnerPositional === 'codex' ? 'codex' : runnerPositional === 'cursor' ? 'cursor' : 'claude';
  const kindExplicit =
    runnerPositional === 'claude' || runnerPositional === 'codex' || runnerPositional === 'cursor';
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
    if (!help && (command === 'run' || command === 'issue') && !/^[1-9]\d*$/.test(raw)) {
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
    candidateAction,
    issueAction,
    issueNumber,
    workspaceAction,
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
    candidateEvidence: values['candidate-evidence'],
    contractFile: values.contract,
    yes: values.yes ?? false,
    local: values.local ?? false,
    inputFile: values.input,
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
  browserOpener: (url: string) => void = openBrowserBestEffort,
): Promise<number> {
  const server = dashboard.start({
    workspace: opts.workspace,
    maxIterations: 0,
    projectRoot: process.cwd(),
    port: opts.port,
  });
  const address = await server.ready;
  if (opts.openBrowser) browserOpener(`http://localhost:${address.port}`);
  console.log('📊 离线查看模式（未在运行循环），按 Ctrl+C 退出。');
  try {
    await (interrupt ?? new Promise<void>((r) => process.once('SIGINT', () => r())));
    return 0;
  } finally {
    server.close();
  }
}

function inputPathOutsideWorkspace(inputFile: string, workspace: string): string {
  const inputPath = realpathSync(resolve(inputFile));
  let workspacePath: string;
  try {
    workspacePath = realpathSync(resolve(workspace));
  } catch {
    workspacePath = resolve(workspace);
  }
  const relation = relative(workspacePath, inputPath);
  if (
    relation === '' ||
    (!relation.startsWith(`..${sep}`) && relation !== '..' && !isAbsolute(relation))
  ) {
    throw new Error('--input 必须位于 workspace 之外，避免候选输入与目标状态互相覆盖');
  }
  return inputPath;
}

function readJsonInput(inputFile: string, workspace: string): unknown {
  const path = inputPathOutsideWorkspace(inputFile, workspace);
  const file = readStableFile(path, { label: '请求文件', maxBytes: 64 * 1024 * 1024 });
  if (file.status !== 'ready') {
    throw new Error(
      file.status === 'missing'
        ? `请求文件不存在：${path}`
        : `请求文件不可读取：${file.diagnostic}`,
    );
  }
  const bytes = file.bytes;
  if (bytes.byteLength === 0) {
    throw new Error(`请求文件大小非法：${path}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new Error(`请求文件不是严格 UTF-8：${path}`);
  }
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(
      `请求文件不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

async function withWorkspaceSession<T>(
  workspace: string,
  command: Exclude<OwnerCommand, 'workspace-init'>,
  action: (session: WorkspaceSession) => Promise<T>,
): Promise<T> {
  const lease = await acquireWorkspaceLease({ workspacePath: workspace, command });
  const session = createWorkspaceSession(lease);
  try {
    const result = await action(session);
    await session.close();
    return result;
  } catch (error) {
    if (session.state === 'open') {
      try {
        await session.close();
      } catch (closeError) {
        throw new Error(
          `${error instanceof Error ? error.message : String(error)}；` +
            'workspace 操作未能安全收口，已保留恢复记录。请先运行 workspace resume-mutation 或 recover。' +
            `（${closeError instanceof Error ? closeError.message : String(closeError)}）`,
        );
      }
    }
    throw error;
  }
}

function repairRequest(workspace: string): RepairV1Request {
  const readRepairFile = (name: string, required: boolean): Buffer | null => {
    const file = readStableFile(join(workspace, name), {
      label: name,
      maxBytes: 64 * 1024 * 1024,
    });
    if (file.status === 'ready') return file.bytes;
    if (file.status === 'missing' && !required) return null;
    throw new Error(
      file.status === 'missing'
        ? `${name} 不存在，不能修复`
        : `${name} 无法安全读取：${file.diagnostic}`,
    );
  };
  const prdBytes = readRepairFile('prd.json', true)!;
  const stateBytes = readRepairFile('state.json', false);
  const decode = (bytes: Buffer, name: string): string => {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      throw new Error(`${name} 不是严格 UTF-8，不能自动修复`);
    }
  };
  return {
    schemaVersion: 1,
    source: {
      prdDigest: digestBytes(prdBytes),
      stateDigest: stateBytes === null ? null : digestBytes(stateBytes),
    },
    candidate: {
      prd: repairJsonString(decode(prdBytes, 'prd.json')),
      state: stateBytes === null ? null : repairJsonString(decode(stateBytes, 'state.json')),
    },
  };
}

function workspaceErrorMessage(error: unknown): string {
  if (error instanceof WorkspaceSafetyError) {
    return `${error.message}（${error.code}）`;
  }
  return error instanceof Error ? error.message : String(error);
}

function commandInterrupted(
  cfg: Pick<CliConfig, 'json'>,
  label: string,
  signals: CommandSignalController,
): 130 | 143 {
  const exitCode = signals.exitCode;
  if (exitCode === null) {
    throw new Error('commandInterrupted 只能在收到用户中断后调用');
  }
  const message = `${label}已按安全边界停止；请先运行 status 或 doctor 确认后续动作`;
  if (cfg.json) {
    console.log(JSON.stringify({ status: 'interrupted', exitCode, message }, null, 2));
  } else {
    console.error(`⏸️  ${message}`);
  }
  return exitCode;
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

  let candidateIdentity: VerifiedCandidateIdentity | undefined;
  if (cfg.candidateEvidence !== undefined) {
    try {
      candidateIdentity = verifyCandidateRuntime({
        evidencePath: cfg.candidateEvidence,
        packageRoot: resolve(dirname(fileURLToPath(import.meta.url)), '..'),
        expectedVersion: CODING_X_VERSION,
      });
    } catch (error) {
      console.error(`❌ ${error instanceof Error ? error.message : String(error)}`);
      return 2;
    }
  }

  if (cfg.command === 'hooks') {
    const here = dirname(fileURLToPath(import.meta.url));
    const bundledCandidates = [
      join(here, 'hooks', 'tdd-commit-check.mjs'),
      join(here, '..', 'hooks', 'tdd-commit-check.mjs'),
    ];
    const bundle =
      bundledCandidates.find((candidate) => existsSync(candidate)) ?? bundledCandidates[0];
    const hookResult = runCursorHookAction(cfg.hooksAction!, {
      root: process.cwd(),
      bundle,
    });
    if (hookResult.exitCode === 0) console.log(hookResult.message);
    else console.error(hookResult.message);
    return hookResult.exitCode;
  }

  if (cfg.command === 'candidate') {
    try {
      const result = publishCandidateProof({
        root: process.cwd(),
        workspace: resolve(cfg.workspace),
      });
      if (cfg.json) console.log(JSON.stringify({ ...result, exitCode: 0 }, null, 2));
      else {
        console.log(
          `✅ 候选 Dogfood 机器证明已${result.status === 'created' ? '发布' : '更新'}：${result.url}`,
        );
      }
      return 0;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cfg.json) console.log(JSON.stringify({ status: 'error', exitCode: 2, message }, null, 2));
      else console.error(`❌ 候选证明发布失败：${message}`);
      return 2;
    }
  }

  if (cfg.command === 'issue') {
    try {
      const instructionsDir = join(dirname(fileURLToPath(import.meta.url)), 'instructions');
      const result = await runReadyIssue({
        root: process.cwd(),
        workspaceBase: cfg.workspace,
        issueNumber: cfg.issueNumber!,
        runEngine: async ({ workspace }) => {
          const exitCode = await runLoop({
            kind: cfg.kind,
            kindExplicit: cfg.kindExplicit,
            maxIterations: cfg.maxIterations,
            devTimeoutMs: cfg.devTimeoutMs,
            valTimeoutMs: cfg.valTimeoutMs,
            builderModel: cfg.builderModel,
            validatorModel: cfg.validatorModel,
            reviewModel: cfg.reviewModel,
            escalationModel: cfg.escalationModel,
            workspace,
            instructionsDir,
            port: cfg.port,
            keepOpen: false,
            stallLimit: cfg.stallLimit,
            shadow: false,
            actualVersion: CODING_X_VERSION,
          });
          const review = readFinalReviewState(workspace);
          const evidence =
            review.status === 'ready' && review.state.schemaVersion !== 1
              ? {
                  reviewBindingDigest: digestReviewBinding(review.state.binding),
                  storyValidationDigest: review.state.binding.storyValidationDigest,
                }
              : {};
          return {
            exitCode,
            message:
              exitCode === 0
                ? '当前 PR 已取得可信结论'
                : exitCode === 6
                  ? '本地已完成，等待当前提交的远端检查'
                  : `coding-x 以退出码 ${exitCode} 停止`,
            evidence,
          };
        },
      });
      if (cfg.json) console.log(JSON.stringify(result, null, 2));
      else {
        const emit = result.exitCode === 0 ? console.log : console.error;
        emit(
          `${result.exitCode === 0 ? '✅' : result.exitCode === 6 ? '⏳' : '❌'} ${result.state.message}\n` +
            `   PR: ${result.pullRequestUrl}`,
        );
      }
      return result.exitCode;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (cfg.json) console.log(JSON.stringify({ status: 'error', exitCode: 2, message }, null, 2));
      else console.error(`❌ Issue 运行失败：${message}`);
      return 2;
    }
  }

  if (cfg.command === 'workspace') {
    const commandSignals = installCommandSignals();
    try {
      if (cfg.workspaceAction === 'init') {
        const result = await bootstrapWorkspace({ workspacePath: cfg.workspace });
        if (commandSignals.exitCode !== null) {
          return commandInterrupted(cfg, 'Workspace 初始化', commandSignals);
        }
        const output = {
          status: result.created ? 'created' : 'ready',
          exitCode: 0,
          workspace: result.workspacePath,
          workspaceIdentity: result.workspaceIdentity,
          protocolDigest: result.protocolDigest,
        };
        if (cfg.json) console.log(JSON.stringify(output, null, 2));
        else {
          console.log(
            result.created
              ? `✅ Workspace 安全协议已初始化：${result.workspacePath}`
              : `✅ Workspace 已初始化且可以使用：${result.workspacePath}`,
          );
        }
        return 0;
      }
      if (cfg.workspaceAction === 'recover' || cfg.workspaceAction === 'resume-mutation') {
        const result =
          cfg.workspaceAction === 'recover'
            ? await runWorkspaceRecover({
                workspacePath: cfg.workspace,
                termination: commandSignals.termination,
              })
            : await runWorkspaceResumeMutation({
                workspacePath: cfg.workspace,
                termination: commandSignals.termination,
              });
        if (commandSignals.exitCode !== null) {
          return commandInterrupted(cfg, 'Workspace 恢复', commandSignals);
        }
        if (cfg.json) console.log(JSON.stringify(result, null, 2));
        else if (result.ok) {
          console.log(
            result.runtimeMode === 'shadow'
              ? `🧪 ${result.message} Shadow 候选已恢复；本结果不能表示可交付。归档：${result.archivePath}`
              : `✅ ${result.message} 归档：${result.archivePath}`,
          );
        } else {
          console.error(`❌ ${result.message}${result.detail ? ` ${result.detail}` : ''}`);
        }
        return result.exitCode;
      }
      if (cfg.workspaceAction === 'apply-prd') {
        const request = readJsonInput(cfg.inputFile!, cfg.workspace) as ApplyPrdV1Request;
        const mutation = await withWorkspaceSession(cfg.workspace, 'apply-prd', async (session) =>
          runApplyPrdV1Mutation(session, request, {
            projectRoot: process.cwd(),
            runtimeMode: cfg.shadow ? 'shadow' : 'formal',
            termination: commandSignals.termination,
          }),
        );
        if (commandSignals.exitCode !== null) {
          return commandInterrupted(cfg, 'PRD 应用', commandSignals);
        }
        const output = {
          status: cfg.shadow ? 'applied-shadow' : 'applied',
          exitCode: cfg.shadow ? 7 : 0,
          mutationId: mutation.state.mutationId,
          kind: mutation.state.kind,
          phase: mutation.state.phase,
        };
        if (cfg.json) console.log(JSON.stringify(output, null, 2));
        else {
          console.log(
            cfg.shadow
              ? `🧪 PRD 候选已按 Shadow 模式原子应用：${mutation.state.mutationId}；本结果不能表示可交付`
              : `✅ PRD 候选已原子应用：${mutation.state.mutationId}`,
          );
        }
        return cfg.shadow ? 7 : 0;
      }
      const request = parseReviewDecisionRequest(readJsonInput(cfg.inputFile!, cfg.workspace));
      const decision = await withWorkspaceSession(
        cfg.workspace,
        'review-decision',
        async (session) => {
          const observation = createManagedReviewObservation({
            session,
            root: process.cwd(),
            termination: commandSignals.termination,
          });
          const contract = await readBoundReviewDecisionContract(
            session,
            process.cwd(),
            observation,
          );
          return recordReviewDecision({
            session,
            root: process.cwd(),
            request,
            contract,
            observation,
            termination: commandSignals.termination,
          });
        },
      );
      if (commandSignals.exitCode !== null) {
        return commandInterrupted(cfg, 'Review 裁决记录', commandSignals);
      }
      const output = { status: 'recorded', exitCode: 0, decision };
      if (cfg.json) console.log(JSON.stringify(output, null, 2));
      else console.log(`✅ 已记录 ${decision.findingId} 的裁决；请重新运行 coding-x`);
      return 0;
    } catch (error) {
      if (commandSignals.exitCode !== null) {
        return commandInterrupted(cfg, 'Workspace 命令', commandSignals);
      }
      const message = workspaceErrorMessage(error);
      if (cfg.json) {
        console.log(JSON.stringify({ status: 'error', exitCode: 2, message }, null, 2));
      } else {
        console.error(`❌ Workspace 命令失败：${message}`);
      }
      return 2;
    } finally {
      commandSignals.dispose();
    }
  }

  if (cfg.command === 'init') {
    if (cfg.yes && !cfg.contractFile) {
      const message =
        'init 使用 --yes 时必须同时提供经人工确认的 --contract；--yes 不会代替平台选择';
      if (cfg.json) console.log(JSON.stringify({ status: 'error', exitCode: 2, message }, null, 2));
      else console.error(`❌ ${message}`);
      return 2;
    }
    if (!cfg.yes && !process.stdin.isTTY) {
      const message =
        '❌ init 需要交互确认；无终端环境请先核对契约，再同时使用 --contract 与 --yes';
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
            throw new Error(
              `${question} --yes 不会替用户选择平台或填写理由；请交互运行或提供 --contract`,
            );
          }
          return prompt!.question(`${question} `);
        },
        prepareWorkspace: async () => {
          const result = await bootstrapWorkspace({ workspacePath: cfg.workspace });
          emit(
            result.created
              ? `Workspace 安全协议已初始化：${result.workspacePath}`
              : `Workspace 安全协议已就绪：${result.workspacePath}`,
          );
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
    const commandSignals = installCommandSignals();
    try {
      const request = repairRequest(cfg.workspace);
      await withWorkspaceSession(cfg.workspace, 'repair', async (session) =>
        runRepairV1Mutation(session, request, {
          termination: commandSignals.termination,
        }),
      );
      if (commandSignals.exitCode !== null) {
        return commandInterrupted(cfg, 'Workspace 修复', commandSignals);
      }
      console.log(`✅ 已修复: prd.json${request.candidate.state === null ? '' : '、state.json'}`);
      return 0;
    } catch (error) {
      if (commandSignals.exitCode !== null) {
        return commandInterrupted(cfg, 'Workspace 修复', commandSignals);
      }
      console.error(`❌ 修复失败：${workspaceErrorMessage(error)}`);
      return 2;
    } finally {
      commandSignals.dispose();
    }
  }

  if (cfg.command === 'doctor') {
    const report = await runDoctorWithWorkspaceSafety(process.cwd(), {
      staleDays: cfg.staleDays,
      workspace: cfg.workspace,
      local: cfg.local,
      shadow: cfg.shadow,
    });
    const { text, exitCode } = cfg.json ? renderDoctorJson(report) : renderDoctorReport(report);
    console.log(text);
    return exitCode;
  }

  if (cfg.command === 'status') {
    const report = await collectStatusWithWorkspaceSafety(cfg.workspace, {
      projectRoot: process.cwd(),
      refreshRemote: !cfg.local,
    });
    // 警告走 stderr：--json 模式下不污染 stdout，人类可读模式同样适用
    if (report.status === 'ok' && report.stateCorrupted) {
      console.error(
        '⚠️  state.json 已损坏，所有 story 已按未验证状态保守显示。建议运行 npx coding-x repair。',
      );
    }
    const { text, exitCode } = cfg.json ? renderStatusJson(report) : renderStatusReport(report);
    console.log(text);
    return exitCode;
  }

  if (cfg.command === 'report') {
    const commandSignals = installCommandSignals();
    try {
      const result = await withWorkspaceSession(cfg.workspace, 'report', async (session) =>
        writeCurrentReportWithSession({
          session,
          workspace: cfg.workspace,
          projectRoot: process.cwd(),
          refreshRemote: !cfg.local,
          termination: commandSignals.termination,
        }),
      );
      if (commandSignals.exitCode !== null) {
        return commandInterrupted(cfg, '验证报告生成', commandSignals);
      }
      if (result.status === 'missing') {
        console.error(
          `❌ 未找到工作区：${join(cfg.workspace, 'prd.json')} 不存在。建议先用 prd-to-json 从源 PRD 生成工作区。`,
        );
        return 2;
      }
      if (result.status === 'unparsable') {
        console.error(
          `❌ 无法解析 ${join(cfg.workspace, 'prd.json')}。建议运行 npx coding-x repair 修复后重试。`,
        );
        return 2;
      }
      console.log(`📄 验证报告: ${result.path}`);
      if (result.stateCorrupted) {
        console.error(
          '❌ state.json 已损坏：已生成保守诊断报告，所有 story 按未验证处理。请运行 npx coding-x repair 后重新生成。',
        );
        return 1;
      }
      return 0;
    } catch (err) {
      if (commandSignals.exitCode !== null) {
        return commandInterrupted(cfg, '验证报告生成', commandSignals);
      }
      console.error(`❌ 验证报告生成失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    } finally {
      commandSignals.dispose();
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
        if (cfg.json)
          console.log(
            JSON.stringify({ status: 'error', runner, configPath, error: message }, null, 2),
          );
        else console.error(message);
        return 1;
      }
      const routing = readModelRouting(prd);
      if (routing.status === 'invalid') {
        const message = `❌ 无法从现有 prd.json 推断 runner：${routing.errors.join('；')}`;
        if (cfg.json)
          console.log(
            JSON.stringify({ status: 'error', runner, configPath, error: message }, null, 2),
          );
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
    keepOpen: cfg.keepOpen,
    stallLimit: cfg.stallLimit,
    shadow: cfg.shadow,
    actualVersion: CODING_X_VERSION,
    candidateIdentity,
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
