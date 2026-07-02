# docs/ 知识库体系 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让 coding-x 能在目标项目中生成并维护「目录式 AGENTS.md + 结构化 docs/ 知识库（含黄金原则）」，支持单项目与 monorepo，统一收编 /planning 与 PRD 产物路径，并在本仓库 dogfood。

**Architecture:** 纯 markdown/模板/清单改动，**引擎 TS 代码（src/）零改动**。新增 `templates/`（5 个模板），`/init-rules` 重写改名为 `/init-docs`，planning/prd-generate 产物收编到 `docs/plans/`、`docs/prds/`，builder/validator 指令接线，最后 dogfood + 发布 0.2.0（破坏性变更）。

**Tech Stack:** Markdown 模板、Claude Code 插件 commands/skills、GitHub Actions（tag 触发 npm 发布）。

**Spec:** `docs/superpowers/specs/2026-07-02-docs-knowledge-base-design.md`

## Global Constraints

- **src/ 零改动**：任何任务都不得修改 `src/`、`tsup.config.ts`、`vitest.config.ts`；引擎只关心 `.workspace/`。
- **统一 frontmatter**：所有生成到目标项目 `docs/` 下的知识库文档（README 占位除外）必须携带：
  ```yaml
  ---
  title: ...
  status: draft | active | done | superseded
  updated: YYYY-MM-DD
  scope: root | <子项目名>
  ---
  ```
- **AGENTS.md 不带 YAML frontmatter**（设计说明 1，见文末备注）；根 AGENTS.md 全文 ≤100 行，严格四段式：①一句话定位+技术栈一行表 ②关键命令 ③文档索引表（主体）④3–5 条内联硬约束。
- **归属规则**（写入 planning 与 prd-generate）：功能只涉及一个子项目 → 产物落 `<sub>/docs/`；跨子项目或单项目 → 落根 `docs/`。
- **黄金原则规范**：每条必须机械可判定，附「为什么」+「怎么检查」；反例「代码要整洁」禁止出现。
- **幂等**：`/init-docs` 对已存在文件一律跳过不覆盖，列入报告。
- **validator 不新增判定维度**：验收标准仍是唯一判定依据。
- **命名**：命令为 `init-docs`（`/init-rules` 移除）；产物目录为 `docs/plans/`、`docs/prds/`、`docs/decisions/`；PRD 文件名保持 `prd-[feature-name].md`。
- **版本**：破坏性变更，发布 `0.2.0`（package.json + 三个 plugin.json 同步）。
- **验证方式**：无单元测试可写（纯指令/模板），每个任务用机械检查命令（grep/wc/文件存在性）验证；验收 = 真实运行（Task 7–9）。每个任务完成后 `git commit && git push`（本仓库直接提交 main）。

## File Structure

| 动作 | 路径 | 职责 |
|---|---|---|
| Create | `templates/AGENTS-root.md` | 目录式根 AGENTS.md 模板（四段式） |
| Create | `templates/AGENTS-sub.md` | 子项目薄 AGENTS.md 模板 |
| Create | `templates/docs/architecture.md` | 架构地图模板 |
| Create | `templates/docs/golden-principles.md` | 黄金原则模板 |
| Create | `templates/docs/decision.md` | ADR 模板 |
| Rename+重写 | `commands/init-rules.md` → `commands/init-docs.md` | 探测→分析→生成→幂等→报告 |
| Delete | `AGENTS-template.md` | 内容拆分进 templates/ |
| Modify | `commands/planning.md` | 输出 `docs/plans/` + 归属规则 + frontmatter |
| Modify | `skills/prd-generate/SKILL.md` | 输出 `docs/prds/` + 归属规则 + frontmatter |
| Modify | `skills/prd-to-json/SKILL.md` | 提示 PRD 通常位于 `docs/prds/` |
| Modify | `assets/instructions/builder.md` | 子项目 AGENTS.md、黄金原则、模式升格 |
| Modify | `assets/instructions/validator.md` | AGENTS.md 背景阅读（不加判定维度） |
| Modify | `README.md` + 4 个插件清单 | init-rules→init-docs、目录结构、路径 |
| Create | 仓库根 `AGENTS.md` + `docs/{architecture,golden-principles}.md` + 3 个 README 占位 | dogfood 产物 |
| Modify | `package.json` + 3 个 plugin.json | version → 0.2.0 |

---

### Task 1: 创建 `templates/` 知识库模板

**Files:**
- Create: `templates/AGENTS-root.md`
- Create: `templates/AGENTS-sub.md`
- Create: `templates/docs/architecture.md`
- Create: `templates/docs/golden-principles.md`
- Create: `templates/docs/decision.md`

**Interfaces:**
- Consumes: 无。
- Produces: 5 个模板文件，供 Task 2 的 `commands/init-docs.md` 以「插件根目录 `templates/`」相对路径引用；Task 7–9 的真实运行以它们为源。模板中 `{...}` 为**生成时替换的占位变量**（这是产品内容，不是计划缺口）。

- [ ] **Step 1: 创建 `templates/AGENTS-root.md`**

内容一字不差如下：

````markdown
# AGENTS.md

<!-- 目录式索引，不是手册：全文 ≤100 行。细节一律下沉 docs/，这里只负责「告诉你去哪找」。 -->

## 项目定位

{一句话：这个项目是什么、为谁解决什么问题}

| 层 | 技术 |
|---|---|
| 语言/运行时 | {如 TypeScript / Node 20} |
| 框架 | {…} |
| 测试 | {…} |
| 构建 | {…} |

## 关键命令

```bash
{dev-command}        # 开发
{build-command}      # 构建
{test-command}       # 测试
{lint-command}       # Lint / 类型检查
```

## 文档索引

| 主题 | 路径 | 说明 |
|---|---|---|
| 架构地图 | `docs/architecture.md` | 模块划分、分层、数据流、依赖方向 |
| 黄金原则 | `docs/golden-principles.md` | 3–5 条机械可判定的强制规则 |
| 设计决策 | `docs/decisions/` | ADR：一事一文件，编号递增 |
| 实现计划 | `docs/plans/` | /planning 产出（active/done 靠 frontmatter status 区分） |
| PRD | `docs/prds/` | prd-generate 产出 |
| {子项目 <name>} | `{<path>/AGENTS.md}` | {monorepo 时每个子项目一行；单项目删除} |

## 硬约束

<!-- 3–5 条最高优先级规则，agent 每轮必须遵守；更多规则放 docs/golden-principles.md -->

1. {如：提交前必须通过 `npm run typecheck`}
2. {…}
3. {…}
````

- [ ] **Step 2: 创建 `templates/AGENTS-sub.md`**

````markdown
# AGENTS.md（{子项目名}）

> 先读根目录 `AGENTS.md`（全局命令、跨项目文档索引、硬约束），本文件只补充 {子项目名} 特有内容。

## 子项目定位

