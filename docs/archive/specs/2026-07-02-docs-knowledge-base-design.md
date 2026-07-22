---
title: "设计文档：docs/ 知识库体系 —— AGENTS.md 目录化 + /init-docs + 产物统一收编"
status: done
updated: 2026-07-06
scope: root
---

# 设计文档：docs/ 知识库体系 —— AGENTS.md 目录化 + /init-docs + 产物统一收编

日期：2026-07-02
来源：OpenAI《Harness engineering: leveraging Codex in an agent-first world》差距分析——coding-x 已覆盖「循环层」，本设计补齐「环境层」中的知识库部分。

## 1. 背景与目标

OpenAI 的 harness-engineering 实践中，仓库知识库是 agent 的「记录系统」：AGENTS.md 只做约百行的**目录**（地图），细节下沉到结构化 `docs/`，通过渐进式披露让 agent 从小而稳定的入口找到所需上下文。coding-x 目前只有一个「百科全书式」的 AGENTS-template.md，且 `/planning` 产物在 `.agents/plans/`、PRD 在 `tasks/`，知识分散、无索引、无原则文档。

**目标**：让 coding-x 的命令/skills 能在目标项目中生成并维护一套 docs/ 知识库（含黄金原则），支持单项目与 monorepo，并把既有产物路径统一收编；同时在 coding-engine 仓库自身 dogfood。

**v1 范围 = 核心四件**：

1. docs/ 目录结构 + 模板（含黄金原则）
2. AGENTS.md 改造为目录式索引
3. 生成命令 `/init-docs`（替代 `/init-rules`）
4. builder/validator/planning/prd-generate 指令接线

**非目标（二期）**：doc-gardening agent、文档新鲜度/交叉链接机械校验（CI/linter）、引擎每 N 轮自动插入园艺迭代、黄金原则 lint 化。模板 frontmatter 为二期预埋钩子。

## 2. 已锁定的决策

| 决策点 | 结论 |
|---|---|
| 落点 | 两者都要：面向目标项目为主设计，coding-engine 自身 dogfood |
| 多子项目布局 | 混合式：根 docs/ 放跨项目内容；每个子项目 `<sub>/docs/` + `<sub>/AGENTS.md`；单项目退化为一层 |
| v1 范围 | 核心四件；自净机制留二期，frontmatter 预埋钩子 |
| 产物收编 | `/planning` → `docs/plans/`、PRD → `docs/prds/`（破坏性变更，当前几乎无存量用户） |
| 命令形态 | 单一入口：`/init-rules` 升级重写并改名 `/init-docs`，`/init-rules` 移除 |
| validator | 不新增判定维度：验收标准仍是唯一判定依据；品味强制走二期 lint 路线，避免验收主观化 |
| 版本 | 命令改名 + 路径变更为破坏性变更，发布 `0.2.0` |

## 3. 知识库形态（目标项目里的产物）

### 3.1 单项目

```
project/
├── AGENTS.md                  # ≤100 行目录：定位 + 关键命令 + 文档索引 + 硬约束
└── docs/
    ├── architecture.md        # 域地图：模块划分、分层、数据流、依赖方向
    ├── golden-principles.md   # 3–5 条机械性、有主见的规则
    ├── decisions/             # 设计决策记录（ADR 风格，一事一文件，编号递增）
    ├── plans/                 # /planning 产出（活跃与已完成共存，靠 status 区分）
    └── prds/                  # prd-generate 产出
```

### 3.2 monorepo（混合式）

```
repo/
├── AGENTS.md                  # 根：全局命令 + 子项目索引表 + 跨项目文档索引
├── docs/                      # 只放跨项目内容
│   ├── architecture.md        #   总架构（含子项目关系）
│   ├── golden-principles.md
│   └── decisions/  plans/  prds/
└── packages/foo/
    ├── AGENTS.md              # 薄索引：子项目命令/模式；首行声明「先读根 AGENTS.md」
    └── docs/
        ├── architecture.md    # 可选：子项目复杂时才生成
        └── decisions/  plans/  prds/
```

**归属规则**（写入 planning/prd-generate 指令）：功能只涉及一个子项目 → 产物落 `<sub>/docs/`；跨子项目 → 落根 `docs/`。

### 3.3 AGENTS.md 四段式（目录，不是手册）

1. 项目一句话定位 + 技术栈一行表
2. 关键命令（dev/build/test/lint）——agent 每轮都用，值得内联
3. **文档索引表**（主体）：主题 → 路径 → 一句话说明（architecture、golden-principles、decisions/、plans/、prds/、各子项目 AGENTS.md）
4. 3–5 条内联硬约束（最高优先级，如「提交前必须过 typecheck」）

细节一律下沉 docs/，AGENTS.md 只负责「告诉你去哪找」。

### 3.4 统一 frontmatter（二期自净钩子）

所有生成的知识库文档统一携带：

