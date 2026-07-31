---
title: 工作区写安全与子进程隔离设计
status: active
updated: 2026-07-30
scope: root
---

# 工作区写安全与子进程隔离设计

## 目标与成立前提

关闭 Issue #106：在 0.34.0 协议内，任一 coding-x 对 canonical 安全路径或业务路径的修改都必须属于
当前 owner domain，且不得同时存在另一个未收口 owner domain。竞争者只可并发写各自唯一、路径
不相交、从不被解释为权限或业务状态的 inert staging；安装失败后不再删除，交由未来的当前 owner
在 creator exact dead 时清理。中断、超时、父进程崩溃、恢复崩溃和诚实并发都不得产生两个被
coding-x 认可的写者。

普通 owner domain 包含父引擎和同一时刻唯一登记的 delegated child；首次 bootstrap 与崩溃恢复则
各有互斥且范围更小的独立 writer domain。它不是“只有父进程能写”，也不是防御同一账号恶意篡改
的安全沙箱。Builder/Validator 现有直接写 workspace 的能力必须进入明确委托范围；项目检查和
Final Review 不得写 workspace。

保证从新版安全初始化完成后成立。新版无法追溯 fencing 已经运行、且旧 `engine.lock` 被删除的
0.33.x 进程。新项目直接初始化；coding-engine 使用新的 workspace 完成一次受控切换；旧项目不做
自动迁移。版本 pin 或 `workspace-safety.json` 不满足时，正式模式停止。

本设计跨项目语言和包管理器；coding-x 自身仍需要 Node 22。GitHub、AI Review 内容、npm 发布和
Issue #91 的干净检出不在本 Issue 内。

## 当前事实

0.33.3 的真实行为是：

1. `run/repair` 使用 pid-only 文件锁；`report` 不持锁；`prd-to-json` 只做两次 doctor；
   `/review-loop` 直接追加决定文件。
2. 锁损坏或 pid 已死会自动删除并接管；`verify()` 遇到缺失/不同锁时尝试重建，重建失败也不阻断
   当前循环。
3. 锁模块注册 SIGINT/SIGTERM 后先删锁再退出；Windows 实际可依赖的终端入口只有 Ctrl+C/SIGINT。
4. timeout 路径会尝试终止进程树；completed/error 和 parent hard crash 没有统一的集合收口证明。
5. Builder/Validator 在子进程运行时直接写指定 workspace 文件。
6. Builder 指令允许 `nohup` dev server 跨轮存活，与“调用结束时 containment 清空”冲突。
7. doctor 只能显示锁 pid，无法解释活动 containment、恢复 claim 或半完成 mutation。

推论：旧锁消失、根进程退出或 taskkill 成功都不能单独证明 workspace 已安全。

## 可证伪完成合同

| 验收标准                                                       | 明确失败信号                              | 验证证据                                            |
| -------------------------------------------------------------- | ----------------------------------------- | --------------------------------------------------- |
| 每次租约有唯一 owner，迟到 handle 不能改新 owner               | 旧 handle 能 rename/delete/重建后来者锁   | owner 置换与迟到 verify/release 单测                |
| 新启动 0.33.3 面对新版目录失败关闭                             | 旧 acquire 删除目录或继续进入             | 冻结的真实 0.33.3 acquire/verify/release 三路径测试 |
| 不宣称 fencing 已运行旧版                                      | 无初始化标记也能正式运行                  | 版本切换与初始化前置测试                            |
| 首次空 workspace 只有一个 bootstrap 赢家                       | 两个初始化者都写安全标记或业务文件        | 两真实进程 init barrier 与标记回读                  |
| prepared 早于 supervisor spawn，bound 早于 DATA                | 无身份 supervisor 已拿到 workspace/target | spawn/bind/DATA 间故障注入                          |
| 项目代码只在 armed 落盘后运行                                  | marker 在 armed 回读前出现                | DATA/ARMED/START 顺序测试                           |
| START 只能消费一次且绑定 operation                             | 重复/迟到/错 ID 仍执行目标                | IPC 状态机单测与真实 helper 测试                    |
| parent hard crash 会触发 supervisor 收口                       | 旧后代仍持续写 sentinel                   | parent kill + EOF cleanup 场景                      |
| root exit 0 但有孙进程不能通过                                 | 结果被记录为 passed/completed             | 正常退出残留孙进程回归                              |
| 只有确认 containment 空才清 activity                           | 第二 writer 进入后旧孙进程仍能写          | 新 owner 获取后再释放旧 child 写动作                |
| Windows 使用 Job Object，而非 taskkill 证明                    | 中间根退出后孤儿孙进程未被统计            | Windows Job ActiveProcesses 真实测试                |
| containment 不可用时项目代码零执行                             | 固定 EXE/Job/PGID 失败却直接 spawn        | capability 故障注入 + marker 反测                   |
| parent 与 delegated child 不并发写业务文件                     | START 后 parent 写 state/evidence         | writer phase 断言与字节不变测试                     |
| child 只能写声明范围                                           | 越界后回 idle 或继续写普通 evidence       | delta violation → quarantine/lease-lost 测试        |
| parent 崩溃不能绕过 child delta                                | drained 后不复核 baseline 就回 ready      | hard kill + recovery delta/quarantine 三平台测试    |
| Agent 不留下跨轮后台服务                                       | nohup 服务存活且调用仍成功                | dev server 残留回归与指令断言                       |
| run/repair/report/apply/review decision 共享排他边界           | 任意两正式入口同时写                      | 代表性两两并发测试                                  |
| recovery 与 normal acquire 不双赢                              | 两者同时获得业务写权                      | claim/mkdir/rename barrier 矩阵                     |
| recovery crash 可精确续做                                      | stale claim 只能手删或永久锁死            | 每个 recovery phase 的 resume 测试                  |
| 未知状态不能靠普通确认变 ready                                 | reason 字符串绕过 containment 证明        | corrupt/foreign/reboot-proof 测试                   |
| 半完成 mutation 不能被普通 recover 清掉                        | 部分新 PRD 被当完整基线                   | phase 故障注入 + exact-input resume                 |
| 未被选入 mutation/archive 的普通业务秘密不被安全元数据顺手复制 | secret canary 出现在 lock/claim/archive   | 全目录反向搜索                                      |
| 三个平台都验证真实树                                           | 只跑 mock 即宣称完成                      | Linux/macOS/Windows Actions 证据                    |

## 状态模型

### 用户可见分类

- `uninitialized-empty`：目录为空且没有安全标记，只允许显式 bootstrap。
- `ready`：永久 `engine.lock/protocol.json` 与初始化标记相互绑定，且没有 active lease。
- `active`：合法 owner 存活；磁盘子状态为 idle/prepared/prepared-bound/armed，armed 后的
  running/terminating 只在内存诊断或独立 quarantine 中表达。
- `recoverable`：旧 owner 已死、canonical 恢复输入有效，且已经证明项目代码未启动或 containment
  已空；delegated delta 或 mutation 仍可等待 recovery domain 内裁决，不等于 ready。
- `isolated`：containment 活着/unknown、终止未确认、异机、quarantine 或缺少可裁决输入。
- `invalid`：锁、活动、mutation 或 claim 损坏/错绑/未知 schema。
- `legacy`：旧 pid-only 锁；即使 pid 已死也不能证明没有后代。
- `recovering`：恢复 claim 正在执行或上次恢复中断。

每个磁盘观察态只映射到一个最高优先级分类：

1. 任一 canonical 安全 schema/绑定无效 → invalid；
2. 合法 `workspace-integrity-violation` 或 `operation-proof-missing` quarantine 存在 → isolated；
3. 永久协议根内严格有效的 recovery 存在 → recovering；
4. 合法 `containment-unconfirmed` quarantine 存在 → isolated；仅 strict reboot proof 可继续；
5. 合法 bootstrap protocol + lease 存在，即使 marker 尚未安装，也按 owner/containment 映射
   active/recoverable/isolated，不能误判 legacy；
6. 无合法 bootstrap 协议根且无标记，却存在运行时文件或 pid-only 锁 → legacy；
7. owner 不是本机 exact-live 时，普通 containment live/unknown、foreign host 或恢复输入不足 →
   isolated；本机 exact-live owner 仍属于 active，armed 期间存在 live containment 是正常执行态；
8. exact containment empty、owner dead 且 baseline/mutation 等所需输入严格有效 → recoverable；
9. exact owner live → active；该规则在 active lease 内优先于普通 containment 状态，但不能覆盖
   schema/绑定无效、quarantine 或 recovery；
10. 永久协议根与初始化标记有效、lease 不存在 → ready；
11. 无标记、无协议根且除严格 inert bootstrap staging 外目录为空 → uninitialized-empty。

`armed` 一律按“START 可能已发出”解释。平台 containment 已确认为空、持久化 baseline/scope
完整有效，且存在 supervisor 在 START 前缓存 frozen digest、集合清空后写出的跨平台 drained receipt
时，可进入带 `delegated-delta-pending` 原因的 recoverable；只有 recovery domain 内的同一 semantic
delta evaluator 通过后才可最终 ready。不能用人工歧义恢复跳过它。POSIX 还需持久 pgid 的精确空
结论，Windows 使用 Job-zero receipt；两者都要求 receipt 绑定当前 active-child/baseline/helper 且
supervisor exact dead。仅知道 pid/pgid dead、KILL_ON_CLOSE 或同机重启不够：armed 缺 receipt 时无法
独立证明 safety path 未被 child 改写，保持 terminal isolated 并引导新 workspace。初始 prepared 中 supervisor 未得到 workspace
path/DATA，owner dead 且握手期限已过即可恢复；prepared-bound 已持久化 supervisor identity，必须
再证明它 exact dead。两者都因 START 从未授权而不要求 drained receipt。

### owner domain

