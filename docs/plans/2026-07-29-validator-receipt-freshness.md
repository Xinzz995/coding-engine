---
title: Validator 凭证持续绑定与最终提交收敛
status: done
updated: 2026-07-29
scope: root
---

# Validator 凭证持续绑定与最终提交收敛

## 背景与问题

Validator 的单次结构化协议已经绑定 request、story、有序验收标准摘要和调用时 Git HEAD，
但成功后持久状态只保存 `validated=true`。提交或验收标准后来变化时，系统无法从 Story 状态
判断旧结果是否仍然有效；当前失效逻辑又依赖旧 `final-review.json` 存在且可读，因此在没有
Final Review、多 Story 后续提交或 Final Review 损坏时可能产生假绿。根因由 Issue #90 跟踪。

## 完成合同

| 验收标准 | 失败信号 | 验证证据 |
|---|---|---|
| 每个通过态绑定当前提交和当前有序验收标准 | 只凭 `passes && validated` 即可完成 | 状态解析、签发、失效与完成判定单测 |
| 任一提交变化会使所有旧提交凭证失效 | Story A 在 H1 验证、Story B 产生 H2 后 A 仍为绿 | 多 Story H1→H2 收敛回归 |
| 失效 Story 不重复调用 Developer | 仅因凭证过期而重新进入实现 Agent | validation-only 轮次测试与调用次数断言 |
| 所有 Story 最终收敛到同一 HEAD | Final Review 能在凭证混合 H1/H2 时调用模型 | Final Review 前后机械断言与模型零调用测试 |
| 验收标准变化立即失效 | Story 文案或顺序变化后旧凭证仍有效 | acceptance hash 变化测试 |
| 旧、损坏或伪造字段不能复活通过态 | 从 evidence、旧 Final Review 或 legacy 布尔值补造凭证 | 迁移、repair、所有权恢复测试 |
| 展示面不显示过期绿灯 | status、report 或 dashboard 在新提交后仍显示完成 | 三个展示面的当前 HEAD 回归 |
| 正式模式没有 Git HEAD 时提前停止 | 进入 Developer、Validator 或 Reviewer 后才失败 | preflight 退出码和 agent/model 零调用测试 |
| 空 Story 与旧历史记录不能退化成完成证明 | 空集合摘要、旧 evidence 或旧 Final Review 复活绿灯 | 空 Story 零调用与历史记录组合回归 |
| 项目检查不能替引擎签发状态 | 测试/TDD 脚本伪造其他 Story 的完整绿态 | 检查前后完整快照恢复与 gate 来源证据 |
| 纯重验不依赖不会调用的 Builder | Builder 模型已移除时 validation-only 被预检阻断 | 仅 Validator 模型可用的路由回归 |
| Story 数量不挤占实现预算 | 两个实现轮都成功，却因第三个仅重验轮超过 `--max-iter 2` | 独立有界重验余量与两 Story 收敛回归 |
| 最终结果写入窗口发生变化时立即撤销 | 写入前核对通过、写入后变化仍返回 0 | 写入后再核对并删除刚写结果的竞态回归 |
| 项目检查不能在 Final Review 前替换凭证或留下源码改动 | 检查返回 0 后仍按新凭证进入模型，或脏工作树被忽略 | 检查前冻结、检查后凭证/工作树复核与模型零调用回归 |
| Reviewer 主动升级可持久复核 | 首轮运行 deep，但保存结果随后无法读取或 status 误报过期 | 固定升级风险、状态一致性与 status 重建回归 |
| PRD 模型路由变化会使旧 Review 失效 | 路由政策变化后旧结果仍为当前，或命令行临时覆盖误伤当前性 | 路由摘要绑定、loop 传递与 status/report 回归 |
| 人工裁决不能在运行中被替换 | Agent 或项目检查改写裁决后继续沿用旧/新组合返回通过 | 启动冻结、逐边界恢复、刚写结果删除与证据回归 |
| Final Review v1 不能伪装成 v2 | 旧结果补字段、迁移或继续显示为通过 | v1 拒绝、v2 必填绑定与重新运行路径 |

## 状态与收敛设计

每个 Story 增加引擎独占的 `validationReceipt`，记录 schema 版本、Validator request ID、
Git HEAD 和有序 acceptanceCriteria 摘要。`validated` 保留为兼容和展示字段，但不能独立证明
通过；唯一完成裁决要求候选通过、已验证、未阻断且凭证与当前 HEAD/验收标准完全一致。

引擎在启动、每轮选择 Story 前、Validator 完成后和 Final Review 前后调用同一纯函数对账。
凭证缺失、损坏或过期时：

- 非阻断且 `passes=true` 的 Story 保留实现候选，改成 `validated=false` 并清除凭证；
- 循环识别该状态为 validation-only，跳过 Developer，重新执行机械检查与 Validator；
- 机械检查或 Validator 失败时再把 `passes=false`，下一轮才交给 Developer 修复；
- blocked Story 保持 blocked，但清除残留凭证，不能通过解除标志复活旧结论。

这样新提交后的最终收敛最多增加一轮逐 Story 重验，不把每个过期 Story再次交给 Developer，
也不依赖 Final Review 文件作为 Validator 新鲜度来源。

