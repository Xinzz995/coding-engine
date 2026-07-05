---
title: 引擎 dogfood 回归断言清单
status: active
updated: 2026-07-06
scope: root
---

# 引擎 dogfood 回归断言清单

<!-- 历次 prompt 行为级翻车的固化断言。每轮引擎真实跑 dogfood 时逐条复查，防旧病复发；
     新的 prompt 行为翻车修复后在此追加一条。只收 prompt 行为级断言——代码级缺陷由
     Vitest 回归覆盖，不重复登记。思想来源：skill 修订应有测试用例可复测
     （agentskills.io evaluating-skills 的轻量适配：不做 with/without 对照，只做历史断言复查）。 -->

复查方式：引擎循环跑完后，按「验证点」列逐条核对工件与记录；任一条不成立即为回归，修复并复验后才能收口。

| # | 断言 | 来源 | 验证点 |
|---|---|---|---|
| 1 | 含 UI 验收的每个 story，builder 都先跑 `which agent-browser` 探测再做浏览器验证，无静默降级为 HTTP 冒烟 | 0.12.1 条件句翻车 | story 过程记录出现探测命令；无「无浏览器工具」自判 |
| 2 | 最终浏览器验证留下 `builder-[story-id]-[序号].png` 于 workspace `screenshots/`；无截图视为未验证 | 0.14.1 | 按 story 对账 screenshots 目录 |
| 3 | validator 验收执行了真实操作并留截图工件（通过与打回两分支皆有） | 0.3.0 / 0.12.1 反共谋实证 | 同上，含打回场景 |
| 4 | prd-to-json 派生新 PRD 前，工作区旧 `state.json` 已删除或归档（story id 重编不撞旧状态） | 0.10.0 空转翻车 | 引擎首轮无「旧轮 passes 误判已完成」 |
| 5 | builder 在有意识简化处留 `// 取舍: <当前上限>，<升级触发条件>`；compound-docs 收账产出账本（非空或「无取舍债务」） | 0.8.0 约定 / 0.12.1 首次触发 | `grep -rn "取舍:"` 与收口账本对照 |
| 6 | 打回链路中 notes 保全 `[需求冲突]` 行不丢失 | 0.4.0 仲裁约定 | 触发过打回的 story 检查 notes |
| 7 | 配置 `qualityChecks` 时：builder 后 validator 前逐条执行，失败确定性打回（notes 带 `[门禁失败-第N次]`）且该轮跳过 validator | 0.14.0（引擎单测已覆盖，此处验真实 agent 链路） | 制造一次门禁失败，观察打回路径 |
| 8 | /review-loop 人审包含 scope 越权核对节（AC 之外改动的反向清单） | 0.13.0 | 审查包结构检查 |
| 9 | /compound-docs 沉淀中改写/删除既有条目时，交付说明附规则变更清单（旧表述 → 新表述 + 当前代码依据） | 0.14.4 | 收口交付说明检查（无改写则不适用） |
