---
title: "全局模型目录：以用户配置取代 runner 自主发现"
status: done
updated: 2026-07-22
scope: root
---

# 全局模型目录：以用户配置取代 runner 自主发现

> 本规格局部修订 [2026-07-21 模型路由重设计](2026-07-21-model-routing-redesign.md) 的“模型发现与启动复核”部分；runner 绑定、low/medium/high 难度路由、首次有效失败升级、CLI 覆盖优先级与可观测性保持不变。决策理由见 [ADR-012](../../../decisions/012-global-model-catalog.md)。

## 背景

v0.23.0 把“模型是否可选”委托给 runner：Codex 通过 app-server `model/list` 枚举，Claude Code 与 Cursor 无稳定机器接口时返回 `unsupported`，派生环节再接受人工清单。该设计的问题不在某个适配器尚未实现，而在真相源本身不稳定：

- 三种 CLI 的枚举、认证和输出合同不一致，版本变化会直接改变 coding-x 行为；
- 当前机器、账号、provider、中转站与配额属于瞬时外部状态，不能成为项目路由合同的可靠来源；
- `unsupported + 会话内人工列表` 没有可复用留痕，同一用户在不同项目和会话会重复选择；
- 模型发现、认证检查和循环预检耦合，导致只想派生 PRD 或核对配置也必须拉起外部 CLI；
- “发现成功”容易被误解为模型实际可调用，实际 provider 仍可能在下一秒拒绝。

本轮把问题重新定义为：coding-x 只需要一个由用户维护的允许目录，并在项目选择和运行前确定性核对目录成员关系；它不负责证明 provider 的实时状态。

## 目标

1. Claude Code、Codex、Cursor 共用一种全局模型目录合同，不依赖任何 runner 的枚举能力。
2. `coding-x models`、`prd-to-json` 与启动预检对同一份目录得出一致结果。
3. 全局目录只保存候选模型，项目 PRD 继续保存 runner 与五项具体映射，两层职责不混合。
4. 启用显式模型策略时，所有本次可能实际调用的模型都必须在目录中声明；错误在 agent/dashboard 启动前暴露。
5. runner-default 的历史零配置行为不增加文件依赖。
6. 路径、schema、错误与 CLI 输出稳定可测，测试和 CI 可用单个环境变量隔离。
7. 文案明确区分“目录已声明”与“provider 当前可用”，不制造在线可用性承诺。

## 非目标

- 自动调用 runner、网络或 provider API 获取模型。
- 自动安装 runner、登录账号、检查余额、配额、base URL 或网络连通性。
- 解析交互 TUI、runner 私有缓存或账号配置。
- 内置厂商模型名单、能力排行、价格、上下文长度或默认模型。
- 把账号、密钥、provider、中转站、base URL、二进制路径写入全局配置。
- 把 low/medium/high、validator、escalation 的项目映射移到全局配置。
- 在多台机器之间自动同步配置。
- 本轮引入 reasoning effort/mode、service tier 或 token/费用路由。

## 数据职责

| 数据 | 真相源 | 写者 | 含义 |
|---|---|---|---|
| runner 允许选择的模型 ID | 全局 `config.json` | 用户；显式 `config init` 只建空模板 | 用户声明的允许目录，不是在线可用性证明 |
| 当前项目的 runner 与五项映射 | `<workspace>/prd.json.models` | `prd-to-json` | 项目执行策略，可审计且不随全局文件自动改写 |
| story 难度 | `<workspace>/prd.json.userStories[*]` | `prd-to-json` | 相对稳定的任务推理复杂度 |
| story 是否已升级 | `<workspace>/state.json.escalated` | 引擎 | 当前运行状态 |
| 某轮实际传给 runner 的模型 | `<workspace>/evidence.jsonl` | 引擎 | 真实调用记录；provider 是否接受由 agent outcome 体现 |

