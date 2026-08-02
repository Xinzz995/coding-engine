---
title: Validator 凭证持续绑定与最终提交收敛
status: done
updated: 2026-08-02
scope: root
---

# Validator 凭证持续绑定与最终提交收敛

## 目标与边界

本计划只解决 Issue #90：把单轮 Validator 已核对的提交、Story ID 和有序验收标准身份持久保存，
并让循环、最终 Review 与三个展示端持续核对它。完成后，旧提交上的 `validated=true` 不能在新
提交、新 Story ID 或新验收标准下继续显示为通过。

本计划以 ADR-020 为设计裁决。它不实现 runner/命令入口冻结、`trusted-tool`、`safe-control-file`、
进程树收口、Policy Guard、doctor、P1 延期刷新、独立纯重验预算、二进制标记修复，也不提前实现
Issue #91 的精确 HEAD 干净检出。

## 可证伪完成合同

| 验收标准                                                          | 失败信号                                        | 计划验证证据                     |
| ----------------------------------------------------------------- | ----------------------------------------------- | -------------------------------- |
| 通过 Story 持久绑定非空 HEAD、request ID、当前 Story ID 和有序 AC | 只有 `passes && validated` 仍可完成             | 状态签发、解析与有效通过单测     |
| 缺失、损坏、HEAD、Story ID 或 AC 不一致的凭证不算通过             | 旧/错绑凭证仍显示绿色                           | 纯函数逐原因失败测试             |
| 验收文字相同的两个 Story 也不能互换凭证                           | 跨 Story 放置凭证后仍显示绿色                   | 跨 Story 置换失败测试            |
| 新提交不依赖旧 Final Review 也会撤销全部旧提交凭证                | 删除或损坏 Final Review 后旧 Story 不重验       | 无 Final Review 的 H1→H2 回归    |
| 失效 Story 保留实现候选并跳过 Builder                             | 仅凭凭证过期就再次调用 Builder                  | validation-only 调用次数断言     |
| validation-only 仍执行完整机械检查与 Validator                    | 纯重验绕过测试、构建或验收                      | gate/TDD/Validator 顺序回归      |
| validation-only 只有明确失败才清除旧候选                          | 环境/协议异常也触发重复 Builder                 | 纯重验三类结果分支测试           |
| validation-only failed 沿用 retry 和 blocked 上限                 | 达到上限后仍重复调用 Builder                    | 上限轮 blocked 与零 Builder 测试 |
| 无 HEAD 的启动预检不修改 Story                                    | 尚未选择 Story 就清除候选或增加 retry           | 预检前后 state 相等测试          |
| 稳定约定区分当前行为与 ADR-020 目标规则                           | 实现者同时收到“保留”和“清除”两套相反指令        | patterns/ADR/计划一致性审计      |
| 全部 Story 在进入 Final Review 前绑定同一当前 HEAD                | 混合 H1/H2 凭证时仍调用 Review 模型             | 多 Story 收敛与模型零调用测试    |
| 正式模式无法读取 HEAD 时提前停止                                  | 任一 Agent 或模型已经启动后才报错               | 非 Git 项目调用计数为零          |
| Final Review 绑定精确凭证集合并在模型前后复核                     | 项目检查或 Review 期间替换凭证后仍接受结果      | 摘要变化、结果不落盘回归         |
| status、report、dashboard 使用同一当前性判断                      | 新提交后任一展示端仍显示旧绿灯                  | 三个展示面的同一 fixture 回归    |
| 旧记录不被反向补造成新凭证                                        | evidence 或旧 Final Review 让缺凭证状态自动变绿 | legacy/evidence/Review 组合回归  |
| 预算不足保持非绿退出                                              | 未完成最终收敛却进入 Review                     | 迭代耗尽且 Review 零调用测试     |

## 状态与纯函数

在既有 Story 状态中保留 `validated`，增加可选 `validationReceipt`：schema 版本、request ID、非空
Git HEAD 与 acceptance hash。acceptance hash 沿用既有精确序列化算法，输入同时包含当前 Story
ID 和当前有序 acceptanceCriteria；字段可选只为读取旧 workspace，新签发的有效通过态必须实体化
完整凭证。

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
按当前 HEAD 和为每个 Story 重算的 `acceptanceHash` 对账，不再读取 Final Review 来决定 Validator
是否过期，也不再把所有 `passes=true, validated=false` 候选启动即打回。

