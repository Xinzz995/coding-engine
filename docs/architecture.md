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
| CLI 入口 | `src/cli.ts` | 参数解析、启动循环/仪表盘，提供 `models` 全局目录查询与 `config path/init/validate` 入口 |
| 主循环 | `src/engine/loop.ts` | Developer ⇄ Validator 迭代；agent 结局机械三分与异常轮处理（no-op 检测、stall 熔断、终轮篡改收口）；validator 正常完成后签发验收凭证；完成判定与收敛出口（ADR-009、ADR-013） |
| Agent 进程 | `src/engine/agent.ts` | 拉起 claude/codex/cursor 子进程、模型参数与超时控制 |
| 进程树终止 | `src/engine/process-tree.ts` | agent 与机械门禁共享的跨平台超时收口：POSIX 进程组 SIGTERM→SIGKILL 并确认退出；Windows 等待 `taskkill /T /F`，调用方只在整棵树停止后继续写 workspace |
| PRD 读取 | `src/engine/prd.ts` | 读 prd.json（需求内容） |
| 执行状态 | `src/engine/state.ts` | state.json 读写与迁移、选 story、完成判定、合并视图；`validated` 验收凭证与 `escalated` 路由状态由引擎独占 |
| 进度 | `src/engine/progress.ts` | 读取 progress.md |
| 修复 | `src/engine/repair.ts` | jsonrepair 修复 prd.json / state.json |
| 机械门禁与回写 | `src/engine/gate.ts` | qualityChecks 门禁执行；超时复用进程树终止单源并等待整棵树退出；打回回写（`applyGateFailure`）与异常轮回写待复核（`applyAbortRollback`）共享 notes 保全逻辑；仲裁标签等跨文件 notes 行前缀常量单源 |
| 模型路由 | `src/engine/models.ts` | 严格校验 runner 绑定的五模型 schema；builder 按 story 难度/升级态/CLI 覆盖解析，validator 恒定，输出实际路由来源 |
| 全局模型目录 | `src/engine/model-catalog.ts` | 解析默认路径与 `CODING_X_CONFIG` 覆盖，严格校验 version 1 schema；只读查询三 runner 的允许模型，并为显式 `config init` 排他创建空模板 |
| 模型预检 | `src/engine/model-preflight.ts` | 循环启动前组合 schema、runner、CLI 覆盖与待执行 story；显式模型策略只允许目录中声明的 ID，无效即停且不启动 agent/dashboard，纯 runner-default 跳过目录 |
| prd 守卫 | `src/engine/prd-guard.ts` | 运行期 prd.json 冻结：首次成功读取建快照，四处检测点校验，篡改自动存档（去重）+快照写回恢复+告警；写回失败信号驱动 loop 跳过该轮 validator（ADR-007） |
| 证据索引 | `src/engine/evidence.ts` | evidence.jsonl 的 schema 单源（iteration/gate-run/tamper/screenshot-claim 四类判别联合）与追加/读取（坏行与未知 type 跳过计数）；loop 写机械记录，builder/validator 按指令登记截图，验证报告消费并按 source 区分信任级别 |
| workspace 锁 | `src/engine/lock.ts`、`src/engine/fs-atomic.ts` | engine.lock 单写者互斥（O_EXCL 原子创建、pid 活性三分支、stale 自动接管、轮首自愈防 agent 误删）；run/repair 持锁，其余子命令不锁；fs-atomic 为 state/prd 关键 JSON 与 report.html 提供 tmp+rename 原子写（ADR-008/014） |
| 知识库体检 | `src/doctor/doctor.ts` | `coding-x doctor` 检查 frontmatter / updated / AGENTS.md 索引 / 相对链接，并核对工作区锁、机械门禁、全局模型目录/PRD 映射与 workspace Git 隔离（ignore + 已跟踪文件）；runDoctor/renderDoctorReport 纯函数，cli 渲染并定退出码 |
| 状态速览 | `src/status/status.ts` | `coding-x status` 展示 story 状态/难度/升级态、配置模型路由与 evidence 中最近实际命中；state 缺失兼容 legacy、存在但损坏则全部按未验证并退出 1；`--json` 输出同等机器可读字段与 `stateCorrupted`，退出码 0/1/2 可作 CI 门禁 |
| 验证报告 | `src/report/` | `coding-x report` / 循环结束自动生成 `<workspace>/report.html` 静态验证证据存档；自动路径消费 PRD guard 冻结快照，手动路径读磁盘，state 损坏 fail-closed，writeReport 原子覆盖；collect/render 分层，零浏览器 JS，全文本转义（ADR-014） |
| 仪表盘 | `src/dashboard/server.ts` | HTTP 服务（:7331）+ 自动开浏览器；分开展示完整配置路由与当前阶段实际命中；state 损坏时 API 标记 `stateCorrupted`、story 全部按未验证并在两套页面警示；`coding-x dashboard` 可离线复用 |
| 引擎指令 | `assets/instructions/` | builder.md / validator.md（{{WORKSPACE}} / {{MAX_RETRIES}} / {{ARBITRATION_PREFIXES}} 占位符，loop.ts renderInstruction 渲染） |
| 知识库模板 | `templates/` | /init-docs、/compound-docs 使用的 AGENTS/docs 模板 |

## 分层与依赖方向

