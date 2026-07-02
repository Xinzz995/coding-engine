# PRD 分层真相源（第一阶段 v0.4.0）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 确立「md 是意图真相源、prd.json 是执行真相源」的分层模型：为 prd.json 增加 sourcePrd 溯源与冲突仲裁段，把 prd-to-json 从一次性有损转换升级为「沿用稳定 id + 增强回写源 md + 对照表 + 再派生保状态」的闭环，并让 builder/validator 提示词与该契约对齐。

**Architecture:** 不改引擎循环行为，只加一个可选透传字段（`Prd.sourcePrd`）并透出到仪表盘 API；其余全部是 skills（prd-generate / prd-to-json）与引擎指令（builder.md / validator.md）的契约升级。story id 是 md ↔ json 的对齐键。第二阶段（状态外置 `.workspace/state.json`，见 ADR-003）另出计划，本计划不包含。

**Tech Stack:** TypeScript（strict, ESM/NodeNext）、Vitest、tsup；skills/commands 为纯 markdown。

## Global Constraints

- `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）
- 每次提交前必须通过 `npm run typecheck` 与 `npm test`
- 提交说明必须用中文，conventional 类型前缀（feat:/fix:/docs:/release:）保留英文
- `skills/`、`commands/` 是唯一源，不得往各工具清单复制内容
- 引擎运行时状态只读写 `--workspace` 目录（默认 `.workspace/`）
- 本计划含面向用户的行为变更（prd-to-json 会回写 `docs/prds/` 源文件），必须升 minor 版本至 0.4.0 并同步 README（硬约束 5）
- 所有新增文案（skill、指令、文档）用中文，代码标识符与固定英文断言（如 "Typecheck passes"）保持原样

## 名词与契约（全计划通用）

- **意图真相源**：`docs/prds/prd-[feature-name].md`，人写人审，需求变更只改它
- **执行真相源**：`.workspace/prd.json`，由源 md 派生，机器与 agent 读写
- **sourcePrd**：prd.json 顶层可选字段，值为源 md 的仓库相对路径；源是粘贴文本/仓库外文件时省略
- **【溯源】段**：追加在 prd.json 顶层 `description` 末尾的固定仲裁文案
- **`[需求冲突]` 标记**：builder 在 story `notes` 中记录源文档与验收标准冲突的行首标记，validator 负责保全

---

### Task 1: ADR-003 分层真相源决策文档

**Files:**
- Create: `docs/decisions/003-prd-layered-truth.md`

**Interfaces:**
- Consumes: 无（首任务）
- Produces: ADR-003，后续任务的文档引用锚点（Task 9 的 README/architecture 引用它）

- [ ] **Step 1: 创建 ADR 文件**

写入 `docs/decisions/003-prd-layered-truth.md`，完整内容如下：

```markdown
---
title: 003-prd-layered-truth
status: active
updated: 2026-07-03
scope: root
---

# 003. PRD 分层真相源：md 是意图真相，prd.json 是执行真相

## 背景

`.workspace/prd.json` 同时承担两类真相：需求内容（title/description/acceptanceCriteria/priority）与执行状态（passes/notes/retryCount/blocked），运行期由 builder/validator agent 直接回写。`docs/prds/prd-[feature].md`（prd-generate 产出）结构更丰富，但与 prd.json 只有一次性、有损（增强/拆分）、无人审的单向转换（prd-to-json），之后各自漂移：validator 实际执行的验收标准从未被人确认；agent 缺少源 PRD 的背景（Goals/Non-Goals/Design）；需求中途变更没有安全的重派生路径；md 与 json 冲突时 agent 行为未定义（表现为烧完重试后 blocked，根因不可见）。

## 决策

确立分层真相源，以四条定则约束数据流：

1. `docs/prds/prd-[feature].md` 是**意图真相源**：人写人审，需求变更只改它。
2. `.workspace/prd.json` 是**执行真相源**：由源 md 派生（顶层 `sourcePrd` 记录来源），机器与 agent 读写，随运行归档。
3. 冲突以 md 为准**重新派生**解决；agent 遇冲突按 acceptanceCriteria 实现并在 notes 记录 `[需求冲突]`，留人工裁决，不得自行取舍。
4. 执行状态永不回流 md。

实施分两阶段：

