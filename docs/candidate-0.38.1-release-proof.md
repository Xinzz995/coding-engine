---
title: coding-x 0.38.1 coding-engine 候选证明 R4
status: candidate-only
updated: 2026-08-23
scope: root
---

# coding-x 0.38.1 coding-engine 候选证明 R4

## 本次目标

在 PR #335 中固定 0.38.1 coding-engine 自托管候选 R4 的完整执行与收口合同。本文只把种子说明升级为候选说明；`candidate-only` 不表示种子、Story 凭证、Shadow Final Review、远端检查或 owner 机器证明已经完成。

分支相对 `main` 的最终差异只能是本文件。不得修改产品代码、质量规则、工作流、版本文件或其他文档。

## 明确的非目标

- PR #335 永不合并；它在 staging 读取最终机器证明前保持开放，只在 0.38.1 发布收口后关闭并保留证明。
- 本 PR 不执行 npm staging、2FA 批准、移动 `next` 或 `latest`、创建标签或 GitHub Release。
- 本仓结果只证明 coding-engine 自托管候选路径，不代表 Go、Python、真实业务下游、npm staging 或正式发布完成。
- #332、#333、#334 的提交、workspace、Story 凭证、Review 和评论均不得复用。

## Spec 与验收标准来源

PR #335 正文与本次请求中完整列出的八条 acceptance criteria 是本次唯一、自包含的规格来源；#332、#333、#334 只用于划定禁止复用的边界，不作为外部规格依赖。

黄金原则对照如下：

| 原则 | 本次裁决与验证证据 |
| --- | --- |
| 可证伪完成合同 | 八条标准逐项由分支差异、本文固定字面量、命令顺序、质量检查以及独立 Validator 核对；任一项不成立即失败。 |
| 生成方不得自签 | Builder 的提交和 `passes=true` 只构成候选；Story 凭证、Shadow Final Review、远端必需检查与 owner 机器证明分别核对。 |
| 自治范围与可逆性 | 本次不扩大写入或发布权限；任一前置步骤失败即停止，PR 永不合并，staging 与正式发布均留在本 PR 范围外。 |
| 优先复用原生能力 | 全程只使用固定候选提供的 workspace、doctor、原子 apply-prd、Shadow run 与 publish-proof，不另建替代流程。 |
| 失败恢复与真实证据 | 本次不修改运行时行为；以实际候选核对、`repository-health`、独立 Validator、Final Review 和远端检查作为证据，不借用历史失败现场。 |

## 固定候选

| 项目 | 固定值 |
| --- | --- |
| 来源提交 | `6e7cde0aceef7918c75c3d0c99f20246bfb6c587` |
| 候选运行 | `32631400657` |
| 候选身份 | `sha256:7d1df0f7d17c9c07cbff1ea9dbfafe5d9052f3c65ca52aef90f56dd80ccbbd5d` |
| tarball SHA-256 | `2224cfefd10c3505829b6d1c00bc107e5cac4333097a7eba97e9de96e5d330c2` |

R4 全程固定以下仓外路径，不得换成全局安装、`npx`、另一份 CLI、另一份 `packed.json` 或旧 workspace：

| 用途 | 唯一路径 |
| --- | --- |
| 实际 tgz | `/private/tmp/coding-x-0.38.1-candidate.cnx59i/coding-x-0.38.1.tgz` |
| 仓外全新安装 | `/private/tmp/coding-x-0.38.1-dogfood.LbczF7/install-engine-r4` |
| 绝对 CLI | `/private/tmp/coding-x-0.38.1-dogfood.LbczF7/install-engine-r4/node_modules/.bin/coding-x` |
| 外部候选证据 | `/private/tmp/coding-x-0.38.1-candidate.cnx59i/packed.json` |
| 本次专用 workspace | `/private/tmp/coding-x-0.38.1-dogfood.LbczF7/workspaces/engine-r4` |
| 已确认 PRD 的原子应用请求 | `/private/tmp/coding-x-0.38.1-dogfood.LbczF7/requests-engine-r4/engine-request.json` |

## 验证方式

以下步骤必须按顺序执行；前一步未成功时不得进入下一步。初始化、doctor、候选身份核对或原子应用任一步失败，都必须立即停止本次 R4，不得清空旧路径后伪装成全新现场，也不得借用历史凭证继续。

### 1. 重新核对候选并仓外全新安装

1. 对实际 `coding-x-0.38.1.tgz` 重新计算 SHA-256，结果必须逐字等于固定表中的 tarball SHA-256。
2. 确认安装目录在本次操作前不存在，再把该实际 tgz 安装到仓库之外的新目录；目录已存在即停止，不删除后复用。
3. 以外部 `packed.json` 为唯一清单，对仓外安装中的完整运行树逐文件核对路径、大小和内容摘要，同时拒绝缺失文件、额外运行文件或整树摘要不一致。还必须核对 `packed.json` 中的来源提交、候选运行、候选身份与 tarball SHA-256 全部等于固定表。
4. 后续每个支持 `--candidate-evidence` 的候选入口都再次使用同一外部 `packed.json` 逐文件核对当前实际 CLI。`workspace init` 不接受该参数，只负责创建空 workspace，但也必须由同一绝对 CLI 执行。

