---
title: "R7 Builder 进度只追加 Dogfood"
status: active
updated: 2026-08-06
scope: root
---

# R7 Builder 进度只追加 Dogfood

## Context

本轮分成两个不能互相替代的阶段。当前阶段使用固定的 `coding-x@0.34.1` 候选，以显式 Shadow
模式针对当前 PR 最新 head 完成 coding-engine 自托管 Dogfood；它只证明候选能够运行，永远不能
产生正式可交付结论。只有 npm 精确版本、`next`、`latest`、可验证的签名与 provenance、
`v0.34.1` 标签、不可变 GitHub Release 和 Release attestation 全部完成并指向同一候选后，才算
`0.34.1` 完整稳定发布；随后还必须通过独立 Policy PR 更新默认分支固定裁判，吸收最新 `main`，
使用公开稳定版以非 Shadow 模式重新完成 Validator、最终 Review 和 GitHub 检查。

当前候选来自 GitHub Actions 运行 `31042351145`，绑定 coding-engine `main` 提交
`2b441c4fb01694dde7c355cbb8728c32f65111d4`，压缩包 SHA-256 为
`421d6ce0e5da2689c9afa7b4f9f39120caee110f851bd66668a9513d712e2ca4`。任何 `0.34.0` 正式结果、
更早候选及其 Shadow 结果、旧 workspace 或旧 PR 身份都已失效，只能用于追溯。

上一轮暴露的 Builder 指令冲突仍未进入 `main`：一处要求 `progress.md` 永远只追加，另一处曾要求
更新顶部 `Codebase Patterns`。本轮继续用这个低风险文档 Story 验证 `0.34.1` 候选能够完成
Shadow Developer、Validator 和本地 Review，并由发布维护者独立对账运行前后的 progress 前缀；
公开后的正式收口另行执行。

## Goals

- 在现有 Dogfood 回归表中追加一条稳定断言，防止 Builder 再次改写历史进度。
- 用真实 Developer 提交产生一个低风险、可机械核对的项目改动。
- 使用固定 `0.34.1` 候选重新签发 Validator 回执：它绑定当前 Story、按顺序的验收标准、HEAD
  和验证环境摘要，且环境摘要继续绑定实际 coding-x 版本与 Shadow 模式。本地最终 Review 另行
  绑定完整 PR 身份，GitHub 机械检查只绑定当前 head。三类证据不能互相替代，退出码 `7` 不表示
  正式可交付。
- 把候选 Shadow、Story 验收、本地最终 Review 与远端交付检查分开核对；发布后再由公开稳定版
  重新执行非 Shadow 正式收口，任何阶段的结果都不能互相替代。

## Non-Goals

- 不修改代码、测试、工作流、质量契约、依赖、版本号或发布资产。
- 不触发 npm staging，不发布 npm，不创建或移动标签，不创建 GitHub Release。
- 候选 Shadow 阶段不合并本 PR；只有 `0.34.1` 完整稳定发布、独立 Policy PR 固定裁判、非
  Shadow 正式复验完成并获得显式授权后才可合并。PR #65 始终不处理。
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
| 2. 生成方不得自签 | 适用。Developer、Validator 与 Review 是职责隔离的模型判断，不冒充独立可信证明；项目机械检查和维护者的 progress 前缀逐字对账不依赖模型自述。候选只能形成 Shadow 证据，不能为自己签发正式交付结果。 | Shadow Validator 回执、最终 Review、机械检查结果、workspace 前后摘要。 |
| 3. 自治与可逆性对称 | 不扩大自治。只允许两份文档改动，不授权合并、staging、发布或处理 PR #65；普通回退即可撤销。 | Git diff 与开放 PR 状态。 |
| 4. 原生执行优先 | 适用。使用仓库现有 Markdown、repository health 和固定 `coding-x@0.34.1` 候选的显式 Shadow 流程，不新增执行层；发布后使用公开稳定版正式复验。 | 原生命令与引擎工件。 |
| 5. 假绿与恢复优先 | 适用。当前质量契约仍固定 `coding-x@0.34.0`；候选只能显式使用 Shadow，健康完成仍退出 `7`。Validator 回执的环境摘要绑定实际版本与 Shadow 模式；最终 Review 独立绑定完整 PR 身份。公开发布后还要更新固定裁判并重新正式运行。 | 版本核对、Shadow 状态、Validator 回执、最终 Review 绑定与远端状态分栏。 |

## User Stories

### US-001: 固化 Builder 进度只追加回归断言

作为发布维护者，我希望把 Builder 指令冲突固化成一条可复测的 Dogfood 断言，从而以后能够
直接发现任何历史进度改写，而不是等 workspace 安全门禁在长运行末尾才暴露。

#### Acceptance Criteria

