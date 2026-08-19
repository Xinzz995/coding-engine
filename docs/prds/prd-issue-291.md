---
title: "Issue #291: POSIX 安全结束后的有界父进程收口"
status: active
updated: 2026-08-20
scope: root
---

# Issue #291: POSIX 安全结束后的有界父进程收口

> GitHub Issue: https://github.com/Xinzz995/coding-engine/issues/291

## Goals

消除 POSIX 受管命令已经安装严格绑定的自然结束证明、目标进程组和输出管道也已清空，但父进程因结束事件未完成而继续等待项目命令完整超时的长尾。

真实现场来自 Issue #288 的两次恢复档案：第一份结束证明在 `2026-08-19T16:55:02.949Z` 落盘，父运行直到 `17:22:20Z` 才被恢复；第二份在 `17:32:56.340Z` 落盘，直到 `18:10:57Z` 才恢复。两份证明都绑定当次 owner、operation、baseline、containment、helper 和 supervisor identity，且 `drainReason=natural`。

父进程仍拥有当前租约时，如果 IPC 的 DRAINED 引用未到达，但同一 operation 的 canonical drained receipt 已安装，应把该文件仅作为触发源，经既有严格校验重建同一 DRAINED 引用并继续 ACK、精确死亡、进程组清空和原子 settlement。磁盘证明不能补造缺失的根命令结果：RESULT 已观察时可保留原结论；RESULT 缺失时只允许安全结算 operation，并把本次调用明确判为不可验证。

## Non-Goals

- 不缩短所有项目命令或 Agent 的业务超时来掩盖问题。
- 不接受缺 receipt、错 operation、错摘要、错 helper、篡改或不稳定文件。
- 不用 receipt 推断其中没有记录的根命令退出码。
- 不改变 Windows Job Object 的正常握手。
- 不放宽 POSIX opaque Runner 外部终止后的永久隔离规则。

## Risk

最大风险是把“磁盘上出现了一个文件”误当成完整结论。文件存在只能触发既有受管校验；ACK 和 settlement 仍要求当前 owner/operation/安全字节完全一致、supervisor 精确退出且 containment 为空。若语义 RESULT 缺失，安全层可以证明没有活跃写者，但产品层不能宣称命令成功。

## 黄金原则逐项对照

1. **可证伪完成合同**：成功重放、RESULT 缺失、篡改/跨 operation、正常握手和重复真实短命令分别有独立断言与时间上限。
2. **生成方不得自签**：只接受固定 supervisor 已原子安装且由 operation 现有校验链回读的 receipt；Agent 输出和普通文件存在性不签发通过。
3. **自治与可逆性对称**：不扩大命令权限；证据完整时只完成原握手，语义不完整时失败，删除磁盘重放分支即可恢复旧的保守隔离行为。
4. **原生执行优先**：这是 coding-x 自有租约和进程监督控制面，Runner 原生能力不能替代；实现保持平台适配层内，不改变 runner-neutral 调用合同。
5. **以假绿率和恢复衡量**：把 #288 两次真实长尾固化为确定性事件丢失回归；目标是结束证明出现后在 ACK 预算内返回，且任何语义缺口都不产生绿色结果。

## User Stories

### US-001: 有界重放已安装的 POSIX 结束证明

#### Acceptance Criteria

- [ ] 父进程已观察 STARTED 与 RESULT、但 DRAINED 事件被确定性丢弃时，发现 canonical receipt 后使用既有绑定校验完成 ACK、supervisor 精确退出、进程组清空和原子 settlement；保留真实退出码，测试在短 ACK 预算内结束。
- [ ] RESULT 与 DRAINED 都被丢弃但 canonical receipt 有效时，operation 仍安全 settlement、workspace 可继续关闭或复用，但本次调用明确返回不可验证，不得变成 completed。
- [ ] receipt 缺失、内容篡改、跨 operation、摘要不匹配、文件不稳定或 containment/supervisor 最终事实不成立时失败关闭，不发送可伪造成功的 ACK，不签发正常结果。
- [ ] 正常 DRAINED 路径继续使用真实 IPC 事件，输出背压、终止、never-started 和 opaque Runner 现有断言不退化。
- [ ] 增加真实短命令重复回归，证明连续调用不会留下 active operation、supervisor 或目标进程组，也不会等待业务命令完整超时。
- [ ] ADR 与工作区安全规格明确：DRAINED IPC 只是已安装 receipt 的引用；当前 owner 可重建同一严格引用，但 receipt 不携带的 RESULT 不能被推断。
- [ ] 按完整改动范围判定的本地检查和远端必需检查全部通过，最终结论绑定 #291 的 PR 最新提交。

## Delivery Boundary

- 只在 `codex/issue-291` 和对应 PR 交付；不自动发布。
- 受保护的 workspace-safety 路径必须使用独立、限时政策例外，并由 owner 在 PR 上明确批准。
