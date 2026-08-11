---
title: 0.35.0 RC6 候选包与三仓 Shadow 证明计划
status: active
updated: 2026-08-11
scope: root
---

# 0.35.0 RC6 候选包与三仓 Shadow 证明计划

## 目标与边界

本计划只固定 RC6 候选身份、记录已经完成的候选构建与三系统安装证明，并规定 coding-engine、Go
和 Python 三仓必须如何重新完成 Shadow Dogfood。它不修改运行代码、测试、质量契约、工作流、
版本、依赖或发布资产，也不把合成试点写成真实业务下游采用证明。

本轮实现只新增本文件。源 PRD
`docs/prds/prd-0.35.0-rc6-candidate-package-proof.md` 与 seed 提交
`6f2ec8419bf5783361513486a48bb04b2974da31` 必须保持不变。

## RC6 十项共同身份

以下十项身份必须同时匹配；缺失或任一项不同都立即停止，不得把结果记为 RC6 证据：

1. 版本：`coding-x@0.35.0`
2. 来源提交：`e3dee2acc9c3033b733044d49abf368d45e04879`
3. 候选运行：`31439426426`
4. artifact：`npm-candidate-0.35.0`，ID `9082544987`
5. artifact digest：`sha256:97aaf69af4f296a4144ce6959f67f12deb8996ba7dfacaa9012522d0f1f7fccb`
6. tarball 大小：`711873 bytes`
7. tarball SHA-256：`d65507d9e568d8302991b8c47840e1aa6387094eebc4d62f3852f7fd768d6713`
8. coding-engine 候选入口：从第 7 项同一 tarball SHA-256 的候选包，在仓库外建立全新独立安装并
   使用其真实命令入口；一次性目录不构成身份。环境清理后必须从同一摘要重建并重核，不能因目录
   消失而放弃或伪造证据。本轮实际入口仅作现场记录：
   `/private/tmp/coding-x-rc6-materials.AZ0D9d/installs/engine/node_modules/.bin/coding-x`
9. CLI SHA-256：`699b44321519e52827545eb1b62b8fb314a4695913883fe34398a1df080004c4`（每次执行前
   对实际入口解析出的 `dist/cli.js` 重新核对；不一致立即停止）
10. PR #206 边界：PR #206 已合并并通过其 exact-head 全部检查；它只固定 RC6 相对 RC5 的测试预算
    修复边界，不签发发布许可。

RC1、RC2、RC3、RC4 与 RC5 均永久作废。旧包、旧安装、旧 workspace、旧 requestId、旧 Validator
回执、旧 Final Review、旧报告和旧 PR 结论都不能作为 RC6 证据；#209 及其 workspace、requestId、
回执和 Review 结论也已作废。相同版本字符串、RC5 与 RC6 相同的 tarball 字节、相同来源仓库或曾经
通过的检查都不能恢复这些证据。

## 已完成的候选与三系统安装总闸

候选运行 `31439426426` 的 RC6 构建与三系统安装总闸已经完成。三台托管机器下载的是同一个
artifact `npm-candidate-0.35.0`（ID `9082544987`），并同时核对 artifact digest
`sha256:97aaf69af4f296a4144ce6959f67f12deb8996ba7dfacaa9012522d0f1f7fccb`、`711873 bytes` 的
tarball 和 tarball SHA-256
`d65507d9e568d8302991b8c47840e1aa6387094eebc4d62f3852f7fd768d6713`。每台机器都在仓库外新目录
安装，且只从 npm 安装产生的真实命令入口执行检查：

| 托管环境            | 下载同一 artifact 并核对同一摘要                                                               | 仓库外全新安装 | npm 真实命令入口检查                                 | 已记录结论   |
| ------------------- | --------------------------------------------------------------------------------------------- | -------------- | ---------------------------------------------------- | ------------ |
| Ubuntu 24.04        | ID `9082544987`；artifact digest、大小与 tarball SHA-256 均匹配                                | 已完成         | `--help`、`workspace init`、`doctor --shadow` 均完成 | 安装任务成功 |
| macOS 26            | ID `9082544987`；artifact digest、大小与 tarball SHA-256 均匹配                                | 已完成         | `--help`、`workspace init`、`doctor --shadow` 均完成 | 安装任务成功 |
| Windows Server 2022 | ID `9082544987`；上述摘要均匹配；真实入口经过 npm 在 Windows 创建的命令包装文件                | 已完成         | `--help`、`workspace init`、`doctor --shadow` 均完成 | 安装任务成功 |

