---
title: Windows 组合身份快照超时重试
status: done
updated: 2026-08-12
scope: root
---

# Windows 组合身份快照超时重试

## 背景、事实与推测边界

### 已确认事实

- PR #187 的最终候选提交 `00f710767402f11cfbf4fb5f8a47e0486fc0f054` 与 squash 后的
  `main` 提交 `68fdeb7e975aa05f8c158c5ad5f9083ac8727e32` 具有相同 Git tree
  `fc36c6579b6b38967eb410bac638aab0d5f97e60`，不是合并时产生了不同代码。
- [PR Quality Gate 31190336016](https://github.com/Xinzz995/coding-engine/actions/runs/31190336016)
  的 Windows Node 22 完整通过；其中 `test / legacy-compatibility` 用时 2 分 26 秒。
- 同一 tree 合并到 `main` 后，[Quality Gate 31192708656](https://github.com/Xinzz995/coding-engine/actions/runs/31192708656)
  的 Windows Node 22 在第一次运行和 failed-job 重跑中都先通过 2005 项普通测试，随后在
  `test / legacy-compatibility` 的第一次 `bootstrapWorkspace` 身份捕获处失败。两次该步骤都在
  启动后约 66 秒结束，栈固定为
  `legacy-compatibility-ci.ts → bootstrap.ts → identity.ts → windows-identity-transport.ts`。
- 当前生产传输为 PowerShell/CIM 子进程设置 60 秒 timeout，但把 `spawnSync.error`、error code、
  status、signal、stderr 和尝试次数全部折叠成同一句
  `Windows identity snapshot is unavailable`。现有日志因此没有底层错误分类。
- 普通 Windows Vitest 会把生产 identity transport 解析到确定性 test transport；它能验证上层身份
  语义，但不能证明生产 PowerShell/CIM 的 timeout、错误分类或重试。单独的
  `test:legacy-compat` 和无 alias 的 Windows native job 才运行生产 transport。
- PR #187 的 Windows native proof 实测总时长为 1,063,518 ms（17 分 44 秒）；其中最长的 integration
  suite 为 642,652 ms（10 分 43 秒）。现有 25 分钟总预算与每 suite 15 分钟预算分别保留约 7 分 16 秒
  和 4 分 17 秒余量。

### 尚未被现有证据直接证明的推测

两次 66 秒失败与 60 秒子进程 timeout 高度吻合，最可能的底层错误是 `ETIMEDOUT`；但旧实现已经
丢弃 error code，因此不能把这个推测写成既成事实。修复必须先补受控诊断，之后才允许用新日志确认
具体分类，不能继续靠耗时反推原因。

## 目标与非目标

本轮只允许 Windows 完整组合身份快照在第一次明确超时时，立即重新执行一次完整、独立的固定脚本。
两次尝试共享一份 120 秒单调绝对预算；任何一次成功都仍须通过现有 JSON、host、boot 与 process
identity 校验才可被采用。

本轮不做以下事情：

- 不对非超时错误重试，不增加无限退避或后台守护进程；
- 不缓存跨正式入口、跨进程或跨 recovery coordinator 的组合快照；
- 不回退到 pid-only、`Get-Process`、测试 transport、旧快照或部分 stdout；
- 不改变 process-only 原生 FILETIME 热路径、owner 判定、reboot proof 或现有身份 hash；
- 不把一次恢复后的超时解释成身份已经验证，最终成功仍只来自第二次完整且可解析的系统快照；
- 不用提高 GitHub job timeout、再次人工重跑或隐藏失败来代替修复。

## 可证伪完成合同

| 编号 | 完成条件                                                                                | 通过证据                                                                                                                                                           | 失败观察                                                                   |
| ---- | --------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------- |
| AC-1 | 第一次成功时只执行一次，不产生重试                                                      | 注入 runner 返回有效快照；调用次数为 1                                                                                                                             | 健康读取也执行两次                                                         |
| AC-2 | 第一次同时满足 `error.code === 'ETIMEDOUT'` 与 `status === null` 时重新执行完整脚本一次 | 第一次 timeout、第二次有效快照；调用次数为 2，采用第二次完整结果                                                                                                   | timeout 直接失败，或把同名错误文字/非空 status 当作可重试 timeout          |
| AC-3 | 两次尝试共享单一 120 秒单调绝对预算，每次最多 60 秒                                     | 假单调时钟证明第二次只取得剩余预算，累计预算不被重置                                                                                                               | 第二次重新获得新的 120 秒，或可继续第三次                                  |
| AC-4 | 两次 timeout 后失败关闭并保留最后分类                                                   | 错误包含 `timeout`、`2/2`、共享预算与最终 error code；不产生身份结果                                                                                               | 耗尽后返回通用 unavailable 或继续运行                                      |
| AC-5 | 永久或不确定错误不重试                                                                  | ENOENT/EACCES、非零退出、没有精确 timeout tuple 的 signal、畸形 JSON、boot source 矛盾和 current process unknown 均只调用一次                                      | 权限、协议或数据错误被第二次调用掩盖                                       |
| AC-6 | 诊断有界且不泄露身份原文                                                                | stdout/stderr 各最多捕获 16 KiB；只记录固定类别、次数、预算、error code/status/signal 与固定枚举阶段；secret canary 不出现                                         | 回显原始 stdout/stderr、MachineGuid、boot/process identity、完整命令或环境 |
| AC-7 | 正式身份边界不降级                                                                      | snapshot 失败时 current authority 仍为 unsupported；owner 探测仍为 unknown，不能取得写权或恢复权                                                                   | pid 存活被当作完整身份通过                                                 |
| AC-8 | 普通测试与原生证明分层                                                                  | 非 Windows 确定性单测覆盖失败矩阵；standard-user native suite 真实取得 `ETIMEDOUT + status null + stage` 后完整重读成功；Windows Node 22 legacy 使用生产 transport | Windows alias 结果被包装成生产证明                                         |

## 设计裁决

### 1. 只重试明确 timeout

生产 wrapper 的公开签名保持不变。每次尝试都重新启动固定系统 PowerShell，执行完整组合快照脚本，
不复用第一次的 stdout、stderr、进程句柄或解析中间值。只有 `spawnSync` 明确同时返回
`error.code === 'ETIMEDOUT'` 与 `status === null`，且这是第一次尝试、共享预算仍有剩余时，才允许
第二次尝试。

以下结果一律不重试：

- SystemRoot 缺失、相对、歧义或 PowerShell 路径解析失败；
- ENOENT、EACCES、EPERM 及 ETIMEDOUT 之外的 spawn error；
- 非零 status、`ETIMEDOUT` 搭配非空 status、没有同时满足 `ETIMEDOUT + status null` 的 signal 或没有可证明分类的异常；真实 timeout 可以同时带 `SIGTERM`，只要精确 tuple 仍成立；
- stdout 不是严格 JSON、字段类型/长度非法或 process 状态组合非法；
- boot identity 与 Node uptime 交叉核对失败；
- 成功快照仍不能证明当前 process identity；
- 第二次尝试的任何失败。

### 2. 一份 120 秒共享预算

进入单次组合快照读取时创建一次基于单调时钟的绝对截止点。每次传给 `spawnSync` 的 timeout 为
`min(60 秒, 当前剩余预算)`；第一次返回、分类、受控诊断和第二次启动都消费同一预算。预算已经耗尽
时不得启动第二次，任何状态推进都不能重置截止点。这里的“一次完整重试”指重新执行完整脚本与完整
解析，不表示第二次可以越过总截止点另取一份 60 或 120 秒。

本轮不增加等待退避。读取是本机、只读、同步的系统观察，第一次 timeout 已经提供了自然等待窗口；
立即重试既能复用已经被系统唤起的 CIM 服务，也不会把总时间扩成无界退避。

### 3. 受控诊断不是身份凭证

每次失败先归入固定枚举类别。传输最多各捕获 16 KiB stdout/stderr；PowerShell 只向 stderr 写入固定
版本、固定枚举的阶段标记，控制器只识别完全匹配的标记并记录最后一个合法阶段。对外错误最多带：
失败类别、尝试序号、最大尝试数、该次耗时、共享预算、底层 error code、status/signal 和受控阶段。
畸形、超长或非 UTF-8 的 stderr 只能回退到固定启动阶段，不得回显原始 stderr。不得输出 stdout，
因为其中包含原始 MachineGuid、boot time 与 process identity；也不得输出完整脚本、参数、环境或项目秘密。
错误对象不得附带原始底层 `Error` 作为 `cause`；Node 检查该对象时可能展开 `spawnargs`、完整脚本或其他
未经过白名单的字段。诊断只允许使用上述固定白名单字段重新构造。

第二次完整快照成功后写一条不含身份数据的有界诊断；交付结论仍只说明取得了一份有效快照，不把
“发生过重试”升级成额外信任。两次耗尽时错误必须保留 `2/2` 与最后分类，避免再次只能由 66 秒耗时
反推。

### 4. 缓存与降级边界不变

第二次成功后只把该次完整记录交给现有 parse 与 boot validation。一次正式 current-process authority
仍只持有一份成功的 host/boot 锚点，并在权限边界继续用固定原生检查器重读 FILETIME；重试本身不
产生可跨 authority 复用的缓存。新正式入口、新进程和 reboot-proof coordinator 仍重新读取组合快照。

组合快照失败时，不调用独立 `readHostIdentity`/`readBootIdentity` 拼接结果，不以
`readWindowsProcessIdentity` 或 `process.kill(pid, 0)` 代替 host/boot，也不读测试 transport。正式
current authority 获取失败；竞争 owner 的 probe 保持 unknown，因此不会授权写入、接管或恢复。

### 5. 测试位置与信任级别

新增 `src/workspace-safety/windows-identity-transport.test.ts`，在非 Windows 普通 Vitest 中通过名称明确、
仅测试模块可导入的 `windows-identity-transport-test-seam.ts` 注入系统命令、警告接收器和假单调时间，
确定性覆盖 retry 与 deadline。该 seam 只转出生产 transport 内部受控入口；production 文件禁止导入，
正式公开函数签名不变，也不增加环境旁路。Windows 普通 Vitest 因既有 identity alias 而排除这项测试，
不得为运行该单测而移除 alias、让数千 fixture 重复启动 PowerShell/CIM。

真实平台验收继续分两条：

1. Windows Node 22 在完整普通测试之后另起 `tsx` 执行 `test:legacy-compat`，证明真实生产 transport、
   冻结 0.33.3 包与此次失败栈已经闭环；
2. `windows-native-standard-user` 使用无 identity alias 的独立配置；固定
   `windows-identity-transport.windows.test.ts` 先让真实系统 PowerShell 写入固定 `boot-read` 阶段和无敏感
   decoy，再以 10 秒局部测试 timeout 取得真实 `ETIMEDOUT + status null`，随后把第二次 production
   command、args 与 options 原样交给 `spawnSync`，只采用该次完整当前快照。固定超时步骤的 10 秒小于
   production 60 秒上限，整个新增 suite 仍由 90 秒测试上限约束，因此不调整 production timeout 或原生
   总预算；同一 job 的其余固定 suite 继续证明普通账户、真实系统身份与原生 helper 路径。

现有 required native suite 中，只有 integration、reparse、managed Review 与 delegated-recovery 四组
会在测试体或工作子进程获取完整组合身份：integration 每个用例一次，reparse 相关用例最多两次，
managed Review 两次，delegated parent 一次、recovery worker 两次。它们原有 60/90/120/180 秒外层
timeout 无法覆盖一次读取最多 120 秒的正式恢复合同，因此只对这四组按“实际身份读取次数 ×
`WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS` + 原场景余量”调整测试外层预算；process-only supervisor/crash 与
deadline suite 不机械放宽。历史总时长约 17 分 44 秒；按新增 suite 的完整 90 秒测试上限保守计算约为
19 分 14 秒，即使其余 suite 再发生一次完整 120 秒恢复也约 21 分 14 秒，仍低于 25 分钟并保留约
3 分 46 秒余量，因此不调整 native runner 的 15/25 分钟边界。

非 Windows 注入测试证明控制逻辑；Windows hosted 任务证明真实系统行为。两者缺一都不能关闭本计划。

## 确定性回归矩阵

| 第一次结果                                      | 第二次结果        | 调用次数 | 固定裁决                                       |
| ----------------------------------------------- | ----------------- | -------: | ---------------------------------------------- |
| 完整有效快照                                    | 不运行            |        1 | 采用第一次结果                                 |
| ETIMEDOUT + null status（可带 signal）          | 完整有效快照      |        2 | 丢弃第一次全部输出，采用第二次结果             |
| ETIMEDOUT                                       | ETIMEDOUT         |        2 | unsupported；诊断包含 timeout 与 2/2           |
| ETIMEDOUT                                       | 非零退出/畸形结果 |        2 | unsupported；不再第三次尝试                    |
| ENOENT/EACCES/EPERM                             | 不运行            |        1 | unsupported；保留固定错误分类                  |
| 非零 status，或 signal 不伴随精确 timeout tuple | 不运行            |        1 | unsupported；不重试                            |
| 畸形 JSON/非法字段                              | 不运行            |        1 | unsupported；不重试                            |
| 非 UTF-8 stdout 或超出捕获上限                  | 不运行            |        1 | unsupported；不重试，不回显原始字节            |
| boot identity 矛盾                              | 不运行            |        1 | unsupported；不重试                            |
| 单调时钟非有限值或倒退                          | 不运行            |   0 或 1 | unsupported；不得以系统墙钟继续预算            |
| ETIMEDOUT 且共享预算已耗尽                      | 不运行            |        1 | unsupported；不得越过绝对截止点                |
| 任意失败且 stdout/stderr 含 canary              | 按上述规则        |   1 或 2 | 错误与日志不含 stdout、身份原文、环境或 canary |

## 预计最小实现范围

- `src/workspace-safety/windows-identity-protocol.ts`：冻结每次 60 秒、最多两次和共享 120 秒常量。
- `src/workspace-safety/windows-identity-transport.ts`：加入 timeout-only 完整重试、单调共享预算与受控诊断；
  公开函数签名不变。
- `src/workspace-safety/windows-identity-transport-test-seam.ts`：只向测试转出受控 runtime 入口；production
  导入边界测试必须拒绝任何正式调用者依赖它。
- `src/workspace-safety/windows-identity-transport.test.ts`：非 Windows 确定性失败/成功矩阵。
- `src/workspace-safety/windows-identity-transport.windows.test.ts`：required standard-user Windows 真机
  timeout tuple 与第二次完整 production 快照证明；普通 Windows Vitest 从固定 native 清单自动排除。
- integration、reparse、managed Review 与 delegated-recovery 原生测试：只把真实身份读取的外层 timeout
  改为共享 120 秒常量乘以实际读取次数，再加各自原有场景余量；不改场景内部 deadline。
- `build/windows-native-proof.mjs` 与对应合同测试：把上述真机证明加入固定、零 skip 的 suite 清单；25 分钟
  总预算与每 suite 15 分钟预算保持不变。
- `src/workspace-safety/identity.test.ts`：同步常量、无降级和生产/test transport 分层合同；不把静态源码
  断言当作运行行为证明。
- ADR-021、本规格与 `docs/patterns.md`：同步这次受控例外和测试证据边界。

测试 seam 是本轮唯一允许的注入边界；不得把 command runner、clock、warning sink 或 timeout 变成生产
公开参数，也不得允许 production 模块导入该 seam。

## 黄金原则逐项对照

### 1. 先定义可证伪的完成合同

- **适用性**：适用。AC-1 至 AC-8 和回归矩阵同时给出通过证据与失败观察。
- **验证**：每项都绑定调用次数、错误分类、预算或真实 Windows job，不以“重跑绿了”作为单独证据。

### 2. 生成方不得给自己签发通过

- **适用性**：适用。timeout 重试控制器不能自行制造身份；只有固定系统脚本的完整结果经现有机械
  parse、boot 与 process 校验后才形成候选快照。
- **验证**：测试注入“第二次仍失败/畸形/矛盾”必须阻断；test transport、日志和错误文案都不能成为
  production 身份凭证。

### 3. 自治范围扩大时同步增加防线与可逆性

- **适用性**：适用。系统自动多执行至多一次本机只读命令。
- **裁决**：仅 timeout、最多两次、共享 120 秒、无后台执行、无写入、无缓存；回退该变更即可恢复
  单次读取，且任何失败继续阻断。

### 4. 原生执行优先，差异只在控制平面

- **适用性**：适用。继续使用 Node `spawnSync` 和 Windows 系统 PowerShell/CIM，不引入守护服务、代理
  或新平台依赖；重试只存在于 Windows identity transport。
- **验证**：Linux/macOS 身份路径不变，跨平台单测只验证 Windows adapter 的控制逻辑。

### 5. 以假绿率和失败恢复衡量价值

- **适用性**：适用。本计划直接来自 exact same tree 在 `main` 连续两次失败的真实证据。
- **裁决**：目标是减少已分类系统 timeout 造成的假红，不减少任何身份校验。验收同时覆盖恢复成功、
  耗尽失败、永久错误和真实 Windows；记录调用次数与总耗时，不能只报告最终绿色。

## 实施与验收顺序

1. 先加入 timeout→success、timeout→timeout、永久错误、预算耗尽和 canary 回归，证明旧实现失败。
2. 实现 timeout-only 重试、共享单调预算和受控诊断；保持所有 production API 与无降级规则不变。
3. 运行相关单测、格式、lint、typecheck、全量测试、构建、文档健康与成品 CLI 冒烟。
4. PR 必须由 Windows Node 22 的 `test:legacy-compat` 与 `windows-native-standard-user` 同时通过；后者
   必须实际执行固定 timeout→fresh snapshot suite 且零 skip，普通 Windows alias 绿色不能替代它们。
5. 合并后核对 `main` exact SHA 的 CodeQL、全部 Quality jobs 与总闸；failed-job 重跑不代替新代码的
   首次完整门禁。

建议验证命令：

```bash
npx vitest run src/workspace-safety/windows-identity-transport.test.ts src/workspace-safety/identity.test.ts
npm run format:check
npm run lint
npm run typecheck
npm test
npm run build
npm run repository-health
node dist/cli.js --help
```
