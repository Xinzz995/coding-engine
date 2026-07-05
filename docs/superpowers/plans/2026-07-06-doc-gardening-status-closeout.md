---
title: "实施计划：doc-gardening 第一阶段——任务型文档状态收尾"
status: active
updated: 2026-07-06
scope: root
---

# doc-gardening 状态收尾 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 /compound-docs 加「状态收尾」步骤（任务型文档退役标记），并一次性清掉本仓库 18 份历史状态欠账。

**Architecture:** 纯 prompt/文档改动，引擎零代码。增量路径=compound-docs 新第 6 步（原 6 顺延 7）；存量路径=按映射表逐份置 done；词汇真相源落 prds/README 并与 init-docs 占位段唯一源同步。

**Tech Stack:** Markdown（commands/、docs/）；验证靠 grep 断言 + `npm run dev -- doctor` + Vitest 回归。

**Spec:** `docs/superpowers/specs/2026-07-06-doc-gardening-status-closeout-design.md`

## Global Constraints

- 提交说明必须中文，conventional 前缀（feat:/docs:/release:）保留英文。
- 每个任务提交前 `npm run typecheck` 与 `npm test` 必须通过（本轮均为文档改动，此为回归保障）。
- 发版到 `git push --follow-tags` 为止停手——npm publish 与 GitHub Release 归 tag 触发的 CI。
- 不修改任何 `src/`、`assets/`、`build/` 文件。
- 编辑均为「一字不差」替换：old 文本以当前文件实际内容为准，不符即 BLOCKED 如实报告。

---

### Task 1: compound-docs.md 新增第 6 步「状态收尾」，交付说明顺延为第 7 步

**Files:**
- Modify: `commands/compound-docs.md`

**Interfaces:**
- Produces: 「状态变更清单」「待拍板」「无状态变更」三个交付说明用语（Task 4 的回归断言引用「状态变更清单」「无状态变更」二词，须逐字一致）。

- [ ] **Step 1: 在「### 6. 交付说明」标题前插入新第 6 步**

用 Edit 将：

```markdown
### 6. 交付说明
```

替换为：

```markdown
### 6. 状态收尾（任务型文档退役标记）

沉淀写入后，核对**本轮牵涉**的任务型文档（正式 PRD、实现计划、设计 spec、对齐稿——有完成态的文档）的 frontmatter `status` 是否与现实脱节。范围来自第 1 步已建立的证据：prd.json 的 `sourcePrd` 链条与本轮 git log 触碰的文档，不做全库扫描。**记录型文档**（ADR、patterns、glossary、architecture——长期生效的知识）不参与收尾，一直 active 属正常。

逐份按证据判定，证据不足的列「待拍板」不动：

| 文档类型 | 置何状态 | 证据（缺一即待拍板） |
|---|---|---|
| 对齐稿 `align-*`/`tech-*` | superseded | 对应正式 PRD 已存在且已吸收其内容（prd-generate 漏做时的兜底） |
| 正式 PRD | done | story 全部通过且已合并（state.json / git log 可证）；需求演进时翻回 active，改后再派生 |
| 实现计划 / 设计 spec | done | 对应实现已合并或已发版（git log 可证） |

只改 frontmatter `status`；早期用正文状态行的顺带迁移为标准 frontmatter（title/status/updated/scope，正文状态行随迁移删除）；不移动文件、不删除文件、不改动其余正文。本轮无任务型文档或目标项目无此类目录时本步空跑。

### 7. 交付说明
```

- [ ] **Step 2: 交付说明节内插入「状态变更清单」段（置于取舍账本段之前）**

用 Edit 将：

```markdown
交付说明最后附「取舍账本」：
```

替换为：

```markdown
交付说明附「状态变更清单」：每行 `<文件> <旧状态> → <新状态>（证据：<一句话>）`；证据不足未动的列「待拍板」并注明缺什么证据；本轮无任务型文档变化时写「无状态变更」。

交付说明最后附「取舍账本」：
```

- [ ] **Step 3: 验证结构**

Run: `grep -n "^### " commands/compound-docs.md`
Expected: 步骤标题依次为 1 建立范围 / 2 交叉取证 / 3 提炼 / 4 落位 / 5 写入 / 6 状态收尾 / 7 交付说明（共 7 个 `###` 步骤标题，无重复编号）。

Run: `grep -c "状态变更清单" commands/compound-docs.md`
Expected: `1`

- [ ] **Step 4: 回归验证**

Run: `npm run typecheck && npm test`
Expected: 均通过（174 tests）。

- [ ] **Step 5: Commit**

```bash
git add commands/compound-docs.md
git commit -m "feat: compound-docs 新增第 6 步状态收尾——按证据表核对本轮任务型文档（PRD/计划/spec 置 done、对齐稿 superseded），证据不足列待拍板；交付说明增状态变更清单节"
```

---

### Task 2: prds/README 补 status 约定，并与 init-docs 占位段唯一源同步

**Files:**
- Modify: `docs/prds/README.md`
- Modify: `commands/init-docs.md`

**Interfaces:**
- Produces: PRD status 词汇正典（active/done/superseded 语义 + 对齐稿条款）。Task 3 按此词汇置状态。

