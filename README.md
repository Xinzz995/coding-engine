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

| 名称                   | 它是什么                                                                                        | 你在哪里操作                                                |
| ---------------------- | ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| **coding-x（控制端）** | 本仓库提供的插件和 npm 引擎，负责安排步骤、启动 agent、保存状态                                 | 安装一次；通常不需要修改它的源码                            |
| **目标项目（目标端）** | 你真正想开发的网站、服务、App 或其他 Git 仓库                                                   | commands、skills 和 `npx coding-x` 都应在这个项目根目录执行 |
| **runner**             | 真正执行 AI 任务的命令行工具：`claude`、`codex` 或 Cursor 的 `agent`（兼容旧名 `cursor-agent`）。三者均可开发；可签发验收凭证的 Validator 当前仅 `codex`（见「Validator 宿主隔离与 Runner 信任分层」） | 先安装并登录；coding-x 每轮调用它                           |

例如，你要给 `my-shop` 增加优惠券功能：coding-x 是控制工具，`my-shop` 是目标项目，Codex 可以是 runner。**不要为了使用 coding-x，把 `my-shop` 的需求和 `.workspace/` 写进 coding-x 源码仓库。**

开发 coding-x 自身时，本仓库可以同时充当控制端和目标端；这是维护者的自用场景，普通用户无需这样做。

### 谁负责什么

| 角色                    | 负责                                                                                | 不负责                                 |
| ----------------------- | ----------------------------------------------------------------------------------- | -------------------------------------- |
| **你（人）**            | 说明目标、确认业务/技术取舍、审阅转换差异、处理 blocked、裁决 review、决定合并/发布 | 不必逐轮提醒 AI 下一步做什么           |
| **交互式 AI 工具**      | 执行 command/skill，和你一起生成文档、转换 PRD、审查和收口                          | 不自动获得最终产品裁决权               |
| **coding-x 引擎**       | 选 story、启动角色、执行机械门禁、控制重试/超时、签发验收状态、记录证据             | 不替人修改需求，也不替人批准破坏性动作 |
| **Developer / Builder** | 一次只实现一个 story，运行检查，提交该 story，再声明候选完成                        | 不能给自己签发最终验收凭证             |
| **Validator**           | 针对引擎绑定的 story 和验收标准逐条复核，提交结构化结果                             | 不修代码、不改需求、不直接改最终状态   |

### 会话上下文如何工作

- commands 和 skills 通常在你当前打开的 AI 会话中执行，不会因为名字里有 `loop` 就自动新开会话。`/priming` 建立的理解也主要服务于当前会话。
- 引擎中的每次 Developer 和 Validator 调用都是新的 headless runner 进程，不能依赖上轮聊天记忆；它们通过 Git、`AGENTS.md`、`docs/` 和 `.workspace/` 接力。
- 全部 Story 验证后，引擎会在临时只读审查包中顺序执行 Spec、工程标准和风险触发的深度 Review；它不复用 Developer/Validator 会话，也不读取项目秘密、未跟踪文件、MCP、hooks 或插件。`/review-loop` 只负责让你裁决这些结构化 findings，不再执行另一套审查。

> **下文命令名的写法：** 为了让三种宿主共用一份说明，本文把命令逻辑名简写成 `/priming`、`/planning` 等。Claude Code 安装插件后的实际名字带命名空间，例如 `/coding-x:priming`；Cursor 以斜杠菜单实际显示的名字为准；Codex 可直接说“使用 coding-x 的 priming 工作流”。如果宿主没有显示裸命令，不要机械输入不存在的 `/priming`，安装和验证方法见「安装」。

---

## 零基础完整流程

下面是一条推荐的完整路线。不是每次都要执行所有可选步骤，后文会说明如何跳过。

1. **准备目标项目。** 确认它是你信任的 Git 仓库，重要内容已经提交或备份，当前没有不明来源的改动。
2. **安装插件和一个 runner。** Node.js 需要 ≥22；Claude Code、Codex 或 Cursor Agent 至少安装并登录一个。要跑通含验收凭证的完整循环需要 `codex`（当前唯一可签发凭证的 runner）。详细命令见「安装」。
3. **进入目标项目根目录。** 后面的对话和终端命令都在这里进行，而不是在 coding-x 插件源码目录中进行。
4. **第一次接入先初始化质量门禁，再运行 `/init-docs`。** `npx coding-x init` 先发现候选检查和规范，必须经你确认才配置 GitHub 最小规则并生成受 Git 管理的质量契约；`/init-docs` 只补缺失文档，不覆盖已有内容。
5. **让当前会话理解项目。** 运行 `/priming`。它不改代码，只输出当前项目概览。
6. **整理需求。** 需求很乱时说 `align: <你的需求>`；涉及数据库、公开接口、状态机、权限或迁移时，再说 `tech: <功能或对齐稿>`。需求已经清楚可以跳过对应步骤。
7. **规划和生成正式 PRD。** 推荐先运行 `/planning <功能描述或对齐稿>`，再说“基于这些材料创建一个 PRD”。逐项确认 AI 提出、且无法从项目中查证的业务问题。
8. **生成引擎执行清单。** 说“将 `docs/prds/prd-xxx.md` 转成 `prd.json`”。检查它展示的 story/AC 对照表；有异议时改源 PRD 后重新转换，不要直接手改 `.workspace/prd.json`。
9. **先体检，再启动。** 运行 `npx coding-x doctor`。质量契约、固定版本、PRD 摘要或派生检查快照任一不一致都会停止。Developer/Validator 可以继续使用 runner 默认模型，但最终 Review 必须固定一个明确模型。
10. **运行引擎。** 例如 `npx coding-x codex --review-model <模型 ID>`；若 PRD 已固定 `models.validator`，可省略该参数。终端会打印仪表盘地址，并持续显示当前 story、阶段和实际模型。
11. **观察和处理异常。** 随时运行 `npx coding-x status`；需要完整证据时打开 `.workspace/report.html`。退出码 3 或 story 显示 blocked 时，先看 `state.json` 的 notes 和报告，再做人工裁决。
12. **处理最终 Review。** 引擎会在所有 Story 验证后自动进入本地三层 Review。若返回 4，运行 `/review-loop` 逐项选择修复、提交反证、登记 P1 延期或知悉低等级 finding；修复必须形成新提交并重新运行 `coding-x`。
13. **合并和收口。** `coding-x status` 只有在实现验证、本地 Review 和 GitHub 交付条件同时就绪时才返回 0；随后仍由人决定合并。合并后可运行 `/compound-docs` 沉淀长期经验。

coding-x 自身的 npm 发布不属于普通下游使用流程。维护者必须遵守
[候选发布与恢复手册](docs/release.md)，GitHub 只能暂存候选，2FA 批准、三仓验证、移动
`latest` 和创建发布标签都由人分阶段完成。

`init` 本来就是分阶段完成的：第一次只在远端最小规则回读成功后生成文件；你提交、推送并
打开 Bootstrap PR 后再次运行，它才会把该 PR 最新提交上真实出现的 `quality-gate` 设为必需
检查。Bootstrap 合并后还需一个 Activation PR，让已进入默认分支的旧 `policy-guard` 产生
绑定最新提交的真实 `policy-guard-source` 任务，再运行一次完成最终绑定。中间返回 6
表示“尚未就绪”，不是执行失败。

最短可用路线是：**`coding-x init` → 已有清楚需求和健康文档 → `prd-generate` → `prd-to-json` → `doctor` → `npx coding-x` → `status` 返回 0 → 人工合并**。只有最终 Review 返回待人工处理的 finding 时，才运行 `/review-loop`，处理后重新运行 `coding-x`。`scenario-alignment`、`technical-alignment`、`/planning` 和 `/compound-docs` 都有明确的可选条件，不需要为了“走全流程”机械执行。

### 首次运行前的安全红线

> ⚠️ coding-x 会以跳过 runner 权限确认的模式运行 AI agent。它可以读写目标项目、执行命令、创建/切换分支并提交代码。

- 只在你信任的仓库中运行；先提交或备份自己的未完成工作。
- 确认质量契约中的测试、构建、静态检查和安全检查基线本来就是绿色，否则循环会把旧失败误当成本轮问题反复处理。
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

引擎在项目根目录启动，围绕 workspace 的三份核心文件运转：`prd.json`（需求，运行期由引擎快照冻结）、`state.json`（执行状态；builder 只写候选完成，Validator verdict/重试/凭证由引擎写）和 `progress.md`（进度与学习日志）。`evidence.jsonl` 追加引擎机械记录（含已随普通 iteration 写入的 Agent 调用耗时、退出码和异常输出尾部）、`source=validator` 的逐 AC claim 与 agent 截图登记；若同轮后续调用无法证明结算，整轮不写普通 iteration，此前已结算的调用也不单独持久化，只保留安全协议、隔离状态和受保护现场。`validation-result.json` 只是一轮 Validator 调用的瞬时 IPC，消费后删除，不能当长期状态。`prd.json` 是 `docs/prds/` 源 PRD 的派生物：md 是**意图真相源**（人写人审，需求变更改它），`prd.json` + `state.json` 是**执行真相源**（机器与 agent 读写）；需求冲突时以 md 为准重新派生（见 `docs/decisions/003-prd-layered-truth.md`）。0.34 开始，新安全协议只会在空 workspace 中初始化，正式写入命令只接受已完成该初始化的 workspace；旧版非空目录不会自动迁移。status/dashboard 仍可以只读回看旧格式；report 只能在已经完成新版安全初始化的 workspace 内解释旧形状数据，不能为旧版非空 workspace 重新生成报告。`state.json` 已存在但损坏时，展示入口会统一把所有 story 按未验证状态显示并提示 repair。

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
   │   ┌── 质量契约机械门禁（必需）────────────────────────┐ │
   │   │ 按冻结快照执行结构化项目检查（fail-fast）          │ │
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
   │                                  否 ──▶ 下一轮           │
   └─────────────────────────────────────────────────────────┘
                          ↓
        有 blocked → 等待人工处理（退出码 3）
        无 blocked → 重跑完整机械检查
                   → Spec / 工程标准 / 风险触发的深度 Review
                   → 查询 GitHub PR、CI 与 Ruleset
                   → 三者均就绪才成功退出（退出码 0）
                          ↓
        http://localhost:7331  实时查看进度
