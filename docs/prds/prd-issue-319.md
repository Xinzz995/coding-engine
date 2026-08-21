---
title: "Issue #319: 运行前对账验收责任与实际检查能力"
status: active
updated: 2026-08-21
scope: root
---

# Issue #319: 运行前对账验收责任与实际检查能力

> GitHub Issue: https://github.com/Xinzz995/coding-engine/issues/319
> Issue-Run-ID: sha256:8068022e259dc7fe6a92a3595190c4c0309a774b9f9a50d965f0a0143d32012d
> Issue-Body-Digest: sha256:627ebe7dfd3592a240d313a8f9deaebc6d4458074e8e79415be149a7fbefde2c
> Issue-Execution-Contract-Digest: sha256:51e67f7d71abab7800bcb4ed6437cec9ca1e1e44f926bd1dc5b30359cb0707df
> Issue-Remote-Check-Mode: scoped
> Issue-Remote-Check-IDs: dependency-audit
> Ready-At: 2026-08-21T07:49:37Z

## Goals

修复 #207 / PR #318 暴露的入口合同缺口：一个 ready Issue 可以把本地语义验收、项目机械检查、远端交付检查和最终耗时记录混写成同一组 Validator 验收标准。引擎随后只按变更路径选择适用检查，而断网 Validator 又被要求补跑未选中或仅远端可运行的检查，导致 Builder 已完成后才进入永远无法自愈的“无法验证”。

为 ready Issue 增加版本化、机器可读的责任分层与检查要求。任何 Agent 启动前，引擎必须确认每项要求由哪一层负责、对应检查是否存在、当前运行是否有能力取得证据；无法满足时立即拒绝启动，并给出明确缺口。不得从自然语言猜检查名称。

## Non-Goals

- 不给 Validator 开放网络、宿主配置、插件或更宽权限。
- 不取消按变更范围选择必要检查，也不默认恢复每次全量运行。
- 不让 Builder、Validator 或 Issue 评论自签机械检查通过。
- 不把远端 CI、Ruleset 或耗时记录伪装成 Story 语义验收。
- 不自动轮询、多任务排队、自动合并或发布。
- 不为兼容旧 Issue 静默猜测含义；旧格式若无法明确归责，应在 Agent 启动前停止并提示迁移。

## Risk

主要风险是把一个入口修复做成复杂工作流语言，或错误地把远端检查当成本地验收替代品。实现应只增加最小的结构化责任字段和确定性对账，不解析自然语言、不扩大 Validator 权限；任何无法唯一归责的要求都应在花费 Builder 时间之前失败。

## User Stories

### US-001: 完成 Issue #319

修复 #207 / PR #318 暴露的入口合同缺口：一个 ready Issue 可以把本地语义验收、项目机械检查、远端交付检查和最终耗时记录混写成同一组 Validator 验收标准。引擎随后只按变更路径选择适用检查，而断网 Validator 又被要求补跑未选中或仅远端可运行的检查，导致 Builder 已完成后才进入永远无法自愈的“无法验证”。

为 ready Issue 增加版本化、机器可读的责任分层与检查要求。任何 Agent 启动前，引擎必须确认每项要求由哪一层负责、对应检查是否存在、当前运行是否有能力取得证据；无法满足时立即拒绝启动，并给出明确缺口。不得从自然语言猜检查名称。

#### Execution Contract

```json
{
  "schemaVersion": 1,
  "storyAcceptance": {
    "evidenceSource": "validator",
    "network": "disabled",
    "criteria": [
      "ready Issue 用版本化字段分别声明 Story 语义、本地检查、远端交付和运行度量，合同变化会使旧运行身份失效",
      "要求放错责任层、检查不存在、当前平台或 Runner 无法取得凭证、真实 Ruleset 不可用时，在任何 Agent 前明确停止",
      "显式本地检查与路径选择取并集且只运行一次，证明绑定当前提交、变化范围、合同和逐项选择原因",
      "Validator 只收到 Story 语义标准与已完成的本地证明，不接收远端条件或运行度量",
      "显式远端检查强制进入当前 Issue PR 的 GitHub 计划，最终可信状态只读取当前提交的检查和 Ruleset",
      "普通 scoped Issue 继续保持唯一分支、唯一 PR、唯一状态评论与相同输入复用"
    ]
  },
  "localChecks": {
    "evidenceSource": "engine",
    "network": "current-host",
    "mode": "scoped",
    "checkIds": []
  },
  "remoteDelivery": {
    "evidenceSource": "github",
    "network": "github-actions",
    "mode": "scoped",
    "checkIds": [
      "dependency-audit"
    ],
    "ruleset": "required"
  },
  "runMetrics": {
    "evidenceSource": "engine-clock",
    "metrics": [
      "ready-to-trusted",
      "active",
      "waiting",
      "continuations"
    ]
  }
}
```

#### Acceptance Criteria

- [ ] ready Issue 用版本化字段分别声明 Story 语义、本地检查、远端交付和运行度量，合同变化会使旧运行身份失效。
- [ ] 要求放错责任层、检查不存在、当前平台或 Runner 无法取得凭证、真实 Ruleset 不可用时，在任何 Agent 前明确停止。
- [ ] 显式本地检查与路径选择取并集且只运行一次，证明绑定当前提交、变化范围、合同和逐项选择原因。
- [ ] Validator 只收到 Story 语义标准与已完成的本地证明，不接收远端条件或运行度量。
- [ ] 显式远端检查强制进入当前 Issue PR 的 GitHub 计划，最终可信状态只读取当前提交的检查和 Ruleset。
- [ ] 普通 scoped Issue 继续保持唯一分支、唯一 PR、唯一状态评论与相同输入复用。

## Delivery Boundary

- 只在分支 `codex/issue-319` 和对应 PR 内交付；不自动合并、不发布。
- Builder 的自述不构成完成；以引擎凭证、最终 Review 和当前 PR 远端总闸为准。