{一句话：这个子项目做什么}

## 子项目命令

```bash
{仅列与根不同的命令，如 pnpm --filter {name} dev；无差异则删除本节}
```

## 文档索引

| 主题 | 路径 | 说明 |
|---|---|---|
| 架构地图 | `docs/architecture.md` | {仅当为本子项目生成了该文件时保留此行} |
| 设计决策 | `docs/decisions/` | 仅限本子项目的决策 |
| 实现计划 | `docs/plans/` | 仅涉及本子项目的功能计划 |
| PRD | `docs/prds/` | 仅涉及本子项目的 PRD |

## 子项目模式

<!-- 仅列与根约定不同或本子项目特有的模式，1–5 条；没有则删除本节 -->

- {…}
````

- [ ] **Step 3: 创建 `templates/docs/architecture.md`**

````markdown
---
title: 架构地图
status: active
updated: {YYYY-MM-DD}
scope: {root 或子项目名}
---

# 架构地图

<!-- 域地图：让 agent 用最短路径知道「东西在哪、怎么流动、往哪依赖」。不要写成教程。 -->

## 模块划分

| 模块 | 路径 | 职责 |
|---|---|---|
| {模块名} | `{path}` | {一句话职责} |

## 分层与依赖方向

{描述层次与允许的依赖方向，如：cli → services → data；禁止反向依赖。}

## 数据流

{一条主流程从入口到出口怎么走，用文字或 ASCII 图}

## 关键入口文件

| 文件 | 作用 |
|---|---|
| `{path}` | {说明} |
````

- [ ] **Step 4: 创建 `templates/docs/golden-principles.md`**

````markdown
---
title: 黄金原则
status: active
updated: {YYYY-MM-DD}
scope: {root 或子项目名}
---

# 黄金原则

<!-- 3–5 条机械可判定、有主见的强制规则。每条必须写「为什么」和「怎么检查」，
     使未来可翻译成 lint。反例：「代码要整洁」（不可判定，禁止写入）。 -->

## 1. {规则的祈使句表述，如：共享逻辑必须放 src/utils/，禁止在 feature 目录内复制辅助函数}

- **为什么**：{一句话}
- **怎么检查**：{机械步骤，如：grep 重复函数签名；或某命令退出码为 0}

## 2. {…}

- **为什么**：{…}
- **怎么检查**：{…}

## 3. {…}

- **为什么**：{…}
- **怎么检查**：{…}
````

- [ ] **Step 5: 创建 `templates/docs/decision.md`**

````markdown
---
title: {NNN-决策标题-kebab-case}
status: active
updated: {YYYY-MM-DD}
scope: {root 或子项目名}
---

# {NNN}. {决策标题}

<!-- 一事一文件，存入 docs/decisions/，文件名 NNN-标题.md（编号从 001 递增） -->

## 背景

{什么问题/约束迫使我们做决定}

## 决策

{我们选了什么，一句话}

## 理由与备选

{为什么选它；列被否掉的 1–2 个备选及否因}

## 后果

{这个决策带来的约束、迁移成本、需要跟进的事}
````

- [ ] **Step 6: 机械验证**

```bash
ls templates/AGENTS-root.md templates/AGENTS-sub.md templates/docs/architecture.md templates/docs/golden-principles.md templates/docs/decision.md
```
Expected: 5 个路径全部输出，无 "No such file"。

```bash
head -1 templates/docs/architecture.md templates/docs/golden-principles.md templates/docs/decision.md
```
Expected: 三个文件首行均为 `---`（frontmatter 起始）。

- [ ] **Step 7: Commit & push**

```bash
git add templates/
git commit -m "feat: add templates/ knowledge-base scaffolding (AGENTS + docs templates)"
git push
```

---

### Task 2: `/init-rules` 重写改名为 `/init-docs`，删除 `AGENTS-template.md`

**Files:**
- Rename: `commands/init-rules.md` → `commands/init-docs.md`（git mv 保留历史，随后全文重写）
- Delete: `AGENTS-template.md`

**Interfaces:**
- Consumes: Task 1 的 `templates/` 5 个模板（命令文本按「插件根目录 `templates/…`」引用）。
- Produces: `commands/init-docs.md`——Task 7/8/9 真实运行的完整操作规程；其「占位 README 内容」块是 `docs/{decisions,plans,prds}/README.md` 的唯一内容来源。

- [ ] **Step 1: 改名**

```bash
git mv commands/init-rules.md commands/init-docs.md
```

- [ ] **Step 2: 用以下完整内容覆写 `commands/init-docs.md`**

内容一字不差如下（原 init-rules 的「发现/分析」两阶段已并入阶段 2）：

````markdown
---
description: 分析代码库，生成目录式 AGENTS.md 与 docs/ 知识库（含黄金原则），支持单项目与 monorepo
---

# 初始化 docs/ 知识库

分析代码库，生成一套「AGENTS.md 目录 + docs/ 知识库」：AGENTS.md 只做 ≤100 行的**地图**，细节全部下沉到结构化 `docs/`。已存在的文件一律不覆盖（幂等，可反复运行只补缺失）。

**模板位置**：插件根目录 `templates/`（Claude Code 中为 `${CLAUDE_PLUGIN_ROOT}/templates/`；Codex/Cursor 中为插件仓库根目录下的 `templates/`）。

---

## 阶段 1：探测项目形态

按以下顺序探测 monorepo 配置，命中任何一项即得到子项目候选清单：

1. `pnpm-workspace.yaml` 的 `packages` 字段
2. 根 `package.json` 的 `workspaces` 字段
3. `lerna.json` 的 `packages` 字段
4. `turbo.json` 存在 → 回到 1/2 找 workspace 定义
5. 以上皆无 → 扫描一、二级目录，找带独立 manifest（`package.json`、`pyproject.toml`、`go.mod`、`Cargo.toml`、`pom.xml`）的目录

得到候选清单后：

- **向用户展示清单并请求确认**（可增删条目），确认后才继续。
- 子项目多于 10 个 → 列出清单请用户**勾选需要生成骨架的子集**，不要一次全部生成。
- 探测不到任何子项目 → 按**单项目**处理，跳过所有子项目步骤。

## 阶段 2：分析代码库

### 识别项目类型

| 类型 | 判断依据 |
|------|----------|
| Web 应用（全栈） | 有独立的 client/server 目录，或存在 API 路由 |
| Web 应用（前端） | 使用 React/Vue/Svelte，且没有服务端代码 |
| API/后端 | 使用 Express/Fastify 等，且没有前端 |
| 库/包 | `package.json` 中有 `main`/`exports`，可发布 |
| CLI 工具 | `package.json` 中有 `bin`，提供命令行接口 |
| Monorepo | 阶段 1 已确认 |
| 脚本/自动化 | 独立脚本为主，面向任务执行 |

### 分析配置与结构

