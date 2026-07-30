---
title: 021-workspace-write-lease-and-process-isolation
status: active
updated: 2026-07-30
scope: root
implementation: planned
---

# 021. 工作区写租约与子进程隔离

## 背景

ADR-008 用 `engine.lock` 防止两个 `run/repair` 同时写 workspace，ADR-009/016 又要求超时后先
终止整棵子进程树再继续。但 Issue #106 的复核证明，两项局部机制没有形成同一个生命周期：

- `engine.lock` 只有 pid，没有唯一 owner；旧 handle 可以删除或覆盖后来者的锁；
- SIGINT/SIGTERM handler 先删锁再退出，机械检查或 Agent 子进程树可能仍在运行；
- 机械检查在 spawn 前没有 crash-safe 活动记录，父进程消失后无法判断后代是否仍可写；
- 损坏锁和已死 pid 被自动当成 stale 接管，但旧父进程死亡不等于旧孙进程死亡；
- completed/error 普通返回没有检查遗留后代，只有 timeout 局部走进程树终止；
- `report`、`prd-to-json`、`review-loop` 等正式写入口不共享一个排他协议。

因此，“pid 看起来已死”不能再等同于“workspace 已可写”，“根命令已退出”也不能等同于“受管
进程集合已清空”。

## 保证范围

本决策保证的是 **0.34.0 协议内、同一主机、诚实遵守 coding-x 入口的 owner domain**：
一个 owner 可以是父引擎及其同一时刻唯一的受管子进程委托，但任意时刻最多只有一个 owner
domain 能修改 canonical 安全路径或业务路径。竞争者只能并发写各自唯一、路径不相交且永不作为
权限/业务事实的 inert staging；失败后不再自行删除。它不声称防御同一操作系统账号下故意删锁、
篡改记录、使用 WMI/setsid 等方式主动逃出 containment 的恶意代码。

0.34.0 初始化后永久保留目录型 `engine.lock/` 协议根，可持续让 0.33.x 的 run/repair 文件锁 acquire
失败；但它不能追溯隔离一个已经运行、且旧锁文件已被删除的 0.33.x 进程，也不能阻止 0.33.x 中
原本不取锁的 report/prd-to-json/review-loop 直接写。因此所有 0.33.x 写入口在初始化后都属于明确
禁止的协议外访问，安全保证从完成一次明确的 0.34.0 初始化且停止旧 writer 后开始：

- 新项目直接建立新版安全标记，不存在旧协议迁移；
- coding-engine 首次自托管使用新的 workspace，并在切换固定版本前确认所有 0.33.x 写命令已停止；
- 已存在的旧 workspace 不自动迁移。quality 版本 pin 与初始化标记不满足时，0.34.0 拒绝正式运行。

这是升级前提，不包装成新版代码可以事后 fencing 旧进程。兼容测试仍须运行真实 0.33.3 的
acquire/verify/release：证明 ready/active 时新启动 acquire 都会拒绝、verify/release 不能删除永久
协议根；另用实际 0.33.3 report 证明无锁旧入口不会被目录 fence 拦住，从而把“禁止旧 CLI”作为
真实运维前提而非虚假保证。已经运行的旧 verify 即使重建失败仍会继续，也是切换前必须停机的反例。

## 决策

### 1. 一个 owner-bound 写域

新版 `engine.lock/` 是初始化后永久存在的协议根，不再代表“当前有人持锁”。它包含绑定安全标记与
workspace identity 的 `protocol.json`，以及随 protocol root 一次安装的固定 `incidents/` 父目录；当前
owner 只存在于 `engine.lock/lease/`。竞争者先在协议根
内完整 staging 非空 lease（owner.json 与必要目录），回读后原子 rename 到固定 `lease/`；已有合法
lease 必为非空，rename 不能替换它，只有一个赢家。`owner.json` 记录严格 schema、随机 `ownerId`、
owner pid、进程/启动会话身份、主机、workspace 身份、启动时间和操作类型，不记录 prompt、环境
变量、完整命令或凭据。失去竞争者停止且不再删除 staging；这些不相交、非权威目录只有后来已取得
active lease 的当前 owner 可在 creator exact dead 时清理，避免“旧竞争者清垃圾”与新 owner 并发写。

