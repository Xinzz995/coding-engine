---
title: Builder 进度追加与进程结算错误保真
status: done
updated: 2026-08-12
scope: root
---

# Builder 进度追加与进程结算错误保真

## 背景与完成合同

0.34.0 R5 自托管暴露了两个相连但独立的问题：Builder 指令同时要求只追加 `progress.md` 和修改
文件顶部的 `Codebase Patterns`，导致 Agent 遵循后一条时必然违反 `append-only` 安全合同；受管进程
已经以 `group-empty-and-pipes-eof` 证明结算后，workspace 语义检查拒绝改动，上层又把临时调用域误报为
`process-unsettled`，掩盖了真实的 `workspace-integrity-violation`。

本修复完成时必须同时满足：

1. Builder 只能在 `progress.md` 末尾追加一次迭代记录；可复用 pattern 写入该记录的学习项，不再修改
   已有顶部内容。
2. `progress.md` 的机械合同继续保持 `append-only`，不扩大 Agent 写权限。
3. 只有受管监督器已经给出精确的进程结算证明时，临时调用域才可标为已结算；workspace 改动被拒绝时
   仍保留原始安全错误，不再替换成 `process-unsettled`。
4. 未获得结算证明、仍有后代进程或临时域身份变化时继续保留现场并失败关闭。

## 设计裁决

- 删除 Builder 对顶部 `Codebase Patterns` 的写入要求，保留“读取既有模式”和“把新发现写入末尾学习项”。
  后续归纳由收口流程完成，不让 Agent 在委托运行中重写历史前缀。
- 由 operation 私有映射签发不可由调用方构造的进程结算事实，保留 receipt 的 proof 与 drain reason。
  该事实只在校验过 receipt、完成 ACK、确认 supervisor 已死亡且 containment 已为空后出现；调用方不得
  根据错误文字猜测，也不得把不同 drain reason 当成同一种清理许可。
- Agent 临时域收口只消费上述结构化事实。它可以在 workspace 语义拒绝后安全删除提示词临时域，
  但遇到残留后代仍保留。Review 的模型调用、版本核对和 authority snapshot 只在自然结束时补结算；
  timeout、外部终止和残留后代继续保留。所有路径都不得清除 workspace 隔离、改写错误类型或把业务
  改动解释为已接受。

## 黄金原则对照

| 原则                | 适用性与设计裁决                                                 | 验证证据                                       |
| ------------------- | ---------------------------------------------------------------- | ---------------------------------------------- |
| 1. 可证伪完成合同   | 适用。分别断言历史前缀、原始错误和临时域状态。                   | 指令合同测试、真实受管进程失败测试。           |
| 2. 生成方不得自签   | 适用。Agent 不能声明自己的顶部改写合法；安全合同继续机械裁决。   | 非法改写仍使 workspace 隔离。                  |
| 3. 自治与可逆性对称 | 适用且不扩大自治。仅在已有强结算证明时清理临时提示词目录。       | 无结算证明的反例继续保留现场。                 |
| 4. 原生执行优先     | 不新增执行器。修复现有 runner-neutral 指令与本地监督器事实传递。 | Codex/Claude/Cursor 共用同一指令和错误类型。   |
| 5. 假绿与恢复优先   | 适用。R5 的真实失败固化为回归，workspace 拒绝仍是主错误。        | 失败路径先测，成功清理与未知结算反例同时覆盖。 |

## 验证

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test -- --run`
- `npm run build`
- 使用真实受管子进程修改 `progress.md` 历史前缀，确认 workspace 进入隔离、提示词临时域不再误报
  `process-unsettled`，且无进程结算证明时仍保留临时域。

## 发布影响

R5 候选因包含该已知缺陷而作废。修复合并后必须从新的精确 `main` 提交重建候选，并重新完成
coding-engine、Go 和 Python 三仓 Dogfood；不得复用 R5 的本地 Review、CI 或 npm staging 证据。
