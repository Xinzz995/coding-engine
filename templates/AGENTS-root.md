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
| {子项目 `<name>`} | `{<path>/AGENTS.md}` | {monorepo 时每个子项目一行；单项目删除} |

## 硬约束

<!-- 3–5 条最高优先级规则，agent 每轮必须遵守；更多规则放 docs/golden-principles.md -->

1. {如：提交前必须通过 `npm run typecheck`}
2. {…}
3. {…}
