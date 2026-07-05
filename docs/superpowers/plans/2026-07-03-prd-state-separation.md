---
title: "PRD 内容与状态分离（第二阶段 v0.5.0）实施计划"
status: done
updated: 2026-07-06
scope: root
---

# PRD 内容与状态分离（第二阶段 v0.5.0）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 落地 ADR-003 第二阶段：执行状态（passes/notes/retryCount/blocked）迁出到 `.workspace/state.json`（按 story id 键控），`prd.json` 运行期只读——agent 回写不再可能损坏需求内容，再派生天然不丢状态。

**Architecture:** 新增 `src/engine/state.ts` 承担状态读写、story 选取、完成判定与合并视图；`prd.ts` 回归纯需求读取（依赖方向 state → prd 单向）。引擎在启动时初始化 state.json，并自动从旧格式（状态写在 story 上的 v0.4 prd.json）抽取迁移；仪表盘用只读合并（state 缺失时回退读 story 上的旧字段），对 v0.4 workspace/归档的离线回看零迁移可用。builder/validator 回写目标改为 state.json；prd-to-json 不再产出状态字段。终审 fix-later 润色项按标注吸收进对应任务。

**Tech Stack:** TypeScript（strict, ESM/NodeNext）、Vitest、tsup；skills 与引擎指令为纯 markdown。

## Global Constraints

- `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）
- 每次提交前必须通过 `npm run typecheck` 与 `npm test`
- 提交说明必须用中文，conventional 类型前缀（feat:/fix:/docs:/release:）保留英文
- `skills/`、`commands/` 是唯一源；引擎运行时状态只读写 `--workspace` 目录（state.json 在该目录内，合规）
- 面向用户的破坏性变更（prd.json 产物不再含状态、agent 回写契约变化）：升 v0.5.0 并在 README 写迁移说明（硬约束 5）
- **向后兼容硬要求**：旧 workspace（prd.json 带状态字段、无 state.json）引擎首跑自动迁移；仪表盘离线回看旧 workspace/归档无需迁移（合并视图的 legacy 回退）
- 标记拼写不变：`sourcePrd`、`【溯源】`、`[需求冲突]`、`[需求已变更]` 逐字保留

## 名词与接口契约（全计划通用）

`src/engine/state.ts` 导出（Task 1 建立，后续任务只消费不改名）：

```ts
export interface StoryState { passes: boolean; notes: string; retryCount: number; blocked: boolean; }
export type RunState = Record<string, StoryState>;          // key = story id
export type StoryView = Story & StoryState;                  // 仪表盘合并视图
export const INITIAL_STORY_STATE: StoryState;                // { passes:false, notes:'', retryCount:0, blocked:false }
export function tryReadState(path: string): RunState | null;
export function initialStateFor(prd: Prd): RunState;         // 每个 story → 初始值；story 上带旧状态字段时抽取之（迁移）
export function ensureStateFile(workspace: string, prd: Prd): RunState;  // 无文件→写初始并返回；有文件→读之（坏文件不覆盖，内存回退初始）
export function getCurrentStoryId(prd: Prd, state: RunState): string | null;   // 从 prd.ts 迁来，改签名
export function allStoriesResolved(prd: Prd, state: RunState): boolean;        // 同上
export function mergedStories(prd: Prd, state: RunState | null): StoryView[];  // 只读合并；state 为 null 时回退 story 上的旧字段
```

- state 中缺失的 story id 一律按 `INITIAL_STORY_STATE` 处理（再派生新增 story 无需写 state）
- `state.json` 写入方：引擎仅在初始化/迁移时写一次；运行期回写全部由 agent 完成（与 prd.json 旧约相同）

---

### Task 1: state.ts 新模块（状态读写 + 选取判定 + 合并视图）

**Files:**
- Create: `src/engine/state.ts`
- Test: `src/engine/state.test.ts`

**Interfaces:**
- Consumes: `Prd`/`Story` 类型（`./prd.js`，此时 Story 仍含状态字段——本任务不改 prd.ts）
- Produces: 上方「名词与接口契约」的全部导出；Task 2/3/5 只 import 不重定义

- [ ] **Step 1: 写失败测试**

创建 `src/engine/state.test.ts`，完整内容：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  tryReadState, initialStateFor, ensureStateFile, mergedStories,
  getCurrentStoryId, allStoriesResolved, INITIAL_STORY_STATE, type RunState,
} from './state.js';
import type { Prd } from './prd.js';

// 用「纯内容 + 可选旧状态字段」的字面量造 PRD 并 cast：
// Task 4 之前 Story 类型仍含状态字段（必填），cast 让本测试在 Story 瘦身前后都成立。
function contentPrd(
  ids: string[],
  legacy: Record<string, Partial<{ passes: boolean; notes: string; retryCount: number; blocked: boolean }>> = {},
): Prd {
  return {
    project: 'p', branchName: 'ralph/x', description: 'd',
    userStories: ids.map((id, i) => ({
      id, title: 't', description: 'd', acceptanceCriteria: [], priority: i + 1,
      ...(legacy[id] ?? {}),
    })),
  } as Prd;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'state-'));
}

describe('tryReadState', () => {
  it('returns null for missing or invalid file', () => {
    expect(tryReadState('/no/such/state.json')).toBeNull();
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{ broken');
    expect(tryReadState(join(dir, 'state.json'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it('parses a valid file', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ 'US-001': { passes: true, notes: 'n', retryCount: 2, blocked: false } }));
    expect(tryReadState(file)?.['US-001'].retryCount).toBe(2);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('initialStateFor', () => {
  it('gives every story the initial state', () => {
    const s = initialStateFor(contentPrd(['US-001', 'US-002']));
    expect(s['US-001']).toEqual(INITIAL_STORY_STATE);
    expect(s['US-002']).toEqual(INITIAL_STORY_STATE);
  });
  it('extracts legacy state fields from v0.4-style stories (migration)', () => {
    const s = initialStateFor(contentPrd(['US-001'], { 'US-001': { passes: true, notes: 'x', retryCount: 3, blocked: true } }));
    expect(s['US-001']).toEqual({ passes: true, notes: 'x', retryCount: 3, blocked: true });
  });
});

describe('ensureStateFile', () => {
  it('creates state.json from the prd when missing', () => {
    const dir = tempDir();
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001'].passes).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))['US-001'].passes).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  it('returns the existing file untouched when present', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'US-001': { passes: true, notes: '', retryCount: 0, blocked: false } }));
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001'].passes).toBe(true); // 不被初始值覆盖
    rmSync(dir, { recursive: true, force: true });
  });
  it('does not overwrite a corrupted state.json (leave it to repair)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{ broken');
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001']).toEqual(INITIAL_STORY_STATE);            // 内存回退
    expect(readFileSync(join(dir, 'state.json'), 'utf-8')).toBe('{ broken'); // 文件原样
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('getCurrentStoryId / allStoriesResolved', () => {
  const prd = contentPrd(['US-001', 'US-002', 'US-003']);
  it('picks the first story that is neither passing nor blocked', () => {
    const state: RunState = {
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      'US-002': { passes: false, notes: '', retryCount: 5, blocked: true },
    };
    // US-003 不在 state 中 → 按初始状态可选
    expect(getCurrentStoryId(prd, state)).toBe('US-003');
    expect(allStoriesResolved(prd, state)).toBe(false);
  });
  it('resolves when every story passes or is blocked', () => {
    const state: RunState = {
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      'US-002': { passes: false, notes: '', retryCount: 5, blocked: true },
      'US-003': { passes: true, notes: '', retryCount: 0, blocked: false },
    };
    expect(getCurrentStoryId(prd, state)).toBeNull();
    expect(allStoriesResolved(prd, state)).toBe(true);
  });
});

describe('mergedStories', () => {
  it('overlays state onto content when state is present', () => {
    const state: RunState = { 'US-001': { passes: true, notes: 'ok', retryCount: 1, blocked: false } };
    const view = mergedStories(contentPrd(['US-001', 'US-002']), state);
    expect(view[0].passes).toBe(true);
    expect(view[0].notes).toBe('ok');
    expect(view[1].passes).toBe(false); // 缺失 id → 初始
  });
  it('falls back to legacy story fields when state is null (v0.4 离线回看)', () => {
    const view = mergedStories(contentPrd(['US-001'], { 'US-001': { passes: true } }), null);
    expect(view[0].passes).toBe(true);
  });
});
```

