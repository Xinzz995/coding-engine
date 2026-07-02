---
title: 002-claude-md-bridge
status: active
updated: 2026-07-03
scope: root
---

# 002. AGENTS.md 是唯一源，CLAUDE.md 仅作 `@AGENTS.md` 导入桥接

## 背景

Claude Code 的记忆系统只自动加载 `CLAUDE.md`、不加载 `AGENTS.md`（官方文档 memory.md 明确声明）。/init-docs 生成的知识库以 AGENTS.md 为入口——Ralph 引擎 agent 靠指令显式读取不受影响，Codex/Cursor 原生读 AGENTS.md 也不受影响，但**交互式 Claude Code 会话**不会自动看到知识库入口。

## 决策

/init-docs 在每个 AGENTS.md 旁生成一个极薄的 `CLAUDE.md` 桥接文件：内容为 `@AGENTS.md` 导入 + 用途注释。AGENTS.md 保持唯一源；CLAUDE.md 里只允许 `@` 导入和 Claude Code 专属的补充指令，**禁止复制实际知识库内容**。目标项目已有 CLAUDE.md 时跳过不覆盖，报告中建议其顶部手动加一行 `@AGENTS.md`。

## 理由与备选

- `@` 导入是官方文档推荐的 AGENTS.md 桥接方式，跨平台安全。
- 被否备选①（symlink `CLAUDE.md → AGENTS.md`）：Windows 需管理员/开发者模式，官方文档明确建议改用 `@` 导入。
- 被否备选②（反向：CLAUDE.md 做主、AGENTS.md 桥接）：Codex/Cursor 原生读 AGENTS.md 且不支持导入语法，会破坏跨工具方向。
- 被否备选③（两边生成完整内容）：重新引入瘦清单架构消灭掉的复制漂移。

## 后果

- 生成产物比设计文档（2026-07-02）多一个 `CLAUDE.md`（根与每个子项目各一），幂等规则同样适用。
- 若未来 Claude Code 原生支持 AGENTS.md，可在后续版本移除该桥接产物（届时另立 ADR 废止本条）。
