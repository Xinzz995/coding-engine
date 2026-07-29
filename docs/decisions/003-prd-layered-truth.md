---
title: 003-prd-layered-truth
status: active
updated: 2026-07-22
scope: root
---

# 003. PRD 分层真相源：md 是意图真相，prd.json 是执行真相

## 背景

`.workspace/prd.json` 同时承担两类真相：需求内容（title/description/acceptanceCriteria/priority）与执行状态（passes/notes/retryCount/blocked），运行期由 builder/validator agent 直接回写。`docs/prds/prd-[feature].md`（prd-generate 产出）结构更丰富，但与 prd.json 只有一次性、有损（增强/拆分）、无人审的单向转换（prd-to-json），之后各自漂移：validator 实际执行的验收标准从未被人确认；agent 缺少源 PRD 的背景（Goals/Non-Goals/Design）；需求中途变更没有安全的重派生路径；md 与 json 冲突时 agent 行为未定义（表现为烧完重试后 blocked，根因不可见）。

## 决策

确立分层真相源，以四条定则约束数据流：

1. `docs/prds/prd-[feature].md` 是**意图真相源**：人写人审，需求变更只改它。
2. `.workspace/prd.json` 是**执行真相源**：由源 md 派生（顶层 `sourcePrd` 记录来源），机器与 agent 读写，随运行归档。
3. 冲突以 md 为准**重新派生**解决；agent 遇冲突按 acceptanceCriteria 实现并在 notes 记录 `[需求冲突]`，留人工裁决，不得自行取舍。
4. 执行状态永不回流 md。

实施分两阶段：

- **第一阶段（v0.4.0，随附计划 docs/archive/plans/2026-07-03-prd-layered-truth.md）**：溯源（sourcePrd 字段 + 【溯源】仲裁段）、转换闭环（增强结果回写源 md + 对照表）、稳定 story id、再派生模式（按 id 合并保状态）、builder/validator 提示词对齐。全部为 skills/提示词/轻引擎改动。
- **第二阶段（v0.5.0 已落地，实施计划 docs/archive/plans/2026-07-03-prd-state-separation.md）**：内容与状态分离——passes/notes/retryCount/blocked 迁出到 `.workspace/state.json`（按 story id 键控），prd.json 运行期只读；引擎 join 两文件做 story 选取与完成判定，仪表盘输出合并视图，repair 兼容双文件，旧格式自动迁移。收益：agent 回写不再可能损坏需求内容，再派生天然不丢状态。

## 理由与备选

- 项目立身之本是机械可判定（golden-principles），执行层真相必须结构化；同时人审与上下文需要富文本。两类真相分层各归其位，比强行合一更符合各自消费者。
- 被否备选①（prd.json 唯一真相，即现状）：人改 JSON 体验差、上下文贫瘠、有损转换无人审、需求变更无安全路径。
- 被否备选②（prd-[feature].md 唯一真相）：完成判定退化为解析 prose/checkbox 或 agent 自由心证，退回 raw Ralph 的 vibes 驱动，丢掉本项目对原版 Ralph 的核心增量。
- 被否备选③（引擎直接消费 md）：等于在引擎里内置一个脆弱的 markdown parser，schema 校验、jsonrepair、仪表盘全部复杂化。

## 后果

- prd-to-json 从「只读转换」变为「转换 + 回写 + 对照表」，会修改用户的 `docs/prds/` 文件（仅 User Stories 章节与 frontmatter updated）——面向用户的行为变更，升 v0.4.0 并同步 README。
- story id 成为 md ↔ json 对齐键：一旦分配永不重排/复用（prd-generate、prd-to-json 双侧约束）。
- `Prd` 类型新增可选 `sourcePrd` 字段，旧 prd.json 不受影响（向后兼容）。
- 第二阶段已于 v0.5.0 落地：状态迁出至 `.workspace/state.json`，prd.json 运行期只读，旧格式由引擎启动时自动抽取迁移；agent 写坏需求内容的通道就此关闭（state.json 仍由 `npx coding-x repair` 兜底）。

## 后续修订

ADR-020 将 Validator 的提交与验收摘要绑定纳入 `.workspace/state.json` 的引擎独占状态。
`prd-to-json` 再派生时只能保留原有凭证，不得生成新凭证；有序 acceptanceCriteria 任何变化
都会由引擎对账使旧凭证失效。