cli → engine（loop → agent / prd / state / progress / models / model-preflight / model-catalog / repair）；agent 与 gate 共同依赖 process-tree 的终止单源。report 模块被 cli 与 loop 调用，反向只读 engine 的 prd/state/progress 读取函数与 gate 的仲裁判定，loop 另把 guard 快照注入自动报告——与 dashboard 同为消费端。loop 启停 dashboard 并推送迭代状态，dashboard 反向只读 `engine/prd.ts`、`engine/state.ts`、`engine/progress.ts` 取数据供 API 使用——两者是双向数据耦合，而非单向依赖。`assets/` 构建时拷进 `dist/`，引擎经 `import.meta.url` 定位读取；`templates/`、`skills/`、`commands/` 只随插件仓库分发，引擎不读。

## 数据流

`.workspace/` 里三份文件贯穿全程：`prd.json`（需求，由 `docs/prds/` 源 PRD 经 prd-to-json 派生，顶层 `sourcePrd` 记录来源，运行期只读——引擎以启动快照冻结，磁盘篡改自动恢复并存档，ADR-007）、`state.json`（执行状态，按 story id 键控，引擎首跑初始化并自动从旧格式迁移；agent 回写结果字段，引擎独占 `validated`/`escalated`）与 `progress.md`（日志+学习）。分层真相源（ADR-003）：md 是意图真相（人改），prd.json+state.json 是执行真相（机器改），冲突以 md 为准再派生，执行状态永不回流 md。workspace 是运行时边界：默认应被 Git 忽略或放在当前仓库之外；prd-to-json 写入前机械检查 ignore/索引状态，doctor 可随时只读复核，二者均不代替用户修改 `.gitignore` 或 Git 索引。builder 实现单个 story 并通过检查后，只提交实现、测试与必要文档，再回写 `passes=true` 候选结果与 progress.md → validator 逐条核对 acceptanceCriteria 并回写 passes/notes/retryCount/blocked → validator 正常完成且候选仍通过时，引擎签发 `validated=true` → 循环直到全部 story 有效通过（`passes && validated`）或 blocked（收敛出口：全通过退出 0，有 blocked 列 story 号退出 3，ADR-013）。任一侧 agent 进程异常结局（超时/非零退出），或 validator 未实际完成时，当轮不签发凭证：未经验收的 passes 回写待复核、evidence 必留一条 iteration 记录（每轮一条不变式）；空转轮与异常轮连续累计触发 stall 熔断（ADR-009）。循环运行期引擎向 `evidence.jsonl` 追加机械证据（门禁执行含通过、轮次事件、凭证/篡改事件），agent 按指令登记截图元数据（AC 级关联）——append-only、坏行只损失自己。循环结束（或手动 `coding-x report`）由三份文件+screenshots/+review 留痕+篡改存档派生 `report.html` 静态验证报告——只读派生物，不回写任何执行状态。循环期间 workspace 根持有 `engine.lock`（启动 O_EXCL 创建、每轮开头自愈核对、结束释放；异常退出遗留的 stale 锁下次启动自动接管）——同一 workspace 同时只有一个写者，run 与 repair 互斥（ADR-008）。

可信收口（ADR-014）进一步收紧这条数据流：loop 的自动报告消费终轮 guard 返回的冻结 PRD 快照并标记来源，不在锁内重新相信磁盘；手动 report 才读取当前磁盘 PRD。state 文件缺失可走 legacy 迁移，文件存在但损坏则由 `readDisplayState` 让 report/status/dashboard 三个消费方统一把所有 story 按未验证渲染；手动报告与 status 退出 1，status JSON/dashboard API 另显式标记 `stateCorrupted`，两套 dashboard 页面显示修复警示。`prd-to-json` 在任何 workspace 变更前与首次真实写入前各消费一次 doctor 的工作区锁结论；活锁或无法判定时零写入，不删除 `engine.lock`。双次检查只缩小 TOCTOU 窗口，不等价于持锁。

模型路由有两层真相源：用户级 `~/.config/coding-x/config.json`（可由 `CODING_X_CONFIG` 覆盖）声明各 runner 允许选择的模型 ID；项目 `prd.json.models` 保存当前 runner 与五项路由映射。`prd-to-json` 在 story 定稿后只读全局目录，让用户从中选择五个模型，并按仓库事实派生每个 story 的 `difficulty/difficultyReason` → 启动时 preflight 严格校验 schema、runner，以及本次可能实际调用的 ID 是否在目录中 → loop 按 `difficulty + state.escalated + CLI override` 解析本轮实际模型 → agent 返回后引擎恢复 agent 对 `validated`/`escalated` 的任何改写，并把实际模型、来源、档位、升级触发与凭证事件写入 `evidence.jsonl` → dashboard/status/report 分开展示「配置路由」与「实际命中」，不用前者伪装后者。

全局模型目录是静态允许声明，不是 provider 实时可用性证明；`models`、preflight、doctor 与 skill 都不会为此拉起 runner、检查认证或访问网络。存在待执行 story，并且（启用项目路由或传入任一 CLI 模型覆盖）时，必须通过目录成员检查；无显式策略的 runner-default 路径和已收敛 workspace 都跳过目录。若 PRD 缺失/损坏而 loop 仍进入修复轮，CLI 覆盖也必须先通过目录，不能借异常输入绕过。全局文件不属于 workspace，不受 `engine.lock` 管理，也不进入运行归档或 evidence；除用户显式执行 `config init` 外，各路径均只读。

## 测试

Vitest，测试与源码同目录（`*.test.ts`）；`src/engine/__fixtures__/fake-agent.mjs` 模拟 agent 子进程。
