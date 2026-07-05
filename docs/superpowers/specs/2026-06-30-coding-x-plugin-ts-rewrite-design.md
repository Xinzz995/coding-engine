---
title: "设计文档：coding-x —— Ralph 自动化 Coding 工作流插件化 + TypeScript 重写"
status: done
updated: 2026-07-06
scope: root
---

# 设计文档：coding-x —— Ralph 自动化 Coding 工作流插件化 + TypeScript 重写

- 日期：2026-06-30
- 作者：Xinzz + Claude

---

## 1. 背景与目标

当前仓库是 **Ralph 自动化 Coding 工作流（harness）本体**——一个用确定性程序固化 Developer → Validator 双 Agent 循环的系统，理论基础见 Anthropic《Harness Design for Long-Running Apps》与文章《AI 自动化 coding 2.0》。核心思想：**上下文为王 + 迭代验证**，用 `prd.json` 作为单一真相源（single source of truth），`progress.md` 作为跨迭代记忆。

现状由 Python 引擎（`ralph.py` / `dashboard.py` / `repair_prd_json.py`）+ 三套重复的 AI 资产（`.claude` / `.cursor` / `.agents` 下的 skills/commands）+ 两个 HTML 监控视图组成。

**本次目标：**
1. 把整套工作流封装成一个 **Claude Code 插件**（承载 skills/commands/agent 指令）。
2. 把执行引擎用 **TypeScript（Node.js）重写**，以 `npx coding-x` 形式分发，彻底告别 Python 运行时依赖。
3. 消除三套 AI 资产的手工重复（单一源 + 构建生成）。
4. 顺带修掉现有实现中的若干缺陷（见 §7）。

**非目标：**
- 不重写 dashboard 前端（两个 HTML 原样复用）。
- 不为真实 `claude`/`codex` 调用编写自动化测试（属手动端到端验收）。
- 不改变 Ralph 的核心方法论（PRD → User Story → prd.json → Developer/Validator 循环）。

---

## 2. 命名约定

| 项 | 名称 | 说明 |
|---|---|---|
| 包 / CLI | **`coding-x`** | 自解释名；`npx coding-x [claude\|codex]` 启动引擎 |
| 技法名 | `ralph` | 仅作为"自主循环技法"的名字保留在文档与 skill 内部（含 `ralph` skill 与触发词），不作为对外命令名 |
| Builder 指令 | `builder.md` | 原 `CLAUDE.md`，改名以避免与 Claude Code 约定的项目记忆 `CLAUDE.md` 撞名 |
| Validator 指令 | `validator.md` | 原 `VALIDATOR.md`，小写统一 |
| 任务状态文件 | `prd.json` | 沿用文章术语，保留 |
| 跨迭代日志 | `progress.md` | 原 `progress.txt`，实为 markdown，改后缀 |
| 运行时工作区 | `.workspace/` | 原 `scripts/ralph/`，名实相符；默认 gitignore |

---

## 3. 仓库结构

仓库根即 Claude Code 插件（符合插件标准布局），四类内容清晰分离：

```
coding-engine/
├── .claude-plugin/plugin.json   # Claude Code 插件清单（指向根级 commands/ skills/）
│
├── src/                         # 【只放 TS 源码】
│   ├── cli.ts                   # 入口：解析 argv（claude/codex、--max-iter、--dev-timeout、--val-timeout、--workspace）
│   ├── engine/
│   │   ├── loop.ts              # 主循环编排（原 ralph.py main + run_developer/validator）
│   │   ├── agent.ts             # 子进程封装：命令构建 + 超时 + stdio:'inherit'
│   │   ├── prd.ts               # prd.json 数据层：getCurrentStory / allStoriesResolved / 读写
│   │   ├── progress.ts          # progress.md 读取 + 提取最后 story ID
│   │   └── repair.ts            # JSON 修复（jsonrepair 库）
│   └── dashboard/
│       └── server.ts            # 原 dashboard.py：HTTP + /api/state + 状态机
│
├── assets/                      # 【唯一手写源：所有 AI 资产】
│   ├── instructions/  builder.md  validator.md
│   ├── skills/        prd/  ralph/  agent-browser/   （各含 SKILL.md）
│   ├── commands/      prime.md  plan-feature.md  create-rules.md
│   └── dashboard/     dashboard.html  dashboard-p.html   # 静态视图
│
├── skills/   commands/          # 【生成产物·Claude 版】= 插件自身引用的那套
├── .cursor/  .agents/           # 【生成产物·其他工具】
│
├── build/
│   └── sync-assets.ts           # 单一源 → 三套工具目录的生成器
│
├── .workspace/                  # 【运行时状态】prd.json / progress.md / screenshots/ / archive/
├── dist/                        # tsup 编译产物
├── docs/
├── package.json  tsconfig.json  vitest.config.ts
```

要点：
- `src/` 仅 TS；所有手写 markdown/html 资产在 `assets/`。
- 根级 `skills/`、`commands/` 是从 `assets/` 生成的 **Claude 版**，插件清单直接引用它；`.cursor/`、`.agents/` 为另外两套生成产物。**源 → 3 套**（而非 4 套）。
- 三套生成目录**提交进 git**（用户 clone 即用，免 build）。
- `.workspace/` 与代码/资产/产物彻底分离，默认 gitignore。

---

## 4. 运行时（Node.js + TS）

