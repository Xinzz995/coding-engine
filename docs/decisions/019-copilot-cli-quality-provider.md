---
title: 019-copilot-cli-quality-provider
status: active
updated: 2026-07-24
scope: root
---

# 019. 远端质量评审改用隔离的 GitHub Copilot CLI provider

## 背景

GitHub 已宣布 GitHub Models 在 2026-07-30 完全退役，届时推理与自带密钥端点都不可用：
<https://github.blog/changelog/2026-07-01-github-models-is-being-fully-retired-on-july-30-2026/>。
同时，coding-engine 的真实 PR 已证明 Models 的账户级额度会让 Spec、Standards、Deep 在同一
提交上无法稳定全部完成。继续增加重试只会延迟 `unverifiable`，不能形成可用门禁。

GitHub Copilot CLI 已正式支持在 Actions 中使用内建 `GITHUB_TOKEN` 与
`copilot-requests: write`，无需保存个人模型 token：
<https://docs.github.com/en/copilot/how-tos/copilot-cli/use-copilot-cli-in-actions>。
它的 programmatic JSONL 输出会给出实际模型、最终回复、工具请求、退出状态和 premium
request 用量。

## 决策

质量契约的 `review` 增加三项受信任配置：

- `provider: "github-copilot"`；
- `model: "auto"`，实际选中的模型必须从 provider 事件回读并写入 receipt；
- `copilotCliVersion`，必须是完整固定版本。

新项目默认使用该 provider。v0.31.0 不自动迁移旧项目；已有 v0.30.x 契约必须在用户审阅后
显式补齐字段并更新受管工作流。GitHub Models adapter 不再作为新版本门禁的回退路径；provider
不可用时直接 `unverifiable`。

AI job 只使用默认分支固定的 coding-x 与 Copilot CLI 版本，并同时在同一隔离 npm 前缀安装。
coding-x 在每个模型调用中：

1. 创建独立临时 Git 根与独立 `COPILOT_HOME`；
2. 把可信 system prompt 写成仅有 `tools: []` 的临时 custom agent；
3. 把 PR 意图、来源与 diff 仅作为 user data 传入；
4. 禁用所有工具、内建 MCP、项目/用户指令、远程会话、远程导出和自动更新；
5. 解析有界 JSONL，只接受一个无工具请求的最终回复、成功 result 和一致的实际模型；
6. 超时、进程异常、版本不符、输出畸形、工具请求或模型身份矛盾均 fail closed。

workflow 不签出 PR head，也不运行 PR 代码。Copilot 使用同一个最小权限 `GITHUB_TOKEN`；
不再读取 `CODING_X_MODEL_TOKEN`。Check Run 与 GitHub API 仍由 coding-x 绑定精确 PR head。

## 黄金原则对照

1. **可证伪完成合同**：单测覆盖版本错配、超时、损坏 JSONL、工具请求、模型错配和注入文本；
   真实 Actions 必须让三轴针对同一 head 全部完成。
2. **不得自签**：Copilot 输出仍要经过结构、语义、证据和提交身份机械校验；custom agent
   的回复不能直接成为通过事实。
3. **防线与自主性同步**：provider 没有工具、仓库工作区和持久凭据；版本核验与评审进程分别
   有时限，输出有硬上限，
   不自动修改、合并或发布。
4. **原生能力优先**：认证、计费和模型路由复用 GitHub Copilot；核心三态与 finding 不依赖
   Copilot 类型，差异收口在 model adapter。
5. **失败恢复可量化**：receipt 记录实际模型、调用次数、premium request 用量与耗时；任何
   provider 失败都保持 `unverifiable`，不静默退回旧 provider。

## 后果

- 新工作流需要 `copilot-requests: write`，不再需要 `models: read` 或模型 secret。
- Copilot 账户或组织政策未启用、额度不足、CLI 版本漂移时，门禁会明确阻断。
- `auto` 的实际模型可能随 GitHub 路由变化，因此 receipt 必须保留每次运行的真实模型身份；
  若同一评审轴中模型身份不一致，该轴不可验证。
- provider 迁移是面向用户的门禁合同变更，发布 minor 版本 0.31.0。
