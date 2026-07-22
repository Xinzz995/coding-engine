---
title: "异常轮语义实施计划（findings A-D 吸收轮）"
status: done
updated: 2026-07-20
scope: root
---

# 异常轮语义实施计划（findings A-D 吸收轮，v0.22.0）

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引擎识别 agent 进程异常结局（超时/非零退出）并回写未验收的 passes 翻转、每轮必留一条 iteration 记录、no-op 空转检测与连续无进展熔断、blocked 收敛文案分叉 + exit 3。

**Architecture:** spec 见 `docs/superpowers/specs/2026-07-17-agent-abort-semantics-design.md`。四组件全部落在既有文件：`gate.ts`（纯函数 applyAbortRollback，与 applyGateFailure 共享保全构件）、`evidence.ts`（iteration 可选字段）、`loop.ts`（结局判定/回写接线/no-op+stall/收敛分叉）、`cli.ts`（--stall-limit）、`report/render.ts`（outcome 标注）。

**Tech Stack:** TypeScript strict/ESM（相对导入必须 `.js` 后缀）、Vitest（fake-agent 架构：`CODING_X_CLAUDE_BIN` 注入 stub 脚本）、writeFileAtomicSync（关键 JSON 落盘约定）。

## Global Constraints

- 每任务提交前 `npm run typecheck` 与 `npm test` 必须全绿（AGENTS.md 硬约束 1）
- `src/` 内相对导入写 `.js` 扩展名（硬约束 2）
- 提交说明中文，conventional 前缀保留英文（硬约束 6）
- state.json 覆盖写一律 `writeFileAtomicSync`（patterns.md 2026-07-16 约定）
- 机械信号原则：引擎不解析 agent 输出，只用 timedOut/exitCode/文件内容对比
- evidence 新字段全部可选——旧 evidence.jsonl 读取与渲染零破坏（0.20 先例）
- 异常轮回写**不涨 retryCount**（中断≠能力不足，不触发 escalation）
- 测试禁墙钟采样断言（0.21.0 keepOpen 教训）；fake 脚本行为需推演引擎真实分支，防 spawn 真 agent

---

### Task 1: gate.ts — applyAbortRollback 纯函数与 ABORT_LINE_PREFIX

**Files:**
- Modify: `src/engine/gate.ts`（applyGateFailure 之后追加；`GATE_FAIL_LINE_PREFIX` 常量区补一条）
- Test: `src/engine/gate.test.ts`（文件已存在，追加 describe）

**Interfaces:**
- Consumes: 既有 `RunState`/`INITIAL_STORY_STATE`（`./state.js`）、既有私有 `formatStamp(d: Date)`、既有 `isArbitrationLine(line)`
- Produces: `export const ABORT_LINE_PREFIX = '[中断轮待复核]'`；`export interface AbortInfo { side: 'builder' | 'validator'; timedOut: boolean; exitCode: number | null }`；`export function applyAbortRollback(state: RunState, storyId: string, abort: AbortInfo, now: Date): RunState`——Task 3/4 的 loop 接线与 Task 7 的 render 高亮消费

- [ ] **Step 1: 写失败测试**（`src/engine/gate.test.ts` 末尾追加；文件顶部 import 行补 `applyAbortRollback, ABORT_LINE_PREFIX`——从 `./gate.js`）

```ts
describe('applyAbortRollback', () => {
  const at = new Date('2026-07-17T10:00:00');

  it('回写 passes=false 并写入中断标记行；retryCount 与 blocked 不动', () => {
    const state = { 'US-001': { passes: true, notes: '', retryCount: 2, blocked: false } };
    const next = applyAbortRollback(state, 'US-001', { side: 'builder', timedOut: true, exitCode: null }, at);
    expect(next['US-001'].passes).toBe(false);
    expect(next['US-001'].retryCount).toBe(2);
    expect(next['US-001'].blocked).toBe(false);
    expect(next['US-001'].notes).toContain(ABORT_LINE_PREFIX);
    expect(next['US-001'].notes).toContain('builder');
    expect(next['US-001'].notes).toContain('执行超时被终止');
    // 不可变：原 state 不被就地修改
    expect(state['US-001'].passes).toBe(true);
  });

  it('error 结局的标记行含退出码', () => {
    const state = { 'US-001': { passes: true, notes: '', retryCount: 0, blocked: false } };
    const next = applyAbortRollback(state, 'US-001', { side: 'validator', timedOut: false, exitCode: 143 }, at);
    expect(next['US-001'].notes).toContain('validator');
    expect(next['US-001'].notes).toContain('退出码 143');
  });

  it('保全既有仲裁标签行在标记行之前', () => {
    const state = { 'US-001': { passes: true, notes: '[需求冲突] AC2 与源 PRD 矛盾\n其他记录', retryCount: 0, blocked: false } };
    const next = applyAbortRollback(state, 'US-001', { side: 'builder', timedOut: true, exitCode: null }, at);
    const lines = next['US-001'].notes.split('\n');
    expect(lines[0]).toBe('[需求冲突] AC2 与源 PRD 矛盾');
    expect(lines[1].startsWith(ABORT_LINE_PREFIX)).toBe(true);
    expect(next['US-001'].notes).not.toContain('其他记录');
  });

  it('prev.blocked 时原样返回不回写（停下等人信号优先）', () => {
    const state = { 'US-001': { passes: true, notes: '[需要人工核实] x', retryCount: 1, blocked: true } };
    const next = applyAbortRollback(state, 'US-001', { side: 'builder', timedOut: true, exitCode: null }, at);
    expect(next).toBe(state);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/gate.test.ts 2>&1 | tail -8`