```text
uninitialized-empty
  └─ explicit init + atomic install persistent engine.lock/protocol + lease ─> bootstrap-owned(ownerId)

bootstrap-owned
  ├─ BootstrapWriter 原子写并回读 workspace-safety.json ─> ready-to-release
  └─ crash/failure ─> lock 保留；精确 recover 完成标记后回 ready

ready
  └─ complete staged lease + atomic rename(engine.lock/lease) ─> owned-idle(ownerId)

owned-idle
  ├─ parent WorkspaceWriter 写业务文件
  ├─ prepare operation ─> child-prepared
  ├─ begin mutation ─> mutation-active
  ├─ exact owner + no activity/mutation + rename(lease→tombstone) ─> ready
  └─ lock missing/different/corrupt ─> lease-lost

child-prepared
  ├─ signal-isolated supervisor identity persisted/readback ─> child-prepared-bound
  └─ supervisor never bound/exact dead + baseline unchanged + prestart abort + atomic settle ─> owned-idle

child-prepared-bound
  ├─ DATA + containment ready + persisted ─> child-armed
  └─ project zero-execution + prestart empty + supervisor dead + baseline unchanged
     + prestart abort + atomic settle ─> owned-idle

child-armed
  ├─ one START(operationId) ─> child-running（内存；磁盘 armed bytes 冻结）
  └─ bound never-started receipt + delta unchanged + atomic settle ─> owned-idle（调用未启动）

child-running
  ├─ delegated child 按 scope 写，parent 普通写暂停
  ├─ result + containment empty + delta accepted + atomic settle operation ─> owned-idle
  ├─ delta 越界/非法 ─> quarantined（不补普通 evidence）
  └─ timeout/signal/leftover ─> terminating

terminating
  ├─ containment empty + delta accepted + atomic settle operation ─> owned-idle（调用仍可失败）
  └─ cannot confirm ─> quarantined

recoverable / containment-isolated-with-strict-reboot-proof
  └─ atomic install recovery + attempt lease ─> recovery-active(recoveryId, attemptId)

recovery-active
  ├─ safety-only verify/manifest/finalize
  ├─ bootstrap-complete 时 BootstrapRecoveryWriter 只写缺失的安全标记
  ├─ delegated-finalize 时复核 delta；accepted 保留未签发候选，violation 终态隔离
  ├─ mutation-resume 未 committed 时 RecoveryWriter 仅写 plannedPaths；committed 时只重核
  ├─ crash ─> recovering（固定目录继续阻断）
  └─ final rename engine.lock/lease ─> ready
```

lease handle 一旦 released/lost 永久不可恢复。父进程写 API 与 coordinator 安全记录 API 分开：
前者只在 owned-idle，后者只改锁目录内的严格安全文件。BootstrapWriter 只能写安全标记；
RecoveryWriter 只在 mutation-resume attempt 内写 manifest 声明的路径。普通 owner 与 recovery attempt
不能并存为有效 writer domain。

### delegated scope

| operation         | workspace 允许变化                                                        | 返回后要求                                              |
| ----------------- | ------------------------------------------------------------------------- | ------------------------------------------------------- |
| Builder           | state 中当前 story 的候选字段、progress、screenshots、screenshot evidence | 引擎复核 Git/staged/state 不变式与文件 delta            |
| Validator         | 当前 request result、screenshots、screenshot evidence                     | 引擎验证 request/result 绑定；不得改 state/prd/progress |
| quality/TDD check | 无                                                                        | 任意 workspace 变化使检查结果不被采用                   |
| Final Review      | 无                                                                        | 只消费只读审查包；任意变化为 unverifiable               |

父进程在 child-running 时不能追加普通 evidence 或生成报告。调用结束、containment 清空、delta
核对后，父进程回到 owned-idle，才写 invocation/iteration/裁决。若 containment 不确定，预先写下
的 activity/quarantine 是唯一安全诊断。若 delta 越界或允许文件结构非法，coordinator 写
`workspace-integrity-violation` quarantine 后停止；child 若动过 lock/recovery 本身则直接
lease-lost/invalid，不能再写 quarantine。首版不自动回滚，后续只能从新空 workspace 重新派生。

## 文件合同

```text
.workspace/
  workspace-safety.json
  engine.lock.prepare-*/     # 首次初始化的非权威 staging；可选
  engine.lock/               # 初始化后永久存在，兼容 fence
    protocol.json
    incidents/               # 原子移入的 released/recovery 记录；永久父目录
    lease.prepare-*/         # 非权威 staging；可选
    lease/                   # active owner 时存在
      owner.json
      quarantine.json        # 无 operation 时的 containment 隔离；可选
      bootstrap-input/       # 初始化标记 staging 时可选
      operation.prepare-*/   # 非权威 staging；可选
      operation/             # active operation 时存在；整体安装/settle
        delegated-baseline.json
        active-child.json    # armed 后冻结并绑定 baseline
        prestart-abort.json  # prepared/bound owner-live 未启动收口；可选
        drained-receipt.json # armed operation 集合清空后的跨平台证明
        quarantine.json      # 可选；存在时禁止 settle/release
      settled-operations/    # 完整 operation 原子移入；非权威历史
      mutation.prepare-*/    # 非权威 staging；可选
      mutation/              # active mutation 时存在；整体安装
        state.json
        input/
      recovery/              # 新版恢复时可选
        claim.json
        state.json
        final-manifest.json  # finalizing 时存在
        lease/owner.json
        attempts/
```

### workspace-safety.json

```json
{
  "schemaVersion": 2,
  "initializedBy": "0.34.0",
  "workspaceIdentity": "sha256:...",
  "protocolDigest": "sha256:...",
  "initializedAt": "2026-07-30T00:00:00.000Z"
}
```

只有 `coding-x init` 或显式 `coding-x workspace init --workspace <dir>` 能走 bootstrap。它先确认目录
严格为空，再取得 bootstrap owner；BootstrapWriter 是标记写入的唯一权限。标记必须 owner-bound
原子写入并回读 workspace identity，之后才能释放 bootstrap lock。目录中已有 0.33 runtime 文件但
没有标记时按 legacy workspace 停止，不能补写标记冒充迁移，只能改用新的空 workspace。

### engine.lock/protocol.json

```json
{
  "schemaVersion": 1,
  "protocol": "coding-x-workspace-lease-v1",
  "workspaceIdentity": "sha256:...",
  "createdBy": "0.34.0",
  "createdAt": "2026-07-30T00:00:00.000Z"
}
```

`engine.lock/` 与 protocol 在成功初始化后永久保留；ready 不是删除目录，而是 `lease/` 不存在。
workspace-safety.protocolDigest 必须精确绑定 protocol 字节。目录型固定路径会让 0.33.3 run/repair 的
文件锁 acquire 持续失败，但 0.33.3 report 等历史无锁写入口仍能绕过，所以初始化后禁止运行任何
0.33.x 写命令是成立前提，不把兼容 fence 夸大成完整旧版本隔离。

### owner.json

```json
{
  "schemaVersion": 2,
  "ownerId": "uuid",
  "pid": 12345,
  "processIdentity": {
    "kind": "linux-boot-start",
    "value": "bounded-platform-value"
  },
  "bootIdentity": "sha256:...",
  "hostId": "sha256:...",
  "workspaceIdentity": "sha256:...",
  "startedAt": "2026-07-30T00:00:00.000Z",
  "command": "run"
}
```

`command` 固定枚举：`workspace-init | run | repair | report | apply-prd | review-decision`。恢复使用独立
attempt lease，不覆盖旧 owner.json。所有对象严格
逐字段解析；未知字段/schema、超长字符串、非枚举和 owner 错绑都失败关闭。

### operation/ 与 active-child.json

每次调用先在唯一 `operation.prepare-<operationId>/` 中完整写入 delegated baseline 与 state=prepared 的
active-child，回读相互摘要后原子 rename 为固定 `operation/`。只有这个 rename 让 operation 成为
canonical；rename 前崩溃只留下 inert staging，项目代码零执行。固定 operation 已存在时禁止启动
第二个调用。

共同字段：

```json
{
  "schemaVersion": 2,
  "ownerId": "uuid",
  "operationId": "uuid",
  "state": "armed",
  "kind": "builder",
  "delegation": "builder-v1",
  "platform": "windows-job-v1",
  "supervisorPid": 12346,
  "supervisorIdentity": "bounded-platform-value",
  "signalIsolation": "windows-new-process-group-ctrl-c-ignore-v1",
  "targetPid": 12347,
  "targetIdentity": "windows-filetime",
  "helperDigest": "sha256:...",
  "delegatedBaselineDigest": "sha256:...",
  "delegationContractDigest": "sha256:...",
  "startedAt": "2026-07-30T00:00:01.000Z",
  "updatedAt": "2026-07-30T00:00:01.020Z"
}
```

`prepared` 禁止 supervisor/target/signalIsolation 字段，但必须绑定已经回读的 delegated baseline 与
contract；`prepared-bound` 必须有 supervisor identity 与严格平台 signalIsolation 枚举，仍无
containment/target。只有 supervisor 完成信号域隔离、该记录落盘回读后才发送 DATA。POSIX armed 使用
`pgid`、supervisor identity
与处于 START barrier 的 launcher identity，target 尚未
START 时可无 target 字段。Windows
armed 必须包含已原子加入 Job、仍 suspended 的 target identity。armed 落盘回读后到 cleanup 前字节
保持不变；STARTED、root result、running 与 terminating 不回写该文件，receipt 始终绑定同一 frozen
armed digest。终止失败另写 quarantine，不改 active-child。

`kind` 与 `delegation` 固定枚举；label 只用内部受控 ID。不得记录 argv、prompt、stdout/stderr、
环境变量、模型认证或项目秘密。

containment empty 且 semantic delta accepted 后，不逐个删除 baseline、active-child 或 receipt，而是
把完整 `operation/` 原子 rename 到唯一
`settled-operations/<operationId>-<operationDigest>/`；这个 rename 是返回 owned-idle 的唯一 commit
point。随后 parent 才能写普通 outcome/evidence。崩溃在 rename 前仍由 recovery 复核完整 operation，
崩溃在 rename 后则 operation 已完整 settled，不存在 orphan baseline/receipt。settled 记录不授予权限，
随 active lease 最终移出；不得由已释放 owner 清理。存在 quarantine 时禁止 settle。

prepared/prepared-bound 的 setup/capability failure 或首个受支持用户中断使用
`prestart-abort.json`。它严格绑定 ownerId、operationId、active-child/baseline 摘要、受控 reason 与
`supervisor-never-bound-v1 | supervisor-prestart-empty-v1` proof，不保存 target/argv/输出。父进程只有
在项目代码机械零执行、业务 baseline 完全未变，并证明 supervisor 从未绑定或 prestart containment
已空且 supervisor exact dead 后才能写入并回读，再原子 settle 整个 operation；之后才允许写未启动
失败/中断结果。证明不完整则写 `containment-unconfirmed` quarantine 并保留 operation。armed 不用
此记录降级；只有 supervisor 的 `never-started-containment-empty-v1` receipt 能证明 START 未接受。

### delegated-baseline.json