```

- **实现收敛不等于可交付**：全部 story 同时满足 `passes && validated` 且无 blocked 后，引擎还会重跑完整机械检查、执行本地最终 Review 并查询 GitHub 交付状态；三者均就绪才返回 0。存在 blocked 返回 3；后续检查、Review 或远端未就绪时返回对应的非零代码；跑满 `maxIterations` 仍未收敛，或连续无进展轮触发 `--stall-limit` 熔断，返回 1（完整对照见「命令行参数」后的「退出码」表）。
- **工作区写租约**：初始化后永久保留 `engine.lock/` 协议根，活动 owner 位于其中的 `lease/`。run、repair、report、PRD 应用和 Review 裁决都进入同一写域；第二个写入口会被拒绝，不能靠 PID 看似已死就自动接管，也不能手删租约继续。
- **异常恢复**：Builder、Validator、项目检查和最终 Review 都在受管范围内运行，返回前必须取得与调用类型相符的收口证明。异常中断留下的活动状态由 `doctor` / `status` 分类，再通过明确的 `workspace recover` 或 `workspace resume-mutation` 恢复；永久隔离状态不能恢复。继续前还要独立确认旧进程不会再影响原项目目录；无法确认时应改用新的隔离项目检出或重启主机，再配新的空 workspace。无法证明安全时不会伪装成已结束。
- **超时保护**：开发/验证各有独立超时；任一侧异常退出都不会留下未经验收的通过态。普通项目命令在进程组收口证明成立后沿用既有重试规则；POSIX 上已经启动的 AI runner 被超时、用户中断、父进程关闭或输出通道故障从外部终止时，不再自动启动下一轮，而是永久隔离当前 workspace。只有已随普通 iteration 写入的调用，才在存档中保留完整收口耗时、退出码和最近 2000 字符异常诊断；proof-missing 只保留安全协议、隔离状态、终端已显示内容和受保护现场。
- **质量契约机械门禁（必需）**：`.coding-x/quality.json` 是测试、构建、静态检查和安全检查的唯一人工维护来源；`prd-to-json` 把规范化摘要与结构化检查快照冻结进 `prd.json`。正式运行要求契约版本、coding-x 版本、摘要和快照全部一致；固定候选只有显式 shadow doctor/apply/run 才能在不放宽其他检查的前提下跨过版本差异，健康也固定返回 7。Story 凭证还绑定实际 coding-x 版本和 formal/shadow 模式，候选结果不能被正式模式或另一个候选复用。每轮开发之后、验证之前按固定类别执行，默认不经 shell，只有契约显式声明时才使用指定 shell。schema v2 还要求明确确认本地依赖准备命令和允许产物目录，不能从 GitHub 工作流暗推。Node 缺少 lockfile、或 Python 无法安全推导隔离环境时，自动发现会停止并要求 `init --contract`，不会借用宿主全局依赖凑出绿色。失败会机械打回并跳过该轮 Validator，运行期契约或 PRD 漂移则停止。GitHub 代码扫描工具和阻断阈值只有在契约明确声明后才由 `init` 配置、由 `doctor` 回读；未声明时不猜测项目技术栈，也不删除仓库已有的扫描规则（ADR-007、018、022）。
- **精确提交的干净验证**：Developer 仍在开发目录工作；本地准备、项目检查、TDD、Validator 和最终 Review 前机械检查在项目外的临时 Git 检出运行。检出只包含精确 HEAD 的已跟踪内容，不复制 `.env`、`.claude`、旧依赖或其他忽略文件；submodule、LFS/custom filter、提交身份变化、tracked 改写和未允许产物都按不可验证停止。Validator 通过后先安全清理检出，才签发绑定完整机械/TDD 环境的凭证；清理无法证明成功时不会留下绿色（ADR-022）。
- **Validator 宿主隔离与 Runner 信任分层**：签发验收凭证的 Validator 必须满足可机械证明的宿主隔离——引擎按固定 Runner profile 启动它（受监督版本与可执行摘要绑定、环境允许清单、HOME/配置/缓存指向单次调用的临时身份域、沙箱只允许写干净检出与授权输出区）。宿主上下文的**自动注入**（memory、用户规则、插件、MCP、hooks、会话）由静态参数/环境事实机械切断（`CODEX_HOME`/`HOME`/`XDG` 重定向到干净临时域 + 临时域除预置认证外为空 + `--ignore-user-config`/`--ignore-rules`/`--disable` 全集）；每次验证前再跑一次引擎侧 canary 反测覆盖可动态观察的边界（越界**写**被拒、受控项目检查可执行、结构化回执可解析、预置凭据不外泄、进程与临时域收口）。诚实边界：Codex 的 `workspace-write` 沙箱只隔离写、**全盘可读**，因此不声称读隔离——Validator 为验收本就需要读检出与依赖，无界读输出由输出背压治理（见「超时保护」）。当前只有固定审计版本的 `codex` 满足该边界：`claude`/`cursor` 仍可完整运行 Builder，但进入验证阶段会按不可验证保留候选并以退出码 5 停止，不会静默降级回宽权限执行；换用 `npx coding-x codex` 重跑即可对已有候选做 validation-only 验收。验收凭证从 v3 起额外绑定 profile 与 canary 证据摘要；旧版本签发的凭证保持可读但不再构成当前通过，升级后首次运行会安全失效并重验（ADR-023、025）。
- **TDD 门禁（可选）**：启用 `prd.json.tdd` 后，Builder 按 `tdd` skill 对每个公共行为做真实 RED→同命令 GREEN→绿色重构；宿主 hook 在 agent commit 前提前检查，引擎仍在 Validator 前独立校验 Git 基线、政策摘要、新增覆盖忽略标记并运行项目原生 `coverageCheck`。hook 通过不能跳过引擎重跑；覆盖率证明代码被执行，不证明断言有效或历史上一定先写测试（ADR-017）。
- **可信目标绑定**：每轮 Validator 都收到一次性 request ID、精确 story、AC 快照/hash 和调用前 Git HEAD，必须提交版本化、逐 AC、自洽的结构化 claim。缺结果、旧结果、错 story/hash/commit、漏 AC、产物变化或改写 `state.json` 全部 fail closed，不签发凭证（ADR-015）。该协议消除正常控制流中的错目标/无结果假绿，但同权限 agent 仍能伪造观察，不能替代机械门禁和人审。
- **workspace 写入与 Git 隔离**：`.workspace/` 是运行时状态，不属于 story commit。`prd-to-json` 只在系统临时目录生成候选，再调用 `workspace apply-prd`；`/review-loop` 也只收集决定，再调用 `workspace record-review-decision`。两者都不直接改 workspace。Git 隔离检查仍只读，不会擅自修改 `.gitignore` 或 Git 索引。
- **状态所有权**：Developer 在开发目录运行，Validator 在精确提交的临时检出运行；两者都只通过原 workspace 接力状态。builder 只写候选 `passes`/进度，Validator 只写本轮 result 与可选截图 claim，所有 Validator verdict 状态和 `validated`/`escalated` 由引擎独占。指令模板用 `{{WORKSPACE}}` 注入路径，validation request 由引擎逐轮追加，三种 runner 共用同一协议。

---

## 安装

### 环境要求

- **Node.js ≥ 22**
- **Git ≥ 2.29**（正式本地验证需要；更旧版本会明确返回不可验证，不会退回浅历史）
- 已安装、已认证并可在终端调用 **`claude`**（Claude Code CLI）、**`codex`** 或 Cursor 的 **`agent`** / **`cursor-agent`**（取决于你用哪个 runner；验收凭证当前只能由固定审计版本的 `codex` 签发）

coding-x 正式支持 Linux、macOS 和 Windows。这里的“支持系统”与“CI 用什么机器”是两件事：
通用格式、安全扫描、候选构建和发布可以集中在 Ubuntu；目标项目只需验证自己真正部署或交付的系统，
不必无条件生成三套任务。

| 系统族  | 自动验证参考环境        | Node 证据 | 说明                                               |
| ------- | ----------------------- | --------- | -------------------------------------------------- |
| Linux   | Ubuntu 24.04 x64        | 22、24    | 同时运行 Linux 进程、挂载与文件身份专项检查        |
| macOS   | macOS 26 arm64          | 22、24    | 同时运行 macOS 进程与文件系统专项检查              |
| Windows | Windows Server 2022 x64 | 22、24    | Node 22 另跑标准用户下的原生 Job Object 与路径证明 |

npm 包只接受 `linux`、`darwin`、`win32`。表中环境是持续自动验证的参考配置，不等于每个发行版、
系统版本和处理器架构都已单独证明；Intel Mac、Linux arm64 和 Windows arm64 暂不写成“已验证”。
每个正式候选只在 Ubuntu 打包一次，随后同一个压缩包会在上述三类系统的全新目录中通过 npm 真实安装
并从 npm 创建的命令入口启动，三项全部成功后才允许进入 npm staging。
0.35.0 发布前，仍由 0.34.1 逐字核对的质量与政策流程暂时保留旧 runner 标签；新版本发布后的独立
政策更新会把这两个流程一并固定到表中的参考环境，避免候选版本先给自己签发正式通过。
POSIX 上的 AI runner 是不透明调用：受支持的 runner 自身可能正常地为内部命令创建独立 session 或
进程组，这不等同于目标项目恶意逃逸。runner 尚未启动时仍可用“从未启动”证明安全结束；已经启动后，
若因超时、用户中断、父进程关闭、输出通道故障、信号退出或观察到残留进程而无法证明其内部命令域
完整清空，coding-x 会永久隔离当前 workspace，并禁止自动开始下一轮。这个结果只证明 coding-x 不再
复用该 workspace，不表示未知的独立进程已经被杀死。普通项目命令继续使用 POSIX 进程组合同，Windows
继续使用 Job Object，行为不变。POSIX 的 `SIGINT` / `SIGTERM` 仍分别保留退出码 130 / 143。

插件和 runner 是两件事：**插件**让交互式 AI 知道怎样做需求对齐、PRD、review 等工作流；**runner**才是 `npx coding-x` 在自动循环中启动的 AI 命令行程序。只装其中一个不能代替另一个。

Windows v1 的 AI runner 必须是原生可执行文件，不能是 `.cmd/.bat` 包装器；如果 PATH 找到的是脚本，
请把下表对应的 `CODING_X_*_BIN` 指向该工具的原生程序。这个限制只针对 AI runner，不影响项目自己的
`npm.cmd` 测试、构建或其他质量检查。

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

# 正式运行只打印地址，不自动打开浏览器：
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
prd-generate ─────────────────────────────▶ docs/prds/prd-*.md
                                              │  正式意图真相源，进入 Git
                                              ▼
prd-to-json ──────────────────────────────▶ .workspace/prd.json
                                              │  本地执行派生物，不进入 Git
                                              ▼
npx coding-x ───────────────▶ Developer → 契约检查 → TDD 门禁 → Validator → 下一 story
                                              │
                                              ├─ state/progress/evidence/screenshots
                                              ├─ dashboard / status
                                              └─ report.html
                                              ▼
最终 Review ────────────────▶ Spec → 工程标准 → 风险触发的深度 Review
                                              │
                       ┌──────────────────────┴──────────────────────┐
                       │ 有阻断 finding                              │ Review 通过
                       ▼                                             ▼
/review-loop ─────────▶ 人工裁决；修复提交后重跑 coding-x     GitHub PR / CI / Ruleset
                                                                     │ ready
                                                                     ▼
人决定合并 ───────────────────────────────────────────────▶ /compound-docs（可选沉淀/显式归档）
```

---

## 什么时候用哪个步骤

