# coding-x

> Ralph 自动化 Coding 工作流 —— 把 **Developer → Validator** 循环固化成确定性程序的 harness。

coding-x 同时是两样东西：

- **Claude Code 插件** —— 提供 `prd` / `ralph` / `agent-browser` skills 和 `/prime` `/plan-feature` `/create-rules` 命令，帮你把一个需求拆解成可自动执行的 `prd.json`。
- **TypeScript 引擎**（`npx coding-x`）—— 读取 `prd.json`，自动驱动 AI agent（Claude 或 Codex）逐个 user story 开发 → 验证 → 提交，直到全部完成，并提供实时 Web 仪表盘。

核心理念：人只负责把需求讲清楚（生成 PRD），剩下的「写代码 → 自检 → 验收 → 修复 → 再验收」交给一个确定性的循环反复跑，直到所有验收标准通过。

---

## 功能清单

### 引擎（`npx coding-x`）

- **Developer → Validator 双 agent 循环**
  - **Developer（builder）**：从 `prd.json` 中挑选优先级最高、未完成且未阻塞的 story，只实现这一个 story，跑质量检查（typecheck / lint / test），通过后以 `feat: [Story ID] - [Title]` 提交，并把进度追加写入 `progress.md`。
  - **Validator**：独立的 QA agent，逐条核对该 story 的 `acceptanceCriteria`。通过则清空 `notes`、重置 `retryCount`；失败则把 `passes` 设回 `false`、写明失败原因、`retryCount + 1`。
- **自动重试与阻塞保护**：同一 story 验证失败累计达 5 次后自动标记 `blocked: true` 并跳过，避免循环卡死。
- **完成判定**：每轮结束后检查所有 story 是否都 `passes` 或 `blocked`，全部解决则成功退出（退出码 0），否则继续直到 `--max-iter` 上限（退出码 1）。
- **支持两种 agent 后端**：默认 `claude`，可切换 `codex`。两者均以「跳过权限确认」模式运行，启动前会打印醒目警告。
- **超时控制**：开发与验证阶段各有独立超时；超时的开发阶段会跳过验证、下一轮重试。
- **实时 Web 仪表盘**：内置 HTTP 服务（默认 `http://localhost:7331`），展示迭代次数、当前阶段、当前 story、已用时长、story 列表与 `progress.md` 日志；自带普通视图与像素风视图（`/p`）。启动时默认自动在浏览器打开（可用 `--no-open` 关闭）。
- **prd.json 修复命令**：`npx coding-x repair` 用 `jsonrepair` 修复被 agent 写坏的 `prd.json`。
- **可配置工作区**：通过 `--workspace` 指定 `prd.json` / `progress.md` 所在目录（默认 `.workspace`）；指令模板用 `{{WORKSPACE}}` 占位符注入，agent 与引擎始终读写同一份文件。

### 插件命令（Slash Commands）

| 命令 | 作用 |
| --- | --- |
| `/prime` | 分析代码库结构、文档与关键文件，为 agent 建立项目上下文理解 |
| `/create-rules` | 分析代码库并提取模式，生成全局规则文件 `AGENTS.md`（项目技术架构 / harness 指南） |
| `/plan-feature <功能描述>` | 通过系统化的代码库分析、外部调研与策略规划，把需求转化为完整实现计划 |

### 插件 Skills

| Skill | 作用 | 触发示例 |
| --- | --- | --- |
| `prd` | 为新功能生成结构清晰、可执行的 PRD（Product Requirements Document） | 「创建一个 prd」 |
| `ralph` | 把已有 PRD 转换成 Ralph 引擎使用的 `prd.json` 格式 | 「将 prd 转成 prd.json」 |
| `agent-browser` | 浏览器自动化：导航、填表、截图、数据提取，用于 UI story 的实际验证 | 需要在浏览器中验证 UI 时 |

### 单一数据源资产生成

`assets/` 是所有 skills / commands / 指令模板的唯一来源，`npm run sync` 会据此重新生成 Claude（根目录）、`.cursor/`、`.agents/` 三套工具目录，避免多处手动维护。

---

## 安装

### 环境要求

- **Node.js ≥ 18**
- 已安装并可在终端调用 **`claude`**（Claude Code CLI）或 **`codex`**（二选一，取决于你用哪个后端）

### 方式一：作为 Claude Code 插件安装

在 Claude Code 中添加本仓库所在的 marketplace，然后安装 `coding-x` 插件：

```
/plugin marketplace add Xinzz995/coding-engine
/plugin install coding-x
```

