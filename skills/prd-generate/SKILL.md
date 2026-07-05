---
name: prd-generate
description: "为新功能生成 Product Requirements Document (PRD)。在规划功能、启动新项目或需要创建 PRD 时使用。触发词：创建一个prd"
---

# PRD Generator

创建清晰、可执行且适合实施的详细 Product Requirements Document。

---

## 工作流程

1. 接收用户的功能描述
2. 提出 3-5 个关键的澄清问题（带字母选项与推荐）
3. 根据答案生成结构化的 PRD
4. 保存到 `docs/prds/prd-[feature-name].md`（monorepo 中按归属规则可能是 `<子项目>/docs/prds/`）

**输入是场景对齐稿时**（`docs/prds/align-*.md`，scenario-alignment 产出）：业务口径已经人工拍板，跳过澄清问题，直接从对齐稿的「业务场景」与「验收口径」派生 User Stories 与 acceptance criteria——不要重新发明需求、不要推翻已拍板的口径；技术粒度的取舍（拆分、排序、前置 story）照常执行。生成后把对齐稿 frontmatter 的 `status` 置为 `superseded`。

**输入还包含技术对齐稿时**（`docs/prds/tech-*.md`，technical-alignment 产出）：技术合同也已拍板——PRD 的 Technical Considerations 从合同稿吸收（引用其可验证陈述，不重新发明方案）；story 拆分与排序参照合同的数据/边界结构（持久化与状态先行、UI 接线在后）；合同中的可验证陈述应逐条落进相应 story 的 acceptance criteria（如「报告记录只追加、永不覆盖」直接成为验收断言）；不可逆项对应的 story 优先级靠前。不得推翻已拍板的合同；发现合同与业务口径冲突时停下来向用户指出，不自行取舍。生成后把合同稿 frontmatter 的 `status` 也置为 `superseded`。

**重要提示：** 不要开始实施。只需创建 PRD。

---

## 步骤 1：澄清问题

仅在初始提示不明确时提出关键问题。**提问前先查证**：能从当前代码、项目文档（AGENTS.md 及其索引）或用户已给材料判断的问题，直接查证，不要问用户——问题只留给真正需要人拍板的决策。重点关注：

- **问题/目标：** 这解决了什么问题？
- **核心功能：** 关键操作是什么？
- **范围/边界：** 它不应该做什么？
- **成功标准：** 我们如何知道它已完成？

每个问题给出你的推荐选项（格式「推荐：B——理由」），让用户可以只回「都按推荐」快速拍板。问题超过 5 个时，先问最上游的 3-5 个（上游=答案会改变其他问题是否成立的那种）。

### 问题格式如下：

```
1. 这个功能的主要目标是什么？
   A. 改善用户 onboarding 体验
   B. 提高用户 retention
   C. 减少 support 负担
   D. 其他：[请说明]

2. 目标用户是谁？
   A. 仅新用户
   B. 仅现有用户
   C. 所有用户
   D. 仅管理员用户

3. 范围是什么？
   A. 最小可行版本 (Minimal viable version)
   B. 完整功能实现 (Full-featured implementation)
   C. 仅 backend/API
   D. 仅 UI
   推荐：A——先验证核心价值，避免一次做大
```

这样用户可以快速回复 "1A, 2C, 3B"，或直接回「都按推荐」进行快速迭代。

---

## 步骤 2：PRD 结构

生成包含以下部分的 PRD：

### 1. 介绍/概述
简要描述功能及其解决的问题。

### 2. 目标
具体、可衡量的目标（列表形式）。

### 3. User Stories
每个 story 需要包含：
- **标题：** 简短的描述性名称
- **描述：** "作为 [用户]，我想要 [功能]，以便 [收益]"
- **Acceptance Criteria：** 可验证的"完成"标准清单

每个 story 应该足够小，可以在一次专注的会话中实现。

### Acceptance Criteria 编写规则

