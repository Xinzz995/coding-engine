---
title: 工作区写安全与子进程隔离实施计划
status: active
updated: 2026-07-30
scope: root
---

# 工作区写安全与子进程隔离实施计划

## 目标与边界

本计划落实 Issue #106 与 ADR-021。它只解决 0.34.0 协议内的 owner domain、受管 containment、
中断收口、显式恢复和正式 workspace 写入口统一，不混入 Issue #107、Issue #90 剩余展示绑定或
Issue #91 干净检出。

0.33.3 继续按旧行为描述，不能用已批准设计或 dark implementation 宣称当前版本完成隔离。新版
也不能事后 fencing 已经运行且丢失旧锁的 0.33.x；正式保证从新 workspace 的 0.34.0 安全初始化
开始。coding-engine 切换时使用新的 workspace，并先确认所有 0.33.x 写命令全部停止。永久目录只能
持续挡住旧 run/repair；旧 report 等无锁入口仍属于明确禁止的协议外访问。

## 交付拆分

### PR 1：设计合同与事实修正

- 提交本计划、设计规格和 ADR-021。
- 修正 ADR-008/009/014/016、architecture、patterns 与 README 的当前事实。
- 冻结永久 protocol root/active lease、bootstrap/普通/recovery writer domain、delegated baseline、
  POSIX launcher、Windows Job Object 与 frozen-armed receipt、恢复 attempt lease、mutation resume、
  旧版本切换前提和后台服务裁决。
- 只做文档健康、链接、格式和独立三轴 Review，不混入运行时代码。

完成信号：状态机、平台 containment、旧锁边界、全部正式写入口、退出码、恢复和反例矩阵均无未
裁决项。

### PR 2：dark foundation 与三平台证明

本 PR 的代码不接入公开 run/repair/report，也不生成新版初始化标记：

- 严格解析 workspace safety、owner、activity、recovery、mutation 与 quarantine；
- 实现显式 bootstrap、永久 protocol root + owner-safe active lease、WorkspaceSession/Writer、
  delegated baseline/delta evaluator、coordinator 和
  supervisor IPC 状态机；
- POSIX 用组外 supervisor + START barrier launcher 建立独占目标 pgid；Windows 分发由固定源码
  确定性重建且逐字节核验的 C# Job Object EXE，使用 JOB_LIST 原子纳管、CREATE_SUSPENDED、
  CREATE_NO_WINDOW、KILL_ON_CLOSE 与
  ActiveProcesses；两个平台的 supervisor 都在 START 前缓存 owner/protocol/active/baseline 摘要，并在
  集合清空后写 owner-bound drained receipt；
- Windows 路径与 process-only 身份检查使用另一份固定源码、确定性重建且逐字节核验的 C# EXE，
  直接调用原生属性、目录枚举与进程 creation FILETIME API；热路径不依赖 PowerShell 或旧版 managed
  路径枚举，host/boot/current owner 的组合快照仍使用系统 PowerShell/CIM；
- 实现新版 lock recovery、同机 reboot-proof、attempt lease 单赢家、recovery-of-recovery 和 exact
  mutation resume 的内部能力；legacy workspace 只阻断并引导新 workspace，不实现迁移；
- 先跑 Linux、macOS、Windows 真实破坏性回归，再允许后续产品接线。

必须先红的测试：

- 旧 handle 删除/重建新 owner；
- owned-idle 在每个 parent 原子业务写边界 hard kill，mechanical-empty 不要求虚构 baseline；
- prepared→bound→DATA→armed→START 每个崩溃窗口；
- prepared/prepared-bound 每个 setup/capability failure 与首个用户中断都证明项目零执行、baseline
  unchanged、supervisor 从未建立或 exact dead，并以 prestart-abort 整体 settle；不生成 drained receipt，
  不确定则 quarantine；
- DATA 后、canonical armed 前崩溃必须零 receipt，并由 baseline unchanged + supervisor dead 恢复；
- START 重复、迟到、错 operation/digest；
- target 穷举继承 fd/handle，不能持有 parent/supervisor 控制通道；
- root exit 0 但 grandchild 延迟写；
- parent hard kill 后跨平台 receipt 正确绑定并允许安全恢复；
- supervisor 在 receipt 前 hard kill 时三平台终态隔离/新 workspace；receipt 后 hard kill 可精确续做；
- child 改写 active-child/owner identity 后 parent hard kill，receipt/current bytes 冲突必须 invalid，旧
  grandchild 仍活时绝不能 recoverable；
- POSIX receipt/pgid/EOF 错绑，以及 Windows handle 关闭顺序、receipt 错绑、固定 EXE 摘要/
  确定性重建/Job/Query/Terminate 失败；
