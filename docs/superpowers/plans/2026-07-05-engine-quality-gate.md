# 引擎机械门禁（quality gate）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引擎在每轮 builder 之后、validator 之前确定性执行 `prd.json` 顶层 `qualityChecks` 命令，失败即机械打回（写 state.json）并跳过该轮 validator——给全 LLM 验证链加一层不可共谋的确定性防线。

**Architecture:** 新模块 `src/engine/gate.ts` 承载纯函数（打回计算、字段守卫）与 spawn 执行器，`loop.ts` 薄接线；打回上限 `MAX_RETRIES=5` 以引擎为单一真相源、经 `{{MAX_RETRIES}}` 渲染进 validator 指令；派生链（prd-to-json）负责提取命令并在有人在场时验证基线全绿。

**Tech Stack:** TypeScript strict/ESM（NodeNext，相对导入带 `.js`）、Node ≥18 `child_process.spawn`、Vitest。

**Spec:** `docs/superpowers/specs/2026-07-05-quality-gate-design.md`（18 条锁定决策）

## Global Constraints

- 每个任务提交前 `npm run typecheck` 与 `npm test` 必须全绿（黄金原则 1）
- `src/` 内相对导入必须写 `.js` 扩展名（黄金原则 2）
- 提交说明中文，conventional 前缀（feat:/fix:/docs:/test:/release:）保留英文
- 引擎运行时状态只读写 workspace 目录——gate 只写 `<workspace>/state.json`（黄金原则 4）
- 面向用户新能力：发版升 minor（0.13.0 → 0.14.0）并同步 README（黄金原则 5）
- 代码注释只写「代码本身表达不了的约束」，风格对齐现有文件（中文注释、紧凑）
- CI 仅 ubuntu-latest；测试中的路径拼接一律 `join()`（patterns.md Windows 陷阱惯例照旧遵守）

---

### Task 1: gate.ts 纯函数层（字段守卫 + 打回计算 + MAX_RETRIES）

**Files:**
- Modify: `src/engine/prd.ts`（`Prd` 接口加字段）
- Create: `src/engine/gate.ts`
- Create: `src/engine/gate.test.ts`

**Interfaces:**
- Consumes: `Prd`（`./prd.js`）、`RunState`/`INITIAL_STORY_STATE`（`./state.js`）
- Produces（后续任务依赖的确切签名）:
  - `export const MAX_RETRIES = 5`
  - `export interface GateFailure { command: string; exitCode: number | null; timedOut: boolean; outputTail: string }`
  - `export interface GateResult { ok: boolean; failure: GateFailure | null }`
  - `export function readQualityChecks(prd: Prd | null): string[] | 'invalid' | null`
  - `export function applyGateFailure(state: RunState, storyId: string, failure: GateFailure, now: Date): RunState`

- [ ] **Step 1: prd.ts 加字段**

在 `src/engine/prd.ts` 的 `Prd` 接口中，`sourcePrd` 字段之后加：

```ts
  /** 机械门禁命令（完整 shell 命令行，引擎逐条执行）；缺失或空数组=门禁不启用 */
  qualityChecks?: string[];
```

- [ ] **Step 2: 写失败测试**

