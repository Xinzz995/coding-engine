---
title: "coding-engine 与 coding-x 双层质量门禁实施计划"
status: done
updated: 2026-07-29
scope: root
---

# coding-engine 与 coding-x 双层质量门禁实施计划

**Goal:** 让 coding-engine 自身和所有经 `coding-x init` 新接入的项目使用同一套质量原则：
本地三层 Review、GitHub 原生机械门禁、固定候选包三仓 Dogfood 与人工稳定发布。

**设计规格:** `docs/specs/2026-07-26-cross-project-quality-gate-design.md`

**决策记录:** `docs/decisions/018-local-review-github-gate-and-staged-release.md`

**Bootstrap:** GitHub Issue #44；最小默认分支 Ruleset 已先行启用并完成回读。

## 完成合同

1. 规格、ADR、质量契约 schema、默认 Reviewer 规则与错误语义有合同测试；
2. `init` 三阶段可中断、可幂等重跑，只有远端回读完成才进入下一状态；
3. 正式运行版本严格匹配，候选版本只能 shadow 且不能产生可交付结果；
4. 最终 Review 的前置条件、三轴隔离、风险触发、精确失效、只读 runner 和人工裁决全部有
   正反例与真实 runner 隔离测试；
5. GitHub 只有机械 CI，一个总闸能捕获失败、取消、超时、跳过和缺失；政策变化由旧规则
   安全检查；
6. coding-engine 的 Node 22/24、三系统、CodeQL、依赖和文档检查真实运行；
7. npm 候选 tarball 在 coding-engine、owner 确认的公开 Go 多模块试点和公开 Python Monorepo
   试点完成真实 PR；
8. 最终 npm、tag、Release 与三个项目安装物绑定同一发布提交和制品摘要；受保护 `main`
   包含该发布提交且自身检查通过；回退路径至少演练到不会误移动 `latest`，并能恢复前一个
   稳定版本；
9. Bootstrap Issue #44 在三个真实 PR 与正式自托管闭环完成后仍保持开放，已在事实收口
   PR #78 合并并完成最终回读后关闭；
10. `loop.ts` 和超大测试文件最后以独立 PR 治理。

## 黄金原则对照

| 原则 | 适用性与裁决 | 必须保留的证据 |
|---|---|---|
| 1. 完成必须可证伪 | 适用。每个本地、远端、发布状态都有失败路径和唯一结论；“AI 评过”“CI 绿了”“包已发布”均不能单独代表完成。 | 契约/状态合同测试；真实 PR check-run；候选与 registry tarball SHA-256；Ruleset 回读；最终 ref 对齐。 |
| 2. 生成者不能自签 | 适用。Developer 不签 Validator；本地 Review 不签 GitHub；候选 N+1 只能 shadow，由稳定 N 和机械 CI 裁决。首次稳定版 0.33.1 使用人工 Bootstrap；0.33.0 没有成为正式裁判。 | Validator receipt；Review binding；shadow exit 7；旧版本运行记录；Bootstrap Issue/PR 历史。 |
| 3. 自主性与风险对称 | 适用。`init` 每次远端变更先展示、确认、应用、回读；不自动 merge/rebase/commit/push/开 PR/发布。Reviewer 只读、最小环境、一次重试。发布和例外保留人工批准。 | 幂等/中断恢复测试；远端失败回读；runner 攻击反测；2FA/stage 审批记录；过期例外 doctor 失败。 |
| 4. 复用原生执行面 | 适用。下游 GitHub CI 只运行 Go/Python 等项目原生命令，不安装 Node/coding-x。核心契约跨语言，GitHub 和三个 runner 只在适配层分叉。 | Go/Python workflow 扫描和真实 run；核心类型无生态专属字段；三 runner 同一输出 schema。 |
| 5. 先度量失败与恢复 | 适用。先实现缺契约、脏树、落后分支、缺 PR、跳过 job、模型损坏、秘密读取、stage 失败和 latest 回退测试，再开放成功路径。 | failure-first 自动化；临时远端破坏场景；失败后 ref/dist-tag 保持或恢复；doctor 漂移告警。 |