不要把 acceptance criteria 写成“实现了某段代码”或“接好了某个接口”。

要写成 validator 能真实检查的结果，优先写：

- 用户做了什么
- 系统调用了什么
- 页面或接口返回了什么
- 本地状态发生了什么
- 刷新后是否仍然成立

#### 必须避免的模糊标准

- “工作正常”
- “接入后端接口”
- “保存 token”
- “页面正确跳转”
- “支持浏览器验证”

这些都不够。必须补成可观测的断言。

#### 对 UI stories 的硬规则

不要只写：

- [ ] 使用 agent-browser 在浏览器中验证

要写成：

- [ ] 使用 agent-browser 打开 `[url/path]`
- [ ] 执行 `[具体操作]`
- [ ] 页面出现 `[具体文案/组件/状态]`
- [ ] 无控制台错误

#### 对认证、支付、上传、表单、多步流程的硬规则

这类 story 不能只验证单点页面，必须写闭环。

例如认证 story 至少要覆盖：

- [ ] 使用一个全新账号完成注册，接口返回成功
- [ ] 使用刚注册的账号立即登录成功
- [ ] `localStorage` 中存在预期 token 或 session 标记
- [ ] 页面跳转到预期受保护页面
- [ ] 刷新页面后仍能恢复登录态
- [ ] 错误凭证时显示明确失败信息

#### 对前后端集成 story 的硬规则

如果 story 涉及前端调用后端，必须显式要求运行时可达，不只是“代码里改成了新路径”。

至少补一条：

- [ ] 在本地开发环境中，前端发出的目标请求可以真实到达后端并返回预期响应

如果存在 dev proxy、base URL、环境变量、网关重写等前置条件，应单独拆成前置 story，而不是混在页面 story 里隐含依赖。

#### 对跨 story 功能的硬规则

如果一个功能被拆成多个 story，但用户感知上是一个完整流程，PRD 末尾必须增加一个集成 story。

例如：

- “注册页改造”
- “AuthContext 改造”
- “HTTP client 改造”

这种拆法还不够，必须再有：

- “真实用户注册→登录→进入受保护页面→刷新恢复登录态的闭环验证”

**格式：**
```markdown
### US-001: [标题]
**描述：** 作为 [用户]，我想要 [功能]，以便 [收益]。

**Acceptance Criteria：**
- [ ] 具体的可验证标准
- [ ] 另一个标准
- [ ] Typecheck/lint 通过
- [ ] **[仅 UI stories]** 使用 agent-browser 打开 `[url/path]`，执行 `[具体操作]`
- [ ] **[仅 UI stories]** 页面出现 `[具体文案/组件/状态]`，无控制台错误
```

#### Story ID 稳定性（硬规则）

story id 是源 PRD 与 prd.json 之间的对齐键（需求变更后再派生时按 id 合并保留执行状态），一旦分配即永久生效：

- 编辑既有 PRD 时，不要重排、不要复用已有 story 的 id
- 新增 story 一律顺延历史最大编号（含已删除 story 曾占用的编号，不回收），US-007 之后是 US-008，即使中间有删除留下的空洞
- 删除 story 时保留编号空洞，不回收

**重要提示：** 
- Acceptance criteria 必须是可验证的，不能模糊。"工作正常"是不好的。"删除前按钮显示确认对话框"是好的。
- **对于任何有 UI 变更的 story：** 始终写明用 agent-browser 验证的页面、操作和预期结果，不要只写一句泛泛的“使用 agent-browser 在浏览器中验证”。
- **对于任何认证、注册、支付、上传、导入导出、多步表单、跨前后端联动 story：** 必须写真实闭环验收标准，至少包含一次成功路径的端到端验证；必要时再补失败路径。

### 4. Functional Requirements
具体功能的编号列表：
- "FR-1: 系统必须允许用户..."
- "FR-2: 当用户点击 X 时，系统必须..."

要明确且无歧义。

