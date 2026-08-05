---
title: "R7 Builder 进度只追加 Dogfood"
status: active
updated: 2026-08-05
scope: root
---

# R7 Builder 进度只追加 Dogfood

## Context

本轮使用已经公开发布、并由默认分支质量契约固定的 `coding-x@0.34.0`，针对当前 PR 最新 head
以非 Shadow 正式模式完成 coding-engine 自托管 Dogfood。Validator、最终三层 Review 和 GitHub
机械检查必须全部重新执行并绑定当前 PR 身份，不得复用任何候选阶段结果。

历史背景：R7 候选来自 GitHub Actions 运行 `30961444465`，绑定 coding-engine `main` 提交
`61cf32673f1447f15dfd30e34bd611d0e6978c0e`，压缩包 SHA-256 为
`5d5a8ca03112ebc84d01ce6115a36cd4d45dcd15c3cb9bf6255fbb0bf4e0c20a`。该候选及其 Shadow
结果只供追溯，已经因稳定裁判切换和 PR 身份变化失效，不能作为本轮正式凭证。R6 运行同样因最终
Review 读取 GitHub 时发生瞬时 EOF 而没有形成可复用结果。

上一轮暴露的 Builder 指令冲突仍未进入 `main`：一处要求 `progress.md` 永远只追加，另一处曾要求
更新顶部 `Codebase Patterns`。本轮继续用这个低风险文档 Story 验证公开稳定版
`coding-x@0.34.0` 能完成正式收口，并由发布维护者独立对账运行前后的 progress 前缀。

## Goals

- 在现有 Dogfood 回归表中追加一条稳定断言，防止 Builder 再次改写历史进度。
- 用真实 Developer 提交产生一个低风险、可机械核对的项目改动。
- 重新完成 Validator、最终三层 Review 与 GitHub 机械检查，证明公开稳定版 `coding-x@0.34.0`
  已针对当前 PR 最新 head 完成正式自托管闭环。
- 把 Story 验收、本地最终 Review 与远端交付检查分开核对；正式结果必须来自非 Shadow 运行，
  三者不能互相替代。

## Non-Goals

- 不修改代码、测试、工作流、质量契约、依赖、版本号或发布资产。
- 不触发 npm staging，不发布 npm，不创建或移动标签，不创建 GitHub Release。
- 不合并本 PR，不修改、关闭或合并 PR #65。
- 不复用 R6 或 R7 候选 Shadow 阶段的 Story、Validator、Review、CI、workspace 或候选摘要。
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
| 2. 生成方不得自签 | 适用。Developer 只提交文档；Validator、三层 Review、机械检查和发布维护者的 progress 前缀对账彼此独立。 | Validator 回执、最终 Review、检查结果、workspace 前后摘要。 |
| 3. 自治与可逆性对称 | 不扩大自治。只允许两份文档改动，不授权合并、staging、发布或处理 PR #65；普通回退即可撤销。 | Git diff 与开放 PR 状态。 |
| 4. 原生执行优先 | 适用。使用仓库现有 Markdown、repository health 和公开稳定版 `coding-x@0.34.0` 的正式非 Shadow 流程，不新增执行层。 | 原生命令与引擎工件。 |
| 5. 假绿与恢复优先 | 适用。运行版本必须与质量契约固定的 `coding-x@0.34.0` 精确一致；正式 Validator 与最终 Review 必须重新绑定当前 PR 最新 head。R6 与 R7 候选 Shadow 证据全部失效，只保留为历史记录。 | 版本核对、正式运行结果、最新 PR 身份与远端状态分栏。 |

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
- 发布维护者在运行前保存 `.workspace/progress.md` 前缀，运行后独立做逐字前缀比较。
- Developer、Validator、最终三层 Review、GitHub CI 和公开稳定版 `coding-x@0.34.0` 的正式运行状态
  分别核对，不互相替代；候选 Shadow 历史不得作为本轮证据。

## Rollback

若第 31 条内容或边界不正确，只回退本 PR 的两份文档并重新运行新 Story；不得通过修改质量
契约、复用 R6 或 R7 候选 Shadow workspace、结果或摘要、触发 staging、处理 PR #65 或提前合并
来迎合结果。
