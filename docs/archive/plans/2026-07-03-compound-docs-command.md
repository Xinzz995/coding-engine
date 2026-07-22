---
title: "/compound-docs 收口命令实施计划"
status: done
updated: 2026-07-06
scope: root
---

# /compound-docs 收口命令实施计划

> **For agentic workers:** Execute this plan task by task using the available agent workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 新增第四个 command `/compound-docs`——一轮循环/功能分支收口时把 progress.md 与 git 历史中的经验提炼、验证、分层沉淀回项目文档；同时收编 builder 内联升格、引擎完成时打印收口提示、init-docs 体系新增 `docs/patterns.md` 落点。

**Architecture:** command 是纯 markdown 工作流（`commands/compound-docs.md`，引擎不执行）；引擎唯一改动是 `loop.ts` 完成分支加一行提示（TDD）；builder.md 删「模式升格」「升格防污染」两段（升格只在收口发生）；`templates/docs/patterns.md` 新模板随 `/init-docs` 生成，作为约定+陷阱的落点。

**Tech Stack:** TypeScript（strict, ESM）/ Node ≥18 / Vitest / tsup。command 与模板为纯 markdown。

**Spec:** `docs/specs/2026-07-03-compound-docs-command-design.md`（已批准，决策以它为准）

## Global Constraints

- 提交前必须通过 `npm run typecheck` 与 `npm test`（仓库硬约束 1）
- `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）（硬约束 2）
- 提交说明必须用中文，conventional 前缀（feat:/fix:/docs: 等）保留英文（硬约束 6）
- 面向用户的可见变更 → 版本升 minor 至 **0.6.0** 并同步 README（硬约束 5；本计划 Task 7）
- 引擎运行时状态只读写 `--workspace` 目录；本计划不改变该行为
- 防污染工具词表（全计划统一，出现即不入项目文档）：`.workspace/`、`{{WORKSPACE}}/`、`prd.json`、`state.json`、`progress.md`、`validator`、`agent-browser`、`coding-x`

---

### Task 1: init-docs 联动——patterns.md 模板 + 索引行 + 产物清单

**Files:**
- Create: `templates/docs/patterns.md`
- Modify: `templates/AGENTS-root.md`（文档索引表，第 33 行 PRD 行之后）
- Modify: `commands/init-docs.md`（3a 根产物表，第 58-64 行）

**Interfaces:**
- Consumes: 无（首个任务）
- Produces: `templates/docs/patterns.md` 模板文件——Task 2 的 command 兜底落位规则引用该模板骨架；`/init-docs` 生成体系从此含 patterns.md

- [ ] **Step 1: 创建 `templates/docs/patterns.md`**

内容一字不差（frontmatter 风格对齐 `templates/docs/architecture.md`）：

```markdown
---
title: 约定与陷阱
status: active
updated: {YYYY-MM-DD}
scope: {root 或子项目名}
---

# 约定与陷阱

<!-- /compound-docs 收口沉淀的落点：稳定开发约定 + 高频陷阱。条目短、可验证、带日期；结构性知识不放这里（去 architecture.md）。 -->

## 约定

<!-- 多个 story 反复出现、未来会复用的稳定开发写法 -->

- {YYYY-MM-DD} {如：共享逻辑统一放 `src/utils/`，feature 目录内禁止复制辅助函数}

## 陷阱

<!-- 容易再次踩、与本项目框架/数据边界/路由方式强相关的坑 -->

- {YYYY-MM-DD} {如：更改 X 时必须同步更新 Y，否则 Z 失效}
```

- [ ] **Step 2: `templates/AGENTS-root.md` 文档索引表加一行**

在第 33 行 `| PRD | \`docs/prds/\` | prd-generate 产出 |` 之后、第 34 行子项目占位行之前插入：

```markdown
| 约定与陷阱 | `docs/patterns.md` | /compound-docs 收口沉淀的稳定约定与高频陷阱 |
```

- [ ] **Step 3: `commands/init-docs.md` 3a 根产物表加一行**

在第 61 行 `| \`docs/golden-principles.md\` | ... |` 之后、第 62 行 `| \`docs/decisions/README.md\` | ... |` 之前插入：

