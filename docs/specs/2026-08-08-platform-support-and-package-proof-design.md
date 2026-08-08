---
title: 平台支持与候选安装证明设计
status: active
updated: 2026-08-08
scope: root
---

# 平台支持与候选安装证明设计

## 三层模型

| 层       | 真相源                                                         | 含义                                           |
| -------- | -------------------------------------------------------------- | ---------------------------------------------- |
| 产品支持 | npm 元数据、README、平台原生实现                               | coding-x 可以在哪类系统安装和运行              |
| 项目验证 | `.coding-x/quality.json` 的 `github.requiredPlatforms` 与 jobs | 当前目标项目交付前必须在哪些系统验证           |
| CI 宿主  | 生成或手写 workflow 的 `runs-on`                               | 某项检查实际在哪台机器执行，不自动等于部署平台 |

通用检查和发布使用 Ubuntu，不会把 Linux 强加给目标项目；平台相关检查必须在对应系统运行，不能由
Ubuntu 模拟。目标项目没有平台证据时，init 必须询问，不得默认三项。

## 质量契约

`github.requiredPlatforms` 为非空、无重复的 `linux | macos | windows` 数组。每项至少有一个
`github.jobs[].platform` 对应；jobs 可以包含额外平台的控制任务。新 init 始终写入该字段。

旧 schema v2 缺字段时，`requiredQualityPlatforms(contract)` 返回 jobs 平台的首次出现顺序去重结果；
不得修改 contract 对象、源文件或 digest。显式字段存在时只使用显式值。解析拒绝空数组、重复值、未知
平台和缺失 job 覆盖。

coding-engine 自身遵守稳定裁判 N 审查候选 N+1 的自举顺序。0.35.0 功能 PR 只增加 jobs，并让新代码
从旧文件派生三平台；`.coding-x/quality.json` 仍固定已发布 0.34.1，也不提前出现旧解析器不认识的新
字段。quality/policy 托管流程也继续生成 0.34.1 的旧 runner 字节，确保正式 doctor 仍可逐字核验。
0.35.0 完成公开发布后，独立 Policy PR 才同时更新 `codingXVersion`、显式 `requiredPlatforms` 和固定
runner 字节。这不削弱新下游契约：由 0.35.0 创建的新项目从一开始就写显式字段和固定 runner。

## 初始化

自动发现分两段：

1. `discoverTrackedWorkflowPlatforms` 只读取 Git 跟踪的 `.github/workflows/*.yml|yaml`，识别固定
   `runs-on: ubuntu-* | macos-* | windows-*`。它输出提示和“不确定”标记；不执行 workflow，不解析
   表达式，不读取候选分支外部状态。
2. 用户输入逗号分隔的平台列表。输入经固定枚举、去重和非空校验后，才传给
   `discoverQualityContract`。后者不再拥有 `ALL_PLATFORMS` 默认值。

命令、local prepare、GitHub setup 和 jobs 只使用所选平台。单平台 npm audit 放在固定主平台：优先
Linux，其次 macOS，最后 Windows。`--yes` 只接受已展示的写入和远端变更，不能替用户回答平台；无人值守
初始化必须使用 `--contract`。平台确认和所有不适用理由都在任何仓库或 GitHub 写入前完成。

引擎在当前主机没有任何适用质量检查时返回不可验证，不得以执行零项得到成功；没有 prepare 本身可以是
合法契约，例如不需要安装依赖的项目。

## coding-engine 参考矩阵

| 参考环境                | Node   | 责任                                                        |
| ----------------------- | ------ | ----------------------------------------------------------- |
| Ubuntu 24.04 x64        | 22、24 | 全量、Linux 原生边界；通用格式、静态、安全检查只执行一次    |
| macOS 26 arm64          | 22、24 | 全量与 macOS 原生边界；Node 22 承担 legacy 兼容             |
| Windows Server 2022 x64 | 22、24 | 全量与 Windows 行为；Node 22 另跑 legacy 和标准用户原生证明 |

每个 job 都是总闸依赖。总闸使用 `always()`，只接受精确 `success`；失败、取消、超时、跳过或缺失一律
失败。稳定检查名仍为 `quality-gate`，Ruleset 无需改名。

## 候选安装证明

### 制品

`build-candidate` 的 Ubuntu build job 是唯一打包者，输出 tarball、`packed.json`、`pack.json`。artifact 名
绑定版本和候选 run；`packed.json` 绑定 schema、版本、head SHA、tarball 文件名、大小与 SHA-256。

安装 job 在 Ubuntu 24.04、macOS 26、Windows 2022 上使用 Node 22：

1. checkout 同一候选 head，仅取得仓库内固定验证器；
2. 下载同一 artifact；
3. 验证证据结构、head、版本、文件名、大小和 SHA-256；
4. 建立 runner 临时目录和最小 package.json；
5. 使用 npm 从本地 tarball 安装，并禁用审计、生命周期脚本和锁文件写入；
6. 核对安装包名称、版本、OS allowlist、CLI 和平台 helper 文件；POSIX helper 必须是普通非空文件，
   Windows 两个 helper 必须是带 MZ 头的普通非空文件；
7. 直接启动 npm 在本次安装中创建的 `node_modules/.bin/coding-x`；Unix 同时核对它是指向候选 CLI 的
   符号链接，Windows 必须调用并核对 `.cmd` 包装入口；
8. 删除临时目录后返回结局。

验证器不得使用 npx、全局命令或联网解析另一个 coding-x 版本，不得从工作树的 `dist` 启动，也不得
重新 `npm pack`。

### 汇总与 staging

独立 `candidate_ready` 使用 `always()` 依赖 build 和三项安装任务，只接受四项全部 `success`。工作流
自身没有 OIDC 或 npm 发布权限。stage 工作流继续回读指定 build-candidate run，要求 workflow path、event、
head、当前 main 和 `conclusion=success`；因此安装总闸失败的 run 不能进入 staging，不新增人工布尔输入或
可复制“通过”文本。

## 支持范围的诚实表达

npm `os` 只限制系统族，不证明其中每个版本或架构。README 分两栏：

- 正式系统族：Linux、macOS、Windows；Node 22 及以上，正式发布当下以 22/24 为证据；
- 自动验证参考环境：Ubuntu 24.04 x64、macOS 26 arm64、Windows Server 2022 x64。

Intel Mac、Linux arm64、Windows arm64 和其他发行版可以工作，但没有进入本轮持续交付证明时，不写成
“已验证”。新增正式架构必须加入候选安装或平台原生矩阵后再更新声明。

## 验收

- 契约、init、工作流生成、零检查失败和候选验证器的确定性单测全部通过；
- 格式、lint、typecheck、全量测试、build、repository health、成品 help 通过；
- exact PR head 的七项 Quality jobs、CodeQL、policy guard 全绿；
- 人工 build-candidate run 的三项安装和总闸首次运行全绿，artifact SHA 完全相同；
- 将任一安装 job 构造为失败/跳过的测试中，stage 所依赖的候选结论不能为 success；
- 候选仍需后续三仓 Dogfood，安装 smoke 不替代真实项目验证。
