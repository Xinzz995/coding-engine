---
title: 004-reject-standalone-grilling-skill
status: rejected
updated: 2026-07-05
scope: root
---

# 004. 不引入独立的 grilling skill，逐题节奏以模式分支吸收进场景对齐

## 背景

调研 mattpocock/skills 后评估是否引入其最流行的 grilling skill（8 行正文的访谈原语：沿决策树逐分支拷问、一次一问、每问附推荐、能查证的不问、确认门、不设问题上限）。

## 决策

不引入独立 skill。其核心纪律（查证优先、附推荐、上游优先、确认落盘）已内置于 scenario-alignment / technical-alignment 且领域化更深；唯一的真差异——逐题交互节奏——以「逐题深挖模式」分支吸收进 scenario-alignment：逐题问、随答案调整路径，停止条件为价值阈值（剩余问题不再改变产品方向或验收口径即出稿），不设数量上限也不为凑数续问。

## 理由与备选

- 抽独立原语的前提是多消费方组合复用（mattpocock 有 grill-me / grill-with-docs / wayfinder / loop-me 四个消费方）；本仓库只有两个 alignment 消费访谈纪律，抽取只增加跳转成本。
- 独立 skill 会成为 `align:` / `tech:` 之外的第三入口，边界模糊、增加路由认知税；与流水线（PRD → 循环 → 收口）无关的通用拷问 skill 偏离项目定位，生态已有充足供给（mattpocock/skills、superpowers 等）。
- 被否备选「照搬无上限逐题」：即使不计人的时间成本也非最优——低价值分支的随口答案会成为束缚实现的伪约束；免费的是时间不是注意力（决策疲劳实证：mattpocock 收到的 #44「问了 200 个问题」）；无上限在边际上腐蚀「能查证的不问」纪律；且本流水线有五道后置纠错（对齐稿可改 / PRD 可改 / 转换对照表 / 需求冲突上报 / review-loop 人审），前置对齐只需问到「方向不再会错」。人自己不知道的信息拷问不出来——该走「出稿对着改」而非「凭空答题」。

## 后果

- scenario-alignment 新增「逐题深挖模式」分支（显式触发，或待问问题间存在依赖时触发），工作流程第 5 步同步标注两种节奏。
- technical-alignment 暂不对称复制（其输入通常已有业务口径打底，模糊度低一档），待 dogfood 出现需求再加。
- 若访谈原语未来出现第三个消费方（组合复用需求成立），本决策值得重开。
