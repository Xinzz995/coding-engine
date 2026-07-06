---
title: "设计：模型路由——不同任务使用不同能力的模型"
status: done
updated: 2026-07-07
scope: root
---

# 模型路由：不同任务使用不同能力的模型

- 日期：2026-07-06
- 作者：Xinzz + Claude
- 前情：引擎至今没有模型概念——`agent.ts` 拉起 `claude --print` / `codex exec` 时不传任何模型参数，builder 与 validator 永远用用户 CLI 的全局默认模型。ADR-005 机械门禁确立了「运行策略放 prd.json 顶层、由 prd-to-json 生成时提取」的先例，本设计沿用同款位置与流程。

## 背景与动机

循环里不同任务的推理强度差异巨大：builder 写代码最重，validator 核对验收标准需要判断力（有「共谋假绿」前科），而同一份 PRD 里的 story 难度也参差。全部任务吃同一个默认模型意味着：简单 story 烧强模型额度，关键把关环节又没法单独升级。

目标是**全面路由能力**：按阶段（builder/validator）、按 story（复杂度）、按动态状态（重试打回后升级）三个维度分配模型，一次到位。

## 目标

1. prd.json 声明式配置阶段默认模型、story 级覆盖、重试升级目标与阈值
2. CLI 参数可临时覆盖阶段模型（实验用）
3. 缺省行为与现状逐字节一致（不配置 = 不传 `--model`），零迁移
4. 引擎对模型名零观点：不透明字符串直接透传，不校验、不维护模型名单
5. 无人值守可观测：日志与 dashboard 能看出本轮用了什么模型、为什么

## 非目标

- **插件侧（skills/commands）模型机制**：它们跑在用户交互会话里，用户本可 `/model` 随时切换；且 skills/commands 是跨工具唯一源，Claude 专属 frontmatter 字段对 Codex/Cursor 的兼容性未验证。无人值守场景才是模型路由不可替代的地方。
- **tier 抽象层**（complexity → 模型名映射表）：一次 run 只有一个 agent kind，跨 kind 可移植是为不存在的场景付维护税，且映射表必然随模型代际过时。
- **模型名有效性预检**：agent CLI 自己报错更诚实。

## 现状

- `src/engine/agent.ts` `buildAgentArgs`：只拼 `claude --print --dangerously-skip-permissions <prompt>` 或 `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`
- `src/cli.ts`：无任何模型参数；唯一逃生口 `CODING_X_CLAUDE_BIN` 只能整体换二进制
- `src/engine/loop.ts`：每轮迭代前已掌握 `currentStory` 与其 `retryCount`（`beforeState`）——路由所需信息已全部就位，无需新状态
- `state.json` 的 `retryCount` 由 validator 打回与门禁打回共同递增，达 `MAX_RETRIES = 5` 转 blocked

## 设计

### 数据结构（`src/engine/prd.ts`）

```ts
export interface ModelsConfig {
  builder?: string;        // builder 阶段默认模型
  validator?: string;      // validator 阶段模型（恒定，不按 story 变）
  escalation?: string;     // builder 升级目标
  escalateAfter?: number;  // retryCount ≥ 此值时启用 escalation，缺省 1
}
// Prd 增加 models?: ModelsConfig；Story 增加 model?: string（只作用于 builder）
```

示例：

```jsonc
{
  "models": {
    "builder": "sonnet",
    "validator": "opus",
    "escalation": "opus",
    "escalateAfter": 2
  },
  "userStories": [
    { "id": "US-001", "model": "haiku", "...": "简单 story 降级" }
  ]
}
```

### 路由解析（新模块 `src/engine/models.ts`，纯函数）

- `readModelsConfig(prd)`：形状校验，非法返回 `'invalid'`（调用方警告后按未配置），复制 `readQualityChecks` 的防御姿势——绝不对落盘数据直接类型断言。
- `resolveBuilderModel({ cliOverride, models, story, retryCount })`，优先级高→低：
  1. CLI `--builder-model`
  2. `models.escalation`（`retryCount ≥ escalateAfter` 时）
  3. `story.model`
  4. `models.builder`
  5. `undefined`（不传 `--model`，现状）
- `resolveValidatorModel({ cliOverride, models })`：CLI `--validator-model` > `models.validator` > `undefined`。

