---
title: "引擎验收凭证实施计划"
status: done
updated: 2026-07-22
scope: root
---

# 引擎验收凭证实施计划（v0.25.0）

**Goal:** 让 story 只有在 validator 被引擎机械观察为正常完成后才进入通过态，消除 builder 单方面置绿与 validator 未完成仍收敛的结构性缺口。

**Spec:** `docs/specs/2026-07-22-engine-validation-receipt.md`

**ADR:** `docs/decisions/013-engine-validation-receipt.md`

## 全局约束

- 只新增最小 `validated` 凭证，不引入 agent-result IPC 或签名。
- 所有关键 state 覆盖写走 `writeFileAtomicSync`。
- src 相对导入保留 `.js`；旧 state/evidence 继续可读。
- 每个任务先补或更新回归，再改实现；收口跑 typecheck、全量测试与 build。

## Task 1：状态 schema、迁移与纯函数

- 修改 `src/engine/state.ts` / `state.test.ts`。
- `StoryState`、初始值、legacy/blank/merge 增加 `validated`。
- 缺字段按 `passes` 归一但不立即写盘。
- 新增 `isStoryPassed`、`restoreValidated`、`issueValidationReceipt`、`rollbackUnvalidatedPasses` 等单一职责纯函数。
- `getCurrentStoryId` 与 `allStoriesResolved` 只认 `passes && validated` 或 blocked。

## Task 2：loop 签发、恢复与所有出口收口

- builder/validator 后恢复 agent 对 validated 的改写。
- validator completed + 前后 passes=true + 非 blocked 时签发凭证。
- validator error/timeout 复用异常回写；missing/skip 与启动崩溃残态新增未验收回写。
- iteration evidence 写凭证与篡改字段。
- 保持 gate、no-op、sticky escalation、锁与 PRD guard 行为不变。

## Task 3：消费面与指令合同

- builder/validator 指令把 `validated` 列为引擎独占、必须原样保留。
- status 人类/JSON、dashboard 两套页面、report banner/story/timeline/red flag 使用有效通过态。
- evidence 守卫接受新可选字段，旧记录中性呈现。

## Task 4：假绿与兼容回归

- builder-only true + validator 缺失/skip/error/timeout 全部不绿。
- validator pass 签发、validator reject 不签发、凭证篡改恢复。
- 显式待验收残态启动回写；旧缺字段 passed workspace 保持完成。
- status/report/dashboard/evidence 的机器与人类输出覆盖。

## Task 5：文档、版本与验证

- README、architecture、glossary、patterns 同步所有权与迁移语义。
- package/lock/三插件清单同步 0.25.0。
- `npm run typecheck && npm test && npm run build`。
- 构建后用临时 workspace 做 builder→validator 最小 smoke，确认 state 落 `validated:true`、status/report 为绿；不重复付费跑完整 provider 矩阵。
- `/review-loop` 与 `/compound-docs`、合并/发布动作留给明确授权的收口阶段。

## 执行结果（v0.25.0，发布后核对）

- 状态机、loop、evidence、status、report、Dashboard、模型预检与 agent 指令已统一采用验收凭证语义。
- README、architecture、glossary、patterns、prd-to-json 与 compound-docs 已同步；package/lock/三插件清单为 0.25.0。
- `npm run typecheck`、`npm test`（24 files / 492 tests）与 `npm run build` 通过；构建产物 CLI 入口已做只读 status 冒烟。
- 实际提交 `70e239d` 直接进入 `main`，随后创建 `v0.25.0` tag，并完成 GitHub Release 与 npm `coding-x@0.25.0` 发布；GitHub Test/Publish workflows 均成功。该提交没有关联 PR。
- 发布前没有生成 v0.25 review package，也没有登记本计划要求的临时 builder→validator 构建产物 smoke；不能用发布后的补记反推这些步骤当时已经完成。
- 2026-07-22 发布后补审记录于 `.workspace/review-2026-07-22-2.md`，复现一项高优先级假绿：agent 可伪造非当前 story 的 `validated=true`，而 v0.25.0 只恢复 current story 的引擎独占字段。

## v0.25.1 热修状态

- 热修分支：`codex/v0.25.1-validation-receipt-hotfix`；目标版本为 0.25.1。
- 修复范围：按 agent 阶段保护全部 PRD story 的 `validated`/`escalated`，补跨 story、validator skip/timeout、gate/abort 与两套 Dashboard 四态回归。
- `.coding-x-local/` 已从仓库级 `.gitignore` 移除，当前 clone 改用 `.git/info/exclude`；本地 fixture 未删除。
- `npm run typecheck` 通过；`npm test -- --silent` 为 24 files / 502 tests 全通过；`npm run build` 通过，`dist/cli.js` 为 135.54 KB；`coding-x doctor` exit 0；`npm pack --dry-run` 确认 0.25.1 发布包仍为既定 8 个文件。
- 构建产物已在隔离临时 workspace 走完不调用真实模型的 fake-agent smoke：builder 与 validator 各调用一次，run/status/report 均 exit 0，最终 state 为 `passes=true, validated=true`，iteration evidence 含 `validationReceipt:true`，报告显示 `✅ 全部通过 1/1`。
- 两路独立复审最终无阻断；复审期间发现并修复了跨 story 伪造后未签发 `passes` 跨轮残留的空转问题，以及对应测试可假阳性的缺口。核心热修提交为 `5f1bc2b`，交付入口为 GitHub PR #3；合并、`v0.25.1` tag、GitHub Release 与 npm registry 的最终状态以对应外部台账为准。上述 smoke 是确定性构建产物链路验证，不声称覆盖真实 provider 网络与 CLI 健康。
