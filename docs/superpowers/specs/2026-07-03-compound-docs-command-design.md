# 设计文档：/compound-docs 收口命令 —— 循环经验的复利文档回收

日期：2026-07-03
状态：已批准（brainstorming 逐节确认）
来源：对照分析旧 Ralph 生态的 `compound-harness-docs` skill（xinzz-vault/Clippings）——其「分支收口时把经验提炼、验证、分层沉淀回项目文档」的模式正是 coding-x 差距分析中明确的 doc-gardening 空白；`agents-map` 的核心理念已被 `/init-docs` 覆盖，不独立移植，其残留价值点（monorepo 集成落点、刷新语义）并入本命令。

## 1. 背景与目标

coding-x 的核心叙事是「复利 harness 越用越准」，但当前学习回流没有闭环：builder 的学习只留在 `.workspace/progress.md`（工作区运行痕迹，不随项目文档分发），唯一的升格通道是 builder 内联的「模式升格」——单一落点（architecture.md 末尾追加）、无交叉验证、占用实现注意力，长期日志化堆积本身就是熵增。

**目标**：新增第四个 command `/compound-docs`，在一轮 run／功能分支收口时，把 progress.md 积累的学习**提炼、验证、分层沉淀**回项目文档，只改文档不改代码；同时收编 builder 的内联升格，让知识回流有唯一、有全局视野的出口。

## 2. 已锁定的决策

| 决策点 | 结论 |
|---|---|
| 触发方式 | 手动 command + 引擎完成提示：`allStoriesResolved` 后打印一行建议文案；引擎不自动执行（项目文档改动人在环内） |
| builder 内联升格 | 收编删除：`builder.md` 的「模式升格」「升格防污染」两段移除；pattern 整合进 progress.md 的职责保留 |
| 落位体系 | 结构/集成 → `docs/architecture.md` 就地更新；机械可判定强制规则 → `docs/golden-principles.md`；约定+陷阱 → **新增 `docs/patterns.md`**；`architecture.md` 不再当杂物抽屉 |
| 落位发现 | 动态发现优先（读目标项目 AGENTS.md 文档索引），init-docs 两层体系兜底，什么都没有时建议先跑 `/init-docs` |
| 命名 | `/compound-docs`，与 `/init-docs` 对仗（init 初始化知识库，compound 复利沉淀） |
| 执行模式 | 沿用原型：默认直接执行；用户要求「先分析」时先输出候选清单待确认 |
| 版本 | 新增用户可见 command + 引擎输出变化 → minor 升 `0.6.0` |

## 3. 命令形态与定位

`commands/compound-docs.md`，与 planning / init-docs / priming 并列的纯 markdown 工作流，引擎不执行它。

- **做什么**：基于当前代码 + git 取证 + progress.md，把项目相关、可复用、当前仍成立的知识沉淀回项目文档
- **不做什么**：不改业务代码、脚本、配置、测试；不把 harness 工具细节写入项目文档；不重写整份文档
- **何时用**：一轮循环全部 story 通过后（引擎会提示）；功能分支收口时；积累了一批 commit 想让未来 agent 更准时
- **不要用**：单个 story 实现中、纯代码修复/发布、只想更新 PRD 或进度日志

## 4. command 工作流（六步，适配三文件模型）

### 4.1 建立范围