### 5. Non-Goals（超出范围）
此功能将不包括的内容。对管理范围至关重要。

### 6. Design Considerations（可选）
- UI/UX 要求
- 如有可用，提供 mockups 链接
- 可重用的相关现有 components

### 7. Technical Considerations（可选）
- 已知的约束或依赖
- 与现有系统的集成点
- Performance 要求

### 8. Success Metrics
如何衡量成功？
- "将完成 X 的时间减少 50%"
- "将 conversion rate 提高 10%"

### 9. Open Questions
剩余的问题或需要澄清的领域。

---

## 为初级开发者编写

PRD 的读者可能是初级开发者或 AI agent。因此：

- 要明确且无歧义
- 避免行话或解释它
- 提供足够的细节以理解目的和核心逻辑
- 为便于参考，对需求进行编号
- 在有用时使用具体示例
- 把“如何判断真的完成”写进 acceptance criteria，而不是留给实施者猜

---

## Story 拆分补充规则

拆分 story 时，不要只按代码层分层，要按“可独立验证的结果”拆。

推荐顺序：

1. 基础设施 / schema / proxy / env / gateway
2. 后端接口或服务逻辑
3. 前端页面或组件接线
4. 闭环集成验证 story

典型反例：

- “登录页调用新接口”

这通常不够，因为它隐含依赖：

- 前端请求能访问到后端
- token 能落盘
- 受保护页面能恢复登录态

这种情况下应该拆成至少两个 story：

- 前端认证请求链路可达
- 登录页完成真实登录闭环

---

## 闭环验收模板

如果功能属于下面类型，优先套用对应模板。

### 认证 / 注册 / 登录

```markdown
- [ ] 使用一个全新唯一账号完成注册，返回成功信息
- [ ] 使用刚注册的账号立即登录成功
- [ ] 登录成功后本地存储中存在预期 token/session
- [ ] 页面跳转到正确的受保护页面
- [ ] 刷新页面后仍可通过当前认证状态恢复登录
- [ ] 使用错误凭证登录时显示明确失败信息
```

### 前端调用后端接口

```markdown
- [ ] 前端请求真实发送到目标后端接口，不是 404/假响应
- [ ] 成功响应在 UI 上产生预期变化
- [ ] 失败响应在 UI 上显示明确错误信息
```

### 列表 / CRUD / 详情页

```markdown
- [ ] 新建/修改/删除操作成功后页面立即反映最新状态
- [ ] 刷新页面后状态保持一致
- [ ] 空状态 / 错误状态 / 无权限状态有明确定义
```

---

## 输出

- **格式：** Markdown (`.md`)
- **位置：** `docs/prds/`（目录不存在则创建）
- **归属规则（monorepo）：** 功能只涉及一个子项目 → 保存到 `<子项目>/docs/prds/`；跨子项目或单项目 → 根 `docs/prds/`
- **文件名：** `prd-[feature-name].md` (kebab-case)
- **frontmatter：** 文件必须以统一 frontmatter 开头：

```yaml
---
title: "PRD: [Feature Name]"
status: active
updated: YYYY-MM-DD（当天日期）
scope: root 或子项目名
---
```

---

## PRD 示例

