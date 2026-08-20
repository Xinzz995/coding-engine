---
title: "Issue #292: 相同输入可信 PR 的批量受管刷新"
status: done
updated: 2026-08-20
scope: root
---

# Issue #292: 相同输入可信 PR 的批量受管刷新

> GitHub Issue: https://github.com/Xinzz995/coding-engine/issues/292

## Goals

把 Issue #289 已实现的“相同输入只刷新远端”从分钟级固定开销压缩到单次确认 60 秒以内，同时保持最终可信标记前的第二次独立确认和全部原有绑定输入。

真实基线：远端未就绪时命令总耗时 237.07 秒、状态刷新 208718 ms；远端已就绪时两次确认合计 421929 ms、命令总耗时 449.06 秒。现场在约 3 分 25 秒时已产生 102 个 settled operation。源码取证表明，完整 Review preflight 会按变更文件分别读取 base/head、存在性和 submodule，managed status 又重复 Story、Runner 与 PR 当前性观察，而每条 git/gh/runner 命令都单独建立 supervisor operation。

新增一个包内固定、只读、输出有界的 preflight snapshot helper：它在一个受管 operation 内启动受限的真实 git/gh 子命令，批量返回构建 ReviewPreflightContext 所需的完整原始事实。父进程继续使用现有质量契约、PR、二进制/LFS/submodule、来源文档、风险与 binding 逻辑独立解析和裁决；helper 不返回“通过”结论。典型输入使用快照；快照执行、解析或输出预算不可用且 session 仍安全时回退现有逐命令受管 preflight，已返回事实与契约/路径对账不一致时直接失败关闭，不降低旧路径能力。

## Non-Goals

- 不建立跨提交、跨环境、跨进程或通用持久缓存。
- 不删除第二次可信标记前确认，不复用第一次远端结论。
- 不减少 Spec、工程规范、变更文件、风险、Story、Runner、PR、Ruleset 或必需检查绑定。
- 不把 helper 自述升级为引擎结论。
- 不加入轮询、队列、自动合并或更多 Agent 编排。

## Risk

主要风险是批量 helper 与现有 preflight 产生语义分叉。helper 只收集原始字节和命令结果；父进程必须重新计算路径集合、解析契约与 PR、核对完整文件集合并调用现有风险/currentness 逻辑。缺字段、额外字段、截断或执行失败使快照不可用并回退旧路径；重复/错误路径、事实矛盾或前后状态变化直接失败关闭。

## 黄金原则逐项对照

1. **可证伪完成合同**：测试分别断言典型输入只用一个 preflight operation、完整 context 等价、篡改/漂移拒绝、超界回退、旧 Review 兼容和真实三轮耗时。
2. **生成方不得自签**：固定 helper 只提供原始观察；现有 parser、风险计算、Review binding、Story 凭证和远端 Ruleset 仍由父引擎裁决。
3. **自治与可逆性对称**：不增加写入或合并权限；删除快照选择分支即可完全恢复旧 preflight，任何异常自动回退。
4. **原生执行优先**：继续调用宿主真实 git/gh/Runner，只把多个只读调用放进已有受管 operation；不复制 Agent 执行能力。
5. **以假绿率和恢复衡量**：以 #289 的 208–213 秒单次刷新和 102 operations 为基线；目标单次低于 60 秒，并要求所有竞态/篡改测试继续失败关闭。

## User Stories

### US-001: 批量收集完整 Review preflight 原始事实

#### Acceptance Criteria

- [x] 典型 PR 的 managed status 使用一个固定受管 preflight snapshot operation，返回的完整 context 与现有逐命令 preflight 在 branch、base/head、PR、契约、changed files、逐文件 base/head、diff、Spec、工程规范、history 和 PR sections 上完全等价。
- [x] helper 的可执行文件来自项目目录外，使用固定最小环境、逐子命令超时、总输出上限、严格 JSON schema 和固定子命令数量/路径集合；项目内容不能改变 helper 程序或注入命令参数。
- [x] 二进制 diff、LFS、submodule、缺失/截断文件、脏工作树、PR/head/base/标签变化、非法契约或来源路径不一致继续产生与旧路径相同的不可验证结论。
- [x] 快照执行/解析不可用或输出超界时只回退现有逐命令受管 preflight；已返回事实与契约对账矛盾时失败关闭。两者都不得直接复用旧 Review 或跳过检查。
- [x] managed status 继续在远端慢读取前后重复 Story、Runner、PR 与本地当前性核对；Issue 可信标记前仍调用第二次独立 managed status，不复用第一次结果。
- [x] 确定性测试记录快照路径与回退路径的外层 managed operation 次数，证明典型 preflight 从随文件增长的多次 operation 降为一次。
- [x] 在 coding-engine 同一提交、同一环境连续实跑至少三次，记录单次确认、完整双确认、外层 operation 数和是否调用 Builder/Validator/项目检查/Reviewer；单次确认目标低于 60 秒。
- [x] 按完整改动范围判定的本地与远端检查全部通过，结论绑定 #292 的 PR 最新提交。

## Delivery Boundary

- 只在 `codex/issue-292` 和对应 PR 交付；不自动发布。
- `src/review/**`、`src/issue/**` 属于受保护质量路径，必须使用独立、限时政策例外和 owner PR 标签。
