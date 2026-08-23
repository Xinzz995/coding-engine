---
title: coding-x 0.38.1 coding-engine 候选证明 R2
status: candidate-only
updated: 2026-08-23
scope: root
---

# coding-x 0.38.1 coding-engine 候选证明 R2

本文是 coding-engine 自托管路径的待执行候选说明，不是已经完成的候选证明或正式发布证明。PR #333
已在候选调用前开放，但这只满足运行前提，不表示种子、当前 head 的 Story 凭证、Shadow Final Review、
远端必需检查或 owner 机器证明已经完成。下列步骤必须按顺序执行并分别取得证据。

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
   逐字核对。不一致时立即停止，不能用制品内预记录的摘要代替这次实际 tgz 摘要核对。
2. 只把摘要一致的 tgz 安装到 coding-engine 仓库之外的全新独立目录，不得改用 registry、全局安装、
   `npx` 稳定版或既有安装。
3. 使用候选制品附带且位于安装目录之外的 `packed.json`，对这次实际安装的完整运行树逐文件核对路径、
   大小和 SHA-256，并确认没有缺失或额外文件。任一项不一致时立即停止。
4. 将这次仓外安装的唯一绝对 CLI 路径固定为 `<candidate-cli>`，将上述外部证据的绝对路径固定为
   `<packed.json>`。后续全部候选命令都必须使用同一绝对 CLI，并始终绑定同一外部 `packed.json`；
   `workspace init` 不接受证据参数，但也必须使用该绝对 CLI，其他支持证据参数的命令每次都显式传入
   同一个 `<packed.json>`，不得中途替换 CLI、证据、候选或摘要。
5. 在 doctor 和 apply-prd 之前，先用同一绝对候选 CLI 初始化本次 R2 运行专用、从未创建或复用的
   全新 workspace：

   ```bash
   <candidate-cli> workspace init --workspace <new-r2-workspace>
   ```

   该命令必须创建这个全新 workspace 并返回 0；已有 workspace、旧 workspace 或其他初始化结果都
   不得继续使用。
6. 只在步骤 5 创建的同一个 workspace 中运行 Shadow doctor：

   ```bash
   <candidate-cli> doctor --shadow --candidate-evidence <packed.json> \
     --json --workspace <new-r2-workspace>
   ```

   它必须完成当前实际 CLI 的候选身份核对，并同时得到退出 7、`quality.status=shadow` 且没有其他错误。
7. doctor 成功后，仍只在这个 workspace 中原子应用已经确认的 PRD：

   ```bash
   <candidate-cli> workspace apply-prd --shadow --json \
     --candidate-evidence <packed.json> --input <confirmed-system-temp-request> \
     --workspace <new-r2-workspace>
   ```

   输入必须是已经确认的本次 PRD 请求；命令必须同时得到退出 7 和 `status=applied-shadow`。不得手写、
   分步复制或在其他 workspace 应用 `prd.json`。init、doctor、任一次候选身份核对或原子应用任一失败，
   都必须立即停止，不得进入 Builder、Validator 或 Final Review。
8. 再次确认 PR #333 仍开放且指向当前分支后，只允许执行一次 coding-x codex Shadow 调用：

   ```bash
   <candidate-cli> codex --shadow --candidate-evidence <packed.json> \
     --workspace <new-r2-workspace> --no-open
   ```

   Builder 产生本地提交后，外层流程只负责及时把该原样提交推送到 PR #333 的当前分支，不修改提交
   内容，也不重跑检查。仍在进行的同一次候选调用随后继续完成本 Story 按路径适用的
   `repository-health`、独立 Validator，以及绑定当前 PR 的 Shadow Final Review；不得用第二次
   coding-x codex 调用补做其中任何阶段。

## 远端检查晚到时的唯一恢复入口

如果 Shadow Final Review 完成时远端必需检查仍未 ready，等待它们自然完成后，只允许运行：

```bash
<candidate-cli> candidate publish-proof --candidate-evidence <packed.json> \
  --workspace <new-r2-workspace>
```

该命令只刷新远端检查并为同一候选补签，不得重跑 Builder、`repository-health`、Validator 或 Final
Review。只有当前 head 的 Story 凭证、Shadow Final Review 和远端必需检查全部 ready 时，才能发布
当前 PR 唯一的 owner 机器证明；任一项 pending、失败或绑定变化都必须停止，不能发布新证明。

## PR、失败现场与发布边界

PR #333 在 staging 读取最终机器证明前必须保持开放且永不合并。coding-x 0.38.1 发布收口完成后才
关闭该 PR，并保留其中的最终机器证明作为历史证据。这份待执行说明本身不能供 staging 读取，也不
授权 npm staging、2FA 批准、移动 `next` 或 `latest`、创建标签或正式发布。

PR #332 是独立的失败现场；它的提交、workspace、Story 凭证、Review 和评论都不得在 R2 复用。
R2 必须在上述全新 workspace 中建立并绑定自己的结果，且在结果真正产生前不得预先声称种子、Story
凭证、Final Review、远端检查或 owner 证明已经完成。

本仓只证明 coding-engine 的自托管候选路径。它不代表 Go、Python 或真实业务下游已经验证或采用，
也不代表 npm staging 或 coding-x 0.38.1 正式发布已经完成。
