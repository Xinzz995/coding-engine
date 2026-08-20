---
title: coding-x 0.37.1 coding-engine 候选证明
status: candidate-only
updated: 2026-08-21
scope: root
---

# coding-x 0.37.1 coding-engine 候选证明

本文只记录 coding-engine 自托管路径对固定候选的核对结果和后续证明边界，不是正式发布证明。

## 固定候选

| 项目 | 固定值 |
|---|---|
| 来源提交 | `b30307d5fcf11bcedbd3a732ad569c7b63a82fb4` |
| 候选运行 | `32404553771` |
| 候选身份 | `sha256:de36aaaa9230164d521b9aaa41ca26590bdb2ae1a217e8426d5bea95cc4c055d` |
| tarball SHA-256 | `1a37cbb8f5e697280c05710af8ac58ba05ec1cbf6cef2689a66bbbda8af37084` |

## 实际核对

- 对实际下载的 `coding-x-0.37.1.tgz` 重新计算摘要，结果与上表的 tarball SHA-256 一致。
- 将该 tgz 安装到 coding-engine 仓库之外的独立目录，没有改用全局安装、`npx` 稳定版或另一份候选。
- 使用候选制品附带的外部 `packed.json`，逐项核对仓外安装中的全部 22 个运行文件；路径、大小和
  SHA-256 均一致，没有缺失或额外运行文件。
- 从该仓外安装固定唯一的绝对候选 CLI。Shadow `doctor`、`apply-prd`、当前 `run`，以及条件满足后
  才允许执行的 `candidate publish-proof`，全程使用同一绝对候选 CLI。尚未满足发布条件的
  `publish-proof` 不在本文中记作已经发布。

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
