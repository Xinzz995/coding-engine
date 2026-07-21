---
title: "全局模型目录实施计划"
status: active
updated: 2026-07-22
scope: root
---

# 全局模型目录实施计划（v0.24.0）

**Goal:** 用当前用户维护的全局模型目录替换 Claude Code、Codex、Cursor 的运行时自主发现，让 `models`、`prd-to-json`、preflight 与 doctor 只消费同一份确定性配置，同时保留 v0.23 的项目级难度路由和 runner-default 零配置行为。

**Architecture:** 新建 `src/engine/model-catalog.ts`，集中负责默认路径/`CODING_X_CONFIG` 解析、version 1 严格 schema、排他初始化、按 runner 查询与安全渲染；删除 `model-discovery.ts` 及 Codex app-server fixture。`model-preflight.ts` 保留现有 effective/shadowed 路由集合算法，但把 discovery 三态改为 catalog available/error；CLI 增加 `config path|init|validate`，`models` 只读 catalog；doctor 与 `prd-to-json` 复用同一合同。全局配置不进入 workspace，项目五项映射仍留在 `prd.json`。

**Tech Stack:** TypeScript strict/ESM、Node ≥18 内置 `fs/path/os`、Vitest、tsup；运行时不新增依赖。

**Spec:** `docs/superpowers/specs/2026-07-22-global-model-catalog.md`

**ADR:** `docs/decisions/012-global-model-catalog.md`

## 执行状态（2026-07-22）

- [x] Task 1–6：核心、CLI、preflight/loop、doctor、skill、文档与 0.24.0 版本同步已完成。
- [x] Task 7 隔离部分：审查修复后 471 条全量测试、typecheck、build、发布入口 config/models/doctor smoke 与 fake-agent 生产配置链路已通过。
- [x] Task 7 真实 provider 最小链路：在隔离 clone 中完成一轮 Codex low Terra builder → Sol validator，门禁、evidence、report 与最终状态均通过；覆盖边界见下方“持久审计证据”。
- [x] Task 7 工程收口：预提交 `/review-loop` 已完成，10 项发现均有裁决（9 项已纳入本分支提交且留痕已回填哈希）；`/compound-docs` 已按无 workspace/无分支提交的降级模式完成取证，现有 architecture/glossary 已覆盖稳定知识，无额外 patterns 候选。
- [ ] 合并/发布收尾：实现尚未合并或发布，因此本 plan/spec 保持 `active`，不发布、不打 tag。

## 全局约束

- `src/` 内所有相对导入写 `.js` 扩展名。
- 每个实现任务提交前运行针对性测试；收口前必须运行 `npm run typecheck && npm test && npm run build`。
- 提交说明使用中文，保留 `feat:` / `fix:` / `test:` / `docs:` conventional 前缀。
- `models`、run、doctor、skills 不得创建、补写或自动更新全局配置；只有显式 `config init` 可创建空模板。
- 不调用 runner CLI、网络、provider API、交互 TUI、内部缓存或私有协议来获得模型。
- 全局目录只表示用户允许的 ID，不得使用“当前可用”文案，不输出具体账号/provider 值，也不得把目录通过写入 PRD/evidence/report 固化成在线证明。
- `prd.json.models`、difficulty、state.escalated、路由优先级、evidence schema 与 dashboard/status/report 的配置/实际分离保持不变。
- run preflight 在无 PRD 模型路由且无 CLI 模型覆盖时不读取全局配置，不改变三 runner 历史 argv；doctor 仍会校验一个已经存在的配置文件。
- 测试一律用临时文件与 `CODING_X_CONFIG` 隔离，不读取或写入开发者真实 home。
- 全局配置不是 workspace 运行状态，不获取 `engine.lock`；`config init` 使用排他创建，绝不覆盖已有文件。
- `skills/`、`commands/` 继续是唯一源，不在插件目录复制正文。
- 不顺带实现 runner 安装/认证诊断、binary 管理、provider 配置、token/费用、reasoning effort 或 service tier。

---

## Task 1：建立全局模型目录核心与严格 schema

**Files:**

- Create: `src/engine/model-catalog.ts`
- Create: `src/engine/model-catalog.test.ts`

