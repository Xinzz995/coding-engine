---
title: 030-change-scoped-checks-and-scheduled-full
status: active
updated: 2026-08-20
scope: root
---

# 030. 按可信 Git 变化范围执行必要检查，以定时全量检查发现环境漂移

## 背景

质量契约的每项检查已经可以声明 `paths`，但 0.37.0 以前本地引擎和生成的 GitHub workflow 都忽略
这些字段。#250 的纯文档候选因此在 Builder 和引擎门禁各执行一次约 26 分钟的完整测试，远端同时
启动全部系统和 Node 版本。相同输入复用消除了 Validator 与最终 Review 的部分重复，却没有解决第一
次全量检查本身对低风险改动过重的问题。

简单给必需 workflow 添加事件级 `paths-ignore` 不可用：GitHub 会让未触发 workflow 的必需检查保持
等待，阻塞合并。任意跨运行复用历史绿色结果也不可用：宿主镜像、依赖源和工具链漂移不会被当前提交
身份捕获。当前 PR 的必需检查是例外：它直接裁决这次合并，默认分支或 PR head 一旦变化，严格 Ruleset
会要求重新运行；取消合并后的第二次事件不是把旧检查冒充新凭证。

## 决策

1. 引擎在干净验证检出中，以固定 Story 起点到当前 HEAD 的完整 Git 清单计算当前平台命中的检查
   `paths`。没有 `paths` 的检查始终适用；未知路径、零项、缺失或异常选择一律回退当前平台全量。
2. 按范围检查证明继续只在同一进程复用，并额外绑定 Story 起点、变化摘要、选择模式和有序检查 ID。
   Validator 只能引用实际执行的 ID；最终 Review 必须以 PR base 到 head 的完整范围重新裁决。
3. 生成的必需 Quality Gate 在每个 PR 始终触发。一个 Linux 计划任务先用 Git pathspec 计算检查集合；
   平台任务和检查步骤按计划条件运行。聚合总闸只接受计划明确为不适用的 skipped，适用任务的 skipped、
   失败、取消和超时都失败关闭。
4. Quality Gate 每周和人工触发时无条件运行全部检查与全部平台，PR 才使用范围选择；无法固定比较提交
   时回退 full。受管 Ruleset 必须 active、无绕过者、强制 PR、绑定 GitHub Actions 必需检查并要求最新
   默认分支；PR workflow 以 GitHub 生成的当前合并结果检出执行，base/head 变化会使旧结果失效。因此
   已通过 PR 合并后不再触发第二次项目检查，也不声称 main commit 取得了新的检查凭证。候选与发布流程
   运行自身门禁，不依赖 main Quality Gate。
5. `paths` 是已知改动的最小检查映射，不是安全白名单。一个改动没有命中任何路径规则时不会零检查
   通过，而会全量运行。
6. CodeQL 是否可按路径跳过由当前 Ruleset 实证裁决。PR #270 证明代码扫描保护要求当前 PR 有 CodeQL
   结果：纯文档 head 没有分析时仍被阻止合并，因此 pull_request 保持每次运行且不接受路径过滤。
   PR 已分析、合并只改变 Markdown 或 `docs/**` 时，main push 的代码树未变，可以跳过第二次扫描；
   混合 push 仍完整运行。weekly schedule 与人工 workflow_dispatch 无路径过滤，继续发现扫描器、查询和
   环境漂移。不上传自定义空 SARIF，也不削弱 Ruleset 的 CodeQL 工具或阈值。

## 后果

- 普通文档 PR 只承担仓库健康等明确相关检查，不再启动完整测试、构建、依赖审计和多平台矩阵。
- 代码、质量契约、构建配置、运行资产和未知文件继续触发相应检查或保守全量。
- 合并不再重复运行项目 Quality Gate；纯文档 main push 也不重复 CodeQL。代码/混合 main push、每周
  schedule 与人工 dispatch 仍维护默认分支完整扫描。
- 每周 full 失败表示环境或依赖漂移，需要独立修复；它不 retroactively 伪造已有 PR 的结果。
- 路径映射漏项首先表现为未知路径全量，代价是变慢而不是假绿；确认映射后才能进一步收窄。
