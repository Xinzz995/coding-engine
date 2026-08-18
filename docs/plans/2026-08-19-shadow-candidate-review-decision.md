---
title: Shadow 候选最终复核决定绑定修复
status: active
updated: 2026-08-19
scope: root
issue: 278
---

# Shadow 候选最终复核决定绑定修复

## 目标

0.37.0 候选在 Python Dogfood 中产生 P1 finding 后，维护者已明确授权修复，但
`workspace record-review-decision` 无法重建绑定了候选身份的 Story 验收环境，因而以
“Story 验收凭证集合已失效”拒绝且零写入。修复必须让裁决入口显式核对当前实际候选，不能
绕过候选身份、复用旧摘要或直接编辑 workspace。

旧候选运行 `32139575460` 及其三仓证明全部作废。修复合并后从新的 `main` 重建 0.37.0，
并重新完成三仓候选证明。

## 非目标

- 不自动批准、修复或关闭 finding。
- 不改变正式 Review 的裁决语义。
- 不把候选身份写进用户可伪造的请求；请求仍只含 finding、动作、操作者和授权证据。
- 不复用旧候选的 Story、Final Review 或三仓评论。

## 可证伪完成合同

| # | 验收标准 | 失败信号 | 验证证据 |
|---|---|---|---|
| 1 | `workspace record-review-decision` 允许显式组合 `--shadow --candidate-evidence <packed.json>` | CLI 在进入候选核对前拒绝合法组合，或允许候选证据脱离 Shadow 使用 | CLI 参数正反测试 |
| 2 | 命令从当前实际 CLI 逐文件重核候选，并把候选身份摘要加入 Story 当前性重建 | 同一候选的 Shadow receipt 仍被判失效，或只信任请求/workspace 摘要 | runtime identity 单测与真实候选复验 |
| 3 | 缺少候选身份、错候选、Shadow/正式模式错配或运行期间身份变化时零决定写入 | 任一错绑输入仍生成 `review-decisions.json` | decision command 失败回归与零写入断言 |
| 4 | 普通正式 Review 裁决保持现有行为 | 正式调用被迫提供候选证据，或正式 receipt 被当成 Shadow | 既有 decision command 全量回归 |
| 5 | CLI、`/review-loop` 和发布手册说明候选 finding 的正确恢复命令 | 用户仍只能按旧命令稳定复现失效 | 文档断言、帮助输出和链接核对 |
| 6 | 新主线重建 0.37.0，三仓证明全部绑定新候选且旧证明不进入 staging | staging 读取旧 run、旧 PR head 或旧证明 | 新 candidate run、三仓唯一证明与 staging 输入对账 |

## 设计裁决

1. CLI 只在 `workspace record-review-decision` 上新增与现有 Shadow 命令相同的显式候选参数组合。
2. 候选证据仍由 CLI 启动时的 `verifyCandidateRuntime` 逐文件核对；裁决请求本身不携带候选摘要。
3. `recordReviewDecision` 接收引擎构造的运行身份，并在每次 Story 当前性观察前后使用同一身份。
4. 保存的 Final Review 是否为 Shadow 必须与调用模式一致；错配立即拒绝。
5. 不改变 Review schema。候选摘要仍通过已有 Story receipt 与 Review 的 Story 集合摘要间接绑定。

## 黄金原则对照

| 原则 | 适用性与裁决 | 验证证据 |
|---|---|---|
| 1. 可证伪完成合同 | 适用。上表把合法、错绑、兼容和真实发布收口分别定义为可观察结果。 | CLI/decision 正反测试、真实 Shadow 裁决、三仓重新取证 |
| 2. 生成方不得自签 | 适用。候选摘要只能来自引擎逐文件核对，用户请求不能自填；正式写入仍由引擎重核 Review、HEAD 和 Story。 | 伪造/缺失候选证据零写入，成功决定绑定当前 Review |
| 3. 自治与可逆性同步 | 不扩大自治范围。命令仍只在用户明确授权后写一个可追溯决定；新增参数反而收紧候选身份边界。 | 未授权不执行；错配、竞态与失败保持零写入或安全回滚 |
| 4. 原生能力优先 | 不适用。问题位于 runner-neutral 的引擎凭证绑定，不涉及新增 Agent、worktree、hooks 或供应商执行能力。 | 核心类型不加入供应商字段；复用现有候选核对器 |
| 5. 假绿与失败恢复 | 适用。先固化本次“Shadow finding 无法授权修复”的失败，再写成功路径；价值指标是从无法恢复变为一次有界命令恢复，同时保持错绑零写入。 | Issue #278、失败 fixture、全量门禁、新候选真实 Dogfood |

## 实施顺序

1. 增加失败回归，证明候选摘要缺失导致同一 Shadow receipt 失效。
2. 接通 CLI 参数、候选逐文件核对和 decision currentness 的运行身份。
3. 覆盖合法、缺失、错候选、模式错配与正式兼容。
4. 同步 CLI 帮助、`commands/review-loop.md`、README 和发布手册。
5. 按 `.coding-x/quality.json` 跑适用门禁，提交并经 PR 合并。
6. 关闭旧候选 PR/证明，从新 `main` 构建候选并重做三仓验证。
