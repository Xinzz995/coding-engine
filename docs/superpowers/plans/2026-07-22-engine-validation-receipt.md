---
title: "引擎验收凭证实施计划"
status: done
updated: 2026-07-22
scope: root
---

# 引擎验收凭证实施计划（v0.25.0）

**Goal:** 让 story 只有在 validator 被引擎机械观察为正常完成后才进入通过态，消除 builder 单方面置绿与 validator 未完成仍收敛的结构性缺口。

**Spec:** `docs/superpowers/specs/2026-07-22-engine-validation-receipt.md`

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

## 执行结果

- 状态机、loop、evidence、status、report、Dashboard、模型预检与 agent 指令已统一采用验收凭证语义。
- README、architecture、glossary、patterns、prd-to-json 与 compound-docs 已同步；package/lock/三插件清单为 0.25.0。
- `npm run typecheck`、`npm test`（24 files / 492 tests）与 `npm run build` 通过；构建产物 CLI 入口已做只读 status 冒烟。
- 未创建提交、tag、发布或推送；人审与发布仍等待明确授权。
