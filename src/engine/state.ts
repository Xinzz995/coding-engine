import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import type { Prd, Story } from './prd.js';

export interface StoryState {
  passes: boolean;
  notes: string;
  retryCount: number;
  blocked: boolean;
}

/** key = story id */
export type RunState = Record<string, StoryState>;

/** 仪表盘/展示用合并视图 */
export type StoryView = Story & StoryState;

export const INITIAL_STORY_STATE: StoryState = Object.freeze({
  passes: false, notes: '', retryCount: 0, blocked: false,
});

export function tryReadState(path: string): RunState | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as RunState;
  } catch {
    return null;
  }
}

// v0.4 及更早的 prd.json 把状态字段写在 story 上；这里读取它们用于迁移与离线回看，缺省按初始值。
function legacyStateOf(story: Story): StoryState {
  const s = story as Story & Partial<StoryState>;
  return {
    passes: s.passes ?? false,
    notes: s.notes ?? '',
    retryCount: s.retryCount ?? 0,
    blocked: s.blocked ?? false,
  };
}

export function initialStateFor(prd: Prd): RunState {
  const state: RunState = {};
  for (const s of prd.userStories) state[s.id] = legacyStateOf(s);
  return state;
}

// 启动时保证 state.json 存在：缺失则从 prd 初始化（含旧格式抽取迁移）并落盘。
// 文件存在但解析失败时不覆盖（留给 npx coding-x repair），内存中按初始值继续。
export function ensureStateFile(workspace: string, prd: Prd): RunState {
  const path = join(workspace, 'state.json');
  if (existsSync(path)) {
    return tryReadState(path) ?? initialStateFor(prd);
  }
  const state = initialStateFor(prd);
  writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');
  return state;
}

function storyStateOf(state: RunState, id: string): StoryState {
  return state[id] ?? INITIAL_STORY_STATE;
}

export function getCurrentStoryId(prd: Prd, state: RunState): string | null {
  for (const s of prd.userStories) {
    const st = storyStateOf(state, s.id);
    if (!st.passes && !st.blocked) return s.id;
  }
  return null;
}

export function allStoriesResolved(prd: Prd, state: RunState): boolean {
  return prd.userStories.every((s) => {
    const st = storyStateOf(state, s.id);
    return st.passes || st.blocked;
  });
}

// 只读合并（不落盘）：state 为 null 时回退读 story 上的旧格式字段，
// 让仪表盘对 v0.4 workspace 与历史归档的离线回看零迁移可用。
export function mergedStories(prd: Prd, state: RunState | null): StoryView[] {
  return prd.userStories.map((s) => ({
    ...s,
    ...(state ? storyStateOf(state, s.id) : legacyStateOf(s)),
  }));
}
