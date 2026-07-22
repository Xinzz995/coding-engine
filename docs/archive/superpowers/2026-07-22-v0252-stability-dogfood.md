---
title: "v0.25.2 稳定性 dogfood 记录"
status: done
updated: 2026-07-22
scope: root
---

# v0.25.2 稳定性 dogfood 记录

## 目标与边界

在不修改主仓运行状态的隔离 fixture 中，验证 npm 正式发布物 `coding-x@0.25.2` 的最小真实 Codex 链路：全局模型目录 → 启动预检 → Terra builder → 机械门禁 → Sol validator → 引擎验收凭证 → status/evidence/report/锁释放。

本轮只覆盖 Codex、low story 与一次正常通过链路；不声称真实覆盖 Claude/Cursor、medium/high、escalation、UI 浏览器验证或 provider 故障矩阵。异常/超时/跳过与进程树清理由自动化测试覆盖。

## 基线门禁

- 主仓起点：`main` 与 `origin/main` 对齐、工作树干净，HEAD/tag/package 均为 v0.25.2。
- 全局目录：`config validate` 通过；Codex 声明 `gpt-5.6-terra` 与 `gpt-5.6-sol`，Claude/Cursor 为空。
- npm registry：`coding-x@0.25.2` 存在正式 tarball；fixture 通过 `npx --yes coding-x@0.25.2` 执行，不复用本仓 `dist` 作为真实链路入口。
- `npm run typecheck` 通过。
- `npm test`：沙箱内仅 3 个回环端口用例因 `connect EPERM 127.0.0.1` 假红；允许回环后全量 24 files / 504 tests 通过。agent/gate 的超时进程树、validator skip/error/timeout、跨 story 所有权与验收凭证回归均在其中通过。
- `npm run build` 通过，`dist/cli.js` 为 138.46 KB。

## 真实链路

fixture 是依赖为零的 Node ESM 小项目，初始测试因缺少 `src/normalize-tag.js` 确定性失败；PRD 启用 `npm test` 门禁与以下模型映射：low/medium builder=Terra、high/validator/escalation=Sol。本轮最多 3 次迭代，实际 1 轮收敛。

1. 正式包只读全局目录并通过预检，启动摘要显示 catalog available。
2. builder 实际命中 `gpt-5.6-terra [difficulty]`，先复现红灯，再完成最小实现、补独立边界测试并提交；它把 `passes` 置为候选 `true`，保持 `validated=false`、`escalated=false`。
3. 机械门禁执行 `npm test`，4/4 通过；evidence 记录 `gate-run ok=true`。
4. validator 实际命中 `gpt-5.6-sol [validator]`，除重跑 4/4 测试外，另做混合分隔符、非字符串集合及空生产依赖树的独立检查；未改写引擎独占字段，进程正常完成。
5. 引擎签发凭证并 exit 0。最终 state 为 `passes=true, validated=true, blocked=false, escalated=false`；iteration 记录含 `builderOutcome=completed`、`validatorOutcome=completed`、`validationReceipt=true`，且没有坏 evidence 行。
6. `status --json` 显示 1/1 passed；`recentActual` 为 Terra/difficulty 与 Sol/validator；report 横幅为“全部通过 1/1”，时间线与 status/evidence 路由一致；`engine.lock` 已释放，fixture 测试仍为 4/4。

## 观察与裁决

- **无引擎 correctness 阻断。** v0.23–v0.25.2 的模型目录、实际路由、机械门禁、验收凭证、消费面与锁释放在一条真实发布物链路中贯通。
- Sol 启动时 Codex 自身 stderr 出现一次 `failed to refresh available models: timeout waiting for child process to exit`，但 runner 随后完成全部验证并 exit 0。裁决为 provider/runner 非阻断诊断噪声：coding-x 没有把目录误当在线证明，也没有解析输出文字改写机械结局，行为符合 ADR-012/013。
- **流程 finding（已修）：workspace 运行时文件污染 story commit。** 原始架构约定默认 gitignore `.workspace/`，但 prd-to-json/引擎没有机械保证目标仓已经落实该约定。本 fixture 未忽略 workspace 时，Terra 没有遵守 builder 指令第 7–9 步“先提交、再写 state/progress”的顺序，反而把新建的 `state.json` 与已跟踪的 `progress.md` 连同实现一起提交；引擎签发 `validated=true` 后工作树又留下 state diff。修复后 builder 只允许显式 stage story 文件、提交前核对暂存清单、提交成功后再写 state/progress；prd-to-json 写入前检查 ignore/索引状态，doctor 只读报告未忽略或已跟踪文件。三处都明确不擅改用户 `.gitignore`、Git 索引或既有暂存区。
- 已把成功合同固化为 dogfood 回归断言 #13–15，并将上述 finding 的修复合同固化为断言 #16；prompt 静态合同与临时 Git fixture 覆盖已落地。

## 后续候选进展

本记录提出的下一候选“可信收口报告”已在后续 0.25.4 候选实现中闭环：自动报告消费 PRD guard 最终快照并标注来源，state 损坏时 fail-closed，report 原子写入；prd-to-json 在任何 workspace 变更前与首次真实写入前双次检查活跃工作区锁，且不删除锁。该实现不改写本次 v0.25.2 dogfood 的历史结论；发布前仍需按回归断言 #11、#17、#18 完成候选版本验证。
