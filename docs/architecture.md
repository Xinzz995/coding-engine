---
title: 架构地图
status: active
updated: 2026-07-22
scope: root
---

# 架构地图

## 双形态

同一仓库两条产品线，互不依赖：

- **npm 引擎**：`src/` → tsup → `dist/`，`npx coding-x` 运行 Developer ⇄ Validator 循环
- **多工具插件**：根 `skills/`、`commands/` 为唯一源，`.claude-plugin/`、`.cursor-plugin/`、`.codex-plugin/`、`.agents/` 各放一个瘦清单指回

## 模块划分

| 模块 | 路径 | 职责 |
|---|---|---|
| CLI 入口 | `src/cli.ts` | 参数解析、启动循环/仪表盘，提供 `models` 全局目录查询与 `config path/init/validate` 入口；`help`/`-h`/`--help` 在子命令校验与任何 workspace/runner 副作用前统一短路 |
| 主循环 | `src/engine/loop.ts` | Developer ⇄ Validator 迭代；agent 结局机械三分与异常轮处理（no-op 检测、stall 熔断、终轮篡改收口）；生成 Validator 精确目标、消费结构化 claim 后写 verdict/签发凭证；完成判定与收敛出口（ADR-009、ADR-013、ADR-015） |
| Agent 进程 | `src/engine/agent.ts` | 拉起 claude/codex/cursor 子进程、模型参数与超时控制 |
| 进程树终止 | `src/engine/process-tree.ts` | agent 与机械门禁共享的跨平台超时收口：POSIX 进程组 SIGTERM→SIGKILL 并确认退出；Windows 等待 `taskkill /T /F`，调用方只在整棵树停止后继续写 workspace |
| PRD 读取 | `src/engine/prd.ts` | 读 prd.json（需求内容） |
| 执行状态 | `src/engine/state.ts` | state.json 读写与迁移、选 story、完成判定、合并视图；`validated` 验收凭证与 `escalated` 路由状态由引擎独占 |
| 验收协议 | `src/engine/validation-protocol.ts` | v1 validation request/result 单源：一次性 request、story/AC hash/Git HEAD 绑定、runner-neutral prompt 合同、固定临时结果路径、64 KiB 严格解析与 fail-closed 错误码（ADR-015） |
| 进度 | `src/engine/progress.ts` | 读取 progress.md |
| 修复 | `src/engine/repair.ts` | jsonrepair 修复 prd.json / state.json |
| 机械门禁与回写 | `src/engine/gate.ts` | qualityChecks 门禁执行；超时复用进程树终止单源并等待整棵树退出；门禁/异常轮回写及结构化 Validator pass/fail 的引擎状态转移共享 notes/重试/blocked 规则；仲裁标签等跨文件 notes 行前缀常量单源 |
| 模型路由 | `src/engine/models.ts` | 严格校验 runner 绑定的五模型 schema；builder 按 story 难度/升级态/CLI 覆盖解析，validator 恒定，输出实际路由来源 |
| 全局模型目录 | `src/engine/model-catalog.ts` | 解析默认路径与 `CODING_X_CONFIG` 覆盖，严格校验 version 1 schema；只读查询三 runner 的允许模型，并为显式 `config init` 排他创建空模板 |
| 模型预检 | `src/engine/model-preflight.ts` | 循环启动前组合 schema、runner、CLI 覆盖与待执行 story；显式模型策略只允许目录中声明的 ID，无效即停且不启动 agent/dashboard，纯 runner-default 跳过目录 |
| prd 守卫 | `src/engine/prd-guard.ts` | 运行期 prd.json 冻结：首次成功读取建快照，四处检测点校验，篡改自动存档（去重）+快照写回恢复+告警；写回失败信号驱动 loop 跳过该轮 validator（ADR-007） |
| 证据索引 | `src/engine/evidence.ts` | evidence.jsonl 的 schema 单源（iteration/gate-run/tamper/validation-claim/screenshot-claim 判别联合）与追加/读取；结构化 result 保留 `source=validator` claim，目标/协议/receipt 保留 `source=engine` 机械判定；有界诊断、坏行与未知 type 均 fail-safe，status/report 按 source 区分信任级别 |
| workspace 锁 | `src/engine/lock.ts`、`src/engine/fs-atomic.ts` | engine.lock 单写者互斥（O_EXCL 原子创建、pid 活性三分支、stale 自动接管、轮首自愈防 agent 误删）；run/repair 持锁，其余子命令不锁；fs-atomic 为 state/prd 关键 JSON 与 report.html 提供 tmp+rename 原子写（ADR-008/014） |
| 知识库体检 | `src/doctor/doctor.ts` | `coding-x doctor` 检查 frontmatter / updated / AGENTS.md 索引 / 相对链接；`docs/archive/` 仍查结构与链接但跳过 updated 新鲜度；另核对工作区锁、机械门禁、全局模型目录/PRD 映射与 workspace Git 隔离（ignore + 已跟踪文件） |
| 状态速览 | `src/status/status.ts` | `coding-x status` 展示 story 状态/难度/升级态、模型实际命中与最近结构化验收 target/protocol/error；state 缺失兼容 legacy、存在但损坏则全部按未验证并退出 1；`--json` 同步输出 `recentValidation` 与 `stateCorrupted` |
| 验证报告 | `src/report/` | `coding-x report` / 循环结束自动生成 `<workspace>/report.html`；分源展示 Validator 逐 AC claim 与 engine protocol/receipt，协议错误和 state 改写进红旗；自动路径消费 PRD guard 快照，state 损坏 fail-closed，原子覆盖、零浏览器 JS、全文本转义（ADR-014、015） |
| 仪表盘 | `src/dashboard/server.ts` | HTTP 服务（:7331）+ 自动开浏览器；分开展示完整配置路由与当前阶段实际命中；state 损坏时 API 标记 `stateCorrupted`、story 全部按未验证并在两套页面警示；`coding-x dashboard` 可离线复用 |
| 引擎指令 | `assets/instructions/` | builder.md / validator.md；静态占位符由 loop 渲染，Validator 每轮再追加 engine-bound v1 request，自定义 instruction 无占位符也不能绕过协议 |
| 知识生命周期 | `commands/compound-docs.md` | 基于代码/git/workspace 取证做沉淀、活知识熵 GC 与状态收尾；物理归档有独立授权门，完成态文档迁入冷档案并同步导航 |
| 知识库模板 | `templates/` | /init-docs、/compound-docs 使用的 AGENTS/docs 模板；冷档案 README 只在首次实际归档时生成 |

