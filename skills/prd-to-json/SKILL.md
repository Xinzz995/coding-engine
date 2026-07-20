---
name: prd-to-json
description: "将 PRD 转换为 prd.json 格式供 Ralph 引擎执行，并把增强后的 stories 回写源 PRD（转换闭环）。当你已有 PRD 并需要将其转换为 Ralph 的 JSON 格式时使用。触发词：将prd 转成 prd.json"
---

# PRD → prd.json 转换器

将现有 PRD 转换为 Ralph 引擎用于自主执行的 prd.json 格式。

---

## 工作流程

获取 PRD（markdown 文件或文本；PRD 通常位于 `docs/prds/`，monorepo 中也可能在 `<子项目>/docs/prds/`——但对来源路径无硬依赖，任何路径或直接粘贴的文本都可以）并将其转换为 `prd.json`（保存到当前项目根路径下 `.workspace/prd.json`）。

---

## 输出格式

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name-kebab-case]",
  "sourcePrd": "docs/prds/prd-[feature-name].md",
  "qualityChecks": ["npm run typecheck", "npm test"],
  "models": { "claude": { "builder": "sonnet", "validator": "opus", "escalation": "opus" } },
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
      "priority": 1
    }
  ]
}
```

`sourcePrd` 仅当源是**仓库内 markdown 文件**时填写（仓库相对路径）；源是粘贴文本或仓库外文件时省略该字段，【溯源】段首句相应改为「本文件由用户提供的 PRD 文本派生」，其余仲裁文案保持不变。

---

## qualityChecks：机械门禁命令（推荐配置）

顶层可选字段。引擎每轮 builder 之后、validator 之前逐条 shell 执行这些命令（fail-fast），任一非零退出码即确定性打回当前 story（passes 设回 false、retryCount +1、notes 写 `[门禁失败]` 详情）并跳过该轮 validator。

生成规则：

- 从目标项目提取候选：`package.json` scripts 里的 typecheck / lint / test 类命令、根 `AGENTS.md` 的关键命令节
- 廉价检查放前面（typecheck → lint → test）：fail-fast 下失败得更早
- 把候选命令随转换对照表一并呈现，请用户确认
- 提取不到可靠命令时省略该字段（门禁不启用），不要编造

---

## models：模型路由（可选配置）

顶层可选字段。引擎按它给 builder/validator 拉起命令追加 `--model <名字>`；缺失时不传（沿用用户 CLI 默认模型，行为与历史版本一致）。模型名是不透明字符串直接透传，引擎不校验、不维护模型名单。**模型名对 agent 工具不可移植**（claude 用别名如 opus/sonnet/haiku，codex 用其 CLI 接受的 gpt-* 名字）——推荐按工具分段，让每个工具都能定位自己的模型名：

```json
"models": {
  "claude": {
    "builder": "sonnet",
    "validator": "opus",
    "escalation": "opus",
    "escalateAfter": 1
  },
  "codex": {
    "builder": "gpt-5-codex"
  }
}
```

- 键=agent 工具名（`claude`/`codex`/…，与 `npx coding-x [tool]` 对应）；运行时取所用工具的段，缺当前工具的段则该次运行不启用路由（引擎警告，不会把别的工具的模型名传错）
- 段内 `builder` / `validator`：两阶段各自的默认模型
- 段内 `escalation`：story 被打回 `retryCount ≥ escalateAfter`（缺省 1）后 builder 的升级模型——失败才花大钱；`escalateAfter` 须 < 5（打回上限，达 5 该 story 已 blocked），否则升级永不生效（引擎启动时会警告）
- story 级可选 `"model"` 字段覆盖 builder（只对该 story 生效；validator 恒定不受影响）：字符串（对所有工具原样透传）或同样按工具分段 `{ "claude": "opus", "codex": "..." }`（缺当前工具条目时回落顶层段）
- 旧扁平形状 `{ "builder": "...", "validator": "..." }` 仍被接受（对所运行工具原样透传），但只适合单工具场景；两种形状不可混用（整体判非法）

生成规则：

- 先问用户是否需要模型分层；不需要或拿不准时**整段省略**（缺省即现状，不要编造）
- 问清用户实际会用哪些 agent 工具跑引擎，**只为用户确认过的工具生成段**——不要替未确认的工具编造模型名
- 配置时默认姿势：**validator 能力 ≥ builder**——validator 是把关方，降它的级会重开「共谋假绿」的门
- 逐 story 评估复杂度再标 `model`：跨模块/数据迁移/状态机类留给强模型，纯样板/文案/单文件小改可标快模型；拿不准不标（回落顶层 builder）
- 模型名必须与用户确认后写入：用户可用哪些模型只有用户知道，引擎不校验，名字写错会在循环里快速失败白烧迭代数

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
4. **不写状态字段**：passes/notes/retryCount/blocked 一律不出现在 prd.json——执行状态由引擎在同目录 `state.json` 初始化与维护
5. **branchName**：从功能名称派生，kebab-case，前缀为 `ralph/`
6. **始终添加**："Typecheck passes" 到每个 story 的 acceptance criteria
7. **sourcePrd 溯源**：源是仓库内 markdown 文件时，顶层写入 `sourcePrd`（仓库相对路径）；粘贴文本或仓库外来源省略
8. **【溯源】仲裁段**：`description` 末尾固定追加【溯源】段（见上方输出格式），保证 builder/validator 拿到统一的冲突处理规则
9. **qualityChecks 提取**：按上方「qualityChecks」节从目标项目提取候选并请用户确认；提取不到可靠命令时省略该字段
10. **models 路由（可选）**：按上方「models」节与用户确认模型分层；用户不需要时省略整段

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
   - 将当前的 `prd.json`、`state.json`、`progress.md`、`review-*.md` 留痕、`evidence.jsonl`、`report.html`、`screenshots/` 目录与 `prd.tampered-*.json`（均为如存在）复制到归档
   - **删除工作区中的旧 `state.json`**——story id 惯例都从 US-001 起编，新旧几乎必然撞车；引擎信任既存 state.json，残留会把旧轮的 `passes: true` 误判为新 story 已完成、循环空转结束
   - **同时删除工作区中的旧 `evidence.jsonl`**——记录按轮次追加且不含轮次归属标识以外的运行标记，残留旧轮记录会污染新轮验证报告的门禁历史与时间线
   - **同时删除工作区中的旧 `prd.tampered-*.json`**——取证已随归档保留，残留会污染新轮报告红旗区
   - 使用新的 header 重置 `progress.md`

如果你在运行之间手动更新 prd.json，请先按上述步骤归档旧运行，再写入新的 prd.json。

---

## 再派生：需求中途变更

源 PRD 修改后重新执行本 skill，若 `.workspace/prd.json` 已存在且 `branchName` 与新转换结果**相同**（同一功能），进入再派生模式（branchName 不同则走上方「归档之前的运行」流程）：

1. 先把现有 `prd.json`（以及 `state.json`、`review-*.md` 留痕文件、`evidence.jsonl`，如存在）复制到 `.workspace/archive/YYYY-MM-DD-HHmm-rederive-[feature-name]/`（带时分，避免同日多次再派生互相覆盖；`progress.md` 不动）；**同时删除工作区中的旧 `evidence.jsonl`**——需求变更后旧登记按 acIndex 位置匹配，会错挂到改写后的验收标准上，一律作废重验
2. 用新转换结果**整体重写** `prd.json`（沿用源 id，纯需求字段——prd.json 不含状态）
3. 若 `state.json` 存在，按 story id 对齐调整它（不存在则跳过，引擎会自动初始化）：
   - id 相同且 acceptanceCriteria 无实质变化 → 该 id 状态原样保留
   - id 相同但 acceptanceCriteria 有实质变化 → 该 id 重置：passes 置 `false`、retryCount 置 `0`、blocked 置 `false`；notes 写入 `[需求已变更 YYYY-MM-DD] 验收标准已更新，按新标准重验（原 passes=true/false）`——若原 notes 中存在以 `[需求冲突]` 或 `[需要人工核实]` 开头的行，将它们原样保留在新内容之前（未裁决的仲裁记录不得因再派生而丢失）
   - 新增 id → 不写入 state.json（引擎按初始状态处理）
   - 源 md 已删除的 id → 从 state.json 移除该键，在对照表标注「已移除」
4. 输出对照表时增加「状态处理」列（保留/重置/新增/移除）

实质变化的判定：AC 条目的增删、断言内容的改变算；纯错别字/措辞润色不算。拿不准时按「有实质变化」处理（宁可重验，不可漏验）。

---

## 保存前检查清单

在编写 prd.json 之前，验证：

- [ ] **之前的运行已归档**（如果 prd.json 存在且 branchName 不同，请先归档，并删除工作区残留的旧 state.json、evidence.jsonl、prd.tampered-*.json）
- [ ] 每个 story 可以在一次迭代中完成（足够小）
- [ ] Stories 按依赖顺序排序（schema 到 backend 到 UI）
- [ ] 每个 story 都有 "Typecheck passes" 作为标准
- [ ] UI stories 的浏览器标准已经展开为页面、操作、期望结果，而不是一句泛化短语
- [ ] 认证/支付/上传/多步流程 stories 有真实闭环标准
- [ ] 前后端集成 stories 包含运行时可达验证
- [ ] 复杂功能最后有一个闭环集成验证 story
- [ ] Acceptance criteria 是可验证的（不模糊）
- [ ] 没有 story 依赖于后面的 story
- [ ] story 不含任何状态字段（passes/notes/retryCount/blocked 均不出现，状态归 state.json）
- [ ] 顶层 `sourcePrd` 已填（源为仓库内文件时），`description` 末尾带【溯源】仲裁段
- [ ] qualityChecks 已配置时：写入前逐条真实跑一遍、确认当前基线全绿——命令不存在、命令写错、基线本来就红，都必须在这里（有人在场的派生环节）拦截，否则 builder 会在循环里白烧 5 轮到 blocked；基线绿同时保证循环中门禁失败必然是 builder 引入的
- [ ] models 已配置时：按 agent 工具分段且只含用户确认过的工具段，模型名已逐个与用户确认（引擎不校验名字），validator 能力 ≥ builder，不需要分层的 story 未强行标注
- [ ] 增强/拆分结果已回写源 md（仅仓库内文件源），frontmatter `updated` 已更新
- [ ] 已在会话中输出转换对照表
- [ ] 同功能再派生时已先归档副本（含 state.json、evidence.jsonl），已删除工作区中的旧 evidence.jsonl，并按 id 对齐调整 state.json（保留/重置/移除）

写入后运行：`npx coding-x repair`（用 jsonrepair 修复并二次校验 prd.json 与 state.json，后者不存在则跳过）。
