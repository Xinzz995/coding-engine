---
title: 018-local-review-github-gate-and-staged-release
status: active
updated: 2026-07-27
scope: root
---

# 018. 本地 Review、GitHub 机械门禁与候选发布分层

## 背景

coding-x 已经能执行 Developer、机械检查、可选 TDD 门禁和 Validator，但“实现已验证”仍可能
被误写成“可以交付”。本地 `/review-loop` 是可跳过流程，Markdown 结果也不是共享凭证；
GitHub 默认分支过去没有强制规则。若直接把模型搬进 GitHub，又会引入秘密、供应链、配额、
上下文分片和不稳定服务成为必需检查等新风险。

coding-x 同时是一个会被下游项目使用的工具。候选版本若直接为自身签发正式通过，会形成
生成者自签；若每个下游生态都在 CI 安装 Node 和 coding-x，则又违背项目原生执行面原则。

## 决策

采用三条互不冒充的链：

1. coding-x 在本地执行 Spec、工程标准和风险触发的深度结构 Review；
2. GitHub 只执行目标项目原生机械检查，用受保护 PR 和不可跳过的 `quality-gate` 阻断交付；
3. 发布先构建一个没有 npm 身份的固定候选 tarball，依次完成 coding-engine、Go 和 Python
   Dogfood；验证通过后才显式提升到 npm stage，人工批准后再移动稳定标签并创建 Git 标签与
   Release（候选与 staging 的进一步拆分见 ADR-019）。

GitHub 不调用模型，也不证明本地 Review。`.coding-x/quality.json` 成为项目质量规则唯一来源，
派生 PRD 检查快照和原生 CI。缺契约、schema 不兼容或正式运行版本不匹配时 fail closed。

最终 Review 必须绑定 PR/base/head、PR 意图、Spec、默认分支工程规则、质量契约、coding-x
版本、runner/model/规则版本与风险结论。Reviewer 在临时只读审查包中运行，不能使用项目
工作目录、秘密、MCP、hooks、插件或危险 bypass 参数。任何输入变化使结果失效；无法保证
完整上下文或只读隔离时返回 `unverifiable`。

Spec Reviewer 只判断仓库改动是否满足行为意图，不负责证明本轮交付流程已经完成。完整机械
检查由引擎在 Reviewer 前执行并绑定当前 head；全部 Review 轴、GitHub CI/Ruleset 和发布状态
由引擎在 Reviewer 后独立收口。这样既不把缺失证据猜成通过，也不要求单个 Reviewer 循环
证明“包含自己在内的三轴 Review 已经完成”。

候选版本只能以 `--shadow` 运行并固定返回非交付结论。首次 0.33.0 由现有机械 CI 和人工
Bootstrap 裁决；之后稳定版 N 评估候选 N+1，发布后再通过旧规则审查 Policy PR 更新固定
版本。

完整 `doctor` 回答“当前运行版本能否作为正式裁判”，因此正式版本不匹配必须继续失败。
GitHub 和候选暂存不得把这个结论冒充仓库机械健康；coding-engine 单独运行只检查真实文档、
契约结构和契约生成文件的仓库测试。首次 0.33.0 明确使用一次性的“机械 CI + owner 人工
Bootstrap”，不绕过 doctor，也不声称完成正式本地 AI Review。受保护 main 上的 0.29.0
可以独立复核仓库健康，但旧契约仍包含候选无法满足的旧检查，因此不能为本 PR 签发正式
Review。GitHub 仍不运行模型；下游项目不获得该仓库专用测试或 Node 依赖。

## GitHub 与发布约束

- 初始化先配置最小 Ruleset 并回读，再生成 Bootstrap PR 文件；首次 `quality-gate` 出现后
  才把它设为必需检查。Bootstrap 合并后再由 Activation PR 触发默认分支旧
  `policy-guard` 工作流，将真实 `policy-guard-source` 任务绑定为必需检查后才完成初始化；
- required check 只使用一个始终执行的总闸；任一必需 job 失败、取消、超时、跳过或缺失时
  总闸失败；
- 政策变更由默认分支旧 `policy-guard` 读取元数据检查；带凭据任务不执行 PR 代码或文本，
  Ruleset 直接要求该工作流的真实 `policy-guard-source` 任务，不再额外写入一条同名结果；
- coding-engine 检查 Node 22/24 与 Ubuntu/macOS/Windows，运行时最低 Node 22；
- npm 使用 OIDC staged publish；固定候选先完成三仓 Dogfood，再提交 stage、批准到 `next`、
  完成公开精确版本冒烟，最后人工移动 `latest`；staging 不可用时只能由用户明确批准临时
  OIDC-to-next 退路；
- 候选检查/构建任务没有 OIDC 权限；stage-only OIDC 任务不安装依赖、不执行项目脚本，只
  重建固定候选并强制核对 npm 返回摘要；
- annotated tag 必须固定人工批准的 workflow run、npm stage ID 与候选 SHA-256，避免同一提交
  多次暂存时由发布任务猜测；
- 标签不再触发直接 npm 发布，只验证已发布制品并创建不可变 Release。

## 后果

- “所有 story 完成”“本地 Review 通过”“GitHub 可合并”“版本已稳定发布”成为四个不同状态；
- `/review-loop` 改写为结构化 finding 裁决入口，Markdown 只供阅读；
- GitHub 门禁在模型服务不可用时仍能工作，但不会替开发者强制本地 AI Review；这是明确接受
  的边界；
- 下游 CI 不需要安装 Node 或 coding-x，只运行由质量契约生成的项目原生命令；
- 个人仓库 owner 仍可删除 Ruleset，首版只承诺日常防误操作，不承诺独立可信根；
- 发布操作增加人工批准和三仓 Dogfood，但获得候选物一致性与可恢复的稳定标签；
- `loop.ts` 等结构债务独立治理，避免门禁实现同时改写裁判和大规模重构。

## 不采用的方案

- 不把 Matt、Cursor 或其他 AI Reviewer 直接放进 GitHub required checks；
- 不复制 no-mistakes 的 Git 代理、守护进程、数据库、TUI 或 PR 文本标记；
- 不让旧 CLI 全面执行新 CLI 的所有内部路径，只要求稳定版裁判与候选 shadow 分工；
- 不使用八分片或静默截断来掩盖大 PR 的上下文不足；
- 不建立中央质量平台、复杂签名系统、自动合并或自动发布。

## 可信上限

本地模型判断不是事实证明，GitHub CI 也不能证明 owner 永不改规则。首版通过精确绑定、旧规则
裁决、回读、失败关闭、候选摘要和人工批准减少常见遗漏与误操作；独立组织策略与多人审批
留到出现稳定协作者之后。
