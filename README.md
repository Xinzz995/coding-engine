# coding-x

> Ralph 自动化 Coding 工作流 —— 把 **Developer → Validator** 循环固化成确定性程序的 harness。

coding-x 同时是两样东西：

- **TypeScript 引擎**（`npx coding-x`）—— 读取 `prd.json`，自动驱动 AI agent（Claude 或 Codex）逐个 user story「开发 → 验证 → 提交」，直到全部完成，并提供实时 Web 仪表盘。
- **多工具插件** —— 提供 `scenario-alignment` / `technical-alignment` / `prd-generate` / `prd-to-json` / `agent-browser` skills 和 `/priming` `/planning` `/init-docs` `/review-loop` `/compound-docs` 命令，支持 Claude Code、Codex、Cursor 及通用 agent，帮你对齐业务口径与技术合同、把需求拆解成可自动执行的 `prd.json`、在合并前审查循环产物并留痕人审裁决，且为项目生成与持续沉淀 docs/ 知识库。

---

## 理念

传统 AI 编码是「人不断盯着、一句句地喂」。coding-x 反过来：

> **人只负责把需求讲清楚（生成 PRD），剩下的「写代码 → 自检 → 验收 → 修复 → 再验收」交给一个确定性的循环反复跑，直到所有验收标准通过。**

三条核心原则：

1. **确定性 harness，而非一次性对话。** 循环、超时、重试、完成判定都由程序控制，不依赖模型「记得」自己该干什么。
2. **开发与验收分离。** 写代码的 agent 和验收的 agent 是两个独立角色，验收方只认「验收标准」，不受开发方自述影响，避免「自己判自己及格」。
3. **单一 story、频繁提交、进度可追溯。** 每轮只推进一个 user story，通过即提交，学习与踩坑写入 `progress.md` 供后续迭代复用。

技法来源：Ralph 自主循环 + Anthropic harness 设计。

---

## 工作原理

引擎在项目根目录启动，围绕工作区里的三份文件运转：`prd.json`（需求，运行期只读且被引擎冻结——启动时快照，运行中的磁盘修改会被自动恢复并存档为 `.workspace/prd.tampered-*.json` 供人审；改需求请停引擎 → 修订源 PRD → 重新派生 → 重跑）、`state.json`（执行状态，按 story id 键控，agent 回写）和 `progress.md`（进度与学习日志）。`prd.json` 是 `docs/prds/` 源 PRD 的派生物：md 是**意图真相源**（人写人审，需求变更改它），`prd.json` + `state.json` 是**执行真相源**（机器与 agent 读写）；需求冲突时以 md 为准重新派生（见 `docs/decisions/003-prd-layered-truth.md`）。旧版 workspace（状态写在 prd.json 里、无 state.json）在 v0.5.0 引擎首次运行时自动抽取迁移，无需手工处理。

```
                      npx coding-x
   ┌─────────────────────────────────────────────────────────┐
   │  for i in 1..maxIterations:                              │
   │                                                          │
   │   ┌── Developer（builder.md）──────────────────────────┐ │
   │   │ 1. 读 prd.json+state.json，选最高优先级未完成 story │ │
   │   │ 2. 只实现这一个 story                               │ │
   │   │ 3. 跑质量检查（typecheck / lint / test）            │ │
   │   │ 4. 通过则提交 feat: [ID] - [Title]                  │ │
   │   │ 5. 把进度 + 学习追加到 progress.md                  │ │
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
   │   │ 3. 通过 → 清理 notes（留仲裁标签行）、重试归零      │ │
   │   │    失败 → passes=false、写失败原因、retryCount+1     │ │
   │   │           （累计 5 次 → blocked=true 跳过）         │ │
   │   └────────────────────────────────────────────────────┘ │
   │                          ↓                               │
   │   所有 story 都 passes 或 blocked ? ── 是 ──▶ 成功退出   │
   │                                       否 ──▶ 下一轮       │
   └─────────────────────────────────────────────────────────┘
                          ↓
        http://localhost:7331  实时查看进度
```

- **完成即退出**：全部 story 解决 → 退出码 0；跑满 `maxIterations` 仍未完成 → 退出码 1。
- **超时保护**：开发/验证各有独立超时；开发阶段超时则跳过验证、下一轮重试。
- **机械门禁（可选）**：`prd.json` 顶层配置 `qualityChecks`（完整 shell 命令数组）后，引擎在每轮开发之后、验证之前逐条确定性执行（fail-fast，单条超时 10 分钟）；失败即机械打回（`retryCount` +1，累计 5 次 `blocked`）并跳过该轮 validator——builder 谎报「检查通过」会被零成本戳穿。门禁配置受快照保护：运行期改写 prd.json（含删改 `qualityChecks` / 验收标准）会被检测、恢复并存档，无法架空门禁与验收（ADR-007）。未配置时行为不变，`npx coding-x doctor` 会给出配置建议。
- **状态共享**：引擎与 agent 都在项目根目录运行，读写同一组 `prd.json` / `state.json` / `progress.md`（需求只读，状态写 state.json）；指令模板用 `{{WORKSPACE}}` 占位符注入实际工作区路径。

