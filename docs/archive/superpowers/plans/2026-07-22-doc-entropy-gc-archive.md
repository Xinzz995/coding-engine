---
title: "实施计划：doc-gardening 熵 GC 与物理归档"
status: done
updated: 2026-07-22
scope: root
---

# doc-gardening 熵 GC 与物理归档实施计划

**Goal:** 把内容熵 GC 与完成态文档物理归档固化进 `/compound-docs`，让 active 知识保持短而可信、历史文档进入可追溯冷区，并完成 coding-x 首次迁移。

**Architecture:** 工作流判断留在 command prompt；doctor 只提供冷区结构健康检查，不承担语义 GC 或移动。`docs/archive/` 镜像原相对树，AGENTS 只把它登记为按需追溯的冷档案。

## Task 1：工作流与模板合同

- Modify: `commands/compound-docs.md`
- Create: `templates/docs/archive-README.md`
- Modify: `templates/docs/patterns.md`、`templates/docs/glossary.md`
- Test: `src/compound-docs-contract.test.ts`

步骤：

1. 把现有七步扩展为：范围/取证/提炼/落位/写入/熵 GC/状态收尾/物理归档/交付说明。
2. 写死增量默认、全量显式、五类活知识、六态裁决与证据清单。
3. 写死归档资格、ADR/rejected 排除、候选预览与明确确认门。
4. 写死 `docs/archive/<原相对路径>`、无 stub、引用重算、冷档案不可变性与 AGENTS 冷索引。
5. 新增 archive README 模板；patterns/glossary 模板说明条目会参与后续 GC。
6. 用 prompt 合同测试固定关键锚点，防止后续措辞修订丢掉安全边界。

## Task 2：doctor 冷档案语义

- Modify: `src/doctor/doctor.ts`
- Modify: `src/doctor/doctor.test.ts`

步骤：

1. `FreshnessCheckResult` 增加冷档案跳过计数。
2. 遍历时以相对 `docs/` 的第一段是否为 `archive` 判定冷区；frontmatter/链接逻辑照常，进入 freshness 前短路。
3. 报告新鲜度检查数量时同时显示跳过数。
4. 测试覆盖：陈旧/非法日期的归档文档不报 freshness；归档文档缺 frontmatter 字段或断链仍报错；active 区同样输入仍报错。

## Task 3：用户文档、初始化约定与版本

- Modify: `README.md`
- Modify: `commands/init-docs.md`
- Modify: `docs/architecture.md`
- Modify: `AGENTS.md`
- Modify: `package.json`、`package-lock.json`
- Modify: `.claude-plugin/plugin.json`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`

步骤：

1. README 的收口流程、命令表、doctor 参数说明与目录树登记 GC/冷档案语义。
2. init-docs 的 plans/prds README 占位说明完成态可由 compound-docs 归档，但不预建空 archive。
3. architecture 的 doctor 与模板模块、文档数据流同步。
4. 本仓 AGENTS 增加冷档案行；物理迁移后该路径真实存在。
5. 版本升 `0.26.0` 并同步全部落点。

## Task 4：本仓全量熵 GC

- Modify as evidence requires: `docs/patterns.md`
- Modify as evidence requires: `docs/glossary.md`
- Modify as evidence requires: `docs/architecture.md`
- Modify as evidence requires: `docs/golden-principles.md`
- Modify as evidence requires: `docs/prompt-writing.md`

步骤：

1. 对每一条/节按当前代码、ADR 与职责边界判为保留、改写、合并、迁位、删除或待拍板。
2. 不强求产生 diff；有修改时更新 frontmatter `updated`。
3. 记录所有非“保留”裁决及证据，供最终熵 GC 清单汇报。

## Task 5：本仓 46 份历史文档迁移

- Create: `docs/archive/README.md`
- Create: `docs/superpowers/specs/README.md`
- Create: `docs/superpowers/plans/README.md`
- Move: 46 份已确认 `done/superseded` 非 ADR 文档
- Modify: 指向这些文档的活导航引用与归档内相对链接

步骤：

1. 再生成并核对候选清单恰为 46，目标路径无冲突。
2. 创建冷档案入口和 active 目录 README。
3. 按原相对树批量移动，不改历史正文/frontmatter。
4. 重算 Markdown 相对链接，更新 active ADR 等导航路径；不改历史命令记录。
5. 核对源路径无副本、目标 46 份齐全、两个 superseded ADR 与 rejected ADR 原位。

## Task 6：验证

1. `npx tsx src/cli.ts doctor --stale-days 0`：frontmatter、AGENTS 索引、相对链接通过；冷档案不因旧 updated 失败。
2. `npm run typecheck`。
3. `npm test`。
4. `npm run build`，并真实执行 `node dist/cli.js --help`。
5. 核对 `git diff --check`、版本一致性、迁移计数和工作树没有范围外改动。
6. 不 commit、不 tag、不 push、不发布。
