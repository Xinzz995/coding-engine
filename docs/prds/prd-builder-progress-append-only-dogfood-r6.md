---
title: "R6 Builder 进度只追加 Dogfood"
status: active
updated: 2026-08-05
scope: root
---

# R6 Builder 进度只追加 Dogfood

## Context

本轮使用同一个 `coding-x@0.34.0` 候选完成 coding-engine 自托管 Dogfood。候选来自
GitHub Actions 运行 `30941731201`，绑定 coding-engine `main` 提交
`2f099f0bf0675c39c63dc781495aa61f2a472ba3`，压缩包 SHA-256 为
`214784c4a62958a34644ccf2daa75c4133925ee23e54df1ce50d7e10833e87cd`。

上一轮真实运行暴露了 Builder 指令冲突：一处要求 `progress.md` 永远只追加，另一处却要求
更新顶部 `Codebase Patterns`。本轮用一个全新的文档 Story 验证修订后的候选确实能完成
Developer → Validator → 最终 Review，同时由发布维护者独立对账运行前后的 progress 前缀。

## Goals

- 在现有 Dogfood 回归表中追加一条稳定断言，防止 Builder 再次改写历史进度。
- 用真实 Builder 提交产生一个低风险、可机械核对的项目改动。
- 把 Story 验收与候选发布结论分开；Shadow 退出 7 不表示正式通过或可交付。

## Non-Goals

- 不修改代码、测试、工作流、质量契约、依赖、版本号或发布资产。
- 不触发 npm staging，不发布 npm，不创建或移动标签，不创建 GitHub Release。
- 不合并本 PR，不修改、关闭或合并 PR #65。
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
| 1. 可证伪完成合同 | 适用。目标行号、不可改写范围、必含语义和原生检查都可直接反证。 | 相对 main 的文件列表、表格第 31 行、前 30 行摘要。 |
| 2. 生成方不得自签 | 适用。Builder 只提交文档；Validator、三层 Review、机械检查和发布维护者的 progress 前缀对账彼此独立。 | Validator 回执、最终 Review、检查结果、workspace 前后摘要。 |
| 3. 自治与可逆性对称 | 不扩大自治。只允许两份文档改动，不授权合并、staging、发布或处理 PR #65；普通回退即可撤销。 | Git diff 与开放 PR 状态。 |
| 4. 原生执行优先 | 适用。使用仓库现有 Markdown、repository health 和正式 coding-x Shadow 流程，不新增执行层。 | 原生命令与引擎工件。 |
| 5. 假绿与恢复优先 | 适用。正式模式必须因版本不匹配拒绝；Shadow 退出 7 只记录候选运行完成，不改写为正式通过。 | 正式拒绝、Shadow 三步退出码、PR 状态分栏。 |

## User Stories

### US-001: 固化 Builder 进度只追加回归断言

作为发布维护者，我希望把这次 Builder 指令冲突固化成一条可复测的 Dogfood 断言，从而以后
能够直接发现任何历史进度改写，而不是等 workspace 安全门禁在长运行末尾才暴露。

#### Acceptance Criteria

- [ ] `docs/dogfood-regression.md` 表格末尾新增且只新增编号 31；编号 1 至 30、表头、frontmatter 和说明文字逐字不变。
- [ ] 第 31 条断言明确包含：Builder 只在 `progress.md` 末尾追加；历史 `Codebase Patterns` 只读；可复用经验写入当轮“未来迭代的学习”；项目级沉淀由 `/compound-docs` 处理。
- [ ] 第 31 条来源逐字为 `2026-08-05 Builder 追加指令冲突`。
- [ ] 第 31 条验证点要求保存运行前 progress 前缀，运行后逐字确认此前字节不变且只新增本轮块，并确认没有新增或改写 `## Codebase Patterns`。
- [ ] 相对 `main` 的受管改动只有本 PRD 与 `docs/dogfood-regression.md`，不修改代码、测试、工作流、质量契约、依赖、版本或发布文件。
- [ ] Repository health check passes

## Verification

- `git diff --name-only origin/main...HEAD`
- 对 `docs/dogfood-regression.md` 的 main 版本与当前版本做前 30 行表格摘要对账。
- `npm run repository-health`
- 发布维护者在运行前保存 `.workspace/progress.md` 前缀，运行后独立做逐字前缀比较。
- Developer、Validator、最终三层 Review、GitHub CI 和候选发布状态分别核对，不互相替代。

## Rollback

若第 31 条内容或边界不正确，只回退本 PR 的两份文档并重新运行新 Story；不得通过修改质量
契约、复用 R5 workspace、触发 staging、处理 PR #65 或提前合并来迎合结果。