- recovery 与 normal acquire 双赢、recovery 自己崩溃；
- 两个 resume 同时接管 dead lease；
- operation baseline + prepared 整体安装，以及 settle 前后每个 hard-kill 窗口；
- manifest 写后、finalizing 写前崩溃只能补记相同 digest，冲突必须 invalid；
- finalizing 后旧 lease owner 崩溃，新 attempt 不改 manifest 即可完成 rename；
- apply-prd/repair 每个 mutation phase、archive mid-copy/manifest-before-rename、目标临时文件与二次
  recovery crash 在三平台真文件运行；
- committed mutation 元数据随整个 active lease 原子移出，禁止逐文件清理窗口；
- mutation state + input 整体 staging/安装，首次安装任一 hard-kill 不得留下 canonical 半状态；
- mutation 每个 phase 收到 POSIX 首个 SIGINT/SIGTERM 或 Windows 真实 Ctrl+C，都在原子边界保留
  lease；POSIX 返回 130/143、Windows 返回 130，内部失败为 2；
- Windows 使用真实 CTRL_C_EVENT 验证优雅收口；SIGTERM/TerminateProcess 按 hard crash 验证，禁止
  用 coordinator 注入冒充系统信号；
- POSIX supervisor 独立 session/process group、Windows supervisor 以 detached 新进程组且不连接控制台；
  三平台真实终端中断都断言 parent 收到、supervisor 存活至平台 receipt、目标 containment 已空；
- recovery-active 在 mutation committed 后、final manifest 前、manifest 后、finalizing 后与最终
  lease rename 竞态中收到中断：rename 前一律保留 recovery+lease 并 exact resume，rename 后旧 owner
  零写，任何路径都不走 ordinary release；
- PID/PGID 复用和损坏记录；
- 两进程首次创建空 workspace 与标记回读；
- bootstrap staging 部分写、protocol root 安装后、marker 安装后和 lease 移出前逐点 hard kill；
- ordinary lease staging 部分写与 canonical lease 安装后、handle 返回前 hard kill；
- ready workspace 重复 top-level init 只读成功，active/legacy/invalid init 零写失败；
- delegated child 越界后不得回 idle 或补普通 evidence；START 后 parent hard kill 仍须由 recovery
  使用持久 baseline 得到相同 quarantine/invalid。
- delegated child 在允许范围写后 parent hard kill，三平台 recovery 接受并 ready；保留未签发候选，
  但不生成普通 outcome/evidence/Validator 凭证；
- 同一 reboot proof 只在 armed receipt 已有效、仅欠 supervisor dead 时允许
  `containment-unconfirmed` 继续原裁决；永久拒绝 `operation-proof-missing` 与
  `workspace-integrity-violation`；
- writer 暂停在 temp commit 前时 release/signal/finally 必须等待；lease rename 成功、新 owner 获取后
  再恢复旧 callback，旧 owner 对 tombstone、staging 与 canonical 路径保持零写。

完成信号：dark API 与三个系统的真实 containment 证据绿色，但当前公开行为完全不变。

### PR 3：一次性产品启用

同一个 PR 完成全部接线，禁止出现“新 run + 旧旁路”的 main：

- Agent、普通 gate、TDD、Final Review 全部迁移到 coordinator；
- state/evidence/PRD guard/Validator IPC/report/repair 等父进程写入迁移到 WorkspaceWriter；
- START 前持久化 delegated child baseline/scope，并让正常路径和 recovery 使用同一 delta evaluator；
- 新增 `coding-x workspace init|apply-prd|record-review-decision|recover|resume-mutation`，
  所有入口透传同一全局 `--workspace`；
- `prd-to-json`、`/review-loop` 不再直接写 workspace；TDD baseline 在 apply-prd 租约内重跑；
- doctor/status/dashboard/report 展示唯一安全分类；
- Builder 指令删除跨轮 `nohup` 服务，要求本轮启动、本轮关闭；
- 正式启用 `workspace-safety.json`，缺少标记或旧 workspace 时失败关闭；
- 所有三平台破坏性任务再次以生产入口运行。

完成信号：任一正式入口不能绕过 owner domain；root 成功但遗留后代不能假绿；recovery 和 mutation
中断都有可执行出路；0.34.0 行为文档与代码一致。

### PR 4：真实 Dogfood 与关闭

- 在 coding-engine 新 workspace 运行正式闭环；
- 候选 tarball 在 Go 多模块与 Python Monorepo 以 `--shadow` 验证正常 workspace 行为；
- 保存三平台 Actions、旧 0.33.3 binary 兼容测试和破坏性场景链接；
- 对账 README、architecture、patterns、dogfood regression、CLI help 与退出码；
- 逐条回复 Issue #106 六项跟进证据，确认无同类 P0/P1 后关闭。

本 PR 不再补核心安全逻辑；若 Dogfood 发现安全缺口，回到独立修复 PR 并重跑生产入口矩阵。