- 读根目录配置：`package.json`（依赖、脚本）、`tsconfig.json`、`*.config.*`
- 梳理目录：源码在哪、测试在哪、共享代码在哪
- 提取技术栈：运行时/语言、框架、数据库、测试工具、构建工具、lint 工具
- 识别模式：命名、文件组织、错误处理、类型定义、测试组织
- 找出关键文件：入口、核心业务逻辑、共享工具、类型定义
- monorepo：对每个已确认子项目重复上述分析（粒度可粗一档）

## 阶段 3：生成

### 3a. 根产物

| 产物 | 来源 | 说明 |
|---|---|---|
| `AGENTS.md` | `templates/AGENTS-root.md` | 填入分析结果；**全文 ≤100 行**；单项目删除子项目索引行 |
| `docs/architecture.md` | `templates/docs/architecture.md` | 填入模块表、分层、数据流、关键文件 |
| `docs/golden-principles.md` | `templates/docs/golden-principles.md` | 按 3c 流程生成 |
| `docs/decisions/README.md` | 下方占位内容 | |
| `docs/plans/README.md` | 下方占位内容 | |
| `docs/prds/README.md` | 下方占位内容 | |

占位 README 内容（一字不差）：

`docs/decisions/README.md`：

```markdown
# 设计决策（ADR）

一事一文件，文件名 `NNN-标题.md`（编号从 001 递增），模板见 coding-x 插件 `templates/docs/decision.md`。
```

`docs/plans/README.md`：

```markdown
# 实现计划

`/planning` 命令的产出目录。活跃与已完成计划共存，靠 frontmatter `status` 字段区分（active/done/superseded）。
```

`docs/prds/README.md`：

```markdown
# PRD

`prd-generate` skill 的产出目录，文件名 `prd-[feature-name].md`。
```

**frontmatter 规则**：`docs/` 下所有生成的 `.md`（README 占位除外）必须带统一 frontmatter——`title` 填文档标题、`status` 填 `active`、`updated` 填**当天日期**、`scope` 填 `root` 或子项目名。

### 3b. 子项目产物（仅 monorepo）

对每个已确认子项目 `<sub>`：

- `<sub>/AGENTS.md` ← `templates/AGENTS-sub.md`（薄索引；标题下方保留「先读根 AGENTS.md」声明，即模板前 3 行：标题 + 空行 + 该声明）
- `<sub>/docs/decisions/README.md`、`<sub>/docs/plans/README.md`、`<sub>/docs/prds/README.md`（同上占位内容）
- `<sub>/docs/architecture.md`：**仅当子项目达到规模阈值才生成**——源文件 > 20 个，或存在两层以上模块目录；拿不准时询问用户
- 在根 `AGENTS.md` 文档索引表中为该子项目加一行：`| 子项目 <sub> | \`<path>/AGENTS.md\` | {一句话} |`

**归属规则**（同时体现在 planning/prd-generate 指令中）：功能只涉及一个子项目 → 产物落 `<sub>/docs/`；跨子项目 → 落根 `docs/`。

### 3c. 黄金原则

1. 从阶段 2 的分析中提炼 **3–5 条候选原则**。每条必须：机械可判定（可翻译成 lint 的表述）+「为什么」+「怎么检查」。反例：「代码要整洁」。正例：「共享逻辑必须放 `src/utils/`，禁止在 feature 目录内复制辅助函数——检查方式：grep 重复函数签名」。
2. **向用户展示候选清单，请确认/修改/增删**，确认后写入。
3. 提炼不足 3 条时，用以下通用默认条目补足，并在条目末尾标注 **「（待人工确认）」**：
   - 提交前必须通过项目的类型检查与测试命令——为什么：坏提交污染主干；怎么检查：对应命令退出码为 0。
   - 禁止提交注释掉的死代码——为什么：死代码误导后续 agent；怎么检查：diff 中不出现成块注释掉的代码。
   - 新增外部依赖必须先在 `docs/decisions/` 登记一条 ADR——为什么：依赖是长期成本；怎么检查：lockfile 变更的提交必须同时触碰 `docs/decisions/`。

## 阶段 4：幂等保护

- 任何目标文件**已存在 → 跳过不覆盖**，列入报告「跳过清单」。
- 根 `AGENTS.md` 已存在且是旧版百科全书式（特征：含「项目结构」「代码模式」「测试」等完整章节正文，而非文档索引表）→ **不动原文件**，输出一份「建议手动合并」的差异说明：哪些章节建议下沉到 `docs/` 哪个文件、哪些内容保留为目录/硬约束。
- 只补缺失的文件/目录。

## 阶段 5：输出报告

```markdown
## docs/ 知识库已初始化

### 项目形态

{单项目 / monorepo（N 个子项目：…）}

### 生成清单

- {逐个文件路径}

### 跳过清单（已存在，未覆盖）

- {逐个文件路径，或「无」}
{如检测到旧版 AGENTS.md，在此附「建议手动合并」差异说明}

### 后续步骤

1. 审阅 `docs/golden-principles.md` 中标注「待人工确认」的条目
2. 补充 `docs/architecture.md` 中残留的 `{…}` 占位
3. 让 AGENTS.md 保持 ≤100 行：新增内容优先下沉 docs/，索引表加一行即可
```
````

- [ ] **Step 3: 删除旧模板**

```bash
git rm AGENTS-template.md
```

- [ ] **Step 4: 机械验证**

```bash
ls commands/ && grep -rn 'AGENTS-template' commands/ skills/ assets/ .claude-plugin/ .cursor-plugin/ .codex-plugin/ 2>/dev/null; grep -c 'init-rules' commands/init-docs.md
```
Expected: `commands/` 下为 `init-docs.md`、`planning.md`、`priming.md`（无 init-rules.md）；grep AGENTS-template 无输出（README 的引用留待 Task 6）；最后一个 grep 输出 `0`。

- [ ] **Step 5: Commit & push**

```bash
git add -A
git commit -m "feat!: replace /init-rules with /init-docs knowledge-base generator"
git push
```

---

### Task 3: `/planning` 产物收编到 `docs/plans/`

**Files:**
- Modify: `commands/planning.md:146-149`（计划模板头部加 frontmatter）
- Modify: `commands/planning.md:375-382`（输出格式：路径 + 归属规则）

**Interfaces:**
- Consumes: Global Constraints 的统一 frontmatter 与归属规则。
- Produces: `/planning` 产物落 `docs/plans/{name}.md`（monorepo 单子项目功能落 `<sub>/docs/plans/`），Task 7 验证。

- [ ] **Step 1: 计划模板头部加 frontmatter**

在 `commands/planning.md` 中找到（阶段 5 模板代码块开头）：

```markdown
```markdown
# 功能: <feature-name>
```

替换为：

```markdown
```markdown
---
title: <feature-name>
status: active
updated: <当天日期 YYYY-MM-DD>
scope: <root 或子项目名>
---

# 功能: <feature-name>
```

