---
title: 016-agent-invocation-receipt
status: active
updated: 2026-08-07
scope: root
---

# 016. 每次真实 Agent 子进程调用留下有界调用凭证

> 2026-07-31 当前状态：ADR-021 已接入受管 containment。只有 coordinator 确认子进程集合清空且
> delta 合法后，才允许结算 completed/error/timeout 调用凭证；终止无法确认时进入 workspace 隔离，
> 不再追加普通 iteration 或 invocation receipt。下文凭证内容与展示语义仍有效，旧
> `terminateProcessTree` 实现边界只保留历史背景。

## 背景

引擎此前只把 Builder/Validator 的 `completed | timeout | error` 和实际模型路由写入 iteration。终端能看到 provider 诊断，但进程结束后无法恢复原因，也没有耗时。2026-07-22 真实 runner dogfood 中，Codex 完成一个极小 story 的 Builder/Validator 分别显示 29,421 / 16,798 tokens；Claude Code 则在 Builder 阶段返回 `402 Account overdue`。后者被引擎正确判为 error、保持 state 未通过、跳过 Validator 并释放锁，但 evidence/report 只剩“builder 异常退出”，无法从存档判断是余额、认证、网络还是 runner 崩溃。

## 决策

`runAgent` 使用受管监督器拥有的两条独立 stdout/stderr 管道，把输出持续转发到父进程终端，同时滚动保留最近 2000 个 Unicode 字符。两路输出并发排空、各自保持顺序；终端产生背压时，监督器暂停对应上游，等待恢复后再继续。单次调用两路合计最多接受 16 MiB，POSIX 和 Windows 的待消费窗口都固定为 256 KiB，不允许以完整 transcript 占用无界内存。

正常调用只有在根进程结束、两路 EOF、全部已接收输出被消费且 containment 为空后，才返回 `durationMs`、`exitCode` 与有界 `outputTail`。输出超过上限、终端写入失败、超时、取消或父通道断开时，先停止采用结果并终止完整 containment；能够证明进程与输出都已收口时按调用失败结算，无法证明时进入 workspace 隔离。结算后不重复回放已转发内容。

Windows 新监督器只签发 `windows-job-zero-pipes-eof-output-settled-v2`：自然完成时 settled 表示每个输出块已经被下游消费并精确确认；超时、取消或输出失败时，表示已解析块先完成收口，随后由绑定的终止请求明确丢弃剩余窗口，且 Job 为零、两路 EOF。旧 v1 只用于历史故障恢复读取，不能作为当前 Windows 调用的完成证明。

iteration 增加可选 `builderInvocation` / `validatorInvocation`。实际启动过的侧始终记录 duration 与 exitCode；只有 error/timeout 才保存 `diagnosticTail`，completed transcript 不持久化。`recordIteration` 公共底座自动附加两侧凭证，保证异常 continue、no-op、门禁打回和正常终轮等写入点不会漏字段。旧 evidence 缺字段继续可读。

status 的最近实际调用和 report 时间线展示耗时/退出码；异常输出以有界、纯文本转义的诊断呈现。诊断内容只表示“引擎观察到 runner 输出了这些字节”，不是 provider 事实、账单证明或失败分类；它不参与 state、升级或验收裁决。

## 信任与数据边界

- 输出最多保留 2000 字符且只在异常时落盘，降低 prompt/源码片段等成功 transcript 被不必要持久化的风险；workspace 仍是 agent 同权限可写区，不具防伪性。
- 流式输出只用于 Builder/Validator 的 headless 调用；需要完整输出解析的机械检查与 Final Reviewer 继续使用默认受管缓冲模式，不隐式改变其协议。
- 本决策不解析 `tokens used` 等人类可读文案。token/cost 只有在各 runner 提供并验证稳定的结构化事件合同后，才通过 provider adapter 接入；正则匹配终端文本会制造错误精度。
- duration 是本机墙钟观察，包含输出排空和终止后的 containment 收口等待；不是 provider 服务端延迟指标。

## 后果

- `RunResult` 包含 `durationMs` / `outputTail`；fake runner 与平台监督器测试必须覆盖正常、异常、多 MiB 双流、慢消费者、上限、终端失败、timeout/cancel 和父通道断开。
- `evidence.jsonl` iteration 新增两个可选 invocation 对象；读取端拒绝负耗时、超限诊断、未运行侧凭证和 completed+diagnostic 矛盾组合。
- status JSON 的 `recentActual` 增加 outcome/invocation；旧脚本读取既有 model/source/iteration 字段不受影响。
- report 能从存档直接看到 provider/认证/网络类错误的原始尾部，恢复不再依赖当时终端滚屏。
