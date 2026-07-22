# coding-x

> Ralph 自动化 Coding 工作流 —— 把 **Developer → Validator** 循环固化成确定性程序的 harness。

coding-x 同时是两样东西：

- **TypeScript 引擎**（`npx coding-x`）—— 读取 `prd.json`，自动驱动 AI agent（Claude Code、Codex 或 Cursor）逐个 user story「开发 → 验证 → 提交」，直到全部完成，并提供实时 Web 仪表盘。
- **多工具插件** —— 提供 `scenario-alignment` / `technical-alignment` / `prd-generate` / `prd-to-json` / `agent-browser` skills 和 `/priming` `/planning` `/init-docs` `/review-loop` `/compound-docs` 命令，支持 Claude Code、Codex、Cursor 及通用 agent，帮你对齐业务口径与技术合同、把需求拆解成可自动执行的 `prd.json`、在合并前审查循环产物并留痕人审裁决，且为项目生成与持续沉淀 docs/ 知识库。

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

引擎在项目根目录启动，围绕工作区里的三份文件运转：`prd.json`（需求，运行期只读且被引擎冻结——启动时快照，运行中的磁盘修改会被自动恢复并存档为 `.workspace/prd.tampered-*.json` 供人审；改需求请停引擎 → 修订源 PRD → 重新派生 → 重跑）、`state.json`（执行状态，按 story id 键控；agent 回写结果字段，引擎独占验收凭证与升级状态）和 `progress.md`（进度与学习日志）。0.20.0 起叠加 `evidence.jsonl`（证据索引：引擎机械记录+agent 截图登记；失败门禁的输出尾部与 Validator 正常打回的 notes 会在下一轮覆盖前有界快照）。`prd.json` 是 `docs/prds/` 源 PRD 的派生物：md 是**意图真相源**（人写人审，需求变更改它），`prd.json` + `state.json` 是**执行真相源**（机器与 agent 读写）；需求冲突时以 md 为准重新派生（见 `docs/decisions/003-prd-layered-truth.md`）。旧版 workspace（状态写在 prd.json 里、无 state.json）在 v0.5.0 引擎首次运行时自动抽取迁移，无需手工处理；`state.json` 已存在但损坏时不是迁移信号，report/status/dashboard 会统一把所有 story 按未验证状态显示并提示 repair。

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
   │   ┌── Validator（validator.md）────────────────────────┐ │
   │   │ 1. 从 progress.md 找出刚完成的 story                │ │
   │   │ 2. 逐条核对 acceptanceCriteria                      │ │
   │   │ 3. 通过 → 保持 passes=true、清 notes、重试归零      │ │
   │   │    失败 → passes=false、写失败原因、retryCount+1     │ │
   │   │           （累计 5 次 → blocked=true 跳过）         │ │
   │   └────────────────────────────────────────────────────┘ │
   │                          ↓                               │
   │   引擎：Validator 正常完成且仍通过 → validated=true     │
   │   所有 story 都 passes&&validated 或 blocked ?          │
   │                                  是 ──▶ 成功退出         │
   │                                       否 ──▶ 下一轮       │
   └─────────────────────────────────────────────────────────┘
                          ↓
        http://localhost:7331  实时查看进度
