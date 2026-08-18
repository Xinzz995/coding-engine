---
title: 0.37.0 候选晚到结果实测夹具
status: candidate-only
updated: 2026-08-18
scope: root
---

# 0.37.0 候选晚到结果单次补签夹具

本文件固定本轮实测协议。当前 PR 相对 `main` 的完整文件范围只能是本文件；候选验证不得改动其他
受版本控制文件。

## 不可变协议

1. 固定全新的 0.37.0 候选、当前 PR 和同一 Git head。先让 Final Review 观察到该 head 的远端检查
   为 `pending`，随后保持 head 不变，等待远端检查自然变为 `ready`。
2. 远端检查变为 `ready` 后，只执行一次同一候选的
   `candidate publish-proof --candidate-evidence <packed.json>`。不得重跑 Builder、Validator、当前
   改动适用的项目检查或 Final Review，也不得再次执行补签。
3. 本次补签的运行结果与刷新耗时只写回 Issue #250 和当前 PR 的证明评论。当前提交只固定协议，
   不预先记录尚未发生的结论或耗时。

## 检查与收口边界

- 本次纯文档变化只命中项目的 `repository-health` 检查；该检查必须实际通过。未命中的测试、构建、
  格式、lint、类型检查和依赖审计不得写成已执行或已通过。
- 本 PR 完成实测后关闭且不合并。禁止 npm staging、npm 发布、变更 `latest`、创建标签或
  GitHub Release。