- **第一阶段（v0.4.0，随附计划 docs/superpowers/plans/2026-07-03-prd-layered-truth.md）**：溯源（sourcePrd 字段 + 【溯源】仲裁段）、转换闭环（增强结果回写源 md + 对照表）、稳定 story id、再派生模式（按 id 合并保状态）、builder/validator 提示词对齐。全部为 skills/提示词/轻引擎改动。
- **第二阶段（拟议 v0.5.0，确认后另出计划）**：内容与状态分离——passes/notes/retryCount/blocked 迁出到 `.workspace/state.json`（按 story id 键控），prd.json 运行期只读；引擎 join 两文件做 story 选取与完成判定，仪表盘输出合并视图，repair 兼容双文件，旧格式自动迁移。收益：agent 回写不再可能损坏需求内容，再派生天然不丢状态。

## 理由与备选

- 项目立身之本是机械可判定（golden-principles），执行层真相必须结构化；同时人审与上下文需要富文本。两类真相分层各归其位，比强行合一更符合各自消费者。
- 被否备选①（prd.json 唯一真相，即现状）：人改 JSON 体验差、上下文贫瘠、有损转换无人审、需求变更无安全路径。
- 被否备选②（prd-[feature].md 唯一真相）：完成判定退化为解析 prose/checkbox 或 agent 自由心证，退回 raw Ralph 的 vibes 驱动，丢掉本项目对原版 Ralph 的核心增量。
- 被否备选③（引擎直接消费 md）：等于在引擎里内置一个脆弱的 markdown parser，schema 校验、jsonrepair、仪表盘全部复杂化。

## 后果

- prd-to-json 从「只读转换」变为「转换 + 回写 + 对照表」，会修改用户的 `docs/prds/` 文件（仅 User Stories 章节与 frontmatter updated）——面向用户的行为变更，升 v0.4.0 并同步 README。
- story id 成为 md ↔ json 对齐键：一旦分配永不重排/复用（prd-generate、prd-to-json 双侧约束）。
- `Prd` 类型新增可选 `sourcePrd` 字段，旧 prd.json 不受影响（向后兼容）。
- 第二阶段落地前，状态仍写在 prd.json 内，agent 写坏需求内容的风险仍在（靠 `npx coding-x repair` 兜底）；第二阶段实施时另立计划，含旧格式迁移。
```

- [ ] **Step 2: 提交**

```bash
git add docs/decisions/003-prd-layered-truth.md
git commit -m "docs: 新增 ADR-003——PRD 分层真相源（md 意图真相 / prd.json 执行真相）"
```

---

### Task 2: 引擎——Prd 类型加 sourcePrd 并透出到仪表盘 API

**Files:**
- Modify: `src/engine/prd.ts:15-20`（Prd 接口）
- Modify: `src/dashboard/server.ts:38-47`（ApiResponse）、`src/dashboard/server.ts:49-66`（buildApiResponse）
- Test: `src/engine/prd.test.ts`、`src/dashboard/server.test.ts`

**Interfaces:**
- Consumes: 无
- Produces: `Prd.sourcePrd?: string`（可选，引擎只透传不解析）；`ApiResponse.sourcePrd: string`（无值时为空字符串）。Task 3 起的 skill 契约与 Task 7/8 的提示词都引用字段名 `sourcePrd`

- [ ] **Step 1: 写失败测试（两个文件）**

`src/engine/prd.test.ts` 的 `describe('tryReadPrd')` 内追加：

```ts
  it('preserves sourcePrd when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, JSON.stringify({ ...makePrd([{ id: 'US-001' }]), sourcePrd: 'docs/prds/prd-x.md' }));
    expect(tryReadPrd(file)?.sourcePrd).toBe('docs/prds/prd-x.md');
    rmSync(dir, { recursive: true, force: true });
  });
```

`src/dashboard/server.test.ts` 的 `tempWorkspace()` 中，prd.json fixture 加一行 `sourcePrd`：

```ts
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({
    project: '任务应用', branchName: 'ralph/x', description: 'd',
    sourcePrd: 'docs/prds/prd-x.md',
    userStories: [{ id: 'US-001', passes: false }],
  }));
```

`describe('buildApiResponse')` 的断言区（`expect(r.branchName)` 之后）追加：

```ts
    expect(r.sourcePrd).toBe('docs/prds/prd-x.md');
