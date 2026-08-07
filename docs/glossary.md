---
title: 领域词汇表
status: active
updated: 2026-07-31
scope: root
---

# 领域词汇表

<!-- 项目的共享语言：每个核心领域概念一个词条，人、文档、代码命名、AI 会话全部统一用这个词。
     词条只回答「这个词指什么」，零实现细节——实现细节进 architecture.md，决策理由进 decisions/。
     「禁用」行列出禁止使用的同义词。新术语与歧义拍板由 /compound-docs 收口沉淀，
     熵 GC 负责合并同义词、删除已退出当前领域模型的词条。 -->

## 词条

**story**
prd.json 中的最小交付单元（`US-NNN`），带 acceptanceCriteria，引擎一次迭代只做一个。
禁用：任务、需求项、工单（统一用「story」）

**acceptanceCriteria（验收标准）**
story 的唯一验收依据；引擎把本轮有序快照放进 validation request，validator 必须逐条核对，源 PRD 与项目文档都不构成验收依据。
禁用：验收条件、完成标准

**打回**
机械门禁失败，或引擎接受 Validator 的结构化 failed claim 后执行的状态转移：passes/validated 设回 false、notes 写失败详情、retryCount +1，builder 下轮重试。
禁用：驳回、退回

**blocked**
story 被跳过并等待人工处理的状态；可由重试达到上限触发，也可由 agent 配合仲裁标签显式置位。它与有效通过态一起构成循环收敛判定。
禁用：卡死、挂起

**验收凭证（validated）**
Validator 正常完成、结构化 result 与本轮 story/AC hash/Git HEAD/request ID 全部匹配、逐 AC 结论通过且未改写 state 后，由引擎签发的 story 通过凭证。由引擎独占，agent 不得改写；story 只有 `blocked=false` 且 `passes && validated` 才是有效通过。
禁用：验证标记、通过凭证（统一用「验收凭证」；字段名用 `validated`）

**validation request（验收请求）**
引擎为一次 Validator 调用生成的唯一目标合同：含一次性 request ID、story ID、有序验收标准快照/hash、调用前 Git HEAD 和 resultPath。它绑定“本轮要验什么”，不是密码学挑战。
禁用：Validator prompt、验收任务（统一用「validation request」或「验收请求」）

**Validator claim（Validator 声明）**
Validator 按 v1 schema 提交的逐 AC 结构化结论（passed/failed、evidence、summary）。引擎会校验新鲜度、目标和自洽性后决定状态；claim 是 `source=validator` 的 agent 声明，不是引擎/CI 证明或安全签名。
禁用：验收证明、Validator 凭证、验证证书

**结构化验收协议**
validation request → Validator claim → engine protocol verdict/receipt 的 runner-neutral 控制面合同。缺结果、错绑定、畸形 schema、产物变化或 Validator 改写 state 一律 invalid 并 fail closed。
禁用：Validator IPC、结果文件协议（只描述媒介，掩盖目标绑定与状态机）

**假绿**
系统显示 story 或交付通过，但实际上未完成指定 AC、没有验证指定产物，或必要检查被跳过。结构化验收协议关闭单 Story 的无结果、错目标和旧结果；最终 Review 负责 Spec/工程/结构判断，GitHub 总闸负责机械检查不可跳过，三者不能互相冒充。
禁用：误报通过、虚假通过

**质量契约**
项目受 Git 管理的 `.coding-x/quality.json`：统一声明测试、构建、静态检查、安全检查、适用范围、风险来源和远端必需检查。它是项目检查唯一人工维护来源；PRD 只保存由它派生的摘要和结构化快照，不能另写一套规则。
禁用：质量配置、PRD 门禁命令（统一用「质量契约」）

**shadow（影子运行）**
候选 coding-x 对真实项目执行的非交付验证模式。它可以暴露失败，但即使全部成功也固定返回影子结局，不能给候选版本自身签发正式通过。
禁用：候选通过、自认证

**TDD 循环**
针对一个公共可观察行为完成的 RED→GREEN→重构：先运行聚焦测试并确认它因待实现行为缺失而失败，再用同一命令确认最小实现通过，最后只在绿色状态重构。过程记录是 agent 声明，不是历史顺序证明。
禁用：先补测试（无法表达真实 RED）、测试覆盖流程

**TDD 门禁**
启用 `prd.json.tdd` 后，引擎在质量契约派生检查之后、Validator 之前执行的项目级机械检查：先验证冻结的 Git 基线、政策摘要与新增覆盖忽略标记，再真实运行 coverageCheck。Codex/Claude 插件 hook 与 Cursor 显式安装的项目检查只是提前反馈，不属于最终 TDD 门禁。
禁用：TDD 证明、测试质量门禁

