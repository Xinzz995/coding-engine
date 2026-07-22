---
title: "设计：doc-gardening 第一阶段——任务型文档状态收尾"
status: done
updated: 2026-07-06
scope: root
---

# doc-gardening 第一阶段：任务型文档状态收尾

- 日期：2026-07-06
- 作者：Xinzz + Claude
- 前情：0.2.0 spec 将 doc-gardening agent 列为二期非目标；0.7.0 doctor 落地过期**检测**（已挂常态 CI）；frontmatter `status` 体系为预埋钩子。本设计立项「执行者」缺位的第一阶段。

## 背景与实证

本仓库 25 份带状态文档**零份 done、零份 superseded**——「标记过期」约定存在但从未执行。活证据：TS 重写 spec 状态停在「已批准（待落实施计划）」（实际 2026-06-30 已合并交付）；`prd-docs-doctor.md` 仍 active（doctor 0.7.0 早已发布）。另有格式债：早期 spec 用正文「- 状态：」行，后期才用 frontmatter。

## 拍板决策（4 问 + 方案选型）

1. **问题域**：仅文件级状态收尾——改 frontmatter `status`，不动文件路径。物理归档（破坏链接/索引、与 0.2.0「共存靠 status 区分」相抵）、内容级熵 GC（与 compound-docs 修正/去重职责纠缠）、纯检测增强均否。
2. **形态**：并入 /compound-docs 收口步骤——收口点=状态变化点，不新增命令入口（ADR-004 第三入口认知税教训）。独立命令、doctor --fix（破坏只读定位且判定非机械）、引擎环节（判定需语义理解，且引擎只读写 workspace）均否。
3. **判定纪律**：证据判定 + 交付说明报告——证据链可查证的直接置状态并列入「状态变更清单」；证据不足列「待拍板」不动（延续「宁可不写」+ 0.14.4 变更可见化模式）。逐份写前确认（收口卡顿）、全自动含模糊件（违反宁可不写）均否。
4. **PRD 交付后语义**：置 done，需求演进时翻回 active 改后再派生（0.4.0 再派生机制承接）。status 是文档生命周期状态而非执行状态，不构成 ADR-003「执行状态回流 md」；与 plans/README 既有词汇（active/done/superseded）一致。
5. **方案选型**：A——独立新步骤 + README 定义状态词汇 + 历史欠账实施时一次性清理。欠账自愈条款写进 command（本仓库一次性问题变所有目标项目常驻负担）、写作要求加一句顺带核对（无完成判据，no-op）均否。

## 设计

### 1. 架构与职责分工

- **增量路径（长期机制）**：`commands/compound-docs.md` 新增第 6 步「状态收尾」，原「6. 交付说明」顺延为第 7 步。只核对**本轮牵涉**的任务型文档（从步骤 1 已建立的范围出发：prd.json 的 sourcePrd 链条 + 本轮 git log 触碰的 docs 文件），不做全库扫描。
- **存量路径（一次性）**：本仓库 18 份历史欠账（2 份正式 PRD + 8 份 spec + 8 份 plan）由实施计划一次性任务清掉，不写进 command。
- **定位澄清**：对齐稿置 superseded 的第一责任人仍是 prd-generate（0.11.0 条款）；compound-docs 的收尾是收口兜底，非职责转移。
- **不动**：doctor 本轮不加检查项（status 脱节机械信号弱，执行层先落地，检测层等实证需要）；引擎零改动。

### 2. compound-docs 第 6 步与交付说明格式

第 6 步核心为判定证据表：

| 文档类型 | 置何状态 | 证据（缺一即列待拍板，不动） |
|---|---|---|
| 对齐稿 align-*/tech-* | superseded | 对应正式 PRD 已存在且已吸收其内容 |
| 正式 PRD | done | story 全部通过且已合并（state.json / git log 可证）；需求演进时翻回 active，改后再派生 |
| 实现计划 / 设计 spec | done | 对应实现已合并或已发版（git log 可证） |

边界规则三条：

1. **任务型 vs 记录型分界**：ADR、patterns、glossary、architecture 等长期生效的记录型文档不参与收尾，一直 active 属正常。
2. 只改 frontmatter `status`；早期用正文状态行的顺带迁移为标准 frontmatter（title/status/updated/scope）；不移动、不删除、不改正文。
3. 目标项目无对应目录或本轮无任务型文档 → 自然空跑，交付说明写「无状态变更」。

交付说明新增「状态变更清单」节（与 0.14.4 规则变更清单并列）：每行 `<文件> <旧状态> → <新状态>（证据：一句话）`；证据不足的列「待拍板」并注明缺什么证据；无变化写「无状态变更」。

### 3. README 状态词汇与唯一源同步

- `docs/prds/README.md` 补 status 约定：`active`（意图生效中/待实施）/ `done`（本轮意图已交付——story 全通过且合并；需求演进时翻回 active 改后再派生）/ `superseded`（被后继 PRD 取代，注明替代者）；对齐稿被正式 PRD 吸收后置 `superseded`。
- **唯一源连带同步**：`commands/init-docs.md` 的 prds/README「一字不差」占位段同改；实施计划用 grep 验证两处一致（0.13.0 catalog 一致性同类点）。
- plans/README 不动（词汇已有）；specs 不建 README——spec/plan 收尾词汇的正典即 compound-docs 第 6 步证据表（YAGNI）。

### 4. 历史欠账清理、验证与发版

- **一次性清理**：18 份逐份查证据（git log / release 记录）置 done/superseded；早期正文状态行 spec 迁移标准 frontmatter，`updated` 填清理当天（迁移后开始参与 doctor 检查）。
- **验证**：清理后 status 分布出现预期数量 done/superseded；doctor 全绿；typecheck + test 全绿。
- **增量路径验证**挂下轮引擎 dogfood：`docs/dogfood-regression.md` 追加断言——收口交付说明含「状态变更清单」节（或「无状态变更」）。
- **README（用户文档）**：命令表 /compound-docs 一句话描述补「状态收尾」。
- **版本**：minor（0.15.0），面向用户的命令行为新增 + 生成物内容变化，非破坏性；发版走全 CI 化流程（push tag 后停手）。

## 非目标（后续阶段候选）

- 内容级熵 GC（patterns.md 条目 / glossary 词条核对瘦身）——单独立项。
- 物理归档目录。
- doctor「status 脱节」检测项——等执行层跑出实证需要再议。
- 目标项目历史欠账的自愈条款。
