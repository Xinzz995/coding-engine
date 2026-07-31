---
title: 014-trusted-closeout-report
status: active
updated: 2026-07-31
scope: root
---

# 014. 可信收口报告

> 2026-07-31 当前状态：ADR-021 只取代了本文“手动 report 不持锁”和 `prd-to-json` 双 doctor
> 尽力避让的写并发规则。自动 report 借用 run session，手动 report 取得短 session；
> `prd-to-json` 与 `/review-loop` 只生成临时请求，分别交给 `workspace apply-prd` 和
> `workspace record-review-decision` 正式写入。下文报告信任来源、损坏 state 和展示语义仍然有效；
> 与旧写排他有关的段落仅保留 0.25.x 至 0.33.3 的历史背景。

## 背景

引擎已按 ADR-007 在启动时冻结 PRD，并在终轮用 guard 检查、恢复磁盘文件；但自动验证报告随后又从磁盘读取 `prd.json`。一旦最终恢复因权限或目录形状失败，循环裁决使用的是可信快照，报告却会缺失、不可解析，或消费未受信的磁盘内容。另一个风险是 `state.json` 已存在但损坏时，报告沿用缺失文件的 legacy 迁移回退，可能把 PRD 内嵌的历史 `passes=true` 重新渲染为全绿。`report.html` 直接覆盖写也会在进程中断时留下半份产物。

同时，`prd-to-json` 的归档与再派生会改写多份 workspace 文件，却没有在 skill 层避让正在持有 `engine.lock` 的运行实例。

## 决策

自动报告必须消费 loop 最终一次 PRD guard 读取返回的冻结快照，不再重新读取磁盘 `prd.json`，并在报告中标明“引擎启动快照”来源。手动 `coding-x report` 仍读取当前磁盘 PRD，并且不冒充引擎快照；两种来源由报告数据显式区分。

报告把“state 文件缺失”和“state 文件存在但损坏”分成两种语义：缺失时继续兼容旧 workspace，从 PRD 内嵌字段迁移；损坏时 fail-closed，所有 story 一律按未验证初始态渲染，顶部显示红色“状态不可验证”，绝不复活 legacy 通过态。手动命令仍写出可供诊断的红色报告，但返回退出码 1；自动报告仍是 loop 副产物，其失败或损坏告警不改变循环退出码。

v0.25.5 将同一 state 语义扩展到所有展示消费方：`readDisplayState` 成为 report/status/dashboard 的单一入口。state 缺失仍兼容 legacy；文件存在但损坏时三者全部归零。status 人类模式与 stderr 显示修复警告、`--json` 输出 `stateCorrupted: true` 且退出 1；dashboard API 输出同名标志，两套页面显示警告，不再把陈旧内嵌状态渲染为通过。

ADR-020 进一步收紧“state 缺失仍兼容 legacy”的含义：历史 `passes` 和 notes 仍可供离线回看，但
缺少结构化 Validator 凭证时不能恢复为有效通过。report/status/dashboard 必须以当前 Git HEAD 和
当前 Story `acceptanceHash` 调用同一凭证当前性判断；该摘要精确绑定 Story ID 和有序验收标准。
HEAD 不可读、凭证缺失或错绑时统一显示待重验或不可验证。

`report.html` 使用与关键 JSON 相同的同目录 tmp+rename 原子覆盖，保证目标始终是完整旧版或完整新版。report 子命令仍不获取工作区锁：它不修改执行状态，原子覆盖足以避免并发写出半份文件，竞态时接受“最后一份完整报告生效”。

`prd-to-json` 在任何 workspace 写入前运行 `coding-x doctor --workspace ...` 消费工作区锁结论；发现活锁或无法判定时保持零写入，陈旧/损坏锁只交用户确认且 skill 不删除锁。完成只读准备后、首次真实写入前再检查一次。该协议是 skill 层尽力避让，不能消除检查与写入之间的 TOCTOU 窗口，也不替代引擎的 O_EXCL 锁。

## 理由与备选

- **复用 guard 快照而非给报告再建一套校验**：loop 已有唯一可信 PRD 来源；再次读取和比较会制造第二套冻结语义，且无法解决最终恢复失败后的磁盘不可信问题。
- **损坏 state 仍产出红色报告**：完全拒绝写报告会丢掉 progress、evidence、截图与人审留痕等诊断材料；保守渲染加非零退出同时保留证据与机器可判定失败。
- **不让 report 获取锁**：自动报告在 loop 持锁期间生成，若 report 自己重入获取同一锁会自拒；为两种调用路径增加锁转交协议超出副产物价值。原子替换解决完整性，来源标记解决信任语义。
- **不让 skill 自动清锁**：skill 无法证明陈旧判断后没有新实例启动；删锁会破坏 ADR-008 的所有权协议。双次 doctor 只缩小误操作窗口，不宣称事务隔离。

## 后果

- 自动与手动报告可能展示不同 PRD：这是各自信任来源的诚实结果，自动报告的来源行可供人审辨认。
- 损坏 state 的手动 report 从“生成成功即 0”改为“诊断报告写出但退出 1”；正常生成、缺失/不可解析 PRD 的退出码保持不变。
- 损坏 state 的 status 从 legacy 回看改为全部未验证且退出 1；dashboard 同步归零并标警告。state
  文件缺失时仍保留历史字段供回看，但 ADR-020 要求缺少当前结构化凭证的 Story 不得显示为通过。
- report.html 的 tmp 文件遵循 `fs-atomic.ts` 既有命名与清理约定。
- `prd-to-json` 多两次只读 doctor 调用；长时间澄清期间若引擎启动，第二次检查会在首次写入前拦截。
- 原始可信报告收口随 0.25.4 patch 发布；展示面统一与门禁进程树收口作为同族安全修复随 0.25.5 patch 发布。
