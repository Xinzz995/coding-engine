---
title: Reviewer 临时域身份与安全清理实施计划
status: active
updated: 2026-08-01
scope: root
---

# Reviewer 临时域身份与安全清理实施计划

## 目标与事实起点

本计划落实 GitHub Issue #113，修复 ADR-018 已裁决的 Reviewer 隔离合同与 0.33.3 实现之间的
缺口。实现为五类临时域统一冻结创建身份、直接父子关系与固定或有界目录树，引擎以不跟随链接的有界句柄核对固定文件。
清理只在受管进程正常结束、没有超时或残留后代、身份与目录树仍一致后进行；其余情况只关闭句柄、保留现场并返回 `unverifiable`。

本轮只加固 Reviewer 临时域的创建、读取、进程收口和清理，不扩大 Reviewer 权限，不改变三层
Review、GitHub 机械门禁或发布模型。它是 0.34.0 发布前的 P1 缺陷修复，完成状态仍以本 PR 的三平台门禁与合并后主分支复验为准。

## 范围与信任边界

### 五类临时域

| 临时域 | 当前前缀 | 内容与使用者 | 本轮必须建立的边界 |
|---|---|---|---|
| 三轴审查包 | `coding-x-review-` | Review 输入、响应 schema、manifest；Runner 只读 | 固定三文件集合、安全读取、创建身份与清理身份一致 |
| Runner 调用目录 | `coding-x-review-invocation-` | 固定代理、Prompt、代理配置；Node 代理读取 | 固定文件集合，受管进程结束后才可清理 |
| Runner 版本目录 | `coding-x-review-version-` | `--version` 的只读工作目录 | 目录身份不变、无额外文件、版本进程完全结束 |
| Runner 隔离探测域 | `coding-x-review-probe-` | 受控审查包、假秘密与攻击探测 | 固定拓扑、探测进程完全结束、失败现场不被误删 |
| status Runner 临时安全域 | `coding-x-status-runner-` | 临时 workspace safety 协议与版本观察 session | session 安全关闭、创建身份不变后才可清理 |

### 明确保证

- 防止 Reviewer 或残留受管进程替换临时域、叶子文件或祖先后，被引擎继续按旧路径读取或删除；
- 防止链接、FIFO 等特殊文件、超大文件、额外文件和读取期间变化被当作合法审查包；
- 无法证明进程集合已清空、目录身份未变或文件读取完整时失败关闭，保留现场并返回
  `unverifiable`；
- Linux、macOS 与 Windows 使用各自真实文件系统语义验证，Windows 的 junction/reparse 不能由
  普通 `lstat` 或非 Windows 替身冒充证明。

### 明确不保证

- 不防御同一操作系统账号下、独立于 coding-x containment 且持续并发的任意恶意外部进程；
- 不声称目录身份摘要是不可伪造能力或密码学所有权；
- 不增加后台守护进程、中央登记服务、自动垃圾回收或按名称前缀扫描旧目录；
- 不新增公开清理命令，不自动删除身份无法证明的历史现场；
- 不扩大到 Issue #91。#91 负责在精确 HEAD 的干净检出中重建依赖并运行机械检查与 Validator；
  #113 只负责 Reviewer 自己的临时域，两者必须使用独立 PR。

若后续要求抵御任意同账号外部攻击者、引入原生清理 helper、持久目录登记或自动回收，必须另立
ADR；不能把本计划的有限身份复核扩写成该保证。

## 可证伪完成合同

| 编号 | 完成条件 | 失败时可观察结果 | 验证证据 |
|---|---|---|---|
| AC-1 | 五类临时域创建后立即冻结系统临时父目录、直接子目录关系、目录类型和平台可用的稳定身份；后续使用与清理都重核同一对象 | 根目录、祖先、路径别名或 Windows reparse 发生变化时拒绝继续 | 每类临时域的身份替换测试；Windows 普通用户真实 junction/reparse 测试 |
| AC-2 | 审查包只接受 `review-input.json`、`response-schema.json`、`manifest.json`；引擎逐个使用不跟随链接、非阻塞、有大小上限且绑定已打开句柄的方式核对；读取前后身份、类型、长度和字节一致 | 链接、硬链接、FIFO 等特殊文件、超大文件、额外文件或中途替换均不能获得有效 Review 结果 | POSIX FIFO/链接/替换 fixture；Windows WOF/祖先 reparse fixture；固定文件与边界大小测试 |
| AC-3 | Runner 调用、版本与探测目录只有在 coordinator 机械确认没有外部终止、目标 containment 清空、supervisor 关闭后才进入清理；status 域还要求 session 为 `closed` | 根进程退出但仍有后代、用户中断、父进程关闭、终止证明缺失、session isolated/invalid 时目录保留，结论不为绿 | 事件 barrier 控制的残留后代、timeout、真实用户中断、父进程关闭和 session 关闭失败测试 |
| AC-4 | 清理前重新证明创建身份和固定拓扑；身份不一致时不执行 `chmod`、rename 或递归删除。身份已证明后清理失败，保留原路径或已核对的清理墓碑路径 | 替换目录和外部 canary 保持原字节；诊断只含已知路径、阶段和引擎生成原因，不含源码、Prompt、凭据或假秘密 | 清理前替换、外部 canary、创建回滚与诊断脱敏测试 |
| AC-5 | Review 成功后若包核对或清理不可验证，该轴和总 Review 都为 `unverifiable`；清理异常不能覆盖原始失败，也不能保留旧绿灯 | “模型通过 + 清理失败”退出 5；“模型失败 + 清理失败”同时保留两类有界原因 | Final Review 组合失败表和旧状态失效测试 |
| AC-6 | 初始化中途失败也只清理身份仍匹配且尚未交给受管进程的临时域；其余保留 | 写入第二个文件失败、权限设置失败或进程启动边界中断时不存在越权删除 | 每个创建阶段的注入失败测试 |
| AC-7 | `src/review/**` 与 `src/status/runner-version-observation.ts` 由质量契约标为 `policy + security`，生成的旧规则工作流包含两者 | 任一后续 PR 修改这些路径但缺少有效政策例外时 `policy-guard-source` 失败 | 契约解析、生成工作流文本、repository-health 与真实 PR 检查 |
| AC-8 | 三系统完整质量门禁通过；Windows 安全结论由 required 普通用户真实证明，不以 skip 或测试 transport 代替 | 任一目标平台缺少真实 suite、出现 skip/pending 或运行生产检查器失败时总闸失败 | Ubuntu/Node 22、Ubuntu/Node 24、macOS、Windows 22/24 与 Windows native required jobs |

