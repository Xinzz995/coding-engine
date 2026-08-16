---
title: coding-x 候选发布与恢复手册
status: active
updated: 2026-08-16
scope: root
---

# coding-x 候选发布与恢复手册

## 边界

发布不是“推一个标签就把当前目录发出去”。固定顺序是：受保护 PR 合并版本 → 无发布身份地
构建固定候选包 → coding-engine 与两个跨语言合成试点验证 → 显式选择该候选进入 npm staging → 维护者用 2FA 批准
到 `next` → 公开精确版本再次验证 → 维护者移动 `latest` → 创建不可改写的标签和 GitHub
Release。

`build-candidate.yml` 只能构建和保存候选，没有 npm 身份。`stage-candidate.yml` 先在无 npm
身份的任务中先读取 `npm-staging` 当前保护规则，再机器读取固定三仓证明；只有两者都通过，后续任务
才进入受保护 environment 等待人工批准。批准后、接触 npm 前再次读取保护规则和三仓证明，随后把
同一候选提交到 npm 暂存区。它不能批准、不能直接公开、不能移动 `latest`。本机也不运行
`npm publish`。发布身份只存在于独立的暂存任务；该任务不安装项目依赖，也不运行项目脚本。

候选版本与质量契约固定的稳定裁判版本不同是预期状态。GitHub 和暂存流程只运行
`repository-health` 机械检查，不运行候选版本的完整 `doctor`，也不把 shadow 结果转换成成功。
普通 `doctor` 必须继续拒绝版本不匹配，直到新版本发布后由独立 Policy PR 更新固定版本；本地
候选准备只能显式使用 `doctor --shadow`，健康时也返回 7，不能作为正式裁判证明。

## 一次性启用

发布流程 PR 通过全部必需检查后，先在功能分支运行 `coding-x init`，确认并回读以下两项：

- `v*` 标签允许首次创建，但创建后禁止更新和删除；
- GitHub Release 发布后，标签、资产和内容不可修改。

PR 合并到 `main` 后再完成 npm 配置，因为 npm 只接受已经存在于默认分支的工作流文件：

1. 在 GitHub 创建 `npm-staging` environment：
   - 至少配置一个 required reviewer；单人维护时允许该维护者批准自己的运行；
   - 关闭管理员绕过保护规则；
   - 使用自定义部署分支政策，且只添加一个精确的 `main` 分支，不添加标签或通配符。

   不要选择 environment 的 “protected branches only”。本仓库用 GitHub ruleset 保护 `main`，但
   environment 不会把它识别为旧式 protected branch；该模式会显示没有旧分支保护规则，并实际允许
   所有分支部署。仓库内 `.release/npm-staging-policy.json` 不绑定具体批准人账号，但每次暂存会在批准
   前后核对至少一名批准人、禁止管理员绕过和唯一 `main` 分支政策。
2. 在 npm 的 `coding-x` 包设置中添加 GitHub Actions Trusted Publisher：
   - 用户：`Xinzz995`
   - 仓库：`coding-engine`
   - 工作流文件：`stage-candidate.yml`
   - Environment：`npm-staging`
   - Allowed actions：只允许 `npm stage publish`
3. 第一次 OIDC 暂存真实成功后，把 npm Publishing access 改为“要求 2FA 且禁止传统 token”。
4. 确认新的暂存入口可用后，删除 GitHub 的 `NPM_TOKEN` secret，并在 npm 撤销对应旧 token。

不要颠倒第 3、4 步。npm 保存 Trusted Publisher 配置时不会验证字段，只有真实暂存才能证明
用户名、仓库、工作流文件和 environment 全部匹配。

## 每次发布

### 1. 合并版本 PR