**覆盖率政策面**
决定 coverageCheck 结论的命令、阈值、排除、零测试策略、差异覆盖基线与委托脚本/配置的集合；派生时由用户批准，运行中受 PRD 快照与政策文件摘要保护。覆盖率只证明代码被执行，不证明断言有效。
禁用：覆盖率证明、测试有效性政策

**最终 Review**
全部 Story 验证后，coding-x 针对当前 PR 最新提交顺序执行的本地三层判断：Spec、工程标准，以及风险触发的深度结构 Review。结果绑定 PR/base/head、规则、契约、runner/model 和风险输入；任一变化即失效。它是本地质量判断，不是 GitHub 共享凭证。
禁用：人审包、GitHub AI Review

**Review finding**
最终 Review 发现的结构化问题：包含稳定 ID、评审轴、P0/P1/P2/Info、位置、规则来源、影响、建议、PR/base/head 和轮次。不同评审轴的 finding 不互相抵消，也不能由汇总者静默降级。
禁用：review 建议、审查意见（用于正式状态时）

**Review 裁决**
用户通过 `/review-loop` 针对当前 head 上具体 finding 作出的结构化决定：授权修复、提交反证、登记 P1 延期或知悉 P2/Info。`/review-loop` 只提交最小临时请求，由 `workspace record-review-decision` 重核事实、绑定提交和时间后写入 `review-decisions.json`；Markdown 和 PR 文本不能代替它，修复提交会让旧裁决失效。
禁用：Markdown resolution、人工自由放行

**收口**
一轮循环或功能分支完成后的收尾动作：处理最终 Review finding、确认 GitHub 交付状态、人工合并，再由 `/compound-docs` 沉淀经验、清理活知识熵并收尾任务文档；物理归档须另有显式授权。
禁用：复盘、总结

**熵 GC**
/compound-docs 对 active 知识做的证据审计：保留当前事实，改写/合并/迁位仍有效内容，删除已失效或被完整覆盖的内容；不是按字数压缩文档。
禁用：文档压缩、自动摘要

**物理归档**
把证据充分的 done/superseded 阶段性文档从 active 区移动到 `docs/archive/`，同步仓库内导航且不留旧路径副本；必须由用户明确要求或确认候选清单。
禁用：删除历史、状态收尾（状态变更不等于文件移动）

**历史冷档案**
`docs/archive/` 中仅供追溯的完成态历史文档；日常实现、沉淀与熵 GC 排除，doctor 仍检查 frontmatter 和相对链接但跳过 updated 新鲜度。
禁用：废纸篓、备份目录

**杠铃策略**
人力只花在两端——业务口径对齐（scenario-alignment）与合同级技术决策（technical-alignment），中间「怎么写代码」交给自动化流水线。
禁用：两头重

**对齐稿**
杠铃两端的产出（`align-*.md` 业务对齐稿、`tech-*.md` 技术对齐稿）：prd-generate 的一次性输入材料，被正式 PRD 吸收后置 superseded，不是持续维护的真相源。
禁用：需求稿、草稿

**分层真相源**
md 文档是意图真相（人改），prd.json + state.json 是执行真相（机器改）；冲突以 md 为准再派生，执行状态永不回流 md（ADR-003）。
禁用：单一真相源（本项目真相源分两层，笼统说单一真相源会掩盖方向规则）

**取舍标记**
builder 有意识选择带已知上限的简单实现时就地留下的 `// 取舍: <当前上限>，<升级触发条件>` 注释；收口时被 /compound-docs 汇总成**取舍账本**收账，不是沉淀候选。
禁用：TODO（取舍标记记录的是已做出的决策及其翻案条件，不是待办）

**瘦清单**
各工具插件目录（`.claude-plugin/` 等）里只指回唯一源 `skills/`、`commands/` 的 json 清单，不复制内容——消灭副本漂移。
禁用：插件副本

**workspace**
引擎运行时状态与证据目录（默认 `.workspace/`），容纳 prd/state/progress、证据、报告、截图，以及独立的安全标记和写租约协议根；不要与编辑器工作区或 `docs/archive/` 历史冷档案混称。
禁用：工作区（泛指编辑器工作区时易混淆，指本概念时统一用「workspace」）

