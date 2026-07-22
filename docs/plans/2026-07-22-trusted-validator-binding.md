---
title: "可信 Validator 目标绑定实施计划"
status: done
updated: 2026-07-22
scope: root
---

# 可信 Validator 目标绑定实施计划

**Goal:** 把“Validator 正常退出且 `passes` 仍为 true”收紧为“Validator 对引擎指定的 story、验收标准快照和产物身份提交了新鲜、结构化且自洽的结论”，关闭未验证、错目标和旧结果复用仍可签发 `validated` 的假绿路径。

**Baseline:** `docs/decisions/013-engine-validation-receipt.md` 已让 `validated` 归引擎独占，但 Validator 仍从 `progress.md` 猜测目标并直接改写 verdict 状态；本计划将 supersede ADR-013 中“不引入结构化 verdict 协议”的范围裁决，不改变 `passes && validated && !blocked` 的最终通过语义。

## 完成合同

1. 每次 Validator 调用前，引擎生成一次性 validation request，至少包含协议版本、request ID、story ID、验收标准哈希、验收标准快照、调用前 Git HEAD（不可用时显式记为 unavailable）和唯一结果路径；Validator 不再从 `progress.md` 推断目标。
2. Validator 只写结构化 validation result，不直接改 `state.json`。结果必须逐条覆盖全部 AC，并回显 request ID、story ID、AC hash 与 Git HEAD；缺失、畸形、过期、目标不一致、AC 覆盖不完整、verdict/checks 自相矛盾或 Validator 改写 `state.json` 均 fail closed，不签发凭证。
3. 引擎验证结果协议后独占写入状态：passed 才签发 `validated`；failed 统一推进 retry/blocked/notes；Validator 异常、协议错误与产物身份变化统一回滚 builder 候选通过态。
4. 结构化结果被明确标为 Validator claim，而非不可伪造证明；引擎在 evidence 中分别记录目标绑定、协议判定和凭证签发。Git HEAD 不可用时允许退化为 request + story + AC 绑定，但必须显式留痕，不伪装成完整产物绑定。
5. 旧 workspace/state/evidence 继续可读；本轮临时结果文件位于 `--workspace`，每轮开始清除旧文件，request ID 阻止崩溃残留复用。CLI 参数、现有产物路径与最终通过定义不变。

## 黄金原则对照

| 原则 | 本功能的机械裁决 | 验收证据 |
|---|---|---|
| 1. 完成必须可证伪 | 完成合同 1–5 全部转成 schema 校验和失败路径；“进程退出 0”不再等于验收成功。 | 缺结果、错 story、错 hash、错 commit、漏 AC、矛盾 verdict、状态篡改和合法 pass/fail 回归。 |
| 2. 生成者不能自签 | Builder 只能生成候选 `passes`；Validator 只提供带来源标签的 claim；`validated`、retry、blocked 和最终状态均由引擎按当前 request 签发/写入。结构化结果不是安全签名，信任等级在文档和 evidence 中明示。 | 引擎拒绝 Validator 直接改 state；evidence 区分 `source: validator` claim 与 `source: engine` protocol/receipt。 |
| 3. 自主性必须与风险对称 | 正常 pass/fail 可自动收敛；任何绑定或协议不确定性一律阻断本轮通过并保留可诊断原因，不做静默兼容或猜测。 | 所有未知/畸形输入 fail closed；错误原因可在 evidence/report 中定位并可重试。 |
| 4. 控制面复用工具原生执行面 | 不重新实现 Claude Code/Codex 的代码执行、测试或 Git 能力；引擎只提供 runner-neutral 请求/结果协议与状态机。协议通过 prompt 和 workspace 文件传递，不依赖单一 provider 的 hook。 | Claude/Codex runner 共用同一协议模块和 instruction；runner 参数层无分叉。 |
| 5. 先度量失败与恢复 | 以 validation protocol 状态、失败原因、目标身份、耗时/runner 既有证据为观测面；每个新发现的假绿必须先形成回归。成本仅在 provider 可提供时记录，本功能不伪造 token/cost。 | iteration/validation evidence 能区分 passed、failed、invalid；假绿矩阵加入 dogfood regression。 |

未裁决项：无。五项原则均适用，无需用户先行选择。

## 协议草案