- [ ] **Step 2: 确认红灯**

```bash
npx vitest run src/engine/state.test.ts
```

预期：FAIL——`Cannot find module './state.js'`（模块尚不存在）。

- [ ] **Step 3: 实现**

创建 `src/engine/state.ts`，完整内容：

```ts
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
```

- [ ] **Step 4: 确认绿灯**

```bash
npm run typecheck && npm test
```

预期：typecheck 通过；全部测试 PASS（既有 39 + 本任务新增）。

- [ ] **Step 5: 提交**

```bash
git add src/engine/state.ts src/engine/state.test.ts
git commit -m "feat: 新增 state.ts——执行状态读写、story 选取、完成判定与合并视图"
```

---

### Task 2: loop.ts 接线（启动迁移 + 状态驱动判定）

**Files:**
- Modify: `src/engine/loop.ts`（import、prdPath 旁、try 块开头、每轮读取、完成判定）
- Test: `src/engine/loop.test.ts`（setup/story helper、4 个内联 fake、新增迁移用例）

**Interfaces:**
- Consumes: Task 1 的 `ensureStateFile`/`initialStateFor`/`tryReadState`/`getCurrentStoryId`/`allStoriesResolved`
- Produces: 循环行为——每轮以 state.json 判定当前 story 与完成；启动时自动迁移旧格式

- [ ] **Step 1: 改写测试（先红）**

`src/engine/loop.test.ts` 改动如下。

`setup()` 中 prd.json 的 story 由测试传入（保持不变），但顶部 `story()` helper 改为纯内容：

```ts
const story = (over: Record<string, unknown> = {}) => ({
  id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [],
  priority: 1, ...over,
});
```

五个「翻转 passes」的内联 fake（`returns 0 …`、`spawns the agent at the project root …`、`renders the actual workspace …`，以及 keepOpen 的两个用例）全部从"重写 prd.json"改为"写 state.json"。以 `returns 0` 用例为例，fake 体改为：

```ts
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
```

其余三个用例的 fake 同样把"写 prd.json 的 userStories"那段替换为上面这两行 `writeFileSync(state.json …)`（`fake-cwd.mjs` 保留 marker 写入行、`fake-prompt.mjs` 保留 prompt 捕获行，仅替换 prd 重写部分；keepOpen 两个用例的 fake 与 `returns 0` 用例相同）。

`returns 1 when stories never resolve` 用例不变（agent 什么都不写，state.json 由引擎初始化为全 false，循环跑满）。

新增迁移用例（放在 `describe('runLoop')` 末尾）：

