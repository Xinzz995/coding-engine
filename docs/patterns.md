---
title: 约定与陷阱
status: active
updated: 2026-07-24
scope: root
---

# 约定与陷阱

<!-- /compound-docs 收口沉淀与熵 GC 的落点：稳定开发约定 + 高频陷阱。条目短、可验证、带日期；
     结构性知识不放这里（去 architecture.md）；失效、重复或只记录一次事故的条目在 GC 时删除/合并/迁位。 -->

## 约定

<!-- 多个 story 反复出现、未来会复用的稳定开发写法 -->

- 2026-07-03 外部读入的持久化 JSON 必须先过逐字段形状守卫（对每个字段做 `typeof` 校验）再当合法数据用；不通过就返回 `null` 交上层按初始值降级，绝不对落盘数据直接类型断言（见 `tryReadState` / `isStoryState`）。
- 2026-07-03 修复/转换类写盘先在内存完成解析与二次校验、确认可用后再落盘；不可用时在任何写入之前抛出，避免留下半损坏文件（见 `repairJsonString`：修完再 `JSON.parse` 一次；落盘与写前抛出在调用方 `repairJsonFile`）。
- 2026-07-03 CLI 子命令统一在 `parseCliArgs` 把 positional 首参映射到 `CliConfig['command']` 联合类型，`main()` 内按 command 分支、早返回退出码（repair/dashboard/doctor 同构）；新增子命令沿用此形状，不另开分发口。
- 2026-07-03 新功能自成 `src/<feature>/` 目录，核心逻辑导出纯函数（签名收 root/数据、返回结构体），console 输出、`process.cwd()`、退出码等副作用全留在 `src/cli.ts` 薄胶水层——纯函数才能用临时目录 fixture 直接单测（见 `src/doctor/`、`src/dashboard/`）。
- 2026-07-03 只读环境探测调用外部命令时用 `execFileSync(command, [...args])`（不经 shell、免转义），并在命令缺失/非目标环境时降级返回 null/false；会改变状态或决定正确性的命令不得套用此降级语义（见 doctor 的 Git 探测与 process-tree 的终止确认对比）。
- 2026-07-03 CLI 参数非法值在 `parseCliArgs` 内抛错、由 `main()` try/catch 捕获打印并返回退出码 1，不把 `NaN`/越界值静默传给下游（见 `--stale-days` 只接受非负整数，且校验的是字面量 `/^\d+$/` 而非 `Number()` 转换结果——否则空串/`0x10`/`1e2` 会被静默接受）。
- 2026-07-22 CLI 全局元入口（`help`/`-h`/`--help`）必须先于子命令必填项与数值校验判定，并在 `main()` 的任何 workspace、锁、网络、端口或 runner 副作用前返回；源码单测之外，构建阶段还要真实执行 `dist/cli.js --help`，防止 npm bin 入口与源码合同分叉。
- 2026-07-04 机器可读输出（`--json` 类）的契约：stdout 恒为单个可 `JSON.parse` 的对象（错误态也输出 `{error, ...}` 对象而非裸文本），警告/提示一律走 stderr 且由 `src/cli.ts` 层发出（render 纯函数只产 stdout 文本与退出码）；测试断言用「`console.log` spy 恰被调用一次 + 对该次参数整体 `JSON.parse`」的不变式，强于正则匹配（见 `renderStatusJson` 与 cli.test.ts 的 status --json 用例）。
- 2026-07-08 展示/渲染层消费宽松解析产物时（`tryReadPrd` 无逐字段守卫——与 `tryReadState` 的读入守卫模式不同，属历史设计），任何值插进输出标记前必须统一走「空值兜底+转义」helper（见 render.ts `text()`），不逐点裸插——缺字段的合法 JSON 会让裸插值抛 TypeError，造成「status 正常降级而验证报告崩」的消费端分叉；段级配置已有单源守卫的直接复用（`readQualityChecks`/`readModelsConfig`），并且其 warnings 必须透出到呈现面，否则「配置非法」与「未配置」不可区分。
- 2026-07-08 跨文件消费的 notes 行前缀/标签一律从 gate.ts 导出常量做单源（`ARBITRATION_PREFIXES`、`GATE_FAIL_LINE_PREFIX`、`VALIDATOR_FAIL_LINE_PREFIX`、`BLOCKED_LINE_PREFIX`），所有生产/消费方 import 同一常量；测试对这些前缀保留字面量断言、不 import 实现常量——字面量断言即格式契约守卫，任何一方单独改措辞立刻红。
- 2026-07-08 主循环内的增强副产物（证据记录、自动验证报告）写入失败只 warn（同类告警去重一次），不改循环控制流与退出码；用户显式调用同一能力时仍须以非零退出报告失败（对比 loop.ts `recordEvidence`/自动 writeReport 与 CLI `report`）。
- 2026-07-08 多写方共享的追加式记录文件用 JSONL（每行一条独立 JSON 带 `source` 字段）：读取端逐行解析+逐字段守卫+未知 type 跳过计数（前向兼容，新版本写的类型旧消费方不炸），坏行只损失自己；「文件不存在」（ENOENT）是唯一合法空态，其余 IO 故障必须上抛——把 EACCES/EISDIR 伪装成「零记录」是审计信道的假阴性（见 `evidence.ts readEvidence`）。
- 2026-07-22 可变状态里的瞬时失败详情必须在机械确认失败的同一时点快照进 append-only 证据，不能等收口时从最终 state/progress 反推——成功重试会清空 notes、覆盖现场。生产端只保留接近失败点的有界尾部，读取端对同名字段逐类型/长度守卫，报告端折叠并按纯文本转义；当前门禁 outputTail 与引擎接受的 Validator failed claim 共用 2000 字符单源边界（见 `clipEvidenceDiagnostic`、`diagnosticTail`、`validatorDiagnostic`）。
- 2026-07-08 新增 workspace 运行产物时三处必须同步：prd-to-json 归档清单的**复制**动作、**删除**动作（残留旧轮数据会污染新轮）、以及报告等消费端的文件集合——任何一处缺席都是「归档回看断链」或「新轮红旗区被旧轮污染」（0.20.0 终审实证：tampered 存档曾三处全缺）。
- 2026-07-16 workspace 中需要“旧版或新版、绝不半份”的覆盖写一律走 `writeFileAtomicSync`（fs-atomic 的 tmp+rename），不裸用 `writeFileSync`——包括 prd.json/state.json 及其归档，也包括可重生成但会被人直接打开裁决的 report.html。进程中途被杀只损失 tmp、目标文件永远完整；append-only 信道（evidence.jsonl）不适用此模式。
- 2026-07-22 共享 state 里的 agent 声明与引擎事实必须分层：builder 只能写 `passes=true` 候选，Validator 只能写 `source=validator` 的结构化 claim，`validated`、retry/blocked/notes 与最终 verdict 全由引擎消费 claim 后写入；所有选 story、收敛、status、dashboard、report 统一复用 `isStoryPassed`（或等价的 `passes && validated`）。异常/跳过/协议 invalid 与启动恢复都要清掉未签发凭证的候选 true（ADR-013、015）。
- 2026-07-22 agent 结果协议不能把“文件存在/进程退出 0”当成功：request 必须带一次性 ID、精确 story、输入快照 hash 和可用的产物身份，result 要版本化、逐字段/大小守卫并回显绑定；每轮先清旧文件，缺失/畸形/错配/输入变化一律 fail closed。claim 与 engine protocol verdict 分 source 留痕，nonce/hash 只提供新鲜度和身份对账，不得文案升级成密码学防伪（见 `validation-protocol.ts`、ADR-015）。
- 2026-07-22 workspace 是运行时边界，不是功能提交的一部分：prd-to-json 首次写入前用 `git ls-files` + `git check-ignore --no-index` 检查“已跟踪/未忽略”两种风险，doctor 只读复核；builder 只显式 stage story 文件、检查暂存清单、提交成功后才回写 state/progress。自动化不得替用户修改 `.gitignore`、执行 `git rm --cached` 或重置既有暂存区。
- 2026-07-22 收口副产物必须沿用主流程已经建立的信任来源：loop 自动报告只消费终轮 PRD guard 返回的冻结快照并显式标注来源，不能在裁决完成后重新读取 agent 可改写的磁盘 PRD；手动报告没有该信任来源，只能标成磁盘读取（ADR-014）。
- 2026-07-22 会在超时后继续读写 workspace 的子进程调用，Promise 只能在整棵进程树确认退出后结算；POSIX 用独占进程组 SIGTERM→宽限→SIGKILL 并探活确认，Windows 等待 `taskkill /T /F`。agent 与机械门禁必须复用 `process-tree.ts`，禁止一侧等待退出、另一侧只安排延时补杀后立即返回。
- 2026-07-22 无人值守子进程的错误恢复不能依赖当时终端滚屏：stdout/stderr 用 pipe+tee 保持实时可见，同时只滚动保留统一上限的尾部；duration 必须覆盖超时后的整棵进程树收口。成功 transcript 不持久化，异常尾部才进入 evidence/status/report；provider 的人类可读 token/费用文案不得用正则伪装成稳定计量，需等结构化 adapter 合同（ADR-016）。
- 2026-07-22 skill 要改写 workspace 前，先通过 doctor 读取工作区锁结论，完成只读准备后在首次真实写入前再次检查；活锁、无法判定或结论变化都保持零写入，陈旧/损坏锁不由 skill 删除。双检查只缩小 TOCTOU 窗口，文案不得把它冒充 O_EXCL 机械互斥。
- 2026-07-16 把 CLI 传入的 workspace 路径与项目根拼接时用 `resolve` 不用 `join`——`--workspace` 可传绝对路径，`join` 会把已是绝对路径的段原样拼在 root 之下产生不存在的路径，检查类消费方表现为假阴性（doctor 的锁检查「引擎运行中却报无锁」与门禁配置检查同款实翻，0.21.0 终审端到端实测检出）。
- 2026-07-16 测试需要在异步流程的特定时刻采样外部状态（文件存在性等）时，用被测代码的可观察事件做同步点（如捕获特定日志行后再采样），不用固定毫秒 sleep——墙钟采样与子进程冷启动赛跑必抖（keepOpen 锁释放用例 50ms 采样 8 跑 4 挂；换「运行结束」日志行同步后确定性成立，10 连跑稳定，0.21.0 实证）。
- 2026-07-20 引擎对 agent 的一切判定只消费机械信号：进程结局按超时标志与退出码三分（completed/timeout/error），产物变化按轮首/轮后内容字符串对比（不 parse）——agent 自己声明的「做完了」不可信，与机械门禁不可共谋同源（见 loop.ts `outcomeOf` 与 no-op 双无变化判定；ADR-009）。给判定加新维度时先自问是否仍是引擎自己观测的确定性事实。
- 2026-07-20 给循环体新增「每轮必做」的收口逻辑（留痕、篡改检测、收敛判定）时，先枚举退出点全集——continue、break、快路径 return，以及循环自然耗尽这个隐式出口——再抽 helper 单源逐点接入；枚举必须在 plan 阶段完成，不能靠 review 逐个数（0.22.0 实证：终轮篡改检测五个点位分四批才收齐，每处都是审查抓漏；见 `tamperCheckBeforeExit` 四调用点+post-loop 收口、`convergedExit` 两出口单源）。
- 2026-07-23 开发过程约束与最终机械结论必须分层：TDD skill 的 RED/GREEN 顺序只能形成可复核的 agent 声明；宿主 hook 只给提交前反馈；引擎必须在 Validator 前独立重跑冻结政策下的 coverageCheck，不能复用 hook 通过结论或从 Git 时间推断“先写测试”（ADR-017）。
- 2026-07-23 把项目原生命令升级为安全门禁时，冻结的不能只有命令字符串：同时枚举并摘要保护阈值、排除、零测试、基线和 diff-coverage 委托文件，限制 realpath 在项目根内，再检查基线后生产路径新增的 ignore marker。摘要能发现常见政策漂移，但同权限工具链仍不防伪，文案不得越界（见 `tdd-gate.ts`、ADR-017）。
- 2026-07-23 宿主 hook 读取外部 workspace 时必须与项目根成对绑定：只有绝对 `CODING_X_WORKSPACE` 搭配 canonical `CODING_X_PROJECT_ROOT` 且后者等于当前 Git 根才采用，否则回退 `<git-root>/.workspace`；禁止单独信任会跨项目遗留的 workspace 环境变量。
- 2026-07-23 runner 的“插件发现”与“hook 实际调用”必须分层实测，不能由清单 schema 推断接线成功：Cursor Agent CLI `2026.07.20-8cc9c0b` 能通过插件目录发现能力，但提交前执行器实际读取项目根 `.cursor/hooks.json`；且 `failClosed` 下成功脚本必须输出原生明确放行 JSON，空 stdout 会被当作失败。对这种宿主差异使用显式、可逆的项目适配器，复制构建产物避免提交时依赖机器路径或联网，并保留引擎最终门禁（ADR-017）。
- 2026-07-24 PR 会修改质量契约或工作流时，裁决政策必须来自默认分支 base，PR head 只作为待检查的数据；项目命令可在无敏感权限、无持久 Git 凭据的隔离 job 中执行 head，AI job 只通过 API 读取 diff/文件且绝不签出或运行 head。两类任务不能因复用方便合并到同一权限域（ADR-018）。
- 2026-07-24 远端质量结论必须同时绑定 repository、PR、base SHA、head SHA、契约来源和评审轮次；任意新提交都重跑所有适用轴。可复制的 PR 文本、本地 receipt、同名 commit status 或旧 head 的成功结果均不能当作最新提交通过。
- 2026-07-24 外部调用只有三态：完整证据为 passed，明确问题为 failed，资料/凭据/权限/模型/格式/提交身份任一不可核验为 unverifiable；异常不得吞掉后返回“跳过”或“默认通过”。需要人判断的问题继续阻断，自动确认参数不能替人作产品裁决。
- 2026-07-24 项目原生检查必须由受 Git 管理的契约显式声明命令、工作目录和适用路径；coding-x 可以发现候选，但写入前必须让人确认。下游只依赖 Git 与能用退出状态表达结论的命令，禁止把 coding-engine 的 npm/Vitest/TypeScript 约定推广成跨项目合同。
- 2026-07-24 GitHub ruleset 是真实合并控制，CLI 写文件和本地 review 都不是；配置后必须回读语义而非只相信写 API 成功。管理员仍能删除规则，所以定时 doctor 要检查启用状态、所需检查及应用来源、协作者对应的审核人数、发布引用和异常期限，漂移即失败。
- 2026-07-24 受管 workflow 运行固定版本的 coding-x 时，不能在项目目录直接 `npx coding-x@<version>`：当下游仓库本身也叫 `coding-x`，npm 会优先按当前同名项目解析，表现为发布包存在但 bin 找不到。统一用 `npm exec --prefix "$RUNNER_TEMP" --package="coding-x@<exact>" -- coding-x ...` 隔离安装，同时保留调用时的项目工作目录；`--prefix` 必须指向已存在目录，npm 不会替调用方创建缺失的末级目录。
- 2026-07-24 provider 的可用额度不是模型 catalog 的理论上下文：GitHub Models 免费层按账号限制单次输入/输出、每分钟和每日请求。超限处理必须在首次调用前按完整 prompt 预算，无损拆分 source、diff 或两者，使叶子片段共同覆盖完整评审空间并逐片 fail closed；不得截断证据、丢弃失败片段或让后一个片段降低前一个片段的严重度。不同 PR 共享模型额度时还必须在仓库级串行，单个 PR 内串行不够。
- 2026-07-24 发布验证不能只按 Check Run 名称查 success；必须从启用中的 ruleset 取得预期 GitHub App ID，并核对关联 PR head 的最新同源结果。紧急发布只能消费受 Git 管理、未过期、未关闭且 commit 是发布祖先的 delivery 记录，日志必须明确标成异常发布。

