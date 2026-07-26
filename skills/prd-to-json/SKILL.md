---
name: prd-to-json
description: "将 PRD 转换为 prd.json 格式供 Ralph 引擎执行，并把增强后的 stories 回写源 PRD（转换闭环）。当你已有 PRD 并需要将其转换为 Ralph 的 JSON 格式时使用。触发词：将prd 转成 prd.json"
---

# PRD → prd.json 转换器

将现有 PRD 转换为 Ralph 引擎用于自主执行的 prd.json 格式。

---

## 工作流程

获取 PRD（markdown 文件或文本；PRD 通常位于 `docs/prds/`，monorepo 中也可能在 `<子项目>/docs/prds/`——但对来源路径无硬依赖，任何路径或直接粘贴的文本都可以）并将其转换为 `prd.json`（保存到当前项目根路径下 `.workspace/prd.json`）。

## 写入前：活跃运行检查

在创建、改写、归档或删除 `.workspace/` 中的任何文件之前，先运行 `npx coding-x doctor --workspace .workspace`，读取其中的 workspace 锁结论：

1. 若 doctor 报告 `engine.lock` 对应“引擎运行中”，立即停止派生；本次必须保持零写入，不得归档、覆盖、删除或修复任何 workspace 文件。
2. 若锁被判定为陈旧或损坏，只能请用户确认对应进程确实不再运行；不得删除 `engine.lock`，也不得由 skill 擅自接管或清锁。用户确认后仍由后续引擎命令按自身锁协议处理。
3. 若 doctor 无法启动、输出中断，或输出不含可判定的 workspace 锁结论，停止派生并说明无法建立单写者前提，不能把“检查失败”当作“没有活跃运行”。doctor 的整体退出码可能受其他体检项影响；只要完整输出中有明确锁结论，本节不把无关项的非零退出误判成锁检查失败。
4. 完成需求澄清、模型选择、对照表等只读准备后，在真正写入前再次运行同一 doctor 命令；只要结论变为活跃、无法判定或与首次检查不一致，就停止派生并保持零写入。

这是协作层的尽力防护，不能消除检查与首次写入之间的 TOCTOU 窗口；因此不得绕过引擎自己的 `engine.lock` 协议，也不得把本检查描述成强事务锁。

---

## 写入前：workspace Git 隔离

在创建、改写或归档 `.workspace/` 中的任何文件之前，先机械检查它不会混入 story commit：

1. 运行 `git rev-parse --is-inside-work-tree`。若当前目录不是 Git worktree，说明已跳过本项并继续。
2. 在 Git worktree 中运行 `git ls-files -- .workspace`。只要有输出，就停止写入并列出已跟踪文件；说明 ignore 规则不会自动移除既有索引项，且不得自动执行 `git rm --cached`。
3. 若没有已跟踪文件，运行 `git check-ignore -q --no-index .workspace/`。退出码为 0 才表示已隔离；未命中时停止写入，建议用户添加适合其仓库的 ignore 规则，但不得自动修改 `.gitignore`。
4. 遇到已跟踪或未忽略的 workspace 时，必须等用户明确选择如何处理并重新检查；用户也可以明确选择知情继续，不能由 skill 静默代替用户决策。

这些检查只读 Git 状态。不要自动改 Git 索引或仓库忽略策略。

---

