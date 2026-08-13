---
title: Validator 输出、不可验证退出与宿主隔离修复
status: superseded
updated: 2026-08-12
scope: root
---

# Validator 输出、不可验证退出与宿主隔离修复

> 2026-08-12：批次 A/B（完成合同 1-5、8 的输出与退出语义部分）已由 #187、#189 交付进
> 默认分支；批次 C/D（完成合同 6-7，宿主隔离与真实复验）经 ADR-025 重新裁决为分层 Runner
> 信任后，由 `2026-08-12-validator-host-isolation.md` 接管。本文的「原生能力对照与适配裁决」
> 一节（三 Runner 各自适配为正式支持）已被 ADR-025 取代，仅存档追溯。

## 背景与事实边界

0.34.0 Python Monorepo R7 的真实运行中，Validator 对 `.venv` 和多个生成目录执行逐文件摘要，
仅 `.venv` 就包含 1837 个文件。命令返回仍在运行的句柄后，Validator 没有继续轮询或终止该任务，
随后大量逐文件输出进入 Runner 通道，Codex 以 101 和 `EAGAIN` 退出。引擎没有收到合法的
`validation-result.json`，因此没有签发验收凭证，也没有产生假绿。

当前代码还存在两项独立事实：

- Runner 子进程继承固定代理的 stdout/stderr，两路最终进入监督器拥有的独立管道；旧监督器虽然并发
  读取，却把全部内容累计到 16 MiB 后才一次性返回，`runAgent` 又在结算后直接写回终端，不等待恢复。
- 干净验证检出隔离了项目文件，但 Validator Runner 仍可能加载宿主的用户配置、记忆、插件、MCP、
  hooks 和会话；这些内容不是验收合同的一部分，不能作为未声明输入。

本计划只处理 Developer/Validator 调用链。Final Reviewer 继续由 #166 管理；不得复用 Validator 的
权限模型，也不得削弱 Final Reviewer 的失败关闭规则。

## 完成合同

1. Validator 指令禁止对依赖、缓存、生成物和质量契约允许产物做递归枚举、读取、哈希或逐文件输出；
   需要身份证据时只能检查少量与 AC 明确相关的命名文件。
2. 工具返回 session/cell/run ID 或仍运行状态时，Validator 必须轮询到终态，或显式终止并确认收口；
   未收口前不得继续验证或写结果。
3. Runner 代理必须同时持续排空 stdout/stderr；任一路下游写入产生背压时暂停对应上游，等待恢复后
   再继续。总输出保持固定上限，溢出、超时、取消或父通道断开都终止完整 containment，不留后台进程。
4. 引擎只保留有界诊断尾部；向终端转发时等待背压恢复，不重复回放、也不把成功 transcript 持久化。
5. Validator 无结果、结果损坏/错配、Runner 异常退出、Runner 隔离配置无法证明或绑定 HEAD 变化时，
   run 返回 5；明确机械检查失败、合法的 Validator failed claim、最大轮次或不收敛返回 1。真正的
   workspace containment、临时检出拓扑或安全清理无法证明时仍返回 2。三类结果都不能签发凭证。
6. Validator 默认不加载宿主记忆、用户规则、插件、MCP、hooks、无关应用或持久会话；只保留引擎显式
   提供的请求、项目 `AGENTS.md`、质量契约命令和模型服务认证。任一 Runner 无法证明该边界时返回 5，
   不退回宽权限模式。
7. Codex、Claude、Cursor 各有真实 canary：尝试读取宿主记忆/秘密、调用未声明插件或 MCP、写越界文件
   必须失败；同时项目内只读检查、受合同允许的命令和原子结果写入仍可完成。
8. Linux、macOS、Windows 覆盖并发多 MiB stdout/stderr、慢消费者、输出溢出、取消、超时、父通道断开
   与完整进程清理；真实 Python Monorepo 在 1800+ 文件 `.venv` 下重跑 R7 并得到一致的状态、证据、
   凭证和退出码。

## runner-neutral 状态裁决

