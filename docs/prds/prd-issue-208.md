---
title: "Issue #208: 自托管工作负载下 POSIX 进程结算证明的时间窗需要有界诊断"
status: active
updated: 2026-08-21
scope: root
---

# Issue #208: 自托管工作负载下 POSIX 进程结算证明的时间窗需要有界诊断

> GitHub Issue: https://github.com/Xinzz995/coding-engine/issues/208
> Issue-Run-ID: sha256:905b81dc21170986ddb3fee0c3ab34f1de9db4447ba9fde8acebc57006b8d3ce
> Issue-Body-Digest: sha256:4fb132f90fc93edd51ebc0dfc4c9d11d04302ce2bf5f31cfca0ecb5dab38a7b1
> Issue-Execution-Contract-Digest: sha256:a8f390a54457b9a4d0349c654fabc7341bb0d0a50844829d9b21ce8fcb524e06
> Issue-Remote-Check-Mode: scoped
> Issue-Remote-Check-IDs: -
> Ready-At: 2026-08-21T16:47:46Z

## Goals

修复 v0.37.1 自托管 coding-x 时仍会出现的 POSIX 不透明 Runner 偶发结算失败：Codex Builder 已自然以数字退出，外层 launcher 组中的合法测试夹具却未在固定 5 秒内完成自然收尾，当前 helper 随即把它升级为 `process-tree-not-empty` 并永久隔离，导致同一候选两次无法进入 Validator。

保留现有 5 秒快速路径；仅对已经取得自然数字 RESULT 的 POSIX `opaque-runner` 增加第二段有界自然结算窗口，总自然等待不超过 30 秒。第二段期间不得发送 TERM/KILL；只有外层组自然收敛到 launcher、stdout/stderr EOF 且输出确认全部完成，才沿用现有 natural receipt。失败时输出有界的结算诊断。

## Non-Goals

- 不用裸 PID、PPID、PGID 轮询或环境标记证明不透明 Runner 的完整内部命令域。
- 不放宽 timeout、user-interrupt、parent-shutdown、output-failure、自然 signal 或 30 秒后仍有残留的永久 `operation-proof-missing`。
- 不自动恢复已经隔离的旧 workspace，也不复用 #319 的失败凭证。
- 不改变普通 POSIX 项目命令、Windows Job Object、Validator 宿主隔离或 Agent 权限。
- 不靠无限延长 Builder 项目超时掩盖结算缺陷。

## Risk

主要风险是把安全失败关闭误改成宽松放行。实现必须保持同一绝对自然结算期限，只在 Runner 已自然数字退出且可观察 containment/output 正在自然收尾时等待；任何外部终止、signal、身份变化、输出未结算或到期残留都保持现有永久隔离。回退方式是移除第二段默认预算和诊断，不改变磁盘协议版本与既有 receipt 语义。

## User Stories

### US-001: 完成 Issue #208

修复 v0.37.1 自托管 coding-x 时仍会出现的 POSIX 不透明 Runner 偶发结算失败：Codex Builder 已自然以数字退出，外层 launcher 组中的合法测试夹具却未在固定 5 秒内完成自然收尾，当前 helper 随即把它升级为 `process-tree-not-empty` 并永久隔离，导致同一候选两次无法进入 Validator。

保留现有 5 秒快速路径；仅对已经取得自然数字 RESULT 的 POSIX `opaque-runner` 增加第二段有界自然结算窗口，总自然等待不超过 30 秒。第二段期间不得发送 TERM/KILL；只有外层组自然收敛到 launcher、stdout/stderr EOF 且输出确认全部完成，才沿用现有 natural receipt。失败时输出有界的结算诊断。

#### Execution Contract

```json
{
  "schemaVersion": 1,
  "storyAcceptance": {
    "evidenceSource": "validator",
    "network": "disabled",
    "criteria": [
      "POSIX opaque Runner 自然数字退出后，外层 containment 与输出在首段 5 秒之后、总计 30 秒以内自然清空时，调用可以按 natural 完成而不永久隔离，并把全部等待计入调用耗时",
      "第二段等待只适用于自然数字退出；timeout、user-interrupt、parent-shutdown、output-failure、自然 signal 或总窗口结束仍未清空时继续永久 proof-missing，不签 receipt、不启动下一 Agent",
      "总窗口结束仍失败时，错误包含有界诊断：结算预算、最后可观察成员数量、stdout/stderr EOF 与待确认输出计数，不输出无界进程明细",
      "普通 POSIX 项目命令、Windows Job Object 与快速自然退出路径保持原行为",
      "coding-x 自托管完整测试负载能在正式 Codex 运行中完成 Builder 结算并继续到独立 Validator"
    ]
  },
  "localChecks": {
    "evidenceSource": "engine",
    "network": "current-host",
    "mode": "scoped",
    "checkIds": [
      "tests",
      "legacy-compatibility"
    ]
  },
  "remoteDelivery": {
    "evidenceSource": "github",
    "network": "github-actions",
    "mode": "scoped",
    "checkIds": [],
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

- [ ] POSIX opaque Runner 自然数字退出后，外层 containment 与输出在首段 5 秒之后、总计 30 秒以内自然清空时，调用可以按 natural 完成而不永久隔离，并把全部等待计入调用耗时
- [ ] 第二段等待只适用于自然数字退出；timeout、user-interrupt、parent-shutdown、output-failure、自然 signal 或总窗口结束仍未清空时继续永久 proof-missing，不签 receipt、不启动下一 Agent
- [ ] 总窗口结束仍失败时，错误包含有界诊断：结算预算、最后可观察成员数量、stdout/stderr EOF 与待确认输出计数，不输出无界进程明细
- [ ] 普通 POSIX 项目命令、Windows Job Object 与快速自然退出路径保持原行为
- [ ] coding-x 自托管完整测试负载能在正式 Codex 运行中完成 Builder 结算并继续到独立 Validator

## Delivery Boundary

- 只在分支 `codex/issue-208` 和对应 PR 内交付；不自动合并、不发布。
- Builder 的自述不构成完成；以引擎凭证、最终 Review 和当前 PR 远端总闸为准。
