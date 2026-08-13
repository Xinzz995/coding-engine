---
title: Validator 宿主隔离与分层 Runner 信任实施
status: active
updated: 2026-08-13
scope: root
---

# Validator 宿主隔离与分层 Runner 信任实施

## 背景与事实边界

issue #174 的剩余范围（0.36 主菜）：#187/#189 已收口无界验证行为、stdout/stderr 背压与
不可验证退出语义（run 退出 5），宿主上下文隔离尚未接入正式运行路径。ADR-025 已裁决方向：
签发验收凭证的执行角色必须满足可机械证明的宿主隔离——固定 Runner profile 加上每次调用的
真实 canary 反测；当前事实上只有固定版本 Codex 满足，Claude/Cursor 对 Validator 角色按
ADR-023 判为 unverifiable，不静默降级回宽权限模式。

草稿分支 `codex/validator-host-isolation-draft`（提交 b50b1a4）提供 `validator-runner-profile`
纯函数模块与测试（共 1133 行）：policy `validator-host-isolation-v1`、16 项 canary 反测清单、
三 Runner 参数固定与环境净化。它未经质量门禁，恢复实施必须基于最新 main 重新评估。

main（6fb9914）现状事实：

- Validator 与 Builder 共用 `runAgent` 宽权限 argv（codex 为
  `exec --dangerously-bypass-approvals-and-sandbox`）；隔离仅靠 ADR-022 干净检出与 env 过滤，
  `clean-validation-checkout.ts` 不改写 HOME，宿主 memory/插件/MCP 仍可被 Runner 加载。
- validation request 的 `resultPath` 位于 engine workspace；沙箱收紧后 Validator 将无法写入。
- 验收凭证 v2 绑定 requestId/gitHead/acceptanceHash/validationEnvironmentDigest，无 Runner
  隔离绑定；v1 有「可读但不构成当前通过」的降级先例。
- 引擎侧（`src/engine/`）无 Runner 版本探测；review 侧已有 `readRunnerVersion` 受管实现可参照。

本计划只处理 Validator 调用链。Final Reviewer 已有独立隔离 argv（`src/review/runner.ts`），
其认证承诺（ADR-025 决策 1 同样覆盖）随 #166 与后续独立立项落地；本计划不复用、不削弱。
不改动 #166 与 PR #65，不通过增加重试掩盖隔离缺口。

## 完成合同

1. Validator 每次调用的 argv 与环境完全由 `validator-runner-profile` 纯函数产出（policy
   `validator-host-isolation-v1`）：宿主环境只按固定允许清单进入；HOME/XDG/TMP 与 Runner
   状态目录全部指向本次调用专用的临时身份域；Validator 路径不再存在直接继承 `process.env`
   或复用 Builder 宽权限 argv 的分支。
   验证：单元 + loop 集成测试断言实际启动的 env/args 与 profile 逐项一致；静态断言 Validator
   分支不含 `--dangerously-bypass-approvals-and-sandbox`。
2. profile 解析失败的每类原因码（invalid-profile / unsupported-platform / unsupported-version /
   native-boundary-incomplete / canary-missing / canary-binding-mismatch / canary-failed）都判
   不可验证：run 退出 5、保留候选、retryCount 不变、不签发验收凭证；原因码写入证据索引并在
   status 与验证报告中可见。
   验证：逐原因码 fixture 测试；status/report 对账测试。
3. 认证 Runner 集合 = 精确固定版本的 Codex。Claude 与 Cursor 的 Validator 调用在 Runner 启动
   前即返回 native-boundary-incomplete；Codex 版本以受监督 `--version` 实测值与固定值精确比对，
   不一致判 unsupported-version；两者都不存在宽权限回退。
   验证：三 Runner 分支测试；版本漂移注入测试；真实 Claude/Cursor 运行证明诚实 unverifiable。
