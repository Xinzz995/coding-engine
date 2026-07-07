---
title: "/review-loop 动作维度与裁决留痕实施计划"
status: done
updated: 2026-07-07
scope: root
---

# /review-loop 动作维度与裁决留痕实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** /review-loop 发现清单加动作三档（需人裁决/机械修/仅提示）、人审包落盘留痕与裁决回填（四态）、prd.tampered-* 红旗区——补「产物必人审」闭环的后半段（规格：`docs/superpowers/specs/2026-07-07-review-loop-actions-design.md`）。

**Architecture:** 纯文档改动：commands/review-loop.md 主体（7 处编辑）+ 三处连带（prd-to-json 归档清单、glossary 词条、README 描述）。验证靠 grep 定位断言 + 真实 dogfood：Task 1/2 提交后**不推送**，本地领先 origin/main 的提交构成真实可审 diff，Task 3 按新版命令对其执行 /review-loop，产出的人审包交用户真实裁决，Task 4 回填实证后发版。

**Tech Stack:** Markdown（命令/skill/文档）；无代码改动，npm test/typecheck 仅防御性复跑。

## Global Constraints

- 提交说明中文，conventional 前缀保留英文（feat:/fix:/docs:/release:）
- `skills/`、`commands/` 是唯一源：各工具清单只指回，不复制内容（本计划不动清单）
- 面向用户的命令行为变化升 minor 版本并同步 README（本计划 0.17.0 → 0.18.0）
- Task 1/2 提交后不执行 git push（为 Task 3 dogfood 保留本地领先 diff）；推送统一在 Task 4 发版时进行
- grep 断言必须锚定唯一位置文本（如判据条目、总结行模板），不用全文计数（防示例自命中）

---

### Task 1: commands/review-loop.md 主体改造

**Files:**
- Modify: `commands/review-loop.md`（7 处编辑）

**Interfaces:**
- Consumes: 无
- Produces: 新版命令文档——动作后缀格式 `→ 需人裁决|机械修|仅提示`、`## 4. 留痕与裁决回填` 节（Task 2 的 glossary 表述与 Task 3 的 dogfood 执行都以此为准）

- [ ] **Step 1: 硬性约束 1 加留痕例外**

原文（`commands/review-loop.md` 硬性约束 1）：

```markdown
1. 只读不改：不修改业务代码与文档、不写 `.workspace/` 与任何项目文件（验证所需的临时探测文件放系统临时目录、用完即删，不留在项目内）；发现的问题列出来，修不修由人决定
```

替换为：

```markdown
1. 只读不改：不修改业务代码与文档、不写项目文件（验证所需的临时探测文件放系统临时目录、用完即删，不留在项目内）；唯一例外是留痕文件 `.workspace/review-*.md`（人审包落盘与裁决回填，见第 4 节）——发现的问题列出来，修不修由人决定
```

- [ ] **Step 2: 建立范围加 tampered 检查项**

在「## 1. 建立范围」节的首个列表项（`- 读 \`.workspace/prd.json\`：branchName…`）之前插入一行：

```markdown
- 检查 `.workspace/prd.tampered-*.json`：存在即记入人审包顶部红旗区（见第 3 节；ADR-007 的运行期篡改存档）
```

- [ ] **Step 3: 人审包输出节加红旗区约定**

在「## 3. 人审包输出（三层）」标题与「### 层 1 改动导读」之间插入：

```markdown
### 红旗区（仅在有内容时输出）

建立范围时发现 `.workspace/prd.tampered-*.json` 存在，则在层 1 之前输出红旗区：列出篡改存档文件清单，并指引人「diff 存档与 prd.json，核对运行期被改了什么」。无篡改文件时整节省略，不输出空节。
```

- [ ] **Step 4: 发现行格式加动作后缀与三档判据**

原文（层 2 节）：

```markdown
一行一发现：`<file>:<line> <tag> <缺陷/砍什么>。<失败场景/替代方案>。`
```