- [ ] `docs/dogfood-regression.md` 表格末尾新增且只新增编号 31；编号 1 至 30、表头、frontmatter 和说明文字逐字不变。
- [ ] 第 31 条断言明确包含：Builder 只在 `progress.md` 末尾追加；历史 `Codebase Patterns` 只读；可复用经验写入当轮“未来迭代的学习”；项目级沉淀由 `/compound-docs` 处理。
- [ ] 第 31 条来源逐字为 `2026-08-05 Builder 追加指令冲突`。
- [ ] 第 31 条验证点要求保存运行前 progress 前缀，运行后逐字确认此前字节不变且只新增本轮块，并确认没有新增或改写 `## Codebase Patterns`。
- [ ] 相对 `main` 的受管改动只有本 PRD 与 `docs/dogfood-regression.md`，不修改代码、测试、工作流、质量契约、依赖、版本或发布文件。
- [ ] Repository health check passes

## Verification

- `git diff --name-only origin/main...HEAD`
- 对 `docs/dogfood-regression.md` 的 main 版本与当前版本做前 30 条摘要对账。
- `npm run repository-health`
- 先提交并推送本 PRD，把 PR #172 正文更新为 `0.34.1` 候选 Shadow 意图并冻结 title、body、
  base 和 head，并确认分支包含最新 `main`。任何 PR 身份或规则变化后都必须重新派生并重跑；
  现有 `0.34.0` 正式 workspace 和请求禁止复用。
- 固定候选身份必须为：运行 `31042351145`、来源提交
  `2b441c4fb01694dde7c355cbb8728c32f65111d4`、SHA-256
  `421d6ce0e5da2689c9afa7b4f9f39120caee110f851bd66668a9513d712e2ca4`。
- 进入 npm staging 前必须回读远端 `main` 仍等于候选来源提交；若 `main` 已变化，本候选立即作废，
  必须从新 `main` 构建新候选并重跑三仓 Dogfood，不能推测变化与发布物无关。
- 从候选包安装出的同一绝对 CLI 必须贯穿准备与运行，不得切换到全局、`npx` 或另一个候选；
  使用它新建全新仓库外 workspace。
- `workspace init` 必须退出 `0`；任何其他结果立即停止。
- 在该新 workspace 中先运行普通 doctor；它必须因 `0.34.0`/`0.34.1` 版本不匹配拒绝，且没有
  业务写入。
- Shadow doctor 必须返回 `7`、`quality.status=shadow`、`quality.actualVersion=0.34.1` 且没有其他
  问题；只有取得这个 workspace 的当前质量摘要和检查快照后，才能从已提交源 PRD、当前 head 与
  当前质量契约派生 `prd.json` 和 apply 请求。
- 普通 apply-prd 必须因版本不匹配拒绝，并通过前后摘要证明 workspace 没有业务写入；随后 Shadow
  apply-prd 必须返回 `7` 和 `status=applied-shadow`。
- 发布维护者在最终运行前保存本轮固定的 `<new-workspace>/progress.md` 前缀，运行后独立做逐字
  前缀比较；不得读取或复用仓内旧 `.workspace`。
- 最终运行必须返回 `7`，且最终 Review 同时满足 `status=passed`、`shadow=true`、
  `deliveryStatus=shadow`、当前绑定有效、远端状态就绪且没有 finding。
- 已冻结的 PR 正文必须记录候选运行、来源提交、压缩包摘要、Shadow 证据边界和无延期/政策例外。
  最终结果必须另行绑定 PR 编号、目标分支、base/head、
  标题与正文摘要、Spec、工程标准、质量契约、coding-x 版本、Runner 类型、模型和 Runner 版本、
  Review 规则、风险结论、验证环境摘要，以及按 PRD 顺序生成的 Validator 回执集合摘要；任一绑定项
  变化都必须废弃旧结果并重跑。
- Shadow Developer、Validator、本地最终 Review、GitHub CI 分别核对，不互相替代；GitHub 不运行
  模型，也不证明本地 Review 已执行。
- 只有 npm 精确版本、`next`、`latest`、包摘要、npm `gitHead`、签名与 provenance、`v0.34.1`、
  不可变 GitHub Release 和 Release attestation 全部与同一候选提交一致后，才允许由独立 Policy PR
  更新固定裁判。功能分支随后必须吸收最新 `main`，从公开 registry 安装精确
  `coding-x@0.34.1`，使用全新 workspace 和重新派生的请求执行非 Shadow 正式 Validator、最终
  Review 和 GitHub 检查；候选入口及 Shadow 结果不得作为正式凭证。

## Rollback

若第 31 条内容或边界不正确，只回退本 PR 的两份文档并重新运行新 Story；不得通过修改质量
契约、复用任何旧 workspace、Validator、Review 或候选结论、触发 staging、处理 PR #65 或提前
合并来迎合结果。
