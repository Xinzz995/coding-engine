---
title: 0.36.0 RC1 候选包与三仓 Shadow 证明
status: active
updated: 2026-08-14
scope: root
---

# 0.36.0 RC1 候选包与三仓 Shadow 证明

## 证明边界

`0.36.0 RC1` 是 0.36.0 的首个候选，没有先前 RC 失效历史。本计划只记录候选能力与三仓
Shadow 事实，不授予发布结论。`0.34/0.35` 的包、安装、workspace、requestId、Validator 回执、
Final Review、报告和 PR 结论都不能作为 RC1 证据；本轮必须使用全新安装、全新 workspace、全新
变更请求、全新 requestId 和绑定当前 HEAD 的全新回执。

Go 与 Python 仓是跨语言合成试点，只证明多模块、多包和原生 CI 的候选兼容性，不证明真实业务下游
采用。本仓的 Shadow 自托管也只证明候选验收链按设计走完，不表示正式可交付。

## RC1 十项身份

以下十项身份必须同时匹配；缺少一项或任一项不一致都立即停止，不得继续收集证据或申请 npm
staging。

| # | 身份 | 固定值与核对规则 |
| -: | --- | --- |
| 1 | 版本 | `coding-x@0.36.0` |
| 2 | 来源提交 | `4706d385e4289daadf8eb3f2df2c91a5d8d90762` |
| 3 | Build release candidate run | `31690201048` |
| 4 | artifact 名称与 ID | `npm-candidate-0.36.0`，ID `9177358726` |
| 5 | artifact digest | `sha256:ae37496a36c5420fd514dfb1dd1869d59e4d52812f589bb70561bbf23f44450a` |
| 6 | 候选 tarball 大小 | `723750` bytes |
| 7 | 候选 tarball SHA-256 | `a7f3401f9a15505dc33f4b6f0597ab94778147a63079e5ee00586fb3e7a4e233` |
| 8 | coding-engine 固定 RC1 CLI | 必须由上述同一 tarball SHA-256 在仓库外全新独立安装后取得 npm 真实命令入口。一次性安装目录不是身份；环境被清理后，从同一摘要重建安装并重新核对入口。本轮现场记录路径为 `/tmp/coding-x-rc1-materials.eNz343/install-engine/node_modules/.bin/coding-x`。 |
| 9 | 固定 CLI SHA-256 | 每次执行前解析实际入口的 `dist/cli.js` 并核对 `642e386a2f6491a7032a348b15ff0efaec8031afd00311c6003266964a19b71c`；不一致立即停止。 |
| 10 | PR #223 边界 | 版本 PR #223 已合并，且通过 exact-head 全部检查；这只固定历史修复边界，不构成 npm staging 或发布许可。 |

## 三系统同包安装证明

构建运行 `31690201048` 已于 2026-08-13 通过候选构建与三系统安装总闸。三台托管系统下载的是
同一 `npm-candidate-0.36.0` artifact，核对同一 artifact digest、`723750` bytes 与 tarball
SHA-256；都在仓库外全新目录安装，并从 npm 创建的真实命令入口执行以下检查。

| 托管系统 | 同一 artifact 与摘要 | 仓库外全新安装 | npm 真实命令入口的现场证明 |
| --- | --- | --- | --- |
| Ubuntu 24.04 | 下载 `npm-candidate-0.36.0`（ID `9177358726`），核对 artifact digest `sha256:ae37496a36c5420fd514dfb1dd1869d59e4d52812f589bb70561bbf23f44450a` 与 tarball SHA-256 `a7f3401f9a15505dc33f4b6f0597ab94778147a63079e5ee00586fb3e7a4e233` | 在仓库外全新目录用 npm 安装同一 tarball | 经 `node_modules/.bin/coding-x` 完成 help（退出 0）、workspace init（退出 0）和 shadow doctor（退出 7，`quality.status=shadow`） |
| macOS 26 | 下载 `npm-candidate-0.36.0`（ID `9177358726`），核对 artifact digest `sha256:ae37496a36c5420fd514dfb1dd1869d59e4d52812f589bb70561bbf23f44450a` 与 tarball SHA-256 `a7f3401f9a15505dc33f4b6f0597ab94778147a63079e5ee00586fb3e7a4e233` | 在仓库外全新目录用 npm 安装同一 tarball | 经 `node_modules/.bin/coding-x` 完成 help（退出 0）、workspace init（退出 0）和 shadow doctor（退出 7，`quality.status=shadow`） |
| Windows Server 2022 | 下载 `npm-candidate-0.36.0`（ID `9177358726`），核对 artifact digest `sha256:ae37496a36c5420fd514dfb1dd1869d59e4d52812f589bb70561bbf23f44450a` 与 tarball SHA-256 `a7f3401f9a15505dc33f4b6f0597ab94778147a63079e5ee00586fb3e7a4e233` | 在仓库外全新目录用 npm 安装同一 tarball | 经 npm 创建的 `node_modules/.bin/coding-x.cmd` 完成 help（退出 0）、workspace init（退出 0）和 shadow doctor（退出 7，`quality.status=shadow`） |

