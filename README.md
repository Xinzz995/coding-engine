# coding-x

> 把一句功能需求，变成一条可追踪、可暂停、可复核的 AI 编码流水线。

如果你只记住一句话：**人负责说明“要什么”和做最终裁决；coding-x 负责让 AI 一次只开发一个小任务，再交给另一个角色逐条验收，直到完成或明确停下来等人处理。**

coding-x 同时包含两部分：

- **工作流插件**：运行在 Claude Code、Codex、Cursor 等 AI 编码工具中，用 commands 和 skills 帮你理解项目、澄清需求、生成 PRD、转换执行清单、审查结果和维护项目文档。
- **自动执行引擎**（`npx coding-x`）：在你的项目目录中读取执行清单，反复启动 Developer（开发者）和 Validator（验收者），逐个 user story 开发、验证并提交，同时提供状态、证据、仪表盘和静态报告。

它不是“输入一句话后无需再看”的黑盒。需求取舍、破坏性修改、审查发现和是否合并，最终都由人决定。

## README 阅读路线

- **第一次使用**：先看「先分清三个位置」「零基础完整流程」「安装」和「使用教程」。
- **想知道文件从哪里来、最后去哪**：看「文档与运行产物的完整流转」。
- **不知道该调用哪个能力**：看「Commands 与 Skills 生命周期」。
- **运行失败或中途改需求**：看「常见情况与处理办法」。
- **需要全部参数和内部原理**：再看「工作原理」「命令行参数」和「coding-x 源码目录说明」。

---

## 先分清三个位置

新手最容易把工具仓库、目标项目和 AI 工具混在一起：

| 名称 | 它是什么 | 你在哪里操作 |
| --- | --- | --- |
| **coding-x（控制端）** | 本仓库提供的插件和 npm 引擎，负责安排步骤、启动 agent、保存状态 | 安装一次；通常不需要修改它的源码 |
| **目标项目（目标端）** | 你真正想开发的网站、服务、App 或其他 Git 仓库 | commands、skills 和 `npx coding-x` 都应在这个项目根目录执行 |
| **runner** | 真正执行 AI 任务的命令行工具：`claude`、`codex` 或 Cursor 的 `agent`（兼容旧名 `cursor-agent`） | 先安装并登录；coding-x 每轮调用它 |

例如，你要给 `my-shop` 增加优惠券功能：coding-x 是控制工具，`my-shop` 是目标项目，Codex 可以是 runner。**不要为了使用 coding-x，把 `my-shop` 的需求和 `.workspace/` 写进 coding-x 源码仓库。**

开发 coding-x 自身时，本仓库可以同时充当控制端和目标端；这是维护者的自用场景，普通用户无需这样做。

### 谁负责什么

| 角色 | 负责 | 不负责 |
| --- | --- | --- |
| **你（人）** | 说明目标、确认业务/技术取舍、审阅转换差异、处理 blocked、裁决 review、决定合并/发布 | 不必逐轮提醒 AI 下一步做什么 |
| **交互式 AI 工具** | 执行 command/skill，和你一起生成文档、转换 PRD、审查和收口 | 不自动获得最终产品裁决权 |
| **coding-x 引擎** | 选 story、启动角色、执行机械门禁、控制重试/超时、签发验收状态、记录证据 | 不替人修改需求，也不替人批准破坏性动作 |
| **coding-x 质量门禁** | 运行项目原生命令、三轴评审、绑定最新提交，并配置/回读 GitHub 规则 | 不把本地反馈当交付凭证，不自动合并或批准例外 |
| **Developer / Builder** | 一次只实现一个 story，运行检查，提交该 story，再声明候选完成 | 不能给自己签发最终验收凭证 |
| **Validator** | 针对引擎绑定的 story 和验收标准逐条复核，提交结构化结果 | 不修代码、不改需求、不直接改最终状态 |

### 会话上下文如何工作

- commands 和 skills 通常在你当前打开的 AI 会话中执行，不会因为名字里有 `loop` 就自动新开会话。`/priming` 建立的理解也主要服务于当前会话。
- 引擎中的每次 Developer 和 Validator 调用都是新的 headless runner 进程，不能依赖上轮聊天记忆；它们通过 Git、`AGENTS.md`、`docs/` 和 `.workspace/` 接力。
- `/review-loop` 现在调用统一的 `quality review` 核心；Spec、工程标准和深度结构评审分别启动只读上下文。它仍只是本地反馈，GitHub 会对 PR 最新提交重新运行。

> **下文命令名的写法：** 为了让三种宿主共用一份说明，本文把命令逻辑名简写成 `/priming`、`/planning` 等。Claude Code 安装插件后的实际名字带命名空间，例如 `/coding-x:priming`；Cursor 以斜杠菜单实际显示的名字为准；Codex 可直接说“使用 coding-x 的 priming 工作流”。如果宿主没有显示裸命令，不要机械输入不存在的 `/priming`，安装和验证方法见「安装」。

---

## 零基础完整流程

下面是一条推荐的完整路线。不是每次都要执行所有可选步骤，后文会说明如何跳过。

1. **准备目标项目。** 确认它是你信任的 Git 仓库，重要内容已经提交或备份，当前没有不明来源的改动。
2. **安装插件和一个 runner。** Node.js 需要 ≥18；Claude Code、Codex 或 Cursor Agent 至少安装并登录一个。详细命令见「安装」。
3. **进入目标项目根目录。** 后面的对话和终端命令都在这里进行，而不是在 coding-x 插件源码目录中进行。
4. **第一次接入时运行 `/init-docs`。** 它只补缺失文档；确认黄金原则、项目检查和来源后，再由 `coding-x quality init` 生成质量契约与 GitHub 门禁。远端规则回读通过前，不算交付就绪。
5. **让当前会话理解项目。** 运行 `/priming`。它不改代码，只输出当前项目概览。
6. **整理需求。** 需求很乱时说 `align: <你的需求>`；涉及数据库、公开接口、状态机、权限或迁移时，再说 `tech: <功能或对齐稿>`。需求已经清楚可以跳过对应步骤。
7. **规划和生成正式 PRD。** 推荐先运行 `/planning <功能描述或对齐稿>`，再说“基于这些材料创建一个 PRD”。逐项确认 AI 提出、且无法从项目中查证的业务问题。
8. **生成引擎执行清单。** 说“将 `docs/prds/prd-xxx.md` 转成 `prd.json`”。检查它展示的 story/AC 对照表；有异议时改源 PRD 后重新转换，不要直接手改 `.workspace/prd.json`。
9. **先体检，再启动。** 运行 `npx coding-x doctor`。初次使用建议保留 `qualityChecks`，模型路由则可以先不启用，直接使用 runner 默认模型。
10. **运行引擎。** 例如 `npx coding-x codex`。浏览器会打开仪表盘；终端也会持续显示当前 story、阶段和实际模型。
11. **观察和处理异常。** 随时运行 `npx coding-x status`；需要完整证据时打开 `.workspace/report.html`。退出码 3 或 story 显示 blocked 时，先看 `state.json` 的 notes 和报告，再做人工裁决。
12. **合并前审查。** 运行 `/review-loop` 获取本地三轴反馈。它不会自动修复，也不会生成远端通过凭证；需要产品判断的问题仍由你裁决。
13. **提交 PR 并通过远端门禁。** 项目检查、Spec、工程标准和按风险触发的深度评审必须全部绑定最新提交通过；模型不可用、资料不足或规则漂移都会阻断。
14. **合并和收口。** 门禁通过后由人决定合并。随后可运行 `/compound-docs`；物理归档只有在你明确授权时才发生。

最短可用路线是：**`quality init` → `prd-generate` → `prd-to-json` → `doctor` → `npx coding-x` → `/review-loop` → GitHub PR 门禁**。`scenario-alignment`、`technical-alignment`、`/planning` 和 `/compound-docs` 都有明确的可选条件。

### 首次运行前的安全红线

> ⚠️ coding-x 会以跳过 runner 权限确认的模式运行 AI agent。它可以读写目标项目、执行命令、创建/切换分支并提交代码。

- 只在你信任的仓库中运行；先提交或备份自己的未完成工作。
- 确认目标项目的测试/typecheck 基线本来就是绿色，否则循环会把旧失败误当成本轮问题反复处理。
- `.workspace/` 应被 Git 忽略；让 `prd-to-json` 和 `doctor` 检查，不要把运行状态混入产品提交。
- 不要在引擎运行时修改 `prd.json`、运行 `repair` 或重新派生需求；先停止引擎并确认锁已释放。
- 不要把密码、密钥写进 PRD、progress、截图或模型目录。全局模型目录只保存模型 ID，不保存账号凭据。

---

## 理念

传统 AI 编码是「人不断盯着、一句句地喂」。coding-x 反过来：

> **人只负责把需求讲清楚（生成 PRD），剩下的「写代码 → 自检 → 验收 → 修复 → 再验收」交给一个确定性的循环反复跑，直到所有验收标准通过。**

三条核心原则：

1. **确定性 harness，而非一次性对话。** 循环、超时、重试、完成判定都由程序控制，不依赖模型「记得」自己该干什么。
2. **开发与验收分离。** 写代码的 agent 和验收的 agent 是两个独立角色，验收方只认「验收标准」，不受开发方自述影响，避免「自己判自己及格」。
3. **单一 story、频繁提交、进度可追溯。** 每轮只推进一个 user story，只提交该 story 的实现/测试/必要文档，再把学习与踩坑写入 workspace 的 `progress.md` 供后续迭代复用。

技法来源：Ralph 自主循环 + Anthropic harness 设计。

---

## 工作原理

引擎在项目根目录启动，围绕 workspace 的三份核心文件运转：`prd.json`（需求，运行期由引擎快照冻结）、`state.json`（执行状态；builder 只写候选完成，Validator verdict/重试/凭证由引擎写）和 `progress.md`（进度与学习日志）。`evidence.jsonl` 追加引擎机械记录（含每次真实 Agent 调用的耗时/退出码/异常输出尾部）、`source=validator` 的逐 AC claim 与 agent 截图登记；`validation-result.json` 只是一轮 Validator 调用的瞬时 IPC，消费后删除，不能当长期状态。`prd.json` 是 `docs/prds/` 源 PRD 的派生物：md 是**意图真相源**（人写人审，需求变更改它），`prd.json` + `state.json` 是**执行真相源**（机器与 agent 读写）；需求冲突时以 md 为准重新派生（见 `docs/decisions/003-prd-layered-truth.md`）。旧版 workspace（状态写在 prd.json 里、无 state.json）在 v0.5.0 引擎首次运行时自动抽取迁移，无需手工处理；`state.json` 已存在但损坏时不是迁移信号，report/status/dashboard 会统一把所有 story 按未验证状态显示并提示 repair。

