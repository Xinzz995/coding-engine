---
title: "/review-loop 审查命令 实施计划"
status: done
updated: 2026-07-06
scope: root
---

# /review-loop 审查命令 实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增 `/review-loop` 命令——循环结束后、合并前，对分支 diff 做独立审查并产出三层人审包；引擎完成提示引导「先审查后收口」；随 0.9.0 发布。

**Architecture:** 命令本体是纯文本指令（commands/review-loop.md，插件经既有 manifest 分发）；唯一代码改动是 loop.ts 完成提示句（TDD 更新既有断言）；README 六处同步；/tmp 真实小项目 dogfood 三场景冒烟。

**Tech Stack:** Markdown 命令指令；Vitest（loop 提示断言）；grep 存在性断言。

**Spec:** `docs/superpowers/specs/2026-07-04-review-loop-command-design.md`

## Global Constraints

- Create 仅 `commands/review-loop.md`；Modify 仅 `src/engine/loop.ts`、`src/engine/loop.test.ts`、`README.md` 与发版版本文件（npm version 钩子自动）。
- **不改** `validator.md`；`docs/architecture.md` 与 `AGENTS.md` 已核实无需改动（均不枚举命令名；architecture.md:31 模板行不适用——review-loop 不用模板）。
- 提交说明中文（conventional 前缀英文）；每任务一个提交。
- grep 断言短语一字不差取自任务给出的最终正文。
- 命令正文使用字面 `.workspace/` 路径（command 非引擎指令，无 {{WORKSPACE}} 占位）。

---

### Task 1: commands/review-loop.md 命令本体

**Files:**
- Create: `commands/review-loop.md`

**Interfaces:**
- Produces: 命令名 `review-loop`、三层包结构与九 tag 词汇（Task 3 README 表述、Task 4 dogfood 执行都以此为准）

- [ ] **Step 1: 创建文件，内容为以下全文**

````markdown
---
description: 循环结束后、合并默认分支前，对本轮分支 diff 做独立审查并产出人审包——改动导读、双维度发现清单、风险聚焦；只读不改，人保持最终裁决
---

# /review-loop——循环产物审查（人审辅助包）

一轮引擎循环跑完后，在合并进默认分支之前，对本轮分支 diff 做独立审查，产出一份人审包。**它是人审的加速器，不是替代品**：审查者自己也是 agent，同样可能漏——包帮助人更快理解与聚焦，最终裁决永远归人。

## 硬性约束

1. 只读不改：不修改业务代码与文档、不写 `.workspace/` 与任何文件；发现的问题列出来，修不修由人决定
2. 独立复核：不得以「validator 已通过」「progress.md 说完成」作为任何结论的证据；验证必须独立重推（读代码、跑质量检查、必要时实际执行）
3. 质量维度的发现只列出，不作为合并阻塞；正确性发现按严重度排序，最终裁决归人
4. 例外（自指豁免）：若目标项目自身就是此类 harness 工具，其子命令名、CLI 参数名等是领域词汇，正常出现在审查输出中（同 /compound-docs 约定）

## 1. 建立范围