## 输出格式

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name-kebab-case]",
  "sourcePrd": "docs/prds/prd-[feature-name].md",
  "qualityContractDigest": "sha256:<.coding-x/quality.json 的规范化摘要>",
  "qualityChecks": {
    "test": { "notApplicable": "<示意；实际原样复制 doctor.quality.derivedChecks.test>" },
    "build": { "notApplicable": "<示意；实际原样复制 doctor.quality.derivedChecks.build>" },
    "static": { "notApplicable": "<示意；实际原样复制 doctor.quality.derivedChecks.static>" },
    "security": { "notApplicable": "<示意；实际原样复制 doctor.quality.derivedChecks.security>" }
  },
  "tdd": {
    "coverageCheck": "node scripts/tdd-coverage-gate.mjs",
    "sourcePathspecs": [":(glob)src/**"],
    "policyFiles": [
      {
        "path": "scripts/tdd-coverage-gate.mjs",
        "sha256": "<64 位小写十六进制 SHA-256>"
      }
    ],
    "baselineRef": "<完整 Git commit id>",
    "forbiddenAddedPatterns": ["istanbul ignore", "c8 ignore"]
  },
  "models": {
    "runner": "codex",
    "builder": { "low": "model-low", "medium": "model-medium", "high": "model-high" },
    "validator": "model-validator",
    "escalation": "model-escalation"
  },
  "description": "[Feature description from PRD title/intro]\n\n【溯源】本文件由 docs/prds/prd-[feature-name].md 派生：需求背景不明时先查阅该文档理解意图，但验收只以本文件中各 story 的 acceptanceCriteria 为准。若发现源文档与 acceptanceCriteria 冲突、或某条标准无法成立，不要自行取舍：按 acceptanceCriteria 实现，并把冲突写入同目录 state.json 中该 story 的 notes（以 [需求冲突] 开头），留给人工裁决。",
  "userStories": [
    {
      "id": "US-001",
      "title": "[Story title]",
      "description": "As a [user], I want [feature] so that [benefit]",
      "acceptanceCriteria": [
        "Criterion 1",
        "Criterion 2",
        "Typecheck passes"
      ],
      "priority": 1,
      "difficulty": "medium",
      "difficultyReason": "命中 medium-1：需沿用 src/api/client.ts 的既有接线模式连接页面与接口。"
    }
  ]
}
```

`sourcePrd` 仅当源是**仓库内 markdown 文件**时填写（仓库相对路径）；源是粘贴文本或仓库外文件时省略该字段，【溯源】段首句相应改为「本文件由用户提供的 PRD 文本派生」，其余仲裁文案保持不变。

---

## 质量契约绑定（必填）

转换前运行 `npx coding-x doctor --json --workspace .workspace`，读取
`.coding-x/quality.json` 的状态和规范化摘要：

1. 契约缺失、非法、schema 过新或固定 coding-x 版本不匹配时立即停止，引导用户先运行
   `coding-x init`；不得退回 PRD 自带命令，也不得编造项目检查。
2. 把 doctor 返回的 `quality.digest` 原样写入顶层 `qualityContractDigest`。
3. 把 doctor 返回的 `quality.derivedChecks` 原样写入顶层 `qualityChecks`。这是机器派生快照，
   不能让用户或模型重新输入、改写、删减，也不能从旧 PRD 复用。
4. 真正写入前再次运行 doctor；若摘要与首次读取不同，停止并重新派生，不能把旧摘要写入。

质量契约是唯一人工维护来源；PRD 同时绑定摘要和不可手改的派生快照。引擎会逐字段核对，
任何差异都按配置错误停止。

---

## tdd：测试先行与可验证覆盖率（可选配置）

stories 定稿且质量契约绑定后，必须明确询问用户是否启用 TDD。用户不启用时完全
省略 `tdd`；不能根据 PRD 中出现“测试”一词自动开启。启用时按下面顺序一次完成发现、
确认和真实基线，不能只写一个看起来合理的命令：

1. 确认这是新项目或存量项目。不能从年龄、文件数量或 Git 历史长度猜；把现有生产代码与
   已有覆盖率政策的证据呈现给用户裁决。
2. 从项目配置、测试脚本和覆盖率工具中提取真实候选，确认测试框架、覆盖率提供者、分支
   覆盖率是否开启、零测试时是否返回非零，以及排除项从哪里读取。提取不到就停止；不得编造
   `coverageCheck`，也不使用 AI 判断测试是否有意义来替代机械命令。
3. 提议一组完整配置：
   - `coverageCheck`：项目原生、可直接运行的完整命令；它必须自行保证工具缺失、零测试、
     覆盖不足和总体回退时返回非零；
   - `sourcePathspecs`：只覆盖生产代码的非空 Git pathspec，且与覆盖命令统计范围对齐；
   - `policyFiles`：覆盖命令委托的阈值、排除、零测试、基线与差异覆盖脚本/配置；完全写在
     `coverageCheck` 中时可以是空数组；
   - `baselineRef`：`git rev-parse HEAD^{commit}` 得到的完整 commit id；
   - `forbiddenAddedPatterns`：目标覆盖工具能关闭统计的行级忽略语法，按不区分大小写的
     字面量列出。
4. 把项目类型、完整命令、生产路径、受保护文件、完整基线和禁止标记合成一张表，请用户
   **一次确认**。不能把阈值、排除或零测试策略拆给 agent 在运行时自行决定。
5. 用户确认后、写入前，在项目根真实运行原样的 `coverageCheck`。同时核对输出和产物，
   确认真正执行了至少一个测试、统计了分支覆盖率、阈值和排除符合已批准政策。命令仅返回
   0 但没有测试，不能视为有效基线。
6. 对每个 `policyFiles.path` 解析真实路径，确认仍在 Git 根内，再计算文件字节的 `sha256`；
   摘要必须是 64 位小写十六进制。最后再次运行写入前的锁与 Git 隔离检查，再写入。

默认政策：

- 新项目：行覆盖率与分支覆盖率都不低于 90%，零测试失败。
- 存量项目：总体行/分支覆盖率不低于启用基线，新增/改动可执行行覆盖率不低于 90%，
  零测试失败。启用基线的数字与比较逻辑必须进入受保护政策文件。

用户可以在启用前批准不同政策，但转换 skill 不得自行降低阈值、不得自行扩大排除，也不得
允许零测试。运行中若需要改变 `coverageCheck`、阈值、排除、基线、生产路径、禁止标记或
任一政策文件，停止当前运行并请用户批准后重新派生；不能只重算摘要让变化静默生效。

`coverageCheck` 与质量契约中的测试可能重复时，先回到 `coding-x init` 修订契约并让用户
确认；不要在 PRD 中静默删改项目检查。TDD 是附加的测试先行门禁，不替代契约检查或每个
story 的行为 AC。

若项目将使用 Cursor Agent，写入 TDD 配置后只提醒用户在项目根运行
`npx coding-x hooks cursor install` 和 `npx coding-x hooks cursor status`。本 skill 不自动安装；
升级 coding-x 后需重新运行 install 刷新，撤销时运行 `npx coding-x hooks cursor remove`。
这些命令不修改 Git hooks，也不暂存或提交 `.cursor/` 文件。

配置一旦出现，五个字段必须全部存在：

```json
"tdd": {
  "coverageCheck": "node scripts/tdd-coverage-gate.mjs",
  "sourcePathspecs": [":(glob)src/**"],
  "policyFiles": [
    {
      "path": "scripts/tdd-coverage-gate.mjs",
      "sha256": "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"
    }
  ],
  "baselineRef": "0123456789abcdef0123456789abcdef01234567",
  "forbiddenAddedPatterns": ["istanbul ignore", "c8 ignore"]
}
```

首版 TDD 保护依赖 Git 基线；不在 Git worktree、没有可达 commit 或基线本身未通过时，不写
`tdd`，向用户说明准确阻碍。不要降级成一份未验证配置。

---

## models：模型路由（可选配置）

顶层可选字段。它必须在 stories 增强、拆分、排序和源 PRD 回写全部定稿之后处理；源 PRD 只保存业务意图，不写模型策略、难度或模型名。

不启用时，**同时省略**顶层 `models` 和每个 story 的 `difficulty` / `difficultyReason`。不再额外传模型 CLI 覆盖时，这是 runner-default 零配置路径，不要求存在全局模型目录；若运行时另行传入任一模型 CLI 覆盖，该 ID 仍必须在目录中声明。

启用时，配置绑定单一 runner，不跨 Claude Code、Codex、Cursor 复用：

```json
"models": {
  "runner": "codex",
  "builder": {
    "low": "model-low",
    "medium": "model-medium",
    "high": "model-high"
  },
  "validator": "model-validator",
  "escalation": "model-escalation"
}
```

五个模型值都必须从对应 runner 的全局模型目录中选择，不使用 coding-x 自造的 `default` 哨兵；如果用户把 runner 接受的 `auto` / `default` 作为真实 ID 写入目录，它只按普通 ID 处理。多个位置可以选择同一模型。目录中的声明表示用户允许 coding-x 使用该 ID，不证明账号、provider、配额或网络下实时可用；真实拒绝只会在 agent 实际调用时体现。

### 全局模型目录合同

默认配置文件是 `~/.config/coding-x/config.json`；`CODING_X_CONFIG` 可覆盖为另一个完整文件路径。只接受 version 1：

```json
{
  "version": 1,
  "models": {
    "claude": [{ "id": "sonnet", "label": "Sonnet" }],
    "codex": [{ "id": "gpt-5.6-codex", "label": "GPT-5.6 Codex" }],
    "cursor": [{ "id": "composer-2.5", "label": "Composer 2.5" }]
  }
}
```

每项 `id` 必填、`label` 可选；数组顺序就是展示顺序。配置可以只含部分 runner，但为所选 runner 配置路由时，其数组必须非空。需要定位、创建或校验文件时分别运行 `npx coding-x config path`、`npx coding-x config init`、`npx coding-x config validate`。这些命令与 `models` 都不拉起 Claude Code、Codex 或 Cursor CLI。

### 生成顺序

1. stories 定稿后，询问是否启用模型路由；不启用就省略整套字段。
2. 确认 runner：`claude`、`codex` 或 `cursor`。无法从当前宿主可靠判断时直接询问，不偷偷猜。
3. 调用 `npx coding-x models <runner> --json`：
   - `available`：使用返回的全局模型目录，保持原数组顺序；
   - `error`：停止路由配置，说明配置路径与校验错误，引导用户先运行 `config init` 或编辑后执行 `config validate`。用户仍可选择不启用路由，继续普通转换。
4. 目录错误时不得请用户在当前会话临时粘贴 ID 绕过；只能修好全局配置后重试，或明确选择不启用路由。
5. 模型列表只展示一次，然后**批量提出五道选择题**：`builder.low`、`builder.medium`、`builder.high`、`validator`、`escalation`。每项由用户从目录选择，不能替用户拍板，也不能选择目录外 ID。
6. `label` 只用于帮助识别，不构成能力或实时可用性证据。没有其他可靠资料时，不按名称、别名或自定义 ID 猜强弱，不自动推荐或判断倒挂；用户确认后允许任意组合。
7. 按下方固定规则自动评估每个 story，直接写入 `difficulty` 与 `difficultyReason`；不在写入前逐 story 设置审批门槛。
8. 写入后展示完整对照表：story、档位、理由、对应初始 builder 模型。用户提出异议时修正派生结果，不把策略写回源 PRD。

### difficulty：所需模型推理能力

`difficulty` 只衡量可靠完成 story 所需的模型推理能力，不是工期、代码行数或故事点。story 大到一次迭代无法完成时先拆分，不能用 `high` 掩盖范围问题。

判定顺序固定：先 high，再 medium，剩余同时满足 low 全部条件的才是 low；拿不准向上归档。必须结合 AC 与仓库证据，不得只做关键词匹配。

**high：任一命中**

1. `high-1`：身份认证、权限边界、安全、隐私、密钥或支付正确性。
2. `high-2`：schema 迁移、存量数据回填、不可逆写入或数据兼容。
3. `high-3`：并发、事务一致性、幂等、重试语义、复杂状态机或分布式协调。
4. `high-4`：对外 API、协议、持久化格式或兼容性合同变化。
5. `high-5`：核心架构/基础设施变化，或跨多个模块/服务且有隐含耦合。
6. `high-6`：故障可能造成数据丢失、越权、重复扣费或服务不可用等高影响后果。
7. `high-7`：仓库没有既有实现模式，需要新技术路径或解决明显未知问题。

常规前后端接线不会仅因跨两层自动成为 high。

**medium：未命中 high，且任一命中**

1. `medium-1`：沿仓库既有模式完成常规前后端接线或跨一至两个技术层。
2. `medium-2`：多分支业务规则、输入校验、异步状态或错误恢复，边界已明确。
3. `medium-3`：普通接口、页面流程、持久化操作或合同明确的第三方集成。
4. `medium-4`：修改多个相关文件/模块，需要保持既有行为并补回归测试。
5. `medium-5`：bug 根因需跨组件追踪，但不涉及 high 风险边界。
6. `medium-6`：多步骤 UI、加载/失败/刷新保持等闭环验收。

**low：未命中 high/medium，且以下全部满足**

1. `low-1`：修改范围局部，集中在单个组件、模块或一组紧密相关文件。
2. `low-2`：仓库已有明确复用模式，不需要新技术决策。
3. `low-3`：逻辑线性、边界明确，几乎没有复杂状态或多分支推理。
4. `low-4`：不改变权限、schema、外部合同、并发语义或核心基础设施。
5. `low-5`：验收结果直接可观察，回归影响有限。

`difficultyReason` 必须是一至两句，写明命中的规则编号与仓库具体证据，路径使用仓库相对路径。例如：`命中 medium-1：需沿用 src/api/client.ts 的既有接线模式连接页面与接口。` 绿地项目无现成文件时，如实写已检查目录与“无既有模式”，不要编造路径。

### 运行时升级语义（生成时必须让用户知道）

第一次有效失败——机械门禁失败、引擎接受 Validator 的 failed claim 或 builder completed no-op——会让下一轮及以后持续使用 `escalation`。超时、非零退出、认证、网络或环境错误不升级。升级状态保存在 `state.json.escalated`，与 `retryCount` 分离且只由引擎修改。

---

## Story 大小：第一规则

**每个 story 必须能在一次 Ralph 迭代（一个 context window）中完成。**

Ralph 每次迭代都会生成一个新的 Claude code 实例，没有之前工作的记忆。如果 story 太大，LLM 在完成之前会用完 context，并产生损坏的代码。

### 合适大小的 stories：
- 添加 database 列和 migration
- 向现有页面添加 UI component
- 使用新逻辑更新 server action
- 向列表添加 filter dropdown

### 太大（需要拆分）：
- "构建整个 dashboard" - 拆分为：schema、queries、UI components、filters
- "添加 authentication" - 拆分为：schema、middleware、login UI、session handling
- "重构 API" - 拆分为每个 endpoint 或 pattern 一个 story

**经验法则：** 如果你无法用 2-3 句话描述这个变更，那就太大了。

---

## Story 排序：依赖优先

Stories 按 priority 顺序执行。较早的 stories 不能依赖于较晚的。

**正确顺序：**
1. Schema/database 变更（migrations）
2. Server actions / backend logic
3. 使用 backend 的 UI components
4. 聚合数据的 Dashboard/summary views

**错误顺序：**
1. UI component（依赖于尚不存在的 schema）
2. Schema 变更

---

## Acceptance Criteria：必须可验证

每个标准必须是 Ralph 可以检查的内容，而不是模糊的内容。

### 好的标准（可验证）：
- "向 tasks 表添加 `status` 列，默认值为 'pending'"
- "Filter dropdown 有选项：All、Active、Completed"
- "点击删除显示确认对话框"
- "Typecheck 通过"
- "Tests 通过"

### 不好的标准（模糊）：
- "工作正常"
- "用户可以轻松执行 X"
- "良好的 UX"
- "处理边缘情况"

### 始终作为最终标准包含：
```
"Typecheck passes"
```

对于具有可测试逻辑的 stories，还应包含：
```
"Tests pass"
```

### 对于更改 UI 的 stories，还应包含：

具体的 agent-browser 浏览器断言——打开哪个页面、执行什么操作、观察到什么结果（形态见下节的扩写示例）：

```json
"Use agent-browser to open [url/path] and [具体操作]",
"[具体文案/组件/状态] is visible on the page"
```

Frontend stories 在视觉验证之前不算完成。Ralph 将使用 agent-browser 导航到页面，与 UI 交互，并确认更改有效。

### 不要保留泛化的浏览器标准

如果输入 PRD 里出现下面这种标准：

- "Verify in browser using agent-browser"
- "在浏览器中验证"
- "验证页面正常工作"

转换成 `prd.json` 时，不要原样照搬。必须扩写成 validator 真能执行的断言。

例如不要写：

```json
"Verify in browser using agent-browser"
```

要改写成类似：

```json
"Use agent-browser to open /login and submit valid credentials",
"A token is stored in localStorage after successful login",
"The page redirects to ?subdomain=user and protected content is visible"
```

### 认证、支付、上传、导入导出、多步表单必须写闭环

如果 story 属于高风险用户流程，必须把验收标准写成完整闭环，而不是单点动作。

最低要求：

- 成功路径可真实跑通
- 关键运行时状态可观察
- 页面或接口结果可观察
- 刷新后状态是否保持可观察
- 失败路径至少有一个明确断言

认证类最低模板：

```json
[
  "Register a new unique account successfully",
  "Log in with the newly registered account successfully",
  "Store the auth token in localStorage after login",
  "Redirect to the correct protected portal based on primaryIdentity",
  "Restore the logged-in state after a page refresh",
  "Show a clear error message for invalid credentials"
]
```

### 前后端集成必须验证运行时可达

只要 story 涉及前端调用后端，就不能只写“改成调用新接口”。

必须补至少一条运行时标准：

- 请求在本地开发环境中真实到达目标后端接口
- 不是打到前端 dev server 自己的假路径
- 成功和失败结果都能在 UI 上观察到

如果 PRD 中缺了这层约束，转换时主动补上。

---

## 转换规则

1. **每个 user story 成为一个 JSON 条目**
2. **IDs**：源 PRD 的 story 标题带 `US-nnn` 编号时（prd-generate 产出格式）**必须沿用**；仅当源无编号时才从 US-001 顺序分配。转换中新增/拆分出的 story 顺延历史最大编号（含源 PRD 中已删除 story 曾占用的编号，不回收），不插号、不重排
3. **Priority**：基于依赖顺序，然后是文档顺序
4. **不写状态字段**：passes/validated/notes/retryCount/blocked/escalated 一律不出现在 prd.json——执行状态由引擎在同目录 `state.json` 初始化与维护
5. **branchName**：从功能名称派生，kebab-case，前缀为 `ralph/`
6. **始终添加**："Typecheck passes" 到每个 story 的 acceptance criteria
7. **sourcePrd 溯源**：源是仓库内 markdown 文件时，顶层写入 `sourcePrd`（仓库相对路径）；粘贴文本或仓库外来源省略
8. **【溯源】仲裁段**：`description` 末尾固定追加【溯源】段（见上方输出格式），保证 builder/validator 拿到统一的冲突处理规则
9. **质量契约绑定**：doctor 必须确认契约有效且版本匹配；顶层写入
   `qualityContractDigest`，并把 `quality.derivedChecks` 原样写入结构化 `qualityChecks`；
   不得写 0.29 及更早版本的 shell 字符串数组
10. **tdd 门禁（可选）**：只在用户明确启用、一次确认完整政策且真实基线通过后写入；否则省略整个字段
11. **models 路由（可选）**：只在 stories 定稿后按上方「models」节处理；用户不启用时省略整段及所有 story 难度字段

### 转换时的增强规则

1. 如果原 PRD 的 acceptance criteria 过于抽象，主动重写成可执行断言
2. 如果某个 UI story 依赖 dev proxy、env、base URL、gateway、seed data 才能成立，而原 PRD 没拆，主动增加前置 story
3. 如果多个 story 合起来才构成一个真实用户流程，主动增加最后一个“闭环集成验证” story
4. 不要让“调用接口”“保存 token”“完成接入”这种实现描述直接进入最终 `prd.json`
5. 优先写 validator 可以用代码检查、curl、agent-browser、localStorage、URL、页面文案、截图来确认的标准

---

## 转换闭环：回写源 md 与对照表

转换不是只读操作。凡是转换过程中做了增强（重写模糊 AC、扩写浏览器断言、新增前置/闭环 story、拆分大 story），源 PRD 与 prd.json 就已经不一致——必须闭环，否则 validator 实际执行的验收标准从未被人审过。

**1. 回写源 md（仅当源是仓库内文件时）：**

- 把增强/拆分后的最终 stories 回写进源 PRD 的 `## User Stories` 章节：标题保持 `### US-nnn: 标题` 格式，AC 一律写成未勾选的 `- [ ]` 清单（执行状态永不回流 md）
- 更新 frontmatter 的 `updated` 为当天日期
- 只允许改 User Stories 章节与 frontmatter `updated`；Goals、Non-Goals、Functional Requirements 等其余章节一律不动
- 源是粘贴文本或仓库外文件时跳过回写，只输出对照表

