---
title: "coding-engine 与 coding-x 双层质量门禁设计"
status: active
updated: 2026-07-27
scope: root
---

# coding-engine 与 coding-x 双层质量门禁设计

## 目标

为 coding-engine 自身和所有经 `coding-x init` 新接入的项目建立同一套质量原则，同时严格
区分三条链：

1. 本地质量判断：coding-x 在实现与 Validator 完成后执行 Spec、工程标准和风险触发的
   深度结构 Review；
2. GitHub 交付约束：只执行项目原生测试、构建、静态检查和安全检查，并通过受保护 PR 与
   一个不可跳过的总闸阻止假绿；
3. 候选发布验证：同一候选包先在 coding-engine、Go 多模块和 Python Monorepo 中验证，
   再由维护者批准进入稳定发布。

GitHub 不调用模型，也不证明本地 AI Review 曾经运行。AI Review 是本地辅助判断；机械检查、
远端门禁和发布制品一致性分别由对应执行面证明。

## 完成合同

本能力只有同时满足以下条件才算完成：

1. coding-engine 通过受保护 PR 使用正式门禁完成一次真实变更；
2. 一个私有 Go 多模块项目和一个私有 Python Monorepo 分别通过真实 PR 完成相同闭环；
3. GitHub 工作流中不存在模型调用、AI 密钥或八分片模型任务；
4. 任一机械任务失败、取消、超时或未运行时，稳定名称 `quality-gate` 必须失败；
5. 本地最终 Review 绑定最新 PR、提交、意图、规则、runner 和实际模型，任一绑定项变化后
   旧结果失效；
6. Reviewer 只能读取最小审查包，不能读取未跟踪秘密、修改项目、调用项目 MCP、hooks、
   插件、浏览器或危险工具；无法保证时返回 `unverifiable`；
7. 候选版本只能以 `--shadow` 验证，永远不能为自己签发正式交付结果；
8. 三个项目安装并验证同一个候选 tarball；最终 npm 版本必须与该 tarball 内容一致；
9. 默认分支规则、CI、npm 版本、Git 标签和 GitHub Release 最终指向同一提交；
10. `loop.ts` 与超大测试文件的结构治理在门禁闭环之后使用独立 PR 完成，不混入首批功能
    变更。

Bootstrap 过程由 GitHub Issue #44 跟踪；该 Issue 只能在三个真实 PR 和发布闭环全部完成后
关闭。

## 参考材料与取舍

### 三个 Review 层次

- Matt Pocock 的 code-review skill 用于定义“评什么”：Spec 与工程标准是两个独立问题域，
  缺少 Spec 时不能由 Reviewer 猜测产品意图；
- Cursor Thermo-Nuclear skill 用于定义“评多深”：聚焦复杂度、职责边界、重复真相源、
  错误传播、并发和维护成本，只在高风险变化中启用；文件跨越 1000 行是调查信号，不是
  自动判死刑；
- no-mistakes 用于定义“怎样进入交付流程”：吸收固定顺序、最新提交绑定、修复后重审和
  CI 状态跟踪；不引入 Git 代理、守护进程、数据库、TUI 或可复制的通过文本。

本地 `review-push` 的结构化 finding 形式可作为输入；其推送脚本不能证明 Review 和测试已
完成。`git-commit` 自动暂存全部文件的行为不采用。`code-reviewer.md` 只作为工程标准检查表
种子，不能代替 Spec Review 或远端门禁。

### Review、Verification、Gate

保留原文章的三分法：

- Review 判断实现是否符合意图和工程标准；
- Verification 通过测试和 Validator 验证行为；
- Gate 保证交付所需步骤不能被日常流程静默跳过。

再补充六个必须显式建模的维度：PR 与提交身份、可信规则来源、不可静默跳过、证据来源、
异常处理和持续漂移检查。

## 可信边界

