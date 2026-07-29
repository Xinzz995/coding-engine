---
title: Validator 凭证持续绑定与最终提交收敛
status: active
updated: 2026-07-30
scope: root
---

# Validator 凭证持续绑定与最终提交收敛

## 目标与边界

本计划只解决 Issue #90：把单轮 Validator 已核对的提交和有序验收标准身份持久保存，并让循环、
最终 Review 与三个展示端持续核对它。完成后，旧提交上的 `validated=true` 不能在新提交或新验收
标准下继续显示为通过。

本计划以 ADR-020 为设计裁决。它不实现 runner/命令入口冻结、`trusted-tool`、`safe-control-file`、
进程树收口、Policy Guard、doctor、P1 延期刷新、独立纯重验预算、二进制标记修复，也不提前实现
Issue #91 的精确 HEAD 干净检出。

## 可证伪完成合同

| 验收标准                                                    | 失败信号                                        | 计划验证证据                    |
| ----------------------------------------------------------- | ----------------------------------------------- | ------------------------------- |
| 通过 Story 持久绑定非空 HEAD、request ID 和当前有序 AC 摘要 | 只有 `passes && validated` 仍可完成             | 状态签发、解析与有效通过单测    |
| 缺失、损坏、HEAD 或 AC 不一致的凭证不算通过                 | 旧/错绑凭证仍显示绿色                           | 纯函数逐原因失败测试            |
| 新提交不依赖旧 Final Review 也会撤销全部旧提交凭证          | 删除或损坏 Final Review 后旧 Story 不重验       | 无 Final Review 的 H1→H2 回归   |
| 失效 Story 保留实现候选并跳过 Builder                       | 仅凭凭证过期就再次调用 Builder                  | validation-only 调用次数断言    |
| validation-only 仍执行完整机械检查与 Validator              | 纯重验绕过测试、构建或验收                      | gate/TDD/Validator 顺序回归     |
| 明确验证失败才回到 Builder                                  | Validator 服务异常也把候选当实现错误清除        | failed 与 unverifiable 分支测试 |
| 全部 Story 在进入 Final Review 前绑定同一当前 HEAD          | 混合 H1/H2 凭证时仍调用 Review 模型             | 多 Story 收敛与模型零调用测试   |
| 正式模式无法读取 HEAD 时提前停止                            | 任一 Agent 或模型已经启动后才报错               | 非 Git 项目调用计数为零         |
| Final Review 绑定精确凭证集合并在模型前后复核               | 项目检查或 Review 期间替换凭证后仍接受结果      | 摘要变化、结果不落盘回归        |
| status、report、dashboard 使用同一当前性判断                | 新提交后任一展示端仍显示旧绿灯                  | 三个展示面的同一 fixture 回归   |
| 旧记录不被反向补造成新凭证                                  | evidence 或旧 Final Review 让缺凭证状态自动变绿 | legacy/evidence/Review 组合回归 |
| 预算不足保持非绿退出                                        | 未完成最终收敛却进入 Review                     | 迭代耗尽且 Review 零调用测试    |

## 状态与纯函数

在既有 Story 状态中保留 `validated`，增加可选 `validationReceipt`：schema 版本、request ID、非空
Git HEAD 与 acceptance hash。字段可选只为读取旧 workspace；新签发的有效通过态必须实体化完整
凭证。

`src/engine/state.ts` 提供唯一纯函数集合：

1. 严格解析凭证，不接受未知字段、空 request、空 HEAD 或非法摘要。
2. 以 Story、状态和当前 HEAD 评估有效性并返回稳定失效原因。
3. 对账全部 Story；失效时只清除 `validated` 和凭证，保留候选、notes、retry、blocked 与路由状态。
4. 从已经通过结构化协议的 Validator result 签发完整凭证。
5. 把 `validated` 与 `validationReceipt` 作为一个引擎独占整体恢复。
6. 按 PRD 顺序生成全部有效凭证的摘要；任一非 blocked Story 无效时不生成摘要。

所有正式完成判断先消费评估或对账结果，不新增第二套裸布尔判断。只读展示在内存中对账，循环在
状态变化时原子写回。

## 循环收敛

启动预检先读取正式 Git HEAD；失败以配置/状态错误退出，不进入模型路由后的 Agent 调用。随后直接
按当前 HEAD/AC 对账 Story，不再读取 Final Review 来决定 Validator 是否过期，也不再把所有
`passes=true, validated=false` 候选启动即打回。

Story 选择分两遍：先选择非 blocked 且 `passes=false` 的实现项；只有所有 Story 都有候选后，才按
PRD 顺序选择凭证无效的 validation-only 项。这样后续 Story 的实现提交不会让前面 Story 在每个
中间提交上反复重验。