**2. 输出对照表（在会话中呈现给用户）：**

| 源 story | 产出 story | 变化 |
|---|---|---|
| US-001 | US-001 | 沿用 |
| US-002 | US-002 | AC 第 3 条改写为可执行断言 |
| — | US-005 | 新增（US-002 的 dev proxy 前置） |
| US-003 | US-006、US-007 | 拆分 |

对照表让用户一眼看出机器即将执行的验收标准与他写的 PRD 差在哪里。用户有异议时，先改源 md 再重新转换；不要直接手改 prd.json。

---

## 拆分大型 PRD

如果 PRD 有大型功能，请拆分它们：

**原始：**
> "添加用户通知系统"

**拆分为：**
1. US-001: 向 database 添加 notifications 表
2. US-002: 创建用于发送通知的 notification service
3. US-003: 向 header 添加 notification bell 图标
4. US-004: 创建 notification dropdown panel
5. US-005: 添加 mark-as-read 功能
6. US-006: 添加 notification preferences 页面
7. US-007: 使用浏览器验证通知创建到展示的完整闭环

每个都是一个可以独立完成和验证的专注变更。

### 对认证和账号体系的拆分规则

不要只拆成：

1. HTTP client
2. AuthContext
3. Login page

这还不够。

至少应拆成：

