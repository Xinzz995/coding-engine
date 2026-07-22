---
title: 011-model-routing-by-difficulty
status: active
updated: 2026-07-22
scope: root
---

# 011. 模型路由按 story 难度分档，并绑定单一 runner

> **2026-07-22 局部修订：** 本 ADR 的“公开接口发现 + unsupported/人工降级 + 启动时在线模型可用性复核”已由 [ADR-012](012-global-model-catalog.md) 取代；runner 绑定、难度分档、首次有效失败升级、CLI 优先级与可观测性继续生效。

## 背景

ADR-006 以阶段默认、story 直接模型名、retryCount 阈值升级为主；ADR-010 又为跨 Claude/Codex 的模型名不可移植引入 `profiles`。两版都尚未进入正式标签。重新梳理用户目标后，优先级明确为「按任务难度选择初始模型 > 首次有效失败升级 > builder/validator 分工」，并明确不需要一份配置跨 runner 复用。

跨工具档案解决了非目标，却没有稳定保存 story 的难度判断；直接模型名把长期相对稳定的任务复杂度与快速变化的模型代际绑死；复用 `retryCount` 又无法覆盖 no-op，且混淆验收失败计数与路由状态。

## 决策

1. `prd.json.models` 绑定单一 `runner`，包含 `builder.low/medium/high`、固定 `validator` 与固定 `escalation` 五个实际模型标识；不再支持 `profiles`、`escalateAfter` 或 story `model`。
2. story 保存 `difficulty: low|medium|high` 与可审计的 `difficultyReason`。`prd-to-json` 在最终 stories 上结合代码库按固定风险规则自动判定，写入后展示；源 PRD 不写模型策略。
3. 模型路由可选；启用后 schema 完整性、未知键、runner 和模型可用性全部 fail-fast。未启用时沿用 runner 默认模型，CLI 临时覆盖仍可独立使用。
4. 第一次有效失败（门禁失败、引擎接受 Validator 的 failed claim、builder completed no-op）后，下轮起持续使用 escalation；超时、非零退出、认证和环境错误不升级。Validator 的失败输入后由 ADR-015 收敛为绑定目标的结构化 claim，升级语义不变。
5. `state.json` 新增引擎独占的 `escalated`，与 `retryCount` 分离；旧 state 缺失时按 false，agent 改动由引擎恢复并留痕。
6. 新增 Cursor runner、`--escalation-model` 与公开 `coding-x models [runner] [--json]`。模型发现只用公开机器接口，发现不了时人工提供列表；不解析交互 TUI、不内置模型名单。
7. `models.runner` 在未显式指定后端时自动选择 runner；显式 runner 错配拒绝启动。
8. 实际模型与路由来源写 evidence，并在控制台、dashboard、status 和 report 区分“配置路由”与“实际调用”。

完整 schema、分档规则、优先级、再派生与错误矩阵见 `docs/archive/superpowers/specs/2026-07-21-model-routing-redesign.md`。

## 理由与被否备选

- **难度与模型分离**：难度是 story 的执行复杂度判断，模型名是当前 runner 环境的短期选择；集中映射允许模型换代时不重写每个 story。
- **runner 绑定而非跨工具档案**：用户明确不需要跨工具复用；单 runner 配置可在生成与启动两端验证，错误名字不会被传给另一工具。
- **固定三档而非自定义层级/数值评分**：三档足以区分局部机械、常规跨层和高风险推理；自定义层级使生成与升级语义不可预测，数值评分制造虚假精度。
- **独立 escalated 而非 retryCount**：no-op 应升级但不应增加验收失败/blocked 预算；异常退出不应升级。两个状态的触发集合不同，不能复用同一计数。
- **首次有效失败即升级而非可配阈值**：初始模型已经按难度选择，重复同一水位价值低；删除阈值也消除“达到 blocked 前永不生效”的配置陷阱。
- **严格失败而非警告回退**：路由可选，但启用后必须确定；静默默认会让成本与质量策略看似生效、实际失效。
- **公开发现接口 + 人工降级，而非内置名单/TUI 抓取**：模型与账号/provider 能力持续变化，内部名单和终端抓屏都会过时；无法证明完整时明确承认 unsupported。
- **不选按阶段三模型方案**：单一 builder 只能在失败后变化，无法实现首要目标“第一次就按 story 难度选模型”。新结构可让三个 builder 档位选同一模型，从能力上覆盖简化方案。

## 后果

- ADR-006 与 ADR-010 被本 ADR 取代；未发布旧 schema 直接拒绝，用户重新执行 `prd-to-json`。
- 新增 runner/model 发现预检会带来启动延迟；有适配器却查询失败时循环不启动，无适配器时明确警告后信任人工清单。
- 用户最终控制五项映射；可靠元数据不足时系统不判断能力倒挂。配置相同模型是合法选择，可能使某档升级不产生实际模型变化。
- `state.json` 公开格式向后兼容新增 `escalated`；evidence 只增加可选字段。
- 面向用户的 CLI、runner 与派生产物 schema 变化随下一 minor 版本 0.23.0 发布，并同步 README、架构、skills 与插件清单。
- token/费用统计、reasoning effort/mode 路由明确留作独立后续议题。