获取、释放、验证、恢复和安全记录更新必须匹配当前 `ownerId`；只匹配 pid 不够。进程探测返回
`alive | dead | unknown`，无法读取、身份精度不足、异机或权限错误均为 unknown。旧 handle
观察到锁缺失、损坏或 owner 不同后只能进入 `lease-lost` 并停止，不能删除、覆盖或“自愈夺回”
后来者的锁。

ownerId 也不能关闭同一进程里的异步 TOCTOU。WorkspaceSession 必须把 parent 写入、operation /
mutation 转移、signal 收口与 release 放进同一个排他串行器。release 先同步标记 closing、拒绝新动作，
等待 in-flight 写完成，再在独占区重核 owner 并移动 lease；signal/finally 不得旁路。这样旧写不可能
在 lease 已释放、下一 owner 已取得写权后再提交 temp rename。

写权按状态分配：

- `bootstrap-owned`：只允许显式 workspace 初始化者原子写、回读安全标记；
- `owned-idle`：只有父进程的 `WorkspaceWriter` 可写业务文件；
- `prepared/prepared-bound/armed`：磁盘只保留这些状态；禁止父进程普通业务写，只有 START 后的唯一
  operation 可按持久化委托范围写；
- `recovery-active`：旧 owner 已证明失效后，只有 attempt lease winner 可写恢复安全记录；仅
  bootstrap-complete 可补全精确安全标记，delegated-finalize 可复核持久化 delta，mutation-resume
  可按 staged manifest 使用限定的 `RecoveryWriter`；
- `running/terminating`：仅是当前进程内的运行诊断，不覆盖冻结的 armed 记录；
- `quarantined`：独立安全记录，禁止普通 state/evidence/report 写入；
- containment 清空并完成返回后校验，才回到 `owned-idle`。

Builder 的委托范围是候选 state、progress、截图和 screenshot evidence；Validator 是 result、截图和
screenshot evidence。项目检查和 Final Review 默认不得写 workspace。父进程在 START 前把完整业务
文件基线、委托范围、语义校验版本与 prepared 记录放入唯一 staging 目录，回读后一次原子安装为固定
operation；armed 继续绑定其摘要。正常返回和崩溃恢复都使用同一份基线核对变化。通过后完整
operation 一次原子移入 settled 目录，不能逐文件清 active/baseline/receipt。越界写入不能被当作通过。
这里的委托是诚实执行合同，不是操作系统权限沙箱；更强的干净检出与文件系统隔离仍由 Issue #91
处理。

baseline 不保存文件正文；字段级委托必须保存可重算的受保护字段 canonical projection digest，追加
文件保存旧长度与 prefix digest，只新增目录保存旧成员摘要。任何委托若不能靠这些持久承诺完整
复核，就不得启动项目代码，不能把只存在于父进程内存的旧值留给崩溃恢复猜测。

delegated child 发生范围外新增、修改、删除，或把允许文件写成非法结构时，不回到 owned-idle，
也不补写普通失败 evidence。coordinator 只能在锁内写 safety-only quarantine；若锁本身已被改动则
直接 lease-lost/invalid。首版不猜测回滚被 child 改坏的字节，用户只能从受 Git 管理的规格在新的
空 workspace 重新派生。

quarantine 只有三个严格 reason：`containment-unconfirmed`、`operation-proof-missing` 与
`workspace-integrity-violation`。第一种只有在 armed receipt 已有效、仅欠 supervisor dead/identity，
或根本没有 armed operation 时，才能在严格同机 reboot proof 后继续原 mode/delta 裁决；后两种是
永久终态，reboot 不得绕过，只能改用新的空 workspace。recovery 后发现越界只能把第一种原子升级为
integrity violation 并绑定 prior digest；安全记录损坏直接 invalid，不用 quarantine 掩盖。

诚实进程的释放顺序是：确认无活动 containment → 将完整 operation 目录原子移为本 owner 的 settled
记录 → owner-checked 把整个 `lease/` 原子 rename 到 `engine.lock/incidents/` 下的 owner 专属
incident/tombstone。该 rename 必须是
旧 owner 最后一次 workspace 写；它不再删除 tombstone。永久 `engine.lock/protocol.json` 不动。
rename 成功才表示租约已释放；历史 released tombstone 或 inert staging 只能由后来已经取得 active
lease 的当前 owner 在 creator exact dead 时尽力清理。任何前置步骤不确定时保留 lease 隔离并返回
非绿。

### 2. 先持久化 containment，再允许项目代码运行