- [ ] **Step 1: 重写 docs/prds/README.md 为以下全文（Write 覆盖）**

```markdown
# PRD

`prd-generate` skill 的产出目录，文件名 `prd-[feature-name].md`。

status 约定：`active`（意图生效中/待实施）/ `done`（本轮意图已交付——story 全部通过且已合并；需求演进时翻回 active，修改后再派生）/ `superseded`（被后继 PRD 取代，注明替代者）。对齐稿（`align-*`/`tech-*`）被正式 PRD 吸收后置 `superseded`。
```

- [ ] **Step 2: 同步 init-docs.md 的 prds/README 占位段**

在 `commands/init-docs.md` 中找到占位段（`` `docs/prds/README.md`： `` 之后的代码块）：

````markdown
```markdown
# PRD

`prd-generate` skill 的产出目录，文件名 `prd-[feature-name].md`。
```
````

将代码块内内容替换为与 Step 1 相同的全文（保持外层 ``` 围栏不变）。

- [ ] **Step 3: 两处一致性验证**

Run: `grep -c "status 约定：\`active\`（意图生效中/待实施）" docs/prds/README.md commands/init-docs.md`
Expected: 两文件各命中 `1`。

- [ ] **Step 4: 回归验证**

Run: `npm run typecheck && npm test`
Expected: 均通过。

- [ ] **Step 5: Commit**

```bash
git add docs/prds/README.md commands/init-docs.md
git commit -m "feat: prds/README 补 PRD status 约定（done=意图已交付演进时翻回、对齐稿吸收后 superseded），init-docs 占位段唯一源同步"
```

---

### Task 3: 历史欠账一次性清理（18 份置 done + frontmatter 统一）

**Files:**
- Modify: `docs/prds/prd-docs-doctor.md`、`docs/prds/prd-workspace-status.md`
- Modify: `docs/superpowers/specs/` 下 8 份（见映射表；**不含** 2026-07-06 本轮 spec）
- Modify: `docs/superpowers/plans/` 下 8 份（见映射表；**不含**本计划文件自身——它在本轮执行中保持 active，由发版后收口置 done）

**Interfaces:**
- Consumes: Task 2 的 status 词汇。

**统一操作规范（每份文件按现状三选一）：**

1. 已有标准 frontmatter → `status:` 值改为 `done`，`updated:` 刷为 `2026-07-06`，其余字段不动。
2. 无 frontmatter，或有 frontmatter 但 `status` 缺失/为模板枚举串 → 在文件最顶补齐/修正为标准 frontmatter：

```markdown
---
title: "<正文一级标题文字，去掉「设计文档：」「实施计划：」类前缀可保留原样>"
status: done
updated: 2026-07-06
scope: root
---
```

3. 正文中的旧状态行（`- 状态：已批准` 等）整行删除（信息已入 frontmatter）；**其余正文一字不动**。

**映射表（18 份，全部置 done；证据供 commit message 与人工抽查）：**

| 文件 | 现状 | 证据 |
|---|---|---|
| specs/2026-06-30-coding-x-plugin-ts-rewrite-design.md | 正文状态行，无 frontmatter | PR #1（38f1e16）已合并，npm 0.1.x 已发布 |
| specs/2026-07-02-docs-knowledge-base-design.md | status 为模板枚举串 | v0.2.0 已发布 |
| specs/2026-07-03-compound-docs-command-design.md | 无状态标记 | v0.6.0 已发布 |
| specs/2026-07-04-builder-anti-overengineering-design.md | 正文状态行 | v0.8.0 已发布 |
| specs/2026-07-04-review-loop-command-design.md | 正文状态行 | v0.9.0 已发布 |
| specs/2026-07-04-scenario-alignment-skill-design.md | 无状态标记 | v0.11.0 已发布 |
| specs/2026-07-04-technical-alignment-skill-design.md | 无状态标记 | v0.12.0 已发布 |
| specs/2026-07-05-quality-gate-design.md | 无状态标记 | v0.14.0 已发布 |
| plans/2026-06-30-coding-x-plugin-ts-rewrite.md | 无 frontmatter status | 同上 PR #1 |
| plans/2026-07-02-docs-knowledge-base.md | status: active | v0.2.0 |
| plans/2026-07-03-compound-docs-command.md | status: active | v0.6.0 |
| plans/2026-07-03-prd-layered-truth.md | status: active | v0.4.0 |
| plans/2026-07-03-prd-state-separation.md | 无 frontmatter status | v0.5.0 |
| plans/2026-07-04-builder-anti-overengineering.md | 无 frontmatter status | v0.8.0 |
| plans/2026-07-04-review-loop-command.md | 无 frontmatter status | v0.9.0 |
| plans/2026-07-05-engine-quality-gate.md | status: active | v0.14.0 |
| prds/prd-docs-doctor.md | status: active | v0.7.0，4 story 全 passes，合并 91d74e9 |
| prds/prd-workspace-status.md | status: active | v0.10.0，合并 22e5f5a |

- [ ] **Step 1: 按映射表逐份处理 18 个文件**（按统一操作规范；逐份对照现状列，不符预期现状即 BLOCKED 报告）

- [ ] **Step 2: 状态分布断言**

Run: `grep -rl "^status: done" docs/ | wc -l`
Expected: `18`

Run: `grep -rn "^- 状态：" docs/superpowers/specs/ | wc -l`
Expected: `0`

Run: `grep -rn "^status: active" docs/prds/ docs/superpowers/specs/ docs/superpowers/plans/ | wc -l`
Expected: `2`（本轮 spec + 本计划文件）

- [ ] **Step 3: doctor 全绿**

Run: `npm run dev -- doctor`
Expected: 末行 `✅ 全部通过`（新迁移 frontmatter 参与检查后仍合规）。

- [ ] **Step 4: 回归验证**

Run: `npm run typecheck && npm test`
Expected: 均通过。

- [ ] **Step 5: Commit**

```bash
git add docs/prds docs/superpowers/specs docs/superpowers/plans
git commit -m "docs: 历史欠账一次性清理——18 份已交付任务型文档（2 PRD+8 spec+8 plan）按发版证据置 done，早期正文状态行迁移为标准 frontmatter（存量路径，spec 第 4 节）"
```

---

### Task 4: dogfood 回归断言 + README 命令表描述

**Files:**
- Modify: `docs/superpowers/dogfood-regression.md`
- Modify: `README.md`

**Interfaces:**
- Consumes: Task 1 的用语「状态变更清单」「无状态变更」（逐字引用）。

- [ ] **Step 1: dogfood-regression.md 表格末尾追加第 10 行**

在第 9 行（`| 9 | /compound-docs 沉淀中改写/删除既有条目时…`）之后追加：

```markdown
| 10 | /compound-docs 收口交付说明含「状态变更清单」节（有变更列明细，无变更写「无状态变更」），任务型文档按证据表判定收尾 | 0.15.0 | 收口交付说明检查 |
```

同时把 frontmatter `updated:` 刷为 `2026-07-06`。

- [ ] **Step 2: README 命令表更新 /compound-docs 行**

用 Edit 将：

```markdown
| `/compound-docs` | 循环/分支收口时把经验提炼、验证、分层沉淀回项目文档（约定与陷阱进 `docs/patterns.md`）；只改文档不改代码；并汇总代码中 `取舍:` 标记为账本 |
```

替换为：

```markdown
| `/compound-docs` | 循环/分支收口时把经验提炼、验证、分层沉淀回项目文档（约定与陷阱进 `docs/patterns.md`）；只改文档不改代码；汇总代码中 `取舍:` 标记为账本；并核对任务型文档状态（交付的 PRD/计划/spec 置 done、被吸收对齐稿置 superseded） |
```

- [ ] **Step 3: 验证**

Run: `grep -c "状态变更清单" docs/superpowers/dogfood-regression.md README.md commands/compound-docs.md`
Expected: dogfood-regression.md 为 `1`，README.md 为 `0`（README 描述不用该词），compound-docs.md 为 `1`。

Run: `npm run typecheck && npm test`
Expected: 均通过。

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/dogfood-regression.md README.md
git commit -m "docs: dogfood 回归清单追加状态收尾断言（第 10 条），README 命令表 /compound-docs 描述补状态收尾"
```