- 读 `.workspace/prd.json`：branchName、story 列表与各自 acceptanceCriteria（顶层 `sourcePrd` 存在时可读源 PRD 补背景）
- 读 `.workspace/state.json`：notes 中的 `[需求冲突]` 与失败历史（理解背景用，不作证据）
- 读 `.workspace/progress.md`：理解各 story 的实现意图（不作证据）
- git 取证基线（同 /compound-docs）：

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
MERGE_BASE=$(git merge-base HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null || git merge-base HEAD "$DEFAULT_BRANCH")
git log --reverse --oneline "$MERGE_BASE"..HEAD
git diff --stat "$MERGE_BASE"..HEAD
```

- 排除：lock 文件、构建产物、依赖目录的 diff 不进入审查与行数统计
- **降级规则**：`.workspace/` 缺失 → 纯 git diff 审查（导读按提交组织，test-gap 降为「测试覆盖疑点」并注明无 AC 可对照）；与默认分支无分叉 → 明示「无可审内容」并结束

## 2. 独立审查（假绿嗅探清单）

逐项执行，不是原则宣言：

- 跑一遍项目质量检查（typecheck/lint/test），确认当前分支真实全绿
- 业务逻辑读取的每个文件/路径：干净检出（CI）环境下存在吗？被 .gitignore 了吗？路径是绝对的吗？依赖本机特有状态吗？
- 逐条 acceptanceCriteria：找到对应的测试断言；断言真的在测这条 AC 吗（不是测 mock、不是测自己）？
- 新增的每个外部输入（CLI 参数、文件内容、环境变量）：空串/0/负数/非法格式会发生什么？
- 修改过的共享函数：grep 其所有调用方，逐个核对语义仍成立
- 对照反过度工程阶梯：有没有本可复用项目已有/标准库/平台原生/已装依赖而新写的代码？

## 3. 人审包输出（三层）

### 层 1 改动导读

按 story 组织（降级时按提交组织），每项 3-6 行：

- 改了什么：核心逻辑位置以 `file:line` 给出
- 数据怎么流：输入 → 处理 → 输出，贴着代码讲，不写空泛概念
- 与其他 story 的接缝：共享的文件/函数

### 层 2 发现清单

一行一发现：`<file>:<line> <tag> <缺陷/砍什么>。<失败场景/替代方案>。`

正确性族（在前，按严重度排序）：

- `bug:` 逻辑错误
- `assume:` 环境隐含假设（gitignored 文件被业务逻辑读取、绝对路径、本机特有状态）
- `test-gap:` 测试未真正覆盖 acceptanceCriteria（断言与 AC 不对应、测了 mock、测了自己）
- `edge:` 边界缺失（空串/0/负数/非法格式）

质量族（在后，按可砍行数排序）：

- `delete:` 死代码、无人用的灵活性。替代方案：无
- `stdlib:` 手写了标准库已有的能力。点名函数
- `native:` 依赖或代码做了平台原生已覆盖的事。点名特性
- `yagni:` 单实现抽象、没人读的配置、单调用方的层
- `shrink:` 同逻辑更短写法。给出短形

质量族末行：`net: 约可减 N 行`。

空结果语——正确性族：「未发现正确性问题（不等于没有——人审仍是最终裁决）」；质量族：「无可砍项」。

清单末行总结：`审查结论：建议合并前处理 N 项正确性发现`（N=0 时写「审查结论：未发现需合并前处理的问题」）。

### 层 3 风险聚焦

top 2-4 处建议人重点细看的位置：文件/逻辑 + 为什么值得细看（环境假设密集、测试薄弱、触碰共享路径、复杂度陡增），并用怀疑式提问句引导人审视角（例：「CI 干净检出时这段还成立吗？」「这个测试在空仓库上还过吗？」）。

## 执行模式

默认一次产出完整三层人审包到对话中，全部输出使用项目语言。人审后要修复的项，由人决定修复方式（自己改或另行授权 agent 改）——本命令不做任何修改。
````

- [ ] **Step 2: 绿断言**

```bash
grep -c "人审的加速器" commands/review-loop.md   # 预期 1
grep -c "假绿嗅探" commands/review-loop.md       # 预期 1（## 2 标题）
grep -c "无可砍项" commands/review-loop.md       # 预期 1（空结果语行；-c 数行不数次）
grep -c "审查结论" commands/review-loop.md       # 预期 1（总结行两次出现同一行；-c 数行不数次）
```

注：若实测计数与预期不符，以「短语存在（≥1）且位置正确」为准并如实记录——计数差异通常来自同段复现，不构成阻塞。

- [ ] **Step 3: Commit**

```bash
git add commands/review-loop.md
git commit -m "feat: 新增 /review-loop 审查命令——合并前产出三层人审包（导读/双维度发现清单/风险聚焦）"
```

---

### Task 2: loop.ts 完成提示改写（TDD）

**Files:**
- Modify: `src/engine/loop.ts:116`
- Test: `src/engine/loop.test.ts:49,69`

**Interfaces:**
- Consumes: 命令名 `/review-loop`（Task 1）

- [ ] **Step 1: 改测试（红）**

`src/engine/loop.test.ts` 第 49 行测试名与第 69 行断言处改为：

```typescript
  it('prints review-loop and compound-docs hints when all stories resolve', async () => {
```

并在第 69 行 `expect(logs.some((l) => l.includes('/compound-docs'))).toBe(true);` 之后加一行：

```typescript
      expect(logs.some((l) => l.includes('/review-loop'))).toBe(true);
```

- [ ] **Step 2: 跑测试验证红**

```bash
npx vitest run src/engine/loop.test.ts 2>&1 | tail -8
```

预期：FAIL，`/review-loop` 断言为 false（现提示句无此词）；`/compound-docs` 断言仍 true。

- [ ] **Step 3: 改实现（绿）**

`src/engine/loop.ts:116` 提示句改为：

```typescript
        console.log('\n💡 全部 story 已通过。建议先运行 /review-loop 审查本轮产物（人审后合并），再用 /compound-docs 收口沉淀。');
```

- [ ] **Step 4: 跑测试验证绿 + 全套**

```bash
npx vitest run src/engine/loop.test.ts 2>&1 | tail -4   # 预期该文件全过
npm test 2>&1 | grep -E "Tests "                          # 预期 108 passed
npm run typecheck                                          # 干净
```

- [ ] **Step 5: Commit**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: 引擎完成提示引导先审查后收口——/review-loop 与 /compound-docs 对仗"
```

---

### Task 3: README 六处同步

**Files:**
- Modify: `README.md:8,82,139,209-211,256-259,284-288`

**Interfaces:**
- Consumes: Task 1 的命令名、三层包与九 tag 表述

- [ ] **Step 1: 改前红断言**

```bash
grep -c "review-loop" README.md   # 预期 0
```

- [ ] **Step 2: 特性行（第 8 行）**

原（片段）：`和 \`/priming\` \`/planning\` \`/init-docs\` \`/compound-docs\` 命令`
新（片段）：`和 \`/priming\` \`/planning\` \`/init-docs\` \`/review-loop\` \`/compound-docs\` 命令`

同句句尾原：`帮你把需求拆解成可自动执行的 \`prd.json\`，并为项目生成与持续沉淀 docs/ 知识库。`
新：`帮你把需求拆解成可自动执行的 \`prd.json\`、在合并前审查循环产物，并为项目生成与持续沉淀 docs/ 知识库。`

- [ ] **Step 3: 安装段（第 82 行）**

原：`安装后即可使用 \`/priming\`、\`/planning\`、\`/init-docs\`、\`/compound-docs\` 命令以及 ...`
新：`安装后即可使用 \`/priming\`、\`/planning\`、\`/init-docs\`、\`/review-loop\`、\`/compound-docs\` 命令以及 ...`

- [ ] **Step 4: 工作流程图（第 139 行前插一行）**

原：

```
              ──/compound-docs─▶  经验沉淀回 docs/（收口，可选）
```

新（两行）：

```
              ──/review-loop───▶  合并前人审包（审查，建议）
              ──/compound-docs─▶  经验沉淀回 docs/（收口，可选）
```

- [ ] **Step 5: 教程——插入新第 4 步，原第 4 步改第 5 步（第 209-211 行区域）**

在 `### 第 4 步：收口沉淀（可选）` 之前插入：

```markdown
### 第 4 步：审查合并（建议）

循环全部 story 通过后（引擎会提示），先别急着合并：在 Claude Code 等工具中运行 `/review-loop`，它对本轮分支 diff 做独立审查，产出三层人审包——改动导读（每个 story 改了什么、数据怎么流）、发现清单（正确性与过度工程双维度，一行一发现）、风险聚焦（建议你重点细看的位置）。它是人审的加速器不是替代品：拿着包审完 diff、处理完发现，再把分支合并进主干。

```

原第 4 步标题改：`### 第 4 步：收口沉淀（可选）` → `### 第 5 步：收口沉淀（可选）`
原第 5 步首句改：`循环全部 story 通过后（引擎会提示），回到 Claude Code 等工具运行 \`/compound-docs\`：` → `分支合并后，回到 Claude Code 等工具运行 \`/compound-docs\`：`

- [ ] **Step 6: 命令表（第 258-259 行之间插行，语义序：planning 之后、compound-docs 之前）**

```markdown
| `/review-loop` | 循环结束后、合并默认分支前，对分支 diff 做独立审查并产出人审包（改动导读/双维度发现清单/风险聚焦）；只读不改，人保持最终裁决 |
```

- [ ] **Step 7: 目录树（第 284-288 行区域）**

原：

```
│   ├── init-docs.md
│   └── compound-docs.md
```

新：

```
│   ├── init-docs.md
│   ├── review-loop.md
│   └── compound-docs.md
```

- [ ] **Step 8: 改后绿断言**

```bash
grep -c "review-loop" README.md   # 预期 6（特性/安装/流程图/教程正文/命令表/目录树各 1 行）
grep -n "第 4 步\|第 5 步" README.md   # 预期：第 4 步=审查合并，第 5 步=收口沉淀
```

- [ ] **Step 9: Commit**

```bash
git add README.md
git commit -m "docs: README 同步 /review-loop——特性、安装、流程图、教程新增审查合并步、命令表、目录树"
```

---

### Task 4: dogfood 冒烟（/tmp 三场景）

**Files:** 无仓库改动（一次性 /tmp 项目 + 按 Task 1 命令正文人工执行）

- [ ] **Step 1: 造 mini 项目**

/tmp 下建 git 项目：main 上 1 个初始提交；`feature/demo` 分支上 2-3 个提交，包含一个**故意埋的 assume 类问题**（业务代码读取一个被 .gitignore 的文件，例如 `config.local.json`）与一个 **edge 类问题**（CLI 参数用 `Number()` 直转不校验）；手写 `.workspace/prd.json`（2 story 含 AC）、`state.json`（全 passes）、`progress.md`（2 条记录）。

- [ ] **Step 2: 场景一——完整模式**

在 feature/demo 上按 `commands/review-loop.md` 正文逐节执行，产出三层人审包。验收：导读按 story 组织；发现清单命中埋的 `assume:` 与 `edge:` 问题（tag 正确）；层 3 有怀疑式提问句；总结行 N≥2。

- [ ] **Step 3: 场景二——降级模式**

删除 `.workspace/` 后重跑。验收：导读按提交组织；输出注明「测试覆盖疑点」类降级措辞（无 AC 可对照）。

- [ ] **Step 4: 场景三——无分叉**

checkout main 后重跑。验收：明示「无可审内容」并结束，不产出空包。

- [ ] **Step 5: 记录结果**

三场景结果如实记入交付说明（含未命中/格式不顺处）；发现命令正文缺陷则回改 `commands/review-loop.md` 并补提交（消息 `fix: review-loop 命令正文——dogfood 修正 <点>`）。

---

### Task 5: 发版 0.9.0

**Files:**
- Modify: `package.json`、`package-lock.json`、三个插件清单（npm version 钩子自动）

- [ ] **Step 1: 前置检查**

```bash
npm run typecheck && npm test          # 全绿（108）
ls docs/decisions/                      # 确认无 ADR 需状态同步（预期三份既有，无变化）
grep -rn "第 4 步" docs/ --include="*.md" | grep -v superpowers   # 预期无教程步骤交叉引用需要同步
git status --short                      # 干净
```

- [ ] **Step 2: bump + 验证**

```bash
npm version 0.9.0 --no-git-tag-version
# 预期钩子输出：插件清单已同步到 0.9.0：三个路径
grep -h '"version"' package.json .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex-plugin/plugin.json  # 四行 0.9.0
npm test 2>&1 | grep "Tests "           # 一致性测试守门通过
```

- [ ] **Step 3: release 提交 + tag 推送**

```bash
git add package.json package-lock.json .claude-plugin .cursor-plugin .codex-plugin
git commit -m "release: v0.9.0"
git tag v0.9.0
git push origin main && git push origin v0.9.0
```

- [ ] **Step 4: CI 与发布验证**

```bash
gh run list --limit 3                                   # test.yml + publish.yml
gh run watch <publish-run-id> --exit-status             # success
npm view coding-x version                               # 0.9.0
gh release view v0.9.0 --json tagName --jq .tagName     # v0.9.0
```

- [ ] **Step 5: 记忆更新**

0.9.0 发布记录；延迟验证项合并表述：下次引擎真实运行后用 /review-loop 做合并前人审（检验检出能力），并观察 builder 取舍标记与收口账本。

---

## Self-Review 记录

1. **Spec 覆盖**：spec 节 3（定位/提示）→ Task 1+2；节 4（输入降级）→ Task 1 正文「建立范围」；节 5（三层格式）→ Task 1 正文；节 6（纪律/嗅探清单）→ Task 1 正文「硬性约束」「独立审查」；节 7（周边）→ Task 2（loop.ts）+ Task 3（README 六处）+ Global Constraints（architecture/AGENTS 免改结论）；节 8（验证）→ Task 2 TDD + Task 4 dogfood 三场景；节 9 非目标未引入。无缺口。
2. **占位符**：命令正文全文给出；README 六处均有原文/新文对照；无 TBD。
3. **一致性**：`review-loop`、三层名称（改动导读/发现清单/风险聚焦）、九 tag、空结果语在 Task 1/3/4 一致；「人审的加速器」表述 Task 1 与 Task 3 教程一致。