4. 每次 Validator 调用前，引擎先机械核对宿主注入隔离的静态参数/环境事实（第一层），再由引擎
   自有 canary 执行器在同一 profile 与临时身份域内完成 8 项运行时反测（第二层）；结论只由引擎
   侧机械观察产生（越界写目标是否存在、进程树是否结算、临时域内容是否符合白名单、结构化 canary
   结果是否匹配 schema、预置凭据是否外泄），模型自述只作诊断。任一层不通过即走第 2 条。
   （原设想的 16 项 sentinel 经真机审计收敛为两层，见「真机审计裁决」。）
   验证：fake-runner 注入「自称通过但 token 泄漏」「越界写成功」「无结构化结果」场景必须
   fail-closed；真实 Codex canary 至少在一个平台留下 dogfood 记录。
5. canary 证据与 profile 精确互绑：runner/版本/平台/架构/模型/可执行摘要/profileDigest 任一不
   匹配即 canary-binding-mismatch；profileDigest 覆盖渲染后 argv、净化环境、检出与身份域绝对
   路径、claim schema 摘要与质量契约摘要，证据跨调用不可复用。
   验证：恢复草稿绑定测试；检出/身份域路径变化使旧证据失效的测试。
6. validation request 的 `resultPath` 迁至 profile 临时身份域的模型可写输出区；引擎在临时域
   清理前读取，沿用 ADR-015 一次性 request、64 KiB 严格解析与 HEAD 对账。Validator 对 engine
   workspace 与源项目目录的写入被沙箱拒绝。
   验证：结构化验收协议测试更新；集成测试断言 workspace 内不再出现 validation-result.json；
   canary 的 outside-write-denied 覆盖真实沙箱拒绝。
7. 验收凭证升 v3：新增 runnerProfileDigest 与 canary 证据摘要两个绑定字段；v1/v2 沿既有先例
   保持可读但不再构成当前通过（安全失效、保留候选，重验后签 v3）。
   验证：contract schema 测试、state 凭证评估测试、v2 workspace 升级路径测试。
8. 面向用户文字一致：README 支持矩阵区分「可用于开发（三 Runner）」与「可签发凭证（当前仅
   固定版本 Codex）」并附迁移说明；CLI help、status、验证报告同步；claude/cursor 运行启动时
   打印明确提示（Validator 阶段将不可验证并退出 5），不做 preflight 硬失败以保住开发可用性。
   验证：文档对账；启动提示与 status/report 快照测试。
9. 真实复验：固定版本 Codex 完成真实 canary + 验证闭环，证据索引记录 canary 与验证调用的实际
   路由、结局与耗时（runner 提供时含 token/成本）；真实 Python Monorepo 在 1800+ 文件 `.venv`
   下重放 R7，state、验收凭证、证据索引与退出码相互一致且无假绿。
   验证：dogfood 记录；`docs/dogfood-regression.md` 新增行为级断言。
10. Linux、macOS、Windows 定向测试与全量质量检查通过。本计划不修改 `src/workspace-safety/**`
    与 `assets/workspace-safety/**` 的进程收口合同（#187 已定）；实施中确需触碰时按受保护路径
    政策例外单独裁决，不夹带。
    验证：三平台 CI 总闸；PR diff 对账。

## 关键设计裁决

1. **claim 传输保持 ADR-015 文件协议，只迁移路径**（偏离草稿的 `structured-stdout`）：一次性
   request、固定 resultPath、原子写入、严格解析与 HEAD 对账是 #187 加固过的机械链，改走 stdout
   会制造第二真相源；codex `--output-schema` 不作为 claim 通道。resultPath 落在临时身份域中
   沙箱唯一授权的输出目录。
2. **凭证 v2 按 v1 先例降级**：v3 的绑定主张是「验证发生在可证明的隔离环境」，旧凭证不含该
   证明；混合信任级别会污染最终 Review 冻结的凭证集合。升级后旧 workspace 保留候选实现，
   validation-only 重验后取得 v3。
3. **不拆分 Validator 专用 runner 配置**：runner 仍等于 runKind（ADR-025：模型路由 ADR-010/011/012
   不变）。claude/cursor 运行可正常完成 Builder 轮，进入 Validator 时按第 2 条诚实退出 5；
   配合启动提示，不做 preflight 硬失败。