1. 前端到后端的认证请求链路可达
2. 注册接口接入
3. 登录接口接入
4. 登录态恢复与退出
5. 注册→登录→进入受保护页面→刷新恢复登录态的闭环验证

最后一个 story 很关键。没有它，Ralph 很容易把“代码接上了”误判成“功能完成了”。

---

## 示例

**输入 PRD：**
```markdown
# Task Status Feature

Add ability to mark tasks with different statuses.

## Requirements
- Toggle between pending/in-progress/done on task list
- Filter list by status
- Show status badge on each task
- Persist status in database
```

**输出 prd.json：**
```json
{
  "project": "任务应用",
  "branchName": "ralph/task-status",
  "description": "任务状态功能 - 使用状态指示器跟踪任务进度\n\n【溯源】本文件由用户提供的 PRD 文本派生：验收只以本文件中各 story 的 acceptanceCriteria 为准。若发现某条标准无法成立，不要自行取舍：按 acceptanceCriteria 实现，并把冲突写入同目录 state.json 中该 story 的 notes（以 [需求冲突] 开头），留给人工裁决。",
  "userStories": [
    {
      "id": "US-001",
      "title": "向任务表添加状态字段",
      "description": "作为开发者，我需要在数据库中存储任务状态。",
      "acceptanceCriteria": [
        "添加 status 列：'pending' | 'in_progress' | 'done' (默认 'pending')",
        "成功生成并运行 migration",
        "Typecheck 通过"
      ],
      "priority": 1
    },
    {
      "id": "US-002",
      "title": "在任务卡片上显示状态徽章",
      "description": "作为用户，我想一眼看到任务状态。",
      "acceptanceCriteria": [
        "每个任务卡片显示彩色状态徽章",
        "徽章颜色：灰色=pending，蓝色=in_progress，绿色=done",
        "Typecheck 通过",
        "Use agent-browser to open the task list page and confirm every visible task card shows a status badge",
        "No console errors are present on the page"
      ],
      "priority": 2
    },
    {
      "id": "US-003",
      "title": "向任务列表行添加状态切换",
      "description": "作为用户，我想直接从列表更改任务状态。",
      "acceptanceCriteria": [
        "每行有状态下拉菜单或切换按钮",
        "更改状态后立即保存",
        "UI 更新无需刷新页面",
        "Typecheck 通过",
        "Use agent-browser to change a task status from the list view and confirm the badge updates immediately",
        "Refresh the page and confirm the updated status persists"
      ],
      "priority": 3
    },
    {
      "id": "US-004",
      "title": "按状态过滤任务",
      "description": "作为用户，我想过滤列表以仅查看特定状态。",
      "acceptanceCriteria": [
        "过滤下拉菜单：All | Pending | In Progress | Done",
        "过滤状态持久化在 URL params 中",
        "Typecheck 通过",
        "Use agent-browser to switch the filter and confirm only matching tasks remain visible",
        "Refresh the page and confirm the selected filter is restored from the URL params"
      ],
      "priority": 4
    }
  ]
}
```

