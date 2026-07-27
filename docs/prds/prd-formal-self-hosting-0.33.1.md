---
title: "coding-x 0.33.1 首次正式自托管收口"
status: done
updated: 2026-07-28
scope: root
---

# coding-x 0.33.1 首次正式自托管收口

## Context

coding-x 0.33.1 已从提交 `a57e8d3cf666c5293d28c2a3f5921be43044c1a7` 构建、完成三个
项目的候选验证、发布到 npm，并创建不可变标签与 GitHub Release。随后，PR #76 已把
`.coding-x/quality.json` 的正式裁判固定为 0.33.1 并合并到 `main`。

当前质量门禁规格、ADR 和实施计划仍有若干“首次版本为 0.33.0”“后续仍待执行”的历史表述。
它们需要按远端现状收口，同时必须区分已经发生的事实与尚未发生的动作：两个外部 Dogfood
PR 的机械检查已经通过但 PR 仍开放；本 PR 正是 coding-engine 的首次正式自托管验证，尚未
完成前不能写成已完成。

## Goals

- 把 ADR、设计规格和实施计划中的首次稳定裁判版本统一为实际发布并固定的 0.33.1。
- 记录候选制品、三项目验证、npm、标签、Release 和 Policy PR 的真实结果与边界。
- 让当前状态明确区分“已验证”“已发布”“已合并”和“仍开放/仍待完成”。
- 用正式发布的 coding-x 0.33.1 对本 PR 执行 Developer、Validator 和三层 Review，形成首次
  正式自托管实例。

## Non-Goals

- 不修改 `src/`、`build/`、`hooks/`、工作流、质量契约、依赖、版本号或发布制品。
- 不合并或关闭 coding-engine PR #65，也不合并两个外部 Dogfood PR。
- 不关闭 Bootstrap Issue #44；只有本 PR 合并且全部退出条件重新核验后才能另行关闭。
- 不把本地 Review 写成 GitHub 证明，也不在 GitHub 中调用模型。
- 不治理 `loop.ts` 或超大测试文件；结构治理继续使用独立 PR。

## Functional Requirements

1. ADR-018 和设计规格中关于首次 Bootstrap、稳定裁判与正式自托管起点的版本号必须与实际
   0.33.1 发布一致，并保留 0.33.0 未成为正式裁判的原因。
2. 实施计划的 Task 16 和“当前状态”必须反映已完成的候选构建、三项目验证、staged 发布、
   npm 稳定发布、不可变 Release 以及 PR #76 固定裁判；不得把本 PR 提前记为完成。
3. 文档必须明确：Go/Python Dogfood PR #3 的原生检查已通过但仍开放；“验证完成”不能被改写
   成“已经合并”。
4. 所有新增事实必须给出可定位的版本、提交、PR、工作流或制品摘要，避免使用“已经全部完成”
   这类无法核对的概括。

## Golden Principles

| 原则 | 适用性与设计裁决 | 验证证据 |
|---|---|---|
| 1. 可证伪完成合同 | 适用。每项文档事实绑定版本、提交、PR、工作流或摘要；首次正式自托管只在最新 head 的 Validator、三层 Review 和 GitHub 总闸完成后成立。 | 本 PR diff、0.33.1 运行状态、Review binding、GitHub checks。 |
| 2. 生成方不得自签 | 适用。Developer 只提交候选改动；Validator 独立核对 AC；三层 Reviewer 分轴判断；GitHub 仅证明机械门禁。 | Validator receipt、三份独立 Review 结果、`quality-gate`。 |
| 3. 自治与可逆性对称 | 适用。本任务只修改文档；coding-x 可以提交和推送故事改动，但不合并 PR、不关闭 Issue、不处理外部 PR。 | Git diff 路径检查；最终停在开放 PR 等待人工决定。 |
| 4. 复用原生执行面 | 适用。正式运行使用公开 npm 0.33.1；GitHub 继续执行仓库原生检查，不新增远端模型任务。 | 运行版本记录、工作流检查列表、PR checks。 |
| 5. 失败与恢复优先 | 适用。若事实不一致、Review 无法验证或远端检查未就绪则失败关闭；文档提交可通过普通 PR 回退。 | 非零退出状态、finding/Review 状态、GitHub 总闸结论。 |

## User Stories

### US-001: 收口首次稳定发布与自托管前置事实

作为维护者，我希望正式文档准确反映 0.33.1 已完成的发布和验证事实，以及仍未完成的合并与
自托管步骤，从而让后续维护者不会依据过时状态做出错误判断。

#### Acceptance Criteria

- [ ] ADR-018 将首次稳定 Bootstrap 和固定裁判版本写为 0.33.1，并说明 0.33.0 没有成为正式裁判。
- [ ] 双层质量门禁设计规格将首次稳定裁判、Policy PR 和正式自托管起点写为实际的 0.33.1。
- [ ] 实施计划 Task 16 不再要求固定 0.33.0，改为记录 PR #76 已固定 0.33.1，并把本 PR 保持为尚待完成的正式自托管步骤。
- [ ] 实施计划当前状态记录候选提交 `a57e8d3cf666c5293d28c2a3f5921be43044c1a7`、候选构建运行 `30286427973`、制品 SHA-256 `b27cab53e7d18ba6b1cd8ccf9421b99804524b531624dbddbb496ea29d9e9a73`、npm staging 运行 `30288714477`、stage ID `9e343f65-8588-40f1-8473-a047bf5c6e1d`、发布运行 `30290999148` 和 PR #76。
- [ ] 文档明确 Go/Python Dogfood PR #3 的原生检查已通过但 PR 仍开放，不把“验证完成”写成“已经合并”。
- [ ] 文档明确 npm `latest`/`next`、`v0.33.1` 和不可变 GitHub Release 已完成，同时 Bootstrap Issue #44 仍须等待本 PR 合并后的最终复核。
- [ ] 除本 PRD、ADR-018、双层质量门禁设计规格和实施计划外，不修改其他受 Git 管理的文件。
- [ ] Typecheck passes
- [ ] Repository health check passes

## Rollback

若文档事实或证据标识有误，回退本 PR 的文档提交并按远端记录重新核对；不得通过修改质量
契约、工作流、标签、npm 状态或外部 PR 来迎合文档。