当前没有待自行裁决的产品边界。任何需要改变公开入口、GitHub 不调用模型、候选不能自签、
三仓真实验证或人工发布批准的发现，都必须先回到用户确认。

## Phase 1：正式规则与契约骨架

### Task 1：文档基线

- 提交并通过 PR 合并本规格、ADR 与本计划；
- 在 Bootstrap Issue #44 留下规格 PR、最小 Ruleset ID 和回读结论；
- 从下一 PR 起按本计划拆分，禁止把 `loop.ts` 结构重构混入门禁功能。

### Task 2：质量契约 schema 与解析

测试先行覆盖：

- 缺文件、非法 JSON、未知/过新 schema、精确版本不匹配；
- 命令结构、cwd/路径越界、平台、超时、模块、生成目录、重复 check 名称；
- shell 命令必须显式声明；不适用项必须有非空理由；
- Spec/规范来源、风险规则、GitHub 身份、发布 ref 和例外规则完整性；
- 规范化摘要在键顺序变化时稳定，语义变化时改变。

实现 `.coding-x/quality.json` 类型、严格解析、规范化与 SHA-256 摘要。新增版本一致性 preflight；
正式模式拒绝不匹配，shadow 记录候选版本并永久禁止 delivery-ready。

### Task 3：PRD 检查快照

- `prd-to-json` 从质量契约派生 `qualityChecks` 与契约摘要；
- 运行中 PRD 与契约摘要不一致在启动 agent 前失败；
- 不再让 PRD 流程询问或维护第二套机械命令；
- 保留未初始化旧项目的明确引导，但不提供静默兼容运行。

## Phase 2：PR 身份、状态与最终 Review

### Task 4：Git 与 GitHub preflight

测试并实现：功能分支、干净工作树、允许 workspace/生成物、fetch 后 base 包含关系、开放 PR、
目标分支、PR 必填正文和 GitHub 权限。coding-x 不执行 merge/rebase/history rewrite；缺远端条件
返回退出码 6，意图不可验证返回 5。

### Task 5：Review binding 与三态状态

- 定义 PR/base/head、PR 文本摘要、Spec/规范/契约摘要、coding-x、runner/model/version、规则
  版本和风险结果的绑定结构；
- 任何绑定项变化使旧结果失效；只有 CI 状态变化允许 status 单独刷新；
- status/report 分栏展示实现、Validator、本地 Review、远端规则/CI、shadow 和最终交付；
- 实现退出码 0–7 的端到端合同，保持既有错误路径兼容映射。

### Task 6：最小只读审查包

先以恶意夹具证明当前 runner 的危险默认参数会写入、执行和读取秘密，再替换为安全适配：

- 从 Git 对象复制已跟踪必要内容，不复制工作区和未跟踪文件；
- 去除 GitHub/npm 写凭据与项目秘密，仅保留模型服务认证；
- 禁项目 MCP、hooks、插件、浏览器和网络工具；
- Codex/Claude/Cursor 分别使用原生只读/plan/sandbox 能力；
- 严格 JSON schema，只接收 stdout；格式或临时服务错误同模型最多重试一次；
- 每个 runner 以真实写文件、危险命令、秘密、MCP 反测后才标记 supported。

### Task 7：三层 Review 与风险判断

- Spec 与工程标准分别构造上下文、分别运行和保留 findings；
- 明确区分实现验收与交付后置条件：Spec 只评改动行为；机械检查、全部 Review 轴和 GitHub
  状态由引擎判定，并把绑定当前 head 的前置检查事实写入审查包，禁止 Reviewer 循环自证；
