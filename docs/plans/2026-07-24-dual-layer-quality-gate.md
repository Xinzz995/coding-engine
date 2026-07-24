---
title: "coding-engine 与下游项目双层质量门禁实施计划"
status: active
updated: 2026-07-24
scope: root
---

# coding-engine 与下游项目双层质量门禁实施计划

**Goal:** 交付一套跨语言的本地评审、GitHub PR 独立评审和远端强门禁，并让 coding-engine
发布后以固定版本自托管；最终用 coding-engine 和一个非 Node 仓库的真实 PR 证明闭环。

**设计规格:** `docs/specs/2026-07-24-dual-layer-quality-gate-design.md`

**设计决策:** `docs/decisions/018-dual-layer-quality-gate.md`

## 完成合同与证据

| 验收标准 | 证据 |
|---|---|
| 严格读取跨语言质量契约，缺失/畸形不降级 | schema 单测、临时 Node/Python/monorepo fixture |
| 三态、finding、例外、receipt 精确绑定当前提交 | 单测、旧 head/旧 policy/过期例外回归 |
| Spec 与 Standards 独立，Deep 只按风险触发 | 三组 prompt/schema fixture 与风险矩阵 |
| 本地 review 不被当作远端凭证 | report/status 文案与合同测试 |
| GitHub AI 不执行 PR 代码 | workflow 静态合同测试、恶意 PR fixture、真实 PR |
| 远端配置写前确认、写后回读，漂移 fail closed | mock API、临时 GitHub repo ruleset E2E |
| coding-engine 与非 Node 下游都由同一机制保护 | 两个真实 PR URL、required checks、规则集快照 |
| 现有能力无回归 | typecheck、全量 test、build、built doctor、CLI smoke |

## 黄金原则对照

| 原则 | 适用性与设计裁决 | 验证证据 |
|---|---|---|
| 1. 完成必须可证伪 | 适用。每条能力对应 exit code、JSON 三态、Check Run、ruleset 或真实 PR；“AI 审过”“管理员绝对不能绕过”不作为完成结论。 | 正反例矩阵、GitHub E2E、最终远端回读。 |
| 2. 生成方不能自签 | 适用。本地 agent receipt 只是反馈；GitHub 默认分支固定版本独立重跑。coding-engine 先发布再自托管，不用 PR 中实现批准自身。 | old-head/policy-change 回归；bootstrap 与后续 self-host PR 分开。 |
| 3. 自主性与风险对称 | 适用。init 新增远端写入，因此写前展示、显式确认、只更新同名受管 ruleset、写后回读；不自动合并/发布。AI workflow 无 PR 代码执行权。 | 拒绝确认零写入、权限不足、部分失败、幂等更新与恶意 PR 测试。 |
| 4. 复用原生执行面 | 适用。项目命令由原生工具执行；远端阻断复用 GitHub ruleset/Checks/Models；provider 差异收口在 GitHub adapter。 | 非 Node/monorepo fixture；核心类型不含 GitHub token/API 对象。 |
| 5. 先度量失败与恢复 | 适用。先覆盖缺契约、命令失败、模型错误、输出畸形、旧 SHA、策略篡改、规则漂移和过期例外；预期降低可跳过评审与旧结果复用造成的假绿。 | failure-first 单测、receipt 错误码、真实被阻断 PR 与修复后重跑。 |

当前无实现方向未裁决项。用户已确认：全部新项目默认启用；核心中立、GitHub 首适配；远端
自动配置并核验；Spec/Standards AI 评审在 PR 上独立重跑。

## Task 1：质量合同、三态与风险引擎

- 先写缺失、未知字段、路径越界、重复 ID、空检查、非法 exceptions 的失败测试。
- 新增 `src/quality/`，严格解析 contract/exceptions，导出三态、finding、receipt 和错误码。
- 实现 Git 身份、契约摘要、source 枚举、diff 统计和风险触发；未知影响按 deep required。
- receipt 只追加写 workspace，关键摘要走原子覆盖；不存在 workspace 时按 CLI 明确创建。

## Task 2：项目命令与三轴评审

- 项目命令复用进程树终止和有界诊断语义，但单独返回 passed/failed/unverifiable，不进入 story
  retry 状态。