Expected: FAIL——`applyAbortRollback` 未导出（import 报错或 undefined is not a function）

- [ ] **Step 3: 实现**（`src/engine/gate.ts`，applyGateFailure 函数之后追加；常量区 `BLOCKED_LINE_PREFIX` 下一行加 `ABORT_LINE_PREFIX`）

```ts
/**
 * 中断轮回写的 notes 行前缀单源。生产方：applyAbortRollback；
 * 消费方：report/render.ts 行分类高亮。标记文本自带下轮指令，builder 读 notes 即知处置。
 */
export const ABORT_LINE_PREFIX = '[中断轮待复核]';

export interface AbortInfo {
  side: 'builder' | 'validator';
  timedOut: boolean;
  exitCode: number | null;
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
  const desc = abort.timedOut ? '执行超时被终止' : `退出码 ${abort.exitCode}`;
  const lines = [
    ...arbitrationLines,
    `${ABORT_LINE_PREFIX} ${formatStamp(now)} ${abort.side} ${desc}：本轮 passes 置位未经完整验收，已回写；请确认实现后重新走完门禁与验收`,
  ];
  return {
    ...state,
    [storyId]: { passes: false, notes: lines.join('\n'), retryCount: prev.retryCount, blocked: prev.blocked },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/gate.test.ts 2>&1 | tail -4`
Expected: PASS（新增 4 用例全绿，既有用例不受影响）

- [ ] **Step 5: 全量检查后提交**

```bash
npm run typecheck && npm test
git add src/engine/gate.ts src/engine/gate.test.ts
git commit -m "feat: applyAbortRollback 纯函数——中断轮回写待复核（保全仲裁行/不涨 retryCount/尊重 blocked）"
```

---

### Task 2: evidence.ts — iteration 记录可选字段

**Files:**
- Modify: `src/engine/evidence.ts:12-14`（iteration 联合成员）
- Test: `src/engine/evidence.test.ts`（追加）

**Interfaces:**
- Produces: iteration 成员新增可选字段 `builderOutcome?: 'completed' | 'timeout' | 'error'; validatorOutcome?: 'completed' | 'timeout' | 'error' | 'skipped'; noop?: true; gateRejected?: true; abortRollback?: { storyId: string }`——Task 3/4/5 写入、Task 7 渲染消费
- Consumes: 无（纯类型演进 + 既有 appendEvidence/readEvidence 往返）

- [ ] **Step 1: 写失败测试**（`src/engine/evidence.test.ts` 追加；类型演进的测试面=新字段记录的 append/read 往返保真）

```ts
describe('iteration 新可选字段（异常轮语义）', () => {
  it('带 outcome/noop/gateRejected/abortRollback 的记录往返保真', () => {
    const dir = ws();
    appendEvidence(dir, {
      type: 'iteration', source: 'engine', at: '2026-07-17T10:00:00.000Z', iteration: 5,
      storyId: 'US-004', builderRan: true, builderModel: 'sonnet',
      validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
      builderOutcome: 'timeout', abortRollback: { storyId: 'US-004' },
    });
    appendEvidence(dir, {
      type: 'iteration', source: 'engine', at: '2026-07-17T10:01:00.000Z', iteration: 6,
      storyId: 'US-005', builderRan: true, builderModel: null,
      validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
      builderOutcome: 'completed', noop: true,
    });
    const recs = readEvidence(dir).filter((r) => r.type === 'iteration');
    expect(recs).toHaveLength(2);
    expect(recs[0]).toMatchObject({ builderOutcome: 'timeout', abortRollback: { storyId: 'US-004' } });
    expect(recs[1]).toMatchObject({ noop: true, builderOutcome: 'completed' });
  });

  it('旧格式 iteration 行（无新字段）读取不受影响', () => {
    const dir = ws();
    appendEvidence(dir, {
      type: 'iteration', source: 'engine', at: '2026-07-17T10:00:00.000Z', iteration: 1,
      storyId: 'US-001', builderRan: true, builderModel: null,
      validatorRan: true, validatorModel: null, skippedValidator: false, agentBlocked: false,
    });
    const recs = readEvidence(dir);
    expect(recs).toHaveLength(1);
    expect((recs[0] as { noop?: true }).noop).toBeUndefined();
  });
});
```

注意：`ws()` 为该测试文件既有的临时 workspace helper；若命名不同（先读文件头确认），沿用现有 helper 名。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/evidence.test.ts 2>&1 | tail -6`
Expected: FAIL——typecheck 层面 `builderOutcome` 不在类型上（vitest 的 esbuild 不做类型检查，故此用例可能直接绿）。**红灯预测**：若 Step 1 后直接绿，以 `npm run typecheck` 的报错为红灯证据（`Object literal may only specify known properties`）。两者取其一即算红灯成立。

- [ ] **Step 3: 类型实现**（`src/engine/evidence.ts` iteration 成员改为）

```ts
  | { type: 'iteration'; source: 'engine'; at: string; iteration: number; storyId: string | null;
      builderRan: boolean; builderModel: string | null; validatorRan: boolean;
      validatorModel: string | null; skippedValidator: boolean; agentBlocked: boolean;
      /** agent 进程结局（异常轮语义，v0.22.0 起）；缺省=该侧未拉起或旧版本记录 */
      builderOutcome?: 'completed' | 'timeout' | 'error';
      validatorOutcome?: 'completed' | 'timeout' | 'error' | 'skipped';
      /** builder completed 但 state.json 与 progress.md 双无变化（空转轮） */
      noop?: true;
      /** 本轮门禁打回（细节在同轮 gate-run 记录；此处保「每轮一条 iteration」的轮语义） */
      gateRejected?: true;
      /** 本轮发生异常回写（applyAbortRollback） */
      abortRollback?: { storyId: string } }
