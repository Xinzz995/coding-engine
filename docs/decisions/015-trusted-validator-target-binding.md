---
title: 015-trusted-validator-target-binding
status: active
updated: 2026-07-22
scope: root
---

# 015. Validator 必须以结构化结果绑定引擎指定目标

## 背景

ADR-013 把 `validated` 收归引擎，消除了 builder 单方面置绿；但签发条件仍是“Validator 进程退出 0，当前 story 的 `passes` 保持 true”。Validator 指令又从 `progress.md` 最后一段反推 story。于是正常退出但没有验证、读错 progress 目标、复用旧输出或只验证另一份 AC 的进程，仍可能得到凭证。进程结局只能证明 CLI 结束，不能证明它验证了哪一个目标。

## 决策

每次 Validator 调用前，引擎生成 v1 validation request，并以运行时合同追加到 runner-neutral prompt。request 含一次性 request ID、当前 story ID、有序 acceptanceCriteria 快照及其 SHA-256、调用前 Git HEAD（不可用时为 `null`）和本轮唯一 resultPath。Validator 不再从 progress 推断目标。

`gitHead:null` 只保留为协议读取和历史诊断形状。ADR-020 生效后，正式运行无法读取非空 Git HEAD
时必须在任何 Agent 或 Review 模型调用前停止，也不得签发结构化持久凭证。

Validator 只能提交结构化 result：回显四项绑定字段，按 1..N 精确覆盖全部 AC，每项含布尔结论和非空有界证据；顶层 verdict 必须与 checks 自洽。结果文件有版本、字段、文本和 64 KiB 上限。引擎在调用前删除旧文件，调用后严格解析，并复核 Git HEAD 未在验证期间变化。缺失、畸形、过期、错 story、错 AC hash、错 Git HEAD、AC 漏项/重复、verdict 矛盾和未知版本全部 fail closed。

`state.json` 的 verdict 状态也改为引擎独占：Validator 不再写 `passes/validated/notes/retryCount/blocked/escalated`。引擎对合法 passed claim 清理瞬时失败、重置 retry 后签发 `validated`；对合法 failed claim 写入失败 notes、推进 retry/blocked，并按既有策略触发 escalation。Validator 若改写 state，引擎恢复调用前快照、记录红旗并拒绝该轮 claim。

解析通过的 result 以 `source=validator` 的 `validation-claim` 进入 append-only evidence；目标、协议状态/错误和 receipt 以 `source=engine` 的 iteration 字段记录。status 与 report 分开呈现二者，不把 agent claim 描述成引擎或 CI 证明。`validation-result.json` 是 workspace 内的瞬时 IPC，消费后清理；崩溃残留即使存在，也因新 request ID 不匹配而不能复用。

## 信任边界

- request ID 是新鲜度 nonce，不是秘密或签名。
- AC hash 证明 result 回显了本轮快照身份，不证明 Validator 的观察内容真实。
- Git HEAD 绑定提交身份；它不单独覆盖未提交或被忽略文件。正常 builder 合同要求先提交 story 再置
  候选态，因此 Git HEAD 是默认产物锚点。ADR-020 后非 Git 正式运行失败关闭；精确 HEAD 干净检出
  与完整执行环境隔离由 Issue #91 独立处理。
- engine、agent 和 evidence 同用户、同 workspace；同权限恶意进程仍可伪造 result/evidence，或在退出前恢复改动。本 ADR 消除正常控制流中的错目标、旧结果与无结果假绿，不宣称提供密码学隔离。

## 理由与备选

- **选择文件协议而非解析 stdout**：三种 runner 都会把自己的日志写到终端，stdout 格式与版本强耦合；workspace 文件能使用同一 schema、大小限制和原子写合同。
- **选择引擎写 verdict state**：如果 Validator 仍直接改 state，结构化 result 只是第二份可漂移真相；状态转移由引擎消费 claim 后统一执行，才能机械检查所有权。
- **选择 Git HEAD 而非全工作树内容哈希**：builder 已承诺先提交，HEAD 成本低且 runner-neutral。全量跟踪/未跟踪文件哈希会读取大文件、密钥和生成物，且仍无法对抗同权限恶意进程；当前收益不足以承担该复杂度。
- **拒绝缺结果时回退 ADR-013 旧判定**：静默兼容会重新打开本 ADR 要关闭的假绿路径。旧 workspace/state/evidence 继续可读，但所有新 Validator 轮次必须走 v1 协议。
- **拒绝本机签名**：密钥与 agent 同权限时不能建立新信任边界，只会制造虚假的安全感。

## 后果

- 本 ADR supersede ADR-013 中“不引入结构化 verdict、Validator 直接写失败状态”的范围裁决。
  ADR-020 又进一步取代裸布尔完成和 legacy 自动置绿：通过 result 必须签发并持续核对结构化持久凭证。
- Validator instruction 与 engine 必须同版本发布；自定义 instruction 即使没有占位符，也会被引擎追加运行时协议，不会静默降级。
- `evidence.jsonl` 增加 `validation-claim` 记录及 iteration 的 `validationProtocol`、`validationTarget`、`validationProtocolError`、`validatorStateMutation` 可选字段；旧记录继续可读。
- status JSON 增加 `recentValidation`；静态报告增加结构化声明、协议错误和 state 改写红旗。
- 合法 failed claim 才消耗 Validator retry 预算并使候选回到 Builder。ADR-020 的 validation-only 中，
  超时、异常或协议不可验证只撤销验收结论、保留已有实现候选；它们仍返回非绿结果，不能进入
  Final Review。