- 默认分支旧规则裁决工程标准、质量契约和 Reviewer；当前 PR 可提供产品 Spec；
- 实现风险触发器与项目覆盖项，排除生成物/锁文件/快照的千行误报；
- 深度 Review 只在触发时运行，或由用户/Reviewer 主动升级；
- 调用前计算完整上下文预算；禁止静默截断和八分片，无法覆盖返回 5；
- 每个轴输出 passed/failed/unverifiable，汇总不能抵消 finding。

### Task 8：findings 与 `/review-loop`

- 定义 finding 和 resolution schema、稳定 ID、head SHA 和轮次；
- P0/P1/人工决策阻断，P1 只有有效延期 Issue 可放行；P2/Info 不阻断；
- `/review-loop` 提供裁决、反证、授权修复、延期登记，再由用户重新运行 coding-x；
- 删除缺 PRD 降级、质量问题默认不阻断和 Markdown 自由编辑即完成；
- doctor 通过 GitHub 检查延期 Issue 字段、开放状态和到期日。

## Phase 3：初始化与 GitHub 门禁

### Task 9：可回读的分阶段 `init`

- 能力探测：Git 仓库、默认分支、GitHub repo、认证、Ruleset/私库套餐；
- 发现候选命令与规范后逐项让用户确认，不自行写入猜测；
- 最小规则展示→确认→应用→回读，成功后生成契约、CI、PR/Issue 模板；
- 识别 Bootstrap PR 首次 `quality-gate` check-run，二次确认后升级 required checks 并回读；
- Bootstrap 合并后用 Activation PR 触发默认分支旧 `policy-guard`，将真实
  `policy-guard-source` 任务及 GitHub Actions 来源加入 required checks 并回读；不在
  Bootstrap PR 伪造同名检查；
- 中断状态落本地可恢复记录，重复运行幂等；不足能力返回配置错误，不降级。

### Task 10：原生 CI 生成器与总闸

- 从质量契约为目标生态生成原生 job，不要求 CI 安装 Node/coding-x；
- 每个 job 在契约中明确系统、Node/Go/Python 工具链版本、准备命令和检查 ID；同一系统的
  多版本矩阵不得在 workflow 另写一份；
- 稳定 `quality-gate` 使用始终执行语义并枚举全部 job 结果；
- 无适用模块由 job 输出原因后成功；工作流级路径过滤禁用；
- 为失败、取消、超时、skip、missing、`[skip ci]` 和 job 条件写合同/临时远端测试；
- Ruleset 只要求 `quality-gate` 和真实 `policy-guard-source` 任务，并回读实际来源。

### Task 11：旧规则 `policy-guard` 工作流

- 使用默认分支上的工作流检查契约、workflow、工程原则、Reviewer、发布规则变更；
- `pull_request_target` 只读 API 元数据，不 checkout、不 eval、不写入 PR 文本；
- 直接把工作流真实的 `policy-guard-source` 任务作为 required check，不再通过 Checks API
  额外写入结果；
- 政策例外标签必须关联字段完整、未过期的 Issue；
- 第三方 Actions 固定完整 SHA，workflow 权限逐 job 最小化；
- 用恶意 PR 标题、文件名、内容和 fork 验证不会执行不可信输入。

## Phase 4：coding-engine dogfood 与安全 CI

### Task 12：coding-engine 质量契约

- 写入正式 `.coding-x/quality.json`，固定稳定裁判版本；
- 收录类型检查、全量测试、构建、文档健康、成品 CLI 冒烟、格式、静态检查、依赖审计；
- 将 Node 最低版本提升到 22，明确生成目录和高风险路径；
- 修正文档中把 `.workspace/review-*.md` 说成 Git 共享证据的错误表述。

### Task 13：跨系统 CI 与安全功能

- Ubuntu Node 22 全量；Ubuntu Node 24 全量；macOS/Windows Node 24 关键测试、构建、冒烟；
- 一个总闸汇总四个实际任务；用人工取消/条件 skip 的临时 PR 验证总闸红灯；
- 增加格式、静态检查、高危依赖审计、Dependabot、CodeQL；
- 探测并启用秘密扫描、推送保护和自动安全更新，不支持时记录真实不可用状态；
- 所有 workflow pin 完整 SHA，并通过 GitHub 真实运行。

