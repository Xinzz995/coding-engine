# scenario-alignment 收编设计（杠铃策略第一端：场景对齐）

日期：2026-07-04
状态：已批准（用户拍板「启动收编」）
来源：雷哥《杠铃策略-场景对齐》一文及其 scenario-alignment skill 源码（xinzz-vault/Clippings/scenario-alignment/SKILL.md）；评估结论见本轮会话

## 背景与动机

coding-x 需求侧流水线的入口是 prd-generate（功能描述 → stories+AC），对「口述+bug+页面调整混杂」的杂乱输入没有系统方法；validator 只认 acceptanceCriteria（锁定决策），业务口径错在源头则全链路白跑，harness 无法自救。scenario-alignment 补这一段：杂乱输入 → 可快速拍板的业务 PRD 对齐稿（无技术内容）→ 喂给 prd-generate。

与 0.6.0 收编 compound-harness-docs 同一性质：同源生态、纯 prompt skill、零引擎改动。

## 锁定决策

1. **形态**：第 4 个 skill `skills/scenario-alignment/SKILL.md`，触发词沿用原设计（`align:`、场景对齐、需求对齐、整理业务 PRD）。
2. **定位边界**：输入杂乱/业务口径未定时的**可选前置**，不是必经步骤——工具型小功能（如 doctor/status 这类无角色权限旅程的 PRD）直接走 prd-generate。skill 描述与正文都要写明。
3. **落盘**：`docs/prds/align-<feature-name>.md`（与 PRD 同目录、前缀区分；monorepo 归属规则沿 prd-generate），带 coding-x 统一 frontmatter（title/status/updated/scope）。
4. **真相源边界（ADR-003 护栏）**：对齐稿是 prd-generate 的**一次性输入材料**，不是新的真相源层——正式 PRD 生成后其 frontmatter `status` 置 `superseded`，后续需求变更改 PRD 本身，不回改对齐稿。杜绝「对齐稿↔PRD↔prd.json」三层同步。
5. **下游衔接**：收尾指向改为 prd-generate（原文指向作者未发布的 technical-contract-review，删除）；对应地 prd-generate 增加「输入为对齐稿时跳过澄清问题直接转换」的衔接。
6. **prd-generate 三处增强**（借鉴吸收，独立于是否使用对齐稿都生效）：
   - 澄清问题前置硬规则：能从代码/文档/用户已给材料查证的不问用户；
   - 每题标注「推荐：选项 X」，用户可回「都按推荐」一键拍板；问题超过上限时先问最上游的；
   - 输入是 `align-` 对齐稿时跳过澄清（口径已拍板），stories 从「业务场景/验收口径」派生，不重新发明需求。
7. **保留原 skill 的核心资产**：访谈式对齐（沿决策分支排歧义而非多问）、≤3 问必附推荐答案、提问规则（不问实现方式、不问泛问题）、输出结构（目标/范围/业务场景/验收口径/需要对齐的问题）、输出压缩规则（不复述输入、不写背景铺垫、验收口径只写用户可感知结果）、禁止技术内容。
8. **版本**：0.11.0（skills 新增为面向用户功能，升 minor）。

## 改动清单

| 文件 | 改动 |
|---|---|
| `skills/scenario-alignment/SKILL.md` | 新建（改造版，见锁定决策 2-5、7） |
| `skills/prd-generate/SKILL.md` | 三处增强（锁定决策 6） |
| `README.md` | 6 处：功能概述枚举（L8）、安装后说明（L82）、基本工作流程图（L130 前加可选对齐行）、教程第 1 步步骤列表（L153 前加可选第 0 步）、Skills 表（+1 行）、目录树 skills/（+1 行） |
| `AGENTS.md` | 文档索引 PRD 行补「场景对齐稿（align- 前缀）亦落此处」半句 |

不动：marketplace/plugin 各清单（description 已去枚举）、引擎代码、commands/、templates/。

## 非目标

- 不做杠铃第二端 technical-contract-review（等作者发布或需求出现再评；现有 PRD 的 Technical Considerations 与 /planning 部分覆盖）
- 不改引擎、不进 builder/validator 指令
- 对齐稿不做再派生/状态回流机制（它是一次性材料）

## 验收（dogfood）

用一段拟真杂乱业务需求按新 SKILL.md 走一遍：产出对齐稿结构齐全、落盘路径与 frontmatter 正确、问题≤3 且附推荐、无技术内容混入；再把对齐稿喂 prd-generate，验证跳过澄清直接产出 stories 的衔接成立。
