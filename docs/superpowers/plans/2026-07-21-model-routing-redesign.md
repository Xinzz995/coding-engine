---
title: "模型路由重设计实施计划"
status: done
updated: 2026-07-21
scope: root
---

# 模型路由重设计实施计划（v0.23.0）

**Goal:** 以 runner 绑定的 `low / medium / high` builder 档位替换未发布的 `profiles` 路由；第一次有效失败后用独立状态切换 escalation；为 Claude Code、Codex、Cursor 提供可验证、可观测、失败即停的端到端模型路由。

**Architecture:** `prd-to-json` 负责一次性的语义判断与用户选择，`prd.json` 保存严格的声明式合同；`models.ts` 只做 schema 校验和确定性优先级解析；`model-discovery.ts` 隔离外部 CLI 探测；`model-preflight.ts` 在循环前组合 runner、有效模型和发现三态；`state.json.escalated` 由引擎独占；loop 只消费上述结果并把实际调用写入 evidence。源 PRD 继续只保存业务意图。

**Tech Stack:** TypeScript strict/ESM、Node ≥18、Vitest、tsup；运行时继续零新增依赖。

**Spec:** `docs/superpowers/specs/2026-07-21-model-routing-redesign.md`

**ADR:** `docs/decisions/011-model-routing-by-difficulty.md`

## Global Constraints

- `src/` 内所有相对导入写 `.js` 扩展名。
- 每个任务提交前运行 `npm run typecheck && npm test`；涉及发布资产的任务另跑 `npm run build`。
- 提交说明使用中文，保留 `feat:` / `fix:` / `docs:` 等 conventional 前缀。
- 不回滚当前 main 上尚未打 tag 的模型路由提交；在其上前向替换实现，保留 ADR/提交历史。
- `models` 缺失且没有 CLI 覆盖时，既有 Claude/Codex argv 不增加 `--model`。
- schema 非法、runner 错配和可确认的有效模型失效都在启动循环前失败；禁止把非法配置降级成 runner 默认模型。
- 模型发现只用公开机器接口；不读私有缓存、不抓交互 TUI、不内置模型名单。
- 探测输出不得包含密钥、base URL、中转站地址、账号标识或完整环境变量。
- `state.json` 运行期覆盖写继续使用 `writeFileAtomicSync`；`escalated` 只有引擎可改。
- evidence 新字段保持可选，旧 JSONL 仍可读取和生成报告。
- `skills/`、`commands/` 继续只指向唯一源，不复制 `prd-to-json` 正文。
- 本计划不引入 token/费用核算、reasoning effort、thinking/max mode 或 service tier 路由。

---

### Task 1: 重建 `prd.json` 模型合同与纯路由解析

**Files:**

- Modify: `src/engine/prd.ts`
- Replace: `src/engine/models.ts`
- Replace: `src/engine/models.test.ts`
- Test: `src/engine/prd.test.ts`

**Interfaces:**

```ts
export type StoryDifficulty = 'low' | 'medium' | 'high';

export interface ModelsConfig {
  runner: AgentKind;
  builder: Record<StoryDifficulty, string>;
  validator: string;
  escalation: string;
}

export type ModelRouteSource =
  | 'cli-builder' | 'cli-escalation' | 'cli-validator'
  | 'difficulty' | 'escalation' | 'runner-default';
```

`readModelRouting(prd)` 产出 `disabled | enabled | invalid` 的显式结果；`resolveBuilderModel` / `resolveValidatorModel` 同时返回 `model` 与 `source`，不得仅返回字符串。

