---
title: "coding-engine 与下游项目双层质量门禁设计"
status: active
updated: 2026-07-24
scope: root
---

# coding-engine 与下游项目双层质量门禁设计

## 目标

建立一套由 coding-x 提供、同时约束 coding-engine 自身和下游项目的质量闭环：

1. 项目用自己的测试、构建和静态检查命令，coding-x 只统一配置、执行结果与证据语义；
2. Code Review 分成 Spec、工程标准、按风险触发的深度结构三条独立轴；
3. 本地评审只作快速反馈，GitHub PR 对最新提交独立重跑并拥有合并门禁权；
4. 缺配置、缺意图、模型不可用、结果畸形、提交变化或远端规则漂移均为
   `unverifiable`，与明确失败一样阻断；
5. coding-engine 先发布机制，再固定使用已发布版本自托管，不能用 PR 中正在修改的门禁代码
   批准自己。

首版完整支持 GitHub。其他托管平台没有适配器时必须明确报告 `unverifiable`。

## 完成合同

首版同时满足以下条件才算完成：

1. 新项目可用 `coding-x quality init` 生成受 Git 管理的质量契约、PR 模板和三条职责隔离的
   GitHub 工作流；远端变更必须预览、确认、应用并回读核验。
2. `.coding-x/quality.json` 至少有一条项目原生检查，支持非 Node 项目、子目录工作目录和多模块
   仓库；路径不能越出 Git 根。
3. 初始化必须确保 `.workspace/` 由受 Git 管理的忽略规则隔离；`quality review` 在本地独立运行
   Spec、工程标准和风险判定，结果只写
   `<workspace>/quality/`，不被包装成远端通过凭证。
4. `quality gate` 能无交互运行项目命令或一条评审轴，机器输出只有
   `passed`、`failed`、`unverifiable` 三态，且绑定 base/head SHA、契约摘要和评审轮次。
5. Spec 评审缺少 PR 意图、验收标准、非目标、验证方式或明确的关联规格声明时必须
   `unverifiable`；没有独立规格的 PR 必须明说“本 PR 意图即完整 Spec”，工程标准评审与
   Spec 评审不互相覆盖。
6. 公开接口、状态/持久化、并发/锁、权限/安全、恢复、发布、跨模块、政策文件、大改动或
   超大文件触发深度评审；未触发时留下明确的 `not-required` 理由。
7. 严重发现必须修复；普通延期只有匹配未过期的例外记录时才可放行；需要人判断的发现不能
   被自动确认参数替人关闭。
8. 任意新提交使旧评审失效。结果缺失、格式错误、模型错误、提交错配、契约错配或异常过期
   均 fail closed。
9. GitHub 项目命令不获得模型或写权限；AI 评审不签出、不执行 PR 代码，只通过 API 读取
   PR 元数据、diff 和文件内容。工作流自身来自默认分支。
10. GitHub 规则集要求 PR、最新提交检查、对话解决、禁止强推/删除，并要求项目检查及三条
    评审状态。单人维护时人工批准数为 0，增加协作者后可提升。
11. `quality doctor` 同时检查本地契约/工作流和真实 GitHub 规则；没有凭据、权限不足、规则
    缺失或不一致不得显示通过。
12. `run/status/report` 区分“实现已验证”与“交付已就绪”；workspace 评审文件明确标成
    本地反馈，GitHub Check/PR 历史才是共享交付记录。
13. coding-engine 的类型检查、测试、构建、doctor、CLI 冒烟、静态检查、依赖审计和兼容矩阵
    进入同一契约；实际 GitHub PR 和一个非 Node 下游 PR 都走通完整闭环。

## 统一质量契约

根目录 `.coding-x/quality.json` 使用严格的 version 1 schema：

