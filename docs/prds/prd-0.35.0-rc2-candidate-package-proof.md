---
title: '0.35.0 RC2 候选包三系统安装证明'
status: active
updated: 2026-08-09
scope: root
---

# 0.35.0 RC2 候选包三系统安装证明

## Context

coding-x 0.35.0 的首个候选在三仓 Shadow Dogfood 中发现 Codex Final Review 事件兼容缺口，
因此已经作废且永不进入 npm staging。修复合入最新主分支后，项目从新提交重新构建了 RC2；
本次自托管 Shadow Dogfood 需要新增一份短小、可核对的计划，明确记录 RC2 的固定身份、
三系统安装证明和仍未完成的发布动作，防止复用首个候选的任何结论。

固定 RC2 身份：

- 版本：`coding-x@0.35.0`
- 来源提交：`faf40bf12eab58060388e4f56007840cf0e36058`
- Build release candidate run：`31263899761`
- 候选 tarball SHA-256：`3c1ec1cb0026ac9566fa78c3dcbeaf50ce2cd79c2a61f49dc2bdfd373f360aad`

## Goals

- 新增一份 RC2 候选安装证明计划，逐项记录 Linux、macOS、Windows 使用同一候选包的边界。
- 明确首个候选已经作废，不复用它的安装、Validator 或 Final Review 结果。
- 明确区分已完成的 RC2 构建与安装证明、本 PR 的 Shadow 证据，以及尚未执行的 npm 发布动作。
- 保持运行代码、测试、质量契约、工作流、版本和发布资产完全不变。

## Non-Goals

- 不触发 npm staging、2FA 批准、dist-tag 变更、标签或 GitHub Release。
- 不把合成试点写成真实业务下游采用证明。
- 不把 Shadow 退出 7 解释为正式可交付。
- 不合并本 PR，也不修改或合并其他开放 PR。

## Golden Principles

| 原则             | 适用性与设计裁决                                                                     | 验证证据                                     |
| ---------------- | ------------------------------------------------------------------------------------ | -------------------------------------------- |
| 可证伪完成合同   | 适用。计划必须包含四项固定 RC2 身份和三系统逐项结果，缺少任一项即不满足验收。        | 文件内容与 RC2 候选制品回读。                |
| 生成方不得自签   | 适用。RC2 只产生 Shadow 结果，正式裁判仍为 0.34.1。                                  | workspace 状态与最终 Review 的 shadow 标记。 |
| 自治与可逆性对称 | 适用。实现只新增一份计划，可由单一提交回退。                                         | RC2 seed 到实现的文件差异。                  |
| 复用原生执行面   | 适用。三系统安装证明来自 GitHub 托管系统和 npm 真实命令入口。                        | candidate run 的五个成功任务。               |
| 失败与恢复优先   | 适用。候选、提交、运行编号或摘要不一致时停止；首个候选与其历史结论不得作为替代证据。 | 固定身份对账与发布边界表。                   |

## User Stories

### US-001: 记录同一 RC2 候选包的三系统安装证明

作为发布维护者，我希望有一份清晰的 RC2 候选证明计划，从而能在进入 npm 暂存前确认三系统使用的
是修复后重新构建的同一个包，并准确看到哪些 Dogfood 与发布动作仍未发生。

#### Acceptance Criteria

- [ ] 新增且只新增 `docs/plans/2026-08-09-rc2-candidate-package-proof-0.35.0.md` 作为实现文件；
      本源 PRD 与 RC2 seed 提交保持不变。
- [ ] 计划逐字包含版本、来源提交、候选运行编号和 tarball SHA-256，并声明四项必须同时匹配。
- [ ] 计划明确首个候选及其摘要已经作废，RC1 的 workspace、Validator 和 Final Review 结果均不得复用。
- [ ] 计划用表格分别记录 Ubuntu 24.04、macOS 26、Windows Server 2022 下载同一 artifact、
      核对同一摘要、全新安装并从 npm 真实命令入口完成 help、workspace init 和 shadow doctor。
- [ ] 计划明确 RC2 构建与三系统安装已完成，本 PR 的完整 Shadow 运行和三个项目 Dogfood 仍需逐项核对。
- [ ] 计划明确 npm staging、2FA 批准、`next`、`latest`、`v0.35.0` 和 GitHub Release 均未由本 PR 执行。
- [ ] 计划明确 Shadow 健康退出码 7 不表示正式通过或可交付。
- [ ] 不修改运行代码、测试、质量契约、工作流、版本、依赖或发布资产。
- [ ] `npm run repository-health` 以及仓库全部既有检查通过。
- [ ] Typecheck passes。

## 本 PR 验证

- RC2 安装在仓库外独立目录，本 PR 的完整 Shadow 流程固定使用该绝对 CLI。
- 本 PR 使用全新 workspace；不得沿用首个候选留下的状态或 Final Review。
- 普通 doctor 与 apply-prd 因稳定裁判 0.34.1 和候选 0.35.0 不一致而拒绝。
- Shadow doctor 与 apply-prd 必须返回 7；Story 必须达到 `blocked=false`、`passes=true`、
  `validated=true`，并产生绑定当前 HEAD 的全新 Validator 回执。
- 最终 Review 必须返回 7，同时满足 `status=passed`、`deliveryStatus=shadow`、`shadow=true`、
  `remote.status=ready`，且绑定当前 PR HEAD；这些 Shadow 结果仍不表示正式可交付。
- PR 最新提交的本地检查、远端质量总闸、Policy Guard 与 CodeQL 全部成功。

## 发布前后置验证

- RC2 还必须分别安装到 Go 与 Python 试点的仓库外独立目录，并核对同一 tarball SHA-256。
- 三个项目都必须使用全新 workspace，分别完成完整 Shadow Dogfood；任何首个候选结果均不得复用。
- 三个候选 PR、候选摘要和远端总闸全部通过后，才允许另行申请进入 npm staging。
- 政策例外 Issue #193 在三仓 RC2 结果收口前保持开放；若它先到期，则停止流程，不得进入 staging。

## Rollback

若计划内容或 RC2 身份不正确，关闭本 PR 并删除分支；不修改候选包、主分支或发布状态来取得绿色结果。