Developer、Validator、普通/TDD 检查和三个 Final Review Runner 共用 coordinator 与打包在 coding-x
中的短生命周期 supervisor。协议严格按以下顺序执行：

1. 父进程暂停普通写，冻结并回读调用前业务文件 manifest、委托范围和语义校验版本，再原子写
   `prepared` 绑定其摘要；
2. 启动固定 supervisor，但暂不传 workspace path、target 或 DATA；父进程取得 supervisor 精确身份，
   原子写 `prepared-bound` 并回读；
3. 只有 prepared-bound 成立后，项目 executable/args/cwd/env 才经专用 IPC 传递且不落盘；
4. supervisor 建立尚不能运行项目代码的 containment，并返回 containment 身份；
5. 父进程把继续绑定同一 baseline/scope 摘要的 `armed` 原子落盘并回读 owner/operation/身份完全一致；
6. 父进程发送且只发送一次带同一 `operationId` 与 frozen armed digest 的 `START`；supervisor 重读
   canonical armed 并核对 digest 后才接受；
7. supervisor 才启动或恢复项目代码，并返回 `STARTED`；它与 `running` 都只存在于内存诊断，磁盘
   armed 字节保持冻结，不用于推断 START 是否已经发生。

`DATA` 不等于授权；重复、迟到、错 operation 的 DATA/START/ACK 一律失败关闭。`armed` 在
START 发出后可能已经运行项目代码，所以恢复必须把 armed 当成“可能已运行”，不能因没有 STARTED
或 running 落盘而宣称安全。drained receipt 绑定冻结的 armed 摘要，避免快速启动/退出与状态回写
争抢同一个权威字节。

prepared/prepared-bound 还必须有 owner-live 的 abort-before-start 出口。supervisor 从未建立，或已
确认项目代码零执行、prestart containment 清空、supervisor exact dead 且 baseline 完全未变时，父进程
写入绑定 operation/baseline/active 摘要的 `prestart-abort.json`，再把完整 operation 原子移入 settled，
然后才回 owned-idle 并写“未启动”失败/中断结果；这两态禁止写 drained receipt。若任何证明不确定，
保留 operation 并进入 containment quarantine。已经 armed 时不能由父进程声称 START 未执行；只有
supervisor 签发完全绑定的 `never-started-containment-empty-v1` receipt 才可按未启动路径 settle，
否则仍按“可能已运行”处理。父进程在 settle 前崩溃，既有 recovery 继续用 baseline unchanged 与
supervisor exact dead 裁决，不需要等待旧 owner 自己恢复。

parent→supervisor 控制通道不得被 launcher/target/后代继承，supervisor→launcher 的 START 通道也
不得传给项目 target；POSIX 使用 close-on-exec/显式 stdio 表，Windows 使用最小 HANDLE_LIST。
stdout/stderr 是有意传递的独立数据管道。否则项目后代持有控制 fd 会让 parent crash 后的 EOF
永远不出现，协议不成立。

父进程在初始 prepared 后、prepared-bound 前死亡时，supervisor 从未得到 workspace path/DATA，因
IPC EOF/握手超时退出，也没有 workspace 写能力；握手期限后可按未授权状态恢复。prepared-bound
之后死亡时，恢复还必须核对持久化 supervisor 身份 exact dead；armed 继续按 START 可能已发出处理。
父进程在 START 后死亡时，supervisor 必须主动终止 containment；磁盘记录仍保留，下一实例只有在
重新确认 containment 清空后才能恢复。

父进程死在 DATA 后、canonical armed 前时，supervisor 只终止仍停在 barrier/suspended 的 containment
并退出，不得写无法绑定 armed digest 的 receipt；磁盘 prepared-bound 由 baseline unchanged +
supervisor exact dead 恢复。只有 canonical armed 严格存在时，supervisor 才能重读并用其 frozen digest
写 drained receipt。