## 稳态不变式

1. 没有有效初始化和 owner domain，不写 workspace。
2. owned-idle 只有 parent writer；START 后只有一个登记 child 按持久化 scope 委托写。
3. prepared/prepared-bound/armed 在磁盘持续阻断 parent 普通写；running/terminating 只作内存诊断，
   quarantine 独立持久化。
4. owner 不匹配，不删、不改、不自愈夺回。
5. root result、kill 请求和 taskkill 成功都不等于 containment 已空。
6. root exit 0 但仍有后代，原结果不得通过。
7. 根结果后的 5 秒自然 drain、TERM 5 秒与强杀确认 5 秒是独立收口预算并计入 duration；
   containment 无法确认时保留 lock/activity/quarantine。
8. recoverable 也不由普通 run 自动接管。
9. 未完成 mutation 只能 exact-input resume，不能直接清锁。
10. recovery rename 是最后一个 workspace 动作；之后只返回，不补元数据。
11. final manifest 只排除 recovery attempt lease/attempts；verified + manifest 崩溃可精确续做，
    finalizing 后恢复者更替不使归档摘要失效。
12. delegated baseline/scope 在 START 前持久化；parent 崩溃后仍执行同一 delta，越界进入
    quarantine/invalid，不回 idle，不猜测回滚。
13. committed mutation 元数据不逐项清理，随整个 active lease 原子移出。
14. lease→tombstone 是旧 owner 最后一次 workspace 写；失败竞争者不清 staging，历史清理由后来持有
    active lease 的 current owner 完成。
15. operation 和 mutation 都先整体 staging 再原子安装；operation 也整体 settle，不逐文件清状态。
16. 首个受支持用户中断按来源返回：POSIX SIGINT/SIGTERM 为 130/143，Windows Ctrl+C 为 130；
    uncommitted mutation 保留 active lease，内部 mutation 失败才返回 2。
17. 本地记录不升级成外部可信证明。

## 实现顺序

1. 先实现严格 schema、纯状态分类和平台 identity probe。
2. 再实现 uninitialized-empty→bootstrap-owned→ready、永久 protocol root/active lease、owner handle
   与 late-handle 反测。
3. 实现 operation 整体 staging（baseline/scope + prepared）→原子安装→spawn→supervisor identity
   persist/readback→DATA→ARMED frozen/readback→单次 START→DRAINED→operation 整体 settle 协议及
   故障注入。
4. 实现 POSIX 组外 supervisor/launcher 与 Windows Job helper，并让两者都写 cached-digest receipt；
   先让 root-exit/grandchild 场景在三平台通过。
5. 实现 mutation state/input 整体 staging/安装、active lease 内的 recovery claim/attempt lease、
   verified→manifest→finalizing 崩溃续做、基于旧 owner 记录的同机 reboot-proof 和 RecoveryWriter
   mutation resume。
6. 实现 WorkspaceSession/Writer，并把 delegated delta evaluator 同时接到正常收口和 recovery。
7. 最后一次性迁移生产 spawn、父写入、skills、doctor 和 Builder 服务合同。
8. 删除旧 signal unlink、stale takeover、taskkill proof 和双 doctor 直写说明。

任何一步发现新的生产 workspace write/spawn 入口，先补回设计清单和失败回归，不能用“调用方应该
先检查”保留旁路。

## 代码范围预估

- `src/engine/lock.ts`：只保留旧实现到 activation；新版拆为 safety evaluator 与 owner lease；
- 新增 workspace session/writer、operation coordinator、supervisor protocol、platform identity；
- 固定 POSIX supervisor 与 Windows 预编译 C# Job helper；
- `agent.ts`、`gate.ts`、`tdd-gate.ts`、review runner：统一受管 spawn；
- loop/preflight/state/evidence/guard/validation protocol/report/repair：传递 session/writer；
- CLI、doctor、status/dashboard：嵌套 workspace init/apply/decision/recover 与安全分类；
- `skills/prd-to-json/SKILL.md`、`commands/review-loop.md`、Builder/Validator 指令：删除直写旁路与后台
  服务逃逸，透传用户选择的同一 `--workspace`；
- 单元、两进程 barrier、真实进程树、旧 binary、三平台 CI 与 secret canary。

dark foundation 不得被 production import；静态边界测试在 activation 前后分别守住“未接线”和
“无旧入口”。

## 兼容与发布

- 新版初始化标记只用于新 workspace；不为任意旧项目设计自动迁移。
- `coding-x init --workspace <dir>` 对默认或自定义目录调用同一 bootstrap 内核；项目已经初始化后，
  可用 `coding-x workspace init --workspace <dir>` 只增加一个明确的新 runtime workspace。无标记非空
  workspace 永久按 legacy 阻断。
