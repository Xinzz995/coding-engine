---
title: "PRD: coding-x doctor——docs/ 知识库健康检查子命令"
status: active
updated: 2026-07-03
scope: root
---

# PRD: coding-x doctor——docs/ 知识库健康检查子命令

## Introduction

docs/ 知识库是 agent 每轮阅读的记录系统，但它会腐烂：文件改了而 frontmatter `updated` 没跟上、AGENTS.md 索引指向被移走的路径、文档间相对链接断裂。这些都是机械可判定的问题，却没有任何工具在看。

新增引擎子命令 `coding-x doctor`：对目标项目的根 `docs/` 与根 `AGENTS.md` 做四项纯机械健康检查，发现问题以退出码 1 结束，可直接放进 CI 当门禁。不需要 LLM，不改任何文件。

## Goals

- 一条命令暴露知识库的元数据缺失、内容过期、索引断链、文档断链
- 检查全部机械可判定（可进 CI），发现问题 exit 1、干净 exit 0
- 零新增运行时依赖，不修改任何文件（只读检查）
- 对未采用知识库体系的项目温和降级（提示而非报错）

## User Stories

### US-001: doctor 子命令骨架 + frontmatter 完整性检查
**描述：** 作为维护者，我想运行 `coding-x doctor` 检查 docs/ 各文档的 frontmatter 元数据是否完整，以便知识库文件始终带有规范的 title/status/updated/scope。

**Acceptance Criteria：**
- [ ] 运行 `coding-x doctor` 会递归扫描项目根 `docs/` 目录树下的全部 `.md` 文件
- [ ] 对以 `---` frontmatter 块开头的文件，检查其 frontmatter 是否包含 `title`、`status`、`updated`、`scope` 四个字段；缺失的文件逐条输出「文件路径 + 缺失字段名」
- [ ] 不以 frontmatter 开头的 `.md`（如各目录 README 占位、docs/superpowers/ 下的工作产物）不参与本项检查、不产生任何报错
- [ ] 全部通过时输出明确的通过信息（含已检查文件数）
- [ ] 存在任何问题时进程退出码为 1，全部通过时为 0
- [ ] 项目根不存在 `docs/` 目录时：输出提示建议先运行 /init-docs 生成知识库，以退出码 0 结束
- [ ] Typecheck 通过；上述行为（缺字段、无 frontmatter 跳过、无 docs/ 降级、退出码）有自动化测试覆盖

### US-002: updated 新鲜度检查（--stale-days）
**描述：** 作为维护者，我想知道哪些文档实际被改过但 frontmatter `updated` 长期没更新，以便发现名存实亡的"最新"文档。

**Acceptance Criteria：**
- [ ] 对每个带 frontmatter 且含 `updated` 字段的 docs/ 文件：取该文件在 git 中的最后提交日期，与 `updated` 值比较；git 日期晚于 `updated` 超过阈值天数 → 判为过期，逐条输出「文件、updated 值、git 最后提交日期、落后天数」
- [ ] 阈值通过 `--stale-days <n>` 指定，缺省为 30；`--stale-days 0` 表示 git 日期只要晚于 `updated` 即算过期
- [ ] `updated` 字段值不是 `YYYY-MM-DD` 格式时，输出格式非法问题（计入退出码 1）
- [ ] 当前目录不是 git 仓库、或该文件尚无任何提交记录时，跳过该文件的新鲜度检查且不报错
- [ ] 过期与格式非法均计入退出码 1
- [ ] Typecheck 通过；上述行为（过期判定、阈值参数、0 阈值、非 git 降级、非法格式）有自动化测试覆盖

### US-003: AGENTS.md 索引与文档相对链接检查
**描述：** 作为维护者，我想发现 AGENTS.md 文档索引里指向不存在路径的行、以及 docs/ 文档间的断链，以便 agent 永远不会被地图带进死胡同。

**Acceptance Criteria：**
- [ ] 解析项目根 `AGENTS.md` 中 markdown 表格里以反引号包裹的相对路径（如 `` `docs/architecture.md` ``、`` `docs/decisions/` ``），逐一检查文件或目录存在；不存在的逐条输出「AGENTS.md 索引 + 缺失路径」
- [ ] 项目根不存在 `AGENTS.md` 时跳过本项检查并输出提示，不计入失败
- [ ] 扫描 docs/ 树内所有带 frontmatter 文件正文中的 markdown 内联链接 `[text](target)`：target 为相对路径时（不以 `http://`、`https://`、`#`、`/` 开头），按所在文件位置解析并检查目标存在（目标含 `#锚点` 时只检查文件部分）；断链逐条输出「所在文件 + 链接目标」
- [ ] 索引缺失路径与文档断链均计入退出码 1
- [ ] Typecheck 通过；上述行为（索引路径提取、目录路径、断链、锚点剥离、无 AGENTS.md 降级）有自动化测试覆盖

