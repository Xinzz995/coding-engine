import { readFileSync, existsSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
import { join } from 'node:path';
import type { Prd, Story } from './prd.js';

export interface StoryState {
  passes: boolean;
  /** validator 已被引擎机械观察为正常完成；仅引擎可修改。 */
  validated: boolean;
  notes: string;
  retryCount: number;
  blocked: boolean;
  /** 首次有效失败已触发专用升级路由；仅引擎可修改。 */
  escalated: boolean;
}

/** key = story id */
export type RunState = Record<string, StoryState>;

/** 仪表盘/展示用合并视图 */
export type StoryView = Story & StoryState;

export const INITIAL_STORY_STATE: Readonly<StoryState> = Object.freeze({
  passes: false, validated: false, notes: '', retryCount: 0, blocked: false, escalated: false,
});

function normalizeStoryState(v: unknown): StoryState | null {
  if (typeof v !== 'object' || v === null) return null;
  const s = v as Record<string, unknown>;
  if (typeof s.passes !== 'boolean' || typeof s.notes !== 'string'
    || typeof s.retryCount !== 'number' || typeof s.blocked !== 'boolean'
    || (s.validated !== undefined && typeof s.validated !== 'boolean')
    || (s.escalated !== undefined && typeof s.escalated !== 'boolean')) return null;
  return {
    passes: s.passes,
    // v0.24.0 及更早 state 没有该字段：历史 passes=true 已被旧引擎当作最终通过，
    // 为避免升级后全量重验，内存按 passes 兼容；只读不触发迁移写。
    // 凭证不能脱离候选通过态单独存活；显式 false/true 组合按 false 归一，
    // 下一次 agent 写回时所有权恢复会把磁盘中的陈旧 true 一并清掉。
    validated: !s.blocked && s.passes && (s.validated === undefined ? true : s.validated),
    notes: s.notes,
    retryCount: s.retryCount,
    blocked: s.blocked,
    // v0.22.0 及更早 state 没有该字段：内存归一但不因读取立刻重写文件。
    escalated: s.escalated ?? false,
  };
}

export function tryReadState(path: string): RunState | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const state: RunState = {};
    for (const [id, raw] of Object.entries(parsed as Record<string, unknown>)) {
      const normalized = normalizeStoryState(raw);
      if (!normalized) return null;
      state[id] = normalized;
    }
    return state;
  } catch {
    return null;
  }
}

export interface EngineOwnedFields {
  validated: boolean | 'missing';
  escalated: boolean | 'missing';
}

/**
 * 读取磁盘原始所有权字段，不做 legacy 缺省归一。
 * loop 用它区分“字段缺失”和“字段值恰好等于兼容缺省”，确保删除也能留痕。
 */
