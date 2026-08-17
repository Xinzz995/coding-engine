---
title: 0.37.0 候选晚到远端结果实测夹具
status: candidate-only
updated: 2026-08-17
scope: root
---

# 实测目的

本文件只用于 coding-x 0.37.0 候选的自托管 Shadow Dogfood，验证本地最终 Review 先观察到远端
检查未完成，随后在同一 PR head 上只刷新远端状态并补签候选证明。

# 边界

- 本 PR 完成实测后关闭且不合并。
- 不运行 npm staging、发布、标签或 GitHub Release。
- 除本文件外，候选验证不得改变仓库受版本控制的文件。