4. **canary 逐调用执行、证据不可复用**（ADR-025 决策 1）：profileDigest 含本次检出与身份域
   绝对路径，天然使证据单次有效。成本为每次验证多一次有界短调用，实际耗时按黄金原则 5 记录
   进证据索引，0.36 收口时对账。
5. **认证材料预置**：引擎把 Codex 认证材料预置进临时域的 Runner 状态目录（模型沙箱不可读），
   不把长期秘密复制进项目、检出或 workspace；credential-hidden 反测核对其不出现在任何输出。
6. **临时身份域沿用 review 侧临时域安全规则**：创建身份、固定/有界目录树、受管进程收口后才
   清理；清理无法证明成功时不签发凭证（与 ADR-022 检出清理同序：先读 claim，再收口临时域与
   检出，全部证明后才签 v3）。
7. **canary 不污染干净检出**：sentinel 只种在临时域伪 HOME 与引擎已知内容的项目外路径；
   checkout 内只读既有 tracked 文件（AGENTS.md、`git rev-parse HEAD`）；canary 后复用 ADR-022
   的 assertCurrent，检出被改写即不可验证。

## 原生能力对照与 build/adapt 裁决

供应商参数只进入 profile 模块（adapter 层）；解析状态、原因码、凭证字段与退出语义保持
runner-neutral。

| Runner | 审计版本（草稿 2026-08-10） | 原生能力裁决 | 结论 |
| --- | --- | --- | --- |
| Codex | 0.147.0-alpha.6.5 | `--ephemeral`、`--ignore-user-config`、`--ignore-rules`、`--strict-config`、`--sandbox workspace-write` + permissions 覆盖、`shell_environment_policy`、`--disable` 特性清单可组合出可机械证明边界 | 认证 Runner；实施时以当时实测版本重跑参数审计与 canary 后更新固定值 |
| Claude | 2.1.220 | 无宿主沙箱能把 Bash 约束在干净检出内；`--bare` 放弃 OAuth/keychain | native-boundary-incomplete：开发可用、认证不可用 |
| Cursor | 2026.07.20-8cc9c0b | 可运行命令的 print 模式无法关闭宿主规则、MCP、插件与会话，无结构化 schema 约束 | 同上 |

升级协议 = 参数重审计 + canary 重跑 + 更新固定版本（ADR-025 决策 4）；未完成前新版本按
unsupported-version 判不可验证。`--disable` 清单是版本特定事实，随 pin 一起重审计。
Claude/Cursor 原生边界补齐并通过真实 canary 后可直接升级为认证 Runner，无需重开决策。

## 宿主隔离的两层机制（2026-08-13 真机审计后定稿）

原计划设想的「16 项 canary sentinel」经真机审计收敛为两层，因为环境重定向式隔离无法用
「在已重定向环境里种 sentinel」可靠验证（详见下方「真机审计裁决」）：

**第一层 · 宿主注入隔离 = 静态参数/环境事实核对**（`assertHostContextIsolation`，canary 前）：
- `CODEX_HOME`/`HOME`/`XDG_CONFIG/DATA/CACHE` 全部落在引擎单次调用临时域内（宿主真实配置被
  重定向切断）；
- 临时域 Runner 状态目录除引擎预置 `auth.json` 外为空（无自造/残留注入源）；
- profile.args 含 `--ignore-user-config`/`--ignore-rules`/`--ephemeral` 与 `--disable` 全集
  （memories/plugins/plugin_sharing/remote_plugin/hooks/apps/enable_mcp_apps）。
任一不满足即 `host-context-unverifiable` 退出 5。这覆盖 rules/memory/mcp/plugins/hooks/apps/
session 的自动注入向量。

**第二层 · canary 运行时反测 = 8 项引擎机械观察**（模型自述只进诊断）：
- credential-hidden：临时域内假凭据 marker（fake token，绝不复制真 auth）不得出现在输出/回执。
- outside-write-denied：越界写探针目标文件必须不存在。
- project-agents-readable / checkout-read-allowed / controlled-command-allowed：读检出内既有
  tracked 文件与运行 `git rev-parse HEAD`，引擎核对已知内容/精确 HEAD 出现。
