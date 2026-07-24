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
5. Spec 评审缺少 PR 意图、验收标准、非目标或验证方式时必须
   `unverifiable`；工程标准评审与 Spec 评审不互相覆盖。
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
    "model": "openai/gpt-4.1",
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
    "codingXVersion": "0.30.1",
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
- source 可以是文件或目录；目录只读取 Git 已跟踪的文本文件，并受单文件/总输入大小上限保护；
- 契约变更本身属于高风险改动，当前 PR 仍由默认分支旧契约裁决；
- GitHub 模型 ID进入 GitHub adapter，不进入 runner-neutral 的三态、finding 与 receipt 核心合同。

`.coding-x/exceptions.json` 同样严格版本化，分为普通 finding 延期与紧急交付记录。普通延期
必须有 finding ID、原因、责任人、ISO 截止时间和后续 URL；过期、字段缺失、head/范围不匹配
或契约未允许该严重级别延期时均无效。紧急交付必须额外记录精确提交和 GitHub 审计 URL；
未写 `resolvedAt` 的记录无论是否到期都让 doctor 显示 `unverifiable / 异常交付`，不能把
临时绕过包装成正常通过。

## 评审合同

### 输入

三条评审都绑定：

- repository、PR number、base SHA、head SHA；
- 默认分支质量契约及其 SHA-256；
- PR 标题、正文和完整 diff；
- 当前轴所需的 source 文本；
- 风险判定结果。

PR 正文必须有四个非空段：意图、验收标准、非目标、验证方式。结构缺失时 Spec 轴不调用模型，
直接 `unverifiable`。

输入中的仓库内容全部用明确边界标为不可信数据。评审模型无工具、无写权限，不能服从 diff、
PR 正文或源码中的指令。

### 输出

模型只返回 schema 约束的 `summary` 与 `findings`；最终状态由 coding-x 机械计算。每条 finding：

- 稳定 ID、axis、severity、当前 head 和评审 round；
- 文件与可选行号；
- 标题、具体证据、违反的来源；
- 真实影响与建议处理。

严重度为 `critical | high | medium | low`：

- critical/high：阻断，不能由普通延期放行；
- medium：默认阻断，可由有效例外放行；
- low：提示，不阻断。

引擎外层 receipt 记录状态、base/head、契约摘要、模型、耗时、finding 数量、例外匹配和错误码。
receipt 以 JSONL 追加到 workspace；GitHub 通过 Check Run 保存共享结论。旧 head 的 receipt
只能用于追溯，不能用于当前提交。

### 三条轴

1. **Spec**：只回答实际改动是否符合意图、验收标准和非目标；必须引用 PR 段落或规格来源。
2. **Standards**：只回答改动是否违反项目标准和通用工程底线；不得重复报告已由项目命令确定
   的格式、类型或测试失败。
3. **Deep**：只在风险判定要求时执行，检查职责边界、重复真相源、错误传播、原子性、并发、
   可恢复性和无价值抽象。单纯“可以写得更漂亮”不能成为阻断项。

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
2. `coding-x-review.yml`：`pull_request_target`，使用默认分支固定版本的 coding-x；拥有
   contents/pull-requests/models read 与 checks write；不签出 PR head，不执行 PR 文件，通过
   GitHub API 读取数据并在精确 head SHA 上发布 Spec、Standards、Deep 三个 Check Run。

远端评审使用 GitHub Models 和自动提供的 `GITHUB_TOKEN`，不要求上传本机模型密钥。API 错误、
限流、模型不支持结构化输出或响应无法验证时，对应 Check Run 为 failure，结论
`unverifiable`。

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
- 缺 PR 时要求 `--intent-file` 提供四段意图，否则 Spec 为 `unverifiable`；
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
4. 后续 PR 添加 coding-engine 的自托管工作流，固定使用 0.30.1；
5. 该 PR 通过过渡规则后，启用完整 ruleset；
6. 以后升级受管版本时，更新 PR 由旧版本规则评审，合并后新版本才生效。

coding-engine 契约包括 typecheck、test、build、doctor、构建 CLI 冒烟、lint、diff check 和高危
依赖审计；CI 另跑 Node 18/22 与 Linux/macOS/Windows 兼容矩阵。发布工作流验证 tag 提交位于
main，且关联提交通过完整质量门禁。

## 失败语义

| 场景 | 结果 |
|---|---|
| 契约缺失/畸形/未知字段 | unverifiable，退出 2 |
| 项目命令非零/超时 | failed，退出 1 |
| 命令无法启动、cwd 越界 | unverifiable，退出 2 |
| PR 四段意图缺失 | Spec unverifiable，不调用模型 |
| 模型/API/结构化输出失败 | 对应轴 unverifiable |
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
