---
title: "prd.json 运行期冻结（门禁配置防篡改）设计"
status: done
updated: 2026-07-07
scope: root
---

# prd.json 运行期冻结（门禁配置防篡改）设计

日期：2026-07-07
来源：validation gate 调研（雷哥《AI coding 最后一公里-Validation 流程》+ no-mistakes 源码对比）发现的真实漏洞；防御思路借鉴 no-mistakes 的「代码执行配置只从受信任副本读取」（其对策是只读默认分支上的 `.no-mistakes.yaml`，本项目的等效受信任锚点是引擎启动时刻的 prd.json）

## 背景与动机

ADR-005 宣称机械门禁「不可绕过、不可共谋」，但存在一条绕过路径：引擎每轮迭代从磁盘重读 prd.json（`loop.ts` 三处 `tryReadPrd`），而「prd.json 运行期只读」只是给 agent 的指令约束，无机械强制。具体篡改面有三个，严重度递增：

1. **门禁面（延迟一轮）**：builder 第 N 轮删改 `qualityChecks`，第 N+1 轮起门禁静默失效（`readQualityChecks` 对未配置返回 null 不告警）。
2. **验收面（当轮生效）**：validator 是独立子进程、自己从磁盘读 prd.json 的 acceptanceCriteria——builder 本轮改弱 AC，validator 当轮即按假标准验收，引擎内存里读过什么都无济于事。
3. **完成判定面（当轮生效）**：完成判定 `after = tryReadPrd(prdPath)` 走磁盘重读，validator（或 builder）删掉未通过的 story 即可骗过 `allStoriesResolved` 提前 exit 0。

且 `.workspace/` 不进 git，篡改无任何痕迹。「循环运行中热更新需求」从未被文档承诺（`[需求已变更]` 标记来自 prd-to-json 的人工再派生流程，属停机操作），为一个未承诺的工作流保留三个漏洞面不值。

## 锁定决策

1. **冻结语义**：一次引擎运行期间，prd.json 冻结为启动快照——引擎的全部 prd 读取以快照为准，磁盘变更一律无效化。改需求的正路是：停引擎 → 修订源 PRD → prd-to-json 再派生 → 重跑（幂等续跑使停机成本≈0；引擎重启即快照合法刷新点，repair 同理）。
2. **实现形态**：新模块 `src/engine/prd-guard.ts`，工厂函数 `createPrdGuard(prdPath)` 返回带 `read()` 的闭包（跟随项目「小模块+函数导出」风格）。闭包持有快照内容（`readFileSync(path, 'utf-8')` 返回的字符串）与快照解析对象（Prd）。`read()`：读磁盘 → 字符串全等比较 → 一致返回解析结果；不一致（含**快照已建立后**的文件缺失/损坏——那是最极端的篡改）执行处置（决策 5）后返回**快照**解析结果。**仅快照未建立时**，缺失/损坏返回 null（与 `tryReadPrd` 现状一致）。比较用原始字符串而非规范化 JSON——运行期没有合法写方，任何字节变化都可疑，宁严勿松。
3. **快照建立时机**：`read()` 第一次成功解析出合法 JSON 时建立（正常即启动 `bootPrd` 处；启动时缺失/损坏则顺延到之后第一次读到），建立后进程生命周期内冻结。已确认 `ensureStateFile` 只写 state.json、从不写 prd.json（state.ts），启动处建立无迁移写回冲突。
4. **检测点四处**：loop.ts 现有三处 `tryReadPrd(prdPath)`（启动 :78、每轮开头 :99、完成判定 :168）全部收口为 `guard.read()`；**新增**第四处——builder 之后、门禁执行前（与门禁同点）：此处必须校验并恢复磁盘，否则本轮 builder 的篡改会被同轮 validator 读到（validator 直读磁盘，等不到下轮开头的检测点）。门禁取数改用该次 `guard.read()` 的返回值（校验+取数同点；快照冻结后与用 before 行为无差）。
5. **篡改处置顺序**：检测到不一致时依次——
   - **存档**：磁盘版写入 `.workspace/prd.tampered-<yyyymmdd-HHmmss>.json`（损坏的 JSON 也按原始内容存档；文件已被删除则无可存档，跳过本步），带内容去重：磁盘内容与上次已存档的篡改版相同则跳过（防同一篡改被多轮循环重复存档爆目录）；
   - **恢复**：快照字节写回 prd.json（validator、门禁、dashboard 此后读到原版）；
   - **告警**：console 详细告警（存档路径 + diff 指引 + 正路指引「若是你本人想改需求：停引擎 → 改源 PRD → 再派生 → 重跑」），同内容重复告警去重（沿用 warnedModels 模式）；
   - **继续循环**，行为完全锚定快照，不中断（无人值守定位）。