父进程在写 prepared 前暂停普通业务写，生成并回读一份严格、排序、可重算的调用前 manifest。它
绑定 ownerId、operationId、固定 delegation contract 版本，并覆盖 workspace 中每个 canonical 业务
路径的类型、相对路径、字节数与 SHA-256。`workspace-safety.json`、整个 `engine.lock/` 协议子树和
本次 baseline 属于安全域，由 coordinator 以独立清单和预算严格验证，不计入业务 baseline，也不得被
delegation contract 授权为业务写入目标。其他普通 workspace 文件不能排除。symlink、reparse point、
特殊文件、路径逃逸、重复规范化路径或扫描期间发生字节变化均使项目代码零执行并返回 invalid。

manifest 同时保存允许新增、修改、删除的有界路径规则，以及 state/result/evidence 的语义校验版本。
对只允许部分字段变化的结构化文件，baseline 还保存由固定 evaluator 生成的“受保护字段 canonical
projection digest”；对 append-only 文件保存旧字节长度与 prefix digest；对只允许新增的目录保存旧
成员清单摘要。恢复时可从当前文件重算这些承诺，证明未获授权字段、旧前缀和旧成员没有变化，而不
需要旧文件正文。若一种委托无法用固定 projection/prefix/成员规则完整表达，项目代码零执行并返回
配置错误，不能只留整文件 hash 后依赖 parent 内存裁决。

baseline 不保存文件正文、prompt、argv 或凭据。这里的 secret canary 只证明未被 mutation input 或
archivePaths 选中的普通业务秘密不会被安全元数据顺手复制；调用方显式选择的 archive/input 本来就会
保存对应字节，不能把此证明扩大成“任意归档输入都不含秘密”。`active-child.json` 从 prepared 起绑定 baseline 与
contract 摘要，armed 后两者都不可修改。正常 parent 和 recovery 使用同一 evaluator 重扫 workspace：
prepared/prepared-bound 要求业务字节与 baseline 完全相同；armed 允许的 delta 还必须满足路径范围、
上述承诺与当前文件语义。无法读取、摘要冲突或 contract 版本不可用都不是“无变化”，而是 invalid。
恢复接受合法 delta 时仅把已有 child 输出保留为未签发候选，不补写普通成功/失败 evidence，也不把
对应 Story 视为已验证。

v1 evaluator 进一步冻结以下机械边界，避免正常路径与恢复路径各自解释：

- canonical contract 不超过 64 KiB、完整 baseline 文件不超过 64 MiB、最多 256 条 rule；每条最多
  3 个不重复 action、256 个 JSON pointer；version、path、pointer 分别不超过 128、4096、512 UTF-8
  bytes；业务树和安全树各自最多 100000 项，不能互相挤占预算；任一先达到的上限都失败关闭；
- ownerId/operationId 使用小写、带 RFC version/variant 的 canonical UUID；contract、rules、allow、
  pointers 与 entries 都使用唯一规范顺序，未知字段、重复值、重叠规则或摘要不匹配一律 invalid；
- JSON pointer 严格按 RFC 6901 解码，只允许 `~0`、`~1`，拒绝重复及祖先/后代重叠。对象 pointer
  允许既存父对象内的叶子新增、删除或改值，但父路径必须前后存在且类型不变；数组只允许既存索引
  的值替换，不允许新增、删除、`-` 或索引位移；
- `whole-file` 可以显式 create 缺失文件，但结果必须是普通文件；modify/delete 的原对象必须是普通
  文件。`append-only + allow[modify]` 必须从既存普通文件开始；
  `append-only + allow[create,modify]` 可以在缺失时首次创建，若起点已存在则仍只能追加，不能替换、
  截短或删除。`json-mutable-pointers` 必须从既存普通文件开始且只允许 modify；
  `add-only-directory` 必须从既存普通目录开始且只允许 create，所有旧成员递归保持不变；
- 文件访问保留 raw name，记录与匹配使用 NFC path；同一树内 NFC 冲突一律 invalid，macOS/Windows
  还按固定“先大写、再小写、再 NFC”的 casefold 保守拒绝冲突。symlink、reparse point、特殊文件和
  路径逃逸都不进入 baseline；
- Windows 不能只依赖 Node 的 `lstat` 判断 reparse point。每个高层操作在开始前和结束后，以固定、
  摘要绑定、严格 UTF-8 的批量系统属性检查器核验完整父链和对应扫描树；任何
  `FILE_ATTRIBUTE_REPARSE_POINT`、属性读取失败、结果缺失或检查器变化都失败关闭。单文件读取继续
  使用原有 no-follow 文件身份与内容稳定性复核，不为每个叶子单独启动检查器；
- 每次 capture/evaluate 都执行两次完整扫描；路径集合、类型、文件身份、长度、时间或摘要任一变化
  立即 invalid，不重试或合并。append prefix 必须通过同一 no-follow 普通文件句柄读完并在前后复核
  路径与文件身份；JSON 必须是严格 UTF-8、无 BOM、无重复 key 的合法 JSON。

### drained-receipt.json

```json
{
  "schemaVersion": 1,
  "ownerId": "uuid",
  "operationId": "uuid",
  "ownerRecordDigest": "sha256:...",
  "protocolDigest": "sha256:...",
  "activeChildDigest": "sha256:...",
  "delegatedBaselineDigest": "sha256:...",
  "delegationContractDigest": "sha256:...",
  "containmentDigest": "sha256:...",
  "helperDigest": "sha256:...",
  "supervisorIdentity": "bounded-platform-value",
  "proof": "windows-job-zero-and-pipes-eof-v1",
  "drainReason": "natural",
  "drainedAt": "2026-07-30T00:00:03.000Z"
}
```

包内固定 POSIX/Windows supervisor 是 safety-only 特例：它可在父进程写权暂停或父进程已崩溃时，
原子安装这一份文件，但不能写任何业务 state/evidence/report。supervisor 在接受 START 前必须重读
canonical active-child/baseline、验证 START digest 并把两份摘要缓存在内存；drain 后使用缓存值写
receipt；同时缓存 owner.json 与 protocol.json 精确摘要，绝不在 child 可能改写后从磁盘重建“原始
摘要”。POSIX 只有在 pipes EOF、launcher 退出且
目标 pgid 精确为空时写 `posix-group-empty-and-pipes-eof-v1`；Windows 自然结束路径必须已缓存根
结果，随后关闭 thread/process handle；外部终止路径允许没有 STARTED/RESULT，但同样必须关闭目标
handle，并在仍持有 Job handle 时确认 `ActiveProcesses == 0` 与 pipes EOF，才写
`windows-job-zero-and-pipes-eof-v1`。若 supervisor 从未接受 START，项目代码机械上未运行；canonical
active-child 已是严格 armed 时，它可以安全重读摘要、清空 barrier/suspended containment，并写
`never-started-containment-empty-v1`；磁盘仍是 prepared-bound 时不写 receipt。`proof` 只允许这三个
枚举。receipt 用不替换既有文件的原子安装；预先存在、错 issuer 或摘要冲突都失败关闭。正常路径由
parent 回读绑定后 ACK；supervisor 随后退出，parent 确认其死亡、delta accepted 后才整体 settle
operation，不逐项清 active 与 receipt。
父进程崩溃路径由 supervisor 完成同一写入后退出，留给 recovery 使用。

`drainReason` 固定为
`natural | process-tree-not-empty | timeout | user-interrupt | parent-shutdown`，是 receipt 精确字节及
摘要的一部分。`process-tree-not-empty` 只能由 supervisor 在自然收口窗口结束后根据平台集合测量得出；
parent 不能通过 TERMINATE 自报。IPC 的 DRAINED 只携带 `operationId + receiptDigest + proof`，不复制
reason 或 `leftover`，避免出现两个可分叉的裁决来源。

receipt 必须和当前 owner record、protocol、operation、active-child、delegated baseline 的精确字节
摘要、固定 helper 及 supervisor identity 完全匹配。缺失、部分写入、旧 operation、helper 不匹配、当前 safety bytes 与
缓存摘要冲突或 supervisor 尚活都不是恢复证明。armed supervisor 被硬杀而未留下有效 receipt 时，
即使 pgid/pid 已死或同机已经重启也不能恢复该 workspace；这避免 child 改写 containment identity 后
让 recovery 误判旧写者已空。

### quarantine.json

quarantine 严格绑定 ownerId、可选 operationId、冻结 active-child/baseline digest、创建者身份、时间与
固定 reason 枚举，只允许：

```json
{
  "schemaVersion": 1,
  "ownerId": "uuid",
  "operationId": "uuid-or-null",
  "activeChildDigest": "sha256-or-null",
  "delegatedBaselineDigest": "sha256-or-null",
  "creator": {
    "kind": "owner-or-recovery-attempt",
    "id": "uuid",
    "recordDigest": "sha256:..."
  },
  "reason": "containment-unconfirmed",
  "priorQuarantineDigest": null,
  "createdAt": "2026-07-30T00:05:00.000Z"
}
```

有 operation 时，`operationId` 与两份冻结摘要必须同时存在，文件位于 `operation/quarantine.json`；
没有 operation 的 containment 失败使用 active lease 根的 `quarantine.json`，三项同时为 `null`。
`creator.recordDigest` 绑定精确 owner 或 recovery attempt owner 记录，不复制机器原始身份。初次安装
不得替换已有文件；唯一允许的覆盖是 recovery 将 `containment-unconfirmed` 单向升级为
`workspace-integrity-violation`，新记录必须保持同一冻结绑定并以 `priorQuarantineDigest` 绑定旧字节。

- `containment-unconfirmed`：终止、探测或平台证明无法确认；业务字节尚未裁决。它在严格同机 reboot
  proof 后才允许安装 recovery claim；若有 armed operation，必须已经存在完整 cached-digest receipt，
  只欠 supervisor dead/identity 结论，之后仍执行 delegated-finalize；
- `operation-proof-missing`：armed operation 缺失或错绑 cached-digest receipt。它与重启无关，属于
  终态 isolated，只能改用新的空 workspace；
- `workspace-integrity-violation`：delta 越界、允许文件语义非法或 child 改动 safety path。它是终态
  isolated，只能改用新的空 workspace，reboot proof 不得绕过。

安全 schema/owner 绑定损坏直接归 invalid，不用 quarantine 掩盖。recovery 若从前一种原因出发又发现
delta violation，只能原子升级为后一种，并绑定 prior quarantine digest；随后停止且不移动 active
lease。状态优先级固定为：invalid → integrity/proof-missing quarantine → valid recovery →
containment quarantine → 其余状态，因此 strict reboot proof 建立 recovery 后可以裁决纯 containment
问题，却永远不能越过 integrity violation 或补造缺失 receipt。quarantine 不保存完整命令、输出或
秘密。

### recovery claim、state 与 attempt lease