任何平台重新打包、改用源码或全局命令、复用项目内安装、只比文件名不比摘要，均不属于这份同包证明。

## 两个跨语言试点的全新 Shadow 事实

| 试点 | 固定范围 | 四步 Shadow 证据 | Validator、Review 与原生 CI |
| --- | --- | --- | --- |
| Go 多模块 | seed 仓 `Xinzz995/coding-x-dogfood-go`；PR #30；分支 `dogfood/0.36.0-rc1-shadow` | workspace init 退出 0；shadow doctor 退出 7 且 `quality.status=shadow`（固定 0.34.1 对候选 0.36.0）；普通 doctor 退出 1 并拒绝版本不一致；shadow apply-prd 退出 7 且 `status=applied-shadow`；最终 shadow run 退出 7 | 审计版 `codex-cli 0.147.0-alpha.6.5` 完成宿主隔离 profile 与 canary 后签发 v3 凭证；final review 为 `passed`、`shadow=true`。round 1 的 P1 是 PR 正文函数名笔误，修正正文后 round 2 重审通过。三平台原生 CI 与 quality-gate 全绿，CI 不安装 Node 或 coding-x。 |
| Python 多包 | seed 仓 `Xinzz995/coding-x-dogfood-python`；PR #26；分支 `dogfood/0.36.0-rc1-shadow` | workspace init 退出 0；shadow doctor 退出 7 且 `quality.status=shadow`（固定 0.34.1 对候选 0.36.0）；普通 doctor 退出 1 并拒绝版本不一致；shadow apply-prd 退出 7 且 `status=applied-shadow`；最终 shadow run 退出 7 | 审计版 Codex 完成 profile 与 canary 后签发 v3 凭证；final review 为 `passed`、`shadow=true`。原生 CI 与 quality-gate 全绿，CI 不安装 Node 或 coding-x。 |

Python 试点还固定了 ADR-025 的负向断言：未审计版本 codex（`0.146.0` 透传壳）与 cursor
进入验证阶段时，都以 `environment-unverifiable (unsupported-version)` 保留候选并退出 5，不增加
重试；evidence 中保留两条 `unsupported-version` 的 `validatorProfile` 记录。任何宽权限回退、候选
丢失或 retryCount 增加都表示失败。

## ADR-025 正向证据与已知边界

审计版 `codex-cli 0.147.0-alpha.6.5` 的每次 shadow run 都必须产生本轮 evidence
`validatorProfile` 的 `resolution=ready` 记录，并记录实际 canary 耗时。Python 试点的现场耗时是
`36.3s`；Go 试点与本仓自托管以各自 evidence 中的 `canaryDurationMs` 为准，不猜测、不跨轮复用。

v3 Validator 凭证的 `runnerProfileDigest` 必须与同轮 `resolution=ready` evidence 的 profile
摘要逐字一致，`canaryEvidenceDigest` 必须与同轮 canary 证据摘要逐字一致；两项摘要都绑定当前
调用、当前 requestId 和当前 HEAD。缺少 ready 记录、耗时、任一摘要，或摘要不能互绑时，不得签发或
接受凭证。

cursor 作为 Builder 时，POSIX supervisor 出现 `process-unsettled` 会保留现场并拒绝恢复。这是
fail-closed 的已知边界，不是候选失败后可绕过的异常，也不能记作 Shadow 完成证据。

## 本 PR Shadow 强完成合同

下表逐项判定本 PR，不能用“运行成功”概括代替。每项都要绑定固定 RC1 身份、全新 workspace、全新
requestId 和当前 PR HEAD。

