---
title: Authority snapshot 已结算失败语义修复
status: done
updated: 2026-08-12
scope: root
---

# Authority snapshot 已结算失败语义修复

## 背景与事实边界

0.34.0 Python Dogfood 在 deep Review 后的最后一次 authority snapshot 中止。对应 operation
已经持久化 `posix-group-empty-and-pipes-eof-v1`、`drainReason=natural` 的结算回执，supervisor
和目标进程组也已结束；但调用方在确认临时域结算前把 `root-failed` 统一抛成“未完整结算”，
导致普通非零退出被误报为 `process-unsettled`，空临时域被保留，真实退出码和 stderr 被覆盖。

旧现场没有持久化被覆盖的 stderr，因此无法断言当时究竟是哪一个 Git、GitHub CLI 或 Runner
子命令失败。Issue #160 跟踪本轮修复；修复后通过真实 Dogfood 重跑取得新证据。

## 完成合同

| 验收标准 | 通过证据 | 失败观察 |
| --- | --- | --- |
| 结算事实与任务结果分离 | 真实 POSIX supervisor 返回 `root-failed` 时先确认临时域已结算，再按非零退出失败 | 已结算失败仍显示 `process-unsettled` |
| 原始诊断不被覆盖 | 错误包含有界的 helper 退出码及原始 stderr marker | 只显示“未完整结算”，无法定位根命令失败 |
| 已结算失败安全清理 | 回执为 natural 且 authority 临时域不残留 | 留下空的只读 authority 目录 |
| 测试清理不误伤并行运行 | 测试只清理本次受管调用返回的精确临时域 | 按全局名称前缀扫描并删除其他运行的目录 |
| 真正异常继续失败关闭 | 现有超时、外部终止和后代残留测试继续要求保留现场并阻断 | 异常进程树被清理或结果被采用 |
| 发布证据重新建立 | 修复通过完整仓库门禁并重建 0.34.0 候选 | 继续沿用旧候选摘要或旧三仓整体结论 |

## 设计裁决

1. 不修改 supervisor、进程组、结算回执或临时目录保护规则，只修正 authority snapshot 消费
   已有强结算结果的顺序。
2. `runManagedWorkspaceProcess` 正常返回即表示 operation 已原子进入 settled archive；
   `root-failed` 表示根任务非零，不表示进程集合未结算。
3. 对无 timeout、无后代残留、无外部终止的返回先调用 `confirmManagedUseSettled()`；随后继续用
   现有退出码和有界 stdout/stderr 路径拒绝非零结果。
4. timeout、`process-tree-not-empty`、外部终止以及 coordinator 直接抛错时仍不确认结算，保留
   既有失败关闭与现场保护语义。本轮不增加重试，避免在尚未取得原始失败证据前扩大行为范围。
5. helper 的失败输出使用固定步骤名及头尾有界详情，不输出内嵌程序堆栈；测试通过受管调用的精确
   `cwd` 观察和清理本次临时域，不再扫描全局名称前缀。

## 黄金原则逐项对照

### 1. 先定义可证伪的完成合同

- **适用性**：适用。上表逐项给出成功证据和失败观察。
- **验证**：真实 supervisor 回归、现有异常矩阵、完整仓库门禁和新候选 Dogfood。

### 2. 生成方不得给自己签发通过

- **适用性**：适用。修复只消费 supervisor 的机械结算回执，不采用 helper 自述。
- **验证**：helper 非零仍必须失败，不能因进程已结算而变成通过。

### 3. 自治范围扩大时同步增加防线与可逆性

- **适用性**：不扩大自治或权限。
- **裁决**：保持所有超时、中断、残留进程和无法取得结算证明的原有阻断；回退本 PR 即恢复旧序。

### 4. 原生执行优先，差异只在控制平面

- **适用性**：适用。
- **裁决**：不新增 Runner 或平台差异，只修正 runner-neutral 控制层状态转换。

### 5. 以假绿率和失败恢复衡量价值

- **适用性**：适用，本轮来自真实 Dogfood 失败。
- **验证**：先加入会在旧实现失败的真实回归；预期减少错误隔离和人工现场判断，不降低任何阻断。

## 实施顺序

1. 先加入真实 POSIX `root-failed` 回归并确认旧实现失败。
2. 最小调整 authority snapshot 的结算确认顺序。
3. 运行定向测试、格式、静态检查、类型检查、全量测试与构建。
4. 独立审查差异，合并后作废旧候选并从新 `main` 重建。