### 合同

实现并导出等价于以下职责的接口；具体函数拆分可按现有风格调整，但读取、解析、查询和渲染要有可独立测试的边界：

```ts
export interface ConfiguredModel {
  id: string;
  label?: string;
}

export interface GlobalModelConfig {
  version: 1;
  models: Partial<Record<AgentKind, ConfiguredModel[]>>;
}

export type ModelCatalogResult =
  | {
      status: 'available';
      runner: AgentKind;
      models: ConfiguredModel[];
      source: 'global-config';
      configPath: string;
    }
  | { status: 'error'; runner: AgentKind; error: string; configPath: string };
```

核心能力：

- `resolveGlobalConfigPath()`：trim 后非空的 `CODING_X_CONFIG` 优先，否则 `homedir()/.config/coding-x/config.json`；相对覆盖路径按当前目录解析，返回绝对路径；空白值按未设置处理。
- 纯 schema 解析：输入 unknown，输出配置或带精确字段路径的错误；不依赖文件系统。
- 文件读取：区分缺文件、坏 JSON 与 schema 非法，不回显完整内容。
- runner 查询：缺 runner 键或空数组返回 error；成功保持数组顺序并返回 `source: global-config`。
- 文本/JSON 渲染：文本标题用“全局模型目录”；JSON 单对象；label 仅展示。
- 初始化：递归创建父目录，用 `flag: 'wx'` 或等价排他语义写入 `{ "version": 1, "models": {} }`；已有文件不覆盖。

严格验证顶层/`models`/runner/模型项未知字段、version、对象/数组形状、ID 与 label 首尾空白、空字符串、重复 ID。允许 `models` 为空对象和 runner 空数组，但查询空 runner 必须失败。

### 测试

- [x] 默认路径和绝对/相对 `CODING_X_CONFIG`；空白覆盖值回落默认路径。
- [x] 合法完整配置、部分 runner、空 `models`、空 runner 数组、顺序与 label 保留。
- [x] 缺文件、坏 JSON、错误 version、根/`models`/模型项未知字段、未知 runner。
- [x] 非数组 runner、非对象模型项、空白/带首尾空白 ID、重复 ID、非法 label。
- [x] `config init` 创建父目录和精确模板；第二次初始化失败且原文件字节不变。
- [x] render JSON 可被单次解析；文本不含“当前可用”，不输出具体账号/provider 值或发现来源。

运行：

```bash
npx vitest run src/engine/model-catalog.test.ts
npm run typecheck
```

**Commit:** `feat: 增加用户级全局模型目录合同`

---

## Task 2：把 `models` 改为纯目录查询，并增加 `config` 子命令

**Files:**

- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`
- Delete: `src/engine/model-discovery.ts`
- Delete: `src/engine/model-discovery.test.ts`
- Delete: `src/engine/__fixtures__/fake-codex-app-server.mjs`

### CLI 解析

- `CliConfig.command` 增加 `config`，另保存严格的 `path | init | validate` action。
- `coding-x config` 缺 action、action 未知或带多余位置参数时输出明确用法错误，不能误落入 run。
- `coding-x models [runner]` 的 runner 推断保持现状：显式 runner > workspace 合法 `models.runner` > Claude。
- `--workspace` 只用于 models runner 推断，不改变全局路径；config 三命令不取 workspace 锁。

### CLI 执行

- `config path` 不读文件，只输出绝对路径。
- `config init` 调用核心排他初始化，成功打印创建路径，已有文件/写失败退出 1。
- `config validate` 读取并严格校验，成功打印路径和各 runner 数量，失败退出 1。
- `models` 调用 `listConfiguredModels`；人类输出成功走 stdout、错误走 stderr；`--json` 无论成功失败都只向 stdout 打一个对象，error 退出 1。
- 删除 `discoverModels`、`checkRunnerReady`、Codex JSON-RPC、`unsupported` 与相关环境探测。不要把认证检查搬到 catalog 或 models 命令的其他位置。

### 测试

- [x] parse 覆盖三个 config action、缺 action、未知 action与多余位置参数。
- [x] path 在文件不存在时仍退出 0，且不创建任何文件。
- [x] init 创建模板、二次执行不覆盖；validate 对合法/缺失/非法文件分别 0/1。
- [x] models 三 runner 从临时目录读取，文本与 JSON 保持文件顺序和 label。
- [x] models 省略 runner 时继续从 workspace `models.runner` 推断；非法/损坏 PRD 仍失败。
- [x] 缺配置、缺 runner、空数组时 JSON 为 error 单对象、退出 1。
- [x] 把 `CODING_X_CLAUDE_BIN` / `CODING_X_CODEX_BIN` / `CODING_X_CURSOR_BIN` 都指向不存在命令，models 仍成功，机械证明没有启动 runner。
- [x] afterEach 清理 `CODING_X_CONFIG` 和三个 binary 环境变量，避免测试互相污染。
- [x] 对 `src/` 生产代码（排除测试）执行 `rg`，不再命中 `app-server model/list`、`CODING_X_FAKE_DISCOVERY_MODE` 或 `unsupported` 模型发现分支；历史 ADR/spec 可保留继任前语境。

运行：

```bash
npx vitest run src/engine/model-catalog.test.ts src/cli.test.ts
npm run typecheck
```

**Commit:** `feat: 用全局配置驱动 models 与 config 命令`

---

## Task 3：将启动预检与 loop 注入切换为 catalog

**Files:**

- Modify: `src/engine/model-preflight.ts`
- Modify: `src/engine/model-preflight.test.ts`
- Modify: `src/engine/loop.ts`
- Modify: `src/engine/loop.test.ts`

### 预检改造

- import 从 `model-discovery.js` 切到 `model-catalog.js`。
- `ModelPreflightResult.discovery` 改为 `catalog`；`ModelPreflightOptions.discover` 改为 `catalog`/`listModels` 等不含 discovery 的命名。
- `LoopConfig.modelDiscovery` 改为 `modelCatalog`，测试注入点同步机械迁移。
- 保留现有 `required` / `shadowed` 算法、runner 一致性、schema 校验与 resolver 优先级，不重写模型路由。
- `hasPolicy` 通常要求“有待执行 story + PRD models 或任一 CLI 模型覆盖”；PRD 缺失/不可解析且存在 CLI 覆盖时也必须读取目录，防止修复轮绕过。已收敛时返回 `catalog: { status: 'skipped', runner }`，不得读取 home。
- true 时按最终 runner 查询目录；error 直接抛 `ModelPreflightError`。
- 所需模型缺项错误改为“未在 `<runner>` 全局模型目录声明”，并保留 story/字段路径或 CLI flag；不写“当前不可用”。
- shadowed 缺项只警告继续，提示重新运行 `prd-to-json`；其余目录缺项不降级 runner default。
- 启动摘要从“模型复核/发现”改为“全局模型目录：available（configPath）/skipped”。
- 不新增 runner readiness、认证或在线探测。实际 spawn/provider 失败继续走既有异常轮/stall，且不触发 escalation。

### 测试迁移

- 把 `ModelDiscoveryResult`/`available()` helper 改成 `ModelCatalogResult`/`catalog()`。
- 删除 unsupported 人工确认、discovery error、discovery runner 错配用例；用目录 error、缺 ID 和 catalog runner 结果覆盖新合同。
- 保留并重命名以下断言：零配置跳过、所有 effective 路线、CLI 模型缺项、shadowed 警告、已升级仅检查 escalation+validator、已收敛跳过、runner 错配和非法 PRD 在目录读取前失败。
- loop 的路由、升级、evidence 和三 runner argv 断言不变，只改依赖注入名与 fixture result。
- 新增纯 CLI、无 PRD models 时也必须校验覆盖 ID 的用例。
- 新增配置 error 在 dashboard/startAgent 之前终止的集成断言。

运行：

```bash
npx vitest run src/engine/model-preflight.test.ts src/engine/loop.test.ts
npm run typecheck
```

**Commit:** `feat: 启动前按全局模型目录复核实际路由`

---

## Task 4：把全局目录健康检查接入 doctor

**Files:**

- Modify: `src/doctor/doctor.ts`
- Modify: `src/doctor/doctor.test.ts`

### 报告结构

新增独立 `ModelCatalogCheckResult`（命名可按代码风格调整），至少携带：解析路径、文件是否存在、schema 是否有效、各 runner 数量、当前 workspace PRD 是否启用模型路由、交叉核对 issues。复用 `model-catalog.ts` 的读取/验证，不复制 schema。

### 行为矩阵

- 配置缺失 + PRD 未启用 models：信息提示，退出码不变。
- 配置合法 + PRD 未启用 models：通过并列 runner 数量。
- 配置文件存在但非法：始终计失败，即使当前 PRD 未启用路由。
- PRD 启用 models + 配置缺失/runner 缺失/空数组：计失败。
- PRD 五项任一 ID 未声明：按 `models.builder.low|medium|high`、`models.validator`、`models.escalation` 列出；计失败。
- PRD 五项都已声明：通过。
- 不要求目录覆盖当前 PRD 未使用的 runner，不读取 provider，不检查 runner binary/auth。
- 无 docs/ 时仍输出目录、门禁和锁三类非文档检查。

### 测试

- [x] 用隔离路径覆盖上述全部矩阵，测试不依赖 home。
- [x] custom/absolute workspace 只改变 PRD 位置，不改变 config 路径。
- [x] config issue 纳入 `renderDoctorReport` 总问题数和 exit 1；缺配置信息态不计失败。
- [x] 现有 frontmatter/freshness/index/links/gate/lock 用例保持通过。
- [x] 三个 binary 环境变量为无效路径时 doctor 仍只读成功。

运行：

```bash
npx vitest run src/doctor/doctor.test.ts src/engine/model-catalog.test.ts
npm run typecheck
```

**Commit:** `feat: doctor 检查全局模型目录与项目映射`

---

## Task 5：更新 `prd-to-json` 的唯一候选来源与静态合同

**Files:**

- Modify: `skills/prd-to-json/SKILL.md`
- Modify: `src/skill-contract.test.ts`

### Skill 语义

- 保留 `npx coding-x models <runner> --json` 作为唯一查询入口，但说明它只读全局目录。
- 删除“当前机器/账号/provider 可用集合”、available/unsupported/error 三态分流、人工提供临时列表与派生阶段认证检查。
- 命令 error 时展示 `coding-x config path`，引导 `config init`/编辑/validate；修好后重试。用户也可选择不启用路由，但不能临时绕过目录。
- 五项只能从返回目录选择；label 只展示，不按名字推断强弱。
- 再派生改为：runner 相同且五项仍在目录中则保留；runner/任一 ID 变化、目录错误或用户要求重配则重走目录选择。
- 保存前检查清单使用“全局模型目录已声明”，不再声称 ID 当前有效。
- difficulty 规则、源 PRD 回写、state 精确迁移和 blocked 分支不变。

### 静态合同测试

- [x] 正向锚定 `全局模型目录`、`CODING_X_CONFIG`、`coding-x config path`、五项只能从目录选择、再派生成员复核。
- [x] 保留新 schema、五道选择题、固定难度规则、理由证据与 state 重置锚点。
- [x] 反向断言 skill 不含 `unsupported`、Codex `model/list`、当前账号/机器/provider 列表、会话内人工清单兜底。
- [x] 继续断言未发布的 profiles、escalateAfter、story.model 不回归。

运行：

```bash
npx vitest run src/skill-contract.test.ts
npm run typecheck
```

**Commit:** `feat: prd-to-json 只从全局目录选择模型`

---

## Task 6：同步用户文档、架构、共享语言与版本

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/glossary.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify via version hook: `.claude-plugin/plugin.json`
- Modify via version hook: `.cursor-plugin/plugin.json`
- Modify via version hook: `.codex-plugin/plugin.json`
- Update status after implementation: `docs/superpowers/specs/2026-07-22-global-model-catalog.md`
- Update status after implementation: `docs/superpowers/plans/2026-07-22-global-model-catalog.md`

### README

- 增加 version 1 配置示例、默认路径、`CODING_X_CONFIG`、声明/实时可用性边界。
- 增加 `config path|init|validate` 示例、参数表和退出码；把 `models` 改为纯目录查询。
- 删除 Codex app-server、Claude/Cursor unsupported、当前账号/provider、人工列表兜底等旧文案。
- 明确零配置 runner-default 不需要文件，项目路由和 CLI 模型覆盖需要目录。
- 增加 v0.24.0 迁移提示：PRD schema 不变，已有五项 ID 先登记再运行。
- 更新功能清单、环境变量表与源码目录树；目录树同时补齐现有漏列的 gate/models/prd-guard/evidence/doctor/status 等模块，加入 `model-catalog.ts`，不再列 `model-discovery.ts`。

### 架构与词汇

- architecture 的 CLI、模型目录、preflight 模块行与模型路由数据流改成 catalog；说明全局文件在 workspace 外、run 只读、实际 provider 拒绝才进入 agent outcome。
- glossary 新增“全局模型目录”：用户维护、跨项目、按 runner 隔离的允许 ID 目录；不是在线可用性证明。统一禁用用“模型发现/当前可用模型列表”指代它。
- 所有改动文档 frontmatter `updated` 设为 `2026-07-22`。

### 版本

```bash
npm version 0.24.0 --no-git-tag-version
```

确认 package、lock 与三个 plugin manifest 都是 0.24.0。实现和全量验收完成后把本 spec/plan 状态置 `done`；ADR-012 保持 `active`。不要在无人审授权前创建 tag、发布 npm 或推送。

运行：

```bash
npm run typecheck
npm test
npm run build
node dist/cli.js doctor
```

**Commit:** `docs: 完成全局模型目录文档与 0.24.0 版本同步`

---

## Task 7：完成隔离 smoke、dogfood 与收口

**Files:**

- Test only: system temporary directory
- Optional local dogfood artifacts: `.superpowers/fixtures/study-report-dogfood/`（不纳入发布资产）

### 临时环境 smoke

1. 创建临时 config，三 runner 各含 fake-agent 接受的 ID，通过 `CODING_X_CONFIG` 注入。
2. `config path` 输出临时绝对路径；`config validate` 通过；`models <runner> --json` 三次均为 `available/global-config`。
3. 把三个 `CODING_X_*_BIN` 指向不存在命令，再次执行 models，仍应成功。
4. 创建无 models 的临时 workspace，不提供 config，fake-agent runner-default 路径保持 v0.23 argv。
5. 创建含 low/medium/high、validator、escalation 的临时 workspace，真实走一次 fake-agent loop，核对 preflight、argv、state.escalated 与 evidence actual route。
6. 删除/改坏 config，确认有显式模型策略时在 dashboard/agent 启动前失败；无策略时仍可运行。
7. doctor 分别验证无路由缺配置为信息、路由缺配置为失败、五项齐全为通过。

### Dogfood

- low/medium/high 初始路由、首次有效失败升级、validator、目录缺项、CLI 遮蔽与 provider-error 语义由单元测试、fake-agent loop 和隔离 smoke 覆盖；provider-error 必须保持外部运行失败，不误判为 catalog 缺陷，也不触发 escalation。
- 真实 provider 只验证一条经用户明确授权的最小边界：从 study-report fixture 派生单个 low 难度 US-009，在无 Git remote 的隔离 clone 中，以临时全局目录运行一轮 Terra builder → Sol validator，并核对目录预检、真实 runner 参数、机械门禁、evidence、state 与 report。
- 该真实调用不声称覆盖 medium/high builder 或 escalation；这些组合的证据来自上一条所列自动化链路。成本边界固定为一次成功尝试最多一个 builder 与一个 validator；首次安全中止另行留痕，不重复扩张 provider 调用范围。
- 预提交 `/review-loop` 人审包落在 `.workspace/review-2026-07-22.md`；所有发现已有四态裁决，机械修复后相关目标测试与全量门禁均通过，留痕已回填本分支修复提交哈希。
- `/compound-docs` 已基于当前代码、工作树 diff 与现有文档降级取证：结构/边界已在 architecture、glossary、ADR/spec/plan 单源表达，一次性 dogfood 事故不沉淀为通用模式，仓库无真实 `// 取舍:` 债务。plan/spec 只在实现合并或发布后置 `done`，本轮不自动发布。

