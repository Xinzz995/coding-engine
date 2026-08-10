---
title: 025-tiered-validator-runner-trust
status: active
implementation: planned
updated: 2026-08-10
scope: root
---

# 025. 签发凭证的角色要求可证明宿主隔离（分层 Runner 承诺）

## 背景

Issue #174 的真实 Dogfood 证实 Validator 会加载宿主 memory、用户配置与插件；这些输入不属于验收
合同，破坏可重复性与权限边界。#187 已收口输出背压与不可验证退出语义，宿主隔离仍是开放缺口。

针对隔离的草稿实现（分支 `codex/validator-host-isolation-draft`，提交 `b50b1a4`）完成了三个
Runner 的原生参数审计：Codex（0.147.0-alpha.6.5）可用 `--ephemeral`、忽略用户配置/规则、严格
sandbox 与 shell 环境政策组合出可机械证明的边界；Claude（2.1.220）没有能把 Bash 约束在干净检出
内的宿主沙箱，`--bare` 还会放弃 OAuth/keychain；Cursor（2026.07.20）能运行命令的 print 模式无法
关闭宿主规则、MCP、插件与会话，也没有结构化 schema 约束。同时，Codex CLI 的快速迭代是发布链的
头号外部干扰源：0.35.0 RC1 因 Final Review 事件兼容缺口作废，#194、#203 均为兼容性追赶修复。
「让谁签发凭证、以什么证明」必须显式裁决，而不是从草稿代码被动继承。

## 决策

1. 分层承诺：签发验收凭证的执行角色（Validator、Final Reviewer）必须满足可机械证明的宿主隔离
   ——固定 Runner profile 加上每次调用的真实 canary 反测；无法证明的 Runner 对这两个角色按
   ADR-023 判为 unverifiable，不静默降级回宽权限模式。
2. 当前事实上只有 Codex 满足上述边界；Claude 与 Cursor 保持「开发可用、认证不可用」：
   Developer/Builder 角色继续三 Runner 支持，模型路由（ADR-010/011/012）不变。
3. 这是能力升级路径而非删除：适配层保持 runner-neutral；当 Claude/Cursor 的原生参数足以机械
   证明边界并通过真实 canary 后，可直接升级为可认证 Runner，无需重开本决策。
4. 认证 Runner 的版本固定为已审计的精确版本。升级协议 = 参数重审计 + canary 重跑 + 更新固定
   版本；未完成前新版本按 unsupported-version 判为 unverifiable，不得临时放宽。
5. 文档诚实边界：README 与用户文档必须区分「可用于开发（三 Runner）」与「可签发凭证（当前仅
   Codex）」，不声明未经证明的认证能力。

## 当前事实

- 引擎尚未实施 Runner profile 与 canary：三个 Runner 目前都可运行 Validator，宿主隔离仅靠
  ADR-022 干净检出与部分启动参数，未达到本决策要求的可证明边界。
- 草稿实现只存在于 `codex/validator-host-isolation-draft`，未经质量门禁，不构成可合并交付。
- 实施属于 issue #174 的剩余范围，动工前须按黄金原则在实现计划中逐条对照。

## 理由与备选

- 备选「先补齐 Claude/Cursor 隔离适配，三者对等后再落地」被否：两者当前 CLI 缺少可机械证明的
  原生边界，补齐时间不可控，等待期间 #174 的安全缺口与不可证明的凭证会一直存在。
- 备选「保持三 Runner，只靠指令约束不做机械隔离」被否：指令不可机械验证，宿主 memory/MCP 注入
  仍会破坏可重复性，违反「生成方不得给自己签发通过」。
- 备选「全角色 Codex-only（含 Builder）」被否：Builder 不签发凭证，其产出全部经 Validator 与
  门禁复核，无需同等隔离；砍掉多 Runner 开发能力只损失灵活性，没有安全收益。

## 后果

- 认证链形成单供应商依赖：Codex CLI 行为变化会直接阻断验证链。版本固定与升级协议把「意外破坏」
  转化为「显式升级动作」，代价是每次 Codex 升级需要一轮重审计与 canary 重跑。
- Claude/Cursor 用户的 Validator 从「可用」变为「明确 unverifiable」。这是诚实化而非功能回退，
  属于面向用户的行为变化：随下一 minor 版本发布，并在 README 支持矩阵与迁移说明中写明。
- 需要跟进：恢复 #174 剩余实施（自草稿分支）；更新 README 支持矩阵；把 Runner 升级协议沉淀进
  发布手册或 patterns。