```json
{
  "version": 1,
  "checks": [
    {
      "id": "test",
      "command": "pytest -q",
      "cwd": ".",
      "paths": ["src/", "tests/"]
    }
  ],
  "review": {
    "provider": "github-copilot",
    "model": "auto",
    "copilotCliVersion": "1.0.74",
    "specSources": ["docs/specs/"],
    "standardsSources": ["AGENTS.md", "docs/golden-principles.md"],
    "deepReview": {
      "highRiskPaths": [".github/", ".coding-x/"],
      "changedProductionLines": 400,
      "largeFileLines": 1000
    }
  },
  "github": {
    "repository": "owner/repo",
    "defaultBranch": "main",
    "releaseRefs": ["refs/tags/v*"],
    "codingXVersion": "0.30.4",
    "requiredChecks": [
      "coding-x / project-checks",
      "coding-x / spec-review",
      "coding-x / standards-review",
      "coding-x / deep-review"
    ]
  },
  "exceptionPolicy": {
    "deferrableSeverities": ["medium"]
  },
  "exceptionsFile": ".coding-x/exceptions.json"
}
```

约束：

- 所有未知字段拒绝；字符串必须非空；检查 ID 唯一；
- `cwd`、source、paths 和 exceptionsFile 只能是项目内相对路径，realpath 不能越界；
- `checks` 至少一条；命令由项目提供，coding-x 不推断其输出文本，只看退出码、超时和启动错误；
- `paths` 决定当前 diff 是否适用该检查；未命中会留下明确的 not-applicable 通过记录，命中后
  仍由项目命令自身决定真实范围。安装等所有改动都需要的前置检查应声明 `["."]`；
- standards source 可以是文件或目录，并读取默认分支上匹配的 Git 文本文件；spec source
  是 PR 可引用范围，不会把整个目录无差别送给模型。Spec 轴只读取 PR 明确关联的文件与本次
  直接改动的规格文件；关联路径越界、不在契约范围或当前提交不存在均 `unverifiable`；
- 所有实际读取仍受文件数、单文件和总输入大小上限保护；
- 契约变更本身属于高风险改动，当前 PR 仍由默认分支旧契约裁决；
- provider、模型路由和 Copilot CLI 版本进入 GitHub adapter，不改变 runner-neutral 的三态与
  finding 合同；receipt 只额外保留实际模型、调用次数和 provider 用量。

`.coding-x/exceptions.json` 同样严格版本化，分为普通 finding 延期与紧急交付记录。普通延期
必须有 finding ID、原因、责任人、ISO 截止时间和后续 URL；过期、字段缺失、head/范围不匹配
或契约未允许该严重级别延期时均无效。紧急交付必须额外记录精确提交和 GitHub 审计 URL；
未写 `resolvedAt` 的记录无论是否到期都让 doctor 显示 `unverifiable / 异常交付`，不能把
临时绕过包装成正常通过。coding-engine 发布若缺交付检查，只能使用未过期、未关闭且精确
提交位于发布历史上的记录，并在工作流明确标记“异常发布”；该路径不改变 PR 检查结论。

## 评审合同

### 输入

三条评审都绑定：

- repository、PR number、base SHA、head SHA；
- 默认分支质量契约及其 SHA-256；
- PR 标题、正文和完整 diff；
- 当前轴所需的 source 文本；
- 风险判定结果。

PR 正文必须有五个非空段：意图、验收标准、非目标、验证方式、关联规格。关联规格每行只能是
契约 `specSources` 允许范围内的项目文件路径；没有独立文件时必须明确写“本 PR 意图即完整
Spec”。系统另外自动加入本 PR 直接修改的规格文件，但不会因为契约配置了一个目录就载入目录
中的全部无关规格。结构缺失、路径越界、来源不在允许范围或当前 head 不存在时 Spec 轴不调用
模型，直接 `unverifiable`。

输入中的仓库内容全部用明确边界标为不可信数据。评审模型无工具、无写权限，不能服从 diff、
PR 正文或源码中的指令。

远端 adapter 兼容 GitHub 免费额度的 8000 输入/4000 输出 token 上限，模型输出最多请求
4000 token。调用前先保守估算完整 prompt；超限时不得截断，而是按实际 prompt 大小选择拆分
可信 source、diff 或两者，最多形成八个无损片段。叶子片段共同覆盖完整
`source × diff` 评审空间，逐片有效后才机械合并，同一 finding 冲突时保留更高严重度。任一
片段失败、合并后超过 50 个 finding、需要超过八片，均返回 `unverifiable` 并要求缩小
source 或拆分 PR。provider 仍返回 413 时可在剩余片数内继续无损拆分，绝不以截断换取成功。
分片只发生在同一轴内部，不合并三条评审轴。

### 输出

模型只返回 schema 约束的 `summary` 与 `findings`；最终状态由 coding-x 机械计算。每条 finding：