export function tryReadEngineOwnedFields(path: string, storyId: string): EngineOwnedFields | null {
  try {
    const parsed = JSON.parse(readFileSync(path, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const raw = (parsed as Record<string, unknown>)[storyId];
    if (raw === undefined) return { validated: 'missing', escalated: 'missing' };
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
    const story = raw as Record<string, unknown>;
    const validated = story.validated === undefined ? 'missing' : story.validated;
    const escalated = story.escalated === undefined ? 'missing' : story.escalated;
    if ((validated !== 'missing' && typeof validated !== 'boolean')
        || (escalated !== 'missing' && typeof escalated !== 'boolean')) return null;
    return { validated, escalated };
  } catch {
    return null;
  }
}

// v0.4 及更早的 prd.json 把状态字段写在 story 上；这里读取它们用于迁移与离线回看，缺省按初始值。
function legacyStateOf(story: Story): StoryState {
  const s = story as Story & Partial<StoryState>;
  const passes = s.passes ?? false;
  const blocked = s.blocked ?? false;
  return {
    passes,
    validated: passes && !blocked,
    notes: s.notes ?? '',
    retryCount: s.retryCount ?? 0,
    blocked,
    escalated: false,
  };
}

export function initialStateFor(prd: Prd): RunState {
  const state: RunState = {};
  for (const s of prd.userStories) state[s.id] = legacyStateOf(s);
  return state;
}

// 运行期回退用：不读 story 上的 legacy 字段（防止已迁移的旧状态“复活”），全部按初始值。
export function blankStateFor(prd: Prd): RunState {
  const state: RunState = {};
  for (const s of prd.userStories) state[s.id] = INITIAL_STORY_STATE;
  return state;
}

export interface DisplayStateRead {
  state: RunState;
  /** state.json 存在但解析失败/形状非法；文件缺失是合法的 legacy 回退。 */
  stateCorrupted: boolean;
}

/**
 * status/dashboard/report 的展示状态单源：文件缺失才迁移旧版内嵌字段；
 * 文件存在但损坏时全部按未验证显示，绝不复活 legacy 通过态。
 */
export function readDisplayState(path: string, prd: Prd): DisplayStateRead {
  const stateExists = existsSync(path);
  const rawState = stateExists ? tryReadState(path) : null;
  const stateCorrupted = stateExists && rawState === null;
  return {
    state: stateCorrupted ? blankStateFor(prd) : rawState ?? initialStateFor(prd),
    stateCorrupted,
  };
}

// 启动时保证 state.json 存在：缺失则从 prd 初始化（含旧格式抽取迁移）并落盘。
// 文件存在但解析失败时不覆盖（留给 npx coding-x repair），内存中按初始值继续。
export function ensureStateFile(workspace: string, prd: Prd): RunState {
  const path = join(workspace, 'state.json');
  if (existsSync(path)) {
    return tryReadState(path) ?? initialStateFor(prd);
  }
  const state = initialStateFor(prd);
  writeFileAtomicSync(path, JSON.stringify(state, null, 2));
  return state;
}

function storyStateOf(state: RunState, id: string): StoryState {
  return state[id] ?? INITIAL_STORY_STATE;
}

/** 对外统一的有效通过判定：非 blocked + builder 声明 + engine 验收凭证缺一不可。 */
export function isStoryPassed(state: Pick<StoryState, 'passes' | 'validated' | 'blocked'>): boolean {
  return !state.blocked && state.passes && state.validated;
}

export interface EscalatedTamper {
  expected: boolean;
  received: boolean | 'missing';
}

export interface ValidatedTamper {
  expected: boolean;
  received: boolean | 'missing';
}

/** 恢复 agent 写回前的引擎独占值；无篡改时保持同一 state 引用。 */
export function restoreEscalated(
  state: RunState,
  storyId: string,
  expected: boolean,
  fallback?: StoryState,
  observed?: boolean | 'missing',
): { state: RunState; tamper: EscalatedTamper | null } {
  const current = state[storyId];
  if (!current) {
    if (!fallback) return { state, tamper: null };
    return {
      state: { ...state, [storyId]: { ...fallback, escalated: expected } },
      tamper: { expected, received: 'missing' },
    };
  }
  const received = observed ?? current.escalated;
  if (received === expected) return { state, tamper: null };
  return {
    state: { ...state, [storyId]: { ...current, escalated: expected } },
    tamper: { expected, received },
  };
}

/** 恢复 agent 写回前的验收凭证；无篡改时保持同一 state 引用。 */
export function restoreValidated(
  state: RunState,
  storyId: string,
  expected: boolean,
  fallback?: StoryState,
  observed?: boolean | 'missing',
): { state: RunState; tamper: ValidatedTamper | null } {
  const current = state[storyId];
  if (!current) {
    if (!fallback) return { state, tamper: null };
    return {
      state: { ...state, [storyId]: { ...fallback, validated: expected } },
      tamper: { expected, received: 'missing' },
    };
  }
  const received = observed ?? current.validated;
  if (received === expected) return { state, tamper: null };
  return {
    state: { ...state, [storyId]: { ...current, validated: expected } },
    tamper: { expected, received },
  };
}

/** 结构化 Validator passed claim 通过目标/协议/state 检查且候选仍通过时，由引擎签发。 */
export function issueValidationReceipt(
  state: RunState,
  storyId: string,
): { state: RunState; changed: boolean } {
  const current = state[storyId];
  if (!current || !current.passes || current.blocked || current.validated) {
    return { state, changed: false };
  }
  return {
    state: { ...state, [storyId]: { ...current, validated: true } },
    changed: true,
  };
}

/** 未签发凭证的 passes 不能跨轮；保留 notes/retry/blocked/escalated。 */
export function rollbackUnvalidatedPass(
  state: RunState,
  storyId: string,
): { state: RunState; changed: boolean } {
  const current = state[storyId];
  if (!current || !current.passes || current.validated || current.blocked) {
    return { state, changed: false };
  }
  return {
    state: { ...state, [storyId]: { ...current, passes: false, validated: false } },
    changed: true,
  };
}

/** 启动恢复：进程若在 builder 与 validator 之间中断，显式待验收 true 回写为可重试态。 */
export function rollbackUnvalidatedPasses(
  state: RunState,
): { state: RunState; storyIds: string[] } {
  let next = state;
  const storyIds: string[] = [];
  for (const id of Object.keys(state)) {
    const rolled = rollbackUnvalidatedPass(next, id);
    if (!rolled.changed) continue;
    next = rolled.state;
    storyIds.push(id);
  }
  return { state: next, storyIds };
}

/** 首次有效失败后置位；没有专用升级目标时保持不变，且从不修改 retryCount。 */
export function enableEscalation(
  state: RunState,
  storyId: string,
  hasDedicatedTarget: boolean,
): { state: RunState; changed: boolean } {
  const current = state[storyId];
  if (!hasDedicatedTarget || !current || current.escalated) return { state, changed: false };
  return {
    state: { ...state, [storyId]: { ...current, escalated: true } },
    changed: true,
  };
}

export function getCurrentStoryId(prd: Prd, state: RunState): string | null {
  for (const s of prd.userStories) {
    const st = storyStateOf(state, s.id);
    if (!isStoryPassed(st) && !st.blocked) return s.id;
  }
  return null;
}

export function allStoriesResolved(prd: Prd, state: RunState): boolean {
  return prd.userStories.every((s) => {
    const st = storyStateOf(state, s.id);
    return isStoryPassed(st) || st.blocked;
  });
}

// 只读合并（不落盘）：state 为 null 时回退读 story 上的旧格式字段。
// 消费方区分缺失/损坏时应先走 readDisplayState，避免损坏态复活 legacy 字段。
export function mergedStories(prd: Prd, state: RunState | null): StoryView[] {
  return prd.userStories.map((s) => ({
    ...s,
    ...(state ? storyStateOf(state, s.id) : legacyStateOf(s)),
  }));
}
