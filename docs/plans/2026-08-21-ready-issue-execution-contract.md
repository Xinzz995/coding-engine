---
title: ready Issue 执行合同与运行前能力对账
status: active
updated: 2026-08-21
scope: root
---

# ready Issue 执行合同与运行前能力对账

## 目标与边界

本轮修复 Issue #207 / PR #318 暴露的入口责任错配：Story 语义、项目检查、远端交付与运行度量
不得再混在 Validator 的自然语言验收标准里。ready Issue 改用一个版本化 JSON 执行合同；入口在创建
实现提交或启动 Agent 前，把它与当前质量契约、运行平台和 GitHub 证据能力逐项对账。

本轮不扩大 Validator 网络或宿主权限，不取消按变化范围选择，不增加轮询、队列、自动合并或发布。
普通非 Issue PRD 沿用现有路径；旧 ready Issue 缺少执行合同时明确要求迁移，不猜测旧文本含义；已有
运行现场时必须新建 Issue，不能用新身份接管旧评论、分支、workspace 或 PR。

## 可证伪完成合同

| # | 完成条件 | 通过证据 | 失败观察 |
| -: | --- | --- | --- |
| 1 | 执行合同分别保存 Story 语义、本地检查、远端交付和运行度量，并有固定 schema 版本 | 解析、摘要和模板合同测试 | 任一字段缺失、未知或改写后仍沿用旧运行身份 |
| 2 | Story Validator 只收到执行合同中的语义标准和已完成的引擎检查证明 | Validator request 回归 | 检查名称或运行度量仍出现在 Validator AC 中 |
| 3 | 本地和远端检查只接受质量契约中的稳定 id；模式只接受 `scoped` / `full` | 严格解析与未知 id 回归 | 从自然语言或命令字符串提取检查意图 |
| 4 | 第一个 Builder 前核对本地平台、固定网络边界、证据来源和远端 GitHub job / Ruleset 能力 | 入口和 loop preflight 回归 | macOS 本地要求 Linux-only 检查后仍启动 Agent |
| 5 | scoped 本地检查把显式 id 与路径选择取并集且每项只执行一次；full 只执行当前平台契约全集 | selector 和 loop gate 回归 | 显式项重复运行、被路径筛掉或跨平台运行 |
| 6 | 检查证明绑定 HEAD、变化摘要、质量契约和逐项选择原因；任一变化拒绝复用 | proof/currentness 回归 | 相同 id 集合但责任来源不同仍复用旧证明 |
| 7 | 远端条件只由当前 PR head 的 GitHub 检查与 Ruleset 裁决，不进入断网 Validator | remote / issue refresh 回归 | 本地语义结论被远端等待阻断，或缺远端结果仍可信 |
| 8 | 普通 scoped Issue、单分支、单 PR、单评论及相同输入复用保持不变；Issue、源 PRD 正文和 PR 意图始终一致 | Issue 入口组合回归 | 默认合同退化成 full、重复创建远端对象，或修改正文后仍可信 |
| 9 | 用户文档给出可复制合同和分层选择规则，并记录 #318 的失败原因 | 文档与仓库健康检查 | 文档继续推荐“所有检查通过”这类混合标准 |

## 设计裁决

### 最小执行合同

Issue 模板提供唯一一个 JSON 对象，包含：

- `storyAcceptance`：标准数组，固定由断网 Story Validator 提交语义 claim；
- `localChecks`：`scoped` 或 `full`，固定由当前主机上的引擎生成机械证明；
- `remoteDelivery`：`scoped` 或 `full`，固定由当前 PR head 的 GitHub Actions 与受管 Ruleset裁决；
- `runMetrics`：固定由引擎时钟记录 ready 到可信、实际运行、等待和继续次数。

责任方、网络边界和证据来源使用固定字面量。未知字段、重复 id、`full` 同时列显式 id、空语义标准
或缺少任一层都拒绝。合同摘要进入源 PRD 和运行 PRD；Issue body 与合同任一修改都会改变运行身份。

### 运行前对账