磁盘上的进程身份、owner/attempt 存活、supervisor 存活与 containment 状态都是操作系统裁判事实。
这条边界从 `bootstrapWorkspace` 与 `acquireWorkspaceLease` 开始：正式入口不得接收 identity 或系统
authority，必须在模块内捕获精确当前身份；返回的 lease handle 由模块私有能力创建，并永久携带同一
身份复核器。不存在可供普通生产调用方读取 owner 后重新 attach 的入口。正式 recovery 的
install/acquire/finalize/resume 同样不得接收调用方提供的 identity、liveness probe、containment probe
或自定义 authority；它们必须在每个权限相关写入及最终 rename 前重新核对同一
pid/host/boot/process identity。确定性测试所需的伪身份只开放在名称明确的
`workspace-authority-test-seam` 与 `recovery-authority-test-seam`，production 与未来 CLI activation
禁止导入这些 seam 或直接调用 Controlled core。同机重启 coordinator 是唯一受控内部例外：它仍从
真实系统 boot change 与精确 quarantine 建立 authority，并在最终写入前重复核对，不能退化为
fixture probe。

`claim.json` 一旦安装便不可变：

```json
{
  "schemaVersion": 1,
  "recoveryId": "uuid",
  "sourceKind": "new-lock",
  "sourceSnapshotDigest": "sha256:...",
  "mode": "mechanical-empty",
  "targetArchive": "engine.lock/incidents/recovery-...",
  "rebootProof": null,
  "createdAt": "2026-07-30T00:10:00.000Z"
}
```

`state.json` 示例：

```json
{
  "schemaVersion": 1,
  "recoveryId": "uuid",
  "claimDigest": "sha256:...",
  "phase": "verified",
  "expectedMutationPhase": "applying",
  "expectedMutationDigest": "sha256:...",
  "finalManifestDigest": null,
  "updatedAt": "2026-07-30T00:10:02.000Z"
}
```

`sourceKind` 首版只允许 `new-lock`。初始 source 摘要只覆盖 active lease 中 recovery 之外的 canonical
`owner/operation/settled-operations/mutation/bootstrap-input`；显式
排除 `recovery.prepare-*`、已安装 recovery、recovery attempt/attempts 与安全临时文件，因此并发
staging 或 staging crash 不改变冻结输入，也不取得权限。`mode` 为
`mechanical-empty | delegated-finalize | bootstrap-complete | mutation-resume`；同机重启只作为 claim
中可选、严格验证的 containment 证明，不取代业务恢复 mode。`state.json` 绑定
recoveryId 与 claim digest，phase 为 `claimed | verified | finalizing`。
不存在 `archived` phase：写 finalizing 后，原子 rename 固定目录是最后一个 workspace 动作；固定路径
消失且目标 archive 的 manifest 与摘要匹配就是完成事实。

`final-manifest.json` 覆盖安全标记摘要、claim digest、`statePhase=finalizing` 和所有 canonical source /
mutation 目标；显式排除它自身、state 中的 manifestDigest、`recovery/lease/`、`recovery/attempts/`、
prepared staging 与临时文件，避免新 recovery owner 的合法接管让终态摘要变旧。`state.json` 保存
finalManifestDigest；archive 验证要求 state.phase、该 digest 与 manifest 内容三者互相匹配。recovery
attempt lease/attempts 仍逐文件严格解析并参与 secret canary，但不决定“业务与 containment 是否
已经安全归档”。

finalize 的落盘顺序固定为：先保持 `phase=verified`，用临时文件 + 原子 rename 安装并回读完整 manifest；
再原子覆盖 state 为 `phase=finalizing` 并绑定 manifest digest；最后同时回读二者才可移动 active lease。
`verified + 无 manifest` 可重算并创建；`verified + 精确相同 manifest` 表示崩溃在 state 更新前，可补写
finalizing；`verified + 冲突/损坏 manifest`、`finalizing + 缺失/冲突 manifest` 均为 invalid，不能覆盖
“修好”。这样 manifest 写后、state 写前与 state 写后、rename 前两个窗口都有唯一续做结果。

`lease/owner.json` 记录 attemptId、recoveryId、pid、process/boot/host identity 与开始时间。尝试目录
先在 `attempts/prepared-<attemptId>/` 完整写入和回读，再以不替换现有非空目录的原子 rename 竞争
成为 `lease/`，避免 mkdir 后崩溃留下半份 owner。已有 lease owner 为 alive/unknown 时拒绝；为 dead
时先把整个 lease 原子 rename 到 `attempts/abandoned-<leaseDigest>/`。多个恢复者只有一个能移动旧
lease，也只有一个能安装新 lease；崩溃在两步之间时固定 recovery 目录仍持续阻断普通 writer。

`recovery/` 在既有 engine.lock 已阻断普通 writer 时，从同目录内完整临时目录原子安装；安装后立即
重核冻结 source 摘要。claim、state、lease 或摘要损坏一律 invalid，保留所有原始字节；系统不覆盖
它们自愈，也不提供 force，只允许改用新的空 workspace 重新初始化/派生。

`sourceSnapshotDigest` 只证明 claim 安装时的起点，不要求 mutation-resume 前进后仍逐字节等于起点。
mutation 模式每一步只能落在 `mutation/state.json` + input manifest 定义的有限中间态；recovery state 保存
最近已确认的 mutation phase 与 expected digest。崩溃后，当前业务字节必须精确匹配“上一步完整”
或“下一幂等步骤已完整生效”之一，才能回读/补记并前进；任何不能由该状态机解释的差异才是
source conflict/invalid。机械恢复和 bootstrap-complete 不允许改 canonical mutation 来源。

### mutation/

```json
{
  "schemaVersion": 1,
  "ownerId": "uuid",
  "mutationId": "uuid",
  "kind": "apply-prd-v1",
  "inputDigest": "sha256:...",
  "baseSnapshotDigest": "sha256:...",
  "phase": "staged",
  "plannedPaths": ["prd.json", "state.json", "progress.md"],
  "startedAt": "2026-07-30T00:20:00.000Z"
}
```

`phase` 为 `staged | archiving | applying | committed`。上述对象保存为 `mutation/state.json`；完整、
已校验的目标字节和固定删除清单放在 `mutation/input/`，不含环境/认证。首次业务写前，owner 在唯一
`mutation.prepare-<mutationId>/` 中完整写入 state、input 与 input manifest，回读后原子 rename 为固定
`mutation/`。rename 前的 staging 不授权业务写；rename 后只会观察到完整 staged mutation，避免 orphan
input 或 state。archive 目标由 mutationId 决定；旧快照先复制到唯一 staging
目录、逐文件校验并写 manifest，完整后才原子 rename 为最终 archive。最终路径已存在时只接受完整
manifest/逐字节相同；半份 staging 不是最终 archive，可由 RecoveryWriter 按 mutationId 保留取证并
新建 attempt staging。目标原子覆盖、删除均幂等，每步重读摘要。committed 前不能 release；崩溃后
只允许 exact-input resume，普通 recover 不得清除。

`kind` 首版固定为 `apply-prd-v1 | repair-v1 | generic-v1`：前两项保留未来正式调用入口的真实目的，
`generic-v1` 仅供 dark implementation 与破坏性测试使用。通用 mutation 核心只执行调用方显式提供的
有限 writes、deletes 与 archivePaths，不替 apply-prd/repair 决定要归档哪些业务文件；该策略仍留给
后续公开接线裁决。generic-v1 的 canary 只能证明“未选入的普通业务秘密不被安全元数据额外复制”，
不能证明任意 archivePaths 都不含秘密。后续 apply-prd/repair 必须各自冻结允许路径，并对真实固定
路径执行独立 canary；本 PR 不选择路径或保留时长。

v1 的 plannedPaths/archivePaths 一律拒绝永久协议根、安全标记、路径逃逸、软链接、硬链接与内部
staging 名称。业务写的父目录必须已经存在；目录创建尚未进入 manifest 状态机，因此不能隐式创建。
目标文件的完整候选先写入 canonical `mutation/apply/` 内的有界 prepared 文件，校验后再形成固定
apply staging 并原子替换业务目标；hard crash 不会在业务目录留下 manifest 外的临时文件。

所有安全 JSON 用 owner-aware 原子覆盖；临时名含 ownerId/单调序号并用 `wx`。这保证本合同覆盖的
进程崩溃窗口得到完整旧版、完整新版或保守 invalid；不额外声称掉电、内核崩溃或存储故障下的 fsync
持久性。reboot proof 只证明旧进程集合已经消失，不证明未持久化业务字节完整；发生此类故障后的
业务数据恢复属于备份/文件系统职责，观察到任何缺失或错绑安全记录仍必须 fail-closed。

## 获取与释放

### 首次目录

唯一允许的无租约写是幂等创建一个空 workspace 目录。只有 `coding-x init` 或显式
`coding-x workspace init` 能继续 bootstrap：

1. 解析全局 `--workspace`，realpath/lstat 并取得目录身份；
2. 拒绝 symlink/path identity 在过程中变化，确认除严格的 inert bootstrap staging 外为空；
3. 每个竞争者在唯一 `engine.lock.prepare-<bootstrapId>/` 内完整写入 protocol、空的固定
   `incidents/` 父目录与非空 bootstrap lease，回读后原子 rename 为固定 `engine.lock/`；只有一个能
   安装永久根并取得 bootstrap-owned，其余 staging 没有业务写权；
4. 赢家再核目录身份、protocol、owner 与空目录前提；
5. BootstrapWriter 在 lease 内 `bootstrap-input/` 完整 staging 并回读，以同文件系统原子 rename 安装
   根目录 `workspace-safety.json`，回读 schema、版本和 workspace identity；
6. 只有 marker.protocolDigest 与 protocol 完整匹配，才 owner-check rename lease 到 incident/tombstone，
   永久 protocol 根不动，得到 ready。

两个初始化者只有安装 protocol 根的赢家能写标记，败者零业务写入且在发现失败后不再修改自己的
staging。staging 不构成 owner/legacy，由 doctor 报告；未来已经取得 canonical lease 的当前 owner
才可在 creator exact dead 时归档它。任一 bootstrap 故障保留 lease；若 recovery
证明这是合法 bootstrap owner、未有项目代码或业务 mutation，BootstrapRecoveryWriter 用 owner 中
已回读的 workspace identity 补全缺失标记，再归档 lease 回到 ready。半份/损坏 canonical 标记为
invalid，不能覆盖自愈。无标记但存在 prd/state/archive 等
运行时内容一律 legacy，0.34.0 不提供迁移或 reboot 恢复，直接引导新的空 workspace。

init/重复 init 的 workspace 部分固定如下，并且发生在 `.coding-x`、workflow 或远端规则写入之前：

