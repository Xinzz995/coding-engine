---
title: "模型路由重设计：难度档位、失败升级与 runner 绑定"
status: done
updated: 2026-07-22
scope: root
---

# 模型路由重设计：难度档位、失败升级与 runner 绑定

> **继任说明（2026-07-22）：** 本规格是 v0.23.0 的已交付合同，保留为历史记录；其中“模型发现与启动时在线复核”从 v0.24.0 起由 [全局模型目录规格](2026-07-22-global-model-catalog.md) 与 [ADR-012](../../decisions/012-global-model-catalog.md) 局部取代，其余路由语义继续有效。

> 本规格取代 `docs/specs/2026-07-06-model-routing-design.md`。旧规格已经按当时设计交付，保留作历史记录；本轮从用户目标重新推导，不继承其 schema 与路由优先级。

## 背景

2026-07-06 版模型路由围绕「阶段默认 + story 直接模型名 + retryCount 阈值升级」设计；随后未发布分支又经历「按 agent 工具分段」与 `profiles` 跨工具档案两版。复盘后确认它们优化了错误的主问题：用户不需要同一份配置跨 Claude Code、Codex、Cursor 移植，真正的优先级是：

1. **按 story 所需推理能力自动选择初始模型**，简单任务降低成本、复杂任务保住质量；
2. **第一次有效失败后自动升级**，避免同一能力水位重复失败；
3. **builder 与 validator 分工**，把关模型保持稳定；
4. 不解决跨 runner 配置复用。

正式标签 `v0.22.0` 尚未包含任何模型路由 schema，因此扁平格式、按工具分段与 `profiles` 都是未发布试验，可直接废弃而无需承担公开兼容成本。

## 目标

1. `prd-to-json` 在 stories 最终定稿后，按固定规则自动判定 `low / medium / high`。
2. 用户从当前机器、当前账号、当前 provider/中转站实际可用的模型中，一次性选择三档 builder、validator 与 escalation。
3. `prd.json` 保存稳定的难度判断与 runner 绑定；引擎只做确定性解析，不在运行时重新猜难度。
4. 第一次有效失败后，下轮 builder 切换到 escalation；异常退出、超时、认证或环境错误不触发花费升级。
5. Claude Code、Codex、Cursor 三种 runner 都能实际执行 `--model` 路由。
6. 配置错误、runner 错配与可验证的模型失效在循环前 fail-fast，不静默回退。
7. 配置路由、实际调用和升级原因贯穿转换结果、日志、dashboard、status、evidence 与最终报告。

## 非目标

- 同一份 `models` 配置跨 runner 复用；换 runner 必须重新派生并重新选择模型。
- token/金额核算；另立成本遥测议题。
- reasoning effort、thinking/max mode、service tier 路由；另立推理强度路由议题。
- 内置厂商模型名单、能力排行榜或价格表。
- 解析 Claude/Cursor 交互式 TUI、内部缓存或私有协议来枚举模型。
- 把模型路由或难度元数据写入源 PRD；源 PRD 继续只表达业务意图。
- 自动安装 runner CLI、自动登录或未经授权修改账号/provider 配置。
- 兼容任何未发布的旧 `models` / `profiles` / story `model` 格式。

## 端到端流程

### 1. `prd-generate`：业务意图层不加模型字段

`prd-generate` 仍只产出业务 PRD。模型选择是执行策略，不进入 `docs/prds/prd-*.md`，也不让业务作者承担具体模型代际变化。

### 2. `prd-to-json`：可选启用路由

stories 经增强、拆分、排序并回写源 PRD后，`prd-to-json` 才处理模型路由：

