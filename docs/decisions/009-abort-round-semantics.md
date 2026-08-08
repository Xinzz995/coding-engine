---
title: 009-abort-round-semantics
status: active
updated: 2026-08-09
scope: root
---

# 009. 异常轮语义（agent 结局机械三分、回写待复核、stall 熔断、blocked 收敛出口）

> 2026-07-31 当前状态：ADR-021 已用统一 session、workspace 写租约和 coordinator 取代本文旧的
> pid-only 锁与局部 `terminateProcessTree` 收口边界。completed/error/timeout 只有在取得与调用类型
> 相符的收口证明且 delta 合法后才结算；POSIX 不透明 AI Runner 已启动后被外部终止、以信号结束或
> 观察到残留进程时，不再凭外层进程组清空进入下一轮，而是永久隔离 workspace。父进程崩溃、终止
> 失败或未完成 mutation 同样保留隔离。下文异常轮状态机仍有效，关于旧锁和旧进程树实现的段落只
> 保留历史背景；当前结算与恢复边界以 ADR-021 为准。

## 背景

2026-07-17 dogfood 真实跑（`docs/archive/dogfood/2026-07-17-dogfood-findings.md`）实证三个引擎缺陷（发现 A/B/C；发现 D 见下文「决策」第 5 点），共同根因：引擎对 agent 进程异常结局（超时/中断/空转）一律「当轮作废、下轮重试」，但作废既不回滚已落盘的产物，也不留痕，重试按 `state.json` 前进而非按验收完备性前进。

- **发现 A（最重）**：builder 在开发超时线前已完成实现并将某 story 的 `passes` 置为 `true`（且已提交），进程随即被 SIGTERM 终止；引擎当轮 continue，下轮按 `state.json` 前进选择下一个 story——该 story 的全部验收标准（US-004 的 8 条 AC）在零复核的情况下收官。同族场景：validator 侧 API 中断，复核缺席，builder 自行置位的 `true` 原样幸存。
- **发现 B**：超时轮的 continue 发生在机械门禁之前，`evidence.jsonl` 当轮既无 `iteration` 记录也无 `gate-run` 记录，时间线上是纯粹的空洞；彼时 `loop.ts` 里一条注释声称「轮号跳跃可对照门禁历史还原打回轮」，但这一还原关系只对门禁打回轮成立，对超时/中断轮不成立——dogfood 断言 #12（`docs/dogfood-regression.md`）因此被判定为「部分成立」。
- **发现 C**：builder 零输出、状态零变化的空转轮无任何检测，机械门禁与 validator（通常是更贵的强模型）照常被拉起执行，白白消耗一轮预算与一次强模型调用。

代码事实（设计前核实，详见 `docs/archive/specs/2026-07-17-agent-abort-semantics-design.md`）：引擎彼时只识别 builder 的 `timedOut`，builder 非零退出仍照常走门禁与验收；validator 的返回值整体被丢弃（`await runAgent(...)` 无接收）。完成判定是 `passes || blocked`，story 选择条件是 `!passes && !blocked`。

## 决策

agent 结局机械三分（builder/validator 两侧同一判定，只看进程退出信号，不解析 agent 输出内容——`src/engine/loop.ts` 的 `outcomeOf`）：

| 结局        | 判定                                       |
| ----------- | ------------------------------------------ |
| `completed` | 进程退出且 `!timedOut && exitCode === 0`   |
| `timeout`   | 引擎侧 dev/val 超时触发（SIGTERM→SIGKILL） |
| `error`     | `exitCode !== 0`（含 spawn 失败）          |

只有在取得与调用类型相符的权威收口证明后，异常结局（`timeout ∨ error`）才触发以下普通轮次机制。POSIX 不透明 Runner 发生 `operation-proof-missing` 时没有形成可结算的普通轮次：只保留安全协议和永久隔离事实，不写普通 `iteration`、不计入 stall，也不进入下一轮。

1. **回写待复核**（`applyAbortRollback`，`src/engine/gate.ts`）：若本轮把当前 story 的 `passes` 从 `false` 翻到 `true` 且未 `blocked`，回写 `passes: false` 并在 notes 追加机械标记行（`ABORT_LINE_PREFIX = '[中断轮待复核]'`），文本自带下轮指令（确认实现后重新走完门禁与验收）；**不涨 `retryCount`**（中断不是能力不足，不该消耗打回预算或触发 escalation）；仲裁标签行（`ARBITRATION_PREFIXES`）保全、`prev.blocked` 原样返回——与 `applyGateFailure` 共享同一套 notes 保全逻辑，不另写一套。state 读取失败（缺失/损坏）时不回写不覆盖，只警告。
2. **「每个已权威结算轮次一条 iteration」不变式**：已取得权威收口证明的提前退出/continue 路径（builder 异常、no-op、门禁打回、agentBlocked 跳过、validator 异常）统一在跳出前写一条 evidence `iteration` 记录，新增字段全部可选（`builderOutcome`/`validatorOutcome`/`noop`/`gateRejected`/`abortRollback`，`src/engine/evidence.ts`）——可结算时间线不再有空洞，发现 B 的还原方式改为「每个已结算轮次一条记录可直读」，不再依赖「轮号跳跃对照门禁历史推断」。`operation-proof-missing` 不在此集合中。
3. **no-op 双无变化判定**：builder `completed` 但轮首/轮后 `state.json` 与 `progress.md`（内容级字符串对比，不 parse）双无变化 → 判 no-op，跳过机械门禁与 validator，省一次强模型调用。
4. **stall 熔断（本 ADR 发布时行为）**：no-op、已权威结算的 builder 异常、已权威结算的 validator 异常三类累计计数，其余轮次（含门禁打回轮、agentBlocked 跳过轮——两者都有真实 state 写入即为有活动）一律清零；达到 `--stall-limit`（`src/cli.ts`，缺省 3，仅 `run` 命令下校验正整数字面量）即提前终止，退出码 1。`operation-proof-missing` 永远不计入 stall。

