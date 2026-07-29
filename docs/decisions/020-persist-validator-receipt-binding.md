---
title: 020-persist-validator-receipt-binding
status: active
updated: 2026-07-30
scope: root
---

# 020. 持久保存并持续核对 Validator 目标绑定

## 背景

ADR-015 已保证单次 Validator 结果与本轮 request、story、有序验收标准摘要和 Git HEAD 一致，
但 ADR-013 的持久完成态仍只有 `validated` 布尔值。提交、Story ID 或验收标准随后变化时，该布尔
值无法说明它是否仍然对应当前目标。

现有提交失效又间接依赖旧 `final-review.json`：只有旧 Final Review 可读且 head 不同时才重验。
因此，没有旧 Final Review、旧文件损坏，或多 Story 中后续 Story 产生新提交时，先前 Story 仍可能
以旧提交上的 `validated=true` 进入最终 Review。这是 Issue #90 要消除的假绿。

## 决策

### 持久凭证与唯一当前性判断

每个 Story 的引擎独占状态增加结构化 `validationReceipt`，记录：

- schema 版本；
- 本轮 Validator request ID；
- 非空 Git HEAD；
- `acceptanceHash`：调用既有 `acceptanceHash(currentStory.id, currentStory.acceptanceCriteria)`，
  对 `{ storyId: 当前 Story ID, acceptanceCriteria: 当前有序 acceptanceCriteria }` 计算的 SHA-256
  摘要，数组顺序参与计算。

`validated` 暂时保留以兼容既有展示和状态结构，但不能脱离结构化凭证证明通过。正式有效通过必须
同时满足：Story 未 blocked、`passes=true`、`validated=true`、凭证结构合法、凭证 HEAD 等于
当前 HEAD，且以当前 Story ID 和当前有序验收标准重新计算的摘要等于凭证 `acceptanceHash`。因此，
即使两个 Story 的验收标准文本相同，把一个 Story 的凭证放到另一个 Story 也必须失效。

引擎以一组 runner-neutral 纯函数完成凭证解析、单 Story 当前性评估、全状态对账、签发、撤销和
Final Review 摘要计算。循环、完成判定和所有展示消费同一个评估结果，不再各自拼接布尔条件。

旧 state 仍可读取，但缺少结构化凭证时只能表示历史实现候选：保留 `passes=true`，撤销
`validated`，不从 evidence、旧 Final Review 或当前文件反向补造凭证。损坏状态继续按 ADR-014
失败关闭。

### 失效与 validation-only

引擎在启动、每轮选取前、Builder 返回后、Validator 返回后和进入 Final Review 前，以当前 PRD
与 Git HEAD 对账全部 Story。提交变化会保守地使所有旧提交凭证失效；Story ID 或验收标准的内容、
数量、顺序变化只使对应 Story 失效。

失效只撤销 Validator 结论和结构化凭证，不删除 `passes=true` 的实现候选。循环优先处理尚无实现
候选的 Story；所有非 blocked Story 都有候选后，再处理凭证过期的 Story。validation-only 轮跳过
Builder，但仍完整执行项目机械检查、可选 TDD 门禁和 Validator。启动预检发生在选择 Story 和建立本轮
纯重验之前：预检失败时不启动 Agent，也不修改任一 Story 的候选、凭证或 retry。

只有“凭证过期但已有 `passes=true` 候选”的 validation-only 轮使用下述恢复分类：

| 结果           | 判定                                                                                                         | 状态转移                                                                                            |
| -------------- | ------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------- |
| `passed`       | 适用机械/TDD 检查全部通过；或 Validator 返回合法 passed claim                                                | 保持候选并继续下一验证步骤；Validator passed 后签发凭证                                             |
| `failed`       | 项目命令正常启动、正常结束并按冻结合同返回非零；确定的 TDD 政策违规；合法 Validator failed                   | 清除候选与凭证，沿用既有 retry、升级与 blocked 规则；未 blocked 时才重新进入 Builder                |
| `unverifiable` | 机械/TDD 超时、无法启动、信号异常、终止失败、引擎平台/目录/配置/政策无法可靠读取；或 Validator 运行/协议异常 | 保留候选、撤销凭证、不增加 retry，并立即非绿结束；前一类不进入 Validator，后一类不进入 Final Review |

质量契约明确声明某项机械检查不适用于当前平台时正常跳过，不属于不可验证；TDD `coverageCheck` 没有
独立的平台跳过声明。