```

- [ ] **Step 2: 确认红灯**

```bash
npm run typecheck
npx vitest run src/dashboard/server.test.ts src/engine/prd.test.ts
```

预期：typecheck 报 `TS2339: Property 'sourcePrd' does not exist`（prd.test.ts 与 server.test.ts 两处）；vitest 中 server.test.ts 的 `buildApiResponse` 用例失败（`r.sourcePrd` 为 undefined）。注意：prd.test.ts 的新用例在运行时会直接通过（JSON.parse 透传未知字段），它的红灯只体现在 typecheck——这正是要补类型的证据。

- [ ] **Step 3: 实现**

`src/engine/prd.ts` 的 `Prd` 接口改为：

```ts
export interface Prd {
  project: string;
  branchName: string;
  description: string;
  /** 意图真相源（源 PRD）的仓库相对路径；由 prd-to-json 写入，引擎只透传不解析 */
  sourcePrd?: string;
  userStories: Story[];
}
```

`src/dashboard/server.ts` 的 `ApiResponse`，在 `branchName: string;` 之后加：

```ts
  sourcePrd: string;
```

`buildApiResponse()` 返回对象中，在 `branchName: prd?.branchName ?? '',` 之后加：

```ts
    sourcePrd: prd?.sourcePrd ?? '',
```

- [ ] **Step 4: 确认绿灯**

```bash
npm run typecheck && npm test
```

预期：typecheck 无输出（通过）；vitest 全部用例 PASS。

- [ ] **Step 5: 提交**

```bash
git add src/engine/prd.ts src/engine/prd.test.ts src/dashboard/server.ts src/dashboard/server.test.ts
git commit -m "feat: prd.json 增加 sourcePrd 溯源字段并透出到仪表盘 API"
```

---

### Task 3: prd-to-json——溯源字段与【溯源】仲裁段

**Files:**
- Modify: `skills/prd-to-json/SKILL.md:18-43`（输出格式）、`:181-197`（转换规则）、`:255-331`（示例输出）、`:350-366`（保存前检查清单）

**Interfaces:**
- Consumes: Task 2 的字段名 `sourcePrd`
- Produces: prd.json 文件契约——顶层 `sourcePrd` + `description` 末尾【溯源】段 + `[需求冲突]` notes 标记约定（Task 7/8 的提示词依赖这三者）

- [ ] **Step 1: 更新「输出格式」JSON 示例**

`## 输出格式` 代码块中，`"branchName"` 行之后加 `"sourcePrd"` 行，`"description"` 行改为带【溯源】段的版本：

```json
{
  "project": "[Project Name]",
  "branchName": "ralph/[feature-name-kebab-case]",
  "sourcePrd": "docs/prds/prd-[feature-name].md",
  "description": "[Feature description from PRD title/intro]\n\n【溯源】本文件由 docs/prds/prd-[feature-name].md 派生：需求背景不明时先查阅该文档理解意图，但验收只以本文件中各 story 的 acceptanceCriteria 为准。若发现源文档与 acceptanceCriteria 冲突、或某条标准无法成立，不要自行取舍：按 acceptanceCriteria 实现，并把冲突写入该 story 的 notes（以 [需求冲突] 开头），留给人工裁决。",
```

（`userStories` 及其后内容不变。）代码块下方紧跟一段说明：

```markdown
`sourcePrd` 仅当源是**仓库内 markdown 文件**时填写（仓库相对路径）；源是粘贴文本或仓库外文件时省略该字段，【溯源】段首句相应改为「本文件由用户提供的 PRD 文本派生」，其余仲裁文案保持不变。
```

- [ ] **Step 2: 转换规则追加两条**

`## 转换规则` 的编号列表（现有 1–6 条）末尾追加：

```markdown
7. **sourcePrd 溯源**：源是仓库内 markdown 文件时，顶层写入 `sourcePrd`（仓库相对路径）；粘贴文本或仓库外来源省略
8. **【溯源】仲裁段**：`description` 末尾固定追加【溯源】段（见上方输出格式），保证 builder/validator 拿到统一的冲突处理规则
```

- [ ] **Step 3: 更新示例输出**

`## 示例` 的「输出 prd.json」代码块中（该示例的输入是粘贴文本，正好演示省略 `sourcePrd` 的情形），`"description"` 行改为：