**workspace 安全标记（workspace-safety.json）**
把一个 canonical workspace 身份与新版安全协议绑定的永久标记。它不是当前运行状态，也不能由后来者在普通启动中自动补写或替换。
禁用：锁文件、安全缓存

**workspace 写租约**
正式写入口在同一 canonical workspace 上取得的 owner-bound 单写者资格。永久 `engine.lock/` 只是协议根，当前 owner 只存在于 `engine.lock/lease/`；ready 表示没有活动 lease。异常退出、身份不明或未完成 mutation 必须显式恢复，不能按 pid stale 自动接管。
禁用：工作区锁、进程锁、文件锁、互斥文件、单实例锁（统一用「workspace 写租约」；`engine.lock/` 称为「协议根」）

**仲裁标签**
notes 中请求人工裁决的行前缀族：`[需求冲突]`（源文档与验收标准冲突，按验收标准实现后留待人工）与 `[需要人工核实]`（其他必须人工介入的异常，配合 blocked 使用）。所有机械路径（打回、清理、再派生）必须原样保全这些行。
禁用：冲突标记、人工核实标记（统一用「仲裁标签」）

**验证报告**
一次运行的验证证据静态存档（`<workspace>/report.html`）：Story 状态与验收标准、门禁配置、截图工件、本地最终 Review、所记录的 GitHub 交付状态和篡改红旗区汇总为零依赖单页。循环结束从引擎冻结的 PRD 快照自动生成，`coding-x report` 可从磁盘重生成；生成时必须核对最终 Review 当前性，无法核对、Runner 或绑定输入已变化、GitHub 状态未刷新时不得显示交付就绪。state 损坏时只生成“全部未验证”的红色诊断报告。它是阅读视图，不是共享凭证，也不能用 Story 绿色代替可交付结论。
禁用：HTML 报告、静态报告（统一用「验证报告」）

**异常轮**
Builder 或 Validator 进程以异常结局结束的轮次。结局判定机械三分（completed / timeout / error），只看引擎自己观测的超时信号与退出码，不解析 agent 输出内容（ADR-009、023）。Developer 异常按既有规则回写待复核；结构化 Validator 异常保留未验收候选、拒绝凭证并立即返回 5。
禁用：失败轮、作废轮（异常结局不等于产品已知失败）

**Agent 调用凭证**
引擎对一次真实 Builder/Validator 子进程调用的机械观察：平台受管进程集合确认收口前的墙钟耗时、退出码，以及仅在异常时保留的有界 stdout/stderr 尾部。主动逃逸平台 containment 的恶意进程不在此证明内；输出内容是恢复诊断，不是 provider 事实、账单证明或验收结论。
禁用：调用日志、执行证明、成本凭证

**空转轮（no-op）**
builder 正常退出但 state.json 与 progress.md 双无变化的轮次；跳过机械门禁与 validator（省一次强模型调用），计入 stall 熔断。
禁用：空跑轮、无效轮

**回写待复核**
Developer 异常轮与旧兼容路径的兜底机制：本轮被翻为 true 且未经验收的 passes 回写为 false，notes 追加 `[中断轮待复核]` 机械标记行（自带下轮重验指令）；不涨 retryCount（中断不是能力不足，不消耗打回预算）。结构化 Validator 不使用该机制，按 ADR-023 保留候选并退出 5。
禁用：回滚（只回写验收状态，不回滚已落盘的提交与产物）

**stall 熔断**
空转轮、Developer 异常轮或旧兼容路径触发待复核回写的轮次，连续累计达 `--stall-limit`（缺省 3）即提前终止循环（退出码 1）；结构化 Validator 不可验证立即退出 5，不进入 stall 重试。
禁用：空转保护、无进展终止

**收敛出口**
全部 story 达到有效通过（`passes && validated`）或 blocked 时的结束语义：全通过退出码 0；存在 blocked 时列出 story 号、退出码 3 交人工处理。
禁用：完成出口、全绿出口

**证据索引**
一次运行的结构化证据记录文件（`<workspace>/evidence.jsonl`，append-only 每行一条）：引擎写门禁、轮次、调用凭证、篡改、目标绑定与协议裁决，Validator result 另以 `validation-claim` 保存逐 AC 声明，builder/validator 也可登记截图元数据。`source` 是信任级别标记——engine=机械观察/状态机事实，builder/validator=agent 声明；整个文件仍在 agent 可写区，消费端按来源诚实标注、不假装防伪。
禁用：evidence 结构化索引、结构化证据索引（统一用「证据索引」；指文件本身时用 `evidence.jsonl`）

