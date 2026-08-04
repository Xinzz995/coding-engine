---
title: "0.34.0 候选证据边界 R2"
status: active
updated: 2026-08-04
scope: root
---

# 0.34.0 候选证据边界 R2

## Context

本轮只为 coding-engine 的全新自托管 Dogfood 建立一份可核对的候选证据边界。唯一候选是
`coding-x@0.34.0`，来自 GitHub Actions 运行 `30914071363`，绑定 `main` 提交
`08d9539d1cca986a9ed2ff2b4f1498ac849988b3`，压缩包 SHA-256 为
`4a0a616e33a48a54f574c44a31d3d510fb380a247d90d2cfd1e459f02dcd8c54`。

候选构建成功和本地压缩包摘要一致，只证明候选字节身份已经建立；它们不证明本 PR 的
Developer、Validator、三层 Review、GitHub CI、外部试点、npm staging、公开发布或合并已经
完成。当前正式质量契约仍固定 `coding-x 0.33.3`，因此 0.34.0 只能显式使用 shadow 路径，
健康退出 7 也不得表述为可交付。

## Goals

- 新增一份短小、独立的实施计划，记录本轮候选的精确身份和证据边界。
- 把“已经直接证明”“仍须本轮产生”“明确不在本 PR 完成”分开，避免把候选构建或 shadow
  退出 7 写成发布完成。
- 为本轮文档 Story 提供低风险、可机械核对且能产生真实提交的验收目标。

## Non-Goals

- 不修改代码、测试、构建、工作流、质量契约、依赖、版本号或发布资产。
- 不触发 npm staging，不发布 npm，不创建或移动标签，不创建 GitHub Release。
- 不合并本 PR，不修改、关闭或合并 PR #65，也不处理其他 Dogfood PR。
- 不把 coding-engine 的结果外推为 Go/Python 试点或真实业务下游已经验证。

## Functional Requirements

1. 新增 `docs/plans/2026-08-04-candidate-evidence-boundary-0.34.0-r2.md`，以表格列出证据阶段、
   可定位证据和当前结论。
2. 文档必须逐字记录版本、candidate run、main 提交和 SHA-256，并声明四项身份必须同时匹配；
   本轮三步固定使用绝对 CLI
   `/private/tmp/coding-x-dogfood-0.34-r5.eDvI6T/engine-install/node_modules/coding-x/dist/cli.js`。
3. 文档必须把候选构建成功、本地摘要复核与本轮尚待产生的 shadow、Agent、Review、CI 证据
   分开；Go/Python、staging、公开发布与合并继续标为本 PR 之外。
4. 文档必须说明：同一绝对候选 CLI 贯穿 doctor、apply-prd 和 run；正式 doctor/apply-prd
   应因固定 0.33.3 与候选 0.34.0 不一致而失败；shadow 三步健康时都退出 7，且 7 不是通过或
   可交付结论。
5. 文档必须保留本轮安全边界：PR 保持开放，不触发 staging，不修改 PR #65，不使用维护者的
   真实 checkout。

## Golden Principles

| 原则 | 适用性与设计裁决 | 验证证据 |
|---|---|---|
| 1. 可证伪完成合同 | 适用。精确字符串、目标路径和证据状态都有正反观察，不使用“全部完成”概括。 | 文件路径、四项身份逐字匹配、证据表状态。 |
| 2. 生成方不得自签 | 适用。文档只登记来源和边界；Developer 自述、shadow 退出 7 与本 PR 文字都不能替代 Validator、Review 或 CI。 | Validator 回执、三层 Review、PR checks 分开核对。 |
| 3. 自治与可逆性对称 | 不扩大自治。只新增文档，不授权合并、发布、标签、staging 或修改其他 PR；提交可普通回退。 | Git diff 只含允许文档；PR 保持开放。 |
| 4. 原生执行优先 | 适用。候选只调用仓库原有 doctor、workspace apply-prd、Codex runner 和 GitHub CI，不新增执行面。 | 固定绝对 CLI 的命令记录与远端 checks。 |
| 5. 假绿与恢复优先 | 适用。把固定版本失败和 shadow 退出 7 的非交付语义作为显式反例；任一身份不符即停止。 | 正式失败、shadow 三步退出码和状态字段对账。 |

## User Stories

### US-001: 记录候选证据边界

作为发布维护者，我希望用一份独立文档准确区分 0.34.0 候选已经建立的身份、仍待本轮产生的
验证证据和明确不在本 PR 完成的发布动作，从而不会把 shadow 结果误当成可交付结论。

#### Acceptance Criteria

- [ ] 新增且只新增目标计划 `docs/plans/2026-08-04-candidate-evidence-boundary-0.34.0-r2.md`；其 frontmatter 为 `status: active`、`updated: 2026-08-04`、`scope: root`。
- [ ] 目标计划逐字包含 `0.34.0`、运行 `30914071363`、main 提交 `08d9539d1cca986a9ed2ff2b4f1498ac849988b3` 和 SHA-256 `4a0a616e33a48a54f574c44a31d3d510fb380a247d90d2cfd1e459f02dcd8c54`，并声明四项必须同时匹配。
- [ ] 目标计划逐字包含本轮固定绝对 CLI `/private/tmp/coding-x-dogfood-0.34-r5.eDvI6T/engine-install/node_modules/coding-x/dist/cli.js`，且 doctor、apply-prd、run 不得换用其他入口。
- [ ] 目标计划用表格分别标明：候选构建与本地摘要已经直接核对；本 PR 的 shadow、Developer、Validator、三层 Review 和 GitHub CI 仍须产生；Go/Python、npm staging、公开发布、标签、Release 与合并不由本 PR 完成。
- [ ] 目标计划明确同一绝对候选 CLI 贯穿三步；正式 doctor/apply-prd 因 `0.33.3` 固定版本不一致而失败；shadow doctor/apply-prd/run 健康时均退出 7，且退出 7 永远不表示通过或可交付。
- [ ] 目标计划明确本 PR 保持开放、不触发 npm staging、不修改 PR #65、不使用维护者真实 checkout。
- [ ] 相对 `main` 的受管改动只有本 PRD 和目标计划，不修改代码、测试、工作流、质量契约、依赖、版本或发布文件。
- [ ] Repository health check passes

## Verification

- `git diff --name-only origin/main...HEAD`
- `npm run repository-health`
- 对候选版本、run、main 提交和 SHA-256 做逐字搜索并人工核对。
- Developer、Validator、三层 Review 与 GitHub CI 属于本 Story 完成后的独立验证层，不写入上述
  实现验收标准的完成事实。

## Rollback

若身份或边界记录有误，只回退本 PR 的两份文档并从候选任务与本地压缩包重新核对；不得通过
改质量契约、重建替代候选、触发 staging、修改 PR #65 或合并本 PR 来迎合文档。
