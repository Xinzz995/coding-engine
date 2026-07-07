---
title: 引擎真实跑 dogfood 发现清单（2026-07-07 轮）
status: done
updated: 2026-07-07
scope: root
---

# 引擎真实跑 dogfood 发现清单（2026-07-07 轮）

<!-- 本轮 dogfood（四机制首验 + Fable 5 代际实测）检出的引擎缺陷与流程缺口，供下一开发轮立项吸收。
     全程证据：.superpowers/sdd/progress.md 的 Dogfood ledger 段、engine-run-fable.log / engine-run-gate.log、
     fixture .superpowers/fixtures/study-report-dogfood（review 留痕 .workspace/review-2026-07-07.md、tampered 归档）。
     吸收完成后本文件置 done。 -->

背景：fixture 同 PRD 重跑 8 story（0.12.1 轮为基线），主跑 8/8 零打回 2h16m；追加 US-009 门禁打回定向验证。四机制（0.14.0 门禁 / 0.14.1 截图 / 0.16.0 三层路由+升级链 / 0.17.0 冻结）全部首验成立，以下为缺陷与缺口。

## a) notes 保全规则窄于意图——agent 仲裁请求被机械路径覆盖丢失（引擎代码，优先级最高）

- 现象：US-009 第一轮 sonnet builder 识破注入门禁，置 `blocked: true` + notes 写 `[需要人工核实]` 完整调查过程请求人工仲裁；随后门禁打回路径（applyGateFailure）把 notes 整体改写为 `[门禁失败 - 第1次]` 内容，调查记录全部丢失。
- 根因：notes 保全规则只认字面 `[需求冲突]` 前缀（0.4.0 约定），agent 语义合理的变体仲裁标签不在名单。
- 后果：「人在环」的上报信号被机械路径无声撤销，循环继续跑（本轮靠 progress.md 层幸存 + validator 主动路由给人工才未失联）。
- 方向候选：保全规则从字面前缀扩为「仲裁类标签」（如 `[需求冲突]`/`[需要人工核实]` 前缀族，或凡 `[…]` 开头行全保全）；或门禁改写 notes 时追加而非替换。连带评估 builder.md 是否应把仲裁标签词汇表写死（单源）。

## b) builder 显式置 blocked=true 被门禁打回覆盖回 false（引擎代码，与 a 同源）

- 现象：同上场景，builder 主动置的 `blocked: true`（"我不能安全继续"）被 applyGateFailure 按 `retryCount>=5` 重算覆盖回 `false`，下轮升级 builder 照常拉起。
- 方向候选：blocked 已为 true 时门禁打回不改写（显式阻塞优先）；或 blocked 语义拆分（引擎阻塞 vs agent 请求人工）。与 a 一起设计。

## c) 合法停机变更 vs 运行期篡改，agent 视角无可辨凭证（机制设计）

- 现象：`.workspace/` 根下的 `prd.tampered-*.json` 归档 + 停机追加的门禁/story，被 sonnet builder 合理地怀疑为「运行期非预期修改」而拒绝执行（fable 第二轮靠推理重构信任链才走通）。
- 本质：快照权威性只对引擎自身成立（重启重建），agent 只能看到「tampered 文件存在 + 当前 prd 与它有 diff」的误导性证据。
- 方向候选：篡改归档挪 `.workspace/archives/` 子目录降低误读面；builder.md/validator.md 声明「prd.json 受引擎快照保护，读到的即权威验收标准」；保留 agent 对真异常上报的本能（fail-safe 行为本身是对的，修复对象是凭证缺失而非警惕性）。

## d) 断言 #1「过程记录出现探测命令」观察面失效（dogfood-regression.md 措辞校准）

- 现象：`claude --print` 模式无过程 transcript，builder 是否执行了 `which agent-browser` 探测无法核对；本轮按实质（7 个 UI story 全真实浏览器验证、零降级）判定通过。
- 方向候选：断言验证点改为可观察形态（如「builder 输出/进度记录声明浏览器验证方式」），或 builder.md 要求 agent 在输出中声明探测结果。

## e) review 检出的 AC 级缺口必须回流源 PRD（流程规范，已有一次闭环实证）

- 现象：generate 端点越权在 0.12.1 轮 review 检出并修复（run-v0.12.1 分支 4091339）但未回流源 PRD；本轮从干净 PRD 重跑，同一缺口如期复现，由 /review-loop 再次捕获。
- 本轮已闭环示范：修代码（fixture 21b605a）+ 回流源 PRD（52dbf35：US-004 补 AC + prd.json 同步 + updated 刷新）。
- 方向候选：/review-loop 四态回填的 `[已修]` 语义扩展——发现属 AC 缺失类时，resolution 要求同时给出「源 PRD 回流提交」；或 review-loop 第 2 节反向核对补一条「AC 缺失类发现的修复必须含源 PRD 回补」。

## 环境备忘（非引擎缺陷）

- `npx coding-x` 在本机（node v26.4.0）静默不执行：exit 0、零输出，`--version`/`status`/`repair` 全中招；绕行=直接 `node ~/.npm/_npx/<hash>/node_modules/coding-x/dist/cli.js`。发布产物本身无恙。未定位是 npx 缓存态还是 npm v11 怪癖，复现时再查。
- 加固候选「validator 拉起直前第五次 read 或快照 AC 渲染进 prompt」（v0.17.0 终审遗留）：本轮实测篡改被第四检测点抓住、门禁窗口未被利用，维持不加急原判。