本段只 supersede ADR-009 与 ADR-017 对 validation-only 旧候选的异常回写：旧凭证失效不等于当前
实现已知有错，环境或协议不可验证时不能因此重复调用 Builder。普通 Builder 刚产生的新候选仍完全
沿用 ADR-009、ADR-017 的现有异常回写、stall、retry、升级与 blocked 语义；本决策不把三态扩展成
全局门禁改造。

TDD 的确定违规包括政策摘要不匹配、新增禁止的忽略标记和必需政策文件确定缺失；Git、基线、文件、
平台或执行环境无法可靠检查时属于不可验证。`coverageCheck` 正常启动并以非零结束时按冻结合同属于
失败；超时、无法启动或信号异常属于不可验证。只有合法 Validator passed claim 才签发绑定当前 HEAD
与当前 Story/有序验收标准的新凭证。

引擎不解析命令输出猜测失败原因。若契约显式选择 shell，外层 shell 正常结束并返回非零，即按契约
视为 `failed`；脚本内部工具缺失无法可靠区分，若项目需要更细语义，应改用结构化命令，而不是把
输出文本识别混入本决策。

正式模式无法读取非空 Git HEAD 时，在任何 Developer、Validator 或 Review 模型调用前停止。协议
类型为历史诊断保留 `gitHead:null` 的读取能力，不代表正式运行可以据此签发持久凭证。

### Final Review 与展示

全部非 blocked Story 的精确凭证按 PRD 顺序计算稳定摘要，并加入 Final Review binding。最终 Review
在完整机械检查结束后、任何模型调用前重新计算摘要；所有评审轴结束后、接受结果前再次核对。任一
核对失败都使本轮不可验证，旧 Review 也不能继续显示为当前结果。

status、report 和 dashboard 在读取状态时使用当前 Git HEAD 执行同一对账：过期凭证显示为待重验，
不能显示旧绿灯。只读命令不回写 state；正式循环会把撤销结果原子落盘。

## 信任边界

持久凭证是本地引擎控制流中的目标身份记录，不是数字签名。engine、agent 与用户仍共享本机权限；
有权限直接修改 workspace 的恶意同权限进程仍可伪造文件。本决策只消除正常运行、恢复与展示路径中
的过期和错绑假绿，不把本地 workspace 描述为 GitHub 证明或外部可信根。

Git HEAD 只标识已提交内容，不证明当前开发目录中被忽略文件、依赖目录或本机配置与提交一致。
精确提交的干净检出执行由 Issue #91 独立设计和验收，本决策不得提前宣称已解决该边界。

## 理由与备选

- **保留候选、只撤销验收**：证据过期不等于实现已知错误；validation-only 避免无价值的重复生成。
- **任一新提交使旧提交凭证失效**：Story 与文件没有可靠的多对多映射，按路径猜测会重新引入假绿。
- **保留 request ID**：它不是秘密，而是区分同一 HEAD/Story/AC 下不同验收轮次的精确身份，能
  检出 Final Review 期间凭证被重新签发或替换。
- **不依赖旧 Final Review 触发失效**：Story 凭证必须自含其目标身份；另一份结果文件不能充当间接
  真相源。
- **不改变运行预算合同**：validation-only 仍受现有 `--max-iter` 与 stall 机制约束；预算耗尽返回
  非零已经失败关闭。是否为纯重验建立独立预算需要单独产品裁决。

## 后果

- `state.json` 增加可选的结构化凭证；新引擎写出的有效通过态必须包含它。
- 旧 workspace 首次正式运行时，历史 `passes=true` 成为待重验候选，不再自动恢复绿灯。
- `passes=true, validated=false` 成为稳定的 validation-only 状态，不再一律解释为必须回滚的崩溃
  残态。
- 新 Final Review 必须绑定按 PRD 顺序生成的 Story 凭证集合摘要；缺少该摘要的旧结果可读取，但
  不能继续表示当前可交付。
- 这是面向用户的状态与恢复语义变化，发布时按仓库版本规则处理。

## 明确不做

本决策不引入或修改 runner 可执行文件冻结、`trusted-tool`、`safe-control-file`、进程树管理、Policy
Guard、doctor、P1 延期在线刷新、独立 validation-only 预算或 GitHub 模型任务；也不包含 Issue #91
的干净检出、已由其他变更处理的二进制标记识别，或其他安全加固。它们不能与 Issue #90 的最小
闭环混在同一实现 PR。