---

## 安装

### 环境要求

- **Node.js ≥ 18**
- 已安装并可在终端调用 **`claude`**（Claude Code CLI）或 **`codex`**（取决于你用哪个后端）

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
# 1. 用插件的命令/skills 生成 .workspace/prd.json（见下文工作流程）

# 2. 在项目根目录运行引擎
npx coding-x                 # 默认用 claude
npx coding-x codex           # 改用 codex

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
6. 用 `prd-to-json` skill 把 PRD 转成 `.workspace/prd.json`（「将 prd 转成 prd.json」）。转换会把增强后的 stories 回写源 PRD 并输出对照表供确认；需求中途变更时改源 PRD 后重新转换（再派生按 story id 保留执行状态）。

`prd.json` 结构：

```jsonc
{
  "project": "我的项目",
  "branchName": "ralph/my-feature",
  "sourcePrd": "docs/prds/prd-my-feature.md",  // 意图真相源（源 PRD）路径，冲突时以它为准重新派生
  "qualityChecks": ["npm run typecheck", "npm test"],  // 机械门禁（可选）：每轮 builder 后引擎逐条执行，失败确定性打回
  "models": { "builder": "sonnet", "validator": "opus", "escalation": "opus" },  // 模型路由（可选）：阶段默认模型与打回升级模型；story 级可再加 "model" 覆盖 builder
  "description": "...",
  "userStories": [
    {
      "id": "US-001",
      "title": "用户可以新建笔记",
      "description": "...",
      "acceptanceCriteria": ["Typecheck passes", "在浏览器中点击新建按钮能创建笔记"],
      "priority": 1        // 数字越小越优先
    }
  ]
}
```

`state.json` 结构（引擎首跑自动生成；旧版含状态字段的 prd.json 会被自动抽取迁移）：

```jsonc
{
  "US-001": {
    "passes": false,      // 开发完成后置 true
    "notes": "",          // 验证失败原因 / 仲裁标签（[需求冲突]、[需要人工核实]）/ [需求已变更] 记录
    "retryCount": 0,      // 失败重试次数
    "blocked": false      // 累计失败 5 次后置 true，跳过
  }
}
```

引擎每轮选择 `priority` 最高、`passes: false` 且 `blocked: false` 的 story（状态读自 `state.json`）。

### 第 2 步：运行引擎

```bash
npx coding-x                    # 默认 claude，max-iter 50
npx coding-x codex              # 改用 codex 后端
npx coding-x --max-iter 20      # 最多 20 轮迭代
npx coding-x --builder-model sonnet --validator-model opus  # 临时覆盖阶段模型（压过 prd.json models）
npx coding-x --no-open          # 不自动打开浏览器
npx coding-x --workspace ./run  # 指定 prd.json / state.json / progress.md 所在目录
npx coding-x --keep-open        # 跑完后保留仪表盘，按 Ctrl+C 退出（退出码不变）
npx coding-x repair             # 修复 .workspace/ 下的 prd.json 与 state.json（不跑循环）
npx coding-x dashboard          # 不跑循环，随时离线回看仪表盘
npx coding-x status             # 终端一屏速览工作区执行状态（退出码 0/1/2 可作 CI 门禁）
npx coding-x status --json      # 同上，stdout 输出单个 JSON 对象供脚本与 agent 消费
npx coding-x doctor             # docs/ 知识库健康检查（问题以退出码 1 结束，可作 CI 门禁）
npx coding-x doctor --stale-days 14  # 新鲜度阈值改为 14 天（缺省 30）
```

### 第 3 步：查看实时进度

浏览器打开（默认自动弹出）：<http://localhost:7331>（像素风视图 `/p`）。仪表盘展示迭代次数、当前阶段、当前 story、当前模型（配置了模型路由时）、已用时长、story 列表与 `progress.md` 日志。

### 第 4 步：审查合并（建议）

循环全部 story 通过后（引擎会提示），先别急着合并：在 Claude Code 等工具中运行 `/review-loop`，它对本轮分支 diff 做独立审查，产出人审包（红旗区如有 + 三层）并落盘 `.workspace/review-*.md` 留痕，人审后四态回填裁决——改动导读（每个 story 改了什么、数据怎么流）、发现清单（正确性与过度工程双维度，一行一发现）、风险聚焦（建议你重点细看的位置）。它是人审的加速器不是替代品：拿着包审完 diff、处理完发现，再把分支合并进主干。

### 第 5 步：收口沉淀（可选）