---

## 归档之前的运行

**在编写新的 prd.json 之前，检查是否存在来自不同功能的现有文件：**

1. 如果存在，读取当前的 `prd.json`
2. 检查 `branchName` 是否与新功能的 branch name 不同
3. 如果不同且 `progress.md` 在 header 之外有内容：
   - 创建归档文件夹：`.workspace/archive/YYYY-MM-DD-feature-name/`
   - 将当前的 `prd.json`、`state.json`、`progress.md`、`review-*.md` 留痕、`evidence.jsonl`、`report.html`、`screenshots/` 目录与 `prd.tampered-*.json`（均为如存在）复制到归档；`validation-result.json` 是单轮瞬时 IPC，完整 claim 已进入 evidence，**不复制**
   - **删除工作区中的旧 `state.json`**——story id 惯例都从 US-001 起编，新旧几乎必然撞车；引擎信任既存 state.json，残留会把旧轮的 `passes: true` 误判为新 story 已完成、循环空转结束
   - **同时删除工作区中的旧 `evidence.jsonl`**——记录按轮次追加且不含轮次归属标识以外的运行标记，残留旧轮记录会污染新轮验证报告的门禁历史与时间线
   - **同时删除工作区中的旧 `prd.tampered-*.json`**——取证已随归档保留，残留会污染新轮报告红旗区
   - **同时删除工作区中的旧 `validation-result.json`**——它只能由当前引擎 request 消费；崩溃残留既不归档，也不得带入新 PRD
   - 使用新的 header 重置 `progress.md`

