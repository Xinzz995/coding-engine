---
title: "R7 Builder 进度只追加 Dogfood"
status: done
updated: 2026-08-06
scope: root
---

# R7 Builder 进度只追加 Dogfood

## Context

本轮分成两个不能互相替代的阶段。候选 Shadow 阶段已经完成，只证明候选能够运行，结果仅供
追溯。`coding-x@0.34.1` 现已完整稳定发布：npm 精确版本、`next`、`latest`、可验证的签名与
provenance、`v0.34.1` 标签、不可变 GitHub Release 和 Release attestation 均已核验并指向同一
发布物；独立 Policy PR #179 也已合并，默认分支的固定裁判已经更新为 `0.34.1`。当前阶段是功能
分支吸收最新 `main` 后，从公共 registry 安装精确稳定版，以非 Shadow 模式重新完成
Developer/Validator 循环、最终 Review 和 GitHub 检查。

稳定发布绑定 coding-engine `main` 提交 `2b441c4fb01694dde7c355cbb8728c32f65111d4`，最终暂存运行
为 `31062819418`，stage ID 为 `000d089a-50c9-4761-84e8-e64f8e49f300`，压缩包 SHA-256 为
`421d6ce0e5da2689c9afa7b4f9f39120caee110f851bd66668a9513d712e2ca4`。与 PR #172 当前身份相关的
任何 `0.34.0` 正式结果、更早候选及其 Shadow 结果、旧 workspace、旧请求或旧 PR 身份都不能
作为本轮凭证，只能用于追溯。

上一轮暴露的 Builder 指令冲突仍未进入 `main`：一处要求 `progress.md` 永远只追加，另一处曾要求
更新顶部 `Codebase Patterns`。本轮继续用这个低风险文档 Story，通过公共稳定版完成非 Shadow
Developer、Validator 和本地 Review，并由发布维护者独立对账运行前后的 progress 前缀。已有实现
提交继续保留；正式运行负责重新验证，不要求为了制造新提交而改写已经满足要求的业务内容。

## Goals

- 在现有 Dogfood 回归表中追加一条稳定断言，防止 Builder 再次改写历史进度。
- 保留已有真实 Developer 实现提交作为本 PR 的业务改动；正式 Developer 重新检查当前内容，若已
  满足验收标准则不制造无意义改动。
- 使用公共 registry 的精确 `coding-x@0.34.1` 重新签发正式 Validator 回执：它绑定当前 Story、
  按顺序的验收标准、HEAD 和验证环境摘要，且环境摘要绑定实际 coding-x 版本与
  `shadow=false`。本地最终 Review 另行绑定完整 PR 身份，GitHub 机械检查只绑定当前 head。
  三类证据不能互相替代；只有完整正式流程成功退出 `0` 才表示当前状态可交付。
- 把正式 Developer、Validator、本地最终 Review 与远端交付检查分开核对；旧候选和 Shadow
  结果只用于追溯，不能作为本轮正式凭证。

## Non-Goals

- 不修改代码、测试、工作流、质量契约、依赖、版本号或发布资产。
- 不触发 npm staging，不发布 npm，不创建或移动标签，不创建 GitHub Release。
- 只有当前 head 的非 Shadow 正式复验和 GitHub 检查全部通过，并由维护者执行最终合并后，本 PR
  才可进入 `main`。Developer、Validator 和 Reviewer 均不自动合并。PR #65 始终不处理。
- 不复用旧 head 的 GitHub 检查，也不复用任何 `0.34.0` Story、Validator、Review、workspace
  或更早候选结论。
- 不把本仓结果外推为 Go、Python 或真实业务下游已经完成验证。

## Functional Requirements

1. 只在 `docs/dogfood-regression.md` 现有表格末尾追加第 31 条，不改写第 1 至 30 条、表头、
   frontmatter 或说明文字。
2. 第 31 条必须明确：Builder 只在 `progress.md` 末尾追加；历史 `Codebase Patterns` 只读；
   可复用经验写入当轮“未来迭代的学习”，项目级沉淀由 `/compound-docs` 处理。
3. 第 31 条必须记录来源为 `2026-08-05 Builder 追加指令冲突`。
4. 第 31 条验证点必须要求逐字比较运行前后 progress 前缀，并确认没有新增或改写
   `## Codebase Patterns`。

## Golden Principles

| 原则 | 适用性与设计裁决 | 验证证据 |
|---|---|---|
| 1. 可证伪完成合同 | 适用。目标编号、不可改写范围、必含语义和原生检查都可直接反证。 | 相对 main 的文件列表、表格第 31 条、前 30 条摘要。 |
| 2. 生成方不得自签 | 适用。Developer、Validator 与 Review 是职责隔离的模型判断，不冒充独立可信证明；项目机械检查和维护者的 progress 前缀逐字对账不依赖模型自述。稳定版由旧裁判、机械检查、人工批准和发布物对账完成发布，当前稳定版只评估本功能 PR。 | 正式 Validator 回执、最终 Review、机械检查结果、workspace 前后摘要。 |
| 3. 自治与可逆性对称 | 不扩大自治。只允许两份文档改动；Developer、Validator 和 Reviewer 不授权合并、发布或处理 PR #65，最终合并只能在门禁通过后由维护者执行；普通回退即可撤销。 | Git diff、门禁结果与开放 PR 状态。 |
| 4. 原生执行优先 | 适用。使用仓库现有 Markdown、repository health 和公共 registry 的精确 `coding-x@0.34.1` 正式流程，不新增执行层。 | 原生命令与引擎工件。 |
| 5. 假绿与恢复优先 | 适用。当前质量契约与实际运行版本都固定为 `coding-x@0.34.1`；正式健康完成必须退出 `0`。Validator 回执绑定实际版本与非 Shadow 模式；最终 Review 独立绑定完整 PR 身份，任何旧 Shadow 结果均无效。 | 版本核对、正式状态、Validator 回执、最终 Review 绑定与远端状态分栏。 |