coding-engine 首版仍位于个人 GitHub 仓库。Ruleset 能可靠阻止日常误操作和普通贡献者绕过，
但唯一 owner 仍能修改或删除规则，因此不称其为独立可信根。出现稳定协作者后再评估组织级
规则、独立策略仓库和人员批准。

各层证据边界如下：

| 层 | 能证明 | 不能证明 |
|---|---|---|
| 本地 Review | 指定 runner/model 在绑定输入上返回了何种结构化判断 | 模型判断一定正确；GitHub 上必然执行过 |
| Validator | 当前 story 的验收标准获得了引擎签发的验证结果 | 工程结构优秀；交付条件全部满足 |
| GitHub CI | 默认分支旧工作流对当前提交执行的机械任务结局 | 本地 AI Review 已运行；owner 永远不能改规则 |
| Ruleset | 日常合并必须满足已配置的 PR 和状态检查 | 仓库 owner 无法删除规则 |
| staged 制品 | 三个项目验证的是同一候选 tarball | 未经后续核验的 dist-tag、标签和 Release 自动一致 |

## 公开入口

不新增 `quality` 命令族：

- `coding-x init`：初始化项目质量契约、原生 GitHub CI、模板和远端门禁，不调用模型；
- `coding-x`：保留 Developer → 机械检查 → 可选 TDD → Validator 循环，在全部 story 完成后
  进入最终 Review；
- `coding-x --shadow`：只用于候选版本 Dogfood，最终固定返回 shadow 结局，不能表示可交付；
- `/review-loop`：让用户处理 findings、授权修复、提交反证或登记延期；
- `coding-x doctor`：只读检查契约、固定版本、GitHub 规则、CI 和例外漂移；
- `coding-x status` / `report`：分开显示实现验证、本地 Review 和远端交付状态。

## 项目质量契约

### 唯一来源

每个新接入项目必须提交 `.coding-x/quality.json`。它是项目机械质量规则的唯一来源，至少
包含：

- 契约 schema 版本和正式运行所需的精确 coding-x 版本；
- 默认分支、GitHub `owner/repo` 和受保护发布引用；
- Spec、验收标准和工程规范来源；
- 测试、构建、静态检查、安全检查以及每个不适用项的理由；
- 多模块范围、适用路径、工作目录、运行系统、工具链精确版本、任务检查范围、超时和生成产物目录；
- 高风险目录、默认风险类别和项目覆盖项；
- GitHub 必需检查名称，以及项目明确选择时才启用的代码扫描工具与阻断阈值；
- P1 延期和紧急政策例外的模板、字段与到期规则。

机械命令默认使用 `executable`、`args`、`cwd`、`platforms`、`timeoutMs` 和适用路径的结构化
形式。GitHub `jobs` 另行明确任务 ID、系统、Node/Go/Python 工具版本、准备命令和实际执行的
检查 ID，因此能表达同一系统的多版本任务，也不会把 coding-engine 的 Node 矩阵偷偷套给
Go/Python 项目。只有确需管道或重定向时才允许显式 `shell` 与脚本内容；shell 模式必须在
初始化时向用户展示并确认。工具链只生成 coding-x 内置且固定完整提交标识的官方 setup
action，不允许契约注入任意 action。

PRD 中的 `qualityChecks` 由契约冻结派生，并记录契约摘要，不再要求用户维护第二份命令。
GitHub 工作流也由同一契约生成。缺少契约、schema 过新、正式运行版本与固定版本不一致，
都在启动任何 agent 前返回配置错误。只有 `--shadow` 能允许候选版本在不签发正式结果的
前提下运行。

### 初始化状态机

完全空的远端没有可保护的默认分支，因此用户先创建一个最小初始提交；这是唯一仓库创建
例外。之后初始化分为四个可回读状态：

1. `minimum-protected`：`init` 探测项目与 GitHub 能力，用户确认命令、规范和最小规则后，
   先配置“必须 PR、禁强推、禁删除”并回读；
2. `bootstrap-generated`：回读成功后生成契约、CI、PR 模板和政策例外 Issue 模板，用户自行
   提交、推送并打开 Bootstrap PR；