```

- [ ] **Step 4: 验证通过**

Run: `npm run typecheck && npx vitest run src/engine/evidence.test.ts 2>&1 | tail -4`
Expected: typecheck 零错误 + 测试 PASS

- [ ] **Step 5: 提交**

```bash
npm test
git add src/engine/evidence.ts src/engine/evidence.test.ts
git commit -m "feat: evidence iteration 记录增异常轮可选字段——outcome/noop/gateRejected/abortRollback（旧记录零破坏）"
```

---

### Task 3: loop.ts — 结局判定与 builder 侧异常回写

**Files:**
- Modify: `src/engine/loop.ts`（builder 分支 `:158-173`；import 行补 `applyAbortRollback` 从 `./gate.js`、`writeFileAtomicSync` 已有则复用 import）
- Test: `src/engine/loop.test.ts`（追加 describe）

**Interfaces:**
- Consumes: Task 1 `applyAbortRollback/AbortInfo`、Task 2 iteration 新字段、既有 `runAgent` 返回 `{ timedOut: boolean; exitCode: number | null }`、既有 `tryReadState`（`./state.js`）
- Produces: loop 内模块级函数 `outcomeOf(r: { timedOut: boolean; exitCode: number | null }): 'completed' | 'timeout' | 'error'`；builder 异常轮的行为契约（回写 + iteration 记录 + continue）——Task 4/5 沿用 outcomeOf 与回写块形态

**行为变更提示（执行者必读）**：现状 builder 非零退出会**继续走门禁与验收**；本任务后改为与超时同路径（异常轮 continue）。改动后先跑全量 `npx vitest run src/engine/loop.test.ts` 核对既有用例——凡依赖「builder exit 非 0 仍继续」的用例（如有）按新语义更新其 fake 脚本为 exit 0。

- [ ] **Step 1: 写失败测试**（`src/engine/loop.test.ts` 追加；沿用文件既有 `setup`/`story` helper 与 `CODING_X_CLAUDE_BIN` 注入模式）

```ts
describe('异常轮回写（builder 侧）', () => {
  it('builder 写 true 后非零退出：回写 false+待复核标记，evidence 记 error 结局与回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    // fake：置 US-001 通过后以非零码退出（对应「干完活但进程异常收尾」）
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(1);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    // 每轮都回写 → 永不 resolved → 跑满 maxIterations，exit 1
    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toContain('[中断轮待复核]');
    expect(state['US-001'].retryCount).toBe(0);
    const iters = readEvidence(workspace).filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(2);
    expect(iters[0]).toMatchObject({
      iteration: 1, storyId: 'US-001',
      builderOutcome: 'error', abortRollback: { storyId: 'US-001' },
    });
    expect((iters[0] as { validatorRan: boolean }).validatorRan).toBe(false);
  });

  it('builder 超时且未动 state：不回写、不产生标记，iteration 记 timeout', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    // fake：不写任何文件，睡到被引擎 SIGTERM（devTimeoutMs=400 触发超时）
    writeFileSync(fake, `
      await new Promise((r) => setTimeout(r, 60_000));
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 1, devTimeoutMs: 400, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toBe('');
    const iters = readEvidence(workspace).filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({ iteration: 1, builderOutcome: 'timeout' });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败（红灯预测）**

Run: `npx vitest run src/engine/loop.test.ts 2>&1 | tail -12`
Expected: 用例 1 FAIL——现状 builder exit 1 后照走 validator（同一 fake 再置 true 后 exit 1）、轮末完成判定读到 passes=true → 实际 exit 0 ≠ 期望 1，且 state.passes 为 true。用例 2 FAIL——现状超时轮 continue 不写 iteration → `iters` 长度 0 ≠ 1。

- [ ] **Step 3: 实现**（`src/engine/loop.ts` builder 分支整体改为；`progressPath`/快照与 helpers 在本任务一并引入，Task 5 复用）

在 `const agentCwd = process.cwd();` 之后（`:108` 附近）加模块内 helper 与路径：

```ts
    const progressPath = join(cfg.workspace, 'progress.md');
    const rawOf = (p: string): string | null => {
      try { return readFileSync(p, 'utf-8'); } catch { return null; }
    };
    const outcomeOf = (r: { timedOut: boolean; exitCode: number | null }): 'completed' | 'timeout' | 'error' =>
      r.timedOut ? 'timeout' : r.exitCode === 0 ? 'completed' : 'error';
    // 异常轮回写：本轮把当前 story 的 passes 从 false 翻到 true 且未 blocked → 回写待复核。
    // state 读取失败（缺失/损坏）不回写不覆盖（同门禁打回的保守语义）。返回是否发生回写。
    const rollbackIfUnvalidatedPass = (side: 'builder' | 'validator', r: { timedOut: boolean; exitCode: number | null }): boolean => {
      if (!currentStory) return false;
      const passedBefore = beforeState?.[currentStory]?.passes ?? false;
      const st = tryReadState(statePath);
      const cur = st?.[currentStory];
      if (!st || !cur || !cur.passes || cur.blocked || passedBefore) return false;
      const next = applyAbortRollback(st, currentStory, { side, timedOut: r.timedOut, exitCode: r.exitCode }, new Date());
      writeFileAtomicSync(statePath, JSON.stringify(next, null, 2));
      console.warn(`⚠️  ${currentStory} 在中断轮被置为通过，未经完整验收——已回写待复核（${side} ${r.timedOut ? '超时' : `退出码 ${r.exitCode}`}）`);
      return true;
    };
```

注意作用域：`currentStory`/`beforeState` 在 for 循环体内定义——`rollbackIfUnvalidatedPass` 若定义在循环外无法闭包它们。**实现落点**：把 `rollbackIfUnvalidatedPass` 定义放循环体内（`const retryCount = ...` 之后），`progressPath`/`rawOf`/`outcomeOf` 放循环外。

builder 分支（现 `:158-173`）改为：

```ts
      // Developer
      let builderOutcome: 'completed' | 'timeout' | 'error' | undefined;
      let builderRollback = false;
      if (!builder) {
        console.error('❌ builder.md 不存在，跳过开发');
      } else {
        if (builderChoice.model) {
          console.log(`🧠 builder 模型: ${builderChoice.model}${builderChoice.escalated ? `（${currentStory} 第 ${retryCount} 次重试，升级）` : ''}`);
        }
        const dev = await runAgent({
          kind: cfg.kind, prompt: builder, cwd: agentCwd, timeoutMs: cfg.devTimeoutMs,
          model: builderChoice.model,
        });
        builderOutcome = outcomeOf(dev);
        if (builderOutcome !== 'completed') {
          builderRollback = rollbackIfUnvalidatedPass('builder', dev);
          recordEvidence({
            type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
            storyId: currentStory, builderRan: true, builderModel: builderChoice.model ?? null,
            validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
            builderOutcome, ...(builderRollback ? { abortRollback: { storyId: currentStory! } } : {}),
          });
          dashboard.setState({ phase: 'idle', model: null });
          continue; // 异常轮：跳过门禁与验收，下轮重试（回写已保证不带走未验收的 true）
        }
      }
```

轮末既有 iteration 记录（现 `:234-242`）补 outcome 字段（validator 侧字段 Task 4 完成，本任务先带 builder 侧）：

```ts
      recordEvidence({
        type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
        storyId: currentStory,
        builderRan: !!builder,
        builderModel: builderChoice.model ?? null,
        validatorRan: !!validator && !skipValidator && !agentBlocked,
        validatorModel: validatorModel ?? null,
        skippedValidator: skipValidator, agentBlocked,
        ...(builderOutcome ? { builderOutcome } : {}),
      });
```

同时删除该记录上方 `:232-233` 的过时注释（「轮末机械记录：只覆盖走到这里的轮…」两行）——Task 5 完成后「每轮一条」成为不变式，注释在 Task 5 收口时换新。

- [ ] **Step 4: 跑测试确认通过 + 既有用例核对**

Run: `npx vitest run src/engine/loop.test.ts 2>&1 | tail -10`
Expected: 新增 2 用例 PASS；若既有用例因「exit 非 0 不再走验收」变红，逐个核对语义后把其 fake 脚本改为 `process.exit(0)`（保持用例原意）。

- [ ] **Step 5: 全量检查后提交**

```bash
npm run typecheck && npm test
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: builder 异常结局（超时/非零退出）统一走异常轮——未验收 passes 回写+iteration 必留痕"
```

---

### Task 4: loop.ts — validator 侧接收结局与异常回写

**Files:**
- Modify: `src/engine/loop.ts` validator 分支（Task 3 后约 `:236-243` 的 `await runAgent`）与轮末 iteration 记录
- Test: `src/engine/loop.test.ts`（追加）

**Interfaces:**
- Consumes: Task 3 的 `outcomeOf`/`rollbackIfUnvalidatedPass`（同循环体作用域）
- Produces: 轮末 iteration 的 `validatorOutcome` 语义：真跑了=completed/timeout/error；因门禁打回、agentBlocked、skipValidator 未跑=后续任务写 'skipped'（本任务先覆盖真跑分支）

- [ ] **Step 1: 写失败测试**

```ts
describe('异常轮回写（validator 侧）', () => {
  it('builder 置 true 后 validator 非零退出：回写 false，iteration 记 validator error 与回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    // 同一 stub 以调用次数区分：第 1 次（builder）置 true 正常退出；第 2 次（validator）非零退出
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const n = readFileSync(${JSON.stringify(calls)}, 'utf-8').length;
      if (n === 1) {
        writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        }));
        process.exit(0);
      }
      process.exit(1);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1); // 回写后未 resolved，跑满 1 轮
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toContain('[中断轮待复核]');
    expect(state['US-001'].notes).toContain('validator');
    const iters = readEvidence(workspace).filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({
      builderOutcome: 'completed', validatorOutcome: 'error',
      abortRollback: { storyId: 'US-001' },
    });
  });

  it('validator 正常完成：iteration 记 validatorOutcome completed，无回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
    const iters = readEvidence(workspace).filter((r) => r.type === 'iteration');
    expect(iters[0]).toMatchObject({ validatorOutcome: 'completed' });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts 2>&1 | tail -10`
Expected: 用例 1 FAIL——现状 validator 返回值被丢弃、无回写 → state.passes 为 true、exit 0。用例 2 FAIL——iteration 无 `validatorOutcome` 字段。

- [ ] **Step 3: 实现**（validator 分支改为接收返回值并判定）

```ts
      // Validator
      const validatorModel = resolveValidatorModel({ cliOverride: cfg.validatorModel, config: modelsRead.config });
      dashboard.setState({ phase: 'validating', model: validatorModel ?? null });
      let validatorOutcome: 'completed' | 'timeout' | 'error' | 'skipped' | undefined;
      let validatorRollback = false;
      if (validator && skipValidator) {
        console.warn('⚠️  prd.json 快照写回失败，跳过本轮 validator（磁盘验收标准不可信）');
        validatorOutcome = 'skipped';
      } else if (validator && !agentBlocked) {
        if (validatorModel) console.log(`🧠 validator 模型: ${validatorModel}`);
        const val = await runAgent({
          kind: cfg.kind, prompt: validator, cwd: agentCwd, timeoutMs: cfg.valTimeoutMs,
          model: validatorModel,
        });
        validatorOutcome = outcomeOf(val);
        if (validatorOutcome !== 'completed') {
          // validator 异常结局：本轮 builder 置的 true 未经复核 → 回写待复核
          validatorRollback = rollbackIfUnvalidatedPass('validator', val);
        }
      } else if (validator && agentBlocked) {
        validatorOutcome = 'skipped';
      }
```

轮末 iteration 记录补 validator 侧字段与回写标记：

```ts
      recordEvidence({
        type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
        storyId: currentStory,
        builderRan: !!builder,
        builderModel: builderChoice.model ?? null,
        validatorRan: !!validator && !skipValidator && !agentBlocked,
        validatorModel: validatorModel ?? null,
        skippedValidator: skipValidator, agentBlocked,
        ...(builderOutcome ? { builderOutcome } : {}),
        ...(validatorOutcome ? { validatorOutcome } : {}),
        ...(validatorRollback ? { abortRollback: { storyId: currentStory! } } : {}),
      });
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts 2>&1 | tail -6`
Expected: PASS 全绿

- [ ] **Step 5: 全量检查后提交**

```bash
npm run typecheck && npm test
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: validator 结局纳入引擎判定——异常结局回写未复核的 passes，iteration 记 validatorOutcome"
```

---

### Task 5: loop.ts + cli.ts — no-op 检测、stall 熔断与「每轮一条」收口

**Files:**
- Modify: `src/engine/loop.ts`（LoopConfig 加 `stallLimit?: number`；轮首快照；no-op 分支；stall 计数；门禁打回轮 iteration；新不变式注释）
- Modify: `src/cli.ts`（`'stall-limit'` 参数：options 表 `:44` 附近、CliConfig 字段、校验、`runLoop` 传参 `:198` 附近）
- Test: `src/engine/loop.test.ts` + `src/cli.test.ts`（若无 cli 测试文件则校验逻辑并入 loop.test 断言缺省值）

**Interfaces:**
- Consumes: Task 3 的 `rawOf`/`progressPath` 与 iteration 记录形态
- Produces: `LoopConfig.stallLimit?: number`（缺省 3）；CLI `--stall-limit`；stall 语义：no-op ∨ builder 异常 ∨ validator 异常累计，非 stall 轮清零，达限 exit 1

- [ ] **Step 1: 写失败测试**

```ts
describe('no-op 检测与 stall 熔断', () => {
  it('builder 空转（双无变化）：跳过验收只跑 builder，连续 3 轮熔断 exit 1', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    // fake：只计数，什么都不写，正常退出（completed 但零产出 = no-op）
    writeFileSync(fake, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 10, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    // 缺省 stallLimit=3：恰 3 轮、每轮只有 builder 一次调用（validator 从未拉起）
    expect(readFileSync(calls, 'utf-8').length).toBe(3);
    const iters = readEvidence(workspace).filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(3);
    expect(iters.every((r) => (r as { noop?: true }).noop === true)).toBe(true);
  });

  it('门禁打回轮不计 stall 且清零：打回多于 stallLimit 也不熔断', async () => {
    // qualityChecks 必败（false 命令）+ builder 每轮置 true → 每轮门禁打回（有 state 写入=有活动）
    const { workspace, instructionsDir } = setup([story()], { qualityChecks: ['false'] });
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 4, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    // 4 轮全是门禁打回（stallLimit=3 未触发熔断）→ 跑满，builder 每轮都拉起
    expect(readFileSync(calls, 'utf-8').length).toBe(4);
    const iters = readEvidence(workspace).filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(4);
    expect(iters.every((r) => (r as { gateRejected?: true }).gateRejected === true)).toBe(true);
    expect(iters.every((r) => (r as { validatorOutcome?: string }).validatorOutcome === 'skipped')).toBe(true);
    expect(code).toBe(1);
  });

  it('stallLimit 可经配置调整', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 10, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false, stallLimit: 1,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    expect(readFileSync(calls, 'utf-8').length).toBe(1);
  });
});
```

注意红灯推演：用例 2 的现状行为——门禁打回轮已 continue 且不写 iteration → `iters` 长度 0 ≠ 4，红灯明确；`false` 是 POSIX 必败命令、零输出零依赖。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts 2>&1 | tail -12`
Expected: 用例 1——现状 no-op 轮照跑 validator（calls=每轮 2 次）且跑满 10 轮 → calls≠3 FAIL；用例 2——iters 长度 0 FAIL；用例 3——`stallLimit` 不在 LoopConfig 上（typecheck 红）或行为跑满 calls=10 FAIL。

