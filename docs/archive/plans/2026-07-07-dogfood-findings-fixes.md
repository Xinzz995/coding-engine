---
title: dogfood 发现修复轮实施计划（0.18.1）
status: done
updated: 2026-07-07
scope: root
---

# dogfood 发现修复轮（findings a–e）Implementation Plan

> **For agentic workers:** Execute this plan task by task using the available agent workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 修复 dogfood 轮实证的三处引擎缺陷（仲裁标签保全窄、blocked 被覆盖、篡改归档误导 agent）并校准两处文档规范（断言 #1、review-loop 回流），发版 0.18.1。

**Architecture:** 仲裁标签前缀族以 `gate.ts` 为单一真相源（`ARBITRATION_PREFIXES` + `isArbitrationLine`），四个消费方（gate 过滤、status 高亮、builder.md/validator.md 经 `{{ARBITRATION_PREFIXES}}` 占位符渲染）全部指回；blocked 保护分两层（applyGateFailure 尊重 prev.blocked + 循环在门禁前识别 agent 显式阻塞并跳过门禁与验收）；篡改归档凭证走纯 prompt 声明，零代码。

**Tech Stack:** TypeScript strict/ESM（NodeNext，相对导入必须 `.js` 后缀）、Vitest、既有 `renderInstruction` 占位符机制（`{{MAX_RETRIES}}` 先例）。

**Source spec:** `docs/specs/2026-07-07-dogfood-findings-fixes-design.md`

## Global Constraints

- 每次提交前 `npm run typecheck` 与 `npm test` 必须全绿（AGENTS.md 硬约束 1）
- `src/` 内相对导入写 `.js` 扩展名（硬约束 2）
- 提交说明中文，conventional 前缀（feat:/fix:/docs:/test:）保留英文（硬约束 6）
- 只改 spec 改动清单内文件；README/ADR 复核标准：出现「notes 保全」或「blocked 重算」粒度的描述才需同步，否则不动
- 版本 0.18.1 patch：用 `npm version patch`（钩子自动同步插件清单+lock），`git push --follow-tags` 后停手——publish 与 GitHub Release 归 tag 触发的 CI，本地不抢发
- 仲裁标签族的准确值（全计划一致）：`['[需求冲突]', '[需要人工核实]']`；占位符渲染形态：中文顿号连接 → `[需求冲突]、[需要人工核实]`

---

### Task 1: gate.ts 仲裁前缀族单源 + blocked 保持 + status 高亮扩族

**Files:**
- Modify: `src/engine/gate.ts`（第 7 行 MAX_RETRIES 下方加常量；`applyGateFailure` 第 123-140 行）
- Modify: `src/status/status.ts:90`
- Test: `src/engine/gate.test.ts`（`describe('applyGateFailure')` 内追加）
- Test: `src/status/status.test.ts`（仿第 247 行既有 🚨 用例追加）

**Interfaces:**
- Produces: `export const ARBITRATION_PREFIXES: readonly string[]`（值见全局约束）与 `export function isArbitrationLine(line: string): boolean`，位于 `src/engine/gate.ts`——Task 2 的 renderInstruction 与本任务的 status.ts 都 import 它们
- 行为契约：`applyGateFailure` 保全所有 `isArbitrationLine` 为真的行置于新 notes 之前；`prev.blocked === true` 时结果 `blocked` 保持 `true` 且**不**追加 `[BLOCKED: 已达到最大重试次数…]` 行（该文案仅在本次打回令 retryCount 达上限时追加）

- [ ] **Step 1: 写三个失败测试（gate.test.ts）**

在 `describe('applyGateFailure')` 内追加（沿用文件内既有 `failure()`/`now` helper）：