全局配置不是 workspace 运行时状态，不参与 `engine.lock`，也不归档进 workspace。run、models、doctor、status、report 与 skills 都不得改写它；只有用户显式执行 `coding-x config init` 时可以创建文件。

## 全局配置合同

### 路径解析

优先级只有两级：

1. 非空 `CODING_X_CONFIG`：完整文件路径，相对路径按进程当前目录解析；值为空白时按未设置处理。
2. 未设置时使用 `~/.config/coding-x/config.json`，其中 `~` 由 Node 当前用户 home 解析。

不读取 `XDG_CONFIG_HOME`、runner 私有环境变量或 workspace 内同名文件。`coding-x config path` 输出解析后的绝对路径，文件不存在也退出 0，供人和脚本确定编辑位置。

### version 1 schema

```json
{
  "version": 1,
  "models": {
    "claude": [
      { "id": "sonnet", "label": "Sonnet" },
      { "id": "opus", "label": "Opus" }
    ],
    "codex": [
      { "id": "gpt-5.6-codex", "label": "GPT-5.6 Codex" }
    ],
    "cursor": [
      { "id": "composer-2.5", "label": "Composer 2.5" }
    ]
  }
}
```

TypeScript 形状：

```ts
interface GlobalModelConfig {
  version: 1;
  models: {
    claude?: ConfiguredModel[];
    codex?: ConfiguredModel[];
    cursor?: ConfiguredModel[];
  };
}

interface ConfiguredModel {
  id: string;
  label?: string;
}
```

严格校验规则：

- 根必须是普通对象，只允许 `version`、`models`；两项都必填。
- `version` 必须严格等于数字 `1`，字符串 `"1"` 不接受。
- `models` 必须是普通对象，只允许 `claude`、`codex`、`cursor`；允许只配置部分 runner，也允许对象为空。
- runner 值必须是数组；空数组在文件级合法，便于初始化，但查询该 runner 时按“未配置模型”失败。
- 每个模型必须是普通对象，只允许 `id`、`label`。
- `id` 必须是非空、无首尾空白的字符串；同一 runner 内 ID 重复直接报错，不静默去重。
- `label` 如存在，必须是非空、无首尾空白的字符串；它只用于展示，不参与 ID 比较、排序或能力判断。
- 数组顺序原样保留，作为 `models` 命令和 `prd-to-json` 的展示顺序。
- JSON 语法错误、未知字段和所有字段路径都要在错误中明确指出；错误输出不得回显整个配置或环境变量。

`config init` 创建的最小模板为：

```json
{
  "version": 1,
  "models": {}
}
```

初始化可以递归创建父目录，但使用排他创建，目标已存在时退出 1，不提供静默覆盖或自动合并。coding-x 不向模板写任何内置模型。

## 公共 CLI 合同

### `coding-x config`

```text
coding-x config path
coding-x config init
coding-x config validate
```

| 命令 | 行为 | 退出码 |
|---|---|---:|
| `config path` | 输出解析后的绝对路径；不读、不创建文件 | 0 |
| `config init` | 在解析路径排他创建 version 1 空模板；不探测 runner | 0；目标已存在或写入失败时 1 |
| `config validate` | 只读解析并严格校验完整文件 | 0；缺失、JSON/schema 非法时 1 |

三个命令都不获取 workspace 锁。`--workspace` 不改变全局配置路径。

### `coding-x models`

```text
coding-x models [claude|codex|cursor]
coding-x models [claude|codex|cursor] --json
```

runner 解析保持 v0.23 规则：显式位置参数优先；省略时若当前 workspace 有合法 `models.runner` 则使用它，否则回落历史默认 `claude`。已有 PRD 的模型 schema 非法时，不能绕过错误猜 runner。

命令只读取全局配置，不执行 runner 二进制、不做认证检查、不访问网络、不持有 workspace 锁。成功时保留目录顺序，文本输出使用“全局模型目录”而非“当前可用模型”。

`--json` 输出一个对象：