创建 `src/engine/gate.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readQualityChecks, applyGateFailure, MAX_RETRIES } from './gate.js';
import type { GateFailure } from './gate.js';
import type { RunState } from './state.js';
import type { Prd } from './prd.js';

const prdWith = (qualityChecks?: unknown): Prd => ({
  project: 'p', branchName: 'b', description: 'd', userStories: [],
  ...(qualityChecks === undefined ? {} : { qualityChecks: qualityChecks as string[] }),
});

const failure = (over: Partial<GateFailure> = {}): GateFailure => ({
  command: 'npm test', exitCode: 1, timedOut: false, outputTail: '2 failed', ...over,
});

describe('readQualityChecks', () => {
  it('returns null when prd is null or field missing', () => {
    expect(readQualityChecks(null)).toBeNull();
    expect(readQualityChecks(prdWith())).toBeNull();
  });

  it('returns null for an empty array (gate disabled, silent)', () => {
    expect(readQualityChecks(prdWith([]))).toBeNull();
  });

  it('returns the commands for a valid string array', () => {
    expect(readQualityChecks(prdWith(['npm run typecheck', 'npm test'])))
      .toEqual(['npm run typecheck', 'npm test']);
  });

  it('returns "invalid" for non-array or non-string members', () => {
    expect(readQualityChecks(prdWith('npm test'))).toBe('invalid');
    expect(readQualityChecks(prdWith([1]))).toBe('invalid');
    expect(readQualityChecks(prdWith(['ok', null]))).toBe('invalid');
  });
});

describe('applyGateFailure', () => {
  const base: RunState = {
    'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
  };
  const now = new Date(2026, 6, 5, 14, 30); // 本地时间 2026-07-05 14:30

  it('flips passes to false, bumps retryCount, writes gate failure notes', () => {
    const next = applyGateFailure(base, 'US-001', failure(), now);
    expect(next['US-001'].passes).toBe(false);
    expect(next['US-001'].retryCount).toBe(1);
    expect(next['US-001'].blocked).toBe(false);
    expect(next['US-001'].notes).toContain('[门禁失败 - 第1次] 2026-07-05 14:30');
    expect(next['US-001'].notes).toContain('npm test');
    expect(next['US-001'].notes).toContain('退出码 1');
    expect(next['US-001'].notes).toContain('2 failed');
  });

  it('does not mutate the input state', () => {
    const next = applyGateFailure(base, 'US-001', failure(), now);
    expect(next).not.toBe(base);
    expect(base['US-001'].passes).toBe(true);
    expect(base['US-001'].notes).toBe('');
  });

  it('keeps [需求冲突] lines at the top and drops stale failure notes', () => {
    const state: RunState = {
      'US-001': {
        passes: true,
        notes: '[需求冲突] 2026-07-01 10:00 冲突点（源说 X，AC 说 Y，已按 Y 实现）\n[验证失败 - 第1次] 旧失败详情',
        retryCount: 1,
        blocked: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].notes.startsWith(
      '[需求冲突] 2026-07-01 10:00 冲突点（源说 X，AC 说 Y，已按 Y 实现）\n[门禁失败 - 第2次]',
    )).toBe(true);
    expect(next['US-001'].notes).not.toContain('[验证失败');
  });

  it('marks blocked and appends BLOCKED note when retryCount reaches MAX_RETRIES', () => {
    const state: RunState = {
      'US-001': { passes: true, notes: '', retryCount: MAX_RETRIES - 1, blocked: false },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].retryCount).toBe(MAX_RETRIES);
    expect(next['US-001'].blocked).toBe(true);
    expect(next['US-001'].notes).toContain('[BLOCKED: 已达到最大重试次数，跳过此 story]');
  });

  it('treats a missing story id as initial state and reports timeout wording', () => {
    const next = applyGateFailure({}, 'US-009', failure({ timedOut: true, exitCode: null }), now);
    expect(next['US-009'].retryCount).toBe(1);
    expect(next['US-009'].blocked).toBe(false);
    expect(next['US-009'].notes).toContain('执行超时被终止');
  });
});
```

- [ ] **Step 3: 跑测试确认红**

Run: `npx vitest run src/engine/gate.test.ts`
Expected: FAIL——`Cannot find module './gate.js'`（模块尚不存在）

- [ ] **Step 4: 最小实现**

创建 `src/engine/gate.ts`：

```ts
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
```

- [ ] **Step 5: 跑测试确认绿 + 全量检查**

Run: `npx vitest run src/engine/gate.test.ts` → PASS（10 个用例）
Run: `npm run typecheck && npm test` → 全绿

- [ ] **Step 6: 提交**

```bash
git add src/engine/prd.ts src/engine/gate.ts src/engine/gate.test.ts
git commit -m "feat: 机械门禁纯函数层——qualityChecks 形状守卫与打回计算，MAX_RETRIES=5 成为引擎单一真相源"
```

---

### Task 2: gate.ts 执行器 runQualityChecks（spawn shell + fail-fast + tee + 超时）

