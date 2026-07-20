---
title: 架构地图
status: active
updated: 2026-07-20
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
| CLI 入口 | `src/cli.ts` | 参数解析、启动循环与仪表盘 |
| 主循环 | `src/engine/loop.ts` | Developer ⇄ Validator 迭代；agent 结局机械三分与异常轮处理（no-op 检测、stall 熔断、终轮篡改收口）；完成判定与收敛出口（ADR-009） |
| Agent 进程 | `src/engine/agent.ts` | 拉起 claude/codex 子进程、超时控制 |
| PRD 读取 | `src/engine/prd.ts` | 读 prd.json（需求内容） |
| 执行状态 | `src/engine/state.ts` | state.json 读写与迁移、选 story、完成判定、合并视图 |
| 进度 | `src/engine/progress.ts` | 读取 progress.md |
| 修复 | `src/engine/repair.ts` | jsonrepair 修复 prd.json / state.json |
| 机械门禁与回写 | `src/engine/gate.ts` | qualityChecks 门禁执行；打回回写（`applyGateFailure`）与异常轮回写待复核（`applyAbortRollback`）共享 notes 保全逻辑；仲裁标签等跨文件 notes 行前缀常量单源 |
| 模型路由 | `src/engine/models.ts` | 读取 prd.json 顶层 models 段（形状校验+警告），解析两阶段模型——builder：CLI 覆盖 > escalation（retryCount ≥ escalateAfter）> story.model > 顶层默认 > 不传；validator 恒定：CLI 覆盖 > 顶层 validator > 不传 |
| prd 守卫 | `src/engine/prd-guard.ts` | 运行期 prd.json 冻结：首次成功读取建快照，四处检测点校验，篡改自动存档（去重）+快照写回恢复+告警；写回失败信号驱动 loop 跳过该轮 validator（ADR-007） |
| 证据索引 | `src/engine/evidence.ts` | evidence.jsonl 的 schema 单源（iteration/gate-run/tamper/screenshot-claim 四类判别联合）与追加/读取（坏行与未知 type 跳过计数）；loop 写机械记录，builder/validator 按指令登记截图，验证报告消费并按 source 区分信任级别 |
| workspace 锁 | `src/engine/lock.ts`、`src/engine/fs-atomic.ts` | engine.lock 单写者互斥（O_EXCL 原子创建、pid 活性三分支、stale 自动接管、轮首自愈防 agent 误删）；run/repair 持锁、只读子命令不锁；fs-atomic 为 state/prd 关键 JSON 提供 tmp+rename 原子写（ADR-008） |
| 知识库体检 | `src/doctor/doctor.ts` | `coding-x doctor` 四项健康检查（frontmatter 完整性 / updated 新鲜度 / AGENTS.md 索引 / 相对链接）；runDoctor/renderDoctorReport 纯函数，cli 渲染并定退出码 |
| 状态速览 | `src/status/status.ts` | `coding-x status` 终端速览 workspace 执行状态（story 通过/阻塞/重试、notes 与仲裁标签、当前 story、最近进展；`--json` 输出机器可读单 JSON 对象）；collectStatus/renderStatusReport/renderStatusJson 纯函数，cli 渲染并定退出码，退出码 0/1/2 可作 CI 门禁 |
| 验证报告 | `src/report/` | `coding-x report` / 循环结束自动生成 `<workspace>/report.html` 静态验证证据存档（story 状态+AC、门禁配置、截图相对引用、review 留痕、篡改红旗区）；collectReport/renderReportHtml/writeReport 纯函数，零浏览器 JS，全文本转义 |
| 仪表盘 | `src/dashboard/server.ts` | HTTP 服务（:7331）+ 自动开浏览器；`coding-x dashboard` 子命令可离线复用 |
| 引擎指令 | `assets/instructions/` | builder.md / validator.md（{{WORKSPACE}} / {{MAX_RETRIES}} / {{ARBITRATION_PREFIXES}} 占位符，loop.ts renderInstruction 渲染） |
| 知识库模板 | `templates/` | /init-docs、/compound-docs 使用的 AGENTS/docs 模板 |

## 分层与依赖方向

cli → engine（loop → agent / prd / state / progress / repair）；report 模块被 cli 与 loop 调用，反向只读 engine 的 prd/state/progress 读取函数与 gate 的仲裁判定——与 dashboard 同为消费端。loop 启停 dashboard 并推送迭代状态，dashboard 反向只读 `engine/prd.ts`、`engine/state.ts`、`engine/progress.ts` 取数据供 API 使用——两者是双向数据耦合，而非单向依赖。`assets/` 构建时拷进 `dist/`，引擎经 `import.meta.url` 定位读取；`templates/`、`skills/`、`commands/` 只随插件仓库分发，引擎不读。

## 数据流

`.workspace/` 里三份文件贯穿全程：`prd.json`（需求，由 `docs/prds/` 源 PRD 经 prd-to-json 派生，顶层 `sourcePrd` 记录来源，运行期只读——引擎以启动快照冻结，磁盘篡改自动恢复并存档，ADR-007）、`state.json`（执行状态，按 story id 键控，引擎首跑初始化并自动从旧格式迁移，agent 回写）与 `progress.md`（日志+学习）。分层真相源（ADR-003）：md 是意图真相（人改），prd.json+state.json 是执行真相（机器改），冲突以 md 为准再派生，执行状态永不回流 md。builder 实现单个 story 并回写 state.json/progress.md → validator 逐条核对 acceptanceCriteria 并回写 passes/notes/retryCount/blocked → 循环直到全部 passes 或 blocked（收敛出口：全通过退出 0，有 blocked 列 story 号退出 3）。任一侧 agent 进程异常结局（超时/非零退出）当轮跳过后续环节：未经验收的 passes 回写待复核、evidence 必留一条 iteration 记录（每轮一条不变式）；空转轮与异常轮连续累计触发 stall 熔断（ADR-009）。循环运行期引擎向 `evidence.jsonl` 追加机械证据（门禁执行含通过、轮次事件、篡改事件），agent 按指令登记截图元数据（AC 级关联）——append-only、坏行只损失自己。循环结束（或手动 `coding-x report`）由三份文件+screenshots/+review 留痕+篡改存档派生 `report.html` 静态验证报告——只读派生物，不回写任何执行状态。循环期间 workspace 根持有 `engine.lock`（启动 O_EXCL 创建、每轮开头自愈核对、结束释放；异常退出遗留的 stale 锁下次启动自动接管）——同一 workspace 同时只有一个写者，run 与 repair 互斥（ADR-008）。

## 测试

Vitest，测试与源码同目录（`*.test.ts`）；`src/engine/__fixtures__/fake-agent.mjs` 模拟 agent 子进程。