### 2. 先初始化 workspace，再执行 doctor 与原子 apply-prd

本次专用 workspace 必须从未被任何先前运行使用。先执行初始化，再执行 Shadow doctor，最后只通过原子入口应用已经确认的 PRD；不得直接写入 `prd.json` 或 `state.json`：

```bash
/private/tmp/coding-x-0.38.1-dogfood.LbczF7/install-engine-r4/node_modules/.bin/coding-x workspace init \
  --workspace /private/tmp/coding-x-0.38.1-dogfood.LbczF7/workspaces/engine-r4

/private/tmp/coding-x-0.38.1-dogfood.LbczF7/install-engine-r4/node_modules/.bin/coding-x doctor \
  --shadow \
  --candidate-evidence /private/tmp/coding-x-0.38.1-candidate.cnx59i/packed.json \
  --json \
  --workspace /private/tmp/coding-x-0.38.1-dogfood.LbczF7/workspaces/engine-r4

/private/tmp/coding-x-0.38.1-dogfood.LbczF7/install-engine-r4/node_modules/.bin/coding-x workspace apply-prd \
  --shadow \
  --json \
  --candidate-evidence /private/tmp/coding-x-0.38.1-candidate.cnx59i/packed.json \
  --input /private/tmp/coding-x-0.38.1-dogfood.LbczF7/requests-engine-r4/engine-request.json \
  --workspace /private/tmp/coding-x-0.38.1-dogfood.LbczF7/workspaces/engine-r4
```

doctor 必须只得到预期的 Shadow 结论且没有其他错误；apply-prd 必须确认原子应用成功。任何失败都在唯一 Shadow run 之前停止。

### 3. 唯一一次 coding-x codex Shadow 调用

PR #335 必须在候选调用前已开放、非草稿且以 `main` 为目标；调用前必须机械核对这一前置条件，本文不以文字代替该核对。本次只允许下面这一条 `coding-x codex --shadow` 调用，且只能执行一次：

```bash
/private/tmp/coding-x-0.38.1-dogfood.LbczF7/install-engine-r4/node_modules/.bin/coding-x codex \
  --shadow \
  --candidate-evidence /private/tmp/coding-x-0.38.1-candidate.cnx59i/packed.json \
  --no-open \
  --port 0 \
  --builder-model gpt-5.6-sol \
  --validator-model gpt-5.6-sol \
  --review-model gpt-5.6-sol \
  --escalation-model gpt-5.6-sol \
  --dev-timeout 60 \
  --val-timeout 90 \
  --max-iter 5 \
  --workspace /private/tmp/coding-x-0.38.1-dogfood.LbczF7/workspaces/engine-r4
```

Builder 完成本地提交后，外层流程只负责及时把该原样提交推送到当前 PR；不得修改提交内容，也不得在外层重跑检查。同一调用随后继续执行当前文档改动适用的 `repository-health`、独立 Validator，以及绑定 PR #335 当前 head 的 Shadow Final Review。

### 4. 晚到远端检查与唯一 owner 机器证明

若 Shadow Final Review 收口时远端检查仍未完成，唯一允许的后续动作是使用同一绝对 CLI、同一外部 `packed.json` 和同一 workspace 运行 `candidate publish-proof` 刷新并补签：

```bash
/private/tmp/coding-x-0.38.1-dogfood.LbczF7/install-engine-r4/node_modules/.bin/coding-x candidate publish-proof \
  --candidate-evidence /private/tmp/coding-x-0.38.1-candidate.cnx59i/packed.json \
  --workspace /private/tmp/coding-x-0.38.1-dogfood.LbczF7/workspaces/engine-r4
```

这一步不得重跑 Builder、`repository-health`、Validator 或 Final Review。只有当前 PR head 的 Story 凭证、绑定同一 head 的 Shadow Final Review 与全部远端必需检查都 ready 时，才允许发布唯一 owner 机器证明；任一条件未就绪或绑定变化都必须失败关闭，不得发布替代评论。

本文不预先声称种子、Story 凭证、Shadow Final Review、远端检查或 owner 机器证明已经完成。staging 只能读取 PR #335 当前 head 最终生成的唯一 owner 机器证明；在它读取前 PR 保持开放，读取后也不合并，只在 0.38.1 发布收口后关闭并保留证明。

## 风险说明

候选 CLI、外部 `packed.json`、tarball、PR base/head、验收文本、Story 凭证、Shadow Final Review 或远端检查任一变化都会使当前证明链失效。发生变化时必须停止并按新的受保护现场重新建立候选，不能用普通日志、Builder 自述、历史 PR 评论或旧 workspace 补齐。

## 深度评审

- [x] 我主动要求深度结构评审

## 延期与政策例外

P1-Deferral: 无

Policy-Exception: 无
