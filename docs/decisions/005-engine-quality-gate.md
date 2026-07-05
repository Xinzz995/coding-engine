---
title: 005-engine-quality-gate
status: active
updated: 2026-07-05
scope: root
---

# 005. 验证链引入引擎机械门禁（确定性验证层）

## 背景

引擎完成判定完全信任 state.json 的 passes 字段，验证链 builder → validator → /review-loop → 人全部是概率性防线（LLM 复核 LLM），「validator 共谋假绿」已有实证（0.12.x，见 glossary「假绿」）。外部触发：雷哥《Agents增加指令遵从的方法》——指令遵从靠提高造假成本，结果验证靠确定性程序独立复跑。

## 决策

prd.json 顶层可选 `qualityChecks`（完整 shell 命令数组）；引擎在每轮 builder 之后、validator 之前逐条执行（fail-fast，单条超时 10 分钟），任一非零退出码即机械打回（passes=false、retryCount+1、notes 写 `[门禁失败]`、达 MAX_RETRIES 转 blocked）并跳过该轮 validator。打回上限 MAX_RETRIES=5 以引擎为单一真相源，validator.md 经 `{{MAX_RETRIES}}` 渲染共享。配置错误在派生环节拦截：prd-to-json 写入前试跑并确认基线全绿。

## 理由与备选

- **为什么在引擎而非 git hooks**：pre-commit 侵入目标仓库配置、agent 可 `--no-verify` 绕过；引擎层不可绕过、不可共谋，且与项目定位同构——循环编排已是确定性程序，验证中可机械化的部分应当下沉。
- **为什么跳过该轮 validator**：门禁失败已足以打回，validator 那轮 token 纯属浪费；失败信息（输出尾部）直接进 notes 供 builder 下轮重现。
- **为什么 validator 不减负**（门禁通过后仍逐条验收含 Typecheck passes 类 AC）：让 validator 跳过已覆盖条目需要 AC↔命令映射，复杂度不值；保留冗余防线，有实证再优化。
- **为什么不做独立子命令**（`coding-x gate`）：用户手动验证直接敲 npm test 即可，多余入口（YAGNI）。
