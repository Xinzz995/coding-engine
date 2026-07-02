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