### Validation request（引擎生成并注入 prompt）

```json
{
  "version": 1,
  "requestId": "uuid",
  "storyId": "US-001",
  "acceptanceHash": "sha256:...",
  "acceptanceCriteria": ["..."],
  "gitHead": "40-hex-sha-or-null",
  "resultPath": ".workspace/validation-result.json"
}
```

### Validation result（Validator 原子写入）

```json
{
  "version": 1,
  "requestId": "uuid",
  "storyId": "US-001",
  "acceptanceHash": "sha256:...",
  "gitHead": "40-hex-sha-or-null",
  "verdict": "passed",
  "checks": [
    { "acIndex": 1, "passed": true, "evidence": "command/output or inspected fact" }
  ],
  "summary": "bounded summary"
}
```

约束：`checks` 必须按 1..N 精确覆盖 AC；`passed` 要求全部 check 为 true，`failed` 要求至少一项 false；字符串与文件大小设上限；未知版本拒绝。`gitHead: null` 表示 Git 身份不可用，不得转换成看似可信的字符串。

## 实施任务

### Task 1：协议纯函数与红灯测试

- 新增 request 生成、AC canonical hash、Git HEAD 读取、result 严格解析/绑定校验和固定结果路径模块。
- 覆盖合法 pass/fail、缺失/超限/畸形 JSON、版本错误、字段错配、AC 漏项/重复/越界、verdict 矛盾和 commit 变化。

### Task 2：loop 状态所有权收紧

- 在每轮 Validator 前清理旧结果并生成/注入 request；调用后先核对 agent outcome、state 未被改写、Git HEAD 未变化及 result 合法性。
- 合法 passed 由引擎签发 receipt；合法 failed 由引擎统一写 retry/blocked/notes；invalid/abort 复用回滚与诊断路径。
- 对现有历史 loop fixture 使用显式测试适配器，生产默认不得静默接受旧的“直接改 state”协议；新增严格模式集成用例覆盖真实默认路径。

### Task 3：指令、证据与可观测性

- 重写 Validator instruction：只验证 request 指定目标、逐 AC 产出证据、原子写 result、禁止修改 state/PRD/源码。
- evidence 新增来源清晰的 validation claim/protocol 字段；report/status 至少能暴露 invalid 原因，不把 claim 描述成引擎证明。
- 保持 runner-neutral；Claude/Codex/Cursor 不增加协议分支。

### Task 4：决策与用户文档

- 新增 ADR-015，明确 supersede ADR-013 的结构化协议范围裁决、信任边界、降级语义与被拒方案。
- 同步 architecture、glossary、patterns、README 与 dogfood regression；记录 Git HEAD 只证明提交身份，不能对抗同权限恶意 agent。

### Task 5：验证与提交

- 运行定向测试、`npm run typecheck`、`npm test`、`npm run build` 与 `git diff --check`。
- 对构建产物执行不调用真实 provider 的 deterministic fake-agent smoke：合法 pass 成功签发，缺结果或错绑定不能签发。
- 审查变更是否满足五项黄金原则，修复后以中文 conventional commit 提交；推送、tag 和发布不在本轮默认授权内。

## 执行结果

- 协议、状态所有权、证据、status/report 与指令资产的定向回归共 167 项通过；覆盖合法 pass/fail、missing/stale/mismatch、AC schema、自相矛盾、state mutation 与 agent aborted 等路径。
- `npm run typecheck`、`git diff --check`、`npm test`（27 个文件、576 项）、`npm run build` 与构建产物 `doctor` 全部通过。
- 使用 `dist/cli.js` 和 deterministic fake agent 完成两条端到端冒烟：绑定 passed claim 得到 `passes=true, validated=true`、一条 `source=validator` claim 且临时 result 被消费；缺 result 得到 `missing-result`、候选态回滚、零 claim、退出码 1。
- 五项黄金原则复核无未裁决项：完成条件已机械化；builder/Validator/engine 三层职责分离；不确定性 fail closed；执行能力继续委托原生 runner；失败原因、目标身份、claim 与 receipt 已分来源留痕。
- 可信边界按 ADR-015 保持克制：nonce/hash/Git HEAD 只做新鲜度和身份对账，不能对抗同权限恶意 agent，也不把 Validator claim 表述为签名或 CI 证明。