Story 选择分两遍：先选择非 blocked 且 `passes=false` 的实现项；只有所有 Story 都有候选后，才按
PRD 顺序选择凭证无效的 validation-only 项。这样后续 Story 的实现提交不会让前面 Story 在每个
中间提交上反复重验。

Builder 返回后重新对账，防止新提交留下其他 Story 的旧绿灯。validation-only 跳过 Builder 和
Builder no-op 判断，直接执行现有机械检查、可选 TDD 门禁与结构化 Validator 协议。外部命令若改写
引擎独占验收字段，本轮恢复调用前值并失败关闭；不为此建立新的通用控制文件框架。

Builder 返回并完成对账后固定本轮唯一验收 HEAD；项目机械检查和 TDD 门禁各自在启动前、结束后
核对，Validator 建立请求前和返回后再次核对。任一边界观察到 HEAD 不一致或不可读时，不接受该阶段
结果、不增加 retry、撤销新 HEAD 下已经过期的其他 Story 凭证并立即停止；validation-only 保留既有
候选，普通实现轮沿用未验收候选回滚。下一次运行重新走完整链路，不能把不同 HEAD 的结果拼接成
一次通过。H1→H2→H1 的瞬时恢复仍属于 Issue #91 的隔离检出边界。

正式 HEAD 预检发生在选择 Story 与建立本轮纯重验之前；失败时不启动 Agent，也不修改 Story、候选
或 retry。validation-only 中，机械检查/TDD 正常结束并明确不通过、确定的 TDD 政策违规或合法
Validator failed 才清除跨轮保留的旧候选，并沿用既有 retry、升级与 blocked 规则；未 blocked 时
才重新进入 Builder。超时、无法启动、信号异常、终止失败、引擎平台/目录/配置/政策不可验证，或
Validator 运行/协议不可验证时，保留旧候选、撤销凭证、不增加 retry，并立即非绿结束。机械/TDD
不可验证时不进入 Validator，Validator 不可验证时不进入 Final Review；合法 Validator passed 才
签发新凭证。质量契约明确声明某项机械检查不适用于当前平台时正常跳过；TDD `coverageCheck` 没有
独立的平台跳过声明。明确失败同样结束本次运行；候选清除后，由下一次启动先完成 Builder/升级模型
预检，再进入 Developer，不能在只预检了 Validator/Review 的同一运行中直接调用 Builder。

以上分类只服务 validation-only。普通 Builder 新候选继续遵循 ADR-009 与 ADR-017 的现有异常回写、
stall、retry、升级和 blocked 语义；本计划不建立全局三态门禁。

本计划不改变 `--max-iter` 或 stall 的公开含义。达到现有上限但尚未收敛时返回非零，不允许进入
Final Review；独立纯重验预算另行裁决。

## Final Review 与展示

loop 在进入 Final Review 前取得按 PRD 顺序生成的精确凭证集合摘要，并把摘要和只读复核入口传给
最终 Review。最终机械检查结束后、Runner 隔离探测或评审模型启动前必须匹配；评审轴结束后和 loop
接受结果前再次匹配。不匹配时删除或不写本轮结果，返回不可验证。

Review binding 保存该摘要。旧 Review 缺少摘要时仍可作为历史记录读取，但 status/report 必须判为
过期。status、report 和 dashboard 都以当前项目 HEAD 调用同一 Story 对账；HEAD 不可读取时保守
显示待重验或不可验证。展示不把本地凭证称为 GitHub 共享证明。

## 实施切片

1. 新增 ADR-020，并修订 ADR-013、014、015 中被取代的 legacy、`gitHead:null` 与待验收回滚说明。
2. 实现结构化持久凭证、统一评估/对账、签发、撤销、所有权恢复和摘要。
3. 只为 validation-only 路径分类机械检查、TDD 与 Validator 结果，按明确失败或不可验证清除或
   保留跨轮旧候选；实现两遍 Story 选择，普通 Builder 轮不变。