```markdown
| `docs/patterns.md` | `templates/docs/patterns.md` | 约定与陷阱骨架（/compound-docs 收口的落点）；两章保留注释占位即可 |
```

- [ ] **Step 4: 验证**

Run: `ls templates/docs/patterns.md && grep -c "patterns.md" templates/AGENTS-root.md commands/init-docs.md`
Expected: 文件存在；AGENTS-root.md 计数 1；init-docs.md 计数 ≥1

Run: `npm run typecheck && npm test`
Expected: 均通过（本任务只动 markdown，作为回归确认）

- [ ] **Step 5: Commit**

```bash
git add templates/docs/patterns.md templates/AGENTS-root.md commands/init-docs.md
git commit -m "feat: init-docs 体系新增 docs/patterns.md 落点——约定与陷阱模板、索引行、产物清单"
```

---

### Task 2: 新 command `commands/compound-docs.md`

**Files:**
- Create: `commands/compound-docs.md`

**Interfaces:**
- Consumes: Task 1 的 `templates/docs/patterns.md`（兜底落位创建文件时的骨架来源）
- Produces: `/compound-docs` 命令本体——Task 3 的引擎提示文案、Task 5 的 README、Task 6 的 dogfood 都指向它

- [ ] **Step 1: 创建 `commands/compound-docs.md`**

内容一字不差：

````markdown
---
description: 一轮循环或功能分支收口时，把 progress.md 与 git 历史中的经验提炼、验证、分层沉淀回项目文档；只改文档不改代码
---

# 收口沉淀（复利文档回收）

一轮 run／功能分支的大部分或全部 story 完成后，把已经落地的真实结构变化、稳定约定、系统边界和高频陷阱，沉淀回项目文档，让下一轮 AI Coding 更准。这不是功能开发命令：**只允许修改文档文件**。

## 何时使用

- 引擎循环全部 story 通过后（引擎会提示运行本命令）
- 功能分支收口、准备合并时
- 积累了一批 commit，目录结构或开发约定发生了真实变化

不要用于：单个 story 实现中、纯代码修复/联调/发布、只想更新 PRD 或进度日志。

## 硬性约束

1. 只允许修改文档文件；禁止修改业务代码、脚本、配置、测试
2. 项目文档中禁止出现 harness 工具细节——凡提及 `.workspace/`、`prd.json`、`state.json`、`progress.md`、validator、agent-browser、coding-x 等工具词的条目一律不写入（工具知识只留在 `.workspace/progress.md`）
3. 只沉淀「项目相关、可复用、当前代码仍然成立」的知识
4. 当前代码状态与历史记录冲突时，以当前代码状态为准
5. 证据不足，宁可不写
6. 最小修改：优先补充/修正/去重，不重写整份文档，保持现有风格与章节层级；一条经验只写一次、写到最合适的位置

## 事实优先级

按此顺序判断事实（高优先级覆盖低优先级）：

1. 当前分支真实代码与目录结构
2. 当前分支相对默认分支的 git diff / git log
3. `.workspace/progress.md` 的 `## Codebase Patterns` 与各 story 的「未来迭代的学习」
4. `.workspace/prd.json` 的交付范围说明（只用于理解「这轮做了什么」，不是事实来源）

progress.md 里写了但当前代码已不再体现的经验，不沉淀。

## 工作流程

### 1. 建立范围