## Phase 5：候选发布与真实下游

### Task 14：staged/OIDC 发布流程

- 删除 tag-trigger 直接 npm publish 和长期 `NPM_TOKEN` 路径；
- 配置 Node 24、npm ≥11.15、OIDC Trusted Publisher 与 stage-only；
- 将完整检查/构建与 OIDC 暂存拆成两个独立工作流；前者没有发布身份，后者不得安装项目
  依赖或执行项目脚本；
- 从精确 main 构建候选 tarball 并记录 SHA-256、commit 和 candidate run；三仓 Dogfood
  通过后，stage-only 流程回读来源/成功状态/当前 main，再记录 stage run 与 stage ID；
- 标签 workflow 只校验 npm 版本/提交/来源并创建不可变 Release；
- Tag Ruleset 只允许受控创建，禁止更新删除，并验证提交属于受保护 main；
- 标签工作流本身损坏时，允许修复经受保护 PR 进入 main 后对既有不可改写标签手动恢复，
  但仍必须通过同一候选、registry、提交和 provenance 核验；
- 真实核验 npm provenance 在 stage 批准前后的呈现时机。

### Task 15：三项目候选 Dogfood

- coding-engine、Go、Python 在创建 npm stage 前安装同一个候选 tarball；coding-engine 运行
  shadow 全链；
- 使用经 owner 确认的公开 Go 多模块试点仓库，至少两个 module，CI 只用 Go 原生命令；
- 使用经 owner 确认的公开 Python Monorepo 试点仓库，至少两个 package，CI 只用 Python
  原生命令；
- 公开是本次两个试点的明确选择，不改变通用私有仓库规则：私有仓库先探测 Ruleset 能力，
  账户套餐或权限不满足就停止等待，不降级；
- 三个仓库各完成真实 PR，记录候选 tarball 摘要、check-runs 和 Ruleset 回读；
- 保留两个外部试点仓库直到最终验收，不删除。

### Task 16：批准、稳定发布与正式自托管

- 0.33.1 stage 已由用户用 2FA 批准到 `next`，三个项目已从 registry 按精确版本重跑安装冒烟；
- 内容摘要一致后，npm `latest` 与 `next` 已指向 0.33.1，`v0.33.1` 标签和不可变 GitHub
  Release 已创建；
- npm `gitHead`/provenance、peeled tag、Release asset、main 和工作树同步已独立核验；
- 旧规则审查的 Policy PR #76 已把正式裁判固定为 0.33.1；固定的 0.33.1 已完成
  coding-engine PR #77 的首次正式自托管，该 PR 已合并；
- 两个外部试点 PR 也已合并；三个主分支合并提交和成功检查运行记录见“当前状态”；
- Bootstrap Issue #44 已在事实收口 PR #78 合并后重新核对三个 PR、Ruleset、npm、tag、
  Release 和摘要证据，并于 2026-07-27 关闭。

## Phase 6：结构治理与收口

### Task 17：独立结构治理

- 对 `loop.ts` 和超大测试文件执行深度结构 Review；
- 只拆职责、真相源和测试组织，不与门禁功能混改；
- 单独 PR，使用已经启用的正式门禁完成；
- 行数只是触发调查的信号，最终拆分由职责和依赖边界决定。

### Task 18：最终回归

- `npm run typecheck`、全量测试、构建、成品 doctor/CLI smoke、文档检查、diff check；
- coding-engine dogfood regression 全量；Go/Python 真实 CI；GitHub 规则漂移检查；
- 失败恢复演练：拒绝过期 stage；隔离验证 `next` 冒烟失败不会移动 `latest`，且 `latest`
  已移动时能够恢复前一个稳定版本；
- 最终确认远端规则仍启用，当前默认分支包含发布提交且自身检查通过；npm、tag、Release 和
  三个安装物绑定同一发布提交与制品摘要，工作树 clean/synced。