**难度档位（difficulty）**
story 可靠完成所需的模型推理能力档位（low / medium / high）；不是代码行数、工期或故事点。
禁用：难度分、复杂度（复杂度只是判定证据之一）

**全局模型目录**
当前 OS 用户为 Claude Code、Codex、Cursor 声明的允许模型 ID 清单，默认位于 `~/.config/coding-x/config.json`，可由 `CODING_X_CONFIG` 覆盖；它是跨项目的选择边界，不是账号、provider、配额或网络下的实时可用性证明。
禁用：当前可用模型列表、runner 实时枚举、模型发现（历史决策语境除外；现行实现不向 runner 查询或证明实时可用性）

**显式模型策略**
项目启用了 `prd.json.models`，或本次运行传入任一模型 CLI 覆盖；本次可能实际调用的全部模型 ID 都必须在对应 runner 的全局模型目录中声明。
禁用：自定义模型模式

**初始路由**
story 尚未升级时的 builder 模型选择：单次 CLI 覆盖优先，否则按难度档位取 PRD 映射；两者都属于显式模型策略。只有两者都不存在时才使用 runner 默认。
禁用：默认路由（runner default 只是其中一种回落）

**有效失败**
可归因于当前实现/推理结果的首次机械事件：门禁打回、引擎接受 Validator 的 failed claim 或 builder completed no-op。超时、非零退出、认证、网络和环境故障不是有效失败。
禁用：失败轮（会与异常轮混淆）

**升级状态（escalated）**
引擎在 story 首次有效失败后置位的 sticky 执行状态；表示后续 builder 使用专用 escalation 路由。该字段由引擎独占，agent 不得改写。
禁用：升级次数、重试状态（它与 retryCount 独立）

## 关系

- 一个 prd.json 包含多个 story；一个 story 有多条 acceptanceCriteria
- builder 把 `passes=true` 作为候选结果；引擎生成 validation request，Validator 提交逐 AC claim，引擎确认目标绑定/协议/state 不变式后才写 verdict 或签发验收凭证；passes 与 validated 同时为 true 才是有效通过
- 打回递增 retryCount，达到上限转 blocked；全部 story 有效通过或 blocked 即走收敛出口结束循环
- Developer 异常轮触发回写待复核并计入 stall 熔断；结构化 Validator 异常保留候选并立即退出 5；空转轮跳过门禁与 Validator、同样计入熔断
- 每次实际启动的 Builder/Validator 都产生 Agent 调用凭证；status/report 从证据索引恢复耗时、退出码和异常诊断，但不把输出内容当裁决依据
- 对齐稿被正式 PRD 吸收（superseded），PRD 派生 prd.json（分层真相源的意图→执行方向）
- 收口包含最终 Review finding 裁决、GitHub 交付核验与 `/compound-docs`（沉淀、熵 GC、状态收尾及显式授权后的物理归档）
- 物理归档把完成态阶段文档从 active 区移入历史冷档案；状态收尾只改 status，不自动构成移动授权
- 验证报告展示 `final-review.json` 的本地质量判断与其中记录的远端状态；旧 `review-*.md` 只作为历史本地反馈，不能作为通过证明
- 验证报告消费证据索引（门禁历史、Validator claim、协议裁决、轮次时间线、验收标准↔截图对账均由它派生）；证据索引缺失时报告退回文件名猜测截图归属
- 难度档位决定初始路由；首次有效失败置升级状态，后续 builder 走 escalation，与 retryCount 独立
- 全局模型目录限定显式模型策略可引用的 ID；项目 PRD 保存五项具体映射；某轮实际传给 runner 的模型只记录进证据索引
- runner-default 不构成显式模型策略，因此无需全局模型目录；目录声明与 provider 是否接受模型是两个独立事实
- TDD skill 约束每个行为的开发顺序；Codex/Claude 插件 hook 与 Cursor 项目检查提前反馈；引擎 TDD 门禁独立重跑并裁决；Validator 仍只按 AC 验证行为

## 已解决的歧义

- 2026-07-05 「command」与「skill」曾被混称为「命令/能力/技能」——已拍板：command 是用户敲 `/命令` 显式触发、支持传参的工作流；skill 是模型按语境自动选用的能力。二者是不同原语，分别放 `commands/` 与 `skills/`（README「commands 与 skills 的区别」）。
- 2026-07-05 「沉淀」曾兼指整个收尾流程——已拍板：全流程叫**收口**（人审+合并+沉淀），**沉淀**只指把经验写回 docs/ 的那一步。