```ts
  it('keeps [需要人工核实] arbitration lines the same way as [需求冲突]', () => {
    const state: RunState = {
      'US-001': {
        passes: false,
        notes: '[需要人工核实] 2026-07-07 19:00 门禁配置来源存疑，已附调查过程\n普通旧失败行',
        retryCount: 0,
        blocked: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].notes.startsWith(
      '[需要人工核实] 2026-07-07 19:00 门禁配置来源存疑，已附调查过程\n[门禁失败 - 第1次]',
    )).toBe(true);
    expect(next['US-001'].notes).not.toContain('普通旧失败行');
  });

  it('keeps mixed arbitration lines in original order before the failure block', () => {
    const state: RunState = {
      'US-001': {
        passes: false,
        notes: '[需求冲突] 冲突点 A\n[需要人工核实] 疑点 B\n其他旧内容',
        retryCount: 0,
        blocked: false,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].notes.startsWith('[需求冲突] 冲突点 A\n[需要人工核实] 疑点 B\n[门禁失败 - 第1次]')).toBe(true);
  });

  it('preserves an explicit blocked=true set by the agent and skips the max-retries banner', () => {
    const state: RunState = {
      'US-001': {
        passes: false,
        notes: '[需要人工核实] 已置 blocked 待人工',
        retryCount: 0,
        blocked: true,
      },
    };
    const next = applyGateFailure(state, 'US-001', failure(), now);
    expect(next['US-001'].blocked).toBe(true);
    expect(next['US-001'].retryCount).toBe(1);
    expect(next['US-001'].notes).not.toContain('[BLOCKED: 已达到最大重试次数');
  });
```

- [ ] **Step 2: 跑测确认三红**

Run: `npx vitest run src/engine/gate.test.ts`
Expected: 新增 3 用例 FAIL（第 1、2 个因 `[需要人工核实]` 行被丢；第 3 个因 blocked 被重算为 false——注意第 3 用例断言 `retryCount` 为 1 天然成立，红点在 blocked）；既有用例全绿

- [ ] **Step 3: 实现 gate.ts**

第 7 行 `MAX_RETRIES` 声明之后追加：

```ts
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
```

`applyGateFailure` 内三处修改：

```ts
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
```

同时更新函数 JSDoc 中「原有 [需求冲突] 行原样保留在前」的表述为「原有仲裁标签行（ARBITRATION_PREFIXES）原样保留在前」。

- [ ] **Step 4: 跑测确认转绿**

Run: `npx vitest run src/engine/gate.test.ts`
Expected: 全部 PASS（含既有 `keeps [需求冲突] lines...` 用例——单标签是前缀族子集，行为不变）

- [ ] **Step 5: 写 status 失败测试（status.test.ts）**

仿第 247 行既有用例结构（同一 describe、同款 setup/teardown 与 `renderStatusReport(collectStatus(ws))` 调用）追加：

```ts
  it('marks [需要人工核实] note lines with the same warning as [需求冲突]', () => {
    // setup 与既有 🚨 用例相同：写 prd.json 与 state.json 后 collectStatus
    // state 中该 story：
    //   notes: '[需要人工核实] 2026-07-07 19:00 门禁配置来源存疑，已置 blocked 待人工'
    const { text } = renderStatusReport(collectStatus(ws));
    const line = text.split('\n').find((l) => l.includes('[需要人工核实]'));
    expect(line).toBeDefined();
    expect(line).toContain('🚨');
  });
```

（setup 细节照抄相邻用例——同文件第 247-270 行是完整参照，仅 notes 文本换成上述内容。）

- [ ] **Step 6: 跑测确认红**

Run: `npx vitest run src/status/status.test.ts`
Expected: 新用例 FAIL（该行渲染为 `· ` 前缀而非 `🚨`）

- [ ] **Step 7: 实现 status.ts**

第 90 行改为前缀族匹配（文件头部 import 区追加 `import { isArbitrationLine } from '../engine/gate.js';`——status.ts 已依赖 engine 层，无新依赖方向）：

```ts
      lines.push(isArbitrationLine(note) ? `      🚨 ${note}` : `      · ${note}`);
```

- [ ] **Step 8: 跑全量测试与 typecheck**