测试必须用生产代码可观察事件、注入 hook 或 IPC barrier 固定竞态窗口，不使用任意毫秒 `sleep` 猜时序。
用于制造 FIFO、junction、链接或替换的 fixture 创建与前置断言必须位于生产调用的异常捕获之外，
避免 fixture 未成立却得到假绿。

## 设计裁决

1. 建立一个 runner-neutral 的内部临时域合同，供五类调用点复用；前缀只用于诊断，不能参与最终
   所有权裁决。
2. 临时域的身份检查复用 ADR-021 已验证的平台目录身份与 Windows 路径检查能力，但不把它注册为
   workspace、lease 或可恢复业务域。
3. 文件读取先做有界类型预检，再以已打开句柄为身份锚点读取；POSIX 使用 no-follow/non-blocking
   语义，Windows 使用生产路径检查器排除叶子和祖先 reparse，并在读取前后复核句柄与路径快照。
   该句柄承诺用于引擎的信任核对。Runner CLI 仅接受路径时，在已反测的只读隔离中消费规范路径，运行后任何差异使结果作废；不宣称观察了 Runner 内部的文件系统调用。
4. 清理是有结果的收口步骤，不放在会掩盖原错误的无条件 `finally` 中。调用者必须把“已删除”与
   “保留现场”纳入该轴裁决。
5. 0.34.0 不做跨运行自动回收。自动扫描只知道名字、不知道创建身份，会重新引入本次缺陷。

## 实施顺序

1. 先提交本计划、ADR/architecture/patterns 的真实边界修正，以及质量契约和生成工作流；不改运行
   行为。
2. 以失败测试建立临时域身份、固定文件、安全读取和保留现场的共同底座。
3. 依次迁移审查包、Runner 调用目录、版本目录、隔离探测域和 status 临时安全域；每迁移一类都保留
   创建失败、进程失败、身份变化和清理失败四条路径。
4. 接通 Final Review 的清理结论与 `unverifiable`，验证旧 Review 结果立即失效。
5. 在 Linux、macOS、Windows 和 Windows 普通用户生产检查器上运行真实破坏性回归，再运行完整
   质量门禁、CodeQL 和 repository-health。
6. 使用受保护 PR 合并；因本轮修改 Reviewer 和质量政策，按默认分支旧 `policy-guard` 创建最长
   7 天的独立政策例外 Issue、添加 owner 标签并在主分支检查通过后关闭。#113 本身不充当政策例外。

## 黄金原则对照

| 原则 | 适用性与设计裁决 | 必须保留的证据 |
|---|---|---|
| 1. 先定义可证伪完成合同 | 适用。AC-1 至 AC-8 分别给出成功条件、失败信号和验证方式；“安全清理”不能单独充当验收语句。 | 固定竞态 fixture、三平台 job、Review 退出码与保留目录断言 |
| 2. 生成方不得自签 | 适用。模型返回成功不证明临时域安全；目录、文件和 containment 结论由引擎及平台检查器独立核对，清理不确定会撤销绿灯。 | 模型通过但身份变化/后代残留/清理失败的反例 |
| 3. 自治扩大必须增加防线 | 本轮不扩大模型权限；它收紧现有自动读取与删除。删除只有在身份和进程终点均确定时发生，不确定即保留，且不增加自动垃圾回收。 | 外部 canary、零 chmod/rm 断言、保留现场诊断 |
| 4. 原生执行优先、差异收口控制面 | 适用。复用 coordinator、POSIX 文件语义和既有 Windows 生产路径检查器；核心临时域合同不包含 Codex/Claude/Cursor 分支。 | 三个 Runner 共用合同；Windows 特有行为只在平台 adapter/测试中出现 |
| 5. 以假绿与恢复衡量价值 | 适用。先固化当前路径前缀、FIFO 阻塞、目录替换、残留后代和清理覆盖原错误等失败样本；目标指标是这些场景零假绿、现场可定位。 | failure-first 测试、退出 5、脱敏诊断、三平台真实回归 |

未裁决项：无。若实现发现 Node 与既有 Windows 检查器无法在上述威胁边界内可靠完成身份复核，
必须停止并把“新增原生 helper 或收窄保证”作为新的架构裁决，不能静默降级。

## 完成后验证

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- Reviewer 临时域、Final Review、status 与 Windows native 定向测试
- `npm test`
- `npm run build`
- `npm run repository-health`
- `npm run test:legacy-compat`
- `npm audit --audit-level=high`
- 构建产物 CLI 冒烟、CodeQL、全部 required GitHub checks 和合并后主分支复验
