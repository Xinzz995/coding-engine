---
title: "dogfood 发现修复轮（仲裁标签保全/blocked 保护/篡改凭证/断言校准/回流规范）设计"
status: active
updated: 2026-07-07
scope: root
---

# dogfood 发现修复轮设计（findings a–e）

日期：2026-07-07
来源：引擎真实跑 dogfood 轮发现清单 `docs/superpowers/2026-07-07-dogfood-findings.md`（四机制首验 + Fable 5 代际实测轮检出）。全部为已被真实场景实证的缺陷/缺口，无假想需求。

## 背景与动机

dogfood 门禁打回定向验证（US-009 场景）暴露一条真实的「人在环」失效链：sonnet builder 识破注入门禁后置 `blocked: true` + notes 写 `[需要人工核实]` 完整调查请求人工仲裁，随后门禁打回路径把两者全部无声覆盖——notes 保全规则只认字面 `[需求冲突]`（gate.ts:126 与 validator.md 两处三点分散字面量，正是 #7 词汇表单源警告的场景），blocked 按 retryCount 纯重算（gate.ts:125）。同轮还实证：`.workspace/` 根的 `prd.tampered-*.json` 归档会诱导 agent 对合法停机变更产生篡改怀疑（agent 无从获得配置权威性凭证）；断言 #1 的「过程记录出现探测命令」在 `--print` 模式下不可核对；review 检出的 AC 级缺口（generate 越权）因 0.12.1 修复未回流源 PRD 而在本轮如期复现。

## 锁定决策

1. **仲裁标签前缀族 + 单源（a）**：`gate.ts` 导出唯一源 `ARBITRATION_PREFIXES = ['[需求冲突]', '[需要人工核实]']`——把 dogfood 中 agent 自发发明的变体转正为规范标签。`applyGateFailure` 的 notes 保全过滤从 `startsWith('[需求冲突]')` 扩为前缀族任一匹配。`loop.ts` 的 `renderInstruction` 机制新增 `{{ARBITRATION_PREFIXES}}` 占位符（复用 `{{MAX_RETRIES}}` 先例），渲染形态为中文顿号连接的标签列表（`[需求冲突]、[需要人工核实]`）。validator.md 两处规则（通过时「只保留这些行否则清空」、打回时「原样保留在新内容之前」）与 builder.md 的标签教育句全部改经占位符渲染；`status.ts:90` 的 🚨 醒目标记从单标签 `startsWith` 改为引用 `ARBITRATION_PREFIXES` 前缀族匹配（否则新标签在 `status` 速览中不高亮，仲裁信号链不闭环）——四文件字面量归一 gate.ts 单源，#7 的全部四文件场景就此收口。builder.md 补通用仲裁用法一句：非需求冲突但需要人工介入的情况（如怀疑配置/环境异常、无法安全继续）用 `[需要人工核实]` 开头记录 notes。
2. **blocked 显式置位保护（b，两层）**：b-i——`applyGateFailure` 的 `blocked` 改为 `prev.blocked || retryCount >= MAX_RETRIES`，agent 显式阻塞不被门禁打回翻回。b-ii——loop.ts 门禁执行前（`checks && currentStory` 分支处）重读磁盘 state：`currentStory` 已被 agent 置 `blocked: true` 时跳过门禁执行与 validator（console 说明「story 已被 agent 置 blocked，待人工处理，本轮跳过门禁与验收」），流程直落完成判定（blocked 属 resolved，当轮即可正常收敛退出）。门禁自身把最后 story 打到 blocked 的既有末轮不对称（loop.ts:157 注释）维持接受，不动。
3. **prompt 权威凭证声明（c）**：builder.md 与 validator.md 各加一段声明——prd.json 受引擎运行期快照保护（ADR-007）：agent 读到的内容即权威验收标准；`{{WORKSPACE}}/prd.tampered-*.json` 是引擎已检测并处置的篡改存档，供人工审查，agent 无需自行审计 prd.json 的来源与完整性。不加行为禁令（不写「禁止怀疑」类措辞）——保留 agent 对真异常的上报本能，修复对象是凭证缺失而非警惕性。归档位置不挪（零破坏性变更；声明治本后，挪目录收益边际）。
4. **断言 #1 校准（d）**：dogfood-regression.md 断言 #1 的验证点从「story 过程记录出现探测命令；无『无浏览器工具』自判」改为可观察形态：「UI story 的 builder 输出含真实浏览器验证记录（操作序列/截图对账），无以 HTTP 冒烟等价替代的表述」。断言与来源列保留。builder.md 的探测式指令本身不动（0.12.1 修复已实证行为正确，改的只是复查手段）。
5. **review-loop 回流规范（e）**：commands/review-loop.md 第 4 节 `[已修]` 四态定义处补一句：发现属 AC 缺失/AC 错误类（动作三档判据①的 AC 挑战类）时，detail 除修复提交外须含源 PRD 回补提交（回补后按需再派生）——依据：generate 越权在 0.12.1 修复未回流，本轮从干净 PRD 重跑如期复现，实证「不回流必复现」。
6. **测试面**：`applyGateFailure` 新增用例——`[需要人工核实]` 行保全、两标签混合保全、`prev.blocked=true` 保持；b-ii 用例——blocked story 门禁不执行（stub 计数为零）、validator 不拉起、完成判定当轮生效；`renderInstruction` 的 `{{ARBITRATION_PREFIXES}}` 渲染断言；builder.md/validator.md 占位符存在性 grep 断言（防手改漂移回字面量）；status 对 `[需要人工核实]` 行输出 🚨 的用例。
7. **版本与文档**：patch 升版 0.18.0 → 0.18.1——全部为缺陷修复与文档校准，无产物路径/命令名变更，无面向用户破坏性行为。README 与 ADR 不动（notes 保全粒度未进入 README；a/b 是 ADR-005 机制的行为修正非决策变更）；实施时复核一遍此判断。findings 文档（`2026-07-07-dogfood-findings.md`）随本轮交付置 done。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/engine/gate.ts` | 导出 `ARBITRATION_PREFIXES`；`applyGateFailure` 过滤扩前缀族 + blocked 保持 |
| `src/engine/loop.ts` | `renderInstruction` 增 `{{ARBITRATION_PREFIXES}}`；门禁前 blocked 检查跳过（b-ii） |
| `src/status/status.ts` | 🚨 醒目标记改前缀族匹配（引用 `ARBITRATION_PREFIXES`） |
| `assets/instructions/builder.md` | 标签教育句经占位符渲染 + 通用仲裁用法一句 + prd.json 权威凭证声明 |
| `assets/instructions/validator.md` | 两处 notes 规则经占位符渲染 + prd.json 权威凭证声明 |
| `docs/superpowers/dogfood-regression.md` | 断言 #1 验证点校准 |
| `commands/review-loop.md` | 第 4 节 `[已修]` 补 AC 缺失类回流要求 |
| 测试（gate.test.ts / loop.test.ts 等既有位置） | 决策 6 的用例 |
| `docs/superpowers/2026-07-07-dogfood-findings.md` | 交付后置 done |
