---
title: 006-model-routing
status: superseded
updated: 2026-07-21
scope: root
---

# 006. 模型路由：透传不映射、validator 恒定、升级复用 retryCount

> 2026-07-21 起由 ADR-011 取代。本文保留首次模型路由的历史取舍，不再作为当前实现目标。

> 2026-07-20 曾由 ADR-010 扩展 `profiles` 具名档案；该扩展同样已被 ADR-011 取代。

## 背景

引擎至今无模型概念（拉起 agent 不传 `--model`），所有任务吃用户 CLI 同一默认模型：简单 story 烧强模型额度，把关环节又无法单独升级。需求是按阶段、按 story、按重试三维路由。配置载体沿用 ADR-005 先例：运行策略放 prd.json 顶层、prd-to-json 派生时与用户确认。

## 决策

prd.json 顶层可选 `models`（builder/validator/escalation/escalateAfter）+ story 级可选 `model`；引擎每轮按优先级链解析（CLI 参数 > escalation（retryCount ≥ escalateAfter，缺省 1）> story.model > 顶层 builder > 不传）并给 agent CLI 追加 `--model`。三个关键取舍：**模型名不透明透传**（不校验、不别名映射）；**validator 恒定**（只吃顶层/CLI 配置，不做 story 级覆盖与升级）；**升级判据复用 state.json 的 retryCount**（零新增状态）。

## 理由与备选

- **为什么透传不映射**：tier 抽象（complexity → 内置模型名映射表）可跨 agent kind 移植，但一次 run 只有一个 kind，可移植性服务的场景不存在；映射表必然随模型代际过时，引擎发版远慢于模型发布。名字写错由 agent CLI 立即报错，比引擎维护名单诚实。
- **为什么 validator 不做 story 级覆盖**：validator 是把关方，「共谋假绿」有实证（见 ADR-005 背景）；把关水位恒定，builder 按任务难度弹性，能力差防线不因单个 story 的配置被拉低。
- **为什么升级复用 retryCount**：validator 打回与门禁打回已共同维护它，「被打回过=当前模型搞不定或需要更强判断」语义现成；引入独立升级计数是重复状态。
- **被否备选——独立配置文件**（coding-x.config.json）：运行策略与需求分离更干净，但引擎零配置文件哲学、且 qualityChecks 已确立 prd.json 顶层先例，一事二载体反而增加脱节面。
- **被否备选——插件侧（commands frontmatter model 字段）**：交互会话用户本可 /model 随时切换；skills/commands 是跨工具唯一源，Claude 专属字段对 Codex/Cursor 兼容性未验证。无人值守引擎才是路由不可替代的场景。

## 后果

- prd-to-json 派生环节新增用户确认面（模型分层与名字）；生成默认遵循 validator ≥ builder。
- 模型名写错在循环内表现为 builder 每轮快速失败，消耗迭代数直到人从日志发现（agent stderr 直出）；「连续 N 轮非零退出提前终止」是独立的循环健壮性议题，未随本决策实现。
- escalateAfter ≥ MAX_RETRIES(5) 时升级永不生效（story 先 blocked），引擎启动警告一次。
- doctor 暂不加 models 检查（运行时已警告）；出现「配置了但没生效」的静默脱节实证再补建议项。
