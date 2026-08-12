---
title: 受管进程监督器单调绝对时限实施计划
status: done
updated: 2026-08-12
scope: root
---

# 受管进程监督器单调绝对时限实施计划

## 目标与事实起点

本计划落实 GitHub Issue #118。当前受管进程协议已经能够证明目标进程集合清空并签发绑定回执，
但准备、控制消息、终止收口、ACK 和最终退出之间仍有等待可以无限持续；部分阶段还会在收到中间
事件后重新获得一整段时限。Windows 与 POSIX 使用的超时字段也不对称，调用方传入的字段可能在
Windows 被静默忽略。

本轮把监督器生命周期收口为四个显式阶段：准备、命令运行、终止与排空、ACK 与最终退出。每个
阶段只创建一次基于单调时钟的绝对截止点，阶段内的消息、事件、hook、排空和退出等待只能消费
同一份剩余预算，不能因重试或状态推进重置。命令运行时限仍从 `START` 成功送达后开始。

本轮不改变三层 Review 的模型调用时限，不新增远端模型任务，也不把“在固定墙钟时间内一定终止”
扩大到操作系统调度器失效、同步系统调用永久不返回等无法由 JavaScript 或监督器控制的情形。

## 范围与信任边界

- 核心使用与平台无关的阶段名称和显式映射；POSIX 信号升级与 Windows Job Object 仍留在各自适配器。
- 准备阶段覆盖监督器启动、`BOUND`、`DATA`、`ARMED`、相关 hook 和 `START` 送达。
- 命令阶段从 `START` 送达后计时，保持现有 `timeoutMs` 用户语义。
- 收口阶段覆盖自然排空、强制终止、`DRAINED` 及所需平台证明；阶段内不得重新计时。
- ACK/退出阶段覆盖回执处理、ACK 送达、监督器退出、输出关闭和最终身份复核。
- 只有有效的空 containment 证明与绑定回执都成立时，普通命令超时才可以作为已验证结果返回；
  任一收口阶段超时都保留隔离状态并返回不可验证，不伪造回执、不误报已清理。
- 保证建立在事件循环和操作系统调度仍可工作的前提下；同步内核调用无法被 JavaScript 抢占，不在
  本轮承诺内。

## 可证伪完成合同

| 编号 | 完成条件 | 失败时可观察结果 | 验证证据 |
|---|---|---|---|
| AC-1 | 四个阶段各自只创建一次单调绝对截止点；阶段内任何事件、重试或状态变化只消费剩余预算 | 人为推进墙钟、重复事件或先消耗部分预算后，等待不会重新获得完整时限 | 假单调时钟单元测试；准备、排空和 ACK 的累计预算测试 |
| AC-2 | 所有控制消息发送、事件等待、hook、排空、ACK、退出和输出关闭都有界 | 监督器存活但不读消息、不发 `DRAINED`、ACK 后不退出或输出不关闭时，在对应阶段内失败 | POSIX 真实暂停故障测试；跨平台协议替身测试 |
| AC-3 | `timeoutMs` 仍从 `START` 成功送达后开始；只有有效空集合证明和绑定回执才能返回普通超时 | 准备失败不消耗命令预算；缺少证明时 session 保持隔离且结果不可验证 | START 边界回归；无 `DRAINED`、无退出和不闭输出反例 |
| AC-4 | 公共配置使用统一阶段字段，并由 coordinator 显式翻译到平台适配器；没有字段靠结构兼容被静默丢弃 | 任一公共字段缺少 POSIX 或 Windows 映射时类型或映射测试失败 | 纯函数映射测试同时断言两个平台的全部字段 |
| AC-5 | POSIX helper 使用单调时钟和共享绝对截止点，信号升级、进程组清空与 EOF 不能逐步重置预算 | 暂停 helper、阻止排空或 ACK 后不退出时有界失败，不产生假回执 | macOS/Linux 可运行的 helper 故障注入回归 |
| AC-6 | Windows C# helper 使用 `Stopwatch` 单调时钟并共享绝对截止点；源文件、协议测试和 required Windows 原生测试合同覆盖四类故障 | C# 回到墙钟、阶段重新计时或 required suite 缺失时测试失败 | 当前平台静态/协议测试；Windows 普通用户 native required job |
| AC-7 | 本轮不改变 Review 模型调用超时，也不把模型等待纳入监督器阶段 | Review Runner 的模型超时配置和行为无差异 | 变更范围审查与现有 Review 回归 |

