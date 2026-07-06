---
title: "计划：模型路由——不同任务使用不同能力的模型"
status: active
updated: 2026-07-06
scope: root
---

# 模型路由 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 引擎按阶段（builder/validator）、按 story、按重试升级三个维度给 agent 子进程分配不同模型（`--model` 透传），缺省行为与现状逐字节一致。

**Architecture:** prd.json 顶层新增可选 `models` 段（builder/validator/escalation/escalateAfter）与 story 级可选 `model` 字段；新模块 `src/engine/models.ts` 纯函数解析优先级链（CLI 覆盖 > escalation（retryCount ≥ escalateAfter 时）> story.model > 顶层默认 > 不传）；loop.ts 每轮解析并透传给 runAgent；模型名不透明字符串直接透传，引擎不校验不映射。

**Tech Stack:** TypeScript (strict, ESM)、Node ≥18、Vitest、tsup。零新依赖。

**Spec:** `docs/superpowers/specs/2026-07-06-model-routing-design.md`

## Global Constraints

- `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）
- 每个任务提交前必须通过 `npm run typecheck` 与 `npm test`
- 提交说明必须用中文（conventional 类型前缀 feat:/fix:/docs: 等保留英文）
- 缺省行为不变：`models` 缺失、CLI 参数缺失时，拉起 agent 的 argv 与现状逐字节一致（不出现 `--model`）
- 打回上限单源：`MAX_RETRIES = 5` 定义在 `src/engine/gate.ts`，models.ts 从它导入，不得复制字面量
- 面向用户新能力 → minor 版本（0.15.0 → 0.16.0）+ README 同步
- 引擎对模型名零观点：不校验有效性、不做别名映射

---

### Task 1: 类型扩展与路由解析模块（models.ts）

**Files:**
- Modify: `src/engine/prd.ts`
- Create: `src/engine/models.ts`
- Test: `src/engine/models.test.ts`

**Interfaces:**
- Consumes: `Prd`/`Story`（`./prd.js`）、`MAX_RETRIES`（`./gate.js`）
- Produces（Task 4 依赖这些精确签名）:
  - `interface ResolvedModels { builder?: string; validator?: string; escalation?: string; escalateAfter: number }`
  - `interface ModelsReadResult { config: ResolvedModels | null; warnings: string[] }`
  - `readModelsConfig(prd: Prd | null): ModelsReadResult`
  - `interface BuilderModelChoice { model: string | undefined; escalated: boolean; warnings: string[] }`
  - `resolveBuilderModel(opts: { cliOverride?: string; config: ResolvedModels | null; story: Story | null; retryCount: number }): BuilderModelChoice`
  - `resolveValidatorModel(opts: { cliOverride?: string; config: ResolvedModels | null }): string | undefined`

- [ ] **Step 1: 在 prd.ts 增加类型（纯类型，无行为变化）**

`src/engine/prd.ts` 中，在 `Story` 接口的 `priority: number;` 之后加一个可选字段，在 `Prd` 接口的 `qualityChecks?: string[];` 之后加一个可选字段：

```ts
export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  /** builder 阶段模型覆盖（可选，只作用于 builder；validator 恒定不受影响） */
  model?: string;
}

/** 模型路由配置（可选）；缺失=不传 --model，行为与历史版本一致 */
export interface ModelsConfig {
  builder?: string;
  validator?: string;
  escalation?: string;
  escalateAfter?: number;
}

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  /** 意图真相源（源 PRD）的仓库相对路径；由 prd-to-json 写入，引擎只透传不解析 */
  sourcePrd?: string;
  /** 机械门禁命令（完整 shell 命令行，引擎逐条执行）；缺失或空数组=门禁不启用 */
  qualityChecks?: string[];
  /** 模型路由（阶段默认/story 覆盖/重试升级）；缺失=模型路由不启用 */
  models?: ModelsConfig;
  userStories: Story[];
}
```

- [ ] **Step 2: 写失败测试 models.test.ts**

创建 `src/engine/models.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { readModelsConfig, resolveBuilderModel, resolveValidatorModel } from './models.js';
import type { Prd, Story } from './prd.js';

// models 参数保持 unknown：非法形状用例要传数组/字符串/错误字段类型
const prdWith = (models?: unknown): Prd => ({
  project: 'p', branchName: 'b', description: 'd', userStories: [],
  ...(models !== undefined ? { models } : {}),
} as Prd);

const story = (over: Record<string, unknown> = {}): Story => ({
  id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1, ...over,
} as Story);