## 实施拆分与停线条件

每个 Phase 使用独立 PR；Node/CI、安全、发布、外部仓库和结构治理不混入核心 Review PR。
以下情况立即停止相关链并向用户报告，不自行降级：

- GitHub 私库 Ruleset 或安全功能不受账户支持；
- npm staging/OIDC 真实能力与文档不一致；
- 任一 runner 不能可靠只读或需要危险 bypass；
- 必需上下文无法完整提供；
- 需要用户 2FA、产品/架构裁决或改变已确认边界；
- 候选、registry、tag 或 Release 内容/提交不一致。

不影响其他独立 Phase 的发现可以记录后继续；但不能把尚未完成的真实远端或发布验收写成
已完成。

## 当前状态

- GitHub Bootstrap Issue #44 已创建；
- Bootstrap PR #47 已由四个原生任务和 `quality-gate` 真实验证后合并；Windows 首轮失败曾让
  总闸保持红色，路径兼容修复后 726 项测试、构建和成品冒烟在四个任务中通过；
- Ruleset ID 19747271 已绑定由 GitHub Actions 在 PR 最新提交产生的 `quality-gate` 与真实
  `policy-guard-source` 任务，并完成远端回读；
- Phase 1、质量契约底座、分阶段 `init`、本地三层 Review 和远端 doctor 已分别通过
  PR #45–#49 合并；
- Phase 4 基础设施 PR #55 已合并；Node 22/24、Linux/macOS/Windows、增量格式检查、静态
  检查、高危依赖审计、固定版本 Actions、Dependabot、秘密扫描和 CodeQL 已在默认分支真实
  运行；
- 默认分支首次 CodeQL 基线发现的 7 个现存问题已通过 PR #57 全部修复；合并提交
  `8daf950` 的主分支扫描和总闸均通过，开放告警为 0；Activation PR #59 已将 CodeQL 的
  high 安全告警和 error 普通告警阈值写入 Ruleset #19747271，`init` 更新后完成远端回读，
  `doctor` 状态为 ready；本次受保护政策变更已由 owner 明确授权，并登记限时政策例外
  Issue #58，PR 最新提交仍必须在新规则下通过后才能合并；
- 候选暂存与不可变发布流程已通过 PR #61 合并；发布标签 Ruleset、不可变 Release、
  `npm-staging` environment 和 stage-only Trusted Publisher 均已回读；运行 #30212975390 已证明
  OIDC 身份和来源声明有效，但 npm 以 0.30.0 曾被使用为由拒绝暂存，未创建 stage；
- 0.33.0 版本准备曾由 Issue #62 跟踪。验证发现候选版本的完整 doctor 不应充当 GitHub 机械
  检查，已获 owner 授权拆出 coding-engine 仓库健康测试；PR #63 按已约定的一次性“机械
  CI + owner 人工 Bootstrap”裁决，不声称完成正式本地 AI Review。随后多轮真实 Dogfood
  在 stage 创建后发现产品问题，旧候选不能吸收新修复，因此 0.33.0 没有成为正式裁判；
- 最终 0.33.1 候选来自提交 `a57e8d3cf666c5293d28c2a3f5921be43044c1a7`；候选构建运行
  #30286427973 产出的 tarball SHA-256 为
  `b27cab53e7d18ba6b1cd8ccf9421b99804524b531624dbddbb496ea29d9e9a73`；
- coding-engine、Go 与 Python 已完成同一 0.33.1 候选和 registry 精确版本验证；两个外部
  仓库经 owner 确认作为公开试点，这不改变通用能力对私有仓库在套餐或 Ruleset 权限不足时
  停止且不降级的规则；
- npm staging 运行 #30288714477 创建 stage
  `9e343f65-8588-40f1-8473-a047bf5c6e1d`；发布运行 #30290999148 已完成，npm `latest` 与
  `next` 均指向 0.33.1，`v0.33.1` 标签与不可变 GitHub Release 已创建；