**Files:**
- Modify: `src/engine/gate.ts`
- Modify: `src/engine/gate.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `GateFailure`/`GateResult`
- Produces: `export function runQualityChecks(checks: string[], cwd: string, timeoutMs?: number): Promise<GateResult>`（缺省超时 600_000ms；Task 4 的 loop 接线只传前两参）

- [ ] **Step 1: 写失败测试**

在 `src/engine/gate.test.ts` 追加（顶部 import 行改为下方形式）：

```ts
import { describe, it, expect } from 'vitest';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readQualityChecks, applyGateFailure, runQualityChecks, MAX_RETRIES } from './gate.js';
```

文件末尾追加：

```ts
describe('runQualityChecks', () => {
  it('passes when every command exits 0', async () => {
    const r = await runQualityChecks(['node -e "process.exit(0)"'], process.cwd());
    expect(r.ok).toBe(true);
    expect(r.failure).toBeNull();
  });

  it('fails with the exit code and captured output tail', async () => {
    const r = await runQualityChecks(
      ['node -e "console.error(\'boom-marker\'); process.exit(3)"'],
      process.cwd(),
    );
    expect(r.ok).toBe(false);
    expect(r.failure!.command).toContain('boom-marker');
    expect(r.failure!.exitCode).toBe(3);
    expect(r.failure!.timedOut).toBe(false);
    expect(r.failure!.outputTail).toContain('boom-marker');
  });

  it('fail-fast: does not run commands after the first failure', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gate-'));
    const marker = join(dir, 'ran-second.txt');
    try {
      // 外层双引号内用单引号包路径：tmpdir 路径无空格与单引号，shell 下字面保留
      const second = `node -e "require('node:fs').writeFileSync('${marker}', 'x')"`;
      const r = await runQualityChecks(['node -e "process.exit(1)"', second], process.cwd());
      expect(r.ok).toBe(false);
      expect(r.failure!.command).toBe('node -e "process.exit(1)"');
      expect(existsSync(marker)).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('keeps only the tail of long output', async () => {
    const r = await runQualityChecks(
      [`node -e "console.log('x'.repeat(5000) + 'TAIL-END'); process.exit(1)"`],
      process.cwd(),
    );
    expect(r.ok).toBe(false);
    expect(r.failure!.outputTail.length).toBeLessThanOrEqual(2000);
    expect(r.failure!.outputTail).toContain('TAIL-END');
  });

  it('times out a hanging command and reports timedOut', async () => {
    const r = await runQualityChecks(
      ['node -e "setTimeout(() => {}, 30000)"'],
      process.cwd(),
      500,
    );
    expect(r.ok).toBe(false);
    expect(r.failure!.timedOut).toBe(true);
    expect(r.failure!.exitCode).toBeNull();
  });
});
```

注意：第二个用例的 `failure!.command` 断言写 `toContain('boom-marker')` 是**故意**的——command 字段应是完整原命令行（含参数），这条断言防止实现只存了 argv[0]。

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/engine/gate.test.ts`
Expected: FAIL——`runQualityChecks` 未导出（`is not a function`）

- [ ] **Step 3: 实现执行器**

在 `src/engine/gate.ts` 顶部 import 区加：

```ts
import { spawn } from 'node:child_process';
```

在 `readQualityChecks` 之后加：

```ts
/** 每条门禁命令的执行超时（10 分钟）；超时按失败打回，notes 注明 */
const GATE_TIMEOUT_MS = 600_000;
/** 打回 notes 只保留输出尾部——失败摘要在尾部，全量会污染 builder 每轮要读的 notes */
const OUTPUT_TAIL_CHARS = 2000;

function runOneCheck(command: string, cwd: string, timeoutMs: number): Promise<GateFailure | null> {
  return new Promise((resolve) => {
    // shell 语义：qualityChecks 是用户在 prd.json 亲手声明的完整命令行（如 `npm test -- --run`）。
    // patterns.md 的「不经 shell」约定针对代码拼接固定命令+变量参数的场景，不适用于此。
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let tail = '';
    const keep = (chunk: Buffer) => {
      tail = (tail + String(chunk)).slice(-OUTPUT_TAIL_CHARS);
    };
    // tee：实时转发保证无人值守时进度可见，同时滚动缓冲尾部供打回 notes 用
    child.stdout.on('data', (c: Buffer) => { process.stdout.write(c); keep(c); });
    child.stderr.on('data', (c: Buffer) => { process.stderr.write(c); keep(c); });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      child.kill('SIGTERM');
      const killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
      child.once('exit', () => clearTimeout(killTimer));
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
```

- [ ] **Step 4: 跑测试确认绿 + 全量检查**

Run: `npx vitest run src/engine/gate.test.ts` → PASS
Run: `npm run typecheck && npm test` → 全绿

- [ ] **Step 5: 提交**

```bash
git add src/engine/gate.ts src/engine/gate.test.ts
git commit -m "feat: 机械门禁执行器——shell 逐条 fail-fast 执行,输出 tee 转发+滚动保尾 2000 字符,单条超时 10 分钟"
```

---

### Task 3: renderInstruction 渲染 {{MAX_RETRIES}} + validator.md 占位符化

**Files:**
- Modify: `src/engine/loop.ts:40-42`（`renderInstruction`）
- Modify: `src/engine/loop.test.ts`（`describe('renderInstruction')` 块）
- Modify: `assets/instructions/validator.md:42`

**Interfaces:**
- Consumes: Task 1 的 `MAX_RETRIES`
- Produces: `renderInstruction(text: string, workspace: string): string` 签名不变，新增替换 `{{MAX_RETRIES}}` → `'5'`

- [ ] **Step 1: 写失败测试**

在 `src/engine/loop.test.ts` 的 `describe('renderInstruction')` 块内追加：

```ts
  it('substitutes {{MAX_RETRIES}} with the engine constant', () => {
    const out = renderInstruction('如果 retryCount 已经达到 {{MAX_RETRIES}}：', '.workspace');
    expect(out).toBe('如果 retryCount 已经达到 5：');
  });
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/engine/loop.test.ts -t 'MAX_RETRIES'`
Expected: FAIL——输出仍含字面 `{{MAX_RETRIES}}`

- [ ] **Step 3: 实现渲染**

`src/engine/loop.ts`：import 区加 `import { MAX_RETRIES } from './gate.js';`，`renderInstruction` 改为：

```ts
export function renderInstruction(text: string, workspace: string): string {
  return text
    .replaceAll('{{WORKSPACE}}', workspace)
    .replaceAll('{{MAX_RETRIES}}', String(MAX_RETRIES));
}
```

（函数上方原有的英文注释块保留不动。）

- [ ] **Step 4: 占位符化 validator.md**

先确认硬编码上限只有一处：

Run: `grep -n "达到 5" assets/instructions/validator.md`
Expected: 恰一行（第 42 行「如果 retryCount 已经达到 5：」）

把 `assets/instructions/validator.md` 第 42 行：

```
- 如果 retryCount 已经达到 5：还需将 blocked 设为 `true`，并在 notes 末尾追加 `[BLOCKED: 已达到最大重试次数，跳过此 story]`
```

改为：

```
- 如果 retryCount 已经达到 {{MAX_RETRIES}}：还需将 blocked 设为 `true`，并在 notes 末尾追加 `[BLOCKED: 已达到最大重试次数，跳过此 story]`
```

- [ ] **Step 5: 跑测试确认绿 + 全量检查**

Run: `npm run typecheck && npm test` → 全绿

- [ ] **Step 6: 提交**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts assets/instructions/validator.md
git commit -m "feat: 重试上限统一为引擎单一真相源——validator.md 的硬编码 5 改 {{MAX_RETRIES}} 占位符渲染"
```

---

### Task 4: loop.ts 门禁接线 + Phase 'gating' + dashboard 展示 + 集成测试

**Files:**
- Modify: `src/dashboard/server.ts:10`（`Phase` 类型）
- Modify: `assets/dashboard/dashboard.html:188-194`（`PHASE_MAP`）
- Modify: `src/engine/loop.ts`（循环体接线）
- Modify: `src/engine/loop.test.ts`（`setup` 扩展 + 集成用例）

**Interfaces:**
- Consumes: Task 1/2 的 `readQualityChecks`、`applyGateFailure`、`runQualityChecks`；`tryReadState`（`./state.js` 已导出）
- Produces: 循环行为——门禁失败写 `<workspace>/state.json` 后 `continue`；`Phase` 联合新增 `'gating'`

- [ ] **Step 1: 扩展测试 setup 支持 prd 顶层字段**

`src/engine/loop.test.ts` 的 `setup` 函数改为（仅函数签名与 prd.json 写入行变化）：

```ts
function setup(prdStories: unknown[], prdExtra: Record<string, unknown> = {}): { workspace: string; instructionsDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'loop-ws-'));
  const instructionsDir = mkdtempSync(join(tmpdir(), 'loop-ins-'));
  cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
  cleanup.push(() => rmSync(instructionsDir, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
    project: 'p', branchName: 'ralph/x', description: 'd', userStories: prdStories, ...prdExtra,
  }));
  writeFileSync(join(instructionsDir, 'builder.md'), 'build it');
  writeFileSync(join(instructionsDir, 'validator.md'), 'validate it');
  return { workspace, instructionsDir };
}
```

- [ ] **Step 2: 写失败的集成测试**

在 `describe('runLoop')` 块之后、`describe('runLoop keepOpen')` 之前追加：

```ts
describe('runLoop quality gate', () => {
  // builder 与 validator 共用同一 stub 二进制：以调用计数文件区分谁跑了。
  function fakeCounting(workspace: string): { fake: string; calls: string } {
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    return { fake, calls };
  }

  it('gate failure rolls the story back and skips the validator for that round', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // 打回后 story 未完成，跑满 maxIterations
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].passes).toBe(false);
      expect(state['US-001'].retryCount).toBe(1);
      expect(state['US-001'].blocked).toBe(false);
      expect(state['US-001'].notes).toContain('[门禁失败 - 第1次]');
      expect(state['US-001'].notes).toContain('退出码 7');
      expect(state['US-001'].notes).toContain('gate-boom');
      // builder 被调用、validator 被跳过：stub 恰好只跑了一次
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('gate pass lets the validator run and the loop complete', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      // builder + validator 都跑了
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('warns and disables the gate on malformed qualityChecks without touching state', async () => {
    const { workspace, instructionsDir } = setup([story()], { qualityChecks: 'npm test' });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0); // 门禁未启用，行为与未配置一致
      expect(warns.some((w) => w.includes('qualityChecks 形状非法'))).toBe(true);
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      console.warn = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});
```

- [ ] **Step 3: 跑测试确认红**

Run: `npx vitest run src/engine/loop.test.ts -t 'quality gate'`
Expected: 3 个用例 FAIL——门禁未接线时 qualityChecks 被忽略：用例 1 的 `code` 为 0 而非 1（validator 照跑、story 完成）；用例 3 无警告输出

- [ ] **Step 4: Phase 类型加 'gating'**

`src/dashboard/server.ts` 第 10 行改为：

```ts
export type Phase = 'idle' | 'developing' | 'gating' | 'validating' | 'done' | 'error';
```

- [ ] **Step 5: loop.ts 接线**

`src/engine/loop.ts`：

import 区两处变化：

```ts
import { readFileSync, writeFileSync } from 'node:fs';
import { runQualityChecks, readQualityChecks, applyGateFailure, MAX_RETRIES } from './gate.js';
```

（`MAX_RETRIES` 为 Task 3 已引入的 import，合并成一行。）

循环体中，Developer 块（`if (!builder) { ... } else { ... }`）结束之后、`// Validator` 注释之前，插入：

```ts
      // 机械门禁：builder 之后、validator 之前确定性执行质量检查（fail-fast）。
      // 失败即机械打回并跳过本轮 validator——builder 谎报「检查通过」在此被零成本戳穿。
      const checks = readQualityChecks(before);
      if (checks === 'invalid') {
        console.warn('⚠️  prd.json 的 qualityChecks 形状非法（应为字符串数组），机械门禁未启用');
      } else if (checks && currentStory) {
        dashboard.setState({ phase: 'gating' });
        const gate = await runQualityChecks(checks, agentCwd);
        if (!gate.ok) {
          console.error(`\n❌ 机械门禁未通过（${gate.failure!.command}），打回 ${currentStory} 待下轮重试`);
          const st = tryReadState(statePath);
          if (st) {
            const next = applyGateFailure(st, currentStory, gate.failure!, new Date());
            writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf-8');
          } else {
            // 缺失/损坏都不落盘打回：绝不覆盖可能损坏的文件（同 ensureStateFile 语义）
            console.warn('⚠️  state.json 缺失或不可读，门禁打回未落盘；若文件损坏请运行 npx coding-x repair');
          }
          dashboard.setState({ phase: 'idle' });
          continue;
        }
      }
```

依赖说明：`before`（循环开头读的 prd）与 `currentStory` 均已在循环体开头计算，直接使用；`tryReadState` 已由 `./state.js` 导入。

- [ ] **Step 6: dashboard PHASE_MAP 加条目**

`assets/dashboard/dashboard.html` 的 `PHASE_MAP`（第 188 行起），在 `developing` 与 `validating` 行之间插入：

```js
  gating:     { label: '机械门禁检查中',        color: 'var(--mac-purple)', animate: true },
```

（`--mac-purple` 变量已存在于第 21 行；对齐列宽与相邻行一致。）

- [ ] **Step 7: 跑测试确认绿 + 全量检查**

Run: `npx vitest run src/engine/loop.test.ts` → PASS（含原有用例回归——未配置 qualityChecks 的既有测试路径行为不变）
Run: `npm run typecheck && npm test` → 全绿

- [ ] **Step 8: 提交**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts src/dashboard/server.ts assets/dashboard/dashboard.html
git commit -m "feat: 引擎机械门禁接线——builder 后 validator 前确定性执行 qualityChecks，失败打回跳过该轮 validator；仪表盘新增 gating 阶段"
```

---

### Task 5: doctor 门禁配置检查项（建议级）

**Files:**
- Modify: `src/doctor/doctor.ts`
- Modify: `src/doctor/doctor.test.ts`
- Modify: `src/cli.ts:130`（doctor 分支传 workspace）

**Interfaces:**
- Consumes: `tryReadPrd`（`../engine/prd.js`）、`readQualityChecks`（`../engine/gate.js`）
- Produces:
  - `export interface GateConfigCheckResult { prdPath: string; prdFound: boolean; configured: boolean }`
  - `DoctorOptions` 加 `workspace?: string`（缺省 `'.workspace'`）
  - `DoctorReport` 加 `gate: GateConfigCheckResult`（docsFound=false 时同样填充）
  - 渲染：建议级提示，**不计入问题总数、不影响退出码**

- [ ] **Step 1: 写失败测试**

在 `src/doctor/doctor.test.ts` 末尾追加（确保文件顶部已 import `mkdtempSync, mkdirSync, writeFileSync, rmSync`、`join`、`tmpdir`、`runDoctor, renderDoctorReport`——缺哪个补哪个）：

```ts
describe('runDoctor quality gate config check', () => {
  it('reports prd missing as skipped (not a failure)', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-gate-'));
    try {
      mkdirSync(join(root, 'docs'));
      const report = runDoctor(root);
      expect(report.gate).toEqual({
        prdPath: join('.workspace', 'prd.json'), prdFound: false, configured: false,
      });
      expect(renderDoctorReport(report).exitCode).toBe(0);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('suggests configuring qualityChecks without failing the check', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-gate-'));
    try {
      mkdirSync(join(root, 'docs'));
      mkdirSync(join(root, '.workspace'));
      writeFileSync(join(root, '.workspace', 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd', userStories: [],
      }));
      const report = runDoctor(root);
      expect(report.gate.prdFound).toBe(true);
      expect(report.gate.configured).toBe(false);
      const { text, exitCode } = renderDoctorReport(report);
      expect(text).toContain('建议在 prd.json 顶层配置 qualityChecks');
      expect(exitCode).toBe(0); // 建议级：不影响退出码
    } finally { rmSync(root, { recursive: true, force: true }); }
  });

  it('reports configured, honoring a custom workspace, and still works without docs/', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-gate-'));
    try {
      mkdirSync(join(root, 'run'));
      writeFileSync(join(root, 'run', 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd', userStories: [],
        qualityChecks: ['npm test'],
      }));
      // 故意不建 docs/：gate 检查独立于知识库存在与否
      const report = runDoctor(root, { workspace: 'run' });
      expect(report.docsFound).toBe(false);
      expect(report.gate).toEqual({
        prdPath: join('run', 'prd.json'), prdFound: true, configured: true,
      });
      expect(renderDoctorReport(report).text).toContain('机械门禁');
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
```

- [ ] **Step 2: 跑测试确认红**

Run: `npx vitest run src/doctor/doctor.test.ts -t 'quality gate'`
Expected: FAIL——`report.gate` 为 undefined

- [ ] **Step 3: 实现**

`src/doctor/doctor.ts`：

import 区加：

```ts
import { tryReadPrd } from '../engine/prd.js';
import { readQualityChecks } from '../engine/gate.js';
```

接口变更：

```ts
export interface GateConfigCheckResult {
  /** 展示用的相对路径（如 .workspace/prd.json） */
  prdPath: string;
  /** workspace/prd.json 是否存在；不存在时跳过本项检查，不计失败 */
  prdFound: boolean;
  /** prd.json 存在时：顶层是否配置了非空合法 qualityChecks */
  configured: boolean;
}

export interface DoctorOptions {
  /** git 最后提交日期晚于 updated 超过该天数判过期；0 表示晚一天即过期。缺省 30。 */
  staleDays?: number;
  /** 引擎工作区目录（相对项目根），门禁配置检查用。缺省 .workspace。 */
  workspace?: string;
}
```

`DoctorReport` 加字段 `gate: GateConfigCheckResult;`。

`runDoctor` 函数体开头（`const docsDir = ...` 之前）加：

```ts
  const workspace = options.workspace ?? '.workspace';
  const prdRel = join(workspace, 'prd.json');
  let gate: GateConfigCheckResult = { prdPath: prdRel, prdFound: false, configured: false };
  if (existsSync(join(root, prdRel))) {
    const checks = readQualityChecks(tryReadPrd(join(root, prdRel)));
    gate = { prdPath: prdRel, prdFound: true, configured: Array.isArray(checks) };
  }
```

两处 return 都带上 `gate`：早返回改为 `return { docsFound: false, frontmatter: null, freshness: null, agentsIndex: null, links: null, gate };`；末尾 return 加 `gate,`。

`renderDoctorReport`：加私有渲染函数，并在两个分支使用：

```ts
function renderGateLines(gate: GateConfigCheckResult): string[] {
  const lines = ['⚙️  机械门禁配置'];
  if (!gate.prdFound) {
    lines.push(`  ℹ️  未找到 ${gate.prdPath}：已跳过门禁配置检查`);
  } else if (gate.configured) {
    lines.push('  ✅ 已配置 qualityChecks（引擎每轮 builder 后确定性执行）');
  } else {
    lines.push('  💡 建议在 prd.json 顶层配置 qualityChecks（如 ["npm run typecheck", "npm test"]）：引擎将在每轮 builder 之后机械执行、失败确定性打回（建议项，不计失败）');
  }
  return lines;
}
```

- docsFound=false 早返回：text 改为原提示行 + 空行 + `renderGateLines` 各行（`[原行, '', ...renderGateLines(report.gate)].join('\n')`），exitCode 仍 0
- 正常路径：在「🔗 文档相对链接」段之后、total 汇总行之前，`lines.push('', ...renderGateLines(report.gate));`
- `total` 计算**不变**（gate 不参与）

`src/cli.ts` doctor 分支改为：

```ts
    const { text, exitCode } = renderDoctorReport(runDoctor(process.cwd(), { staleDays: cfg.staleDays, workspace: cfg.workspace }));
```

- [ ] **Step 4: 跑测试确认绿 + 全量检查**

Run: `npx vitest run src/doctor/doctor.test.ts` → PASS（含既有用例回归——若既有用例对 report 做了整体形状断言，补 `gate` 字段的期望值）
Run: `npm run typecheck && npm test` → 全绿

- [ ] **Step 5: 提交**

```bash
git add src/doctor/doctor.ts src/doctor/doctor.test.ts src/cli.ts
git commit -m "feat: doctor 新增机械门禁配置建议项——workspace prd.json 缺 qualityChecks 时提示，建议级不影响退出码"
```

---

### Task 6: prd-to-json 派生链——提取 qualityChecks 并验证基线全绿

**Files:**
- Modify: `skills/prd-to-json/SKILL.md`

（纯 prompt 文档任务，无代码测试；验证方式为逐处核对落位。）

- [ ] **Step 1: 输出格式加字段**

「输出格式」JSON 示例中 `"sourcePrd"` 行之后加一行：

```json
  "qualityChecks": ["npm run typecheck", "npm test"],
```

- [ ] **Step 2: 输出格式之后新增说明节**

在「输出格式」节末尾（`sourcePrd` 仅当…省略该字段」段之后、「Story 大小：第一规则」之前）插入：

```markdown
---

## qualityChecks：机械门禁命令（推荐配置）

顶层可选字段。引擎每轮 builder 之后、validator 之前逐条 shell 执行这些命令（fail-fast），任一非零退出码即确定性打回当前 story（passes 设回 false、retryCount +1、notes 写 `[门禁失败]` 详情）并跳过该轮 validator。

生成规则：

- 从目标项目提取候选：`package.json` scripts 里的 typecheck / lint / test 类命令、根 `AGENTS.md` 的关键命令节
- 廉价检查放前面（typecheck → lint → test）：fail-fast 下失败得更早
- 把候选命令随转换对照表一并呈现，请用户确认
- 提取不到可靠命令时省略该字段（门禁不启用），不要编造
```

- [ ] **Step 3: 转换规则加一条**

「转换规则」编号列表（现有 8 条）末尾加：

```markdown
9. **qualityChecks 提取**：按上方「qualityChecks」节从目标项目提取候选并请用户确认；提取不到可靠命令时省略该字段
```

- [ ] **Step 4: 保存前检查清单加一项**

「保存前检查清单」列表中「顶层 `sourcePrd` 已填…」一项之后加：

```markdown
- [ ] qualityChecks 已配置时：写入前逐条真实跑一遍、确认当前基线全绿——命令不存在、命令写错、基线本来就红，都必须在这里（有人在场的派生环节）拦截，否则 builder 会在循环里白烧 5 轮到 blocked；基线绿同时保证循环中门禁失败必然是 builder 引入的
```

- [ ] **Step 5: 核对与提交**

核对：四处改动都已落位、与既有格式（分隔线、编号、清单语气）一致；「不写状态字段」规则与新字段无冲突（qualityChecks 是需求侧配置，非执行状态）。

```bash
git add skills/prd-to-json/SKILL.md
git commit -m "feat: prd-to-json 派生 qualityChecks——从目标项目提取候选经用户确认，写入前试跑验证基线全绿"
```

---

### Task 7: README 同步 + ADR-005

**Files:**
- Modify: `README.md`（5 处）
- Create: `docs/decisions/005-engine-quality-gate.md`

- [ ] **Step 1: README「工作原理」ASCII 图加门禁框**

在 Developer 框（`└──…┘`，约第 43 行）与 Validator 框之间的 `↓` 后插入（列宽与相邻框对齐）：

```
   │   ┌── 机械门禁（qualityChecks，可选）───────────────────┐ │
   │   │ 引擎逐条 shell 执行质量检查命令（fail-fast）        │ │
   │   │ 失败 → 确定性打回 story、跳过本轮 Validator          │ │
   │   └────────────────────────────────────────────────────┘ │
   │                          ↓                               │
```

- [ ] **Step 2: README「工作原理」要点列表加一条**

「超时保护」条目之后加：

```markdown
- **机械门禁（可选）**：`prd.json` 顶层配置 `qualityChecks`（完整 shell 命令数组）后，引擎在每轮开发之后、验证之前逐条确定性执行（fail-fast，单条超时 10 分钟）；失败即机械打回（`retryCount` +1，累计 5 次 `blocked`）并跳过该轮 validator——builder 谎报「检查通过」会被零成本戳穿。未配置时行为不变，`npx coding-x doctor` 会给出配置建议。
```

- [ ] **Step 3: README prd.json 结构示例加字段**

「`prd.json` 结构」jsonc 块中 `"sourcePrd"` 行之后加：

```jsonc
  "qualityChecks": ["npm run typecheck", "npm test"],  // 机械门禁（可选）：每轮 builder 后引擎逐条执行，失败确定性打回
```

- [ ] **Step 4: README 功能清单与参数表**

「引擎（`npx coding-x`）」功能清单中「自动重试与阻塞保护」条目之后加：

```markdown
- **机械门禁（qualityChecks）**：引擎在 Developer 与 Validator 之间确定性执行项目质量检查（`prd.json` 顶层配置），失败机械打回并跳过该轮验证——LLM 验证链之下不可共谋、不可绕过的确定性防线。
```

命令行参数表两处说明补充：

- `--workspace <dir>` 行说明追加：「；`doctor` 用它定位 prd.json 做门禁配置检查」
- 位置参数 `doctor` 行说明中「文档相对链接」之后追加：「、机械门禁配置建议（建议级，不计失败）」

- [ ] **Step 5: 写 ADR-005**

创建 `docs/decisions/005-engine-quality-gate.md`：

```markdown
---
title: 005-engine-quality-gate
status: active
updated: 2026-07-05
scope: root
---

# 005. 验证链引入引擎机械门禁（确定性验证层）

## 背景

引擎完成判定完全信任 state.json 的 passes 字段，验证链 builder → validator → /review-loop → 人全部是概率性防线（LLM 复核 LLM），「validator 共谋假绿」已有实证（0.12.x，见 glossary「假绿」）。外部触发：雷哥《Agents增加指令遵从的方法》——指令遵从靠提高造假成本，结果验证靠确定性程序独立复跑。

## 决策

prd.json 顶层可选 `qualityChecks`（完整 shell 命令数组）；引擎在每轮 builder 之后、validator 之前逐条执行（fail-fast，单条超时 10 分钟），任一非零退出码即机械打回（passes=false、retryCount+1、notes 写 `[门禁失败]`、达 MAX_RETRIES 转 blocked）并跳过该轮 validator。打回上限 MAX_RETRIES=5 以引擎为单一真相源，validator.md 经 `{{MAX_RETRIES}}` 渲染共享。配置错误在派生环节拦截：prd-to-json 写入前试跑并确认基线全绿。

## 理由与备选

- **为什么在引擎而非 git hooks**：pre-commit 侵入目标仓库配置、agent 可 `--no-verify` 绕过；引擎层不可绕过、不可共谋，且与项目定位同构——循环编排已是确定性程序，验证中可机械化的部分应当下沉。
- **为什么跳过该轮 validator**：门禁失败已足以打回，validator 那轮 token 纯属浪费；失败信息（输出尾部）直接进 notes 供 builder 下轮重现。
- **为什么 validator 不减负**（门禁通过后仍逐条验收含 Typecheck passes 类 AC）：让 validator 跳过已覆盖条目需要 AC↔命令映射，复杂度不值；保留冗余防线，有实证再优化。
- **为什么不做独立子命令**（`coding-x gate`）：用户手动验证直接敲 npm test 即可，多余入口（YAGNI）。
```

- [ ] **Step 6: 核对与提交**

核对：README 五处落位、ASCII 图列对齐渲染正常（可用 `sed -n '32,62p' README.md` 目检）；ADR frontmatter 四字段齐全。

```bash
git add README.md docs/decisions/005-engine-quality-gate.md
git commit -m "docs: README 同步机械门禁（工作原理图/要点/prd.json 结构/功能清单/参数表）；ADR-005 记录确定性验证层决策与否因"
```

---

### Task 8: 发版 0.14.0

**Files:**
- Modify: `package.json` + `package-lock.json` + 三个插件清单（由 `npm version` 钩子自动同步）

- [ ] **Step 1: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 全绿（含 `build/version-consistency.test.mjs` 的版本一致性校验）

- [ ] **Step 2: 升 minor 版本**

```bash
npm version minor -m "release: v%s"
```

Expected: 生成 `0.14.0` 提交与 `v0.14.0` tag；version 钩子已自动同步 `.claude-plugin/`、`.cursor-plugin/`、`.codex-plugin/` 三个清单（`build/sync-plugin-versions.mjs`）

- [ ] **Step 3: 推送触发发布**

```bash
git push && git push --tags
```

Expected: `publish.yml`（tag `v*` 触发）自动执行——tag 与四处 version 一致性防呆 → 发布 npm + 创建 GitHub Release。稍后可用 `npm view coding-x version` 验证（CI 有分钟级延迟）。

---

## 计划自审记录（写入时已核）

- **Spec 覆盖**：设计稿 18 条锁定决策——1/2（时序与条件）→ Task 4；3（字段与守卫）→ Task 1；4（模块形态）→ Task 1/2；5（打回同构）→ Task 1；6（MAX_RETRIES 真相源）→ Task 3；7-11（fail-fast/shell/tee/超时/不特判 127）→ Task 2；12（validator 不减负）→ 无代码改动，ADR 记录否因；13（dashboard）→ Task 4；14（doctor）→ Task 5；15（派生链）→ Task 6；16（prd-generate 不动）→ 无任务（非目标）；17（state 损坏边界）→ Task 4 Step 5 else 分支；18（版本/README/ADR）→ Task 7/8。
- **类型一致性**：`GateFailure`/`GateResult`/`readQualityChecks` 返回联合、`applyGateFailure` 签名在 Task 1 定义后各任务引用一致；`renderInstruction` 签名不变。
- **既有测试回归风险**：doctor.test.ts 若有对 `DoctorReport` 的整体形状断言需补 `gate` 字段（Task 5 Step 4 已注明）；loop.test.ts 的 `setup` 扩展带缺省参数，既有调用零改动。