## User Stories

### US-001: 固化 Builder 进度只追加回归断言

作为发布维护者，我希望把 Builder 指令冲突固化成一条可复测的 Dogfood 断言，从而以后能够
直接发现任何历史进度改写，而不是等 workspace 安全门禁在长运行末尾才暴露。

#### Acceptance Criteria

- [x] `docs/dogfood-regression.md` 表格末尾新增且只新增编号 31；编号 1 至 30、表头、frontmatter 和说明文字逐字不变。
- [x] 第 31 条断言明确包含：Builder 只在 `progress.md` 末尾追加；历史 `Codebase Patterns` 只读；可复用经验写入当轮“未来迭代的学习”；项目级沉淀由 `/compound-docs` 处理。
- [x] 第 31 条来源逐字为 `2026-08-05 Builder 追加指令冲突`。
- [x] 第 31 条验证点要求保存运行前 progress 前缀，运行后逐字确认此前字节不变且只新增本轮块，并确认没有新增或改写 `## Codebase Patterns`。
- [x] 相对 `main` 的受管改动只有本 PRD 与 `docs/dogfood-regression.md`，不修改代码、测试、工作流、质量契约、依赖、版本或发布文件。
- [x] Repository health check passes

## Verification

- `git diff --name-only origin/main...HEAD`
- 对 `docs/dogfood-regression.md` 的 main 版本与当前版本做前 30 条摘要对账。
- `npm run repository-health`
- 先提交并推送本 PRD，把 PR #172 正文更新为公共稳定版 `0.34.1` 的非 Shadow 正式意图，冻结
  title、body、base 和 head，并确认分支包含最新 `main`。任何 PR 身份或规则变化后都必须重新
  派生并重跑；所有旧正式或 Shadow workspace 和请求禁止复用。
- 稳定版本身份必须回读为：npm `next=0.34.1`、`latest=0.34.1`、`gitHead` 为
  `2b441c4fb01694dde7c355cbb8728c32f65111d4`，压缩包 SHA-256 为
  `421d6ce0e5da2689c9afa7b4f9f39120caee110f851bd66668a9513d712e2ca4`，`v0.34.1` 标签和不可变
  GitHub Release 指向同一来源链；Policy PR #179 已合并且分支已吸收其最新 `main`。
- 必须从公共 registry 精确安装 `coding-x@0.34.1`，同一绝对 CLI 贯穿准备与运行；不得切换到
  本地 `dist`、全局命令、浮动 `npx` 或旧候选。使用它新建全新仓库外 workspace。
- `workspace init` 必须退出 `0`；任何其他结果立即停止。
- 在该新 workspace 中运行普通 doctor；它必须退出 `0`，且质量契约的 expected/actual 都为
  `0.34.1`，没有其他问题。只有取得当前质量摘要和检查快照后，才能从已提交源 PRD、当前 head
  与当前质量契约派生全新 `prd.json` 和 apply 请求。
- 普通 `apply-prd` 必须退出 `0`；禁止使用 `--shadow`、旧请求或旧 workspace。
- 发布维护者在最终运行前保存本轮固定的 `<new-workspace>/progress.md` 前缀，运行后独立做逐字
  前缀比较；不得读取或复用仓内旧 `.workspace`。
- 最终运行必须返回 `0`，且最终 Review 同时满足 `status=passed`、`shadow=false`、
  `deliveryStatus=ready`、`current=true`、当前绑定有效、远端状态就绪且没有 finding。
- 已冻结的 PR 正文必须记录稳定版本、来源提交、压缩包摘要、旧 Shadow 证据边界和无延期/政策
  例外。
  最终结果必须另行绑定 PR 编号、目标分支、base/head、
  标题与正文摘要、Spec、工程标准、质量契约、coding-x 版本、Runner 类型、模型和 Runner 版本、
  Review 规则、风险结论、验证环境摘要，以及按 PRD 顺序生成的 Validator 回执集合摘要；任一绑定项
  变化都必须废弃旧结果并重跑。
- 正式 Developer、Validator、本地最终 Review、GitHub CI 分别核对，不互相替代；GitHub 不运行
  模型，也不证明本地 Review 已执行。
- npm 精确版本、`next`、`latest`、包摘要、npm `gitHead`、签名与 provenance、`v0.34.1`、不可变
  GitHub Release 和 Release attestation 已核验为同一来源链，Policy PR #179 已更新固定裁判，
  功能分支已吸收最新 `main`。当前只允许公共 `coding-x@0.34.1`、全新 workspace 和重新派生的
  请求完成非 Shadow 正式闭环；候选入口及 Shadow 结果不得作为正式凭证。

## Completion

PR #172 已通过公共稳定版 0.34.1 的正式非 Shadow 流程和全部远端检查后合并；
`docs/dogfood-regression.md` 第 31 条已进入主分支，以上验收项全部兑现。

## Rollback

若第 31 条内容、规格事实或证据边界不正确，就不合并，在本 PR 的两份文档内修复；新提交后必须
使用全新 workspace 重新执行完整正式流程。合并后若发现问题，只能通过受保护的回退 PR 恢复；
不得通过修改质量契约、复用旧 workspace、Validator、Review 或候选结论、处理 PR #65 或提前
合并来迎合结果。
