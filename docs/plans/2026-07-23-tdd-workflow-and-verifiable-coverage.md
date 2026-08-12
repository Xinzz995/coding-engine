---
title: "TDD 工作流与可验证覆盖率实施计划"
status: done
updated: 2026-08-12
scope: root
---

# TDD 工作流与可验证覆盖率实施计划

**Goal:** 交付一套 Codex、Claude Code、Cursor、coding-x 共用的 TDD 工作流：skill 约束红→绿→重构，Codex/Claude 插件 hook 与 Cursor 项目级检查在 agent commit 前提前反馈，引擎在 Validator 前以受保护的同一覆盖率命令作最终裁决。

**设计规格:** `docs/specs/2026-07-23-tdd-workflow-and-verifiable-coverage-design.md`

**实施前提:** 用户批准设计规格；Archive 目录保持只读；本轮不提交、不推送、不打 tag、不发布。

## 完成合同

1. `skills/tdd/` 保留参考 skill 的行为测试、垂直切片、边界模拟和绿色重构原则，并加入真实 RED/GREEN、双模式审批、覆盖率门禁与可信边界。
2. `.workspace/prd.json` 支持严格的可选 `tdd` 配置；未启用完全兼容，启用后非法配置和不可信政策面 fail closed。
3. `prd-to-json` 只在用户确认真实命令、政策文件、基线和忽略标记后写入；写入前真实跑通基线，不能把缺工具、零测试或已有红灯带进无人值守循环。
4. Codex/Claude Code 共用插件内 `hooks/hooks.json`；Cursor 由
   `coding-x hooks cursor install` 显式安装项目配置和同一脚本的构建副本。失败统一 exit 2，
   Cursor 成功返回原生明确放行结果。
5. 引擎每轮在 Validator 前独立执行 TDD 门禁，失败使用既有打回/升级/blocked 语义，并写来源明确的 evidence。
6. Validator 不新增 AI 测试质量评分；README 与设计决策明确覆盖率、hook、Validator 和未来变异测试各自边界。
7. 单元、合同、构建产物、临时仓库 E2E、Codex/Cursor 真实检查通过；Claude Code 若账户仍
   返回 402，保留真实 hook 待补验，不宣称四端全部完成。

## 黄金原则对照

| 原则 | 适用性与设计裁决 | 计划验证证据 |
|---|---|---|
| 1. 完成必须可证伪 | 适用。RED/GREEN、政策摘要、命令退出、超时、hook 阻断和引擎打回均有正反例；“真正 TDD”“高质量测试”不作模糊自动结论。 | skill 合同测试；配置矩阵；hook/engine 成功、失败、超时、零配置回归；真实宿主 smoke。 |
| 2. 生成者不能自签 | 适用。agent 的 RED/GREEN 记录只是声明；宿主 hook 仅提前反馈；最终结果由引擎重新执行并写 `source=engine` evidence。Validator 仍是 claim，不升级为假测试证明。 | hook 通过但引擎重跑失败时不得签发 validation receipt；report 区分过程声明、hook 与 engine 事实。 |
| 3. 自主性与风险对称 | 适用。新增命令执行沿用 10 分钟超时和进程树终止；阈值/排除/零测试政策受摘要保护；合法政策变化必须停机并重新确认。Cursor 安装器只显式、原子地管理归属明确的项目文件，拒绝冲突与用户修改，不改 Git 索引、提交或 Git hooks。 | 缺文件、摘要变化、非法路径、超时、进程树、运行中新增 ignore marker 回归；Cursor 非 Git、非法 JSON、结构冲突、符号链接、修改后拒绝、回滚与安全卸载。 |
| 4. 复用原生执行面 | 适用。覆盖率计算交给项目原生工具；Codex/Claude 复用插件 hook，Cursor 复用当前 CLI 实际执行的项目 `.cursor/hooks.json`；差异止于安装适配与输入归一，核心 TDD/引擎合同无供应商字段。 | 三种输入归一测试；引擎类型无 provider 分支；真实 Cursor CLI 对插件级与项目级配置的对照；构建副本内容校验。 |
| 5. 先度量失败与恢复 | 适用。先固化无测试、覆盖不足、政策篡改、hook 漏触发、Cursor 空 stdout 失败和命令超时，再实现成功路径；预期降低“没写/大块没覆盖”的假绿，不宣称解决假测试。 | failure-first 测试；`tdd-gate` evidence；真实临时仓库 red→green；Cursor 失败时历史不变、成功时提交；后续 mutation testing 明确保留。 |

