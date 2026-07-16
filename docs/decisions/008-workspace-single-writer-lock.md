---
title: 008-workspace-single-writer-lock
status: active
updated: 2026-07-16
scope: root
---

# 008. workspace 单写者锁（engine.lock）

## 背景

引擎对「同一 workspace 被多进程同时写」零防护：双终端误开、后台任务被系统 kill 后用户重新拉起（旧进程未死透）、运行中执行 repair——三类真实场景都会造成无痕迹的静默损坏（state 覆盖丢失、evidence.jsonl 轮号交错污染时间线重建、prd-guard 快照互踩致篡改检测失真）。幂等续跑设计恰恰训练用户「觉得死了就重新拉起」，放大了双实例风险。与 ADR-005/007 同族：单写者是「不可共谋」信任链的地基。

## 决策

新模块 `src/engine/lock.ts`：run/repair 启动时以 `writeFileSync(..., { flag: 'wx' })` 原子创建 `<workspace>/engine.lock`（pid/startedAt/command）。已存在时 pid 活性三分支：存活 → 退出码 2 拒绝（报错含手动删锁出路）；已死或锁损坏 → stale 告警自动接管。SIGINT/SIGTERM/exit 钩子清锁；kill -9 遗留交 stale 判定。运行中每轮开头 verify 自愈（agent 误删/改写 → 告警重建）。status/doctor/dashboard/report 只读或幂等覆盖写，不锁。配套 `fs-atomic.ts` 把 state 落盘、门禁打回、prd 归档与恢复四处覆盖写改为 tmp+rename 原子写。

## 理由与备选

- **为什么不引入 proper-lockfile 类库**：违反「引擎唯一运行时依赖 jsonrepair」硬约束；其 mtime 心跳为 NFS/长租约设计，单机 CLI 过度。
- **为什么不用 flock**：Node 无内置绑定，需原生模块。
- **为什么不靠约定（文档告诫勿双开）**：ADR-005 哲学——指令层禁止而无机械强制 = 不成立；无人值守场景没有人盯着防双开。
- **为什么 worktree 并行方案不能替代锁**：多 worktree × 多 workspace 解决「如何有意并行」，锁防的是「意外并发」；锁正是「不共享 workspace」约定的机械执行者，也是未来并行编排器的活性信号载体。
- **为什么 stale 自动接管而非人工删锁**：「被 kill 后重新拉起」是幂等续跑的设计内场景，人工干预会打断无人值守自动化。

## 后果

- 双开被拒（退出码 2）是面向用户的行为变更 → 0.21.0 minor（硬约束 5）。
- pid 复用有小概率误拒（活性判定把无关新进程当持锁者）——报错信息给出手动删锁出路，接受。
- agent 删锁由轮首自愈兜底；两实例同毫秒抢同一把 stale 锁的接管竞态按活锁报错处理，不循环重试。
- `prd-to-json` 再派生属 agent/skill 侧、不受引擎锁约束；skill 指令「派生前查锁」留作后续候选。
- 原子写依赖目标父目录写权限：目录只读但文件可写的场景下，改写由「成功」变为「恢复失败→跳过 validator」（更保守，ADR-007 契约内）；该场景引擎本就无法正常运转（state.json 同样写不进），实际损失≈0。
- repair 对不存在的 workspace 会先建出空目录再因 prd.json 缺失报错（acquireLock 建目录副作用；修改前是直接 ENOENT）——错误信息与退出行为不变，仅多一个空目录，接受。
