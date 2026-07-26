---
title: "coding-engine 与 coding-x 双层质量门禁实施计划"
status: active
updated: 2026-07-26
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
7. npm 候选 tarball 在 coding-engine、私有 Go 多模块和私有 Python Monorepo 完成真实 PR；
8. 最终 npm、tag、Release、main 与三个项目安装摘要一致，回退路径至少演练到不会误移动
   `latest`；
9. Bootstrap Issue #44 只在三个真实 PR 与正式自托管闭环后关闭；
10. `loop.ts` 和超大测试文件最后以独立 PR 治理。

## 黄金原则对照

| 原则 | 适用性与裁决 | 必须保留的证据 |
|---|---|---|
| 1. 完成必须可证伪 | 适用。每个本地、远端、发布状态都有失败路径和唯一结论；“AI 评过”“CI 绿了”“包已发布”均不能单独代表完成。 | 契约/状态合同测试；真实 PR check-run；候选与 registry tarball SHA-256；Ruleset 回读；最终 ref 对齐。 |
| 2. 生成者不能自签 | 适用。Developer 不签 Validator；本地 Review 不签 GitHub；候选 N+1 只能 shadow，由稳定 N 和机械 CI 裁决。首次 0.30.0 使用人工 Bootstrap。 | Validator receipt；Review binding；shadow exit 7；旧版本运行记录；Bootstrap Issue/PR 历史。 |
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
- Bootstrap 合并后用 Activation PR 触发默认分支旧 `policy-guard`，绑定 PR head 和 GitHub
  Actions 来源、加入 required checks 并回读；不在 Bootstrap PR 伪造同名检查；
- 中断状态落本地可恢复记录，重复运行幂等；不足能力返回配置错误，不降级。

### Task 10：原生 CI 生成器与总闸

- 从质量契约为目标生态生成原生 job，不要求 CI 安装 Node/coding-x；
- 每个 job 在契约中明确系统、Node/Go/Python 工具链版本、准备命令和检查 ID；同一系统的
  多版本矩阵不得在 workflow 另写一份；
- 稳定 `quality-gate` 使用始终执行语义并枚举全部 job 结果；
- 无适用模块由 job 输出原因后成功；工作流级路径过滤禁用；
- 为失败、取消、超时、skip、missing、`[skip ci]` 和 job 条件写合同/临时远端测试；
- Ruleset 只要求 `quality-gate` 和必要的 `policy-guard`，并回读实际来源。

### Task 11：旧规则 `policy-guard`

- 使用默认分支上的工作流检查契约、workflow、工程原则、Reviewer、发布规则变更；
- `pull_request_target` 只读 API 元数据，不 checkout、不 eval、不写入 PR 文本；
- 评估后只创建绑定 PR 最新 head 的 `policy-guard` Check Run，源 job 不作为 required check；
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
- 将完整检查/构建与 OIDC 暂存拆成两个任务；后者不得安装项目依赖或执行项目脚本；
- 暂存精确 main 提交，下载候选 tarball 并记录 SHA-256、stage ID、commit；
- 标签 workflow 只校验 npm 版本/提交/来源并创建不可变 Release；
- Tag Ruleset 只允许受控创建，禁止更新删除，并验证提交属于受保护 main；
- 标签工作流本身损坏时，允许修复经受保护 PR 进入 main 后对既有不可改写标签手动恢复，
  但仍必须通过同一候选、registry、提交和 provenance 核验；
- 真实核验 npm provenance 在 stage 批准前后的呈现时机。

### Task 15：三项目候选 Dogfood

- coding-engine 安装候选 tarball 并运行 shadow 全链；
- 创建私有 Go 多模块仓库，至少两个 module，CI 只用 Go 原生命令；
- 创建私有 Python Monorepo，至少两个 package，CI 只用 Python 原生命令；
- 两个私库先探测 Ruleset 能力，不满足就停止等待权限，不降级；
- 三个仓库各完成真实 PR，记录候选 tarball 摘要、check-runs 和 Ruleset 回读；
- 保留两个私库直到最终验收，不删除。

### Task 16：批准、稳定发布与正式自托管

- 用户用 2FA 批准 stage 到 `next`；三个项目从 registry 按精确版本重跑安装冒烟；
- 内容摘要一致后人工移动 `latest`；创建对应 `v*` 标签和 GitHub Release；
- 独立核验 npm `gitHead`/provenance、peeled tag、Release asset、main 和工作树同步；
- 通过旧规则 Policy PR 固定 0.30.0，再由 0.30.0 完成一个正式 coding-engine PR；
- 关闭 Bootstrap Issue #44 前附三个 PR、Ruleset、npm、tag、Release 和摘要证据。

## Phase 6：结构治理与收口

### Task 17：独立结构治理

- 对 `loop.ts` 和超大测试文件执行深度结构 Review；
- 只拆职责、真相源和测试组织，不与门禁功能混改；
- 单独 PR，使用已经启用的正式门禁完成；
- 行数只是触发调查的信号，最终拆分由职责和依赖边界决定。

### Task 18：最终回归

- `npm run typecheck`、全量测试、构建、成品 doctor/CLI smoke、文档检查、diff check；
- coding-engine dogfood regression 全量；Go/Python 真实 CI；GitHub 规则漂移检查；
- 失败恢复演练：stage 拒绝、`next` 冒烟失败、`latest` 回退计划；
- 最终确认默认分支、远端规则、npm、tag、Release 和三个安装物一致，工作树 clean/synced。

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
- Ruleset ID 19747271 已绑定由 GitHub Actions 在 PR 最新提交产生的 `quality-gate` 与
  `policy-guard`，并完成远端回读；
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
  `npm-staging` environment 和 stage-only Trusted Publisher 均已回读，真实 OIDC 暂存尚未执行；
- 0.30.0 版本准备由 Issue #62 跟踪。验证发现候选版本的完整 doctor 不应充当 GitHub 机械
  检查，已获 owner 授权拆出 coding-engine 仓库健康测试；固定裁判继续保持 0.29.0；
- 首次真实 staged publish、三个项目的同包 Dogfood、发布后固定 0.30.0 的 Policy PR 和结构
  治理仍待后续独立步骤。