```json
  "description": "任务状态功能 - 使用状态指示器跟踪任务进度\n\n【溯源】本文件由用户提供的 PRD 文本派生：验收只以本文件中各 story 的 acceptanceCriteria 为准。若发现某条标准无法成立，不要自行取舍：按 acceptanceCriteria 实现，并把冲突写入该 story 的 notes（以 [需求冲突] 开头），留给人工裁决。",
```

- [ ] **Step 4: 检查清单追加**

`## 保存前检查清单` 列表追加：

```markdown
- [ ] 顶层 `sourcePrd` 已填（源为仓库内文件时），`description` 末尾带【溯源】仲裁段
```

- [ ] **Step 5: 验证与提交**

```bash
grep -c "sourcePrd" skills/prd-to-json/SKILL.md   # 预期 ≥ 4
grep -c "【溯源】" skills/prd-to-json/SKILL.md     # 预期 ≥ 3
git add skills/prd-to-json/SKILL.md
git commit -m "feat: prd-to-json 产出 sourcePrd 溯源字段与需求冲突仲裁段"
```

---

### Task 4: prd-generate——story id 稳定性硬规则

**Files:**
- Modify: `skills/prd-generate/SKILL.md:148-163`（User Stories 格式区）、`:387-401`（检查清单）

**Interfaces:**
- Consumes: 无
- Produces: md 侧 id 稳定契约（`### US-nnn: 标题` 一旦分配永不重排/复用），Task 5 的沿用规则与 Task 6 的按 id 合并都以此为前提

- [ ] **Step 1: 插入「Story ID 稳定性」小节**

在 `**格式：**` 代码块（含 `### US-001: [标题]` 模板）的结束 ``` 之后、`**重要提示：**` 之前，插入：

```markdown
#### Story ID 稳定性（硬规则）

story id 是源 PRD 与 prd.json 之间的对齐键（需求变更后再派生时按 id 合并保留执行状态），一旦分配即永久生效：

- 编辑既有 PRD 时，不要重排、不要复用已有 story 的 id
- 新增 story 一律顺延历史最大编号（含已删除 story 曾占用的编号，不回收），US-007 之后是 US-008，即使中间有删除留下的空洞
- 删除 story 时保留编号空洞，不回收
```

- [ ] **Step 2: 检查清单追加**

`## 检查清单` 列表追加：

```markdown
- [ ] 编辑既有 PRD 时未重排/复用已有 story id；新增 story 顺延最大编号
```

- [ ] **Step 3: 验证与提交**

```bash
grep -c "永不重排\|不要重排" skills/prd-generate/SKILL.md   # 预期 ≥ 1
git add skills/prd-generate/SKILL.md
git commit -m "feat: prd-generate 增加 story id 稳定性硬规则"
```

---

### Task 5: prd-to-json——沿用源 id、增强回写源 md、输出对照表（转换闭环）

**Files:**
- Modify: `skills/prd-to-json/SKILL.md:181-197`（转换规则 #2）、`:198` 附近（「拆分大型 PRD」之前插入新章节）、检查清单

**Interfaces:**
- Consumes: Task 4 的 md 侧 id 契约；Task 3 的 sourcePrd 契约
- Produces: 「转换闭环」章节（回写规则 + 对照表格式），Task 6 再派生复用其对照表格式

- [ ] **Step 1: 改写转换规则 #2（IDs）**

原文：

```markdown
2. **IDs**：顺序（US-001、US-002 等）
```

改为：

```markdown
2. **IDs**：源 PRD 的 story 标题带 `US-nnn` 编号时（prd-generate 产出格式）**必须沿用**；仅当源无编号时才从 US-001 顺序分配。转换中新增/拆分出的 story 顺延历史最大编号（含源 PRD 中已删除 story 曾占用的编号，不回收），不插号、不重排
```

- [ ] **Step 2: 插入「转换闭环」章节**

在 `### 转换时的增强规则` 一节结束后、`## 拆分大型 PRD` 之前，插入（含分隔线）：

```markdown
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
```

- [ ] **Step 3: 检查清单追加两条**

`## 保存前检查清单` 列表追加：

```markdown
- [ ] 增强/拆分结果已回写源 md（仅仓库内文件源），frontmatter `updated` 已更新
- [ ] 已在会话中输出转换对照表
```

