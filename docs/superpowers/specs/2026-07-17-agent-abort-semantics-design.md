---
title: 异常轮语义——回写待复核、每轮留痕不变式、no-op 熔断与 blocked 收敛出口
status: active
updated: 2026-07-17
scope: root
---

# 异常轮语义设计（dogfood findings A-D 吸收轮）

## 背景与问题

2026-07-17 dogfood 真实跑（`docs/superpowers/2026-07-17-dogfood-findings.md`）实证四个缺陷，共同根因：**引擎对 agent 进程异常结局（超时/中断/空转）一律「当轮作废下轮重试」，但作废不回滚产物、不留痕，重试按 state 前进而非按验收完备性前进**。

- **A（最重）**：builder 在超时线前完成实现+置 `passes: true`，被杀后引擎 continue，下轮按 state 跳过该 story——US-004 的 8 条 AC 零复核收官。同族：validator API 中断，复核缺席，builder 自置的 true 幸存。
- **B**：超时轮 continue 在门禁前（`loop.ts:169-172`），iteration 与 gate-run 双缺——`loop.ts:232` 注释声称「轮号跳跃+gate-run 可还原」只对门禁打回轮成立；`validatorRan: true` 语义是「拉起过」非「完成过」。
- **C**：builder 零输出空转轮无检测，门禁（旧基线本来绿）+ validator（强模型）白烧一轮。
- **D**：8 通过 + 1 blocked 收敛时输出「全部 story 已通过」+ exit 0——假绿文案（0.18.1 defer 项实证）。

代码事实（设计前核实）：引擎现状**只识别 builder 的 `timedOut`**；builder 非零退出照常走门禁+验收，validator 的返回值整个被丢弃（`loop.ts:226` `await runAgent(...)` 无接收）。完成判定 `passes || blocked`（`state.ts:89`），story 选择 `!passes && !blocked`（`state.ts:81`）。

## 已拍板决策（2026-07-17 用户裁决）

1. **A 修法 = 方案 X「异常轮回写」**（否 Y「验收台账对账」：完成判定语义变更+新状态载体，超本轮范围，其完整防伪价值留防伪三件套推迟项；否 Z「validator 当轮重试」：不覆盖 builder 侧，需两套机制）。
2. **C = 检测 + 熔断一起做**（并清 ADR-006 挂账的「连续 N 轮非零退出提前终止」议题），`--stall-limit` 缺省 3。
3. **D = 文案分叉 + 退出码 3**，升 minor 版本（0.22.0）+ README 同步。

## 统一语义定义

**agent 结局**（builder/validator 两侧同一判定，机械信号，不解析 agent 输出）：

| 结局 | 判定 |
|---|---|
| `completed` | 进程退出，`!timedOut && exitCode === 0` |
| `timeout` | 引擎 devTimeout/valTimeout 触发（SIGTERM→SIGKILL） |
| `error` | `exitCode !== 0`（含 spawn 失败的 exitCode 1） |

**异常结局** = timeout ∨ error。

**no-op 轮**：builder `completed` 但轮首/轮后 `state.json` 与 `progress.md` **内容级对比**（读文件字符串全等，不 parse）双无变化。

**stall 轮**：no-op ∨ builder 异常结局 ∨ validator 异常结局，仅此三类累计 stall 计数；**非 stall 轮一律将计数清零**（含门禁打回轮与 agentBlocked 跳过轮——两者都有真实 state 写入=有活动；门禁打回另受 MAX_RETRIES=5 的既有打回预算约束，不与熔断预算叠加）。

## 组件设计

### 1. 异常轮回写（applyAbortRollback）

触发：异常结局轮，且本轮当前 story 的 `passes` 从 false→true（轮首 parse 快照 vs 轮后对比，字段级），且轮后未 blocked。

动作：回写 `passes: false`，notes 置机械标记行 `[中断轮待复核] <ISO 时间> <builder|validator> <timeout|exit N>：本轮 passes 置位未经完整验收，已回写；请确认实现后重新走完门禁与验收`。**不涨 retryCount**（中断≠能力不足，不触发 escalation）。

实现约束：
- 与 `applyGateFailure` 共享 notes 保全逻辑（仲裁前缀族 `ARBITRATION_PREFIXES` 行保全、尊重 `prev.blocked`）——**单源复用**，不另写一套；落盘走 `writeFileAtomicSync`（patterns.md 原子写约定）。
- builder 异常轮的回写发生在 continue 之前；validator 异常轮的回写发生在轮末记录之前。
- 轮后 state 读取失败（缺失/损坏）→ 不回写不覆盖（同 `ensureStateFile`/门禁打回的「绝不覆盖可能损坏的文件」语义），仅警告。

### 2. 「每轮一条 iteration」不变式（B）