- 读 `.workspace/prd.json`：branchName、交付范围（顶层 `sourcePrd` 存在时可读源 PRD 补背景）
- 读 `.workspace/state.json`：哪些 story 已 `passes`（本轮实际完成范围）
- git 取证基线：

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
MERGE_BASE=$(git merge-base HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null || git merge-base HEAD "$DEFAULT_BRANCH")
git log --reverse --oneline "$MERGE_BASE"..HEAD
git diff --name-status "$MERGE_BASE"..HEAD
```

**降级规则**：非 git 仓库或 merge-base 失败（如就在默认分支上且无分叉）→ 改用近期提交（`git log --oneline -30`）或跳过 git 取证，只基于 progress.md + 当前代码，并在交付说明中注明；`.workspace/` 或 progress.md 缺失 → 提示用户先跑引擎循环，本次只做纯 git + 代码取证（价值有限，如实说明）。

### 2. 交叉取证

四路对照：当前代码结构 ⨯ git log/diff ⨯ progress.md ⨯ prd.json 交付说明。逐条核对候选经验在当前代码中是否仍然成立（结构是否还在、约定是否还被遵守）。

### 3. 提炼（归纳而不是抄录）

只保留四类：

- 目录结构已真实变化、未来必须知道的新入口/新模块/归属
- 多个 story 反复出现、未来会复用的稳定开发约定
- 容易再次踩、与本项目框架/数据边界/路由方式强相关的陷阱
- 影响 AI 编码正确性的系统边界、跨项目协作边界、公开接口边界

排除：story 编号与修复经过、过程叙事、一次性事故、临时占位、执行环境信息（「需手动验证」类）、已在现有文档准确表达的内容。

每条候选自问四题：当前代码仍成立？是项目知识而非自动化工具知识？未来会再遇到？该落在哪一层文档？

### 4. 落位

**第一优先——动态发现**：读目标项目根 `AGENTS.md` 的文档索引表，按它声明的结构落位。AGENTS.md 是入口和索引，与你预想的目录结构不同时，服从 AGENTS.md。

- monorepo：子项目内部知识落该子项目的 `AGENTS.md`/docs（存在时）；跨子项目集成边界落根级架构文档
- 根 `AGENTS.md` 只允许更新仓库级导航/硬约束，不堆子项目细节

**兜底——init-docs 两层默认体系**（无 AGENTS.md 或无文档索引时）：

| 知识类型 | 落点 | 方式 |
|---|---|---|
| 结构变化、模块归属、数据流 | `docs/architecture.md` | 就地更新对应章节（模块表加行、数据流改句），不做末尾追加 |
| 集成/接口边界 | `docs/architecture.md`（分层与依赖方向） | 就地更新 |
| 机械可判定的强制规则 | `docs/golden-principles.md` | 追加；保持 3–5 条精简，超出时提请用户取舍；该文件不存在时不自动创建，降级进 patterns.md |
| 稳定约定 + 高频陷阱 | `docs/patterns.md` | 分「约定」「陷阱」两章追加，条目带日期；文件不存在时按 coding-x 插件 `templates/docs/patterns.md` 骨架创建 |

三个落点文件都不存在且无 `AGENTS.md` 时：建议用户先跑 `/init-docs`，本次只输出候选清单，不写入。

**沉淀模式迁移（一次性自愈）**：若目标项目 `docs/architecture.md` 存在旧的 `## 沉淀模式` 章节（来自旧版 builder 内联升格），把其中条目按上表重新落位（多数进 patterns.md），然后删除该章节。

### 5. 写入

按落位结果最小修改。写作要求：条目短、信息密度高、可验证；用项目语言描述，不提自动化流水线；优先描述稳定模式与边界，不写过程叙事。

### 6. 交付说明

完成后简短汇报：更新了哪些文档、每份补了什么类型的信息、明确排除了哪些不该沉淀的内容（及排除理由）。

## 执行模式

默认直接执行文档更新。用户要求「先分析」时，先输出：候选沉淀项、对应写入文件、不建议写入的内容，获确认后再改。
````

- [ ] **Step 2: 验证内容完整性**

Run: `grep -c "事实优先级\|防污染\|沉淀模式迁移\|降级规则\|执行模式" commands/compound-docs.md ; head -3 commands/compound-docs.md`
Expected: 关键章节均命中（计数 ≥5）；frontmatter 首行为 `---` 且含 `description:`

说明：防污染约束在「硬性约束」第 2 条——grep `禁止出现 harness 工具细节` 应命中。

- [ ] **Step 3: Commit**

```bash
git add commands/compound-docs.md
git commit -m "feat: 新增 /compound-docs 收口命令——经验提炼、交叉取证、动态落位、防污染"
```

---

### Task 3: 引擎完成提示（TDD）

**Files:**
- Modify: `src/engine/loop.ts:114-118`（完成分支）
- Test: `src/engine/loop.test.ts`（`describe('runLoop')` 块内新增测试）

**Interfaces:**
- Consumes: Task 2 的命令名 `/compound-docs`（文案引用）
- Produces: 完成路径 stdout 含 `/compound-docs` 提示——Task 6 dogfood 时可见

