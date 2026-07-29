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

agent 改写该字段时按阶段前值恢复并留 evidence。validator 未实际完成的路径回写未验收的 `passes=true`；进程崩溃留下的显式待验收残态在下次启动时回写。旧 state 缺字段时，为保持已发布 workspace 不被全量重验，按历史 `passes` 值归一 `validated`。

## 理由与备选

- **选择一位布尔凭证，而非新 IPC**：进程结局、validator 前后 state 与当前 story 都是引擎已有的机械事实，足以区分本轮有没有完整经过 validator。结果文件、nonce 与 stdout 协议会增加新的损坏和兼容面，却不提升对“CLI 错误 exit 0”的判断力。
- **完成判定不再只信 passes**：builder 本来就必须先置 `passes=true`，该字段天然是候选结果而非独立验收证明；凭证把 Developer → Validator 分工固化进状态机。
- **兼容旧 passed 状态**：无法事后证明旧运行是否验收；强制全部重验会让升级行为不可预测。沿用旧结论、只对 v0.25 之后的新轮次强制凭证，是清晰的版本边界。
- **不做密码学防伪**：agent 与 engine 同用户、同 workspace；签名密钥仍需落在同权限环境，不能凭空建立强隔离。本决策解决 harness 内的所有权与异常控制流，不宣称抵御恶意本机进程。

被否备选：把 state 全部改为 engine 独占并让两侧 agent 输出结构化 verdict。方向长期更纯，但会同时重写 blocked/仲裁/失败 notes/重试合同，超出这次针对完成判定的最小变更。

## 后果

- `state.json`、status JSON、dashboard API 增加 `validated`；属于兼容新增字段。
- `passes=true, validated=false` 成为可观察的短暂“待验收”态，任何消费端都不得算作通过。
- 异常轮、门禁、升级与 blocked 语义保持；实现需审计循环的全部 continue/break/自然耗尽出口，保证未签发凭证的 true 不跨轮泄漏。
- 版本随新增公开状态字段与展示语义升到 0.25.0。

## 后续修订

ADR-015 保留本 ADR 的 `passes && validated && !blocked` 最终语义与 legacy 兼容，但 supersede 了“只凭正常退出和 state 前后值签发、暂不引入结构化 verdict”的范围裁决：所有新 Validator 轮次必须绑定引擎 request，并由引擎消费结构化 claim 后写 verdict 状态。

ADR-020 进一步取代本 ADR 的裸布尔完成语义和 legacy 自动视作已验证：`validated` 继续保留，
但正式通过还必须有与当前 Git HEAD 和当前有序验收标准匹配的结构化凭证；旧状态缺少凭证时
只能重新验证，不能延续为当前绿灯。