Run: `npm run typecheck && npm test`
Expected: 全绿（217 + 新增 4 = 221 tests）

- [ ] **Step 9: Commit**

```bash
git add src/engine/gate.ts src/engine/gate.test.ts src/status/status.ts src/status/status.test.ts
git commit -m "fix: 仲裁标签前缀族单源（gate.ts）——打回保全与 status 高亮扩族，agent 显式 blocked 不被门禁重算翻回"
```

---

### Task 2: loop.ts 占位符渲染 + agent 显式 blocked 当轮跳过门禁与验收

**Files:**
- Modify: `src/engine/loop.ts`（`renderInstruction` 第 47-51 行；门禁段第 139-162 行；validator 段第 167-175 行）
- Test: `src/engine/loop.test.ts`（`describe('runLoop quality gate')` 内追加 + renderInstruction 直测）

**Interfaces:**
- Consumes: Task 1 的 `ARBITRATION_PREFIXES`（loop.ts 第 7 行既有 gate.js import 语句中追加）
- Produces: `renderInstruction` 新占位符 `{{ARBITRATION_PREFIXES}}` → `[需求冲突]、[需要人工核实]`（Task 3 的两份 md 依赖此渲染）；循环行为——currentStory 在 builder 后已 `blocked: true` 时：不执行 qualityChecks、不拉起 validator、console 打 `⏭️` 说明行、完成判定当轮正常收敛

- [ ] **Step 1: 写 renderInstruction 失败测试**

loop.test.ts 顶层（与既有顶层 describe 平级）追加：

```ts
describe('renderInstruction arbitration placeholder', () => {
  it('renders {{ARBITRATION_PREFIXES}} as a 、-joined label list', () => {
    const out = renderInstruction('保全 {{ARBITRATION_PREFIXES}} 行', '.workspace');
    expect(out).toBe('保全 [需求冲突]、[需要人工核实] 行');
  });
});
```

（`renderInstruction` 已由 loop.ts 导出；确认测试文件 import 语句包含它，没有则追加。）

- [ ] **Step 2: 跑测确认红**

Run: `npx vitest run src/engine/loop.test.ts -t 'arbitration placeholder'`
Expected: FAIL（占位符原样残留）

- [ ] **Step 3: 实现 renderInstruction**

loop.ts 第 7 行 import 追加 `ARBITRATION_PREFIXES`；`renderInstruction` 改为：

```ts
export function renderInstruction(text: string, workspace: string): string {
  return text
    .replaceAll('{{WORKSPACE}}', workspace)
    .replaceAll('{{MAX_RETRIES}}', String(MAX_RETRIES))
    .replaceAll('{{ARBITRATION_PREFIXES}}', ARBITRATION_PREFIXES.join('、'));
}
```

- [ ] **Step 4: 跑测确认绿**

Run: `npx vitest run src/engine/loop.test.ts -t 'arbitration placeholder'`
Expected: PASS

- [ ] **Step 5: 写 agent 显式 blocked 的失败测试**

`describe('runLoop quality gate')` 内追加（`fakeCounting` 是既有 helper；`setup`/`story` 同文件既有）：

```ts
  it('an agent-set blocked story skips the gate and validator for that round and resolves the loop', async () => {
    const gateMark = join(tmpdir(), `coding-x-gate-mark-${Date.now()}`);
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: [`node -e 'require("node:fs").writeFileSync("${gateMark}", "ran")'`],
    });
    // stub agent：不置 passes，而是显式置 blocked（模拟 dogfood US-009 的仲裁上报）
    const fake = join(workspace, 'fake-blocking.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: false, notes: '[需要人工核实] 疑似配置异常，已附调查', retryCount: 0, blocked: true },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 3, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0); // blocked 属 resolved，完成判定当轮收敛
      expect(existsSync(gateMark)).toBe(false); // 门禁命令未执行
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1); // 只有 builder，validator 未拉起
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].blocked).toBe(true);
      expect(state['US-001'].retryCount).toBe(0); // 未被门禁打回推进
      expect(state['US-001'].notes).toContain('[需要人工核实]'); // 仲裁记录未被覆盖
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
      rmSync(gateMark, { force: true });
    }
  });
```