---

### Task 5: 发版 v0.15.0（全 CI 化）

**Files:**
- Modify: `package.json`、`package-lock.json`、三个插件清单（均由 `npm version` 钩子自动完成）

- [ ] **Step 1: ADR 状态核查**

Run: `grep -rn "^status:" docs/decisions/*.md`
Expected: 001/002/003/005 为 `active`、004 为 `rejected`，与本轮无涉——本轮决策记录在 spec，未新增/变更 ADR。有出入即停下报告。

- [ ] **Step 2: 发版前全绿确认**

Run: `npm run typecheck && npm test && npm run dev -- doctor`
Expected: 全部通过。

- [ ] **Step 3: 升版本并推送（此后停手）**

```bash
npm version minor -m "release: v%s"
git push --follow-tags
```

Expected: 钩子输出「插件清单已同步到 0.15.0」；推送含 `v0.15.0` tag。**不执行本地 `npm publish`**——publish 与 GitHub Release 归 tag 触发的 CI。

- [ ] **Step 4: 观察 CI 与发布结果**

Run（后台等待）: `gh run list --workflow "Publish to npm" -b v0.15.0 --limit 1 --json status,conclusion`
Expected: `conclusion: success`；随后 `npm view coding-x version` 为 `0.15.0`，`gh release view v0.15.0` 存在。

- [ ] **Step 5: 计划收口**

本计划文件 frontmatter `status:` 置 `done`（发版即交付证据），提交：

```bash
git add docs/superpowers/plans/2026-07-06-doc-gardening-status-closeout.md docs/superpowers/specs/2026-07-06-doc-gardening-status-closeout-design.md
git commit -m "docs: doc-gardening 状态收尾轮收口——spec 与计划按新约定置 done（首个增量路径实例）"
git push
```

其中 spec 文件 `status:` 同步置 `done`。此提交本身就是新第 6 步语义的首次自用实例。