- [ ] **Step 1: 写失败测试**

在 `src/engine/loop.test.ts` 的 `describe('runLoop', () => {` 块内、第一个测试（`returns 0 when all stories are already resolved after one pass`，第 29-47 行）之后新增（沿用该文件手工 fake agent 模式，不引入 vi mock）：

```typescript
  it('prints a /compound-docs hint when all stories resolve', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes('/compound-docs'))).toBe(true);
    } finally {
      console.log = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts -t "compound-docs" 2>&1 | tail -5`
Expected: FAIL——`expect(logs.some(...)).toBe(true)` 断言失败（提示行尚未实现）

- [ ] **Step 3: 实现**

`src/engine/loop.ts` 完成分支（当前第 114-118 行）：

```typescript
      if (after && afterState && allStoriesResolved(after, afterState)) {
        dashboard.setState({ phase: 'done' });
        console.log('\n💡 全部 story 已通过。建议运行 /compound-docs 把本轮经验沉淀进项目文档。');
        exitCode = 0;
        break;
      }
```

（唯一改动是插入 `console.log` 一行；前后行保持原样。）

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts 2>&1 | tail -5`
Expected: 该文件全部测试 PASS（新测试通过，原有测试不受影响）

- [ ] **Step 5: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 均通过（52 + 1 = 53 个测试全绿；若基数有出入以全绿为准）

- [ ] **Step 6: Commit**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: 循环全部通过时提示运行 /compound-docs 收口沉淀"
```

---

### Task 4: builder.md 收编——删除内联升格两段

**Files:**
- Modify: `assets/instructions/builder.md:50-54`

**Interfaces:**
- Consumes: Task 2 已提供替代通道（升格只在收口发生）——删除顺序上必须在 Task 2 之后执行，避免升格通道真空
- Produces: builder 只整合 pattern 进 progress.md、不再写 docs/——Task 6 dogfood 的前提

- [ ] **Step 1: 删除「模式升格」「升格防污染」两段**

`assets/instructions/builder.md` 第 50-54 行当前为：

```markdown
只添加**通用且可重用**的 patterns，不要添加 story 特定的细节。

**模式升格**：如果某条 pattern 已在 **≥2 个不同 story** 的「未来迭代的学习」中出现且依然成立，且项目存在 `docs/` 知识库，则将它升格为项目级文档：追加写入 `docs/architecture.md` 末尾的 `## 沉淀模式` 章节（该章节不存在则创建，条目带日期），并在 progress.md 中触发本次升格的最新一条该 pattern 记录后标注 `[已升格 → docs/architecture.md]`。项目没有 `docs/architecture.md` 时跳过此步。已标注升格的条目不要重复升格。

**升格防污染**：升格条目必须是项目自身的知识（框架用法、数据边界、目录约定等）。禁止把自动化 harness 的运行机制写入项目文档——凡提及 `{{WORKSPACE}}/`、`prd.json`、`state.json`、`progress.md`、validator、agent-browser 等工具词的 pattern 一律不升格，只留在 progress.md。
```

整块替换为（只保留首句，两段升格规则删除）：

```markdown
只添加**通用且可重用**的 patterns，不要添加 story 特定的细节。patterns 的升格与文档沉淀由收口命令统一处理，你不需要把它们写进项目 `docs/`。
```

- [ ] **Step 2: 验证删除干净且 dist 同步**

Run: `grep -c "模式升格\|升格防污染\|沉淀模式" assets/instructions/builder.md || echo "0 hits"`
Expected: `0 hits`

Run: `npm run build && grep -c "模式升格" dist/instructions/builder.md || echo "dist clean"`
Expected: 构建成功；`dist clean`（tsup onSuccess 已把新版拷入 dist/instructions）

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 均通过（loop.test.ts 等测试用假指令 fixture，与 builder.md 真实内容无耦合——上一轮已验证）

- [ ] **Step 4: Commit**

```bash
git add assets/instructions/builder.md
git commit -m "refactor: builder 指令收编内联模式升格——升格与防污染统一归 /compound-docs 收口"
```

---

### Task 5: README 与本仓库架构地图同步（七处）

**Files:**
- Modify: `README.md:8, 82, 129-138, 203 之后, 244-248, 272-279`
- Modify: `docs/architecture.md:30`（模块表「知识库模板」行）

**Interfaces:**
- Consumes: Task 2 的命令名与定位描述
- Produces: 用户文档完整反映新命令——Task 7 发版前提（硬约束 5）

- [ ] **Step 1: 第 8 行插件介绍句**

将 `` `/priming` `/planning` `/init-docs` 命令 `` 改为 `` `/priming` `/planning` `/init-docs` `/compound-docs` 命令 ``，并把句尾「并为项目生成 docs/ 知识库」扩为「并为项目生成与持续沉淀 docs/ 知识库」。

- [ ] **Step 2: 第 82 行安装说明**

将 `` 安装后即可使用 `/priming`、`/planning`、`/init-docs` 命令 `` 改为 `` 安装后即可使用 `/priming`、`/planning`、`/init-docs`、`/compound-docs` 命令 ``。

- [ ] **Step 3: 基本工作流程图（129-138 行）加收口环节**

图中 `Developer ⇄ Validator 循环（见「工作原理」）` 与 `http://localhost:7331` 之间的流向保持不变，在图末尾（`http://localhost:7331  实时查看进度` 行之后）追加两行：