入口从当前质量契约建立唯一 check id 表，并确认所选 runner 能完成正式 Validator 闭环；
`localChecks.checkIds` 必须支持当前平台；
`remoteDelivery.checkIds` 必须至少出现在一个 GitHub job 中，且项目必须由实际存在的 GitHub 必需检查与
受管 Ruleset 提供权威交付结论。任何不匹配在分支切换、源 PRD 提交和 Agent 调用前停止。

loop preflight 再对冻结 PRD、合同摘要、Story AC 和当前质量契约执行同一纯函数核对，防止入口后到
Agent 前发生错绑。普通 PRD 没有 Issue 执行合同时不进入这条专用规则。

### 本地检查与证明

`scoped` 先按 Git pathspec 计算检查，再按质量契约顺序并入显式 id；同一 id 只执行一次。
`full` 仍只取当前平台可运行的契约检查。证明为每个已选 id 记录 `path`、`explicit`、`always` 或
`full` 原因，并把原因集合放入复用摘要；原因变化即使最终 id 相同也拒绝复用。

### 远端交付

显式远端 id 通过源 PRD 机器头并入质量契约生成的 GitHub 路径选择，由映射 job 强制执行，不表示把
命令交给 Validator 重跑。入口只接受存在真实 GitHub job 映射的 id；最终 Review 继续以当前 PR head 的必需检查、代码
扫描和受管 Ruleset 为唯一远端事实。远端未完成或失败不妨碍 Story Validator 写语义结论，但最终交付
保持等待或失败，不得标为可信。

## 黄金原则逐项对照

### 1. 先定义可证伪的完成合同

- **适用性**：适用；本次缺陷正是自然语言把不同完成条件混成一项。
- **裁决**：以上九项都列出可观察的通过证据与失败结果；执行合同严格解析且逐层绑定。
- **验证证据**：解析、入口、selector、proof、Validator、remote、Issue 恢复和文档合同测试。

### 2. 生成方不得给自己签发通过

- **适用性**：适用；Builder 和 Issue 文本都不能成为机械或远端通过证明。
- **裁决**：本地检查只认引擎结果，远端只认当前 GitHub / Ruleset，Validator 只提交语义 claim。
- **验证证据**：未知 id、未执行检查、旧 head、错摘要和缺远端结果全部失败关闭。

### 3. 自治范围扩大时同步增加防线与可逆性

- **适用性**：不扩大 Agent 写入、网络、合并、发布或删除范围。
- **裁决**：入口只增加启动前拒绝条件；失败发生在实现提交和 Agent 调用前，可通过修订 Issue 并重新
  添加 ready 标签建立新运行恢复。
- **验证证据**：拒绝路径断言 Builder、Validator 和实现提交调用次数均为零。

### 4. 原生执行优先，差异只在控制平面

- **适用性**：适用。
- **原生能力对照**：路径仍由 Git pathspec 判定；本地命令仍来自质量契约；远端仍由 GitHub Actions
  和 Ruleset 执行；runner 能力不重建。
- **build/adapt 裁决**：只在 Issue 入口、检查选择和证明绑定中增加责任信息，不新增工作流语言或依赖。
- **验证证据**：合同核心不含 Claude、Codex、Cursor 或语言生态字段。

### 5. 以假绿率和失败恢复衡量价值

- **适用性**：适用；#318 是 Builder 已完成后才发现证据永远不可得的真实失败。
- **裁决**：先固定 macOS + `dependency-audit` 错层失败样本，再实现成功路径；主要指标是无能力合同在
  Builder 前拒绝，普通 scoped 快速路径耗时不退化。
- **验证证据**：#207 合同回归、普通 Issue 恢复回归、完整质量检查及运行状态对账。

## 实施顺序

1. 固化严格合同解析、摘要和能力对账测试。
2. 接入 Issue 模板、源 PRD、运行 PRD 与入口启动前拒绝。
3. 接入 loop preflight、本地检查并集、逐项选择原因和证明复用。
4. 收窄 Validator 输入并保留现有远端最终裁决。
5. 更新 ADR、架构、README、dogfood 回归和 #318 失败说明。
6. 运行定向测试，再按完整改动范围执行项目质量契约。