安装后即可使用 `/prime`、`/plan-feature`、`/create-rules` 命令以及 `prd` / `ralph` / `agent-browser` skills。

### 方式二：直接用引擎（无需安装）

引擎已发布为 npm 包，`npx` 会自动拉取，无需预装：

```bash
npx coding-x
```

### 方式三：从源码运行（开发者）

```bash
git clone https://github.com/Xinzz995/coding-engine.git
cd coding-engine
npm install
npm run dev            # 用 tsx 直接运行 CLI
```

---

## 使用教程

### 整体流程

```
需求  ──/plan-feature──▶  实现计划
      ──prd skill───────▶  PRD
      ──ralph skill─────▶  .workspace/prd.json
                                │
                  npx coding-x  ▼
        ┌──────────────────────────────────────┐
        │  for 每一轮迭代:                       │
        │    Developer 实现最高优先级 story      │
        │    Validator 逐条验证验收标准          │
        │    全部 story passes/blocked → 完成     │
        └──────────────────────────────────────┘
                                │
                                ▼
              http://localhost:7331  实时查看进度
```

### 第 1 步：生成 prd.json

在 Claude Code 中：

1. （可选）`/prime` 让 agent 先理解你的代码库；`/create-rules` 生成根目录 `AGENTS.md` 作为项目技术指南。
2. `/plan-feature 我要做的功能描述` 产出完整实现计划。
3. 用 `prd` skill 生成 PRD（「创建一个 prd」）。
4. 用 `ralph` skill 把 PRD 转成 `.workspace/prd.json`（「将 prd 转成 prd.json」）。

`prd.json` 的每个 user story 结构如下：

```jsonc
{
  "project": "我的项目",
  "branchName": "ralph/my-feature",
  "description": "...",
  "userStories": [
    {
      "id": "US-001",
      "title": "用户可以新建笔记",
      "description": "...",
      "acceptanceCriteria": ["Typecheck passes", "在浏览器中点击新建按钮能创建笔记"],
      "priority": 1,
      "passes": false,
      "notes": "",
      "retryCount": 0,
      "blocked": false
    }
  ]
}
```

引擎会优先选择 `priority` 最高、`passes: false` 且 `blocked: false` 的 story。

### 第 2 步：运行引擎

```bash
npx coding-x                    # 默认用 claude，max-iter 50
npx coding-x codex              # 改用 codex 后端
npx coding-x --max-iter 20      # 最多 20 轮迭代
npx coding-x --no-open          # 不自动打开浏览器
npx coding-x --workspace ./run  # 指定 prd.json / progress.md 所在目录
npx coding-x repair             # 仅修复 .workspace/prd.json，不跑循环
```

> ⚠️ coding-x 会以**跳过权限确认**模式运行 AI agent（`--dangerously-skip-permissions` / `--dangerously-bypass-approvals-and-sandbox`），它会在无人确认的情况下读写文件、执行命令、提交代码。请务必确认当前目录是你信任的项目工作区。

### 第 3 步：查看实时进度

浏览器打开（默认会自动弹出）：

- 普通视图：<http://localhost:7331>
- 像素风视图：<http://localhost:7331/p>

### 命令行参数

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| 位置参数 `codex` | — | 使用 codex 后端（缺省为 claude） |
| 位置参数 `repair` | — | 仅修复 `<workspace>/prd.json` 后退出 |
| `--max-iter <n>` | `50` | 最大迭代轮数 |
| `--dev-timeout <分钟>` | `30` | 单轮开发阶段超时（分钟） |
| `--val-timeout <分钟>` | `60` | 单轮验证阶段超时（分钟） |
| `--workspace <dir>` | `.workspace` | `prd.json` / `progress.md` 所在目录 |
| `--no-open` | 关闭 | 不在启动时自动打开浏览器 |

### 环境变量

| 变量 | 说明 |
| --- | --- |
| `CODING_X_CLAUDE_BIN` | 覆盖 `claude` 可执行文件路径 |
| `CODING_X_CODEX_BIN` | 覆盖 `codex` 可执行文件路径 |

---

## 开发

- `npm run dev` —— 用 tsx 直接运行 CLI
- `npm test` —— Vitest 测试
- `npm run typecheck` —— `tsc --noEmit` 类型检查
- `npm run sync` —— 从 `assets/` 重新生成 `skills/ commands/ .cursor/ .agents/`
- `npm run build` —— tsup 打包到 `dist/`

技法来源：Ralph 自主循环 + Anthropic harness 设计。详见 `docs/superpowers/specs/`。