```json
{
  "status": "available",
  "runner": "codex",
  "source": "global-config",
  "configPath": "/Users/me/.config/coding-x/config.json",
  "models": [
    { "id": "gpt-5.6-codex", "label": "GPT-5.6 Codex" }
  ]
}
```

此处 `available` 仅表示“成功读取该 runner 的已配置目录”，不表示 provider 实时可用。错误时输出：

```json
{
  "status": "error",
  "runner": "codex",
  "configPath": "/Users/me/.config/coding-x/config.json",
  "error": "未找到全局模型配置：..."
}
```

成功退出 0，缺文件、配置非法、runner 未配置或数组为空退出 1。v0.23 的 `unsupported` 分支删除，`displayName` / `isDefault` 等发现接口元数据不再输出；配置中的 `label` 原样展示。

## `prd-to-json` 生成与再派生

模型路由仍在 stories 增强、拆分、排序并回写源 PRD之后处理：

1. 询问是否启用模型路由。不启用则同时省略顶层 `models` 和所有 story 的 `difficulty` / `difficultyReason`，无需全局配置。
2. 用户确认 runner：`claude`、`codex` 或 `cursor`。
3. 调用 `npx coding-x models <runner> --json`。成功则把目录按原顺序展示一次；失败则解释配置路径和错误，引导用户执行 `config init` 或编辑配置。
4. 目录错误时不得请用户在当前会话临时粘贴 ID 绕过。用户可以修好配置后重试，也可以明确选择不启用路由并继续普通转换。
5. 从目录批量提出五道选择题：`builder.low`、`builder.medium`、`builder.high`、`validator`、`escalation`。每项由用户选择，多个位置允许相同 ID；不能选择目录之外的值。
6. `label` 只帮助识别，不构成强弱证据。没有额外可靠资料时不按名称猜能力、不自动推荐或判断倒挂。
7. 难度判定、理由证据和写后对照表继续遵守 v0.23 规格。

生成阶段不再要求当前机器安装或登录对应 runner。目录选择与实时 runner 状态解耦；实际运行时若 runner 不存在或 provider 拒绝，由 agent 启动/异常轮如实失败。

同功能再派生时：

- runner 相同，且原五个 ID 都仍在该 runner 当前全局目录中：保留原选择，不重复提问。
- runner 变化、任一 ID 被移出目录、目录读取失败，或用户明确要求重配：停止保留并重新走目录选择；目录失败时不能退回历史列表。
- story 难度与 state 的精确保留/重置规则不变：AC、difficulty、runner 或对应初始 builder 改变时重置 `escalated=false`；只改理由、validator 或 escalation 时保留。
- 全局目录只增加 label、调整顺序或新增未被项目引用的 ID，不属于项目路由变化。

## 启动预检

### 触发条件

preflight 先完成 PRD 模型 schema 与显式 runner 一致性校验，再计算待执行 story。以下条件同时成立时才读取全局目录：

1. 至少存在一个 `passes=false && blocked=false` 的待执行 story；
2. PRD 启用了 `models`，或本次提供了任一模型 CLI 覆盖。

无待执行 story 时没有模型调用，跳过目录读取；无项目路由且无 CLI 模型覆盖时使用 runner 默认模型，也跳过目录读取。两种跳过都不放宽 PRD schema 与 runner 错配检查。

异常兼容路径例外：`prd.json` 缺失或无法解析时，既有 loop 仍可能启动 agent 做修复；此时传入的任一 CLI 模型覆盖都必须先在最终 runner 目录中声明，不能因无法枚举 story 而绕过目录。没有 CLI 覆盖时仍保持历史 runner-default 行为。

### 本次所需模型集合

沿用 v0.23 的确定性路由优先级，计算“本次可能实际调用”的最小集合：

- 每个待执行 story 的当前 builder；
- 尚未升级且存在专用 escalation 路线时的 escalation；
- 固定 validator；
- CLI 覆盖按既有优先级替换被遮蔽路线。