```ts
  it('migrates legacy prd.json state fields into state.json on startup', async () => {
    // v0.4 旧格式：story 自带 passes:true 且无 state.json —— 引擎启动即抽取迁移，
    // 循环第一轮就判定全部完成并以 0 退出。
    const { workspace, instructionsDir } = setup([story({ passes: true, notes: '', retryCount: 0, blocked: false })]);
    process.env.CODING_X_CLAUDE_BIN = 'node -e process.exit(0)';
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const migrated = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(migrated['US-001'].passes).toBe(true);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
```

- [ ] **Step 2: 确认红灯**

```bash
npx vitest run src/engine/loop.test.ts
```

预期：改用 state.json 的用例 FAIL（引擎仍只看 prd.json，story 永不 resolve，退出码 1≠0）；迁移用例 FAIL（state.json 未生成）。

- [ ] **Step 3: 实现**

`src/engine/loop.ts` 五处修改。

import 行，原：

```ts
import { tryReadPrd, getCurrentStoryId, allStoriesResolved } from './prd.js';
```

改为：

```ts
import { tryReadPrd } from './prd.js';
import { ensureStateFile, initialStateFor, tryReadState, getCurrentStoryId, allStoriesResolved } from './state.js';
```

`const prdPath = join(cfg.workspace, 'prd.json');` 之后加：

```ts
  const statePath = join(cfg.workspace, 'state.json');
```

`try {` 之后、`const agentCwd = process.cwd();` 所在注释块之前加：

```ts
    // 启动时保证 state.json 存在：v0.4 及更早的 prd.json 把状态写在 story 上，
    // ensureStateFile 会把它们抽取成 state.json（一次性迁移）。
    const bootPrd = tryReadPrd(prdPath);
    if (bootPrd) ensureStateFile(cfg.workspace, bootPrd);
```

每轮开头，原：

```ts
      const before = tryReadPrd(prdPath);
      const currentStory = before ? getCurrentStoryId(before) : null;
```

改为：

```ts
      const before = tryReadPrd(prdPath);
      const beforeState = before ? (tryReadState(statePath) ?? initialStateFor(before)) : null;
      const currentStory = before && beforeState ? getCurrentStoryId(before, beforeState) : null;
```

完成判定，原：

```ts
      const after = tryReadPrd(prdPath);
      if (after && allStoriesResolved(after)) {
```

改为：

```ts
      const after = tryReadPrd(prdPath);
      const afterState = after ? (tryReadState(statePath) ?? initialStateFor(after)) : null;
      if (after && afterState && allStoriesResolved(after, afterState)) {
```

- [ ] **Step 4: 确认绿灯**

```bash
npm run typecheck && npm test
```

预期全绿（此时 prd.ts 的旧签名 selection 函数暂时无人引用但仍存在——Task 4 删除）。

- [ ] **Step 5: 提交**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: 主循环改由 state.json 驱动选取与完成判定，启动时自动迁移旧格式"
```

---

### Task 3: 仪表盘合并视图（含 v0.4 离线回看兼容）

**Files:**
- Modify: `src/dashboard/server.ts`（import 与 buildApiResponse）
- Test: `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `tryReadState`/`mergedStories`
- Produces: `/api/state` 的 `stories` 仍是「内容+状态」合一的对象数组——前端（assets/dashboard）零改动

- [ ] **Step 1: 改写测试（先红）**

`src/dashboard/server.test.ts` 的 `tempWorkspace()` 拆成两份文件：

```ts
function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({
    project: '任务应用', branchName: 'ralph/x', description: 'd',
    sourcePrd: 'docs/prds/prd-x.md',
    userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
  }));
  writeFileSync(join(dir, 'state.json'), JSON.stringify({
    'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
  }));
  writeFileSync(join(dir, 'progress.md'), '## US-001\n- done');
  return dir;
}
```

`describe('buildApiResponse')` 现有用例在 `expect(r.stories.length).toBe(1);` 之后追加合并断言：

```ts
    expect((r.stories[0] as { passes: boolean }).passes).toBe(true); // 状态来自 state.json
```

同一 describe 内新增 legacy 用例：

```ts
  it('falls back to legacy in-story state when state.json is absent (v0.4 workspace)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-legacy-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(join(dir, 'prd.json'), JSON.stringify({
      project: 'p', branchName: 'ralph/x', description: 'd',
      userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [],
        priority: 1, passes: true, notes: '', retryCount: 0, blocked: false }],
    }));
    writeFileSync(join(dir, 'progress.md'), '');
    configureWorkspace(dir, 50);
    const r = buildApiResponse();
    expect((r.stories[0] as { passes: boolean }).passes).toBe(true);
  });
```

- [ ] **Step 2: 确认红灯**

```bash
npx vitest run src/dashboard/server.test.ts
```

预期：合并断言 FAIL（`stories[0].passes` 为 undefined——prd.json 里已无状态字段而 server 尚未合并 state.json）。legacy 用例此时恰好 PASS（旧代码直接透传 story）——这是预期的不对称，记录进报告即可。

- [ ] **Step 3: 实现**

`src/dashboard/server.ts` import 区，原：

```ts
import { tryReadPrd } from '../engine/prd.js';
```

改为：

```ts
import { tryReadPrd } from '../engine/prd.js';
import { tryReadState, mergedStories } from '../engine/state.js';
```

`buildApiResponse()` 中，原：

```ts
  const prd = tryReadPrd(join(workspaceDir, 'prd.json'));
```

之后加一行（命名为 `runState`——server.ts 模块级已有运行时相位变量 `const state: State`，同名局部会遮蔽它并在 `state.startedAt` 处触发 TDZ 引用错误）：

