---
title: 引擎 dogfood 回归断言清单
status: active
updated: 2026-07-22
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
| 1 | 含 UI 验收的每个 story，builder 都先跑 `which agent-browser` 探测再做浏览器验证，无静默降级为 HTTP 冒烟 | 0.12.1 条件句翻车 | UI story 的 builder 输出含真实浏览器验证记录（操作序列/截图对账）；无以 HTTP 冒烟等价替代的表述（--print 模式无过程 transcript，2026-07-07 起以输出与工件为核对面） |
| 2 | 最终浏览器验证留下 `builder-[story-id]-[序号].png` 于 workspace `screenshots/`；无截图视为未验证 | 0.14.1 | 按 story 对账 screenshots 目录 |
| 3 | validator 验收执行了真实操作并留截图工件（通过与打回两分支皆有） | 0.3.0 / 0.12.1 反共谋实证 | 同上，含打回场景 |
| 4 | prd-to-json 派生新 PRD 前，工作区旧 `state.json` 已删除或归档（story id 重编不撞旧状态） | 0.10.0 空转翻车 | 引擎首轮无「旧轮 passes 误判已完成」 |
| 5 | builder 在有意识简化处留 `// 取舍: <当前上限>，<升级触发条件>`；compound-docs 收账产出账本（非空或「无取舍债务」） | 0.8.0 约定 / 0.12.1 首次触发 | `grep -rn "取舍:"` 与收口账本对照 |
| 6 | 打回链路中 notes 保全仲裁标签行（`[需求冲突]`、`[需要人工核实]`）不丢失 | 0.4.0 仲裁约定 / 0.18.1 扩前缀族 | 触发过打回的 story 检查 notes |
| 7 | 配置 `qualityChecks` 时：builder 后 validator 前逐条执行，失败确定性打回（notes 带 `[门禁失败-第N次]`）且该轮跳过 validator | 0.14.0（引擎单测已覆盖，此处验真实 agent 链路） | 制造一次门禁失败，观察打回路径 |
| 8 | /review-loop 人审包含 scope 越权核对节（AC 之外改动的反向清单） | 0.13.0 | 审查包结构检查 |
| 9 | /compound-docs 沉淀中改写/删除既有条目时，交付说明附规则变更清单（旧表述 → 新表述 + 当前代码依据） | 0.14.4 | 收口交付说明检查（无改写则不适用） |
| 10 | /compound-docs 收口交付说明含「状态变更清单」节（有变更列明细，无变更写「无状态变更」），任务型文档按证据表判定收尾 | 0.15.0 | 收口交付说明检查 |
| 11 | 循环结束（完成或跑满）workspace 根自动生成验证报告 report.html：结果横幅与 state 一致、story 卡片截图与 screenshots/ 对账、存在 prd.tampered-* 时红旗区必亮、review-*.md 收录进人审留痕区且带免责标注 | 0.19.0 | 打开 report.html 与工件对账 |
| 12 | 证据索引真实链路：evidence.jsonl 含三类 engine 记录且时间线可重建（iteration 记录每轮一条（时间线零空洞），异常轮带 outcome/noop/gateRejected/abortRollback 标注可直读还原）；builder/validator 按指令登记 screenshot-claim（grep acIndex 分布核对输入质量：整数、1 起、无越界泛滥）；报告 AC 对账区与门禁执行历史真实渲染 | 0.20.0（终审风险②③④固化）；0.22.0 还原链重构 | 真实跑后逐类 grep evidence.jsonl + 打开 report.html 对账 |
| 13 | 启用按难度模型路由时，真实 builder/validator 分别命中 story 档位与 validator 映射；启动摘要、evidence、status JSON 与 report 时间线里的模型 ID 和 route source 四处一致 | 0.23.0 / 0.24.0 | 对账控制台、iteration 记录、`status --json.recentActual` 与 report 时间线 |
| 14 | builder 与 validator 都原样保留 `validated`/`escalated`；只有 validator 正常完成且候选仍通过后，引擎签发 `validated=true`，status/report 才显示全绿 | 0.25.0–0.25.1 | builder 后候选态、最终 state、iteration.validationReceipt、status/report 四处对账 |
| 15 | 使用 npm 正式发布物运行时，全局模型目录、预检与真实 runner 调用贯通；目录不做在线发现，provider 的非阻断诊断噪声不得改变引擎对进程结局和验收凭证的机械判定 | 0.24.0 / 0.25.2 | `config validate`、启动目录摘要、runner 实际结局、最终退出码与锁释放对账 |
| 16 | builder 的 story 提交只包含实现与测试，不包含 prd/state/progress/evidence/report/lock 等 workspace 运行时文件；即使目标仓尚未 gitignore workspace，也必须先提交业务改动，再单独回写 state/progress | 0.25.2 真实链路发现 | `git show --name-only` 对账 story commit，循环结束后检查 runtime diff 只留在 workspace |
