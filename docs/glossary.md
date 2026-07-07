---
title: 领域词汇表
status: active
updated: 2026-07-08
scope: root
---

# 领域词汇表

<!-- 项目的共享语言：每个核心领域概念一个词条，人、文档、代码命名、AI 会话全部统一用这个词。
     词条只回答「这个词指什么」，零实现细节——实现细节进 architecture.md，决策理由进 decisions/。
     「禁用」行列出禁止使用的同义词。新术语与歧义拍板由 /compound-docs 收口沉淀。 -->

## 词条

**story**
prd.json 中的最小交付单元（`US-NNN`），带 acceptanceCriteria，引擎一次迭代只做一个。
禁用：任务、需求项、工单（统一用「story」）

**acceptanceCriteria（验收标准）**
story 的唯一验收依据；validator 逐条核对，源 PRD 与项目文档都不构成验收依据。
禁用：验收条件、完成标准

**打回**
validator 判定某条 acceptanceCriteria 未通过：passes 设回 false、notes 写失败详情、retryCount +1，builder 下轮重试。
禁用：驳回、退回

**blocked**
story 达到最大重试次数后被跳过的状态，留给人工处理；与 passes 一起构成循环完成判定。
禁用：卡死、挂起

**假绿**
validator 报告通过但实际未满足验收标准（共谋、敷衍验证或同义反复测试所致）——review-loop 独立复核存在的理由。
禁用：误报通过、虚假通过

**人审包**
/review-loop 产出的审查交付物：红旗区（如有）+ 三层（改动导读、发现清单、风险聚焦），落盘 `.workspace/review-*.md` 供裁决回填（四态：已修/接受/推迟/驳回）；人审的加速器，不是替代品。
禁用：审查报告

**收口**
一轮循环或功能分支完成后的收尾动作：/review-loop 人审 + 合并 + /compound-docs 把经验分层沉淀回 docs/。
禁用：复盘、总结

**杠铃策略**
人力只花在两端——业务口径对齐（scenario-alignment）与合同级技术决策（technical-alignment），中间「怎么写代码」交给自动化流水线。
禁用：两头重

**对齐稿**
杠铃两端的产出（`align-*.md` 业务对齐稿、`tech-*.md` 技术对齐稿）：prd-generate 的一次性输入材料，被正式 PRD 吸收后置 superseded，不是持续维护的真相源。
禁用：需求稿、草稿

**分层真相源**
md 文档是意图真相（人改），prd.json + state.json 是执行真相（机器改）；冲突以 md 为准再派生，执行状态永不回流 md（ADR-003）。
禁用：单一真相源（本项目真相源分两层，笼统说单一真相源会掩盖方向规则）

**取舍标记**
builder 有意识选择带已知上限的简单实现时就地留下的 `// 取舍: <当前上限>，<升级触发条件>` 注释；收口时被 /compound-docs 汇总成**取舍账本**收账，不是沉淀候选。
禁用：TODO（取舍标记记录的是已做出的决策及其翻案条件，不是待办）

**瘦清单**
各工具插件目录（`.claude-plugin/` 等）里只指回唯一源 `skills/`、`commands/` 的 json 清单，不复制内容——消灭副本漂移。
禁用：插件副本

**workspace**
引擎运行时状态目录（默认 `.workspace/`），prd.json、state.json、progress.md 所在地；引擎只读写这里。
禁用：工作区（泛指编辑器工作区时易混淆，指本概念时统一用「workspace」）

**仲裁标签**
notes 中请求人工裁决的行前缀族：`[需求冲突]`（源文档与验收标准冲突，按验收标准实现后留待人工）与 `[需要人工核实]`（其他必须人工介入的异常，配合 blocked 使用）。所有机械路径（打回、清理、再派生）必须原样保全这些行。
禁用：冲突标记、人工核实标记（统一用「仲裁标签」）

## 关系

- 一个 prd.json 包含多个 story；一个 story 有多条 acceptanceCriteria
- 打回递增 retryCount，达到上限转 blocked；全部 story passes 或 blocked 即循环结束
- 对齐稿被正式 PRD 吸收（superseded），PRD 派生 prd.json（分层真相源的意图→执行方向）
- 收口包含人审（/review-loop 产出人审包）与沉淀（/compound-docs，含取舍账本收账）

## 已解决的歧义

- 2026-07-05 「command」与「skill」曾被混称为「命令/能力/技能」——已拍板：command 是用户敲 `/命令` 显式触发、支持传参的工作流；skill 是模型按语境自动选用的能力。二者是不同原语，分别放 `commands/` 与 `skills/`（README「commands 与 skills 的区别」）。
- 2026-07-05 「沉淀」曾兼指整个收尾流程——已拍板：全流程叫**收口**（人审+合并+沉淀），**沉淀**只指把经验写回 docs/ 的那一步。
