---
title: '0.36.0 RC1 候选包与三仓 Shadow 证明'
status: active
updated: 2026-08-14
scope: root
---

# 0.36.0 RC1 候选包与三仓 Shadow 证明

## Context

coding-x 0.36.0 的主菜是 Validator 宿主隔离（ADR-025 / #174）：只有机械可证宿主隔离的
Runner（当前为固定审计版本的 Codex）可以签发验收凭证，凭证升级到 schema v3 并绑定
Runner profile 摘要与 canary 反测证据摘要；claude/cursor 进入验证阶段按不可验证保留候选
并以退出码 5 停止。版本 PR #223 已合并，RC1 候选构建与三系统安装总闸已于 2026-08-13
成功完成。本 PRD 是 0.36.0 的首个候选 seed，没有先前 RC 失效历史。

以下身份必须作为一个整体固定，任一项不匹配都要停止：

- 版本：`coding-x@0.36.0`
- 来源提交：`4706d385e4289daadf8eb3f2df2c91a5d8d90762`
- Build release candidate run：`31690201048`
- artifact：`npm-candidate-0.36.0`，ID `9177358726`
- artifact digest：`sha256:ae37496a36c5420fd514dfb1dd1869d59e4d52812f589bb70561bbf23f44450a`
- 候选 tarball 大小：`723750` bytes
- 候选 tarball SHA-256：`a7f3401f9a15505dc33f4b6f0597ab94778147a63079e5ee00586fb3e7a4e233`
- coding-engine 固定 RC1 CLI：从上述同一 tarball SHA-256 的候选包在仓库外建立的全新独立安装的
  真实命令入口；一次性安装目录本身不构成身份，环境清理后必须从同一摘要重建安装并重新核对入口，
  不得因目录消失而放弃或伪造证据。本轮实际入口（现场记录，供审计回溯）：
  `/tmp/coding-x-rc1-materials.eNz343/install-engine/node_modules/.bin/coding-x`
- 固定 CLI SHA-256：`642e386a2f6491a7032a348b15ff0efaec8031afd00311c6003266964a19b71c`（每次执行
  前对实际入口解析出的 `dist/cli.js` 重新核对；不一致立即停止）
- 历史修复边界：版本 PR #223 已合并并通过其 exact-head 全部检查；它不构成 npm staging 或发布许可

两个跨语言合成试点已用同一候选完成全新 Shadow Dogfood，证据必须按下列事实记录，不得复用
0.34/0.35 任何旧工件：

- Go 多模块试点：seed 仓 `Xinzz995/coding-x-dogfood-go`，PR #30，分支
  `dogfood/0.36.0-rc1-shadow`。init 退出 0；shadow doctor 退出 7 且 `quality.status=shadow`
  （固定 0.34.1 vs 候选 0.36.0）；普通 doctor 退出 1 拒绝版本不一致；shadow apply-prd 退出 7 且
  `status=applied-shadow`；审计版 codex（`codex-cli 0.147.0-alpha.6.5`）完成宿主隔离
  profile + canary 后签发 v3 凭证，最终 run 退出 7，final review `passed`、`shadow=true`
  （round 2：round 1 的 P1 为 PR 正文函数名笔误，修正正文后重审通过）；三平台原生 CI 与
  quality-gate 全绿，CI 不安装 Node 或 coding-x。
- Python 多包试点：seed 仓 `Xinzz995/coding-x-dogfood-python`，PR #26，分支
  `dogfood/0.36.0-rc1-shadow`。四步 shadow 序列与 Go 一致（init 0 / doctor 7+shadow /
  apply 7+applied-shadow / run 7），final review `passed`、`shadow=true`；额外完成 ADR-025
  负向断言：未审计版本 codex（0.146.0 透传壳）与 cursor 进入验证阶段均按
  `environment-unverifiable (unsupported-version)` 保留候选并退出 5，不增加重试，
  evidence 留有两条 `unsupported-version` 的 `validatorProfile` 记录；随后审计版 codex 完成
  宿主隔离 profile + canary（36.3s）签发 v3 凭证（`runnerProfileDigest` 与
  `canaryEvidenceDigest` 与 evidence `ready` 记录互绑）。cursor 作为 Builder 时 POSIX
  supervisor 按 process-unsettled 保留现场并拒绝恢复，属 fail-closed 设计行为，已如实记录。

本 PRD 的首个 seed 提交（`2e32a12`）在自托管首轮运行中揭示：0.36 的隔离验证检出只含精确
HEAD（与 TDD 基线引用），`npm run format:check` 因依赖 `origin/main` 引用在验证域内不可执行；
Validator 按合同拒绝伪造 claim、引擎按 missing-result 保留候选并退出 5，行为全部 fail-closed。

