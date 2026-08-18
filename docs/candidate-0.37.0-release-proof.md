---
title: coding-x 0.37.0 coding-engine 新候选证明
status: candidate-only
updated: 2026-08-19
scope: root
---

# coding-x 0.37.0 coding-engine 新候选证明

## 固定候选

本说明只适用于下列唯一候选；不得替换来源、运行、身份或压缩包，也不得把其他候选的结论挪用到这里。

| 项目 | 固定值 |
| --- | --- |
| 来源提交 | `e00b645b5ee49302ac9a675078a434fc5ca55d0c` |
| 候选运行 | `32168637964` |
| 候选身份 | `sha256:a59afb7940386a6ac1be7f94125207493e96f77c4e22fb1ba15c2293385a87cf` |
| tarball SHA-256 | `a4e44020d76e76d1a919ed56ce758a6c3117e4c71dda8904bb631cbd37be2fdc` |

这是一份待执行的候选证明说明，不声明当前 head 的 Story 凭证、Shadow Final Review、远端检查或 PR 证明已经完成。

## 本仓候选验证顺序

1. 下载该候选的 tgz 与包外的 `packed.json`。安装前，先对实际下载的 tgz 计算 SHA-256，并与上表的固定值逐字比较；不一致立即停止。`packed.json` 的声明不能代替这次实际 tgz 摘要核对。
2. 仅在摘要一致后，才从该 tgz 安装到仓库外的独立目录，并用实际安装得到的绝对 CLI 路径创建全新的 workspace；不得改用 registry、全局安装或既有 workspace。
3. 每次候选命令都使用这个实际安装的 CLI 和包外 `packed.json`。在作出或记录候选结论前，CLI 必须逐文件核对完整安装文件树；入口、任一文件、大小或内容不匹配都立即终止，不能继续使用候选。
4. Shadow doctor、PRD 应用、运行、Review 裁决和 `candidate publish-proof` 都沿用同一候选身份与同一外部 `packed.json`，不得混用其他候选、复制摘要或只信任 workspace 内的记录。

## 机器证明的补签条件

只有当前 PR 当前 head 的 Story 凭证、Shadow Final Review 和远端必需检查全部为 `ready` 后，才可以由带同一候选证据的 `candidate publish-proof` 发布或更新当前 PR 唯一的 owner 机器证明。

该证明必须绑定仓库、PR、base/head、候选身份、Story 凭证、Shadow Final Review 与当时的必需检查快照。任一项尚未 ready、候选不一致或绑定发生变化时，不发布或更新证明。

当前 PR 不合并，并保持开放，以供 staging 机器读取；只有发布收口完成后才关闭 PR。本仓 Dogfood 不执行 npm staging、2FA 批准、移动 `next` 或 `latest`、创建标签或创建 GitHub Release。

本轮文档变化的完成检查是 `repository-health` 通过。测试、构建、格式、lint、类型检查和依赖审计并不因这一文档路径而命中，也不在本文中被当作已执行的候选证明。

## 证明边界

本仓验证只证明 coding-engine 的自托管候选路径；它不代表 Go、Python 或真实业务下游已经通过、采用或完成发布。