如果你在运行之间手动更新 prd.json，请先按上述步骤归档旧运行，再写入新的 prd.json。

---

## 再派生：需求中途变更

源 PRD 修改后重新执行本 skill，若 `.workspace/prd.json` 已存在且 `branchName` 与新转换结果**相同**（同一功能），进入再派生模式（branchName 不同则走上方「归档之前的运行」流程）：

1. 先把现有 `prd.json`（以及 `state.json`、`review-*.md` 留痕文件、`evidence.jsonl`，如存在）复制到 `.workspace/archive/YYYY-MM-DD-HHmm-rederive-[feature-name]/`（带时分，避免同日多次再派生互相覆盖；`progress.md` 不动）；**同时删除工作区中的旧 `evidence.jsonl` 与 `validation-result.json`**——需求变更后旧登记按 acIndex 位置匹配会错挂，瞬时 result 也不再属于新 request，一律作废重验
2. 先处理模型再派生，再用新结果**整体重写** `prd.json`：
   - runner 相同，且原五个模型在本次 `coding-x models <runner> --json` 返回的全局目录中仍有声明 → 保留原选择，不重复提问
   - runner 变化、任一模型被移出目录、目录读取失败，或用户明确要求重配 → 停止保留，重新走目录选择与五道选择题；目录失败时不得退回历史列表或会话内临时列表
   - story 内容无实质变化 → 保留原 `difficulty` 与 `difficultyReason`，包括用户事后修正
   - story 内容有实质变化 → 按固定规则重新评估；用户可明确要求全量重新评估
   - 原 `tdd` 配置与本次仓库事实完全一致且政策文件摘要未变 → 原样保留；任何命令、路径、
      阈值、排除、基线、禁止标记或摘要变化都必须重新走 TDD 一次确认与真实基线，不能静默
      更新摘要
   - 当前质量契约摘要与原 `qualityContractDigest` 不同 → 使用当前摘要整体重新派生；旧运行
     结果不再可复用，不能只修改摘要并保留已通过状态
