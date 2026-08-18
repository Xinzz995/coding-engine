---
title: 0.37.0 候选晚到结果实测夹具
status: candidate-only
updated: 2026-08-18
scope: root
---

# 0.37.0 第五个候选晚到结果单次补签

本文件固定第五个 0.37.0 候选的晚到远端检查实测边界。当前 PR 相对 `main` 的完整文件范围只能包含
本文件；候选验证不得改动其他受版本控制文件。

## 实测顺序

1. 先观察当前 PR 同一 head 的远端总闸为 `pending`。
2. 保持该 PR head 不变，等待远端总闸自然变为 `ready`。
3. 确认 ready 后，仅执行一次：

   ```bash
   <candidate-cli> candidate publish-proof --candidate-evidence <packed.json> \
     --workspace <workspace>
   ```

从观察到 pending 到补签结束，不得重跑 Builder、Validator、完整机械检查或最终 Review。

## 收口边界

- 本 PR 完成后关闭且不合并。
- 禁止执行 npm staging、npm 发布、移动 `latest`、创建标签或 GitHub Release。
