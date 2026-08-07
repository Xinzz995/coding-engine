---
title: 依赖自动化分组与受保护工具刷新
status: done
updated: 2026-08-06
scope: root
---

# 依赖自动化分组与受保护工具刷新

## Context

遗留 Dependabot PR #51、#53、#135、#178 暴露了两个不同问题：已经被主分支替代的旧更新没有
及时关闭；现行 `development-dependencies` 分组会把 TypeScript、Node 类型与普通补丁更新捆在
同一 PR 中，使不兼容的大版本阻断整组。PR #135 的 CodeQL v4.37.4 也已经落后当前 v4.37.6。

本任务由限时政策例外 Issue #180 跟踪。旧 PR 只关闭、不合并；新改动从最新 `main` 独立验证。

## Goals

- 将 CodeQL `init` 与 `analyze` 固定到 v4.37.6 的同一完整提交。
- 将 `tsx` 从 4.23.1 单独更新到当前 4.23.9，不夹带 TypeScript 或 Node 类型大版本。
- npm 与 GitHub Actions 常规分组只包含 minor/patch；major 保持独立。
- 在工具链明确支持前，暂停 TypeScript 与 `@types/node` 的 major 自动更新。
- 保留现行人工批准和政策例外要求，不为 Dependabot 放宽受保护路径。

## Non-Goals

- 不升级 TypeScript 7、`@types/node` 26 或运行时 Node 主版本。
- 不自动批准、合并或放行未来 Dependabot PR。
- 不改变质量契约、Ruleset、测试矩阵、npm 发布或本地三层 Review。
- 不修改运行时代码。

## Acceptance Criteria

1. PR #51、#53、#135、#178 均关闭且未合并。
2. `.github/workflows/codeql.yml` 的两个 CodeQL Action 都固定到
   `5595ccaf912efad79be6eef63a5619ff05969be3`（v4.37.6）。
3. `package.json` 与锁文件只把直接开发依赖 `tsx` 更新到 `^4.23.9` / 4.23.9；TypeScript 仍为
   5.9.3，`@types/node` 仍为 22.20.1。
4. production/development 与 GitHub Actions 常规分组都只接受 minor/patch；major 不进入组合 PR。
5. TypeScript 与 `@types/node` major 被显式忽略，后续迁移必须先修改本计划所建立的配置。
6. 格式、静态检查、类型检查、全量测试、构建、成品 CLI、仓库健康和高危依赖审计通过。
7. PR 关联 Issue #180，获得维护者批准标签，远端政策检查、总闸与 CodeQL 全部通过。

## Golden Principles

| 原则 | 适用性与设计裁决 | 验证证据 |
|---|---|---|
| 1. 可证伪完成合同 | 适用。版本、分组范围、忽略对象和检查结果都有精确断言。 | 文件差异、锁文件版本、完整本地与远端检查。 |
| 2. 生成方不得自签 | 适用。依赖更新声明不算通过，仍由安装、测试、CodeQL 和 GitHub 总闸独立裁决。 | `npm ci`、全量检查、PR checks。 |
| 3. 自治与可逆性对称 | 适用。不增加自动合并或自动批准；改动可由普通回退 PR 撤销。 | Dependabot 配置、政策标签与 Issue #180。 |
| 4. 原生执行能力优先 | 适用。只使用 GitHub 原生 Dependabot 分组和 ignore 选项，不新建机器人或服务。 | GitHub 官方配置格式、仓库现有工作流。 |
| 5. 假绿与失败恢复优先 | 适用。#178 的不兼容组合被固化为“major 不分组”；工具链未支持时停止重复提案。 | 配置断言、依赖安装与版本核对。 |

## Implementation

1. 关闭四个旧 PR，保留说明和历史。
2. 更新 CodeQL 完整提交、tsx 清单与锁文件。
3. 收紧 Dependabot 分组并忽略两个已知不支持的 major 更新。
4. 增加仓库健康断言，防止分组重新吞入 major 或 CodeQL 两处版本漂移。
5. 通过本地检查后创建受保护 PR；远端全部通过后合并并关闭 Issue #180。

## Completion

PR #181 已合并，全部远端检查通过；四个失效的旧依赖 PR 已关闭，Issue #180 已按完成关闭。
主分支继续使用拆分后的依赖分组与固定版本的 CodeQL Action。

## Rollback

若升级或配置导致安装、检查或扫描异常，回退本 PR。不得通过 `--force`、忽略依赖冲突、移除
政策检查或降低测试要求来制造绿色结果。