（即在模板正文最前面插入 frontmatter 块；`# 功能: <feature-name>` 行保留。）

- [ ] **Step 2: 重写「输出格式」节**

找到：

```markdown
**文件名**: `.agents/plans/{kebab-case-descriptive-name}.md`

- 将 `{kebab-case-descriptive-name}` 替换为简短且描述清晰的功能名
- 示例：`add-user-authentication.md`、`implement-search-api.md`、`refactor-database-layer.md`

**目录**：如果 `.agents/plans/` 不存在，则创建它
```

替换为：

```markdown
**文件名**: `docs/plans/{kebab-case-descriptive-name}.md`

- 将 `{kebab-case-descriptive-name}` 替换为简短且描述清晰的功能名
- 示例：`add-user-authentication.md`、`implement-search-api.md`、`refactor-database-layer.md`

**归属规则（monorepo）**：功能只涉及一个子项目 → 保存到 `<子项目>/docs/plans/`；跨子项目或单项目 → 保存到根 `docs/plans/`。

**frontmatter**：计划文件必须以上方模板中的 frontmatter 开头（title/status/updated/scope）；`status` 初始为 `active`，功能完成后改为 `done`。

**目录**：如果目标 `docs/plans/` 不存在，则创建它
```

- [ ] **Step 3: 机械验证**

```bash
grep -c '\.agents/plans' commands/planning.md; grep -n 'docs/plans' commands/planning.md | head -5; grep -n 'scope: <root' commands/planning.md
```
Expected: 第一个输出 `0`；后两个各有命中行。

- [ ] **Step 4: Commit & push**

```bash
git add commands/planning.md
git commit -m "feat!: /planning output moves to docs/plans/ with frontmatter + monorepo attribution"
git push
```

---

### Task 4: PRD 产物收编到 `docs/prds/`（prd-generate + prd-to-json）

**Files:**
- Modify: `skills/prd-generate/SKILL.md:17`、`269-274`（输出节）、`279-280`（示例头）、`382`（检查清单）
- Modify: `skills/prd-to-json/SKILL.md:14`（工作流程提示）

**Interfaces:**
- Consumes: 统一 frontmatter 与归属规则。
- Produces: PRD 落 `docs/prds/prd-[feature-name].md`；prd-to-json 知道去哪找 PRD（无硬依赖）。Task 7/8 验证。

- [ ] **Step 1: prd-generate 工作流程第 4 步**

找到：

```markdown
4. 保存到 `tasks/prd-[feature-name].md`
```

替换为：

```markdown
4. 保存到 `docs/prds/prd-[feature-name].md`（monorepo 中按归属规则可能是 `<子项目>/docs/prds/`）
```

- [ ] **Step 2: prd-generate「输出」节**

找到：

```markdown
## 输出

- **格式：** Markdown (`.md`)
- **位置：** `tasks/`
- **文件名：** `prd-[feature-name].md` (kebab-case)
```

替换为：

```markdown
## 输出

- **格式：** Markdown (`.md`)
- **位置：** `docs/prds/`（目录不存在则创建）
- **归属规则（monorepo）：** 功能只涉及一个子项目 → 保存到 `<子项目>/docs/prds/`；跨子项目或单项目 → 根 `docs/prds/`
- **文件名：** `prd-[feature-name].md` (kebab-case)
- **frontmatter：** 文件必须以统一 frontmatter 开头：

```yaml
---
title: "PRD: [Feature Name]"
status: active
updated: YYYY-MM-DD（当天日期）
scope: root 或子项目名
---
```
```

- [ ] **Step 3: prd-generate 示例头部加 frontmatter**

找到（PRD 示例代码块开头）：

```markdown
```markdown
# PRD: Task Priority System
```

替换为：

```markdown
```markdown
---
title: "PRD: Task Priority System"
status: active
updated: 2026-07-02
scope: root
---

# PRD: Task Priority System
```

- [ ] **Step 4: prd-generate 检查清单末条**

找到：

```markdown
- [ ] 已保存到 `tasks/prd-[feature-name].md`
```

替换为：

```markdown
- [ ] 文件以统一 frontmatter 开头（title/status/updated/scope）
- [ ] 已按归属规则保存到 `docs/prds/prd-[feature-name].md`（或 `<子项目>/docs/prds/`）
```

- [ ] **Step 5: prd-to-json 工作流程提示**

找到：

```markdown
获取 PRD（markdown 文件或文本）并将其转换为 ralph 目录中的 `prd.json` (保存到当前项目跟路径下/.workspace/prd.json)。
```

替换为：

```markdown
获取 PRD（markdown 文件或文本；PRD 通常位于 `docs/prds/`，monorepo 中也可能在 `<子项目>/docs/prds/`——但对来源路径无硬依赖，任何路径或直接粘贴的文本都可以）并将其转换为 `prd.json`（保存到当前项目根路径下 `.workspace/prd.json`）。
```

- [ ] **Step 6: 机械验证**

```bash
grep -c 'tasks/prd' skills/prd-generate/SKILL.md; grep -n 'docs/prds' skills/prd-generate/SKILL.md | head -5; grep -n 'docs/prds' skills/prd-to-json/SKILL.md
```
Expected: 第一个输出 `0`；后两个各有命中。

- [ ] **Step 7: Commit & push**

```bash
git add skills/prd-generate/SKILL.md skills/prd-to-json/SKILL.md
git commit -m "feat!: prd-generate output moves to docs/prds/; prd-to-json path hint"
git push
```

---

### Task 5: builder/validator 指令接线

**Files:**
- Modify: `assets/instructions/builder.md`（「整合 Patterns」节尾 + 「关于该项目的重要注意事项」节）
- Modify: `assets/instructions/validator.md`（「你能看到的信息」节后加背景阅读 + 「重要约束」加一条）

**Interfaces:**
- Consumes: 目标项目里由 `/init-docs` 生成的 `AGENTS.md`、`<sub>/AGENTS.md`、`docs/golden-principles.md`、`docs/architecture.md`（都可能不存在——指令必须写成条件式）。
- Produces: 引擎两个 agent 的新行为约定；构建时由 tsup onSuccess 原样拷入 dist（无需代码改动）。

- [ ] **Step 1: builder.md「整合 Patterns」节尾追加模式升格规则**

找到：

```markdown
只添加**通用且可重用**的 patterns，不要添加 story 特定的细节。
```

替换为：