```

- **完成即退出**：全部 story 同时满足 `passes && validated`（无 blocked）→ 退出码 0；全部收敛但存在 blocked 待人工 → 退出码 3；跑满 `maxIterations` 仍未收敛，或连续无进展轮触发 `--stall-limit` 熔断 → 退出码 1（完整对照见「命令行参数」后的「退出码」表）。
- **工作区锁**：启动时在 workspace 写 `engine.lock`（O_EXCL 原子创建），同一 workspace 的第二个 `run`/`repair` 以退出码 2 直接拒绝；异常退出（kill -9、断电）遗留的 stale 锁在下次启动时自动接管并告警，无需人工清理。
- **超时保护**：开发/验证各有独立超时；任一侧异常退出都不会留下未经验收的通过态，下一轮重试。
- **机械门禁（可选）**：`prd.json` 顶层配置 `qualityChecks`（完整 shell 命令数组）后，引擎在每轮开发之后、验证之前逐条确定性执行（fail-fast，单条超时 10 分钟）；失败即机械打回（`retryCount` +1，累计 5 次 `blocked`）并跳过该轮 validator——builder 谎报「检查通过」会被零成本戳穿。门禁配置受快照保护：运行期改写 prd.json（含删改 `qualityChecks` / 验收标准）会被检测、恢复并存档，无法架空门禁与验收（ADR-007）。未配置时行为不变，`npx coding-x doctor` 会给出配置建议。
- **workspace 写入避让与 Git 隔离**：`.workspace/` 是运行时状态，不属于 story commit。`prd-to-json` 在任何变更前及首次真实写入前各用 `doctor` 检查工作区锁，发现引擎运行中或无法判定就保持零写入，且绝不删除 `engine.lock`；随后检查目录是否被忽略、是否已有文件进入 Git 索引。它不会擅自修改 `.gitignore` 或 Git 索引。锁检查是尽力避让，不替代引擎的机械互斥。
- **状态共享**：引擎与 agent 都在项目根目录运行，读写同一组 `prd.json` / `state.json` / `progress.md`（需求只读，状态写 state.json）；`validated`、`escalated` 由引擎独占，agent 必须原样保留。指令模板用 `{{WORKSPACE}}` 占位符注入实际工作区路径。

---

## 安装

### 环境要求

- **Node.js ≥ 18**
- 已安装、已认证并可在终端调用 **`claude`**（Claude Code CLI）、**`codex`** 或 **`cursor-agent`**（取决于你用哪个 runner）

### Claude Code

添加 marketplace 并安装插件：

```
/plugin marketplace add Xinzz995/coding-engine
/plugin install coding-x
```

安装后即可使用 `/priming`、`/planning`、`/init-docs`、`/review-loop`、`/compound-docs` 命令以及 `scenario-alignment` / `technical-alignment` / `prd-generate` / `prd-to-json` / `agent-browser` skills。

### Codex

克隆仓库，仓库根目录的 `.codex-plugin/plugin.json` 清单会把顶层 `skills/`、`commands/` 暴露给 Codex：

```bash
git clone https://github.com/Xinzz995/coding-engine.git
```

按 Codex 的插件加载方式指向该目录即可（清单声明 `"skills": "./skills/"`、`"commands": "./commands/"`，指回仓库中唯一的一份内容）。引擎侧则直接用 `npx coding-x codex` 运行，无需额外安装。

### Cursor

同样克隆仓库，`.cursor-plugin/plugin.json` 清单把顶层 `skills/`、`commands/` 暴露给 Cursor：

```bash
git clone https://github.com/Xinzz995/coding-engine.git
```

按 Cursor 的插件/技能加载方式指向该目录即可。

> 说明：三套工具共用**同一份** `skills/` 和 `commands/`，各自只多一个瘦清单指回它（详见下文「目录结构」）。引擎（`npx coding-x`）与用哪个工具无关，任何环境下都能独立运行。

---

## 快速开始

```bash
# 1. 用插件的命令/skills 生成 .workspace/prd.json（会先检查 Git 隔离；见下文工作流程）

# 2. 在项目根目录运行引擎
npx coding-x                 # 默认用 claude
npx coding-x codex           # 改用 codex
npx coding-x cursor          # 改用 Cursor Agent

# 3. 浏览器会自动打开仪表盘（也可手动访问）
#    http://localhost:7331   普通视图
#    http://localhost:7331/p 像素风视图
```

> ⚠️ coding-x 会以**跳过权限确认**模式运行 AI agent（`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`），它会在无人确认的情况下读写文件、执行命令、提交代码。请务必确认当前目录是你信任的项目工作区。

---

## 基本工作流程

```
需求  ──scenario-alignment──▶  业务对齐稿（可选：输入杂乱/口径未定时先对齐）
      ──technical-alignment─▶  技术对齐稿（可选：涉及持久化/接口/状态机等合同级决策时）
      ──/planning────────────▶  实现计划（docs/plans/）
      ──prd-generate skill───▶  PRD（docs/prds/）
      ──prd-to-json skill────▶  .workspace/prd.json
                                │
                  npx coding-x  ▼
              Developer ⇄ Validator 循环（见「工作原理」）
                                │
                                ▼
              http://localhost:7331  实时查看进度
                                │
              ──/review-loop───▶  合并前人审包（审查，建议）
              ──/compound-docs─▶  经验沉淀回 docs/（收口，可选）
