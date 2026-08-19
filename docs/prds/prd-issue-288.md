---
title: "Issue #288: fix: Issue 续跑只刷新相同输入的远端状态"
status: active
updated: 2026-08-19
scope: root
---

# Issue #288: fix: Issue 续跑只刷新相同输入的远端状态

> GitHub Issue: https://github.com/Xinzz995/coding-engine/issues/288
> Issue-Run-ID: sha256:fdc515d7409adf128bd9dc8d48c32f828ad8913c0d87adca76000de23b30d5bc
> Issue-Body-Digest: sha256:3ce4c346de85c80ad7b1a2e7975f1bc92ba7b11a59d9d3cec1e90e49b3b17314
> Ready-At: 2026-08-19T10:18:56Z

## Goals

修复 ready Issue 续跑的重复最终验证：当当前提交、默认分支基线、PR 意图、需求、工程规则、质量契约、验收凭证、审查规则、执行环境和既有最终审查全部仍然一致时，续跑只受控刷新 GitHub 检查、规则和合并状态，不再重跑 Builder、Validator、项目检查或三层最终审查。

真实基线来自 Issue #284 / PR #285：从 ready 到可信 PR 用时 6 小时 20 分 55 秒。仅添加 quality-policy-approved 标签后的最后一次续跑，又重复了约 25 分 30 秒的完整检查。现有 PR #73 只避免重复 Story 验收，其回归测试仍明确允许最终审查再次运行；现有 status 路径已经能安全核对本地审查当前性并刷新远端状态，但 issue run 没有复用它。

## Non-Goals

- 不建立跨提交、跨环境或通用的持久检查缓存。
- 不增加自动轮询、后台任务、队列、多 Issue 并发、自动合并或自动发布。
- 不削弱 Builder、Validator、最终审查或远端规则的既有边界。
- 不处理模型无输出、默认开发超时或 Codex 审计版本升级。

## Risk

主要风险是假复用：把已经过期的本地审查当成当前结论。实现必须复用现有受管 status 当前性核对和远端刷新，而不是新增一套简化判断；任何观测缺失或竞态都失败关闭。改动只影响 Issue 续跑的快速收口，可通过删除该快速路径回退到现有保守重跑行为。

## User Stories

### US-001: 完成 Issue #288

修复 ready Issue 续跑的重复最终验证：当当前提交、默认分支基线、PR 意图、需求、工程规则、质量契约、验收凭证、审查规则、执行环境和既有最终审查全部仍然一致时，续跑只受控刷新 GitHub 检查、规则和合并状态，不再重跑 Builder、Validator、项目检查或三层最终审查。

真实基线来自 Issue #284 / PR #285：从 ready 到可信 PR 用时 6 小时 20 分 55 秒。仅添加 quality-policy-approved 标签后的最后一次续跑，又重复了约 25 分 30 秒的完整检查。现有 PR #73 只避免重复 Story 验收，其回归测试仍明确允许最终审查再次运行；现有 status 路径已经能安全核对本地审查当前性并刷新远端状态，但 issue run 没有复用它。

#### Acceptance Criteria

- [ ] 同一 Issue 再次运行时，若现有正式最终审查对当前全部输入仍有效，机器直接进入受控远端刷新路径，不调用 Builder、Validator、项目质量命令或三层 Reviewer。
- [ ] 审批标签在本次刷新开始前已经增加时，不把它误判为代码或审查输入变化；刷新期间标签再次变化则失败关闭。
- [ ] 远端已就绪时续跑返回可信状态并写回同一 Issue；远端仍等待或失败时如实保持等待状态，不伪造通过。
- [ ] 当前提交、默认分支、PR 标题或正文、需求、工程规则、质量契约、Story 验收凭证、审查规则、Runner 版本、风险判断或人工裁决任一变化时，旧审查不得复用，必须回到正常验证路径或明确停止。
- [ ] 远端刷新继续核对当前 PR、head、base、Ruleset、必需检查、可合并状态和需实时读取的延期事项，并在慢读取后再次核对上下文。
- [ ] Issue 结果记录本次状态刷新耗时和是否复用了既有审查，能够与 #284 最后一次约 25 分 30 秒的重复验证直接比较。
- [ ] 增加确定性回归：复现等待远端、添加审批标签、再次运行、零 Builder/Validator/质量检查/Reviewer 调用；同时覆盖 head、base、PR 意图、规则和刷新期间标签漂移的拒绝路径。
- [ ] 按完整改动范围判定的本地检查和远端必需检查全部通过，最终结论绑定当前 Issue、当前提交和当前 PR。

## Delivery Boundary

- 只在分支 `codex/issue-288` 和对应 PR 内交付；不自动合并、不发布。
- Builder 的自述不构成完成；以引擎凭证、最终 Review 和当前 PR 远端总闸为准。
