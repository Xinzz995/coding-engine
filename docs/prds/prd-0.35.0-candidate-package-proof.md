---
title: '0.35.0 候选包三系统安装证明'
status: active
updated: 2026-08-08
scope: root
---

# 0.35.0 候选包三系统安装证明

## Context

coding-x 0.35.0 首次把“同一候选包在 Linux、macOS、Windows 全新安装并从真实命令入口启动”
纳入候选总闸。本次自托管 Shadow Dogfood 需要新增一份短小、可核对的计划，把已经取得的候选
身份与仍未完成的发布动作分开，防止把候选构建、Shadow 结果或开放 PR 误写成正式发布完成。

固定候选身份：

- 版本：`coding-x@0.35.0`
- 来源提交：`cd8a3f089cde2b46bc1c7baf80f64e756af2f35a`
- Build release candidate run：`31237085957`
- 候选 tarball SHA-256：`6f1a93c7df06de280c234da93a78933f9bf0577f527d43f7e25d3fe44fd7fc5d`

## Goals

- 新增一份候选安装证明计划，逐项记录 Linux、macOS、Windows 使用同一候选包的边界。
- 明确区分已完成的构建与安装证明、本 PR 的 Shadow 证据，以及尚未执行的 npm 发布动作。
- 保持运行代码、测试、质量契约、工作流、版本和发布资产完全不变。

## Non-Goals

- 不触发 npm staging、2FA 批准、dist-tag 变更、标签或 GitHub Release。
- 不把合成试点写成真实业务下游采用证明。
- 不把 Shadow 退出 7 解释为正式可交付。
- 不修改或合并其他开放 PR。

## Golden Principles

| 原则             | 适用性与设计裁决                                                             | 验证证据                                     |
| ---------------- | ---------------------------------------------------------------------------- | -------------------------------------------- |
| 可证伪完成合同   | 适用。计划必须包含四项固定候选身份和三系统逐项结果，缺少任一项即不满足验收。 | 文件内容与候选制品回读。                     |
| 生成方不得自签   | 适用。候选只产生 Shadow 结果，正式裁判仍为 0.34.1。                          | workspace 状态与最终 Review 的 shadow 标记。 |
| 自治与可逆性对称 | 适用。实现只新增一份计划，可由单一提交回退。                                 | seed 到实现的文件差异。                      |
| 复用原生执行面   | 适用。三系统安装证明来自 GitHub 托管系统和 npm 真实命令入口。                | candidate run 的四个成功任务。               |
| 失败与恢复优先   | 适用。候选、提交、运行编号或摘要不一致时停止，不重建替代候选。               | 固定身份对账与发布边界表。                   |

## User Stories

### US-001: 记录同一候选包的三系统安装证明

作为发布维护者，我希望有一份清晰的候选证明计划，从而能在进入 npm 暂存前确认三系统使用的是
同一个包，并准确看到哪些发布动作仍未发生。

#### Acceptance Criteria

- [ ] 新增且只新增 `docs/plans/2026-08-08-candidate-package-proof-0.35.0.md` 作为实现文件；
      本源 PRD 与 seed 提交保持不变。
- [ ] 计划逐字包含版本、来源提交、候选运行编号和 tarball SHA-256，并声明四项必须同时匹配。
- [ ] 计划用表格分别记录 Ubuntu 24.04、macOS 26、Windows Server 2022 下载同一 artifact、
      核对同一摘要、全新安装并从 npm 真实命令入口完成 help、workspace init 和 shadow doctor。
- [ ] 计划明确候选构建与三系统安装已完成，本 PR 的 Shadow 运行和三个项目 Dogfood 仍需逐项核对。
- [ ] 计划明确 npm staging、2FA 批准、`next`、`latest`、`v0.35.0` 和 GitHub Release 均未由本 PR 执行。
- [ ] 计划明确 Shadow 健康退出码 7 不表示正式通过或可交付。
- [ ] 不修改运行代码、测试、质量契约、工作流、版本、依赖或发布资产。
- [ ] `npm run repository-health` 以及仓库全部既有检查通过。
- [ ] Typecheck passes。

## Verification

- 候选安装在仓库外独立目录，整个 Shadow 流程固定使用同一绝对 CLI。
- 普通 doctor 与 apply-prd 因稳定裁判 0.34.1 和候选 0.35.0 不一致而拒绝。
- Shadow doctor、apply-prd 和最终 Codex 运行健康时均返回 7，并保留 Shadow 最终 Review。
- PR 最新提交的本地检查、远端质量总闸、Policy Guard 与 CodeQL 全部成功。

## Rollback

若计划内容或候选身份不正确，关闭本 PR 并删除分支；不修改候选包、主分支或发布状态来取得绿色结果。
