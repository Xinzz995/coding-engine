---
title: "evidence 结构化索引设计"
status: done
updated: 2026-07-08
scope: root
---

# evidence 结构化索引设计

日期：2026-07-08
来源：validation gate 调研吸收轮 #4「evidence 结构化索引」（no-mistakes 借鉴候选——pipeline 每步产结构化证据记录供人审）；建立在 0.19.0 验证报告之上。

## 背景与动机

0.19.0 验证报告让证据可见，但证据链本身有四个缺口：

1. **截图归属靠文件名猜测**：`parseScreenshotEntry` 按命名约定解析（builder.md 契约 `builder-[story-id]-[序号].png`、validator.md 契约 `validator-[story-id]-[pass/fail]-[序号].png`——两端契约齐备且 dogfood 实测遵守），但命名只能携带 story 级归属；「哪张截图证明哪条 AC」的关联不存在，且解析对命名偏差是猜测式容错。
2. **门禁通过零留痕**：只有失败写 notes；报告能展示门禁配置，无法证明「每轮真实跑过、哪轮通过」。
3. **轮次时间线无落盘**：第 N 轮谁跑了/什么模型/什么结果只在 console，报告只有终态没有过程。
4. **验证方式散在 progress.md 叙述里**，无结构化。

## 锁定决策

1. **范围=引擎机械记录 + agent 登记全做**（用户拍板）：引擎写最可信的机械证据（门禁执行含通过、轮次事件、篡改事件），agent 按指令登记截图元数据（story/AC 关联），报告消费两者并区分信任级别。
2. **落盘=单 `<workspace>/evidence.jsonl`**：引擎与 agent 都追加，每行一条独立 JSON 带 `source` 字段。append-only 时序天然；坏行跳过容错（agent 写坏一行不毁全文件）；写入时机天然错开。
3. **登记粒度=AC 级可选字段**：`storyId`+`phase(source)` 必填、`acIndex` 可选——报告做「AC ↔ 证据」对账视图（每条 AC 有无证据一眼看出，no-mistakes evidence 的核心价值）；agent 给不出时退化 story 级。**acIndex 从 1 数起**（与报告 AC 列表编号一致，指令明示防混淆）。
4. **信任边界明示不假装**：evidence.jsonl 在 agent 可写区，`source: 'engine'` 记录可被伪造。v1 只做呈现层区级免责标注（同 0.19.0 review 留痕哲学）；防伪加固（如引擎内存对账）与「报告 guard 快照喂数」推迟项同族，留后续评估。
5. **evidence 是增强不是关键路径**：引擎写入失败只 warn 绝不影响循环；agent 登记失败不阻塞 story 完成；报告在 evidence 缺失时视觉与 0.19.0 完全一致（全部新区块条件渲染）。

## schema（`src/engine/evidence.ts` 单源）

```ts
export type EvidenceRecord =
  | { type: 'iteration'; source: 'engine'; at: string; iteration: number; storyId: string | null;
      builderRan: boolean; builderModel: string | null; validatorRan: boolean;
      validatorModel: string | null; skippedValidator: boolean; agentBlocked: boolean }
  | { type: 'gate-run'; source: 'engine'; at: string; iteration: number; storyId: string | null;
      ok: boolean; total: number; ran: number; ms: number;
      failedCommand?: string; exitCode?: number | null; timedOut?: boolean }
  | { type: 'tamper'; source: 'engine'; at: string; iteration: number; archive: string | null }
  | { type: 'screenshot-claim'; source: 'builder' | 'validator'; at: string; storyId: string;
      file: string; acIndex?: number; note?: string };
```

- `at` 一律 ISO 时间戳（机器面；报告渲染时转 `YYYY-MM-DD HH:mm` 本地格式）。
- `gate-run` 记「共 total 条、fail-fast 跑到第 ran 条、总耗时 ms、失败摘要」，不逐条计时（YAGNI）；通过时无 failed* 字段。
- `tamper.archive`：篡改归档文件名；删除类篡改（无存档）为 null。
- 读写 API：`appendEvidence(workspace, record)` 同步追加一行；`readEvidence(workspace): { records: EvidenceRecord[]; skippedLines: number }`——JSON 解析失败、逐字段形状校验失败、**未知 type**（前向兼容：新版本引擎写的类型，旧版本消费方不炸）三类行都跳过并计数。

## 三方接线

**loop.ts 三处写入**（每处 try/catch 吞错、首次失败 warn 一次）：

