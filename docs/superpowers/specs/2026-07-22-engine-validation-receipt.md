---
title: "引擎验收凭证设计"
status: done
updated: 2026-07-22
scope: root
---

# 引擎验收凭证设计（v0.25.0）

## 问题

builder 按现有合同在实现完成后把 `state.json` 的 `passes` 置为 `true`，validator 通过时不再改回；引擎当前只看 `passes || blocked` 判定收敛。因此 `passes` 同时承担“builder 声称完成”和“validator 已验收”两层含义。v0.22 已能在 validator 超时或异常退出时回写未验收的 `true`，但完成判定本身仍没有一份由引擎签发的“本 story 确实走完 validator”机械凭证。

本轮把两层语义拆开：`passes` 继续是 agent 的当前结果字段；新增 `validated` 作为引擎独占验收凭证。story 只有 `passes && validated` 才算通过，`blocked` 仍是独立收敛态。

## 锁定决策

1. `StoryState` 新增 `validated: boolean`。初始值为 `false`；只有引擎可修改，builder/validator 必须原样保留。
2. 引擎只在同时观察到以下事实后签发 `validated=true`：本轮 current story 在 validator 启动前 `passes=true`、validator 进程结局为 `completed`、validator 结束后该 story 仍存在且 `passes=true`、未 blocked；所有权恢复出来的候选值不得充当 validator 的结束状态。
3. validator 正常打回（`passes=false` 且 retryCount 增加）、超时、异常退出、未安装指令、PRD 快照恢复失败或任何未实际完成 validator 的路径都不得签发凭证。
4. `getCurrentStoryId`、`allStoriesResolved`、status、dashboard 与 report 的“通过”统一使用 `passes && validated`；`passes=true && validated=false` 明示为“待验收”，不得显示全绿或 exit 0。
5. agent 改写 `validated` 时，引擎按阶段前快照恢复并写入 iteration evidence；与 `escalated` 一样是逻辑所有权防线，不声称抵御同权限进程对整个 workspace 的蓄意伪造。
6. 若 validator 未运行而 builder 已置 `passes=true`，引擎在本轮结束前回写 `passes=false`；若进程在两者之间崩溃，下一次启动会对显式 `validated=false` 的 `passes=true` 做同样回写，确保 builder 能重新选中该 story。
7. v0.24 及更早的 state 缺少 `validated`：读取时 `passes=true` 归一为 `validated=true`、`passes=false` 归一为 false，保持已完成 workspace 零重验；一旦 v0.25 自然写 state，字段随整对象落盘补齐。
8. 不新增 agent-result 文件、stdout 标记、随机 nonce、签名或独立验收台账文件。现有进程结局与 state 前后快照已足以解决本轮目标；ADR-009 接受的“agent CLI 错误地 exit 0”盲区保持不变。

## 状态机

| 时点 | passes | validated | 含义 |
|---|---:|---:|---|
| 初始/被打回 | false | false | 待 builder |
| builder 完成、validator 前 | true | false | builder 声称完成，待验收 |
| validator 通过、引擎签发 | true | true | 已通过 |
| validator 打回 | false | false | 待下一轮修复 |
| blocked | 任意 | false | 待人工；以 blocked 收敛 |

有效失败触发 escalation 的规则不变：门禁打回、validator 正常打回、builder no-op；签发凭证本身不改变路由状态。

## 兼容与可观测性

- `state.json` 是向后兼容加字段；旧文件不因只读立即重写。
- evidence iteration 增加可选 `validationReceipt: true` 与 `stateValidationTamper`；旧记录继续可读。
- status JSON 增加 `validated`；人类输出、dashboard 和 report 对待验收态使用非绿色标记。
- README、architecture 与 glossary 明示 `passes` 是 builder 声明、`validated` 是 engine 机械凭证。
- 版本升 minor 到 0.25.0。

## 测试矩阵

- 旧 state 缺字段：passed→validated true，pending→false，读取不写盘。
- builder 单方面写 `passes=true`，validator 缺失/skip/error/timeout：不得 exit 0，落盘不得保留未验收 true。
- validator completed 且保持 true：引擎签发凭证；正常打回不签发并保持既有 retry/escalation 语义。
- builder/validator 删除或翻转 `validated`：恢复、留痕、报告红旗可见；validator 删除整条 story 时不得基于恢复值签发凭证。
- 显式 `passes=true, validated=false` 的崩溃残态：启动回写后继续同 story。
- status/report/dashboard：待验收不计 passed、不显示绿色；旧 workspace 仍按兼容规则显示。
- 全量 typecheck/test/build 与发布入口 smoke。

## 非目标

- 对 evidence.jsonl 做密码学签名或把 workspace 变成 agent 不可写区域。
- 解析 agent 自然语言输出判断是否认真验收。
- 改为 engine 独占 `passes/notes/retryCount/blocked` 全部字段。
- reasoning effort、费用遥测、runner health 或 worktree 并行。