### 持久审计证据（脱敏）

- 执行日期：2026-07-22（Asia/Shanghai）；runner 为 Codex；模型 ID 由用户确认，过程中未调用任何 runner 模型枚举接口。
- 临时全局目录映射：low/medium=`gpt-5.6-terra`，high/validator/escalation=`gpt-5.6-sol`；配置 SHA-256 为 `220b10c9288a49d06a9011c6e09b39813acc7e20474f6fc9f3db0bfd792fb07d`。
- 隔离条件：执行前 clone 工作树干净且没有 Git remote；完整脱敏材料另存于本地忽略目录 `.superpowers/fixtures/study-report-dogfood/.workspace/archive-run-20260722-global-model-catalog/`，原始临时根为 `/private/tmp/coding-x-dogfood-20260722.4nUyFn`（可能被系统清理，本节仍保留可独立复核的持久摘要）。
- 成功尝试：引擎单轮退出码 0；builder=`gpt-5.6-terra`、route source=`difficulty`、outcome=`completed`；validator=`gpt-5.6-sol`、route source=`validator`、outcome=`completed`；机械门禁 `npm run typecheck` 与 `npm test` 为 2/2 通过；隔离 clone 提交为 `932cc26 feat: US-009 - README 运行与角色说明`。
- 最终 state：US-009 `passes=true`、`retryCount=0`、`blocked=false`、`escalated=false`。
- engine evidence 原文如下（两条）：

