---
title: coding-x 0.37.1 coding-engine 候选证明
status: candidate-only
updated: 2026-08-21
scope: root
---

# coding-x 0.37.1 coding-engine 候选证明

本文是 coding-engine 自托管路径的待执行候选说明，不是已经完成的候选证明或正式发布证明。下列核对、
Shadow 验证和机器证明均须按顺序执行；本文不把它们记作已经完成。

## 固定候选

| 项目 | 固定值 |
|---|---|
| 来源提交 | `b30307d5fcf11bcedbd3a732ad569c7b63a82fb4` |
| 候选运行 | `32404553771` |
| 候选身份 | `sha256:de36aaaa9230164d521b9aaa41ca26590bdb2ae1a217e8426d5bea95cc4c055d` |
| tarball SHA-256 | `1a37cbb8f5e697280c05710af8ac58ba05ec1cbf6cef2689a66bbbda8af37084` |

## 待执行顺序

1. 下载候选运行中的实际 `coding-x-0.37.1.tgz`，重新计算摘要，并与上表的 tarball SHA-256 核对。
2. 将核对后的 tgz 安装到 coding-engine 仓库之外的独立目录，不得改用全局安装、`npx` 稳定版或
   另一份候选。
3. 使用候选制品附带的外部 `packed.json`，逐项核对仓外安装的全部运行树，包括每个文件的路径、
   大小和 SHA-256，并确认没有缺失或额外运行文件。
4. 从该仓外安装固定唯一的绝对候选 CLI；后续每一步都使用这个绝对路径，不得中途替换 CLI。
5. 使用该绝对候选 CLI 依次执行 Shadow `doctor`、Shadow `workspace apply-prd` 和当前 Shadow `run`。
6. 等当前 head 的 Story 凭证、Shadow Final Review 和远端必需检查全部满足下述门槛后，才使用同一
   绝对候选 CLI 执行 `candidate publish-proof`。

在上述步骤实际执行并取得对应证据前，本文不声明实际 tgz 摘要、仓外独立安装、外部 `packed.json`
全运行树核对、当前 head 的 Story 凭证、Shadow Final Review、远端必需检查或 owner 机器证明已经完成。

## 唯一 owner 机器证明的门槛

只有当前 head 的全部 Story 凭证仍然有效、Shadow Final Review 已通过，并且该 head 的远端必需检查
全部 ready 时，才允许由同一绝对候选 CLI 发布唯一 owner 机器证明。任一条件未满足时都不得发布证明。

当前 PR 不合并，并保持开放，供 staging 读取和复核当前证明；本文不授权合并、npm staging、公开发布、
移动标签或创建 GitHub Release。

## 证明边界

本仓只证明 coding-engine 的自托管候选路径。它不代表 Go 试点、Python 试点或真实业务下游已经验证或
采用，也不代表 coding-x 0.37.1 已完成正式发布。

## 本次改动的检查

本次只新增本文。质量契约按 `docs/**` 实际选择并通过 `repository-health` 检查。测试、构建、lint、
类型检查和依赖审计均未命中本次文档路径，也未执行，因此不作为本文的证明。