| 观察态              | `coding-x init` / `workspace init` 行为                                   | workspace 结果 |
| ------------------- | ------------------------------------------------------------------------- | -------------- |
| 目录不存在/严格为空 | 创建空目录并竞争 bootstrap；唯一赢家安装标记                              | 成功为 0/ready |
| ready               | 只读回核 marker、canonical path 与目录 identity，不取锁、不改字节         | 0/ready        |
| active/recovering   | 不等待、不接管，整个 init 在任何项目/远端写入前停止                       | 2/零写         |
| recoverable         | 指向带精确 mode/reason 的显式 recover/resume，不自动执行                  | 2/零写         |
| isolated            | 报告精确原因；仅合格 containment quarantine 可凭 strict reboot proof 继续 | 2/零写         |
| legacy/invalid      | 指向新空 workspace，不补标记、不迁移                                      | 2/零写         |

同一路径首次 init 成功后，可为 GitHub 分阶段配置重复运行 top-level init；workspace 步骤只做上述 ready
回核。自定义路径在 `coding-x init --workspace <dir>` 与 runtime-only `coding-x workspace init` 中语义
相同。

### 普通获取

正式命令先要求 protocol/安全标记绑定有效，再运行唯一 `evaluateWorkspaceSafety()`。无 lease 时，
竞争者各自在 `engine.lock/lease.prepare-<ownerId>/` 完整写入非空 lease 并回读，再原子 rename 到固定
`lease/`；合法目标始终非空，已有 lease 或 recovery 时绝不替换、删除或循环接管。失去竞争者停止且
不再删除自己的 staging，避免与赢家并发写；未来 current owner 可在 creator exact dead 时清理。
`recoverable` 要求显式 recover，普通 run 不接管。空/部分 canonical lease 为 invalid；严格未授权
staging 被 source digest 排除且没有写权。legacy pid-only lock 或无标记非空 workspace 始终拒绝并
引导新 workspace。

### owner-checked 释放

同一 owner 内也不能靠 ownerId 检查避免竞态。WorkspaceSession 为全部 parent business write、operation /
mutation 转移、signal 收口、recovery action 与 release 提供同一个排他串行器。每个 writer action 在
创建 temp 前和原子 commit 前都验证 handle；release 先同步把 session 从 open 切为 closing，拒绝新
action，再等待已经进入串行器的 action 完成，最后在独占区重核磁盘 owner/phase 并移动 lease。signal /
finally 只能请求这条 close 路径，不能旁路 rename。这样暂停在“temp 已写、尚未 commit”的旧写必须
先完成或随进程崩溃留下 active lease，绝不会在 lease 释放、新 owner 进入后再提交业务文件。

1. handle 未 lost/released，workspace identity 未变；
2. `engine.lock/lease/owner.json` 严格有效且 ownerId 匹配；
3. 固定 `operation/` 不存在、无 quarantine/recovery，`mutation/` 不存在或 state=committed；
4. rename 整个 `engine.lock/lease/` 为 owner 专属 incident/tombstone，committed mutation 元数据随行；
5. handle 永久 released；
6. 立即返回，旧 owner 不再写任何 workspace 字节。

永久 protocol 根不删除。旧 handle 看到新 lease owner、lease 缺失/损坏或 identity 变化只进入 lost，
绝不 rename/unlink。released tombstone 和 inert staging 仅可由后来已经取得 active lease 的当前 owner
在 owned-idle、creator exact dead 且不影响 canonical 分类时尽力清理；清理中崩溃仍保留 active lease，
不会与下一 owner 并发。

## supervisor 协议

### 通用消息

| 方向              | 消息                           | 前置                               | 后置                     |
| ----------------- | ------------------------------ | ---------------------------------- | ------------------------ |
| supervisor→parent | BOUND(identity,isolation)      | supervisor 已隔离终端信号          | parent 可持久化 bound    |
| parent→supervisor | DATA(operationId, target)      | prepared-bound 已落盘并回读        | 仅内存校验，不运行       |
| supervisor→parent | READY/ARMED                    | containment 已建，项目代码不可运行 | 返回有界身份             |
| parent→supervisor | START(operationId,digest)      | armed 已原子落盘并回读             | 重读同 digest 后一次接受 |
| parent→supervisor | ABORT_BEFORE_START             | canonical 仍为 prepared-bound      | 项目代码保持零执行       |
| supervisor→parent | PRESTART_DRAINED               | prestart containment 空且 pipe EOF | parent 等其退出并核基线  |
| supervisor→parent | STARTED                        | 项目代码已启动/恢复                | 仅内存诊断               |
| supervisor→parent | RESULT                         | 根结果已得，集合可能未空           | 不等于完成               |
| parent→supervisor | TERMINATE(operationId,reason)  | canonical armed；timeout/中断/断链 | 与 START 首到者获胜      |
| supervisor→parent | DRAINED(receiptDigest,proof)   | 集合空、pipe EOF、receipt 已回读   | parent ack 后退出        |
| parent→supervisor | ACK(operationId,receiptDigest) | DRAINED 与持久 receipt 已回读      | supervisor 可退出/关 Job |

START 必须携带 frozen active-child digest；supervisor 在运行/恢复 target 前从 canonical operation 重读并
验证 owner、operation、containment 与该 digest。任一断链、重复、错 ID 或错 digest 都停止新启动。
`TERMINATE.reason` 固定为 `timeout | user-interrupt | parent-shutdown`，不携带自由命令、PID、
信号名或平台参数；POSIX 与 Windows 使用同一通用消息。canonical armed 后 START 与 TERMINATE 以
supervisor 首次接受的消息为准：TERMINATE 先到时项目代码永不启动，迟到的同 operation、同冻结绑定
START 只返回未接受，不改变终态；START 先到时项目代码已经可能运行，TERMINATE 直接清空集合。
首个合法 TERMINATE reason 冻结，之后同 operation 的合法 TERMINATE 幂等且不能改写原因。自然窗口
结束后仍有成员由 supervisor 自己测得并写入 receipt 的 `process-tree-not-empty`，不再由 parent 发送
TERMINATE 代替；清理成功也不能采用原 exit 0 为通过。

parent 先暂停普通写，原子写并回读 delegated baseline，再写绑定其摘要的 prepared；随后启动一个
尚不知道 workspace path/target 的 supervisor。取得 pid 与平台 identity 后写 prepared-bound 并回读，
且只有 BOUND 已证明下述平台信号隔离后才允许发送 DATA。这样 parent 若死在 spawn→bound 窗口，未知
supervisor 既不能启动项目，也不能写 workspace，握手超时后无需猜它的 pid；bound 之后的恢复则有
精确 supervisor identity 可要求 dead。若 parent 死在 DATA 后、canonical armed 前，supervisor 终止仍
被 barrier/suspended 的 containment 并退出，绝不写缺少 armed digest 的 receipt；磁盘仍是
prepared-bound，baseline unchanged + supervisor exact dead 是唯一恢复依据。若 canonical armed 已存在，
supervisor 才可重读其 digest，并在清空 containment 后按平台合同写 receipt。bound 前 supervisor 使用
包内固定入口、package-owned 中立 cwd 与最小环境，不读取项目配置、hooks、默认 `.workspace` 或
runner 插件。

owner-live 的 spawn/DATA/capability failure 或用户中断若发生在 prepared，必须先确认 supervisor 从未
BOUND 或已 exact dead；发生在 prepared-bound，则发送 ABORT_BEFORE_START/关闭控制通道，等待
PRESTART_DRAINED、supervisor exact dead 并重算 baseline unchanged。随后按 prestart-abort 合同整体
settle；任一环节 unknown 就 quarantine，不把无 receipt 误报成 armed completion。

parent→supervisor 控制 fd/handle 只属于两端，不出现在 launcher/target 的继承表；launcher 的 START
控制通道也不传给项目 target。POSIX 对非必要 fd 设置 close-on-exec 并显式声明 stdio，Windows 使用
最小 HANDLE_LIST。stdout/stderr 是单独的有意继承数据管道。测试让 target 枚举并长期持有所有实际
继承描述符，确认 parent hard kill 仍立即令 supervisor 收到 EOF，而不是被后代伪装成“parent 仍在”。

### POSIX

- Node supervisor 使用独立 session/process group，且在发送 BOUND 前安装不会退出的 SIGINT/SIGTERM
  handler；它只根据 parent IPC 的 TERMINATE/ABORT_BEFORE_START 或 EOF 收口，先等待 DATA；
- supervisor 启动包内固定 launcher；launcher 建立独占 session/process group，回报 identity 后停在
  START barrier，尚未 spawn 项目 target；
- parent 把 launcher pid/identity/pgid 持久化为 armed 并回读，START 携带 frozen digest；supervisor
  重读 active/baseline、缓存摘要后，launcher 才在同一 pgid 内 spawn target，普通后代继续继承；
- root 结束且 pipes EOF 后，supervisor 用 Linux `/proc` 或 macOS 平台 adapter 枚举精确 pgid；只剩
  launcher 时命令 launcher 退出，再用负 pgid probe 证明整个组不存在，使用 START 前缓存摘要原子写
  POSIX drained receipt，回读后才发送 DRAINED；
- parent IPC EOF 后 supervisor 只经仍与原 ChildProcess IPC 绑定的固定 launcher 发送内部
  `SIGNAL_GROUP(TERM|KILL)`；launcher 在自身进程内向自己的 process group 发信号，从而在系统调用前
  排除 PID/PGID 复用，再按 TERM→宽限→KILL 等待组不存在。该内部消息拒绝 caller 提供 PID 或任意
  signal；若曾接受 START，
  使用缓存摘要写同一 receipt；若未接受 START 但 canonical armed 有效，写 never-started receipt；仍是
  prepared-bound 则零 receipt。因为 supervisor 不在目标组，KILL 不会同时消灭见证者；
- timeout、用户中断或 parent EOF 的终止路径不要求先收到 STARTED/RESULT；launcher IPC、身份、
  session 或 pgid 任一不匹配时停止并隔离；
- parent ACK 后 supervisor 正常退出，parent 再 probe 持久 pgid。pgid 存在表示有残留，结果不得通过；
- pgid 复用或成员身份无法判定时 unknown/quarantine，不误杀。

终端 Ctrl+C 或对 parent pid 的 SIGTERM 不能命中 supervisor/launcher/target 的控制路径；parent 先记录
用户中断，再通过 IPC 请求收口。真实集成测试必须在 armed 后发送终端信号，证明 parent 返回来源码、
supervisor 存活至 receipt 落盘、目标 pgid 为空，而不是只调用 coordinator 方法。

### Windows