- coding-engine 使用新的 workspace 切换，quality contract 仍由稳定 0.33.3 Policy PR 更新到
  0.34.0；切换前停止所有 0.33.x 写命令。
- 永久 lock directory 只持续阻断尚未持锁的新启动 0.33.3 run/repair；冻结 binary 必须在三平台实际
  验证 ready/active acquire/verify/release，并以旧 report 成功写入反测诚实保留无锁入口边界。
- Windows 要求 Windows 10 / Server 2016+ 与 .NET Framework 4.6+；能力不足时项目代码零
  执行、退出 2，不回退运行时编译或 taskkill。固定 EXE 由锁定 SDK/引用程序集在不同目录重复构建，
  并与仓库及 npm 产物逐字节核验；现有真机证据只覆盖 x64，ARM64 保持未验证。任一平台 armed
  operation 的 supervisor hard crash 若未留下精确
  drained receipt，即使同机重启也保持终态 isolated 并改用新 workspace；reboot proof 只处理完整安全
  记录允许继续裁决的 containment 不确定态。存在 armed operation 时，receipt 必须已经有效，reboot
  只能补 supervisor dead/identity 结论；不存在 armed operation 时按对应的 mechanical-empty 路径裁决。
- POSIX/macOS identity 精度不足时允许保守 unknown，不能降级 PID-only。
- Agent 本轮启动的 dev server 不再跨轮；外部用户服务仍可复用。
- 0.34.0 候选按既有 staged release 流程；只有需要 npm 2FA 时暂停交用户。

## 验证命令

每个 PR 至少运行：

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
node dist/cli.js --help
```

PR 2 与 PR 3 还必须保存 Linux、macOS、Windows 的真实任务链接。Windows mock taskkill、macOS 本机
单测或复制旧算法都不能替代对应真机合同。旧 0.33.3 兼容必须执行冻结的实际 package/binary。

## 黄金原则对照

1. **可证伪合同**：正常 exit 的遗留孙进程是第一反例；每项绑定明确 marker/状态。
2. **独立裁决**：Agent/项目命令不签发释放；coordinator 和平台集合事实决定。
3. **防线与可逆性**：终止失败保留隔离；恢复移动原字节；未知需 reboot proof。
4. **原生与中立**：Node/OS process group/Windows Job；无 runner 专有核心状态。
5. **假绿与恢复**：先做三平台破坏性测试、双恢复与 mutation 中断，再接生产路径。

## 关闭条件

只有以下条件全部成立才关闭 Issue #106：

- 四个 PR 均通过旧稳定版规则审查并合并；
- 生产入口在三个系统完成 root-exit、timeout、平台真实中断、parent/supervisor crash 回归；Windows
  真实中断只承诺 Ctrl+C/SIGINT，SIGTERM/TerminateProcess 属于 hard crash；
- Windows 先关闭目标 thread/process handle，再以 Job ActiveProcesses 归零和绑定 receipt 证明，
  不使用 taskkill 或“pid 已死”代替；
- run、repair、report、apply-prd、review decision 代表性并发均被拒绝且零越界写；
- bootstrap 双初始化只有一个标记写者；所有嵌套命令的自定义 workspace/symlink alias 指向同一租约；
- bootstrap 与普通 lease 的部分 staging、canonical install、marker install、handle return 各 crash
  barrier 都有唯一续做结果；
- recovery attempt 单赢家、recovery-of-recovery 和 RecoveryWriter mutation resume 无手删出路；
- manifest-before-finalizing 和 committed-before-release 两个崩溃窗口均可唯一续做；
- delegated delta 越界后保持 quarantine/invalid，不回 idle、不补普通 evidence；parent hard kill 后恢复
  仍由持久 baseline 得到相同结论；
- delegated 合法 delta 在 parent hard kill 后可恢复 ready，且没有伪造普通结果或验收凭证；
- session in-flight writer 与 release 串行，lease rename 后旧 finally/signal/callback 的 workspace 写为零；
- reboot proof 只解除安全记录完整的 containment-unconfirmed；存在 armed operation 时还必须已有有效
  receipt。它永不解除 operation-proof-missing 或 workspace-integrity-violation；
- mutation 每个 phase 的首个受支持中断、内部失败与第二次中断分别得到来源对应码、2 与 OS 行为，
  且未提交状态从不 release；Windows 以真实 CTRL_C_EVENT 证明 130，不虚构 SIGTERM 143；
- recovery-active 即使 mutation committed，也只在 final rename 成功后成为 ready；此前用户中断保留
  recovery+lease 并由 exact resume 完成，不得走普通 release；
- 新 workspace 初始化成立，旧 0.33 正在运行的不可 fencing 边界被诚实保留；
- architecture、patterns、README、Builder 指令与实际代码一致；
- Issue #106 在 2026-08-06 前关闭，0.34.0 发布前无未处理同类 P0/P1。