（确认测试文件 import 含 `existsSync`、`rmSync`、`tmpdir`——缺则在既有 `node:fs`/`node:os` import 中补。）

- [ ] **Step 6: 跑测确认红**

Run: `npx vitest run src/engine/loop.test.ts -t 'agent-set blocked'`
Expected: FAIL——现行引擎会执行门禁（`existsSync(gateMark)` 为 true），且门禁失败与否都与预期行为不符（qualityChecks 命令本身 exit 0，门禁「通过」后 validator 会被拉起 → calls 为 2）

- [ ] **Step 7: 实现 loop.ts 的 blocked 跳过**

门禁段（第 139 行 `const gateRead = guard.read();` 与 `if (gateRead.restoreFailed)` 之后、`const checks = ...` 之前）插入：

```ts
      // agent 轮内显式置 blocked（仲裁上报，如 [需要人工核实]）：机械路径不得推进它——
      // 当轮跳过门禁执行与验收，完成判定按 resolved 正常收敛。
      // 第四检测点（上方 guard.read()）保持无条件执行：篡改恢复不因跳过而延后。
      const agentBlocked = !!(currentStory && tryReadState(statePath)?.[currentStory]?.blocked);
      if (agentBlocked) {
        console.log(`⏭️  ${currentStory} 已被置 blocked（待人工处理），本轮跳过门禁与验收`);
      }
```

门禁执行分支条件从 `} else if (checks && currentStory) {` 改为：

```ts
      } else if (!agentBlocked && checks && currentStory) {
```

validator 拉起分支从 `} else if (validator) {` 改为（skipValidator 警告分支保持在前不动）：

```ts
      } else if (validator && !agentBlocked) {
```

- [ ] **Step 8: 跑全量测试与 typecheck**

Run: `npm run typecheck && npm test`
Expected: 全绿（既有门禁用例不受影响——它们的 state 无 blocked=true）