| 你的情况                                            | 应该做什么                                                                                                         | 可以跳过什么                                                     |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------- |
| 第一次把 coding-x 接入某仓库                        | `/init-docs`，人工确认黄金原则，再 `/priming`                                                                      | 以后文档齐全时无需重复初始化                                     |
| 需求是口述、聊天记录、bug 和改版混在一起            | `scenario-alignment`                                                                                               | 需求边界已经清楚时可跳过                                         |
| 涉及数据库/schema、公开接口、状态机、权限、存量迁移 | 业务口径确认后执行 `technical-alignment`                                                                           | 纯页面文案或局部逻辑通常可跳过                                   |
| 需要一份别人拿到就能实施的技术路线                  | `/planning <功能>`                                                                                                 | 极小改动可跳过，但 PRD/AC 仍要清楚                               |
| 要进入自动执行                                      | `prd-generate` 生成正式 PRD，再用 `prd-to-json` 派生                                                               | 不能只拿 align/tech/plan 直接启动引擎                            |
| 要用测试驱动开发                                    | 在 `prd-to-json` 中明确启用 TDD，确认公共行为、覆盖命令与政策；由 `workspace apply-prd` 在受保护会话内重跑真实基线 | 不能把覆盖率当测试质量或先写测试的证明                           |
| 有 UI 验收                                          | 在 AC 中写清页面、操作、结果；环境有 `agent-browser` 时用它验证和截图                                              | 不能只写“页面正常”或只做 HTTP 冒烟                               |
| Story 全部验证，最终 Review 有 finding              | `/review-loop`，逐项修复、反证、延期或知悉                                                                         | 不能因 Validator 已通过而跳过最终 Review；不能用旧 Markdown 放行 |
| 功能已合并，需要更新长期知识                        | `/compound-docs`                                                                                                   | 没有可复用知识时允许零修改                                       |

---

## 文档与运行产物的完整流转

coding-x 的信息分三层保存：

1. **`docs/` 与 `AGENTS.md`：长期、可评审、应进入 Git。** 它们告诉人和未来 agent“项目现在是什么、这次想做什么”。
2. **`.workspace/`：当前执行的本地工作台，默认应被 Git 忽略。** 它保存机器状态、过程证据和报告，可以断点续跑，但不应混入产品提交。
3. **全局配置：跨项目复用。** 默认在 `~/.config/coding-x/config.json`，只保存允许使用的模型 ID。

### 长期项目文档：来源、去处和生命周期

| 产物                                    | 谁创建或更新                                              | 来源                                     | 谁会读取                              | 生命周期与去处                                                                                  |
| --------------------------------------- | --------------------------------------------------------- | ---------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `AGENTS.md`                             | `/init-docs`；以后人工维护索引                            | 代码结构、项目命令和硬约束               | 交互式 agent、Builder、Validator      | 长期入口，保持短小；细节下沉 `docs/`，进入 Git                                                  |
| `CLAUDE.md`                             | `/init-docs` 在缺失时创建                                 | `@AGENTS.md` 桥接                        | Claude Code                           | 长期薄文件；已有文件不会被覆盖                                                                  |
| `docs/architecture.md`                  | `/init-docs` 初始化，`/compound-docs` 按事实更新          | 当前代码结构、边界和数据流               | 规划、实现、审查                      | 长期 active 文档，结构变化时更新，不归档                                                        |
| `docs/golden-principles.md`             | `/init-docs` 提候选，人确认；后续谨慎维护                 | 项目最重要、可机械检查的规则             | `/planning`、Builder、`/review-loop`  | 长期 active；保持少量强规则，不作为历史日志                                                     |
| `docs/patterns.md` / `docs/glossary.md` | `/init-docs` 建骨架，`/compound-docs` 沉淀/去重           | 当前代码、Git、progress 中仍成立的经验   | 后续规划和实现                        | 长期 active；失效内容被改写、合并或删除                                                         |
| `docs/decisions/*.md`                   | 人或规划过程记录                                          | 重要架构取舍及理由                       | 后续设计与审查                        | ADR 长期保留；active/superseded/rejected 表示决策状态，不随普通收口删除                         |
| `docs/prds/align-*.md`                  | `scenario-alignment`                                      | 原始需求 + 代码/文档事实 + 人工业务裁决  | `technical-alignment`、`prd-generate` | 一次性业务对齐材料；正式 PRD 吸收后置 `superseded`，可显式归档                                  |
| `docs/prds/tech-*.md`                   | `technical-alignment`                                     | 已确认业务口径 + 当前架构 + 人工技术裁决 | `prd-generate`                        | 一次性技术合同材料；正式 PRD 吸收后置 `superseded`，可显式归档                                  |
| `docs/plans/*.md`                       | `/planning`                                               | 需求/对齐稿 + 代码调研 + 官方资料        | 人、实施 agent、`/review-loop`        | 实施路线参考；初始 `active`，实现已合并后置 `done`，可显式归档；**不替代 PRD**                  |
| `docs/prds/prd-*.md`                    | `prd-generate`；`prd-to-json` 只回写增强后的 User Stories | 对齐稿、计划或清楚的原始需求 + 人工回答  | `prd-to-json`、人审、后续需求变更     | **意图真相源**；初始 `active`，全部 story 通过且合并后置 `done`；需求变化时重新 active 并再派生 |
| `docs/specs/*.md`                       | 项目自行采用的设计过程或其他工具                          | 功能设计                                 | 规划、实现、审查                      | coding-x 当前没有专门生成它的 command；有则按 active/done 管理，可显式归档                      |
| `docs/archive/`                         | `/compound-docs` 在人明确授权后移动                       | 已完成或被替代的任务型文档               | 只在追溯历史/修断链时读取             | **Git 内冷档案**；不再作为日常当前事实，不留旧路径副本                                          |

`docs/` 任务文档的 frontmatter 常用状态：

| 状态         | 含义                                          | 下一步                                     |
| ------------ | --------------------------------------------- | ------------------------------------------ |
| `active`     | 当前仍生效、待实现或待完成                    | 保留在 active 区继续维护                   |
| `done`       | 已有完成证据；PRD 要求 story 全通过且已经合并 | 可保留，也可在人授权后移入 `docs/archive/` |
| `superseded` | 内容已被后继文档吸收或取代                    | 标明替代者，可在人授权后归档               |
| `rejected`   | 方案评估后明确不做，常用于 ADR                | 保留作为先例，避免重复讨论同一提案         |

“改成 done”和“移动到 archive”是两件事：前者是状态裁决，后者是路径变化。`/compound-docs` 可以根据证据更新状态，但没有“物理归档”授权时只列候选，不会移动文件。

### `.workspace/`：来源、用途和去处

| 产物                     | 何时产生                                                                 | 谁写 / 谁读                                                                            | 用途                                                         | 生命周期与去处                                                                               |
| ------------------------ | ------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- | ------------------------------------------------------------ | -------------------------------------------------------------------------------------------- |
| `prd.json`               | `prd-to-json` 根据正式 PRD 准备临时候选，`workspace apply-prd` 原子应用  | apply 命令写；引擎/agent 读；运行期由引擎冻结保护                                      | 本轮可执行 story、AC、分支、普通/TDD 门禁和可选模型路由      | 当前功能的执行需求；需求或 TDD 政策改变时从源 PRD 再派生，**不要直接改**                     |
| `state.json`             | 引擎首次运行自动创建；apply 命令在同功能再派生时按 story ID 应用候选     | Builder 只写候选 `passes`；最终 verdict、重试、blocked、validated/escalated 由引擎控制 | 当前执行状态和人工仲裁 notes                                 | 断点续跑依据；新功能切换时旧副本由 apply 命令归档                                            |
| `progress.md`            | `workspace apply-prd` 初始化/切换功能时写入新 header；Builder 逐轮追加   | apply 命令与 Builder 写；后续 Builder 和 `/compound-docs` 读                           | 跨无记忆轮次传递实现进度、模式和陷阱                         | 过程上下文，不是完成证据；切换功能时由 apply 命令归档，同功能再派生保留                      |
| `evidence.jsonl`         | 引擎运行时逐行追加；agent 可登记截图                                     | 引擎与 agent 写；status/report 读                                                      | 门禁、轮次、调用、验收 claim、协议裁决、截图索引             | append-only 过程索引；再派生会清理当前副本并归档旧副本                                       |
| `validation-result.json` | 每次 Validator 调用临时生成                                              | Validator 写；引擎读取后删除                                                           | 单轮结构化验收 IPC                                           | **瞬时文件**；不作为长期状态，也不归档                                                       |
| `screenshots/`           | UI 的最终 Builder/Validator 验证时产生                                   | agent 写；report 读                                                                    | 可视化验收工件                                               | 与本轮 workspace 一起保留/归档；分享报告时要连同该目录                                       |
| `report.html`            | 每次循环结束自动生成；`coding-x report` 可重建                           | 引擎/CLI 写；人读                                                                      | 汇总 story、AC、状态、证据、截图、review 和红旗              | 生成时重新核对 Review 当前性；无法核对或已过期时不会显示交付就绪；它不是新的真相源           |
| `final-review.json`      | 全部 Story 验证后由引擎写                                                | 引擎写；status/report 和 `/review-loop` 读                                             | 保存当前 PR/head、规则、runner、风险和三层 Review 结果       | 任一绑定输入变化即失效；本地状态，不是 GitHub 共享凭证                                       |
| `final-review.md`        | 与结构化最终 Review 同时生成                                             | 引擎写；人读                                                                           | 方便阅读 findings                                            | 只是阅读副本，编辑它不能改变裁决状态                                                         |
| `review-decisions.json`  | `/review-loop` 获得用户明确决定后调用 `workspace record-review-decision` | 引擎核对并写；`/review-loop` 只读；引擎/doctor 读                                      | 当前完整 Review 语境下的反证、修复授权、P1 延期或低等级知悉  | 由引擎绑定 finding ID、完整 Review binding、head SHA 和时间；任一语境变化后必须重跑 coding-x |
| `review-*.md`            | 旧版本 `/review-loop` 可能遗留                                           | report 只读展示                                                                        | 历史本地反馈                                                 | 已弃用；被 Git 忽略，不能作为通过证明或共享记录                                              |
| `workspace-safety.json`  | `coding-x init` 或 `workspace init` 首次初始化                           | coding-x 写并核对                                                                      | 把目录身份与安全协议绑定                                     | 初始化后永久保留；缺失、过新或不匹配时所有正式写入口拒绝                                     |
| `engine.lock/`           | workspace 初始化时安装永久协议根；写命令开始时创建内部活动 lease         | coding-x 独占管理                                                                      | 统一 run、repair、report、PRD 应用和 Review 裁决的单写者边界 | 协议根永久保留；正常结束只移走活动 lease；异常时显式 recover/resume，不能手删                |
| `prd.tampered-*.json`    | 引擎发现运行期 PRD 被修改时产生                                          | 引擎写；review/report/人读                                                             | 保存被检测到的篡改版本，当前 PRD 会按启动快照恢复            | 红旗取证；切换功能时随旧运行归档并清出当前根目录                                             |
| `archive/<日期-功能>/`   | 新功能覆盖旧 workspace，或同功能需求再派生时                             | `workspace apply-prd` 按固定清单原子创建                                               | 保存旧运行/旧 AC 对应的本地状态和证据                        | **本地运行档案**；与 Git 内 `docs/archive/` 完全不同；当前版本不自动清理                     |

