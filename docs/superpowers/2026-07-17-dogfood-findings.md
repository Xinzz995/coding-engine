---
title: 引擎真实跑 dogfood 发现清单（2026-07-17 轮）
status: active
updated: 2026-07-17
scope: root
---

# 引擎真实跑 dogfood 发现清单（2026-07-17 轮）

<!-- 本轮 dogfood（0.17→0.21 五版首次真实跑：report.html / evidence 索引 / workspace 并发锁 + 12 断言全量复查）
     检出的引擎缺陷与流程缺口，供下一开发轮立项吸收。
     全程证据：.superpowers/sdd/progress.md 的 Dogfood ledger 段、engine-run-20260717{,-gate,-verify}.log、
     fixture .superpowers/fixtures/study-report-dogfood（分支 ralph/study-report-rerun-20260717，
     .workspace/evidence.jsonl 时间线、report.html、archive-run-20260707 为上轮归档）。
     吸收完成后本文件置 done。 -->

背景：fixture 同 PRD 三跑（0.12.1 基线 / 2026-07-07 全 fable / 本轮 sonnet+fable 分层——ADR-006 推荐形态 validator ≥ builder 首验）。主跑 9/9 零人工干预 3h33m；追加两轮定向验证（门禁注入仲裁 + US-004 补验收/升级横幅）。首验成立：并发锁三分支（双开拒绝退码 2 / stale 接管横幅 / 正常清理）、report.html 自动生成与七区对账（断言 #11）、evidence 索引主体（断言 #12：三类 engine 记录 schema、acIndex 全整数 1 起零越界、claim=截图 33=33）、0.18.1 双修复（agentBlocked 门禁前识别跳过 + 仲裁 notes 完整保全零覆盖，断言 #6）、escalation 升级横幅（含 story 号与重试次数）、sonnet builder 一次分层跑通全部 9 story。以下为缺陷与缺口。

## A) 超时/中断轮的已完成产物未经验收静默生效——假绿新形态（引擎代码，优先级最高）

- 现象：轮 5 US-004 builder 26 分钟内完成实现+截图 claim+提交（7094ca7, 20:47:57Z）+置 `passes: true`，输出最终响应时撞 30 分钟 devTimeout（20:49:54Z）被 SIGTERM；引擎按「本轮作废、下轮重试」continue，但下轮按 state 前进选中下一 story——US-004 就此收官：**该轮门禁未跑、validator 从未验收（8 条 AC 零复核）**，直到本轮定向补验才闭环。
- 同族：轮 4 US-003 validator（fable）API stalled 中断，复核缺席，builder 自置的 true 无人复核即幸存。
- 根因：超时语义预设「没干完」，实际可能是「干完了只是没说完」；「作废」只作废流程不回滚产物（state/提交已落盘），重试按 state 前进而非按验收完备性前进。validator 恒定防线在中断场景被整体跳过——把关水位瞬时归零，与「共谋假绿」不同源但同果。
- 方向候选：builder 超时/中断轮下轮对同 story 强制 validator 复核（state true 但本引擎实例未见 validator 通过记录 → 不算 resolved）；或 validator 中断轮当轮重试 validator 而非前进；或推迟项「防伪加固三件套」之 engine 记录对账（state 变更与验收完成对账）直接对症。

## B) 超时/中断轮 evidence 零记录——时间线还原声明失效（引擎代码，与 A 同场景不同层）

- 现象：轮 5 既无 iteration 也无 gate-run 记录（builder 超时 continue 在门禁之前，loop.ts:169-172），evidence 时间线上是纯空洞；loop.ts:232 注释声称「轮号跳跃+gate-run 记录即可还原」只对门禁打回轮成立。断言 #12 的还原链在超时场景实测断裂（跳跃可见但不可解释）。
- 连带：iteration 的 `validatorRan: true` 语义是「拉起过」而非「完成过」——轮 4 validator 中断仍记 true，时间线读者（含 report.html 轮次时间线区）误读为「已验收」。report 渲染忠实于 evidence，盲区在数据层。
- 方向候选：continue 路径补一条轻量记录（iteration 带 aborted/timedOut 标记，或独立 `agent-abort` 记录类型）；validatorRan 细化或补 exitCode 留痕（agent 进程退出码是机械信号，不违反「不解析 agent 输出」哲学）；断言 #12 验证点措辞随修复轮订正。