- 读 `.workspace/prd.json`：branchName、交付范围说明（顶层 `sourcePrd` 存在时可参考背景）
- 读 `.workspace/state.json`：哪些 story 已 `passes`（本轮实际完成范围）
- git 取证基线：确定默认分支与 merge-base（照搬原型脚本）：

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
MERGE_BASE=$(git merge-base HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null || git merge-base HEAD "$DEFAULT_BRANCH")
git log --reverse --oneline "$MERGE_BASE"..HEAD
git diff --name-status "$MERGE_BASE"..HEAD
```

### 4.2 交叉取证

四路对照：当前代码结构 ⨯ git log/diff ⨯ progress.md（Codebase Patterns 章节 + 各 story 的「未来迭代的学习」）⨯ prd.json 交付说明。

**事实优先级链**（高到低）：

1. 当前分支真实代码与目录结构
2. merge-base..HEAD 的 git diff / log
3. progress.md 的 Codebase Patterns
4. prd.json 的交付范围说明（只用于理解「这轮做了什么」，不是事实来源）

progress.md 里写了但当前代码已不再体现的经验，不沉淀。

### 4.3 提炼（归纳而不是抄录）

只保留四类：

- 目录结构已真实变化、未来必须知道的新入口/新模块/归属
- 多个 story 反复出现、未来会复用的稳定开发约定
- 容易再次踩、与本项目框架/数据边界/路由方式强相关的陷阱
- 影响 AI 编码正确性的系统边界、跨项目协作边界、公开接口边界

排除：story 编号与修复经过、过程叙事、一次性事故、临时占位、执行环境信息（「需手动验证」类）、已在现有文档准确表达的内容。每条候选自问：当前代码仍成立？是项目知识而非工具知识？未来会再遇到？该落哪一层？

### 4.4 防污染门

凡提及 `.workspace/`、`prd.json`、`state.json`、`progress.md`、validator、agent-browser、coding-x 等 harness 工具词的条目一律不入项目文档。收编后此约束只在本命令维护（builder.md 中删除）。

### 4.5 落位写入

按第 5 节规则落位；**最小修改**：优先补充/修正/去重，不重写整份文档，保持现有风格与章节层级；一条经验只写一次、写到最合适的位置。结构性内容**就地更新**对应章节（如模块表加一行、数据流改一句），不做末尾追加式堆积。

### 4.6 交付说明

完成后简短汇报：更新了哪些文档、每份补了什么类型的信息、明确排除了哪些不该沉淀的内容。

## 5. 落位规则（动态发现 + 两层兜底）

### 5.1 第一优先：动态发现

读目标项目根 `AGENTS.md` 的文档索引表，按它声明的结构落位——AGENTS.md 是入口和索引，与预想不符时服从 AGENTS.md。monorepo 时：子项目内部知识落该子项目的 `AGENTS.md`/docs（存在时）；跨子项目集成边界落根级架构文档（吸收 agents-map 的集成层价值点）。根 AGENTS.md 只允许更新仓库级导航/硬约束，不堆子项目细节。

### 5.2 兜底：init-docs 两层默认体系

无 AGENTS.md 或无文档索引时：

| 知识类型 | 落点 | 方式 |
|---|---|---|
| 结构变化、模块归属、数据流 | `docs/architecture.md` | 就地更新对应章节 |
| 集成/接口边界 | `docs/architecture.md`（分层与依赖方向） | 就地更新 |
| 机械可判定的强制规则 | `docs/golden-principles.md` | 追加（保持 3–5 条精简，超出时提请用户取舍） |
| 稳定约定 + 高频陷阱 | `docs/patterns.md`（新落点） | 分「约定」「陷阱」两章追加，条目带日期 |

三个文件都不存在且无 AGENTS.md 时：建议用户先跑 `/init-docs`，本次只输出候选清单不写入。

### 5.3 patterns.md 与「沉淀模式」章节的迁移

`docs/patterns.md` 取代现行 architecture.md 末尾的「沉淀模式」章节。收口时若发现目标项目 architecture.md 存在旧「沉淀模式」条目：迁移到 patterns.md 并删除该章节（一次性自愈，之后不再出现）。

## 6. 周边改动（四处联动）

1. **builder.md 收编**：删「模式升格」「升格防污染」两段（`assets/instructions/builder.md:52-54`）；保留「整合 Patterns」——builder 仍每轮把可复用 pattern 整合进 progress.md 顶部 Codebase Patterns 章节（收口的原料）
2. **引擎完成提示**：`src/engine/loop.ts` 完成分支（`allStoriesResolved` 为真处）追加一行：`💡 全部 story 已通过。建议运行 /compound-docs 把本轮经验沉淀进项目文档。`——引擎唯一改动
3. **init-docs 联动**：新增 `templates/docs/patterns.md` 模板（frontmatter + 约定/陷阱两章骨架）；`templates/AGENTS-root.md` 文档索引表加 patterns.md 一行；`commands/init-docs.md` 产物清单同步
4. **文档同步**：README（命令表 + 新命令介绍）、本仓库 `docs/architecture.md` 与 `AGENTS.md`（如涉及命令清单/文档索引）；本仓库自身 dogfood（AGENTS.md 索引加 patterns.md）

## 7. 错误处理

- 非 git 仓库 / merge-base 失败：降级为只基于 progress.md + 当前代码取证，并在交付说明中注明
- `.workspace/` 或 progress.md 缺失：提示先跑引擎循环；只做纯 git + 代码取证（价值有限，如实说明）
- 证据不足：宁可不写（原型原则）
- 落位目标文件缺失（兜底模式下）：按 5.2 表创建对应文件（patterns.md 用模板骨架）；golden-principles.md 特殊——不自动创建，不确定为强制规则的降级进 patterns.md

## 8. 测试与验证

- `builder.md` 删段：已确认测试只用假指令 fixture，无内容耦合
- `loop.ts` 加提示行：预计无测试耦合（loop.test.ts 测流程不测文案），提交前 `npm run typecheck` + `npm test` 兜底
- command 本身是 markdown 工作流，无单测；验证方式为在本仓库 dogfood 跑一次 `/compound-docs`（真实 E2E）
- builder.md 改动经 tsup onSuccess 拷进 `dist/instructions`，`npm run build` 后抽查 dist 版本已含删改；`templates/docs/patterns.md` 不进构建（templates/ 只随插件仓库分发，引擎不读），无需构建验证

## 9. 非目标（YAGNI）

- 引擎自动执行收口 agent（第三 instruction）——文档改动无人审风险大，先人工触发
- 照搬原型四文件体系（structure/conventions/integrations/concerns）——违背两层极简哲学
- agents-map 独立移植——/init-docs 已覆盖其核心
- 定时/自动触发、文档新鲜度 CI 校验——留给后续 doc-gardening 二期