- [ ] **Step 3: 实现**

`LoopConfig` 加字段（`:16` 接口内）：

```ts
  /** 连续无进展轮（no-op/超时/异常退出）熔断上限；缺省 3 */
  stallLimit?: number;
```

循环外初始化（`let exitCode = 1;` 旁）：

```ts
    const stallLimit = cfg.stallLimit ?? 3;
    let stallCount = 0;
    // stall 熔断判定：stall 轮调用；达限打横幅并返回 true（调用方 break）
    const stalled = (): boolean => {
      stallCount += 1;
      if (stallCount < stallLimit) return false;
      console.error(`\n🛑 连续 ${stallLimit} 轮无进展（no-op/超时/异常退出），提前终止。排查 agent CLI 可用性、模型名与网络后重跑（引擎幂等续跑）。`);
      return true;
    };
```

轮首快照（`const beforeRead = guard.read();` 之前）：

```ts
      const stateRawBefore = rawOf(statePath);
      const progressRawBefore = rawOf(progressPath);
```

Task 3 的 builder 异常分支 continue 前改为熔断可中断（`dashboard.setState(...); continue;` 改）：

```ts
          dashboard.setState({ phase: 'idle', model: null });
          if (stalled()) break;
          continue;
```

builder completed 后、第四检测点（`const gateRead = guard.read();`）之前插入 no-op 分支：