- **运行时**：Node.js。开发用 `tsx`，打包用 `tsup`。理由：`npx` 零门槛分发、生态最广、PTY/子进程最成熟。
- **子进程**：用 `child_process.spawn` + `stdio: 'inherit'`，子进程继承终端 TTY 即可实时流式输出，**不引入 `node-pty` 原生模块**（替代原 Python 的 `script -q /dev/null` PTY 包装）。
- **JSON 修复**：`jsonrepair` 作为正式依赖声明在 `package.json`，**消除原 Python 运行时 `pip install` 的脆弱点**。
- **测试**：Vitest。

---

## 5. 引擎模块职责

| 模块 | 职责 | 备注 |
|---|---|---|
| `prd.ts` | `prd.json` 纯数据层 | 无副作用，最易测 |
| `progress.ts` | 读 `progress.md`、提取最后一个 `## ` 节的 story ID | |
| `agent.ts` | 把一段 prompt 跑成子进程：构建 `claude --print --dangerously-skip-permissions <prompt>` / `codex exec --dangerously-bypass-approvals-and-sandbox <prompt>`，处理超时与终止 | 启动时打印**跳过权限模式的醒目警告**（见 §7-⑤） |
| `loop.ts` | 编排 `for i in 1..max`：`developing → run developer → (超时则跳过 validator) → validating → run validator → idle → 检查 resolved`，并驱动 dashboard 状态 | |
| `repair.ts` | JSON 修复，写入 `prd.json` 后调用 | |
| `dashboard/server.ts` | 起 :7331；路由 `/`、`/p`、`/api/state`；读 `.workspace/prd.json` + `progress.md` 拼实时状态 | 与引擎同进程 |

---

## 6. 端到端用户流程

两半各司其职：**插件管"想清楚做什么"，CLI 引擎管"自动把它做完"**。

```
① 安装插件（一次）   /plugin install coding-x
                    → 得到 /prime /plan-feature /create-rules + prd/ralph/agent-browser skill

② 规划阶段（人机协作） /prime → /plan-feature <功能> → "创建一个prd" → "将prd转成prd.json"
                    → 产出 .workspace/prd.json（写入后引擎自动 repair）

③ 自动执行（CLI）    npx coding-x          （或 npx coding-x codex）
                    → 起 http://localhost:7331 dashboard（/p 为像素视图）
                    → Developer→Validator 循环直到全部 passes 或 blocked
```

引擎默认在 `.workspace/` 下读写状态，可用 `--workspace <dir>` 覆盖。

---

## 7. 现有实现的缺陷修复（本次一并处理）

| # | 问题 | 处理 |
|---|---|---|
| ① | `CLAUDE.md` 要求 Builder 输出 `<promise>COMPLETE</promise>` 停止标记，但 `ralph.py` **从未解析 stdout**，纯靠 `all_stories_resolved()` 读 prd.json 判完成——该指令是死逻辑 | **从 `builder.md` 删除停止标记整段**（prd.json 已是足够的确定性真相源） |
| ② | `repair_prd_json.py` 运行时 `pip install json-repair`，脆弱 | TS 用 `jsonrepair` 正式依赖 |
| ③ | 主循环 `time.sleep(60)` 轮询，完成后最多空等 60s、超时 ±60s 误差 | 事件驱动：子进程 `exit` 事件 + `setTimeout` 超时 race，完成即推进 |
| ④ | 超时时长硬编码（dev 30min / val 60min） | 提为 CLI flag：`--dev-timeout` / `--val-timeout` / `--max-iter`，保留原默认值 |
| ⑤ | 危险权限开关硬编码且无提示 | 默认保留（自动化必需），但**启动时打印醒目警告**说明正在跳过权限运行 |

---

## 8. 测试策略（Vitest）

- **纯函数层（重点）**：`prd.ts`（story 选取、`allStoriesResolved` 边界、读写往返）、`repair.ts`（坏 JSON → 合法；不可修复时不覆盖）、`progress.ts`（提取最后 story ID）、`agent.ts`（命令构建：claude vs codex + flag 拼接）。
- **编排层（桩子进程，不调真 AI）**：`loop.ts` 用一个**假 agent 脚本**（立即退出/sleep/写 prd.json 的小 node 脚本）替代 `claude`/`codex`，验证阶段切换、超时跳过 Validator、全部 resolved → 退出码 0、达 max-iter → 退出码 1。
- **服务层**：`dashboard/server.ts` 写临时 `.workspace/prd.json` + `progress.md`，请求 `/api/state` 断言 JSON 结构；`/`、`/p` 返回对应 HTML。
- **构建层**：`sync-assets.ts` 断言生成幂等、三套目标目录产物存在且 frontmatter 转换正确。
- **不覆盖**：真实 `claude`/`codex` 调用（不确定、需 key、慢）→ 手动端到端验收。

---

## 9. 决策汇总

1. 形态：npm 引擎内核 + Claude Code 插件壳（两者都要，对应系统天然的两半）。
2. 运行时：Node.js（tsx/tsup），子进程用 `stdio:'inherit'`，不引 node-pty。
3. AI 资产：单一源 `assets/` → 生成 `skills/`+`commands/`（Claude）/`.cursor/`/`.agents/`，三套均提交。
4. Dashboard：服务端 TS 重写，两个 HTML 原样复用，不做前端重写。
5. 命名：CLI=`coding-x`，技法名=`ralph`（仅文档/skill 内部），`builder.md`/`validator.md`/`progress.md`/`.workspace/`，`prd.json` 保留。
6. 缺陷修复：删死逻辑停止标记、正式依赖 jsonrepair、事件驱动超时、超时/迭代可配置、权限警告。