```ts
  const runState = tryReadState(join(workspaceDir, 'state.json'));
```

返回对象中，原：

```ts
    stories: prd?.userStories ?? [],
```

改为：

```ts
    stories: prd ? mergedStories(prd, runState) : [],
```

- [ ] **Step 4: 确认绿灯**

```bash
npm run typecheck && npm test
```

预期全绿（`src/cli.test.ts` 的 `runDashboard` 用例用的就是旧格式 prd.json，它随本任务自动成为 legacy 回退的第二个活证据，不需要修改）。

- [ ] **Step 5: 提交**

```bash
git add src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat: 仪表盘输出内容+状态合并视图，旧格式 workspace 离线回看零迁移"
```

---

### Task 4: prd.ts 瘦身（Story 纯内容化）

**Files:**
- Modify: `src/engine/prd.ts`（Story 接口、删除 selection 函数）
- Test: `src/engine/prd.test.ts`

**Interfaces:**
- Consumes: 无新依赖
- Produces: `Story` = { id, title, description, acceptanceCriteria, priority }；`prd.ts` 仅导出 `Story`/`Prd`/`tryReadPrd`。selection 的唯一实现自此只在 `state.ts`

- [ ] **Step 1: 改写测试（先红）**

`src/engine/prd.test.ts` 整文件替换为：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryReadPrd, type Prd } from './prd.js';

function makePrd(stories: Array<Partial<Prd['userStories'][number]>>): Prd {
  return {
    project: 'p', branchName: 'ralph/x', description: 'd',
    userStories: stories.map((s, i) => ({
      id: s.id ?? `US-00${i + 1}`, title: 't', description: 'd',
      acceptanceCriteria: [], priority: s.priority ?? i + 1,
    })),
  };
}

describe('tryReadPrd', () => {
  it('returns null for missing/invalid file', () => {
    expect(tryReadPrd('/no/such/file.json')).toBeNull();
  });
  it('parses a valid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, JSON.stringify(makePrd([{ id: 'US-001' }])));
    expect(tryReadPrd(file)?.userStories[0].id).toBe('US-001');
    rmSync(dir, { recursive: true, force: true });
  });
  it('preserves sourcePrd when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, JSON.stringify({ ...makePrd([{ id: 'US-001' }]), sourcePrd: 'docs/prds/prd-x.md' }));
    expect(tryReadPrd(file)?.sourcePrd).toBe('docs/prds/prd-x.md');
    rmSync(dir, { recursive: true, force: true });
  });
});
```

（原 `getCurrentStoryId`/`allStoriesResolved` 两个 describe 块删除——Task 1 的 state.test.ts 已以新签名覆盖同等场景。）

- [ ] **Step 2: 确认红灯（typecheck 维度）**

```bash
npx vitest run src/engine/prd.test.ts && npm run typecheck
```

预期：vitest 本文件 PASS（运行时不校验多余字段），但 typecheck 仍通过——此步的"红"体现在下一步删除代码后才能锁定接口，因此本任务以 Step 3 完成后的 typecheck/全量测试为准；如 Step 3 前 typecheck 已报错，说明存在计划未预期的引用，STOP 上报。

- [ ] **Step 3: 实现**

`src/engine/prd.ts` 整文件替换为：

```ts
import { readFileSync } from 'node:fs';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
}

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  /** 意图真相源（源 PRD）的仓库相对路径；由 prd-to-json 写入，引擎只透传不解析 */
  sourcePrd?: string;
  userStories: Story[];
}

