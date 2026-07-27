---
title: 019-verify-candidate-before-npm-staging
status: active
updated: 2026-07-27
scope: root
---

# 019. 在 npm 暂存前验证固定候选

## 背景

ADR-018 确立了固定候选、三仓 Dogfood、npm staged publishing 和人工批准，但首次真实运行把
“构建候选”与“创建 npm stage”放在同一次工作流。0.33.0 多次在 stage 创建后才由真实
Dogfood 发现产品问题。拒绝旧 stage 保证了安全，却把 npm 暂存区变成了产品测试候选池。

摘要一致性要求的是 Dogfood 与发布消费同一个 tarball，并不要求先创建 npm stage 才能开始
Dogfood。GitHub artifact 已能保存精确候选和摘要；npm staging 只需作为验证完成后的提升动作。

## 决策

候选发布改为两个独立的人工入口：

1. `build-candidate.yml` 在当前受保护 `main` 执行完整机械检查、构建固定 tarball 并记录提交、
   运行编号和摘要。该工作流没有 OIDC 或 npm 发布权限；
2. coding-engine、Go、Python 使用该 artifact 完成批准前 Dogfood；
3. `stage-candidate.yml` 由维护者输入版本和候选运行编号，回读 GitHub 运行来源、成功状态和
   head SHA，并要求候选提交仍等于当前远端 `main`；
4. 只有核验通过后，stage-only OIDC 才把同一候选提交 npm。npm 返回摘要必须与原 tarball
   一致，最终仍由维护者用 2FA 批准。

发布证据 schema 升为 v2，分别记录 candidate workflow run 和 stage workflow run。稳定标签
继续固定 stage run、npm stage ID 和候选 SHA-256；标签工作流先取得 stage 证据，再沿其中的
candidate run 下载原始候选并分别回读两次运行。旧 v1 stage 不自动迁移或批准。

## 后果

- 产品问题在 npm 之外修复，不再为每轮修复制造待拒绝 stage；
- 候选提交之后任何 `main` 变化都会要求重建和重跑 Dogfood，牺牲少量吞吐以消除“改动是否
  影响发布物”的人工猜测；
- npm Trusted Publisher 继续绑定 `stage-candidate.yml`，无需改变已验证身份；
- 维护者只选择版本和候选运行编号，摘要与提交核对全部自动完成；
- stage-only 任务仍不安装依赖或执行项目生命周期脚本。

## 不采用的方案

- 不让维护者逐文件比较或手工复制 SHA-256，避免增加操作负担；
- 不在同一工作流的两个 job 之间等待数天 Dogfood，避免长期占用 environment 审批和运行状态；
- 不允许从旧 `main` 提升候选，即使维护者认为后续提交“只改文档”；
- 不新建制品服务、数据库或签名平台。
