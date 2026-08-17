---
title: 0.37.0 重建候选晚到结果实测夹具
status: candidate-only
updated: 2026-08-17
scope: root
---

# 实测目的

本文件只用于修复后重新构建的 coding-x 0.37.0 候选自托管 Shadow Dogfood。实测必须先记录
同一 PR head 的远端状态为 pending，等待检查自然变为 ready 后，仅执行一次
`candidate publish-proof --candidate-evidence` 补签；不得重跑 Builder、Validator、完整质量检查
或最终 Review。

# 边界

- 本 PR 完成实测后关闭且不合并。
- 不运行 npm staging、发布、latest、标签或 GitHub Release。
- 除本文件外，候选验证不得改变仓库受版本控制的文件。