3. `bootstrap-protected`：首次 `quality-gate` check-run 已在 Bootstrap PR 的最新提交出现后，
   用户再次运行 `init`，将它连同 GitHub Actions 来源绑定到 Ruleset 并回读；Bootstrap PR
   通过该检查后才能合并；
4. `ready`：`policy-guard` 工作流已进入默认分支后，再用一个 Activation PR 让默认分支旧
   工作流为该 PR head 产生真实 `policy-guard-source` 任务。`init` 将其绑定为必需检查并
   回读后，该 PR 才能合并。Bootstrap PR 不伪造同名占位检查，也不能要求尚不存在于默认
   分支的政策检查。

初始化不自动 commit、push、开 PR 或合并。任一阶段中断后可以幂等重跑；`doctor` 在进入
`ready` 前始终返回非就绪。私有仓库若账户套餐或权限不支持所需 Ruleset，初始化停止，不
降级为“只有 CI”。

### PR 意图合同

生成的 PR 模板要求填写：目标、非目标、Spec 与验收来源、验证方式、风险、是否主动要求
深度评审、关联延期或政策例外 Issue。模板不包含“AI 已通过”复选框，也不复制本地 Review
报告。

## Developer、Validator 与最终 Review

### Story 循环

每个 story 的顺序保持：

1. Developer 实现；
2. 从质量契约冻结出的机械检查；
3. 可选 TDD 门禁；
4. Validator 逐条验证验收标准；
5. 引擎签发 Validator 结果。

Validator 不承担工程标准或结构 Review。修复产生新提交后，受影响的 Validator 和最终
Review 都必须重新运行。

### 最终 Review 前置条件

全部 story 验证完成后，引擎依次确认：

- 当前在功能分支，不是契约中的默认分支；
- 工作树干净，仅允许 workspace 和契约明确声明的生成产物；
- 已获取远端最新默认分支，当前分支包含该提交；引擎不自动 merge、rebase 或改写历史；
- 当前分支存在目标为默认分支的开放 GitHub PR；
- PR 正文包含目标、Spec 和验收标准来源。

缺 PR 返回远端未就绪；意图资料不完整返回 `unverifiable`，都不能签发正式 Review。

### 三层 Review

1. 先重新执行完整机械检查；
2. Spec Review 独立比较 PR 意图、验收标准、关联规格和实际 diff；
3. 工程标准 Review 使用 coding-x 内置跨语言底线和默认分支上的项目规范；
4. 风险触发时执行深度结构 Review；
5. 最后查询 GitHub PR、CI 和 Ruleset 状态。

产品 Spec 可以来自当前 PR 新增或修改的规格；工程标准、质量契约、Review 规则和工作流始终
使用默认分支旧版本裁决，防止 PR 同时削弱裁判并批准自己。三类 Review 隔离上下文、顺序
运行并分别保留结果；总流程不能重新排序、合并或淡化 findings。

Spec 轴只评审“仓库改动应具备什么行为”，不负责证明“本轮交付流程是否已经完成”。引擎在
进入各轴前机械确认完整检查已绑定当前 head 通过，并把这一事实和责任边界写入审查包；全部
Review 轴是否完成、GitHub CI/Ruleset 是否就绪以及发布状态，均由引擎在各轴结束后独立判定。
PR 若把这些流程后置条件写入验证计划，Spec 轴不得因无法预知自身完成状态而形成循环证明；
但改动本身若错误描述或破坏流程边界，仍属于可报告问题。

### 深度 Review 触发

以下任一条件触发：

- 质量契约、工作流、Reviewer、Validator、发布或门禁变化；
- 公开接口、命令、配置、数据格式或插件契约变化；
- 状态、迁移、恢复、幂等、并发、锁、超时、重试或子进程变化；
- 权限、安全、隐私、秘密或不可信输入变化；
- 一次影响三个及以上模块；
- 手写文件跨越 1000 行；
- 项目声明的高风险目录；
- Reviewer 主动升级或用户在 PR 中要求。