```markdown
---
title: "PRD: Task Priority System"
status: active
updated: 2026-07-02
scope: root
---

# PRD: Task Priority System

## Introduction

为任务添加优先级级别，以便用户专注于最重要的事情。任务可以标记为高、中或低优先级，带有视觉指示器和过滤功能，帮助用户有效管理工作负载。

## Goals

- 允许为任何任务分配优先级（high/medium/low）
- 提供优先级级别之间的清晰视觉区分
- 支持按优先级过滤和排序
- 新任务默认为 medium 优先级

## User Stories

### US-001: 向 database 添加 priority 字段
**描述：** 作为开发者，我需要存储任务优先级，以便它在会话之间持久化。

**Acceptance Criteria：**
- [ ] 向 tasks 表添加 priority 列：'high' | 'medium' | 'low' (默认 'medium')
- [ ] 成功生成并运行 migration
- [ ] Typecheck 通过

### US-002: 在 task cards 上显示 priority 指示器
**描述：** 作为用户，我想一眼看到任务优先级，以便我知道首先需要注意什么。

**Acceptance Criteria：**
- [ ] 每个 task card 显示彩色 priority badge（红色=high，黄色=medium，灰色=low）
- [ ] 无需悬停或点击即可看到 priority
- [ ] Typecheck 通过
- [ ] 使用 agent-browser 打开任务列表页，每个 task card 都可直接看到 priority badge
- [ ] 页面无控制台错误

### US-003: 向 task edit 添加 priority 选择器
**描述：** 作为用户，我想在编辑任务时更改任务的优先级。

**Acceptance Criteria：**
- [ ] task edit modal 中的 priority 下拉菜单
- [ ] 显示当前 priority 为选中状态
- [ ] 选择更改时立即保存
- [ ] Typecheck 通过
- [ ] 使用 agent-browser 修改一个任务的 priority，列表中的 badge 立即更新
- [ ] 刷新页面后 priority 保持为最新值

### US-004: 按 priority 过滤任务
**描述：** 作为用户，我想过滤任务列表，以便在我专注时只看到高优先级项目。

**Acceptance Criteria：**
- [ ] 带有选项的过滤下拉菜单：All | High | Medium | Low
- [ ] 过滤状态持久化在 URL params 中
- [ ] 没有任务匹配过滤条件时显示空状态消息
- [ ] Typecheck 通过
- [ ] 使用 agent-browser 切换过滤条件，只显示匹配项
- [ ] 刷新页面后 URL params 仍能恢复当前过滤状态

## Functional Requirements

- FR-1: 向 tasks 表添加 `priority` 字段（'high' | 'medium' | 'low'，默认 'medium'）
- FR-2: 在每个 task card 上显示彩色 priority badge
- FR-3: 在 task edit modal 中包含 priority 选择器
- FR-4: 在任务列表标题中添加 priority 过滤下拉菜单
- FR-5: 在每个 status 列内按 priority 排序（high 到 medium 到 low）

## Non-Goals

- 不包含基于 priority 的通知或提醒
- 不包含基于截止日期的自动 priority 分配
- 不包含 subtasks 的 priority 继承

## Technical Considerations

- 重用带有颜色变体的现有 badge component
- 通过 URL search params 管理过滤状态
- priority 存储在 database 中，不计算

## Success Metrics

- 用户可以在 2 次点击内更改 priority
- 高优先级任务立即在列表顶部可见
- 任务列表 performance 无回归

## Open Questions

- priority 是否应该影响列内的任务排序？
- 我们是否应该为 priority 更改添加键盘快捷键？
```

---

## 检查清单

保存 PRD 之前：

- [ ] 澄清问题只问了查证不了的决策（代码/文档/已给材料能答的没问），且每题带字母选项与推荐；输入是 align- 对齐稿时跳过了澄清且未推翻已拍板口径
- [ ] 融入了用户的答案
- [ ] User stories 小而具体
- [ ] 所有 acceptance criteria 都是可观测、可验证的结果，不是实现描述
- [ ] 所有 UI stories 的浏览器验证都写明了页面、操作和预期结果
- [ ] 所有认证/支付/上传/多步流程 stories 都有闭环验收标准
- [ ] 如功能跨多个 story，已增加最终集成验证 story
- [ ] Functional requirements 已编号且无歧义
- [ ] Non-goals 部分定义了清晰的边界
- [ ] 文件以统一 frontmatter 开头（title/status/updated/scope）
- [ ] 已按归属规则保存到 `docs/prds/prd-[feature-name].md`（或 `<子项目>/docs/prds/`）
- [ ] 编辑既有 PRD 时未重排/复用已有 story id；新增 story 顺延最大编号