已升级 story 只需要当前 escalation 与 validator，不因目录仍包含初始模型而额外检查；blocked/passed story 不加入集合。所有所需 ID 都必须存在于最终 runner 的目录中，包括纯 CLI、无 `prd.json.models` 的覆盖。

PRD 中被 CLI 完全遮蔽、这次不会实际调用的模型不阻塞启动；若它已不在目录，输出一次警告：该 ID “未在全局模型目录声明但本次已被 CLI 完全覆盖”，并提示重新运行 `prd-to-json`。不得使用“当前不可用”描述静态目录缺项。

### 结果与外部失败

preflight 结果中的 `discovery` 概念改名为 `catalog`，启动摘要使用：

```text
全局模型目录：available（/Users/me/.config/coding-x/config.json）
```

或在零配置/已收敛时：

```text
全局模型目录：skipped
```

preflight 不执行认证、网络或 provider 可用性检查。目录内 ID 在实际调用时仍可能因 runner 未安装、未登录、欠费、模型下线或 provider 不接受而失败；这些都按既有 spawn/error/timeout 异常轮回写与 stall 熔断处理，不能用更贵模型掩盖环境故障，因此不设置 `escalated=true`。

## Doctor 合同

doctor 新增“全局模型目录”区，并与 docs、门禁、workspace 锁检查并列：

| 状态 | 输出 | 是否计失败 |
|---|---|---:|
| 配置文件不存在，当前 PRD 未启用 models | 信息：未配置，runner-default 不受影响 | 否 |
| 配置文件存在且 schema 合法，当前 PRD 未启用 models | 通过，列出已配置 runner 与条目数 | 否 |
| 配置文件存在但 JSON/schema 非法 | 精确错误与配置路径 | 是 |
| 当前 PRD 启用 models，但配置文件不存在 | 缺配置错误 | 是 |
| 当前 PRD 的 runner 未配置或数组为空 | 缺 runner 目录错误 | 是 |
| 当前 PRD 五项任一 ID 未在目录 | 列出字段路径与 ID | 是 |
| PRD 五项都已声明 | 通过 | 否 |

doctor 不执行 runner CLI，不检查认证/provider，不因目录没有覆盖未使用 runner 而失败。`--workspace` 只决定要交叉核对哪份 PRD，配置路径仍只由默认值/`CODING_X_CONFIG` 决定。无 docs/ 时目录检查仍执行，与现有门禁和锁检查一致。

## 错误矩阵

| 场景 | `models` | `prd-to-json` | run preflight | doctor |
|---|---|---|---|---|
| 配置缺失 | error/1 | 不能启用路由；可选零配置 | 有显式模型策略则失败；runner-default 跳过 | PRD 启用路由时失败，否则信息 |
| JSON/schema 非法 | error/1 | 停止路由配置 | 有显式模型策略则失败 | 失败 |
| runner 键缺失/空数组 | error/1 | 不能为该 runner 配置路由 | 该 runner 有显式模型策略时失败 | 当前 PRD 使用该 runner 时失败 |
| 所需 ID 未声明 | — | 不能选择 | 失败并列字段路径 | 当前 PRD 映射缺项时失败 |
| PRD 旧 ID 被 CLI 完全覆盖 | — | 再派生要求重选 | 警告后继续 | doctor 按 PRD 静态映射仍报告缺项 |
| 无 models、无 CLI 覆盖 | 查询行为不变 | 合法零配置 | 跳过目录，runner 默认 | 配置缺失不失败 |
| 已收敛 workspace | 查询行为不变 | — | 校验 schema/runner，跳过目录 | 仍做静态 PRD↔目录核对 |
| 目录已声明但 provider 拒绝 | 仍成功列目录 | 仍可选择 | 仍通过目录复核 | 不检查 |

最后一行的真实失败只在 agent 调用中出现；目录、doctor 或 preflight 不得声称已验证在线可用性。

