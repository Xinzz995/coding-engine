---
title: "v0.25.4 外部真实仓库 dogfood 记录"
status: done
updated: 2026-07-22
scope: root
---

# v0.25.4 外部真实仓库 dogfood 记录

## 目标与边界

用 npm 正式发布物 `coding-x@0.25.4` 在一个非 fixture、非 coding-x 自身的真实开源仓库中完成 Developer → 机械门禁 → Validator 循环，验证它能否处理既有架构、仓库债务、偶发测试和不完整项目说明。本轮只做 dogfood 与留证，不修改 coding-x 功能，不向外部仓库推送或创建 PR。

目标仓库为 [Xinzz995/cs-hub](https://github.com/Xinzz995/cs-hub)，基线 `d96db40`；需求来自仍开放的 [issue #34](https://github.com/Xinzz995/cs-hub/issues/34) 与 [issue #35](https://github.com/Xinzz995/cs-hub/issues/35)。隔离 clone 位于 `/private/tmp/coding-x-dogfood.iyrR3A/cs-hub`，工作分支为 `codex/dogfood-wechat-notify-fast-path`。

## 基线与运行配置

- 目标仓库标准命令 `uv run python scripts/check.py` 在改动前已有 6 个无关 mypy 错误，均位于 `test/integration/test_billing_commit_deduct_extended.py`。本轮没有顺手修复 billing，而是在源 PRD 中记录基线债务，并使用全仓 Ruff、所涉模块 mypy 与全部 unit tests 作为机械门禁。
- 基线门禁为 Ruff/format 全绿、范围 mypy 全绿、`941 passed`。
- PRD 拆为 3 个 story：body 读取前验签、噪音事件零数据库连接、A/B ticket 三态后按需获取 session。
- 引擎上限 8 轮，实际 5 轮收敛；Builder/Validator 使用 Codex runner 默认模型。运行时目录 `.workspace/` 已先加入 ignore，story 提交没有混入 state/progress/evidence/report。

## 真实链路结果

1. `US-001` 首轮 Builder 完成验签前移且机械门禁全绿，但 Validator 独立构造出 `notify_signature_required=false` 与 `wechat_service=None` 的组合，发现实现错误返回 `false`。第二轮 Builder 先复现再修正，并补回归测试；Validator 通过。
2. `US-002` 完成 FastAPI 依赖图去 DB 化与轻量事件零 session。Builder 门禁为 `952 passed`，但引擎独立机械门禁命中目标仓无关的 QPS 时间窗偶发失败，正确跳过 Validator 并打回。下一轮相同完整单测恢复 `952 passed`，未修改无关 QPS 代码，随后 Validator 通过。
3. `US-003` 把 A/B Redis ticket 三态判定前移到 session 之前，并用 factory 与 context entry 双重计数断言每条路径精确进入 0 或 1 次 session；Builder、机械门禁与 Validator 一轮通过，最终为 `953 passed`。
4. 引擎 exit 0；`status --json`、`state.json` 与 `report.html` 一致为 3/3 `passes=true, validated=true`、0 blocked。循环结束后人工再次运行四组门禁，Ruff、format、范围 mypy 与 `953 passed` 全绿。

外部分支共有 5 个本地提交：1 个 dogfood/PRD 种子提交，`US-001` 两个提交，`US-002` 与 `US-003` 各一个提交。工作树干净，未 push，原仓库未受影响。

## 有效性观察

- **Validator 不是形式复跑。** `US-001` 在 Builder 自带测试和机械门禁均绿时仍被独立组合探针打回，证明双角色在真实业务分支上产生了实际增益。
- **门禁顺序正确。** `US-002` 的偶发失败发生后，Validator 没有被浪费性拉起；候选状态被机械打回，重跑转绿后才恢复验证。
- **边界纪律良好。** Builder 面对无关 QPS 偶发失败时选择原样重跑并拒绝猜测性修改；面对目标仓缺失 `.claude/rules/` 时回退到已读取的根规则，没有扩展需求范围。
- **运行时隔离成立。** `.workspace/` 未进入任何 story commit，最终工作树和 coding-x 主仓在 dogfood 实现阶段均保持可审计。

## 发现与摩擦

### 1. CLI 帮助入口不符合常见预期

`npx --yes coding-x@0.25.4 --help` 稳定退出 1，并输出 `Unknown option '--help'`。这不会影响主链路，但会在首次使用和自动探测时制造不必要摩擦。

后续修复：v0.25.6 增加 `help`、`-h`、`--help` 三个等价入口，在任何 workspace/runner 副作用前退出 0，并用构建产物烟测守卫 npm bin 入口。

### 2. 成功重试后的失败取证不够完整

`evidence.jsonl` 能记录门禁失败的命令、退出码与轮次，但最终报告对 `US-002` 只保留 `uv run pytest test/unit -q（退出码 1）`，没有保留具体失败测试 `test_llm_qps_guard.py::test_over_cap_rejected` 与断言差异。`US-001` 首次 Validator 的完整失败说明也会随 notes 清理而消失，只因下一轮 Builder 主动写入 progress 才留下摘要。当前报告足以证明“曾失败”，不足以独立复盘“为什么失败”。

后续修复：v0.25.7 在失败当轮把门禁 stdout/stderr 尾部写入 gate-run，并在 Validator 正常打回时把 notes 写入 iteration；两类诊断统一限制为 2000 字符，读取端拒绝超限/错误类型，验证报告按转义后的折叠纯文本展示。后续成功重试即使清空当前 notes，失败原因仍留在证据索引中。

### 3. 发布物的离线复盘体验偏脆弱

循环结束后只读执行 `npx --yes coding-x@0.25.4 status ...` 仍尝试访问 npm registry；受限网络下报 `ENOTFOUND`，联网后才成功。问题主要来自带版本 spec 的 npx 入口，但对“使用正式发布物做可重复离线审计”的体验有直接影响。

### 4. 成本与耗时缺少持久化总账

runner 控制台能看到单次 token 统计，例如 `US-003` Builder/Validator 分别显示 115,061 与 41,253 tokens，但这些数据没有进入 evidence、status 或 report，最终无法从工件计算完整运行成本。门禁耗时已有持久化，agent 耗时与 token 仍是观测盲区。

### 5. 目标仓自身噪声会真实消耗迭代

标准检查的既有 mypy 红灯、QPS 偶发测试以及 `CLAUDE.md` 引用但不存在的 `.claude/rules/` 都不是 coding-x correctness 缺陷，却分别要求定制门禁、额外一轮 Builder 与 agent 自行恢复。这正是外部仓 dogfood 相比 fixture 更有价值的部分。

## 人工复核

行为与验收标准均未发现阻断项。唯一非阻塞瑕疵是 `WeChatNotifyService._dispatch_event` 的旧 docstring 仍把 A 首次命中写成 `1`，而实现与 TicketStore 的真实返回已是 `str`；这不影响运行，但说明行为门禁不能替代最终文字审查。

## 裁决

本轮结论是：`coding-x@0.25.4` 已能在外部真实仓库中完成可审计的多轮收敛，Validator 与机械门禁都提供了真实防线；当前没有需要立即追加功能才能继续使用的 correctness 阻断。

前两项摩擦已分别由 v0.25.6 的标准帮助入口与 v0.25.7 的失败诊断快照收口。剩余优先级建议为：先评估 agent token/耗时总账，再改善正式包的离线调用方式。外部代码是否提交上游，交由人工另行决定。