Builder 返回后重新对账，防止新提交留下其他 Story 的旧绿灯。validation-only 跳过 Builder 和
Builder no-op 判断，直接执行现有机械检查、可选 TDD 门禁与结构化 Validator 协议。外部命令若改写
引擎独占验收字段，本轮恢复调用前值并失败关闭；不为此建立新的通用控制文件框架。

本计划不改变 `--max-iter` 或 stall 的公开含义。达到现有上限但尚未收敛时返回非零，不允许进入
Final Review；独立纯重验预算另行裁决。

## Final Review 与展示

loop 在进入 Final Review 前取得精确凭证摘要，并把摘要和只读复核入口传给最终 Review。最终机械
检查结束后、Runner 隔离探测或评审模型启动前必须匹配；评审轴结束后和 loop 接受结果前再次匹配。
不匹配时删除或不写本轮结果，返回不可验证。

Review binding 保存该摘要。旧 Review 缺少摘要时仍可作为历史记录读取，但 status/report 必须判为
过期。status、report 和 dashboard 都以当前项目 HEAD 调用同一 Story 对账；HEAD 不可读取时保守
显示待重验或不可验证。展示不把本地凭证称为 GitHub 共享证明。

## 实施切片

1. 新增 ADR-020，并修订 ADR-013、014、015 中被取代的 legacy、`gitHead:null` 与待验收回滚说明。
2. 实现结构化持久凭证、统一评估/对账、签发、撤销、所有权恢复和摘要。
3. 在 gate 状态转移中清除旧凭证，并实现两遍 Story 选择与 validation-only。
4. 在启动、轮界、Builder/Validator 后和完成出口接入对账；正式 HEAD 缺失提前停止。
5. 给 Final Review binding 增加凭证摘要，并在模型前后复核。
6. 让 status、report、dashboard 使用同一当前性判断；同步最小用户文档和指令。
7. 先运行定向失败回归，再运行格式、静态检查、类型检查、全量测试、构建和成品 CLI 冒烟。

## 计划测试范围

- `src/engine/state.test.ts`：结构、签发、失效、legacy 与摘要。
- `src/engine/gate.test.ts`：失败转移清除凭证。
- `src/engine/model-preflight.test.ts`：validation-only 只要求 Validator/Review 路由。
- `src/engine/loop-preflight.test.ts`：无 HEAD 提前停止、不依赖旧 Final Review。
- `src/engine/loop-lifecycle.test.ts`：两遍选择、保留候选、跳过 Builder、多 Story 收敛。
- `src/engine/loop-validation-protocol.test.ts`：合法 result 签发精确凭证，错绑和改写失败关闭。
- `src/review/final-review.test.ts`、`src/review/state.test.ts`、`src/review/status.test.ts`：摘要绑定与前后失效。
- `src/status/status.test.ts`、`src/report/*.test.ts`、`src/dashboard/server.test.ts`：展示不复活旧绿灯。

这些是计划验证范围，不代表已经实现或已经通过；完成时必须以实际命令输出和测试结果更新证据。

## 黄金原则对照

| 原则                    | 适用性与设计裁决                                                                                            | 计划验证证据                                            |
| ----------------------- | ----------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1. 先定义可证伪完成合同 | 适用。上表逐条写明可观察的通过条件、失败信号和测试位置。                                                    | 每条标准至少一个失败断言；人工边界明确写入信任边界      |
| 2. 生成方不得自签       | 适用。`passes` 和 Validator result 都是候选声明；只有引擎核对目标、协议、HEAD 和 AC 后签发并持续复核。      | 伪造字段、错 request/head/hash、缺结果均不得签发或完成  |
| 3. 自治扩大需同步防线   | 本变更不扩大 Agent 写入、命令、合并、发布或删除权限；validation-only 反而跳过无价值 Builder 调用。          | 调用次数与失败关闭测试；不新增自动合并或发布路径        |
| 4. 原生能力优先         | 适用。复用 Git HEAD、现有结构化 Validator 协议、现有循环与 runner adapter，不自建服务或 runner。            | 核心状态和评估保持 runner-neutral；无供应商分支         |
| 5. 假绿率与恢复         | 适用。先固定无 Final Review、多 Story H1→H2、legacy 缺凭证和 AC 变化四类失败，再验证 validation-only 恢复。 | 失败/成功成对回归；对账模型调用次数、非零退出与最终状态 |

预期价值指标是减少“旧 Validator 结论仍显示绿色”的假绿，并减少仅因证据过期导致的 Builder 重复
调用。实施前不存在需要用户补充裁决的范围项；任何超出“明确不做”的需求必须另建计划。