```
                      npx coding-x
   ┌─────────────────────────────────────────────────────────┐
   │  for i in 1..maxIterations:                              │
   │                                                          │
   │   ┌── Developer（builder.md）──────────────────────────┐ │
   │   │ 1. 读 prd.json+state.json，选最高优先级未完成 story │ │
   │   │ 2. 只实现这一个 story                               │ │
   │   │ 3. 跑质量检查（typecheck / lint / test）            │ │
   │   │ 4. 通过则只提交 story 文件（不提交 workspace）      │ │
   │   │ 5. 再写 passes=true 候选并追加 progress.md           │ │
   │   └────────────────────────────────────────────────────┘ │
   │                          ↓                               │
   │   ┌── 机械门禁（qualityChecks，可选）──────────────────┐ │
   │   │ 引擎逐条 shell 执行质量检查命令（fail-fast）        │ │
   │   │ 失败 → 确定性打回 story、跳过本轮 Validator         │ │
   │   └────────────────────────────────────────────────────┘ │
   │                          ↓                               │
   │   ┌── TDD 门禁（tdd，可选）────────────────────────────┐ │
   │   │ 校验冻结政策，再独立运行项目 coverageCheck          │ │
   │   │ 失败 → 确定性打回 story、跳过本轮 Validator         │ │
   │   └────────────────────────────────────────────────────┘ │
   │                          ↓                               │
   │   ┌── Validator（validator.md）────────────────────────┐ │
   │   │ 1. 接收引擎绑定的 story / AC hash / Git HEAD        │ │
   │   │ 2. 按 request 快照逐条核对 acceptanceCriteria       │ │
   │   │ 3. 只写逐 AC 结构化 claim，不修改 state.json        │ │
   │   └────────────────────────────────────────────────────┘ │
   │                          ↓                               │
   │   引擎：校验 nonce/目标/产物/schema/state 不变式         │
   │         passed → validated=true                         │
   │         failed → 写 notes/retryCount/blocked            │
   │   所有 story 都 passes&&validated 或 blocked ?          │
   │                                  是 ──▶ 成功退出         │
   │                                       否 ──▶ 下一轮       │
   └─────────────────────────────────────────────────────────┘
                          ↓
        http://localhost:7331  实时查看进度
```

- **完成即退出**：全部 story 同时满足 `passes && validated`（无 blocked）→ 退出码 0；全部收敛但存在 blocked 待人工 → 退出码 3；跑满 `maxIterations` 仍未收敛，或连续无进展轮触发 `--stall-limit` 熔断 → 退出码 1（完整对照见「命令行参数」后的「退出码」表）。
- **工作区锁**：启动时在 workspace 写 `engine.lock`（O_EXCL 原子创建），同一 workspace 的第二个 `run`/`repair` 以退出码 2 直接拒绝；异常退出（kill -9、断电）遗留的 stale 锁在下次启动时自动接管并告警，无需人工清理。
- **超时保护**：开发/验证各有独立超时；任一侧异常退出都不会留下未经验收的通过态，下一轮重试。每次真实调用记录完整收口耗时与退出码，异常时另保留最近 2000 字符诊断，终端输出仍实时可见。
- **机械门禁（可选）**：`prd.json` 顶层配置 `qualityChecks`（完整 shell 命令数组）后，引擎在每轮开发之后、验证之前逐条确定性执行（fail-fast，单条超时 10 分钟）；失败即机械打回（`retryCount` +1，累计 5 次 `blocked`）并跳过该轮 validator——builder 谎报「检查通过」会被零成本戳穿。门禁配置受快照保护：运行期改写 prd.json（含删改 `qualityChecks` / 验收标准）会被检测、恢复并存档，无法架空门禁与验收（ADR-007）。未配置时行为不变，`npx coding-x doctor` 会给出配置建议。
- **TDD 门禁（可选）**：启用 `prd.json.tdd` 后，Builder 按 `tdd` skill 对每个公共行为做真实 RED→同命令 GREEN→绿色重构；宿主 hook 在 agent commit 前提前检查，引擎仍在 Validator 前独立校验 Git 基线、政策摘要、新增覆盖忽略标记并运行项目原生 `coverageCheck`。hook 通过不能跳过引擎重跑；覆盖率证明代码被执行，不证明断言有效或历史上一定先写测试（ADR-017）。
- **可信目标绑定**：每轮 Validator 都收到一次性 request ID、精确 story、AC 快照/hash 和调用前 Git HEAD，必须提交版本化、逐 AC、自洽的结构化 claim。缺结果、旧结果、错 story/hash/commit、漏 AC、产物变化或改写 `state.json` 全部 fail closed，不签发凭证（ADR-015）。该协议消除正常控制流中的错目标/无结果假绿，但同权限 agent 仍能伪造观察，不能替代机械门禁和人审。
- **workspace 写入避让与 Git 隔离**：`.workspace/` 是运行时状态，不属于 story commit。`prd-to-json` 在任何变更前及首次真实写入前各用 `doctor` 检查工作区锁，发现引擎运行中或无法判定就保持零写入，且绝不删除 `engine.lock`；随后检查目录是否被忽略、是否已有文件进入 Git 索引。它不会擅自修改 `.gitignore` 或 Git 索引。锁检查是尽力避让，不替代引擎的机械互斥。
- **状态所有权**：引擎与 agent 都在项目根目录运行，但写权限按角色收紧：builder 只写候选 `passes`/进度，Validator 只写本轮 result 与可选截图 claim，所有 Validator verdict 状态和 `validated`/`escalated` 由引擎独占。指令模板用 `{{WORKSPACE}}` 注入路径，validation request 由引擎逐轮追加，三种 runner 共用同一协议。

---

## 安装

### 环境要求

- **Node.js ≥ 18**
- 已安装、已认证并可在终端调用 **`claude`**（Claude Code CLI）、**`codex`** 或 Cursor 的 **`agent`** / **`cursor-agent`**（取决于你用哪个 runner）

插件和 runner 是两件事：**插件**让交互式 AI 知道怎样做需求对齐、PRD、review 等工作流；**runner**才是 `npx coding-x` 在自动循环中启动的 AI 命令行程序。只装其中一个不能代替另一个。

### Claude Code

在 Claude Code 对话中添加 marketplace、安装插件，并让当前会话重新加载：

```text
/plugin marketplace add Xinzz995/coding-engine
/plugin install coding-x@coding-x-marketplace
/reload-plugins
```