```ts
      // no-op 空转检测：builder 正常结束但 state 与 progress 双无变化（机械信号）——
      // 跳过门禁与验收（省一次强模型调用），计入 stall。
      if (builder && builderOutcome === 'completed'
          && rawOf(statePath) === stateRawBefore && rawOf(progressPath) === progressRawBefore) {
        console.warn('⏭️  本轮 builder 无任何产出（state/progress 双无变化），跳过门禁与验收');
        recordEvidence({
          type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
          storyId: currentStory, builderRan: true, builderModel: builderChoice.model ?? null,
          validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
          builderOutcome: 'completed', noop: true,
        });
        dashboard.setState({ phase: 'idle', model: null });
        if (stalled()) break;
        continue;
      }
```

门禁打回分支（`if (!gate.ok) { ... continue; }`）在 `continue` 前补 iteration 与清零：

```ts
          recordEvidence({
            type: 'iteration', source: 'engine', at: new Date().toISOString(), iteration: i,
            storyId: currentStory, builderRan: !!builder, builderModel: builderChoice.model ?? null,
            validatorRan: false, validatorModel: null, skippedValidator: false, agentBlocked: false,
            ...(builderOutcome ? { builderOutcome } : {}), validatorOutcome: 'skipped', gateRejected: true,
          });
          stallCount = 0; // 有 state 写入=有活动；打回预算由 MAX_RETRIES 独立约束
          dashboard.setState({ phase: 'idle', model: null });
          continue;
```

