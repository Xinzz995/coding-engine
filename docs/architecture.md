---
title: 架构地图
status: active
updated: 2026-07-03
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
| PRD 读取 | `src/engine/prd.ts` | 读 prd.json（需求内容） |
| 执行状态 | `src/engine/state.ts` | state.json 读写与迁移、选 story、完成判定、合并视图 |
| 进度 | `src/engine/progress.ts` | 读取 progress.md |
| 修复 | `src/engine/repair.ts` | jsonrepair 修复 prd.json / state.json |
| 仪表盘 | `src/dashboard/server.ts` | HTTP 服务（:7331）+ 自动开浏览器；`coding-x dashboard` 子命令可离线复用 |
| 引擎指令 | `assets/instructions/` | builder.md / validator.md（{{WORKSPACE}} 占位符） |
| 知识库模板 | `templates/` | /init-docs、/compound-docs 使用的 AGENTS/docs 模板 |

## 分层与依赖方向

cli → engine（loop → agent / prd / state / progress / repair）；loop 启停 dashboard 并推送迭代状态，dashboard 反向只读 `engine/prd.ts`、`engine/state.ts`、`engine/progress.ts` 取数据供 API 使用——两者是双向数据耦合，而非单向依赖。`assets/` 构建时拷进 `dist/`，引擎经 `import.meta.url` 定位读取；`templates/`、`skills/`、`commands/` 只随插件仓库分发，引擎不读。

## 数据流

`.workspace/` 里三份文件贯穿全程：`prd.json`（需求，由 `docs/prds/` 源 PRD 经 prd-to-json 派生，顶层 `sourcePrd` 记录来源，运行期只读）、`state.json`（执行状态，按 story id 键控，引擎首跑初始化并自动从旧格式迁移，agent 回写）与 `progress.md`（日志+学习）。分层真相源（ADR-003）：md 是意图真相（人改），prd.json+state.json 是执行真相（机器改），冲突以 md 为准再派生，执行状态永不回流 md。builder 实现单个 story 并回写 state.json/progress.md → validator 逐条核对 acceptanceCriteria 并回写 passes/notes/retryCount/blocked → 循环直到全部 passes 或 blocked。

## 测试

Vitest，测试与源码同目录（`*.test.ts`）；`src/engine/__fixtures__/fake-agent.mjs` 模拟 agent 子进程。