- [ ] **Step 9: Commit**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "fix: agent 显式置 blocked 当轮跳过门禁与验收（机械路径不推进仲裁上报）；renderInstruction 增 {{ARBITRATION_PREFIXES}} 渲染"
```

---

### Task 3: 两份指令 md 占位符化 + prd.json 权威凭证声明 + 防漂移断言

**Files:**
- Modify: `assets/instructions/builder.md`（第 95-106 行「需求来源与冲突处理」节）
- Modify: `assets/instructions/validator.md`（第 29 行、第 34 行、第 67 行附近）
- Test: `src/engine/loop.test.ts`（`describe('instruction assets arbitration contract')` 新增）

**Interfaces:**
- Consumes: Task 2 的 `{{ARBITRATION_PREFIXES}}` 渲染（md 中写占位符，运行时经 renderInstruction 展开）
- Produces: 两份 md 的行为约定文本（无代码接口）；防漂移断言保证 md 与 gate.ts 单源不脱钩

- [ ] **Step 1: 写防漂移失败断言**

loop.test.ts 顶层追加：

```ts
describe('instruction assets arbitration contract', () => {
  const read = (f: string) =>
    readFileSync(new URL(`../../assets/instructions/${f}`, import.meta.url), 'utf-8');

  it('builder.md and validator.md reference the arbitration placeholder, not hardcoded label lists', () => {
    expect(read('builder.md')).toContain('{{ARBITRATION_PREFIXES}}');
    expect(read('validator.md')).toContain('{{ARBITRATION_PREFIXES}}');
  });

  it('both instructions carry the prd.json authority statement', () => {
    for (const f of ['builder.md', 'validator.md']) {
      expect(read(f)).toContain('prd.tampered-');
      expect(read(f)).toContain('快照保护');
    }
  });
});
```

- [ ] **Step 2: 跑测确认红**

Run: `npx vitest run src/engine/loop.test.ts -t 'arbitration contract'`
Expected: 两用例 FAIL（md 尚无占位符与声明）

- [ ] **Step 3: 改 builder.md**

「需求来源与冲突处理」节内，第 97 行「……验收只以它的 acceptanceCriteria 为准。」之后另起一段追加：

```markdown
prd.json 受引擎运行期快照保护（运行中被改会被自动检测、恢复并存档）：你读到的内容就是本轮权威验收标准，无需自行审计它的来源与完整性。`{{WORKSPACE}}/prd.tampered-*.json` 是引擎已检测并处置的篡改存档，供人工审查，与你的任务无关。
```

第 106 行「冲突留给人工裁决……」段之后追加一段：

```markdown
除需求冲突外，若你遇到其他必须人工介入才能安全继续的情况（例如怀疑运行配置异常、环境异常且无法自行排除）：在该 story 的 `notes` 追加一行以 `[需要人工核实]` 开头的记录（简述疑点与关键证据），并将该 story 的 `blocked` 设为 `true` 等待人工处理——引擎会因此跳过对该 story 的门禁与验收，不会推进重试。引擎与人工流程只把以 {{ARBITRATION_PREFIXES}} 开头的行识别为仲裁记录，不要发明新标签。
```

- [ ] **Step 4: 改 validator.md**

第 29 行整行替换：

```markdown
- 清理 notes 字段：若其中存在以 {{ARBITRATION_PREFIXES}} 任一标签开头的行，只保留这些行；否则清空为空字符串 `""`（仲裁记录必须留到人工裁决，不随验证通过消失）
```

第 34 行括号内替换：

```markdown
- 在 notes 字段写入失败详情（若原 notes 中存在以 {{ARBITRATION_PREFIXES}} 任一标签开头的行，将它们原样保留在新内容之前），格式如下：
```

第 67 行约束「**不得修改 prd.json**（只读需求文件）」之后同段追加：

```markdown
prd.json 受引擎运行期快照保护，你读到的内容就是本轮权威验收标准，无需自行审计其来源；`{{WORKSPACE}}/prd.tampered-*.json` 是引擎已处置的篡改存档，供人工审查，不影响你的验证。
```

- [ ] **Step 5: 跑测确认绿 + 全量**

Run: `npx vitest run src/engine/loop.test.ts -t 'arbitration contract' && npm run typecheck && npm test`
Expected: 全 PASS

- [ ] **Step 6: 构建冒烟（assets 拷贝链）**

Run: `npm run build && grep -c "ARBITRATION_PREFIXES" dist/instructions/builder.md dist/instructions/validator.md`
Expected: 两文件计数均 ≥1（占位符随 assets 进 dist，运行时由 renderInstruction 展开）

- [ ] **Step 7: Commit**

```bash
git add assets/instructions/builder.md assets/instructions/validator.md src/engine/loop.test.ts
git commit -m "feat: 指令资产接入仲裁标签单源与 prd.json 权威凭证声明——builder 通用仲裁用法（[需要人工核实]+blocked）、validator 保全规则占位符化"
```

---

### Task 4: 文档校准 + 发版 0.18.1

**Files:**
- Modify: `docs/dogfood-regression.md`（断言 #1 验证点列）
- Modify: `commands/review-loop.md`（第 4 节 `[已修]` 定义行）
- Modify: `docs/archive/dogfood/2026-07-07-dogfood-findings.md`（frontmatter status → done）
- Modify: `docs/specs/2026-07-07-dogfood-findings-fixes-design.md`（status → done）
- Modify: `docs/plans/2026-07-07-dogfood-findings-fixes.md`（status → done，发版提交内）

**Interfaces:**
- Consumes: Task 1-3 已合入 main 的全部行为（发版打包对象）
- Produces: npm 0.18.1 + GitHub Release（CI 完成）

- [ ] **Step 1: 断言 #1 验证点校准**

dogfood-regression.md 第 20 行（断言 #1 行）的「验证点」列从「story 过程记录出现探测命令；无「无浏览器工具」自判」替换为：

```markdown
UI story 的 builder 输出含真实浏览器验证记录（操作序列/截图对账）；无以 HTTP 冒烟等价替代的表述（--print 模式无过程 transcript，2026-07-07 起以输出与工件为核对面）
```

（断言列与来源列 `0.12.1 条件句翻车` 保持不动。）

- [ ] **Step 2: review-loop.md 回流要求**

第 4 节四态定义中 `[已修] <detail>：detail 引用修复提交哈希` 一行之后追加同级列表项：

```markdown
  - `[已修]` 的发现属 AC 缺失/AC 错误类（动作三档判据①）时，detail 除修复提交外必须含源 PRD 的回补提交（回补后按需再派生）——review 修复不回流源 PRD，重跑同一 PRD 会复现同一缺口（2026-07-07 dogfood 两轮复现实证）