export function tryReadPrd(path: string): Prd | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Prd;
  } catch {
    return null;
  }
}
```

（执行状态字段与 selection 函数已迁往 `state.ts`——见 Task 1。）

- [ ] **Step 4: 确认绿灯**

```bash
npm run typecheck && npm test
```

预期全绿：loop/server 早已只从 `state.js` import selection（Task 2/3），此处删除不再有引用方；`state.ts` 的 `legacyStateOf` 用的是 `Partial<StoryState>` cast，不依赖 Story 上的状态字段。

- [ ] **Step 5: 提交**

```bash
git add src/engine/prd.ts src/engine/prd.test.ts
git commit -m "feat: Story 类型纯内容化，prd.ts 回归只读需求文件"
```

---

### Task 5: repair 双文件 + CLI 接线

**Files:**
- Modify: `src/engine/repair.ts`（新增 `repairWorkspaceFiles`）
- Modify: `src/cli.ts`（repair 分支）
- Test: `src/engine/repair.test.ts`

**Interfaces:**
- Consumes: 既有 `repairPrdFile`
- Produces: `repairWorkspaceFiles(workspace: string): string[]`——修 prd.json，state.json 存在则一并修，返回修复文件名列表；CLI `repair` 子命令输出改为列表

- [ ] **Step 1: 写失败测试**

`src/engine/repair.test.ts` 追加（import 行补 `repairWorkspaceFiles`）：

```ts
describe('repairWorkspaceFiles', () => {
  it('repairs prd.json and state.json when both exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-ws-'));
    writeFileSync(join(dir, 'prd.json'), '{ "userStories": [], }');
    writeFileSync(join(dir, 'state.json'), '{ "US-001": { "passes": true, }, }');
    const repaired = repairWorkspaceFiles(dir);
    expect(repaired).toEqual(['prd.json', 'state.json']);
    expect(JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf-8'))).toEqual({ userStories: [] });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))).toEqual({ 'US-001': { passes: true } });
    rmSync(dir, { recursive: true, force: true });
  });
  it('skips state.json when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-ws-'));
    writeFileSync(join(dir, 'prd.json'), '{ "userStories": [], }');
    expect(repairWorkspaceFiles(dir)).toEqual(['prd.json']);
    rmSync(dir, { recursive: true, force: true });
  });
});
```

- [ ] **Step 2: 确认红灯**

```bash
npx vitest run src/engine/repair.test.ts
```

预期：FAIL——`repairWorkspaceFiles` 未导出。

- [ ] **Step 3: 实现**

`src/engine/repair.ts` import 行改为：

```ts
import { readFileSync, writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { jsonrepair } from 'jsonrepair';
```

文件末尾追加：

```ts
// repair 子命令入口：prd.json 必修；state.json 存在才修（不存在不是错误）。
export function repairWorkspaceFiles(workspace: string): string[] {
  repairPrdFile(join(workspace, 'prd.json'));
  const repaired = ['prd.json'];
  const statePath = join(workspace, 'state.json');
  if (existsSync(statePath)) {
    repairPrdFile(statePath);
    repaired.push('state.json');
  }
  return repaired;
}
```

`src/cli.ts` 中，原：

```ts
import { repairPrdFile } from './engine/repair.js';
```

改为：

```ts
import { repairWorkspaceFiles } from './engine/repair.js';
```

原 repair 分支：

```ts
  if (cfg.command === 'repair') {
    repairPrdFile(join(cfg.workspace, 'prd.json'));
    console.log('✅ prd.json 已修复');
    return 0;
  }
```

改为：

```ts
  if (cfg.command === 'repair') {
    const repaired = repairWorkspaceFiles(cfg.workspace);
    console.log(`✅ 已修复: ${repaired.join('、')}`);
    return 0;
  }
```

（`join` 若在 cli.ts 中因此不再被其他代码使用则保留原 import 不动——它仍被 `instructionsDir` 使用。）

- [ ] **Step 4: 确认绿灯**

```bash
npm run typecheck && npm test
```

- [ ] **Step 5: 提交**

```bash
git add src/engine/repair.ts src/engine/repair.test.ts src/cli.ts
git commit -m "feat: repair 子命令同时修复 prd.json 与 state.json"
```

---

### Task 6: builder.md / validator.md 回写目标改 state.json

**Files:**
- Modify: `assets/instructions/builder.md`（5 处）
- Modify: `assets/instructions/validator.md`（3 处）

**Interfaces:**
- Consumes: state.json 契约（Task 1）；`[需求冲突]`/`[需求已变更]` 标记
- Produces: agent 回写契约——prd.json 只读、状态只写 state.json（吸收终审 fix-later #2：builder step 4 notes 前提句过时）

- [ ] **Step 1: builder.md 五处替换**

① 原：

```
以下文件都在 {{WORKSPACE}}/ 下: prd.json、progress.md
```

改为：

```
以下文件都在 {{WORKSPACE}}/ 下: prd.json（需求，只读）、state.json（执行状态）、progress.md（进度日志）
```

② 步骤 1，原：

```
1. 读取 `prd.json` 中的 PRD（与此文件在同一目录）
```

改为：

```
1. 读取 `prd.json` 中的需求与 `state.json` 中的执行状态（同一目录；state.json 或某个 story id 不存在时，视该 story 为未开始）
```

③ 步骤 4 整块（含缩进说明两行），原：

```
4. 选择满足以下所有条件的**最高 priority** 的 user story：
   - `passes: false`
   - `blocked: false`（或 blocked 字段不存在）
   
   如果该 story 的 `notes` 字段不为空，说明 Validator 上次验证发现了问题，
   请优先阅读 notes 中的失败原因，针对性地进行修复，而不是重新实现。
```

改为：

```
4. 选择满足以下所有条件的**最高 priority** 的 user story（passes/blocked 以 `state.json` 中该 story id 的记录为准；id 不存在视为未开始）：
   - `passes: false`
   - `blocked: false`
   
   如果该 story 在 `state.json` 的 `notes` 不为空——可能是 Validator 的失败记录、需求变更记录（`[需求已变更]`）或待人工裁决的需求冲突（`[需求冲突]`）——请先阅读并针对性处理，而不是重新实现。
```

④ 步骤 8，原：

```
8. 更新 PRD，将已完成的 story 的 `passes` 设置为 `true`
```

改为：

```
8. 更新 `state.json`，将已完成 story 对应 id 的 `passes` 设为 `true`（**不要修改 prd.json**——它是只读的需求文件）
```

⑤ 「需求来源与冲突处理」节，原：

```
如果你发现源文档与 acceptanceCriteria 冲突，或某条 acceptanceCriteria 无法成立：不要自行取舍、不要按源文档自由发挥——按 acceptanceCriteria 实现，并在该 story 的 `notes` 字段追加一行冲突记录（保留 notes 已有内容）：
```

改为：

```
如果你发现源文档与 acceptanceCriteria 冲突，或某条 acceptanceCriteria 无法成立：不要自行取舍、不要按源文档自由发挥——按 acceptanceCriteria 实现，并在 `{{WORKSPACE}}/state.json` 中该 story 的 `notes` 字段追加一行冲突记录（保留已有内容）：
```

- [ ] **Step 2: validator.md 三处替换**

① 步骤 4，原：

```
4. 读取 `{{WORKSPACE}}/prd.json`，找到该 story 的完整信息（acceptanceCriteria、retryCount 等）
```

改为：

```
4. 读取 `{{WORKSPACE}}/prd.json` 中该 story 的 acceptanceCriteria，以及 `{{WORKSPACE}}/state.json` 中该 story 的执行状态（retryCount 等；文件或 id 不存在视为初始状态）
```

② 步骤 6，原：

```
6. 根据验证结果，更新 `prd.json` 中该 story 的字段（见下方规则）
```

改为：

```
6. 根据验证结果，更新 `{{WORKSPACE}}/state.json` 中该 story 的字段（见下方规则；不要修改 prd.json）
```

③ 重要约束，原：

```
- 不要修改 prd.json 中除 passes、notes、retryCount、blocked 以外的任何字段
```

改为：

```
- **不得修改 prd.json**（只读需求文件）；只允许修改 state.json 中该 story 的 passes、notes、retryCount、blocked 四个字段
```

（「验证结果写入规则」小节的字段规则与 `[需求冲突]` 保全规则文本不动——字段名与语义不变，仅落盘文件变了，由上面①②③钉住。）

- [ ] **Step 3: 验证与提交**

```bash
grep -c "state.json" assets/instructions/builder.md     # 预期 ≥ 4
grep -c "state.json" assets/instructions/validator.md   # 预期 ≥ 3
grep -c "{{WORKSPACE}}" assets/instructions/builder.md assets/instructions/validator.md   # 占位符仍在
npm run build && grep -c "state.json" dist/instructions/builder.md   # 与源一致
npm run typecheck && npm test
git add assets/instructions/builder.md assets/instructions/validator.md
git commit -m "feat: builder/validator 指令——状态回写目标改为 state.json，prd.json 运行期只读"
```

---

### Task 7: prd-to-json——产物去状态化与再派生简化

**Files:**
- Modify: `skills/prd-to-json/SKILL.md`（frontmatter、输出格式、转换规则 #4、示例、归档、再派生整节、检查清单、末行 repair 提示）

**Interfaces:**
- Consumes: state.json 契约；`[需求冲突]`/`[需求已变更]` 标记
- Produces: prd.json 产物契约 v2（纯需求字段）；再派生规则 v2（吸收终审 fix-later #4 冲突行保全、#6 归档目录时间粒度与 frontmatter 说明）

- [ ] **Step 1: frontmatter description（吸收 fix-later #6b）**

原：

```
description: "将 PRD 转换为 prd.json 格式，供 Ralph 自主 agent 系统使用。当你已有 PRD 并需要将其转换为 Ralph 的 JSON 格式时使用。触发词：将prd 转成 prd.json"
```

改为：

```
description: "将 PRD 转换为 prd.json 格式供 Ralph 引擎执行，并把增强后的 stories 回写源 PRD（转换闭环）。当你已有 PRD 并需要将其转换为 Ralph 的 JSON 格式时使用。触发词：将prd 转成 prd.json"
```

- [ ] **Step 2: 输出格式与【溯源】段**

「## 输出格式」JSON 示例中 story 对象删除状态字段四行（`"passes": false,`、`"notes": "",`、`"retryCount": 0,`、`"blocked": false`），story 以 `"priority": 1` 结尾。两处【溯源】文案（输出格式 + 示例输出）中，原：

```
并把冲突写入该 story 的 notes（以 [需求冲突] 开头）
```

均改为：

```
并把冲突写入同目录 state.json 中该 story 的 notes（以 [需求冲突] 开头）
```

- [ ] **Step 3: 转换规则 #4**

原：

```
4. **所有 stories**：`passes: false`、空的 `notes`、`retryCount: 0`、`blocked: false`
```

改为：

```
4. **不写状态字段**：passes/notes/retryCount/blocked 一律不出现在 prd.json——执行状态由引擎在同目录 `state.json` 初始化与维护
```

- [ ] **Step 4: 示例输出去状态**

「## 示例」的输出 prd.json 中四个 story 各删除状态字段四行（story 均以 `"priority": n` 结尾）。

- [ ] **Step 5: 归档章节**

原：

```
   - 将当前的 `prd.json` 和 `progress.md` 复制到归档
```

改为：

```
   - 将当前的 `prd.json`、`state.json`（如存在）和 `progress.md` 复制到归档
```

- [ ] **Step 6: 再派生整节替换（吸收 fix-later #4、#6a）**

「## 再派生：需求中途变更」正文（标题保留）整体替换为：

```markdown
源 PRD 修改后重新执行本 skill，若 `.workspace/prd.json` 已存在且 `branchName` 与新转换结果**相同**（同一功能），进入再派生模式（branchName 不同则走上方「归档之前的运行」流程）：

1. 先把现有 `prd.json`（以及 `state.json`，如存在）复制到 `.workspace/archive/YYYY-MM-DD-HHmm-rederive-[feature-name]/`（带时分，避免同日多次再派生互相覆盖；`progress.md` 不动）
2. 用新转换结果**整体重写** `prd.json`（沿用源 id，纯需求字段——prd.json 不含状态）
3. 若 `state.json` 存在，按 story id 对齐调整它（不存在则跳过，引擎会自动初始化）：
   - id 相同且 acceptanceCriteria 无实质变化 → 该 id 状态原样保留
   - id 相同但 acceptanceCriteria 有实质变化 → 该 id 重置：passes 置 `false`、retryCount 置 `0`、blocked 置 `false`；notes 写入 `[需求已变更 YYYY-MM-DD] 验收标准已更新，按新标准重验（原 passes=true/false）`——若原 notes 中存在以 `[需求冲突]` 开头的行，将它们原样保留在新内容之前（未裁决的冲突不得因再派生而丢失）
   - 新增 id → 不写入 state.json（引擎按初始状态处理）
   - 源 md 已删除的 id → 从 state.json 移除该键，在对照表标注「已移除」
4. 输出对照表时增加「状态处理」列（保留/重置/新增/移除）

实质变化的判定：AC 条目的增删、断言内容的改变算；纯错别字/措辞润色不算。拿不准时按「有实质变化」处理（宁可重验，不可漏验）。
```

- [ ] **Step 7: 检查清单与末行**

检查清单，原：

```
- [ ] 每个 story 包含 `retryCount: 0` 和 `blocked: false` 字段
```

改为：

```
- [ ] story 不含任何状态字段（passes/notes/retryCount/blocked 均不出现，状态归 state.json）
```

末行，原：

```
写入 prd.json 后运行：`npx coding-x repair`（引擎会用 jsonrepair 修复并二次校验）。
```

改为：

```
写入后运行：`npx coding-x repair`（用 jsonrepair 修复并二次校验 prd.json 与 state.json，后者不存在则跳过）。
```

- [ ] **Step 8: 验证与提交**

```bash
grep -c "state.json" skills/prd-to-json/SKILL.md          # 预期 ≥ 7
grep -rn '"passes"' skills/prd-to-json/SKILL.md | cat      # 预期无输出（示例中状态字段清零）
npm run typecheck && npm test
git add skills/prd-to-json/SKILL.md
git commit -m "feat: prd-to-json 产物去状态化——状态归 state.json，再派生规则随之简化"
```

---

### Task 8: 文档同步（README / 架构地图）

**Files:**
- Modify: `README.md`（工作原理段、流程图两行、状态共享 bullet、结构示例、repair/workspace 说明、目录树）
- Modify: `docs/architecture.md`（模块表、依赖方向、数据流）

**Interfaces:**
- Consumes: 前述全部契约
- Produces: 用户可见的三文件模型与 v0.4→v0.5 迁移说明（吸收终审 fix-later #3：两处 notes 描述）

- [ ] **Step 1: README 工作原理段**

原（第 30 行）：

```
引擎在项目根目录启动，围绕工作区里的两份文件运转：`prd.json`（需求与状态）和 `progress.md`（进度与学习日志）。`prd.json` 是 `docs/prds/` 源 PRD 的派生物：md 是**意图真相源**（人写人审，需求变更改它），`prd.json` 是**执行真相源**（机器与 agent 读写）；两者冲突时以 md 为准重新派生（见 `docs/decisions/003-prd-layered-truth.md`）。
```

改为：

```
引擎在项目根目录启动，围绕工作区里的三份文件运转：`prd.json`（需求，运行期只读）、`state.json`（执行状态，按 story id 键控，agent 回写）和 `progress.md`（进度与学习日志）。`prd.json` 是 `docs/prds/` 源 PRD 的派生物：md 是**意图真相源**（人写人审，需求变更改它），`prd.json` + `state.json` 是**执行真相源**（机器与 agent 读写）；需求冲突时以 md 为准重新派生（见 `docs/decisions/003-prd-layered-truth.md`）。旧版 workspace（状态写在 prd.json 里、无 state.json）在 v0.5.0 引擎首次运行时自动抽取迁移，无需手工处理。
```

- [ ] **Step 2: 流程图两行（吸收 fix-later #3a）**

Developer 框第 1 行，原：

```
   │   │ 1. 读 prd.json，选优先级最高、未完成、未阻塞的 story │ │
```

改为（保持右侧边框列对齐，必要时增删行内空格）：

```
   │   │ 1. 读 prd.json+state.json，选最高优先级未完成 story │ │
```

Validator 框第 3 行，原：

```
   │   │ 3. 通过 → 清空 notes、retryCount 归零               │ │
```

改为（同样保持边框对齐）：

```
   │   │ 3. 通过 → 清理 notes（留[需求冲突]行）、重试归零     │ │
```

- [ ] **Step 3: 状态共享 bullet**

原（第 62 行）：

```
- **状态共享**：引擎与 agent 都在项目根目录运行，读写同一份 `prd.json` / `progress.md`；指令模板用 `{{WORKSPACE}}` 占位符注入实际工作区路径。
```

改为：

```
- **状态共享**：引擎与 agent 都在项目根目录运行，读写同一组 `prd.json` / `state.json` / `progress.md`（需求只读，状态写 state.json）；指令模板用 `{{WORKSPACE}}` 占位符注入实际工作区路径。
```

- [ ] **Step 4: 结构示例拆两块（吸收 fix-later #3b）**

「`prd.json` 结构：」代码块中 story 删除四行状态字段及其注释（`"priority": 1` 行保留注释、行尾逗号删除），代码块之后、「引擎每轮选择…」之前插入：

````markdown
`state.json` 结构（引擎首跑自动生成；旧版含状态字段的 prd.json 会被自动抽取迁移）：

```jsonc
{
  "US-001": {
    "passes": false,      // 开发完成后置 true
    "notes": "",          // 验证失败原因 / [需求冲突] / [需求已变更] 记录
    "retryCount": 0,      // 失败重试次数
    "blocked": false      // 累计失败 5 次后置 true，跳过
  }
}
```
````

「引擎每轮选择 `priority` 最高、`passes: false` 且 `blocked: false` 的 story。」句末追加「（状态读自 `state.json`）」。

- [ ] **Step 5: repair 与 workspace 说明三处**

命令示例行，原：

```
npx coding-x repair             # 仅修复 .workspace/prd.json（不跑循环）
```

改为：

```
npx coding-x repair             # 修复 .workspace/ 下的 prd.json 与 state.json（不跑循环）
```

参数表 repair 行，原：

```
| 位置参数 `repair` | — | 仅修复 `<workspace>/prd.json` 后退出 |
```

改为：

```
| 位置参数 `repair` | — | 修复 `<workspace>/` 下的 prd.json 与 state.json 后退出 |
```

参数表 `--workspace` 行说明 `prd.json / progress.md 所在目录` 改为 `prd.json / state.json / progress.md 所在目录`；特性 bullet「**prd.json 修复**：`npx coding-x repair` 用 `jsonrepair` 修复被 agent 写坏的 JSON。」改为「**JSON 修复**：`npx coding-x repair` 用 `jsonrepair` 修复被 agent 写坏的 `prd.json` / `state.json`。」

- [ ] **Step 6: README 目录树**

原：

```
│   │   ├── prd.ts                #   读取 prd.json、选 story、完成判定
```

改为：

```
│   │   ├── prd.ts                #   读取 prd.json（需求内容）
│   │   ├── state.ts              #   state.json 读写、选 story、完成判定、合并视图
```

同一树中 repair 行说明 `jsonrepair 修复 prd.json` 改为 `jsonrepair 修复 prd.json / state.json`。

- [ ] **Step 7: docs/architecture.md 三处**

模块表，原：

```
| PRD 读写 | `src/engine/prd.ts` | 读 prd.json、选 story、完成判定 |
```

改为两行：

```
| PRD 读取 | `src/engine/prd.ts` | 读 prd.json（需求内容） |
| 执行状态 | `src/engine/state.ts` | state.json 读写与迁移、选 story、完成判定、合并视图 |
```

模块表修复行说明 `jsonrepair 修复 prd.json` 改为 `jsonrepair 修复 prd.json / state.json`。依赖方向段中 `dashboard 反向只读 \`engine/prd.ts\`、\`engine/progress.ts\` 取数据` 改为 `dashboard 反向只读 \`engine/prd.ts\`、\`engine/state.ts\`、\`engine/progress.ts\` 取数据`；括号内引擎模块列表 `（loop → agent / prd / progress / repair）` 改为 `（loop → agent / prd / state / progress / repair）`。

数据流段整段（v0.4 版）替换为：

```
`.workspace/` 里三份文件贯穿全程：`prd.json`（需求，由 `docs/prds/` 源 PRD 经 prd-to-json 派生，顶层 `sourcePrd` 记录来源，运行期只读）、`state.json`（执行状态，按 story id 键控，引擎首跑初始化并自动从旧格式迁移，agent 回写）与 `progress.md`（日志+学习）。分层真相源（ADR-003）：md 是意图真相（人改），prd.json+state.json 是执行真相（机器改），冲突以 md 为准再派生，执行状态永不回流 md。builder 实现单个 story 并回写 state.json/progress.md → validator 逐条核对 acceptanceCriteria 并回写 passes/notes/retryCount/blocked → 循环直到全部 passes 或 blocked。
```

frontmatter `updated` 更新为执行当天日期（若已是则不动，报告注明）。

- [ ] **Step 8: 验证与提交**

```bash
npm run typecheck && npm test
git add README.md docs/architecture.md
git commit -m "docs: README/架构地图同步三文件模型（prd.json 只读 + state.json 状态 + progress.md）"
```

---

### Task 9: 发版 v0.5.0（含 package-lock 同步）

**Files:**
- Modify: `package.json`、`.claude-plugin/plugin.json`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`（0.4.0 → 0.5.0）
- Modify: `package-lock.json`（经 `npm install --package-lock-only` 同步——吸收终审 fix-later #5：锁文件版本自 0.1.0 起漂移）

**Interfaces:**
- Consumes: 前面全部任务已合入
- Produces: v0.5.0（prd.json 产物与 agent 契约变化，硬约束 5）

- [ ] **Step 1: 升版本号**

四个清单中 `"version": "0.4.0"` 全部改为 `"version": "0.5.0"`，然后：

```bash
npm install --package-lock-only
```

预期：`package-lock.json` 顶部两处 version 同步为 0.5.0，无依赖变更。

- [ ] **Step 2: 全量验证**

```bash
npm run typecheck && npm test && npm run build
grep -rn '"version"' package.json .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex-plugin/plugin.json | grep -v lock
head -4 package-lock.json
```

预期：三连全绿；四清单均 0.5.0；lock 文件 version 0.5.0。

- [ ] **Step 3: 提交**

```bash
git add package.json package-lock.json .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex-plugin/plugin.json
git commit -m "release: v0.5.0"
```

发布动作（维护者手动）：`git tag v0.5.0 && git push origin v0.5.0`（CI 自动 npm publish + GitHub Release）。

---

## 终审 fix-later 项吸收对照

| 终审遗留项 | 吸收位置 |
|---|---|
| builder step4 notes 前提句过时 | Task 6 ③ |
| README 流程图/结构示例 notes 描述 | Task 8 Step 2/4 |
| 再派生对 `[需求冲突]` 行的覆盖语义未写明 | Task 7 Step 6（显式保全） |
| rederive 归档目录同日覆盖 | Task 7 Step 6（目录名加 HHmm） |
| prd-to-json frontmatter 未提回写行为 | Task 7 Step 1 |
| package-lock 版本漂移（0.1.0 起预存） | Task 9 Step 1 |
| v0.4.0 计划检查清单「顺延最大编号」措辞 | 不动（历史执行记录，accept） |