`.workspace/` 不是缓存目录：`report.html` 可以重建，但 `state.json`、progress、review、截图和历史证据可能没有其他副本。不要像删除 `dist/` 那样随手删除整个 workspace；要换功能时重新执行 `prd-to-json`，由 `workspace apply-prd` 按固定规则归档。

### 全局模型目录

`~/.config/coding-x/config.json`（或 `CODING_X_CONFIG` 指定的文件）位于目标项目之外，供多个项目复用。它只声明“允许传给某个 runner 的模型 ID”，不保存 API key、账号或 provider 地址，也不证明模型当前可用。初次使用不需要配置模型路由；只有要按 story 难度选择模型时才需要它。

### 一条需求如何被追踪到底

1. 正式 PRD 中的 `US-001` 等 ID 一旦分配就保持稳定；删除后也不回收编号。
2. `prd-to-json` 把仓库内源 PRD 的相对路径写进 `prd.json.sourcePrd`，并把增强/拆分后的最终 stories 回写源 PRD，同时展示转换对照表。
3. `state.json` 用同一个 story ID 保存执行状态；引擎给 Validator 的 request 还绑定 AC 快照/hash、一次性 request ID 和调用前 Git HEAD。
4. Developer 默认每个 story 单独提交；`evidence.jsonl` 分别记录 `source=validator` 的声明和 `source=engine` 的机械观察/协议裁决。
5. 最终 Review 绑定 PR/base/head、PR 意图、Spec、默认分支工程规则、质量契约、runner/model 和风险结论；任一项变化都会失效。
6. `/review-loop` 的结构化决定绑定 finding ID、同一个 head SHA 和完整 Review binding。即使提交不变，
   PR 意图、base、Spec、工程规则或 Runner 变化也会让旧决定失效；授权修复后必须提交并重新运行。
7. `report.html` 把上述材料分栏展示。workspace 只是本地工作台；共享交付记录以 GitHub 检查与 PR 历史为准。

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
   - 确认并原样保留本次 workspace 路径；只读检查它是否被 Git 忽略、是否已有运行文件被跟踪，异常时交给你决定，不擅自改 `.gitignore` 或 Git 索引；
   - 把模糊 AC 改成可执行断言、拆分过大 story、补闭环 story，并把最终 User Stories 回写仓库内源 PRD；
   - 询问是否启用 TDD；启用时确认新项目/存量项目、真实覆盖命令、生产路径、政策文件、Git 基线与禁止标记；最终应用时由 coding-x 在受保护会话内重跑真实基线；
   - 在会话里展示“源 story → 执行 story → 变化”的对照表；
   - 把候选和请求放在系统临时目录，通过 `coding-x workspace apply-prd` 一次完成旧运行归档与新候选应用；skill 本身不直接写 workspace。
7. **人工检查三个结果**：源 PRD 的变化、转换对照表、`npx coding-x doctor` 的结论。有异议就改源 PRD 并重新转换，不要直接改 JSON。

#### 看懂 `prd.json`（通常不需要手写）

下面的 JSON 只帮助你理解字段；正常流程应由 `prd-to-json` 生成：

```jsonc
{
  "project": "我的项目",
  "branchName": "ralph/my-feature",
  "sourcePrd": "docs/prds/prd-my-feature.md", // 意图真相源（源 PRD）路径，冲突时以它为准重新派生
  "qualityContractDigest": "sha256:<当前质量契约摘要>",
  "qualityChecks": {
    // 由 doctor 输出原样派生，不能手写另一套
    "test": {
      "checks": [
        {
          "id": "tests",
          "module": "root",
          "command": {
            "executable": "npm",
            "args": ["test", "--", "--run"],
            "cwd": ".",
            "platforms": ["linux", "macos", "windows"],
            "timeoutMs": 600000,
          },
        },
      ],
    },
    "build": { "notApplicable": "本项目没有构建步骤" },
    "static": { "notApplicable": "本项目没有独立静态检查" },
    "security": { "notApplicable": "本项目没有第三方生产依赖" },
  },
  "tdd": {
    // TDD 门禁整段可选；出现时五个字段必须完整
    "coverageCheck": "node scripts/tdd-coverage-gate.mjs",
    "sourcePathspecs": [":(glob)src/**"], // 用户批准的生产代码 Git 范围
    "policyFiles": [
      {
        "path": "scripts/tdd-coverage-gate.mjs",
        "sha256": "<当前文件的 64 位小写 SHA-256>",
      },
    ],
    "baselineRef": "<启用时的完整 Git commit id>",
    "forbiddenAddedPatterns": ["istanbul ignore", "c8 ignore"],
  },
  "models": {
    // 模型路由整段可选；一旦启用必须完整
    "runner": "codex", // claude | codex | cursor，绑定单一 runner
    "builder": {
      "low": "model-a", // 低难度 story 初始模型
      "medium": "model-b", // 中难度 story 初始模型
      "high": "model-c", // 高难度 story 初始模型
    },
    "validator": "model-d", // validator 恒定模型
    "escalation": "model-e", // 首次有效失败后的 builder 专用模型
  },
  "description": "...",
  "userStories": [
    {
      "id": "US-001",
      "title": "用户可以新建笔记",
      "description": "...",
      "acceptanceCriteria": ["Typecheck passes", "在浏览器中点击新建按钮能创建笔记"],
      "priority": 1, // 数字越小越优先
      "difficulty": "medium", // 启用 models 时每个 story 必填：low | medium | high
      "difficultyReason": "命中 medium-1：需协调多个现有模块。",
    },
  ],
}
```

#### 看懂 `state.json`（不要手工推进状态）

`state.json` 由引擎在首次正式运行时生成；同一功能重新派生时，apply 命令会按稳定 story ID 应用候选状态。旧版含状态字段的 prd.json 只供 status/dashboard 直接回看；report 仅能在已经完成新版安全初始化的 workspace 中解释这种形状，不能为旧版非空 workspace 重新生成报告。正式运行不自动迁移：

```jsonc
{
  "US-001": {
    "passes": false, // builder 完成后置 true；只是待验证的候选结果
    "validated": false, // 结构化 claim 通过全部绑定/不变式后由引擎置 true；agent 不得改写
    "notes": "", // 引擎写验证失败原因；builder 仲裁标签会被机械路径保全
    "retryCount": 0, // 引擎确认的门禁/Validator failed 次数
    "blocked": false, // 引擎累计失败 5 次后置 true；builder 也可配合仲裁显式置位
    "escalated": false, // 首次有效失败后由引擎置 true；agent 不得改写
  },
}
```

引擎每轮选择 `priority` 最高、尚未同时满足 `passes && validated` 且 `blocked: false` 的 story（状态读自 `state.json`）。

> **验收凭证迁移：** 新状态用 `validated` 区分“builder 声称完成”和“引擎已观察 Validator 正常完成”。旧 state 缺少该字段时只保留实现候选，不再补造当前凭证。显式的 `passes=true, validated=false` 是稳定的待重验状态：它不会被算作通过；Validator 环境或结果不可验证时保留候选并返回 5，只有确定的机械失败或合法 `failed` claim 才清除候选。

> **结构化验收协议：** 所有新 Validator 轮次都必须提交 `validation-result.json` v1；不再从 `progress.md` 猜 story，也不再直接改 `state.json`。引擎签发的 Validator receipt 使用 v2，除 request/story/AC/Git HEAD 外还绑定干净验证环境摘要；v1 receipt 继续可读，但一律按过期处理并重新验证。Git HEAD 或受支持的干净检出无法证明时，正式运行失败关闭，不会伪装成完整产物绑定。

#### 可选进阶：TDD

TDD 的开发顺序由 `tdd` skill 指导：

1. 一次只选一个公共可观察行为，先写聚焦测试；
2. 真实运行并确认失败原因正是行为尚未实现；语法、依赖、路径或环境错误不算 RED；
3. 写最小实现，用完全相同的聚焦命令取得 GREEN；
4. 只在 GREEN 后重构，每步重跑；
5. 全部行为完成后运行项目级 `coverageCheck`。

`prd-to-json` 会让你一次确认完整政策；`workspace apply-prd` 在受保护会话内真实重跑基线，失败时
不会应用候选。默认建议是：新项目行覆盖率和分支覆盖率都不低于 90%；存量项目总体行/分支不
低于启用基线，新增或改动的可执行行不低于 90%；两类都必须让零测试失败。项目可以采用其他
政策，但必须在启用前由人明确批准。coding-x 会核对 Git 基线、政策文件和禁止标记，但不会猜测
不同测试工具的输出格式；`coverageCheck` 自己必须用退出状态表达零测试、覆盖不足或政策失败。

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
    "claude": [{ "id": "sonnet", "label": "Sonnet" }],
    "codex": [{ "id": "gpt-5.6-codex", "label": "GPT-5.6 Codex" }],
    "cursor": [{ "id": "composer-2.5", "label": "Composer 2.5" }]
  }
}
```

目录表达的是“用户允许 coding-x 选择或传给该 runner 的模型 ID”，**不是模型在当前账号、provider、配额和网络下实时可用的证明**。coding-x 不把账号、密钥、base URL、中转站或 runner 配置写入该文件；真实可用性只会在实际 agent 调用时体现。

`prd-to-json` 在用户选择 runner 后调用 `coding-x models <runner> --json` **只读该目录**，将候选展示一次，再让用户分别选择 low/medium/high builder、validator 和 escalation。目录缺失或非法时可先维护配置后重试，也可明确不启用模型路由并继续普通转换；不能用会话内临时 ID 绕过。

### 第 2 步：运行引擎

先确认终端当前目录是目标项目根目录，然后运行：

```bash
npx coding-x doctor
npx coding-x codex      # 使用 Codex；也可以换成 claude 或 cursor
```

启动后会依次发生：引擎获取 workspace 的活动写租约 → 读取/初始化状态 → 预检 runner 与模型 → 启动仪表盘 → 每轮在受管范围内启动一个 Builder → 运行机械门禁 → 启动一个 Validator → 引擎写入裁决 → 继续下一个 story。全部 Story 验证完成后，引擎会重跑完整机械检查、执行本地最终 Review，再查询 GitHub PR、CI 与 Ruleset；只有三部分都就绪才返回 0。Builder 会按 PRD 的 `branchName` 检查、创建或切换功能分支，并按 story 提交代码。

可以按 `Ctrl+C` 中止。正常收口后稍后重跑，已验证 story 会保留；如果中断留下未完成活动状态，不要手删 `engine.lock/` 或直接重开，先运行 `doctor` / `status` 查看分类。只有可恢复分类才按提示使用 `workspace recover` 或 `workspace resume-mutation`；若 POSIX AI runner 已启动后被中断并进入永久隔离，不能恢复或自动开始下一轮。继续前还要独立确认旧进程不会再影响原项目目录；无法确认时改用新的隔离项目检出或重启主机，再创建新的空 workspace。

下面是完整命令示例；新项目先完成 `init`，日常主要关心 `doctor`、一个 runner、`status` 和
`report`：

```bash
npx coding-x --help             # 显示完整命令与参数后退出，不读取 workspace 或启动 runner
npx coding-x init               # 交互确认后分阶段配置质量契约、原生 CI 和 GitHub 门禁
npx coding-x init --contract quality.json  # 使用已人工确认的契约候选文件
npx coding-x init --contract quality.json --yes  # 非交互使用已人工确认的契约并接受已展示的变更
npx coding-x workspace init --workspace ./run  # 只初始化一个新的空 workspace
npx coding-x workspace apply-prd --input /path/to/system-temp/request.json --workspace ./run
                                # 原子应用 prd-to-json 已确认的临时候选
