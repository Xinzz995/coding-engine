import type { Prd } from './prd.js';
import type { RunState } from './state.js';
import { INITIAL_STORY_STATE } from './state.js';

/** 打回上限的单一真相源：validator.md 经 {{MAX_RETRIES}} 占位符共享此值 */
export const MAX_RETRIES = 5;

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
 * 原有 [需求冲突] 行原样保留在前（与 validator 的 notes 规则一致）。
 */
export function applyGateFailure(
  state: RunState,
  storyId: string,
  failure: GateFailure,
  now: Date,
): RunState {
  const prev = state[storyId] ?? INITIAL_STORY_STATE;
  const retryCount = prev.retryCount + 1;
  const blocked = retryCount >= MAX_RETRIES;
  const conflictLines = prev.notes.split('\n').filter((l) => l.startsWith('[需求冲突]'));
  const failDesc = failure.timedOut ? '执行超时被终止' : `退出码 ${failure.exitCode}`;
  const lines = [
    ...conflictLines,
    `[门禁失败 - 第${retryCount}次] ${formatStamp(now)}`,
    `- 失败命令：${failure.command}（${failDesc}）`,
    '- 输出尾部：',
    failure.outputTail,
  ];
  if (blocked) lines.push('[BLOCKED: 已达到最大重试次数，跳过此 story]');
  return {
    ...state,
    [storyId]: { passes: false, notes: lines.join('\n'), retryCount, blocked },
  };
}
