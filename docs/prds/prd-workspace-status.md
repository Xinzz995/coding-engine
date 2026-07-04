---
title: "PRD: coding-x status——工作区执行状态终端速览子命令"
status: active
updated: 2026-07-04
scope: root
---

# PRD: coding-x status——工作区执行状态终端速览子命令

## Introduction

引擎循环的执行状态分散在 `.workspace/` 三个文件里（prd.json 需求、state.json 状态、progress.md 日志）。想知道「跑到哪了、有没有卡住、有没有留给人的冲突记录」，目前只有两条路：起 dashboard（开端口、开浏览器，重）或手动拼读三个文件（人麻烦，agent/脚本每次都要重新解析）。

新增只读子命令 `coding-x status`：终端一屏输出当前工作区的项目名、分支、每个 story 的通过/阻塞/重试情况、留给人裁决的 notes（尤其 `[需求冲突]`）、最近一次进展记录；`--json` 供脚本与 agent 机器消费；退出码反映整体完成状态，可直接作 CI 门禁（「循环真的全绿了吗」）。不起服务、不改文件、零新增依赖。

## Goals

- 一条命令一屏看清工作区执行状态（不起服务器、不开浏览器）
- 留给人的信息（`[需求冲突]` notes、blocked story）必须冒出来，不被淹没
- `--json` 机器可读输出，agent/脚本/CI 可直接消费
- 退出码可作门禁：全通过 0、未全通过 1、无可读工作区 2
- 复用引擎既有合并视图逻辑，v0.4 旧格式 workspace 与历史归档零迁移可看
- 只读、零新增运行时依赖

## User Stories

### US-001: status 子命令骨架 + 总览输出与退出码
**描述：** 作为维护者，我想运行 `coding-x status` 一眼看到当前工作区每个 story 的执行状态与整体进度，以便不开浏览器就知道循环跑到哪了。

**Acceptance Criteria：**
- [ ] 运行 `coding-x status` 读取 `--workspace`（缺省 `.workspace`）目录下的 `prd.json` 与 `state.json`，输出总览：项目名、分支名、story 通过数/总数
- [ ] 每个 story 输出一行：状态标记 + id + 标题；通过、未通过、阻塞三种状态的行首标记互不相同；`retryCount` 大于 0 的 story 行内显示重试次数
- [ ] 全部 story 通过时输出明确的全绿信息，进程退出码为 0
- [ ] 存在未通过或 blocked 的 story 时退出码为 1
- [ ] workspace 目录或其中 `prd.json` 不存在时：输出提示（建议先用 prd-to-json 生成工作区）并以退出码 2 结束
- [ ] `prd.json` 存在但无法解析时：输出错误提示（建议运行 `npx coding-x repair`）并以退出码 2 结束
- [ ] 总览输出、三种状态标记、重试显示、无工作区与解析失败降级、退出码等行为有自动化测试覆盖
- [ ] Typecheck 通过

### US-002: 留给人的信息——notes、冲突、当前 story、最近进展
**描述：** 作为维护者，我想让 status 把需要人裁决的信息（冲突 notes、阻塞原因）和「现在跑到哪」直接冒出来，以便我不漏看关键决策点。

**Acceptance Criteria：**
- [ ] `state.json` 中 notes 非空的 story：notes 内容随该 story 逐行缩进显示
- [ ] notes 中以 `[需求冲突]` 开头的行带醒目警示标记输出，与普通 notes 行可区分
- [ ] 存在未通过且未阻塞的 story 时，输出「当前 story」提示行，指向其中 priority 最高的一个（与引擎每轮选取 story 的语义一致）
- [ ] blocked 的 story 数量在汇总中单独呈现（为 0 时不显示阻塞计数）
- [ ] `progress.md` 存在且含 `## ` 开头的迭代记录时，显示最后一条记录的标题行作为「最近进展」；文件缺失或无记录时不显示该行且不报错
- [ ] notes 呈现、冲突行标记、当前 story 提示、blocked 计数、最近进展有/无两态有自动化测试覆盖
- [ ] Typecheck 通过

### US-003: --json 机器可读输出 + 旧格式回退
**描述：** 作为 agent/脚本作者，我想用 `coding-x status --json` 拿到结构化的执行状态，以便程序化消费而不解析人类可读文本；旧格式工作区也要能看。

**Acceptance Criteria：**
- [ ] `coding-x status --json` 向 stdout 输出单个 JSON 对象，字段含 `project`、`branchName`、`sourcePrd`（prd.json 中存在时）、`stories`（每项含 id/title/priority/passes/notes/retryCount/blocked）、`summary`（total/passed/blocked 计数）
- [ ] `--json` 模式下 stdout 内容可被 `JSON.parse` 直接解析（无任何装饰性文本混入）
- [ ] `--json` 模式退出码语义与人类可读模式一致（0/1/2）
- [ ] `state.json` 缺失时：按 prd.json story 上的旧格式内嵌状态字段回退合并（v0.4 workspace 与历史归档零迁移可看，语义与 dashboard 离线回看一致）
- [ ] `state.json` 存在但损坏（解析失败或形状非法）时：按旧格式回退合并，并向 stderr 输出警告建议运行 `npx coding-x repair`；`--json` 模式下该警告不污染 stdout
- [ ] JSON 可解析性、字段齐全、旧格式回退、损坏警告走 stderr、退出码有自动化测试覆盖
- [ ] Typecheck 通过