生成文件、依赖代码、锁文件和快照不参与千行判断。

### 精确绑定与失效

最终 Review 结构化结果同时绑定：

- PR 编号、目标分支、base SHA、head SHA；
- PR 标题和正文规范化摘要；
- Spec、默认分支工程标准、默认分支质量契约摘要；
- coding-x 精确版本；
- runner 类型、实际模型、runner 版本和 Review 规则版本；
- 风险判断输入和结果。

任一项变化，旧 Review 立即失效。只有远端 CI 状态变化时，`status` 可只查询 GitHub 而不
再次调用模型。

## Reviewer 隔离

### 审查包

Reviewer 不在开发者工作目录执行。引擎从绑定的 Git 对象建立临时、最小、只读审查包，
只包含：

- base/head 的已跟踪必要文件；
- 精确 diff 与变更文件清单；
- PR 意图、验收标准、Spec；
- 绑定当前 head 的前置机械检查结果，以及由引擎负责的后置验证边界；
- 默认分支工程规范、质量契约与 Review 规则；
- 必要且有界的历史摘要。

不复制 `.env`、workspace、未跟踪文件、本机配置、GitHub/npm 写凭据或项目秘密。Review
输出只从标准输出接收，校验为严格结构后由引擎写入 workspace；不保存完整模型对话。

### Runner 合同

- Codex：使用独立权限配置默认拒绝文件访问，只向当次临时审查包授予读权限；
  同时使用临时会话、忽略用户配置和项目执行规则、禁用工具并严格校验结构化事件；
- Claude：安全模式、计划权限、无会话持久化、严格空 MCP，只开放所需读取工具；
- Cursor：ask/plan 模式、启用沙箱，不自动批准 MCP；
- 所有 runner 禁用项目 MCP、hooks、插件和浏览器能力，并使用最小环境变量；
- 每个 runner 必须通过真实的写文件、危险命令、秘密读取和 MCP 调用反向测试后，才能标记
  为支持。

无法保证只读时返回 `unverifiable`，不得退回危险 bypass 参数。格式错误或临时服务失败最多
用同一 runner/model 重试一次；不自动切换模型。

一般的 `read-only` 模式只能约束模型发起的写操作，不自动等于“只能读审查包”。
因此不把参数存在当成隔离证据；权限白名单和每次真实反向测试缺一不可。

### 上下文完整性

调用前估算必要上下文能否完整提供。禁止静默截断，也不自动拆成八个或更多模型分片。
无法可靠覆盖时返回 `unverifiable` 并建议拆分 PR。关键 LFS 内容不可读、子模块指针无法
核验或关键二进制变化同样不可验证。

## Findings 与人工裁决

每个 finding 包含：稳定 ID、评审轴、严重度、具体位置、违反来源、实际影响、建议处理、
PR/base/head、评审轮次和状态。

- P0：必须修复，或由用户提交具体反证后驳回；
- P1：默认阻断；只有关联有效延期 Issue 才可延期；
- P2、Info：不阻断，可确认知悉；
- 产品、架构和业务决策：等待用户，模型不能替代。

`/review-loop` 写结构化裁决记录，不再把 Markdown 当正式状态。记录至少包含 finding ID、
绑定 head SHA、处理方式、操作者、反证或 Issue 和时间。P1 延期 Issue 必须有负责人、原因、
到期日和跟进事项；`doctor` 检查 Issue 开放、字段完整且未过期。

删除旧行为：缺 PRD 降级普通 diff Review、所有质量问题默认不阻断、自由编辑 Markdown 即
视为完成。

## 状态与退出码

本地结构化状态使用三态：`passed`、`failed`、`unverifiable`。CLI 退出码：