## 可观测性与隐私

- 控制台启动摘要展示目录复核状态，但不把“配置模型”写成“已实际调用”。
- dashboard、status、report 与 evidence 的既有配置路由/实际命中字段无需加入全局目录副本。
- 错误可展示解析后的配置路径与具体字段路径，不输出完整文件、环境变量、home 其他内容或 runner 配置。
- 全局配置 schema 不接收密钥、账号、base URL、provider 或二进制字段；未知字段严格失败，防止用户误以为 coding-x 会管理它们。
- `config init` 不覆盖已有文件；run/models/doctor 不写配置，模型目录查询不需要 workspace 锁。

## 兼容与迁移

- `prd.json.models`、story difficulty、state.escalated 与 evidence schema 全部不变，无需重写 workspace。
- v0.23 已启用模型路由的项目，必须在 v0.24 首次运行前把五项 ID 登记进相应 runner 目录；否则启动前明确失败。
- 未启用 `models` 且不使用 CLI 模型覆盖的项目完全兼容，不需要创建配置。
- 使用 CLI 模型覆盖的脚本从 v0.24 起也要提供包含覆盖 ID 的全局目录；CI 用 `CODING_X_CONFIG` 指向受控 fixture。
- 消费 `coding-x models --json` 的脚本要删除 `unsupported` 分支，并把 `available` 理解为“目录读取成功”；`source` 固定为 `global-config`。
- `model-discovery.ts`、Codex app-server fixture 与 runner readiness 探测从模型目录链路删除。未来若需要独立的 runner health 命令，应另立合同，不能重新混入目录查询。
- 公开命令语义与配置路径是用户合同，版本升 **0.24.0**，同步 README、架构、skill、插件清单与 npm 包版本。

## 验收标准

1. 默认路径与 `CODING_X_CONFIG` 覆盖有确定性测试；测试不读取开发者真实 home。
2. version 1 合法配置、部分 runner、空数组、坏 JSON、错误版本、未知字段、空白/重复 ID 与非法 label 均有测试。
3. `config path` 不读文件；`config init` 只建空模板且不覆盖；`config validate` 对缺失/非法文件退出 1。
4. `coding-x models` 对三 runner 都只读同一配置，文本/JSON 顺序稳定，只有 `available` / `error`；runner 二进制不存在时仍可成功查询。
5. 无 PRD 模型路由和无 CLI 覆盖时不读取配置，历史 runner-default argv 不变。
6. PRD 模型路由或任一 CLI 模型覆盖启用时，缺配置、缺 runner、所需 ID 未声明都在 agent/dashboard 启动前失败。
7. 初始、已升级、validator、CLI 覆盖与被完全遮蔽配置继续按 v0.23 优先级计算最小所需集合。
8. `prd-to-json` 五项只能从目录选择；目录失败无临时人工列表兜底；再派生按目录成员关系保留或重选。
9. doctor 覆盖缺失/非法/PRD 交叉核对矩阵，且从不拉起 runner。
10. dashboard/status/report/evidence 继续区分项目配置与实际调用，不复制全局目录。
11. 删除 Codex app-server 枚举、Claude/Cursor `unsupported` 与模型发现认证探测，仓库不再包含运行时自主发现路径。
12. `npm run typecheck`、`npm test`、`npm run build` 全绿，并用临时配置完成至少一次 models/config smoke test 与模型路由 fake-agent smoke test。

## 已知边界

- 用户需要自行维护目录；模型下线或 provider 改名不会自动更新。
- 目录成员关系不等于认证、额度、网络或 provider 可用性；只有实际 agent 调用能暴露这些问题。
- 全局文件不随项目归档，复现历史运行仍以 `prd.json` 与 evidence 中记录的具体 ID 为准；目录只决定未来是否允许再次调用。
- 同一 ID 在不同 runner 下可有不同含义；目录按 runner 隔离，不做跨工具映射。
