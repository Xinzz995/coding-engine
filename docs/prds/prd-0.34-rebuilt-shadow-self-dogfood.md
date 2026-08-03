---
title: 'coding-x 0.34.0 重建候选 Shadow 自托管验证'
status: active
updated: 2026-08-04
scope: root
---

# coding-x 0.34.0 重建候选 Shadow 自托管验证

## Context

coding-x 0.34.0 候选新增受控的 Shadow workspace 准备链。内部链接验收修复合并后，发布前
必须让从 `main` 提交 `c8347347dd5bf9e8212cd839e13e3133f0847155` 重建的同一候选包在
coding-engine 自身完成 workspace 初始化、正式模式拒绝、Shadow doctor、Shadow PRD 应用、
Developer、Validator 和最终 Review。候选来自运行 `30844326491`，压缩包 SHA-256 为
`db2c22f440d5d912dc195e9e8541ce0e5b54a8d1b275a9421949ce9eebcd382e`。

该运行只证明候选流程能够完整执行，不把 Shadow 结果升级为正式交付凭证，也不要求 GitHub
证明本地模型 Review 已发生。本 PR 在 npm staging 前保持开放且不合并，避免改变候选绑定的
main 提交。PR #65 是旧候选历史，不属于本任务范围。

## Goals

- 用固定 0.34.0 重建候选包在 coding-engine 自身执行完整 Shadow 流程。
- 新增一份边界说明，准确区分 Shadow 本地结果、GitHub 机械门禁和发布判断。
- 让 Validator、三层 Review 与 GitHub 总闸分别核对同一 PR 最新提交。

## Non-Goals

- 不修改源码、测试、质量契约、工作流、依赖、版本号或发布制品。
- 不把本 PR 合并到候选提交，不触碰或合并 PR #65。
- 不实现三个项目的机器回执，不声称完成真实业务下游验证。
- 不在 GitHub 调用模型，也不把本地 workspace 文件提交为共享证明。

## Golden Principles

| 原则                | 适用性与设计裁决                                                                                       | 验证证据                                         |
| ------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------ |
| 1. 可证伪完成合同   | 适用。Story 明确限定新增文件、必须出现的边界和全量检查；任一缺失即失败。                               | 文件差异、Validator 逐项结论、仓库检查。         |
| 2. 生成方不得自签   | 适用。Developer 只提交候选文档；Validator、三层 Review 和 GitHub 机械门禁分别判断。Shadow 永远返回 7。 | Validator receipt、Shadow Review、GitHub 总闸。  |
| 3. 自治与可逆性对称 | 适用但不扩大自治。只新增文档，分支在 staging 前不合并；可直接关闭 PR 丢弃。                            | Git 路径核对、开放 PR 状态。                     |
| 4. 复用原生执行面   | 适用。GitHub 继续运行项目原生检查；候选只在本地调用现有 runner。                                       | 工作流任务列表、本地 runner 记录。               |
| 5. 失败与恢复优先   | 适用。正式模式必须因版本不一致拒绝；Shadow 任一其他错误必须失败关闭，不得只看退出码。                  | formal/shadow 反向检查、结构化状态、最终退出码。 |

## User Stories

### US-001: 记录候选 Shadow 验证的证据边界

作为维护者，我希望有一份短小的候选验证边界说明，从而在审查本轮发布时不会把 Shadow、
GitHub 机械检查或人工发布判断混成同一种证明。

#### Acceptance Criteria

- [ ] 新增 `docs/specs/2026-08-04-candidate-shadow-boundary.md`，不修改本 PRD 之外的其他既有文件。
- [ ] 新文档明确同一候选 CLI 必须贯穿 workspace init、shadow doctor、shadow apply 和最终 run。
- [ ] 新文档明确 Shadow 健康也返回 7，只证明候选运行完成，不能表示正式可交付。
- [ ] 新文档明确 GitHub 只执行机械检查，不调用模型，也不证明本地三层 Review 已运行。
- [ ] 新文档明确本轮 Go/Python 仅为合成跨语言试点，不等于真实业务项目验证。
- [ ] 新文档明确三仓机器回执尚未实现，发布维护者仍需逐仓人工核对同一候选摘要。
- [ ] Format check passes
- [ ] Lint passes
- [ ] Typecheck passes
- [ ] Tests pass
- [ ] Build and repository health checks pass

## Rollback

本 PR 在候选 staging 前不合并。若文档表述或候选运行不符合预期，关闭 PR 并丢弃分支；不得
为了得到绿色而修改质量契约、工作流、候选提交、npm 状态或 PR #65。