```markdown
只添加**通用且可重用**的 patterns，不要添加 story 特定的细节。

**模式升格**：如果某条 pattern 已在 **≥2 个不同 story** 的「未来迭代的学习」中出现且依然成立，且项目存在 `docs/` 知识库，则将它升格为项目级文档：追加写入 `docs/architecture.md` 末尾的 `## 沉淀模式` 章节（该章节不存在则创建，条目带日期），并在 progress.md 原条目后标注 `[已升格 → docs/architecture.md]`。项目没有 `docs/architecture.md` 时跳过此步。已标注升格的条目不要重复升格。
```

- [ ] **Step 2: builder.md「关于该项目的重要注意事项」节改写**

找到：

```markdown
如果项目根路径下存在 `AGENTS.md`，先阅读它——这是整个项目的技术架构与开发指导说明（harness）。
```

替换为：

```markdown
如果项目根路径下存在 `AGENTS.md`，先阅读它——它是项目的目录式索引（定位、关键命令、文档索引、硬约束）。按其中的文档索引表，只读与当前 story 相关的 `docs/` 文档，不要全量阅读。

- **monorepo**：如果当前 story 涉及某个子项目，除根 `AGENTS.md` 外，必须同时阅读该子项目的 `<子项目>/AGENTS.md`（如存在）。
- **黄金原则**：如果存在 `docs/golden-principles.md`（含所涉子项目的），其中每条原则都是**强制规则**，实现与提交必须遵守；违反任何一条视为质量检查不通过。
```

- [ ] **Step 3: validator.md 加背景阅读节**

找到：

```markdown
## 你能看到的信息

你需要自己读取 `{{WORKSPACE}}/progress.md`，从最后一个进度 section 中找出刚完成的 story。
```

替换为：

```markdown
## 你能看到的信息

你需要自己读取 `{{WORKSPACE}}/progress.md`，从最后一个进度 section 中找出刚完成的 story。

## 背景阅读（可选）

如果项目根路径下存在 `AGENTS.md`，可先快速浏览它（以及 story 所涉子项目的 `<子项目>/AGENTS.md`），了解项目的运行命令与结构，帮助你更快执行验证（例如找到正确的 typecheck/test 命令与 dev server 启动方式）。**注意：它只是背景信息，不构成验收依据。**
```

- [ ] **Step 4: validator.md「重要约束」加一条**

找到：

```markdown
- 你只负责验证，不负责修复代码
```

替换为：

```markdown
- 你只负责验证，不负责修复代码
- 验收判定**只**以 prd.json 中该 story 的 acceptanceCriteria 为准；不得因 AGENTS.md、golden-principles 或代码风格/品味问题追加失败项
```

- [ ] **Step 5: 机械验证**

```bash
grep -n '沉淀模式\|golden-principles' assets/instructions/builder.md; grep -n '背景阅读\|acceptanceCriteria 为准' assets/instructions/validator.md; npm run build >/dev/null 2>&1 && grep -c '沉淀模式' dist/instructions/builder.md
```
Expected: builder 两处命中；validator 两处命中；最后输出 `1`（构建拷贝链路完好）。

- [ ] **Step 6: Commit & push**

```bash
git add assets/instructions/
git commit -m "feat: wire builder/validator to AGENTS.md + golden principles + pattern promotion"
git push
```

---

### Task 6: README 与 4 个插件清单更新

**Files:**
- Modify: `README.md:8`、`82`、`129-137`、`148`、`232`、`255-261`
- Modify: `.claude-plugin/plugin.json:4`、`.claude-plugin/marketplace.json:3`、`.cursor-plugin/plugin.json:4`、`.codex-plugin/plugin.json:4`（description 中 init-rules → init-docs）

**Interfaces:**
- Consumes: Task 2 确定的命令名 `/init-docs` 与 Task 1 的 `templates/` 结构。
- Produces: 对外文档与清单一致；Task 10 发布前的最后文案状态。

- [ ] **Step 1: README 逐处替换**

① 找到（line 8）：
```markdown
- **多工具插件** —— 提供 `prd-generate` / `prd-to-json` / `agent-browser` skills 和 `/priming` `/planning` `/init-rules` 命令，支持 Claude Code、Codex、Cursor 及通用 agent，帮你把需求拆解成可自动执行的 `prd.json`。
```
替换为：
```markdown
- **多工具插件** —— 提供 `prd-generate` / `prd-to-json` / `agent-browser` skills 和 `/priming` `/planning` `/init-docs` 命令，支持 Claude Code、Codex、Cursor 及通用 agent，帮你把需求拆解成可自动执行的 `prd.json`，并为项目生成 docs/ 知识库。
```

② 找到（line 82）：
```markdown
安装后即可使用 `/priming`、`/planning`、`/init-rules` 命令以及 `prd-generate` / `prd-to-json` / `agent-browser` skills。
```
替换为：
```markdown
安装后即可使用 `/priming`、`/planning`、`/init-docs` 命令以及 `prd-generate` / `prd-to-json` / `agent-browser` skills。
```

③ 找到（基本工作流程图，line 129-131）：
```markdown
需求  ──/planning────────────▶  实现计划
      ──prd-generate skill───▶  PRD
      ──prd-to-json skill────▶  .workspace/prd.json
```
替换为：
```markdown
需求  ──/planning────────────▶  实现计划（docs/plans/）
      ──prd-generate skill───▶  PRD（docs/prds/）
      ──prd-to-json skill────▶  .workspace/prd.json
```

④ 找到（line 148）：
```markdown
1. （可选）`/priming` 让 agent 先理解你的代码库；`/init-rules` 生成根目录 `AGENTS.md` 作为项目技术指南。
```
替换为：
```markdown
1. （可选）`/priming` 让 agent 先理解你的代码库；`/init-docs` 生成目录式根 `AGENTS.md` + `docs/` 知识库（架构地图、黄金原则、decisions/plans/prds），单项目与 monorepo 均支持。
```

⑤ 找到（命令表，line 232）：
```markdown
| `/init-rules` | 分析代码库并提取模式，生成全局规则文件 `AGENTS.md` |
```
替换为：
```markdown
| `/init-docs` | 分析代码库，生成目录式 `AGENTS.md` 与 `docs/` 知识库（含黄金原则），支持 monorepo |
```

⑥ 找到（目录结构，line 255-261）：
```markdown
├── commands/                     # 唯一源：用户 /斜杠命令
│   ├── priming.md
│   ├── planning.md
│   └── init-rules.md
├── AGENTS-template.md            # 项目级 AGENTS.md 模板（init-rules 引用）
```
替换为：
```markdown
├── commands/                     # 唯一源：用户 /斜杠命令
│   ├── priming.md
│   ├── planning.md
│   └── init-docs.md
├── templates/                    # /init-docs 使用的知识库模板
│   ├── AGENTS-root.md            #   目录式根 AGENTS.md（四段式）
│   ├── AGENTS-sub.md             #   子项目薄 AGENTS.md
│   └── docs/                     #   architecture / golden-principles / decision(ADR)
```

- [ ] **Step 2: 4 个清单 description 替换**

`.claude-plugin/plugin.json` 与 `.codex-plugin/plugin.json`，找到：
```json
  "description": "Ralph auto-coding workflow: prd-generate/prd-to-json/agent-browser skills + priming/planning/init-rules commands. Run the engine via `npx coding-x`.",