npx coding-x workspace apply-prd --shadow --json --input /path/to/request.json --workspace ./run
                                # 固定候选专用；成功为 applied-shadow/退出 7，不能表示正式应用
npx coding-x workspace record-review-decision --input /path/to/system-temp/decision.json --workspace ./run
                                # 让引擎核对并记录一次 Review 裁决
npx coding-x workspace recover --workspace ./run
                                # 恢复已证明安全的中断运行
npx coding-x workspace resume-mutation --workspace ./run
                                # 继续已验证的 apply-prd / repair 操作
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
npx coding-x --builder-model model-a --validator-model model-d  # 临时覆盖初始 builder / validator
npx coding-x --escalation-model model-e  # 临时覆盖升级 builder 模型
npx coding-x dashboard --no-open # 离线仪表盘不自动打开浏览器
npx coding-x --workspace ./run  # 指定 prd.json / state.json / progress.md 所在目录
npx coding-x --keep-open        # 跑完后保留仪表盘，按 Ctrl+C 退出（退出码不变）
npx coding-x --shadow           # 候选版本真实 Dogfood；成功也固定返回 7，不表示可交付
npx coding-x --stall-limit 5    # 已权威结算的 Developer 空转/超时/异常退出连续达 5 次才熔断（缺省 3）
npx coding-x repair             # 在短租约内修复 workspace 的 prd.json 与 state.json（不跑循环）
npx coding-x dashboard          # 不跑循环，随时离线回看仪表盘
npx coding-x status             # 终端一屏速览实现、最终 Review 与 GitHub 交付状态；0 才表示三者均就绪
npx coding-x status --json      # 同上，stdout 输出单个 JSON 对象供脚本与 agent 消费
npx coding-x doctor             # docs/、workspace Git 隔离等健康检查（硬错误以退出码 1 结束）
npx coding-x doctor --json      # 单个 JSON；含契约摘要及 PRD 应原样冻结的结构化检查快照
npx coding-x doctor --shadow --json # 固定候选准备检查；健康也返回 shadow/退出 7
npx coding-x doctor --local     # 只做本地检查；供项目 CI 使用，避免反向依赖 GitHub 状态
npx coding-x doctor --stale-days 14  # 新鲜度阈值改为 14 天（缺省 30）
npx coding-x report             # 在短租约内（重）生成 report.html；state 损坏时产出红色诊断报告并退出 1
```

### 第 3 步：查看实时进度

正式运行会打印仪表盘地址：<http://localhost:7331>（像素风视图 `/p`），但在持有 workspace 活动租约时不会另启系统命令打开浏览器。独立的 `npx coding-x dashboard` 没有活动写会话，仍会尝试自动打开；可用 `--no-open` 关闭。仪表盘展示迭代次数、当前阶段、story 难度/升级态、完整配置映射，以及当前阶段实际命中的模型与路由来源（CLI/难度/升级/默认）。

仪表盘是本次运行的本地进度视图，不会持续查询 GitHub，也不会在页面保持打开期间重新核验延期 Issue。它显示“本次运行已完成”只代表保存的本地结果仍绑定当前提交；是否真正可交付始终以重新运行 `npx coding-x status`（或生成最新 report）的结果为准。

- **只想快速知道完成了多少**：`npx coding-x status`。
- **引擎没在运行但想看仪表盘**：`npx coding-x dashboard`，看完按 `Ctrl+C`。
- **需要逐条 AC、截图、门禁、调用和 Review 状态**：打开 `.workspace/report.html`；它会把 Story、本地 Review 和 GitHub 交付分开显示。
- **不要只看 `passes=true`**：story 真正有效通过必须同时满足 `blocked=false`、`passes=true` 和 `validated=true`。

### 第 4 步：最终 Review 与人工裁决（正式流程）

全部 Story 验证完成后，引擎先重新运行完整机械检查，再自动执行三个相互隔离的判断：Spec 是否实现正确、工程标准是否满足，以及高风险改动是否存在更深的结构问题。没有 PR、缺少必填意图、分支落后、模型隔离不可靠或上下文无法完整覆盖时都会停止，不能用普通 diff 审查降级放行。

没有阻断 finding 时，引擎继续核验当前 PR 最新提交对应的 GitHub CI 与 Ruleset；远端为 `ready` 才返回 0，尚未就绪返回 6。最终 Review 返回 4 时才需要运行 `/review-loop`。它读取当前提交的 `.workspace/final-review.json`，一次解释一个待处理 finding，并等待你选择：

- **授权修复**：只在你明确授权后修改；提交后重新运行 `coding-x`，旧 Review 和旧决定立即失效。
- **提交反证**：给出可复核事实；“误报”“接受风险”不算反证。
- **P1 延期**：关联开放 Issue，写全负责人、原因、到期日和跟进事项；`doctor` 会检查是否过期。
- **知悉**：只适用于 P2 或 Info，不能解除 P0、P1 或产品/架构决策阻断。

`/review-loop` 只在系统临时目录准备最小决定请求，再调用 `workspace record-review-decision`；引擎会在
开始和写入前重新核对当前提交、PR 意图、base、Spec、工程规则、Review、Runner、finding 和延期
Issue，绑定请求中的操作者标识，并由引擎填入完整 Review binding、head 与时间后写入
`review-decisions.json`。它不会直接编辑
workspace，也不会自动推送、合并、创建标签或发布；正式交付结论仍由重新运行的引擎结合最新提交与
GitHub 状态给出。

### 第 5 步：收口沉淀（可选）

推荐在功能合并后、发布前，回到 Claude Code 等工具运行 `/compound-docs`。它基于**当前代码优先**，再与 Git、`progress.md`、本轮 PRD 交叉取证，把仍成立的结构变化、稳定约定和高频陷阱分层沉淀进 `docs/`；过程故事、一次性事故和已经失效的说法不会被当成长期知识。

默认只处理本轮影响范围，并执行 active 知识的增量熵 GC、任务文档状态收尾和取舍账本汇总：

- 明确说“全量 GC”才逐条审计全部 patterns/glossary/architecture/golden-principles/prompt-writing。
- 明确说“物理归档”，或在它展示候选后再次确认，才移动 `done/superseded` 的 PRD、plan、spec 等到 `docs/archive/`。
- 它只允许修改文档，不会顺手修代码；证据不足时允许零修改或列为待拍板。

### 命令行参数

| 参数                                            | 默认值       | 说明                                                                                                                                                                                                                                                                       |
| ----------------------------------------------- | ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 位置参数 `help` / `-h, --help`                  | —            | 输出完整用法并退出 0；可放在子命令后（如 `config --help`），不读取 workspace、不获取锁、不启动 runner/dashboard                                                                                                                                                            |
| 位置参数 `claude` / `codex` / `cursor`          | —            | 显式选择 runner；若 PRD 启用了模型路由，必须与 `models.runner` 一致。未显式指定时优先用 `models.runner`，否则默认 claude                                                                                                                                                   |
| 位置参数 `init`                                 | —            | 先初始化新的空 workspace，再在功能分支分阶段初始化质量门禁：回读确认 GitHub 最小规则后生成质量契约、原生 CI 和模板；PR 最新提交出现可信检查后才加入 Ruleset。不会自动提交、推送、开 PR 或合并；未完成返回 6，配置或远端错误返回 2                                          |
| 位置参数 `workspace init`                       | —            | 只初始化新的空 workspace，安装永久安全协议；已正确初始化时幂等返回，旧版、非空但未初始化或损坏目录会拒绝                                                                                                                                                                   |
| 位置参数 `workspace apply-prd`                  | —            | 获取短租约并应用 `--input` 指定的已确认 PRD 候选；请求必须位于 workspace 外，输入失效、TDD 基线失败或租约不可用时不写业务文件；固定候选可显式加 `--shadow`，只放宽版本差异并以 `applied-shadow`/7 返回                                                                     |
| 位置参数 `workspace record-review-decision`     | —            | 获取短租约，重新核对当前提交、Final Review、finding、现有决定和延期 Issue，再记录 `--input` 中的用户裁决；请求不能自带提交、时间或目标路径                                                                                                                                 |
| 位置参数 `workspace recover\|resume-mutation`   | —            | 分别恢复已证明安全的中断运行，或继续已验证但未完成的 apply-prd / repair；中断的 shadow apply 会从受保护记录恢复候选身份并继续返回 7，不做 PID 猜测式自动接管                                                                                                               |
| 位置参数 `config path\|init\|validate`          | —            | 查看全局配置路径、排他创建空模板或只读严格校验；均不启动 runner，不获取 workspace 锁                                                                                                                                                                                       |
| 位置参数 `models [claude\|codex\|cursor]`       | —            | 只读查询全局模型目录；不启动 runner、不检查认证、不访问网络；可配 `--json`                                                                                                                                                                                                 |
| 位置参数 `hooks cursor install\|status\|remove` | —            | 在当前 Git 项目安全安装、只读检查或卸载 Cursor TDD 提交前检查；只管理 `.cursor/` 中 coding-x 拥有的内容，不改 Git hooks、索引或提交。install/remove 成功与 status 健康返回 0；缺失、冲突或过期返回 1                                                                       |
| 位置参数 `repair`                               | —            | 获取短租约，修复 `<workspace>/` 下的 prd.json 与 state.json 后退出；活动租约或未完成恢复会拒绝                                                                                                                                                                             |
| 位置参数 `dashboard`                            | —            | 不跑循环，仅启动仪表盘离线查看 workspace 状态；state 文件缺失兼容旧格式，存在但损坏时全部按未验证显示并警告                                                                                                                                                                |
| 位置参数 `doctor`                               | —            | `docs/` 知识库健康检查（frontmatter、`updated`、AGENTS.md 索引、相对链接；`docs/archive/` 仍查结构/链接但跳过新鲜度）、机械门禁、全局模型目录/PRD 映射与 workspace Git 隔离核对；未忽略/已跟踪只建议且不自动改仓库；普通错误退出 1，显式 shadow 且其余健康时退出 7         |
| 位置参数 `status`                               | —            | 终端速览 story、最终 Review 与 GitHub 交付状态，并显示重试/仲裁、实际模型路由和最近 validation target/protocol/error；损坏 state 全部按未验证，`--json` 增加 `recentValidation` 并标 `stateCorrupted`；退出码见下方独立表格                                                |
| 位置参数 `report`                               | —            | 在同一短租约内核对最新 Review、Runner 与 GitHub 状态并（重）生成 `<workspace>/report.html`；观察后状态变化、无法核对或结果过期时报告不会显示交付就绪。循环结束复用 run 租约并从冻结 PRD 快照自动生成；退出码 0=可信状态下已生成 / 1=写入失败或 state 损坏 / 2=无可读工作区 |
| `--max-iter <n>`                                | `50`         | 最大迭代轮数                                                                                                                                                                                                                                                               |
| `--dev-timeout <分钟>`                          | `30`         | 单轮开发阶段超时（分钟）                                                                                                                                                                                                                                                   |
| `--val-timeout <分钟>`                          | `60`         | 单轮验证阶段超时（分钟）                                                                                                                                                                                                                                                   |
| `--builder-model <id>`                          | —            | 本次运行的初始 builder 覆盖；优先于 `models.builder[story.difficulty]`，但不压过已触发的专用 escalation 路由                                                                                                                                                               |
| `--validator-model <id>`                        | —            | 本次运行的 validator 覆盖；优先于 `models.validator`                                                                                                                                                                                                                       |
| `--escalation-model <id>`                       | —            | 本次运行的升级 builder 覆盖；仅在 `state.escalated=true` 时生效，优先于 `models.escalation`                                                                                                                                                                                |
| `--workspace <dir>`                             | `.workspace` | 所有 workspace 命令共享的唯一路径输入，可放在嵌套子命令前后但只能出现一次；相对路径、绝对路径和同目录别名会解析到同一身份                                                                                                                                                  |
| `--no-open`                                     | 关闭         | 仅对独立 `dashboard` 生效；不自动打开浏览器。正式 run 始终只打印地址                                                                                                                                                                                                       |
| `--keep-open`                                   | 关闭         | 运行结束后保留仪表盘直到 Ctrl+C（保留循环的真实退出码）                                                                                                                                                                                                                    |
| `--port <n>`                                    | `7331`       | 仪表盘端口；必须是 0–65535 的十进制整数，0 表示由系统选择可用端口                                                                                                                                                                                                          |
| `--stall-limit <n>`                             | `3`          | 仅 `run`（位置参数 `codex` 同属 `run`，同样适用）：已取得权威结算证明的 Developer no-op 空转、超时或异常退出连续达到 n 次即提前终止（退出码 1），避免无人值守时死循环空跑；结构化 Validator 异常与 `operation-proof-missing` 都立即停止、不计入 stall；必须是正整数                                      |
| `--stale-days <n>`                              | `30`         | 仅 `doctor`：active 区文件的 git 最后提交日期晚于 frontmatter `updated` 超过 n 天判为过期；`0` 表示晚一天即过期，`docs/archive/` 冷档案不参与                                                                                                                              |
| `--contract <file>`                             | —            | 仅 `init`：读取仓库内已经人工确认的契约候选；不能读取仓库外路径                                                                                                                                                                                                            |
| `--input <file>`                                | —            | 仅 `workspace apply-prd` / `workspace record-review-decision`：读取 workspace 外的严格 UTF-8 JSON 请求；不能把请求放进目标 workspace                                                                                                                                       |
| `--yes`                                         | 关闭         | 仅 `init`：接受命令已经展示的远端和文件变更；必须同时提供人工确认过的 `--contract`，不会替用户选择平台或填写不适用理由                                                                                                                                                     |
| `--local`                                       | 关闭         | 仅 `doctor`：不查询 GitHub，只检查本地契约、派生快照、文档和 workspace；用于项目原生 CI                                                                                                                                                                                    |
| `--json`                                        | 关闭         | `init`、`workspace`、`doctor`、`status`、`models` 输出单个 JSON 对象；交互提示不写入 JSON stdout                                                                                                                                                                           |
| `--shadow`                                      | 关闭         | 只供固定候选 Dogfood，且只允许用于 run、doctor、`workspace apply-prd`；健康固定退出 7，不能表示正式通过；真实失败仍保留原失败码，其他子命令会拒绝该参数                                                                                                                    |
| `--review-model <id>`                           | —            | 最终 Review 的精确模型 ID；不能使用 runner 默认值，因为结果必须能绑定并复现实际模型                                                                                                                                                                                        |

### `status` 子命令退出码

| 退出码 | 含义                                                              |
| ------ | ----------------------------------------------------------------- |
| `0`    | 全部 Story 已有效通过、本地最终 Review 已通过且 GitHub 交付 ready |
| `1`    | Story 未完成、state 损坏或 PRD 没有 Story                         |
| `2`    | workspace 安全状态未就绪/不可读，或最终 Review 状态损坏           |
| `3`    | 存在 `blocked` Story                                              |
| `4`    | 最终 Review 有待人工处理的 finding                                |
| `5`    | Validator 或最终 Review 无法可靠验证                              |
| `6`    | 最终 Review 未完成、已失效，或 GitHub CI / Ruleset 未就绪         |
| `7`    | shadow 已完成，但不能表示可交付                                   |

### 默认运行退出码

默认命令（`run`，即无 `init`/`repair`/`dashboard`/`doctor`/`status`/`report`/`models`/`config`
位置参数时；位置参数 `claude`/`codex`/`cursor` 只切换 runner，仍属 `run`，退出码规则相同）
循环结束的进程退出码：

| 退出码 | 含义                                                                       |
| ------ | -------------------------------------------------------------------------- |
| `0`    | 实现验证、本地最终 Review 和 GitHub 交付条件均已就绪                       |
| `1`    | 机械检查或执行失败；包括最大轮次、连续无进展或普通未完成                   |
| `2`    | 配置、质量契约、固定版本、状态或 workspace 锁无效                          |
| `3`    | 存在 `blocked` Story，等待人工处理                                         |
| `4`    | 最终 Review 存在待人工处理的 finding                                       |
| `5`    | Validator 或最终 Review 无法可靠验证，例如结果缺失、模型异常、上下文不完整或 Runner 宿主隔离无法证明（含 `claude`/`cursor` 作为 Validator、未审计的 runner 版本与 canary 反测未通过） |
| `6`    | 本地已完成，但 PR、GitHub CI 或 Ruleset 尚未就绪                           |
| `7`    | shadow 运行完成；只表示候选验证跑完，永远不能表示可交付                    |

`init`/`workspace`/`repair`/`doctor`/`status`/`report`/`models`/`config`/`hooks` 等子命令的退出码语义各自独立，见上方参数表对应行说明。

这里的“无法验证”表示代码结论不可信，但进程与临时目录已经安全收口。若连 workspace containment、临时检出拓扑或安全清理都无法证明，仍属于 workspace 安全故障并返回 `2`，不能降级成 `5`。

### 环境变量

| 变量                  | 说明                                                                       |
| --------------------- | -------------------------------------------------------------------------- |
| `CODING_X_CONFIG`     | 覆盖全局模型配置的完整文件路径；相对路径按当前目录解析，空白值按未设置处理 |
| `CODING_X_CLAUDE_BIN` | 覆盖 `claude` 可执行文件路径；Windows 必须指向原生程序                     |
| `CODING_X_CODEX_BIN`  | 覆盖 `codex` 可执行文件路径；Windows 必须指向原生程序                      |
| `CODING_X_CURSOR_BIN` | 覆盖 Cursor `agent` / `cursor-agent` 路径；Windows 必须指向原生程序        |

---

## Commands 与 Skills 生命周期

先区分两类入口：

- **Command**：你显式输入 `/命令`，启动一套有固定步骤的工作流。
- **Skill**：你用自然语言表达意图后，AI 工具按语境选用；为了避免误触发，也可以直接说出 skill 名和目标文件。

它们负责准备、检查和收口，**不会因为生成了 PRD 就自动启动引擎**。真正开始无人值守 Developer/Validator 循环的入口始终是终端里的 `npx coding-x`。

### Commands（用户显式触发）

| 命令                   | 何时使用 / 输入                                                | 会读取什么                                                        | 会产出或修改什么                                                                                                          | 生命周期与下一步                                                                                     |
| ---------------------- | -------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `/priming`             | 新会话开始、AI 不了解项目时；无需参数                          | Git 文件/状态/近期提交、README/AGENTS/docs、配置和关键源码        | 只在当前对话输出项目概览，默认不落盘、不改代码                                                                            | 会话级临时上下文；换会话可重跑，完成后继续需求对齐或任务处理                                         |
| `/init-docs`           | 一个仓库第一次建立 AI 知识入口时                               | 项目形态、配置、目录、技术栈；monorepo 候选需人确认               | 只创建缺失的 `AGENTS.md`、`CLAUDE.md` 和 docs 骨架；已有文件不覆盖                                                        | 基线初始化；可幂等重跑补缺，之后人工确认黄金原则/占位并由 `/compound-docs` 持续维护                  |
| `/planning <功能描述>` | 编码前需要完整技术路线时；输入可为原始需求或 align/tech 对齐稿 | 项目文档、相关代码/测试、官方资料和黄金原则                       | `docs/plans/<feature>.md`，含任务顺序、风险、验证命令和原则对照；不写代码                                                 | 初始 `active`；供人/agent 实施和 review 定位，合并后置 `done`，可显式归档；不替代正式 PRD            |
| `/review-loop`         | 最终 Review 返回待人工处理 finding 时                          | 选定 workspace 的 `final-review.json`、当前 HEAD 和已有结构化决定 | 经用户确认后在系统临时目录生成最小请求，并调用 `workspace record-review-decision`；不直接写 workspace，只有明确授权才修复 | 一次处理一个 finding；修复提交后重跑 `coding-x`，旧结果失效；不自动推送、合并或发布                  |
| `/compound-docs`       | 功能分支/引擎轮次收口，推荐功能合并后、发布前                  | 当前代码（最高事实）、Git、progress、PRD 范围和 active 文档       | 只修改文档：沉淀、增量熵 GC、状态收尾、取舍账本；物理归档需明确授权                                                       | 默认只处理本轮；“全量 GC”才全库审计；完成后长期知识继续 active，任务文档可 done/superseded → archive |

### Skills（按语境使用）

| Skill                 | 何时触发 / 输入                                                                             | 主要产出                                                                                                                  | 人需要确认什么                                                                                  | 生命周期与下一步                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `scenario-alignment`  | 输入杂乱、业务边界未定；说“`align: ...`”或“场景对齐”                                        | `docs/prds/align-<feature>.md`：不含技术方案的目标、范围、场景、验收口径                                                  | 默认 1–3 个真正影响产品方向的问题；每题有推荐；可要求逐题深挖                                   | 一次性输入材料；口径确认后交给 technical-alignment（若需要）或 prd-generate；正式 PRD 吸收后置 `superseded`           |
| `technical-alignment` | 业务已清楚，且涉及持久化/接口/状态机/权限/迁移等昂贵合同；说“`tech: ...`”                   | `docs/prds/tech-<feature>.md`：可验证技术合同和不可逆项                                                                   | 少数高代价、难回滚的技术选择；不会替人决定业务口径                                              | 一次性输入材料；与 align 一起交给 prd-generate，吸收后置 `superseded`；长期技术事实以后由 `/compound-docs` 沉淀       |
| `prd-generate`        | 要把清楚需求或 align/tech 材料变成正式需求；说“创建一个 PRD”并给路径                        | `docs/prds/prd-<feature>.md`：Goals、Non-Goals、稳定 story ID、可验证 AC 等                                               | 无前置对齐稿时回答 3–5 个查证不了的关键问题；逐条审阅 story 和 AC                               | 正式**意图真相源**；初始 `active`，交给 prd-to-json；合并交付后 `done`，需求演进时改回 `active`                       |
| `prd-to-json`         | 正式 PRD 已确认、准备运行；说“将 `<PRD 路径>` 转成 prd.json”                                | 回写源 PRD 最终 User Stories；在系统临时目录生成候选和请求，再调用 `workspace apply-prd` 原子更新运行状态；输出转换对照表 | workspace 路径与 Git 隔离、门禁命令、是否启用模型路由及模型选择、story/AC 增强差异              | 每次需求变更都从源 PRD 重跑；同功能按 ID 保留/重置状态，不同功能由 apply 命令归档旧运行；完成后先 `doctor` 再启动引擎 |
| `tdd`                 | 用户要求 TDD、测试先行、红绿重构或用回归测试修复缺陷；coding-x 启用 TDD 时 Builder 自动引用 | 每个公共行为的真实 RED→同命令 GREEN→绿色重构过程，以及最终 coverageCheck 结局                                             | 交互模式确认公共接口、行为顺序和覆盖政策；coding-x 模式沿用已批准 AC；Cursor 项目检查需显式安装 | 开发行为能力，不另建 TDD 政策文件；宿主只提前反馈、引擎独立重跑，不能把过程记录称为证明                               |
| `agent-browser`       | 需要真实浏览器导航、点击、填表、截图、数据提取或 UI 验收时                                  | 浏览器操作结果；引擎角色按规范可把最终截图放 `.workspace/screenshots/` 并登记 evidence                                    | 登录、支付、删除等敏感操作仍需按任务授权；核对页面、动作和可观察结果                            | 操作型能力，不生成长期需求文档；用完关闭会话。skill 说明不等于已安装二进制，引擎会用 `which agent-browser` 探测 PATH  |

不同宿主对“自动选择 skill”的体验可能不同；最稳妥的说法是“使用 `prd-to-json` 将这个文件转换……”。commands/skills 通常沿用当前会话；需要真正独立复核时，由人手动新开会话。

---

## 引擎功能清单

### 引擎（`npx coding-x`）

- **Developer → Validator 双 agent 循环**：开发方实现单个 story 并提交，验收方独立逐条核对验收标准。
- **引擎验收凭证 + 可信目标绑定**：`passes=true` 只是 builder 候选；引擎在每个 story 第一次实现前固定起点，向 Validator 注入 request ID/story/AC hash、固定起点、最终 Git HEAD 与整段变化摘要，严格消费逐 AC claim，确认 schema、绑定、产物和 state 不变式后才写 verdict 或签发 `validated=true`。验证检出会按质量契约建立冻结的 `origin/<defaultBranch>` 引用；引用缺失会在任何 Agent 启动前停止。凭证同时绑定机械验证环境、实际 coding-x 版本和 formal/shadow 模式，切换正式模式、候选版本或默认分支基线会保留实现候选并强制重验（ADR-013、015、018、026）。
- **Agent 调用凭证**：已经权威结算的 Builder/Validator 调用，只有在所属普通 iteration 成功写入时，才把 outcome、退出码、收口耗时和有界异常尾部带入 evidence/status/report；成功 transcript 不落盘。若同轮后续调用发生 proof-missing，整轮不写普通 iteration，此前已结算的调用也不单独持久化，只保留安全协议与隔离事实。它是引擎观察，不是 provider 账单或执行证明（ADR-016）。
- **自动重试与阻塞保护**：同一 story 验证失败累计 5 次后自动 `blocked` 跳过，避免卡死。
- **空转检测与 stall 熔断**：builder 结束但 `state.json`/`progress.md` 均无变化（no-op）时跳过门禁与验收，省一次验证方调用；已经取得权威收口证明的 Developer no-op、超时或异常退出累计达 `--stall-limit`（缺省 3）时提前终止（退出码 1）。POSIX 不透明 Runner 外部终止后的永久隔离不进入 stall 重试；结构化 Validator 异常也不空转重试，而是立即以不可验证退出码 5 停止并保留候选。
- **质量契约门禁**：项目只维护 `.coding-x/quality.json`；PRD 保存由 doctor 派生的摘要和结构化快照。schema v2 显式声明本地准备命令、允许目录和交付必须验证的平台。`init` 可以把现有固定 GitHub runner 作为建议，但最终平台必须由用户确认；服务器项目可以只选 Linux，桌面项目可以只选 macOS/Windows，跨平台工具再选择三项。CI 的额外 Ubuntu 控制任务不会自动变成部署要求。引擎在精确 HEAD 的项目外检出中准备依赖并逐项执行，失败机械打回并跳过该轮验证。验证检出保留最多 16 个目标提交的完整可达历史，但不复制无关分支或标签；开发仓库为 shallow/partial、缺少对象、启用替换历史、可达对象超过 10 万个或保守容量估算超过 1 GiB 时会返回不可验证，检出后还会复核对象集合与实际文件大小。版本、摘要、快照、验证环境或运行中契约漂移都会停止，当前系统没有适用检查也会失败而不是以零项通过。普通项目命令超时会等进程组确认收口后才继续。项目代码主动脱离平台 containment 属于明确非目标；受支持 AI runner 自身在 POSIX 上创建独立 session 则按上文的不透明 runner 边界保守隔离。coding-x 不是操作系统沙箱。
- **TDD 工作流与门禁**：共享 skill 约束逐行为红绿重构；Codex/Claude 插件 hook 与 Cursor 项目级检查在 agent commit 前提前反馈；引擎在 Validator 前独立校验政策并运行项目原生覆盖命令。非法配置启动前拒绝，运行期失败打回并写入单独证据与报告历史（ADR-017）。
- **workspace 安全写入与 Git 隔离检查**：builder 只 stage/commit story 文件并在受管范围内回写运行时状态；所有正式写入口共用 owner-bound 租约。`prd-to-json` 与 `/review-loop` 只准备临时请求，再由引擎写入；`doctor` 只读报告安全分类与 Git 隔离状态，不替用户删租约或改索引。
- **按难度的模型路由**：`models.runner` 绑定一个 runner，`builder.low/medium/high` 按 story `difficulty` 选初始模型，validator 恒定。首次机械门禁打回、引擎接受 Validator 的 failed claim 或 completed no-op 后，引擎置 `state.escalated=true`，下轮使用专用 escalation；超时、非零退出、认证/网络异常不会用更贵模型掩盖环境故障。启动前严格校验 schema、runner，并确认本次可能调用的 ID 已在全局模型目录声明；目录不承诺 provider 实时可用。CLI 覆盖只影响单次运行，不改写 PRD；存在待执行 story 时同样必须在目录中声明。
- **完成判定**：全部 story 有效通过（`passes && validated`）或 `blocked` 只表示实现循环已经收敛；存在 blocked 返回 3。无 blocked 时继续执行完整机械检查、本地最终 Review 和 GitHub 交付查询，三者均就绪才返回 0；其余按下方完整退出码表返回。
- **三种 agent runner**：`claude`（历史默认）、`codex` 与 `cursor`，均以跳过权限确认模式运行，启动前打印警告。
- **超时与进程收口**：开发/验证阶段各有独立超时。普通项目命令必须在 operation 返回前证明本轮进程组清空，不能用 `nohup` 留到下一轮；POSIX AI runner 已启动后若被外部终止或以信号结束，coding-x 不把外层进程组为空当成其内部命令全部退出，而是永久隔离 workspace、禁止下一轮。用户在 coding-x 外预先启动的服务仍可复用。
- **实时 Web 仪表盘**：默认 `http://localhost:7331`，含普通视图与像素风视图（`/p`）。正式 run 只打印地址；无写会话的 `npx coding-x dashboard` 才尝试自动打开浏览器。`--keep-open` 让跑完后面板继续可看；服务停止后页面冻结最后状态并显示「运行已结束」横幅。
- **静态验证报告**：循环结束从 PRD guard 的最终冻结快照自动生成 `.workspace/report.html`，手动 `npx coding-x report` 读取当前磁盘 PRD。报告把 `source=validator` 的逐 AC claim 与 `source=engine` 的目标/协议/receipt 分开；已随普通 iteration 写入的 Agent 调用可恢复耗时、退出码和异常尾部。proof-missing 使整轮普通 iteration 缺席，此前已结算的调用也不单独持久化，报告只展示安全协议与隔离事实。协议错误和 Validator 改 state 进入红旗；报告同时汇总 story、门禁、截图、人审与篡改。state 损坏时全部未验证；报告原子覆盖，截图分享需连同 `screenshots/`。
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
├── .workspace/                       # 当前/历史运行状态，默认不进 Git
│   ├── workspace-safety.json          # 目录身份与安全协议绑定标记
│   ├── engine.lock/                   # 永久协议根；活动 lease 与恢复记录位于其中
│   ├── prd.json
│   ├── state.json
│   ├── progress.md
│   ├── evidence.jsonl
│   ├── screenshots/
│   ├── final-review.json
│   ├── final-review.md
│   ├── review-decisions.json
│   ├── review-*.md                 # 仅旧版本历史反馈
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