版本 PR 同步 `package.json`、lockfile、三个插件清单和运行时版本常量。合并后确认 `main`
全部检查通过，工作树干净，候选提交就是当前远端 `main`。首次稳定自举实际使用 0.33.1
（0.33.0 已被 npm 判定不可复用），并采用一次性的“机械 CI + owner 人工 Bootstrap”：PR
最新提交必须通过全部仓库检查，但不声称完成正式本地 AI Review，也不得用候选版本为自己
签发正式结果。0.33.1 发布并由独立 Policy PR 固定后，后续版本恢复常规流程：稳定裁判 N
评估候选 N+1；N+1 完成发布和公开精确版本复验后，独立 Policy PR 才把正式裁判更新为 N+1。
当前正式裁判版本只以 `.coding-x/quality.json` 的 `codingXVersion` 为真相源，本文不复制另一份
当前版本号。

### 2. 构建固定候选

从 GitHub Actions 手动运行 `Build release candidate`，分支必须选 `main`，输入精确稳定版本，
例如 `0.35.0`。该工作流在没有 npm 身份的环境中执行完整检查，只在 Ubuntu 24.04 构建一次并保存
候选包。随后 Ubuntu 24.04、macOS 26、Windows Server 2022 使用 Node 22 下载同一 artifact，重新核对
版本、提交、运行编号、文件大小与 SHA-256，在仓库外全新目录通过 npm 安装，并从 npm 创建的真实命令
入口依次运行 help、workspace 初始化和 shadow doctor。三个系统与构建任务全部成功，候选总闸才成功。

下载该次运行的制品：

- `npm-candidate-X.Y.Z`：压缩包、打包结果和 schema v3 候选证据；证据记录 commit、candidate
  run ID、文件大小、SHA-1、SHA-256、SHA-512 integrity，以及发布包全部运行文件的路径、大小、
  内容摘要和统一候选身份摘要。

发布包的唯一运行库已经并入 `dist`，公共包不再从包外加载运行代码。三系统安装后不仅核对 tarball，
还要从真实安装目录逐文件核对运行文件树；换掉入口或任一发布文件都必须失败。

构建、摘要、任一系统安装或候选总闸失败时 npm 尚未收到任何内容。取消、超时或跳过也视为失败。
通过受保护 PR 修复后，从新的 main 重新构建候选。
不要重跑旧候选并把它解释成包含后续修复。

### 3. 批准前 Dogfood

coding-engine、Go 多模块合成试点和 Python Monorepo 合成试点都安装
`npm-candidate-X.Y.Z` 中同一个压缩包并记录 SHA-256。两个外部试点只证明跨语言、多模块和
原生 CI，不证明真实业务下游已经采用。

每个项目把候选安装到仓库外独立目录，并把同一候选 CLI 的绝对路径固定为 `<candidate-cli>`。
从准备到运行不能换回全局/npx 稳定版，也不能混用另一个候选：

```bash
<candidate-cli> workspace init --workspace <new-workspace>
<candidate-cli> doctor --shadow --candidate-evidence <packed.json> \
  --json --workspace <new-workspace>
<candidate-cli> workspace apply-prd --shadow --json \
  --candidate-evidence <packed.json> --input <system-temp-request> --workspace <new-workspace>
<candidate-cli> <runner> --shadow --candidate-evidence <packed.json> \
  --workspace <new-workspace> --no-open
```

- workspace init 返回 0；
- shadow doctor 必须同时得到退出 7、`quality.status=shadow` 且没有其他错误；
- shadow apply-prd 必须同时得到退出 7 和 `status=applied-shadow`；
- 最终 run 必须退出 7，并保留 `shadow=true` 的最终 Review；
- Story 凭证和最终 `candidate-proof.json` 必须绑定 `packed.json` 的同一候选身份摘要；每次新进程
  都重新核对当前实际 CLI 文件，不能只复制摘要；
- 普通 doctor/apply-prd 仍应因固定版本不一致而失败，不能靠手写 `prd.json`/`state.json` 绕过；
- shadow Story 凭证在正式模式或另一候选版本中必须自动过期并重验。

随后分别核对：

- coding-engine 使用候选版本运行 `--shadow`；退出 7 只表示影子验证走完，不表示可交付；
- Go 多模块项目运行自身 Go 检查，GitHub CI 不安装 Node 或 coding-x；
- Python Monorepo 运行自身 Python 检查，GitHub CI 不安装 Node 或 coding-x。