- 稳定 ID、axis、severity、当前 head 和评审 round；
- 文件与可选行号；
- 标题、具体证据、违反的来源；
- 真实影响与建议处理。

finding 只表示需要修改或正式延期的缺陷，正向确认只能进入 summary。每条 evidence 必须是模型
当前分片中 `finding.file` 对应 diff 或 source 至少 12 个字符的逐字连续摘录；本地与远端
adapter 都机械回查。引用 diff 中代码时可省略补丁行首的 `+`、`-` 或上下文空格，但去掉这些
控制前缀后的代码仍须在同一文件连续逐字出现。改写、虚构、过短、跨文件或跨分片引用，以及
建议明确表示“无需修改”的正向确认，都不是有效 finding。

远端模型第一次返回上述可纠正的无效结果时，adapter 在同一隔离分片上追加机械拒绝原因并且
只重审一次。纠正轮重新生成完整输出，不继承首次 summary 或 finding；第二次仍无效即
`unverifiable`。provider 错误、输入超限、调用中断或提交身份变化不走语义纠正重审。

严重度为 `critical | high | medium | low`：

- critical/high：阻断，不能由普通延期放行；
- medium：默认阻断，可由有效例外放行；
- low：提示，不阻断。

引擎外层 receipt 记录状态、base/head、契约摘要、模型、耗时、finding 数量、例外匹配和错误码。
receipt 以 JSONL 追加到 workspace；GitHub 通过 Check Run 保存共享结论。旧 head 的 receipt
只能用于追溯，不能用于当前提交。

### 三条轴

1. **Spec**：只回答实际改动是否符合意图、验收标准和非目标；只读取 PR 明确关联及直接修改
   的规格文件，必须引用 PR 段落或实际载入的规格来源。
2. **Standards**：只回答改动是否违反项目标准和通用工程底线；不得重复报告已由项目命令确定
   的格式、类型或测试失败。
3. **Deep**：只在风险判定要求时执行，读取工程标准来源与 diff，检查职责边界、重复真相源、
   错误传播、原子性、并发、可恢复性和无价值抽象。Spec 来源只由 Spec 轴消费，Deep 不重复
   载入或重新裁决产品范围。单纯“可以写得更漂亮”不能成为阻断项。

## 风险判定

以下任一条件触发深度评审：

- 变更 `.coding-x/`、质量工作流、发布工作流或项目标准；
- 触及契约声明的 highRiskPaths；
- diff 文本命中公开接口、状态/数据库、锁/并发、权限/安全、恢复/迁移、发布等稳定风险词；
- 同时修改三个及以上顶层生产模块；
- 生产代码新增/删除行达到契约阈值；
- 变更后的已跟踪生产文件达到大文件阈值。

无法可靠计算影响范围时按高风险处理。阈值是调查触发器，不是 finding。

## GitHub 安全分层

生成两条工作流：

1. `coding-x-project-checks.yml`：由可信默认分支工作流调用，分别签出 base 契约与 PR head，
   项目命令步骤拿不到持久化仓库凭据、模型、checks write 或其他敏感权限；两个 checkout
   也使私有仓库不依赖匿名 fetch。
2. `coding-x-review.yml`：`pull_request_target`，使用默认分支固定版本的 coding-x 与
   GitHub Copilot CLI；拥有 contents/pull-requests read、checks write 与
   `copilot-requests: write`；不签出 PR head，不执行 PR 文件，通过 GitHub API 读取数据并在
   精确 head SHA 上发布 Spec、Standards、Deep 三个 Check Run。

远端评审从 0.31.0 起使用 GitHub Copilot CLI。GitHub Models 将于 2026-07-30 完全退役，
不再作为回退。workflow 使用内建 `GITHUB_TOKEN` 完成 GitHub API 与 Copilot 请求，不保存
`CODING_X_MODEL_TOKEN`。coding-x 为每次调用创建独立临时 Git 根和 `COPILOT_HOME`，将可信
system prompt 写成 `tools: []` 的 custom agent；PR diff、来源和意图仅作为不可信 user data。
调用禁用全部工具、内建 MCP、项目/用户指令、远程会话、远程导出和自动更新。