**validator 刻意不做 story 级覆盖**：把关水位恒定，是对「共谋假绿」教训的结构化回应——builder 按任务难度弹性降级，validator 永远保持配置的最高水位。

### 引擎改动

- `agent.ts`：`buildAgentArgs(kind, prompt, model?)`——有 model 时 claude 与 codex 均插入 `--model <name>`；`runAgent` 增加可选 `model` 透传。
- `loop.ts`：每轮迭代用已有的 `before`/`beforeState`/`currentStory` 查出当前 story 对象与 retryCount，喂给解析函数，结果传给两次 `runAgent`。升级语义自然成立：打回 → retryCount+1 → 下轮 `getCurrentStoryId` 仍选中该 story → builder 自动换 escalation 模型重试。
- `cli.ts`：新增 `--builder-model` / `--validator-model`，进 `CliConfig` 透传 `LoopConfig`。

### 可观测性

- 每次拉起 agent 前打日志注明所用模型及原因，如 `🧠 builder 模型: opus（US-003 第 2 次重试，升级）`；未配置时不打（保持现状安静）。
- dashboard `setState` 增加当前模型字段，面板迭代区显示——无人值守时可见「这轮是升级模型在跑」。

### 数据流

prd-to-json（交互、强模型会话）评估各 story 复杂度 → 与用户确认后写入 `models` 段与 story 级 `model` → 引擎每轮确定性解析、透传。与 ADR-003 一致：模型策略是执行配置，生成时定，运行时机器读；源 PRD（md）不写模型名。

## 错误处理

| 情形 | 行为 |
|---|---|
| `models` 形状非法（非对象/字段类型错） | 警告 + 按未配置运行（同 qualityChecks，绝不 crash） |
| `story.model` 非字符串 | 警告 + 忽略该覆盖 |
| `escalateAfter` 非正整数（0/负/小数/非数字） | 警告 + 按缺省 1 |
| `escalateAfter` ≥ MAX_RETRIES(5) | 启动警告「升级永不生效」（story 达 5 即 blocked） |
| 模型名写错/无权限 | 不预检；agent CLI 立即非零退出（stderr 直出可见），走现有轮次重试 |
| `escalation` 未配置但触发升级 | 不升级，沿用原解析链（escalation 是可选增强） |

## 配套生态（随本次交付）

- **prd-to-json skill**：增补提取步骤——评估各 story 复杂度、与用户确认 `models` 段；生成默认遵循「validator 能力 ≥ builder」（共谋教训的生成端防线）。
- **README**：CLI 参数表加 `--builder-model` / `--validator-model`；prd.json 字段说明加 `models` 段与 `story.model`。
- **architecture.md**：模块表加 `src/engine/models.ts` 一行。
- **ADR-006**：记录三个关键取舍——模型名透传不映射（映射表会过时）、validator 恒定不按 story 覆盖（把关水位）、升级复用 retryCount（零新状态）。
- **dashboard**：迭代状态与面板显示当前模型。

## 测试

Vitest，测试与源码同目录：

- `models.test.ts`：解析链全矩阵（CLI > escalation > story > 顶层 > undefined）、`escalateAfter` 边界（0/负数/小数/≥5/缺省）、形状校验各非法输入。
- `agent.test.ts`：`buildAgentArgs` 带/不带 model 的参数拼接，claude 与 codex 两个 kind。
- `loop.test.ts`：`__fixtures__/fake-agent.mjs` 集成——配置 models 段跑一轮，断言子进程 argv 含 `--model`；打回一次后（`escalateAfter: 1`）下轮 builder 收到 escalation 模型。
- `cli.test.ts`：新参数解析。

## 版本与兼容

新增能力、缺省即现状，非破坏——**minor 版本（0.16.0）**。旧 prd.json 无需迁移；`models` 缺失时引擎行为与今天逐字节一致。

## 已知限制与后续

- 模型名写错时每轮 builder 都会快速失败，消耗迭代数直到人从日志发现（agent stderr 直出）。「连续 N 轮非零退出提前终止」是独立于模型路由的通用循环健壮性问题，不在本设计内。
- doctor 暂不加 models 形状检查（引擎运行时已警告）；若实践中发现「配置了但没生效」的静默脱节，再补 doctor 建议项。