- structured-claim-returned：canary 按 respondToken 写结构化回执到授权输出区，引擎严格解析。
- process-tree-settled / temporary-domain-clean：受管 operation 收口证明与临时域无符号链接。

**不覆盖读隔离**：Codex `workspace-write` 全盘可读、无读隔离档位；威胁模型只防自动注入，不防
被恶意 AC 诱导的主动读（Validator 验收本就需读检出与依赖），无界读输出由 #187 输出背压治理。

## 真机审计裁决（2026-08-13，codex 0.147.0-alpha.6.5）

用真实 Codex（`/Applications/ChatGPT.app/Contents/Resources/codex`）跑通端到端后固化的三条裁决：
1. profile 不得禁用 `code_mode`/`code_mode_host`/`code_mode_only`——它们是 Codex 命令执行宿主，
   禁用会让 Validator 只能读、不能跑 git/检查/写回执（真机报 `code-mode host disabled`）。
2. 移除 `outside-read-denied`：Codex `workspace-write` 结构上全盘可读，该检查无法通过且威胁
   模型不要求（用户 2026-08-13 裁决「诚实化边界」）。
3. host-* 注入检查从「运行时种 sentinel」改为「静态参数/环境事实核对」：canary 运行在已重定向
   环境里，往临时域种 sentinel 是自造真实不存在的污染（用户 2026-08-13 裁决「参数事实断言」）。
真机端到端结果：canary `resolution=ready`、验证闭环 `exit 0`、`validated=true`、v3 凭证含
profile 与 canary 双摘要、`canaryDurationMs≈34s`。

## 分批实施

### 批次 A：profile 模块自草稿恢复

- 基于最新 main 恢复 `src/engine/validator-runner-profile.ts` 与测试；保留 policy 版本、16 项
  反测清单、路径分离与环境净化断言。
- 按裁决 1 调整：claimTransport 改为固定文件路径（临时域授权输出区），移除 `--output-schema`
  / `--json` 作为 claim 通道的假设；重审 `--disable` 清单与当时 Codex 实测版本。

### 批次 B：引擎接入

- 引擎侧新增受监督 Runner 版本探测与可执行摘要（参照 review 侧 `readRunnerVersion`）。
- `runAgent` 增加密封 invocation 覆盖入口：接受 profile 产出的 argv/env/cwd/stdin prompt，
  仍走 `createRunnerInvocation` + 受管 operation，containment 与有界尾部语义不变。
- loop 在 Validator 调用前解析 profile；unverifiable 走 ADR-023 既有路径并携带原因码；
  resultPath 迁移；认证材料预置与临时域生命周期接入。
- 凭证 v3、证据索引新增 engine-source 的 profile/canary 记录、status 与报告展示、启动提示。

### 批次 C：canary 执行器

- 引擎自有 canary 执行器：种 sentinel、发固定 canary prompt、按上节机械观察逐项裁决、写
  绑定 profileDigest 的证据；任何非 passed 即按原因码返回不可验证。
- fake-runner 失败注入回归：token 泄漏、越界写、无结构化结果、进程未结算、域污染。

### 批次 D：文档、支持矩阵与真实复验（0.36 发布线）

- README 支持矩阵与迁移说明、CLI help、词汇表新增「Validator Runner profile」「canary 反测」
  词条、`docs/dogfood-regression.md` 新增断言、Runner 升级协议沉淀进发布手册或 patterns
  （ADR-025 跟进项）。
- 真实 Codex canary + 验证闭环 dogfood；真实 Claude/Cursor 诚实 unverifiable 记录；Python
  Monorepo 1800+ 文件 `.venv` 重放 R7；对账 state/凭证/证据/退出码后按发布手册走 0.36.0。

## 黄金原则对照