- [ ] 先写失败测试，覆盖完整新 schema、五个非空模型值、三种 runner、每个 story 的难度与非空理由。
- [ ] 覆盖严格未知键：`models` 只允许 `runner/builder/validator/escalation`，`builder` 只允许 `low/medium/high`。
- [ ] 覆盖所有旧格式的定向错误：扁平 builder、按 runner 分段、`profiles`、`escalateAfter`、story `model`；错误信息包含“重新运行 prd-to-json”。
- [ ] 覆盖耦合约束：有 models 时每个 story 必须同时有合法难度和理由；无 models 时任一难度字段都报“半套配置”。
- [ ] 删除 `profiles` 引用解析和 retryCount 阈值路由；不要留下兼容分支。
- [ ] 实现三条优先级链：
  - 初始 builder：`--builder-model > builder[difficulty] > runner default`；
  - 已升级 builder：`--escalation-model > models.escalation > --builder-model > builder[difficulty] > runner default`；
  - validator：`--validator-model > models.validator > runner default`。
- [ ] 覆盖“纯 CLI、无 models”与“同一模型用于多个位置”合法；resolver 不评价模型能力。
- [ ] 跑 `npx vitest run src/engine/models.test.ts src/engine/prd.test.ts`，再跑全量门禁。

**Commit:** `feat!: 重建按难度分档的模型路由合同`

---

### Task 2: 接入 Cursor runner，并保留零配置 argv

**Files:**

- Modify: `src/engine/agent.ts`
- Modify: `src/engine/agent.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**

- `AgentKind` 扩为 `'claude' | 'codex' | 'cursor'`。
- `resolveBinary('cursor')` 使用 `CODING_X_CURSOR_BIN ?? 'cursor-agent'`。
- `CliConfig` 新增 `escalationModel?: string`，并保留“用户是否显式选择 runner”的信息，不能在解析阶段把省略值悄悄固化成 Claude。

- [ ] 先写三 runner 的无模型/带模型 argv 表格测试。
- [ ] Cursor 无模型 argv 为 `cursor-agent -p --force <prompt>`；带模型时为 `cursor-agent -p --force --model <id> <prompt>`。
- [ ] 增加 `coding-x cursor` 与 `--escalation-model` 参数解析；既有 `coding-x claude`、`coding-x codex` 保持可用。
- [ ] 更新权限警告，Cursor 明确展示 `--force`；测试不得把 Cursor 落入 Claude 文案分支。
- [ ] 覆盖三个 `CODING_X_*_BIN` 测试替身，继续允许 `node fixture.mjs` 形式的测试命令。
- [ ] 回归断言：没有模型参数时 Claude/Codex 既有 argv 逐项不变。
- [ ] 跑 agent/CLI 定向测试与全量门禁。

**Commit:** `feat: 增加 Cursor runner 与 escalation CLI 覆盖`

---

### Task 3: 给 state 增加引擎独占的 `escalated`

**Files:**

- Modify: `src/engine/state.ts`
- Modify: `src/engine/state.test.ts`
- Modify: `src/engine/gate.ts`
- Modify: `src/engine/gate.test.ts`

**Interfaces:**

```ts
export interface StoryState {
  passes: boolean;
  notes: string;
  retryCount: number;
  blocked: boolean;
  escalated: boolean;
}
```

新增纯 helper：读取旧 state 时补 `false`、把 agent 写回的状态与轮首 `escalated` 合并、在有专用 escalation 目标时原子置位。

- [ ] 先写失败测试：新初始化值为 false；旧四字段 state 可读且内存归一为 false；损坏的其他字段仍拒绝。
- [ ] 验证“懒补齐”：仅仅读取旧 state 不立即重写，后续正常状态写入才落盘 `escalated:false`。
- [ ] `legacyStateOf`、`blankStateFor`、`mergedStories` 与 gate 回写都保全该字段。
- [ ] 写所有权 helper 测试：agent 把 false 改 true 或把 true 改 false，都恢复轮首值；其他合法 state 变化保留。
- [ ] 写升级 helper 测试：没有专用 escalation 目标时不置位；已有 dedicated CLI/config 目标时置位；重复调用幂等且不增加 `retryCount`。
- [ ] 所有落盘路径继续走 `writeFileAtomicSync`。
- [ ] 跑 state/gate 定向测试与全量门禁。

**Commit:** `feat: 用独立引擎状态记录模型升级`

---

### Task 4: 建立模型发现三态与公共 `models` 命令

**Files:**

- Create: `src/engine/model-discovery.ts`
- Create: `src/engine/model-discovery.test.ts`
- Create: `src/engine/__fixtures__/fake-codex-app-server.mjs`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**

```ts
export interface DiscoveredModel {
  id: string;
  displayName?: string;
  // 仅保留发现源明确返回且可安全公开的能力元数据
}