```
替换为：
```json
  "description": "Ralph auto-coding workflow: prd-generate/prd-to-json/agent-browser skills + priming/planning/init-docs commands. Run the engine via `npx coding-x`.",
```

`.cursor-plugin/plugin.json`，找到：
```json
  "description": "Ralph auto-coding workflow: prd-generate/prd-to-json/agent-browser skills + priming/planning/init-rules commands",
```
替换为：
```json
  "description": "Ralph auto-coding workflow: prd-generate/prd-to-json/agent-browser skills + priming/planning/init-docs commands",
```

`.claude-plugin/marketplace.json`，找到：
```json
  "description": "Ralph 自动化 Coding 工作流：prd-generate/prd-to-json/agent-browser skills + priming/planning/init-rules 命令，配合 npx coding-x 引擎。",
```
替换为：
```json
  "description": "Ralph 自动化 Coding 工作流：prd-generate/prd-to-json/agent-browser skills + priming/planning/init-docs 命令 + docs/ 知识库生成，配合 npx coding-x 引擎。",
```

- [ ] **Step 3: 机械验证**

```bash
grep -rn 'init-rules\|AGENTS-template' README.md .claude-plugin/ .cursor-plugin/ .codex-plugin/ .agents/ commands/ skills/ assets/ templates/ 2>/dev/null
```
Expected: 无输出（仓库中除 docs/superpowers/ 历史文档外不再有任何 init-rules / AGENTS-template 引用）。

- [ ] **Step 4: Commit & push**

```bash
git add README.md .claude-plugin/ .cursor-plugin/ .codex-plugin/
git commit -m "docs: update README and plugin manifests for /init-docs"
git push
```

---

### Task 7: 验收运行 1 —— throwaway 单项目（幂等 + planning/prd 新路径）

**Files:**
- 仓库内无预期改动；仅当发现指令缺陷时 Modify 对应命令/模板文件并提交 fix。
- 运行场地：`/tmp/kb-accept-single`（用后即删）

**Interfaces:**
- Consumes: Task 1–6 的全部产物；执行者**扮演 `/init-docs` 命令本身**——逐字按 `commands/init-docs.md` 阶段 1–5 操作，模板取自本仓库 `templates/`。
- Produces: 验收记录（通过/缺陷清单）；如有缺陷，产出修复提交。

- [ ] **Step 1: 搭建 throwaway 单项目**

```bash
rm -rf /tmp/kb-accept-single && mkdir -p /tmp/kb-accept-single/src && cd /tmp/kb-accept-single && git init -q
cat > package.json <<'EOF'
{
  "name": "kb-accept-single",
  "version": "0.0.1",
  "type": "module",
  "scripts": { "test": "node --test", "typecheck": "echo typecheck-ok" }
}
EOF
printf 'export const add = (a, b) => a + b;\n' > src/index.js
printf 'export const mul = (a, b) => a * b;\n' > src/math.js
```

- [ ] **Step 2: 首次运行 `/init-docs` 流程**

在 `/tmp/kb-accept-single` 中，严格按 `commands/init-docs.md` 阶段 1–5 执行（阶段 1 应探测不到子项目 → 单项目路径；阶段 3c 代码库太小提炼不足 3 条 → 用默认条目补足并标注「待人工确认」；「向用户确认」步骤由执行者自演确认默认清单）。

- [ ] **Step 3: 验证产物清单**

```bash
cd /tmp/kb-accept-single && ls AGENTS.md docs/architecture.md docs/golden-principles.md docs/decisions/README.md docs/plans/README.md docs/prds/README.md && wc -l < AGENTS.md
```
Expected: 6 个文件都存在；AGENTS.md 行数 ≤ 100。

```bash
head -6 docs/architecture.md && head -6 docs/golden-principles.md
```
Expected: 两文件都以 `---` 开头，含 `title:`、`status: active`、`updated: 2026-`、`scope: root`。

人工核对：AGENTS.md 含四段（项目定位＋技术栈表 / 关键命令 / 文档索引表 / 硬约束）；golden-principles 有 3–5 条，每条含「为什么」「怎么检查」，默认补足条目带「待人工确认」。

- [ ] **Step 4: 二次运行验证幂等**

重复 Step 2 的阶段 3–5。Expected: 生成清单为空，跳过清单列出全部 6 个文件，任何文件内容无变化（`git -C /tmp/kb-accept-single status` 前后对比或对文件取 md5 对比）。

- [ ] **Step 5: 验证 planning 与 prd-generate 新路径**

在同一 throwaway 项目中：
1. 按 `skills/prd-generate/SKILL.md` 的输出规则为一个微功能（如「给 add 加上参数校验」）生成最小 PRD → Expected: 文件落 `docs/prds/prd-add-validation.md`，以 frontmatter 开头（title/status/updated/scope: root）。
2. 按 `commands/planning.md` 的「输出格式」节生成一份最小计划文件 → Expected: 落 `docs/plans/add-validation.md`，以 frontmatter 开头。

- [ ] **Step 6: 缺陷处理与收尾**

发现任何指令歧义/缺失（例如模板占位没有说明如何替换、报告格式无法照做），回本仓库修复对应文件并提交：

```bash
cd /Users/xinzz/Documents/_workspace/coding/coding-engine
git add <修复的文件> && git commit -m "fix: <具体缺陷> found in single-project acceptance" && git push
```

清理：`rm -rf /tmp/kb-accept-single`。

---

### Task 8: 验收运行 2 —— throwaway monorepo（探测 + 归属 + 阈值）

**Files:**
- 仓库内无预期改动；发现缺陷时同 Task 7 修复提交。
- 运行场地：`/tmp/kb-accept-mono`（用后即删）

**Interfaces:**
- Consumes: 同 Task 7；重点行使 `commands/init-docs.md` 阶段 1 探测、3b 子项目产物与 architecture.md 阈值、归属规则。
- Produces: monorepo 验收记录；缺陷修复提交。

- [ ] **Step 1: 搭建 throwaway monorepo（pnpm workspaces，两个子包）**

```bash
rm -rf /tmp/kb-accept-mono && mkdir -p /tmp/kb-accept-mono/packages/app/src/services /tmp/kb-accept-mono/packages/lib/src && cd /tmp/kb-accept-mono && git init -q
cat > package.json <<'EOF'
{ "name": "kb-accept-mono", "private": true }
EOF
cat > pnpm-workspace.yaml <<'EOF'
packages:
  - "packages/*"