分支合并后、推送前，回到 Claude Code 等工具运行 `/compound-docs`：它基于当前代码、git 历史与 `progress.md` 的学习记录做交叉取证，把仍然成立的结构变化、稳定约定与高频陷阱分层沉淀进项目 `docs/`（约定与陷阱进 `docs/patterns.md`）。只改文档不改代码，越用文档越准。收口同时会汇总代码中的 `// 取舍:` 标记（builder 对带已知上限简化的就地记录）成取舍账本，提醒你处理未兑现的升级条件。

### 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 位置参数 `codex` | — | 使用 codex 后端（缺省为 claude） |
| 位置参数 `repair` | — | 修复 `<workspace>/` 下的 prd.json 与 state.json 后退出 |
| 位置参数 `dashboard` | — | 不跑循环，仅启动仪表盘离线查看 workspace 状态 |
| 位置参数 `doctor` | — | `docs/` 知识库健康检查（frontmatter 完整性、`updated` 新鲜度、AGENTS.md 索引、文档相对链接、机械门禁配置建议（建议级，不计失败）），发现问题以退出码 1 结束，可作 CI 门禁 |
| 位置参数 `status` | — | 终端速览 workspace 执行状态（story 通过/阻塞/重试、notes 与仲裁标签（`[需求冲突]`、`[需要人工核实]`）醒目标记、当前 story、最近进展）；退出码 0=全通过 / 1=未全通过 / 2=无可读工作区，可作 CI 门禁 |
| `--max-iter <n>` | `50` | 最大迭代轮数 |
| `--dev-timeout <分钟>` | `30` | 单轮开发阶段超时（分钟） |
| `--val-timeout <分钟>` | `60` | 单轮验证阶段超时（分钟） |
| `--builder-model <名字>` | — | builder 阶段模型，直接透传给 agent CLI 的 `--model`；压过 `prd.json` `models`（含升级链）。缺省依次回落 `models` 段、CLI 默认模型 |
| `--validator-model <名字>` | — | validator 阶段模型；压过 `prd.json` `models.validator`，缺省同上回落 |
| `--workspace <dir>` | `.workspace` | `prd.json` / `state.json` / `progress.md` 所在目录；`doctor` 用它定位 prd.json 做门禁配置检查 |
| `--no-open` | 关闭 | 不在启动时自动打开浏览器 |
| `--keep-open` | 关闭 | 运行结束后保留仪表盘直到 Ctrl+C（保留循环的真实退出码） |
| `--port <n>` | `7331` | 仪表盘端口 |
| `--stale-days <n>` | `30` | 仅 `doctor`：git 最后提交日期晚于 frontmatter `updated` 超过 n 天判为过期；`0` 表示晚一天即过期 |
| `--json` | 关闭 | 仅 `status`：向 stdout 输出单个 JSON 对象（project/branchName/sourcePrd/stories/summary），退出码语义与人类可读模式一致；state.json 损坏警告走 stderr 不污染 stdout |

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `CODING_X_CLAUDE_BIN` | 覆盖 `claude` 可执行文件路径 |
| `CODING_X_CODEX_BIN` | 覆盖 `codex` 可执行文件路径 |

---

## 包含内容 / 功能清单

### 引擎（`npx coding-x`）

- **Developer → Validator 双 agent 循环**：开发方实现单个 story 并提交，验收方独立逐条核对验收标准。
- **自动重试与阻塞保护**：同一 story 验证失败累计 5 次后自动 `blocked` 跳过，避免卡死。
- **机械门禁（qualityChecks）**：引擎在 Developer 与 Validator 之间确定性执行项目质量检查（`prd.json` 顶层配置），失败机械打回并跳过该轮验证——LLM 验证链之下不可共谋、不可绕过的确定性防线。
- **模型路由（models）**：`prd.json` 顶层 `models` 段按阶段分配模型（builder/validator 各自默认），story 级 `model` 字段覆盖 builder，story 被打回后自动升级到 `escalation` 模型重试（阈值 `escalateAfter` 可配，缺省打回 1 次即升级）；模型名不透明透传给 agent CLI（claude/codex 均加 `--model`），未配置时行为与旧版完全一致。
- **完成判定**：全部 story `passes` 或 `blocked` 即成功退出。
- **两种 agent 后端**：`claude`（默认）与 `codex`，均以跳过权限确认模式运行，启动前打印警告。
- **超时控制**：开发/验证阶段各有独立超时。
- **实时 Web 仪表盘**：默认 `http://localhost:7331`，含普通视图与像素风视图（`/p`），启动时默认自动打开浏览器。`--keep-open` 让跑完后面板继续可看；`npx coding-x dashboard` 随时离线回看；服务停止后页面冻结最后状态并显示「运行已结束」横幅。
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
│   │   ├── agent.ts              #   拉起 claude / codex 子进程、超时控制
│   │   ├── prd.ts                #   读取 prd.json（需求内容）
│   │   ├── state.ts              #   state.json 读写、选 story、完成判定、合并视图
│   │   ├── progress.ts           #   读取 progress.md
│   │   └── repair.ts             #   jsonrepair 修复 prd.json / state.json
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