1. 询问是否启用；不启用则省略顶层 `models` 及所有 story 难度字段，保持历史零配置行为。
2. 识别当前宿主为 `claude`、`codex` 或 `cursor`；识别不确定时询问，不偷偷猜。
3. 检查对应 runner CLI 已安装且已认证。失败时停止路由配置；用户仍可省略 `models` 完成普通转换。
4. 调用 `coding-x models <runner> --json` 获取当前有效环境的模型集合。
5. 发现能力不可用时，请用户提供当前可用模型 ID 列表；发现适配器本来可用但查询报错时，不把错误伪装成「无发现能力」。
6. 模型清单只展示一次，随后批量提出五道选择题：`builder.low`、`builder.medium`、`builder.high`、`validator`、`escalation`。
7. 所有位置必须选择实际模型标识；不发明通用 `default` 哨兵。工具若把 `auto/default` 作为真实可选标识返回，则它只是该 runner 接受的普通标识。
8. 仅用发现接口的可靠元数据或官方明确资料给推荐与能力倒挂警告；未知/中转站别名不按名称猜强弱。用户可确认任意组合，多个位置允许相同模型。
9. 按本规格的固定难度规则自动写入每个 story 的 `difficulty` 与 `difficultyReason`，不设置写入前逐 story 审批门槛。
10. 写入后展示完整结果表；用户有异议时由 `prd-to-json` 修正派生产物，不直接手改运行中的文件。

### 3. 引擎：预检后确定性选路

引擎启动时完成 schema、runner 与模型可用性预检；通过后按 story 难度、`state.escalated` 和 CLI 临时覆盖解析实际模型。运行期不修改 `prd.json`，不重新评估难度。

## `prd.json` 数据合同

```jsonc
{
  "models": {
    "runner": "codex",
    "builder": {
      "low": "model-a",
      "medium": "model-b",
      "high": "model-c"
    },
    "validator": "model-d",
    "escalation": "model-e"
  },
  "userStories": [
    {
      "id": "US-001",
      "difficulty": "medium",
      "difficultyReason": "命中 medium-1：需沿用现有 API client 模式连接页面与接口；相关模式见 src/api/notes.ts 与 src/pages/Notes.tsx。"
    }
  ]
}
```

TypeScript 目标形状：

```ts
export type AgentKind = 'claude' | 'codex' | 'cursor';
export type StoryDifficulty = 'low' | 'medium' | 'high';

export interface ModelsConfig {
  runner: AgentKind;
  builder: Record<StoryDifficulty, string>;
  validator: string;
  escalation: string;
}

export interface Story {
  // 既有字段略
  difficulty?: StoryDifficulty;
  difficultyReason?: string;
}
```

约束：

- `models` 整段可选；一旦存在，五个模型值均为非空字符串，`runner` 必须是三种已知值。
- `models` 与 `models.builder` 使用严格键集合，任何未知键都报错；旧引擎遇到未来字段也不得静默忽略。
- 启用 `models` 时，每个 story 都必须有合法 `difficulty` 与非空 `difficultyReason`。
- 未启用 `models` 时，任何 story 出现难度字段都视为半套配置并报错。
- 旧顶层扁平 `builder` 字符串、按工具分段、`profiles`、`escalateAfter`、story `model` 均明确报错并提示重新运行 `prd-to-json`。
- 模型清单、账号、密钥、base URL、中转站地址、provider 配置均不写入 `prd.json`。

## 难度判定

`difficulty` 衡量的是**可靠完成该 story 所需的模型推理能力**，不是代码行数、工期或故事点。story 大到不能在一次迭代完成时先拆分，不能用 `high` 掩盖范围问题。

判定顺序固定为：先 `high`，再 `medium`，剩余同时满足低风险条件的才是 `low`；拿不准向上归档。

### `high`：任一硬触发

1. 身份认证、权限边界、安全、隐私、密钥或支付正确性。
2. schema 迁移、存量数据回填、不可逆写入或数据兼容。
3. 并发、事务一致性、幂等、重试语义、复杂状态机或分布式协调。
4. 对外 API、协议、持久化格式或兼容性合同变化。
5. 修改核心架构/基础设施，或跨多个模块/服务且存在隐含耦合。
6. 故障可能造成数据丢失、越权、重复扣费、服务不可用等高影响后果。
7. 仓库没有既有实现模式，需要引入新技术路径或解决明显未知问题。