EOF
cat > packages/app/package.json <<'EOF'
{ "name": "@kb/app", "version": "0.0.1" }
EOF
for i in $(seq 1 21); do printf 'export const f%s = () => %s;\n' "$i" "$i" > "packages/app/src/services/f$i.js"; done
cat > packages/lib/package.json <<'EOF'
{ "name": "@kb/lib", "version": "0.0.1" }
EOF
printf 'export const id = (x) => x;\n' > packages/lib/src/index.js
```

- [ ] **Step 2: 运行 `/init-docs` 流程**

严格按 `commands/init-docs.md` 执行。Expected 关键行为：
- 阶段 1 经 `pnpm-workspace.yaml` 探测出 `packages/app`、`packages/lib` 两个子项目（执行者自演确认）。
- 阶段 3b：`packages/app` 源文件 21 个 > 20 → 生成 `packages/app/docs/architecture.md`；`packages/lib` 仅 1 个源文件 → **不**生成 architecture.md。

- [ ] **Step 3: 验证产物**

```bash
cd /tmp/kb-accept-mono
ls AGENTS.md docs/architecture.md docs/golden-principles.md docs/decisions/README.md docs/plans/README.md docs/prds/README.md
ls packages/app/AGENTS.md packages/app/docs/architecture.md packages/app/docs/decisions/README.md packages/app/docs/plans/README.md packages/app/docs/prds/README.md
ls packages/lib/AGENTS.md packages/lib/docs/decisions/README.md packages/lib/docs/plans/README.md packages/lib/docs/prds/README.md
test ! -e packages/lib/docs/architecture.md && echo "lib-no-arch: OK"
head -3 packages/app/AGENTS.md
grep -n 'scope: ' packages/app/docs/architecture.md
grep -n '子项目' AGENTS.md
```
Expected: 前三组 ls 全部存在；`lib-no-arch: OK`；app 的 AGENTS.md 前 3 行内含「先读根目录 `AGENTS.md`」声明；app 的 architecture.md frontmatter `scope:` 为子项目名（如 `app` 或 `@kb/app`，与根 AGENTS.md 索引一致即可）；根 AGENTS.md 文档索引表含两行子项目条目。

- [ ] **Step 4: 验证归属规则**

1. 模拟「只涉及 @kb/app 的功能」按 prd-generate 输出规则生成最小 PRD → Expected: 落 `packages/app/docs/prds/`，frontmatter `scope:` 为子项目名。
2. 模拟「跨 app+lib 的功能」→ Expected: 落根 `docs/prds/`，`scope: root`。

- [ ] **Step 5: 缺陷处理与收尾**

同 Task 7 Step 6：缺陷回仓库修复、提交 `fix: <缺陷> found in monorepo acceptance`、push；清理 `rm -rf /tmp/kb-accept-mono`。

---

### Task 9: Dogfood —— 在 coding-engine 仓库运行 `/init-docs`

**Files:**
- Create: `AGENTS.md`（仓库根）
- Create: `docs/architecture.md`、`docs/golden-principles.md`
- Create: `docs/decisions/README.md`、`docs/plans/README.md`、`docs/prds/README.md`

**Interfaces:**
- Consumes: `commands/init-docs.md` 流程 + `templates/`；本仓库真实结构（README「目录结构详细说明」为分析基准）。
- Produces: 本仓库自己的知识库，提交入库；AGENTS.md 索引表必须收录既有 `docs/superpowers/` 的 specs/plans。

- [ ] **Step 1: 按 `/init-docs` 流程在本仓库执行（单项目形态）**

阶段 1 预期：根 package.json 无 workspaces、无 pnpm-workspace.yaml → 单项目。阶段 4 预期：无既有 AGENTS.md（`AGENTS-template.md` 已在 Task 2 删除）→ 全量生成。以下 Step 2–4 给出各产物的**基准内容**——以真实分析结果为准做微调，但结构、索引行与硬约束条目不得缺失。

- [ ] **Step 2: 写 `AGENTS.md`（基准内容，≤100 行）**

````markdown
# AGENTS.md

<!-- 目录式索引，不是手册：全文 ≤100 行。细节一律下沉 docs/，这里只负责「告诉你去哪找」。 -->

## 项目定位

coding-x：Ralph 自动化编码 harness——把 Developer → Validator 循环固化成确定性程序。同一仓库既是 npm 包（TS 引擎，`npx coding-x`），也是多工具插件（skills + commands）。

| 层 | 技术 |
|---|---|
| 语言/运行时 | TypeScript（strict, ESM）/ Node ≥18 |
| 构建/开发 | tsup / tsx |
| 测试 | Vitest |
| 引擎依赖 | jsonrepair |

## 关键命令

```bash
npm run dev         # tsx 直接运行 CLI
npm run build       # tsup 打包到 dist/（onSuccess 拷贝 assets）
npm test            # Vitest
npm run typecheck   # tsc --noEmit
```

## 文档索引

| 主题 | 路径 | 说明 |
|---|---|---|
| 架构地图 | `docs/architecture.md` | 引擎/插件双形态、模块划分、数据流、依赖方向 |
| 黄金原则 | `docs/golden-principles.md` | 机械可判定的强制规则 |
| 设计决策 | `docs/decisions/` | ADR：一事一文件，编号递增 |
| 实现计划 | `docs/plans/` | /planning 产出 |
| PRD | `docs/prds/` | prd-generate 产出 |
| 功能设计文档 | `docs/superpowers/specs/` | brainstorming 产出的设计规格 |
| 实施任务计划 | `docs/superpowers/plans/` | writing-plans 产出的分任务计划 |
| 用户文档 | `README.md` | 安装、快速开始、CLI 参数、目录结构 |

## 硬约束

1. 提交前必须通过 `npm run typecheck` 与 `npm test`
2. `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）
3. `skills/`、`commands/` 是唯一源：各工具清单只指回，不复制内容
4. 引擎运行时状态只读写 `--workspace` 目录（默认 `.workspace/`）
5. 面向用户的破坏性变更（命令改名、产物路径）必须升 minor 版本并同步 README
````

- [ ] **Step 3: 写 `docs/architecture.md`（基准内容）**

````markdown
---
title: 架构地图
status: active
updated: 2026-07-02
scope: root
---

# 架构地图

## 双形态

同一仓库两条产品线，互不依赖：

- **npm 引擎**：`src/` → tsup → `dist/`，`npx coding-x` 运行 Developer ⇄ Validator 循环
- **多工具插件**：根 `skills/`、`commands/` 为唯一源，`.claude-plugin/`、`.cursor-plugin/`、`.codex-plugin/`、`.agents/` 各放一个瘦清单指回

## 模块划分

| 模块 | 路径 | 职责 |
|---|---|---|
| CLI 入口 | `src/cli.ts` | 参数解析、启动循环与仪表盘 |
| 主循环 | `src/engine/loop.ts` | Developer ⇄ Validator 迭代、完成判定 |
| Agent 进程 | `src/engine/agent.ts` | 拉起 claude/codex 子进程、超时控制 |
| PRD 读写 | `src/engine/prd.ts` | 读 prd.json、选 story、完成判定 |
| 进度 | `src/engine/progress.ts` | 读取 progress.md |
| 修复 | `src/engine/repair.ts` | jsonrepair 修复 prd.json |
| 仪表盘 | `src/dashboard/server.ts` | HTTP 服务（:7331）+ 自动开浏览器 |
| 引擎指令 | `assets/instructions/` | builder.md / validator.md（{{WORKSPACE}} 占位符） |
| 知识库模板 | `templates/` | /init-docs 使用的 AGENTS/docs 模板 |

