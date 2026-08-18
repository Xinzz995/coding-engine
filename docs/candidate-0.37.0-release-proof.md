---
title: coding-x 0.37.0 候选发布证明
status: candidate-only
updated: 2026-08-18
scope: root
---

# coding-x 0.37.0 候选发布证明

这是一份候选边界说明，不是已经签发的发布证明。它只固定本仓自托管验证将使用的候选，不能把
后续的 Story 凭证、Shadow Final Review、远端检查或 owner 机器证明当作已经发生。

## 唯一固定候选

下列四项必须作为一个整体使用，不能替换为另一次运行、另一份包或相同版本的其他构建：

| 项目 | 固定值 |
| --- | --- |
| 候选来源提交 | `c06db8ece8054bdde2aa98ec240e0dcafece1eaa` |
| 候选运行 | `32139575460` |
| 候选身份 | `sha256:7a1ecca0d840f6fef20e88a3590d82b915a4defa6773bc356e462588ff7678a6` |
| tarball SHA-256 | `7b4700bc56b418aa4906d2d5e4e3a440a220d52b6b00bb65ff94d29fbf3d362c` |

候选必须从这份 tarball 安装到仓库外的独立目录，并使用全新的 workspace。所有候选命令都只能
调用该实际安装目录中的 CLI；每条命令执行前都要从实际安装文件重新核对 `packed.json`，确认它仍
对应上表的候选身份和 tarball SHA-256。任一核对不匹配、文件缺失或无法核对时，立即停止，不得
改用全局命令、npx、旧 workspace 或另一份候选继续。

## 本次文档检查

当前 PR 相对 `main` 的受版本控制变更只能是本文件。这个变更范围实际命中
`repository-health`，提交前必须通过该检查。测试、构建、格式、lint、类型检查和依赖审计均不
命中本次变化；它们没有作为本次检查执行，本说明也不把它们说成已经执行。

## 机器证明的前提

只有当前 head 的 Story 凭证、Shadow Final Review 和全部远端必需检查都处于 ready 后，才可以从
上述实际安装的候选运行 `candidate publish-proof`。该命令届时才可以发布或更新当前 PR 唯一的
owner 机器证明。

该证明必须绑定当时的仓库、PR、base/head、候选身份、Story、Review 和检查结果；其中任何一项
在命令运行前后变化，都不能沿用旧证明。本文件没有声称这些前提、命令或机器证明已经完成。

## 发布边界与证明范围

当前 PR 必须保持开放且不合并，供 staging 机器读取。本仓 Dogfood 不执行 npm staging、2FA 批准、
移动 `next` 或 `latest`、创建标签或 GitHub Release；只有发布完整收口后才能关闭 PR。

本次证明只覆盖 coding-engine 的自托管候选验证，不代表 Go、Python 或真实业务下游已经通过。