第二轮自托管（seed 修订 `2af3711`）进一步揭示两条 0.36 隔离边界：Validator 在隔离检出内重跑
`npm test` 时，coding-engine 自身的嵌套进程监督用例（POSIX supervisor、workspace 安全协调器等）
与 Validator 宿主隔离域冲突而批量失败；同时 npm 以重定向后的临时身份域为 `HOME` 运行，缓存写入
产生符号链接，收口检查按「临时域包含链接」判定 identity-or-tree-unverified，保留现场并以退出码
2 fail-closed。两轮均未伪造任何结论。据此，本修订把 AC 10 调整为证明职责划分的文档验收：隔离
检出内由引擎机械门禁执行当前系统适用检查集，其余由本 PR 最新 head 的远端 quality-gate 证明，
Validator 不在隔离身份域内重跑全量测试套件或执行 npm 安装。这些是 0.36 验证域隔离下「引擎自身
作为被验证项目」的适配事实，必须记入证明计划，不构成对候选包的修改。

## Goals

- 新增一份短小的 RC1 证明计划，记录同一候选在三个托管系统的安装证明、三仓 Dogfood 边界与
  ADR-025 宿主隔离验证事实。
- 用固定 RC1 CLI、全新 workspace、全新变更请求和全新 requestId 对本 PR 完成一次 Shadow 自托管，
  真实走完宿主隔离 profile + canary + v3 凭证链。
- 保持运行代码、测试、质量契约、工作流、版本、依赖和发布资产不变。

## Non-Goals

- 不触发 npm staging、2FA 批准、`next`、`latest`、标签或 GitHub Release。
- 不合并本 PR 或其他 Dogfood PR，也不把 Shadow 退出 7 解释为正式可交付。
- 不把 Go/Python 合成试点写成真实业务下游采用证明。
- 不在本仓固定 0.36.0 稳定裁判；稳定发布后由独立 Policy PR 处理。

## Golden Principles

| 原则             | 适用性与设计裁决                                                                                             | 验证证据                                                       |
| ---------------- | ------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------- |
| 可证伪完成合同   | 适用。RC1 十项身份、三仓证据事实和 Shadow 强完成条件（含 v3 凭证双摘要互绑）缺少任一项即失败。               | 候选制品回读、三仓命令结果、evidence `validatorProfile`、远端检查。 |
| 生成方不得自签   | 适用。Agent 自述和 `passes=true` 不是结论，必须同时存在宿主隔离链下的 v3 引擎回执、Final Review 与原生门禁。 | Validator v3 回执、schema v2 Review 和 GitHub checks。         |
| 自治与可逆性对称 | 适用。本任务只新增计划；合并、暂存和发布继续需要独立人工决定。                                               | 路径差异检查；流程停在开放 PR 和未暂存候选。                   |
| 复用原生执行面   | 适用。三系统证明来自托管系统和 npm 真实入口，三仓继续运行各自原生检查；宿主隔离复用 Codex 原生参数与环境面。 | candidate run 任务与三个候选 PR 的原生质量总闸。               |
| 失败与恢复优先   | 适用。身份不符、旧证据混入、宿主隔离不可证或强完成条件不全时停止，并从全新 workspace 重新执行。              | 新 requestId/HEAD 绑定；unverifiable 退出 5 语义；非零失败结果。 |

## User Stories

### US-001: 记录 RC1 候选与三仓全新 Shadow 证明

作为发布维护者，我希望得到一份身份固定、证据边界清楚的 RC1 证明计划，从而能在另行申请 npm
暂存前确认三个项目确实使用同一最终候选完成了全新验证，且 ADR-025 宿主隔离在真实运行中按
设计生效。

#### Acceptance Criteria

- [ ] 新增且只新增 `docs/plans/2026-08-14-rc1-candidate-package-proof-0.36.0.md` 作为实现文件；
      本源 PRD 与 seed 提交保持不变。
- [ ] 计划逐字包含版本、来源提交、候选运行编号、artifact 名称、ID 与 digest、tarball 大小与
      SHA-256、候选入口建立与重建规则、本轮实际入口的现场记录路径、CLI SHA-256、PR #223 边界，
      并声明十项身份必须同时匹配。
- [ ] 计划声明 0.36.0 RC1 是首个候选、没有先前 RC 失效历史，且 0.34/0.35 的包、安装、workspace、
      requestId、Validator 回执、Final Review、报告和 PR 结论都不能作为 RC1 证据。
- [ ] 计划用表格分别记录 Ubuntu 24.04、macOS 26 与 Windows Server 2022 下载同一 artifact、核对
      同一摘要、仓库外全新安装，并从 npm 真实命令入口完成 help、workspace init 和 shadow doctor。