所有 continue 路径（builder 超时/异常、门禁打回、no-op、agentBlocked 跳过、skipValidator）统一在跳出前写 iteration 记录——**每轮必有一条 iteration** 成为不变式，时间线零空洞。

evidence schema 演进（判别联合加可选字段，0.20 零字节兼容先例；旧字段语义不变）：

```
iteration 记录新增（全部可选）:
  builderOutcome?: 'completed' | 'timeout' | 'error'
  validatorOutcome?: 'completed' | 'timeout' | 'error' | 'skipped'
  noop?: true
  gateRejected?: true          // 门禁打回轮（与 gate-run 记录并存：gate-run 有细节，iteration 有轮语义）
  abortRollback?: { storyId: string }   // 本轮发生了回写
```

配套订正：删除 `loop.ts:232-233` 过时注释；`dogfood-regression.md` 断言 #12 验证点措辞从「轮号跳跃对照门禁历史还原」改为「每轮一条 iteration 直读还原」；report 时间线区补 outcome/noop 标注（旧 evidence 无新字段照常渲染，`validatorRan` 列渲染语义不变）。

### 3. no-op 检测与熔断（C）

- 轮首读 `state.json` 与 `progress.md` 内容快照（字符串）；builder `completed` 后再读对比，双无变化 → 判 no-op → 跳过门禁与 validator（省一次强模型调用）→ 写 iteration（`noop: true`）→ stall++ → 下一轮。
- 熔断：stall 连续计数达 `--stall-limit`（CLI 参数，缺省 3，正整数字面量校验同 `--stale-days` 先例）→ 提前终止，exit 1，横幅说明「连续 N 轮无进展（no-op/超时/异常退出），排查 agent CLI、模型名与网络后重跑」。
- 误判面（接受）：builder 干了活但 state/progress 双未动 → 判 no-op 跳验收——它本来也没声明完成，下轮幂等重试，无害。

### 4. blocked 收敛出口（D）

收敛分支（`loop.ts:250-255`）统计 afterState 中 blocked 的 story：

- M = 0：现文案「全部 story 已通过…」+ exit 0（不变）。
- M > 0：文案「N 个 story 通过，M 个 blocked 待人工处理（US-xxx, …）。处理后重跑引擎收敛剩余项。」+ **exit 3**。

退出码总表（README 同步）：0=全部通过 / 1=跑满未完成或熔断 / 2=workspace 锁占用 / 3=收敛但有 blocked 待人工。

## 已知边界（记入 ADR-009 后果）

- validator 正常完成但 agent CLI 意外非零退出 → 误回写 → 多烧一轮快速确认，幂等无害，evidence 留痕可观察。
- API stalled 但 CLI 以 exit 0 结束 → 漏检（该轮被当 completed）——机械信号的盲区，靠下轮幂等与 /review-loop 人审兜底；若实测频发再评估输出心跳等增强。
- 回写与 agent 写 state 存在竞态窗口（agent 进程已死，窗口实际关闭；异常路径下引擎是唯一写者，锁已保证跨进程互斥）。

## 测试策略

- `loop.test.ts`（现有 fake-agent 架构）：builder 超时置 true 回写+标记（A 主场景）；validator 非零退出回写（A 同族）；异常轮不涨 retryCount 不触发 escalation；回写尊重 blocked/保全仲裁行；no-op 轮跳过门禁与 validator；连续 3 轮 stall 熔断 exit 1；正常轮 stall 清零；门禁打回不计 stall；blocked 收敛 exit 3 + 文案列 story 号；每轮一条 iteration 不变式（含各 continue 路径）。
- `state.test.ts`：`applyAbortRollback` 单测（保全/尊重 blocked/state 损坏不覆盖）。
- `evidence.test.ts`：新可选字段 schema 用例。
- `report` 渲染：outcome 标注 + 旧 evidence（无新字段）兼容渲染。
- 红灯预测纪律（SDD 计划经验）：fake-agent 的超时/退出码模拟需推演引擎真实分支，防 spawn 真 agent；无墙钟采样断言（0.21.0 keepOpen 教训）。

## 兼容性与发版

- `state.json` 无 schema 变更（notes 纯文本、无新字段）——旧 workspace 零迁移。
- evidence 新字段全可选——旧 evidence.jsonl 读取与报告渲染零破坏。
- 退出码 3 为新增对外行为 → 升 **0.22.0**，README 退出码表+`--stall-limit` 参数说明同步（硬约束 5）。
- 新 ADR-009（异常轮语义：机械信号三分、回写而非台账、stall 熔断——含被否方案 Y/Z 与漏检边界）。

## 非目标

- 完整防伪验收台账（方案 Y：防 builder 伪造 true 的结构性防线）——留防伪加固三件套推迟项，等真实需求实证。
- agent 输出流心跳/进度解析——违反「不解析 agent 输出」哲学，仅在漏检边界实测频发时重新评估。
- worktree 并行编排——独立轮次。
