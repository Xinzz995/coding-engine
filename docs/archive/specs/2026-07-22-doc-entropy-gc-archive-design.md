---
title: "设计：doc-gardening 第二阶段——熵 GC 与物理归档"
status: done
updated: 2026-07-22
scope: root
---

# doc-gardening 第二阶段：熵 GC 与物理归档

- 日期：2026-07-22
- 前情：第一阶段只给任务型文档收尾 `status`，明确把内容级熵 GC 与物理归档留作后续；本设计补齐长期生命周期，并以 coding-x 仓库做首次全量迁移。

## 背景与实证

本仓库当前有 65 份带状态文档，其中 45 份为 `done`；当时 `docs/specs/` 与 `docs/plans/` 合计约 964 KB，绝大多数是已完成 spec/plan。状态标记解决了“能否辨认历史”，但没有解决两个后续问题：

1. 活知识只增不减：`patterns.md`、`glossary.md`、`architecture.md`、`golden-principles.md`、`prompt-writing.md` 会积累失效、重复、过宽或落错层的条目。
2. 已完成任务文档继续与 active 文档同目录：AGENTS 索引与常规检索会把历史计划带回实现上下文，`status` 不能形成物理冷区。

第一阶段的“不移动文件”仍是当时正确边界；本阶段在已有状态证据、doctor 链接检查和交付清单机制之上增加可审计迁移，不回改第一阶段结论。

## 目标

1. `/compound-docs` 日常按本轮范围做增量熵 GC；用户明确要求“全量 GC”时，逐份审计五类活知识文档。
2. 只有用户明确要求物理归档，或看过候选清单后确认，才把完成态文档移入 `docs/archive/`。
3. 冷档案保留 Git 历史、frontmatter 与正文；仓库内导航引用同步改写，不留旧路径 stub。
4. doctor 继续检查冷档案的 frontmatter 与相对链接，但不把历史文档纳入 `updated` 新鲜度。
5. coding-x 首次迁移 46 份既有历史文档，并对五份活知识文档跑一次全量熵 GC。

## 非目标

- 不新增 `/doc-gc`、`/archive-docs` 或 CLI 子命令。
- 不删除历史文档或用 Git 历史代替仓库内冷档案。
- 不自动归档 `docs/decisions/`；superseded/rejected ADR 留在原位维持决策链。
- 不为归档文件制造重定向 stub、符号链接或内容副本。
- 不自动修复仓库外书签，不自动 commit、tag 或发布。
- 不因“看起来啰嗦”删除知识；熵 GC 必须有当前代码、当前文档层级或 ADR 证据。

## 设计决策

### 1. 单入口，两种扫描范围

继续使用 `/compound-docs`：

- **增量模式（默认）**：沿用本轮 sourcePrd、git diff/log、progress 建立的范围，只核对本轮新增、修改或被当前事实影响的活知识条目。
- **全量模式（显式）**：用户明确说“全量 GC”“全量文档整理”或同义请求时，扫描项目中实际存在的 `patterns.md`、`glossary.md`、`architecture.md`、`golden-principles.md`、`prompt-writing.md`；缺失文件自然跳过。

物理归档与扫描范围正交：普通 `/compound-docs` 只列出新出现的归档候选，不移动；用户已明确要求“物理归档”，或展示候选清单后再次确认，才执行移动。这样保留单入口，同时避免一次普通收口静默破坏外部路径。

### 2. 熵 GC 是证据裁决，不是摘要压缩

逐条只能落入六种结果：

| 结果 | 充分证据 |
|---|---|
| 保留 | 当前代码/合同仍依赖，且所在层级正确、无同义副本 |
| 改写 | 核心约束仍成立，但范围、命名或例证已与当前事实脱节 |
| 合并 | 两条表达同一约束；保留信息更完整、层级更正确的一条 |
| 迁位 | 内容仍成立，但属于另一份活知识文档的职责 |
| 删除 | 当前代码/ADR 已明确使其失效，或它完全被另一条覆盖且无独立信息 |
| 待拍板 | 证据不足或删除会改变政策含义；保持原文不动 |

