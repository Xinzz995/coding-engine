---
title: 0.37.0 候选晚到结果实测夹具
status: candidate-only
updated: 2026-08-18
scope: root
---

# 0.37.0 候选晚到结果单次补签实测

## 固定候选与范围

本次只使用第三个固定 `coding-x@0.37.0` 候选：来源提交
`3ff37b3458dd3c7d486a8f7c02d81741a9795d91`、构建运行 `32043375321`、候选身份摘要
`sha256:ffec0c1234d314215f36f9b3e90445603cf4685df60c24be3c79427bcef7b507`。当前 PR 相对
`main` 的完整文件范围必须始终只有本文件；候选验证不得改变其他受版本控制文件。

## 单次补签实测合同

1. Builder、Validator、当前平台适用的完整机械检查和最终 Review 先正常完成。最终 Review 必须为
   `passed/shadow`，并先观察、保存当前 PR 最新 head 的远端总闸为 `pending`。
2. 保持同一 PR head 不变，等待远端检查自然从 `pending` 变为 `ready`；等待期间不重推提交，也不
   手动重跑任何检查来制造结果。
3. 确认 `ready` 仍属于同一 PR head 后，仅执行一次
   `candidate publish-proof --candidate-evidence <packed.json> --workspace <workspace>`。这次补签不得重跑
   Builder、Validator、完整机械检查或最终 Review。
4. 对账新候选证明和唯一 owner 证明评论，记录 `refresh.durationMs` 与真实墙钟耗时；原最终 Review
   文件必须保持不变，Builder、Validator、完整机械检查和最终 Review 的运行次数不得增加。

初次验收所需的格式、lint、类型、构建、仓库健康、完整测试和旧版兼容检查仍须全部通过；上面的
“不得重跑”只约束远端自然变为 `ready` 之后的补签阶段，不能用来省略初次检查。

## 收口边界

本 PR 仅用于候选实测。完成后关闭且不合并；不得进入 npm staging，不得发布 npm 包，不得移动
`latest`，不得创建标签或 GitHub Release。候选证明只证明这次实测，不代表正式发布。
