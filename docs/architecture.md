---
title: 架构地图
status: active
updated: 2026-07-28
scope: root
---

# 架构地图

## 双形态

同一仓库两条产品线，互不依赖：

- **npm 引擎**：`src/` → tsup → `dist/`，`npx coding-x` 运行 Developer ⇄ Validator 循环
- **多工具插件**：根 `skills/`、`commands/`、`hooks/` 为唯一源，`.claude-plugin/`、`.cursor-plugin/`、`.codex-plugin/`、`.agents/` 只放瘦清单或宿主所需的单一接线

## 模块划分

| 模块 | 路径 | 职责 |
|---|---|---|
| CLI 入口 | `src/cli.ts`、`src/cursor-hooks.ts` | 参数解析、启动循环/仪表盘，提供模型/全局配置与 Cursor 项目检查安装、状态、卸载入口；Cursor 安装器只在 Git 根安全管理 `.cursor/` 中归属明确的内容；`help`/`-h`/`--help` 在子命令校验与任何 workspace/runner 副作用前统一短路 |
| 主循环 | `src/engine/loop.ts` | 直接拥有 workspace 锁、仪表盘、Developer ⇄ Validator 逐轮状态机、最终 Review、报告与资源释放；agent 结局机械三分与异常轮处理（no-op 检测、stall 熔断、终轮篡改收口）；按契约检查→TDD 门禁→Validator 排序；生成 Validator 精确目标、消费结构化 claim 后写 verdict/签发凭证；每个真实子进程调用附加调用凭证；完成判定与收敛出口（ADR-009、013、015、016、017、018）。逐轮状态机保留在这里，因为提前退出、证据写入、状态所有权与完成判定共享同一控制流，继续拆成回调会掩盖退出路径 |
| 循环启动预检 | `src/engine/loop-preflight.ts` | 仪表盘和任何 agent 启动前，按既有顺序核对质量契约与固定版本，完成 PRD/State 恢复、TDD 政策、模型目录、最终 Review 模型与冻结检查快照校验；失败只返回既有退出码，成功交回收窄的就绪上下文 |
| 循环指令装配 | `src/engine/loop-instructions.ts` | 读取 Builder/Validator 指令，维护 TDD 工作流片段并渲染 workspace、重试、仲裁与 TDD 占位符；`loop.ts` 继续兼容转出 `renderInstruction` |
| Agent 进程 | `src/engine/agent.ts` | 拉起 claude/codex/cursor headless 子进程、模型参数与超时控制；stdout/stderr 实时 tee 并滚动保留有界尾部，正常路径等 pipe 关闭再返回 duration/exit/output，超时路径计入整棵进程树终止等待 |
| 进程树终止 | `src/engine/process-tree.ts` | agent 与机械门禁共享的跨平台超时收口：POSIX 进程组 SIGTERM→SIGKILL 并确认退出；Windows 等待 `taskkill /T /F`，调用方只在整棵树停止后继续写 workspace |
| PRD 读取 | `src/engine/prd.ts` | 读 prd.json（需求内容） |
| 执行状态 | `src/engine/state.ts` | state.json 读写与迁移、选 story、完成判定、合并视图；`validated` 与结构化 Validator 目标凭证、`escalated` 路由状态由引擎独占；当前 HEAD/有序 AC 的同一判断供循环与展示消费 |
| 验收协议 | `src/engine/validation-protocol.ts` | v1 validation request/result 单源：一次性 request、story/AC hash/Git HEAD 绑定、runner-neutral prompt 合同、固定临时结果路径、64 KiB 严格解析与 fail-closed 错误码（ADR-015） |
| 进度 | `src/engine/progress.ts` | 读取 progress.md |
| 修复 | `src/engine/repair.ts` | jsonrepair 修复 prd.json / state.json |
| 质量契约 | `src/quality/contract.ts` | 严格解析 `.coding-x/quality.json`，规范化摘要、精确版本约束和 PRD 检查快照派生/一致性核对；契约是项目检查唯一人工维护来源 |
| GitHub 交付门禁 | `src/quality/github.ts`、`src/quality/ruleset.ts`、`src/quality/release-ruleset.ts`、`src/doctor/delivery.ts` | 配置并回读默认分支 PR/状态检查规则、发布标签禁止更新/删除规则及不可变 Release；契约明确声明时精确管理代码扫描工具和两类阻断阈值，未声明时保留已有扫描规则；doctor 与最终 Review 对远端漂移 fail-closed |
| 候选发布证据 | `build/release-evidence.mjs`、`.github/workflows/build-candidate.yml`、`.github/workflows/stage-candidate.yml`、`.github/workflows/publish.yml` | 无发布身份的独立工作流完成检查、构建和固定候选包；三仓验证后，stage-only OIDC 工作流回读候选来源与当前 `main`，不安装依赖或执行项目脚本，只暂存同一摘要；标签流程分别核对候选与 staging 运行，只验证已公开 npm 制品并发布不可变 Release，不直接发布 npm |
| 机械门禁与回写 | `src/engine/gate.ts` | 按 test→build→static→security 执行 PRD 中由契约冻结的结构化检查；默认不经 shell，只有契约显式声明时使用指定 shell；超时复用进程树终止单源并等待整棵树退出；门禁/异常轮回写及结构化 Validator pass/fail 的引擎状态转移共享 notes/重试/blocked 规则 |
| TDD 门禁 | `src/engine/tdd-gate.ts` | 严格解析 `prd.json.tdd`；校验 Git 根/完整基线、项目内政策文件真实路径与 SHA-256、生产 pathspec 和基线后新增覆盖忽略标记；通过公共 command runner 执行项目原生 coverageCheck（ADR-017） |
| 模型路由 | `src/engine/models.ts` | 严格校验 runner 绑定的五模型 schema；builder 按 story 难度/升级态/CLI 覆盖解析，validator 恒定，输出实际路由来源 |
| 全局模型目录 | `src/engine/model-catalog.ts` | 解析默认路径与 `CODING_X_CONFIG` 覆盖，严格校验 version 1 schema；只读查询三 runner 的允许模型，并为显式 `config init` 排他创建空模板 |
| 模型预检 | `src/engine/model-preflight.ts` | 循环启动前组合 schema、runner、CLI 覆盖与待执行 story；显式模型策略只允许目录中声明的 ID，无效即停且不启动 agent/dashboard，纯 runner-default 跳过目录 |
| prd 守卫 | `src/engine/prd-guard.ts` | 运行期 prd.json 冻结：首次成功读取建快照，四处检测点校验，篡改自动存档（去重）+快照写回恢复+告警；写回失败信号驱动 loop 跳过该轮 validator（ADR-007） |
| 证据索引 | `src/engine/evidence.ts` | evidence.jsonl 的 schema 单源（iteration/gate-run/tdd-gate/tamper/validation-claim/screenshot-claim 判别联合）与追加/读取；结构化 result 保留 `source=validator` claim，目标/协议/receipt、TDD 门禁与 Builder/Validator 调用凭证保留 `source=engine` 机械观察；有界诊断、坏行与未知 type 均 fail-safe，status/report 按 source 区分信任级别 |
| workspace 锁 | `src/engine/lock.ts`、`src/engine/fs-atomic.ts` | engine.lock 单写者互斥（O_EXCL 原子创建、pid 活性三分支、stale 自动接管、轮首自愈防 agent 误删）；run/repair 持锁，其余子命令不锁；fs-atomic 为 state/prd 关键 JSON 与 report.html 提供 tmp+rename 原子写（ADR-008/014） |
| 知识库体检 | `src/doctor/doctor.ts` | `coding-x doctor` 检查 frontmatter / updated / AGENTS.md 索引 / 相对链接；`docs/archive/` 仍查结构与链接但跳过 updated 新鲜度；另只读核对质量契约、固定版本、PRD 摘要与派生快照、工作区锁、TDD 政策、全局模型目录及 workspace Git 隔离；`--json` 同时提供 prd-to-json 应原样冻结的检查快照，不运行昂贵项目检查 |
| coding-engine 仓库健康 | `src/doctor/repository-health.test.ts` | coding-engine 自身的机械 CI 检查真实文档、质量契约及契约生成文件，不比较候选运行版本；完整 doctor 继续负责正式裁判资格，避免版本 PR 让候选批准自己。该检查只属于 coding-engine，下游仍运行各自原生命令 |
| 状态速览 | `src/status/status.ts` | `coding-x status` 展示 story 状态/难度/升级态、最近实际模型及 invocation outcome/duration/exit/异常诊断、结构化验收 target/protocol/error；state 缺失兼容 legacy、存在但损坏则全部按未验证并退出 1；`--json` 同步输出 `recentActual`、`recentValidation` 与 `stateCorrupted` |
| 验证报告 | `src/report/` | `coding-x report` / 循环结束自动生成 `<workspace>/report.html`；分源展示普通/TDD 门禁、Validator 逐 AC claim 与 engine protocol/receipt，时间线展示两侧调用耗时/退出码/异常输出，协议错误和 Validator 改 state 进红旗；自动路径消费 PRD guard 快照，state 损坏 fail-closed，原子覆盖、零浏览器 JS、全文本转义（ADR-014、015、016、017） |
| 仪表盘 | `src/dashboard/server.ts` | HTTP 服务（:7331）+ 自动开浏览器；分开展示完整配置路由与当前阶段实际命中；state 损坏时 API 标记 `stateCorrupted`、story 全部按未验证并在两套页面警示；`coding-x dashboard` 可离线复用 |
| 引擎指令 | `assets/instructions/` | builder.md / validator.md；静态占位符由 loop 渲染，TDD 启用时 Builder 只引用唯一源 `tdd` skill；Validator 每轮再追加 engine-bound v1 request，自定义 instruction 无占位符也不能绕过协议 |
| TDD 宿主能力 | `skills/tdd/`、`hooks/`、`src/cursor-hooks.ts` | skill 约束逐行为 RED→GREEN→重构；共同 Node hook 在 Codex/Claude 插件和显式安装的 Cursor 项目配置中读取同一 `prd.json.tdd` 提前反馈。Cursor 复制的脚本来自 npm 构建产物；所有宿主检查都不改目标 Git hooks且不拥有最终裁决权（ADR-017） |
| 知识生命周期 | `commands/compound-docs.md` | 基于代码/git/workspace 取证做沉淀、活知识熵 GC 与状态收尾；物理归档有独立授权门，完成态文档迁入冷档案并同步导航 |
| 知识库模板 | `templates/` | /init-docs、/compound-docs 使用的 AGENTS/docs 模板；冷档案 README 只在首次实际归档时生成 |