替换为：

```markdown
一行一发现：`<file>:<line> <tag> <缺陷/砍什么>。<失败场景/替代方案>。→ <动作>`

动作三档（与严重度正交，逐条必标）：

- `→ 需人裁决`：满足任一——①发现挑战 story 意图或 AC 本身（行为不该存在/AC 可能写错）②修复方案取决于产品语义选择（两种修法对应两种产品行为）③删除性/破坏性变更（删功能、删数据、改公开接口）④`scope:` 私货的去留（吸收进 PRD 还是删）。不要把产品判断伪装成代码修复——这类发现授权 agent 机械修是错误动作，正确动作可能是回改源 PRD
- `→ 机械修`：修法唯一且不涉上述——bug 修复、边界补齐、测试补齐、质量族砍代码；人可放心授权 agent 执行
- `→ 仅提示`：信息性、无需动作、不阻塞；拿不准是否算问题的归此档
```

- [ ] **Step 5: 总结行扩展**

原文：

```markdown
清单末行总结：`审查结论：建议合并前处理 N 项正确性发现`（N=0 时写「审查结论：未发现需合并前处理的问题」）。
```

替换为：

```markdown
清单末行总结：`审查结论：建议合并前处理 N 项正确性发现（其中 M 项需人裁决）`（N=0 时写「审查结论：未发现需合并前处理的问题」）。
```

- [ ] **Step 6: 新增「## 4. 留痕与裁决回填」节**

在层 3 风险聚焦节之后、「## 执行模式」之前插入：

```markdown
## 4. 留痕与裁决回填

- 人审包全文（红旗区如有 + 三层）落盘 `.workspace/review-YYYY-MM-DD.md`（同日已存在则 `-2`、`-3` 递增；`.workspace/` 不存在时创建该目录）。发现清单每条之下带空槽 `- resolution: （待人审裁决）`
- 人审后人在对话给出裁决，执行者把每条 resolution 写回留痕文件，四态：
  - `[已修] <detail>`：detail 引用修复提交哈希
  - `[接受] <理由>`：发现真实但不值得修
  - `[推迟] <去向>`：后续处理，写明去向
  - `[驳回] <反证>`：审查者误报，写明反证
- 「仅提示」档通常回填 `[接受] 知悉`；人明确说不用逐条过时可批量回填
- 所有发现都有 resolution 后本轮审查才算闭环；修复动作本身仍由人另行授权，本命令不代修
```

- [ ] **Step 7: 执行模式同步**

原文：

```markdown
默认一次产出完整三层人审包到对话中，全部输出使用项目语言。人审后要修复的项，由人决定修复方式（自己改或另行授权 agent 改）——本命令不做任何修改。
```

替换为：

```markdown
默认一次产出完整人审包（红旗区如有 + 三层）到对话中，同时落盘留痕文件（见第 4 节），全部输出使用项目语言。人审后要修复的项，由人决定修复方式（自己改或另行授权 agent 改）——本命令不修改业务代码与文档。
```

- [ ] **Step 8: grep 定位断言**

```bash
grep -n "唯一例外是留痕文件" commands/review-loop.md
grep -n "→ 需人裁决\`：满足任一" commands/review-loop.md
grep -n "其中 M 项需人裁决" commands/review-loop.md
grep -n "## 4. 留痕与裁决回填" commands/review-loop.md
grep -n "### 红旗区（仅在有内容时输出）" commands/review-loop.md
grep -n "prd.tampered" commands/review-loop.md
```

Expected: 前五条各恰 1 处命中；最后一条恰 2 处（建立范围检查项 + 红旗区节）。

- [ ] **Step 9: 提交（不推送）**

```bash
git add commands/review-loop.md
git commit -m "feat: /review-loop 动作三档与裁决留痕——发现逐条标注需人裁决/机械修/仅提示，人审包落盘 .workspace/review-*.md 四态回填，prd.tampered 红旗区（ADR-007 消费端）"
```

---