describe('readModelsConfig', () => {
  it('returns null config without warnings when prd is null or models is missing', () => {
    expect(readModelsConfig(null)).toEqual({ config: null, warnings: [] });
    expect(readModelsConfig(prdWith())).toEqual({ config: null, warnings: [] });
  });

  it('normalizes a full valid config and keeps escalateAfter', () => {
    const r = readModelsConfig(prdWith({ builder: 'b-m', validator: 'v-m', escalation: 'e-m', escalateAfter: 2 }));
    expect(r.config).toEqual({ builder: 'b-m', validator: 'v-m', escalation: 'e-m', escalateAfter: 2 });
    expect(r.warnings).toEqual([]);
  });

  it('defaults escalateAfter to 1 when missing', () => {
    const r = readModelsConfig(prdWith({ builder: 'b-m' }));
    expect(r.config?.escalateAfter).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it('treats a non-object models value as invalid (array, string)', () => {
    for (const bad of [['opus'], 'opus']) {
      const r = readModelsConfig(prdWith(bad));
      expect(r.config).toBeNull();
      expect(r.warnings.some((w) => w.includes('models 形状非法'))).toBe(true);
    }
  });

  it('treats non-string stage fields as invalid as a whole', () => {
    const r = readModelsConfig(prdWith({ builder: 42 }));
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes('models 形状非法'))).toBe(true);
  });

  it('degrades an invalid escalateAfter to 1 with a warning (0, negative, float, non-number)', () => {
    for (const bad of [0, -1, 2.5, '2']) {
      const r = readModelsConfig(prdWith({ builder: 'b-m', escalateAfter: bad }));
      expect(r.config?.escalateAfter).toBe(1);
      expect(r.warnings.some((w) => w.includes('escalateAfter'))).toBe(true);
    }
  });

  it('warns that escalation never fires when escalateAfter >= MAX_RETRIES', () => {
    const r = readModelsConfig(prdWith({ escalation: 'e-m', escalateAfter: 5 }));
    expect(r.config?.escalateAfter).toBe(5); // 值保留，行为上永不触发（达 5 已 blocked）
    expect(r.warnings.some((w) => w.includes('永不生效'))).toBe(true);
  });
});

describe('resolveBuilderModel', () => {
  const cfg = { builder: 'b-m', validator: 'v-m', escalation: 'e-m', escalateAfter: 1 };

  it('returns undefined when nothing is configured', () => {
    const r = resolveBuilderModel({ config: null, story: null, retryCount: 0 });
    expect(r).toEqual({ model: undefined, escalated: false, warnings: [] });
  });

  it('falls back to the top-level builder model', () => {
    const r = resolveBuilderModel({ config: cfg, story: story(), retryCount: 0 });
    expect(r.model).toBe('b-m');
    expect(r.escalated).toBe(false);
  });

  it('lets story.model override the top-level builder model', () => {
    const r = resolveBuilderModel({ config: cfg, story: story({ model: 's-m' }), retryCount: 0 });
    expect(r.model).toBe('s-m');
  });

  it('applies story.model even without a top-level models config', () => {
    const r = resolveBuilderModel({ config: null, story: story({ model: 's-m' }), retryCount: 0 });
    expect(r.model).toBe('s-m');
  });

  it('escalates past story.model once retryCount reaches escalateAfter', () => {
    const r = resolveBuilderModel({ config: cfg, story: story({ model: 's-m' }), retryCount: 1 });
    expect(r).toMatchObject({ model: 'e-m', escalated: true });
  });

  it('does not escalate below the threshold', () => {
    const r = resolveBuilderModel({ config: { ...cfg, escalateAfter: 3 }, story: story(), retryCount: 2 });
    expect(r).toMatchObject({ model: 'b-m', escalated: false });
  });

  it('does not escalate when escalation is not configured', () => {
    const r = resolveBuilderModel({
      config: { builder: 'b-m', escalateAfter: 1 }, story: story(), retryCount: 4,
    });
    expect(r).toMatchObject({ model: 'b-m', escalated: false });
  });

  it('lets the CLI override beat everything, including escalation', () => {
    const r = resolveBuilderModel({ cliOverride: 'cli-m', config: cfg, story: story({ model: 's-m' }), retryCount: 3 });
    expect(r).toMatchObject({ model: 'cli-m', escalated: false });
  });

  it('ignores a non-string story.model with a warning and falls back', () => {
    const r = resolveBuilderModel({ config: cfg, story: story({ model: 123 }), retryCount: 0 });
    expect(r.model).toBe('b-m');
    expect(r.warnings.some((w) => w.includes('US-001') && w.includes('model'))).toBe(true);
  });
});

describe('resolveValidatorModel', () => {
  const cfg = { builder: 'b-m', validator: 'v-m', escalateAfter: 1 };

  it('returns undefined when nothing is configured', () => {
    expect(resolveValidatorModel({ config: null })).toBeUndefined();
  });

  it('uses the top-level validator model', () => {
    expect(resolveValidatorModel({ config: cfg })).toBe('v-m');
  });

  it('lets the CLI override win', () => {
    expect(resolveValidatorModel({ cliOverride: 'cli-m', config: cfg })).toBe('cli-m');
  });
});
```

- [ ] **Step 3: 跑测试确认失败**

Run: `npx vitest run src/engine/models.test.ts`
Expected: FAIL —— `Cannot find module './models.js'`（模块尚不存在）

- [ ] **Step 4: 实现 src/engine/models.ts**

```ts
import type { Prd, Story } from './prd.js';
import { MAX_RETRIES } from './gate.js';

/** 规范化后的模型路由配置：escalateAfter 总有值（缺省/非法一律归 1） */
export interface ResolvedModels {
  builder?: string;
  validator?: string;
  escalation?: string;
  escalateAfter: number;
}