## 分层与依赖方向

cli → quality + engine（loop → loop-preflight / agent / state / gate / tdd-gate / models / validation-protocol，loop-preflight → quality / prd / state / model-preflight / loop-instructions）；cli 另调用独立的 cursor-hooks 项目适配器。doctor 与 loop-preflight 共用 quality 契约解析和摘要核对。agent 与 gate 共同依赖 process-tree 的终止单源，tdd-gate 复用 gate 的命令 runner。report 模块被 cli 与 loop 调用，反向只读 engine 的 prd/state/progress/tdd-gate 与 gate 的仲裁判定，loop 另把 guard 快照注入自动报告——与 dashboard 同为消费端。loop 启停 dashboard 并推送迭代状态，dashboard 反向只读 `engine/prd.ts`、`engine/state.ts`、`engine/progress.ts` 取数据供 API 使用——两者是双向数据耦合，而非单向依赖。`assets/` 与共同 hook 脚本构建时拷进 `dist/`；CLI 以自身 `import.meta.url` 定位构建后的指令目录，再交给循环指令模块读取，Cursor 适配器读取 `dist/hooks` 后复制到目标项目。`templates/`、`skills/`、`commands/` 与 Codex/Claude hook 配置只随插件仓库分发。

## 数据流

项目知识也分冷热生命周期：`/compound-docs` 默认只对本轮相关 active 文档做沉淀与增量熵 GC，用户显式要求全量时才逐条审计 patterns/glossary/architecture/golden-principles/prompt-writing；任务型文档先以证据收尾 status，再在用户明确授权物理归档后镜像原相对树移入 `docs/archive/`。冷档案继续由 doctor 检查 frontmatter 与相对链接，但不参与 updated 新鲜度，也不进入日常实现/沉淀上下文。