表中“成功”只证明同一个 RC6 候选包能在三个参考系统安装和启动。candidate workflow、相同来源提交、
相同 tarball 字节或旧 PR 检查，都不能替代下面的三仓 Shadow Dogfood、各仓原生门禁和人工证据对账。

## 三仓必须重新建立的证据

三仓都必须使用上面的共同身份，但安装、clone、workspace、变更请求和 requestId 必须彼此独立且
全部为 RC6 新建。不得把三系统安装冒烟目录拿来运行三仓，也不得让三个仓库共享一个 RC6 安装。

| 项目                     | 独立 RC6 安装   | 全新 clone | 全新 workspace | 全新变更请求与 requestId | 仓库自己的门禁                 | 收口状态   |
| ------------------------ | --------------- | ---------- | -------------- | ------------------------ | ------------------------------ | ---------- |
| coding-engine            | 固定候选入口    | 必须       | 必须           | 必须                     | 本地既有检查与 GitHub 全部检查 | 待逐项对账 |
| Go 多模块合成试点        | 必须            | 必须       | 必须           | 必须                     | Go 原生检查与 GitHub CI        | 待逐项对账 |
| Python Monorepo 合成试点 | 必须            | 必须       | 必须           | 必须                     | Python 原生检查与 GitHub CI    | 待逐项对账 |

每仓记录都必须回读并确认候选版本 `coding-x@0.35.0`、来源提交
`e3dee2acc9c3033b733044d49abf368d45e04879`、候选运行 `31439426426` 与 tarball SHA-256
`d65507d9e568d8302991b8c47840e1aa6387094eebc4d62f3852f7fd768d6713` 完全一致。任一仓缺项，三仓
证明就仍未完成，不能用另外两仓的绿色结果补足，也不能用已经完成的候选构建与三系统安装总闸代替。

## 本 PR Shadow 强完成合同

本 PR 必须逐项取得下表证据；“运行成功”不能替代任何一行：

| 编号 | 必须观察到的完成事实                                                                                                                 | 失败观察                                                                                                          |
| ---- | ------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------- |
| 1    | 固定 RC6 CLI 执行 `workspace init` 返回 0                                                                                            | 非 0、使用默认 `.workspace`、全局命令或其他候选                                                                  |
| 2    | 普通 `doctor` 与普通 `workspace apply-prd` 因正式裁判版本不匹配而拒绝                                                               | 普通模式接受 RC6，或靠手写状态绕过拒绝                                                                           |
| 3    | `doctor --shadow --json` 同时返回 7、`quality.status=shadow`，且没有其他错误                                                         | 返回码不是 7、状态不是 shadow，或同时存在其他错误                                                                |
| 4    | `workspace apply-prd --shadow --json` 同时返回 7 与 `status=applied-shadow`，并产生本轮全新 requestId                               | 返回码或状态不匹配，或复用旧请求/requestId                                                                       |
| 5    | 下方固定命令整体执行并最终返回 7                                                                                                     | 返回 1–6、换用其他 CLI/模型/workspace、参数缺失，或入口摘要不一致                                                |
| 6    | Story 同时达到 `blocked=false`、`passes=true`、`validated=true`                                                                      | 只看 `passes=true`，或 blocked/validated 任一不符                                                                 |
| 7    | 全新 Validator 回执绑定当前 PR HEAD、`coding-x@0.35.0`、runner `codex`、模型 `gpt-5.6-sol` 与本次 requestId                         | 回执来自旧 HEAD、旧候选、其他 runner/模型/requestId，或只有 Agent 自述                                           |
| 8    | Final Review 使用 schema v2，并同时满足 `status=passed`、`deliveryStatus=shadow`、`shadow=true`、`remote.status=ready` 和当前 PR HEAD | 任一字段不符、Review 旧于当前 HEAD，或把 shadow 写成正式可交付                                                  |
| 9    | seed PR 与 Builder 最终 HEAD 的本地既有检查、Policy Guard、CodeQL、跨平台质量检查与总闸分别成功                                     | 只验证其中一个 HEAD、复用旧 PR 检查，或以 PR #206/来源 main 的检查代替本 PR 的 exact-head 检查                    |

