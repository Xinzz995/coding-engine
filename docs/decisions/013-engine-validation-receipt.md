---
title: 013-engine-validation-receipt
status: active
updated: 2026-07-22
scope: root
---

# 013. 完成判定要求引擎验收凭证

## 背景

builder 与 validator 共享 `state.json`：builder 完成时先写 `passes=true`，validator 通过时保持该值，失败才打回。此前完成判定只检查 `passes || blocked`，无法从持久状态区分“builder 声称完成”和“validator 已正常走完”。ADR-009 用异常轮回写修复了超时/非零退出造成的假绿，但把完整验收台账作为后续防线保留。

## 决策

`state.json` 的每个 story 增加引擎独占布尔字段 `validated`。引擎观察到 validator 启动前 story 已由 builder 置为通过、validator 进程正常结束、结束后 story 仍存在、通过且未 blocked，才原子写 `validated=true`；若 validator 删除整条 story，引擎可恢复状态供下轮重试，但不得把恢复值当作 validator verdict。通过态定义为非 blocked 的 `passes && validated`，blocked 继续独立收敛。

本 ADR 发布时的历史行为是：agent 改写该字段时按阶段前值恢复并留 evidence；validator 未实际完成
的路径回写未验收的 `passes=true`；进程崩溃留下的显式待验收残态在下次启动时回写；旧 state 缺
字段时按历史 `passes` 值归一 `validated`。这些恢复和兼容规则已由下述 ADR-020 取代，不再是后续
实现应继续遵循的现行规则。

以上关于裸布尔凭证、跨轮回写与 legacy 自动置绿的范围只描述本 ADR 发布时的行为。ADR-020
引入可持续核对的结构化凭证后，`validated` 不能脱离当前 HEAD 与 `acceptanceHash` 证明通过；
`acceptanceHash` 精确绑定当前 Story ID 和有序 AC。旧状态缺少结构化凭证时保留实现候选但必须
重新验收。

## 理由与备选

- **选择一位布尔凭证，而非新 IPC**：进程结局、validator 前后 state 与当前 story 都是引擎已有的机械事实，足以区分本轮有没有完整经过 validator。结果文件、nonce 与 stdout 协议会增加新的损坏和兼容面，却不提升对“CLI 错误 exit 0”的判断力。
- **完成判定不再只信 passes**：builder 本来就必须先置 `passes=true`，该字段天然是候选结果而非独立验收证明；凭证把 Developer → Validator 分工固化进状态机。
- **兼容旧 passed 状态（历史裁决）**：本 ADR 发布时沿用旧结论、只对新轮次强制布尔凭证。ADR-020
  已取代该裁决：无法证明的旧结论不得继续显示为当前通过，但其 `passes` 候选可以保留用于
  validation-only，避免无依据地重复实现。
- **不做密码学防伪**：agent 与 engine 同用户、同 workspace；签名密钥仍需落在同权限环境，不能凭空建立强隔离。本决策解决 harness 内的所有权与异常控制流，不宣称抵御恶意本机进程。

被否备选：把 state 全部改为 engine 独占并让两侧 agent 输出结构化 verdict。方向长期更纯，但会同时重写 blocked/仲裁/失败 notes/重试合同，超出这次针对完成判定的最小变更。

## 后果

- `state.json`、status JSON、dashboard API 增加 `validated`；属于兼容新增字段。
- `passes=true, validated=false` 成为可观察的“待验收”态，任何消费端都不得算作通过；ADR-020 使它
  同时承担凭证过期后的稳定 validation-only 状态，不再一律跨轮回写为 `passes=false`。
- “未签发凭证的候选 true 不跨轮保留”是本 ADR 发布时的历史要求，已由 ADR-020 取代。现行出口审计
  只禁止缺少当前结构化凭证的候选被算作通过或进入最终 Review；`passes=true` 可以跨轮保留并进入
  validation-only。仅在这种“凭证过期但实现候选已存在”的纯重验中，机械检查/TDD 明确不通过、
  确定的 TDD 政策违规或合法 Validator failed 才清除候选并沿用既有 retry、升级与 blocked 规则；
  不可验证只撤销验收、保留候选且不增加 retry。普通 Builder 新候选仍沿用 ADR-009、ADR-017 的
  现有异常回写语义。
- 版本随新增公开状态字段与展示语义升到 0.25.0。

## 后续修订

ADR-015 supersede 了“只凭正常退出和 state 前后值签发、暂不引入结构化 verdict”的范围裁决：所有
新 Validator 轮次必须绑定引擎 request，并由引擎消费结构化 claim 后写 verdict 状态。ADR-020
进一步 supersede 裸 `passes && validated` 与 legacy 自动置绿的最终语义：正式通过还必须持有与当前
HEAD 和当前 Story `acceptanceHash` 一致的结构化持久凭证。