### Task 2: 连带三处（prd-to-json 归档清单 / glossary / README）

**Files:**
- Modify: `skills/prd-to-json/SKILL.md`（归档复制清单一行）
- Modify: `docs/glossary.md`（人审包词条）
- Modify: `README.md`（:8 命令描述）

**Interfaces:**
- Consumes: Task 1 的第 4 节命名「留痕与裁决回填」、落盘路径 `.workspace/review-*.md`
- Produces: 无

- [ ] **Step 1: prd-to-json 归档清单加 review-*.md**

原文（「归档之前的运行」节）：

```markdown
   - 将当前的 `prd.json`、`state.json`（如存在）和 `progress.md` 复制到归档
```

替换为：

```markdown
   - 将当前的 `prd.json`、`state.json`（如存在）、`progress.md` 和 `review-*.md` 留痕文件（如存在）复制到归档
```

- [ ] **Step 2: glossary 人审包词条更新**

原文：

```markdown
**人审包**
/review-loop 产出的三层审查交付物（改动导读、发现清单、风险聚焦）；人审的加速器，不是替代品。
禁用：审查报告
```

替换为：

```markdown
**人审包**
/review-loop 产出的审查交付物：红旗区（如有）+ 三层（改动导读、发现清单、风险聚焦），落盘 `.workspace/review-*.md` 供裁决回填（四态：已修/接受/推迟/驳回）；人审的加速器，不是替代品。
禁用：审查报告
```

- [ ] **Step 3: README 命令描述补留痕**

README.md :8 的长句中，原文片段：

```markdown
在合并前审查循环产物，并为项目生成与持续沉淀 docs/ 知识库
```

替换为：

```markdown
在合并前审查循环产物并留痕人审裁决，且为项目生成与持续沉淀 docs/ 知识库
```

- [ ] **Step 4: grep 定位断言**

```bash
grep -n "review-\*.md\` 留痕文件" skills/prd-to-json/SKILL.md
grep -n "落盘 \`.workspace/review-\*.md\` 供裁决回填" docs/glossary.md
grep -n "审查循环产物并留痕人审裁决" README.md
```

Expected: 各恰 1 处命中。

- [ ] **Step 5: 防御性全量验证 + 提交（不推送）**

```bash
npm run typecheck && npm test
git add skills/prd-to-json/SKILL.md docs/glossary.md README.md
git commit -m "docs: 归档清单/词汇表/README 随 review-loop 留痕机制连带同步"
```

Expected: typecheck+test 全绿（纯文档改动零影响）。

---

### Task 3: dogfood——对本轮改动真实跑 /review-loop

**Files:**
- Modify: `.workspace/`（归档旧轮残留 + 新增留痕文件——运行时状态目录，非业务提交）

**Interfaces:**
- Consumes: Task 1 的新版 commands/review-loop.md（执行依据）；Task 1/2 的未推送提交（审查素材：origin/main..HEAD）
- Produces: 真实人审包（对话 + `.workspace/review-2026-07-07.md` 带空槽）交用户裁决；dogfood 验证报告

- [ ] **Step 1: 归档旧轮 workspace 残留**

本仓 `.workspace/` 现存 v0.10.0 时代 status 轮的 prd.json/state.json/progress.md——不归档则其无关 AC 会把本轮 diff 全部误判为 scope: 越权。按 prd-to-json 既有归档惯例处理（内容零丢失）：

```bash
mkdir -p .workspace/archive/2026-07-07-legacy-workspace
mv .workspace/prd.json .workspace/state.json .workspace/progress.md .workspace/archive/2026-07-07-legacy-workspace/
ls .workspace/
```

Expected: `.workspace/` 仅剩 `archive/`。

- [ ] **Step 2: 按新版命令执行 /review-loop**

执行者通读 `commands/review-loop.md`（Task 1 改后版）并严格按其执行，审查范围为本地领先提交（`git merge-base HEAD origin/main`..HEAD，即 Task 1/2 的改动）。预期走的路径：