## 分层与依赖方向

cli → engine（loop → agent / prd / state / progress / models / model-preflight / model-catalog / repair）；agent 与 gate 共同依赖 process-tree 的终止单源。report 模块被 cli 与 loop 调用，反向只读 engine 的 prd/state/progress 读取函数与 gate 的仲裁判定，loop 另把 guard 快照注入自动报告——与 dashboard 同为消费端。loop 启停 dashboard 并推送迭代状态，dashboard 反向只读 `engine/prd.ts`、`engine/state.ts`、`engine/progress.ts` 取数据供 API 使用——两者是双向数据耦合，而非单向依赖。`assets/` 构建时拷进 `dist/`，引擎经 `import.meta.url` 定位读取；`templates/`、`skills/`、`commands/` 只随插件仓库分发，引擎不读。

## 数据流

项目知识也分冷热生命周期：`/compound-docs` 默认只对本轮相关 active 文档做沉淀与增量熵 GC，用户显式要求全量时才逐条审计 patterns/glossary/architecture/golden-principles/prompt-writing；任务型文档先以证据收尾 status，再在用户明确授权物理归档后镜像原相对树移入 `docs/archive/`。冷档案继续由 doctor 检查 frontmatter 与相对链接，但不参与 updated 新鲜度，也不进入日常实现/沉淀上下文。

源 PRD（意图真相）经 prd-to-json 派生为 workspace `prd.json`（执行需求）并初始化 `state.json`；builder 只实现一个 story并留下 `passes=true` 候选。机械门禁通过后，引擎把 story ID、有序 AC 快照/hash、一次性 request ID 与 Git HEAD 注入 Validator；Validator 只写逐 AC 结构化 claim，引擎核对绑定与 state 不变式后才写 retry/blocked/notes 或签发 `validated=true`。缺结果、错目标、旧结果、产物变化或 state 改写全部回滚候选态。异常/no-op/验收不完整轮不会带走未签发的通过态，全部 story 有效通过或 blocked 时分别以 0/3 收敛（ADR-009、013、015）。

workspace 是运行边界：progress 记录学习，evidence 追加门禁/轮次/篡改/Validator claim/截图等事件；`validation-result.json` 只作为单轮瞬时 IPC，调用前清旧、消费后删除，崩溃残留由新 request ID 拒绝。report 从需求、状态与分源证据派生静态报告；`engine.lock` 让 run/repair 单写，关键覆盖写走原子替换。PRD guard 冻结运行期需求并恢复篡改；自动报告沿用该冻结快照，手动报告才读磁盘。state 缺失可迁移 legacy，存在但损坏则所有展示面统一 fail-closed 为未验证（ADR-007、008、014、015）。

全局模型目录声明 runner 可选择的 ID，项目 `prd.json.models` 保存 runner 与五项映射；preflight 只在显式模型策略可能被调用时检查目录成员，loop 再按 difficulty、escalated 与 CLI 覆盖解析本轮模型，并把实际命中写入 evidence。目录是静态允许清单，不证明 provider、认证、配额或网络实时可用；runner-default 与已收敛 workspace 跳过目录（ADR-011、012）。

## 测试

Vitest，测试与源码同目录（`*.test.ts`）；`src/engine/__fixtures__/fake-agent.mjs` 模拟 agent 子进程。