包内携带由固定源码确定性构建的 `.NET Framework 4.6` C# EXE。parent 直接以 `detached: true`、
`windowsHide: true`、`shell: false` 和三条 pipe 启动它；运行时不再调用 PowerShell 或编译源码：

1. supervisor 通过继承的标准 pipe 建立严格 UTF-8 输入输出，验证自身 EXE 摘要后才发送 BOUND；
   detached 新进程组不连接 parent 控制台，parent 是用户 Ctrl+C 的唯一接收者；
2. CreateJobObject；
3. SetInformationJobObject(KILL_ON_JOB_CLOSE)，不设置 breakaway；
4. 解析完整 executable；`.cmd/.bat` 通过受测的 `cmd.exe` 规则；
5. STARTUPINFOEX 同时传 JOB_LIST 与最小 HANDLE_LIST；
6. CreateProcessW 使用 EXTENDED_STARTUPINFO_PRESENT、UNICODE_ENVIRONMENT、CREATE_SUSPENDED 与
   CREATE_NO_WINDOW；
7. Query Job，确认 ActiveProcesses == 1，回报 target FILETIME identity；
8. parent 持久化 armed 并发送 frozen digest；supervisor 重读 active/baseline、缓存摘要后才
   ResumeThread；
9. ResumeThread 成功且不再需要 thread handle 后立即 CloseHandle(hThread)；
10. 自然结束时先缓存根 exit code，再 CloseHandle(hProcess)；外部终止允许尚无根结果，也必须关闭
    hProcess，随后查询 ActiveProcesses；
11. 正常完成或 TerminateJobObject 后都等待 ActiveProcesses == 0 与 stdout/stderr EOF；
12. supervisor 在仍持有 Job handle 时原子写、回读 drained receipt，再发送 DRAINED；
13. parent 验证 receipt 并 ACK 后，supervisor 才关闭 Job handle 并退出。

Windows 原生检查另带一份由固定源码确定性构建的 `.NET Framework 4.6` C# EXE。Node 直接启动
并核对固定摘要；helper 通过 GetFileAttributesW 与 FindFirstFileW/FindNextFileW 流式读取系统属性、
规范名称和有界目录树，也通过 OpenProcess、GetProcessTimes 与前后两次零等待存活检查读取进程
creation FILETIME。路径和进程热路径都不经过 PowerShell、运行时编译或旧版 managed 路径枚举；
进程读取另有小于 supervisor 5 秒 handshake 的 3 秒硬上限。输入输出和失败阶段都采用有界协议，
任何摘要、请求绑定、路径、进程存活、重解析点、枚举完整性或关闭句柄无法确认都按不可验证阻断。

parent IPC EOF 时 supervisor 主动 TerminateJobObject。canonical active-child 仍是 prepared-bound 时，
它按 9-10 归零后直接退出且不写 receipt；若曾接受 START，按 9-11 使用缓存摘要写 receipt；若从未
接受 START 但 canonical armed 严格有效，则安全重读并写 never-started receipt。随后退出，不等 ACK。
若 supervisor 自身被硬杀，KILL_ON_JOB_CLOSE 只能触发异步终止，无法给后来的进程留下可查询
Job；没有 receipt 就保持 isolated，不以 supervisor/target pid dead 代替。终止路径也必须先缓存
已经取得的根结果；即使 STARTED/RESULT 尚未出现也要关闭 hProcess，再等待 ActiveProcesses 归零，
避免 supervisor 自己的 handle 让计数无法收敛。

固定 EXE 缺失、损坏、摘要错误或不可执行，以及外层 Job 不兼容、原子 Job 关联失败、查询失败或
handle 继承不明时，target 保持未运行/被终止，返回 2。绝不回退运行时编译，也不以 `taskkill`
成功代替 Job 归零。EXE 由固定 SDK、锁定引用程序集和同一组源码在两个不同绝对路径下重建，先证明
两次输出逐字节一致，再与仓库及 npm 包内字节比较。CI 的真机证据覆盖 x64 Windows；AnyCPU 只说明
二进制格式兼容，不把 ARM64 宣称为已验证。helper 摘要绑定实际 EXE 字节，但包安装目录仍是可信
边界，不声称能防御同一账号在读取后、启动前主动替换可执行文件。

真实 Windows Ctrl+C 测试在 parent 所在 console 中发出 CTRL_C_EVENT：parent 必须进入 130 收口，
detached supervisor 不连接该 console，target 也以 CREATE_NO_WINDOW 启动；supervisor 只在收到
parent IPC 后终止 Job、
确认 ActiveProcesses=0、写 receipt 再退出。若信号发生在 BOUND/armed 前则走 prestart-abort；不能用
测试内直接调用 coordinator 代替这个系统事件。

### 进程身份

- Linux：`/proc/sys/kernel/random/boot_id` + `/proc/<pid>/stat` starttime；
- Windows：process-only 热路径通过固定摘要的原生检查器读取 GetProcessTimes creation FILETIME，
  前后确认进程仍存活；host、boot 与当前 owner 的组合快照仍通过系统 PowerShell/CIM 获取，
  reboot proof 使用 `Win32_OperatingSystem.LastBootUpTime` 与 `GetTickCount64` 推导值交叉核对；
- macOS：`kern.bootsessionuuid` + 可取得的启动时间。若只有秒级信息，PID 存活且值相同判 unknown，
  不判 exact alive/dead；
- hostId 对 Linux `/etc/machine-id`、macOS IOPlatformUUID、Windows MachineGuid 做带域分隔的
  SHA-256；不落原始机器标识。来源缺失或两项矛盾时为 unknown；
- probe 的 EPERM/EACCES、平台命令缺失、异机均为 unknown。

当前 owner 可用内存 handle/IPC 证明自身；磁盘恢复只接受平台记录能证明的结论。PID reuse fixture
必须覆盖“不同 identity 不误杀；相同但精度不足保持 unknown”。

## 完成、收口与长时服务

armed 调用的共同完成条件是
`pipes EOF + containment empty + cached-digest receipt + supervisor closed`，不是 Promise 收到 exit；
只有自然完成路径额外要求 root result，timeout、用户中断和 parent 断链允许没有 STARTED/RESULT。
POSIX 的 empty 由组外 supervisor 让 trusted launcher 退出、探测精确 pgid 消失、写 receipt，
并在 supervisor 退出后由 parent 再探测和回读证明；Windows 的 empty 由仍持 Job handle 的 supervisor
在关闭目标 handle 后查询为零并持久化精确 receipt，不能在 helper 退出后补查匿名 Job。

固定时序为：根结果后自然 drain 最多 5 秒；提前达到 pipes EOF + empty 即正常完成。到期仍有成员，
receipt 记录 `drainReason=process-tree-not-empty` 并清理：POSIX TERM grace 5 秒，再 KILL + empty confirm 5 秒；Windows
TerminateJobObject + zero/EOF confirm 5 秒。清理成功也保留 process-tree-not-empty 裁决。命令 timeout
不吞掉这三段收口预算；完整 duration 包含它们。timeout、signal、parent EOF 跳过自然 drain，直接
终止。有限测试使用 barrier：

1. grandchild 等待 `new-owner-acquired` marker 后才尝试写 sentinel；
2. 测试先要求旧调用结束/第二 owner 获取；
3. 再释放 marker；
4. 断言旧 PID/Job 已不存在且 sentinel 未出现。

不使用“等几秒后应该永远不出现”这种不可证伪断言。

所有结局的裁决顺序固定：先确认 containment empty；无法确认就 quarantine。确认后，无论 root
success/error、timeout、leftover 或 signal，都必须使用持久 baseline 执行同一 semantic delta check。
delta 越界/非法时保留完整 operation + quarantine 且绝不回 idle/release；普通路径退出 2，受支持
用户中断仅在进程码上保持来源对应码。只有 delta accepted 才把完整 operation 原子移入
settled-operations，回到
owned-idle，并写对应普通 outcome/evidence；不逐项删除 active/baseline/receipt。若 child 动过
lock/recovery 导致 owner 校验失败，直接 lease-lost/invalid。
coordinator/POSIX/Windows helper 按协议产生的 operation/receipt/quarantine 属于单独的 safety delta，必须严格
绑定验证但不算 delegated child 业务变化；child 自己写同名安全文件仍是 lease-lost/invalid。

0.34.0 同步修改 Builder 指令：

- 可复用用户预先启动的外部服务；
- coding-x operation 内启动的服务必须在 operation 返回前停止；
- 不再允许 `nohup ... &` 跨轮保留；
- 忘记清理时，结果按 process-tree-not-empty 失败，引擎负责最终清理。

未来 engine-owned service manager 需独立 ADR；本设计不暗中保留逃逸服务。

## workspace 写入口

`runLoop` 持有一个 WorkspaceSession（lease、coordinator、writer）。所有引擎侧 state/evidence/
guard/result/review/report 写 API 接收 session/writer；静态约束测试禁止生产模块绕过。delegated
child 是唯一明确例外，其允许变化由 delta checker 裁决。

- 自动 report 与 Final Review 复用 run session；
- 手动 report/repair 获取短 session；
- `coding-x workspace apply-prd --workspace <dir>` 获取短 session，先在 coordinator 下执行已确认
  TDD baseline；失败时业务
  workspace 零变化；成功后才建立 mutation 并幂等应用；
- `prd-to-json` 在命令外只做发现、用户确认、候选与可选源文档编辑。apply 时绑定 source bytes、
  Git HEAD、quality digest 和 candidate digest；租约外不直接写 workspace，并把用户选择的同一
  `--workspace` 原样交给 CLI，禁止硬编码 `.workspace`；
- `coding-x workspace record-review-decision --workspace <dir>` 在短 session 内重核 Final Review
  binding、HEAD、现有决定和
  延期 Issue 后原子覆盖结构化文件；
- `/review-loop` 不直接改文件；
- status/doctor/dashboard 只读；report collect 可只读，写 report.html 时必须持 session。

公开嵌套命令固定为 `workspace init|apply-prd|record-review-decision|recover|resume-mutation`。
`--workspace` 是现有全局 option，可出现在 positionals 前后，但只能出现一次；parser 统一 resolve
canonical realpath 和目录 identity 后传给所有层。相对路径、绝对路径和 symlink alias 必须竞争同一
租约。`coding-x init` 对默认/显式 workspace 调用同一个 workspace-init 内核。测试覆盖 CLI、skill
透传与错误目录 canary。

apply-prd 不承诺回滚 skill 已经完成的源 Markdown 编辑；它保证获取不到租约或 baseline 失败时
workspace 零业务写入，并用 source digest 防止把错误版本派生进去。

## mutation 恢复

apply-prd/repair 的固定前向恢复流程：