固定运行命令必须从身份第 8 项规则建立、并通过第 9 项摘要核对的候选命令入口整体执行，参数逐字
保持；不得换用全局命令、其他候选或默认 workspace。环境被清理或需要恢复时，从同一 tarball
SHA-256 重新建立全新独立安装并重新核对入口摘要后重跑：

```bash
<candidate-cli> codex --shadow --workspace <fresh-workspace> --no-open --port 0 --builder-model gpt-5.6-sol --validator-model gpt-5.6-sol --review-model gpt-5.6-sol --escalation-model gpt-5.6-sol --dev-timeout 60 --val-timeout 90 --max-iter 5
```

`<candidate-cli>` 是按身份第 8、9 项建立并核对后的入口绝对路径；本轮实际执行使用的入口即身份
第 8 项的现场记录路径。最终返回 7；任何 1–6 都是失败，不能继续使用该结果申请暂存。入口摘要
不一致也按失败处理，不得以未经核对的入口取得任何证据。

## 两阶段远端收口

1. **seed 阶段**：先在未改写的 seed 提交
   `6f2ec8419bf5783361513486a48bb04b2974da31` 上记录本地既有检查，并等待该 exact HEAD 的 Policy
   Guard、CodeQL、跨平台质量检查和总闸分别成功。旧 PR、PR #206 或来源 main 的检查不能代替。
2. **Builder 最终阶段**：Builder 只新增本计划并提交、推送后，以 Git 直接读出的当前 PR HEAD 为绑定
   重跑本地既有检查，等待同一 exact HEAD 的 Policy Guard、CodeQL、跨平台质量检查和总闸分别成功，
   再完成 Final Review 和人工证据对账。提交推送前 `remote.status` 尚未就绪时，只允许中间退出 6；
   退出 6 不是失败恢复完成，也不是 Shadow 完成。最终必须取得上一节全部事实并退出 7。

两阶段任一远端任务失败、取消、超时、跳过，或检查结果绑定旧 HEAD，都视为本 PR 未完成。修正时必须
保留候选包和发布状态不变，以新的当前 HEAD 重新取得本地、远端、Validator 与 Final Review 证据。

## 发布边界与恢复

当前 `npm staging`、2FA 批准、`next`、`latest`、`v0.35.0` 标签和 GitHub Release 均未执行。
PR #206 的合并只解释 RC6 的来源边界；本 PR 的合并和 Shadow 退出 7 也都不构成任何发布许可。
三仓全部完成且人工对账后，是否申请 npm staging 仍是另一个明确决定。

若十项身份、旧证据排除或强完成合同任一项不正确，停止本轮并关闭本 PR、删除本分支；不得修改候选
包、主分支、质量契约或发布状态来取得绿色，也不得退回 RC1–RC5 的任何证据。

## 黄金原则与交付验证

| 原则             | 本计划裁决                                                                                   | 验证证据                                                   |
| ---------------- | -------------------------------------------------------------------------------------------- | ---------------------------------------------------------- |
| 可证伪完成合同   | 适用；每个候选身份、Shadow 条件和两阶段远端结果都有失败观察                                  | 十项身份回读、命令返回码、状态字段、exact-head 检查        |
| 生成方不得自签   | 适用；Agent 自述和 `passes=true` 只是候选声明                                                 | Validator 回执、schema v2 Final Review、原生门禁与人工对账 |
| 自治与可逆性对称 | 适用；本次只新增计划，合并、暂存和发布保持独立决定                                           | 提交路径核对；流程停在开放 PR 和未暂存候选                 |
| 复用原生执行面   | 适用；三系统使用 npm 真实入口，三仓运行各自原生门禁                                          | candidate 三系统任务及三仓原生 CI                          |
| 失败与恢复优先   | 适用；身份错配、旧证据混入、退出 1–6 或任一门禁缺失都失败关闭                                | 全新安装/clone/workspace/requestId、失败状态和重新绑定 HEAD |

本计划提交前必须确认相对 seed 提交只新增本文件，并依次通过：

```bash
npm run format:check
npm run lint
npm run typecheck
npm test
npm run repository-health
npm run build
```
