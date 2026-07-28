---
title: "主循环与测试结构治理"
status: done
updated: 2026-07-28
scope: root
---

# 主循环与测试结构治理

## Context

双层质量门禁 Bootstrap 已完成，`coding-engine`、Go 多模块和 Python Monorepo 都已通过真实
PR 闭环。实施计划 Phase 6 Task 17 约定在门禁闭环之后，单独治理 `src/engine/loop.ts` 与
超大测试文件，不把结构重构混进裁判功能。

当前 `loop.ts` 同时承担启动预检、指令渲染、逐轮状态机、最终 Review、报告与资源清理；其中
`runLoop` 单个函数超过一千行。`loop.test.ts` 的 95 个用例又把启动、验收协议、机械门禁、
模型路由、篡改恢复、异常轮和生命周期混在同一文件。问题的本质不是行数本身，而是修改某一
职责时需要在过大的上下文里确认没有破坏其他退出路径。

本次只做可机械验证的职责重组。逐轮状态机中的提前退出、每轮证据、状态所有权与完成判定
高度耦合，继续保留在同一编排位置；不为了缩短文件而把它拆成大量回调或单实现接口。

## Goals

- 把启动前的质量契约、版本、PRD、TDD、模型与恢复检查收口为独立预检模块。
- 把指令读取与占位符渲染收口为独立模块，同时保持现有导出入口兼容。
- 让 `runLoop` 聚焦资源生命周期、逐轮状态机、最终 Review 与收口。
- 按行为领域拆分 95 个主循环测试，并把共用 fixture 保持为一个真相源。
- 保持所有运行行为、退出码、日志、证据、状态文件和公开入口不变。

## Non-Goals

- 不改变 Developer、Validator、机械门禁、TDD、三层 Review 或 GitHub 门禁语义。
- 不改变 `LoopConfig`、`runLoop`、`renderInstruction` 的现有调用方式。
- 不新增配置、命令、依赖、版本号、发布流程或持久化格式。
- 不重写逐轮状态机，不顺手修复功能问题，不处理 PR #65 或现有 Dependabot PR。
- 不把“一定低于某个行数”当作质量目标；职责与依赖边界优先于文件大小。

## Structural Decision

1. 新增 `loop-instructions.ts`，只负责读取并渲染 Builder/Validator 指令；`loop.ts` 继续转出
   `renderInstruction`，现有调用方无需迁移。
2. 新增 `loop-preflight.ts`，只负责启动到仪表盘启动之前的检查与恢复，并返回经过收窄的就绪
   上下文或明确退出码。
3. `loop.ts` 继续拥有锁、仪表盘、逐轮控制流、最终 Review、报告和资源释放。逐轮状态机暂不
   拆分，因为其中的提前退出与证据写入必须保持在同一可读控制流中。
4. `loop.test.ts` 按预检、生命周期、门禁、验收、路由、安全恢复、指令合同拆为独立测试文件；
   共享临时目录、契约、假 agent 与固定 Review 结果移入测试支持文件，支持文件不得包含断言。

## Functional Requirements

1. 正式运行的预检顺序、失败退出码、错误文案以及“任何 agent 启动前拒绝无效配置”的语义
   必须保持不变。
2. `renderInstruction` 仍可从 `src/engine/loop.ts` 导入，四类占位符渲染结果保持不变。
3. 逐轮状态机的所有提前退出、每轮一条 evidence、篡改恢复、Validator 凭证和最终 Review
   行为不得改变。
4. 拆分前 `loop.test.ts` 中的 95 个 `it` 用例必须全部保留；测试标题和断言不得静默删除。
5. 测试文件必须按单一行为领域命名；共享支持文件只提供 fixture/helper，不注册新的测试。
6. 架构地图应明确主循环、启动预检与指令模块的职责边界，并说明逐轮状态机为何暂不继续拆分。

## Golden Principles