export interface ModelsReadResult {
  /** null = 未配置或整体形状非法（按未配置运行） */
  config: ResolvedModels | null;
  warnings: string[];
}

/**
 * 读取并校验 prd.json 顶层 models：未配置返回 null（静默）；整体形状非法
 * （非对象/阶段字段非字符串）返回 null + 警告——与 readQualityChecks 同款防御，
 * 绝不对落盘数据直接类型断言。escalateAfter 单独字段级降级：非正整数按 1 并警告。
 */
export function readModelsConfig(prd: Prd | null): ModelsReadResult {
  if (!prd || prd.models === undefined) return { config: null, warnings: [] };
  const v: unknown = prd.models;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { config: null, warnings: ['⚠️  prd.json 的 models 形状非法（应为对象），模型路由未启用'] };
  }
  const o = v as Record<string, unknown>;
  for (const key of ['builder', 'validator', 'escalation'] as const) {
    if (o[key] !== undefined && typeof o[key] !== 'string') {
      return { config: null, warnings: [`⚠️  prd.json 的 models 形状非法（${key} 应为字符串），模型路由未启用`] };
    }
  }
  const warnings: string[] = [];
  let escalateAfter = 1;
  if (o.escalateAfter !== undefined) {
    const n = o.escalateAfter;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) {
      escalateAfter = n;
    } else {
      warnings.push(`⚠️  models.escalateAfter 应为正整数，收到「${String(n)}」，已按缺省 1 处理`);
    }
  }
  if (escalateAfter >= MAX_RETRIES && typeof o.escalation === 'string') {
    warnings.push(`⚠️  models.escalateAfter (${escalateAfter}) ≥ 打回上限 ${MAX_RETRIES}，story 会先 blocked，升级永不生效`);
  }
  return {
    config: {
      builder: o.builder as string | undefined,
      validator: o.validator as string | undefined,
      escalation: o.escalation as string | undefined,
      escalateAfter,
    },
    warnings,
  };
}

export interface BuilderModelChoice {
  model: string | undefined;
  /** 本轮因重试触发了升级（供日志标注原因） */
  escalated: boolean;
  warnings: string[];
}

/** builder 阶段模型：CLI 覆盖 > escalation（retryCount ≥ escalateAfter）> story.model > 顶层 builder > 不传 */
export function resolveBuilderModel(opts: {
  cliOverride?: string;
  config: ResolvedModels | null;
  story: Story | null;
  retryCount: number;
}): BuilderModelChoice {
  const warnings: string[] = [];
  let storyModel: string | undefined;
  const rawStoryModel: unknown = opts.story?.model;
  if (rawStoryModel !== undefined) {
    if (typeof rawStoryModel === 'string') storyModel = rawStoryModel;
    else warnings.push(`⚠️  story ${opts.story!.id} 的 model 非字符串，已忽略该覆盖`);
  }
  if (opts.cliOverride) return { model: opts.cliOverride, escalated: false, warnings };
  const cfg = opts.config;
  if (cfg?.escalation && opts.retryCount >= cfg.escalateAfter) {
    return { model: cfg.escalation, escalated: true, warnings };
  }
  if (storyModel) return { model: storyModel, escalated: false, warnings };
  return { model: cfg?.builder, escalated: false, warnings };
}

/** validator 阶段模型：CLI 覆盖 > 顶层 validator > 不传。刻意不做 story 级/升级——把关水位恒定 */
export function resolveValidatorModel(opts: {
  cliOverride?: string;
  config: ResolvedModels | null;
}): string | undefined {
  return opts.cliOverride ?? opts.config?.validator;
}
```

- [ ] **Step 5: 跑测试确认通过**

Run: `npx vitest run src/engine/models.test.ts`
Expected: PASS（全部用例绿）

- [ ] **Step 6: 全量门禁后提交**

```bash
npm run typecheck && npm test
git add src/engine/prd.ts src/engine/models.ts src/engine/models.test.ts
git commit -m "feat: 模型路由解析模块——prd.json models 段与 story.model 类型、优先级链纯函数（CLI > 升级 > story > 顶层）、形状校验与字段级降级"
```

---

### Task 2: agent.ts 透传 --model

**Files:**
- Modify: `src/engine/agent.ts`
- Test: `src/engine/agent.test.ts`

**Interfaces:**
- Consumes: 无新依赖
- Produces（Task 4 依赖）: `buildAgentArgs(kind: AgentKind, prompt: string, model?: string): string[]`；`runAgent(opts: { kind: AgentKind; prompt: string; cwd: string; timeoutMs: number; model?: string }): Promise<RunResult>`

- [ ] **Step 1: 在 agent.test.ts 的 `describe('buildAgentArgs')` 里追加失败测试**

```ts
  it('appends --model before the prompt for claude when a model is given', () => {
    expect(buildAgentArgs('claude', 'P', 'opus')).toEqual([
      'claude', '--print', '--dangerously-skip-permissions', '--model', 'opus', 'P',
    ]);
  });
  it('appends --model before the prompt for codex when a model is given', () => {
    expect(buildAgentArgs('codex', 'P', 'gpt-5')).toEqual([
      'codex', 'exec', '--dangerously-bypass-approvals-and-sandbox', '--model', 'gpt-5', 'P',
    ]);
  });
