---
title: 005-engine-quality-gate
status: active
updated: 2026-07-31
scope: root
---

# 005. 验证链引入引擎机械门禁（确定性验证层）

## 背景

引擎完成判定完全信任 state.json 的 passes 字段，验证链 builder → validator → /review-loop → 人全部是概率性防线（LLM 复核 LLM），「validator 共谋假绿」已有实证（0.12.x，见 glossary「假绿」）。外部触发：雷哥《Agents增加指令遵从的方法》——指令遵从靠提高造假成本，结果验证靠确定性程序独立复跑。

## 决策

prd.json 顶层可选 `qualityChecks`（完整 shell 命令数组）；引擎在每轮 builder 之后、validator 之前逐条执行（fail-fast，单条超时 10 分钟），任一非零退出码即机械打回（passes=false、retryCount+1、notes 写 `[门禁失败]`、达 MAX_RETRIES 转 blocked）并跳过该轮 validator。打回上限 MAX_RETRIES=5 以引擎为单一真相源，validator.md 经 `{{MAX_RETRIES}}` 渲染共享。配置错误在派生环节拦截：prd-to-json 写入前试跑并确认基线全绿。

## 当前状态（2026-07-31）

上述段落保留最初决策的历史原文。ADR-018 与 ADR-021 已替代其中的配置和执行细节：

- `qualityChecks` 不再是可选 shell 字符串数组，而是从受 Git 管理的质量契约冻结派生的必需结构化快照；
- 每条检查使用契约自己的执行文件、参数、工作目录、平台和超时；只有契约明确声明时才启用 shell；
- `prd-to-json` 只准备候选并交用户确认，不在 skill 外围试跑任意项目命令；正式 `workspace apply-prd`
  只在已确认的 TDD 政策要求时，于受管 session 内运行基线；
- 子进程由 ADR-021 的隔离与结算协议统一管理。

本 ADR 仍然有效的核心是不变量：Developer 之后、Validator 之前由引擎独立运行机械检查；失败时
fail-fast、跳过该轮 Validator，并由引擎掌握打回与阻断状态。

## 理由与备选

- **为什么在引擎而非 git hooks**：pre-commit 侵入目标仓库配置、agent 可 `--no-verify` 绕过；引擎层不可绕过、不可共谋，且与项目定位同构——循环编排已是确定性程序，验证中可机械化的部分应当下沉。
- **为什么跳过该轮 validator**：门禁失败已足以打回，validator 那轮 token 纯属浪费；失败信息（输出尾部）直接进 notes 供 builder 下轮重现。
- **为什么 validator 不减负**（门禁通过后仍逐条验收含 Typecheck passes 类 AC）：让 validator 跳过已覆盖条目需要 AC↔命令映射，复杂度不值；保留冗余防线，有实证再优化。
- **为什么不做独立子命令**（`coding-x gate`）：用户手动验证直接敲 npm test 即可，多余入口（YAGNI）。

## 后果

- 循环内新增一段确定性执行时间（每轮 builder 后跑一遍 qualityChecks，典型秒级到分钟级）；换来 builder 谎报「检查通过」被零成本戳穿、失败轮不再烧 validator 的 token。
- `MAX_RETRIES` 成为 gate.ts 与 validator.md 的共享耦合点（经 `{{MAX_RETRIES}}` 渲染共享）：改上限只动引擎一处；新增渲染键时须同步 renderInstruction 测试。
- 配置错的命令（不存在/写错）在循环内与真实失败不可区分（127 不特判）：拦截完全依赖 prd-to-json 派生环节的试跑检查项——绕过派生链手写 prd.json 的用户失去这层保护，门禁失败会烧满 5 轮到 blocked。
- validator 的 token 成本有意不减：门禁通过后「Typecheck passes」类 AC 仍被 validator 重验（接受的冗余防线）。
- 门禁命令由 ADR-021 的平台隔离器统一启动和收口；根进程结束、超时或中断都必须等到整组后代已确认退出。仍有后代或无法确认时保留隔离状态，不能让下一轮与旧门禁重叠，也不能把单个 kill 命令成功当成完成证明。
- 「不可绕过、不可共谋」的论证隐含依赖 prd.json 运行期不可变——该前提当时无机械保证（builder 改写 qualityChecks 可延迟一轮静默架空门禁），由 ADR-007 运行期冻结闭环。