validator 异常轮（Task 4 的 `validatorOutcome !== 'completed'` 分支）后、轮末记录前：stall 处理放轮末记录之后、完成判定之前：

```ts
      if (validatorOutcome === 'timeout' || validatorOutcome === 'error') {
        if (stalled()) break;
      } else {
        stallCount = 0; // 正常走完的轮（含 agentBlocked/skipValidator 跳过轮）清零
      }
```

轮末记录上方换新注释（替代 Task 3 删除的旧注释）：

```ts
      // 每轮一条 iteration 不变式：continue 路径（builder 异常/no-op/门禁打回）各自留痕后跳出，
      // 走到这里的轮在此记录——evidence 时间线零空洞（v0.22.0，dogfood 发现 B）。
```

`src/cli.ts`：options 表加 `'stall-limit': { type: 'string' },`；CliConfig 加 `stallLimit: number;`；解析（`staleDays` 校验块之后同款）：

```ts
  let stallLimit = 3;
  if (values['stall-limit'] !== undefined) {
    const raw = values['stall-limit'];
    if (command === 'run' && !/^[1-9]\d*$/.test(raw)) {
      throw new Error(`❌ --stall-limit 必须是正整数，收到「${raw}」`);
    }
    stallLimit = Number(raw);
  }
```

返回对象加 `stallLimit,`；`runLoop` 调用处（`:198` 附近）传 `stallLimit: cfg.stallLimit,`。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts src/cli.test.ts 2>&1 | tail -8`（无 cli.test.ts 则只跑前者）
Expected: PASS 全绿

- [ ] **Step 5: 全量检查后提交**

```bash
npm run typecheck && npm test
git add src/engine/loop.ts src/cli.ts src/engine/loop.test.ts
git commit -m "feat: no-op 空转检测与 stall 熔断（--stall-limit 缺省 3）——每轮一条 iteration 不变式收口"
```

---

### Task 6: loop.ts — blocked 收敛出口（exit 3 + 文案分叉）

**Files:**
- Modify: `src/engine/loop.ts` 完成判定分支（`:250-255` 附近）
- Test: `src/engine/loop.test.ts`（追加）

**Interfaces:**
- Consumes: 既有 `allStoriesResolved`（不改）；afterState
- Produces: 退出码 3 语义（收敛但有 blocked）——Task 8 README 文档消费

- [ ] **Step 1: 写失败测试**

```ts
describe('blocked 收敛出口', () => {
  it('全部 resolved 但存在 blocked：文案列出 story 号，exit 3', async () => {
    const { workspace, instructionsDir } = setup([story(), story({ id: 'US-002', priority: 2 })]);
    const fake = join(workspace, 'fake.mjs');
    // fake：US-001 通过、US-002 置 blocked（agent 仲裁上报形态）
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '[需要人工核实] 环境缺失', retryCount: 0, blocked: true },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); origLog(...a); };
    const code = await runLoop({
      kind: 'claude', maxIterations: 3, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    console.log = origLog;
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(3);
    const banner = logs.find((l) => l.includes('blocked'));
    expect(banner).toBeDefined();
    expect(banner).toContain('US-002');
    expect(banner).toContain('1 个 story 通过');
    expect(logs.some((l) => l.includes('全部 story 已通过'))).toBe(false);
  });

  it('全部通过无 blocked：维持 exit 0 与既有文案', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
  });
});
```

红灯推演：用例 1 现状——blocked 计入 resolved → 「全部 story 已通过」+ exit 0 ≠ 期望 3。注意：agentBlocked 检测（`:185`）在 builder 后读 state——US-002 首轮即 blocked，第二轮 `getCurrentStoryId` 返回 null（全 resolved 于轮末判定，第一轮末即 break）。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts 2>&1 | tail -8`
Expected: 用例 1 FAIL（exit 0 ≠ 3）；用例 2 PASS（守恒用例，红灯阶段即绿是预期——它锚定不回归面）