| 现象                                                       | 先看哪里                                                                                  | 正确动作                                                                                                                              |
| ---------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| 找不到 `/init-docs`、`/planning` 等命令                    | 插件是否加载、当前 AI 工具是否支持 commands、是否在目标项目会话                           | 重新加载插件或按宿主的插件方式指向 coding-x 仓库；不要在目标项目里复制一份 command 内容                                               |
| `prd-to-json` 说所选 workspace 未忽略或已有文件被 Git 跟踪 | `npx coding-x doctor --workspace <同一路径>`、`.gitignore`、对应 `git ls-files` 结果      | 先决定是否修正 Git 隔离；skill 不会自动改 `.gitignore` 或执行 `git rm --cached`                                                       |
| 提示 workspace 未初始化或安全标记不匹配                    | `doctor` 的 workspace 分类、是否选错 `--workspace`                                        | 新的空目录运行 `coding-x workspace init --workspace <同一路径>`；非空旧目录或损坏状态不要强行初始化，保留现场并按提示处理             |
| 契约中的项目检查失败                                       | 按失败 check ID 在对应模块运行同一命令                                                    | 先修复项目原有失败或重新确认质量契约，基线全绿后再跑引擎                                                                              |
| `doctor` 报 TDD 配置非法、基线不可达或政策摘要变化         | workspace 中 `prd.json` 的 `tdd`、对应政策文件、当前 Git 根                               | 不要直接重算摘要；停止运行，由 `prd-to-json` 重新确认政策并生成候选，`workspace apply-prd` 会在租约内重跑真实基线                     |
| agent 执行 `git commit` 被 TDD hook 阻断                   | hook 的有限错误摘要、手工运行 `coverageCheck`                                             | 修测试、实现或政策漂移后重跑；不要关闭 hook 规避。即使绕过，coding-x 引擎仍会独立打回                                                 |
| Cursor 没有提前检查，或 `hooks cursor status` 报缺失/过期  | 项目根的 `.cursor/hooks.json`、`.cursor/coding-x/`、status 输出                           | 在 Git 项目根运行 `npx coding-x hooks cursor install`，升级 coding-x 后也重跑；若报冲突，先人工处理被修改或不合法的文件，不要强行覆盖 |
| Cursor 插件已装但 `npx coding-x cursor` 找不到命令         | `agent --version`（旧安装可试 `cursor-agent --version`）、登录状态、`CODING_X_CURSOR_BIN` | 单独安装 Cursor Agent CLI；桌面应用不能替代。coding-x 自动识别两种命令名，自定义路径再设置环境变量                                    |
| Windows 提示 AI runner 的 `.cmd/.bat` 包装器不受支持       | 对应 `CODING_X_*_BIN` 的实际路径、安装包是否提供原生程序                                  | 把对应变量指向该工具的原生可执行文件；不要改成 `shell:true`，项目自己的 `npm.cmd` 检查不受影响                                        |
| 报“找不到 prd.json”                                        | 选定 workspace 的 `prd.json` 是否存在、`--workspace` 是否一致                             | 用 `prd-to-json` 从正式 PRD 生成临时候选并调用 apply；不要手工拼一个不完整 JSON                                                       |
| 退出码 `2`，提示活动 lease 或恢复状态阻断                  | `doctor` / `status` 的安全分类、是否仍有 coding-x 或项目检查进程                          | 活跃运行就等待或正常停止；中断状态按提示运行 `workspace recover` 或 `workspace resume-mutation`，不要删除 `engine.lock/`              |
| 提示 `operation-proof-missing` 或永久隔离                  | `doctor` / `status` 的安全分类、是否为 POSIX AI runner 启动后的超时/中断/信号结束         | 保留原 workspace 现场，不要 recover、删锁或直接重开；独立确认旧进程不再影响原项目目录，无法确认时换隔离检出或重启主机，再用新的空 workspace |
| `state.json` 或 `prd.json` JSON 损坏                       | `status`/`report` 的保守警告                                                              | 运行 `npx coding-x repair`；它会自行获取短租约并按固定清单修复，不会替你解决业务失败                                                  |
| 退出码 `1`：达到最大轮次或 stall 熔断                      | `npx coding-x status`、终端异常尾部、`report.html` 时间线                                 | 区分代码失败、Developer 的 runner 认证/网络、已权威结算的超时和空转；处理根因后重跑，已有有效状态会续跑                               |
| 退出码 `5`：Validator 无法可靠验证                         | `npx coding-x status`、最近一次 Validator 结局、协议错误和当前提交                        | 修复 runner、结果、提交漂移或运行环境后重跑；候选不会被当成失败清除，也不会获得验收凭证                                               |
| 退出码 `3` 或 story `blocked`                              | `state.json` 对应 story 的 notes、报告红旗和仲裁标签                                      | 人决定改需求、修环境还是重试；需求/AC 有问题就改源 PRD、再运行 `prd-to-json`，然后重跑引擎                                            |
| 运行中途需求改变                                           | 源 `docs/prds/prd-*.md`                                                                   | 先停止引擎；修改源 PRD 并重新转换。AC 变化的 story 会重验，旧证据会先归档                                                             |
| UI story 没有浏览器证据                                    | PATH 中是否有 `agent-browser`、`.workspace/screenshots/`、报告截图对账                    | 安装/提供浏览器工具后真实操作；AC 要写明 URL、动作、期望结果，不能只写“页面正常”                                                      |
| 仪表盘端口 7331 被占用                                     | 终端端口错误                                                                              | 使用 `npx coding-x --port 7332`；离线 dashboard 也可带同一参数                                                                        |
| `/review-loop` 已记录决定，但仍返回 4                      | `review-decisions.json` 的完整 Review binding、head SHA、反证内容或延期 Issue             | 确认决定绑定当前 PR 意图、base、规则与提交；任一项变化后重跑 `coding-x`，不能复用旧结果；P1 Issue 必须开放且未过期                    |
| 要开始另一个功能                                           | 新旧 `branchName`、旧 `progress.md`                                                       | 重新执行 `prd-to-json`；skill 只准备临时候选，`workspace apply-prd` 按固定策略归档旧运行并清理会污染新轮的状态/证据                   |
| 所有 Story 已通过但退出 4/5/6                              | `status` 和报告中的“本地最终 Review / GitHub 交付”分栏                                    | 4 运行 `/review-loop`；5 修复不可验证原因后重跑；6 打开/更新 PR 或等待远端检查，不要把 Story 绿色当成交付绿色                         |