POSIX supervisor 不仅位于 target containment 之外，还必须在独立 session/process group 中，并在
回报可持久化 identity 前安装不会退出的 SIGINT/SIGTERM handler；它只接受 parent IPC 的 TERMINATE
或 parent EOF。这样终端 Ctrl+C/对 parent 的 SIGTERM 只由 parent 进入统一收口，不会在 receipt 前
杀掉见证者。它随后启动包内固定、尚不运行项目代码的 launcher；launcher
建立独占 session/process group 并停在 START barrier，supervisor 把其 pgid 与精确 identity 回报给
父进程持久化。START 后 launcher 才在同一 pgid 内启动目标，普通后代继续继承该组。正常路径只有
当组内除 launcher 外无成员且 pipes EOF 时才让 launcher 退出，再以负 pgid 探测整个组为空并发送
DRAINED。发送前 supervisor 使用 START 前缓存的 owner/protocol/active/baseline 摘要原子写并回读
POSIX drained receipt。父进程硬崩溃时 supervisor 对目标 pgid 执行 TERM→宽限→KILL，等待组消失并
写同一 receipt；supervisor
自己不在该组，因此能观察终点。若 supervisor 也被硬杀，已持久 pgid 继续阻断；pgid 被复用或成员
身份无法判断时保持隔离。

Windows 不再用 `taskkill /T` 证明整树退出。npm 包分发固定 PowerShell + 内联 C# P/Invoke
supervisor。它在回报可持久化 identity 前进入独立 process group，并调用
`SetConsoleCtrlHandler(NULL, TRUE)` 忽略且让后续 target 继承忽略 Ctrl+C；parent 仍是用户 Ctrl+C 的
唯一接收者，并通过 IPC 要求 supervisor 终止 Job。之后 supervisor 创建 Job Object，启用
`JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE` 且不允许 breakaway；
用 `PROC_THREAD_ATTRIBUTE_JOB_LIST` 在 `CreateProcessW` 时原子纳入 Job，并保持
`CREATE_SUSPENDED`，确认 `ActiveProcesses == 1` 后才回报 armed；父进程落盘后才
`ResumeThread`。恢复线程后立即关闭 thread handle；取得并缓存根结果后关闭 process handle，
然后才能等待 `ActiveProcesses == 0` 与 stdout/stderr EOF。固定 supervisor 在仍持有 Job handle
时使用 START 前缓存值原子写入 owner/protocol/operation/active/baseline/helper 摘要全绑定的
`drained-receipt.json`，父进程回读后 ACK，supervisor 才关闭 Job handle 并退出。跨平台 safety-only
receipt 是正常/父进程崩溃路径的集合清空与原始 safety bytes 证明；helper 除该安全文件外没有
workspace 写权。

若 supervisor 被硬杀，匿名 Job 的最后一个 handle 关闭会触发 KILL_ON_JOB_CLOSE，但终止是异步的，
后来的进程也无法重新查询已经消失的 Job。因而“supervisor/target pid 已死”或“KILL_ON_CLOSE 已
配置”都不是恢复证明。任一平台的 armed operation 没有精确有效 receipt 时，当前 safety bytes 与
原始 containment identity 均无法独立对账，即使同机重启也保持终态 isolated，只能改用新 workspace。

