---
title: POSIX 不透明 Runner 外部终止证明修复
status: done
updated: 2026-08-12
scope: root
---

# POSIX 不透明 Runner 外部终止证明修复

## 背景与事实边界

0.35.0 RC2 的 coding-engine 自托管 Dogfood 中，Builder 在 30 分钟截止线被终止。固定
POSIX supervisor 随后确认 launcher 进程组为空且输出管道 EOF，写出
`posix-group-empty-and-pipes-eof-v1` 回执并允许下一轮启动；但 Codex 正常执行 `npm test` 时已经把
它放入另一个 session/process group。外层 Codex 结束后，该测试以 `PPID=1` 继续运行，与下一轮
Builder 真实重叠。

30 分钟预算不足不是本修复的安全缺陷：该预算可配置。本缺陷是受支持的不透明 AI Runner 被外部
终止后，外层进程组证明不能代表 Runner 内部命令域已经清空，却被当成完整 operation proof。
RC2 因此永久作废，不得进入 staging。

本轮采用最小保守修复：POSIX 上只有 AI Agent/Reviewer 这类不透明 Runner 在外部终止后进入永久
隔离；普通项目质量命令继续使用现有进程组合同，Windows Job Object 合同不变。恢复自动清理与重试
需要未来取得能封闭 fork/setsid/reparent 竞态的强证明，不在本轮用 PID、PGID 或轮询近似替代。

当前 Agent 调用凭证按普通 iteration 一次性持久化，不是逐调用日志。若 Builder 已权威结算、
随后 Validator 进入 `operation-proof-missing`，本轮会在 iteration 写入前永久隔离；此前
Builder 的调用凭证也不单独进入 evidence/status/report。本修复保留这一轮级边界，不在
永久隔离后追加部分普通轮次。

## 完成合同

| 验收标准                                                                                                             | 失败时观察                                    | 验证证据                                                                       |
| -------------------------------------------------------------------------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| POSIX 不透明 Runner 已启动后遇到 timeout、user-interrupt、parent-shutdown、output-failure 不签发外层进程组权威回执   | operation 被普通 settle，循环进入下一轮       | helper/supervisor 参数化回归与 parent SIGKILL 回归                             |
| 活 parent 原子安装永久 `operation-proof-missing`；parent 已死时保持 armed 且无权威 receipt，并由磁盘判为同一永久终态 | 使用可重启恢复的 quarantine，或释放 workspace | 磁盘状态、恢复分类；timeout/output failure 退出 2，SIGINT/SIGTERM 保持 130/143 |
| 跨组且不继承 stdio 的真实形态不会假绿                                                                                | detached 后代仍活着时 receipt 被采用          | `detached:true`、`stdio:'ignore'` fixture；随机 nonce/stop marker 自清理       |
| Agent 超时后不自动启动第二个 Builder/Validator                                                                       | iteration 2 marker 出现或调用次数大于 1       | loop 级失败回归                                                                |
| Review 外部终止沿用同一保守边界                                                                                      | Review 把外部终止当成已结算普通失败           | Review runner 回归                                                             |
| START 前终止仍可用 never-started proof 安全结算                                                                      | 从未执行 Runner 也被永久隔离                  | pre-start timeout/interrupt 反例                                               |
| 普通项目命令、POSIX 正常 Runner 成功、Windows Job Object 行为不回归                                                  | 无关命令被永久隔离或平台矩阵失败              | 既有 supervisor/engine/review 测试与三平台 CI                                  |
| 修复合并后从新 main 重建候选，三仓使用全新安装和 workspace 重跑                                                      | 复用 RC2 的 tgz、receipt 或 Final Review      | 新候选摘要、三仓新 requestId/HEAD/Final Review 证据                            |

## 设计裁决

1. `runManagedWorkspaceProcess` 增加内部的 POSIX 结算策略；默认仍信任固定进程组，只有明确标记的
   不透明 Runner 使用保守策略。供应商差异不进入 story/state/report schema。
   固定 `--version` 叶子调用不接受 prompt、模型或工具命令，继续归入普通进程组；测试同时锁定真实
   Agent/Review proxy 必须为 opaque，避免未来扩展参数时无声越界。