### US-004: 文档同步与真实运行闭环
**描述：** 作为用户，我想在 README 里查到 doctor 的用法，并且这条命令在真实仓库上跑通，以便功能可被发现且确实可用。

**Acceptance Criteria：**
- [ ] README 的 CLI 使用说明（「第 2 步：运行引擎」的命令示例块）与「命令行参数」表新增 `doctor` 子命令与 `--stale-days` 参数说明
- [ ] `docs/architecture.md` 模块划分表新增 doctor 模块一行（路径与职责与实际实现一致）
- [ ] 在本仓库根目录真实运行一次 `coding-x doctor`（构建产物或 dev 方式均可）：命令正常完成、输出四项检查结果、以与检查结果一致的退出码结束（此结果写入进度说明）
- [ ] Typecheck 通过；全部既有测试与新增测试通过

## Functional Requirements

- FR-1: CLI 新增子命令 `doctor`（与既有 `dashboard`、`repair` 子命令同级分发），支持 `--stale-days <n>` 参数（默认 30）
- FR-2: frontmatter 完整性——递归扫描根 `docs/**/*.md`，仅对以 `---` 开头的文件校验 `title/status/updated/scope` 四字段齐全
- FR-3: 新鲜度——对含 `updated` 的上述文件，比较 git 最后提交日期与 `updated`，落后超过 `--stale-days` 天判过期；`updated` 非 `YYYY-MM-DD` 判格式非法
- FR-4: 索引有效性——解析根 `AGENTS.md` 表格中反引号包裹的相对路径，校验文件/目录存在
- FR-5: 链接有效性——校验 docs/ 带 frontmatter 文件正文内相对 markdown 链接的目标存在（剥离锚点；跳过外链、纯锚点、绝对路径）
- FR-6: 汇总输出按检查项分组、逐条给出文件与原因；任何一项有问题 → exit 1，否则 exit 0
- FR-7: 降级行为——无 `docs/`：提示 + exit 0；无 `AGENTS.md`：跳过 FR-4 并提示；非 git 仓库/文件未入库：跳过该文件的 FR-3
- FR-8: doctor 为只读命令，不创建、不修改、不删除任何文件

## Non-Goals

- 不检查 monorepo 子项目的 `<sub>/docs/` 与 `<sub>/AGENTS.md`（二期）
- 不提供 `--strict`（把无 frontmatter 文件也判违规）——二期再议
- 不做自动修复（如回写 `updated`）——doctor 只诊断
- 不做语义级检查（内容是否过时需要判断力，那是 /compound-docs 与人的事）
- 不集成进 builder/validator 循环、不改动引擎迭代行为
- 不校验外部 URL 可达性

## Technical Considerations

- **零新增运行时依赖**：frontmatter 解析用简单行解析（`---` 块内 `key: value` 提取），不引入 gray-matter/yaml 等库；git 日期用子进程调 `git log -1 --format=%cs -- <file>`
- 子命令分发在 `src/cli.ts` 已有 `dashboard`、`repair` 先例，沿用同一模式
- 检查逻辑放独立模块并导出纯函数，便于用临时目录 fixture 做单测（仓库测试惯例：测试与源码同目录 `*.test.ts`）
- 输出风格与现有 CLI 一致（中文信息、✅/❌ 类标记）；本仓库 dogfood 时四项应全绿（patterns.md 等均带完整 frontmatter 且 updated 为当天）

## Success Metrics

- 本仓库运行 `coding-x doctor` 一秒内完成且结果准确（现状应全绿）
- 人为制造一处缺字段/过期/断链，doctor 均能各自准确报出且 exit 1
- CI 中可直接以 `npx coding-x doctor` 作为文档门禁步骤（是否真加入本仓库 CI 留待观察）

## Open Questions

- 二期是否加 `--strict` 模式把「无 frontmatter 的 docs/*.md」也判违规（当前跳过是为不误伤 superpowers 产物与 README 占位）
- 二期是否随 monorepo 支持一并检查子项目文档与子 AGENTS.md
- `status: superseded/done` 的文档是否应豁免新鲜度检查（当前一视同仁）