| 码 | 含义 |
|---|---|
| 0 | 本地与远端均可交付 |
| 1 | 机械检查或执行失败 |
| 2 | 配置、契约、版本或状态无效 |
| 3 | story 已阻断 |
| 4 | 存在待人工处理的 Review finding |
| 5 | Review 无法验证 |
| 6 | 本地已完成，但 PR、远端 CI 或规则尚未就绪 |
| 7 | shadow 运行完成，不能表示可交付 |

结构化结果和阅读用 Markdown 都只保存在被 Git 忽略的 workspace；它们不是共享交付凭证。
`status/report` 必须分别展示 story 验证、本地 Review、远端 CI/规则和最终交付结论，不能用
“所有 story 通过”代替“可交付”。

## GitHub 机械门禁

### 默认分支 Ruleset

正式规则要求：所有改动经过 PR、批准人数 0、分支包含最新默认分支、所有对话解决、禁止
强推和删除、无日常绕过者。所需检查限制为 GitHub Actions 提供；文档明确同一 App 下不同
工作流不能被 cryptographically 区分。质量契约若明确声明代码扫描工具和阈值，Ruleset 还
必须要求该工具完成分析，并在结果达到阈值时阻止合并；契约没有声明时，coding-x 不猜测
项目生态，也不删除仓库已有的更严格扫描规则。

### 不可跳过总闸

项目检查可以拆成多个原生 job，但 Ruleset 只要求稳定名称 `quality-gate`：

- 使用始终执行语义；
- 逐项读取所有必需 job 结果；
- 任一失败、取消、超时、跳过或缺失都失败；
- 必需工作流本身不使用路径过滤；
- 无适用模块时仍由 job 和总闸记录原因后明确成功。

### 政策变化

默认分支旧 `policy-guard` 识别质量契约、工作流、工程原则和发布规则变更。若使用
`pull_request_target`，只通过 API 读取文件列表、标签和 Issue 元数据；不签出、不执行、
不拼接运行 PR 内容。一次性政策标签仅表示 owner 明确批准，必须关联有效 Issue，不称为
第二方审批。Ruleset 直接要求 GitHub 为该默认分支工作流产生、并关联 PR 最新 head 的真实
`policy-guard-source` 任务；工作流不再通过 Checks API 额外写入一条结果，也不需要检查写
权限。所有第三方 Action 固定完整提交 SHA，并采用最小权限。

### coding-engine 检查矩阵

- Ubuntu / Node 22：类型检查、全量测试、构建、仓库机械健康、成品命令冒烟、格式、静态检查、
  依赖审计；
- Ubuntu / Node 24：全量测试、构建、成品命令冒烟；
- macOS / Node 24：关键测试、构建、成品命令冒烟；
- Windows / Node 24：关键测试、构建、成品命令冒烟；
- `quality-gate`：汇总上述任务。

运行时最低版本提升到 Node 22；发布使用 Node 24 和 npm 11.15 以上。启用 Dependabot、自动
安全更新、秘密扫描、推送保护和 TypeScript CodeQL；平台或套餐不支持的能力明确报告，
不能静默写成已启用。coding-engine 的 CodeQL 规则要求安全告警达到 high 及以上时阻断，
普通告警达到 error 时阻断。

仓库机械健康只检查 coding-engine 的真实文档、质量契约和契约生成文件，不比较候选运行版本，
也不产生可交付结论。完整 `doctor` 始终保留精确版本判断；GitHub 与候选暂存不得通过接受
shadow 或忽略非零退出码来绕过它。首次 0.33.0 使用一次性的机械 CI 和 owner 人工 Bootstrap，
不声称完成正式本地 AI Review；受保护 main 上的 0.29.0 只可独立复核仓库健康。发布并通过
独立 Policy PR 固定 0.33.0 后，正式自托管 Review 才开始。

## 候选发布、自托管与回退

### 发布顺序

