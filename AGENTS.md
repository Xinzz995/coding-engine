# AGENTS.md

<!-- 目录式索引，不是手册：全文 ≤100 行。细节一律下沉 docs/，这里只负责「告诉你去哪找」。 -->

## 项目定位

coding-x：Ralph 自动化编码 harness——把 Developer → Validator 循环固化成确定性程序。同一仓库既是 npm 包（TS 引擎，`npx coding-x`），也是多工具插件（skills + commands）。

技术栈：TypeScript（strict, ESM）/ Node ≥22；tsup 构建、tsx 开发、Vitest 测试；唯一第三方运行库 jsonrepair 在构建时并入发布包，安装后不再加载包外运行依赖。

## 关键命令

```bash
npm run dev         # tsx 直接运行 CLI
npm run build       # tsup 打包到 dist/（onSuccess 拷贝 assets）
npm test            # Vitest
npm run typecheck   # tsc --noEmit
npm run lint        # ESLint 静态检查
npm run format:check # 新增代码格式与全部差异空白检查
```

## 文档索引

| 主题 | 路径 | 说明 |
|---|---|---|
| 架构地图 | `docs/architecture.md` | 引擎/插件双形态、模块划分、数据流、依赖方向 |
| 黄金原则 | `docs/golden-principles.md` | 新功能立项、实现与验收必须逐条对照的五条机械规则 |
| 设计决策 | `docs/decisions/` | ADR：一事一文件，编号递增 |
| 实现计划 | `docs/plans/` | 与生成工具无关的 active 实施计划；`/planning` 产出亦落此处 |
| 功能设计规格 | `docs/specs/` | 与生成工具无关的 active 功能设计规格 |
| PRD | `docs/prds/` | prd-generate 产出；意图真相源，`.workspace/prd.json` 由它派生（ADR-003）；两端对齐稿（scenario-alignment 的 `align-*.md`、technical-alignment 的 `tech-*.md`）亦落此处，被正式 PRD 吸收后置 superseded |
| 约定与陷阱 | `docs/patterns.md` | /compound-docs 收口沉淀的稳定约定与高频陷阱 |
| 领域词汇表 | `docs/glossary.md` | 共享语言：核心术语定义与禁用同义词，命名与表述以它为准 |
| Prompt 编写原则 | `docs/prompt-writing.md` | skills/commands/引擎指令的编写与修订判据（no-op 检验、完成判据、锚定词） |
| Dogfood 回归 | `docs/dogfood-regression.md` | 真实引擎运行需要逐条复查的行为级回归断言 |
| 发布手册 | `docs/release.md` | npm 候选暂存、三仓 Dogfood、2FA 批准、稳定发布与失败恢复 |
| 历史冷档案 | `docs/archive/` | 完成态历史文档，仅追溯时读取；日常实现与熵 GC 排除 |
| 用户文档 | `README.md` | 安装、快速开始、CLI 参数、目录结构 |

## 硬约束

1. 提交前必须通过 `npm run format:check`、`npm run lint`、`npm run typecheck` 与 `npm test`
2. `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）
3. `skills/`、`commands/` 是唯一源：各工具清单只指回，不复制内容
4. 引擎运行时状态只读写 `--workspace` 目录（默认 `.workspace/`）
5. 面向用户的破坏性变更（命令改名、产物路径）必须升 minor 版本并同步 README
6. 提交说明必须用中文书写（conventional 类型前缀 feat:/fix:/docs: 等保留英文）
7. 新功能编码前必须在实现计划或 PRD 中逐条完成 `docs/golden-principles.md` 对照；不适用项写明理由，未裁决项先交用户确认