- Policy PR #76 已按旧规则通过并合并，把正式裁判固定为 0.33.1；coding-engine PR #77 已
  完成首次正式自托管并合并，`main` 合并提交为
  `0365262ed7706124658ee419a7563376f8645c8c`，该提交的 Quality Gate 运行 #30308770168 和
  CodeQL 运行 #30308770166 均成功；
- Go 公开试点 PR #3 已合并，`main` 合并提交为
  `c6188742c3ade06391f90c593536b23c224ccad7`，Quality Gate 运行 #30310021499 成功；Python
  公开试点 PR #3 已合并，`main` 合并提交为
  `c2f5b3ba5cdabd6d9016c18821e67bc2432a4fa5`，Quality Gate 运行 #30310021340 成功；
- Bootstrap Issue #44 已在事实收口 PR #78 合并并完成最终回读后关闭；过渡期政策例外
  Issue #62 与 #69 也在各自跟进事项全部完成后关闭。

## 最终回归事实（2026-07-28）

- 结构治理 PR #80 的正式本地 Review 由 coding-x 0.33.1 绑定 PR 最新提交
  `633c8a7651cc438e7ea518b27aae9c2f16651449`，重新验收两个 Story；Spec、工程标准与深度结构
  Review 均通过且没有遗留 finding。PR #80 随后合并，`main` 合并提交为
  `39ed19d46ce819326c4ce6c938c274c4d521cefd`；合并后的 Quality Gate #30316452669 与 CodeQL
  #30316452674 均成功。
- 本地最终检查通过：类型检查、825 项全量测试、构建、成品 CLI、doctor、格式、静态检查、
  仓库健康、高危依赖审计与 diff check；doctor 回读质量契约和远端交付状态均为 `ready`，
  工作树与 `origin/main` 同步。
- `docs/dogfood-regression.md` 的 25 条断言已逐条复查。PR #80 不含 UI、PRD 再派生或 TDD/hook
  变更，对应断言不适用；其余断言由本次正式运行工件、Validator/Review 绑定、结构化 evidence、
  报告和失败路径回归覆盖，未发现行为回退。
- coding-engine Ruleset #19747271、Go Ruleset #19773424 与 Python Ruleset #19773582 均启用、
  无绕过者，并要求最新提交上的 `policy-guard-source` 与 `quality-gate`；三个仓库的发布标签规则
  也均启用且禁止更新、删除。Go `main` #30310021499、Python `main` #30310021340 保持成功，
  两个外部工作流只使用各自原生 Go/Python 工具，不安装 Node 或 coding-x。
- npm `latest` 与 `next` 均为 0.33.1，`gitHead`、注解标签 `v0.33.1` 和不可变 Release 均绑定
  候选提交 `a57e8d3cf666c5293d28c2a3f5921be43044c1a7`；registry 与 Release tarball 重新下载后字节
  一致，SHA-256 为 `b27cab53e7d18ba6b1cd8ccf9421b99804524b531624dbddbb496ea29d9e9a73`。
- 上述本地 Review、GitHub 机械检查与发布物摘要分别证明审查结论、远端执行状态与制品身份，
  彼此不能替代。当前 `main` 已包含 0.33.1 发布提交，但不等于该历史发布提交。
- 失败恢复边界已完成演练：三个 0.33.0 stage
  `c02b6696-3a4b-4a5e-a58c-c697afcee006`、
  `2be2a6f1-4a10-44b7-992f-98b9361d607d` 与
  `7a4e4795-f43c-4e8e-af65-8d8157797931` 均已拒绝；最后一个过期 stage 于 2026-07-28
  使用 2FA 拒绝后，npm 暂存页回读为没有待审核版本，公开 `latest` 与 `next` 仍保持 0.33.1。
  隔离 npm registry 中先以 1.0.0 作为 `latest`、1.1.0 作为 `next`：停止候选提升模拟公开冒烟
  失败时，`latest` 保持 1.0.0；再把 `latest` 提升到 1.1.0 并执行回退后，dist-tag 和默认版本
  解析均恢复为 1.0.0，而 `next` 保持 1.1.0。演练使用 npm 11.17.0 与 Verdaccio 6.9.0，未改动
  公开 npm 的稳定标签。候选来源过期、schema 错误、运行身份或制品摘要不一致继续由回归测试
  失败关闭。