```
                                │
              ──/compound-docs─▶  经验沉淀回 docs/（收口，可选）
```

- [ ] **Step 4: 使用教程新增「第 4 步」（第 203 行第 3 步内容之后、205 行 `### 命令行参数` 之前）**

```markdown
### 第 4 步：收口沉淀（可选）

循环全部 story 通过后（引擎会提示），回到 Claude Code 等工具运行 `/compound-docs`：它基于当前代码、git 历史与 `progress.md` 的学习记录做交叉取证，把仍然成立的结构变化、稳定约定与高频陷阱分层沉淀进项目 `docs/`（约定与陷阱进 `docs/patterns.md`）。只改文档不改代码，越用文档越准。
```

- [ ] **Step 5: 命令表（244-248 行）加一行**

在 `/planning` 行之后追加：

```markdown
| `/compound-docs` | 循环/分支收口时把经验提炼、验证、分层沉淀回项目文档（约定与陷阱进 `docs/patterns.md`）；只改文档不改代码 |
```

- [ ] **Step 6: 目录结构树（272-279 行）**

`commands/` 块内 `init-docs.md` 之后加 `│   └── compound-docs.md`（原 `└── init-docs.md` 改为 `├── init-docs.md`）；第 276 行 templates 注释 `# /init-docs 使用的知识库模板` 改为 `# /init-docs、/compound-docs 使用的知识库模板`；第 279 行 `#   architecture / golden-principles / decision(ADR)` 改为 `#   architecture / golden-principles / patterns / decision(ADR)`。

- [ ] **Step 7: 本仓库 `docs/architecture.md` 模块表同步**

第 30 行 `| 知识库模板 | \`templates/\` | /init-docs 使用的 AGENTS/docs 模板 |` 的说明改为 `/init-docs、/compound-docs 使用的 AGENTS/docs 模板`。

- [ ] **Step 8: 验证**

Run: `grep -c "compound-docs" README.md docs/architecture.md`
Expected: README ≥7；architecture.md ≥1

- [ ] **Step 9: Commit**

```bash
git add README.md docs/architecture.md
git commit -m "docs: README 与架构地图同步 /compound-docs——介绍、工作流程、教程第 4 步、命令表、目录树"
```

---

### Task 6: dogfood E2E——在本仓库跑一遍收口工作流

**Files:**
- Create: `docs/patterns.md`（由工作流按模板创建）
- Modify: `AGENTS.md`（文档索引表加 patterns.md 行）
- Modify: 视取证结果而定（可能就地更新 `docs/architecture.md`）

**Interfaces:**
- Consumes: Task 2 的 `commands/compound-docs.md`（逐字按它执行）、Task 1 的模板
- Produces: 验证过的工作流 + 本仓库首批沉淀内容——Task 7 发版的质量门

- [ ] **Step 1: 按 `commands/compound-docs.md` 的工作流在本仓库逐步执行一遍**