- [ ] **Step 4: 验证与提交**

```bash
grep -c "转换闭环" skills/prd-to-json/SKILL.md   # 预期 ≥ 1
grep -c "对照表" skills/prd-to-json/SKILL.md     # 预期 ≥ 4
git add skills/prd-to-json/SKILL.md
git commit -m "feat: prd-to-json 转换闭环——沿用源 id、增强结果回写源 md、输出对照表"
```

---

### Task 6: prd-to-json——再派生模式（需求变更保状态）

**Files:**
- Modify: `skills/prd-to-json/SKILL.md`（「归档之前的运行」之后、「保存前检查清单」之前插入新章节；检查清单追加）

**Interfaces:**
- Consumes: Task 4/5 的 id 稳定与对照表格式；现有「归档之前的运行」章节的归档机制
- Produces: 再派生合并规则（同 branchName 按 id 合并保状态）

- [ ] **Step 1: 插入「再派生」章节**

在 `## 归档之前的运行` 一节结束后、`## 保存前检查清单` 之前，插入（含分隔线）：

```markdown
---

## 再派生：需求中途变更

源 PRD 修改后重新执行本 skill，若 `.workspace/prd.json` 已存在且 `branchName` 与新转换结果**相同**（同一功能），进入再派生模式（branchName 不同则走上方「归档之前的运行」流程）：

1. 先把现有 `prd.json` 复制到 `.workspace/archive/YYYY-MM-DD-rederive-[feature-name]/`（防合并出错；`progress.md` 不动）
2. 按 story id 对齐合并：
   - id 相同且 acceptanceCriteria 无实质变化 → 需求字段（title/description/acceptanceCriteria/priority）更新为新版，**保留** passes/notes/retryCount/blocked
   - id 相同但 acceptanceCriteria 有实质变化 → 需求字段更新为新版，passes 置 `false`、retryCount 置 `0`、blocked 置 `false`，notes 写入 `[需求已变更 YYYY-MM-DD] 验收标准已更新，按新标准重验（原 passes=true/false）`
   - 新增 id → 全新初始状态（`passes: false`、`notes: ""`、`retryCount: 0`、`blocked: false`）
   - 源 md 已删除的 id → 从 prd.json 移除，在对照表标注「已移除」
3. 输出对照表时增加「状态处理」列（保留/重置/新增/移除）

实质变化的判定：AC 条目的增删、断言内容的改变算；纯错别字/措辞润色不算。拿不准时按「有实质变化」处理（宁可重验，不可漏验）。
```

- [ ] **Step 2: 检查清单追加**

`## 保存前检查清单` 列表追加：

```markdown
- [ ] 同功能再派生时已先归档副本，并按 id 合并保留执行状态
```

- [ ] **Step 3: 验证与提交**

```bash
grep -c "再派生" skills/prd-to-json/SKILL.md   # 预期 3
git add skills/prd-to-json/SKILL.md
git commit -m "feat: prd-to-json 再派生模式——按 story id 合并、需求变更保状态"
```

---

### Task 7: builder.md——sourcePrd 背景查阅与冲突仲裁

**Files:**
- Modify: `assets/instructions/builder.md:90`（末段「关于该项目的重要注意事项」内的需求来源句）

**Interfaces:**
- Consumes: Task 3 的 sourcePrd 契约与 `[需求冲突]` 标记
- Produces: builder 侧冲突记录行为（写 notes、保留已有内容），Task 8 validator 的保全规则依赖该标记格式

- [ ] **Step 1: 替换需求来源段落**

原文（文件最后一段）：

```markdown
如果开发过程中对需求有不明确的地方，查看 `{{WORKSPACE}}/prd.json` 中该 story 的完整描述与验收标准；这是需求的唯一来源。
```

替换为：

````markdown
## 需求来源与冲突处理

如果开发过程中对需求有不明确的地方，先查看 `{{WORKSPACE}}/prd.json` 中该 story 的完整描述与验收标准——验收只以它的 acceptanceCriteria 为准。

如果 prd.json 顶层存在 `sourcePrd` 字段，它指向本次需求派生自的源 PRD 文档（仓库相对路径）。当 story 的描述与验收标准不足以理解背景（目标、Non-Goals、设计约束）时，去读该文档补全上下文。