3. 若 `state.json` 存在，先把旧 state 缺失的 `validated` 按同条 `passes` 理解、缺失的 `escalated` 按 `false` 理解，再按 story id 对齐调整（不存在则跳过，引擎会自动初始化）：
   - id 相同且 acceptanceCriteria 无实质变化 → 该 id 状态原样保留
   - id 相同但 acceptanceCriteria 有实质变化 → 该 id 重置：passes 与 validated 置 `false`、retryCount 置 `0`、blocked 置 `false`、escalated 置 `false`；notes 写入 `[需求已变更 YYYY-MM-DD] 验收标准已更新，按新标准重验（原 passes=true/false）`——若原 notes 中存在以 `[需求冲突]` 或 `[需要人工核实]` 开头的行，将它们原样保留在新内容之前（未裁决的仲裁记录不得因再派生而丢失）
   - acceptanceCriteria 未变，但 difficulty、models.runner 或该 story 对应的初始 `models.builder[difficulty]` 变化 → 只把 escalated 重置为 `false`，其他执行状态保留
   - 只改 difficultyReason、validator 或 escalation 模型 → escalated 保留；它们不改变该 story 的初始路由
   - 上述路由变化影响已 blocked story 时，必须让用户选择“保持 blocked”或“用新路由重试”；选择重试时同时设置 passes=false、validated=false、blocked=false、retryCount=0、escalated=false，并在 notes 追加模型路由重试说明
   - 新增 id → 不写入 state.json（引擎按初始状态处理）
   - 源 md 已删除的 id → 从 state.json 移除该键，在对照表标注「已移除」
