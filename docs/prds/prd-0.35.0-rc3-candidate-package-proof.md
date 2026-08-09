---
title: '0.35.0 RC3 候选包与三仓 Shadow 证明'
status: active
updated: 2026-08-09
scope: root
---

# 0.35.0 RC3 候选包与三仓 Shadow 证明

## Context

coding-x 0.35.0 RC1 因 Final Review 事件兼容缺口作废；RC2 又在 coding-engine 自托管
Dogfood 中暴露 POSIX 不透明 Runner 外部终止后可能假结算的问题，因此也永久作废，且从未进入
npm staging。Issue #196 只授权修复并已在最终主线检查通过后关闭，不授权暂存或发布。

RC3 从修复后的最终主线重新构建。以下身份必须作为一个整体固定，任一项不匹配都要停止：

- 版本：`coding-x@0.35.0`
- 来源提交：`2ac10e24a8b7fe23355e34aeee71aa87717d2d7b`
- Build release candidate run：`31289659773`
- artifact：`npm-candidate-0.35.0`，ID `9031076577`
- 候选 tarball 大小：`708857` bytes
- 候选 tarball SHA-256：`4e0acaf3fe5673c1957faaf64ea2f022e1920f80a2fa53091c9c012b40ed2388`
- coding-engine 固定 RC3 CLI：`/private/tmp/coding-x-rc3-materials.8iB1AE/installs/engine/node_modules/.bin/coding-x`
- 修复例外：Issue #196，状态为已关闭

## Goals

- 新增一份短小的 RC3 证明计划，记录同一候选在三个托管系统的安装证明和三仓 Dogfood 边界。
- 用固定 RC3 CLI、全新 workspace、全新变更请求和全新 requestId 对本 PR 完成一次 Shadow 自托管。
- 明确 RC1/RC2 的包、workspace、Validator 回执、Final Review 和 PR 结论均不得复用。
- 保持运行代码、测试、质量契约、工作流、版本、依赖和发布资产不变。

## Non-Goals

- 不触发 npm staging、2FA 批准、`next`、`latest`、标签或 GitHub Release。
- 不合并本 PR 或其他 Dogfood PR，也不把 Shadow 退出 7 解释为正式可交付。
- 不把 Go/Python 合成试点写成真实业务下游采用证明。

## Golden Principles

| 原则             | 适用性与设计裁决                                                                           | 验证证据                                                     |
| ---------------- | ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| 可证伪完成合同   | 适用。RC3 九项身份、三仓新身份和 Shadow 强完成条件缺少任一项即失败。                       | 候选制品回读、三仓命令结果、workspace 状态与远端检查。       |
| 生成方不得自签   | 适用。Agent 自述和 `passes=true` 不是结论，必须同时存在引擎回执、Final Review 与原生门禁。 | Validator 回执、schema v2 Review 和 GitHub checks。          |
| 自治与可逆性对称 | 适用。本任务只新增计划；合并、暂存和发布继续需要独立人工决定。                             | 路径差异检查；流程停在开放 PR 和未暂存候选。                 |
| 复用原生执行面   | 适用。三系统证明来自托管系统和 npm 真实入口，三仓继续运行各自原生检查。                    | candidate run 五个任务与三个候选 PR 的原生质量总闸。         |
| 失败与恢复优先   | 适用。身份不符、旧证据混入或强完成条件不全时停止，并从全新 workspace 重新执行。            | 新 requestId/HEAD 绑定；RC1/RC2 证据反向扫描；非零失败结果。 |

## User Stories

### US-001: 记录 RC3 候选与三仓全新 Shadow 证明

作为发布维护者，我希望得到一份身份固定、证据边界清楚的 RC3 证明计划，从而能在另行申请 npm
暂存前确认三个项目确实使用同一修复后候选完成了全新验证。

#### Acceptance Criteria

- [ ] 新增且只新增 `docs/plans/2026-08-09-rc3-candidate-package-proof-0.35.0.md` 作为实现文件；
      本源 PRD 与 seed 提交保持不变。
- [ ] 计划逐字包含版本、来源提交、候选运行编号、artifact 名称与 ID、tarball 大小与 SHA-256、
      固定 engine CLI 和 Issue #196，并声明九项身份必须同时匹配。
- [ ] 计划明确 RC1 与 RC2 永久作废；旧包、旧 workspace、旧 requestId、旧 Validator 回执、
      旧 Final Review 和旧 PR 结论都不能作为 RC3 证据。
- [ ] 计划用表格分别记录 Ubuntu 24.04、macOS 26 与 Windows Server 2022 下载同一 artifact、
      核对同一摘要、仓库外全新安装，并从 npm 真实命令入口完成 help、workspace init 和 shadow doctor。
- [ ] 计划要求 coding-engine、Go、Python 分别使用独立 RC3 安装、全新 workspace、全新变更请求和
      全新 requestId，且三者的候选版本、来源提交、运行编号与 tarball 摘要一致。
- [ ] 计划明确 RC3 构建与三系统安装总闸已经完成；三仓 Shadow Dogfood、各仓原生门禁和人工证据
      对账必须逐仓完成，不能由 candidate workflow 或旧 PR 检查代替。
- [ ] 计划逐项记录本 PR 的 Shadow 强完成合同和失败观察，不用“运行成功”概括代替。
- [ ] 计划明确 npm staging、2FA、`next`、`latest`、`v0.35.0` 和 GitHub Release 均未执行，
      Issue #196 的关闭不构成任何发布许可。
- [ ] 不修改运行代码、测试、质量契约、工作流、版本、依赖或发布资产。
- [ ] `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、
      `npm run repository-health` 与 `npm run build` 全部通过。

## 本 PR Shadow 强完成合同

- 固定 RC3 CLI 执行 workspace init 返回 0；普通 doctor 与 apply-prd 因正式裁判版本不匹配而拒绝。
- shadow doctor 同时返回 7、`quality.status=shadow` 且没有其他错误；shadow apply-prd 同时返回 7
  与 `status=applied-shadow`。
- 运行必须把以下命令作为一个整体执行，不得换用全局命令、其他候选或默认 `.workspace`：

  ```bash
  /private/tmp/coding-x-rc3-materials.8iB1AE/installs/engine/node_modules/.bin/coding-x codex --shadow --workspace <fresh-workspace> --no-open --port 0 --builder-model gpt-5.6-sol --validator-model gpt-5.6-sol --review-model gpt-5.6-sol --escalation-model gpt-5.6-sol --dev-timeout 60 --val-timeout 90 --max-iter 5
  ```

  最终返回 7；任何 1–6 都是失败，不能继续使用该结果申请暂存。

- Story 必须达到 `blocked=false`、`passes=true`、`validated=true`，并产生绑定当前 PR HEAD、
  `coding-x@0.35.0`、runner `codex`、模型 `gpt-5.6-sol` 和本次 requestId 的全新 Validator 回执。
- 最终 Review 必须是 schema v2，并同时满足 `status=passed`、`deliveryStatus=shadow`、
  `shadow=true`、`remote.status=ready`，且绑定当前 PR HEAD；Shadow 结果仍不表示正式可交付。
- PR 最新 HEAD 的本地既有检查、Policy Guard、CodeQL、跨平台质量检查与总闸全部成功。

## Rollback

若 RC3 身份、证据边界或完成合同不正确，关闭本 PR 并删除分支；不得修改候选包、主分支、质量
契约或发布状态来取得绿色结果，也不得退回 RC1/RC2 的任何证据。