| 原则 | 适用性与设计裁决 | 验证证据 |
|---|---|---|
| 1. 可证伪完成合同 | 适用。以公开入口兼容、95 个主循环用例完整保留、全量检查通过和文件职责边界作为完成条件。 | 导出兼容测试、用例标题集合对比、全量测试与构建结果。 |
| 2. 生成方不得自签 | 适用。实现者只提交候选重构；固定 0.33.1 的 Validator、三层 Review 和 GitHub 机械检查分别复核。 | Validator receipt、三层 Review 结果、PR `quality-gate`。 |
| 3. 自治与可逆性对称 | 适用但不扩大自治。本次只移动内部职责，不增加写入、合并、发布或删除权限；每个故事独立提交，可按提交回退。 | Git diff、提交边界、PR 等待人工合并。 |
| 4. 复用原生执行面 | 适用。继续复用现有 TypeScript 模块、Vitest 与 coding-x 0.33.1，不引入框架或新的运行抽象。 | 依赖清单不变、构建产物冒烟、正式 doctor。 |
| 5. 失败与恢复优先 | 适用。既有异常、篡改、超时、无结果、锁冲突与假绿回归必须原样保留；本任务不新增行为，因此不启用 TDD，而用完整既有失败路径回归保护结构移动。若重构暴露真实缺陷，先新增失败用例并另行裁决，不混入本 PR。 | 95 个主循环用例完整保留；825 项基线测试全部通过。 |

## User Stories

### US-001: 分离启动预检与指令职责

作为维护者，我希望主循环只保留运行生命周期和逐轮编排，把启动检查与指令处理放到明确模块，
从而能在不通读整个状态机的情况下修改预检规则。

#### Acceptance Criteria

- [ ] `loop-instructions.ts` 单独负责指令读取、TDD 片段和占位符渲染，`loop.ts` 仍兼容导出 `renderInstruction`。
- [ ] `loop-preflight.ts` 单独负责质量契约、固定版本、PRD/State 恢复、TDD、模型目录与冻结检查快照的启动阶段。
- [ ] `loop.ts` 仍直接拥有锁、仪表盘、逐轮状态机、最终 Review、报告和资源释放，不引入单实现接口或回调层级。
- [ ] 预检失败发生在 agent 与仪表盘启动之前，既有退出码和可观察文案保持不变。
- [ ] `docs/architecture.md` 记录三个模块的职责边界以及逐轮状态机保留在 `loop.ts` 的原因。
- [ ] 没有新增运行依赖、配置、持久化字段或公开调用方式。
- [ ] Typecheck passes
- [ ] Tests pass
- [ ] Build and built CLI smoke pass

### US-002: 按行为领域拆分主循环测试

作为维护者，我希望主循环测试按独立行为领域组织，同时共用稳定 fixture，从而能快速定位失败且
不会在拆分过程中丢失既有回归保护。

#### Acceptance Criteria

- [ ] 原 `loop.test.ts` 的 95 个 `it` 用例全部迁移，测试标题集合与拆分前一致，不删除或弱化断言。
- [ ] 测试至少分为预检、生命周期、门禁、验收协议、模型路由、安全恢复和指令合同七个行为领域。
- [ ] 共用契约、临时 workspace、假 agent 与固定 Review 结果只有一个测试支持来源；支持文件不包含 `describe`、`it` 或断言。
- [ ] 原 `loop.test.ts` 被移除，不留下重复执行的测试。
- [ ] 全仓测试总数不少于拆分前的 825 项，所有测试通过。
- [ ] Typecheck passes
- [ ] Lint and format checks pass
- [ ] Repository health check passes

## Verification

- `npm run typecheck`
- `npm test -- --run`
- `npm run build`
- `node dist/cli.js --help`
- `npm run format:check`
- `npm run lint`
- `npm run repository-health`
- `npm audit --audit-level=high`
- 使用正式发布的 coding-x 0.33.1 完成两个 Story 的 Validator 与最终三层 Review。
- 推送独立 PR，等待 GitHub 四平台检查、总闸和 CodeQL 全部通过后再请求人工合并。

## Rollback

两个 Story 分开提交。若预检提取影响行为，回退 US-001；若测试拆分丢失或重复用例，回退
US-002。不得通过放宽断言、删除失败路径或修改质量契约来让重构通过。
