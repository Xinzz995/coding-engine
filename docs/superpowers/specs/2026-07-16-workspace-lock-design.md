---
title: "workspace 并发锁设计"
status: done
updated: 2026-07-16
scope: root
---

# workspace 并发锁设计

日期：2026-07-16
来源：validation gate 调研吸收轮 #6「workspace 并发锁」（最后一项待做）；与 no-mistakes 同构的单写者互斥问题。

## 背景与动机

引擎对「同一 workspace 被多个进程同时写」零防护：`src/engine/` 无任何单实例检测，state.json 是裸 `writeFileSync`。一个 workspace 有五类写入面：state.json（覆盖写）、evidence.jsonl（append）、prd.json 快照恢复与篡改归档（prd-guard）、report.html、screenshots/（agent 侧）。

真实触发场景（非假想）：

1. 用户开两个终端，忘了第一个还在跑，又执行一次 `npx coding-x`；
2. 已知环境坑「后台任务约 2.5h 被系统 kill」+ 引擎幂等续跑设计，训练了用户「觉得死了就重新拉起」——若旧进程假死或未死透（父进程死、子进程存活），重新拉起即双实例；
3. 引擎运行中执行 `coding-x repair`，jsonrepair 重写的成果被引擎下一次覆盖写抹掉（或反向互踩）。

后果全部是**无痕迹的静默损坏**：A 实例读 state → B 写入 → A 用旧内存状态覆盖写回，B 的 retryCount/notes/passes 丢失；双写者使 evidence.jsonl 轮号交错，0.20.0 时间线重建被污染；prd-guard 快照被对方重建，篡改检测误报/漏报。与 0.17.0 防篡改同属「信任链被架空」类问题。

顺带修复同域单写者风险：进程在写 state.json 中途被杀留下半截 JSON（2.5h 被 kill 环境坑正是风险源），jsonrepair 只能修复部分半截。

## 锁定决策（用户拍板）

1. **锁覆盖面 = run + repair**：两个会重写 state.json/prd.json 的子命令互斥。report 不锁（单文件全量覆盖写、无交错损坏面，运行中生成「进行中报告」算合法用法）；status/doctor/dashboard 只读不锁。
2. **stale 锁自动接管 + 告警**：持锁 pid 已死 → 警告后接管继续。理由：「被 kill 后重新拉起」是幂等续跑的设计内场景，每次人工删锁会打断无人值守自动化。
3. **state.json 原子写入本轮**：与锁同属「workspace 完整性」主题——锁防多写者互踩，原子写防单写者半截。
4. **方案 = 锁文件 + `O_EXCL` 原子创建 + pid 活性检测**：零新依赖（硬约束：引擎唯一运行时依赖 jsonrepair，否决 proper-lockfile 类库）、跨平台（`{ flag: 'wx' }` 在 POSIX/win32 都原子；flock 需原生模块，不可行）、锁内容人类可读可调试。

## 锁模块（`src/engine/lock.ts`）

锁文件 `<workspace>/engine.lock`，内容 JSON：

```json
{ "pid": 12345, "startedAt": "2026-07-16T08:00:00.000Z", "command": "run" }
```

接口：

```ts
acquireLock(workspace: string, command: 'run' | 'repair'): LockHandle  // 冲突时抛 LockConflictError（含持锁方 pid/startedAt）
LockHandle.release(): void   // 幂等：删锁 + 注销信号 handler；失败只 warn
LockHandle.verify(): void    // 轮首自愈：锁丢失/非本进程 → 告警 + 重建
```

- 获取：`writeFileSync(lockPath, data, { flag: 'wx' })`。EEXIST → 读锁 JSON → 三分支判定（见「冲突与 stale 判定」）。
- `startedAt` 用 ISO 时间戳（与 evidence.jsonl 的 `at` 一致）。
- 锁文件是运行时瞬态，不属数据文件：repair 不修它，报告不渲染它。

## 生命周期与接入点

**run（loop.ts）**：`runLoop` 内、`dashboard.start` 之前 acquire——失败无需清理任何资源，打印错误后直接返回退出码 2。**循环结束、report.html 写完后立即 release，然后才进入 keepOpen 等待**：等待阶段只读不需要持锁，且信号 handler 已随 release 注销，keepOpen 现有的 `process.once('SIGINT')` 语义（打印退出码、close server、按循环真实结果退出）零干扰。既有 `finally` 兜底 release（幂等，双调用安全）。

**repair（cli.ts）**：repair 分支用 acquire/release 包裹（try/finally）。

**信号**：acquire 时注册 SIGINT/SIGTERM handler——清锁后按原语义退出（SIGINT=130、SIGTERM=143）；release 时注销。现状是 Ctrl+C 进程直接死（默认行为，shell 报 130），加 handler 后行为等价、只多了清锁。另挂 `process.on('exit')` 同步 unlink 兜底（process.exit 与正常结束路径）。kill -9 / SIGKILL 无法拦截 → 交给 stale 检测。

## 冲突与 stale 判定

启动见锁（wx 抛 EEXIST）→ 读锁 JSON → 三分支：

