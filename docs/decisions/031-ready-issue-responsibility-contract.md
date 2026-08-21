---
title: 031-ready-issue-responsibility-contract
status: accepted
updated: 2026-08-21
scope: root
---

# 031. ready Issue 在 Agent 前冻结责任分层与证据能力

## 背景

Issue #207 把功能行为、完整项目检查、远端交付和最终耗时写进同一个验收标准列表。PR #318 的
Builder 已完成候选和本地适用检查后，断网 Story Validator 仍被要求取得仅 Linux / GitHub 可提供的
`dependency-audit` 证据，最终只能报告不可验证。同一提交在宿主运行该检查为零漏洞，所以真实问题是
入口没有说明谁负责哪项证据，而不是依赖检查失败。

从验收文字猜出 `dependency-audit` 或“所有检查”会产生第二套质量配置，也无法可靠区分语义、命令、
远端状态和度量。给 Validator 开网络同样只会扩大权限，不能修复责任归属。

## 决策

1. ready Issue 必须包含 schema v1 JSON 执行合同，四个顶层责任字段不可缺省：
   `storyAcceptance`、`localChecks`、`remoteDelivery`、`runMetrics`。
2. Story 标准只来自 `storyAcceptance.criteria`。它固定由 `validator` 提交语义 claim，网络固定为
   `disabled`；检查 id、命令和度量不得进入该数组充当 Validator 任务。
3. `localChecks` 固定由 `engine` 在 `current-host` 运行；`remoteDelivery` 固定由 `github` 在
   `github-actions` 与受管 Ruleset 边界裁决；`runMetrics` 固定由 `engine-clock` 记录。固定字面量被改写、
   增删未知字段或缺少任一层时拒绝。
4. 本地和远端检查只接受质量契约中的稳定 check id。`scoped` 保留路径选择并与显式 id 取并集；
   `full` 不能再列 id。本地 full 只运行当前平台可执行项。远端 full 虽是合法语法，但当前最小入口
   不能靠一次 PR 事件强制完整矩阵，因此会在 Agent 前明确拒绝；不把 scoped 结果伪装成 full。
5. 入口在切换分支、创建源 PRD 提交或启动 Agent 前核对：本地 id 是否支持当前平台，远端 id 是否有
   GitHub job，真实远端必需检查与 Ruleset 是否存在权威裁决路径。loop preflight 对冻结 PRD 再执行同一核对。
6. 合同规范化摘要写入源 PRD 与运行 PRD，并进入 Issue run identity。改变任何字段都建立新身份，旧
   workspace、分支或评论不能冒充新运行。Agent 前、运行后和可信标记前还要重读 Issue、完整源 PRD
   正文与 PR 的目标/非目标/来源/风险，任一偏离都失败关闭。
7. 本地检查证明绑定 HEAD、Story 变化摘要、质量契约、显式要求和每个 check id 的选择原因。相同
   check id 集合若从 `path` 改为 `explicit`，旧证明也不得复用。
8. 远端显式 id 由源 PRD 中与合同相互校验的机器头传给质量契约生成的 GitHub 计划，并强制并入当前
   Issue PR 的检查集合；聚合总闸确认承载 job 成功后才构成远端结果，不让 Validator 重跑。Story 语义
   结论可以先完成；当前 PR 最新 head 的必需检查或 Ruleset 尚未就绪时，最终状态继续等待远端。

## 合同示例

```json
{
  "schemaVersion": 1,
  "storyAcceptance": {
    "evidenceSource": "validator",
    "network": "disabled",
    "criteria": ["用户能观察到预期行为"]
  },
  "localChecks": {
    "evidenceSource": "engine",
    "network": "current-host",
    "mode": "scoped",
    "checkIds": ["tests"]
  },
  "remoteDelivery": {
    "evidenceSource": "github",
    "network": "github-actions",
    "mode": "scoped",
    "checkIds": ["dependency-audit"],
    "ruleset": "required"
  },
  "runMetrics": {
    "evidenceSource": "engine-clock",
    "metrics": ["ready-to-trusted", "active", "waiting", "continuations"]
  }
}
```

## 后果

- 尚未启动的旧 ready Issue 没有执行合同时，维护者可用当前模板补合同、移除再重新添加
  `ready-for-agent`；已有运行评论、分支、workspace 或 PR 的旧 Issue 必须保留现场并新建 Issue，不能
  让新身份接管旧运行。
- 当前可信 Issue 入口只接受 `codex`；Claude/Cursor 在能够签发正式 Validator 凭证前于任何 Agent 前拒绝。
- Issue 作者需要明确选择责任层，但不需要复制命令、平台矩阵或 Ruleset 名称；这些仍由质量契约单一
  维护。
- 本地快速路径不退化为默认全量；显式本地 id 只补充路径选择，远端条件不扩大 Validator 权限。