```yaml
---
title: ...
status: draft | active | done | superseded
updated: YYYY-MM-DD
scope: root | <子项目名>
---
```

### 3.5 golden-principles.md 内容规范

每条原则必须**机械可判定**（未来可翻译为 lint 的表述），附「为什么」+「怎么检查」。
反例：「代码要整洁」。正例：「共享逻辑必须放 `src/utils/`，禁止在 feature 目录内复制辅助函数——检查方式：grep 重复函数签名」。

## 4. `/init-docs` 命令行为

1. **探测项目形态**：`package.json` workspaces / `pnpm-workspace.yaml` / `lerna.json` / `turbo.json` / 一二级目录多 manifest（package.json、pyproject.toml、go.mod…）扫描 → 子项目清单 → 向用户展示确认（可增删）；探测不到 → 按单项目处理。
2. **分析代码库**：复用现有 init-rules 的发现/分析阶段（项目类型判定、技术栈、模式提取）。
3. **生成**：
   - 根：目录式 AGENTS.md + docs/ 骨架（architecture、golden-principles、decisions/、plans/、prds/；空目录放 README 占位说明用途）。
   - 子项目：薄 AGENTS.md + docs/ 骨架；`architecture.md` 仅在子项目达到一定规模时生成（参考标准：源文件 > 20 个或存在两层以上模块目录；拿不准时询问用户）。
   - 黄金原则：从代码库分析提炼 3–5 条候选 → 请用户确认/修改后写入；提炼不足时给通用默认条目并标注「待人工确认」。
4. **幂等保护**：已存在的文件一律不覆盖，跳过并列入报告；旧版（百科全书式）AGENTS.md 存在时，给出「建议手动合并」的差异说明。只补缺失的文件/目录。
5. **输出报告**：生成清单 + 跳过清单 + 后续步骤。

### 模板组织（插件仓库内）

根目录 `AGENTS-template.md` 拆分迁移到 `templates/`：

```
templates/
├── AGENTS-root.md          # 目录式根 AGENTS.md 模板（四段式）
├── AGENTS-sub.md           # 子项目薄 AGENTS.md 模板
└── docs/
    ├── architecture.md
    ├── golden-principles.md
    └── decision.md         # ADR 模板
```

命令通过插件根路径引用模板。

## 5. 接线改造清单

全部为 markdown/模板改动，**引擎 TS 代码零改动**（引擎只关心 `.workspace/`）。

| 文件 | 改动 |
|---|---|
| `commands/init-rules.md` | 重写为 `commands/init-docs.md`（第 4 节流程） |
| `commands/planning.md` | 输出 `.agents/plans/` → `docs/plans/`；加归属规则与 frontmatter |
| `skills/prd-generate/SKILL.md` | 输出 `tasks/` → `docs/prds/`；加归属规则与 frontmatter |
| `skills/prd-to-json/SKILL.md` | 微调：提示 PRD 通常位于 `docs/prds/`（无路径硬依赖） |
| `assets/instructions/builder.md` | 增加：monorepo 时同时读所涉子项目 AGENTS.md；存在 `docs/golden-principles.md` 时必须遵守；progress.md 的 Codebase Patterns 中在 ≥2 个不同 story 的学习里出现过的稳定模式**升格**写入 docs/ 并在原处标注已升格 |
| `assets/instructions/validator.md` | 不新增判定维度（见第 2 节决策）；可将 AGENTS.md 作为背景阅读 |
| `README.md` | 更新命令表、目录结构、工作流程图中的路径 |
| `AGENTS-template.md` | 删除（内容拆分进 `templates/`） |

## 6. Dogfood

改造完成后在 coding-engine 仓库运行 `/init-docs`（单项目形态）：生成本仓库的目录式 AGENTS.md + docs/ 知识库，并把既有 `docs/specs/` 与 `docs/plans/` 纳入 AGENTS.md 索引表。产物提交入库。

## 7. 验收方式

纯指令/模板改动没有单元测试可写，验收 = 真实运行：

1. throwaway 单项目跑 `/init-docs`：产物齐全、frontmatter 正确；再跑一次全部跳过（幂等）。
2. throwaway monorepo（pnpm workspaces，两个子包）跑 `/init-docs`：根 + 子项目产物齐全、归属规则正确。
3. coding-engine dogfood 产物提交。
4. `/planning` 与 `prd-generate` 实际产出落新路径且带 frontmatter。

## 8. 错误处理汇总

| 情形 | 处理 |
|---|---|
| 探测不到子项目 | 按单项目处理 |
| 黄金原则提炼不足 3 条 | 通用默认条目补足，标注「待人工确认」 |
| 目标文件已存在 | 跳过不覆盖，报告列出；旧版 AGENTS.md 给合并建议 |
| 子项目过多（如 >10） | 列清单请用户勾选需要生成的子集，避免一次生成过量骨架 |