事实优先级沿用 compound-docs：当前代码 > 当前分支 git 事实 > progress > PRD。GC 额外要求：

- 不把历史过程、一次性事故或可由代码直接读出的实现枚举继续留作“规范”。
- `architecture.md` 只保留结构、边界、数据流；`golden-principles.md` 只保留少量机械强制规则；`prompt-writing.md` 只保留会改变 prompt 行为的判据。
- 删除、合并、迁位和语义改写必须进入交付说明的“熵 GC 清单”，逐项给出旧表述、结果与证据；纯保留项只汇总数量。

### 3. 归档资格与排除项

候选必须同时满足：

1. 位于 `docs/` 且不在 `docs/archive/`、`docs/decisions/`；
2. 有完整 frontmatter，`status` 为 `done` 或 `superseded`；
3. 语义上属于 PRD、对齐稿、spec、plan、已结束 dogfood/审计记录等任务型或阶段性文档；
4. `done/superseded` 的证据已经满足第一阶段状态收尾合同。

`active`、README、五类活知识文档、ADR 一律不是自动候选；`rejected` 默认也不归档，保留为防止重复立项的先例。状态可在同一次收口中先完成证据收尾，再进入候选清单。

### 4. 冷档案路径与不可变性

目标路径固定为：

```text
docs/<原相对路径>  →  docs/archive/<原相对路径>
```

例如 `docs/plans/x.md` 移到 `docs/archive/plans/x.md`。不再按年份增加一层：文件名与 frontmatter 已含时间，保留原相对树更容易判定目标且避免同名目录规则分叉。

归档文件继续纳入 Git，frontmatter 与正文不因搬迁改写；搬迁后原则上只允许修复导航链接。首次创建冷档案时：

- 按 `templates/docs/archive-README.md` 创建 `docs/archive/README.md`；
- 在对应根/子项目 `AGENTS.md` 索引加入“历史冷档案”行，说明仅追溯时读取；
- 不由 `/init-docs` 预建空目录或无效索引。

### 5. 引用迁移合同

移动前枚举每个源→目标映射；移动后同步处理：

1. 所有 Markdown 内联相对链接，目标按新位置重新计算；
2. 活文档中承担导航作用的反引号/纯文本仓库路径；
3. AGENTS 索引和 README 导航说明。

历史计划正文里的旧命令、旧 `git add` 清单和“当时修改了某路径”的过程记录不是导航引用，不因归档改写。旧路径不留 stub；迁移报告明确仓库外书签可能需要人工更新。

完成判据：`coding-x doctor` 无断链，且对每个已移动源路径都确认不存在意外残留副本。

### 6. doctor 的冷档案语义

doctor 仍递归枚举整个 `docs/`。对 `docs/archive/` 下带 frontmatter 的 Markdown：

- 继续计入 frontmatter 必填字段检查；
- 继续解析正文相对链接并报告断链；
- 完全跳过 `updated` 格式与 git 日期新鲜度比较；
- 报告新鲜度时显式显示跳过的冷档案数量，避免“检查数变少”不可解释。

判断只按 `docs/archive/` 第一层目录，不用 status 代替路径：归档区是生命周期边界，active 区里误标 done 的文件仍应接受新鲜度检查，促使状态/位置脱节暴露。

### 7. 首次迁移

本仓既有候选固定为 46 份：45 份 `done`，加 1 份非 ADR 的 `superseded` spec。包含两份已完成 PRD 与四份已结束 dogfood/审计记录；两个 superseded ADR、一个 rejected ADR 留在 `docs/decisions/`，active 的 dogfood 回归清单留在原位。

本功能自己的 spec/plan 在尚未合并或发布时保持 `active`，不借本次迁移提前归档。`docs/specs/` 与 `docs/plans/` 各补 README，保证活文档入口在未来清空时仍可被 Git 与 AGENTS 索引保留。

## 交付与版本

这是 `/compound-docs` 行为扩展，并新增面向用户的文档产物路径，版本升至 `0.26.0`；同步 README、三个插件清单、package-lock 与知识库模板。提交前运行 `npm run typecheck`、`npm test`，并构建验证真实 CLI 帮助入口。当前任务不 commit、不打 tag、不发布。
