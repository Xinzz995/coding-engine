---
title: Codex Review 多消息事件兼容与安全诊断
status: active
updated: 2026-08-09
scope: root
---

# Codex Review 多消息事件兼容与安全诊断

## 目标与事实边界

0.35.0 RC4 的 Go 候选 Dogfood 已完成 Builder、质量检查和 Validator，但 Final Review
隔离反测以 `shape-invalid×1` 失败，整体退出 5。失败记录只保留了 stdout 的字节数与摘要，
原始 904 bytes 因 `--ephemeral` 和临时目录清理无法恢复；三条 Review 轴引用的是同一次反测，
不是三次独立复现。因此不能把这次字节流的具体形状写成已知事实，也不得重跑 RC4 碰取绿色。

Codex 精确上游实现和当前 CLI 实测表明，同一 turn 可以产生多条
`item.completed/agent_message`；`--output-schema` 也可能让中间消息满足最终 schema。但 JSONL
末条消息不一定是 Codex 在 `turn.completed` 时重新选定的最终答复，且官方文档没有承诺这一
精确事件形状。当前 adapter 又在出现已知 Code Mode 启动提示时强制 agent message 恰好一条，
属于比已观察实现更窄的限制。本修复会安全扫描全部严格被动消息，并以同一次调用写出的
`--output-last-message` 为唯一权威结果；不放行工具、未知事件、特殊流中的额外字段或完成后事件。

## 范围与非目标

- 含已接受 Code Mode/传输诊断的特殊流允许一个或多个形状严格的
  `item.completed/agent_message`，全部参与安全扫描；
- 同一次 Codex 调用使用独立受管临时域接收 `--output-last-message`，只解析这个权威结果；
- 权威结果临时域固定根身份、唯一允许文件、普通文件类型、单链接、4 MiB 上限和读取前后身份；
  缺失、替换、链接、越界、额外对象或解析失败一律失败关闭，诊断只保留长度与摘要；
- 上述特殊流保留单 thread、单 turn、单 completion、严格顺序与逐事件精确字段检查；
- 事件失败增加有界结构指纹和进程结局，只显示固定词表、长度和摘要；任意未知字符串只显示
  摘要，模型正文、错误正文、路径、源码和秘密永不回显；
- Final Review/隔离反测在事件失败时保留 exit code、超时/残留标志及 stderr 长度和摘要；
- Runner 工具策略升级到 `package-read-only-v9`，Review 规则版本升级到 `1.5.0`，使旧结果失效；
- 用真实 Codex 连续五次执行隔离反测，确认多消息兼容不会扩大读写、命令、网络或工具能力。

本轮不放宽命令、文件、MCP、浏览器、网络或未知 item；不重试 policy violation；不改变普通
无诊断被动流的既有字段兼容、Validator、三轴裁决、远端门禁或发布审批。RC4 永久失效，修复
合入后必须从新 main 构建新候选，三仓全部使用新安装、新 workspace、新 requestId 与新 Final
Review 重跑。

## 可证伪完成合同

| 编号  | 完成条件                                                                                       | 失败时可观察结果                                            | 验证证据                                                                                                                                        |
| ----- | ---------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| AC-1  | 特殊流含 1..N 条精确被动 agent message 时全部安全扫描，并以同次 `--output-last-message` 为结果 | 第二条合法消息仍被判损坏，或把 JSONL 中的过期消息当最终结果 | 多消息、过期末条与权威结果回归；真实 Codex 反测                                                                                                 |
| AC-2  | 含已接受诊断的特殊流中，thread/turn/completion 仍各恰好一次，completion 后无事件               | 特殊流的重复、缺失、乱序或 late event 被接受                | 特殊流顺序与计数反例                                                                                                                            |
| AC-3  | 所有流的工具/未知 item，以及特殊流的额外键/非精确被动形状和任一中间危险声明仍 fail-closed      | 早期危险消息被末条安全结果洗白，或危险事件进入最终结果      | 工具/额外键/未知类型/早期危险声明反例                                                                                                           |
| AC-4  | 结构指纹最多记录 32 行，只回显固定词表、长度与摘要                                             | 任意恶意 type/key/message/text/路径原文出现在错误中         | 对抗字符串与溢出测试                                                                                                                            |
| AC-5  | 事件失败同时保留 exit code、timeout/tree 标志、stderr 与权威结果的长度/摘要                    | 只能看到 stdout 哈希，无法区分进程结局或权威结果状态        | 隔离反测受管进程注入测试                                                                                                                        |
| AC-6  | policy violation 或已产生非空权威结果的失败调用均不重试，也不以第二次成功覆盖                  | 发生第二次 Runner 调用或产生通过结果                        | 普通 Review/隔离反测调用次数与最终状态测试                                                                                                      |
| AC-7  | 真实隔离反测连续五次通过且无包外读取、写入、删除或外部工具成功                                 | 任一副作用、残留或不可验证结果                              | 本机 Codex 五次反测与临时树复核                                                                                                                 |
| AC-8  | v9 工具策略与 1.5.0 Review 规则使旧 Final Review 失效                                          | 旧结果仍被当作当前通过                                      | 版本与 currentness 回归                                                                                                                         |
| AC-9  | 全部本地门禁、首次跨平台检查和新 main 检查通过                                                 | 任一检查失败                                                | format、lint、typecheck、test、build、repository-health、CI                                                                                     |
| AC-10 | 新 main 构建的新候选完成三仓 fresh Shadow 后仍停在 staging 审批前                              | 复用 RC4 证据、身份链缺项或提前暂存/发布                    | 新 main、run、artifact、tgz 摘要、下载、三份安装、clone/head、workspace、apply mutation、Validator requestId/receipt、Final Review binding 对账 |

