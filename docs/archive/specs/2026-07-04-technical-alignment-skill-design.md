---
title: "technical-alignment 原创设计（杠铃策略第二端：技术对齐）"
status: done
updated: 2026-07-06
scope: root
---

# technical-alignment 原创设计（杠铃策略第二端：技术对齐）

日期：2026-07-04
来源：雷哥《杠铃策略-场景对齐》一文对第二端的定义（「用户行为最终如何持久化？表、Redis、OSS、外部接口、权限系统、状态机和兼容策略怎么承接？」）；作者的 technical-contract-review 未发布，本 skill 为 coding-x 原创设计，名字遵用户指定 technical-alignment（与第一端对仗）

## 背景与动机

杠铃策略把人审时间集中在两端：业务口径（scenario-alignment，v0.11.0 已收编）与关键技术合同（本 skill），中间「怎么写代码」交给 harness。coding-x 现状：PRD 的 Technical Considerations 段太轻（几行提示），/planning 又太重（完整实现计划、偏人类开发者）；「改起来贵」的技术决策（持久化结构、对外接口、状态机、迁移策略）没有专门的人审产物，常被 story 拆分默默裹挟通过。

## 锁定决策

1. **定位**：只对齐**合同级**技术决策——改起来贵的少数决策，产出供人快速拍板的技术对齐稿。实现细节（函数拆分、内部结构、代码组织、任务顺序）一律不进合同，交给 builder（阶梯自查 + AGENTS.md 约束）。
2. **合同判定三问**（进合同的门槛，任一为是才进）：影响存量数据吗？被多方依赖或公开后难收回吗（对外接口/文件格式/CLI 契约）？错了要连锅端重做吗（状态机/权限模型）？全否 → 不进合同，builder 自行决定。
3. **流水线位置**：业务口径确定后（对齐稿或清晰需求）、prd-generate 之前。依据：prd-to-json 的 story 排序规则（schema→backend→UI）本就要求技术结构先于 story 拆分；文章「两端清楚后，自动化 coding 才有稳定输入」。
4. **可验证陈述（coding-x 特色，超出原文）**：每条合同写成后续 PRD acceptanceCriteria 可直接引用/检验的陈述（例：「报告记录只追加、永不覆盖」「导出权限判定在服务端」），使合同能一路传导到 validator 与 /review-loop。
5. **粒度边界**：允许 schema 级描述（表/字段/类型/默认值、接口的入参出参语义、状态与流转图），禁止实现代码、伪代码、函数签名、组件结构。
6. **不可逆项清单**：合同稿单列「不可逆项」（数据迁移、公开接口、外部依赖引入），提示人这里是最贵的拍板。
7. **拍板问题**：沿用第一端纪律——最多 1-3 个、必附推荐；能从代码/文档查证的不问。
8. **产物与生命周期**：`docs/prds/tech-<feature-name>.md`（统一 frontmatter；monorepo 归属规则同 PRD）；一次性输入材料，被正式 PRD 吸收后置 `superseded`（ADR-003 护栏）。长期技术事实的沉淀是 /compound-docs → architecture.md 的职责，不归合同稿。
9. **与 /planning 分工**：共存不替代——planning 产完整实现计划（任务步骤，人类开发者向）；technical-alignment 只产合同（AI 流水线的稳定输入）。
10. **触发词**：`tech:`、「技术对齐」、「技术合同」。
11. **可选前置**：与第一端同理——无合同级决策的小功能（纯 UI 调整、无持久化/接口/状态变化）直接 prd-generate。
12. **版本**：0.12.0。

## 改动清单

| 文件 | 改动 |
|---|---|
| `skills/technical-alignment/SKILL.md` | 新建（原创，见锁定决策 1-7、10-11） |
| `skills/scenario-alignment/SKILL.md` | 「保存与下一步」加分流：涉及合同级决策时先 technical-alignment 再 prd-generate |
| `skills/prd-generate/SKILL.md` | 加 tech- 合同稿消费规则：Technical Considerations 从合同吸收、story 排序参照合同的数据/边界结构、AC 引用合同的可验证陈述、不推翻已拍板合同、生成后置 superseded |
| `README.md` | 概述枚举、流程图（对齐行扩为两端）、教程第 1 步、Skills 表、目录树 |
| `AGENTS.md` | 文档索引 PRD 行补 tech- 前缀 |

不动：引擎代码、commands/、templates/、各插件清单。

## 非目标

- 不做合同的机械校验器（合同↔代码一致性检查是潜在 doctor 二期方向，本轮不做）
- 不改引擎、不进 builder/validator 指令
- 不替代 /planning
- 合同稿不做再派生/状态回流（一次性材料）

## 验收（dogfood）

接力 0.11.0 的学习报告 fixture（其对齐稿含状态机「发布」、存储改造「覆盖→历史」、权限承接、PDF 导出——全是合同级素材）：子 agent（新会话）按 SKILL.md 产技术对齐稿，验证：查证现有技术事实（upsertReport 覆盖语义等）、合同条目为可验证陈述、不可逆项标出、≤3 问附推荐、无实现步骤/代码混入；拍板后把对齐稿+合同稿一起喂 prd-generate，验证三方衔接（Technical Considerations 吸收合同、story 排序遵合同、两稿均置 superseded）。
