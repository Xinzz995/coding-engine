---
title: Validator 不可验证结果与 workspace 安全故障分层
status: active
updated: 2026-08-07
scope: root
---

# ADR-023：Validator 不可验证结果与 workspace 安全故障分层

## 背景

Python Monorepo R7 中，Validator 因无界输出以 101 异常退出且没有合法结果。旧循环把这类情况当作
普通未完成返回 1，并在普通实现轮撤销新候选；另一方面，workspace 结算层会把有界但畸形或绑定错误的
`validation-result.json` 当成越权改写，隔离 workspace 并返回 2。这两种行为都把“无法判断实现是否正确”
与其他故障混在一起。

## 决策

Validator 的结局分三层裁决：

1. 受管进程和 workspace 层只证明进程集合已收口，且改动只发生在允许路径和大小边界内。真正越界写入、
   结算证明缺失或安全树异常继续隔离并返回 2。
2. 有界 `validation-result.json` 即使 JSON 畸形、schema 错误或身份错配，也允许完成 workspace 结算；
   引擎协议层随后把它判为不可验证。它不是可采用的 Validator claim，也不能产生 candidate 或凭证。
3. 引擎把 Runner 非零/信号/超时、结果缺失/损坏/错配、HEAD 变化和 Validator 环境无法建立统一判为
   `unverifiable`，立即返回 5。普通实现轮和 validation-only 都保留 `passes=true` 实现候选、撤销验收、
   不增加 retry；下次运行跳过 Developer，重新执行完整检查和 Validator。

只有进程正常结束且合法 `failed` claim 明确证明 AC 不满足时返回 1，并沿用失败、retry 和 blocked 规则；
机械检查确定失败、不收敛和最大轮次也仍返回 1。用户中断保留 130/143。只有正常结束、合法 `passed`
claim、当前 HEAD、完整绑定和安全清理同时成立时才签发凭证。

循环使用一个 runner-neutral 分类函数组合进程结局、协议结论和凭证事实。引擎在 `state.json` 中写入只由
引擎持有的 `validatorUnverifiable` 标记，精确绑定当前 Git HEAD 和有序 AC 摘要；写入有效 failed 状态、
签发 passed 凭证或候选被机械打回时清除。`status` 只用这个持久标记判定当前退出 5；`evidence.jsonl`
仍提供诊断，但它是尽力写入的时间线，不能独自把旧结果延长到新提交或新验收标准。

本决策取代 ADR-020 中“普通 Builder 新候选遇到 Validator 环境或协议不可验证时回滚候选”的局部规则；
明确机械失败时清除候选的规则不变。它不改变 Final Reviewer 的独立权限与失败关闭模型。

## 被否方案

- **所有异常都返回 1**：无法区分代码已知错误和验证环境故障，会触发无价值的重复生成。
- **所有异常都返回 2 并隔离 workspace**：把普通模型输出错误冒充安全边界被破坏，恢复成本过高。
- **异常退出后仍采用已经写出的 passed 结果**：进程没有正常收口，结果可能不完整，存在假绿。
- **普通新候选继续回滚**：候选本身没有被证明错误；`validated=false` 已能机械阻止它成为完成态。

## 后果与验证

- `passes=true, validated=false, validationReceipt=null` 是稳定的待重验候选，不表示通过。
- 当前 `validatorUnverifiable` 让 status JSON 和报告明确区分“普通待验收”与“Validator 无法验证”；HEAD
  或 AC 变化会让旧标记自动失效。
- evidence 保留具体协议错误和 Runner 结局；成功 transcript 不因本决策新增持久化。
- 循环结束先写入“尚未完成安全收口”的保守报告；只有临时验证目录确认删除后才覆盖成最终观察。
  最终清理失败时返回 2、保留隔离租约，不能留下看似已经完成的当轮报告。
- 静态报告由仍持有 workspace 写权限的会话生成，因此在逻辑上不能自证“写完报告之后 owner lease 也已
  安全释放”。报告必须明确这一边界；本次进程的最终退出码以及后续 `doctor/status` 才能反映释放失败。
- 回归必须覆盖缺失、损坏、过大、错绑、exit 101、结果后异常退出和 HEAD 变化均为 5 且无凭证；
  越权改 state 或无法证明 containment 清空仍为 2；合法 failed claim 仍为 1。
- 后续输出背压和宿主上下文隔离分别按 #174 实施计划补齐；未补齐前不能关闭 #174。