Copilot CLI 与 coding-x 都固定完整版本。adapter 先核对 CLI 版本，再有界解析 JSONL：只接受
一个无工具请求的最终回复、成功 result，以及与该次 auto 路由事件一致的实际模型；代码围栏只
可包裹单个 JSON 对象。单次调用最长等待五分钟；超时、输出过大、事件损坏、工具请求、单次
调用中的模型身份冲突、额度不足或组织政策禁用均为 `unverifiable`。`model: "auto"` 的全部
真实模型和 premium request 用量写入 receipt；同一轴多个分片可以由 provider 路由到不同模型，
但必须稳定列出所有实际身份。provider 未返回用量时不得以零代替。

每个 PR 只创建一个模型队列 job，在该 job 内依次运行 Spec、Standards、Deep 并分别发布
Check Run；不同 PR 的这个单一 job 再用 GitHub 原生 `queue: max` 并发组串行。不能让三个
有依赖关系的 job 同时加入同一队列，否则已完成轴可能留下后续轴永久等待。单轴分片保持顺序
调用；Copilot 没有可写入契约的稳定每分钟间隔，因此不伪造固定节流值，provider 拒绝时直接
`unverifiable`。AI job 只在隔离的项目命令 job 成功后进入模型队列，避免已经确定不能交付的
提交继续占用评审容量；两个 job 仍使用不同权限和工作区。新 head 由外层 PR 并发组取消旧运行。
该队列只协调当前仓库。

Copilot 额度仍不是无限容量保证。额度或政策不可用时，对应 Check Run 为 failure，结论
`unverifiable`；不以旧 Models、个人 secret 或本地报告静默降级。

规则集使用固定名称 `coding-x quality gate`。init 只更新同名 repository ruleset，不触碰用户
其他规则集。写远端前展示旧/新摘要并要求确认；写后重新 GET，按语义比较而不是相信写请求的
HTTP 成功。

管理员可以删除规则，这是平台权限边界。定时 `quality doctor` 检测漂移并失败，但不宣称形成
密码学不可绕过保证。

## CLI 行为

### `quality init`

- 必须在 Git 仓库根执行；
- 发现 package scripts、Makefile、pyproject、go.mod 等候选，只用于展示；
- 没有显式确认时不写文件；非交互环境必须传 `--yes`；
- 已有文件内容不一致时拒绝覆盖，除非内容仍是 coding-x 受管版本且升级路径明确；
- 在保留现有 `.gitignore` 内容的前提下补齐 `/.workspace/`，并由 doctor 核验该规则已进入 Git；
- 写入使用原子替换，失败恢复；
- GitHub remote 存在时预览规则；`--local-only` 明确只生成本地文件且最终状态为
  `unverifiable`，不能误报远端已就绪。

### `quality review`

- 只读 Git diff、契约和来源；源码不写；
- 缺 PR 时要求 `--intent-file` 提供五段意图与关联规格声明，否则 Spec 为 `unverifiable`；
- 三轴使用独立请求；Deep 未触发时记录 `passed/not-required`；
- 结果追加写入 `<workspace>/quality/receipts.jsonl` 和人类可读摘要。

### `quality gate`

- 无交互；支持 `--checks` 或 `--axis spec|standards|deep`；
- GitHub axis 模式只接受事件文件与 API 取得的身份，不接受用户自由传入 head 后直接发布可信状态；
- stdout 在 `--json` 下恒为一个可解析对象，诊断走 stderr；
- exit 0 仅对应 passed，failed=1，unverifiable=2。

### `quality doctor`

- 本地检查不需要网络；
- 完整检查要求 GitHub token；无 token 或 API 权限不足为 `unverifiable`；
- 核对契约、受管工作流内容、默认分支、规则集、required checks、严格最新提交策略、禁止强推/
  删除、例外过期和发布规则；
- 只读，不自动修复远端。

## coding-engine 自托管

首次实现 PR 不能由尚未发布的新门禁裁决，采用显式 bootstrap：

1. 新能力在现有 CI、完整测试和独立人工/agent 复核下进入 main；
2. 发布 0.30.0；
3. 自托管预演发现同名源码仓库的直接 npx 调用冲突，发布隔离安装修复 0.30.1；
4. 后续 PR 添加 coding-engine 的自托管工作流并启用完整 ruleset；
5. 首次远端运行发现 npm 前缀目录不存在及免费模型输入超限，经 #13 公开记录后，仅在原有
   四平台 CI 和项目命令通过时执行有界 bootstrap；
