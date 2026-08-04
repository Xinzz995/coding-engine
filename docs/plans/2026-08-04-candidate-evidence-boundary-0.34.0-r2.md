---
title: 0.34.0 候选证据边界 R2
status: active
updated: 2026-08-04
scope: root
---

# 0.34.0 候选证据边界 R2

## 候选身份

本轮唯一候选的身份由下列四项共同组成。四项身份必须**同时匹配**，后续证据才可以绑定到该候选；
任一项不匹配都必须停止，不能用其他运行、提交或压缩包替代。

| 身份字段 | 已直接核对的值 |
| --- | --- |
| 版本 | `coding-x@0.34.0` |
| candidate run | `30914071363` |
| main 提交 | `08d9539d1cca986a9ed2ff2b4f1498ac849988b3` |
| 压缩包 SHA-256 | `4a0a616e33a48a54f574c44a31d3d510fb380a247d90d2cfd1e459f02dcd8c54` |

## 证据边界

候选构建与本地压缩包摘要已经直接核对，但这两个事实只建立候选字节身份。它们不会替代本 PR 仍须产生的
shadow、Developer、Validator、三层 Review 或 GitHub CI 证据。

| 证据或动作 | 当前状态 | 可定位证据或预期落点 | 本 PR 的结论 |
| --- | --- | --- | --- |
| 候选构建 | 已直接核对 | GitHub Actions run `30914071363`，artifact `npm-candidate-0.34.0` | 证明候选构建身份，不能证明交付完成。 |
| 本地压缩包 SHA-256 摘要 | 已直接核对 | run `30914071363` 的 artifact 中 `packed.json.tarball.sha256` | 证明本地摘要与候选身份一致，不能替代独立验证。 |
| workspace 初始化与 shadow | 仍须产生 | 候选工作目录的 `.workspace/state.json`、`.workspace/evidence.jsonl` 与 `.workspace/final-review.json` | 必须以固定候选路径依次初始化、运行并单独记录结果。 |
| Developer | 仍须产生 | PR #150 的最新 head 提交 | 不是候选构建或本文档可以替代的证据。 |
| Validator | 仍须产生 | `.workspace/state.json` 中的 Validator 回执及 `.workspace/evidence.jsonl` | 必须独立于 Developer 的自述。 |
| 三层 Review | 仍须产生 | `.workspace/final-review.json` 的 Spec、工程标准与深度 Review 三个独立轴 | 三层结论须分别产生，不能由 shadow 退出码代替。 |
| GitHub CI | 仍须产生 | PR #150 最新 head 的 GitHub Checks 与必需 `quality-gate` | 远端机械检查尚未由本 PR 的候选身份签发。 |
| Go/Python 试点 | 不由本 PR 完成 | Go PR #19 与 Python PR #16 各自的本地 Review 和 GitHub Checks | 不将 coding-engine 的结果外推为 Go 或 Python 已验证。 |
| npm staging | 不由本 PR 完成 | `Stage npm candidate` 的后续 workflow run 与 npm staged package 记录 | 本 PR 不触发 npm staging。 |
| 公开发布 | 不由本 PR 完成 | npm 上 `coding-x@0.34.0` 的版本记录 | 不发布 npm 包。 |
| 标签 | 不由本 PR 完成 | GitHub tag `v0.34.0` 指向的提交 | 不创建、移动或使用发布标签。 |
| Release | 不由本 PR 完成 | GitHub Release `v0.34.0` | 不创建 GitHub Release。 |
| 合并 | 不由本 PR 完成 | PR #150 的远端状态 | 本 PR 保持开放。 |

## Shadow 路径的非交付语义

本轮固定绝对候选 CLI 是
`/private/tmp/coding-x-dogfood-0.34-r5.eDvI6T/engine-install/node_modules/coding-x/dist/cli.js`。这一个路径必须
按顺序贯穿 `workspace init`、`doctor --shadow`、`workspace apply-prd --shadow` 和最终 shadow run 四步；
四步均不得换用其他入口、CLI、版本或位置。正式 `doctor` 与正式 `workspace apply-prd` 的反例检查也必须
使用同一绝对候选 CLI。

| 入口 | 预期语义 |
| --- | --- |
| `workspace init` | 由固定候选 CLI 建立候选工作区；它本身不产生交付就绪结论。 |
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
| shadow 语义 | 同一候选 CLI 依次完成 workspace 初始化和三项 shadow 操作；正式版本不一致失败，三项健康 shadow 结果均为退出 `7`，且没有把 `7` 写成通过或交付。 |
| 受管范围 | `git diff --name-only origin/main...HEAD` 只列出需求来源和本计划。 |
| 仓库检查 | `npm run repository-health`、`npm run typecheck` 通过。 |