## C) builder 空转轮无检测——门禁与 validator 白烧（引擎代码/机制设计）

- 现象：轮 1 sonnet builder 零输出零产物退出（无提交、无 progress section、state 未动），引擎无感知：门禁照跑（旧基线本来绿→通过）、validator（fable）照拉起白烧一次。validator fail-safe 表现教科书级（识别无验证对象→拒绝写 state→不误伤 retryCount→终止说明清晰），但一轮迭代数+一次强模型调用已消耗。
- 空转轮在 state 机上完全不可见，仅 evidence 双轮号同 story（轮 1/2 均 US-001）可辨。
- 方向候选：progress.md 无新 section 或 state 无变更 → 判 no-op 轮跳过 validator（省强模型调用）；与 ADR-006 已记的「连续 N 轮非零退出提前终止」循环健壮性议题合并设计（本例退出码未知，零退出空转更隐蔽）。

## D) blocked 收敛文案假绿——「全部 story 已通过」误报（文案级，0.18.1 defer 项首次实证）

- 现象：定向轮 8 通过+1 blocked 收敛时，引擎输出「💡 全部 story 已通过」+exit 0。blocked 计入 resolved 是 0.18.1 设计内（循环不空转），但文案在有 blocked 时是假绿表述——无人值守场景操作者可能据此跳过人工仲裁处理。
- 方向候选：完成判定文案分叉——存在 blocked 时输出「N 通过 + M blocked 待人工处理」并列出 story 号；退出码是否随分叉（0 vs 特定码）连带评估（对 CI 语义有影响，需权衡）。

## 黄金样本升级版（非缺陷，行为契约记录）

- 定向注入门禁（`grep -q 'DOGFOOD-GATE-20260717' README.md`）被 sonnet builder 一轮识破：核实 US-004 实现完整（typecheck/91 测试/evidence 截图）→ 考古 2b61d92 撤除提交识别「fixture 周期性注入门禁测试」模式 → 拒绝向真实产品文档编造无来源字符串 → 置 blocked+`[需要人工核实]` 完整证据链（含 gate-run 历史 total:2 对比证明注入是新增）→ 存入项目记忆。与上轮「识破 .gate-marker 伪造」一脉，防线跨轮跨配置稳定；0.18.1 修复后仲裁信号全程零丢失（对照上轮 findings a/b 的覆盖翻车）。
- 流程涵义：诚实 agent 面对不该满足的门禁，正确行为是仲裁而非打回循环——门禁打回链数据不应靠强扭 agent 行为制造（断言 #7 本轮记 N/A-supersede，上轮已实证+引擎单测覆盖）。

## 断言复查判定（12 条）

| # | 判定 | 备注 |
|---|---|---|
| 1-3, 5 | ✅ | 浏览器验证声明/截图命名/validator 通过分支截图/取舍注释（US-007）均成立 |
| 4 | ✅ | 开跑前归档+清 state，首轮无旧状态误判 |
| 6 | ✅ | 定向轮仲裁标签完整保全（0.18.1 修复首次真实验证） |
| 7 | N/A-supersede | sonnet 仲裁路径替代触发；打回链上轮已实证+单测覆盖 |
| 8-10 | 未复查 | 属 /review-loop、/compound-docs 环节，随吸收轮核对 |
| 11 | ✅ | report.html 全区对账，红旗区正确不亮 |
| 12 | ⚠️ 部分 | 主体成立（三类记录/acIndex 质量/AC 对账区）；还原链在超时场景断裂＝发现 B |

## 环境备忘（非引擎缺陷）

- `API Error: Response stalled mid-stream` 两次打在 agent 进程上（轮 4 validator、轮 5 builder 尾声）——长输出 API 中断环境坑首次穿透到引擎拉起的 agent 层（此前只见于主会话 subagent）。引擎幂等续跑+超时兜底扛住了流程，但衍生出发现 A/B 的语义缺口。
- 本轮 Bash 后台 3h33m 未被 kill（既往 ~2.5h 被杀未复现）；stale 接管改用伪造锁验证，等价且更可控。
- `npx coding-x` 静默坑未再验证（本轮直接 node 本仓 dist，绕过）。