4. 输出对照表时增加「难度处理」「模型路由」「状态处理」列（保留/重评/重置/新增/移除）

验收实质变化的判定：AC 条目的增删、断言内容的改变算；纯错别字/措辞润色不算。story 难度输入的实质变化还包括 title/description/AC 的语义改变。拿不准时按「有实质变化」处理（宁可重验，不可漏验）。

---

## 保存前检查清单

在编写 prd.json 之前，验证：

- [ ] 已运行 `npx coding-x doctor --workspace .workspace`；未发现“引擎运行中”，且真正写入前再次运行的结论仍可判定、未变化；未删除 `engine.lock`
- [ ] `.workspace/` 已通过 Git 隔离检查；若已跟踪或未忽略，已取得用户明确选择，且未自动修改 `.gitignore` 或执行 `git rm --cached`
- [ ] **之前的运行已归档**（如果 prd.json 存在且 branchName 不同，请先归档，并删除工作区残留的旧 state.json、evidence.jsonl、validation-result.json、prd.tampered-*.json）
- [ ] 每个 story 可以在一次迭代中完成（足够小）
- [ ] Stories 按依赖顺序排序（schema 到 backend 到 UI）
- [ ] 每个 story 都有 "Typecheck passes" 作为标准
- [ ] UI stories 的浏览器标准已经展开为页面、操作、期望结果，而不是一句泛化短语
- [ ] 认证/支付/上传/多步流程 stories 有真实闭环标准
- [ ] 前后端集成 stories 包含运行时可达验证
- [ ] 复杂功能最后有一个闭环集成验证 story
- [ ] Acceptance criteria 是可验证的（不模糊）
- [ ] 没有 story 依赖于后面的 story
- [ ] story 不含任何状态字段（passes/validated/notes/retryCount/blocked/escalated 均不出现，状态归 state.json）
- [ ] 顶层 `sourcePrd` 已填（源为仓库内文件时），`description` 末尾带【溯源】仲裁段
- [ ] `npx coding-x doctor --json` 确认质量契约有效且固定版本匹配；顶层
  `qualityContractDigest` 等于 doctor 当前摘要；结构化 `qualityChecks` 与
  `doctor.quality.derivedChecks` 逐字段一致，没有旧 shell 字符串数组
- [ ] tdd 已配置时：用户明确选择启用并确认新项目或存量项目；`coverageCheck` 已真实运行且至少执行一个测试、统计分支覆盖率、按批准阈值返回；`sourcePathspecs` 与覆盖范围一致；完整 `baselineRef` 可达；每个政策文件在 Git 根内且 `sha256` 与当前字节匹配；禁止标记已按目标工具确认
- [ ] tdd 已配置且将使用 Cursor Agent 时：已提醒用户显式运行 `npx coding-x hooks cursor install` 与 `npx coding-x hooks cursor status`；转换过程未自动安装
- [ ] tdd 未配置时：整个字段已省略；没有留下半套或未经基线验证的配置
- [ ] models 已配置时：runner 已确认；五个模型 ID 全部由用户从该 runner 的全局模型目录选择；每个 story 都有 low/medium/high 与含规则编号、仓库路径的非空理由
- [ ] models 未配置时：所有 story 都没有 difficulty/difficultyReason，避免半套配置
- [ ] 增强/拆分结果已回写源 md（仅仓库内文件源），frontmatter `updated` 已更新
- [ ] 已在会话中输出转换对照表
- [ ] 同功能再派生时已先归档副本（含 state.json、evidence.jsonl），已删除工作区中的旧 evidence.jsonl 与瞬时 validation-result.json，并按 id、难度与初始路由精确调整 state.json；blocked 路由重试已由用户选择

写入后运行：`npx coding-x repair`（用 jsonrepair 修复并二次校验 prd.json 与 state.json，后者不存在则跳过）。