export type ModelDiscoveryResult =
  | { status: 'available'; runner: AgentKind; models: DiscoveredModel[]; source: string }
  | { status: 'unsupported'; runner: AgentKind; reason: string }
  | { status: 'error'; runner: AgentKind; error: string };
```

- [ ] 先写三态序列化测试：`--json` 的 stdout 永远是单个 JSON 对象，诊断走 stderr；人类模式只打印安全字段。
- [ ] 实现 runner readiness 探测：二进制/认证状态分开报告；使用各 CLI 的公开状态入口，不从配置文件推断登录。
- [ ] Codex 适配器通过 `codex app-server` 的公开 JSON-RPC `model/list` 获取当前配置下的模型；测试 fixture 覆盖 initialize、请求 ID 对应、噪声行、超时、进程退出和空列表。
- [ ] Claude Code 与 Cursor 在没有公开机器模型接口时返回 `unsupported`；不得调用 `/model`、解析 TUI 或读取内部缓存。Cursor 认证检查使用公开 `cursor-agent status`。
- [ ] `coding-x models [runner] [--json]` 不获取 workspace 写锁、不改文件；runner 省略时沿用“显式 runner > models.runner > 历史 Claude”的解析规则。
- [ ] 查询适配器存在但认证、网络或协议失败时返回 `error`，不能伪装为 unsupported。
- [ ] 去重模型 ID，拒绝空 ID；不按未知模型名称推断能力顺序。
- [ ] 测试确保输出不含 fixture 注入的 token/base URL/account 标识。
- [ ] 跑 discovery/CLI 定向测试与全量门禁。

**Commit:** `feat: 增加安全的模型发现三态与 models 命令`

---

### Task 5: 在循环前完成 runner 解析和有效模型预检

**Files:**

- Create: `src/engine/model-preflight.ts`
- Create: `src/engine/model-preflight.test.ts`
- Modify: `src/engine/loop.ts`
- Modify: `src/engine/loop.test.ts`
- Modify: `src/cli.ts`
- Modify: `src/cli.test.ts`

**Interfaces:**

`preflightModelRouting` 消费已校验 PRD、显式 runner、三个 CLI 覆盖、当前 state 与 `ModelDiscoveryResult`，产出最终 runner、每个未完成 story 的初始/升级路线、validator 路线、警告和启动摘要；非法时抛带字段路径的领域错误。

- [ ] 先写 runner 矩阵：显式 runner 优先用于一致性校验；无显式 runner + models 使用 `models.runner`；无 models 回落 Claude；显式错配失败。
- [ ] schema 校验必须先于任何 agent 运行；错误时不启动 dashboard、不生成 iteration、不消耗 maxIterations。
- [ ] 根据未完成且未 blocked stories 计算“本次可能实际调用”的模型集合：各 story 初始 builder、专用 escalation、固定 validator；CLI 覆盖按优先级消除被完全遮蔽的配置路线。
- [ ] available：有效模型缺失即失败；CLI 指定模型同样校验。被 CLI 完全遮蔽的过期配置只警告并提示重新派生。
- [ ] unsupported：打印一次无法复核警告后继续；error：循环前失败。
- [ ] runner CLI 缺失或未认证时 fail-fast；错误文案区分安装、认证、模型发现。
- [ ] 启动摘要列出 runner、三档映射、validator、escalation、CLI 覆盖、复核状态；不得把“配置模型”写成“已实际调用”。
- [ ] CLI parser 保留显式性，最终 permission warning 使用预检解析出的实际 runner。
- [ ] 覆盖无 models + 三种 CLI 参数的独立工作方式，以及没有专用 escalation 时不制造升级路线。
- [ ] 跑 preflight/loop/CLI 定向测试与全量门禁。

**Commit:** `feat: 在运行前严格校验 runner 与有效模型`

---

### Task 6: 接线首轮分档、首次有效失败升级与状态防篡改

**Files:**

- Modify: `src/engine/loop.ts`
- Modify: `src/engine/loop.test.ts`
- Modify: `src/engine/evidence.ts`
- Modify: `src/engine/evidence.test.ts`
- Modify: `assets/instructions/builder.md`
- Modify: `assets/instructions/validator.md`

**Evidence additions（全部 optional）:**

```ts
builderRouteSource?: ModelRouteSource;
validatorRouteSource?: ModelRouteSource;
storyDifficulty?: StoryDifficulty;
escalationTriggeredBy?: 'gate' | 'validator' | 'noop';
stateRouteTamper?: { expected: boolean; received: boolean; side: 'builder' | 'validator' };
```

- [ ] 先写低/中/高三个 story 的首轮 argv 集成测试，断言分别收到对应 builder 模型与 `difficulty` 来源。
- [ ] 写三种有效失败测试：机械门禁失败、validator 正常打回、builder completed no-op；都先原子写 `escalated=true`，下一轮才使用 escalation，并在后续轮保持 sticky。
- [ ] validator 打回使用机械状态差异识别（正常退出且 retryCount/验收状态按 validator 合同发生打回），不解析 agent 文本。
- [ ] 写反例：builder/validator timeout、非零退出、spawn/认证/环境错误均不置位；`retryCount` 仍沿用既有语义，no-op 不增加。
- [ ] 每次 builder/validator 返回后恢复轮首 `escalated`；检测到篡改时写一次警告与 evidence，其他 state 字段继续按原合同处理。
- [ ] `--builder-model` 只压过初始 builder；已升级时专用 `--escalation-model` / `models.escalation` 先于它。
- [ ] 没有专用 escalation 目标时，即使发生有效失败也不置位；同名的专用目标仍算已配置，不由引擎猜测“能力没变化”。
- [ ] 更新 builder/validator 指令，明确不得修改 `escalated`；skills/commands 不复制指令正文。
- [ ] 每一轮 evidence 记录实际模型、来源、story 档位与触发原因；异常轮继续保留既有 outcome 语义。
- [ ] 跑 loop/evidence 定向测试与全量门禁。

**Commit:** `feat: 首次有效失败后切换并固化升级模型`

---

### Task 7: 重写 `prd-to-json` 的生成、选择与再派生流程

**Files:**

- Modify: `skills/prd-to-json/SKILL.md`
- Create: `src/skill-contract.test.ts`

- [ ] 先写静态 prompt 合同测试，读取唯一源 `skills/prd-to-json/SKILL.md`，断言新 schema、五项选择、三档规则、理由格式、再派生与 blocked 分支均存在；断言 `profiles/escalateAfter/story.model` 示例已移除。
- [ ] 把模型路由移动到 stories 增强、拆分、排序并回写源 PRD之后；明确源 PRD 不写难度与模型策略。
- [ ] 先问是否启用。否：同时省略 `models`、`difficulty`、`difficultyReason`；CLI 缺失/未认证时允许用户走该路径继续普通转换。
- [ ] 调用 `coding-x models <runner> --json`：available 使用返回清单；unsupported 请求用户提供当前有效 ID；error 停止路由配置并解释原因。
- [ ] 模型列表只展示一次，再批量提出五道选择题：`builder.low`、`builder.medium`、`builder.high`、`validator`、`escalation`；允许重复选择，未知别名不猜强弱。
- [ ] 完整写入固定 high-1..7、medium-1..6、low-1..5 规则；先 high、再 medium、最后 low，证据不足向上归档。
- [ ] 每个 `difficultyReason` 一至两句，包含规则编号、仓库事实和相对路径；绿地项目如实记录检查范围与无既有模式。
- [ ] 自动写入后展示 story/档位/理由/初始模型对照表，不逐 story 设前置审批；用户纠正写回派生 JSON。
- [ ] 再派生保留逻辑：runner 相同且五模型仍有效则不重问；story 未实质变化保留人工修正；变化的 story 重评；支持显式全量重评。
- [ ] 精确维护 state：AC、difficulty、runner 或对应初始 builder 变化时重置该 story 的 `escalated=false`；只改理由/validator/escalation 时保留。
- [ ] 已 blocked story 必问“保持”或“新路由重试”；重试同时设置 `blocked=false/retryCount=0/escalated=false` 并追加说明。
- [ ] 继续遵守现有 PRD 回写、AC 增强、qualityChecks 与 ID 不回收规则，不把模型讨论提前到业务 stories 定稿前。
- [ ] 跑 skill contract 测试与全量门禁。

**Commit:** `feat!: 按 story 难度生成 runner 绑定模型路由`

---

### Task 8: 统一 console、dashboard、status、report 的配置/实际语义

**Files:**

- Modify: `src/dashboard/server.ts`
- Modify: `src/dashboard/server.test.ts`
- Modify: `assets/dashboard/dashboard.html`
- Modify: `assets/dashboard/dashboard-p.html`
- Modify: `src/status/status.ts`
- Modify: `src/status/status.test.ts`
- Modify: `src/report/render.ts`
- Modify: `src/report/render.test.ts`
- Modify: `src/report/report.ts`
- Modify: `src/report/report.test.ts`

- [ ] 先为共享展示矩阵写测试：配置映射、story 难度/理由、escalated、最近实际模型/来源分别有明确标签。
- [ ] dashboard 运行态展示当前阶段的实际模型、来源和档位；离线态只展示配置，不声称发生过调用。
- [ ] 两套 dashboard 资产行为一致；避免一个页面继续读取旧 `profiles` 结构。
- [ ] `collectStatus` 读取 `evidence.jsonl` 中该 story 最近一次 builder/validator 实际调用；无 evidence 时返回 null，而不是把配置值当实际值。
- [ ] `status` 人类输出和 `status --json` 同时包含 models 配置、story difficulty/reason/escalated 与 recentActual；损坏 evidence 继续按既有容错策略处理。
- [ ] report 概要展示五项配置；story 卡展示档位、理由、升级状态；轮次时间线展示实际模型与 route source/trigger。
- [ ] 旧 evidence 无新字段时仍可渲染，显示“来源未知”而不是报错。
- [ ] 删除 report 对旧 `readModelsSpec/profiles` 的依赖；所有文案区分“配置路由”和“实际调用”。
- [ ] 不新增 `run.json`，不复制 evidence 的生命周期。
- [ ] 跑 dashboard/status/report 定向测试与全量门禁。

**Commit:** `feat: 贯通模型路由配置与实际调用可观测性`

---

### Task 9: 补齐端到端回归与失败矩阵

**Files:**

- Modify: `src/engine/loop.test.ts`
- Modify: `src/cli.test.ts`
- Modify: `src/engine/__fixtures__/fake-agent.mjs`
- Modify as needed: related `*.test.ts` fixtures only

- [ ] 建立三 runner fake-agent 表格测试，覆盖无 models、三档初始、升级后、validator、三个 CLI 覆盖的最终 argv。
- [ ] 覆盖所有启动拒绝：旧 schema、未知键、半套难度、runner 错配、discovery error、effective model missing、CLI model missing、CLI/账号未就绪。
- [ ] 覆盖可继续分支：discovery unsupported、被 CLI 完全遮蔽的 stale 配置、旧 state 缺 escalated、旧 evidence 无 route 字段。
- [ ] 覆盖三种升级触发与四类不触发事件，断言升级从下一轮生效而非当前失败轮中途重跑。
- [ ] 覆盖 agent 对 `escalated` 的双向篡改、进程重启后的 sticky、blocked 不再调 agent。
- [ ] 覆盖 `models.runner` 自动选 Cursor/Codex，以及无 models 的历史默认 Claude。
- [ ] 全部测试使用 fixture/环境变量，不依赖开发机真实账号、网络或已安装 Cursor。
- [ ] 跑 `npm run typecheck && npm test && npm run build`；检查 dist 仍包含 dashboard/instructions/skills 既有资产。

**Commit:** `test: 补全模型路由端到端与失败矩阵`

---

### Task 10: 同步公开文档、版本与发布前检查

**Files:**

- Modify: `README.md`
- Modify: `docs/architecture.md`
- Modify: `docs/glossary.md`
- Modify as evidence requires: `docs/patterns.md`
- Modify: `package.json`
- Modify: `package-lock.json`
- Modify via version hook: `.claude-plugin/plugin.json`
- Modify via version hook: `.cursor-plugin/plugin.json`
- Modify via version hook: `.codex-plugin/plugin.json`
- Update status after implementation: `docs/superpowers/specs/2026-07-21-model-routing-redesign.md`
- Update status after implementation: `docs/superpowers/plans/2026-07-21-model-routing-redesign.md`

- [ ] README 更新 `prd.json` schema、难度规则摘要、三 runner 启动方式、`models [runner] --json`、三个 CLI 覆盖、发现三态和严格错误行为。
- [ ] README 明确 Claude/Cursor 无公开机器模型列表时的人工清单路径，不承诺“自动发现所有模型”。
- [ ] 架构图/模块表加入 discovery、preflight、difficulty → route → evidence 数据流；词汇表定义“难度档位”“初始路由”“有效失败”“升级状态”。
- [ ] 只有实现中形成可复用陷阱时才更新 patterns；不要把本规格全文复制进去。
- [ ] 运行 `npm version 0.23.0 --no-git-tag-version`，让 version hook 同步三个插件清单；检查 package/lock/manifests 版本一致。
- [ ] 运行 `npm run typecheck && npm test && npm run build`，再运行针对临时 workspace 的三 runner fake smoke test。
- [ ] 运行 `git diff --check`，核对 `git status --short` 只包含本功能文件，不纳入用户已有 `.superpowers/` 等无关变更。
- [ ] 完成人工 review 后把新 spec/plan 状态改为 done；ADR-011 保持 active，ADR-006/010 保持 superseded。
- [ ] 先提交和评审，不自动 tag/push/publish；发布动作继续遵守现有 review-loop 与人工授权。

**Commit:** `docs: 完成模型路由重设计文档与 0.23.0 版本同步`

## Definition of Done

1. 三 runner 在零配置时保持各自默认模型；启用配置后，三种难度首轮模型确定可测。
2. gate、validator reject、completed no-op 首次发生后，下一轮稳定走 escalation；异常退出和环境故障不升级。
3. 新旧非法 schema、runner 错配与可确认的有效模型失效均在循环前失败，无静默回退。
4. `coding-x models --json` 三态稳定可机读，Codex adapter 由协议 fixture 验证，Claude/Cursor unsupported 不抓 TUI。
5. `escalated` 向后兼容旧 state、由引擎独占、跨进程保留且被篡改会恢复留痕。
6. `prd-to-json` 完成五模型选择、固定难度规则、可审计理由、再派生保留/重置与 blocked 决策。
7. console、dashboard、status、evidence、report 对配置与实际调用的术语一致。
8. README/架构/词汇表/插件版本同步到 0.23.0，`npm run typecheck && npm test && npm run build` 全绿。
