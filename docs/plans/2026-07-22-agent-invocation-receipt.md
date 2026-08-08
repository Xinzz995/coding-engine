---
title: 'Agent 调用凭证实施计划'
status: done
updated: 2026-08-09
scope: root
---

# Agent 调用凭证实施计划

> 当前边界：ADR-021 与 `2026-08-09-posix-opaque-runner-termination-proof.md` 已取代本计划对 Agent
> timeout 的旧进程树假设。调用凭证只在普通 iteration 写入时成批持久化，不是逐调用
> 日志。若 Builder 已权威结算、随后 Validator 发生 proof-missing，整轮不写普通 iteration，
> Builder 凭证也不单独落盘；只保留安全协议与永久隔离事实，且不进入下一轮。下文主体保留
> 本计划实施时的历史目标，现行行为以 ADR-016、021 和上述 POSIX 计划为准。

**Goal:** 让每次已经权威结算的真实 Builder/Validator 进程调用都留下可恢复诊断的机械凭证：实际结局、退出码、耗时和有界输出尾部；终端仍实时显示原生 runner 输出。proof-missing 只保留安全协议、隔离状态和受保护现场，不伪造普通调用凭证。

**真实起点:** 2026-07-22 在隔离仓库执行新 validation protocol dogfood：Codex Builder/Validator 正常闭环并分别报告 29,421 / 16,798 tokens，但 `evidence.jsonl` 只记录 outcome/model；Claude Code 在 Builder 阶段返回 `402 Account overdue`，最终 report 只剩“builder 异常退出”，没有 402、退出码或耗时。state 正确保持未通过、Validator 未启动、锁已释放，因此本功能只补可观测性，不改变状态机裁决。

## 完成合同

1. `runAgent` 对能够权威结算的 completed/error/timeout 返回非负 `durationMs`、`exitCode` 和最多 2000 字符的 stdout/stderr 合并尾部；stdout/stderr 继续实时转发，普通 POSIX 项目命令和 Windows 超时仍等待平台 containment 证明后才结算。POSIX 不透明 Runner 已启动后的外部终止不沿用这条返回路径，而是按 ADR-021 永久隔离。
2. 每个已经权威结算的 Builder/Validator 都在本轮 iteration 记录 invocation：耗时与退出码存在；只有异常/超时才持久化诊断尾部，成功输出不落 evidence，避免噪声与不必要的数据留存。proof-missing 不写普通 iteration。
3. evidence 读取端严格守卫新增字段，旧记录继续可读；status JSON/文本与 report 能显示最近一次已结算调用的耗时，并在异常时显示退出码和转义后的诊断尾部；永久隔离只显示安全协议与隔离事实。
4. 固化真实 402 形态回归：fake runner 向 stderr 写 `API Error: 402 Account overdue` 后退出 1；最终 state 不通过、Validator 未跑、iteration 含 error/exit=1/duration/诊断，report 可定位恢复原因。
5. 本轮不解析人类可读的 `tokens used` 文案，也不修改三 runner 的 CLI 参数。token/cost 需要各 runner 官方结构化输出的独立 adapter 与兼容策略，另案验证后接入；不得把脆弱正则包装成准确成本。

## 黄金原则对照

| 原则                    | 本功能的机械裁决                                                                                                       | 验收证据                                                                                                |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| 1. 完成必须可证伪       | 完成合同 1–5 都有字段、上限和失败样本；“诊断更好”不作为模糊目标。                                                      | agent、evidence、loop、status、report 定向断言；真实 402 fixture。                                      |
| 2. 生成者不能自签       | duration/exitCode/捕获字节是 engine 对子进程的观察；诊断内容只表示 runner 输出，不升级成 provider 真相或 CI 证明。     | schema 使用 `source=engine` iteration 且文档标明 observed output；state 仍按既有 outcome/receipt 裁决。 |
| 3. 自主性必须与风险对称 | 不扩大 agent 权限或写入范围；输出仅滚动保留 2000 字符，成功输出不持久化，采集失败不得改变循环结局。                    | 超长输出截断、timeout 进程树、成功不留诊断、旧 evidence 兼容测试。                                      |
| 4. 控制面复用原生执行面 | Claude/Codex/Cursor 参数与原生执行保持不变；只在 runner-neutral 进程 adapter 中 tee 与计时，不解析供应商人类文案。     | 三类 `buildAgentArgs` 回归不变；同一 invocation schema 无 runner 分支。                                 |
| 5. 先度量失败与恢复     | 先以真实 Codex/Claude dogfood建立成功与 402 失败基线，再实现 duration/diagnostic；该凭证是后续恢复率与成本工作的地基。 | dogfood 对账、402 回归、report/status 可恢复诊断；token/cost 缺口显式保留。                             |

未裁决项：无。token/cost adapter 是范围外后续项，不影响本轮 runner-neutral 调用凭证。

## 实施任务

### Task 1：进程 adapter 红灯测试与实现

- 扩充 fake agent：stdout/stderr、402、超长诊断。
- `runAgent` 改为 pipe + tee + bounded tail，返回 duration；保持超时进程树语义和终端可见性。

### Task 2：iteration 证据单源

- 新增 `AgentInvocationEvidence` 严格读入守卫。
- 在 `recordIteration` 公共底座自动附加实际调用凭证，覆盖所有 early continue/break 点，避免五个写入点漂移。

### Task 3：恢复入口

- status 最近实际调用增加 outcome/duration/exit/diagnostic；文本输出只展示有界摘要，JSON 保留完整有界尾部。
- report 时间线展示耗时、退出码和折叠诊断，全文本转义；成功调用不出现诊断区。

### Task 4：文档、验证与提交

- 新增 ADR-016，同步 architecture、glossary、patterns、README 与 dogfood regression。
- 运行定向测试、typecheck、全量测试、build、doctor、diff check；用构建产物 fake 402 冒烟后中文 conventional commit。
- 推送、tag 与 v0.27.0 发布仍需用户明确授权，不在本轮自动执行。

## 执行结果

- 真实 runner 基线已完成：Codex Builder/Validator 在隔离仓库闭环通过，分别报告 29,421 / 16,798 tokens；Claude Code 在 Builder 阶段真实返回 402，引擎保持未通过、未启动 Validator、释放锁且工作树干净。token 数只作为人工对账基线，未从终端文案写入结构化证据。
- `runAgent`、iteration evidence、status 与 report 已贯通调用凭证；完成调用只留 duration/exit，异常调用另留最多 2000 字符诊断。fake 402 端到端回归确认 state 不假绿，status/evidence/report 均可恢复 `API Error: 402 Account overdue`。
- 定向测试 126 项及主循环关键路径 7 项通过；`npm run typecheck`、`npm test`（27 个文件、583 项）、`npm run build`、构建产物 `doctor`、fake 402 冒烟与 diff check 全部通过。
- 五项黄金原则复核无未裁决项：字段与上限可证伪；凭证来自引擎对子进程的观察且不参与业务验收；成功 transcript 不落盘；三 runner 复用同一 adapter；真实失败先形成基线与自动回归。
- 后续显式保留为 provider adapter：只有验证各 runner 的官方结构化事件合同后才采集 token/cost，不解析 `tokens used` 等人类输出；Cursor 真实 dogfood 需先安装 runner。本次未推送、打 tag 或发布。