判定必须结合 AC 与代码事实，不能仅做关键词匹配；常规前后端接线不会仅因跨两层自动成为 `high`。

### `medium`：未命中 high，且任一命中

1. 按仓库既有模式完成常规前后端接线或跨一至两个技术层。
2. 多分支业务规则、输入校验、异步状态或错误恢复，边界已明确。
3. 新增普通接口、页面流程、持久化操作或合同明确的第三方集成。
4. 修改多个相关文件/模块，需要保持既有行为并补回归测试。
5. bug 根因需跨组件追踪，但不涉及 high 风险边界。
6. 多步骤 UI、加载/失败/刷新保持等闭环验收。

### `low`：未命中 high/medium，且全部满足

1. 修改范围局部，集中在单个组件、模块或一组紧密相关文件。
2. 仓库已有明确复用模式，不需要新技术决策。
3. 逻辑线性、边界明确，几乎没有复杂状态或多分支推理。
4. 不改变权限、schema、外部合同、并发语义或核心基础设施。
5. 验收结果直接可观察，回归影响有限。

`difficultyReason` 为一至两句短文本，必须同时写明命中的规则编号与代码库具体证据；引用路径使用仓库相对路径。绿地项目无现成文件时，理由应如实记录已检查的目录与“无既有模式”事实。

## 模型发现与 runner

### 公开命令

新增：

```bash
coding-x models [claude|codex|cursor]
coding-x models [claude|codex|cursor] --json
```

命令只输出模型标识、展示名及发现源确实提供的可靠元数据，不输出密钥、账号标识或连接地址。底层返回三态：

| 状态 | 含义 | `prd-to-json` | 引擎启动复核 |
|---|---|---|---|
| available | 成功得到当前有效模型集合 | 生成五道选择题 | 校验本次有效模型 |
| unsupported | 当前 runner/provider 无机器可读公开接口 | 请求用户提供列表 | 警告“无法复核”，信任人工确认 |
| error | 适配器存在，但认证/网络/provider 查询失败 | 停止路由配置 | 拒绝启动 |

发现适配器只使用公开、机器可读接口：

- Codex：官方 app-server `model/list`，它按当前配置返回可用模型。
- Claude Code：官方 CLI 没有模型枚举命令；仅在当前 provider 暴露稳定机器接口时发现，否则 `unsupported`。
- Cursor：官方支持 `cursor-agent -p --force --model` 执行，但模型列表只有交互式 `/model`；不解析 TUI，无法通过其他公开机器接口发现时返回 `unsupported`。