## 分层与依赖方向

cli → engine（loop → agent / prd / progress / repair）；dashboard 只读引擎状态，engine 不依赖 dashboard。`assets/` 构建时拷进 `dist/`，引擎经 `import.meta.url` 定位读取；`templates/`、`skills/`、`commands/` 只随插件仓库分发，引擎不读。

## 数据流

`.workspace/` 里两份文件贯穿全程：`prd.json`（需求+状态）与 `progress.md`（日志+学习）。builder 实现单个 story 并更新两者 → validator 逐条核对 acceptanceCriteria 并回写 passes/notes/retryCount/blocked → 循环直到全部 passes 或 blocked。

## 测试

Vitest，测试与源码同目录（`*.test.ts`）；`src/engine/__fixtures__/fake-agent.mjs` 模拟 agent 子进程。
````

- [ ] **Step 4: 写 `docs/golden-principles.md`（基准内容）+ 3 个 README 占位**

````markdown
---
title: 黄金原则
status: active
updated: 2026-07-02
scope: root
---

# 黄金原则

## 1. 提交前必须通过 `npm run typecheck` 与 `npm test`

- **为什么**：CI 只在发布 tag 时跑检查，平时直接提交 main，坏提交会直接污染主干。
- **怎么检查**：两条命令退出码为 0。

## 2. `src/` 内相对导入必须带 `.js` 扩展名

- **为什么**：ESM/NodeNext 解析要求，漏写会让构建产物运行时报错。
- **怎么检查**：`npm run typecheck` 通过（NodeNext 下漏扩展名直接报错）。

## 3. `skills/`、`commands/` 内容只存一份

- **为什么**：多工具清单靠相对路径指回唯一源，复制副本会立刻漂移。
- **怎么检查**：`.cursor-plugin/`、`.codex-plugin/`、`.agents/` 下只有 json 清单，`find` 不到任何 `.md`。

## 4. 引擎运行时状态只读写 workspace 目录

- **为什么**：状态散落会让循环不可恢复、无法归档。
- **怎么检查**：`src/` 中所有文件写入路径都由 `--workspace` 解析而来（review `writeFile`/`appendFile` 调用点）。

## 5. 面向用户的破坏性变更必须升 minor 版本并同步 README

- **为什么**：插件被外部安装，命令改名/产物路径变更会静默破坏用户工作流。
- **怎么检查**：diff 触碰 `commands/` 文件名或产物路径时，`package.json` minor 位 +1 且 README 命令表已更新。
````

3 个 README 占位使用 Task 2 命令文档「阶段 3a」中的一字不差内容，分别写入 `docs/decisions/README.md`、`docs/plans/README.md`、`docs/prds/README.md`。

- [ ] **Step 5: 机械验证**

```bash
wc -l < AGENTS.md
ls docs/architecture.md docs/golden-principles.md docs/decisions/README.md docs/plans/README.md docs/prds/README.md
grep -n 'superpowers' AGENTS.md
head -6 docs/architecture.md
npm run typecheck && npm test
```
Expected: AGENTS.md ≤100 行；5 个文件存在；索引表含 `docs/superpowers/specs/`、`docs/superpowers/plans/` 两行；frontmatter 完整；typecheck/test 通过（确认零代码影响）。

- [ ] **Step 6: Commit & push**

```bash
git add AGENTS.md docs/
git commit -m "docs: dogfood /init-docs on coding-engine (AGENTS.md + docs/ knowledge base)"
git push
```

---

### Task 10: 发布 0.2.0

**Files:**
- Modify: `package.json`（version 0.1.4 → 0.2.0）
- Modify: `.claude-plugin/plugin.json`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`（version 0.1.0 → 0.2.0）

**Interfaces:**
- Consumes: Task 1–9 全部完成且已 push。
- Produces: tag `v0.2.0` → GitHub Actions（`.github/workflows/publish.yml`）自动 typecheck→test→build→npm publish→GitHub Release。**注意 CI 防呆：tag 必须与 package.json version 完全一致。**

- [ ] **Step 1: 四处版本号改为 0.2.0**

`package.json` 找到 `"version": "0.1.4",` 替换为 `"version": "0.2.0",`。
三个 plugin.json 各找到 `"version": "0.1.0",` 替换为 `"version": "0.2.0",`。

- [ ] **Step 2: 本地跑一遍 CI 同款检查**

```bash
npm run typecheck && npm test && npm run build
```
Expected: 全部通过（发布是外发动作，先在本地确认绿灯）。

- [ ] **Step 3: 提交、打 tag、push（触发发布）**

```bash
git add package.json .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex-plugin/plugin.json
git commit -m "release: v0.2.0"
git tag v0.2.0
git push && git push origin v0.2.0
```

- [ ] **Step 4: 验证发布结果**

```bash
gh run watch --exit-status $(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId') || gh run list --workflow=publish.yml --limit 1
npm view coding-x version
```
Expected: workflow 成功；`npm view coding-x version` 输出 `0.2.0`（npm 传播可能有几分钟延迟，失败则稍后重试一次）。

---

## 备注（设计说明，供评审确认）

计划相对设计文档做了 3 处解释性决策，均已体现在上述任务中：

1. **AGENTS.md 不带 YAML frontmatter**。设计文档 §3.4 说「所有生成的知识库文档统一携带 frontmatter」，但 §3.3 对 AGENTS.md 的四段式定义不含 frontmatter，且 AGENTS.md 有 ≤100 行硬预算、是各工具直读的约定文件。故 frontmatter 只落在 `docs/` 下的文档；AGENTS.md 保持通用形态。
2. **builder 模式升格的落点是 `docs/architecture.md` 的「沉淀模式」章节**。设计文档 §5 只说「升格写入 docs/」未指明文件。黄金原则定位为「用户确认的有主见规则」，不宜由 agent 自主追加，故升格目标选 architecture.md 附录章节（机械、可追加、带日期）。
3. **4 个插件清单的 description 更新**不在设计文档 §5 清单内，但其中的 `init-rules` 字样随改名必须同步（grep 已确认仅 description 字段涉及）。

## 执行提示

- Task 7/8 的「向用户确认」环节由执行者自演（确认默认清单即可），因为验收对象是**指令是否可照做**，不是交互体验。
- Task 7/8 若发现指令缺陷，修复提交后需重跑该验收任务对应步骤，直到一次通过。
- 全程不得改动 `src/`；若发现看似需要改引擎才能满足设计，停下来向用户报告而不是改代码。