6. v0.30.2 的发布校验因默认 Actions 身份无法完整读取 ruleset 而安全失败，标签保留且不移动；
7. 发布工作流改用显式管理只读凭据，并以受 Git 管理的未关闭异常记录发布 0.30.3，日志标记
   异常而非伪造检查成功；
8. v0.30.3 首次真实自托管 PR 暴露模型请求和干净检出两项兼容问题，PR 保持阻断且不合并；
9. 两项修复通过真实 provider 与干净检出复验后发布 0.30.4，由 0.30.4 完整裁决后续真实 PR，
   成功后关闭异常；
10. 后续结构治理 PR 的仓库自动 token 用尽免费 Models 周期额度，三轴均保持
    `unverifiable`；#23 记录恢复过程，0.30.5 将 GitHub API token 与专用模型 token 隔离，
    不以例外把不可用伪装成通过；
11. 0.30.6 对 429 按 `Retry-After` 在两分钟内最多尝试五次，并将三轴依次调度；重试耗尽仍
    为 `unverifiable`，不改变三态语义；
12. 真实运行继续证明“单个 PR 串行”不足以约束多个 Dependabot/人工 PR 的共享额度，且高限流
    档每日 50 次免费请求不适合作为默认门禁。0.30.7 在首个请求前按完整 prompt 有界分片，
    使用低限流档默认模型，在单轴调用间节流，并用 GitHub 原生 job 队列把全仓模型任务串行；
13. 0.30.7 的结构治理预演发现 Deep 重复载入 Spec 与 Standards 来源，使任意高风险改动都可能
    因来源总量超过八片而不可验证；随后真实 PR 又证明把 `specSources` 目录下所有历史规格
    全部载入同样会耗尽预算。0.30.8 恢复轴隔离，并把 Spec 目录改成可信允许范围：Spec 只读
    PR 明确关联和直接改动的规格，Deep 只读取 Standards 与 diff；
14. 以后升级受管版本时，更新 PR 由旧版本规则评审，合并后新版本才生效。

coding-engine 契约包括 typecheck、test、build、doctor、构建 CLI 冒烟、lint、diff check 和高危
依赖审计；CI 另跑 Node 18/22 与 Linux/macOS/Windows 兼容矩阵。发布工作流验证 tag 提交位于
main，branch/tag ruleset 仍启用，并按 ruleset 的 GitHub App 来源核对关联 PR head；同名但来源
不同的 Check Run 无效。

## 失败语义

| 场景 | 结果 |
|---|---|
| 契约缺失/畸形/未知字段 | unverifiable，退出 2 |
| 项目命令非零/超时 | failed，退出 1 |
| 命令无法启动、cwd 越界 | unverifiable，退出 2 |
| PR 五段意图或关联规格声明缺失 | Spec unverifiable，不调用模型 |
| 关联规格越界、不在契约范围或 head 不存在 | Spec unverifiable，不调用模型 |
| 模型/API/结构化输出失败 | 对应轴 unverifiable |
| 首次 finding 是正向确认，或证据非当前分片同文件逐字代码/原文 | 同一分片带原因纠正重审一次 |
| 纠正重审仍无效，或 evidence 不足 12 字符 | 对应轴 unverifiable |
| 模型输入超限 | source/diff 无损分片覆盖完整评审空间；任一片失败或超过八片则 unverifiable |
| critical/high finding | failed |
| medium finding 无有效例外 | failed |
| medium finding有有效例外 | passed，并记录 exception |
| 新 head 与 receipt/check 不同 | 旧结果无效，完整重跑 |
| Deep 未触发 | passed，reason=not-required |
| provider 不是 GitHub | 远端 doctor unverifiable |
| ruleset/required checks 漂移 | doctor unverifiable |

## 非目标

- Git 代理、守护进程、数据库、TUI、中央质量服务或复杂签名。
- 自动修改代码、自动回答产品判断、自动批准例外、自动合并或自动发布。
- 从自然语言测试输出推断“有多少测试”或“测试一定有效”。
- 把本地 workspace 文件称为不可伪造的共享凭证。
- 首版支持 GitLab、Bitbucket 等其他远端适配器。
