---
title: 007-prd-runtime-freeze
status: active
updated: 2026-07-07
scope: root
---

# 007. 运行期 prd.json 冻结（快照防篡改）

## 背景

ADR-005 宣称机械门禁「不可绕过、不可共谋」，但引擎每轮从磁盘重读 prd.json，而「运行期只读」只是指令约束、无机械强制。三个篡改面：builder 删改 `qualityChecks` 下轮起门禁静默失效；builder 改弱 acceptanceCriteria 则 validator（独立进程直读磁盘）当轮即按假标准验收；删 story 可骗过完成判定提前 exit 0。`.workspace/` 不进 git，篡改无痕迹。外部触发：no-mistakes 源码调研——其「代码执行配置只从受信任默认分支读取」的防御思路，映射到本项目即「只信引擎启动时刻的 prd.json」。

## 决策

新模块 `src/engine/prd-guard.ts`：第一次成功解析 prd.json 时建立快照（原始字符串+解析对象），此后引擎全部 prd 读取（启动、每轮开头、builder 后门禁前、完成判定共四处检测点）收口为 guard.read()——磁盘与快照不一致即篡改：篡改版存档到 `.workspace/prd.tampered-<时间戳>.json`（内容去重）、快照写回磁盘恢复、console 告警（内容去重、含正路指引）、循环继续。写回失败的轮次跳过 validator（磁盘验收标准不可信）。改需求的正路：停引擎 → 修订源 PRD → prd-to-json 再派生 → 重跑（引擎重启即快照合法刷新点）。

## 理由与备选

- **为什么不是仅 qualityChecks 内存快照**：validator 是独立子进程、自己读磁盘的 acceptanceCriteria——内存快照护不住验收面与完成判定面，是半个修复；恢复必须写回磁盘。
- **为什么不终止循环**：无人值守是核心定位，过夜跑一旦触发即整晚停摆；恢复+继续使篡改完全失效，无需戏剧化反应。
- **为什么不写 story notes**：篡改是 PRD 级事件且归因不清（builder/validator/外部进程均可能），写进某个 story 的 notes 会误导 builder 下轮「针对性处理」。留证走存档文件+console。
- **为什么按字符串全等而非语义比较**：运行期没有合法写方，任何字节变化都可疑；格式化差异也是变更，宁严勿松。

## 后果

- 「运行中热更新需求」不再可行（从未被文档承诺；幂等续跑使停机成本≈0）。
- 每轮多两次文件读取与字符串比较（几十 KB 级，可忽略）。
- 新产物文件 `prd.tampered-*.json` 落在 workspace，人审时一眼可见；/review-loop 对其的高亮消费留给后续吸收项。
- state.json 篡改面（builder 批量写 passes=true 跳过 validator 复核）不在本决策范围：state.json 是 agent 合法写入目标、不能冻结，防线是机械门禁+/review-loop+人审。
