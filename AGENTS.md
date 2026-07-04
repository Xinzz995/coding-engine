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
| PRD | `docs/prds/` | prd-generate 产出；意图真相源，`.workspace/prd.json` 由它派生（ADR-003）；scenario-alignment 的对齐稿（`align-*.md`）亦落此处，被正式 PRD 吸收后置 superseded |
| 约定与陷阱 | `docs/patterns.md` | /compound-docs 收口沉淀的稳定约定与高频陷阱 |
| 功能设计文档 | `docs/superpowers/specs/` | brainstorming 产出的设计规格 |
| 实施任务计划 | `docs/superpowers/plans/` | writing-plans 产出的分任务计划 |
| 用户文档 | `README.md` | 安装、快速开始、CLI 参数、目录结构 |

## 硬约束

1. 提交前必须通过 `npm run typecheck` 与 `npm test`
2. `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）
3. `skills/`、`commands/` 是唯一源：各工具清单只指回，不复制内容
4. 引擎运行时状态只读写 `--workspace` 目录（默认 `.workspace/`）
5. 面向用户的破坏性变更（命令改名、产物路径）必须升 minor 版本并同步 README
6. 提交说明必须用中文书写（conventional 类型前缀 feat:/fix:/docs: 等保留英文）