```jsonl
{"type":"gate-run","source":"engine","at":"2026-07-21T22:27:32.123Z","iteration":1,"storyId":"US-009","ok":true,"total":2,"ran":2,"ms":941}
{"type":"iteration","source":"engine","at":"2026-07-21T22:28:09.559Z","iteration":1,"storyId":"US-009","builderRan":true,"builderModel":"gpt-5.6-terra","validatorRan":true,"validatorModel":"gpt-5.6-sol","skippedValidator":false,"agentBlocked":false,"builderRouteSource":"difficulty","storyDifficulty":"low","validatorRouteSource":"validator","builderOutcome":"completed","validatorOutcome":"completed"}
```

- 首次安全中止事件：第一次尝试已启动一个 Terra builder，终检发现隔离 clone 仍保留指向源 fixture 的可写 `origin`，随即以 SIGTERM 终止引擎与 builder；未启动 validator，未产生 engine evidence、state/progress 更新或提交，但可能已消耗一次 builder 配额。随后移除 remote、恢复干净工作树，才执行上述成功尝试。
- 源 fixture 未被修改；其唯一状态仍是运行前已存在的未跟踪 `.DS_Store`。中止尝试与成功尝试的脱敏材料均归档在上述本地忽略目录。

### 最终门禁

```bash
npm run typecheck
npm test
npm run build
node dist/cli.js doctor
```

