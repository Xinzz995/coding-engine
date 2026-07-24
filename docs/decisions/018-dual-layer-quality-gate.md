---
title: 018-dual-layer-quality-gate
status: active
updated: 2026-07-24
scope: root
---

# 018. 质量评审与交付门禁分层，并由 coding-engine 自托管

## 背景

coding-x 已能在 Developer 后独立运行项目门禁并让 Validator 对 story 产出结构化 claim，但
这些机制只裁决一次引擎运行，不控制 GitHub 上的直接推送、PR 合并和发布。本地
`/review-loop` 也可被跳过，且 workspace 留痕与共享交付证据曾被混为一谈。

目标同时覆盖 coding-engine 自身和所有新建下游项目，又不能把 npm、Vitest 或 TypeScript
变成下游项目要求。

## 决策

新增 runner-neutral 质量合同，核心只定义：

- 项目原生命令；
- Spec、工程标准和风险触发深度评审三条独立轴；
- `passed | failed | unverifiable` 三态；
- 精确 base/head、政策摘要、finding、例外和 receipt。

GitHub 是首个远端 adapter。项目命令在无敏感权限的 PR workflow 运行；AI 评审在默认分支
`pull_request_target` workflow 运行，通过 API 读取 PR 数据，不签出或执行 PR 代码，并用
GitHub Models 的 `models: read` 权限取得结构化结论。对应 Check Run 明确绑定 PR head。

默认分支上的契约和固定 coding-x 版本是可信政策源。PR 修改契约、评审规则或工作流时仍由
旧政策裁决，并自动触发深度评审。规则集要求 PR、最新提交检查、解决对话、禁止强推与删除。
`quality init` 负责预览、确认、配置和回读核验；首次接入先写受管文件，只有默认分支已经
持有同一契约与固定版本工作流后才启用 ruleset，避免启动顺序把仓库锁死。`quality doctor`
只读检查持续漂移；定时巡检需要具备 ruleset 只读权限的显式凭据。

本地 `quality review` 复用同一评审核心，但只提供反馈；共享交付事实以 GitHub Check/PR
历史为准。`run/status/report` 分开展示实现验证与交付就绪。

coding-engine 不允许使用 PR 中的新实现批准自身。首次通过现有 CI 发布 0.30.0；自托管前
发现同名源码仓库会干扰直接 `npx coding-x`，因此发布使用隔离 npm 前缀的 0.30.1。首次
远端运行又证明 npm 前缀必须是已存在目录，经 #13 记录的有界 bootstrap 修复后，由 0.30.1
正式审查并发布 0.30.2。以后门禁版本升级始终由旧版本审查。

## 可信边界

- AI finding 是独立评审结论，不是机械正确性证明；模型不可用或输出畸形时 fail closed。
- GitHub workflow 和 ruleset 能约束正常协作流程，但仓库管理员仍能删除规则。定时 doctor
  负责发现漂移，不能把管理员权限包装成密码学不可绕过。
- GitHub Models 是 provider adapter；模型 ID、token 和 API 形状不进入核心三态与 receipt
  语义。
- 同权限的项目测试工具仍可能被恶意代码伪造；coding-x 证明的是受保护工作流观察到的命令
  结局，不证明工具链绝对可信。

## 后果

- 新增 `.coding-x/quality.json`、受管 exceptions 文件、`quality` CLI 与三个 GitHub workflow
  模板。
- `/review-loop` 改为同一核心的插件入口，不再维护第二套发现结构。
- 缺契约的新项目不能静默降级；没有 GitHub adapter 的远端交付状态为 unverifiable。
- coding-engine 增加 lint、安全扫描、兼容矩阵、规则集和发布来源校验。
- GitLab 等 adapter、中央服务、签名、自动修复/合并/发布保持非目标。