```

---

## 使用教程（整体流程）

### 第 1 步：生成 `prd.json`

在 Claude Code（或其他工具）中：

1. （可选）`/priming` 让 agent 先理解你的代码库；`/init-docs` 生成目录式根 `AGENTS.md` + `docs/` 知识库（架构地图、黄金原则、decisions/plans/prds），单项目与 monorepo 均支持。
2. （可选）输入杂乱（口述/bug/页面调整混杂）或业务口径未定时，先用 `scenario-alignment` skill 对齐场景（对它说「align: 你的需求」）：产出无技术内容的业务 PRD 对齐稿（`docs/prds/align-*.md`），人只拍板 1-3 个关键问题。需求本身已清楚时跳过。
3. （可选）功能涉及合同级技术决策（新表/改 schema、对外接口、状态机、权限模型、存量数据迁移）时，用 `technical-alignment` skill 对齐技术合同（「tech: ...」）：产出技术对齐稿（`docs/prds/tech-*.md`）——每条合同是可验证陈述，不可逆项单独列出，人只拍板少数贵决策。无此类决策时跳过。
4. `/planning 我要做的功能描述` 产出完整实现计划。
5. 用 `prd-generate` skill 生成 PRD（对它说「创建一个 prd」；输入是对齐稿/技术对齐稿时它会跳过澄清、吸收合同直接转）。
6. 用 `prd-to-json` skill 把 PRD 转成 `.workspace/prd.json`（「将 prd 转成 prd.json」）。它先用 `doctor` 检查是否有引擎持锁，真正写入前再检查一次；活锁或无法判定时零写入，陈旧/损坏锁交你确认但不由 skill 删除。随后检查 `.workspace/` 是否被 Git 忽略、是否已有运行时文件被跟踪；异常时停下来交由你决定，不自动改仓库。转换会把增强后的 stories 回写源 PRD 并输出对照表供确认；需求中途变更时改源 PRD 后重新转换（再派生按 story id 保留执行状态）。

`prd.json` 结构：

```jsonc
{
  "project": "我的项目",
  "branchName": "ralph/my-feature",
  "sourcePrd": "docs/prds/prd-my-feature.md",  // 意图真相源（源 PRD）路径，冲突时以它为准重新派生
  "qualityChecks": ["npm run typecheck", "npm test"],  // 机械门禁（可选）：每轮 builder 后引擎逐条执行，失败确定性打回
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

`state.json` 结构（引擎首跑自动生成；旧版含状态字段的 prd.json 会被自动抽取迁移）：

```jsonc
{
  "US-001": {
    "passes": false,      // builder 完成后置 true；只是待验证的候选结果
    "validated": false,   // validator 正常完成且结果仍通过后由引擎置 true；agent 不得改写
    "notes": "",          // 验证失败原因 / 仲裁标签（[需求冲突]、[需要人工核实]）/ [需求已变更] 记录
    "retryCount": 0,      // 失败重试次数
    "blocked": false,     // 累计失败 5 次后置 true，跳过
    "escalated": false    // 首次有效失败后由引擎置 true；agent 不得改写
  }
}
```

引擎每轮选择 `priority` 最高、尚未同时满足 `passes && validated` 且 `blocked: false` 的 story（状态读自 `state.json`）。

> **0.25.0 验收凭证迁移：** 新状态用 `validated` 区分“builder 声称完成”和“引擎已观察 Validator 正常完成”。旧 state 缺少该字段时，读取阶段按历史 `passes` 值兼容，不会把既有已完成 workspace 全量重验；新一轮自然写回后会补齐字段。显式的 `passes=true, validated=false` 会被视为中断留下的待验收状态并回写待复核。

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

### 第 4 步：审查合并（建议）

循环全部 story 通过后（引擎会提示），先别急着合并：在 Claude Code 等工具中运行 `/review-loop`，它对本轮分支 diff 做独立审查，产出人审包（红旗区如有 + 三层）并落盘 `.workspace/review-*.md` 留痕，人审后四态回填裁决——改动导读（每个 story 改了什么、数据怎么流）、发现清单（正确性与过度工程双维度，一行一发现）、风险聚焦（建议你重点细看的位置）。它是人审的加速器不是替代品：拿着包审完 diff、处理完发现，再把分支合并进主干。

### 第 5 步：收口沉淀（可选）

分支合并后、推送前，回到 Claude Code 等工具运行 `/compound-docs`：它基于当前代码、git 历史与 `progress.md` 的学习记录做交叉取证，把仍然成立的结构变化、稳定约定与高频陷阱分层沉淀进项目 `docs/`（约定与陷阱进 `docs/patterns.md`）。只改文档不改代码，越用文档越准。收口同时会汇总代码中的 `// 取舍:` 标记（builder 对带已知上限简化的就地记录）成取舍账本，提醒你处理未兑现的升级条件。

### 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 位置参数 `help` / `-h, --help` | — | 输出完整用法并退出 0；可放在子命令后（如 `config --help`），不读取 workspace、不获取锁、不启动 runner/dashboard |
| 位置参数 `claude` / `codex` / `cursor` | — | 显式选择 runner；若 PRD 启用了模型路由，必须与 `models.runner` 一致。未显式指定时优先用 `models.runner`，否则默认 claude |
| 位置参数 `config path\|init\|validate` | — | 查看全局配置路径、排他创建空模板或只读严格校验；均不启动 runner，不获取 workspace 锁 |
| 位置参数 `models [claude\|codex\|cursor]` | — | 只读查询全局模型目录；不启动 runner、不检查认证、不访问网络；可配 `--json` |
| 位置参数 `repair` | — | 修复 `<workspace>/` 下的 prd.json 与 state.json 后退出；引擎运行中（engine.lock 活锁）时以退出码 2 拒绝 |
| 位置参数 `dashboard` | — | 不跑循环，仅启动仪表盘离线查看 workspace 状态；state 文件缺失兼容旧格式，存在但损坏时全部按未验证显示并警告 |
| 位置参数 `doctor` | — | `docs/` 知识库健康检查（frontmatter、`updated`、AGENTS.md 索引、相对链接）、机械门禁、全局模型目录/PRD 映射与 workspace Git 隔离核对；未忽略/已跟踪只建议且不自动改仓库，硬错误以退出码 1 结束 |
| 位置参数 `status` | — | 终端速览 workspace 执行状态（story 通过/阻塞/重试、notes 与仲裁标签（`[需求冲突]`、`[需要人工核实]`）醒目标记、当前 story、最近进展）；损坏 state 全部按未验证、`--json` 标 `stateCorrupted`；退出码 0=全通过 / 1=未全通过或 state 损坏 / 2=无可读工作区，可作 CI 门禁 |
| 位置参数 `report` | — | （重）生成 `<workspace>/report.html` 静态验证报告（story 状态+AC、门禁、截图、review 留痕、篡改红旗区）；循环结束时也会从引擎冻结的 PRD 快照自动生成；退出码 0=可信状态下已生成 / 1=写入失败或 state 损坏（仍写红色诊断报告） / 2=无可读工作区 |
| `--max-iter <n>` | `50` | 最大迭代轮数 |
| `--dev-timeout <分钟>` | `30` | 单轮开发阶段超时（分钟） |
| `--val-timeout <分钟>` | `60` | 单轮验证阶段超时（分钟） |
| `--builder-model <id>` | — | 本次运行的初始 builder 覆盖；优先于 `models.builder[story.difficulty]`，但不压过已触发的专用 escalation 路由 |
| `--validator-model <id>` | — | 本次运行的 validator 覆盖；优先于 `models.validator` |
| `--escalation-model <id>` | — | 本次运行的升级 builder 覆盖；仅在 `state.escalated=true` 时生效，优先于 `models.escalation` |
| `--workspace <dir>` | `.workspace` | `prd.json` / `state.json` / `progress.md` 所在目录；`doctor` 用它定位 prd.json，并检查门禁、项目模型映射与 Git 隔离 |
| `--no-open` | 关闭 | 不在启动时自动打开浏览器 |
| `--keep-open` | 关闭 | 运行结束后保留仪表盘直到 Ctrl+C（保留循环的真实退出码） |
| `--port <n>` | `7331` | 仪表盘端口 |
| `--stall-limit <n>` | `3` | 仅 `run`（位置参数 `codex` 同属 `run`，同样适用）：连续无进展轮（no-op 空转、builder/validator 超时或异常退出）达到 n 次即提前终止（退出码 1），避免无人值守时死循环空跑；必须是正整数 |
| `--stale-days <n>` | `30` | 仅 `doctor`：git 最后提交日期晚于 frontmatter `updated` 超过 n 天判为过期；`0` 表示晚一天即过期 |
| `--json` | 关闭 | `status`：输出 story 状态、配置路由与 evidence 中最近实际命中；`models`：输出 `available` 或 `error` 的单个 JSON 对象 |

### 退出码

默认命令（`run`，即无 `repair`/`dashboard`/`doctor`/`status`/`report`/`models`/`config` 位置参数时；位置参数 `claude`/`codex`/`cursor` 只切换 runner，仍属 `run`，退出码规则相同）循环结束的进程退出码：

| 退出码 | 含义 |
| --- | --- |
| `0` | 全部 story 通过（`passes && validated`），且无 `blocked` |
| `1` | 跑满 `--max-iter` 仍未全部收敛；或连续无进展轮（no-op 空转、builder/validator 超时或异常退出）达到 `--stall-limit` 提前熔断 |
| `2` | workspace 锁（`engine.lock`）被占用，本次 `run`/`repair` 直接拒绝（ADR-008） |
| `3` | 全部 story 已收敛（`passes && validated`，或 `blocked`），但存在 `blocked` story 待人工处理 |

`repair`/`doctor`/`status`/`report`/`models`/`config` 等子命令的退出码语义各自独立，见上方参数表对应行说明。

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `CODING_X_CONFIG` | 覆盖全局模型配置的完整文件路径；相对路径按当前目录解析，空白值按未设置处理 |
| `CODING_X_CLAUDE_BIN` | 覆盖 `claude` 可执行文件路径 |
| `CODING_X_CODEX_BIN` | 覆盖 `codex` 可执行文件路径 |
| `CODING_X_CURSOR_BIN` | 覆盖 `cursor-agent` 可执行文件路径 |

---

## 包含内容 / 功能清单

### 引擎（`npx coding-x`）

- **Developer → Validator 双 agent 循环**：开发方实现单个 story 并提交，验收方独立逐条核对验收标准。
- **引擎验收凭证**：`passes=true` 只是 builder 的候选声明；仅当 Validator 被引擎观察为正常完成且结果仍通过，才签发 `validated=true`。所有完成判定与展示面统一要求二者同时为 true（ADR-013）。
- **自动重试与阻塞保护**：同一 story 验证失败累计 5 次后自动 `blocked` 跳过，避免卡死。
- **空转检测与 stall 熔断**：builder 结束但 `state.json`/`progress.md` 均无变化（no-op）时跳过门禁与验收，省一次验证方调用；no-op、超时、异常退出累计达 `--stall-limit`（缺省 3）连续无进展轮即提前终止（退出码 1）——已全部完成的工作区不受影响，完成判定优先于熔断计数。
- **机械门禁（qualityChecks）**：引擎在 Developer 与 Validator 之间确定性执行项目质量检查（`prd.json` 顶层配置），失败机械打回并跳过该轮验证；超时会终止并确认整棵门禁进程树退出后才进入下一轮——LLM 验证链之下不可共谋、不可绕过的确定性防线。
- **workspace 写入避让与 Git 隔离检查**：builder 只 stage/commit story 文件并在提交后回写运行时状态；`prd-to-json` 双次检查活跃工作区锁、写前阻止静默污染，`doctor` 只读报告锁与 Git 隔离状态，不替用户删锁或改索引。
- **按难度的模型路由**：`models.runner` 绑定一个 runner，`builder.low/medium/high` 按 story `difficulty` 选初始模型，validator 恒定。首次机械门禁打回、validator 正常打回或 completed no-op 后，引擎置 `state.escalated=true`，下轮使用专用 escalation；超时、非零退出、认证/网络异常不会用更贵模型掩盖环境故障。启动前严格校验 schema、runner，并确认本次可能调用的 ID 已在全局模型目录声明；目录不承诺 provider 实时可用。CLI 覆盖只影响单次运行，不改写 PRD；存在待执行 story 时同样必须在目录中声明。
- **完成判定**：全部 story 有效通过（`passes && validated`）或 `blocked` 即收敛；无 blocked → 退出码 0，存在 blocked → 文案分叉列出 story 号，退出码 3（待人工处理）。
- **三种 agent runner**：`claude`（历史默认）、`codex` 与 `cursor`，均以跳过权限确认模式运行，启动前打印警告。
- **超时控制**：开发/验证阶段各有独立超时。
- **实时 Web 仪表盘**：默认 `http://localhost:7331`，含普通视图与像素风视图（`/p`），启动时默认自动打开浏览器。`--keep-open` 让跑完后面板继续可看；`npx coding-x dashboard` 随时离线回看；服务停止后页面冻结最后状态并显示「运行已结束」横幅。
- **静态验证报告**：循环结束从 PRD guard 的最终冻结快照自动生成 `.workspace/report.html`，并标明“引擎启动快照”；手动 `npx coding-x report` 则诚实读取当前磁盘 PRD。story 验收证据（AC/notes/截图）、门禁配置、人审留痕（review-*.md）、篡改红旗区汇总为零依赖单页；失败门禁的输出尾部与 Validator 正常打回详情会从证据索引折叠展示，即使后续成功重试清空 notes 仍可复盘。state 已存在但损坏时所有 story 按未验证渲染，绝不复活 legacy 通过态。报告以 tmp+rename 原子覆盖；截图为相对引用，分享时需连同 `screenshots/` 目录。
- **JSON 修复**：`npx coding-x repair` 用 `jsonrepair` 修复被 agent 写坏的 `prd.json` / `state.json`。
- **可配置工作区**：`--workspace` 指定文件目录，指令用 `{{WORKSPACE}}` 占位符注入。

### 命令（Slash Commands，用户显式触发）

| 命令 | 作用 |
| --- | --- |
| `/priming` | 分析代码库结构、文档与关键文件，为 agent 建立项目上下文理解 |
| `/init-docs` | 分析代码库，生成目录式 `AGENTS.md` 与 `docs/` 知识库（含黄金原则），支持 monorepo；并为 Claude Code 生成 `CLAUDE.md` 桥接（`@AGENTS.md` 导入） |
| `/planning <功能描述>` | 通过系统化分析与调研，把需求转化为完整实现计划 |
| `/review-loop` | 循环结束后、合并默认分支前，对分支 diff 做独立审查并产出人审包（改动导读/双维度发现清单/风险聚焦）；只读不改（唯一写入是 .workspace/ 的审查留痕文件），人保持最终裁决 |
| `/compound-docs` | 循环/分支收口时把经验提炼、验证、分层沉淀回项目文档（约定与陷阱进 `docs/patterns.md`）；只改文档不改代码；汇总代码中 `取舍:` 标记为账本；并核对任务型文档状态（交付的 PRD/计划/spec 置 done、被吸收对齐稿置 superseded） |

### Skills（能力，Claude 按语境自动触发）

| Skill | 作用 | 触发示例 |
| --- | --- | --- |
| `scenario-alignment` | 杠铃第一端「场景对齐」：把杂乱输入（口述/bug/调整混杂）整理成无技术内容的业务 PRD 对齐稿（`docs/prds/align-*.md`），默认最多问 1-3 个关键问题且必附推荐答案；说「一个一个问」可切逐题深挖模式（逐题追问到剩余问题不再影响产品方向为止）；口径确认后交 `prd-generate` 转正式 PRD | 「align: 你的需求」「场景对齐」 |
| `technical-alignment` | 杠铃第二端「技术对齐」：把改起来贵的合同级技术决策（持久化/对外接口/状态机/权限承接/兼容迁移）整理成技术对齐稿（`docs/prds/tech-*.md`）——每条合同是可验证陈述、不可逆项单列；实现细节不进合同 | 「tech: ...」「技术对齐」「技术合同」 |
| `prd-generate` | 为新功能生成结构清晰、可执行的 PRD（输入为对齐稿/技术对齐稿时跳过澄清、吸收合同直接转） | 「创建一个 prd」 |
| `prd-to-json` | 把已有 PRD 转换成引擎使用的 `prd.json` 格式 | 「将 prd 转成 prd.json」 |
| `agent-browser` | 浏览器自动化：导航、填表、截图、数据提取，用于 UI story 验证 | 需要在浏览器中验证 UI 时 |

> commands 与 skills 的区别：**command 是你敲 `/命令` 显式触发、支持传参的工作流；skill 是 Claude 根据你说的话自动选用的能力**。二者是 Claude Code 的两种不同原语，分别放在插件根目录的 `commands/` 与 `skills/`，由 Claude Code 自动发现。

---

## 目录结构详细说明

skill / command 内容在整个仓库里**只存一份**，各工具用一个瘦清单指回它，因此没有副本、无需同步、不会漂移（做法参考 [superpowers](https://github.com/obra/superpowers)）。

```
coding-engine/
├── skills/                       # 唯一源：模型自主触发的能力
│   ├── scenario-alignment/SKILL.md
│   ├── technical-alignment/SKILL.md
│   ├── prd-generate/SKILL.md
│   ├── prd-to-json/SKILL.md
│   └── agent-browser/SKILL.md
├── commands/                     # 唯一源：用户 /斜杠命令
│   ├── priming.md
│   ├── planning.md
│   ├── init-docs.md
│   ├── review-loop.md
│   └── compound-docs.md
├── templates/                    # /init-docs、/compound-docs 使用的知识库模板
│   ├── AGENTS-root.md            #   目录式根 AGENTS.md（四段式）
│   ├── AGENTS-sub.md             #   子项目薄 AGENTS.md
│   └── docs/                     #   architecture / golden-principles / patterns / glossary / decision(ADR)
├── AGENTS.md                     # 本仓库自己的目录式索引（/init-docs dogfood 产物）
├── CLAUDE.md                     # Claude Code 桥接：@AGENTS.md 导入（Claude Code 不读 AGENTS.md）
├── docs/                         # 本仓库知识库：architecture / golden-principles / decisions / plans / prds
│
├── .claude-plugin/               # Claude Code 插件清单
│   ├── plugin.json               #   插件元数据（commands/ skills/ 自动发现）
│   └── marketplace.json          #   marketplace 元数据
├── .cursor-plugin/plugin.json    # Cursor 瘦清单：{ skills: ./skills/, commands: ./commands/ }
├── .codex-plugin/plugin.json     # Codex 瘦清单：同上
├── .agents/plugins/marketplace.json  # 通用 agent 清单：source 指向仓库根
│
├── assets/                       # 引擎专用静态资产（构建时拷进 dist/，工具不读）
│   ├── instructions/
│   │   ├── builder.md            #   Developer 指令（含 {{WORKSPACE}} 占位符）
│   │   └── validator.md          #   Validator 指令
│   └── dashboard/
│       ├── dashboard.html        #   仪表盘普通视图
│       └── dashboard-p.html      #   仪表盘像素风视图
│
├── src/                          # TypeScript 引擎源码
│   ├── cli.ts                    #   命令行入口、参数解析
│   ├── engine/
│   │   ├── loop.ts               #   主循环：Developer ⇄ Validator
│   │   ├── agent.ts              #   拉起 claude / codex / cursor 子进程、模型参数与超时控制
│   │   ├── evidence.ts           #   evidence.jsonl schema、追加与读取
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
│   │   ├── progress.ts           #   读取 progress.md
│   │   └── repair.ts             #   jsonrepair 修复 prd.json / state.json
│   ├── doctor/
│   │   └── doctor.ts             #   docs、门禁、模型目录与 workspace Git 隔离检查
│   ├── report/
│   │   ├── report.ts             #   验证报告收集、可信 PRD 来源与原子写盘
│   │   └── render.ts             #   验证报告 HTML 渲染（零浏览器 JS、全文本转义）
│   ├── status/
│   │   └── status.ts             #   workspace 状态与实际路由终端速览
│   └── dashboard/
│       └── server.ts             #   仪表盘 HTTP 服务 + 自动开浏览器
│
├── tsup.config.ts                # 打包配置（onSuccess 把 assets 拷进 dist/）
├── tsconfig.json / vitest.config.ts
├── package.json
└── LICENSE                       # MIT
```

**两条资产链路：**

- **面向工具**：`skills/`、`commands/` 是唯一源，各工具的瘦清单用相对路径 `./skills/` `./commands/` 指回它，随插件仓库分发。
- **面向引擎**：`assets/instructions`、`assets/dashboard` 由 `npm run build`（tsup 的 `onSuccess` 钩子）拷进 `dist/instructions`、`dist/public`；引擎通过 `import.meta.url` 定位并读取。`package.json` 的 `files` 只发布 `dist`、`assets/instructions`、`assets/dashboard`。

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