```

（现有两条不带 model 的用例保持不动——它们就是「缺省不出现 --model」的回归断言。）

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/agent.test.ts`
Expected: FAIL —— 数组不含 `--model`（现签名忽略第三参）

- [ ] **Step 3: 实现**

`src/engine/agent.ts` 中替换 `buildAgentArgs` 与 `runAgent` 签名：

```ts
export function buildAgentArgs(kind: AgentKind, prompt: string, model?: string): string[] {
  const bin = resolveBinary(kind);
  const modelArgs = model ? ['--model', model] : [];
  if (kind === 'codex') {
    return [bin, 'exec', '--dangerously-bypass-approvals-and-sandbox', ...modelArgs, prompt];
  }
  return [bin, '--print', '--dangerously-skip-permissions', ...modelArgs, prompt];
}
```

`runAgent` 的 opts 增加可选 `model`，调用处透传：

```ts
export function runAgent(opts: {
  kind: AgentKind;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** 透传给 agent CLI 的 --model；undefined = 不传（用户 CLI 默认模型） */
  model?: string;
}): Promise<RunResult> {
  // buildAgentArgs()[0] may itself be "node /path mode" when overridden by an
  // env var in tests; split it so the stub receives its trailing args.
  const argv = buildAgentArgs(opts.kind, opts.prompt, opts.model);
```

（函数体其余部分不变。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/agent.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁后提交**

```bash
npm run typecheck && npm test
git add src/engine/agent.ts src/engine/agent.test.ts
git commit -m "feat: agent 拉起支持可选 --model 透传（claude/codex 同参数名，缺省不传保持现状）"
```

---

### Task 3: CLI 参数 --builder-model / --validator-model

**Files:**
- Modify: `src/cli.ts`
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: 无新依赖
- Produces（Task 4 依赖）: `CliConfig` 增加 `builderModel: string | undefined; validatorModel: string | undefined`（parseCliArgs 总是返回这两个键，值可为 undefined）

- [ ] **Step 1: 在 cli.test.ts 的 `describe('parseCliArgs')` 里追加失败测试**

```ts
  it('parses --builder-model and --validator-model', () => {
    const c = parseCliArgs(['--builder-model', 'haiku', '--validator-model', 'opus']);
    expect(c.builderModel).toBe('haiku');
    expect(c.validatorModel).toBe('opus');
  });
  it('defaults builder/validator model overrides to undefined', () => {
    const c = parseCliArgs([]);
    expect(c.builderModel).toBeUndefined();
    expect(c.validatorModel).toBeUndefined();
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli.test.ts`
Expected: FAIL —— parseArgs 遇到未知参数 `--builder-model` 抛错（`parseCliArgs` 会把它转为返回值前的异常）或属性不存在

- [ ] **Step 3: 实现**

`src/cli.ts` 三处：

`CliConfig` 接口在 `valTimeoutMs: number;` 之后加：

```ts
  builderModel: string | undefined;
  validatorModel: string | undefined;
```

`parseArgs` 的 `options` 在 `'val-timeout': { type: 'string' },` 之后加：

```ts
      'builder-model': { type: 'string' },
      'validator-model': { type: 'string' },
```

`parseCliArgs` 返回对象在 `valTimeoutMs: min(values['val-timeout'], 60),` 之后加：

```ts
    builderModel: values['builder-model'],
    validatorModel: values['validator-model'],
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/cli.test.ts`
Expected: PASS

- [ ] **Step 5: 全量门禁后提交**

```bash
npm run typecheck && npm test
git add src/cli.ts src/cli.test.ts
git commit -m "feat: CLI 新增 --builder-model / --validator-model 阶段模型临时覆盖参数"
```

---

### Task 4: loop.ts 路由接线（解析、日志、警告去重、透传）

**Files:**
- Modify: `src/engine/loop.ts`
- Modify: `src/cli.ts`（main() 透传两字段）
- Test: `src/engine/loop.test.ts`

**Interfaces:**
- Consumes: Task 1 的 `readModelsConfig`/`resolveBuilderModel`/`resolveValidatorModel`、Task 2 的 `runAgent({ ..., model })`、Task 3 的 `cfg.builderModel/validatorModel`
- Produces（Task 5 依赖）: `LoopConfig` 增加 `builderModel?: string; validatorModel?: string`；循环体内 `builderChoice: BuilderModelChoice` 与 `validatorModel: string | undefined` 两个局部变量（Task 5 的 setState 改造以它们为输入）

- [ ] **Step 1: 在 loop.test.ts 追加失败的集成测试（新 describe）**

追加到 `describe('runLoop keepOpen')` 之前：