每个候选 PR 必须开放、非草稿、目标为该仓默认分支。对应仓库从该候选 CLI 显式运行：

```bash
<candidate-cli> candidate publish-proof --candidate-evidence <packed.json> \
  --workspace <new-workspace>
```

该命令再次逐文件证明当前 CLI 是同一候选，在短租约内核对 Story 凭证、已有 Final Review、Runner、
Git/PR head/base、契约、Ruleset 和检查。远端总闸 ready 时，它补签或更新
`candidate-proof.json`；短租约安全关闭后，原发布入口再核对当前仓库、owner、分支、PR 编号、
head/base 和可合并状态，创建或更新唯一 owner 证明评论。若 Final Review 收口时 CI 尚未结束，
等待检查自然完成后直接重跑这条命令；不要重跑 Builder、Validator、完整机械检查或 Review。命令不
轮询，远端仍 pending/failed、候选证据缺失或任一绑定变化时失败关闭且不发布新评论。

不带 `--candidate-evidence` 的兼容模式只会发布 workspace 中已经存在的证明，不能产生新结论。评论
绑定候选身份、Story 凭证集合、最终 Review、当前 head/base 和当时全部必需检查；普通日志、Agent
自述或旧评论不能替代它。

### 4. 提升已验证候选到 npm staging

从 GitHub Actions 手动运行 `Stage verified npm candidate`，分支必须选 `main`，输入：

- 候选的精确版本；
- `Build release candidate` 页面显示的 candidate run ID；
- coding-engine、Go、Python 三个当前候选 PR 的编号。

不需要手工复制文件摘要。工作流先自动回读候选运行，要求它来自
`.github/workflows/build-candidate.yml`、已成功结束、对应提交仍是当前远端 main，并重新核对
tarball 与运行文件树身份；再读取固定三仓的指定 PR、全部评论和当前 head 的检查结果，要求每仓
恰有一条受信任 owner 证明，且三个证明都绑定同一候选、各自当前 PR head/base，PR 仍可合并，证明
列出的必需检查仍是最新成功结果。机器核对完成并保存三仓证明集合后，npm environment 才显示批准
请求。任一条件不满足都不会进入批准，也不会取得 npm 身份；此时应修正对应 PR 或从新 main 重新
构建候选。

成功后下载该次 staging 运行的 `npm-stage-X.Y.Z`。它记录 candidate run、stage run、npm
stage ID、同一候选摘要和三仓证明集合摘要。批准后任务还会重新读取三仓 PR、评论与检查，要求重算
结果和批准前集合完全一致，并再次核对当前 main；任何批准等待期间的 base/head、评论或检查变化都会
停止，不会在有 npm 身份的步骤接受旧快照或人工文字。若该制品不存在，不得推测暂存成功。查看日志
和 npm Staged Packages；若 npm 已创建 stage 但后续摘要核验或证据上传失败，必须用 2FA 拒绝该 stage。

若 npm 报告版本曾经发布，停止重试该版本。npm 的版本标识不可复用，即使公开内容已经撤回；
必须通过新的受保护版本 PR 选择新版本，再从新的 main 构建和验证候选。

### 5. 用 2FA 批准到 `next`

在 npmjs.com 的 Staged Packages 页面检查并批准，或在已交互登录的终端执行：

```bash
npm stage view <stage-id>
npm stage download <stage-id>
npm stage approve <stage-id>
```

批准会把暂存时固定的 `next` 标签一并公开；不能在批准时改标签。重新下载公开的精确版本，
在 coding-engine 与两个合成试点执行安装冒烟，并核对候选摘要、npm `gitHead` 和 provenance
都指向候选提交。

### 6. 提升稳定版本

公开精确版本验证通过后，维护者用 2FA 把同一版本提升为 `latest`：

```bash
npm dist-tag add coding-x@X.Y.Z latest
npm view coding-x dist-tags --json
```