1. 版本更新通过受保护 PR 合并到 `main`；
2. 暂存工作流从精确 main 提交构建并执行全部检查；
3. npm OIDC Trusted Publisher 只允许 staged publish；
4. 最终稳定版本先进入 staging，批准目标为 `next`；
5. 下载精确候选 tarball，记录提交、stage ID 和文件 SHA-256；
6. coding-engine、Go、Python 都安装该 tarball，以 `--shadow` 运行候选能力；
7. 维护者用 2FA 批准到 `next`；
8. 三个项目从公开 registry 按精确版本执行关键安装冒烟；
9. 人工把同一版本提升为 `latest`；
10. 创建指向同一提交、禁止更新删除的 `v*` 标签和不可变 GitHub Release。

原“推送标签即直接发布 npm”流程删除。标签流程只验证 npm 版本、提交和来源信息，再创建
Release。发布任务还必须确认标签提交属于受保护 main。

若 npm staging 实际不可用，经用户明确确认后，临时允许 OIDC 将同一版本发布到 `next`；
三仓验证和 `latest` 人工提升顺序不变，随后恢复 stage-only 权限。

### 失败与恢复

- staging 前失败：修复 PR，使用新提交重新暂存；
- stage 长期未批准：doctor 告警，由维护者批准或拒绝；
- 已进入 `next` 后失败：保留原版本，不移动 `latest`，发布新补丁；
- 已移动 `latest` 后失败：立即把 `latest` 恢复到前一个稳定版本，标记问题版本并发布补丁；
- 不覆盖或删除已发布版本；npm 来源信息的实际出现时机必须在试点中核验。

### 稳定版裁判

质量契约固定精确版本。正式模式只有版本一致才运行；不一致只能拒绝或显式 shadow。首次
0.33.0 由现有机械 CI 和人工 Bootstrap 裁决。之后稳定版 N 正式评估候选 N+1；N+1 发布后，
再用旧规则审查的 Policy PR 更新固定版本。候选版本不能为自身签发正式结果。

## 明确非目标

- 不在 GitHub 调用模型或存放 AI 密钥；
- 不要求 GitHub 证明本地 AI Review；
- 不自动拆成八个模型分片；
- 不引入 Git 代理、守护进程、数据库、TUI 或中央质量平台；
- 不让 AI 自动批准例外、合并、推送、打标签或发布；
- 不把 Markdown、PR 文本、标签或 npm 来源信息解释为代码质量证明；
- 不为旧项目设计迁移；v1 只支持 GitHub 强门禁；
- 单人阶段不伪造第二位审批者，也不宣称 owner 无法绕过规则。

## 验收矩阵

### 本地

- 缺契约、schema 过新、版本错误、脏工作树、默认分支、落后分支、缺 PR 分别得到约定错误；
- PR 正文、Spec、提交、规则、runner/model 变化使旧 Review 失效；CI 单独变化不触发重审；
- 缺 Spec、模型异常、格式损坏、上下文不足、关键内容不可读返回 `unverifiable`；
- Reviewer 写文件、危险命令、秘密、MCP、hook 和插件反向测试全部失败；
- P0、P1、人工决策与不完整延期 Issue 阻断；修复提交后 Validator/Review 重跑；
- shadow 始终退出 7，不能转成正式通过。

### GitHub

- 最小锁在 Bootstrap PR 前阻止直接推送；首次 check-run 出现后才能加入 required checks；
- 任何平台任务失败、取消、超时或未运行使总闸失败；`[skip ci]` 和条件跳过不能假绿；
- 政策变化由默认分支旧 guard 识别；有凭据任务不执行 PR 内容；
- 权限不足、规则漂移或私库能力不足明确失败；工作流扫描确认无模型调用和 AI 凭据。

### 发布和外部项目

- staging 下载物、三个项目安装物、`next` 和最终稳定物摘要一致；
- `latest` 在三个公开精确版本冒烟前不变；npm、标签、Release 指向同一提交；
- 回退演练能恢复前一个稳定版本；
- Go 和 Python GitHub CI 不安装 Node 或 coding-x；两个外部仓库保持私有；
- 三个真实 PR 完成后才关闭 Bootstrap Issue。