| 原则 | 适用性与设计裁决 | 验证证据 |
| --- | --- | --- |
| 1. 可证伪完成合同 | 适用。完成合同 10 条分别绑定 argv/env 一致性、原因码、退出码、凭证字段、文档对账与真实复验的可观察结果；无「保证隔离」类绝对承诺。 | 逐条对应的单元/集成/fixture 测试、三平台 CI、dogfood 记录（合同各条已内联验证方式）。 |
| 2. 生成方不得自签 | 适用。canary 结论只由引擎机械观察产生，模型自述仅诊断；证据带 engine-observed 来源标记并与 profileDigest 互绑；凭证 v3 由引擎在全部收口证明后签发。 | 「自称通过但 token 泄漏」注入必须 fail-closed；绑定不匹配拒签测试；receipt 评估测试。 |
| 3. 自治与可逆性对称 | 适用。Validator 自治范围收缩（沙箱、断网、环境允许清单）；新增的引擎能力（临时身份域写入、认证预置、canary 调用）各配防线：固定路径分离断言、模型沙箱不可读、有界单次调用；失败恢复统一为退出 5 + 保留候选 + validation-only 重验。 | 新增能力 → 失败场景 → 防线 → 恢复对照：域污染→白名单+拒签；认证泄漏→credential-hidden+域清理；canary 失控→固定 prompt+超时+受管收口。测试覆盖各失败路径。 |
| 4. 原生执行优先 | 适用。复用 Codex 原生 ephemeral/sandbox/环境政策，不自建沙箱；Claude/Cursor 因可度量原生缺口判不可认证而非补建执行能力；供应商参数收口在 profile 模块，核心状态/凭证/退出语义 runner-neutral；单供应商耦合已由 ADR-025 显式裁决。 | 原生能力对照表（本文）；核心合同测试不含供应商字段；版本固定 + 升级协议测试。 |
| 5. 假绿与恢复优先 | 适用。先写失败路径（七类原因码、canary 注入、版本漂移）再写成功路径；R7 真实事故已固化于 #187，本次补隔离侧真实 canary 与 R7 重放回归；预期指标：宿主注入类假绿归零、不可验证可一键重验、每次验证新增一次有界 canary 调用（记录实际耗时/成本并在收口对账）。 | 失败/成功断言成对的测试清单；dogfood-regression 新增断言；证据索引中的 canary 耗时记录。 |

## 验证清单

- `npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test`、`npm run build`
- 三平台 GitHub 总闸全绿；不触碰 workspace-safety 受保护路径（如需，另走政策例外）
- 真实 Codex canary 通过记录；真实 Claude/Cursor 诚实 unverifiable 记录（无宽权限回退）
- Python Monorepo R7 重放：核对 head、request、claim、profileDigest、canary 证据、凭证 v3、
  证据索引与最终退出码
- `coding-x doctor` 文档检查通过

## 政策、兼容性与发布影响

- Claude/Cursor 的 Validator 从「可用」变为「明确 unverifiable」，v1/v2 凭证降级触发重验：
  均为面向用户行为变化，随 0.36.0 minor 发布并在 README 迁移说明写明（硬约束 5、ADR-025）。
- 不改变 validation-result.json 的 claim schema；resultPath 属引擎内部合同，随 profile 迁移。
- 本任务不自动合并、发布或修改 GitHub 规则；真实复验完成后再按发布手册决定 0.36.0，不在
  实现 PR 中预先宣称版本完成。

## 未裁决项

无。默认 runner 保持 claude（用户 2026-08-12 裁决）：不改默认值，靠启动提示 + README 引导
认证场景使用 codex；该裁决已并入完成合同第 8 条与关键设计裁决第 3 条。

## 实施进展与偏差记录

- 批次 A 完成（分支 `codex/validator-host-isolation`）：profile 模块与测试自草稿恢复并按裁决 1
  调整；测试路径期望改为 `resolve`/`join` 推导以过 Windows CI。Claude/Cursor 实测版本与审计
  pin 精确一致；Codex CLI 不在本机 shell PATH，版本复核顺延批次 D。