1. 在内存生成并严格校验完整目标；
2. 在 `mutation.prepare-<mutationId>/` 完整写 state、input 与 manifest，并回读所有摘要；
3. 原子 rename 为固定 `mutation/`；只有这一步成功才允许首次业务写；
4. 在唯一 attempt staging dir 复制旧文件、逐项核对并写 manifest，再原子 rename 到 deterministic
   archive path；final 已存在只接受完整相同，mid-copy crash 不得留下半份 final；
5. 逐个原子覆盖目标、删除固定旧产物；每步可重放；
6. 校验最终 workspace snapshot；
7. 写 committed；
8. 不再逐项删除或移动 mutation 元数据；owner-checked release 或 recovery finalization 把整个 active
   lease 连同 committed 元数据一次原子移入 tombstone/incident。旧 owner 立即返回；只有未来已持有
   active lease 的 current owner 可以尽力清理 released tombstone。

任一 phase 崩溃后，在旧 owner/containment 尚未证明安全前 doctor 返回 isolated；证明 owner exact
dead、containment empty 且 mutation/input 严格有效后，分类变为
`recoverable/mutation-incomplete|committed-finalize`。resume 再取得 recovery claim，由 attempt lease
winner 进入 `recovery-active/mutation-resume`。
RecoveryWriter 核对 `mutation/state.json`、input/base、当前字节与 phase，只能修改 mutation
`plannedPaths`、固定 archive 和 mutation 目录内元数据，再从该 phase 前向执行。同 input 的重复步骤
必须得到相同结果；摘要冲突变
invalid，不猜测回滚。恢复者崩溃时业务写权随 attempt lease 失效，固定 recovery 目录继续阻断；
后续 attempt 必须重新核对全部摘要。

review decision/report 是单文件 owner-aware 原子写，不进入 mutation。run 的 state/evidence 写保留
既有逐文件合同；parent crash 时锁/active 保留，下一次恢复只解决写者安全，损坏业务文件继续由
既有 guard/repair fail-closed 处理。

## 恢复协议

### 新版 active lease

1. evaluator 先验证永久 protocol 根、marker 与 active lease，证明旧 owner exact dead；normal acquire
   因固定 active lease 存在而失败。owned-idle 且无 operation/mutation/quarantine 时使用
   mechanical-empty，不要求不存在普通业务文件，业务字节继续由既有 guard/repair fail-closed；
   prepared/prepared-bound 也使用 mechanical-empty，但必须有完整 baseline 且业务字节完全未变；armed
   只有 cached-digest receipt 完整有效且 containment 已精确清空时才可选择 delegated-finalize；receipt
   缺失/错绑直接 `operation-proof-missing` 终态，不得建立 claim。合法 bootstrap 使用 bootstrap-complete；
   只要固定 mutation 存在就使用 mutation-resume：未完成 phase 前向续做，committed 则只重核 input、
   archive 与最终 snapshot 后收口。需要同机重启才能证明集合为空时，claim 另外绑定严格
   rebootProof，不把它当业务 mode；只有 `containment-unconfirmed` 可由这条 proof 继续。若存在 armed，
   proof 只能补 supervisor dead/identity 事实，不能替代已经有效的 receipt；integrity/proof-missing
   quarantine 永久拒绝；
2. 在 `engine.lock/lease/` 内生成完整 `recovery.prepare-<id>/`（claim、state、首个 staged attempt
   lease、attempts），回读后原子 rename 为固定 `recovery/`；多个创建者只有一个能安装，永久 protocol
   根和 active lease 均不移动；
3. attempt lease winner 重核 claim；首次 attempt 比对初始 source，后续 mutation attempt 则比对
   state/mutation 定义的合法前向中间态，同时重核 owner、containment、workspace identity；存在
   rebootProof 时还必须证明 host 相同、owner 中的 boot identity 可靠且与当前不同；
4. mechanical-empty 的 idle 分支只重核安全 schema、owner 与“无 operation/mutation/quarantine”；其
   prepared/prepared-bound 分支重算 baseline 并要求业务字节完全相同。delegated-finalize 用冻结的
   baseline、scope 与语义版本执行正常路径同一个 delta evaluator，合法变化只保留为未签发候选，越界/非法则
   原子写或升级为 `workspace-integrity-violation` quarantine 并停止，绝不 ready；bootstrap-complete 只允许按 owner identity 写缺失的
   精确安全标记；mutation-resume 对未完成 phase 只给 RecoveryWriter plannedPaths 权限并完成
   committed，对已经 committed 的 phase 零业务写、重核最终 snapshot 后继续 finalization，不能普通
   归档半份 mutation；
5. 写 verified；按前述顺序原子安装并回读 final manifest，再把精确 digest 写入 finalizing。任何一步
   恢复都必须接受唯一的缺失/相同状态，冲突即 invalid；
6. 原子 rename 整个 `engine.lock/lease/` 到 claim 指定的 incidents 路径，作为最后一个 workspace 动作。

rename 后不再写任何 workspace 字节。永久 `engine.lock/protocol.json` 保留；固定 active lease 消失、
精确 archive/manifest 存在且安全标记仍与 protocol 绑定才表示 ready。无标记非空 legacy workspace
没有 recovery 路径，始终引导新的空 workspace。

reboot-proof 不在重启前写任何新状态：旧 owner.json 已保存 host 与 boot identity；重启后旧进程已
被操作系统消灭，`workspace recover` 才创建 recovery domain，并冻结当时的 source snapshot。host
不同、boot identity 未变化/不可靠、owner 或 workspace identity 损坏时仍保持 isolated/invalid。它只
解除安全记录完整的 `containment-unconfirmed`；armed 必须已有有效 receipt，proof-missing/integrity
终态不变。这样不会在旧后代仍可能写业务文件时引入第二个 workspace writer。

### recovery-of-recovery

- strict recovery attempt lease owner exact alive/unknown：拒绝；
- recovery attempt lease owner dead：竞争者先计算完整 lease digest，并原子 rename
  `recovery/lease/` 到唯一 `recovery/attempts/abandoned-<digest>/`；只有一个能移动；
- `recovery/lease/` 缺失：各竞争者先完整 staging 自己的 owner dir，再原子 rename 到固定
  `recovery/lease/`；只有一个能安装，赢家回读 attemptId/recoveryId/process identity 后才进入
  recovery-active；
- 崩溃在 move-old 与 install-new 之间：固定 active lease 和 `recovery/` 仍阻断，下一竞争者可直接
  竞争安装；
- claim/state/source 摘要冲突或 attempt lease 损坏：invalid，保留原字节并改用新的空 workspace，不能删
  claim、覆盖 owner 或冒充恢复；
- phase 为 verified 且 manifest 已存在：重算完全相同才可补写 finalizing；冲突/损坏即 invalid；
- phase 为 finalizing 且固定 active lease 已消失：只有 claim 指定 archive 与 manifest 全匹配才判完成；
  目标缺失或冲突则 invalid，不补写 archived 状态。
- phase 为 finalizing、active lease 仍存在且旧 attempt dead：新 attempt 可移动/安装 recovery attempt
  lease，但不得重写 final manifest；因 volatile 路径被排除，原 manifest 仍有效，复核后直接重试
  active lease 的最终 rename。

不提供 `--force`。用户可以在 coding-x 外自行改文件，但系统不能把那条路径显示为安全恢复或
正常交付。

## 中断与退出

| 场景                                  | 固定裁决                         | 磁盘                            | 重试/后续 writer                  |
| ------------------------------------- | -------------------------------- | ------------------------------- | --------------------------------- |
| 根成功、集合自然为空                  | 原语义                           | activity 清除                   | owner release 后可进入            |
| Builder/Validator 成功但遗留后代      | 丢弃结果；本轮失败               | 清理后写有界失败证据            | 不重跑 invocation；既有有界下一轮 |
| 机械检查/apply baseline 遗留后代      | `process-tree-not-empty`，退出 1 | apply 不开始 mutation           | 修正命令后重新发起                |
| Final Review 遗留后代                 | 该轴 unverifiable，整体退出 5    | 不采用 review 输出              | 用户修正后重跑最终 Review         |
| 其他独立命令遗留后代                  | `process-tree-not-empty`，退出 1 | 清理后写有界失败证据            | 不自动重试同一 invocation         |
| delegated delta 越界/非法             | 退出 2                           | quarantine；不写普通 evidence   | 拒绝；新空 workspace 重新派生     |
| 根非零、集合为空                      | 原 failed/error                  | activity 清除                   | 按原调用策略                      |
| timeout 且终止成功                    | delta accepted 后原 timeout      | accepted 后 activity 清除       | 按原调用策略                      |
| termination/containment 无法确认      | 2                                | activity + quarantine + lock    | 拒绝                              |
| 首个受支持用户中断，无未提交 mutation | 来源对应码                       | accepted 才 settle/release      | 越界则 quarantine                 |
| 首个受支持用户中断，mutation 未提交   | 来源对应码                       | 当前原子步后保留 mutation+lease | 仅 exact resume                   |
| 首个受支持用户中断，收口失败          | 来源对应码                       | quarantine + lock               | 拒绝                              |
| recovery-active 中断、final rename 前 | 来源对应码                       | 保留 recovery + lease           | exact resume finalization         |
| recovery final rename 已提交后中断    | 来源对应码                       | ready；旧 owner 零写            | 可重新 acquire                    |
| 第二次中断/平台强制终止               | OS 行为                          | 不主动删当前记录                | 诊断/恢复前拒绝                   |
| 无用户中断的 mutation 内部失败        | 2                                | mutation + lock                 | 仅 exact resume                   |
| lock 被删/改写                        | 2 / lease-lost                   | 不夺回                          | 不宣称防恶意同账号篡改            |

