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
| `CLAUDE.md` | 下方桥接内容 | Claude Code 只自动加载 CLAUDE.md、不加载 AGENTS.md；用 `@` 导入桥接 |
| `docs/architecture.md` | `templates/docs/architecture.md` | 填入模块表、分层、数据流、关键文件 |
| `docs/golden-principles.md` | `templates/docs/golden-principles.md` | 按 3c 流程生成 |
| `docs/patterns.md` | `templates/docs/patterns.md` | 约定与陷阱骨架（/compound-docs 收口的落点）；两章保留注释占位即可 |
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

`CLAUDE.md`（Claude Code 桥接，一字不差；不带 frontmatter）：

```markdown
@AGENTS.md

<!-- Claude Code 只自动加载 CLAUDE.md、不加载 AGENTS.md，上方 @ 导入把 AGENTS.md
     （跨工具知识库入口）带入 Claude Code 上下文。Claude Code 专属的补充指令写在
     本行以下；其余内容一律进 AGENTS.md 与 docs/，保持本文件极薄。 -->
```

**frontmatter 规则**：`docs/` 下所有生成的 `.md`（README 占位除外）必须带统一 frontmatter——`title` 填文档标题、`status` 填 `active`、`updated` 填**当天日期**、`scope` 填 `root` 或子项目名。

### 3b. 子项目产物（仅 monorepo）

对每个已确认子项目 `<sub>`：

- `<sub>/AGENTS.md` ← `templates/AGENTS-sub.md`（薄索引；标题下方保留「先读根 AGENTS.md」声明，即模板前 3 行：标题 + 空行 + 该声明）
- `<sub>/CLAUDE.md`：同根桥接内容（`@AGENTS.md` 为相对导入，指向本子项目的 AGENTS.md）
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
- 目标项目已有自己的 `CLAUDE.md` → 跳过不覆盖，并在报告「后续步骤」中建议：在其**顶部**加一行 `@AGENTS.md`，让 Claude Code 会话自动加载知识库入口。
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
{如 CLAUDE.md 因已存在被跳过：4. 在你的 CLAUDE.md 顶部加一行 `@AGENTS.md`，桥接知识库入口}
```