测试优先使用生产代码可观察 hook、IPC barrier 或可控协议替身固定竞态，不用任意长 `sleep` 猜测
时序。所有超时反例还必须断言没有正常收口、没有伪造清理证明，并在测试结束时回收自身 fixture。

## 设计裁决

1. 新增一个 runner-neutral 的单调绝对截止点原语。它只暴露剩余预算和有界等待；超时后的迟到
   Promise 必须被消费，不能产生未处理拒绝。
2. 公共 `ManagedSupervisorTimeouts` 改为 `prepareMs`、`naturalDrainMs`、
   `terminateDrainMs`、`ackExitMs`、`pollMs`。coordinator 通过两个显式映射函数构造 POSIX 与
   Windows 配置，不再把同一个对象直接传给两个形状不同的类型。POSIX 的 TERM 宽限是 adapter
   私有策略，不暴露成会在 Windows 被忽略的公共字段。
3. POSIX 的 TERM 宽限只是总终止预算内的子边界；SIGKILL、进程组清空与 EOF 共用同一个终止
   截止点。Windows 的 Job Object 终止和 empty/EOF 证明使用相同总截止点。
4. 自然结束时，从收到根进程结果起建立一次包含自然排空和必要强制收口的总截止点；进入强制
   收口只改变动作，不延长截止点。外部终止则直接建立一次终止截止点。
5. 已安装的隔离状态和有效回执在后续 ACK/退出失败时继续保留为诊断证据，但不能转成正常通过。
6. Windows 可执行文件必须由固定 Windows 工具链重建并与源码一致。macOS 只验证源码、协议、
   静态合同和可移植测试；最终 Windows 结论由 required hosted job 签发。

## 实施顺序

1. 提交本计划并更新 ADR-021 的生命周期时限裁决。
2. 实现单调截止点原语、公共阶段配置和两平台显式映射，先补失败测试。
3. 收紧 POSIX 父进程与 helper 的全部无界等待，增加暂停/缺事件/缺退出故障测试。
4. 对称修改 Windows 协议与 C# helper，补跨平台协议测试、源码静态合同和 Windows required suite。
5. 运行格式、静态检查、类型检查、定向测试、全量测试和构建；在 Windows 固定工具链重建二进制
   并运行普通用户 native required job。

## 黄金原则对照

| 原则 | 适用性与设计裁决 | 必须保留的证据 |
|---|---|---|
| 1. 先定义可证伪完成合同 | 适用。AC-1 至 AC-7 分别给出成功、失败信号和证据；“所有等待有界”被拆成可制造的停滞场景。 | 假时钟、真实暂停、协议替身和 hosted Windows job |
| 2. 生成方不得自签 | 适用。helper 的普通退出或文本消息不构成成功；父进程仍独立验证空 containment、回执绑定和精确退出身份。 | 缺 `DRAINED`、ACK 后不退出、stdout 不关闭均不得返回绿灯 |
| 3. 自治扩大必须增加防线 | 本轮不扩大执行权限，而是给既有子进程自治补齐时限、隔离保留与失败恢复；终止升级只在既有 containment 内执行。 | 四阶段超时、SIGTERM/SIGKILL 或 Job 终止、隔离状态保留断言 |
| 4. 原生执行优先、差异收口控制面 | 适用。共享阶段语义和截止点合同保持平台中立；POSIX 进程组与 Windows Job Object 只存在于适配器。 | 显式双平台映射测试；相同故障合同在当前平台和 hosted Windows 验证 |
| 5. 以假绿与恢复衡量价值 | 适用。先固定准备停滞、无 `DRAINED`、ACK 后无退出和输出不关闭四类失败；目标是所有场景零假绿且在预算内返回。 | failure-first 测试、无正常回执断言、fixture 回收和耗时上界 |

## 完成后验证

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- 单调截止点、映射、POSIX closeout、Windows 协议与静态合同定向测试
- `npm test`
- `npm run build`
- Windows 固定工具链重建 `coding-x-windows-supervisor.exe`
- Windows 普通用户 native required suite、全部 required GitHub checks