以上 Validator 异常的回写与 stall 规则是本 ADR 发布时的行为。ADR-023 已对正式结构化 Validator
取代该局部规则：不可验证时保留候选、不增加 retry，并立即返回 5；Developer 与 legacy 测试兼容路径
仍沿用本 ADR。

5. **blocked 收敛出口**：全部 story 收敛（`passes` 或 `blocked`）时，若存在 `blocked` story，输出文案分叉列出具体 story 号并以退出码 3 结束（而非旧版「全部 story 已通过」的假绿文案 + 退出码 0）；`convergedExit` 单一函数同时服务 no-op 快路径与轮末完成判定两个收敛出口，保证两处行为一致。

四条对外可见退出码：`0`=全部通过 / `1`=跑满未收敛或 stall 熔断 / `2`=workspace 锁占用（ADR-008）/ `3`=收敛但有 blocked 待人工（README 同步）。

## 理由与备选

- **被否方案 Y——验收台账**：为 validator 每次真实通过建立独立的可信凭证记录，完成判定改为查台账而非只查 `state.passes`，从结构上防止 builder 自行伪造 `passes: true` 蒙混过关。否决理由：这会改变完成判定的语义并引入新的状态载体，超出本轮「异常轮怎么处理」的范围；其完整防伪价值留给「防伪加固三件套」推迟项，等真实场景（如下方误回写/漏检频发）实证后再评估，避免在没有实测压力前过度设计。
- **被否方案 Z——validator 当轮重试**：validator 遇到异常结局时不 continue 到下一轮，而是同轮立即重试 validator。否决理由：只覆盖 validator 侧，不覆盖 builder 侧同类问题（发现 A 里 builder 超时同样需要处理）；要对称覆盖两侧需要两套机制，而回写方案（已采纳）用同一套逻辑同时覆盖 builder 与 validator 两侧的异常结局。
- **为什么是机械信号三分、不解析 agent 输出**：与既有哲学一致（同源于 ADR-005/007 的「机械门禁不可共谋」立场）——进程退出码与超时是引擎自己观测到的确定性事实，agent 自己声明的「做完了」不可信；对输出内容做心跳/进度解析属于非目标，留给下方漏检边界实测频发后再重新评估。
- **为什么不涨 `retryCount`**：`retryCount` 衡量的是「agent 反复没做对」，中断是环境/时间因素，与能力无关；计入会不当消耗打回预算（`MAX_RETRIES = 5`）甚至触发不必要的模型升级（escalation）。
- **为什么复用 `applyGateFailure` 的仲裁行保全逻辑而非另写一套**：仲裁标签（`[需求冲突]`、`[需要人工核实]`）是「停下等人」的信号，任何回写路径都不能吞掉它；单源复用避免未来再出现第三条回写路径时各写一套、其中一套漏保全。

## 后果

- validator 正常完成但 agent CLI 意外以非零码退出 → 触发误回写，多烧一轮重新走门禁与验收去确认——回写是幂等操作，代价是多一轮而非数据损坏，接受。
- API 中断但 agent CLI 最终以 `exit 0` 结束 → 落在机械信号的盲区，该轮被判定为 `completed`，实质漏检；靠下一轮的幂等重试与 `/review-loop` 人审兜底。若实测中此类漏检频繁出现，需重新评估输出心跳等增强手段（当前明确不做）。
- 回写与 agent 写 state 之间存在理论竞态窗口。本文发布时假设超时会终止整棵 agent 进程树后再让引擎回写；ADR-021 已取代该假设：普通 POSIX 项目命令与 Windows 只有在平台收口证明成立后才把写权交回父进程，POSIX 不透明 AI Runner 已启动后被外部终止则永久 `operation-proof-missing`，不执行本轮回写、不释放 workspace、也不进入下一轮。这个边界避免与未知跨组进程并发写，但不宣称已经杀死它们。
- blocked 置位与异常结局发生在同一轮时，收敛识别推迟到下一轮——异常轮提前 continue 到不了轮末完成判定，需等下一轮 builder 干净退出后才走收敛出口。方向 fail-safe（只推迟收敛、不假收敛），代价是多一轮；`maxIterations` 恰在此轮耗尽时以「跑满」退出码 1 结束而非 3。
- 退出码 3（blocked 收敛）是新增对外行为，升级为 **0.22.0** minor 版本（硬约束 5）；README 的退出码表与 `--stall-limit` 参数说明随本轮同步。以退出码 0 判定「全部完成」的既有 CI 脚本，遇到存在 blocked story 的工作区时会从「误判为 0」变为「诚实收到 3」——这是行为订正，但外部消费方需要感知 3 是新增语义。
- `state.json` 无 schema 变更（notes 仍是纯文本，无新增字段），旧版 workspace 零迁移；evidence 新增字段全部可选，旧 `evidence.jsonl` 与旧版报告渲染零破坏。