- 建立 Spec、Standards、Deep 三份短 prompt 与共同 JSON schema；仓库文本标成不可信数据。
- PR 模板要求明确关联规格；`specSources` 作为允许范围，只读取 PR 关联和直接改动的规格，
  没有独立规格时必须明确声明 PR 意图本身是完整 Spec，禁止无差别载入全部历史规格。
- 实现 GitHub Models adapter 与本地只读 agent adapter；结构、大小、head/policy 逐项校验。
- 模型首次返回伪 finding、虚构证据或其他可纠正的无效结果时，只允许针对同一分片追加一次
  明确拒绝原因后重审；第二次仍无效即 `unverifiable`。纠正轮不得继承首次输出的 finding。
  diff 证据允许逐字引用去掉 `+/-/空格` 控制前缀后的同文件代码，但仍禁止改写、跨文件借用
  和虚构内容；明确写“无需修改”的正向确认机械判为非 finding。
- 远端输入遵守 GitHub 免费额度：输出上限 4000，source/diff 均不截断；首个请求前按完整
  prompt 预算，最多八个无损片段共同覆盖完整评审空间，逐片有效后机械合并并保留重复
  finding 的最高严重度。瞬时 429 按服务端等待提示有限重试，单轴调用节流；全仓模型 job
  通过 GitHub 原生保留队列串行，耗尽后仍保持不可验证。
- local review 并行独立运行 Spec/Standards，风险要求时再运行 Deep；不合并或重新排序 finding。

## Task 3：quality CLI 与展示

- 按现有 CLI 约定接入 `quality init|review|gate|doctor`，非法位置参数和数值在 parse 阶段失败。
- `--json` stdout 单对象，提示/诊断走 stderr；passed/failed/unverifiable 对应 0/1/2。
- `run` 缺质量契约时停止并引导 init；完成提示改为“实现已验证，交付待 PR 门禁”。
- status/report 增加独立交付区；修正 workspace review 真实性文案。
- `/review-loop` 改为调用/指向 `quality review` 的兼容入口，保留人最终裁决边界。

## Task 4：GitHub adapter、生成资产与远端核验

- 生成 contract、PR template、project checks workflow、trusted review workflow、scheduled doctor
  workflow；构建时复制到 dist。
- project checks 无模型/写权限；review workflow 不 checkout PR head，只通过 API 读取并在 head
  创建三条 checks。
- GitHub API adapter 支持仓库识别、PR bundle、文件读取、Models、Check Run、ruleset
  get/create/update；token 只从环境或 `gh auth token` 读取且从不输出。
- init preview/confirm/apply/read-back；doctor 语义比较 ruleset，不相信名字或 HTTP 成功。
- 规则只管理 `coding-x quality gate`，保留用户其他 rulesets；重复执行幂等。

## Task 5：coding-engine 自身质量面

- 增加只检查不改写的 lint；升级 Vitest 3.2.6 并锁定安全 Vite；全量修复由新检查发现的问题。
- 扩展 CI：Linux Node 22 完整检查、Node 18 兼容、macOS/Windows 关键测试/构建、依赖审计、
  CodeQL、Dependabot。
- 发布 workflow 验证 tag commit 位于 origin/main、branch/tag ruleset 启用，并按 ruleset 的
  GitHub App 来源核对关联 PR head；仅允许受 Git 管理且位于发布历史上的有效紧急交付记录
  显式进入异常发布。
- 提交 coding-engine contract；self-host workflow 延至 bootstrap 版本发布后的独立 PR。
- `loop.ts`/巨型测试拆分另开结构治理 PR，不与门禁产品实现混改。

## Task 6：验证、bootstrap、真实下游

1. 跑定向测试、typecheck、全量测试、build、built doctor、CLI help/smoke、diff check、audit。
2. 临时 Git 仓库覆盖 Node、Python、monorepo、路径空格、无 remote、权限不足和 malicious diff。
3. 推送实现分支，创建过渡 PR，等待现有 CI，并完成独立 review。
4. 合并并发布 0.30.0；核对 tag、GitHub Release、npm gitHead 和干净同步状态。
5. 自托管前修复同名源码仓库的 npm 执行冲突并发布 0.30.1；第二个 coding-engine PR 用
   0.30.1 生成 self-host 配置。首次远端运行发现临时前缀目录缺失及模型免费额度超限，经
   #13 记录的有界 bootstrap 修复；v0.30.2 因默认 Actions 身份不能完整读取 ruleset 而在发布
   前安全失败，保留标签但不移动。改用显式管理凭据发布 0.30.3；首次正常 PR 又因真实模型
   请求兼容和干净检出缺构建产物而被阻断且未合并。修正后发布 0.30.4，再由 0.30.4 完整裁决
   真实 PR，验证 direct push 被拒绝、旧 SHA 不可复用、doctor 回读通过，再关闭异常。