### 不要这样做

- 不要直接把 `.workspace/prd.json` 当需求文档长期维护；改源 PRD，再派生。
- 不要为了“让进度变绿”手改 `state.json` 的 `passes`、`validated`、`blocked` 或 `retryCount`。
- 不要提交 `.workspace/`；它含本地状态、诊断、截图，可能还有敏感信息。
- 不要把 `.workspace/` 当纯缓存整目录删除；需要换任务时先按规则归档。
- 不要只看 Builder 的提交说明、`progress.md` 或 `passes=true` 就认定完成。
- 不要让同一个 review finding 既没有修复，也没有接受/推迟/驳回记录。
- 不要让 `AGENTS.md` 变成长手册；它是入口，细节应放进 `docs/`。

---

## 常用术语

| 术语                         | 给新手的解释                                                                                                 |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------ |
| **harness**                  | 控制 AI 工作顺序、重试、超时、状态和验收的程序外壳；coding-x 的引擎就是 harness                              |
| **runner**                   | 被引擎实际调用的 AI CLI：Claude Code、Codex 或 Cursor Agent                                                  |
| **User Story**               | 一小块可独立实现、独立验收的用户价值，编号如 `US-001`                                                        |
| **AC / acceptance criteria** | “什么现象出现才算完成”的可验证清单；不是“写了某个函数”这种实现描述                                           |
| **Builder / Developer**      | 实现单个 story 的角色；`passes=true` 只是它的候选声明                                                        |
| **Validator**                | 独立逐条检查 AC 的角色；它提交 claim，最终状态仍由引擎裁决                                                   |
| **机械门禁**                 | 由程序直接执行的 typecheck/lint/test 命令，失败就打回，不依赖模型自述                                        |
| **TDD 循环**                 | 对一个行为完成真实 RED、同命令 GREEN、再绿色重构；过程记录可复核但不是机器证明                               |
| **TDD 门禁**                 | 引擎在 Validator 前校验冻结政策并独立运行覆盖命令；宿主 hook 只是提前反馈                                    |
| **workspace**                | `.workspace/` 本地执行工作台，保存需求派生物、状态、证据和报告                                               |
| **源 PRD**                   | `docs/prds/prd-*.md`，人维护的正式意图真相源；需求变化改这里                                                 |
| **blocked**                  | story 已达到失败上限或需要人工介入，引擎暂时跳过，等待人处理                                                 |
| **假绿**                     | 状态看似通过，但 AC 实际没完成或证据没有验证目标；机械门禁、目标绑定和 review 都在降低它                     |
| **验收凭证**                 | 引擎在目标、协议、状态和 Validator 结果都满足约束后写入的 `validated=true`                                   |
| **dogfood**                  | 用 coding-x 真实运行 coding-x 或固定测试项目，以实际使用发现问题；普通目标项目使用者无需维护 dogfood fixture |

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
│   ├── dashboard/
│   │   ├── dashboard.html        #   仪表盘普通视图
│   │   └── dashboard-p.html      #   仪表盘像素风视图
│   └── workspace-safety/         #   固定进程/路径检查器与只读 Review 代理
├── dist/                         # npm run build 生成的可发布包；删后可重新构建，不手改
│   ├── instructions/             #   构建复制的 Developer / Validator 指令
│   ├── public/                   #   构建复制的只读仪表盘页面
│   ├── workspace-safety/         #   构建复制并随 npm 包发布的固定安全辅助资产
│   └── hooks/tdd-commit-check.mjs # Cursor 安装器复制到目标项目的离线脚本
│
├── src/                          # TypeScript 引擎源码
│   ├── cli.ts                    #   命令行入口、参数解析
│   ├── cursor-hooks.ts           #   Cursor 项目检查的安全安装、状态与卸载
│   ├── engine/
│   │   ├── loop.ts               #   主循环：Developer ⇄ Validator
│   │   ├── agent.ts              #   runner 子进程、实时 tee、调用耗时/诊断与超时控制
│   │   ├── evidence.ts           #   evidence.jsonl schema、调用凭证、追加与读取
│   │   ├── fs-atomic.ts          #   非正式 workspace 兼容路径与项目文件原子覆盖
│   │   ├── gate.ts               #   机械门禁、打回与异常轮回写
│   │   ├── model-catalog.ts      #   全局模型目录路径、严格 schema、查询与初始化
│   │   ├── model-preflight.ts    #   runner/路由/CLI 覆盖与目录成员启动预检
│   │   ├── models.ts             #   PRD 模型路由 schema 与实际路由解析
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
│       ├── server.ts             #   只读仪表盘 HTTP 服务
│       └── browser-opener.ts     #   仅 standalone dashboard 使用的尽力开浏览器便利功能
│
├── tsup.config.ts                # 打包配置（onSuccess 把 assets 拷进 dist/）
├── tsconfig.json / vitest.config.ts
├── package.json
└── LICENSE                       # MIT
```

**两条资产链路：**

- **面向工具**：`skills/`、`commands/` 和共同 hook 脚本都是唯一源；Codex/Claude 从插件读取 hook，Cursor 插件只提供 commands/skills，项目检查由用户显式安装。
- **面向引擎**：`assets/instructions`、`assets/dashboard`、`assets/workspace-safety` 和共同 hook 脚本由 `npm run build` 拷进 `dist/`；引擎读取指令、页面和固定安全辅助资产，Cursor 安装器从 `dist/hooks` 复制脚本。`package.json` 的 `files` 只发布 `dist`，源码资产不单独发布。

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