## 陷阱

<!-- 容易再次踩、与本项目框架/数据边界/路由方式强相关的坑 -->

- 2026-07-03 需要区分持久化文件“缺失”与“损坏”时，先 `existsSync` 再调用会把两者都折叠成 `null` 的 `tryReadX`。文件缺失可以是 legacy 迁移信号；文件存在但损坏必须 fail-closed，不能复用会抽取历史字段的迁移初始化——state 的 report/status/dashboard 统一经 `readDisplayState` 全部归零并显式标记损坏，避免陈旧 passes:true 复活成假绿（ADR-014）。
- 2026-07-03 临时目录里跑 git 的单测须先 `git config commit.gpgsign false`（否则全局签名配置会让 commit 失败），并用 `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE` 固定日期（`git log %cs` 取的是 committer date），否则依赖提交日期的断言不稳定（见 doctor.test.ts 的 git fixture）。
- 2026-07-03 单测里的路径断言用 `join('docs', 'sub', 'x.md')` 拼接，不要硬编码 `/` 分隔的字面串，否则 Windows 上会假失败。
- 2026-07-04 版本号除 package.json 外还有多处落点（package-lock、`.claude-plugin/`/`.cursor-plugin/`/`.codex-plugin/` 三个插件清单），靠人记必漂移——0.6.0–0.7.1 期间插件清单曾停在 0.5.1 三个版本没人发现。机械防线（三道）：`npm version` 生命周期钩子跑 `build/sync-plugin-versions.mjs` 自动同步；`build/version-consistency.test.mjs` 随 npm test 常态校验全部落点一致（本地与 CI test.yml，漂移提交即红）；publish.yml 发版门禁兜底。新增版本号落点时登记进 `PLUGIN_MANIFESTS`（或一致性测试的 entries）即可全线生效。同理，会随版本演进的枚举内容（如清单 description 里列 skills/commands 名单）不要复制到多处，写稳定表述。
- 2026-07-04 `.workspace/` 换新 PRD（branchName 变更）时，归档后必须删除旧 `state.json`——story id 惯例都从 US-001 起编，新旧几乎必然撞车，而引擎 `ensureStateFile` 信任既存文件，会把旧轮的 `passes: true` 误判为新 story 已完成、循环空转结束。
- 2026-07-04 progress.md 里 `## ` 开头的标题不全是迭代记录（顶部还有 `## Codebase Patterns` 汇总段）：结构化提取迭代记录必须按日期前缀 `/^## \d{4}-\d{2}-\d{2}/` 匹配，不能只按标题层级取（见 `latestProgressTitle` 的修复）。
- 2026-07-08 按「列表位置序号」关联到人可改写文档条目的数据（如证据登记的 acIndex → 验收标准列表），源文档再派生/条目改写后旧关联会静默错挂到新内容上——生命周期动作（再派生、换 PRD）必须归档并清空此类位置关联数据，旧证据一律作废重验（见 prd-to-json 再派生节清 evidence.jsonl；0.20.0 终审需人裁决项）。
- 2026-07-08 macOS BSD grep 对多个中文模式的交替匹配（`grep -o "模式A\|模式B\|模式C"`）存在漏匹配怪癖（0.19.0/0.20.0 两轮发版冒烟均实证误报「未渲染」）：验证产物内容时用单模式逐一 grep，多模式交替的计数结果不可作为「区块缺失」的证据。