Builder/Validator 的既有轮次耗尽后仍按 story blocked/退出 3；process-tree-not-empty 不增加一次隐藏
重试。若清理本身不能确认，上表所有“遗留后代”分支统一升级为退出 2 与 quarantine。
“来源对应码”严格指 POSIX SIGINT=130、POSIX SIGTERM=143、Windows 终端 Ctrl+C/SIGINT=130。Windows
没有可依赖的 SIGTERM 用户事件；`process.kill(..., 'SIGTERM')`/TerminateProcess 属于 hard crash，不能
用 coordinator 注入冒充优雅收口。首个受支持用户中断码优先于 mutation 的内部失败码；已 committed
mutation 可以 release 后退出，未 committed mutation 不 release。第二次受支持中断或平台强制终止才
进入 OS 行为。平台边界见 [Node.js signal events](https://nodejs.org/api/process.html#signal-events)。

上表的普通 committed mutation release 只适用于没有固定 recovery 的普通 owner。`recovery-active` 的
ordinary release guard 必然失败；在 final lease rename 前收到中断时，即使 mutation 已 committed，也
只能在当前原子边界保留 recovery/lease，后续 exact resume 按既有 manifest→finalizing→rename 继续。
信号与 final rename 由同一 session 串行：rename 已提交则保持 ready 且旧 owner 不再写，否则完整
recovery 仍在。

## 跨平台矩阵

所有场景用 IPC/事件 barrier，不用固定 sleep 猜窗口。

| 场景                                           |             Linux |             macOS |               Windows |
| ---------------------------------------------- | ----------------: | ----------------: | --------------------: |
| prepared/bound/DATA 各窗口 parent crash        |              真机 |              真机 |                  真机 |
| prepared/bound setup 失败或首中断原子 abort    |    barrier + 真机 |    barrier + 真机 |        barrier + 真机 |
| DATA 后、armed 前零 receipt 恢复               |              真机 |              真机 |              Job 真机 |
| DATA 与 START 分离、重复/错 ID 拒绝            |       真机 + 单测 |       真机 + 单测 |           真机 + 单测 |
| armed 后 START/TERMINATE 两种先后顺序          |       真机 + 单测 |       真机 + 单测 |           真机 + 单测 |
| TERM-first 迟到 START、重复 TERM 首因冻结      |       真机 + 单测 |       真机 + 单测 |           真机 + 单测 |
| 终止路径无 STARTED/RESULT 仍完成平台证明       |              真机 |              真机 |                  真机 |
| STARTED/快速退出/receipt 任意交错              |      barrier 单测 |      barrier 单测 |      Job barrier 真机 |
| child 越界后 parent hard kill 再恢复           |              真机 |              真机 |                  真机 |
| 合法 delta 后 parent kill→recover ready        |              真机 |              真机 |                  真机 |
| safety/owner 改写与 receipt 摘要冲突           |              真机 |              真机 |                  真机 |
| root exit 0、grandchild 延迟写                 |              真机 |              真机 |              Job 真机 |
| timeout 顽固 child/grandchild                  |              PGID |              PGID |                   Job |
| parent SIGINT / terminal Ctrl+C                |          真机 130 |          真机 130 | CTRL_C_EVENT 真机 130 |
| parent SIGTERM                                 |          真机 143 |          真机 143 |                不适用 |
| Windows process.kill(SIGTERM)/TerminateProcess |            不适用 |            不适用 |       hard-crash 真机 |
| 用户中断时 supervisor 存活至 receipt           |              真机 |              真机 |                  真机 |
| parent hard kill                               |              真机 |              真机 |                  真机 |
| supervisor hard kill、armed 无 receipt         | 终态/新 workspace | 终态/新 workspace |     终态/新 workspace |
| termination adapter 失败                       |              注入 |              注入 |  Query/Terminate 注入 |
| PID reuse/identity unknown                     |              注入 |      同秒 unknown |         FILETIME 注入 |
| normal acquire vs recovery barrier             |            两进程 |            两进程 |                两进程 |
| first workspace 双初始化                       |            两进程 |            两进程 |                两进程 |
| bootstrap staging/root/marker/release crash    |    barrier 两进程 |    barrier 两进程 |        barrier 两进程 |
| bootstrap owner dead、marker 缺失恢复          |            两进程 |            两进程 |                两进程 |
| lease staging/install/handle-return crash      |    barrier 两进程 |    barrier 两进程 |        barrier 两进程 |
| ready workspace 重复 init 零写                 |              真机 |              真机 |                  真机 |
| 0.33.3 ready/active run 与无锁 report          |          冻结真包 |          冻结真包 |              冻结真包 |
| 双 resume 与每 phase crash                     |            两进程 |            两进程 |                两进程 |
| manifest 写后、finalizing 写前 crash           |    barrier 两进程 |    barrier 两进程 |        barrier 两进程 |
| finalizing 后接管 lease 再 rename              |    barrier 两进程 |    barrier 两进程 |        barrier 两进程 |
| committed 后直接移动完整 active lease          |     真文件 + 真机 |     真文件 + 真机 |         真文件 + 真机 |
| in-flight writer vs close/release              |    barrier 两进程 |    barrier 两进程 |        barrier 两进程 |
| release 后旧 callback 与新 owner               |    barrier 两进程 |    barrier 两进程 |        barrier 两进程 |
| mutation 每 phase/mid-copy/二次 crash          |     真文件 + 真机 |     真文件 + 真机 |         真文件 + 真机 |
| recovery committed/finalizing 各窗口中断       |    barrier + 真机 |    barrier + 真机 |        barrier + 真机 |
| owner boot identity 同机重启恢复               |   adapter fixture |   adapter fixture |       adapter fixture |
| reboot 仅解除合格 containment quarantine       |   adapter fixture |   adapter fixture |       adapter fixture |
| reboot 不补 armed receipt/不越过 integrity     |   adapter fixture |   adapter fixture |       adapter fixture |
| 未选择的普通 secret canary 不落安全元数据      |              真机 |              真机 |                  真机 |

Windows 另测 Node 22 与当前 Node、普通用户、嵌套外层 Job、不兼容 Job、固定 EXE 缺失/损坏/摘要错误、
确定性重建与逐字节比较、breakaway 尝试、`.cmd` shim、Unicode/空参数、stdin/大 stdout/stderr、thread/process handle
关闭顺序、ActiveProcesses 归零、receipt 损坏/错绑、supervisor 在 receipt 前后 hard kill 和 handle leak。
同一普通用户证明还必须真实创建 Unicode/空格路径上的 WOF 压缩普通文件和“父目录 junction、子文件
表面普通”的场景，先证明 Node `lstat` 未识别，再证明 readReady、bootstrap/recovery 和 evaluator
均由系统属性检查拒绝；fixture 创建失败不得跳过。
GitHub Windows Server 2022 是最低真实证明；mock taskkill 不能替代。
非 Windows 上的源码、摘要和条件测试只能证明分发合同，不能把 skip 或静态检查报告为 Job 行为已完成；
上述 Windows 行为必须由 required Windows CI 真正执行后才算绿色。

Windows 原生证明使用独立的 required job：工作流固定 `windows-2022`，先由 hosted runner 管理员创建
一次性本地普通账户，再通过无交互 credential 启动该账户执行固定 Windows Job、parent crash、生产
operation、delegated recovery 与 reparse safety suite。证明入口同时核对 token 不含 Administrators SID，
并解析 Vitest JSON，要求固定 suite 全部存在、至少一个断言实际通过、逐项记录耗时且零 skip/pending；
账户切换、结果文件、WOF/junction fixture 或任一
suite 不可用都让 job 失败。普通 `npm test` 中的条件 skip 不计入此证明。0.33.3 冻结包兼容测试使用
PATH 上的 `node` 和仓库相对 fixture，避免把 `Program Files` 绝对路径送入旧版按空格切分的 runner
覆盖参数；不得因此替换冻结 tarball 或放宽摘要核验。

普通 Windows 全量单测为避免每个 fixture 重复启动原生检查器，可由仓库 Vitest 配置把 identity 与
path transport 解析到严格、有计数上限的 test-only 实现；这份结果不计入原生证明。启动真实
supervisor 的专用子进程不安装任何 transport alias，进程身份与路径检查都使用同一份生产 EXE，
避免“生产身份间接落到测试路径”的假证明。required native runner 也必须显式使用另一份无 test-only
alias、setup 或环境旁路的固定配置，将 import 固定回生产 transport，直接调用真实固定 EXE 与 Windows
原生 API，并以 WOF、junction、真实进程身份和普通用户断言证明没有走 test transport。production API
不接收 transport/probe，也不读取测试旁路环境变量；配置、runner、固定 suite、辅助 EXE 的可复现
构建、进程身份和属性规则都属于旧 policy 保护范围。

POSIX 另测 supervisor 与 launcher 分组、launcher 在 START 前零项目代码、launcher 提前退出、pgid
仍有成员、group probe unknown 和 START 后 parent 立即 kill。真实测试只证明普通进程继承合同；
主动 setsid/平台逃逸属于明确非目标。

## PR 切换与兼容

1. 设计 PR 只纠正事实和冻结合同。
2. dark foundation PR 可以加入未接线 lock/coordinator/helper/parser 与三平台测试，不改变公开行为。
3. atomic activation PR 同时迁移全部 spawn、全部 workspace 写入口、doctor/recovery、skills 和
   Builder 服务合同；没有“新 run + 旧旁路”的中间产品状态。
4. closeout PR 只做真实 dogfood、文档对账和 Issue 证据。

dark foundation 的 `workspace-safety` 生产模块只公开进程放置与集合状态的只读检查；POSIX 组信号只存在于
摘要绑定的固定 launcher 内。0.33.3 仍在使用的 `src/engine/process-tree.ts` 是 activation PR 必须整体
替换的已知旧边界，不属于本 PR 的新安全证明，也不能被新模块导入。测试失败后的破坏性清理仅允许位于
test-only fixture，并在发送信号前重核已记录 launcher 的进程身份与 session/pgid。

0.34.0 初始化真实测试实际运行冻结 0.33.3 binary 面对新版目录：

- 新 acquire 失败且目录字节不变；
- 旧 verify/release 不得使已存在的新目录消失；
- 明确记录：已经运行且旧锁先丢失的 0.33.3 无法被新版事后 fencing，因此必须满足切换前提。

## 黄金原则对照

1. **可证伪完成合同**：每条安全承诺都有可观察反例和测试；kill 请求、根退出、绿色单测都不是集合
   清空证明。
2. **生成方不得自签**：Agent 只能在委托范围写候选；owner/coordinator/platform adapter 决定是否
   接受并释放。
3. **自治扩张匹配防线**：后台服务不再逃逸；失败保持隔离；恢复保留原始字节并需精确摘要。
4. **原生与中立**：POSIX process group、Windows Job Object、Node/固定原生 helper；不把
   Claude/Codex/Cursor 写进核心状态。
5. **假绿与恢复**：先测正常 exit 的遗留孙进程、parent crash、双恢复和 mutation 中断；三平台真机
   证据是关闭条件。

## 非目标

- 防御恶意同权限本机进程或给本地记录加密码学不可伪造性。
- 跨主机共享 workspace 的分布式一致性。
- 自动迁移任意 0.33.x 旧 workspace。
- 允许 operation 合法遗留后台 daemon。
- 改变稳定 required check 名称或门禁语义、三层 Review 内容或 npm 发布；本 PR 只扩展
  `quality-gate` 内部跨平台证明矩阵。
- 提前完成 Issue #91 的干净检出。