- [ ] **Step 3: 实现**（完成判定分支改为）

```ts
      if (after && afterState && allStoriesResolved(after, afterState)) {
        dashboard.setState({ phase: 'done' });
        const blockedIds = after.userStories.filter((s) => afterState[s.id]?.blocked).map((s) => s.id);
        if (blockedIds.length > 0) {
          const passedCount = after.userStories.length - blockedIds.length;
          console.log(`\n⏸️  ${passedCount} 个 story 通过，${blockedIds.length} 个 blocked 待人工处理（${blockedIds.join(', ')}）。处理后重跑引擎收敛剩余项；人审入口见 .workspace/report.html 与 state.json notes。`);
          exitCode = 3;
        } else {
          console.log('\n💡 全部 story 已通过。建议先运行 /review-loop 审查本轮产物（人审后合并），再用 /compound-docs 收口沉淀。');
          exitCode = 0;
        }
        break;
      }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts 2>&1 | tail -6`
Expected: PASS 全绿

- [ ] **Step 5: 全量检查后提交**

```bash
npm run typecheck && npm test
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: blocked 收敛出口——文案分叉列 story 号+退出码 3（dogfood 发现 D，0.18.1 defer 清账）"
```

---

### Task 7: report/render.ts — 时间线区 outcome/noop 标注与中断行高亮

**Files:**
- Modify: `src/report/render.ts`（`:195-200` 时间线表；notes 行分类高亮处）
- Test: `src/report/render.test.ts`（追加）

**Interfaces:**
- Consumes: Task 2 iteration 新字段；Task 1 `ABORT_LINE_PREFIX`（从 `../engine/gate.js` import——render.ts 已 import 该模块的 GATE_FAIL_LINE_PREFIX，先读文件头确认既有 import 形态并沿用）
- Produces: 无下游

- [ ] **Step 1: 写失败测试**（先读 `render.test.ts` 既有用例的构造模式——它如何组装 evidence 记录喂 render；沿用同款 helper。以下断言为语义锚点，接入现有构造函数时保持断言不变）

```ts
describe('时间线区异常轮标注', () => {
  it('timeout/error/noop/gateRejected 轮在时间线行上可辨', () => {
    // 用现有测试的 render 入口构造含以下 4 条 iteration 的报告：
    // {iteration:1, builderOutcome:'timeout', abortRollback:{storyId:'US-001'}}
    // {iteration:2, noop:true, builderOutcome:'completed'}
    // {iteration:3, gateRejected:true, validatorOutcome:'skipped'}
    // {iteration:4, builderOutcome:'completed', validatorOutcome:'completed'}
    const html = renderWithIterations(/* 见上注释，按现有构造 helper 传入 */);
    expect(html).toContain('builder 超时');
    expect(html).toContain('空转');
    expect(html).toContain('门禁打回');
    expect(html).toContain('已回写');
  });

  it('旧 evidence（无新字段）时间线渲染与 0.21.0 一致（零破坏）', () => {
    const html = renderWithIterations(/* 一条不带任何新字段的 iteration */);
    expect(html).toContain('轮次时间线');
    expect(html).not.toContain('空转');
  });

  it('notes 中断标记行按引擎行样式高亮', () => {
    // state 含 notes: '[中断轮待复核] 2026-07-17 10:00 builder 执行超时被终止：…'
    const html = renderWithState(/* 按现有 story 卡片构造 helper */);
    expect(html).toContain('[中断轮待复核]');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/report/render.test.ts 2>&1 | tail -6`
Expected: FAIL——时间线行无「超时/空转/门禁打回」字样

- [ ] **Step 3: 实现**（时间线行渲染 `:198` 改为——在既有 builder/validator 列的基础上补状态列）

```ts
  const rows = iters.map((r) => {
    const flags: string[] = [];
    if (r.builderOutcome === 'timeout') flags.push('builder 超时');
    if (r.builderOutcome === 'error') flags.push('builder 异常退出');
    if (r.noop) flags.push('空转（无产出）');
    if (r.gateRejected) flags.push('门禁打回');
    if (r.validatorOutcome === 'timeout') flags.push('validator 超时');
    if (r.validatorOutcome === 'error') flags.push('validator 异常退出');
    if (r.abortRollback) flags.push(`已回写 ${text(r.abortRollback.storyId)} 待复核`);
    const flagCell = flags.length > 0 ? `⚠️ ${flags.join('；')}` : '—';
    return `<tr><td>${r.iteration}</td><td>${text(r.storyId ?? '—')}</td><td>${r.builderRan ? text(r.builderModel ?? '默认') : '未跑'}</td><td>${r.validatorRan ? text(r.validatorModel ?? '默认') : (r.agentBlocked ? '跳过（agent blocked）' : r.skippedValidator ? '跳过（快照写回失败）' : '未跑')}</td><td>${flagCell}</td><td>${stampOf(r.at)}</td></tr>`;
  });
```

