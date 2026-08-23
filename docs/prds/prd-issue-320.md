---
title: "Issue #320: 重新实现外部普通文件链接的自适应核对预算"
status: active
updated: 2026-08-23
scope: root
---

# Issue #320: 重新实现外部普通文件链接的自适应核对预算

> GitHub Issue: https://github.com/Xinzz995/coding-engine/issues/320
> Issue-Run-ID: sha256:90e5524288832e949507f1fa2b12ff142370d3023527b4ec52ebc4c3263d9435
> Issue-Body-Digest: sha256:8e84c2eb1c2892c69519019c70fef80f8ab5c96b571e946fe1d7018cebdb22de
> Issue-Execution-Contract-Digest: sha256:64e8fa5fe8181ec4c0bc1e9b56121f8a7a53097170308617515854a809c4a457
> Issue-Remote-Check-Mode: scoped
> Issue-Remote-Check-IDs: -
> Ready-At: 2026-08-23T15:02:28Z

## Goals

重新完成 #207 的功能目标：干净验证检出在冷缓存或高负载机器上核对外部普通文件链接时，使用内部、单调、有硬上限并与真实工作量相关的预算，使 1 GiB 以内可完成的核对不再被固定 30 秒过早打断，同时完整保留身份、内容、挂载、hard link、开发工作树回链和进程收口的失败关闭语义。

本 Issue 承接已关闭 PR #318，但不得继承其成功声明、Validator 结果或运行状态。可以研究其实现与测试，必须重新证明并修复已发现的故障优先级问题。

## Non-Goals

- 不增加用户可调的链接核对超时。
- 不提高 1024 条链接、单文件 256 MiB、去重读取量 1 GiB 的现有限制。
- 不跳过内容摘要、路径解析、文件系统类型、挂载、hard link、前后身份或开发工作树回链检查。
- 不把超时重试、热缓存成功或不完整快照当成放行依据。
- 不修改 Validator 的网络与宿主隔离边界。
- 不自动轮询、多任务排队、自动合并或发布。
- 不复用 #318 的 Story 凭证、最终 Review、远端结果或 ready 到可信 PR 耗时。

## Risk

主要风险有三个：扩大预算会让真正卡死的读取更晚失败；元数据预扫会引入新的身份竞态；错误裁决顺序会把监督或输出故障伪装成普通超时。180 秒硬上限限制最坏等待，前后受管身份复核限制竞态，针对同一时刻多种故障的确定性测试锁定裁决优先级。任何无法建立工作量、进度、最终身份或进程收口证明的情况都继续失败关闭。

**补充验收说明**

- 生产预算使用唯一固定公式：budgetMs = min(180000, 30000 + linkCount * 20 + ceil(distinctTargetBytes / 8388608) * 1000)。linkCount 统计每条链接；distinctTargetBytes 只按稳定去重后的外部普通文件目标计一次。
- 工作量由受管元数据路径机械建立，并继续受 1024 条、单文件 256 MiB、总读取量 1 GiB 上限约束。元数据预扫、代表目标内容读取和最终全链接复核必须对比同一链接与目标身份；漂移、等长改写、重复目标大小或摘要冲突全部失败关闭。
- 在元数据预扫前记录唯一单调起点；工作量确定后，公式得到的绝对期限必须追溯到该起点，并覆盖内容读取、最终链接身份复核以及随后与本次链接核对相关的整树拓扑、挂载和 hard link 复核。预扫尚未得到工作量时只能受 180 秒硬上限保护，不能为后续阶段重新计时。
- 受管 reader、父进程监督期限和预算对象使用同一个绝对期限；任何外层期限都不能更短，也不能给每个文件、批次或最终复核重新获得完整预算。
- 进程结果的裁决顺序必须保留真实故障：中断、输出故障、非正常退出、进程树未清空、未取得结算证明等先按原故障失败；只有监督器明确报告超时，或正常完成后机械发现绝对期限已过，才能报告预算超时。期限边缘不得把其他故障覆盖成普通超时。
- 超时诊断有界且不泄露路径，至少包含 budgetMs、elapsedMs、links、distinctTargets、completedLinks、completedTargets、readBytes、remainingBytes；暂时无法取得的值明确标为 unavailable，不得猜测。
- 确定性测试覆盖零工作量、重复目标只计一次、1024 条与 1 GiB 得到 178480 ms、非法或超限输入拒绝、180 秒硬上限，以及超过旧 30 秒但仍在新预算内的合法完成。
- 故障回归至少覆盖：输出故障与期限同时到达、进程已退出但结算证明缺失、AbortSignal、reader 真超时、正常结果越过绝对期限、目标替换、等长改写、链接回开发树、特殊或远程文件系统。每项都要证明错误类别没有被超时掩盖，且测试不真实等待数分钟。
- 既有外部链接、干净检出、hard link、挂载、进程监督和跨平台回归通过；按照 #319 建立的责任分层只运行并复用实际适用的本地检查，远端交付条件由当前 PR 最新提交裁决，测试前后不得新增 coding-x 临时残留。
- #319 已正式交付并成为当前 0.38.1 稳定执行入口；本 Issue 必须用一次新的 Issue 运行建立唯一分支、唯一 PR 和唯一状态评论，不自动合并，并记录新的 ready 到可信 PR 总时间、实际运行时间、远端等待时间、继续次数与检查执行/跳过清单。

**前置依赖与失败基线**

