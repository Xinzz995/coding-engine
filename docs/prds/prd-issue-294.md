---
title: "Issue #294: 纯文档合并不重复 CodeQL"
status: done
updated: 2026-08-20
scope: root
---

# Issue #294: 纯文档合并不重复 CodeQL

> GitHub Issue: https://github.com/Xinzz995/coding-engine/issues/294

## Goals

消除纯文档 PR 已在当前 head 完成必需 CodeQL 后，合并到 main 又对完全相同代码树重复扫描一次的等待；定时和人工完整扫描继续发现工具、查询与环境漂移。

真实基线来自 PR #293：Quality Gate 只运行 repository-health，17 秒完成；PR CodeQL 仍用 1 分 49 秒，合并后 main CodeQL 又用 2 分 41 秒。PR #270 已实证当前 Ruleset `19747271` 要求当前 PR 有 CodeQL analysis：对 pull_request 使用 `paths-ignore` 会让分析缺失并把 PR 保持 BLOCKED，因此 PR 侧扫描不能在不改变信任边界的情况下删除。

本轮只给 CodeQL 的 `push: main` 增加严格文档忽略范围：当该 main push 的全部变化都是 Markdown 或 `docs/**` 时不启动第二次分析。`pull_request: main` 保持每次运行，继续满足 code scanning Ruleset。schedule 无路径过滤，并新增 `workflow_dispatch` 作为人工完整扫描入口。

## Non-Goals

- 不删除或弱化 Ruleset 的 CodeQL 必需工具和告警阈值。
- 不给 pull_request 增加 paths-ignore；不重演 #270 的已知阻塞。
- 不上传伪造的空 SARIF，不把路径分类器包装成 CodeQL 分析。
- 不把 workflow、质量规则、依赖、构建配置或未知路径归类为普通文档。
- 不改变 Quality Gate 已有的按范围检查逻辑。

## Risk

主要风险是忽略范围过宽，使含可执行变化的 main push 跳过扫描。过滤仅允许 `**/*.md` 和 `docs/**`；混合提交只要包含任一其他路径，GitHub 事件过滤就运行完整 CodeQL。PR 在合并前已经对当前代码树取得 CodeQL 结果，main 只跳过代码树未变化的文档合并；每周和人工触发不受 paths-ignore 影响。

## 黄金原则逐项对照

1. **可证伪完成合同**：治理测试锁定 PR 无过滤、main 只忽略两类文档、schedule/manual 无过滤；真实归档 PR 对账 PR 扫描存在、main 重复扫描不存在。
2. **生成方不得自签**：PR 仍由 GitHub CodeQL 和现有 Ruleset 裁决；不生成自定义绿色 SARIF 或自定义替代检查。
3. **自治与可逆性对称**：不增加权限或自动合并；删除 push paths-ignore 即恢复旧行为，人工完整扫描可随时执行。
4. **原生执行优先**：使用 GitHub Actions 原生路径过滤与 workflow_dispatch，不自建扫描器或跨运行缓存。
5. **以假绿率和恢复衡量**：把 #270 的阻塞和 #293 的重复扫描固化为治理断言与真实归档 dogfood；目标减少一次 main 扫描且 PR 仍可无绕过合并。

## User Stories

### US-001: 安全跳过纯文档 main push 的重复 CodeQL

#### Acceptance Criteria

- [x] `pull_request` 继续对 main 的每个 PR 运行 CodeQL，且没有 `paths`/`paths-ignore`。
- [x] `push: main` 仅在全部变化匹配 `**/*.md` 或 `docs/**` 时跳过；任一混合、workflow、质量规则、依赖、构建、源码或未知路径仍运行。
- [x] weekly schedule 和 `workflow_dispatch` 无路径过滤，始终执行完整 CodeQL。
- [x] repository-health 测试精确锁定上述触发器，拒绝把 pull_request 或更宽路径加入忽略范围。
- [x] Ruleset `19747271` 的 CodeQL 工具与阈值保持不变，无 bypass actor，不改为自定义 SARIF 或普通状态检查。
- [x] 用获批的 #288 PRD 物理归档 PR 实测：PR CodeQL 存在并通过、Quality Gate 只跑必要文档检查、PR 可正常合并；合并后的 main commit 不产生 CodeQL run。
- [x] 记录相对 #293 的 PR 等待和合并后收口时间变化，关闭 #294 前核对 main 与本地干净同步。

## Delivery Boundary

- 只在 `codex/issue-294` 和对应 PR 交付；不自动发布。
- `.github/workflows/codeql.yml` 是受保护政策路径，必须使用独立、限时政策例外和 owner PR 标签。
