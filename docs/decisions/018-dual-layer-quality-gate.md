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
GitHub Models 取得结构化结论。仓库 API 与 Check Run 只使用自动 `GITHUB_TOKEN`；模型调用
可使用独立的 `CODING_X_MODEL_TOKEN`，且该 token 不进入 GitHub API client。对应 Check Run
明确绑定 PR head。
GitHub 免费调用额度当前限制每次 8000 个输入 token 和 4000 个输出 token；adapter 将输出上限
固定为 4000。调用前按完整 prompt 保守预算，输入超限时无损拆分可信来源、diff 或两者，最多
八个叶子片段共同覆盖完整 `source × diff` 评审空间，逐片有效后才合并 finding；任一片段
失败或需要更多片段时均为 `unverifiable`，不截断内容后假装完成评审。

默认分支上的契约和固定 coding-x 版本是可信政策源。PR 修改契约、评审规则或工作流时仍由
旧政策裁决，并自动触发深度评审。规则集要求 PR、最新提交检查、解决对话、禁止强推与删除。
`quality init` 负责预览、确认、配置和回读核验；首次接入先写受管文件，只有默认分支已经
持有同一契约与固定版本工作流后才启用 ruleset，避免启动顺序把仓库锁死。`quality doctor`
只读检查持续漂移；定时巡检需要具备 ruleset 只读权限的显式凭据。

本地 `quality review` 复用同一评审核心，但只提供反馈；共享交付事实以 GitHub Check/PR
历史为准。`run/status/report` 分开展示实现验证与交付就绪。

coding-engine 不允许使用 PR 中的新实现批准自身。首次通过现有 CI 发布 0.30.0；自托管前
发现同名源码仓库会干扰直接 `npx coding-x`，因此发布使用隔离 npm 前缀的 0.30.1。首次
远端运行又证明 npm 前缀必须是已存在目录，且 0.30.1 的单次模型输入超过 GitHub 免费额度。
两个不可由旧二进制自修的启动缺陷都记入 #13；仅在原有四平台 CI 和项目命令通过后进行有界
bootstrap。v0.30.2 又因默认 Actions 身份无法完整读取 ruleset 而在发布前安全失败，未产生
npm 包或 GitHub Release；失败标签保留用于审计，发布改用显式管理只读凭据的 0.30.3。
0.30.3 发布后的首次正常 PR 又暴露两项真实兼容问题：GitHub Models 拒绝无工具声明时多余
的工具选择参数，coding-engine 文档检查依赖按路径被跳过的构建产物。该 PR 被完整阻断且
未合并；修复在真实模型调用与无构建产物的干净检出中复验后发布 0.30.4。0.30.4 必须完整
裁决后续真实 PR，成功后关闭异常。后续结构治理 PR 又证明仓库自动 token 的免费 Models
整周期额度会耗尽：三轴按既有语义全部阻断，串行复跑也不能恢复，而同一模型的个人 token
仍可调用。#23 记录有界恢复；0.30.5 将模型凭据与仓库凭据隔离，避免为了增加模型容量而扩大
Check Run 或仓库读取权限。0.30.6 对 429 遵守 provider 的 `Retry-After` 并在两分钟总时限内
最多尝试五次，同时依次调度三轴评审，耗尽后仍为 `unverifiable`。此后门禁版本升级始终由
旧版本审查。0.30.6 的后续真实运行又证明单个 PR 内串行无法约束多个 PR 共享的账户额度，
且默认 GPT-4.1 所属高限流档的免费日额度只有 50 次。0.30.7 改用已真实验证结构化输出的
GPT-4.1 mini 作为低限流档默认值，在请求前按完整 prompt 选择 source/diff 分片，在分片间
节流，并通过 GitHub 原生 job 并发组及 `queue: max` 将全仓模型任务串行；该方案不引入中央
队列、守护进程或静默降级。随后结构治理预演发现 Deep 同时载入 Spec 与 Standards 会重复
消费已经由 Spec 轴裁决的产品来源，并让高风险改动稳定超出八片；真实升级 PR 进一步证明，
把 `specSources` 目录下全部历史规格送入每个 PR 也不是可扩展的来源合同。0.30.8 将来源所有权
收紧为：Spec 只读取 PR 明确关联及本次直接修改的规格，`specSources` 只定义可信允许范围；
Standards 与 Deep 读取工程标准，Deep 不再重新裁决产品范围。没有独立规格时，作者必须明确
声明 PR 的意图、验收标准和非目标就是完整 Spec，不能静默省略。

发布检查不能只按名称相信同名 Check Run：发布时重新读取启用中的 branch/tag ruleset，以
ruleset 绑定的 GitHub App ID 核对关联 PR head 的最新结果。正常路径要求全部成功；只有受
Git 管理、未过期、未关闭、精确提交是发布提交祖先的紧急交付记录才能进入“异常发布”，并在
Actions 日志留下 warning。规则停用、来源不符、例外过期或不在发布历史上仍直接失败。

## 可信边界

- AI finding 是独立评审结论，不是机械正确性证明；模型不可用或输出畸形时 fail closed。
- GitHub workflow 和 ruleset 能约束正常协作流程，但仓库管理员仍能删除规则。定时 doctor
  负责发现漂移，不能把管理员权限包装成密码学不可绕过。
- GitHub Models 是 provider adapter；模型 ID、token 和 API 形状不进入核心三态与 receipt
  语义。免费额度不构成生产容量保证；有限重试只恢复 provider 明确报告的瞬时 429，耗尽或
  周期额度不足仍是 `unverifiable`，不能通过无限重试或例外改写成正常通过。
- 同权限的项目测试工具仍可能被恶意代码伪造；coding-x 证明的是受保护工作流观察到的命令
  结局，不证明工具链绝对可信。

## 后果

- 新增 `.coding-x/quality.json`、受管 exceptions 文件、`quality` CLI 与三个 GitHub workflow
  模板。
- `/review-loop` 改为同一核心的插件入口，不再维护第二套发现结构。
- 缺契约的新项目不能静默降级；没有 GitHub adapter 的远端交付状态为 unverifiable。
- coding-engine 增加 lint、安全扫描、兼容矩阵、规则集和发布来源校验。
- GitLab 等 adapter、中央服务、签名、自动修复/合并/发布保持非目标。