`.coding-x/quality.json` 是项目检查唯一人工维护来源；prd-to-json 先用 doctor 取得规范化摘要和结构化派生快照，再把它们连同源 PRD（意图真相）一起冻结到 workspace `prd.json`（执行需求）并初始化 `state.json`。正式运行要求精确版本、摘要和快照全部一致；候选版本只能 shadow。builder 只实现一个 story 并留下 `passes=true` 候选。契约检查与 TDD 政策/覆盖命令都通过后，引擎才把 story ID、有序 AC 快照/hash、一次性 request ID 与 Git HEAD 注入 Validator；Validator 只写逐 AC 结构化 claim，引擎核对绑定与 state 不变式后才写 retry/blocked/notes 或签发结构化凭证。机械检查失败或合法 Validator failed 才清除实现候选；缺结果、错目标、旧结果、超时或协议异常只撤销验收结论并保留候选进入 validation-only，仍失败关闭且不能进入最终 Review（ADR-009、013、015、017、018、020）。

coding-engine 的 GitHub 与暂存流程不运行候选版本的完整 doctor。它们运行仓库机械健康检查，
只验证文档、契约结构和契约生成文件；完整 doctor 继续拒绝候选版本与固定版本不一致。
首次稳定自举实际使用 0.33.1（0.33.0 已被 npm 判定不可复用），发布前由机械检查和 owner
人工 Bootstrap 裁决，不声称取得正式本地 Review；发布后通过独立 Policy PR 固定 0.33.1，
正式自托管才开始。因此首发阶段的远端总闸成功不表示候选取得正式裁判资格（ADR-018）。

