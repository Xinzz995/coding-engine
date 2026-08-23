---
title: POSIX 不透明 Runner 自然结算窗口修复
status: active
updated: 2026-08-23
scope: root
---

# POSIX 不透明 Runner 自然结算窗口修复

## 背景与边界

Issue #208 的真实失败发生在 POSIX 自托管负载：Runner 根进程已经自然返回数字结果，但仍在同一
launcher 组内的合法测试夹具和继承输出会在默认 5 秒之后才自然结束。当前 helper 在首段等待结束
后立即把它判为 `process-tree-not-empty`，随后对 opaque Runner 永久失败关闭，导致已经完成的
Builder 无法进入独立 Validator。

本轮保留普通 POSIX 命令、Windows Job Object、外部终止和自然 signal 的原合同。只对
`opaque-runner + 自然数字 RESULT` 增加第二段自然观察，总自然结算预算固定不超过 30 秒；第二段
不发送 TERM/KILL。到期仍不能同时证明 launcher-only、stdout/stderr EOF 和输出确认清空时，不安装
receipt，继续永久 `operation-proof-missing`。

## 可证伪完成合同

| 验收标准 | 失败时观察 | 验证证据 |
| --- | --- | --- |
| 默认 5 秒后、30 秒内自然清空的 opaque Runner 仍按 natural 完成 | 5 秒处被终止或永久隔离 | 使用默认预算的真实进程回归：后代延迟自然退出、完整输出、调用耗时包含等待 |
| 第二段只接受自然数字 RESULT，且期间不发送 TERM/KILL | signal、外部终止或残留被放行，或延迟后代收到 TERM | 自然 signal、timeout、interrupt、output-failure 既有回归；TERM 标记反例 |
| 30 秒总窗口到期后保持永久失败关闭 | 安装 natural receipt、释放 workspace 或允许后续调用 | 缩短内部测试预算的到期回归，断言无 receipt 且 quarantine 为 `operation-proof-missing` |
| 到期诊断只包含有界结算事实 | 缺预算/成员数/EOF/待确认输出，或打印成员明细 | 精确字段断言与禁止 PID/成员数组断言 |
| 普通 POSIX、Windows 和快速自然退出不变 | 普通命令也等待第二段，或 Windows 合同变化 | 既有平台回归、完整测试、构建与静态检查 |
| 当前自托管运行能从 Builder 继续到独立 Validator | Builder 自述直接被当成最终通过，或仍停在结算失败 | 本轮只写候选状态；由引擎随后启动并绑定独立 Validator 证据 |

## 设计裁决

1. 第二段预算属于 POSIX adapter 的内部配置，生产默认固定为 30 秒；不进入公共跨平台配置，也不
   改变磁盘协议或 receipt 语义。内部可缩短该预算以构造确定性到期测试。
2. helper 收到根 RESULT 时只建立一次绝对自然结算截止点。首段仍使用现有 `naturalDrainMs`
   （生产默认 5 秒），第二段只消费同一截止点的剩余时间，不能因事件或轮询重置。
3. 父进程与 helper 使用同一预算值；父进程额外保留现有终止预算，以便接收有界失败诊断并安装
   永久 quarantine。自然结算预算本身仍在 30 秒结束。
4. 第二段只观察 launcher 组成员数量、两个输出 EOF 和待确认输出数量，不使用裸 PID/PPID/PGID
   推断 opaque Runner 的内部命令域，也不输出成员列表。
5. 到期后 helper 发送有界失败诊断，再沿用既有失败关闭清理；它不签 natural receipt。外层组的
   后备 KILL 只能用于清理，不能升级为 opaque Runner 完整证明。

## 黄金原则逐项对照

1. **可证伪合同**：上表逐条绑定成功、失败信号和测试证据；第 5 条保留给引擎独立 Validator，
   Builder 的 `passes=true` 仍只是候选声明。
2. **独立证据**：完成由固定 helper 的进程组、EOF、输出确认、磁盘 receipt/quarantine 和引擎
   Validator 裁决，不采用 Runner 自述。
3. **自治与可逆性**：不扩大权限或自动恢复范围；等待严格有界，到期仍永久隔离。回退只需移除
   第二段默认预算与诊断，不迁移现有 workspace。
4. **原生能力与控制平面**：继续使用 Runner 原生命令执行；变化只在 POSIX 监督 adapter，Windows
   Job Object、普通项目命令和 runner-neutral 状态合同不变。
5. **假绿与恢复**：先用 5 秒后才自然结束的真实后代重现失败，再覆盖成功、到期、signal 和外部
   终止。目标是消除合法自托管负载的假失败，同时保持到期残留零假绿、零自动跨轮继续。

## 实施与验证顺序

1. 增加默认预算延迟自然退出回归和缩短预算的到期诊断回归，先确认旧实现失败。
2. 在 POSIX helper 与父进程加入同一绝对第二段预算，保持其他路径不变。
3. 重跑定向回归，再运行本次改动路径对应的格式、lint、类型、完整测试、旧版本兼容、构建与 CLI
   冒烟。
4. 提交候选后由当前自托管运行继续独立 Validator；不在 Builder 阶段自签最终通过。

## 当前候选证据

- 旧实现上的两个失败回归均稳定失败：默认 5 秒后把合法后代升级为永久隔离；到期错误缺少结算
  诊断。
- 修复后的默认预算回归证明 5 秒之后自然结束的后代按 natural 完成，完整输出返回，调用耗时包含
  全部等待，且第二段未收到 TERM/INT。
- 缩短内部预算的到期回归证明无 receipt、永久 `operation-proof-missing`，诊断只包含预算、成员数量、
  stdout/stderr EOF 和待确认输出数量；超过 30 秒的配置在执行前被拒绝。
- 完整测试通过：158 个文件、2527 条测试通过；6 个文件和 77 条平台不适用测试跳过。旧版本兼容、
  格式、lint、类型、构建、CLI 冒烟和仓库健康检查均通过。
- 当前自托管 Builder 只形成候选；第 5 条验收标准仍由提交后的独立 Validator 和引擎目标绑定裁决。