### US-004: 文档同步与真实运行闭环
**描述：** 作为用户，我想在 README 里查到 status 的用法，并且这条命令在本仓库真实跑通，以便功能可被发现且确实可用。

**Acceptance Criteria：**
- [ ] README 的「第 2 步：运行引擎」命令示例块与「命令行参数」表新增 `status` 子命令与 `--json` 参数说明
- [ ] `docs/architecture.md` 模块划分表新增 status 模块一行（路径与职责与实际实现一致）
- [ ] 在本仓库根目录真实运行一次构建后的 status（`node dist/cli.js status` 或等价方式）：输出的 story 状态、汇总与退出码与 `.workspace/` 当前实际内容一致，运行结果摘要写入进度说明
- [ ] 全部既有测试与新增测试通过
- [ ] Typecheck 通过

## Functional Requirements

- FR-1: CLI 新增子命令 `status`（与既有 `dashboard`、`repair`、`doctor` 同级分发），支持 `--workspace <dir>`（缺省 `.workspace`）与 `--json` 参数
- FR-2: 人类可读输出包含——总览（项目名、分支名、通过数/总数、blocked 计数（>0 时））、每 story 一行（三态标记/id/标题/重试次数（>0 时））、非空 notes 缩进展示、`[需求冲突]` 行醒目标记、「当前 story」提示行、最近进展标题行（progress.md 有记录时）
- FR-3: `--json` 输出合并视图单个 JSON 对象到 stdout，无装饰文本；人类警告一律走 stderr
- FR-4: 状态合并以 `state.json` 为准；state.json 缺失或损坏时回退读 prd.json story 上的旧格式内嵌状态字段（损坏时 stderr 警告建议 repair）
- FR-5: 退出码——全部 story passes：0；存在未通过或 blocked：1；workspace 目录/prd.json 不存在或不可解析：2
- FR-6: status 为只读命令，不创建、不修改、不删除任何文件
- FR-7: 零新增运行时依赖，复用 `src/engine/` 既有纯函数（`tryReadPrd`、`tryReadState`、`mergedStories`、`getCurrentStoryId`、`readProgress`）

## Non-Goals

- 不起 HTTP 服务、不打开浏览器（实时可视化是 `dashboard` 子命令的职责）
- 不做 watch/轮询实时刷新——status 是时点快照
- 不做 `.workspace/archive/` 的专用聚合或列表（`--workspace` 指向归档子目录即可离线查看单次归档）
- 不修复损坏文件（提示交给 `repair`）
- 不做 ANSI 颜色/主题配置（沿用现有 CLI 的中文 + emoji 标记风格）
- 不改动引擎循环行为、不集成进 builder/validator 指令

## Technical Considerations

- **复用优先**：合并视图 `mergedStories(prd, state)`（含 legacy 回退）、`tryReadState`、`getCurrentStoryId` 已在 `src/engine/state.ts` 导出，`tryReadPrd` 在 `src/engine/prd.ts`，`readProgress` 在 `src/engine/progress.ts`——status 应是这些纯函数之上的薄呈现层，不复制判定逻辑
- 子命令分发沿 `src/cli.ts` 既有模式（command 联合类型 + `main()` 分支早返回退出码）；核心逻辑放独立模块 `src/status/`（仿 `src/doctor/` 惯例：纯函数接收数据返回结构体/文本，渲染与 process 副作用留在 cli 薄胶水层）
- 测试惯例：与源码同目录 `*.test.ts`，fixture 用 `mkdtempSync(join(tmpdir(), ...))` + try/finally `rmSync`
- stdout/stderr 纪律：`--json` 时 stdout 只有 JSON，警告走 stderr，保证 `status --json | jq` 可用
- 输出风格与现有 CLI 一致（中文信息、✅/❌ 类标记）

## Success Metrics

- 引擎循环结束后在本仓库运行 status，1 秒内一眼看到全绿/未全绿与冲突 notes
- `coding-x status --json | jq .summary` 可直接消费
- CI/脚本可用退出码判定「循环是否全部通过」，无需解析文本

## Open Questions

- 二期是否加 `--archive` 列出全部历史归档运行并逐个速览（当前 `--workspace` 指向归档子目录已可单看）
- 二期是否在引擎循环每轮结束后自动打印一行 status 摘要（当前实时性由 dashboard 承担）
- 是否需要 `--quiet`（只出退出码不出文本）供纯门禁场景（当前 `--json` 已可脚本消费，暂不做）