| 情形 | 判定 | 行为 |
|---|---|---|
| pid 存活（`process.kill(pid, 0)` 成功或 EPERM） | 活锁 | fail-fast 报错退出（码 2）：含持锁 pid、启动时间、命令，以及「若确认该进程已死可手动删除 engine.lock」出路（覆盖 pid 复用误判的小概率场景） |
| pid 已死（ESRCH） | stale | 告警「检测到上次异常退出遗留的锁（pid X，启动于 T），已接管」→ unlink + 重新 wx 创建 |
| 锁 JSON 损坏/半截/字段缺失 | stale | 视为异常死亡痕迹，同上接管 |

stale 接管重建时再遇 EEXIST（两实例同毫秒抢同一把 stale 锁的理论竞态）→ 按活锁报错退出，不循环重试——简单诚实，实际场景是人工重新拉起，概率可忽略。

## 轮首锁自愈

缝隙：`.workspace/` 是 agent 可写区，agent 误删/改写 engine.lock 后，若锁只在启动时检查一次，单写者不变量静默失效——下一个实例 wx 创建成功即双实例。与 0.17.0 prd 篡改同构：「指令层告诫 agent 不碰锁文件」按 ADR-005 哲学不成立，必须机械防护。

对策：每轮循环开头（`guard.read()` 旁）调用 `verify()`——锁文件存在且 pid 为本进程则通过；丢失或 pid 非本进程 → 告警 + 重建（wx 失败再告警，不中断循环：引擎自身仍是合法写者，中断反而把胜利让给篡改方）。每轮一次 read，成本可忽略。

## state.json 原子写（`src/engine/fs-atomic.ts`）

```ts
writeFileAtomicSync(path: string, data: string): void  // 写 `${path}.tmp-${process.pid}` + renameSync
```

同目录 rename 在 POSIX 原子；win32 的 `renameSync` 目标存在时同样覆盖成功。替换四处覆盖写：

1. `state.ts` ensureStateFile 的初始化落盘（现 :72）；
2. `loop.ts` 门禁打回写 state（现 :193）；
3. `prd-guard.ts` 快照恢复写 prd.json（现 :90）；
4. `prd-guard.ts` 篡改归档写（现 :76）——归档是证据文件，半截=证据损坏，顺手同换。

report.html 不换（幂等副产物，重生成即可）；evidence.jsonl 不适用（append-only）。acquire 成功后顺带清理 workspace 根遗留的原子写残留：只清文件名匹配 `*.tmp-<纯数字>`（fs-atomic 的命名模式，写与 rename 之间崩溃的无害垃圾；遗留者 pid 已死，故不限定本进程 pid）的文件，不碰其他任何临时文件；不要求去掉后缀后的原文件存在（首次写 state.json 即崩溃时原文件尚不存在）。

## 错误处理与退出码

- 锁冲突退出码 **2**（与 report「workspace 级问题」语义一致，区别于循环失败的 1）。
- acquire 是关键路径：失败必须 fail-fast，绝不静默继续。
- release/exit 钩子失败只 warn：进程将退，锁残留由下次 stale 接管兜底——符合「副产物吞错、关键路径诚实」项目哲学。
- `verify()` 重建失败只告警不中断循环（理由见「轮首锁自愈」）。

## 测试

- `lock.test.ts`：获取成功且锁内容正确／活锁（本进程 pid 写入假锁）冲突拒绝／stale（不存在的 pid，如已回收的子进程 pid）接管+告警／损坏锁按 stale 接管／release 删锁且注销 handler（`process.listenerCount` 对账）／verify 丢失重建／verify pid 不符重建。
- `fs-atomic.test.ts`：内容正确／覆盖已存在文件／成功后无 tmp 残留。
- 集成（loop.test.ts / cli.test.ts）：活锁时 `runLoop` 返回 2 且不写任何 workspace 文件；正常跑完锁已清；repair 分支拿锁与释放；keepOpen 场景锁在进入等待前已释放。
- 既有测试回归：runLoop 相关用例在无锁文件时行为不变。

## 非目标（YAGNI）

- `--wait` 等待锁释放模式（第二实例排队接力无真实需求）；
- mtime 心跳/租约刷新（NFS/跨机器场景专属，本工具单机）;
- 跨机器锁（不记 hostname）；
- dashboard/status/report 渲染锁状态；
- report 子命令锁定（见锁定决策 1）；
- `prd-to-json` 再派生前查锁：属 agent/skill 侧行为，不受引擎锁约束，skill 指令加「派生前检查 engine.lock」留作后续候选，不入本轮。

## 文档与发版

- README：锁行为、engine.lock 说明、退出码 2、「异常退出后重新拉起会自动接管」；
- architecture.md：workspace 产物清单加 engine.lock、模块划分加 lock/fs-atomic；
- glossary：「工作区锁」词条（含禁用同义词校准）；
- doctor：加 stale 锁建议项（发现 engine.lock 且 pid 已死 → 提示「上次异常退出遗留，下次运行将自动接管」）；
- 版本 **0.21.0**（minor：新功能且「双开被拒」是面向用户的行为变更，硬约束 5）。