`--max-iter` 只计算可能调用 Developer 的实现/修复轮。validation-only 的总余量按“Story 数量 ×
`stall-limit`”计算，相当于为每个 Story 预留 `stall-limit` 轮；这样瞬时失败后仍有成功机会，
同时保留总成本上限，避免多 Story 全部成功却在最终重验前被实现预算截断。

旧 workspace 仍能解析，但缺少结构化凭证时只能表示“历史上曾通过”，正式模式必须重验。
不从 evidence、Final Review 或当前 HEAD 反向补造凭证。

## 最终 Review 边界

正式运行必须在任何 Agent 前读取非空 Git HEAD。进入 Final Review 前，所有非 blocked Story
必须持有绑定同一当前 HEAD 与当前验收标准的有效凭证。Final Review 在机械检查前冻结凭证
身份；机械检查完成后、模型调用前同时核对凭证与工作树，Review、远端查询和结果写入后继续
核对。失败返回不可验证，不调用或不接受模型结果。

Final Review 自身继续绑定 PR、base/head、Spec、规则、实际 Runner/模型和冻结 PRD 路由政策
等身份。Story 凭证摘要加入它的输入绑定，避免状态身份变化后复用旧 Review。Reviewer 主动
升级 deep 的决定也进入唯一风险摘要，并能从已保存的独立评审轴确定性重建。

人工裁决在 coding-x 启动、任何项目代码运行前按原始字节冻结；机械检查、Reviewer 或其他同权限
进程改写时恢复启动快照并阻断，本轮退出后才允许 `/review-loop` 追加新决定。Final Review v1
缺少新增绑定，不能迁移、补造或继续显示为通过，必须重跑正式流程生成 v2。

## 黄金原则对照

| 原则 | 适用性与设计裁决 | 验证证据 |
|---|---|---|
| 1. 可证伪完成合同 | 适用。上表分别定义通过条件、假绿信号和可执行证据。 | 纯函数、状态机、模型零调用和展示回归 |
| 2. 生成方不得自签 | 适用。Agent 只提交 claim；引擎持久化并持续核对当前 HEAD/AC 绑定。 | Agent 篡改恢复、legacy 不补造、错绑定失败测试 |
| 3. 自治与风险对称 | 适用。本变更不扩大写入或发布权限；validation-only 减少无价值 Agent 调用，所有失配 fail closed。 | 调用次数、失败转 Builder、正式无 HEAD 提前停止测试 |
| 4. 原生能力优先 | 适用。复用 Git HEAD、现有 Validator 协议和循环，不新增服务、守护进程或供应商逻辑。 | 核心类型保持 runner-neutral，adapter 无新增分支 |
| 5. 失败恢复 | 适用。先固化无 Final Review、多 Story 混合提交、旧状态和 AC 变化四个真实失败，再验证成功收敛。 | Issue #90 对应回归、定向与全量检查 |

未裁决项：无。五项原则均适用。

## 实施任务

1. 新增 ADR-020，修订 ADR-003、013、014、015 与黄金原则中的旧边界。
2. 实现结构化凭证、统一完成评估、对账与引擎字段所有权。
3. 增加 validation-only 轮次，删除把所有未验证候选强制退回 Developer 的旧启动回滚。
4. 在最终 Review 的模型调用前后核对 Story 凭证，并绑定稳定凭证摘要。
5. 让 status、report、dashboard 读取当前 HEAD 后使用统一裁决。
6. 同步 architecture、glossary、patterns、README、指令、PRD 转换与 Dogfood 回归。
7. 运行定向测试、格式、静态检查、类型检查、全量测试、构建和成品 CLI 冒烟。

## 实施结果与验证

- 结构化凭证、当前 HEAD/有序 AC 对账、validation-only、最终 Review 摘要绑定和三个展示面已完成。
- 普通检查与 TDD 检查修改 `state.json` 时会恢复完整快照并记录 `gate` 来源，不能伪造其他 Story 绿态。
- `status --json` 与 dashboard API 已公开 Story `validationReceipt` 和 `validationInvalidations`；Final Review v2 已公开 Story 凭证、冻结裁决与 PRD 路由摘要绑定。
- 人工裁决运行内冻结、最终机械检查前后的凭证/工作树复核、Reviewer 风险升级重建和结果写入后撤销均已完成。
- 空 Story、无 Git HEAD、旧 evidence/Final Review、纯重验模型路由、两 Story 最终提交收敛与写入竞态均有回归。
- 全量测试 64 个文件、923 项通过；类型检查、静态检查、构建、仓库健康检查和成品 CLI 冒烟通过。
- 高危依赖审计通过；当前仅有一个开发工具的低危 Windows 开发服务器提示，不阻断本变更。

## 明确不做

- 不把 workspace 凭证、裁决快照或摘要称为密码学签名、身份认证或 GitHub 交付证明；同权限进程仍可直接伪造本地文件；
- 不从历史记录自动迁移、猜测或补造凭证；
- 不因过期而重复调用 Developer；
- 不修改 GitHub 机械门禁或在 GitHub 调用模型；
- 不在本 PR 进行 npm 发布或结构拆分。
