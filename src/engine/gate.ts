import type { Prd } from './prd.js';
import type { RunState } from './state.js';
import { INITIAL_STORY_STATE } from './state.js';
import { spawn } from 'node:child_process';

/** 打回上限的单一真相源：validator.md 经 {{MAX_RETRIES}} 占位符共享此值 */
export const MAX_RETRIES = 5;

/**
 * 仲裁类标签前缀族的单一真相源：agent 请求人工裁决的 notes 行以这些前缀开头，
 * 打回与清理路径必须保全。消费方：applyGateFailure 过滤、status 醒目标记、
 * builder.md/validator.md 经 {{ARBITRATION_PREFIXES}} 占位符渲染（loop.ts renderInstruction）。
 */
export const ARBITRATION_PREFIXES = ['[需求冲突]', '[需要人工核实]'] as const;

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

export interface GateResult {
  ok: boolean;
  failure: GateFailure | null;
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
  return v.length === 0 ? null : (v as string[]);
}

/** 每条门禁命令的执行超时（10 分钟）；超时按失败打回，notes 注明 */
const GATE_TIMEOUT_MS = 600_000;
/** 打回 notes 只保留输出尾部——失败摘要在尾部，全量会污染 builder 每轮要读的 notes */
const OUTPUT_TAIL_CHARS = 2000;

function runOneCheck(command: string, cwd: string, timeoutMs: number): Promise<GateFailure | null> {
  return new Promise((resolve) => {
    // shell 语义：qualityChecks 是用户在 prd.json 亲手声明的完整命令行（如 `npm test -- --run`）。
    // patterns.md 的「不经 shell」约定针对代码拼接固定命令+变量参数的场景，不适用于此。
    const child = spawn(command, {
      cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'],
      // detached: 命令自成进程组——shell:true 下 child.kill 只达 shell 本身，
      // 超时必须对整组发信号，否则挂起的孙进程（npm 包裹的测试进程等）会泄漏
      detached: process.platform !== 'win32',
    });
    let tail = '';
    const keep = (chunk: Buffer) => {
      tail = (tail + String(chunk)).slice(-OUTPUT_TAIL_CHARS);
    };
    // tee：实时转发保证无人值守时进度可见，同时滚动缓冲尾部供打回 notes 用
    child.stdout.on('data', (c: Buffer) => { process.stdout.write(c); keep(c); });
    child.stderr.on('data', (c: Buffer) => { process.stderr.write(c); keep(c); });
    // 对整个进程组发信号（POSIX 负 pid）；win32 回退单进程 kill。进程可能已死（ESRCH）——忽略
    const killTree = (signal: NodeJS.Signals) => {
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, signal);
        else child.kill(signal);
      } catch { /* 已退出 */ }
    };
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      killTree('SIGTERM');
      // 组长（shell）先于孙进程退出是常态：不能在 exit 时取消升级，
      // 否则陷 SIGTERM 的孙进程永远等不到组 SIGKILL。unref 防空转 timer 拖住进程退出；
      // 组已全死时补刀是空操作（killTree 吞 ESRCH，win32 child.kill 对已退进程返回 false）
      setTimeout(() => killTree('SIGKILL'), 5000).unref();
      resolve({ command, exitCode: null, timedOut: true, outputTail: tail });
    }, timeoutMs);
    child.once('exit', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(code === 0 ? null : { command, exitCode: code, timedOut: false, outputTail: tail });
    });
    child.once('error', (err) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command, exitCode: null, timedOut: false, outputTail: err.message });
    });
  });
}

/** 逐条 shell 执行质量检查，fail-fast：第一条失败即返回，不跑后续。 */
export async function runQualityChecks(
  checks: string[],
  cwd: string,
  timeoutMs: number = GATE_TIMEOUT_MS,
): Promise<GateResult> {
  for (const command of checks) {
    const failed = await runOneCheck(command, cwd, timeoutMs);
    if (failed) return { ok: false, failure: failed };
  }
  return { ok: true, failure: null };
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
    `[门禁失败 - 第${retryCount}次] ${formatStamp(now)}`,
    `- 失败命令：${failure.command}（${failDesc}）`,
    '- 输出尾部：',
    failure.outputTail,
  ];
  // 上限文案只描述「本次打回达到上限」——agent 预先置的 blocked 不适用该归因
  if (blocked && !prev.blocked) lines.push('[BLOCKED: 已达到最大重试次数，跳过此 story]');
  return {
    ...state,
    [storyId]: { passes: false, notes: lines.join('\n'), retryCount, blocked },
  };
}
