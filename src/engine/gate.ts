import type { Prd } from './prd.js';
import type { RunState } from './state.js';
import { INITIAL_STORY_STATE } from './state.js';
import { realpathSync } from 'node:fs';
import { basename, isAbsolute, relative, resolve, sep } from 'node:path';
import { EVIDENCE_DIAGNOSTIC_CHARS } from './evidence.js';
import { resolveExecutablePath } from './agent.js';
import type { ValidationCheck } from './validation-protocol.js';
import type {
  FrozenQualityChecks,
  QualityCheck,
  QualityCommand,
  QualityPlatform,
} from '../quality/contract.js';
import { environmentEntries, runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import type { SupervisorTerminationReason } from '../workspace-safety/supervisor-protocol.js';

/** 打回上限的单一真相源：门禁与结构化 Validator failed claim 都由引擎应用。 */
export const MAX_RETRIES = 5;

/**
 * 仲裁类标签前缀族的单一真相源：agent 请求人工裁决的 notes 行以这些前缀开头，
 * 打回与清理路径必须保全。消费方：applyGateFailure 过滤、status 醒目标记、
 * builder.md/validator.md 经 {{ARBITRATION_PREFIXES}} 占位符渲染（loop.ts renderInstruction）、
 * report/render.ts 报告内仲裁行高亮（isArbitrationLine）。
 */
export const ARBITRATION_PREFIXES = ['[需求冲突]', '[需要人工核实]'] as const;

/**
 * 门禁打回与阻塞上限的 notes 行前缀单源。生产方：applyGateFailure；
 * 第二生产方 applyValidatorFailure；消费方：report/render.ts 行分类高亮。
 */
export const GATE_FAIL_LINE_PREFIX = '[门禁失败';
export const BLOCKED_LINE_PREFIX = '[BLOCKED';

/** Validator 结构化 claim 被引擎机械打回后的 notes 前缀。 */
export const VALIDATOR_FAIL_LINE_PREFIX = '[验证失败';

/**
 * 中断轮回写的 notes 行前缀单源。生产方：applyAbortRollback；
 * 消费方：report/render.ts 行分类高亮。标记文本自带下轮指令，builder 读 notes 即知处置。
 */
export const ABORT_LINE_PREFIX = '[中断轮待复核]';

/** 该 notes 行是否仲裁记录（保全对象） */
export function isArbitrationLine(line: string): boolean {
  return ARBITRATION_PREFIXES.some((p) => line.startsWith(p));
}

export interface GateFailure {
  command: string;
  /** 超时或 spawn 错误时为 null */
  exitCode: number | null;
  timedOut: boolean;
  /** stdout+stderr 合并输出的尾部（滚动保留） */
  outputTail: string;
}

/** validation-only 对失败结果的裁决；普通 Builder 轮不消费此分类。 */
export type ValidationOnlyFailureClassification = 'failed' | 'unverifiable';

/**
 * validation-only 只把正常结束并返回非零退出码视为候选实现已明确失败。
 * GateFailure 只表示失败结果，因此非 null 的正常退出码按契约必为非零；
 * 超时、spawn 错误与信号终止都无法证明候选有错，必须保持为不可验证。
 */
export function classifyValidationOnlyGateFailure(
  failure: GateFailure,
): ValidationOnlyFailureClassification {
  return failure.exitCode !== null && !failure.timedOut ? 'failed' : 'unverifiable';
}

export interface GateResult {
  ok: boolean;
  failure: GateFailure | null;
  /** 配置的检查总条数 */
  total: number;
  /** fail-fast 实际执行到的条数（通过=total；失败=失败那条的序号） */
  ran: number;
  /** 已执行检查的总耗时（毫秒） */
  ms: number;
}

export interface ContractGateResult extends GateResult {
  /** 因当前操作系统不适用而未运行的 check id；不是失败，也不会计入 total。 */
  skipped: string[];
}

/**
 * 读取并校验 qualityChecks：未配置或空数组返回 null（门禁不启用，静默）；
 * 形状非法（非数组/含非字符串）返回 'invalid'——调用方警告后按未配置处理，
 * 绝不对落盘数据直接类型断言（tryReadPrd 无逐字段守卫，这里补上本字段的）。
 */
export function readQualityChecks(prd: Prd | null): string[] | 'invalid' | null {
  if (!prd || prd.qualityChecks === undefined) return null;
  const v: unknown = prd.qualityChecks;
  if (!Array.isArray(v) || !v.every((x) => typeof x === 'string')) return 'invalid';
  return v.length === 0 ? null : v;
}

/** 每条门禁命令的执行超时（10 分钟）；超时按失败打回，notes 注明 */
export const GATE_TIMEOUT_MS = 600_000;

/**
 * 执行一条用户批准的完整 shell 命令。普通 qualityChecks 与 TDD coverageCheck
 * 必须共用这一实现，避免超时、进程树收口和诊断截尾语义漂移。
 */
interface SpawnedGateSpec {
  label: string;
  executable: string;
  args: string[];
  cwd: string;
  timeoutMs: number;
  shell: boolean;
}

export interface ManagedGateContext {
  readonly session: WorkspaceSession;
  readonly kind: 'quality-check' | 'tdd-check' | 'final-review';
  /**
   * 干净验证检出提供的显式环境。未提供只保留给历史测试 seam；正式验证不得
   * 从开发工作树继承 PATH、虚拟环境或 CODING_X_PROJECT_ROOT。
   */
  readonly environment?: NodeJS.ProcessEnv;
  /** 干净验证拒绝从开发工作树解析 executable 或显式参数路径。 */
  readonly forbiddenExecutableRoot?: string;
  /** 干净检出在项目命令运行前固定的 Git；只供引擎内部政策探测，不传给项目命令。 */
  readonly gitExecutable?: string;
  readonly termination?: {
    readonly signal: AbortSignal;
    readonly reason: Exclude<SupervisorTerminationReason, 'timeout'>;
  };
}

/** legacy shell 命令和结构化契约命令共用受控超时、整树收口与有界诊断语义。 */
function runSpawnedGate(
  spec: SpawnedGateSpec,
  managed: ManagedGateContext,
): Promise<GateFailure | null> {
  const environment = { ...(managed.environment ?? process.env) };
  let executable = spec.executable;
  let args = spec.args;
  if (spec.shell) {
    if (process.platform === 'win32') {
      executable = environment.ComSpec ?? 'cmd.exe';
      args = ['/d', '/s', '/c', spec.executable];
    } else {
      executable = '/bin/sh';
      args = ['-c', spec.executable];
    }
  }
  let resolvedExecutable: string;
  let resolvedCwd: string;
  try {
    resolvedExecutable = resolveExecutablePath(executable, spec.cwd, environment);
    resolvedCwd = realpathSync(spec.cwd);
    if (managed.forbiddenExecutableRoot) {
      const forbiddenInput = resolve(managed.forbiddenExecutableRoot);
      const forbiddenRoots = [...new Set([forbiddenInput, realpathSync(forbiddenInput)])];
      const withinForbiddenRoot = (candidate: string): boolean =>
        forbiddenRoots.some((root) => {
          const rel = relative(root, candidate);
          return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
        });
      const candidateReferencesForbiddenRoot = (entry: string): boolean => {
        if (!entry) return false;
        const lexical = isAbsolute(entry) ? resolve(entry) : resolve(spec.cwd, entry);
        if (withinForbiddenRoot(lexical)) return true;
        try {
          return withinForbiddenRoot(realpathSync(lexical));
        } catch {
          return false;
        }
      };
      const referencesForbiddenRoot = (value: string): boolean => {
        if (forbiddenRoots.some((root) => value.includes(root))) return true;
        // 结构化参数是一个原子值，路径即使含空格也必须先作为整体核对；随后才对
        // legacy shell/script 中嵌入的常见参数形式做保守扫描。
        if (candidateReferencesForbiddenRoot(value)) return true;
        return value
          .split(/[\s,;=]+/u)
          .map((entry) => entry.replace(/^[('"`]+|[)'"`]+$/gu, ''))
          .some(candidateReferencesForbiddenRoot);
      };
      if (referencesForbiddenRoot(resolvedExecutable) || args.some(referencesForbiddenRoot)) {
        throw new Error('验证命令解析到开发工作树，不能作为干净验证输入');
      }
    }
  } catch (error) {
    return Promise.resolve({
      command: spec.label,
      exitCode: null,
      timedOut: false,
      outputTail: error instanceof Error ? error.message : String(error),
    });
  }
  return runManagedWorkspaceProcess(managed.session, {
    kind: managed.kind,
    delegation: 'read-only-v1',
    executable: resolvedExecutable,
    args,
    cwd: resolvedCwd,
    environment: environmentEntries(environment),
    timeoutMs: spec.timeoutMs,
    termination: managed.termination,
  }).then((result) => {
    process.stdout.write(result.stdout);
    process.stderr.write(result.stderr);
    const tail = Buffer.concat([result.stdout, result.stderr])
      .toString('utf8')
      .slice(-EVIDENCE_DIAGNOSTIC_CHARS);
    if (result.timedOut) {
      return { command: spec.label, exitCode: null, timedOut: true, outputTail: tail };
    }
    if (result.processTreeNotEmpty) {
      return {
        command: spec.label,
        exitCode: result.exitCode,
        timedOut: false,
        outputTail: `${tail}\n检测到命令根进程退出后仍有后代进程；本次结果已拒绝`.trim(),
      };
    }
    return result.exitCode === 0
      ? null
      : {
          command: spec.label,
          exitCode: result.exitCode,
          timedOut: false,
          outputTail: tail,
        };
  });
}

export function runGateCommand(
  command: string,
  cwd: string,
  timeoutMs: number | undefined,
  managed: ManagedGateContext,
): Promise<GateFailure | null> {
  // 仅保留给历史 PRD fixture 与 TDD coverageCheck；正式质量契约默认不经 shell。
  return runSpawnedGate(
    {
      label: command,
      executable: command,
      args: [],
      cwd,
      timeoutMs: timeoutMs ?? GATE_TIMEOUT_MS,
      shell: true,
    },
    managed,
  );
}

/** 逐条 shell 执行质量检查，fail-fast：第一条失败即返回，不跑后续。 */
export async function runQualityChecks(
  checks: string[],
  cwd: string,
  timeoutMs: number | undefined,
  managed: ManagedGateContext,
): Promise<GateResult> {
  const started = Date.now();
  let ran = 0;
  for (const command of checks) {
    ran++;
    const failed = await runGateCommand(command, cwd, timeoutMs, managed);
    if (failed)
      return { ok: false, failure: failed, total: checks.length, ran, ms: Date.now() - started };
  }
  return { ok: true, failure: null, total: checks.length, ran, ms: Date.now() - started };
}

function nodeQualityPlatform(platform: NodeJS.Platform): QualityPlatform | null {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return null;
}

function allFrozenChecks(snapshot: FrozenQualityChecks): QualityCheck[] {
  const declared: QualityCheck[] = [];
  for (const category of ['test', 'build', 'static', 'security'] as const) {
    const policy = snapshot[category];
    if ('checks' in policy) declared.push(...policy.checks);
  }
  return declared;
}

function resolveContractCwd(projectRoot: string, cwd: string): string {
  const root = realpathSync(projectRoot);
  const target = realpathSync(resolve(root, cwd));
  const rel = relative(root, target);
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`命令工作目录解析到项目根之外：${cwd}`);
  }
  return target;
}

function shellArgs(shell: string, script: string): string[] {
  const name = basename(shell).toLowerCase();
  if (name === 'cmd' || name === 'cmd.exe') return ['/d', '/s', '/c', script];
  if (
    name === 'powershell' ||
    name === 'powershell.exe' ||
    name === 'pwsh' ||
    name === 'pwsh.exe'
  ) {
    return ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script];
  }
  return ['-c', script];
}

function commandSpec(
  command: QualityCommand,
  cwd: string,
  label: string,
): SpawnedGateSpec {
  return 'executable' in command
    ? {
        label,
        executable: command.executable,
        args: command.args,
        cwd,
        timeoutMs: command.timeoutMs,
        shell: false,
      }
    : {
        label,
        executable: command.shell,
        args: shellArgs(command.shell, command.script),
        cwd,
        timeoutMs: command.timeoutMs,
        shell: false,
      };
}

/** 在干净检出中执行质量契约显式确认的本地准备命令。 */
export async function runContractPrepareCommands(
  commands: readonly QualityCommand[],
  projectRoot: string,
  platform: QualityPlatform | null | undefined,
  managed: ManagedGateContext,
): Promise<ContractGateResult> {
  const started = Date.now();
  platform ??= nodeQualityPlatform(process.platform);
  if (platform === null) {
    return {
      ok: false,
      failure: {
        command: '[local-prepare:platform]',
        exitCode: null,
        timedOut: false,
        outputTail: `当前 Node 平台 ${process.platform} 未被质量契约支持`,
      },
      total: 0,
      ran: 0,
      ms: Date.now() - started,
      skipped: [],
    };
  }
  const applicable = commands.filter((command) => command.platforms.includes(platform));
  const skipped = commands
    .map((command, index) => ({ command, index }))
    .filter(({ command }) => !command.platforms.includes(platform))
    .map(({ index }) => `local-prepare-${index + 1}`);
  let ran = 0;
  for (const [index, command] of applicable.entries()) {
    ran += 1;
    let cwd: string;
    try {
      cwd = resolveContractCwd(projectRoot, command.cwd);
    } catch (error) {
      return {
        ok: false,
        failure: {
          command: `[local-prepare-${index + 1}]`,
          exitCode: null,
          timedOut: false,
          outputTail: error instanceof Error ? error.message : String(error),
        },
        total: applicable.length,
        ran,
        ms: Date.now() - started,
        skipped,
      };
    }
    const failure = await runSpawnedGate(
      commandSpec(command, cwd, `[local-prepare-${index + 1}]`),
      managed,
    );
    if (failure) {
      return {
        ok: false,
        failure,
        total: applicable.length,
        ran,
        ms: Date.now() - started,
        skipped,
      };
    }
  }
  return {
    ok: true,
    failure: null,
    total: applicable.length,
    ran,
    ms: Date.now() - started,
    skipped,
  };
}

/**
 * 按固定类别顺序执行质量契约中适用于当前系统的检查。结构化命令 shell=false；只有契约
 * 明确选择 shell 时才以该 executable 的原生 -c/-Command 入口执行。
 */
export async function runContractQualityChecks(
  checks: FrozenQualityChecks,
  projectRoot: string,
  platform: QualityPlatform | null | undefined,
  managed: ManagedGateContext,
): Promise<ContractGateResult> {
  const started = Date.now();
  platform ??= nodeQualityPlatform(process.platform);
  if (platform === null) {
    return {
      ok: false,
      failure: {
        command: '[platform]',
        exitCode: null,
        timedOut: false,
        outputTail: `当前 Node 平台 ${process.platform} 未被质量契约支持`,
      },
      total: 0,
      ran: 0,
      ms: Date.now() - started,
      skipped: [],
    };
  }
  const declared = allFrozenChecks(checks);
  const skipped = declared
    .filter((check) => !check.command.platforms.includes(platform))
    .map((check) => check.id);
  const applicable = declared.filter((check) => check.command.platforms.includes(platform));
  let ran = 0;
  for (const check of applicable) {
    ran += 1;
    let cwd: string;
    try {
      cwd = resolveContractCwd(projectRoot, check.command.cwd);
    } catch (error) {
      return {
        ok: false,
        failure: {
          command: `[${check.id}]`,
          exitCode: null,
          timedOut: false,
          outputTail: error instanceof Error ? error.message : String(error),
        },
        total: applicable.length,
        ran,
        ms: Date.now() - started,
        skipped,
      };
    }
    const spec = commandSpec(check.command, cwd, `[${check.id}]`);
    const failure = await runSpawnedGate(spec, managed);
    if (failure) {
      return {
        ok: false,
        failure,
        total: applicable.length,
        ran,
        ms: Date.now() - started,
        skipped,
      };
    }
  }
  return {
    ok: true,
    failure: null,
    total: applicable.length,
    ran,
    ms: Date.now() - started,
    skipped,
  };
}

function pad2(n: number): string {
  return String(n).padStart(2, '0');
}

/** 与 validator/progress 记录一致的本地时间戳：YYYY-MM-DD HH:mm */
function formatStamp(d: Date): string {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;
}

/**
 * 门禁失败打回（纯函数，不落盘）：与 validator 打回同构——passes 设回 false、
 * retryCount +1、达 MAX_RETRIES 转 blocked；notes 覆盖写失败详情，
 * 原有仲裁标签行（ARBITRATION_PREFIXES）原样保留在前（与 validator 的 notes 规则一致）。
 */
export function applyGateFailure(
  state: RunState,
  storyId: string,
  failure: GateFailure,
  now: Date,
): RunState {
  const prev = state[storyId] ?? INITIAL_STORY_STATE;
  const retryCount = prev.retryCount + 1;
  // agent 显式置过的 blocked 不被重算翻回（「停下等人」信号优先于机械重试推进）
  const blocked = prev.blocked || retryCount >= MAX_RETRIES;
  const arbitrationLines = prev.notes.split('\n').filter(isArbitrationLine);
  const failDesc = failure.timedOut ? '执行超时被终止' : `退出码 ${failure.exitCode}`;
  const lines = [
    ...arbitrationLines,
    `${GATE_FAIL_LINE_PREFIX} - 第${retryCount}次] ${formatStamp(now)}`,
    `- 失败命令：${failure.command}（${failDesc}）`,
    '- 输出尾部：',
    failure.outputTail,
  ];
  // 上限文案只描述「本次打回达到上限」——agent 预先置的 blocked 不适用该归因
  if (blocked && !prev.blocked)
    lines.push(`${BLOCKED_LINE_PREFIX}: 已达到最大重试次数，跳过此 story]`);
  return {
    ...state,
    [storyId]: {
      ...prev,
      passes: false,
      validated: false,
      validationReceipt: null,
      notes: lines.join('\n'),
      retryCount,
      blocked,
    },
  };
}

/**
 * 合法 passed claim 的状态收口（纯函数）：清掉瞬时失败并重置重试，但不签发
 * validated；receipt 仍须由 loop 在全部协议/绑定检查完成后单独签发。
 */
export function applyValidatorSuccess(state: RunState, storyId: string): RunState {
  const prev = state[storyId] ?? INITIAL_STORY_STATE;
  const arbitrationLines = prev.notes.split('\n').filter(isArbitrationLine);
  return {
    ...state,
    [storyId]: {
      ...prev,
      validated: false,
      validationReceipt: null,
      notes: arbitrationLines.join('\n'),
      retryCount: 0,
    },
  };
}

export interface ValidatorFailureClaim {
  checks: readonly ValidationCheck[];
  summary: string;
}

/**
 * 合法 failed claim 的状态收口（纯函数）：只有引擎执行 retry/blocked/verdict 写入。
 * notes 仅复制未通过 AC 的 claim 证据；完整逐项 claim 另存 append-only evidence。
 */
export function applyValidatorFailure(
  state: RunState,
  storyId: string,
  claim: ValidatorFailureClaim,
  now: Date,
): RunState {
  const prev = state[storyId] ?? INITIAL_STORY_STATE;
  const retryCount = prev.retryCount + 1;
  const blocked = prev.blocked || retryCount >= MAX_RETRIES;
  const arbitrationLines = prev.notes.split('\n').filter(isArbitrationLine);
  const failedChecks = claim.checks.filter((check) => !check.passed);
  const lines = [
    ...arbitrationLines,
    `${VALIDATOR_FAIL_LINE_PREFIX} - 第${retryCount}次] ${formatStamp(now)}`,
    ...failedChecks.map((check) => `- AC ${check.acIndex}：${check.evidence}`),
    `- Validator 总结：${claim.summary}`,
  ];
  if (blocked && !prev.blocked) {
    lines.push(`${BLOCKED_LINE_PREFIX}: 已达到最大重试次数，跳过此 story]`);
  }
  return {
    ...state,
    [storyId]: {
      ...prev,
      passes: false,
      validated: false,
      validationReceipt: null,
      notes: lines.join('\n'),
      retryCount,
      blocked,
    },
  };
}

export interface AbortInfo {
  side: 'builder' | 'validator';
  timedOut: boolean;
  exitCode: number | null;
}

/**
 * agent 异常结局的人读描述单源（notes 标记行与引擎回写警告共用）。
 * 非超时且 exitCode 为 null 只有一种来源：进程被外部信号终止（runAgent 的
 * exit 事件 code=null）——渲染「被信号终止」而非字面「退出码 null」。
 */
export function abortDesc(abort: Pick<AbortInfo, 'timedOut' | 'exitCode'>): string {
  if (abort.timedOut) return '执行超时被终止';
  return abort.exitCode === null ? '被信号终止' : `退出码 ${abort.exitCode}`;
}

/**
 * 异常轮回写（纯函数，不落盘）：agent 进程异常结局（超时/非零退出）的轮里
 * passes 被置 true 但未经完整验收——回写 false + 机械标记行，仲裁标签行保全在前。
 * 与 applyGateFailure 的关键差异：不涨 retryCount（中断≠能力不足，不触发 escalation）、
 * 不重算 blocked；prev.blocked 时原样返回（「停下等人」优先于机械回写）。
 */
export function applyAbortRollback(
  state: RunState,
  storyId: string,
  abort: AbortInfo,
  now: Date,
): RunState {
  const prev = state[storyId] ?? INITIAL_STORY_STATE;
  if (prev.blocked) return state;
  const arbitrationLines = prev.notes.split('\n').filter(isArbitrationLine);
  const lines = [
    ...arbitrationLines,
    `${ABORT_LINE_PREFIX} ${formatStamp(now)} ${abort.side} ${abortDesc(abort)}：本轮 passes 置位未经完整验收，已回写；请确认实现后重新走完门禁与验收`,
  ];
  return {
    ...state,
    [storyId]: {
      ...prev,
      passes: false,
      validated: false,
      validationReceipt: null,
      notes: lines.join('\n'),
      retryCount: prev.retryCount,
      blocked: prev.blocked,
    },
  };
}
