---
title: 018-local-review-github-gate-and-staged-release
status: active
updated: 2026-08-02
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

该隔离承诺还要求临时域本身绑定创建时的目录身份；审查包、Runner 调用目录、版本目录和隔离探测使用
固定集合，固定文件由引擎以有界句柄核对；status 安全域使用有界动态目录树。只有受管进程正常结束、
没有外部终止、超时或残留后代时才能清理。五类临时域共用相同的身份与收口规则。
身份、目录树、固定文件句柄字节、进程终点或清理条件无法证明时，引擎不删除对象，当前轴和总 Review 返回
`unverifiable`；能否安全收紧 POSIX 权限位按下述独立保护状态裁决，不以名称前缀、模型成功或 supervisor
最终杀净进程来替代异常现场。

创建时的最小权限与保留后的权限证明是两件事。POSIX 只有在受管进程已经结算、原对象与内容仍能
通过创建时绑定的句柄证明，并用同一句柄收紧和回读 POSIX 权限位后，保留结果才记录 `restricted`。其他结果
记录不可验证原因并要求人工隔离；身份异常时绝不为了修权限而触碰不可信路径。Windows v1 不把
POSIX mode 数字当作 ACL 证明，所有保留结果都不声称仅当前用户可读。`restricted` 只证明返回路径
在收口时的 POSIX 权限位，不证明扩展 ACL、历史保密、既有读取者或 Review 内容有效，因而不会恢复任何绿灯。
保留位置与权限保护是两个独立状态：只有候选路径仍能绑定冻结目录时才报告真实保留路径；删除已完成、
对象被移走或父目录身份异常而无法定位原对象时，必须返回“保留位置不可验证”和有界候选路径，不能
虚构一个可供人工隔离的现场。

Reviewer CLI 的输入接口并不一致：Codex 通过规范路径读取 schema，Claude 接收内联 schema，Cursor
由引擎在返回后严格解析；Codex 和 Claude 的 Prompt 经标准输入传递，Cursor 的 Prompt 使用有上限的参数。
这些 CLI 都无法跨平台直接消费 Node 已打开的文件句柄。因此边界是：引擎自身的信任判定使用不跟随链接、
有界且绑定句柄的读取；Reviewer 只在已反测的只读隔离中使用规范路径或已冻结字节，运行后的任何路径或字节变化都会使结果作废。这不声称能观察 Reviewer 内部的每一次
文件系统调用。该修复也不扩大为防御同一系统账号下持续并发的任意外部恶意进程；若要作出该保证，必须另立 ADR。

Spec Reviewer 只判断仓库改动是否满足行为意图，不负责证明本轮交付流程已经完成。完整机械
检查由引擎在 Reviewer 前执行并绑定当前 head；全部 Review 轴、GitHub CI/Ruleset 和发布状态
由引擎在 Reviewer 后独立收口。这样既不把缺失证据猜成通过，也不要求单个 Reviewer 循环
证明“包含自己在内的三轴 Review 已经完成”。

候选版本只能以 `--shadow` 运行并固定返回非交付结论。首次稳定 Bootstrap 实际使用
0.33.1：0.33.0 的多轮候选在 npm stage 后发现产品问题，不可变候选又不能吸收后续修复，
因此 0.33.0 没有成为正式裁判。0.33.1 由现有机械 CI 和 owner 人工 Bootstrap 裁决；发布后
再由旧规则审查的 Policy PR #76 将固定版本更新为 0.33.1，coding-engine PR #77 随后完成
首次正式自托管并合并。之后稳定版 N 评估候选 N+1，发布后再通过旧规则审查 Policy PR 更新
固定版本。

Go 多模块和 Python Monorepo 外部仓库在试点收口时经 owner 确认作为公开试点，并不代表通用
能力只支持公开仓库。私有仓库仍必须先探测账户套餐和 Ruleset 权限；能力不足时初始化停止，
不得降级为只有 CI 的弱门禁。

完整 `doctor` 回答“当前运行版本能否作为正式裁判”，因此正式版本不匹配必须继续失败。
GitHub 和候选暂存不得把这个结论冒充仓库机械健康；coding-engine 单独运行只检查真实文档、
契约结构和契约生成文件的仓库测试。首次 0.33.1 明确使用一次性的“机械 CI + owner 人工
Bootstrap”，不绕过 doctor，也不声称完成正式本地 AI Review。受保护 main 上的 0.29.0
曾可独立复核仓库健康，但旧契约包含候选无法满足的旧检查，因此不能为当时的候选 PR 签发
正式 Review。GitHub 仍不运行模型；下游项目不获得该仓库专用测试或 Node 依赖。

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