当前无实现方向未裁决项。Cursor Agent 已由用户安装；Claude Code 账户 402 若持续存在，只影响
该宿主真实调用验收，不改变已批准设计。

## Task 1：先建立失败夹具和配置合同

### 测试先行

- 新增最小临时 Git 仓库夹具，包含：
  - 成功 coverageCheck；
  - 覆盖不足退出非零；
  - 缺工具；
  - 超时并派生孙进程；
  - 政策文件摘要匹配/缺失/变化；
  - 基线后新增 ignore marker；
  - 零测试错误配置。
- 为 `Prd.tdd` 写 strict parser 红灯测试：
  - 缺失=disabled；
  - 空命令、空/非法 source pathspec、非法数组、重复路径、绝对路径、`..`、越界 realpath、非法 SHA、非法 baselineRef、空 pattern 全拒绝；
  - 配置一旦出现，任何形状不确定性都不能降级成 disabled。

### 实现

- 新增 runner-neutral `tdd-gate` 模块：
  - 配置解析；
  - 项目内路径/realpath 约束；
  - SHA-256 校验；
  - 只在批准的 `sourcePathspecs` 内执行从 `baselineRef` 到当前 HEAD/工作区的 added-line pattern 检查；
  - 复用现有命令执行、输出截断、超时和进程树终止能力。
- 若复用需要抽取公共 command runner，只移动一份实现并保持既有 `qualityChecks` 行为全量回归，不复制第二套 spawn 逻辑。

## Task 2：引擎门禁与证据

### 测试先行

- TDD 未启用时，现有 loop 行为和 evidence 不变。
- 非法 TDD 配置在 Builder 启动前退出 1，Builder/Validator 均未调用。
- 启动前 baselineRef 不可达、政策摘要已漂移或 source pathspec 非法时同样零 agent 调用。
- 普通门禁通过、TDD 门禁失败时：
  - 当前 story `passes=false`；
  - retry 增长并按既有规则升级/blocked；
  - Validator 不运行；
  - `tdd-gate` evidence 有失败命令、结局、耗时和有界诊断。
- Builder 已 commit 后修改政策或加入 ignore marker，仍能以 `baselineRef` 检出。
- hook 曾返回成功也不能让引擎跳过重跑。

### 实现

- 在 loop 中按 `qualityChecks → TDD → Validator` 接线。
- 启动前完成只读 TDD preflight；每轮 Builder 后重新校验政策，区分“启动前配置漂移”和“本轮 Builder 引入变更”。
- 启动 Builder/Validator 时向子进程注入实际 workspace 与项目根的绝对路径 `CODING_X_WORKSPACE`、`CODING_X_PROJECT_ROOT`，不改变目标进程的其他环境。
- 新增 `tdd-gate` evidence 严格读入与报告呈现；成功只保留结局、耗时和政策校验，不持久化完整测试输出。
- `doctor` 展示 TDD 是否启用、配置是否合法、政策文件摘要是否匹配；不默认运行昂贵覆盖率命令。
- Builder runtime prompt 在 TDD 启用时引用已安装的 `tdd` skill；不复制 skill 正文。

## Task 3：TDD skill

### 初始化与来源

- 使用 skill-creator 初始化 `skills/tdd/`，再复制/改写用户已授权的参考材料。
- 保留 `tests.md`、`mocking.md`、`interface-design.md`、`deep-modules.md`、`refactoring.md` 的有效内容；消除重复并让 `SKILL.md` 保持核心流程。
- 交互模式与 coding-x 模式写在同一 skill 中；宿主差异不得进入 skill 主流程。

### 合同测试

- frontmatter 只含 `name`、`description`，名称与目录匹配。
- description 覆盖：TDD、test-first、红绿重构、修复缺陷、测试驱动等触发语义。
- 正文必须包含：
  - 一行为一个循环；
  - RED 真实运行和正确失败分类；
  - GREEN 重跑同一聚焦命令；
  - 只在 GREEN 重构；
  - 公共行为测试；
  - 环境错误不能算 RED；
  - 最终 coverageCheck；
  - 过程记录非机器证明；
  - coding-x AC 已批准与 blocked 仲裁路径。
