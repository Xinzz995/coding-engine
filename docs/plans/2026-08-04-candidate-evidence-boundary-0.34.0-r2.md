---
title: 0.34.0 候选证据边界 R2
status: active
updated: 2026-08-04
scope: root
---

# 0.34.0 候选证据边界 R2

## 候选身份

本轮唯一候选的身份由下列四项共同组成。只有四项**同时匹配**，后续证据才可以绑定到该候选；任一项
不匹配都必须停止，不能用其他运行、提交或压缩包替代。

| 身份字段 | 已直接核对的值 |
| --- | --- |
| 版本 | `0.34.0` |
| candidate run | `30891402247` |
| main 提交 | `c42e0c266554fc48462108e9e2e972e0632e9a0f` |
| 压缩包 SHA-256 | `ca081fbd623f234af4befff37c1093a1d3f9ac06172ecf20153ef3657df16007` |

## 证据边界

候选构建与本地压缩包摘要已经直接核对，但这两个事实只建立候选字节身份。它们不会替代本 PR 仍须产生的
shadow、Developer、Validator、三层 Review 或 GitHub CI 证据。

| 证据或动作 | 当前状态 | 本 PR 的结论 |
| --- | --- | --- |
| 候选构建 | 已直接核对 | 证明候选构建身份，不能证明交付完成。 |
| 本地压缩包 SHA-256 摘要 | 已直接核对 | 证明本地摘要与候选身份一致，不能替代独立验证。 |
| shadow | 仍须产生 | 必须以固定候选路径运行并单独记录结果。 |
| Developer | 仍须产生 | 不是候选构建或本文档可以替代的证据。 |
| Validator | 仍须产生 | 必须独立于 Developer 的自述。 |
| 三层 Review | 仍须产生 | 三层结论须分别产生，不能由 shadow 退出码代替。 |
| GitHub CI | 仍须产生 | 远端机械检查尚未由本 PR 的候选身份签发。 |
| Go/Python 试点 | 不由本 PR 完成 | 不将 coding-engine 的结果外推为 Go 或 Python 已验证。 |
| npm staging | 不由本 PR 完成 | 本 PR 不触发 npm staging。 |
| 公开发布 | 不由本 PR 完成 | 不发布 npm 包。 |
| 标签 | 不由本 PR 完成 | 不创建、移动或使用发布标签。 |
| Release | 不由本 PR 完成 | 不创建 GitHub Release。 |
| 合并 | 不由本 PR 完成 | 本 PR 保持开放。 |

## Shadow 路径的非交付语义

本轮固定绝对候选 CLI 是
`/private/tmp/coding-x-dogfood-0.34-r4.MP2iUc/engine-install/node_modules/coding-x/dist/cli.js`。这一个路径必须
贯穿 `doctor`、`workspace apply-prd` 和 `run` 三步；不得在三步之间替换为其他 CLI、版本或位置。

| 入口 | 预期语义 |
| --- | --- |
| 正式 `doctor` | 因质量契约固定 `coding-x 0.33.3`、与候选 `0.34.0` 不一致而失败。 |
| 正式 `workspace apply-prd` | 因同一固定版本不一致而失败。 |
| shadow `doctor` | 健康时退出 `7`。 |
| shadow `workspace apply-prd` | 健康时退出 `7`。 |
| shadow `run` | 健康时退出 `7`。 |

退出 `7` 永远不表示通过，也永远不表示可交付；它只表示候选在受限 shadow 路径上的非正式结果。

## 本 PR 的安全边界

- 本 PR 保持开放。
- 不触发 npm staging。
- 不修改 PR #65。
- 不使用维护者的真实 checkout。
- 不进行公开发布、标签、Release 或合并。

相对 `main`，受管改动只能是需求来源
`docs/prds/prd-candidate-evidence-boundary-0.34.0-r2.md` 与本目标计划
`docs/plans/2026-08-04-candidate-evidence-boundary-0.34.0-r2.md`。本 PR 不修改代码、测试、工作流、
质量契约、依赖、版本或发布文件。

## 完成核对

| 核对项 | 通过观察 |
| --- | --- |
| 候选身份 | 四项值逐字匹配，且明确要求同时匹配。 |
| 证据边界 | 表格分别标明已直接核对、仍须产生和不由本 PR 完成的项目。 |
| shadow 语义 | 正式版本不一致失败，三项健康 shadow 结果均为退出 `7`，且没有把 `7` 写成通过或交付。 |
| 受管范围 | `git diff --name-only origin/main...HEAD` 只列出需求来源和本计划。 |
| 仓库检查 | `npm run repository-health`、`npm run typecheck` 通过。 |