注意本仓库当前状态决定走哪些分支，预期路径：

- `.workspace/` 为空 → 触发命令的**降级规则**：提示信息 + 纯 git + 代码取证（这正是要验证的错误处理分支）
- 本仓库在 `main` 上、与默认分支无分叉 → merge-base 降级为 `git log --oneline -30` 近期取证（覆盖 0.5.x 系列提交）
- 本仓库有 `AGENTS.md` 且有文档索引 → 走**动态发现**落位（不是兜底）
- 候选沉淀源：近 30 条提交中的真实约定（如「src/ 相对导入必须 .js 扩展名」已在 AGENTS.md 硬约束——按排除标准「已在现有文档准确表达」跳过；寻找未记录的，如 state.json 形状校验/回退防复活的边界知识、三文件模型的就地更新点等）

验证点（流程性，不预设沉淀内容）：

1. 每一步指令可操作、无歧义（发现歧义 → 记录并回改 Task 2 的 command 文案）
2. 防污染门生效：候选条目含工具词的被正确排除
3. `docs/patterns.md` 按模板骨架创建，frontmatter 完整（title/status/updated/scope）
4. `AGENTS.md` 文档索引表新增 patterns.md 行（动态发现模式下命令应主动更新索引所在文件吗？——**不**：AGENTS.md 行属于「仓库级导航」允许更新；本步作为 dogfood 顺带完成 spec 6.4 的要求）
5. 交付说明输出三要素：更新了什么、补了什么类型、排除了什么

- [ ] **Step 2: 人工检查沉淀质量**

Run: `cat docs/patterns.md && git diff --stat`
Expected: 条目短、可验证、带日期；无工具词（`grep -c "workspace\|prd.json\|state.json\|progress.md\|validator" docs/patterns.md` → 0 hits）；改动只落文档文件

- [ ] **Step 3: 全量验证**

Run: `npm run typecheck && npm test`
Expected: 均通过（本任务只产文档）

- [ ] **Step 4: Commit**

```bash
git add docs/patterns.md AGENTS.md docs/
git commit -m "docs: dogfood /compound-docs——本仓库首次收口沉淀，patterns.md 建档并入索引"
```

---

### Task 7: 发版 0.6.0

**Files:**
- Modify: `package.json`（version 字段 `0.5.1` → `0.6.0`）

**Interfaces:**
- Consumes: Task 1-6 全部完成且提交
- Produces: npm 上可用的 coding-x@0.6.0

- [ ] **Step 1: 版本号**

`package.json` 的 `"version": "0.5.1"` 改为 `"version": "0.6.0"`。

- [ ] **Step 2: 发版前全量验证**

Run: `npm run typecheck && npm test && npm run build`
Expected: 全部通过；`dist/instructions/builder.md` 为收编后版本（`grep -c "模式升格" dist/instructions/builder.md` → 0 hits）

- [ ] **Step 3: Release commit + push + tag（CI 自动发布）**

本仓库发布走 CI：推 `vX.Y.Z` tag 触发 `.github/workflows/publish.yml`（typecheck→test→build→`npm publish --provenance`→GitHub Release）。不要本地 `npm publish`（npm 2FA 下 CLI 交互 OTP 不可用，CI 用 Automation token）。

```bash
git add package.json
git commit -m "release: v0.6.0"
git push
git tag v0.6.0 && git push origin v0.6.0
```

- [ ] **Step 4: 验证 CI 发布成功**

Run: `gh run watch --exit-status $(gh run list --workflow=publish.yml --limit 1 --json databaseId --jq '.[0].databaseId')`
Expected: workflow success

Run: `npm view coding-x version`
Expected: `0.6.0`

---

## 任务顺序与依赖

```
Task 1（模板落点） ─▶ Task 2（command 本体） ─▶ Task 3（引擎提示）
                                   │
                                   ├─▶ Task 4（builder 收编，必须在 Task 2 之后）
                                   ├─▶ Task 5（README）
                                   └─▶ Task 6（dogfood，需 1-5 全部就绪） ─▶ Task 7（发版）
```

Task 3/4/5 相互独立，可并行；Task 6 必须最后于它们，Task 7 收尾。