6. 建立私有或公开的最小 Python 多模块仓库，先做明确 bootstrap，再用 0.30.4 配置规则；
   用失败 PR 证明阻断，修复后同一 PR 最新 head 全绿并合并。
7. 最终记录两个 PR、ruleset、checks、发布与外部仓库边界；不删除外部仓库，除非用户另行授权。

后续真实运行补充：

- v0.30.5 的专用模型凭据解决了身份额度隔离，但 0.30.6 的单 PR 重试与三轴串行仍挡不住
  多个 Dependabot PR 同时消费共享额度；
- v0.30.7 把默认模型切到已验证严格结构化输出的低限流档，在请求前按完整 prompt 有界分片，
  分片间节流，并用 GitHub 原生 `queue: max` job 队列把仓库内所有模型评审串行；
- v0.30.8 修正 Deep 重复读取 Spec 与 Standards 的来源所有权，并把 `specSources` 从“全部
  载入”改成可信允许范围：Spec 只读 PR 明确关联与直接改动的规格，Deep 只读取工程标准与
  diff，既保持三轴独立，也避免无关历史规格稳定耗尽八片；
- 真实运行连续复现 Standards/Deep 在没有运行中模型任务时永久排队：三个相互依赖的 job
  共用一个 `queue: max` 组会留下悬挂任务。改为一个队列 job 内顺序跑三轴，三条 Check Run
  和三态仍独立，仓库级队列只持有一个等待单元；
- 真实结构治理 PR 证明低限流模型可能把符合要求的实现写成 finding，甚至编造 diff 片段。
  下一版本要求 finding 只能表示需改变的缺陷，并机械核对 evidence 是当前分片中对应文件
  的逐字原文；跨文件或跨分片借用的内容同样无效。不可信输出保持 `unverifiable`，不把模型
  措辞直接升级为失败事实；
- 0.30.9 在外部 Python PR 的真实缺陷上正确 fail closed 并在代码职责澄清后正常通过，但
  coding-engine 结构治理 PR 连续三次把“测试已覆盖、无需修改”写成 medium finding。更高
  限流档模型实测在 120 秒内持续 429，其他低限流档不支持当前严格 schema 或产生空泛误报，
  因此不以换模型规避。下一补丁对同一分片只做一次带拒绝原因的纠正重审；持续失范仍阻断。
- 结构治理和外部下游闭环必须在该版本发布并由旧版本完成 bootstrap 后继续，不能把本地
  provider probe 当成远端门禁证明。

## coding-engine 自托管证据

- v0.30.4 的 npm `gitHead`、GitHub Release 和 annotated tag 剥离提交一致，均为
  `fa82b711d18158237b3b54d23e585ea52e16a80f`。
- PR #20 的首个 head 在 GitHub Models 临时限流时保持不可合并，重试后才恢复全绿。
- PR #20 追加提交后，旧 head 的成功结果不再满足规则；新 head
  `9f59544246d56565f50ceea1a73d31031f2a1b41` 重新取得四项质量检查和四平台 CI 的成功结果。
- PR #20 在 branch ruleset 持续启用、无绕过主体的状态下正常合并为
  `d43904a9a98f08d3d61b8d59cf1c42f3cc1dc927`，未使用启动例外。

## 交付边界

- 本次授权包含实现、提交、推送、PR、GitHub 规则配置和为自托管所需的正式发布。
- 远端写入只作用于 `Xinzz995/coding-engine` 和本次新建的明确 dogfood 仓库。
- 不自动合并未通过检查的 PR，不静默管理员绕过，不上传本机模型密钥。
- 不实现 Git 代理、守护进程、数据库、TUI、中央服务、签名、自动修复/合并/发布。