| # | 完成条件 | 通过证据 | 失败观察 |
| -: | --- | --- | --- |
| 1 | 候选入口在仓库外由固定 tarball 建立，并在每次执行前核对 CLI | tarball SHA-256、真实入口解析结果和 `dist/cli.js` SHA-256 同时匹配十项身份 | 安装目录消失后继续引用旧路径；改用全局命令、npx、其他候选；任一摘要不一致 |
| 2 | 初始化与正式模式拒绝边界成立 | 固定 RC1 CLI 执行 workspace init 返回 0；普通 doctor 与普通 apply-prd 因正式裁判版本不匹配而拒绝 | init 非 0；普通命令接受候选；手写运行状态绕过拒绝 |
| 3 | shadow doctor 只报告版本影子差异 | 同时得到退出 7、`quality.status=shadow` 且没有其他错误 | 退出码不是 7、状态不是 shadow，或同时存在其他错误 |
| 4 | shadow apply-prd 建立全新请求 | 同时得到退出 7、`status=applied-shadow`、全新 requestId | 退出码或状态不匹配；复用旧请求、旧 workspace 或旧 requestId |
| 5 | 固定命令整体执行并走完 Shadow | 逐字使用下方命令；最终返回 7 | 参数被删改、换用默认 `.workspace`、全局命令或其他候选；任何 1–6 都是失败 |
| 6 | Story 状态与全新 v3 回执同时成立 | `blocked=false`、`passes=true`、`validated=true`；回执绑定当前 PR HEAD、`coding-x@0.36.0`、runner `codex`、审计版本 `0.147.0-alpha.6.5`、模型 `gpt-5.6-sol` 与本次 requestId；双摘要与同轮 ready evidence 互绑 | 只有 Agent 自述或 `passes=true`；状态任一不符；回执旧版、旧 HEAD、旧 requestId、身份不符或摘要不互绑 |
| 7 | Final Review 完成 Shadow 远端判定 | schema v2 同时满足 `status=passed`、`deliveryStatus=shadow`、`shadow=true`、`remote.status=ready`，并绑定当前 PR HEAD | Review 字段缺失或不符、绑定旧 HEAD、远端未就绪，或把 Shadow 当作正式可交付 |
| 8 | seed 与最终 HEAD 的本地和远端门禁均完整 | seed PR 与 Builder 最终 HEAD 的本地既有检查、Policy Guard、CodeQL、跨平台质量检查和总闸分别成功 | 只看总闸、不核对分项；跳过 seed 或最终 HEAD；失败、取消、超时、跳过或仍在运行 |

固定运行命令如下；`<candidate-cli>`、`<fresh-workspace>` 都必须替换为已经按上文规则核对的绝对
路径，其他参数逐字保持：

```bash
<candidate-cli> codex --shadow --workspace <fresh-workspace> --no-open --port 0 --builder-model gpt-5.6-sol --validator-model gpt-5.6-sol --review-model gpt-5.6-sol --escalation-model gpt-5.6-sol --dev-timeout 60 --val-timeout 90 --max-iter 5
```

### 两阶段远端收口

1. **阶段一：形成并推送 Builder 最终 HEAD。** 先对 seed HEAD 与 Builder 最终 HEAD 分别完成本地既有
   检查，再精确提交和推送最终 HEAD。推送前远端检查尚未生成或未就绪时，只允许记录为中间退出 6；
   这不是完成、不是失败豁免，也不能进入 Final Review。
2. **阶段二：固定同一 HEAD 完成远端判定。** 等待该最终 HEAD 的 Policy Guard、CodeQL、跨平台质量
   检查与总闸逐项成功，再让绑定同一 HEAD 的 Final Review 得到 `remote.status=ready`。任一检查失败、
   取消、超时、跳过、指向其他 HEAD，或最终仍是退出 6，都必须停止并修复后以新的最终 HEAD 重走两阶段。

## 发布状态与恢复

本轮 npm staging、2FA 批准、`next`、`latest`、`v0.36.0` 标签和 GitHub Release 均未执行。
PR #223 的合并只证明版本来源已进入主分支；Shadow 退出 7 只表示影子验证按合同结束。两者都不构成
任何暂存、合并、发布或标签许可。

若十项身份、证据边界、ADR-025 互绑或强完成合同任一不成立，关闭本 PR 并删除本分支；不得通过修改
候选包、主分支、质量契约、工作流、版本、依赖或发布资产来取得绿色结果。本计划本身也不修改运行
代码、测试、质量契约、工作流、版本、依赖或发布资产。