```ts
describe('runLoop model routing', () => {
  // fake 记录每次调用收到的 argv（一行一次），并把 story 翻绿让循环结束。
  // 行 1 = builder、行 2 = validator（同轮内先后调用）。
  function fakeArgvRecorder(workspace: string): { fake: string; argvLog: string } {
    const fake = join(workspace, 'fake-argv.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 1, blocked: false },
      }));
      process.exit(0);
    `);
    return { fake, argvLog };
  }

  it('routes stage models and escalates the builder after a rollback', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      models: { builder: 'fast-m', validator: 'val-m', escalation: 'esc-m' },
    });
    // 预置：US-001 已被打回一次（retryCount=1 ≥ escalateAfter 缺省 1）→ builder 应升级
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: false, notes: '', retryCount: 1, blocked: false },
    }));
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('--model esc-m'); // builder 升级
      expect(lines[1]).toContain('--model val-m'); // validator 恒定
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('uses story.model for the builder before any rollback', async () => {
    const { workspace, instructionsDir } = setup([story({ model: 'story-m' })], {
      models: { builder: 'fast-m', validator: 'val-m', escalation: 'esc-m' },
    });
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model story-m'); // retryCount=0，story 覆盖生效
      expect(lines[1]).toContain('--model val-m');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('lets CLI overrides beat prd.json models', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      models: { builder: 'fast-m', validator: 'val-m', escalation: 'esc-m' },
    });
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        builderModel: 'cli-b', validatorModel: 'cli-v',
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model cli-b');
      expect(lines[1]).toContain('--model cli-v');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('passes no --model at all when nothing is configured', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).not.toContain('--model');
      expect(lines[1]).not.toContain('--model');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('warns only once across rounds and disables routing on malformed models', async () => {
    const { workspace, instructionsDir } = setup([story()], { models: 'opus' });
    // 只记录 argv、不翻绿：跑满 2 轮，真正验证跨轮警告去重（每轮都重读非法 models）
    const fake = join(workspace, 'fake-argv-only.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // story 从未翻绿，跑满 maxIterations
      expect(warns.filter((w) => w.includes('models 形状非法'))).toHaveLength(1); // 2 轮只警告一次
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(4); // 2 轮 × (builder + validator)
      for (const line of lines) expect(line).not.toContain('--model');
    } finally {
      console.warn = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: FAIL —— 前三条测试 argv 里没有 `--model ...`（loop 尚未接线）；第 4、5 条可能已过（现状本来不传），以前三条红为准

- [ ] **Step 3: 实现 loop.ts 接线**

`src/engine/loop.ts`：

导入区加：

```ts
import { readModelsConfig, resolveBuilderModel, resolveValidatorModel } from './models.js';
```

`LoopConfig` 在 `valTimeoutMs: number;` 之后加：

```ts
  /** 临时覆盖 builder 阶段模型（压过 prd.json models 与升级链） */
  builderModel?: string;
  /** 临时覆盖 validator 阶段模型（压过 prd.json models.validator） */
  validatorModel?: string;
```

`runLoop` 内、`const agentCwd = process.cwd();` 之后加警告去重器：

```ts
    // 模型路由警告去重：prd.json 每轮重读（agent 可能改它），同一条警告只打一次
    const warnedModels = new Set<string>();
    const warnModelsOnce = (msgs: string[]) => {
      for (const m of msgs) {
        if (!warnedModels.has(m)) { warnedModels.add(m); console.warn(m); }
      }
    };
```

循环体内，替换从 `dashboard.setState({ iteration: i, phase: 'developing', currentStory });` 到 Developer 段结束的代码为：

```ts
      const modelsRead = readModelsConfig(before);
      warnModelsOnce(modelsRead.warnings);
      const currentStoryObj = before?.userStories.find((s) => s.id === currentStory) ?? null;
      const retryCount = currentStory && beforeState ? (beforeState[currentStory]?.retryCount ?? 0) : 0;
      const builderChoice = resolveBuilderModel({
        cliOverride: cfg.builderModel, config: modelsRead.config, story: currentStoryObj, retryCount,
      });
      warnModelsOnce(builderChoice.warnings);

      dashboard.setState({ iteration: i, phase: 'developing', currentStory });

      // Developer
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
        if (dev.timedOut) {
          dashboard.setState({ phase: 'idle' });
          continue; // skip validator, retry next iteration
        }
      }
```

Validator 段替换为：

```ts
      // Validator
      const validatorModel = resolveValidatorModel({ cliOverride: cfg.validatorModel, config: modelsRead.config });
      dashboard.setState({ phase: 'validating' });
      if (validator) {
        if (validatorModel) console.log(`🧠 validator 模型: ${validatorModel}`);
        await runAgent({
          kind: cfg.kind, prompt: validator, cwd: agentCwd, timeoutMs: cfg.valTimeoutMs,
          model: validatorModel,
        });
      }
```

`src/cli.ts` 的 `main()` 中 `runLoop({...})` 调用在 `valTimeoutMs: cfg.valTimeoutMs,` 之后加：

```ts
    builderModel: cfg.builderModel,
    validatorModel: cfg.validatorModel,
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: PASS（新 5 条 + 既有全部）

- [ ] **Step 5: 全量门禁后提交**

```bash
npm run typecheck && npm test
git add src/engine/loop.ts src/cli.ts src/engine/loop.test.ts
git commit -m "feat: 循环接线模型路由——每轮解析阶段/story/升级模型透传 runAgent，带模型日志与警告去重（缺省不传保持现状）"
```

---

### Task 5: dashboard 显示当前模型

**Files:**
- Modify: `src/dashboard/server.ts`
- Modify: `src/engine/loop.ts`（setState 调用点补 model）
- Modify: `assets/dashboard/dashboard.html`
- Modify: `assets/dashboard/dashboard-p.html`
- Test: `src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: Task 4 的 `builderChoice.model` / `validatorModel` 局部变量
- Produces: `setState(patch: { iteration?; phase?; currentStory?; model?: string | null })`；`ApiResponse.runtime.model: string | null`

- [ ] **Step 1: 在 server.test.ts 的 `describe('buildApiResponse')` 里追加失败测试**

```ts
  it('exposes the current model in runtime and defaults it to null', () => {
    setState({ phase: 'developing', model: 'opus' });
    expect(buildApiResponse().runtime.model).toBe('opus');
    setState({ model: null });
    expect(buildApiResponse().runtime.model).toBe(null);
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/dashboard/server.test.ts`
Expected: FAIL —— typecheck 层面 `model` 不是 setState patch 的属性 / runtime 无 model 字段

- [ ] **Step 3: 实现 server.ts**

`State` 接口与初值加 `model`：

```ts
interface State {
  iteration: number;
  maxIterations: number;
  phase: Phase;
  currentStory: string | null;
  /** 当前阶段所用模型（未配置路由时为 null） */
  model: string | null;
  startedAt: number | null;
}

const state: State = {
  iteration: 0, maxIterations: 50, phase: 'idle', currentStory: null, model: null, startedAt: null,
};
```

`setState` 加 model 分支：

```ts
export function setState(patch: {
  iteration?: number; phase?: Phase; currentStory?: string | null; model?: string | null;
}): void {
  if (patch.iteration !== undefined) state.iteration = patch.iteration;
  if (patch.phase !== undefined) state.phase = patch.phase;
  if (patch.currentStory !== undefined) state.currentStory = patch.currentStory;
  if (patch.model !== undefined) state.model = patch.model;
}
```

`ApiResponse.runtime` 加 `model: string | null;`，`buildApiResponse` 的 runtime 对象加 `model: state.model,`。

- [ ] **Step 4: loop.ts 的 setState 调用点补 model**

Task 4 改造后的 loop.ts 中，逐个更新：

- developing：`dashboard.setState({ iteration: i, phase: 'developing', currentStory, model: builderChoice.model ?? null });`
- builder 超时的 idle：`dashboard.setState({ phase: 'idle', model: null });`
- gating：`dashboard.setState({ phase: 'gating', model: null });`（门禁是 shell，无模型）
- 门禁打回后的 idle：`dashboard.setState({ phase: 'idle', model: null });`
- validating：`dashboard.setState({ phase: 'validating', model: validatorModel ?? null });`
- Completion check 的 idle：`dashboard.setState({ phase: 'idle', model: null });`

（`phase: 'done'` 处不传 model——保留最后一个 validator 模型无意义，但 idle 已先置 null，无需重复。）

- [ ] **Step 5: 两个 HTML 的阶段行追加模型**

`assets/dashboard/dashboard.html` 的 `renderPhase` 中：

```js
  if (cfg.animate) {
    const storyPart = rt.current_story ? ` · ${rt.current_story}` : '';
    const modelPart = rt.model ? ` · ${rt.model}` : '';
    label += storyPart + modelPart + ` · Round ${rt.iteration}`;
    label += '<span class="loading-dots"></span>';
  }
```

同文件演示数据行（`runtime: { iteration: 12, ... }`）加 `model: 'opus',`（离线预览可见效果）。

`assets/dashboard/dashboard-p.html` 的 hud-phase 模板串（约 501 行）：

```js
      <span class="hud-phase">${phaseEmoji[runtime.phase]||'⏸'} ${phaseText[runtime.phase]||'等待启动'}${runtime.current_story ? ' · '+runtime.current_story : ''}${runtime.model ? ' · '+runtime.model : ''}${isActive ? '<span class="loading-dots"></span>' : ''}</span>
```

同文件演示数据行（约 274 行）runtime 对象加 `model: "opus"`。

- [ ] **Step 6: 跑测试确认通过**

Run: `npx vitest run src/dashboard/server.test.ts src/engine/loop.test.ts`
Expected: PASS

- [ ] **Step 7: 全量门禁后提交**

```bash
npm run typecheck && npm test
git add src/dashboard/server.ts src/engine/loop.ts src/dashboard/server.test.ts assets/dashboard/dashboard.html assets/dashboard/dashboard-p.html
git commit -m "feat: 仪表盘显示当前阶段所用模型（runtime.model，两视图阶段行追加，无路由时不显示）"
```

---

### Task 6: prd-to-json skill 增补 models 生成规则

**Files:**
- Modify: `skills/prd-to-json/SKILL.md`

**Interfaces:**
- Consumes: 引擎已支持的 `models` 段与 `story.model` 语义（Task 1/4）
- Produces: 派生环节的生成规则（无代码接口）

- [ ] **Step 1: 输出格式示例加 models 段**

`## 输出格式` 的 JSON 示例中，`"qualityChecks": ["npm run typecheck", "npm test"],` 之后加一行：

```json
  "models": { "builder": "sonnet", "validator": "opus", "escalation": "opus" },
```

- [ ] **Step 2: 在「qualityChecks：机械门禁命令（推荐配置）」节之后新增一节**

```markdown
---

## models：模型路由（可选配置）

顶层可选字段。引擎按它给 builder/validator 拉起命令追加 `--model <名字>`；缺失时不传（沿用用户 CLI 默认模型，行为与历史版本一致）。模型名是不透明字符串直接透传（claude 可用别名如 opus/sonnet/haiku，codex 用其 CLI 接受的名字），引擎不校验、不维护模型名单。

```json
"models": {
  "builder": "sonnet",
  "validator": "opus",
  "escalation": "opus",
  "escalateAfter": 1
}
```

- `builder` / `validator`：两阶段各自的默认模型
- `escalation`：story 被打回 `retryCount ≥ escalateAfter`（缺省 1）后 builder 的升级模型——失败才花大钱
- story 级可选 `"model"` 字段覆盖 builder（只对该 story 生效；validator 恒定不受影响）

生成规则：

- 先问用户是否需要模型分层；不需要或拿不准时**整段省略**（缺省即现状，不要编造）
- 配置时默认姿势：**validator 能力 ≥ builder**——validator 是把关方，降它的级会重开「共谋假绿」的门
- 逐 story 评估复杂度再标 `model`：跨模块/数据迁移/状态机类留给强模型，纯样板/文案/单文件小改可标快模型；拿不准不标（回落顶层 builder）
- 模型名必须与用户确认后写入：用户可用哪些模型只有用户知道，引擎不校验，名字写错会在循环里快速失败白烧迭代数
```

- [ ] **Step 3: 「转换规则」列表追加第 10 条**

```markdown
10. **models 路由（可选）**：按上方「models」节与用户确认模型分层；用户不需要时省略整段
```

- [ ] **Step 4: 「保存前检查清单」在 qualityChecks 检查项之后追加**

```markdown
- [ ] models 已配置时：模型名已逐个与用户确认（引擎不校验名字），validator 能力 ≥ builder，不需要分层的 story 未强行标注
```

- [ ] **Step 5: 提交**

```bash
git add skills/prd-to-json/SKILL.md
git commit -m "docs: prd-to-json 增补 models 模型路由生成规则（用户确认制、validator 不低于 builder、缺省省略）"
```

---

### Task 7: 用户文档与 ADR

**Files:**
- Modify: `README.md`
- Modify: `docs/architecture.md`
- Create: `docs/decisions/006-model-routing.md`

**Interfaces:**
- Consumes: Task 1-5 落地的行为
- Produces: 无代码接口（文档）

- [ ] **Step 1: README——prd.json 结构示例**

`"qualityChecks": [...]` 行之后加：

```jsonc
  "models": { "builder": "sonnet", "validator": "opus", "escalation": "opus" },  // 模型路由（可选）：阶段默认模型与打回升级模型；story 级可再加 "model" 覆盖 builder
```

- [ ] **Step 2: README——运行示例（第 2 步代码块）加一行**

`npx coding-x --max-iter 20` 行之后加：

```bash
npx coding-x --builder-model sonnet --validator-model opus  # 临时覆盖阶段模型（压过 prd.json models）
```

- [ ] **Step 3: README——命令行参数表**

`--val-timeout` 行之后加两行：

```markdown
| `--builder-model <名字>` | — | builder 阶段模型，直接透传给 agent CLI 的 `--model`；压过 `prd.json` `models`（含升级链）。缺省依次回落 `models` 段、CLI 默认模型 |
| `--validator-model <名字>` | — | validator 阶段模型；压过 `prd.json` `models.validator`，缺省同上回落 |
```

- [ ] **Step 4: README——功能清单引擎节**

「**机械门禁（qualityChecks）**」条目之后加：

```markdown
- **模型路由（models）**：`prd.json` 顶层 `models` 段按阶段分配模型（builder/validator 各自默认），story 级 `model` 字段覆盖 builder，story 被打回后自动升级到 `escalation` 模型重试（阈值 `escalateAfter` 可配，缺省打回 1 次即升级）；模型名不透明透传给 agent CLI（claude/codex 均加 `--model`），未配置时行为与旧版完全一致。
```

- [ ] **Step 5: README——第 3 步仪表盘描述**

「仪表盘展示迭代次数、当前阶段、当前 story、已用时长、story 列表与 `progress.md` 日志。」改为「仪表盘展示迭代次数、当前阶段、当前 story、当前模型（配置了模型路由时）、已用时长、story 列表与 `progress.md` 日志。」

- [ ] **Step 6: architecture.md——模块表加一行（「修复」行之后）**

```markdown
| 模型路由 | `src/engine/models.ts` | 读取 prd.json 顶层 models 段（形状校验+警告），解析 builder/validator 阶段模型与重试升级：CLI 覆盖 > escalation（retryCount ≥ escalateAfter）> story.model > 顶层默认 > 不传 |
```

同时把 frontmatter `updated` 改为当天日期。

- [ ] **Step 7: 创建 docs/decisions/006-model-routing.md**

```markdown
---
title: 006-model-routing
status: active
updated: 2026-07-06
scope: root
---

# 006. 模型路由：透传不映射、validator 恒定、升级复用 retryCount

## 背景

引擎至今无模型概念（拉起 agent 不传 `--model`），所有任务吃用户 CLI 同一默认模型：简单 story 烧强模型额度，把关环节又无法单独升级。需求是按阶段、按 story、按重试三维路由。配置载体沿用 ADR-005 先例：运行策略放 prd.json 顶层、prd-to-json 派生时与用户确认。

## 决策

prd.json 顶层可选 `models`（builder/validator/escalation/escalateAfter）+ story 级可选 `model`；引擎每轮按优先级链解析（CLI 参数 > escalation（retryCount ≥ escalateAfter，缺省 1）> story.model > 顶层 builder > 不传）并给 agent CLI 追加 `--model`。三个关键取舍：**模型名不透明透传**（不校验、不别名映射）；**validator 恒定**（只吃顶层/CLI 配置，不做 story 级覆盖与升级）；**升级判据复用 state.json 的 retryCount**（零新增状态）。

## 理由与备选

- **为什么透传不映射**：tier 抽象（complexity → 内置模型名映射表）可跨 agent kind 移植，但一次 run 只有一个 kind，可移植性服务的场景不存在；映射表必然随模型代际过时，引擎发版远慢于模型发布。名字写错由 agent CLI 立即报错，比引擎维护名单诚实。
- **为什么 validator 不做 story 级覆盖**：validator 是把关方，「共谋假绿」有实证（见 ADR-005 背景）；把关水位恒定，builder 按任务难度弹性，能力差防线不因单个 story 的配置被拉低。
- **为什么升级复用 retryCount**：validator 打回与门禁打回已共同维护它，「被打回过=当前模型搞不定或需要更强判断」语义现成；引入独立升级计数是重复状态。
- **被否备选——独立配置文件**（coding-x.config.json）：运行策略与需求分离更干净，但引擎零配置文件哲学、且 qualityChecks 已确立 prd.json 顶层先例，一事二载体反而增加脱节面。
- **被否备选——插件侧（commands frontmatter model 字段）**：交互会话用户本可 /model 随时切换；skills/commands 是跨工具唯一源，Claude 专属字段对 Codex/Cursor 兼容性未验证。无人值守引擎才是路由不可替代的场景。

## 后果

- prd-to-json 派生环节新增用户确认面（模型分层与名字）；生成默认遵循 validator ≥ builder。
- 模型名写错在循环内表现为 builder 每轮快速失败，消耗迭代数直到人从日志发现（agent stderr 直出）；「连续 N 轮非零退出提前终止」是独立的循环健壮性议题，未随本决策实现。
- escalateAfter ≥ MAX_RETRIES(5) 时升级永不生效（story 先 blocked），引擎启动警告一次。
- doctor 暂不加 models 检查（运行时已警告）；出现「配置了但没生效」的静默脱节实证再补建议项。
```

- [ ] **Step 8: 提交**

```bash
git add README.md docs/architecture.md docs/decisions/006-model-routing.md
git commit -m "docs: 模型路由用户文档与 ADR-006——README 参数表/prd.json 结构/功能清单，架构图模块表，透传不映射等三取舍记录"
```

---

### Task 8: 收尾发版 0.16.0

**Files:**
- Modify: `docs/superpowers/specs/2026-07-06-model-routing-design.md`（status → done）
- Modify: `docs/superpowers/plans/2026-07-06-model-routing.md`（status → done）
- Modify: `package.json` 等（npm version 钩子自动同步插件清单与 lock）

**Interfaces:**
- Consumes: Task 1-7 全部完成且门禁绿
- Produces: v0.16.0 tag；npm publish 与 GitHub Release 由 tag 触发的 CI 完成

- [ ] **Step 1: 全量验证**

Run: `npm run typecheck && npm test && npm run build`
Expected: 三者全绿（build 含 assets 拷贝）

- [ ] **Step 2: 任务型文档状态收尾（发版即交付证据）**

spec 与本计划两个文件的 frontmatter：`status: active` → `status: done`，`updated` → 当天日期。

```bash
git add docs/superpowers/specs/2026-07-06-model-routing-design.md docs/superpowers/plans/2026-07-06-model-routing.md
git commit -m "docs: 模型路由 spec 与计划按发版证据置 done（状态收尾）"
```

- [ ] **Step 3: 版本与推送（推送后停手）**

```bash
npm version minor -m "release: v%s"
git push --follow-tags
```

Expected: 版本 0.15.x → 0.16.0；**push --follow-tags 之后停手**——npm publish 与 GitHub Release 归 tag 触发的 CI（本地抢发会撞 CI，0.14.3 实翻过）。

- [ ] **Step 4: 观察 CI**

Run: `gh run watch`（或 `gh run list --limit 3` 查看状态）
Expected: publish workflow 绿；如红，读日志修复后重推。