如果你发现源文档与 acceptanceCriteria 冲突，或某条 acceptanceCriteria 无法成立：不要自行取舍、不要按源文档自由发挥——按 acceptanceCriteria 实现，并在该 story 的 `notes` 字段追加一行冲突记录（保留 notes 已有内容）：

```
[需求冲突] YYYY-MM-DD HH:mm 冲突点简述（源文档说 X，acceptanceCriteria 说 Y，已按 Y 实现）
```

冲突留给人工裁决：人工修订源 PRD 后会重新派生 prd.json，你不需要也不允许直接改源 PRD 或验收标准。
````

- [ ] **Step 2: 验证与提交**

```bash
grep -c "需求冲突" assets/instructions/builder.md   # 预期 1
npm run build && grep -c "需求冲突" dist/instructions/builder.md   # 预期一致（onSuccess 拷贝生效）
git add assets/instructions/builder.md
git commit -m "feat: builder 指令——sourcePrd 背景查阅与需求冲突仲裁"
```

---

### Task 8: validator.md——验收依据防御与冲突记录保全

**Files:**
- Modify: `assets/instructions/validator.md:26-42`（验证结果写入规则）、`:61-68`（重要约束）

**Interfaces:**
- Consumes: Task 7 的 `[需求冲突]` 标记格式
- Produces: validator 侧 notes 保全规则；验收依据防御句

- [ ] **Step 1: 通过分支保全冲突记录**

原文：

```markdown
**所有验收标准都通过时：**
- 不修改任何字段（passes 保持 true，开发 Agent 已设好）
- 清空 notes 字段为空字符串 `""`
- 将 retryCount 重置为 `0`
```

改为：

```markdown
**所有验收标准都通过时：**
- 不修改任何字段（passes 保持 true，开发 Agent 已设好）
- 清理 notes 字段：若其中存在以 `[需求冲突]` 开头的行，只保留这些行；否则清空为空字符串 `""`（冲突记录必须留到人工裁决，不随验证通过消失）
- 将 retryCount 重置为 `0`
```

- [ ] **Step 2: 失败分支保全冲突记录**

原文：

```markdown
- 在 notes 字段写入失败详情，格式如下：
```

改为：

```markdown
- 在 notes 字段写入失败详情（若原 notes 中存在以 `[需求冲突]` 开头的行，将它们原样保留在新内容之前），格式如下：
```

- [ ] **Step 3: 重要约束加防御句**

在原有约束行：

```markdown
- 验收判定**只**以 prd.json 中该 story 的 acceptanceCriteria 为准；不得因 AGENTS.md、golden-principles 或代码风格/品味问题追加失败项
```

之后新增一行：

```markdown
- 即使 prd.json 顶层的 `sourcePrd` 或 description 指向源 PRD 文档，也**不得**去源文档中寻找验收依据或增删验收项；源文档只属于开发 Agent 的背景材料
```

- [ ] **Step 4: 验证与提交**

```bash
grep -c "需求冲突" assets/instructions/validator.md   # 预期 ≥ 2
grep -c "sourcePrd" assets/instructions/validator.md  # 预期 ≥ 1
npm run build && grep -c "需求冲突" dist/instructions/validator.md   # 预期一致
git add assets/instructions/validator.md
git commit -m "feat: validator 指令——验收依据防御与需求冲突记录保全"
```

---

### Task 9: 文档同步（README / 架构地图 / AGENTS.md）

**Files:**
- Modify: `README.md:30`（工作原理首句）、`README.md:151`（教程第 4 步）、`README.md:155-174`（prd.json 结构示例）
- Modify: `docs/architecture.md:37`（数据流）
- Modify: `AGENTS.md`（文档索引 PRD 行）

**Interfaces:**
- Consumes: ADR-003（Task 1）、sourcePrd 契约（Task 3）
- Produces: 面向用户的分层真相源说明（硬约束 5 的 README 同步义务）

- [ ] **Step 1: README 工作原理段**

原文（第 30 行）：

```markdown
引擎在项目根目录启动，围绕工作区里的两份文件运转：`prd.json`（需求与状态）和 `progress.md`（进度与学习日志）。
```

改为：