表头行同步加「状态」列（时间线 `<th>` 行：`轮 | story | builder | validator | 状态 | 时刻`）。notes 行分类高亮：找到现有 `GATE_FAIL_LINE_PREFIX`/`BLOCKED_LINE_PREFIX` 的行分类逻辑，同款加 `ABORT_LINE_PREFIX` 分支（样式复用门禁失败行的引擎行样式）。

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/report/ 2>&1 | tail -4`
Expected: PASS（含既有快照/结构用例不回归）

- [ ] **Step 5: 全量检查后提交**

```bash
npm run typecheck && npm test
git add src/report/render.ts src/report/render.test.ts
git commit -m "feat: 报告时间线区异常轮标注（超时/空转/门禁打回/回写）+中断标记行高亮，旧 evidence 零破坏"
```

---

### Task 8: 文档收口——ADR-009、断言 #12 措辞、README

**Files:**
- Create: `docs/decisions/009-abort-round-semantics.md`
- Modify: `docs/superpowers/dogfood-regression.md`（断言 #12 验证点）
- Modify: `README.md`（退出码表 + `--stall-limit` 参数）
- Modify: `docs/decisions/README.md`（若有索引列表则加行——先读确认）

**Interfaces:** 无代码；文档声明必须与 Task 1-7 的实现事实逐处对得上（0.21.0 Task 7 的对账纪律）

- [ ] **Step 1: 写 ADR-009**（frontmatter 同 008 形态：title/status: active/updated/scope: root）

内容要点（按 ADR 四节：背景/决策/理由与备选/后果）：
- 背景：dogfood 2026-07-17 发现 A-C（引用 findings 文档）；现状引擎只识别 builder timedOut，validator 返回值被丢弃
- 决策：agent 结局机械三分（completed/timeout/error）；异常轮回写待复核（不涨 retryCount）；no-op 双无变化判定；stall 熔断缺省 3；blocked 收敛 exit 3
- 理由与备选：被否方案 Y（验收台账——完成判定语义变更+新状态载体，防伪价值留三件套推迟项）、被否方案 Z（validator 当轮重试——不覆盖 builder 侧）；机械信号不解析 agent 输出的哲学一致性
- 后果：validator 正常完成但 CLI 意外非零 → 误回写多烧一轮（幂等无害）；API stalled 但 exit 0 → 漏检（靠下轮幂等+人审兜底，实测频发再评估）；exit 3 为新对外行为（0.22.0）

- [ ] **Step 2: 订正断言 #12 + README**

断言 #12 验证点中「轮号跳跃能对照门禁历史还原打回轮」改为「iteration 记录每轮一条（时间线零空洞），异常轮带 outcome/noop/gateRejected/abortRollback 标注可直读还原」。README：退出码表（0=全部通过 / 1=跑满未完成或熔断 / 2=workspace 锁占用 / 3=收敛但有 blocked 待人工）+ CLI 参数表加 `--stall-limit`（连续无进展轮熔断上限，缺省 3）。

- [ ] **Step 3: 对账后提交**

逐条 grep 验证文档声明与实现一致（`grep -n "stallLimit ?? 3" src/engine/loop.ts`、`grep -n "exitCode = 3" src/engine/loop.ts`、`grep -n "ABORT_LINE_PREFIX" src/engine/gate.ts src/report/render.ts`）。

```bash
npm run typecheck && npm test
git add docs/decisions/009-abort-round-semantics.md docs/decisions/README.md docs/superpowers/dogfood-regression.md README.md
git commit -m "docs: ADR-009 异常轮语义+断言#12 措辞订正+README 退出码表与 --stall-limit"
```

---

### Task 9: 发版 v0.22.0（人审 gate 后执行）

**Files:**
- Modify: `package.json`（npm version 钩子自动同步插件清单与 lock）

**前置 gate：本任务开始前停下，走 /review-loop 人审并获人工放行——不得未经裁决直接发版。**

- [ ] **Step 1: 人审放行确认**（对话中获得明确放行后才继续）

- [ ] **Step 2: 版本与推送**

```bash
npm run typecheck && npm test && npm run build
npm version minor -m "release: v%s——异常轮语义（回写待复核/每轮留痕/no-op 熔断/blocked 收敛 exit 3）"
git push --follow-tags
```

推送后停手：npm publish 与 GitHub Release 归 tag 触发的 CI（0.14.3 本地抢发撞 CI 教训）。

- [ ] **Step 3: CI 确认**

Run: `gh run list --limit 3` 观察 Test+Publish 双 success；`npm view coding-x version` 确认 0.22.0 命中。

---

## Self-Review 记录

- **Spec 覆盖**：组件 1（回写）→Task 1/3/4；组件 2（不变式+schema）→Task 2/3/4/5；组件 3（no-op+熔断+CLI）→Task 5；组件 4（收敛出口）→Task 6；report 标注→Task 7；ADR/断言/README→Task 8；发版→Task 9。spec 全节有对应任务。
- **占位符扫描**：Task 7 Step 1 的 `renderWithIterations`/`renderWithState` 是「按现有测试 helper 接入」的显式指令（先读文件再沿用），断言锚点已给全——非 TBD。
- **类型一致性**：`AbortInfo{side,timedOut,exitCode}`（T1）与 `rollbackIfUnvalidatedPass(side, r)` 调用（T3/T4）一致；`builderOutcome`/`validatorOutcome` 字面量集合 T2=T3=T4=T5=T7；`stallLimit` LoopConfig（T5）与 cli 传参一致。