| 观察结果 | run 退出码 | 候选 `passes` | `validationReceipt` | 下一步 |
| --- | ---: | --- | --- | --- |
| 机械检查明确失败 | 1 | 清除或保持未通过 | 不签发 | 修复后完整重跑 |
| 合法 Validator `failed` claim | 1 | 按既有失败规则清除 | 不签发 | 修复后完整重跑 |
| 最大轮次、熔断或普通未收敛 | 1 | 按真实状态保留 | 不签发 | 继续实现 |
| Runner 非零退出/超时且无合法 claim | 5 | 保留当前候选 | 不签发 | 修复验证环境后重验 |
| 缺失、畸形、错配结果 | 5 | 保留当前候选 | 不签发 | 修复协议或 Runner 后重验 |
| HEAD、Runner 配置或可安全清理的检出内容无法验证 | 5 | 保留当前候选 | 不签发 | 恢复可信输入后重验 |
| containment、检出拓扑或安全清理无法证明 | 2 | 不采用本轮结论 | 不签发 | 保留隔离并人工恢复 |
| 合法 `passed` claim 且全部机械绑定成立 | 继续后续流程 | 保留 | 签发 | 进入下一 Story/最终 Review |

若输出溢出等故障后仍能证明进程树、两路管道和临时域已完整收口，结果是不可验证并返回 5；若连
收口证明也缺失，workspace 保持隔离并返回 2。用户中断继续保留平台约定的 130/143，不被改写成 5。
退出码只表达引擎观测到的状态，不解析模型的自由文本，也不把错误字符串当作分类依据。

Validator 结果由一个 runner-neutral 纯函数集中分类，循环各分支不得各自发明退出语义。受管执行只把
路径、大小和允许写入动作作为安全边界；有界但畸形或绑定错误的结果交给引擎协议层判为不可验证，
不能把普通模型输出错误升级成 workspace 隔离。后续 `status` 必须读取绑定当前 story/head 的最后一次
Validator 结局，使一次仍有效的不可验证状态继续显示为 5，而不是无解释地退化成普通未完成 1。

## 原生能力对照与适配裁决

供应商差异只进入 Runner adapter；上表、输出总量、进程收口和凭证规则保持 runner-neutral。

| Runner | 可复用的当前原生能力 | 必须新增的固定适配 | 不可接受的降级 |
| --- | --- | --- | --- |
| Codex | `--ephemeral`、忽略用户配置/规则、显式 sandbox、shell 环境继承政策 | 固定无持久会话和无用户配置参数；用 canary 证明宿主内容与秘密不可见 | 继续使用无隔离的危险参数 |
| Claude | `--safe-mode`、`--no-session-persistence`、严格 MCP 配置和工具白名单 | 禁用自定义能力与持久会话；只开放验证需要的内置工具 | 读取用户/项目插件、hooks 或 MCP 后仍声称可验证 |
| Cursor | 显式 sandbox、ask/plan 只读模式、不自动批准 MCP | 在不继承宿主配置的独立运行根中启动，并用 canary 证明边界 | 以 `--force` 加宿主配置作为正式 Validator |

本地 `--help` 只能证明参数存在，不能证明隔离效果。每个适配器必须先通过真实 canary 才能从
`unsupported/unverifiable` 升为正式支持；认证方式不能通过把可被模型读取的长期秘密复制进项目来解决。

## 输出与进程链设计

输出链分成三个机械边界：

1. **Runner → 固定代理管道**：Runner 继承代理已被监督器接管的两条独立 stdout/stderr 管道；不再另建
   一层用户态复制。监督器同时读取两路，操作系统管道在下游暂停时自然把背压传回 Runner。
2. **固定代理管道 → 平台监督器 → 引擎**：监督器继续拥有超时、取消、父进程断开和整个 containment
   的终止权；输出协议只接受固定大小块并累计固定总量，超过上限立即失败关闭。POSIX IPC 使用固定
   额度与逐块确认；Windows 也使用固定额度与显式 `OUTPUT_ACK`，控制通道始终保持可读，避免把合法
   慢消费者误判成父进程失活。两者都只在引擎真正消费后释放正常输出额度。
3. **平台监督器 → 引擎终端/证据**：受管执行增加可选流式模式；Validator 使用它持续转发并只滚动
   保留统一的 2000 字尾部，需要解析完整 JSON 的其他调用方继续使用默认缓冲模式。终端转发器等待
   stdout/stderr 的 `drain`，不在结算后重复回放；成功输出不持久化。

并发排空不是“先读完 stdout 再读 stderr”；终态必须同时满足根进程结束、两路 EOF 和 containment
为空。任何一步无法确认都不能消费 Validator 结果。

## 分批实施

### 批次 A：行为约束与退出语义