```markdown
引擎在项目根目录启动，围绕工作区里的两份文件运转：`prd.json`（需求与状态）和 `progress.md`（进度与学习日志）。`prd.json` 是 `docs/prds/` 源 PRD 的派生物：md 是**意图真相源**（人写人审，需求变更改它），`prd.json` 是**执行真相源**（机器与 agent 读写）；两者冲突时以 md 为准重新派生（见 `docs/decisions/003-prd-layered-truth.md`）。
```

- [ ] **Step 2: README 教程第 4 步**

原文（第 151 行）：

```markdown
4. 用 `prd-to-json` skill 把 PRD 转成 `.workspace/prd.json`（「将 prd 转成 prd.json」）。
```

改为：

```markdown
4. 用 `prd-to-json` skill 把 PRD 转成 `.workspace/prd.json`（「将 prd 转成 prd.json」）。转换会把增强后的 stories 回写源 PRD 并输出对照表供确认；需求中途变更时改源 PRD 后重新转换（再派生按 story id 保留执行状态）。
```

- [ ] **Step 3: README prd.json 结构示例加 sourcePrd**

结构示例代码块中，`"branchName": "ralph/my-feature",` 之后加：

```jsonc
  "sourcePrd": "docs/prds/prd-my-feature.md",  // 意图真相源（源 PRD）路径，冲突时以它为准重新派生
```

- [ ] **Step 4: 架构地图数据流段**

原文（docs/architecture.md 第 37 行）：

```markdown
`.workspace/` 里两份文件贯穿全程：`prd.json`（需求+状态）与 `progress.md`（日志+学习）。builder 实现单个 story 并更新两者 → validator 逐条核对 acceptanceCriteria 并回写 passes/notes/retryCount/blocked → 循环直到全部 passes 或 blocked。
```

改为：

```markdown
`.workspace/` 里两份文件贯穿全程：`prd.json`（需求+状态，由 `docs/prds/` 源 PRD 经 prd-to-json 派生，顶层 `sourcePrd` 记录来源）与 `progress.md`（日志+学习）。分层真相源（ADR-003）：md 是意图真相（人改），prd.json 是执行真相（机器改），冲突以 md 为准再派生，执行状态永不回流 md。builder 实现单个 story 并更新两者 → validator 逐条核对 acceptanceCriteria 并回写 passes/notes/retryCount/blocked → 循环直到全部 passes 或 blocked。
```

同时更新 frontmatter `updated` 为当天日期。

- [ ] **Step 5: AGENTS.md 文档索引 PRD 行**

原文：

```markdown
| PRD | `docs/prds/` | prd-generate 产出 |
```

改为：

```markdown
| PRD | `docs/prds/` | prd-generate 产出；意图真相源，`.workspace/prd.json` 由它派生（ADR-003） |
```

- [ ] **Step 6: 验证与提交**

```bash
npm run typecheck && npm test
git add README.md docs/architecture.md AGENTS.md
git commit -m "docs: README/架构地图/AGENTS 同步分层真相源模型"
```

---

### Task 10: 发版 v0.4.0

**Files:**
- Modify: `package.json:3`、`.claude-plugin/plugin.json:3`、`.cursor-plugin/plugin.json:5`、`.codex-plugin/plugin.json:3`（版本号 0.3.0 → 0.4.0）

**Interfaces:**
- Consumes: 前面全部任务已合入
- Produces: v0.4.0 版本（prd-to-json 回写源文件属面向用户的行为变更，按硬约束 5 升 minor）

- [ ] **Step 1: 升版本号**

上述四个文件中的 `"version": "0.3.0"` 全部改为 `"version": "0.4.0"`。

- [ ] **Step 2: 全量验证**

```bash
npm run typecheck && npm test && npm run build
grep -rn '"version"' package.json .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex-plugin/plugin.json
```

预期：三个命令全部成功；grep 显示四处均为 `0.4.0`。

- [ ] **Step 3: 提交**

```bash
git add package.json .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex-plugin/plugin.json
git commit -m "release: v0.4.0"
```

`npm publish` 由维护者手动执行（prepublishOnly 会自动 build）。

---

## 第二阶段预告（不在本计划内）

内容与状态分离（`.workspace/state.json`，prd.json 运行期只读）已在 ADR-003 中定案为拟议方向（v0.5.0）：涉及 `Story` 类型拆分、`loop.ts`/`server.ts`/`repair.ts` 改造、builder/validator 回写目标迁移与旧格式自动迁移。经维护者确认后另出独立计划。