2. 策略在 START 前随固定 POSIX helper 的 DATA 合同送达。只要不透明 Runner 已可能执行并发生
   外部终止，helper 即使清空外层进程组和管道也不写现有 drained receipt，而是失败关闭。parent
   crash 后磁盘因此天然保持 `armed + no receipt`。
3. 活 parent 识别这一固定失败后，在任何 settle 前安装 `operation-proof-missing`；若 parent 已被
   SIGKILL，没有 owner-authored quarantine 也必须由磁盘 evaluator 将 `armed + no receipt` 判为同一
   永久终态。所有 catch 分支都不得降级为可重启恢复的 `containment-unconfirmed`。
4. START 前终止继续使用 `never-started-containment-empty-v1`，因为 Runner 尚未执行。Runner 自然
   code 0 和自然数字非零退出继续按现有合作式 Runner 完成合同结算；自然 signal 与观察到
   `process-tree-not-empty` 对不透明 Runner 也视为缺少完整证明。这里明确假设正常数字退出表示
   Runner 已完成自己的同步清理；未来真实反例将再次收紧。
5. `operation-proof-missing` 是永久终态；同机重启不得把它恢复为 ready。外层进程组清空只可作为
   诊断，不得升级为完整 Runner 域证明。
6. 不用 PPID 轮询、环境 marker、秒级启动时间或裸 PID/PGID 发信号签发空树证明。这些机制无法
   封住 macOS 上的 fork、setsid、reparent 与编号复用窗口。
7. 本次回归创建的 detached 进程使用随机 nonce、stop marker 和 exit marker 自行收口；PID/PGID
   仅作有界后备清理，不能成为通过证据。生产修复不宣称已经终止未知逃逸后代，只保证不会释放
   workspace 或开始下一轮。

## 黄金原则逐项对照

1. **可证伪合同**：上表把结算、隔离、禁止重试、平台不回归和重新 Dogfood 分别绑定到可观察
   证据；退出码 7 或 Agent 自述不能单独通过。
2. **独立证据**：裁决来自 supervisor 事件、operation 状态机与磁盘 quarantine，不采用 Runner
   的“已清理”声明。真实 detached 反例由测试进程独立观察。
3. **自治与可逆性**：不扩大权限；外部终止后收紧为永久隔离，禁止自动重试。RC2 可丢弃，任何
   staging、2FA、tag 与 Release 仍需后续明确人工批准。
4. **原生能力与控制平面**：保留 Codex 原生命令执行；差异仅表现为控制层的 opaque policy。
   Windows 继续依赖 Job Object，普通 POSIX 命令继续依赖 process group。
5. **假绿与恢复**：先固化这次真实“外层已空、逃逸后代仍活、下一轮已启动”的失败，再实现最小
   阻断。目标是假绿和自动跨轮重叠归零；新 workspace 只解决协议状态复用，不证明未知进程已经死亡。
   继续前还需独立确认旧进程不会影响原项目目录；无法确认时改用隔离检出或重启主机。

## 非目标

- 不把 POSIX process group 升级宣传为操作系统沙箱。
- 不在本轮实现 Linux cgroup、macOS 原生进程句柄或跨平台原生 guardian。
- 不靠加长 Builder timeout 掩盖结算缺陷；修复后 Dogfood 可按真实检查耗时单独扩大预算。
- 不自动杀死无法以强身份绑定的跨组 PID/PGID，也不在隔离后自动恢复旧 workspace。
- 不把 SIGINT/SIGTERM 的进程退出码改成 2；仍保留 130/143，只收紧 workspace 结算状态。
- 不复用 RC2 的 Go、Python 或 engine 结果；新 main 必须生成新候选并完整重跑。

## 实施顺序

1. 写入 detached/no-stdio 的失败回归，证明旧实现会结算并允许继续。
2. 在 START 前把 opaque policy 送达固定 helper；外部终止后禁止 helper 安装权威 receipt。
3. 让 Agent 与真实 Review proxy 显式启用，并验证活 parent、parent SIGKILL、永久 quarantine、一次
   调用、不启动下一轮与普通命令不回归。
4. 运行格式、静态检查、类型检查、定向/全量测试、构建和独立对抗审查。
5. 合并后作废 RC2，从新 main 构建候选并在三个仓库使用全新 workspace 重跑 Shadow Dogfood。