官方合同（核对日期 2026-07-21）：[Codex app-server `model/list`](https://github.com/openai/codex/blob/main/codex-rs/app-server/README.md)、[Claude Code CLI reference](https://docs.anthropic.com/en/docs/claude-code/cli-usage)、[Cursor CLI parameters](https://docs.cursor.com/en/cli/reference/parameters)、[Cursor slash commands](https://docs.cursor.com/en/cli/reference/slash-commands)。

### runner 选择

- 无显式 runner 时：若 `models` 存在，自动使用 `models.runner`；否则保持历史默认 `claude`。
- 显式 `coding-x claude|codex|cursor` 与 `models.runner` 不一致时拒绝启动。
- Cursor runner 使用公开 headless 入口 `cursor-agent -p --force --model <id> <prompt>`，二进制允许由 `CODING_X_CURSOR_BIN` 覆盖；权限警告与 Claude/Codex 同级。
- 对应 CLI 缺失或未认证时，`prd-to-json` 不生成路由；引擎启动同样 fail-fast。

### 启动时模型复核

- schema 与 runner 始终严格校验，不能被 CLI 模型覆盖绕过。
- 若发现状态为 available，只硬校验本次实际会调用的模型；被 CLI 完全覆盖的过期配置仅警告并提示重新派生。
- CLI 提供的模型同样属于“本次实际模型”，须参加可用性校验。
- unsupported 时警告后继续，明确说明本次仅信任人工列表；error 时拒绝进入循环。
- 生成阶段缓存不是当前可用性的证据，不落盘也不作为启动回退。

## 运行时选路

### CLI 参数

保留：

```text
--builder-model <id>
--validator-model <id>
```

新增：

```text
--escalation-model <id>
```

即使 `prd.json` 未启用 `models`，三参数仍可独立使用。CLI 只影响单次运行，不改写 `prd.json`。

### 优先级

```text
未升级 builder:
  --builder-model
  > models.builder[story.difficulty]
  > runner 默认模型

已升级 builder:
  --escalation-model
  > models.escalation
  > --builder-model
  > models.builder[story.difficulty]
  > runner 默认模型

validator:
  --validator-model
  > models.validator
  > runner 默认模型
```

validator 不按 story 变化，也不进入升级链。若没有任何专用 escalation 模型，失败后不设置 `escalated`；纯 CLI 模式不会制造“已升级但实际仍是同一默认路由”的假状态。

## 失败升级与状态所有权

`state.json` 每个 story 新增：

```json
"escalated": false
```

语义：首次有效失败已经触发独立升级路由；下一轮及该 story 后续轮次持续使用 escalation。它不是失败计数，不替代 `retryCount`。

### 触发升级

以下事件发生一次即由引擎置 `escalated=true`：

1. 机械门禁失败；
2. validator 正常完成并打回；
3. builder 正常退出，但 state/progress 双无变化，被判 no-op。

以下事件不触发：builder/validator 超时、非零退出、spawn 失败、认证、网络或环境错误。它们继续由异常轮回写与 stall 熔断负责；换贵模型不是环境修复手段。

### 所有权

- `escalated` 仅由引擎修改。builder/validator 指令要求原样保留。
- 每个 agent 返回后，引擎核对轮首值；agent 的升/降级改动都恢复，并写告警与 evidence。
- 人工重置只在引擎停机后的 `prd-to-json` 再派生流程发生。
- 已发布旧 `state.json` 缺字段时按 `false` 读取；后续自然写状态时补齐，不做启动即全文件迁移。
- `retryCount` 继续只承担验收失败与 blocked 上限语义；no-op 不增加它。

## 再派生

### 模型选择

- runner 相同且五个已选模型在当前环境仍可用：保留原配置，不重复提问。
- runner 变化、任一模型失效或用户要求重配：重新发现并提出五道选择题。
- 无发现能力时沿用人工列表流程；不能把历史列表当当前验证。

### story 难度

- story 内容无实质变化：保留现有 `difficulty` 与理由，包括用户事后修正。
- story 内容实质变化：重新自动评估。
- 用户可显式要求全量重新评估。

### `escalated` 精确重置

以下变化使受影响 story 重置为 `false`：

- acceptanceCriteria 实质变化；
- story `difficulty` 变化；
- `models.runner` 变化；
- 该 story 对应的初始 `models.builder[difficulty]` 变化。

仅修改 `difficultyReason`、validator 或 escalation 模型时保留：前两者不改变初始路由，换 escalation 时已失败 story 应直接尝试新的升级模型。

若已有 blocked story，`prd-to-json` 必须让用户选择“保持 blocked”或“用新路由重试”；后者同时设置 `blocked=false`、`retryCount=0`、`escalated=false`，并在 notes 留下模型路由重试说明。

## 可观测性

- 转换结果：每个 story 显示档位、理由与初始实际模型；五项映射集中展示。
- 启动摘要：runner、三档 builder、validator、escalation、CLI 覆盖与模型复核结果。
- 每轮控制台/dashboard：实际模型、阶段、story 档位、路由来源（CLI/难度/升级/默认）。
- evidence iteration：继续记录实际 `builderModel` / `validatorModel`，新增路由来源与升级触发/agent 篡改信息；旧 evidence 字段全部保持可选兼容。
- `status`：显示配置路由、story 难度与 `escalated`；从 `evidence.jsonl` 显示最近一次实际调用。无 evidence 时只声称“配置路由”，不伪称实际值。
- `status --json`：输出上述结构化字段。
- `report.html`：概要展示配置映射；story 卡展示档位、理由、升级状态；轮次时间线展示实际模型与来源。
- 不新增 `run.json`，避免与 evidence 重复且产生清理生命周期。

## 错误语义

| 情形 | 行为 |
|---|---|
| `models` 缺失，story 也无难度字段 | 合法零配置；仅按 CLI 参数或 runner 默认运行 |
| `models` 结构/未知键/空模型值非法 | 启动失败，指出精确字段 |
| 启用 models 但任一 story 难度/理由缺失 | 启动失败 |
| 无 models 但存在难度字段 | 启动失败，提示半套配置 |
| 旧 `profiles` / 扁平 / story.model | 启动失败，提示重新派生 |
| 显式 runner 与配置不一致 | 启动失败 |
| 发现适配器 unsupported | 明确警告，信任人工确认继续 |
| 发现适配器 error | 启动失败 |
| 本次有效模型不在 available 列表 | 启动失败 |
| 配置模型失效但被 CLI 完全覆盖 | 警告后继续 |
| agent 修改 `escalated` | 引擎恢复、告警、evidence 留痕 |

## 兼容性与版本

- `models` 缺失时，旧 PRD 继续按 runner 默认模型运行；新增 CLI 参数不改变缺省 argv。
- `state.json.escalated` 向后兼容缺失值；公开 state 格式不要求人工迁移。
- evidence 只加可选字段，旧 JSONL 与旧报告输入继续可读。
- 未发布旧模型 schema 不兼容，失败信息提供重新派生路径。
- 新增 Cursor runner、公开 `models` 命令、CLI 参数与 `prd.json` 产物结构，属于面向用户的功能与破坏性 schema 变化；下一版本升 **0.23.0** 并同步 README/插件清单。发布仍遵守先 review-loop、人审后 tag 的既有流程。

## 验收判据

1. 未配置 `models` 且无 CLI 覆盖时，三 runner 都不传 `--model`。
2. 三个难度 story 首轮分别收到 `builder.low/medium/high`。
3. 门禁打回、validator 打回、no-op 各自使下一轮走 escalation；超时和非零退出不触发。
4. `escalated` 跨进程保留，旧 state 缺字段按 false；agent 改动被恢复并留痕。
5. 三 CLI 覆盖符合优先级表，`--builder-model` 不压过专用 escalation。
6. 配置 runner 自动决定默认后端，显式错配启动失败。
7. Cursor argv 使用官方 headless/force/model 参数并有测试覆盖。
8. `coding-x models --json` 三态可机读；Codex `model/list` 适配有协议 fixture，不依赖真实账号测试。
9. available/error/unsupported 三种启动预检行为均有集成测试。
10. 所有新旧非法 schema 都在循环前失败，无静默默认回退。
11. `prd-to-json` 生成五项选择、三档判断、理由、再派生保留/重置与 blocked 询问均有静态 prompt 断言。
12. 控制台、dashboard、status、report、evidence 对“配置”与“实际”表述一致。
13. `npm run typecheck` 与 `npm test` 全绿。

## 已知边界

- Claude Code/Cursor 当前缺少公开机器可读模型列表时会走人工清单；这是诚实降级，不以抓取 TUI 补洞。
- provider 可能在启动预检后、实际调用前撤销模型；此时 agent CLI 异常退出，走既有 stall 熔断，不触发 escalation。
- 用户可选择相同或能力倒挂的模型；有可靠元数据时告警，但最终选择权属于用户。
- `auto` 类 runner 内部动态标识若被用户选择，coding-x 只能证明传入了该标识，不能声称知道 runner 内部最终子模型。
