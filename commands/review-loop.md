---
description: 处理 coding-x 针对当前 PR 最新提交产生的结构化 Review findings；逐项让用户裁决、授权修复、提交反证或登记 P1 延期，并写入当前提交绑定的结构化决定
---

# /review-loop——最终 Review 裁决入口

`/review-loop` 不再自行生成第二份 Review，也不把 Markdown 当成正式状态。三层 Review 已由 `coding-x` 在全部 Story 验证后、针对当前 PR 最新提交独立执行；本命令只帮助用户理解 finding 并作出决定。

开始时先固定本次 `<workspace-dir>`：用户已经给出路径时原样保留；未给出时询问并推荐 CLI 默认值
`.workspace`。所有读取和最终命令都使用同一个原始值，不自行规范化、拼接或换回默认目录。

## 不可突破的边界

1. 只读取 `<workspace-dir>/final-review.json`。文件缺失、格式损坏或 `binding.headSha` 不等于当前 `git rev-parse HEAD` 时，立即停止并提示重新运行 `coding-x`；不得降级为普通 diff Review。
2. 不修改 `final-review.json`，不以编辑 Markdown、PR 文本或标签代替裁决。本命令也不得直接创建、覆盖或追加 `review-decisions.json`；正式决定只能交给 `coding-x workspace record-review-decision` 写入。
   默认 workspace 下的最终位置是 `.workspace/review-decisions.json`，但用户选择其他 workspace 时必须使用对应目录，不能硬编码默认路径。
3. 未经用户针对具体 finding 明确授权，不修改业务代码、规格、测试或配置。`fix-requested` 仍是阻断态，不等于已经修复。
4. 不自动推送、合并、创建标签或发布。创建延期 Issue 也要先取得用户明确同意。
5. 不采信 Developer、Validator、计划或 PRD 的自述作为反证。黄金原则不是自述；涉及原则的 finding 必须逐条独立复核代码、测试或可观察证据。
6. finding 的严重度和评审轴由引擎保留；本命令不得重新降级、合并或隐藏。

## 第一步：验证输入

- 读取 `<workspace-dir>/final-review.json` 并确认：
  - `schemaVersion` 受当前 coding-x 支持；
  - Review 绑定的 PR、base SHA、head SHA、模型、规则版本均存在；
  - 当前 HEAD 与 `binding.headSha` 完全相同；
  - `axes` 中每个 finding 都有稳定 ID、评审轴、严重度、位置、规则来源、影响和建议。
- 只读已有 `<workspace-dir>/review-decisions.json`。格式非法时停止，不得覆盖；提交或完整 Review
  binding 不同的决定只展示为历史，不能复用于当前裁决。
- 展示三条彼此独立的状态：Story 实现验证、本地三层 Review、GitHub 交付。不得把任意一条包装成另外两条的证明。

## 第二步：逐项裁决

按 P0 → P1 → 需要人工决策 → P2 → Info 的顺序，一次只处理一个 finding。先用简单语言说明：发现了什么、实际失败场景、为什么是当前严重度、建议动作；然后等待用户选择。

允许的动作如下：

- `fix-requested`：用户授权修复。记录决定后才可按用户授权修改；修复必须形成新提交，再重新运行 `coding-x`。新提交会让旧 Validator 和最终 Review 失效，因此不能把旧决定改写成“已通过”。
- `counterevidence`：用户提供具体反证。P0、P1 和需人工决策 finding 至少需要可复核的事实，不能只写“误报”“接受风险”；反证正文不少于 20 个字符。
- `p1-deferred`：只允许 P1，且必须关联开放的 `quality-p1-deferral` Issue。Issue 必须包含负责人、原因、到期日和跟进事项，并满足质量契约规定的最长延期。
- `acknowledged`：只用于 P2 或 Info 的知悉；不能解除 P0、P1 或 `requiresHumanDecision=true` 的阻断。

产品、架构或业务取舍必须停下来交给用户。模型不能替人选择产品行为，也不能自动批准例外。

## 第三步：提交结构化决定

每次确认后，在**系统临时目录**创建一次性 JSON 请求。请求必须位于项目和 workspace 之外，且只
包含用户给出的裁决数据：

```json
{
  "schemaVersion": 1,
  "findingId": "spec-P1-...",
  "action": "counterevidence",
  "operator": "明确的 GitHub 用户名或用户给出的身份",
  "evidence": "不少于 20 个字符、可复核的具体反证"
}
```

请求不允许包含 `headSha`、`at`、目标文件路径、workspace 路径或任何归档/租约字段；这些值只能由
引擎根据当前事实签发。`p1-deferred` 只增加正整数 `issue`，不带 `evidence`；`acknowledged` 不带
二者；`fix-requested` 可带授权说明作为 `evidence`，但不带 `issue`。不适用字段整个省略，不能填
`null` 或空字符串。

随后只执行：

```bash
npx coding-x workspace record-review-decision --input <request-file> --workspace <workspace-dir>
```

- 不猜操作者身份；无法从已登录 GitHub 账户可靠取得时询问用户。
- coding-x 会在短会话内重新核对当前 HEAD、PR 意图、base、Spec、工程规则、Final Review、finding、
  已有决定、Runner 版本和延期 Issue，并由引擎填入完整 Review binding 摘要、`headSha` 与 `at`。
  任一事实失效时保持零决定写入。
- 同一 finding 有多条当前提交记录时，引擎追加的新记录成为当前决定；保留历史，不原地改写。
- 命令成功或失败后都清理系统临时请求；不得在失败时回退为直接编辑 JSON。
- Markdown 可作为阅读副本，但不得由本命令生成或修改后充当完成状态。

## 第四步：结束条件

- 用户授权修复：完成获授权的修改与验证后提交，再运行 `coding-x`；不要继续裁决旧 finding。
- 尚有 P0、P1、需人工决定的 finding 未有效处理：明确列出，保持退出码 4 对应的人工阻断。
- Review 文件缺失、损坏、过期或关联 Issue 无法核验：停止并保持 `unverifiable`；不得假绿。
- 仅剩已知悉的 P2/Info，且所有阻断 finding 都有有效反证或有效 P1 延期：提示用户重新运行 `coding-x`。正式结果只能由引擎重新读取结构化决定、重跑必要检查并查询 GitHub 后给出。

## 不再执行的旧行为

- 缺少 PRD 时降级为普通 diff Review。
- 在当前开发目录里自行重跑一套三层审查。
- 宣称所有质量问题都不阻断。
- 生成 `review-*.md` 并让用户自由编辑 resolution 作为闭环。
- 用 `/review-loop` 的文本输出证明 GitHub 可以合并。
