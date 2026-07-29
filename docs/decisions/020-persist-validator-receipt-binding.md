---
title: 020-persist-validator-receipt-binding
status: active
updated: 2026-07-29
scope: root
---

# 020. 持久保存并持续核对 Validator 目标绑定

## 背景

ADR-015 保证单次 Validator 调用的结构化结果与本轮 request、story、验收标准摘要和 Git HEAD
一致，但 ADR-013 的持久完成态仍只有 `validated` 布尔值。提交或验收标准随后变化时，该布尔值
无法证明仍然新鲜。现有启动失效又以旧 Final Review 为间接锚点，导致没有 Final Review、文件
损坏或多 Story 后续提交时，旧 Story 可能未经最终提交重验就进入 Final Review。

## 决策

每个 Story 的引擎独占状态增加结构化 `validationReceipt`，固定记录 schema 版本、request ID、
非空 Git HEAD 和有序 acceptanceCriteria 摘要。引擎只有在合法 Validator claim 已通过全部
协议检查且调用期间 HEAD 未变化时，才原子写入 `validated=true` 与完整凭证。

正式通过不再由裸布尔值决定。引擎以当前 PRD、当前 Git HEAD 和 Story 状态统一评估：非
blocked、`passes=true`、`validated=true`、凭证结构合法、凭证 HEAD 等于当前 HEAD 且验收
摘要等于当前有序标准，缺一不可。

启动、每轮选取前、Validator 完成后以及 Final Review 前后都执行同一对账。失效的实现候选
保留 `passes=true`，清除验证态和凭证，进入 validation-only 轮：跳过 Developer，仍完整运行
机械检查和 Validator。若重验失败，再回到 `passes=false` 交给 Developer。所有 Story 因此在
最终 Review 前收敛到同一 HEAD，且不会因纯新鲜度问题产生重复实现调用。

项目机械检查会执行仓库代码，但没有 workspace 状态所有权。普通检查和 TDD 检查前后对
`state.json` 做完整快照比较；任何改写都恢复并以 `gate` 来源留痕，不能替其他 Story 伪造凭证。
`--max-iter` 继续约束实现/修复轮；validation-only 的总余量按“Story 数量 × `stall-limit`”
计算，相当于为每个 Story 预留 `stall-limit` 轮，允许瞬时失败后仍有成功机会，同时不让确定性
收敛步骤挤占实现预算。

正式模式无法读取 Git HEAD 时，在任何 Agent 或 Review 模型调用前返回配置/状态错误。旧状态
可解析但不自动视为当前有效；不从 evidence、Final Review 或当前文件反向补造凭证。

status、report、dashboard 与循环消费同一评估结果。Final Review 前置先确认工作树干净，再在项目
机械检查前冻结全部 Story 凭证摘要；检查返回后重新核对凭证身份和工作树，再允许 Reviewer 运行；
模型后、远端查询后及结果写入后继续核对，防止项目命令伪造凭证、留下未提交源码或运行中漂移。

`review-decisions.json` 在 coding-x 启动、任何项目代码执行前按原始字节冻结。Agent、机械检查或
Reviewer 在运行中改写它时，引擎恢复启动快照、删除已产生的 Final Review 并返回不可验证；
合法新裁决只能在本轮退出后由 `/review-loop` 写入，再由下一次运行消费。

Final Review 还绑定启动 PRD 中 `models` 路由政策的稳定摘要；命令行临时模型覆盖不进入该摘要，
但实际 Runner、模型与 Runner 版本继续分别绑定。Spec 或工程 Reviewer 主动要求深度评审时，
引擎以固定风险类别和原因更新唯一风险判断；读取状态时由已保存的评审轴重建同一判断，无法
重建或轴与风险矛盾的结果一律视为损坏。

## 信任边界

该凭证是引擎控制流中的持久身份记录，不是数字签名。engine、agent 和用户仍共享本机权限，
有权限直接改 workspace 的恶意进程可以伪造文件。本决策消除正常运行、异常恢复和展示消费中
的过期/错绑假绿，不声称建立本机外部可信根，也不让 GitHub 证明本地 Review。

## 理由与备选

- **保留布尔字段并增加结构化凭证**：兼容现有展示和 schema，同时让完成判定有可复核身份；
  单纯扩展 `validated` 的含义仍无法判断新鲜度。
- **validation-only 收敛而非全部退回 Developer**：过期表示证据需重验，不等于实现已知错误；
  只有机械检查或 Validator 发现失败才需要再次实现。
- **任一提交使所有旧凭证失效**：无法低成本且可靠地证明某个后续提交不会影响另一 Story；
  保守全量重验比基于路径猜测更真实。
- **精确有序 AC 摘要**：验收标准文字、数量或顺序任一变化都可能改变要求，不采用“实质变化”
  的模型判断。
- **不从历史证据迁移**：旧 evidence 和 Final Review 是不同目的的记录，反推会把无法证明的
  历史结论包装成当前凭证。
- **不使用全工作树哈希或签名**：正式前置已要求提交和干净工作树；读取全部文件会引入密钥、
  大文件与生成物边界，同权限签名也不能增加真实隔离。

## 后果

- 旧 workspace 第一次由新版本正式运行时需要重新验证已通过 Story；没有旧项目迁移承诺。
- Final Review v1 缺少 Story 凭证、冻结裁决与 PRD 路由绑定，不迁移、补造或继续视作通过；
  必须重新运行正式流程生成 v2。
- `passes=true, validated=false, validationReceipt=null` 从异常残态升级为明确的“实现候选待验收”
  状态，循环不得在启动时无条件打回。
- 状态、status JSON 和 dashboard API 增加公开字段：每个 Story 暴露 `validationReceipt`，status 与
  dashboard 暴露 `validationInvalidations`，Final Review v2 增加 Story 凭证、冻结裁决与 PRD 路由
  摘要绑定；属于需要 minor 版本的行为变化。
- ADR-013 的 legacy 自动视作已验证、ADR-015 的 `gitHead:null` 正式降级，以及 ADR-014 的
  缺失 state 历史绿灯兼容范围被本 ADR 取代。