1. 门禁执行完成处写 `gate-run`——通过与失败都写；`runQualityChecks` 返回值需扩展出 `ran`（fail-fast 跑到第几条）与总耗时（`GateResult` 加字段，不破坏既有消费）。
2. 每轮末尾（completion check 附近）写 `iteration`——字段全部来自 loop 既有局部变量（builderChoice/validatorModel/skipValidator/agentBlocked 等）。
3. 篡改检测处写 `tamper`——`prd-guard` 的 `read()` 返回 `PrdReadResult` 扩展 `tamperedArchive?: string | null`（本次 read 检测到篡改并归档时给档名；删除类给 null 但仍标发生），loop 据此即时写记录。接口扩展不破坏既有消费方。

**指令层**（assets/instructions/，经 `{{WORKSPACE}}` 渲染管线）：

- builder.md 截图段后扩登记约定：最终验证的每张截图追加一行登记，给死单行 JSON 模板（type/source/at/storyId/file 必填，acIndex（从 1 数起）/note 可选）；明示「登记失败不阻塞你完成 story」（弱依赖）。
- validator.md 同样扩登记约定（其截图要求节已有命名契约 `validator-[story-id]-[pass/fail]-[序号].png`，登记模板的 file 即该契约产物，无需另立规范）。

**报告消费**（collectReport 读 evidence 入 `ReportData`；render 四点增强，全部条件渲染）：

1. 门禁区：配置之下挂**执行历史表**（轮次/结果/跑到第几条/耗时/失败摘要）——「配置了门禁」升级为「每轮真实跑过的证明」。
2. story 证据卡：AC 逐条挂证据徽标（claim 按 storyId+acIndex 匹配，storyId **大小写不敏感**——对齐 parseScreenshotEntry 先例，agent 写 `us-002` 也归对；显示文件链接+note+「agent 声明」弱化标注）；无 acIndex 的 claim 列在 AC 列表之后；storyId 匹配不到任何 story 的 claim 落「未归类工件」区如实呈现。
3. 截图画廊：有登记的排前并显示 note，未登记的保持文件名猜测归属并标「未登记」。
4. 轮次时间线：`<details>` 折叠表（iteration 记录：轮次/story/模型/validator 是否跑/blocked）。

`skippedLines > 0` 时头部警示「evidence.jsonl 有 N 行无法解析已跳过」；tamper 记录融进现有红旗区（文件扫描保底，evidence 补「何轮何时」）；claim 涉及的区块带区级免责标注（同 review 留痕）。

## 生命周期与边界

- **换 PRD 归档**：prd-to-json 的「归档之前的运行」清单补 `evidence.jsonl`（复制进归档 + 从工作区删除——残留旧轮 evidence 会污染新轮报告，同 state.json 撞车逻辑）；顺手把 0.19.0 欠账 `report.html` 与 `screenshots/` 一并补进归档复制清单。
- repair.ts 不管 evidence.jsonl（JSONL 坏行跳过即容错）。
- 并发依赖写入时机天然错开（builder 完→门禁→validator）；跨进程锁属 #6 独立候选。

## 测试

- evidence.ts：append/read 往返、坏行跳过计数、未知 type 跳过（前向兼容）、逐字段形状守卫、缺文件返回空。
- loop（fake-agent 基建）：gate-run 通过/失败两分支记录、iteration 记录字段、tamper 即时记录（复用现有篡改注入用例）；写入失败不影响退出码。
- render：四增强点条件渲染（无 evidence=0.19.0 视觉）、acIndex 1-based 匹配、「agent 声明」标注、「未登记」标注、skippedLines 警示、claim 文本转义（延续 text() 纪律）。
- 指令 assets 契约测试：builder.md/validator.md 含 evidence.jsonl 登记模板与 validator 命名契约（loop.test 的 instruction assets describe 先例）。
- 提交前 `npm run typecheck` + `npm test` 全绿（硬约束）。

## 版本与文档

- 新文件约定 + 指令变更 + 报告增强 = minor **0.20.0**。
- README（特性列表、`.workspace/` 目录结构）、architecture.md（模块表 evidence 行、数据流）同步。
- glossary「证据记录」词条候选与 dogfood 断言 #12（agent 登记行为的真实跑验证）留 /compound-docs 收口时定。

## 非目标

- status 子命令消费 evidence（报告是主消费方）。
- repair 支持 evidence.jsonl。
- 逐条门禁计时。
- evidence 防伪加固（引擎内存对账/签名）——与「报告 guard 快照喂数」推迟项同族，下轮评估。
- 截图文件内容校验（存在性/尺寸）——claim 指向不存在文件时报告如实渲染断链，人审可见即可。