6. **退出码不变**：篡改被恢复无效化后，循环结果按真实验收（全绿即 exit 0）——退出码语义是「需求是否全部完成」，不因已被无效化的篡改改变。但运行结束摘要中若发生过篡改必须再提示（次数 + 存档位置）；`.workspace/` 里躺着的 `prd.tampered-*` 文件本身即人审信号。
7. **不写 story notes**：篡改是 PRD 级事件且归因不清（builder / validator / 外部进程均可能），塞进某个 story 的 notes 会误导 builder 下轮「针对性处理」。留证只走存档文件 + console。
8. **写回失败降级**（磁盘满/权限等）：告警说明「写回失败，本轮 validator 验收不可信」并跳过本轮 validator（`continue`，下轮开头重试恢复）。理由：validator 在假 AC 上写出的 passes=true 是毒数据、直接污染完成判定；引擎自身取数不受影响（内存快照）。
9. **dashboard 不加篡改标记 UI**：告警走 console 足够（YAGNI）；恢复后 dashboard 展示的数据自然是原版。
10. **版本与文档**：minor 升版 0.16.0 → 0.17.0（新防护行为 + 新产物文件 `prd.tampered-*`，「运行中改 prd.json」的行为语义有可感知变化）；新 ADR-007「运行期 prd 冻结」（引用 ADR-005，补其「不可共谋」论证的漏洞并修订该 ADR 后果节的失效表述）；README 补冻结语义与 `prd.tampered-*` 说明；architecture.md 模块表加 prd-guard 行。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/engine/prd-guard.ts` | 新建：`createPrdGuard(prdPath)`——快照建立/字节比较/存档去重/写回恢复/告警去重；副作用（存档、写回、console）集中于此 |
| `src/engine/loop.ts` | 三处 `tryReadPrd(prdPath)` 换 `guard.read()`；builder 后新增检测点并把门禁取数切过去；写回失败时跳过本轮 validator；结束摘要加篡改提示 |
| `src/engine/__fixtures__/fake-agent.mjs` | 加「改写 prd.json」场景开关（环境变量驱动，沿用现有 fixture 模式） |
| `README.md` | prd.json 结构说明处补「运行期冻结」语义 + `prd.tampered-*` 文件说明 |
| `docs/architecture.md` | 模块表加 prd-guard 行；数据流节补冻结语义一句 |
| `docs/decisions/007-prd-runtime-freeze.md` | 新 ADR：运行期冻结决策、否因（为什么不是仅 qualityChecks 内存快照、为什么不终止循环）、与 ADR-005 的关系 |
| `docs/decisions/005-engine-quality-gate.md` | 后果节修订：「不可共谋」补充引用 ADR-007 闭环 |
| 测试 | prd-guard 单测（建立时机含顺延/一致通过/篡改检测+存档+写回/存档去重/写回失败降级/缺失损坏 null）；loop 集成测（builder 篡改 checks→门禁仍按原命令、builder 改 AC→validator 前磁盘已恢复、删 story→完成判定不被骗、写回失败→跳过 validator） |

## 非目标

- **state.json 篡改面不修**：builder 批量写 passes=true 可跳过 validator 复核（validator 只验 progress.md 最新 story 的既有设计后果）——防线是机械门禁 + /review-loop + 人审，另案处理；state.json 是 agent 的合法写入目标，不能冻结。
- 不做快照落盘持久化（进程内存足够；重启=合法刷新点）。
- 不做 dashboard 篡改标记 UI（决策 9）。
- /review-loop 感知 `prd.tampered-*` 的人审包高亮留给吸收轮 #1/#2（发现清单动作维度 + resolution 留痕）时一并做。
- 不改 prd-to-json / prd-generate（派生链与本漏洞无关）。