- 前置依赖：#319 已由 PR #321 交付，并随 coding-x 0.38.1 完成稳定发布；当前前置依赖已满足。
- 失败运行：#207，run sha256:c5bc94e504c5c1d21d7aff0adacfa869099db710a7664aead12c6ce6e314ac6b。
- 失败候选：PR #318，提交 ee4f06bc15f20ad3459597a7222ce2a2613af1cf，现已关闭并保留证据。
- 已确认缺陷：受管读取返回后先检查预算、再检查输出与结算状态，期限边缘可能误报错误类别；新增回归必须先红后绿。

## User Stories

### US-001: 完成 Issue #320

重新完成 #207 的功能目标：干净验证检出在冷缓存或高负载机器上核对外部普通文件链接时，使用内部、单调、有硬上限并与真实工作量相关的预算，使 1 GiB 以内可完成的核对不再被固定 30 秒过早打断，同时完整保留身份、内容、挂载、hard link、开发工作树回链和进程收口的失败关闭语义。

本 Issue 承接已关闭 PR #318，但不得继承其成功声明、Validator 结果或运行状态。可以研究其实现与测试，必须重新证明并修复已发现的故障优先级问题。

#### Execution Contract

```json
{
  "schemaVersion": 1,
  "storyAcceptance": {
    "evidenceSource": "validator",
    "network": "disabled",
    "criteria": [
      "生产预算使用唯一固定公式 budgetMs = min(180000, 30000 + linkCount * 20 + ceil(distinctTargetBytes / 8388608) * 1000)；linkCount 统计每条链接，distinctTargetBytes 对稳定去重后的外部普通文件目标只计一次。",
      "工作量只能由受管 metadata 路径机械建立，并继续受 1024 条链接、单文件 256 MiB、总读取量 1 GiB 上限约束；metadata 预扫、内容读取和最终复核必须绑定同一链接与目标身份，任何漂移或冲突都失败关闭。",
      "元数据预扫前记录唯一单调起点；工作量确定后得到的绝对期限追溯到该起点，并覆盖内容读取、最终链接身份复核以及相关整树拓扑、挂载和 hard link 复核，任何阶段不得重新计时。",
      "受管 reader、父进程监督期限和预算对象必须使用同一绝对期限；外层期限不得更短，也不得给单个文件、批次或最终复核重新分配完整预算。",
      "故障裁决必须保留真实优先级：中断、输出故障、非正常退出、进程树未清空和结算证明缺失先按原故障拒绝；只有明确监督超时或正常结果越过绝对期限时才能报告预算超时。",
      "超时诊断必须有界且不泄露路径，并机械记录 budgetMs、elapsedMs、links、distinctTargets、completedLinks、completedTargets、readBytes、remainingBytes；无法取得的值明确标为 unavailable。",
      "固定公式必须满足零工作量、重复目标去重、1024 条与 1 GiB 得到 178480 ms、非法或超限输入拒绝，以及 180 秒硬上限。",
      "受控慢 I/O 超过旧 30 秒但未超过新预算时能够完成；达到绝对期限时有界失败；目标替换、等长改写、开发树回链、特殊或远程文件系统及监督异常继续失败关闭。"
    ]
  },
  "localChecks": {
    "evidenceSource": "engine",
    "network": "current-host",
    "mode": "scoped",
    "checkIds": [
      "tests"
    ]
  },
  "remoteDelivery": {
    "evidenceSource": "github",
    "network": "github-actions",
    "mode": "scoped",
    "checkIds": [],
    "ruleset": "required"
  },
  "runMetrics": {
    "evidenceSource": "engine-clock",
    "metrics": [
      "ready-to-trusted",
      "active",
      "waiting",
      "continuations"
    ]
  }
}
```

#### Acceptance Criteria

- [ ] 生产预算使用唯一固定公式 budgetMs = min(180000, 30000 + linkCount * 20 + ceil(distinctTargetBytes / 8388608) * 1000)；linkCount 统计每条链接，distinctTargetBytes 对稳定去重后的外部普通文件目标只计一次。
- [ ] 工作量只能由受管 metadata 路径机械建立，并继续受 1024 条链接、单文件 256 MiB、总读取量 1 GiB 上限约束；metadata 预扫、内容读取和最终复核必须绑定同一链接与目标身份，任何漂移或冲突都失败关闭。
- [ ] 元数据预扫前记录唯一单调起点；工作量确定后得到的绝对期限追溯到该起点，并覆盖内容读取、最终链接身份复核以及相关整树拓扑、挂载和 hard link 复核，任何阶段不得重新计时。
- [ ] 受管 reader、父进程监督期限和预算对象必须使用同一绝对期限；外层期限不得更短，也不得给单个文件、批次或最终复核重新分配完整预算。
- [ ] 故障裁决必须保留真实优先级：中断、输出故障、非正常退出、进程树未清空和结算证明缺失先按原故障拒绝；只有明确监督超时或正常结果越过绝对期限时才能报告预算超时。
- [ ] 超时诊断必须有界且不泄露路径，并机械记录 budgetMs、elapsedMs、links、distinctTargets、completedLinks、completedTargets、readBytes、remainingBytes；无法取得的值明确标为 unavailable。
- [ ] 固定公式必须满足零工作量、重复目标去重、1024 条与 1 GiB 得到 178480 ms、非法或超限输入拒绝，以及 180 秒硬上限。
- [ ] 受控慢 I/O 超过旧 30 秒但未超过新预算时能够完成；达到绝对期限时有界失败；目标替换、等长改写、开发树回链、特殊或远程文件系统及监督异常继续失败关闭。

## Delivery Boundary

- 只在分支 `codex/issue-320` 和对应 PR 内交付；不自动合并、不发布。
- Builder 的自述不构成完成；以引擎凭证、最终 Review 和当前 PR 远端总闸为准。