Expected：类型检查通过；全部测试通过；构建包含新 CLI 且不包含 discovery fixture；doctor 只报告当前真实问题；`rg` 无生产自主发现残留。

**Commit:** `test: 完成全局模型目录隔离验收与 dogfood`

---

## 完成判据

1. 全局配置路径只有默认值与 `CODING_X_CONFIG` 两级，version 1 schema 严格、错误可定位。
2. `config path|init|validate` 行为可测，init 不覆盖、不内置模型。
3. `models` 对三 runner 只读配置，runner 未安装/未认证也不会影响查询；不再返回 unsupported。
4. run preflight 只校验本次 effective 模型的目录成员关系，CLI 覆盖与 shadowed 语义保持确定。
5. runner-default 零配置路径不读取 home；项目路由或任一 CLI 模型覆盖缺目录时 fail-fast。
6. `prd-to-json` 不接受目录外或会话临时 ID，再派生按当前目录保留/重选。
7. doctor 能区分可选的“未配置”与阻塞运行的缺失/非法/ID 漂移，不执行外部 CLI。
8. PRD/state/evidence/dashboard/status/report 的既有路由和实际调用语义无回归。
9. README、architecture、glossary、ADR/spec/plan 与 0.24.0 package/plugin 版本一致。
10. `npm run typecheck && npm test && npm run build` 全绿，隔离 smoke 和至少一轮真实 dogfood 有可审计证据。