```

- [ ] **Step 3: README/ADR 复核（预期不动）**

Run: `grep -n "需求冲突\|保全\|blocked" README.md docs/decisions/*.md | grep -v "^docs/decisions/007" | head`
判断：输出中若无「notes 保全规则」或「blocked 重算」粒度的行为描述则无需改动（README:67 的门禁段只到「retryCount +1，累计 5 次 blocked」粒度——新行为不与之矛盾：达上限依旧 blocked，本轮只是增加保持语义）；若发现矛盾表述，最小修正后一并提交。

- [ ] **Step 4: 状态收尾三份文档**

findings 文档、spec、本计划的 frontmatter `status: active` → `status: done`，`updated` → 当天。

- [ ] **Step 5: 全量验证后提交文档**

Run: `npm run typecheck && npm test && node dist/cli.js doctor`
Expected: 全绿（doctor 校验 frontmatter 与新鲜度）

```bash
git add docs/dogfood-regression.md commands/review-loop.md docs/archive/dogfood/2026-07-07-dogfood-findings.md docs/specs/2026-07-07-dogfood-findings-fixes-design.md docs/plans/2026-07-07-dogfood-findings-fixes.md
git commit -m "docs: 断言#1 校准为可观察形态、review-loop [已修] 补 AC 缺失类源 PRD 回流要求、findings/spec/plan 置 done"
```

- [ ] **Step 6: 发版**

```bash
npm version patch -m "release: v%s"
git push --follow-tags
```

Expected: 钩子自动同步插件清单与 lock 进版本提交；push 后**停手**——publish 与 GitHub Release 由 tag 触发的 CI 完成。

- [ ] **Step 7: CI 与产物确认**

Run（等待 1-2 分钟后）: `gh run list --limit 3` 与 `npm view coding-x version`
Expected: `Publish to npm (v0.18.1)` 与 `Test (main)` 双 success；npm 显示 `0.18.1`；`gh release view v0.18.1` 存在

- [ ] **Step 8: 更新 SDD ledger**

`.coding-x-local/sdd/progress.md` 追加本轮完成记录（任务清单、审查战果、defer 项）。

---

## Self-Review 记录

- Spec 覆盖：决策 1→T1(常量/过滤/status)+T2(渲染)+T3(md)；决策 2→T1(b-i)+T2(b-ii)；决策 3→T3；决策 4→T4.1；决策 5→T4.2；决策 6→T1/T2/T3 各测试步；决策 7→T4.3-7 ✓
- 占位符扫描：无 TBD/「适当处理」类；所有代码步含完整代码 ✓
- 类型一致：`ARBITRATION_PREFIXES`/`isArbitrationLine` 名称在 T1 定义、T2 import、T3 断言文本、status.ts 引用中一致；`as const` 数组与 `readonly string[]` 接口兼容（`.some`/`.join` 均可用）✓
