# AGENTS.md

<!-- 目录式索引，不是手册：全文 ≤100 行。细节一律下沉 docs/，这里只负责「告诉你去哪找」。
     增删行的检验：删掉这行，agent 读代码能否自行发现同样信息？能则不写（文档索引指针不适用此检验）。 -->

## 项目定位

{一句话：这个项目是什么、为谁解决什么问题}

技术栈：{语言/运行时、框架、测试、构建，一行概括；与标准做法的偏离（如包管理器用 pnpm 而非 npm）必须点名}

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
| 约定与陷阱 | `docs/patterns.md` | /compound-docs 收口沉淀的稳定约定与高频陷阱 |
| 领域词汇表 | `docs/glossary.md` | 共享语言：核心术语定义与禁用同义词，命名与表述以它为准 |
| {子项目 `<name>`} | `{<path>/AGENTS.md}` | {monorepo 时每个子项目一行；单项目删除} |

## 硬约束

<!-- 3–5 条最高优先级规则，agent 每轮必须遵守；更多规则放 docs/golden-principles.md。
     只收代码看不出来的隐式约定，首选「与标准做法的偏离」——不写 agent 就会按默认做法犯错。 -->

1. {如：提交前必须通过 `npm run typecheck`}
2. {…}
3. {…}