看到 `/coding-x:priming`、`/coding-x:init-docs` 等条目就表示插件已加载。Claude Code 会给插件能力加 `coding-x:` 命名空间；例如本文写的 `/planning 搜索功能`，实际输入 `/coding-x:planning 搜索功能`。skills 也可以由 Claude 按语境自动使用，或显式说出 skill 名。安装机制可参照 [Claude Code 官方插件与 marketplace 文档](https://code.claude.com/docs/en/plugin-marketplaces)。

### Codex

Codex CLI 用户可在普通终端中添加本仓库 marketplace 并安装插件：

```bash
codex plugin marketplace add Xinzz995/coding-engine
codex plugin add coding-x@coding-x-dev
```

随后**新开一个 Codex 任务**再使用；也可以在 Codex CLI 输入 `/plugins`，从已配置的 `coding-x-dev` marketplace 安装。Codex 桌面版可重启后打开 Plugins，选择本仓库来源并安装。当前官方支持面是 Codex 桌面版与 Codex CLI，**Codex IDE 扩展不支持插件**；详见 [OpenAI 插件使用说明](https://learn.chatgpt.com/docs/plugins) 和 [插件构建/marketplace 说明](https://learn.chatgpt.com/docs/build-plugins)。

在新任务中可以直接说“使用 coding-x 的 prd-to-json skill 转换这个 PRD”或“使用 coding-x 的 priming 工作流理解项目”。若当前 Codex 版本把 command 兼容加载为 skill，不一定出现与 Claude Code 相同的斜杠名字，以自然语言点名工作流最稳妥。

插件启用 TDD hook 时，Codex 会要求你审查并信任 hook 配置。先确认命令确实来自本仓库的
`hooks/tdd-commit-check.mjs` 再授权；不信任就不要运行。hook 只做 agent commit 前的提前
反馈，最终结论仍由 coding-x 引擎重跑。参见 [Codex hooks 官方说明](https://developers.openai.com/codex/hooks)。

### Cursor

在 Cursor 的 Agent 对话中输入 `/add-plugin`，选择从 GitHub/仓库安装，并粘贴：

```text
https://github.com/Xinzz995/coding-engine
```

安装后重新加载 Cursor 窗口，在 Plugins/Skills 中确认 `coding-x` 已启用；然后可从斜杠菜单选择 command，或在对话中显式说出 skill/工作流名。若没有 `/add-plugin`，先更新到支持插件的 Cursor 版本。Cursor 的官方入口说明见 [Cursor 2.5 插件发布说明](https://cursor.com/changelog/2-5) 和 [Cursor Plugins 文档](https://cursor.com/docs/plugins)。

**还需要单独安装 Cursor Agent CLI。** 只安装 Cursor 桌面应用不够；coding-x 的
`cursor` runner 和真实 hook 验收都要求终端可调用独立 CLI。按当前官方安装页安装后先运行
`agent --version` 并完成登录，再运行 `npx coding-x cursor`。coding-x 会自动兼容旧安装的
`cursor-agent`；只有自定义安装路径时才需要设置 `CODING_X_CURSOR_BIN`。参见
[Cursor CLI 安装说明](https://cursor.com/docs/cli/installation)。

Cursor 插件继续提供 commands 和 skills；TDD 提交前检查需要在每个目标 Git 项目中显式安装：

```bash
npx coding-x hooks cursor install
npx coding-x hooks cursor status
```

安装器只安全合并项目内的 `.cursor/hooks.json`，并复制一份离线可运行的检查脚本。它不改
Git hooks、不暂存、不提交，也不会在 `npx coding-x cursor` 或 `prd-to-json` 时偷偷执行。
升级 coding-x 后重新运行 install 刷新脚本；不再需要时运行
`npx coding-x hooks cursor remove`。项目级 `.cursor/` 文件是否提交到 Git 由你决定。

> 说明：三套工具共用**同一份** `skills/` 和 `commands/`，各自只多一个瘦清单指回它（详见下文「coding-x 源码目录说明」）。宿主对 command 的展示方式不同，但工作流内容不复制。引擎（`npx coding-x`）与插件安装分开；它会调用你在终端选择且已经登录的 runner。

---

## 快速开始

先在 AI 编码工具中完成文档准备。下面以 Claude Code 的实际命令为例：

```text
/coding-x:init-docs
/coding-x:priming
/coding-x:planning 增加一个可以按关键词搜索笔记的功能
创建一个 PRD
将 docs/prds/prd-search-notes.md 转成 prd.json
```

使用 Codex 或 Cursor 时，不必猜命令前缀：直接说“使用 coding-x 的 init-docs 工作流初始化文档”“使用 priming 工作流理解项目”“使用 planning 工作流规划搜索功能”。然后继续说代码块中的“创建一个 PRD”和“将……转成 prd.json”，它们会分别触发 `prd-generate` 和 `prd-to-json` skill。

然后在**目标项目根目录**运行：

```bash
npx coding-x doctor          # 先检查文档、门禁、模型配置和 workspace 隔离
npx coding-x status          # 确认执行清单可读；未开始时显示全部待执行

npx coding-x hooks cursor install  # 仅 Cursor + TDD：首次使用或 coding-x 升级后安装/刷新
npx coding-x hooks cursor status   # 仅 Cursor + TDD：确认项目级检查完整

npx coding-x                 # 默认用 claude
npx coding-x codex           # 改用 codex
npx coding-x cursor          # 改用 Cursor Agent

# 浏览器通常会自动打开，也可手动访问：
# http://localhost:7331      普通视图
# http://localhost:7331/p    像素风视图
```

`npx` 首次运行时可能询问是否下载 `coding-x`，这是 npm 的正常提示。模型路由和 TDD 都是
可选项；新手可以先不配置 `models`。要启用 TDD，就在 `prd-to-json` 询问时确认项目类型、
真实覆盖命令和政策，不能直接手写一条未经基线验证的命令。

你可以用三个信号判断接入是否成功：交互式 AI 能按 `priming` 工作流输出项目概览；`npx coding-x --help` 能显示 CLI 用法；生成 `.workspace/prd.json` 后，`npx coding-x doctor` 没有硬错误。任何一项失败，都先按「常见情况与处理办法」排查，不要直接启动自动循环。

---

## 基本工作流程

```
原始想法
   │
   ├─ scenario-alignment（业务不清楚时）──▶ docs/prds/align-*.md
   ├─ technical-alignment（技术合同昂贵时）▶ docs/prds/tech-*.md
   └─ /planning（推荐、可选）─────────────▶ docs/plans/*.md
   │
   ▼
quality init ───────────────▶ .coding-x/quality.json + GitHub 受管工作流/规则
                                              │
                                              ▼
prd-generate ─────────────────────────────▶ docs/prds/prd-*.md
                                              │  正式意图真相源，进入 Git
                                              ▼
prd-to-json ──────────────────────────────▶ .workspace/prd.json
                                              │  本地执行派生物，不进入 Git
                                              ▼
npx coding-x ───────────────▶ Developer → 普通门禁 → TDD 门禁 → Validator → 下一 story
                                              │
                                              ├─ state/progress/evidence/screenshots
                                              ├─ dashboard / status
                                              └─ report.html
                                              ▼
/review-loop ───────────────▶ .workspace/quality/ 本地三轴反馈
                                              ▼
GitHub PR ──────────────────▶ 最新提交的四项必需检查
                                              ▼
人决定合并 ─────────────────▶ /compound-docs（可选沉淀/显式归档）
```

---

## 什么时候用哪个步骤

| 你的情况 | 应该做什么 | 可以跳过什么 |
| --- | --- | --- |
| 第一次把 coding-x 接入某仓库 | `/init-docs`，确认后执行 `quality init` 与远端 bootstrap，再 `/priming` | 质量契约和远端规则均健康后无需重复初始化 |
| 需求是口述、聊天记录、bug 和改版混在一起 | `scenario-alignment` | 需求边界已经清楚时可跳过 |
| 涉及数据库/schema、公开接口、状态机、权限、存量迁移 | 业务口径确认后执行 `technical-alignment` | 纯页面文案或局部逻辑通常可跳过 |
| 需要一份别人拿到就能实施的技术路线 | `/planning <功能>` | 极小改动可跳过，但 PRD/AC 仍要清楚 |
| 要进入自动执行 | `prd-generate` 生成正式 PRD，再用 `prd-to-json` 派生 | 不能只拿 align/tech/plan 直接启动引擎 |
| 要用测试驱动开发 | 在 `prd-to-json` 中明确启用 TDD，确认公共行为、覆盖命令、政策与真实基线 | 不能把覆盖率当测试质量或先写测试的证明 |
| 有 UI 验收 | 在 AC 中写清页面、操作、结果；环境有 `agent-browser` 时用它验证和截图 | 不能只写“页面正常”或只做 HTTP 冒烟 |
| 引擎全部通过，准备合并 | `/review-loop` 获取本地反馈，再创建 PR 等待四项远端检查 | 不能因为本地反馈或 Validator 已通过而跳过远端门禁 |
| 功能已合并，需要更新长期知识 | `/compound-docs` | 没有可复用知识时允许零修改 |

---

## 文档与运行产物的完整流转

coding-x 的信息分四层保存：

1. **`docs/` 与 `AGENTS.md`：长期、可评审、应进入 Git。** 它们告诉人和未来 agent“项目现在是什么、这次想做什么”。
2. **`.workspace/`：当前执行的本地工作台，默认应被 Git 忽略。** 它保存机器状态、过程证据和报告，可以断点续跑，但不应混入产品提交。
3. **`.coding-x/` 与 `.github/`：受 Git 管理的质量政策和交付控制。** 它们定义项目原生命令、评审来源、异常记录和 GitHub 工作流。
4. **全局配置：跨项目复用。** 默认在 `~/.config/coding-x/config.json`，只保存允许使用的模型 ID。

### 长期项目文档：来源、去处和生命周期

| 产物 | 谁创建或更新 | 来源 | 谁会读取 | 生命周期与去处 |
| --- | --- | --- | --- | --- |
| `AGENTS.md` | `/init-docs`；以后人工维护索引 | 代码结构、项目命令和硬约束 | 交互式 agent、Builder、Validator | 长期入口，保持短小；细节下沉 `docs/`，进入 Git |
| `CLAUDE.md` | `/init-docs` 在缺失时创建 | `@AGENTS.md` 桥接 | Claude Code | 长期薄文件；已有文件不会被覆盖 |
| `docs/architecture.md` | `/init-docs` 初始化，`/compound-docs` 按事实更新 | 当前代码结构、边界和数据流 | 规划、实现、审查 | 长期 active 文档，结构变化时更新，不归档 |
| `docs/golden-principles.md` | `/init-docs` 提候选，人确认；后续谨慎维护 | 项目最重要、可机械检查的规则 | `/planning`、Builder、`/review-loop` | 长期 active；保持少量强规则，不作为历史日志 |
| `docs/patterns.md` / `docs/glossary.md` | `/init-docs` 建骨架，`/compound-docs` 沉淀/去重 | 当前代码、Git、progress 中仍成立的经验 | 后续规划和实现 | 长期 active；失效内容被改写、合并或删除 |
| `docs/decisions/*.md` | 人或规划过程记录 | 重要架构取舍及理由 | 后续设计与审查 | ADR 长期保留；active/superseded/rejected 表示决策状态，不随普通收口删除 |
| `docs/prds/align-*.md` | `scenario-alignment` | 原始需求 + 代码/文档事实 + 人工业务裁决 | `technical-alignment`、`prd-generate` | 一次性业务对齐材料；正式 PRD 吸收后置 `superseded`，可显式归档 |
| `docs/prds/tech-*.md` | `technical-alignment` | 已确认业务口径 + 当前架构 + 人工技术裁决 | `prd-generate` | 一次性技术合同材料；正式 PRD 吸收后置 `superseded`，可显式归档 |
| `docs/plans/*.md` | `/planning` | 需求/对齐稿 + 代码调研 + 官方资料 | 人、实施 agent、`/review-loop` | 实施路线参考；初始 `active`，实现已合并后置 `done`，可显式归档；**不替代 PRD** |
| `docs/prds/prd-*.md` | `prd-generate`；`prd-to-json` 只回写增强后的 User Stories | 对齐稿、计划或清楚的原始需求 + 人工回答 | `prd-to-json`、人审、后续需求变更 | **意图真相源**；初始 `active`，全部 story 通过且合并后置 `done`；需求变化时重新 active 并再派生 |
| `docs/specs/*.md` | 项目自行采用的设计过程或其他工具 | 功能设计 | 规划、实现、审查 | coding-x 当前没有专门生成它的 command；有则按 active/done 管理，可显式归档 |
| `docs/archive/` | `/compound-docs` 在人明确授权后移动 | 已完成或被替代的任务型文档 | 只在追溯历史/修断链时读取 | **Git 内冷档案**；不再作为日常当前事实，不留旧路径副本 |

`docs/` 任务文档的 frontmatter 常用状态：

| 状态 | 含义 | 下一步 |
| --- | --- | --- |
| `active` | 当前仍生效、待实现或待完成 | 保留在 active 区继续维护 |
| `done` | 已有完成证据；PRD 要求 story 全通过且已经合并 | 可保留，也可在人授权后移入 `docs/archive/` |
| `superseded` | 内容已被后继文档吸收或取代 | 标明替代者，可在人授权后归档 |
| `rejected` | 方案评估后明确不做，常用于 ADR | 保留作为先例，避免重复讨论同一提案 |

“改成 done”和“移动到 archive”是两件事：前者是状态裁决，后者是路径变化。`/compound-docs` 可以根据证据更新状态，但没有“物理归档”授权时只列候选，不会移动文件。

### `.workspace/`：来源、用途和去处

| 产物 | 何时产生 | 谁写 / 谁读 | 用途 | 生命周期与去处 |
| --- | --- | --- | --- | --- |
| `prd.json` | `prd-to-json` 根据正式 PRD 生成 | skill 写；引擎/agent 读；运行期由引擎冻结保护 | 本轮可执行 story、AC、分支、普通/TDD 门禁和可选模型路由 | 当前功能的执行需求；需求或 TDD 政策改变时从源 PRD 再派生，**不要直接改** |
| `state.json` | 引擎首次运行自动创建；再派生时按 story ID 调整 | Builder 只写候选 `passes`；最终 verdict、重试、blocked、validated/escalated 由引擎控制 | 当前执行状态和人工仲裁 notes | 断点续跑依据；新功能切换时旧副本进 `.workspace/archive/` |
| `progress.md` | `prd-to-json` 初始化/切换功能时重置；Builder 逐轮追加 | Builder 写；后续 Builder 和 `/compound-docs` 读 | 跨无记忆轮次传递实现进度、模式和陷阱 | 过程上下文，不是完成证据；随旧运行归档 |
| `evidence.jsonl` | 引擎运行时逐行追加；agent 可登记截图 | 引擎与 agent 写；status/report 读 | 门禁、轮次、调用、验收 claim、协议裁决、截图索引 | append-only 过程索引；再派生会清理当前副本并归档旧副本 |
| `validation-result.json` | 每次 Validator 调用临时生成 | Validator 写；引擎读取后删除 | 单轮结构化验收 IPC | **瞬时文件**；不作为长期状态，也不归档 |
| `screenshots/` | UI 的最终 Builder/Validator 验证时产生 | agent 写；report 读 | 可视化验收工件 | 与本轮 workspace 一起保留/归档；分享报告时要连同该目录 |
| `report.html` | 每次循环结束自动生成；`coding-x report` 可重建 | 引擎/CLI 写；人读 | 汇总实现状态、证据、截图、本地反馈和红旗，并单列交付状态 | 可重复生成的阅读视图；不能证明 GitHub PR 已通过 |
| `quality/receipts.jsonl`、`quality/review-latest.md` | `quality review/gate/doctor` 本地运行时产生 | coding-x 写；status/report/人读 | 最新提交绑定的本地三轴反馈与诊断 | workspace 可写，只用于提前反馈；共享交付记录在 GitHub Check/PR 历史 |
| `engine.lock` | `run` 或 `repair` 开始时原子创建 | 引擎独占 | 防止两个写者同时改同一 workspace | 正常退出删除；异常遗留由下次运行判定并接管，不要习惯性手删 |
| `prd.tampered-*.json` | 引擎发现运行期 PRD 被修改时产生 | 引擎写；review/report/人读 | 保存被检测到的篡改版本，当前 PRD 会按启动快照恢复 | 红旗取证；切换功能时随旧运行归档并清出当前根目录 |
| `archive/<日期-功能>/` | 新功能覆盖旧 workspace，或同功能需求再派生之前 | `prd-to-json` 创建 | 保存旧运行/旧 AC 对应的本地状态和证据 | **本地运行档案**；与 Git 内 `docs/archive/` 完全不同，可按保留策略人工清理 |

`.workspace/` 不是缓存目录：`report.html` 可以重建，但 `state.json`、progress、截图和历史反馈可能没有其他副本。不要像删除 `dist/` 那样随手删除整个 workspace；也不要把其中任何文件称作共享交付凭证。

### 全局模型目录

`~/.config/coding-x/config.json`（或 `CODING_X_CONFIG` 指定的文件）位于目标项目之外，供多个项目复用。它只声明“允许传给某个 runner 的模型 ID”，不保存 API key、账号或 provider 地址，也不证明模型当前可用。初次使用不需要配置模型路由；只有要按 story 难度选择模型时才需要它。

### 一条需求如何被追踪到底

1. 正式 PRD 中的 `US-001` 等 ID 一旦分配就保持稳定；删除后也不回收编号。
2. `prd-to-json` 把仓库内源 PRD 的相对路径写进 `prd.json.sourcePrd`，并把增强/拆分后的最终 stories 回写源 PRD，同时展示转换对照表。
3. `state.json` 用同一个 story ID 保存执行状态；引擎给 Validator 的 request 还绑定 AC 快照/hash、一次性 request ID 和调用前 Git HEAD。
4. Developer 默认每个 story 单独提交；`evidence.jsonl` 分别记录 `source=validator` 的声明和 `source=engine` 的机械观察/协议裁决。
5. `/review-loop` 的本地 receipt 绑定当前提交；修复产生新提交后旧结果失效。AC 本身有缺口时，还必须先回补源 PRD，再让 GitHub 对新提交重跑。
6. `report.html` 把上述材料汇总成阅读页面。它方便检查，但不把 agent 可写的记录伪装成不可篡改证明；最终交付结论以 GitHub PR 最新提交的必需检查为准。

### 需求变更时只改哪里

**改 `docs/prds/prd-*.md`，然后重新运行 `prd-to-json`。** 不要为了“快”直接改 `.workspace/prd.json` 或 `state.json`。

- AC 没变的 story：再派生会按稳定 ID 尽量保留已有状态。
- AC 有实质变化的 story：该 story 会重置为待重新验收。
- 新增/删除 story：state 按 ID 增删；旧证据先归档，避免对错 AC。
- branchName 不同：视为新功能，先归档上一轮 workspace，再初始化新一轮。
- 引擎正在运行：先停止并确认没有活锁，再派生；skill 不会替你强行覆盖。

---

## 使用教程（整体流程）

### 第 1 步：生成 `prd.json`

在目标项目中打开 Claude Code、Codex、Cursor 或其他已加载插件的 AI 工具：

1. **只在首次接入时初始化知识库**：运行 `/init-docs`。如果它列出 monorepo 子项目或黄金原则候选，先由人确认；已存在的文件会跳过，不会覆盖。
2. **建立当前会话理解**：运行 `/priming`。检查它识别的项目目标、技术栈、关键目录和当前分支是否正确。
3. **按需要做两端对齐**：输入杂乱时说 `align: <需求>`；存在昂贵技术合同时说 `tech: <功能或 align 文件路径>`。对齐稿中的待拍板问题必须由人回答。
4. **生成实现计划（推荐、可选）**：运行 `/planning <功能描述或对齐稿路径>`。计划说明“怎么做”，但不决定最终验收口径。
5. **生成正式 PRD**：说“基于 `<对齐稿/计划路径>` 创建一个 PRD”。没有前置材料时也可以直接说“为 `<功能>` 创建一个 PRD”。确认 Goals、Non-Goals、每个 story 和 acceptance criteria 后再继续。
6. **转换为执行清单**：说“将 `docs/prds/prd-xxx.md` 转成 `prd.json`”。skill 会：
   - 在写入前和真正写入前分别检查引擎锁；活锁或无法判定时保持零写入；
   - 检查 `.workspace/` 是否被 Git 忽略、是否已有运行文件被跟踪，异常时交给你决定，不擅自改 `.gitignore` 或 Git 索引；
   - 把模糊 AC 改成可执行断言、拆分过大 story、补闭环 story，并把最终 User Stories 回写仓库内源 PRD；
   - 询问是否启用 TDD；启用时确认新项目/存量项目、真实覆盖命令、生产路径、政策文件、Git 基线与禁止标记，跑通至少一个真实测试和分支覆盖后才写入；
   - 在会话里展示“源 story → 执行 story → 变化”的对照表；
   - 对不同功能先归档上一轮 workspace；对同一功能的需求变化按稳定 story ID 再派生。
7. **人工检查三个结果**：源 PRD 的变化、转换对照表、`npx coding-x doctor` 的结论。有异议就改源 PRD 并重新转换，不要直接改 JSON。

#### 看懂 `prd.json`（通常不需要手写）

下面的 JSON 只帮助你理解字段；正常流程应由 `prd-to-json` 生成：

```jsonc
{
  "project": "我的项目",
  "branchName": "ralph/my-feature",
  "sourcePrd": "docs/prds/prd-my-feature.md",  // 意图真相源（源 PRD）路径，冲突时以它为准重新派生
  "qualityChecks": ["npm run typecheck", "npm test"],  // 机械门禁（可选）：每轮 builder 后引擎逐条执行，失败确定性打回
  "tdd": {                                     // TDD 门禁整段可选；出现时五个字段必须完整
    "coverageCheck": "node scripts/tdd-coverage-gate.mjs",
    "sourcePathspecs": [":(glob)src/**"],       // 用户批准的生产代码 Git 范围
    "policyFiles": [
      {
        "path": "scripts/tdd-coverage-gate.mjs",
        "sha256": "<当前文件的 64 位小写 SHA-256>"
      }
    ],
    "baselineRef": "<启用时的完整 Git commit id>",
    "forbiddenAddedPatterns": ["istanbul ignore", "c8 ignore"]
  },
  "models": {                                  // 模型路由整段可选；一旦启用必须完整
    "runner": "codex",                       // claude | codex | cursor，绑定单一 runner
    "builder": {
      "low": "model-a",                     // 低难度 story 初始模型
      "medium": "model-b",                  // 中难度 story 初始模型
      "high": "model-c"                     // 高难度 story 初始模型
    },
    "validator": "model-d",                 // validator 恒定模型
    "escalation": "model-e"                 // 首次有效失败后的 builder 专用模型
  },
  "description": "...",
  "userStories": [
    {
      "id": "US-001",
      "title": "用户可以新建笔记",
      "description": "...",
      "acceptanceCriteria": ["Typecheck passes", "在浏览器中点击新建按钮能创建笔记"],
      "priority": 1,                         // 数字越小越优先
      "difficulty": "medium",              // 启用 models 时每个 story 必填：low | medium | high
      "difficultyReason": "命中 medium-1：需协调多个现有模块。"
    }
  ]
}
```

#### 看懂 `state.json`（不要手工推进状态）

`state.json` 由引擎首跑自动生成；旧版含状态字段的 prd.json 会被自动抽取迁移：

```jsonc
{
  "US-001": {
    "passes": false,      // builder 完成后置 true；只是待验证的候选结果
    "validated": false,   // 结构化 claim 通过全部绑定/不变式后由引擎置 true；agent 不得改写
    "notes": "",          // 引擎写验证失败原因；builder 仲裁标签会被机械路径保全
    "retryCount": 0,      // 引擎确认的门禁/Validator failed 次数
    "blocked": false,     // 引擎累计失败 5 次后置 true；builder 也可配合仲裁显式置位
    "escalated": false    // 首次有效失败后由引擎置 true；agent 不得改写
  }
}
```

引擎每轮选择 `priority` 最高、尚未同时满足 `passes && validated` 且 `blocked: false` 的 story（状态读自 `state.json`）。

> **0.25.0 验收凭证迁移：** 新状态用 `validated` 区分“builder 声称完成”和“引擎已观察 Validator 正常完成”。旧 state 缺少该字段时，读取阶段按历史 `passes` 值兼容，不会把既有已完成 workspace 全量重验；新一轮自然写回后会补齐字段。显式的 `passes=true, validated=false` 会被视为中断留下的待验收状态并回写待复核。

> **结构化验收协议：** 所有新 Validator 轮次都必须提交 `validation-result.json` v1；不再从 `progress.md` 猜 story，也不再直接改 `state.json`。旧 state/evidence 继续可读，但新轮次不会静默回退到“退出 0 + passes 未变”的旧判定。Git 不可用时 request 明示 `gitHead: null`，此时只有 request/story/AC 绑定，status/report 会显示 `unavailable`，不会伪装成完整产物绑定。

#### 可选进阶：TDD

TDD 的开发顺序由 `tdd` skill 指导：

1. 一次只选一个公共可观察行为，先写聚焦测试；
2. 真实运行并确认失败原因正是行为尚未实现；语法、依赖、路径或环境错误不算 RED；
3. 写最小实现，用完全相同的聚焦命令取得 GREEN；
4. 只在 GREEN 后重构，每步重跑；
5. 全部行为完成后运行项目级 `coverageCheck`。

`prd-to-json` 会让你一次确认完整政策，再真实跑基线。默认建议是：新项目行覆盖率和分支
覆盖率都不低于 90%；存量项目总体行/分支不低于启用基线，新增或改动的可执行行不低于
90%；两类都必须让零测试失败。项目可以采用其他政策，但必须在启用前由人明确批准。

运行中不要直接降低阈值、扩大排除、允许零测试、重算政策摘要或新增覆盖忽略标记。确实
需要变更时，先停止引擎，修改并验证项目政策，再由 `prd-to-json` 重新确认和派生。

三个信任层不要混淆：

- skill 约束过程，但 RED/GREEN 记录仍是 agent 声明；
- Codex、Claude Code 由插件 hook 提前反馈；Cursor 由显式安装的项目级检查提前反馈。它们都
  可能因非标准提交路径、宿主设置或缺失配置而未触发；
- coding-x 引擎每轮独立重跑，才拥有当前 story 的机械裁决权。

即使引擎通过，也只能说明受保护命令在当时返回成功。coverage 工具和仓库与 agent 同权限，
不能防住恶意伪造；覆盖率也不能替代 Validator 按 AC 验证和最终人审。首版不使用 AI
判断“测试真假”，后续如需加强应另行引入变异测试。

#### 可选进阶：模型路由

模型路由不是启动 coding-x 的前置条件。新手可以在 `prd-to-json` 询问时选择“不启用”，这时不生成 `models`、`difficulty` 和 `difficultyReason`，引擎直接使用 runner 默认模型。

> **0.24.0 模型目录迁移：** coding-x 不再调用 Claude Code、Codex 或 Cursor 查询模型。模型候选统一来自用户维护的全局模型目录；`models` 缺失、没有任何模型 CLI 覆盖时仍是合法零配置，直接使用 runner 默认模型。存在待执行 story，并且（PRD 启用模型路由或本次传入任一模型 CLI 覆盖）时，所需 ID 必须已在目录中声明；已收敛 workspace 跳过目录读取。`prd.json.models` schema 不变，v0.23 已有项目只需先登记原五项 ID，无需迁移项目文件。

全局配置默认位于 `~/.config/coding-x/config.json`，可用 `CODING_X_CONFIG` 覆盖为另一个完整文件路径。version 1 的示例结构如下；`config init` 创建的真实空模板是 `{ "version": 1, "models": {} }`。runner 可以只配置一部分，`label` 可省略，数组顺序就是展示顺序：

```json
{
  "version": 1,
  "models": {
    "claude": [
      { "id": "sonnet", "label": "Sonnet" }
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

目录表达的是“用户允许 coding-x 选择或传给该 runner 的模型 ID”，**不是模型在当前账号、provider、配额和网络下实时可用的证明**。coding-x 不把账号、密钥、base URL、中转站或 runner 配置写入该文件；真实可用性只会在实际 agent 调用时体现。

`prd-to-json` 在用户选择 runner 后调用 `coding-x models <runner> --json` **只读该目录**，将候选展示一次，再让用户分别选择 low/medium/high builder、validator 和 escalation。目录缺失或非法时可先维护配置后重试，也可明确不启用模型路由并继续普通转换；不能用会话内临时 ID 绕过。

### 第 2 步：运行引擎

先确认终端当前目录是目标项目根目录。新项目第一次接入时，先确认候选命令、Spec 和工程标准，
再建立质量契约与远端规则：

```bash
npx coding-x quality init
npx coding-x quality doctor --remote
```

首次运行通常会先生成文件并返回 `unverifiable`：把这些文件经 PR 合并到默认分支后，再运行一次
`quality init`，它回读确认可信工作流已经存在，才会启用远端规则，避免先锁住仓库却没有检查可跑。初始化还会在保留现有内容的前提下补齐 `.workspace/` 的 Git 忽略规则；`quality doctor` 会确认这条规则已经纳入版本管理，且没有本地反馈误入索引。
定时远端巡检优先读取仓库 secret `CODING_X_ADMIN_TOKEN`；没有具备 ruleset 只读权限的凭据时会
明确失败，不把 GitHub 的权限不足当成健康。只有本地文件、工作流和 GitHub 真实规则都核验通过，
项目才进入可交付状态。随后运行引擎：

```bash
npx coding-x doctor
npx coding-x codex      # 使用 Codex；也可以换成 claude 或 cursor
```

启动后会依次发生：引擎获取 `.workspace/engine.lock` → 读取/初始化状态 → 预检 runner 与模型 → 启动仪表盘 → 每轮启动一个 Builder → 运行机械门禁 → 启动一个 Validator → 引擎写入裁决 → 继续下一个 story。Builder 会按 PRD 的 `branchName` 检查、创建或切换功能分支，并按 story 提交代码。

可以按 `Ctrl+C` 中止后稍后重跑。已验证 story 会保留；如果进程停在“Builder 声称完成、Validator 尚未签发”之间，下次启动会把该 story 恢复为待复核。异常退出留下的 stale lock 会由下次运行判定接管，不需要日常手删。

下面是完整命令示例；第一次只需关心 `doctor`、一个 runner、`status` 和 `report`：

```bash
npx coding-x --help             # 显示完整命令与参数后退出，不读取 workspace 或启动 runner
npx coding-x                    # 默认 claude，max-iter 50
npx coding-x codex              # 改用 codex 后端
npx coding-x cursor             # 改用 Cursor Agent 后端
npx coding-x --max-iter 20      # 最多 20 轮迭代
npx coding-x config path        # 输出实际使用的全局配置绝对路径
npx coding-x config init        # 排他创建 version 1 空模板（已存在时不覆盖）
npx coding-x config validate    # 只读校验全局配置
npx coding-x models codex --json  # 从全局配置列出声明给 Codex 的模型
npx coding-x hooks cursor install # 安装或安全更新当前项目的 Cursor TDD 提交前检查
npx coding-x hooks cursor status  # 只读检查 Cursor 项目配置、脚本和安装记录
npx coding-x hooks cursor remove  # 只移除 coding-x 管理的 Cursor 项目内容
npx coding-x quality init          # 预览并确认质量契约、GitHub 工作流和远端 ruleset
npx coding-x quality review codex  # 在本地对当前提交运行隔离的三轴只读评审
npx coding-x quality doctor --remote # 回读本地契约、工作流和 GitHub 真实规则
npx coding-x --builder-model model-a --validator-model model-d  # 临时覆盖初始 builder / validator
npx coding-x --escalation-model model-e  # 临时覆盖升级 builder 模型
npx coding-x --no-open          # 不自动打开浏览器
npx coding-x --workspace ./run  # 指定 prd.json / state.json / progress.md 所在目录
npx coding-x --keep-open        # 跑完后保留仪表盘，按 Ctrl+C 退出（退出码不变）
npx coding-x --stall-limit 5    # 连续无进展轮（空转/超时/异常退出）达 5 次才熔断（缺省 3）
npx coding-x repair             # 修复 .workspace/ 下的 prd.json 与 state.json（不跑循环）
npx coding-x dashboard          # 不跑循环，随时离线回看仪表盘
npx coding-x status             # 终端一屏速览工作区执行状态（退出码 0/1/2 可作 CI 门禁）
npx coding-x status --json      # 同上，stdout 输出单个 JSON 对象供脚本与 agent 消费
npx coding-x doctor             # docs/、workspace Git 隔离等健康检查（硬错误以退出码 1 结束）
npx coding-x doctor --stale-days 14  # 新鲜度阈值改为 14 天（缺省 30）
npx coding-x report             # 手动（重）生成 .workspace/report.html；state 损坏时产出红色诊断报告并退出 1
```

### 第 3 步：查看实时进度

浏览器打开（默认自动弹出）：<http://localhost:7331>（像素风视图 `/p`）。仪表盘展示迭代次数、当前阶段、story 难度/升级态、完整配置映射，以及当前阶段实际命中的模型与路由来源（CLI/难度/升级/默认）。

- **只想快速知道完成了多少**：`npx coding-x status`。
- **引擎没在运行但想看仪表盘**：`npx coding-x dashboard`，看完按 `Ctrl+C`。
- **需要逐条 AC、截图、门禁、调用和红旗证据**：打开 `.workspace/report.html`；review 回填后运行 `npx coding-x report` 刷新。
- **不要只看 `passes=true`**：story 真正有效通过必须同时满足 `blocked=false`、`passes=true` 和 `validated=true`。

### 第 4 步：审查与 PR 门禁

循环全部 story 通过后，运行 `/review-loop`。它会准备四段式意图并调用
`coding-x quality review`，在彼此隔离的只读上下文中分别检查：

1. **Spec**：改动是否符合意图、验收标准和非目标。
2. **工程标准**：正确性、安全、边界、测试质量和维护成本。
3. **深度结构**：只在公开接口、状态、并发、安全、发布、跨模块、大改动或超大文件等风险
   出现时运行。

本地结果写入 `.workspace/quality/`，只用于提前反馈。修复产生新提交后，旧结果失效，必须重跑。
`critical/high` 不能延期；只有质量契约明确列出的严重度可延期，默认仅 `medium`。
`.coding-x/exceptions.json` 中的责任人、原因、期限和后续事项必须完整且未过期。管理员紧急
绕过远端规则时，还必须记录提交、审计链接和后续事项；未关闭记录始终显示为“异常交付”，
不会伪装成正常通过。

真正的合并控制发生在 GitHub PR：可信默认分支工作流会对最新 head 独立重跑项目检查、Spec、
工程标准和深度评审。缺 Spec、模型不可用、输出损坏、提交变化或规则漂移都显示为
`unverifiable` 并阻断。AI 任务只通过 API 读取 PR 数据，不签出或执行 PR 代码；项目命令在
没有模型、写权限或持久化凭据的隔离 job 中运行。命令不会自动合并、发布或替人批准例外。

### 第 5 步：收口沉淀（可选）

推荐在分支合并后、推送或发布前，回到 Claude Code 等工具运行 `/compound-docs`。它基于**当前代码优先**，再与 Git、`progress.md`、本轮 PRD 交叉取证，把仍成立的结构变化、稳定约定和高频陷阱分层沉淀进 `docs/`；过程故事、一次性事故和已经失效的说法不会被当成长期知识。

默认只处理本轮影响范围，并执行 active 知识的增量熵 GC、任务文档状态收尾和取舍账本汇总：

- 明确说“全量 GC”才逐条审计全部 patterns/glossary/architecture/golden-principles/prompt-writing。
- 明确说“物理归档”，或在它展示候选后再次确认，才移动 `done/superseded` 的 PRD、plan、spec 等到 `docs/archive/`。
- 它只允许修改文档，不会顺手修代码；证据不足时允许零修改或列为待拍板。

### 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 位置参数 `help` / `-h, --help` | — | 输出完整用法并退出 0；可放在子命令后（如 `config --help`），不读取 workspace、不获取锁、不启动 runner/dashboard |
| 位置参数 `claude` / `codex` / `cursor` | — | 显式选择 runner；若 PRD 启用了模型路由，必须与 `models.runner` 一致。未显式指定时优先用 `models.runner`，否则默认 claude |
| 位置参数 `config path\|init\|validate` | — | 查看全局配置路径、排他创建空模板或只读严格校验；均不启动 runner，不获取 workspace 锁 |
| 位置参数 `models [claude\|codex\|cursor]` | — | 只读查询全局模型目录；不启动 runner、不检查认证、不访问网络；可配 `--json` |
| 位置参数 `hooks cursor install\|status\|remove` | — | 在当前 Git 项目安全安装、只读检查或卸载 Cursor TDD 提交前检查；只管理 `.cursor/` 中 coding-x 拥有的内容，不改 Git hooks、索引或提交。install/remove 成功与 status 健康返回 0；缺失、冲突或过期返回 1 |
| 位置参数 `quality init` | — | 发现并展示候选项目命令与来源；确认后生成 `.coding-x/`、PR 模板和受管工作流，并确保 `.workspace/` 被受 Git 管理的规则忽略。默认分支回读到同一受管版本后，第二阶段才配置 GitHub ruleset 并回读；`--local-only` 明确不配置远端，结果为 unverifiable |
| 位置参数 `quality review [runner]` | — | 需要 `--intent-file`；对已提交且干净的当前 head 运行本地 Spec、工程标准和风险触发的深度评审。只写 workspace 反馈 |
| 位置参数 `quality gate` | — | GitHub 无交互入口；`--checks` 运行可信 base 契约中的项目命令，`--axis` 运行一条远端评审，结果绑定精确 base/head |
| 位置参数 `quality doctor` | — | 检查契约、异常记录和受管文件；加 `--remote` 后回读仓库身份、规则集、required checks、检查来源和人员审核数 |
| 位置参数 `repair` | — | 修复 `<workspace>/` 下的 prd.json 与 state.json 后退出；引擎运行中（engine.lock 活锁）时以退出码 2 拒绝 |
| 位置参数 `dashboard` | — | 不跑循环，仅启动仪表盘离线查看 workspace 状态；state 文件缺失兼容旧格式，存在但损坏时全部按未验证显示并警告 |
| 位置参数 `doctor` | — | `docs/` 知识库健康检查（frontmatter、`updated`、AGENTS.md 索引、相对链接；`docs/archive/` 仍查结构/链接但跳过新鲜度）、机械门禁、全局模型目录/PRD 映射与 workspace Git 隔离核对；未忽略/已跟踪只建议且不自动改仓库，硬错误以退出码 1 结束 |
| 位置参数 `status` | — | 终端速览 story 状态/重试/仲裁、实际模型路由和最近 validation target/protocol/error；损坏 state 全部按未验证，`--json` 增加 `recentValidation` 并标 `stateCorrupted`；退出码 0=全通过 / 1=未全通过或 state 损坏 / 2=无可读工作区 |
| 位置参数 `report` | — | （重）生成 `<workspace>/report.html` 静态实现验证报告（story+AC、门禁、分源 Validator claim/engine 裁决、截图、本地质量反馈、篡改红旗），并明确不证明 GitHub 交付就绪；退出码 0=可信状态下已生成 / 1=写入失败或 state 损坏 / 2=无可读工作区 |
| `--max-iter <n>` | `50` | 最大迭代轮数 |
| `--dev-timeout <分钟>` | `30` | 单轮开发阶段超时（分钟） |
| `--val-timeout <分钟>` | `60` | 单轮验证阶段超时（分钟） |
| `--builder-model <id>` | — | 本次运行的初始 builder 覆盖；优先于 `models.builder[story.difficulty]`，但不压过已触发的专用 escalation 路由 |
| `--validator-model <id>` | — | 本次运行的 validator 覆盖；优先于 `models.validator` |
| `--escalation-model <id>` | — | 本次运行的升级 builder 覆盖；仅在 `state.escalated=true` 时生效，优先于 `models.escalation` |
| `--workspace <dir>` | `.workspace` | `prd.json` / `state.json` / `progress.md` / `evidence.jsonl` 与瞬时 validation result 所在目录；`doctor` 用它定位 prd.json，并检查门禁、项目模型映射与 Git 隔离 |
| `--no-open` | 关闭 | 不在启动时自动打开浏览器 |
| `--keep-open` | 关闭 | 运行结束后保留仪表盘直到 Ctrl+C（保留循环的真实退出码） |
| `--port <n>` | `7331` | 仪表盘端口 |
| `--stall-limit <n>` | `3` | 仅 `run`（位置参数 `codex` 同属 `run`，同样适用）：连续无进展轮（no-op 空转、builder/validator 超时或异常退出）达到 n 次即提前终止（退出码 1），避免无人值守时死循环空跑；必须是正整数 |
| `--stale-days <n>` | `30` | 仅 `doctor`：active 区文件的 git 最后提交日期晚于 frontmatter `updated` 超过 n 天判为过期；`0` 表示晚一天即过期，`docs/archive/` 冷档案不参与 |
| `--json` | 关闭 | `status`/`models`/所有 `quality` 命令输出单个 JSON 对象；质量状态只有 passed、failed、unverifiable |

### 退出码

默认命令（`run`，即无 `repair`/`dashboard`/`doctor`/`status`/`report`/`models`/`config` 位置参数时；位置参数 `claude`/`codex`/`cursor` 只切换 runner，仍属 `run`，退出码规则相同）循环结束的进程退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部 story 通过（`passes && validated`），且无 `blocked` |
| `1` | 跑满 `--max-iter` 仍未全部收敛；或连续无进展轮（no-op 空转、builder/validator 超时或异常退出）达到 `--stall-limit` 提前熔断 |
| `2` | workspace 锁（`engine.lock`）被占用，本次 `run`/`repair` 直接拒绝（ADR-008） |
| `3` | 全部 story 已收敛（`passes && validated`，或 `blocked`），但存在 `blocked` story 待人工处理 |

`quality` 命令统一使用 0=passed、1=failed、2=unverifiable；其他子命令的语义见上方参数表。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `CODING_X_CONFIG` | 覆盖全局模型配置的完整文件路径；相对路径按当前目录解析，空白值按未设置处理 |
| `CODING_X_CLAUDE_BIN` | 覆盖 `claude` 可执行文件路径 |
| `CODING_X_CODEX_BIN` | 覆盖 `codex` 可执行文件路径 |
| `CODING_X_CURSOR_BIN` | 覆盖 Cursor `agent` / `cursor-agent` 可执行文件路径 |

---

## Commands 与 Skills 生命周期

先区分两类入口：

- **Command**：你显式输入 `/命令`，启动一套有固定步骤的工作流。
- **Skill**：你用自然语言表达意图后，AI 工具按语境选用；为了避免误触发，也可以直接说出 skill 名和目标文件。

它们负责准备、检查和收口，**不会因为生成了 PRD 就自动启动引擎**。真正开始无人值守 Developer/Validator 循环的入口始终是终端里的 `npx coding-x`。

### Commands（用户显式触发）

| 命令 | 何时使用 / 输入 | 会读取什么 | 会产出或修改什么 | 生命周期与下一步 |
| --- | --- | --- | --- | --- |
| `/priming` | 新会话开始、AI 不了解项目时；无需参数 | Git 文件/状态/近期提交、README/AGENTS/docs、配置和关键源码 | 只在当前对话输出项目概览，默认不落盘、不改代码 | 会话级临时上下文；换会话可重跑，完成后继续需求对齐或任务处理 |
| `/init-docs` | 一个仓库第一次建立 AI 知识入口时 | 项目形态、配置、目录、技术栈；monorepo 候选需人确认 | 创建缺失文档；确认项目检查和来源后调用 `quality init` 建立受管交付门禁 | 新项目默认入口；远端 bootstrap 与 doctor 回读完成前保持 unverifiable |
| `/planning <功能描述>` | 编码前需要完整技术路线时；输入可为原始需求或 align/tech 对齐稿 | 项目文档、相关代码/测试、官方资料和黄金原则 | `docs/plans/<feature>.md`，含任务顺序、风险、验证命令和原则对照；不写代码 | 初始 `active`；供人/agent 实施和 review 定位，合并后置 `done`，可显式归档；不替代正式 PRD |
| `/review-loop` | 引擎循环结束、创建 PR 前 | 当前提交 diff、四段式意图、受 Git 管理的质量契约与来源 | 调用统一 `quality review`；输出 `.workspace/quality/` 本地反馈，不改业务代码 | 三轴各用只读上下文；新提交使旧结果失效；最终仍由 GitHub PR 独立重跑并阻断 |
| `/compound-docs` | 功能分支/引擎轮次收口，推荐合并后、推送前 | 当前代码（最高事实）、Git、progress、PRD 范围和 active 文档 | 只修改文档：沉淀、增量熵 GC、状态收尾、取舍账本；物理归档需明确授权 | 默认只处理本轮；“全量 GC”才全库审计；完成后长期知识继续 active，任务文档可 done/superseded → archive |

### Skills（按语境使用）

| Skill | 何时触发 / 输入 | 主要产出 | 人需要确认什么 | 生命周期与下一步 |
| --- | --- | --- | --- | --- |
| `scenario-alignment` | 输入杂乱、业务边界未定；说“`align: ...`”或“场景对齐” | `docs/prds/align-<feature>.md`：不含技术方案的目标、范围、场景、验收口径 | 默认 1–3 个真正影响产品方向的问题；每题有推荐；可要求逐题深挖 | 一次性输入材料；口径确认后交给 technical-alignment（若需要）或 prd-generate；正式 PRD 吸收后置 `superseded` |
| `technical-alignment` | 业务已清楚，且涉及持久化/接口/状态机/权限/迁移等昂贵合同；说“`tech: ...`” | `docs/prds/tech-<feature>.md`：可验证技术合同和不可逆项 | 少数高代价、难回滚的技术选择；不会替人决定业务口径 | 一次性输入材料；与 align 一起交给 prd-generate，吸收后置 `superseded`；长期技术事实以后由 `/compound-docs` 沉淀 |
| `prd-generate` | 要把清楚需求或 align/tech 材料变成正式需求；说“创建一个 PRD”并给路径 | `docs/prds/prd-<feature>.md`：Goals、Non-Goals、稳定 story ID、可验证 AC 等 | 无前置对齐稿时回答 3–5 个查证不了的关键问题；逐条审阅 story 和 AC | 正式**意图真相源**；初始 `active`，交给 prd-to-json；合并交付后 `done`，需求演进时改回 `active` |
| `prd-to-json` | 正式 PRD 已确认、准备运行；说“将 `<PRD 路径>` 转成 prd.json” | 回写源 PRD 最终 User Stories；生成/更新 `.workspace/prd.json`、progress 和必要的归档/状态调整；输出转换对照表 | workspace 隔离异常、门禁命令、是否启用模型路由及模型选择、story/AC 增强差异 | 每次需求变更都从源 PRD 重跑；同功能按 ID 保留/重置状态，不同功能先归档旧 workspace；完成后先 `doctor` 再启动引擎 |
| `tdd` | 用户要求 TDD、测试先行、红绿重构或用回归测试修复缺陷；coding-x 启用 TDD 时 Builder 自动引用 | 每个公共行为的真实 RED→同命令 GREEN→绿色重构过程，以及最终 coverageCheck 结局 | 交互模式确认公共接口、行为顺序和覆盖政策；coding-x 模式沿用已批准 AC；Cursor 项目检查需显式安装 | 开发行为能力，不另建 TDD 政策文件；宿主只提前反馈、引擎独立重跑，不能把过程记录称为证明 |
| `agent-browser` | 需要真实浏览器导航、点击、填表、截图、数据提取或 UI 验收时 | 浏览器操作结果；引擎角色按规范可把最终截图放 `.workspace/screenshots/` 并登记 evidence | 登录、支付、删除等敏感操作仍需按任务授权；核对页面、动作和可观察结果 | 操作型能力，不生成长期需求文档；用完关闭会话。skill 说明不等于已安装二进制，引擎会用 `which agent-browser` 探测 PATH |

不同宿主对“自动选择 skill”的体验可能不同；最稳妥的说法是“使用 `prd-to-json` 将这个文件转换……”。commands/skills 通常沿用当前会话；需要真正独立复核时，由人手动新开会话。

---

## 引擎功能清单

### 引擎（`npx coding-x`）

- **双层质量门禁**：`.coding-x/quality.json` 用项目自己的命令描述检查，不要求下游采用 npm、TypeScript 或 Vitest；GitHub PR 对最新提交独立运行项目检查、Spec、工程标准和风险触发的深度结构评审，规则缺失或无法验证时 fail closed。
- **远端规则配置与漂移检查**：`quality init` 先确认默认分支已有同一受管版本，再应用并回读 GitHub ruleset；要求 PR、最新检查、对话解决、禁止强推/删除，并绑定 GitHub Actions 来源。`quality doctor --remote` 定期发现规则关闭、替换、异常交付未关闭或延期过期；管理员权限仍是平台边界。
- **Developer → Validator 双 agent 循环**：开发方实现单个 story 并提交，验收方独立逐条核对验收标准。
- **引擎验收凭证 + 可信目标绑定**：`passes=true` 只是 builder 候选；引擎向 Validator 注入 request ID/story/AC hash/Git HEAD，严格消费逐 AC claim，确认 schema、绑定、产物和 state 不变式后才写 verdict 或签发 `validated=true`（ADR-013、015）。
- **Agent 调用凭证**：每次真实 Builder/Validator 子进程都记录 outcome、退出码与调用收口耗时；异常 stdout/stderr 尾部有界进入 evidence/status/report，成功 transcript 不落盘。它是引擎观察，不是 provider 账单或执行证明（ADR-016）。
- **自动重试与阻塞保护**：同一 story 验证失败累计 5 次后自动 `blocked` 跳过，避免卡死。
- **空转检测与 stall 熔断**：builder 结束但 `state.json`/`progress.md` 均无变化（no-op）时跳过门禁与验收，省一次验证方调用；no-op、超时、异常退出累计达 `--stall-limit`（缺省 3）连续无进展轮即提前终止（退出码 1）——已全部完成的工作区不受影响，完成判定优先于熔断计数。
- **机械门禁（qualityChecks）**：引擎在 Developer 与 Validator 之间确定性执行项目质量检查（`prd.json` 顶层配置），失败机械打回并跳过该轮验证；超时会终止并确认整棵门禁进程树退出后才进入下一轮——LLM 验证链之下不可共谋、不可绕过的确定性防线。
- **TDD 工作流与门禁**：共享 skill 约束逐行为红绿重构；Codex/Claude 插件 hook 与 Cursor 项目级检查在 agent commit 前提前反馈；引擎在 Validator 前独立校验政策并运行项目原生覆盖命令。非法配置启动前拒绝，运行期失败打回并写入单独证据与报告历史（ADR-017）。
- **workspace 写入避让与 Git 隔离检查**：builder 只 stage/commit story 文件并在提交后回写运行时状态；`prd-to-json` 双次检查活跃工作区锁、写前阻止静默污染，`doctor` 只读报告锁与 Git 隔离状态，不替用户删锁或改索引。
- **按难度的模型路由**：`models.runner` 绑定一个 runner，`builder.low/medium/high` 按 story `difficulty` 选初始模型，validator 恒定。首次机械门禁打回、引擎接受 Validator 的 failed claim 或 completed no-op 后，引擎置 `state.escalated=true`，下轮使用专用 escalation；超时、非零退出、认证/网络异常不会用更贵模型掩盖环境故障。启动前严格校验 schema、runner，并确认本次可能调用的 ID 已在全局模型目录声明；目录不承诺 provider 实时可用。CLI 覆盖只影响单次运行，不改写 PRD；存在待执行 story 时同样必须在目录中声明。
- **完成判定分层**：全部 story 有效通过只代表“实现已验证”；交付就绪必须另看 GitHub PR 最新提交的必需检查。无 blocked 的引擎循环仍退出 0，存在 blocked 退出 3。
- **三种 agent runner**：`claude`（历史默认）、`codex` 与 `cursor`，均以跳过权限确认模式运行，启动前打印警告。
- **超时控制**：开发/验证阶段各有独立超时。
- **实时 Web 仪表盘**：默认 `http://localhost:7331`，含普通视图与像素风视图（`/p`），启动时默认自动打开浏览器。`--keep-open` 让跑完后面板继续可看；`npx coding-x dashboard` 随时离线回看；服务停止后页面冻结最后状态并显示「运行已结束」横幅。
- **静态验证报告**：循环结束从 PRD guard 的最终冻结快照自动生成 `.workspace/report.html`，手动 `npx coding-x report` 读取当前磁盘 PRD。报告把 `source=validator` 的逐 AC claim 与 `source=engine` 的目标/协议/receipt 分开，时间线可恢复 Agent 调用耗时、退出码和异常尾部，协议错误和 Validator 改 state 进入红旗；同时汇总 story、门禁、截图、人审与篡改。state 损坏时全部未验证；报告原子覆盖，截图分享需连同 `screenshots/`。
- **JSON 修复**：`npx coding-x repair` 用 `jsonrepair` 修复被 agent 写坏的 `prd.json` / `state.json`。
- **可配置工作区**：`--workspace` 指定文件目录，指令用 `{{WORKSPACE}}` 占位符注入。

---

## 目标项目中会出现什么

接入 coding-x 后，一个典型目标项目会多出这些内容：

```text
my-project/
├── AGENTS.md                         # 所有 agent 共用的短索引和硬约束，应进 Git
├── CLAUDE.md                         # Claude Code 到 AGENTS.md 的薄桥接，应进 Git
├── docs/                             # 长期项目知识和任务文档，应进 Git
│   ├── architecture.md
│   ├── golden-principles.md
│   ├── patterns.md
│   ├── glossary.md
│   ├── decisions/
│   ├── plans/
│   ├── prds/
│   └── archive/                      # 只有首次真实物理归档后才出现
├── .coding-x/                        # 受 Git 管理的质量政策
│   ├── quality.json                  # 项目命令、评审来源、风险触发器和远端要求
│   └── exceptions.json               # 普通延期与带提交/审计链接的异常交付记录
├── .github/                          # 受 Git 管理的 GitHub 门禁
│   ├── workflows/
│   │   ├── coding-x-review.yml
│   │   ├── coding-x-project-checks.yml
│   │   └── coding-x-doctor.yml
│   └── pull_request_template.md
├── .workspace/                       # 当前/历史运行状态，默认不进 Git
│   ├── prd.json
│   ├── state.json
│   ├── progress.md
│   ├── evidence.jsonl
│   ├── screenshots/
│   ├── quality/
│   │   ├── receipts.jsonl
│   │   └── review-latest.md
│   ├── report.html
│   └── archive/
├── .cursor/                          # 仅显式安装 Cursor TDD 检查后出现；是否进 Git 由使用者决定
│   ├── hooks.json
│   └── coding-x/
│       ├── tdd-commit-check.mjs
│       └── install.json
└── <项目原有源码、测试和配置>
```

请把 `docs/archive/` 和 `.workspace/archive/` 分开理解：前者是进入 Git 的历史文档，后者是被 Git 忽略的旧运行快照。目标项目自身如果已有 `dist/`，它通常仍是该项目的构建产物，与 coding-x 的 workspace 无关。

---

## 常见情况与处理办法

| 现象 | 先看哪里 | 正确动作 |
| --- | --- | --- |
| 找不到 `/init-docs`、`/planning` 等命令 | 插件是否加载、当前 AI 工具是否支持 commands、是否在目标项目会话 | 重新加载插件或按宿主的插件方式指向 coding-x 仓库；不要在目标项目里复制一份 command 内容 |
| `prd-to-json` 说 `.workspace/` 未忽略或已有文件被 Git 跟踪 | `npx coding-x doctor`、`.gitignore`、`git ls-files .workspace` | 先决定是否修正 Git 隔离；skill 不会自动改 `.gitignore` 或执行 `git rm --cached` |
| `doctor` 发现 qualityChecks 基线失败 | 直接运行它列出的 typecheck/lint/test | 先修复项目原有失败或重新确认门禁，基线全绿后再跑引擎 |
| `doctor` 报 TDD 配置非法、基线不可达或政策摘要变化 | `.workspace/prd.json` 的 `tdd`、对应政策文件、当前 Git 根 | 不要直接重算摘要；停止运行，由 `prd-to-json` 重新确认政策、跑真实基线并派生 |
| agent 执行 `git commit` 被 TDD hook 阻断 | hook 的有限错误摘要、手工运行 `coverageCheck` | 修测试、实现或政策漂移后重跑；不要关闭 hook 规避。即使绕过，coding-x 引擎仍会独立打回 |
| Cursor 没有提前检查，或 `hooks cursor status` 报缺失/过期 | 项目根的 `.cursor/hooks.json`、`.cursor/coding-x/`、status 输出 | 在 Git 项目根运行 `npx coding-x hooks cursor install`，升级 coding-x 后也重跑；若报冲突，先人工处理被修改或不合法的文件，不要强行覆盖 |
| Cursor 插件已装但 `npx coding-x cursor` 找不到命令 | `agent --version`（旧安装可试 `cursor-agent --version`）、登录状态、`CODING_X_CURSOR_BIN` | 单独安装 Cursor Agent CLI；桌面应用不能替代。coding-x 自动识别两种命令名，自定义路径再设置环境变量 |
| 报“找不到 prd.json” | `.workspace/prd.json` 是否存在、`--workspace` 是否一致 | 用 `prd-to-json` 从正式 PRD 生成；不要手工拼一个不完整 JSON |
| 启动时提示缺少质量契约 | 根目录 `.coding-x/quality.json` 与 `quality init` 预览 | 先确认项目原生检查、Spec/标准来源并完成初始化；不要用空命令绕过 |
| `quality init/doctor --remote` 返回 unverifiable | GitHub token 权限、默认分支是否已有 Actions Check Run、ruleset 回读错误 | 先提交受管 workflow 并触发一次 Actions，再重跑远端配置；权限不足或漂移不能当作通过 |
| PR 的 Spec/工程标准/深度检查失败 | 对应 Check Run 的 finding、PR 四段意图、当前 head | 修复或补齐资料后提交新 head，让三轴全部重跑；不要复制旧报告或创建同名文本标记 |
| 退出码 `2`，提示 `engine.lock` 被占用 | 是否已有 `coding-x` 或 `repair` 在运行 | 有活进程就等待/停止它；异常 stale 锁让下次引擎接管，不要把删锁当常规解决方案 |
| `state.json` 或 `prd.json` JSON 损坏 | `status`/`report` 的保守警告 | 确认无活锁后运行 `npx coding-x repair`；repair 只修 JSON 结构，不会替你解决业务失败 |
| 退出码 `1`：达到最大轮次或 stall 熔断 | `npx coding-x status`、终端异常尾部、`report.html` 时间线 | 区分代码失败、runner 认证/网络、超时和空转；处理根因后重跑，已有有效状态会续跑 |
| 退出码 `3` 或 story `blocked` | `state.json` 对应 story 的 notes、报告红旗和仲裁标签 | 人决定改需求、修环境还是重试；需求/AC 有问题就改源 PRD、再运行 `prd-to-json`，然后重跑引擎 |
| 运行中途需求改变 | 源 `docs/prds/prd-*.md` | 先停止引擎；修改源 PRD 并重新转换。AC 变化的 story 会重验，旧证据会先归档 |
| UI story 没有浏览器证据 | PATH 中是否有 `agent-browser`、`.workspace/screenshots/`、报告截图对账 | 安装/提供浏览器工具后真实操作；AC 要写明 URL、动作、期望结果，不能只写“页面正常” |
| 仪表盘端口 7331 被占用 | 终端端口错误 | 使用 `npx coding-x --port 7332`；离线 dashboard 也可带同一参数 |
| `/review-loop` 后报告仍显示旧反馈 | `.workspace/report.html` 的生成时间、`.workspace/quality/` 最新 receipt | 运行 `npx coding-x report` 刷新；这仍不是 GitHub 交付通过凭证 |
| 要开始另一个功能 | 新旧 `branchName`、旧 `progress.md` | 重新执行 `prd-to-json`；它会把旧运行复制进 `.workspace/archive/`，再清理会污染新轮的状态/证据 |
| 所有 story 已通过 | `status`、report、当前 Git diff | 这只代表实现已验证；先做本地反馈，再让 PR 最新提交通过四项远端门禁 |

### 不要这样做

- 不要直接把 `.workspace/prd.json` 当需求文档长期维护；改源 PRD，再派生。
- 不要为了“让进度变绿”手改 `state.json` 的 `passes`、`validated`、`blocked` 或 `retryCount`。
- 不要提交 `.workspace/`；它含本地状态、诊断、截图，可能还有敏感信息。
- 不要把 `.workspace/` 当纯缓存整目录删除；需要换任务时先按规则归档。
- 不要只看 Builder 的提交说明、`progress.md` 或 `passes=true` 就认定完成。
- 不要复用旧 head 的 review；任何新提交都会让旧结论失效。
- 不要用 PR 文本、评论或本地报告冒充 required check。
- 不要让 `AGENTS.md` 变成长手册；它是入口，细节应放进 `docs/`。

---

## 常用术语

| 术语 | 给新手的解释 |
| --- | --- |
| **harness** | 控制 AI 工作顺序、重试、超时、状态和验收的程序外壳；coding-x 的引擎就是 harness |
| **runner** | 被引擎实际调用的 AI CLI：Claude Code、Codex 或 Cursor Agent |
| **User Story** | 一小块可独立实现、独立验收的用户价值，编号如 `US-001` |
| **AC / acceptance criteria** | “什么现象出现才算完成”的可验证清单；不是“写了某个函数”这种实现描述 |
| **Builder / Developer** | 实现单个 story 的角色；`passes=true` 只是它的候选声明 |
| **Validator** | 独立逐条检查 AC 的角色；它提交 claim，最终状态仍由引擎裁决 |
| **机械门禁** | 由程序直接执行的 typecheck/lint/test 命令，失败就打回，不依赖模型自述 |
| **TDD 循环** | 对一个行为完成真实 RED、同命令 GREEN、再绿色重构；过程记录可复核但不是机器证明 |
| **TDD 门禁** | 引擎在 Validator 前校验冻结政策并独立运行覆盖命令；宿主 hook 只是提前反馈 |
| **workspace** | `.workspace/` 本地执行工作台，保存需求派生物、状态、证据和报告 |
| **源 PRD** | `docs/prds/prd-*.md`，人维护的正式意图真相源；需求变化改这里 |
| **blocked** | story 已达到失败上限或需要人工介入，引擎暂时跳过，等待人处理 |
| **假绿** | 状态看似通过，但 AC 实际没完成或证据没有验证目标；机械门禁、目标绑定和 review 都在降低它 |
| **验收凭证** | 引擎在目标、协议、状态和 Validator 结果都满足约束后写入的 `validated=true` |
| **dogfood** | 用 coding-x 真实运行 coding-x 或固定测试项目，以实际使用发现问题；普通目标项目使用者无需维护 dogfood fixture |

---

## coding-x 源码目录说明（维护者参考）

下面是 coding-x 工具仓库自身的结构，不是要求每个目标项目都照搬。skill / command 内容在整个仓库里**只存一份**，各工具用一个瘦清单指回它，因此没有副本、无需同步、不会漂移。

```
coding-engine/
├── skills/                       # 唯一源：模型自主触发的能力
│   ├── scenario-alignment/SKILL.md
│   ├── technical-alignment/SKILL.md
│   ├── prd-generate/SKILL.md
│   ├── prd-to-json/SKILL.md
│   ├── tdd/SKILL.md
│   └── agent-browser/SKILL.md
├── hooks/                        # TDD 提交前检查的唯一脚本与 Codex/Claude 配置
│   ├── tdd-commit-check.mjs
│   └── hooks.json                # Codex / Claude Code
├── commands/                     # 唯一源：用户 /斜杠命令
│   ├── priming.md
│   ├── planning.md
│   ├── init-docs.md
│   ├── review-loop.md
│   └── compound-docs.md
├── templates/                    # /init-docs、/compound-docs 使用的知识库模板
│   ├── AGENTS-root.md            #   目录式根 AGENTS.md（四段式）
│   ├── AGENTS-sub.md             #   子项目薄 AGENTS.md
│   └── docs/                     #   architecture / golden-principles / patterns / glossary / decision / archive-README
├── AGENTS.md                     # 本仓库自己的目录式索引（/init-docs dogfood 产物）
├── CLAUDE.md                     # Claude Code 桥接：@AGENTS.md 导入（Claude Code 不读 AGENTS.md）
├── docs/                         # 本仓库 active 知识：architecture / principles / decisions / specs / plans / prds
│   ├── dogfood-regression.md     #   真实引擎运行的行为级回归断言
│   └── archive/                  #   完成态历史冷档案；日常实现/熵 GC 排除，doctor 仍查结构与链接
├── .coding-x-local/              # 仅维护者本机可能有：忽略的 dogfood/SDD 过程证据，不发布
│
├── .claude-plugin/               # Claude Code 插件清单
│   ├── plugin.json               #   插件元数据（commands/ skills/ 自动发现）
│   └── marketplace.json          #   marketplace 元数据
├── .cursor-plugin/plugin.json    # Cursor 瘦清单：只发现唯一源 commands / skills
├── .codex-plugin/plugin.json     # Codex 瘦清单
├── .agents/plugins/marketplace.json  # 通用 agent 清单：source 指向仓库根
│
├── assets/                       # 引擎专用静态资产（构建时拷进 dist/，工具不读）
│   ├── instructions/
│   │   ├── builder.md            #   Developer 指令（含 {{WORKSPACE}} 占位符）
│   │   └── validator.md          #   Validator 逐 AC 结构化 claim 指令
│   └── dashboard/
│       ├── dashboard.html        #   仪表盘普通视图
│       └── dashboard-p.html      #   仪表盘像素风视图
├── dist/                         # npm run build 生成的可发布包；删后可重新构建，不手改
│   └── hooks/tdd-commit-check.mjs # Cursor 安装器复制到目标项目的离线脚本
│
├── src/                          # TypeScript 引擎源码
│   ├── cli.ts                    #   命令行入口、参数解析
│   ├── cursor-hooks.ts           #   Cursor 项目检查的安全安装、状态与卸载
│   ├── engine/
│   │   ├── loop.ts               #   主循环：Developer ⇄ Validator
│   │   ├── agent.ts              #   runner 子进程、实时 tee、调用耗时/诊断与超时控制
│   │   ├── evidence.ts           #   evidence.jsonl schema、调用凭证、追加与读取
│   │   ├── fs-atomic.ts          #   关键 JSON 原子写（tmp+rename）
│   │   ├── gate.ts               #   机械门禁、打回与异常轮回写
│   │   ├── lock.ts               #   engine.lock 单写者互斥（pid 活性/stale 接管/轮首自愈）
│   │   ├── model-catalog.ts      #   全局模型目录路径、严格 schema、查询与初始化
│   │   ├── model-preflight.ts    #   runner/路由/CLI 覆盖与目录成员启动预检
│   │   ├── models.ts             #   PRD 模型路由 schema 与实际路由解析
│   │   ├── process-tree.ts        #   agent/门禁共享的跨平台进程树终止与退出确认
│   │   ├── prd-guard.ts          #   运行期 PRD 快照、篡改存档与恢复
│   │   ├── prd.ts                #   读取 prd.json（需求内容）
│   │   ├── state.ts              #   state.json 读写、验收凭证、选 story、完成判定、合并视图
│   │   ├── tdd-gate.ts           #   TDD 配置/政策完整性与项目覆盖命令门禁
│   │   ├── validation-protocol.ts #   Validator request/result、目标绑定与严格解析
│   │   ├── progress.ts           #   读取 progress.md
│   │   └── repair.ts             #   jsonrepair 修复 prd.json / state.json
│   ├── doctor/
│   │   └── doctor.ts             #   docs、门禁、模型目录与 workspace Git 隔离检查
│   ├── report/
│   │   ├── report.ts             #   验证报告收集、可信 PRD 来源与原子写盘
│   │   └── render.ts             #   验证报告 HTML 渲染（零浏览器 JS、全文本转义）
│   ├── status/
│   │   └── status.ts             #   workspace 状态、实际调用与最近结构化验收速览
│   └── dashboard/
│       └── server.ts             #   仪表盘 HTTP 服务 + 自动开浏览器
│
├── tsup.config.ts                # 打包配置（onSuccess 把 assets 拷进 dist/）
├── tsconfig.json / vitest.config.ts
├── package.json
└── LICENSE                       # MIT
```

**两条资产链路：**

- **面向工具**：`skills/`、`commands/` 和共同 hook 脚本都是唯一源；Codex/Claude 从插件读取 hook，Cursor 插件只提供 commands/skills，项目检查由用户显式安装。
- **面向引擎**：`assets/instructions`、`assets/dashboard` 和共同 hook 脚本由 `npm run build` 拷进 `dist/`；引擎读取指令与页面，Cursor 安装器从 `dist/hooks` 复制脚本。`package.json` 的 `files` 只发布 `dist`，源码资产不单独发布。

`dist/` 是构建产物，发布 npm 包前由 `npm run build` 产生，可以删除后重建；`.coding-x-local/` 是维护 coding-x 时留在本机的 dogfood/设计过程材料，不是 npm 包内容，也不是目标项目的 `.workspace/`。普通使用者不需要创建或维护它。

---

## 开发

```bash
npm install
npm run dev         # 用 tsx 直接运行 CLI
npm test            # Vitest 测试
npm run typecheck   # tsc --noEmit 类型检查
npm run build       # tsup 打包到 dist/
```

---

## 许可证

本项目基于 [MIT 许可证](./LICENSE) 开源。
