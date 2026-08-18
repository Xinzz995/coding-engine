---
title: 0.37.0 候选晚到结果实测夹具
status: candidate-only
updated: 2026-08-18
scope: root
---

# 0.37.0 固定候选的晚到远端补签实测

本夹具只用于在全新的 PR 和 workspace 中验证一次晚到远端检查的补签恢复。它不是发布记录，
也不预先宣称本次运行会成功、失败或耗时多久。

## 固定候选身份

本次只接受以下四项完全相等的候选身份：

- 来源提交：`c06db8ece8054bdde2aa98ec240e0dcafece1eaa`
- 候选运行：`32139575460`
- 候选身份：`sha256:7a1ecca0d840f6fef20e88a3590d82b915a4defa6773bc356e462588ff7678a6`
- tarball SHA-256：`7b4700bc56b418aa4906d2d5e4e3a440a220d52b6b00bb65ff94d29fbf3d362c`

每一次候选 CLI 命令都必须从实际安装的包文件重新逐文件核对 `packed.json`，并确认其中的
来源提交、候选运行、候选身份和 tarball SHA-256 正是上述四项。任一文件或任一值不匹配时，
立即终止本次实验；不得替换候选、修改 `packed.json`、忽略差异或继续执行。

## 唯一允许的时序

1. 在同一 head 上让 Final Review **首次**观察远端总闸。只有这次首次观察结果为 `pending`，
   实验才可继续等待。
2. 如果首次观察之前远端已是 `ready`，本实验立即作废：关闭该 PR 且不合并。不得重跑流程，
   也不得通过人为制造失败或重新触发检查来制造 `pending` 窗口。
3. 只有该同一 head 的 `pending` 自然变为 `ready` 后，才执行且只执行一次：

   ```bash
   <candidate-cli> candidate publish-proof --candidate-evidence <packed.json> \
     --workspace <new-workspace>
   ```

   这次补签不得重跑 Builder、Validator、适用项目检查或 Final Review，也不得再次补签。

## 结果记录与关闭边界

- 本次运行的结果与耗时只写回 Issue #250 和该 PR 的证明评论；当前提交不预知未来结论，
  事后也不得修改当前 head 来补写结论。
- 本 PR 完成后必须关闭且不合并。
- 严禁 npm staging、npm 发布、更新 `latest`、创建标签或创建 GitHub Release。