- `.workspace/` 无 prd.json → 降级纯 git diff 审查（导读按提交组织，注明无 AC 可对照）
- 无 `.workspace/prd.tampered-*.json` → 红旗区整节省略
- 本仓是 harness 工具 → 自指豁免适用（命令名/参数名不当缺陷报）

- [ ] **Step 3: 验证 dogfood 产出规范**

逐项核对：

```bash
ls .workspace/review-2026-07-07*.md
grep -c "resolution: （待人审裁决）" .workspace/review-2026-07-07.md
grep -n "→ " .workspace/review-2026-07-07.md | head -5
grep -n "红旗区" .workspace/review-2026-07-07.md || echo "OK: 红旗区正确省略"
```

Expected: 留痕文件存在；resolution 空槽数 = 发现数；发现行带 `→ <动作>` 后缀；无红旗区文本（正确省略）。若任何产出偏离新版命令约定，视为 Task 1 的文档缺陷——修 review-loop.md 并重跑本任务。

- [ ] **Step 4: 人审包呈交用户**

把人审包（对话版）完整呈交用户裁决。**本任务到此结束**——裁决是人的动作，Task 4 在用户给出裁决后继续。

---

### Task 4: 裁决回填实证 + 发版 0.18.0

**Files:**
- Modify: `.workspace/review-2026-07-07.md`（回填 resolution）
- Modify: `docs/superpowers/specs/2026-07-07-review-loop-actions-design.md`（status: done）
- Modify: `package.json` 等（npm version 钩子自动同步）

**Interfaces:**
- Consumes: 用户对 Task 3 人审包的裁决
- Produces: tag v0.18.0；publish 归 tag 触发的 CI（workflow 文件名是 **publish.yml**）——本地不做

- [ ] **Step 1: 裁决回填实证**

按用户裁决逐条回填 `.workspace/review-2026-07-07.md` 的 resolution（四态格式见新版命令第 4 节）；若有「修复」裁决，先按授权修复并提交，再回填提交哈希。回填后：

```bash
grep -c "resolution: （待人审裁决）" .workspace/review-2026-07-07.md
```

Expected: 0（全部发现已有 resolution，闭环）。

- [ ] **Step 2: 规格收尾**

`docs/superpowers/specs/2026-07-07-review-loop-actions-design.md` frontmatter：`status: active` → `status: done`。

```bash
git add docs/superpowers/specs/2026-07-07-review-loop-actions-design.md
git commit -m "docs: review-loop 动作与留痕设计规格按落地置 done"
```

- [ ] **Step 3: 全量验证与发版**

```bash
npm run typecheck && npm test && npm run build
npm version minor -m "release: v%s"
git push --follow-tags
```

Expected: 全绿；0.17.0 → 0.18.0；tag v0.18.0。**push 后停手**——publish 由 tag 触发的 CI（publish.yml）完成，本地绝不执行发布命令；可 `gh run list --workflow=publish.yml --limit 1` 观察（只看不动）。

---

## 自审记录

- **规格覆盖**：决策 1/2 → Task 1 Step 4/5；决策 3/4/5 → Task 1 Step 6（+Step 1 约束例外）；决策 6 → Task 1 Step 2/3；决策 7 → Task 1 Step 1；决策 8 → Task 2 Step 1；决策 9 → Task 1 Step 8 + Task 3 全部；改动清单 5 行全对应；非目标无任务（正确）。
- **占位符**：无——每处编辑给出完整 old/new 文本（锚点已在计划前逐一 sed/grep 核对为当前行文）。
- **一致性**：Task 1 Step 1 例外句「见第 4 节」与 Step 6 节名「## 4. 留痕与裁决回填」对应；Task 2 glossary 四态与 Task 1 Step 6 四态一致（已修/接受/推迟/驳回）；「不推送」约束在 Global Constraints 与 Task 1/2 提交步骤、Task 4 统一推送处三处呼应。