- 批次 B 完成：凭证 v3（v1/v2 沿先例降级，评估新增 `missing-runner-binding` 原因）、受监督
  Runner 观察（`validator-runner-observation`）、`runAgent` 密封调用覆盖、隔离编排
  （`validator-host-isolation`：单次调用临时身份域 + Codex 认证预置 + 两步解析）、loop 接线
  （预调用不可验证 → `environment-unverifiable` → 退出 5；ready → 密封调用 + resultPath 迁移
  + 绑定进凭证）、证据索引 `validatorProfile` 记录与 claude/cursor 启动提示。
- 批次 B 实施期裁决偏差：
  1. profile 请求以 `claimProtocolVersion` 绑定 claim 合同（替代草稿的 schema JSON 字符串）——
     文件传输裁决后 schema 字符串只剩摘要用途，与 ADR-015「解析器为合同单源」重复且有漂移
     风险；`model` 改为可空以承载 runner-default 路由（args 省略 `--model`，凭证与 canary 以
     null 绑定该事实）。
  2. 临时身份域不进入 review 侧受管使用协议（`prepareManagedUse` 仅支持密封只读树）：域是
     运行期可变的被动存储，进程收口证明由 runAgent 的受管 operation 承担，域收口只做身份与
     safe tree 核对，非 removed 一律失败关闭。
  3. Runner 观察拒绝含前置参数的包装命令（如 `node script.mjs`）：密封 argv 无法表达前置
     参数，语义与 Windows `.cmd` 包装器拒绝一致。
  4. profile 解析失败与 canary 缺失/失败通过既有 `validationProtocolError` 管道
     （`environment-unverifiable` + 原因码诊断）进入 status/报告；`validatorProfile` 的专门
     渲染并入批次 D 文档轮统一核对。
- 批次 C 完成：引擎 canary 执行器（`validator-canary.ts`）作为生产默认 provider。sentinel
  种入 Runner 状态目录与伪 HOME 的约定加载位置（位置集合属审计事实，随 pin 重审计更新）；
  判据全部引擎侧机械观察——sentinel token 缺席、域外写探针不存在、检出探针内容与精确 HEAD
  出现、respondToken 结构化回执严格解析、身份域无符号链接；模型自述只进诊断。canary 与验证
  共用同一密封 profile 与受管 validator 委托（独立 UUID requestId），耗时记入证据索引
  `canaryDurationMs`。执行器内部故障（超时、异常退出、输出超 1 MiB、探针无法建立）不产出
  证据，解析器按 canary-missing 失败关闭。loop 集成测试含全真链：builder → 引擎 canary（真
  探针协议 fake runner）→ 密封 validator → v3 凭证与证据索引互绑 → 身份域收口零残留。
- 批次 D 文档项完成：README（runner 概念、快速开始、前置要求、「Validator 宿主隔离与 Runner
  信任分层」核心概念小节、退出码 5 描述）、CLI help（runner 认证说明与退出码 5）、词汇表
  （「Validator Runner profile」「canary 反测」词条与关系）、patterns（认证 Runner 升级协议、
  canary 判据约定）、dogfood-regression 断言 32、架构地图（模块表新行、主循环与数据流）。
  status/报告对原因码的呈现核对完成：`validationProtocolError` 诊断全文（含原因码与消息）已经
  由既有协议错误管道展示，不另做 `validatorProfile` 专门渲染。
- 真机复验完成（2026-08-13，codex 0.147.0-alpha.6.5）：三条真机裁决已固化（见「真机审计
  裁决」），端到端 `exit 0` + `validated=true` + v3 双摘要凭证 + `canaryDurationMs≈34s`；期间
  修掉 code_mode 执行宿主被禁的真实 bug，并按用户两次裁决（诚实化读边界、host-* 改参数事实）
  收敛 canary 为「静态参数事实 + 8 项运行时反测」两层。canary 判据、宿主注入机制、pin 版本
  已与实测一致。
- 待办（需用户参与/发布线）：Python Monorepo 1800+ 文件 `.venv` R7 重放、claude/cursor 诚实
  unverifiable 真实记录、0.36.0 发布线（版本 bump 随发布 PR）。