4. 在启动、轮界、Builder/Validator 后和完成出口接入对账；正式 HEAD 缺失提前停止。
5. 给 Final Review binding 增加凭证集合摘要，并在模型前后复核。
6. 让 status、report、dashboard 使用同一当前性判断；实现与测试通过后同步 architecture，并把
   patterns 中明确标注的目标规则改为已验证事实；在此之前不宣称当前程序具备该能力。
7. 先运行定向失败回归，再运行格式、静态检查、类型检查、全量测试、构建和成品 CLI 冒烟。

## 验证范围

- `src/engine/state.test.ts`：结构、签发、失效、legacy、摘要、相同 AC 的跨 Story 凭证置换与 AC 调序。
- `src/engine/gate.test.ts`：validation-only 对门禁非零与不可验证结果的分类不改变普通轮行为。
- `src/engine/tdd-gate.test.ts`：validation-only 中确定政策违规/coverage 非零与环境不可验证分支。
- `src/engine/loop-gates.test.ts`：纯重验分别通过、打回或保留旧候选停止；只有明确失败增加 retry，达到上限后 blocked 且不再调用 Builder。
- `src/engine/loop-head-binding.test.ts`：项目检查、TDD 与 Validator 各边界的 HEAD 漂移优先按不可验证处理，不接受跨提交结果。
- `src/engine/model-preflight.test.ts`：validation-only 只要求 Validator/Review 路由。
- `src/engine/loop-preflight.test.ts`：无 HEAD 提前停止、不依赖旧 Final Review，且 state/retry 不变。
- `src/engine/loop-lifecycle.test.ts`：两遍选择、保留候选、跳过 Builder、多 Story 收敛。
- `src/engine/loop-validation-protocol.test.ts`：合法 result 签发精确凭证，错绑和改写失败关闭。
- `src/review/final-review.test.ts`、`src/review/state.test.ts`、`src/review/status.test.ts`：摘要绑定与前后失效。
- `src/status/status.test.ts`、`src/report/*.test.ts`、`src/dashboard/server.test.ts`：展示不复活旧绿灯。

上述范围已实现。2026-08-02 收口时，凭证集合摘要、Final Review 多边界复核、旧 Review 兼容失效、
loop 接受竞态以及 status/report/dashboard 当前 HEAD 下的内存撤销均有定向回归；类型、静态检查和
差异格式检查同时通过。实际命令结果仍以对应 PR 的 CI 记录为共享证据。

## 黄金原则对照

| 原则                    | 适用性与设计裁决                                                                                                     | 计划验证证据                                            |
| ----------------------- | -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------- |
| 1. 先定义可证伪完成合同 | 适用。上表逐条写明可观察的通过条件、失败信号和测试位置。                                                             | 每条标准至少一个失败断言；人工边界明确写入信任边界      |
| 2. 生成方不得自签       | 适用。`passes` 和 Validator result 都是候选声明；只有引擎核对目标、协议、HEAD 和 `acceptanceHash` 后签发并持续复核。 | 伪造字段、错 request/head/hash、缺结果均不得签发或完成  |
| 3. 自治扩大需同步防线   | 本变更不扩大 Agent 写入、命令、合并、发布或删除权限；validation-only 反而跳过无价值 Builder 调用。                   | 调用次数与失败关闭测试；不新增自动合并或发布路径        |
| 4. 原生能力优先         | 适用。复用 Git HEAD、现有结构化 Validator 协议、现有循环与 runner adapter，不自建服务或 runner。                     | 核心状态和评估保持 runner-neutral；无供应商分支         |
| 5. 假绿率与恢复         | 适用。先固定无 Final Review、多 Story H1→H2、legacy 缺凭证和 Story ID/AC 变化四类失败，再验证 validation-only 恢复。 | 失败/成功成对回归；对账模型调用次数、非零退出与最终状态 |

预期价值指标是减少“旧 Validator 结论仍显示绿色”的假绿，并减少仅因证据过期导致的 Builder 重复
调用。实施中没有新增需要用户补充裁决的范围项；任何超出“明确不做”的需求必须另建计划。
