---
title: 016-agent-invocation-receipt
status: active
updated: 2026-07-22
scope: root
---

# 016. 每次真实 Agent 子进程调用留下有界调用凭证

## 背景

引擎此前只把 Builder/Validator 的 `completed | timeout | error` 和实际模型路由写入 iteration。终端能看到 provider 诊断，但进程结束后无法恢复原因，也没有耗时。2026-07-22 真实 runner dogfood 中，Codex 完成一个极小 story 的 Builder/Validator 分别显示 29,421 / 16,798 tokens；Claude Code 则在 Builder 阶段返回 `402 Account overdue`。后者被引擎正确判为 error、保持 state 未通过、跳过 Validator 并释放锁，但 evidence/report 只剩“builder 异常退出”，无法从存档判断是余额、认证、网络还是 runner 崩溃。

## 决策

`runAgent` 将 headless runner 的 stdout/stderr 从直接 inherit 改为 pipe 后实时 tee 回父进程终端，同时滚动保留最近 2000 字符。正常调用在 runner 退出且 pipe 关闭后返回 `durationMs`、`exitCode` 与有界 `outputTail`，避免丢失退出前最后一段输出。超时语义不变：只有 `terminateProcessTree` 确认整棵树退出后才停止计时和结算。

iteration 增加可选 `builderInvocation` / `validatorInvocation`。实际启动过的侧始终记录 duration 与 exitCode；只有 error/timeout 才保存 `diagnosticTail`，completed transcript 不持久化。`recordIteration` 公共底座自动附加两侧凭证，保证异常 continue、no-op、门禁打回和正常终轮等写入点不会漏字段。旧 evidence 缺字段继续可读。

status 的最近实际调用和 report 时间线展示耗时/退出码；异常输出以有界、纯文本转义的诊断呈现。诊断内容只表示“引擎观察到 runner 输出了这些字节”，不是 provider 事实、账单证明或失败分类；它不参与 state、升级或验收裁决。

## 信任与数据边界

- 输出最多保留 2000 字符且只在异常时落盘，降低 prompt/源码片段等成功 transcript 被不必要持久化的风险；workspace 仍是 agent 同权限可写区，不具防伪性。
- 三 runner 的命令参数保持不变；pipe 只作用于 `--print` / `exec` / `-p` 的 headless 模式，终端仍实时可见。
- 本决策不解析 `tokens used` 等人类可读文案。token/cost 只有在各 runner 提供并验证稳定的结构化事件合同后，才通过 provider adapter 接入；正则匹配终端文本会制造错误精度。
- duration 是本机墙钟观察，包含超时后的进程树终止等待；不是 provider 服务端延迟指标。

## 后果

- `RunResult` 新增必填 `durationMs` / `outputTail`；fake runner 与进程树测试必须覆盖正常、402、超长输出和 timeout。
- `evidence.jsonl` iteration 新增两个可选 invocation 对象；读取端拒绝负耗时、超限诊断、未运行侧凭证和 completed+diagnostic 矛盾组合。
- status JSON 的 `recentActual` 增加 outcome/invocation；旧脚本读取既有 model/source/iteration 字段不受影响。
- report 能从存档直接看到 provider/认证/网络类错误的原始尾部，恢复不再依赖当时终端滚屏。
