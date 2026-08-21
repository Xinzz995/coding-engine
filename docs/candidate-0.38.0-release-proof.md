---
title: coding-x 0.38.0 coding-engine 候选证明
status: candidate-only
updated: 2026-08-22
scope: root
---

# coding-x 0.38.0 coding-engine 候选证明

> 本文是待执行的固定候选说明，不是已经完成的候选证明。本文不声称当前 head 的 Story
> 凭证、Shadow Final Review、远端必需检查或 owner 机器证明已经完成。

## 固定候选

以下四项共同标识本轮唯一候选；实际文件或任一固定值不一致时立即停止，不得换包、重打包或沿用
旧结果。

| 项目 | 固定值 |
| --- | --- |
| 来源提交 | `fb81189997c5acf26d693fcffcf264e21a9a17cf` |
| 候选运行 | `32517098488` |
| 候选身份 | `sha256:f695b24061f84ddfc77d49c77c88199a599ce602d3310c445355f9459a6905ab` |
| tarball SHA-256 | `621387552b0699437945f885e159c79ba37e5b67c1c0c83e35d6ed6d21d04191` |

## 待执行顺序

所有路径都必须是绝对路径。候选 tarball、`packed.json`、独立安装目录和 Shadow workspace 均放在
仓库外；不得把安装或临时验证文件写入本仓。执行过程中只使用这次安装生成的同一个
`<absolute-candidate-cli>`，不得换成全局命令、`npx`、源码入口或另一次安装。

1. 从候选运行 `32517098488` 下载实际 tgz 与 `packed.json` 到仓库外目录。对实际 tgz 计算
   SHA-256，结果必须逐字等于
   `621387552b0699437945f885e159c79ba37e5b67c1c0c83e35d6ed6d21d04191`；同时核对
   `packed.json` 中的来源提交、候选运行、候选身份和 tarball 摘要均与上表一致。
2. 在仓库外的全新目录中从该实际 tgz 做一次独立 npm 安装。解析 npm 创建的真实命令入口，记录其
   绝对路径为唯一的 `<absolute-candidate-cli>`；后续不能重新解析到另一个入口。
3. 以仓库外的 `<absolute-packed-json>` 为真相源，对独立安装中的完整运行文件树逐文件核对路径、
   类型、大小和 SHA-256，并核对整棵运行树摘要。缺文件、多文件、链接、越界路径或任一摘要不一致
   都必须停止。后续每个带 `--candidate-evidence` 的候选命令还必须再次从这个实际安装逐文件核对，
   不能只复制候选身份摘要。
4. 用同一个 `<absolute-candidate-cli>` 初始化全新的仓外 Shadow workspace：

   ```bash
   <absolute-candidate-cli> workspace init --workspace <absolute-shadow-workspace>
   ```

5. 用同一个绝对候选 CLI 依次完成 Shadow doctor、apply 和 run；三步都使用同一个仓外
   `packed.json` 与同一个 workspace：

   ```bash
   <absolute-candidate-cli> doctor --shadow --candidate-evidence <absolute-packed-json> --json --workspace <absolute-shadow-workspace>
   <absolute-candidate-cli> workspace apply-prd --shadow --json --candidate-evidence <absolute-packed-json> --input <absolute-system-temp-request> --workspace <absolute-shadow-workspace>
   <absolute-candidate-cli> codex --shadow --candidate-evidence <absolute-packed-json> --workspace <absolute-shadow-workspace> --no-open
   ```

   `workspace init` 必须退出 0；健康的 Shadow doctor 必须同时得到退出 7、
   `quality.status=shadow` 且没有其他错误；Shadow apply 必须同时得到退出 7 和
   `status=applied-shadow`；Shadow run 必须退出 7。退出 7 只表示影子验证走完，不表示候选可发布。
6. 保持当前 PR 开放且不合并。只有绑定当前 head 的全部 Story 凭证有效、Shadow Final Review
   通过并绑定当前 head、当前 head 的远端必需检查全部 ready，且 PR 仍开放、非草稿并可合并时，
   才能继续。任一条件缺失、等待中、失败、过期或指向旧 head，都不得发布证明。
7. 所有前置条件满足后，仍使用同一个 `<absolute-candidate-cli>` 和同一个
   `<absolute-packed-json>`，发布唯一 owner 机器证明：

   ```bash
   <absolute-candidate-cli> candidate publish-proof --candidate-evidence <absolute-packed-json> --workspace <absolute-shadow-workspace>
   ```

   发布证明后当前 PR 仍须保持开放且不合并。npm staging 读取并核对的是这条已发布、绑定当前
   head 的 owner 机器证明；staging 不得把本文这份待执行说明当成已完成证明。

## 证明边界

- 本仓只证明 coding-engine 的自托管候选路径；它不证明 Go 或 Python 试点完成，也不证明真实业务
  下游已经采用。
- 本文、Shadow 退出 7 或单仓 owner 机器证明都不表示 npm staging、正式发布、标签或 GitHub
  Release 已经完成。正式提升仍需要发布流程要求的全部仓库证明和后续机械核对。
- 这次文档变化由质量契约只选择 `repository-health` 检查。未命中的测试、构建、lint、类型检查和
  依赖审计不列为本次已执行证明；文档检查结果也不能替代上述候选机器证明。

在当前 head 的 Story 凭证、Shadow Final Review、远端必需检查和 owner 机器证明真正生成并通过
机械核对前，本文始终只是待执行说明。