## 设计裁决

1. 特殊诊断流中的多条 agent message 都是被动输出，不扩大 Runner 能力；每条仍必须是
   `item.completed`，且只含 `id/type/text`。全部消息参与隔离危险声明扫描，但 JSONL 末条不具备
   最终结果权威；只有同一次调用的 `--output-last-message` 可进入结构化结果解析。普通无诊断流
   保持既有字段兼容，不在本修复中另行收紧。
2. 结构诊断不是原始日志。已知类型和已知字段可用固定名称显示；未知值只显示 SHA-256，
   文本只显示 UTF-8 byte 数和 SHA-256。超过上限的行只给数量与聚合摘要。
3. 事件安全检查必须在返回错误时拿到同一次受管进程的结局与权威输出状态，不能先丢弃
   exit/stderr 信息；但进程非零、超时或后代残留仍按原有更严格规则裁决。
4. 真实 RC4 失败只能作为触发证据，不能被推断成精确多消息 fixture。正向 fixture 由精确
   上游源码实现、当前 CLI 实测和独立回归建立；失败现场的精确结构仍标为不可恢复。
5. 修复后新候选不得继承 RC4 的成功 Builder/Validator 或失败 Review。候选身份不是包字节相同
   就等价，必须重新绑定 source main、candidate run、artifact 和全新三仓运行链。
6. Review 规则版本和 Runner 工具策略同时升级；即使包版本、PR 与 Runner 版本未变，旧 Review
   也必须因规则版本不同而失效。
7. 权威输出使用独立临时域，不能与 Runner 调用配置或审查包共用目录。只有受管进程自然结算、
   根和唯一文件身份稳定、大小有界、无链接或额外对象时才能读取；任何不确定都失败关闭。

## 原生能力核对

- Codex 精确上游提交
  [`618b8e9`](https://github.com/openai/codex/blob/618b8e9111da9f57fe380b09d0f6516e3f343536/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L471-L524)
  会逐条转发 agent message，但 `turn.completed` 还可能从完整 turn 重新选择最终消息而不补发一条
  JSONL 事件；[同一实现](https://github.com/openai/codex/blob/618b8e9111da9f57fe380b09d0f6516e3f343536/codex-rs/exec/src/event_processor_with_jsonl_output.rs#L619-L624)
  会把该结果写入 last-message 文件。因此 adapter 不能把 JSONL 末条当权威结果。
- Codex 当前 JSONL 没有可信的 `phase` 字段区分过程消息与最终消息；adapter 使用原生
  `--output-last-message` 取得同次调用的最终结果，同时继续用严格事件顺序与结构守住边界。
- [官方非交互文档](https://learn.chatgpt.com/docs/non-interactive-mode)明确 `--json` 输出 JSONL
  事件流、`--output-last-message` 写出 final message，并把 `--output-schema` 表述为请求符合 schema
  的 final response；它没有承诺 agent_message 次数。精确依据是上述固定源码与当前本机
  `codex-cli 0.147.0-alpha.6.5` 实测，未来漂移仍由特殊流严格形状检查和真实隔离反测失败关闭。
- 供应商差异只留在 Codex adapter；runner-neutral 的 Review 输出、三态和远端门禁不变。

## 实施与验证顺序

1. 先写多消息 RED、危险夹杂反例和诊断防泄漏测试。
2. 允许严格被动多消息并全部安全扫描；同次调用接入并安全读取权威最终输出。
3. 增加有界结构指纹、权威输出摘要和同次进程结局摘要，补齐失败路径测试。
4. 升级工具策略与 Review 规则版本，验证旧结果当前性失效。
5. 运行 Runner/Final Review 定向测试、全部本地门禁、构建、旧版本兼容和 CLI 冒烟。
6. 显式运行五次真实 Codex 隔离反测并检查副作用与残留；一次性反测文件在提交前删除，默认不
   进入普通 CI。
7. 新建限时 Policy Exception Issue；受保护 PR 正文绑定该 Issue，并由 owner 加
   `quality-policy-approved` 标签。旧的已关闭例外不得复用。
8. 通过受保护 PR 合入，等待新 main 首次全绿，再构建新候选并重跑三仓 Dogfood。

## 黄金原则对照

| 原则                | 适用性与设计裁决                                                                | 证据                                           |
| ------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1. 可证伪完成合同   | 适用。AC-1 至 AC-10 均定义通过和失败信号                                        | 正反 fixture、真实反测、CI 与三仓对账          |
| 2. 生成方不得自签   | 适用。模型消息只作为候选数据；事件形状、能力和副作用由引擎裁决                  | 危险声明、工具事件、文件副作用反例             |
| 3. 自治扩大同步防线 | 不扩大自治。新增的只是特殊流被动消息数量；未知/工具及特殊流中的额外字段继续阻断 | 多消息夹工具与 late event 测试                 |
| 4. 原生能力优先     | 适用。适配 Codex 多消息与原生权威最终输出，不自造 phase 协议                    | 精确上游实现、官方文档边界与真实 CLI           |
| 5. 假绿与恢复       | 适用。RC4 失败永久保留，新修复不能靠重跑覆盖；成功与失败路径都固化              | failure-first 测试、新候选、fresh 三仓 Dogfood |
