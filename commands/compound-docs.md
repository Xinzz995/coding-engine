---
description: 一轮循环或功能分支收口时，把 progress.md 与 git 历史中的经验提炼、验证、分层沉淀回项目文档；只改文档不改代码
---

# 收口沉淀（复利文档回收）

一轮 run／功能分支的大部分或全部 story 完成后，把已经落地的真实结构变化、稳定约定、系统边界和高频陷阱，沉淀回项目文档，让下一轮 AI Coding 更准。这不是功能开发命令：**只允许修改文档文件**。

## 何时使用

- 引擎循环全部 story 通过后（引擎会提示运行本命令）
- 功能分支收口、准备合并时
- 积累了一批 commit，目录结构或开发约定发生了真实变化

不要用于：单个 story 实现中、纯代码修复/联调/发布、只想更新 PRD 或进度日志。

## 硬性约束

1. 只允许修改文档文件；禁止修改业务代码、脚本、配置、测试
2. 项目文档中禁止出现 harness 工具细节——凡提及 `.workspace/`、`prd.json`、`state.json`、`progress.md`、validator、agent-browser、coding-x 等工具词的条目一律不写入（工具知识只留在 `.workspace/progress.md`）
3. 只沉淀「项目相关、可复用、当前代码仍然成立」的知识
4. 当前代码状态与历史记录冲突时，以当前代码状态为准
5. 证据不足，宁可不写
6. 最小修改：优先补充/修正/去重，不重写整份文档，保持现有风格与章节层级；一条经验只写一次、写到最合适的位置

## 事实优先级

按此顺序判断事实（高优先级覆盖低优先级）：

1. 当前分支真实代码与目录结构
2. 当前分支相对默认分支的 git diff / git log
3. `.workspace/progress.md` 的 `## Codebase Patterns` 与各 story 的「未来迭代的学习」
4. `.workspace/prd.json` 的交付范围说明（只用于理解「这轮做了什么」，不是事实来源）

progress.md 里写了但当前代码已不再体现的经验，不沉淀。

## 工作流程

### 1. 建立范围

- 读 `.workspace/prd.json`：branchName、交付范围（顶层 `sourcePrd` 存在时可读源 PRD 补背景）
- 读 `.workspace/state.json`：哪些 story 已 `passes`（本轮实际完成范围）
- git 取证基线：

```bash
DEFAULT_BRANCH=$(git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null | sed 's@^refs/remotes/origin/@@')
DEFAULT_BRANCH=${DEFAULT_BRANCH:-main}
MERGE_BASE=$(git merge-base HEAD "origin/$DEFAULT_BRANCH" 2>/dev/null || git merge-base HEAD "$DEFAULT_BRANCH")
git log --reverse --oneline "$MERGE_BASE"..HEAD
git diff --name-status "$MERGE_BASE"..HEAD
```

**降级规则**：非 git 仓库或 merge-base 失败（如就在默认分支上且无分叉）→ 改用近期提交（`git log --oneline -30`）或跳过 git 取证，只基于 progress.md + 当前代码，并在交付说明中注明；`.workspace/` 或 progress.md 缺失 → 提示用户先跑引擎循环，本次只做纯 git + 代码取证（价值有限，如实说明）。

### 2. 交叉取证

四路对照：当前代码结构 ⨯ git log/diff ⨯ progress.md ⨯ prd.json 交付说明。逐条核对候选经验在当前代码中是否仍然成立（结构是否还在、约定是否还被遵守）。

### 3. 提炼（归纳而不是抄录）

只保留四类：

- 目录结构已真实变化、未来必须知道的新入口/新模块/归属
- 多个 story 反复出现、未来会复用的稳定开发约定
- 容易再次踩、与本项目框架/数据边界/路由方式强相关的陷阱
- 影响 AI 编码正确性的系统边界、跨项目协作边界、公开接口边界

排除：story 编号与修复经过、过程叙事、一次性事故、临时占位、执行环境信息（「需手动验证」类）、已在现有文档准确表达的内容。

每条候选自问四题：当前代码仍成立？是项目知识而非自动化工具知识？未来会再遇到？该落在哪一层文档？

### 4. 落位

**第一优先——动态发现**：读目标项目根 `AGENTS.md` 的文档索引表，按它声明的结构落位。AGENTS.md 是入口和索引，与你预想的目录结构不同时，服从 AGENTS.md。

- monorepo：子项目内部知识落该子项目的 `AGENTS.md`/docs（存在时）；跨子项目集成边界落根级架构文档
- 根 `AGENTS.md` 只允许更新仓库级导航/硬约束，不堆子项目细节

**兜底——init-docs 两层默认体系**（无 AGENTS.md 或无文档索引时）：

| 知识类型 | 落点 | 方式 |
|---|---|---|
| 结构变化、模块归属、数据流 | `docs/architecture.md` | 就地更新对应章节（模块表加行、数据流改句），不做末尾追加 |
| 集成/接口边界 | `docs/architecture.md`（分层与依赖方向） | 就地更新 |
| 机械可判定的强制规则 | `docs/golden-principles.md` | 追加；保持 3–5 条精简，超出时提请用户取舍；该文件不存在时不自动创建，降级进 patterns.md |
| 稳定约定 + 高频陷阱 | `docs/patterns.md` | 分「约定」「陷阱」两章追加，条目带日期；文件不存在时按 coding-x 插件 `templates/docs/patterns.md` 骨架创建 |

三个落点文件都不存在且无 `AGENTS.md` 时：建议用户先跑 `/init-docs`，本次只输出候选清单，不写入。

**沉淀模式迁移（一次性自愈）**：若目标项目 `docs/architecture.md` 存在旧的 `## 沉淀模式` 章节（来自旧版 builder 内联升格），把其中条目按上表重新落位（多数进 patterns.md），然后删除该章节。

### 5. 写入

按落位结果最小修改。写作要求：条目短、信息密度高、可验证；用项目语言描述，不提自动化流水线；优先描述稳定模式与边界，不写过程叙事。

### 6. 交付说明

完成后简短汇报：更新了哪些文档、每份补了什么类型的信息、明确排除了哪些不该沉淀的内容（及排除理由）。

## 执行模式

默认直接执行文档更新。用户要求「先分析」时，先输出：候选沉淀项、对应写入文件、不建议写入的内容，获确认后再改。