- [ ] 计划按本 PRD Context 的事实逐仓记录 Go（PR #30）与 Python（PR #26）的四步 Shadow 证据、
      final review `passed`/`shadow=true` 结论与原生 CI 全绿事实，并记录 Python 试点的 ADR-025
      负向断言：未审计版本 codex 与 cursor 进入验证阶段均退出 5 且候选保留、不增加重试。
- [ ] 计划记录 ADR-025 正向证据要求：审计版 codex 的 shadow run 中 evidence `validatorProfile`
      的 `resolution=ready` 记录、canary 耗时，以及 v3 凭证 `runnerProfileDigest` 与
      `canaryEvidenceDigest` 与 evidence 互绑；同时记录三条已知边界——cursor 作为 Builder 时
      POSIX supervisor 的 process-unsettled fail-closed 行为；隔离验证检出不含
      `origin/main` 导致依赖远端引用的项目命令（如本仓 `format:check`）在验证域内不可执行、
      首轮自托管按 missing-result 退出 5 的事实；以及 Validator 在隔离域内重跑本仓全量测试
      触发嵌套进程监督用例冲突、npm 缓存在临时身份域产生符号链接导致
      identity-or-tree-unverified 保留现场并退出 2 的事实。
- [ ] 计划逐项记录本 PR 的 Shadow 强完成合同、两阶段远端收口和失败观察，不用「运行成功」概括代替。
- [ ] 计划明确 npm staging、2FA 批准、`next`、`latest`、`v0.36.0` 标签和 GitHub Release 均未执行，
      PR #223 的合并和 Shadow 退出 7 都不构成任何发布许可。
- [ ] 不修改运行代码、测试、质量契约、工作流、版本、依赖或发布资产。
- [ ] 计划记录质量证明职责划分：隔离检出内由引擎机械门禁执行当前系统适用检查集（本轮 macOS
      为 tests、legacy-compatibility、build、cli-smoke、typecheck、repository-health）；
      format、lint、dependency-audit、Windows 原生证明与全平台矩阵由本 PR 最新 head 的远端
      quality-gate 证明；并声明 Validator 不在隔离身份域内重跑全量测试套件或执行 npm 安装
      （本仓嵌套进程监督用例与隔离域冲突、npm 缓存会在临时身份域产生符号链接，均为 0.36
      已知边界），不得因此放宽任何一项机械检查的证明义务。

## 本 PR Shadow 强完成合同

- 固定 RC1 CLI 执行 workspace init 返回 0；普通 doctor 与 apply-prd 因正式裁判版本不匹配而拒绝。
- shadow doctor 同时返回 7、`quality.status=shadow` 且没有其他错误；shadow apply-prd 同时返回 7
  与 `status=applied-shadow`。
- 运行必须把以下命令作为一个整体执行，参数逐字保持，不得换用全局命令、其他候选或默认
  `.workspace`。`<candidate-cli>` 是按候选入口身份规则建立、并通过 CLI SHA-256 核对的入口绝对
  路径；环境被清理时从同一 tarball 摘要重建安装并重新核对后重跑：

  ```bash
  <candidate-cli> codex --shadow --workspace <fresh-workspace> --no-open --port 0 --builder-model gpt-5.6-sol --validator-model gpt-5.6-sol --review-model gpt-5.6-sol --escalation-model gpt-5.6-sol --dev-timeout 60 --val-timeout 90 --max-iter 5
  ```

  最终返回 7；任何 1–6 都是失败，不能继续使用该结果申请暂存。入口摘要不一致按失败处理，不得
  以未经核对的入口取得任何证据。

- Story 必须达到 `blocked=false`、`passes=true`、`validated=true`，并产生绑定当前 PR HEAD、
  `coding-x@0.36.0`、runner `codex` 审计版本 `0.147.0-alpha.6.5`、模型 `gpt-5.6-sol` 和本次
  requestId 的全新 v3 Validator 回执；回执的 `runnerProfileDigest` 与 `canaryEvidenceDigest`
  必须与同轮 evidence `validatorProfile`（`resolution=ready`）逐字一致。
- 最终 Review 必须是 schema v2，并同时满足 `status=passed`、`deliveryStatus=shadow`、
  `shadow=true`、`remote.status=ready`，且绑定当前 PR HEAD；Shadow 结果仍不表示正式可交付。
- seed PR 与 Builder 最终 HEAD 的本地既有检查、Policy Guard、CodeQL、跨平台质量检查与总闸都必须
  分别成功；Builder 提交推送前的远端未就绪只允许作为中间退出 6，不能当作完成证据。

## Rollback

若 RC1 身份、证据边界或完成合同不正确，关闭本 PR 并删除分支；不得修改候选包、主分支、质量
契约或发布状态来取得绿色结果。