- 运行 skill-creator `quick_validate.py` 与仓库 `skill-contract`/catalog 测试。

## Task 4：跨宿主 hook

### 配置

- 新增默认 `hooks/hooks.json`：
  - Codex/Claude Code `PreToolUse`；
  - matcher `Bash`；
  - 调用 `${CLAUDE_PLUGIN_ROOT}` 下的共同 Node 脚本；
  - 超时覆盖整个覆盖率检查窗口。
- 构建时把共同脚本复制到 `dist/hooks/`，新增
  `hooks cursor install|status|remove`：
  - 先定位 Git 根；
  - 安全合并项目 `.cursor/hooks.json` 的 `beforeShellExecution`；
  - 把脚本和归属记录写入 `.cursor/coding-x/`；
  - 620 秒超时、`failClosed: true`，重复安装不重复；
  - 非法 JSON、结构冲突、路径越界、符号链接或用户改过的受管内容拒绝写入；
  - 原子更新失败时恢复，remove 只删受管内容并保留用户配置。
- `.cursor-plugin/plugin.json` 移除 hook 入口与不再使用的插件级 Cursor 配置；commands/skills 保持。
- `.codex-plugin/plugin.json` 不新增 hooks 字段，继续使用默认发现；Claude Code 同样使用默认目录。

### 共同脚本

- 兼容嵌套 `tool_input.command` 与 Cursor flat `command`。
- 只在可识别的 agent `git commit` 前运行。
- 寻找 Git 根和 `.workspace/prd.json`，严格读取 `tdd`。
- 只有继承的 `CODING_X_PROJECT_ROOT` 等于当前 Git 根时，才使用配套的 `CODING_X_WORKSPACE`；否则回退到当前 Git 根 `.workspace/`。允许 workspace 在仓库外，但不能跨项目误读。
- 校验政策摘要并执行 `coverageCheck`；透传有限、去敏的失败摘要到 stderr。
- 成功 exit 0；Codex/Claude 成功输出保持为空，Cursor 成功输出原生 allow JSON；TDD 已启用后的
  任何不确定性或检查失败 exit 2。
- 不写持久日志，不使用 jq/qodercli，不修改仓库。

### 自动验证

- 对 Codex、Claude、Cursor 三类 payload 运行脚本；
- 非 commit/no config 放行；
- commit + success 放行；
- commit + invalid/missing policy/failing command/timeout 阻断；
- 路径含空格、子目录 cwd、worktree、无 Git 仓库边界；
- JSON 畸形仅在无法确认 TDD 是否启用时按 hook 来源安全处理：非 commit payload 不阻断，commit-like payload 不能静默通过。
- 安装器覆盖首次安装、幂等、构建副本更新、status、安全卸载、保留已有配置、非法配置零写入、
  受管内容修改、符号链接、路径含空格和非 Git 目录。

## Task 5：派生、文档与决策记录

- `prd-to-json` 增加显式 TDD 启用步骤：
  1. 用户选择是否启用；
  2. 判定新项目/存量项目；
  3. 提取真实测试与覆盖工具；
  4. 提议完整 coverageCheck、生产代码 sourcePathspecs、政策文件、baselineRef、ignore patterns；
  5. 用户一次确认；
  6. 写入前运行基线，确认有真实测试、分支覆盖开启、阈值和排除符合已批政策；
  7. 计算摘要后写入。
- 不可靠时停止，不编造命令，不退回 AI 语义判断。
- 新增 ADR-017，说明：
  - 保留 ADR-005 引擎门禁的最终权威；
  - hook 只做提前反馈，不是目标 Git hook；
  - 单一 `prd.json` 政策源与项目原生覆盖工具；
  - 配置摘要与同权限攻击边界；
  - mutation testing 延后。
- 同步 architecture、glossary、patterns、dogfood regression、README 技能表/流程图/安装与故障排查。
- 提醒用户：Codex 安装插件后需审查并信任 hook；Cursor 需要独立 Agent CLI，并在目标项目
  显式 install/status，升级后刷新、需要时 remove；`coding-x cursor` 和 `prd-to-json` 不自动安装。