Windows 方案要求 Node 22 支持范围内的 Windows 10 / Server 2016+、同用户同 session 和可用的
FullLanguage `Add-Type`。Job、原子关联、查询或 Add-Type 任一步不可用时，真实命令零执行并返回
配置/隔离错误；不回退直接 spawn 或 taskkill。官方依据：
[Job Objects](https://learn.microsoft.com/en-us/windows/win32/procthread/job-objects)、
[原子 Job 列表属性](https://learn.microsoft.com/en-us/windows/win32/api/processthreadsapi/nf-processthreadsapi-updateprocthreadattribute)、
[KILL_ON_JOB_CLOSE](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_limit_information)、
[ActiveProcesses](https://learn.microsoft.com/en-us/windows/win32/api/winnt/ns-winnt-jobobject_basic_accounting_information)、
[控制事件处理](https://learn.microsoft.com/en-us/windows/console/setconsolectrlhandler) 与
[独立进程组](https://learn.microsoft.com/en-us/windows/win32/procthread/process-creation-flags#create_new_process_group)。

### 3. 根命令结果不等于调用完成

接受 START 并实际启动项目代码后的普通完成必须同时满足：

- 根命令结果已经取得；
- stdout/stderr 全部 EOF；
- containment 内没有剩余项目进程；
- POSIX 与 Windows supervisor 都使用 START 前缓存的 owner/protocol/active/baseline 摘要持久化并回读
  精确 drained receipt；
- POSIX 在 supervisor 退出后再次探测精确 pgid 为空，并与 receipt 对账；
- Windows 在 supervisor 仍持 Job handle 时确认 ActiveProcesses 为零后写 receipt，随后 supervisor
  才退出；不声称能在匿名 Job 消失后重新查询它。

prepared/prepared-bound 的 setup failure、能力失败或首个用户中断走上一节 abort-before-start，不要求
不存在的 drained receipt；armed 但 supervisor 明确从未接受 START 时使用 never-started receipt。两类
路径都必须原子 settle 整个 operation，不能删 active 文件假装调用从未发生。

根命令即使 exit 0，只要仍有后代，结果也不得记为普通 passed/completed。若剩余进程清理成功，
该调用产出 `process-tree-not-empty`，并按下文各 operation 的唯一退出语义裁决；随后可以回到
owned-idle 并写有界失败证据；
若清理无法确认则 quarantine，且不补写普通 evidence/report。

根结果出现后先给自然收口固定 5 秒：期间持续等待 pipes EOF 与 containment 为空，提前满足就采用
根结果。期限后仍有成员才判 leftover；POSIX 再给 TERM 5 秒、KILL 后确认 5 秒，Windows 终止 Job
后确认最多 5 秒。三段预算独立于项目命令 timeout，并计入调用 duration；timeout、signal 和父进程
断链不等待自然收口，直接进入终止。测试用事件 barrier 命中每个边界，不靠固定 sleep 猜结果。

因此 0.34.0 不再允许 Agent 通过 `nohup ... &` 留下跨轮 dev server。Agent 可以在本轮临时启动
服务，但返回前必须关闭；用户在 coding-x 之外预先启动、且不属于本次 containment 的服务仍可
复用。若未来需要跨轮服务，必须另行设计引擎拥有、可诊断、可收口的服务生命周期，不能让进程
静默逃逸。

### 4. 信号与异常统一由运行生命周期收口

锁模块不再安装“删锁后 `process.exit`”的 handler。运行生命周期统一处理 POSIX 的 SIGINT/SIGTERM、
Windows 终端 Ctrl+C 产生的 SIGINT、正常返回和可捕获异常：

1. 停止启动新 operation 和父进程普通写入；
2. 在内存进入 terminating；
3. 终止并确认当前 containment；
4. 完成返回后 delta 校验，并把完整 operation 原子移入 settled；
5. 只有不存在 uncommitted mutation、quarantine、recovery 且 owner 仍安全时才走普通释放；
   recovery 必须使用自己的 finalization，其他情况保留完整 active lease；
6. 再退出。

POSIX 首个 SIGINT/SIGTERM 无论收口成功与否仍使用 130/143；Windows 首个真实终端 Ctrl+C/SIGINT
使用 130。Windows 不支持把 SIGTERM 作为可捕获的用户信号；`process.kill(..., 'SIGTERM')` 或
TerminateProcess 会无条件终止目标，必须按 hard-crash 恢复合同处理，不能用 coordinator 注入测试
冒充真实信号。内部 timeout 或 termination adapter 失败返回 2。第二次受支持信号、kill -9 或 Windows
强制终止允许进程立即消失，但正常控制流不得先删锁。同步 exit hook 只能尽力终止，不能把“已发
kill”当成“已确认退出”。平台边界以 [Node.js signal events](https://nodejs.org/api/process.html#signal-events)
为准。

首个受支持用户中断若发生在 mutation 内，只允许当前原子步骤到达边界，随后保留 mutation + active
lease、不继续前向步骤也不 release；POSIX 按来源返回 130/143，Windows Ctrl+C 返回 130，之后只能
exact resume。没有用户中断的内部 mutation 错误返回 2。mutation 已 committed 时可按 owner-checked
release 后返回同一中断码，但这只适用于没有 recovery 的普通 owner。`recovery-active` 在最终 lease
rename 前收到中断时，即使 mutation 刚到 committed，也必须在当前原子边界保留 recovery + active
lease 并返回同一中断码；后续 exact resume 继续 final manifest→finalizing→整 lease rename，绝不能
旁路为普通 release。若中断与最终 rename 串行后发现 rename 已成功，则 workspace 已 ready，旧 owner
不再写任何字节，只返回中断码。第二次受支持中断或平台强制终止保持 OS 行为。

### 5. 正式写入口统一接线

所有引擎侧 workspace 写函数必须接收 owner-aware `WorkspaceSession/WorkspaceWriter`，不得只接收
裸 workspace/path。以下入口进入同一种写域：

- `run` 及其自动报告、Final Review、state/evidence/PRD guard/Validator IPC；
- `repair` 与手动 `report`；
- `coding-x workspace apply-prd --workspace <dir>`；
- `coding-x workspace record-review-decision --workspace <dir>`；
- `coding-x workspace recover|resume-mutation --workspace <dir>`；
- 后续新增的任何 workspace 写命令。

自动 report/Final Review 借用 run 的 session，不重入获取。手动 report/repair 获取短租约。
`prd-to-json` 在租约外只做资料发现、用户确认与候选生成；真实 TDD baseline 命令移入
`workspace apply-prd`，在租约及 coordinator 内重跑。源 PRD 若由 skill 修改，apply-prd 必须绑定
其精确字节摘要、Git HEAD、质量契约和候选摘要；获取不到租约时 workspace 零写入。
`/review-loop` 只收集决定，最终调用 `record-review-decision` 重新核对 HEAD、Review 与 Issue。

`--workspace` 是所有这些命令共享的唯一全局路径输入，位置可在子命令前后；CLI 只解析一次并把
canonical realpath 与目录身份传到底层，skills 不得硬编码 `.workspace` 或再次拼接。相对路径、
绝对路径和指向同目录的 symlink alias 必须落到同一租约身份。`coding-x init` 使用同一底层
`workspace init` 完成默认新 workspace 初始化；额外 workspace 由用户显式调用该嵌套命令。

多文件 apply-prd/repair 在首次业务写前，把严格 mutation state、完整 input 与 manifest 放入唯一
staging 目录，回读后一次原子安装为固定 mutation；只有完整 staged 状态才授权业务写。每一步按
固定 phase 幂等执行；未到 committed 不允许 release，committed 后也不逐项清元数据，而是随整个
active lease 原子移出。崩溃后普通 recover 不得清除它，只能由同一命令使用精确 input digest 续做，
直到得到完整目标状态。首版只实现这两类固定状态机，不建立通用事务框架。

只读 status/doctor/dashboard 不获取租约。手动 report 一旦要落盘就不再属于只读。质量 init 写
`.coding-x/`、GitHub workflow 和项目模板，不属于 workspace 租约。

### 6. 恢复是可证明的状态转换

doctor 将观察状态归一为：

- `uninitialized-empty`：空目录且无安全标记，只允许显式 bootstrap；
- `ready`：永久协议根与初始化标记有效，且没有 active lease；
- `active`：合法 owner 活着；磁盘细分 idle/prepared/prepared-bound/armed，armed 覆盖“可能正在运行”；
- `recoverable`：owner 已死、必要 baseline/mutation 输入有效，且 prepared 未授权路径已过握手期限或
  精确 containment 已确认为空；delegated delta 或 mutation 仍可等待 recovery domain 内裁决；
- `isolated`：containment 活着/未知、armed 可能运行、异机记录、quarantine、输入不足或终止未确认；
- `invalid`：锁/活动/mutation 记录损坏、错绑或未知 schema；
- `legacy`：旧 pid-only 锁，无法证明没有旧孙进程；
- `recovering`：恢复 claim 正在执行或中断。

armed 只有在存在与精确 owner/protocol/operation、冻结 active/baseline 摘要和 helper 绑定的有效
跨平台 drained receipt 且 supervisor 已确认死亡时，才可进入 recoverable；POSIX 还要复核 receipt
中的 pgid 当前精确为空。armed 缺 receipt 时，即使 pid/pgid 已死或同机重启也保持终态 isolated。
初始 prepared 因 supervisor 尚未得到 workspace path/DATA，可在 owner dead 且握手期限已过
后恢复；prepared-bound 还要求持久 supervisor identity exact dead。两者都因 START 尚未授权而不
要求 containment drained proof。只要 active-child 曾进入 armed，containment 清空且 baseline/scope
严格有效只让它进入 `recoverable/delegated-delta-pending`；恢复还必须在取得 recovery domain 后执行
和正常路径相同的 semantic delta。baseline 缺失、损坏或无法重算即 invalid，不能仅凭 containment
已空回到 ready。

恢复不是一个可被后来者覆盖的 owner 字段。活动 lease 使用固定 `engine.lock/lease/recovery/`，其中包含
不可变 `claim.json`、阶段 `state.json`、当前尝试的
`lease/owner.json` 与废弃尝试目录。固定目录存在就阻断普通 writer。恢复者先原子取得 attempt
lease；旧 lease owner 为 alive/unknown 时拒绝，为 dead 时先把整个 lease 目录原子移动到按摘要
命名的 abandoned 目录，再把完整 staged lease 原子安装到固定路径。只有唯一赢家能继续，恢复者
在 lease 转移中再次崩溃也不会解除固定阻断。

所有验证与 manifest 都在固定路径仍被占用时完成。恢复以原子 rename 整个 `engine.lock/lease/` 到
incident archive 为最后一个 workspace 动作，永久协议根继续 fence 旧 CLI。phase 只到
`finalizing`，不写不可实现的 rename 后
`archived` 状态；
final manifest 显式排除可随恢复者更替的 recovery attempt lease/attempts，因而 finalizing 后旧恢复者
崩溃仍可由新 attempt 复核同一 manifest 并完成 rename。`verified` 后先原子写并回读 manifest，再把
其摘要写入 `finalizing`；若崩溃在两步之间，新 attempt 只能在重算结果完全相同时补写 finalizing，
不能覆盖冲突 manifest。固定 active lease 消失且目标 archive 的 manifest/摘要匹配就是完成事实。
claim、state 或 attempt lease 损坏时保留
原始字节并归类 invalid，只能在新的空 workspace 重新初始化/派生，不能覆盖字段或无条件 force。

机械恢复只接受确切空 containment。损坏、异机或身份 unknown 不允许用“我确认了”直接变 ready。
新版 owner 已持久化原 host/boot identity；同一主机重启后，操作系统保证旧进程集合不再存在，
`workspace recover` 可在 host 相同、boot identity 已变化、锁与 workspace identity 仍严格有效时建立
reboot-proof claim。它只处理 `containment-unconfirmed`：存在 armed operation 时必须已有完整有效的
cached-digest receipt，reboot 只能补 supervisor dead/identity 结论；`operation-proof-missing` 与
`workspace-integrity-violation` 永不因此恢复。无需在未知后代仍可能写业务文件时预写第二个 recovery
domain。异机记录必须回原主机处理；缺少可靠 boot identity 时继续隔离，不提供无条件 `--force`。

只要固定 mutation 存在，attempt lease winner 就以 mutation-resume 进入 recovery-active；只有 mode、
claim、原 mutation 及 staged input 摘要完全匹配时，RecoveryWriter 才能按 plannedPaths 前向续做。
未完成 phase 续到 committed；已经 committed 的 phase 零业务写，重核 input、archive 与最终 snapshot
后直接收口。mutation 元数据不逐项删除，随整个 active lease 原子移入 archive。不能仅归档锁后把
半份 workspace 宣称 ready。

dead owner 若停在 owned-idle 且没有 operation/mutation/quarantine，可走 mechanical-empty：恢复只
重核安全 schema、owner 与活动不存在后归档 active lease；普通业务文件继续由既有 guard/repair
fail-closed，不要求凭空存在 delegated baseline。prepared/prepared-bound 则必须用已经持久化的 baseline
证明业务字节完全未变；armed 必须走 delegated-finalize，不能混用这条 idle 分支。

首次不存在 workspace 时，唯一无租约副作用是幂等创建空目录。`coding-x init` 或显式
`coding-x workspace init` 随后解析 canonical path 与目录身份；竞争者在唯一临时目录中完整 staging
`engine.lock/protocol.json`、固定 `incidents/` 父目录与 bootstrap lease，再以原子 rename 安装永久
协议根，只有一个赢家。
赢家进入 bootstrap-owned，只能在 lease 内 staging，再原子安装并回读 `workspace-safety.json`；标记
与 protocol 相互绑定后原子移出 lease，协议根保留，才得到 ready。失败或崩溃保留 lease。若 owner
与空目录前提仍严格有效，显式恢复只能补全确定性标记并移出 lease。无标记非空且不存在合法
bootstrap 协议根的目录、以及任何 0.33 runtime 文件，一律 legacy，拒绝迁移并引导新空 workspace。
两个初始化者只有一个能安装协议根；败者零业务写入，发现失败后不再修改自己的未授权 staging。

### 7. 平台身份与未知语义

- Linux：使用 boot ID 与 `/proc/<pid>/stat` start time；
- Windows：使用 `GetProcessTimes` creation FILETIME，并同时使用 Job/target/supervisor 状态；
- macOS：使用 boot session identity 与可取得的进程启动信息；若精度不足以排除同秒 PID 复用，
  相等只判 unknown，不判安全死亡；
- 主机身份使用有界哈希，不保存原始机器标识；任一平台来源不可用都返回 unknown。

这些身份用于避免误杀和误恢复，不是认证。availability 可以因保守 unknown 下降，但不能退回
pid-only 自动接管。

### 8. 原子启用而非半套上线

内部锁、coordinator、Windows helper、恢复解析器和破坏性测试可以先以 dark implementation 合并，
但不得只切换 run 后把 report/prd-to-json/review-loop 留作旁路。正式启用必须在同一个产品 PR
完成：

- 所有生产 spawn 迁移；
- 所有 workspace 写入口迁移；
- doctor/recovery 与 mutation resume 可用；
- Builder 后台服务合同同步改变；
- Linux、macOS、Windows 真实回归已绿色。

启用前 architecture/README 继续诚实描述 0.33.3，不能用已合并但未接线的模块宣称 P1 已关闭。

## 退出语义

- 第二写者、租约丢失、隔离、恢复未完成、containment 能力不可用或终止无法确认：2；
- 根命令正常非零且 containment 清空：沿用该调用原有 failed/error 语义；
- 根命令成功但遗留后代、清理成功：固定产出 `process-tree-not-empty`，不自动重跑同一 invocation。
  Builder/Validator 丢弃本次结果并进入既有有界下一轮，耗尽后 story 以 3 阻断；机械检查和
  apply-prd baseline 以 1 失败，apply-prd 不开始业务 mutation；Final Review 轴为 unverifiable，
  整体以 5 返回；其他独立命令以 1 返回；
- delegated delta 越界、非法结构或安全记录被 child 改动：2 并保留 quarantine/invalid，不重试；若
  同时由受支持用户中断触发，POSIX 进程码仍为 130/143、Windows Ctrl+C 为 130，但 quarantine 优先于
  清理/release；
- POSIX SIGINT/SIGTERM：130/143；Windows 终端 Ctrl+C/SIGINT：130；失败收口或 uncommitted mutation
  保留 active lease；Windows 外部 SIGTERM/TerminateProcess 归 hard crash，不宣称优雅收口；
- recovery-active 在最终 lease rename 前收到中断：即使 mutation committed 也保留 recovery + lease，
  不走普通 release；exact resume 完成 finalization；
- 无用户中断的 mutation 内部失败：2，直到精确 resume 完成；第二次受支持中断或平台强制终止沿用
  OS 行为。

## 信任边界

`ownerId` 是并发身份，不是秘密或签名。coding-x、Agent 和用户仍以同一操作系统身份运行；恶意
同权限进程可以篡改本地文件或绕开公开入口。本决策消除正常控制流、诚实子进程、崩溃恢复和诚实
并发中的双写与迟到释放，不声称建立密码学隔离或 GitHub 证明。

Windows Job Object 和 POSIX process group 都不覆盖项目代码主动使用平台逃逸机制创建的进程；
检测到或无法确认时保留隔离。项目命令合同禁止这种逃逸。

## 被取代范围

本决策在原子启用 PR 合并时取代 ADR-008 的 pid-only stale 自动接管、轮首删锁重建和 signal
先删锁，也修正 ADR-009/016 对 completed/error 与根进程返回的过宽表述。ADR-014 中 report 不
持锁、`prd-to-json` 双 doctor 尽力避让同时被取代；报告信任来源和损坏 state 语义不变。

在实施完成前，ADR-008/014 仍描述 0.33.3 的真实运行行为；本文件是已批准但尚未启用的 0.34.0
目标合同。

## 明确不做

- 不建立 GitHub、跨主机分布式锁或中央质量平台。
- 不引入数据库、常驻 daemon、TUI 或 Node ABI native addon。
- 不自动杀身份无法核对的 pid，不把手删锁包装成安全恢复。
- 不保存完整命令、prompt、模型输出、环境变量或秘密到安全记录。
- 不允许 Agent 留下未登记的跨轮后台服务。
- 不借此改造三层 Review 内容、npm 发布或 Issue #91 的干净检出。
- 不承诺掉电、内核崩溃或存储设备故障下的落盘持久性；本合同的 atomic 指进程崩溃可见性，不代表
  fsync durability。重启 proof 只证明旧进程集合消失，不能证明未持久化业务字节完整。