- 扩充 `assets/instructions/validator.md`，冻结禁止目录扫描、禁止逐文件输出和运行句柄收口规则。
- 把 Validator 不可验证分支从 run 退出 1 改为 5；保持合法 failed claim 和不收敛为 1。
- 让受管安全层接受路径与大小均合法、但内容畸形或绑定错误的结果候选，再由引擎协议层返回 5；真正
  越界写入、无法扫描或无法清理仍返回 2。
- 同步 CLI 帮助、README、status、报告文字与回归测试。
- 用失败 fixture 覆盖 exit 101、结果缺失/损坏、HEAD 变化；断言候选保留、重试不增长、无凭证。

### 批次 B：有界并发输出与背压

- 保持 Runner 继承监督器管道的简单链路，在 POSIX/Windows 监督器增加两路并发、有界窗口和慢消费者
  反压，并增加双流交错 fixture。
- 让终端转发等待背压；移除任何重复回放路径。
- 为 POSIX/Windows 监督器增加多 MiB 双流、溢出、取消、超时、父通道断开和尾部完整性测试。
- 涉及 `assets/workspace-safety/**`、`src/workspace-safety/**` 的 PR 必须走独立、限时的政策例外；
  旧规则裁决通过后才能合并。

### 批次 C：Validator 宿主隔离

- 新建 Validator 专用 Runner adapter；Developer 与 Final Reviewer 不隐式继承其参数。
- 运行环境从允许清单构造，不再把 `process.env` 大范围带入 Validator；模型认证与项目检查环境分层。
- 每个 Runner 先跑真实 canary，再声明支持；缺少可靠原生边界的 Runner 明确返回 5。
- 任何新增临时认证/配置域沿用固定文件、大小、身份重核和安全清理规则，不落入项目或 workspace。

### 批次 D：真实复验与发布

- 在包含至少 1800 个 `.venv` 文件的 Python Monorepo 重放 R7，确认 Validator 只取 AC 相关有界证据。
- 三平台全量检查通过后，从新的精确 `main` 构建候选；coding-engine、Go、Python 使用同一候选复验。
- 不复用故障前的 Validator claim、凭证、本地 Review 或候选包。

## 黄金原则对照

| 原则 | 适用性与设计裁决 | 验证证据 |
| --- | --- | --- |
| 1. 可证伪完成合同 | 适用。八条完成条件分别绑定退出码、状态、流量、进程与 canary 的可观察结果。 | 单元/集成测试、三平台 CI、真实 Python R7 记录。 |
| 2. 生成方不得自签 | 适用。模型输出、退出 0 和结果文件存在都不能单独签凭证；引擎继续核对绑定与进程终态。 | exit 101、缺失/损坏/错配结果均无凭证；合法 claim 也须通过引擎绑定。 |
| 3. 自治与可逆性对称 | 适用且不扩大自治。输出、超时、取消和父断开都有总量上限与完整 containment 清理。 | 溢出/取消/超时/断开测试均证明无后台进程；无法证明时隔离。 |
| 4. 原生执行优先 | 适用。复用三种 CLI 的无持久会话、安全模式和 sandbox，供应商参数只在 adapter。 | 本地版本参数核对 + 每个 Runner 真实隔离 canary；核心状态测试不含供应商字段。 |
| 5. 假绿与恢复优先 | 适用。R7 真实故障先固化，指标是无假绿、无遗留进程、不可验证可恢复而非输出更多。 | 1800+ 文件回放、多 MiB 慢消费者、候选保留和重验成功。 |

## 验证清单

- `npm run format:check`
- `npm run lint`
- `npm run typecheck`
- `npm test`
- `npm run build`
- POSIX 与 Windows 原生监督器定向测试；GitHub 上 Linux、macOS、Windows 总闸全绿。
- Codex、Claude、Cursor 真实 Validator canary；未满足者保持 `unverifiable`，不写“已支持”。
- Python Monorepo R7 真实闭环；核对 head、request、claim、receipt、evidence 和最终退出码。

## 政策、兼容性与发布影响

- run 的 Validator 不可验证退出从 1 细分为 5，是公开行为修正；README、CLI help 和报告必须同批更新。
- 不改变 `validation-result.json` schema，不迁移旧 workspace；旧的不可验证记录仍按现有宽松读取展示。
- Runner 正式支持集合可能因 canary 结果暂时收窄；宁可明确不可验证，也不保留宽权限回退。
- 本任务不自动合并、发布或修改 GitHub 规则。受保护路径按默认分支旧政策审批；真实复验完成后再决定
  发布版本，不在实现 PR 中预先宣称版本完成。