## Task 6：分层验证

### 静态与单元

- `node` 语法检查 hook；
- JSON schema/manifest 校验；
- `quick_validate.py skills/tdd`；
- TDD config、policy hash、diff pattern、command runner、hook payload、loop、doctor、evidence/report 定向测试。

### 构建与仓库健康

- `npm run typecheck`
- `npm test`
- `npm run build`
- 构建产物 `doctor`
- `git diff --check`
- plugin validator 与三份 manifest/catalog consistency。

### 临时仓库端到端

1. 失败覆盖率仓库：hook 阻断 commit；直接绕过 hook 后，引擎仍打回且 Validator 未运行。
2. 成功覆盖率仓库：真实 RED→GREEN 后 hook 放行；引擎重跑通过，Validator 才启动。
3. 政策篡改仓库：降低阈值或扩大排除后，即使测试命令表面返回 0，政策摘要先失败。
4. ignore marker 仓库：Builder 已提交新增 ignore marker，baselineRef 对比仍能检出。
5. 零测试仓库：启用流程拒绝返回 0 的零测试命令。

### 真实宿主

- Codex：开发加载/安装插件，确认 hook trust 后，分别验证失败阻断、成功放行和脚本收到真实 payload。
- Claude Code：`--plugin-dir` 加载，验证同三条路径。
- Cursor：用构建后的 coding-x 在临时 Git 仓库执行 install/status，再由已认证的真实 Cursor
  Agent 验证覆盖不足时提交被阻断、覆盖达标时提交成功、重复安装单项、卸载保留用户配置。
- coding-x：用构建产物在隔离 Git 仓库跑完整 Builder→TDD gate→Validator 顺序。

## 交付边界

- 设计批准后才开始以上代码改动。
- 未经新授权不 commit、不 push、不 tag、不 publish。
- 已实测发现 Cursor 插件级 hook 与实际执行面不一致，因此按批准的修正设计改为项目级显式安装。
- Claude Code 账户 402 等外部阻碍必须保留待补验，不能以共享脚本测试冒充真实宿主调用。

## 当前实施状态

本地实现、自动化回归、构建产物和隔离 Git 仓库验收已完成：

- `tdd` skill、Codex/Claude 插件 hook、Cursor 项目级安装器、严格 TDD 政策、引擎独立门禁、doctor、证据与报告均已接线；
- 失败覆盖率会同时被宿主 hook 和直接绕过 hook 后的引擎阻断，Validator 不运行；
- 成功覆盖率按 Builder → 普通门禁 → TDD 门禁 → Validator 的顺序完成，并签发引擎验收凭证；
- 政策文件摘要变化在任何 agent 启动前失败；已提交新增 ignore marker、非法配置、超时与进程树收口由自动化测试覆盖；
- Cursor runner 自动兼容当前 `agent` 与旧版 `cursor-agent` 两种命令名；项目级安装器的
  首次安装、重复安装、更新、状态、安全卸载、冲突、修改与符号链接边界均有自动测试。

真实宿主边界：

- Codex 0.145.0-alpha.30 已用本地临时市场安装当前快照；默认插件 hook 发现路径在覆盖不足时
  阻断提交，在覆盖达标时放行并成功提交；
- Claude Code 2.1.216 已确认发现当前插件与 `coding-x:tdd` skill，但账户返回 402，模型未能发起 Bash 调用，因此真实 `PreToolUse` 仍待账户恢复后补验；共享脚本的 Claude payload 已自动验证；
- Cursor Agent CLI `2026.07.20-8cc9c0b` 已用构建产物完成真实验收：覆盖不足时提交被阻断且
  Git 历史不变，覆盖达标时提交成功；重复安装只有一个受管检查项，卸载后用户原配置完整保留；
- coding-x 构建产物已在隔离 Git 仓库完成 Builder → 普通门禁 → TDD 门禁 → Validator
  端到端验收，只有两道门禁通过后才签发验收凭证。

因此本计划保持 `active`：实现与本轮可执行验收已经完成；仅 Claude 账户恢复后的真实 hook
补验仍属外部待办，在此之前不宣称四端全部完成。
