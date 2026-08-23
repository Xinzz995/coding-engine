---
title: coding-x 0.38.1 coding-engine 候选证明
status: candidate-only
updated: 2026-08-23
scope: root
---

# coding-x 0.38.1 coding-engine 候选证明

本文是 coding-engine 自托管路径的待执行候选说明，不是已经完成的候选证明或正式发布证明。当前 PR
已在候选运行前开放，但这不代表种子、当前 head 的 Story 凭证、Shadow Final Review、远端必需检查或
owner 机器证明已经完成；下列步骤必须按顺序执行并分别取得证据。

## 唯一固定候选

| 项目 | 固定值 |
| --- | --- |
| 来源提交 | `6e7cde0aceef7918c75c3d0c99f20246bfb6c587` |
| 候选运行 | `32631400657` |
| 候选身份 | `sha256:7d1df0f7d17c9c07cbff1ea9dbfafe5d9052f3c65ca52aef90f56dd80ccbbd5d` |
| tarball SHA-256 | `2224cfefd10c3505829b6d1c00bc107e5cac4333097a7eba97e9de96e5d330c2` |

这四项必须作为一个整体使用，不得替换为相同版本的另一份包、另一次运行或另一候选身份。

## 待执行顺序

1. 下载候选运行中的实际 `coding-x-0.38.1.tgz`，重新计算其 SHA-256，并与上表的 tarball SHA-256
   逐字核对；不一致立即停止，不能用制品内任何预记录摘要代替实际 tgz 摘要核对。
2. 只把摘要一致的 tgz 安装到 coding-engine 仓库之外的全新独立目录，不得改用 registry、全局安装、
   `npx` 稳定版或既有安装。
3. 使用候选制品附带、位于安装目录之外的 `packed.json` 核对这次实际安装的完整运行树，包括每个运行
   文件的路径、大小和 SHA-256，并确认没有缺失或额外文件；任一项不一致立即停止。
4. 从该仓外安装固定唯一的绝对候选 CLI 路径。步骤 5 和步骤 6 的每一次调用都只使用这个绝对路径，
   并且每次都带同一份外部 `packed.json`，不得中途替换 CLI、候选或 workspace 中的摘要。
5. 使用该绝对候选 CLI 依次执行 Shadow `doctor` 和 Shadow `workspace apply-prd`。二者通过后，只允许
   一次 `coding-x codex --shadow` 调用；这一次调用内部依次完成 Builder、本 Story 按路径适用的
   `repository-health`、独立 Validator，以及绑定当前 PR 的 Shadow Final Review。
6. 只有当前 head 的 Story 凭证、Shadow Final Review 和远端必需检查全部 ready 后，才使用同一绝对
   候选 CLI 执行 `candidate publish-proof`，补签并发布当前 PR 唯一的 owner 机器证明。

如果 Shadow Final Review 完成时远端检查仍在进行，等待它们自然完成后，只允许运行上述
`candidate publish-proof` 刷新远端状态并补签。不得重跑 Builder、Validator、机械检查或 Final Review；
任何当前 head 绑定变化也不得复用旧结果。

## PR 与发布边界

当前 PR 在 staging 读取最终机器证明前必须保持开放，并且永不合并。0.38.1 发布收口完成后才关闭该
PR，并保留其中的最终机器证明作为历史证据。这份待执行说明本身不能供 staging 读取，也不授权 npm
staging、2FA 批准、移动 `next` 或 `latest`、创建标签或正式发布。

本仓只证明 coding-engine 的自托管候选路径。它不代表 Go、Python 或真实业务下游已经验证或采用，
也不代表 npm staging 或 coding-x 0.38.1 正式发布已经完成。