发布链把“构建候选”和“取得 npm 暂存身份”拆成两个独立工作流与权限域。前者执行完整项目
代码但没有发布身份，产物先供三个项目 Dogfood；后者由维护者选择已经验证的候选运行，回读
其来源、成功状态与当前 `main`，只下载固定候选、重建不执行脚本的包目录并核对摘要，OIDC
只能执行 `npm stage publish`。维护者 2FA 批准后仍需三个项目从 registry 验证精确版本，人工
移动 `latest` 后才创建标签；标签固定所选暂存任务、npm stage ID 与候选摘要，标签工作流沿
stage 证据找到原候选运行，分别对账后创建不可变 Release（ADR-018、019）。

workspace 是运行边界：progress 记录学习，evidence 追加普通/TDD 门禁、轮次、篡改、Validator claim、调用凭证、截图等事件；Agent stdout/stderr 实时 tee，异常时只留最近 2000 字符，成功 transcript 不落盘。引擎把绝对项目根和实际 workspace 注入 agent，宿主 hook 只在二者与当前 Git 根配对时使用外部 workspace。`validation-result.json` 只作为单轮瞬时 IPC，调用前清旧、消费后删除，崩溃残留由新 request ID 拒绝。report 从需求、状态与分源证据派生静态报告；`engine.lock` 让 run/repair 单写，关键覆盖写走原子替换。PRD guard 冻结运行期需求并恢复篡改；自动报告沿用该冻结快照，手动报告才读磁盘。state 缺失可迁移 legacy 候选，但缺少与当前 HEAD/有序 AC 一致的结构化凭证时不能恢复绿灯；存在但损坏则所有展示面统一 fail-closed 为未验证（ADR-007、008、014、015、016、017、020）。

全局模型目录声明 runner 可选择的 ID，项目 `prd.json.models` 保存 runner 与五项映射；preflight 只在显式模型策略可能被调用时检查目录成员，loop 再按 difficulty、escalated 与 CLI 覆盖解析本轮模型，并把实际命中写入 evidence。目录是静态允许清单，不证明 provider、认证、配额或网络实时可用；runner-default 与已收敛 workspace 跳过目录（ADR-011、012）。

## 测试

Vitest，测试与源码同目录（`*.test.ts`）；`src/engine/__fixtures__/fake-agent.mjs` 模拟 agent 子进程。