## 状态变更清单（2026-07-28）

| 对象 | 状态变更 | 成立依据 |
|---|---|---|
| `docs/specs/2026-07-26-cross-project-quality-gate-design.md` | `active` → `done` | 双层门禁、三仓验证、正式发布与 Bootstrap 收口均已完成 |
| `docs/plans/2026-07-26-cross-project-quality-gate.md` | `active` → `done` | Task 18 最终回归完成，结构治理 PR #80 已合并并完成合并后检查 |
| `docs/plans/2026-07-27-prestage-candidate-promotion.md` | `active` → `done` | 暂存前候选验证已交付，并用于 0.33.1 候选、暂存与稳定发布 |
| `docs/prds/prd-loop-structure-governance.md` | `active` → `done` | 两个 Story 已由正式 Review 验收，PR #80 已合并且主分支检查成功 |
| GitHub Issue #44 | `open` → `closed` | PR #78 合并后完成三个仓库、Ruleset、发布与制品摘要的最终回读 |
| GitHub Issue #62 | `open` → `closed` | 0.33.0 过渡候选的跟踪与后续裁决已经完成 |
| GitHub Issue #69 | `open` → `closed` | 暂存前固定候选验证的跟进事项已经完成 |
| npm 0.33.0 过期 stage `7a4e4795-...-7931` | `pending` → `rejected` | 2FA 拒绝后暂存页回读为空；公开 `latest`/`next` 保持 0.33.1 |

## 后续稳定版复验事实（2026-07-29）

- 0.33.2 发布提交为 `e141853d8d31159680a11d696f4f1f51faa3f8a0`；候选构建运行
  #30418096133 的 tarball SHA-256 为
  `8dedbca1bb2b95c4f78b18deaf9e58f2a27cea5029e1e3d5e46a9f2fcf7ff0c6`。暂存运行
  #30444501474 创建 stage `09a46d7f-dc83-4f21-9226-48743c05b2c6`；人工批准、公开精确版本
  冒烟与稳定提升完成后，npm `latest` 和 `next` 均指向 0.33.2。
- 注解标签 `v0.33.2`、npm `gitHead` 和不可变 GitHub Release 均指向上述发布提交；Release
  中的 registry tarball 摘要与候选摘要一致。0.33.1 的事实继续作为首次 Bootstrap 历史，
  不再代表当前稳定版本。
- 三个项目分别通过独立 Policy PR 将正式裁判固定为 0.33.2，再用公开安装的 0.33.2 对原
  Dogfood PR 最新提交执行非 shadow 的 Validator 与三层 Review。coding-engine PR #87、Go
  PR #6 和 Python PR #6 均无遗留 finding 并已合并；对应主分支合并提交分别为
  `2ee5941c06e143ee2b78a38afa0a85468de1a266`、
  `7f9b4797557a2e250fb071a133a3045c2e9be705` 和
  `3a2f2f3b61059547140984ae1ccf815496ecfbd3`。
- 合并后的 coding-engine Quality Gate #30449850165 与 CodeQL #30449855412、Go Quality Gate
  #30449555193、Python Quality Gate #30449734644 均成功。三个仓库随后使用公开 0.33.2
  再次运行 doctor，质量契约与 GitHub 交付状态均为 `ready`，本地 `main` 与远端同步且工作树
  干净。
- 本次复验继续保持责任边界：模型只在本地正式 Review 中运行；GitHub 只执行项目原生机械
  检查，不保存或证明本地 AI Review。候选证据、npm/标签/Release 身份、本地 Review 与远端
  检查分别证明不同事实，不能互相替代。
