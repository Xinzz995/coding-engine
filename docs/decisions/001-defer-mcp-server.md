---
title: 001-defer-mcp-server
status: active
updated: 2026-07-03
scope: root
---

# 001. 暂缓 MCP Server，待「聊天里遥控 Ralph」场景出现再立项

## 背景

讨论过给 coding-x 增加 MCP Server，把能力暴露给 Codex、Claude Code、Cursor 等 agent。但这三家消费方均已通过插件瘦清单加载 `skills/`、`commands/`，且都能执行 shell——跑循环（`npx coding-x`）、修 JSON（`npx coding-x repair`）、查状态（直接读 `.workspace/prd.json` / `progress.md`）都有更自然的入口。

## 决策

暂不实现 MCP Server。**重新立项的触发条件**：出现「从无 shell 的 MCP 客户端（如 Claude Desktop 聊天）远程发起/查看 Ralph 运行」的真实需求，或有用户需要接入三大工具之外的 MCP agent。

## 理由与备选

- 提示词能力（prd-generate / prd-to-json / planning / init-docs）若再以 MCP prompts 暴露，会与现有插件单一源形成双轨，重新引入当初瘦清单架构消灭的复制漂移问题。
- 主循环是小时级长任务，与 MCP 请求-响应模型不合，只能做成「启动后台 + 轮询」，而这套能力 shell + 文件已天然具备。
- 被否备选：现在就做 dashboard `/api/state` 的 MCP 薄封装——对已有 shell 的 agent 是用更复杂的接口替代更自然的接口，无增量价值。

## 后果

- 立项时必须重新设计安全边界：引擎以 `--dangerously-skip-permissions` 运行 agent，「远程触发无权限确认的自主编码循环」不能只是薄封装，需要独立的授权与作用域设计。
- 该项与二期「环境层」事项（doc-gardening、文档新鲜度 CI、黄金原则 lint 化）一起排优先级。