`next` 和 `latest` 必须同时指向 `X.Y.Z`。然后把同一次暂存任务编号、npm stage ID 和候选
SHA-256 写进 annotated tag。以下三个值必须直接来自已下载并人工核对的候选证据：

```bash
git switch main
git pull --ff-only
git tag -a vX.Y.Z -m "release: vX.Y.Z

Stage-Run-ID: <GitHub Actions run ID>
Npm-Stage-ID: <npm stage ID>
Candidate-SHA256: <64 位 SHA-256>"
git push origin vX.Y.Z
```

标签工作流不会再发布 npm。它只接受受保护 `main` 中的 annotated tag，重新核对候选包、npm
内容、`next`/`latest`、提交、标签中的三项候选身份和签名 provenance，再把 npm 的精确压缩包
及候选证据放入 draft Release，最后一次性发布为不可变 Release。即使同一提交重跑过多次暂存，
标签也只允许选择人工实际批准的那一次，不会猜测“最新一次”或“任意一次”。

### 7. 最终核对

以下状态必须同时成立：

- npm 精确版本的 `gitHead` 是候选提交，`next` 与 `latest` 指向同一版本；
- npm registry 压缩包与候选压缩包摘要一致，签名和 provenance 可验证；
- `vX.Y.Z` 是 annotated tag，指向同一提交且属于受保护 `main`；
- GitHub Release 显示 Immutable，两个资产摘要和 Release attestation 均通过；
- coding-engine 与两个合成试点记录的是同一候选摘要；本地 `main` 干净并与远端同步；
- staging 证据包含固定三仓唯一证明集合，三份证明分别绑定各自 PR 的当前 head；
- 本轮证据只证明跨语言试点，不声称已经完成真实业务下游验证。

## 失败恢复

| 失败点                                     | 处理方式                                                                                                  |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------- |
| 候选构建或 Dogfood 失败                    | npm 尚未收到候选。通过新 PR 修复，从新 main 构建新候选并重跑 Dogfood。                                    |
| 选择的候选运行非法、失败或已落后 main      | 没有 stage；不要猜测后续改动是否影响发布物，构建并验证新候选。                                            |
| 暂存任务在 npm 调用前失败                  | 没有 stage；查明候选身份、OIDC、environment 或工作流配置后重跑。                                          |
| npm 已返回 stage，但摘要核验或证据上传失败 | 不批准。用 `npm stage reject <stage-id>` 和 2FA 拒绝；查明原因后重跑。                                    |
| 批准到 `next` 后，公开冒烟失败             | 不移动 `latest`，不创建标签；保留版本并发布新的补丁版本。                                                 |
| 已移动 `latest`，标签创建前发现问题        | 立即把 `latest` 移回前一个稳定版本，再发布补丁；不删除已发布版本。                                        |
| 标签工作流因临时错误失败                   | 直接重跑原工作流。标签不得移动或删除。                                                                    |
| 标签工作流本身有缺陷                       | 通过受保护 Policy PR 修复；随后从当前 `main` 手动运行 `Verify stable npm release`，输入原标签恢复或复核。 |
| GitHub Release 已发布                      | Release、资产和标签不可改写；任何修复使用新补丁版本。                                                     |

npm staged publishing 不可用时不自动降级。只有用户明确批准新的限时政策例外后，才能临时
开放 OIDC 直接发布到 `next`；验证结束后必须恢复 stage-only，并重新运行 doctor。

## 证据保留

Actions 候选制品保留 30 天，供批准前 Dogfood、staging 和发布工作流消费；三个 PR 的 owner
证明评论是可回读的批准输入，stage 证据保存其集合摘要、评论 ID 和 PR head。stage 证据沿
candidate run ID 回到原候选，不复制或重建一个替代候选。npm stage、公开 registry、GitHub
不可变 Release 和对应 attestation 是共享记录。workspace 里的 Review 文件仍只是本地反馈，
不能替代这些交付记录。
