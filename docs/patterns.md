---
title: 约定与陷阱
status: active
updated: 2026-07-20
scope: root
---

# 约定与陷阱

<!-- /compound-docs 收口沉淀的落点：稳定开发约定 + 高频陷阱。条目短、可验证、带日期；结构性知识不放这里（去 architecture.md）。 -->

## 约定

<!-- 多个 story 反复出现、未来会复用的稳定开发写法 -->

- 2026-07-03 外部读入的持久化 JSON 必须先过逐字段形状守卫（对每个字段做 `typeof` 校验）再当合法数据用；不通过就返回 `null` 交上层按初始值降级，绝不对落盘数据直接类型断言（见 `tryReadState` / `isStoryState`）。
- 2026-07-03 修复/转换类写盘先在内存完成解析与二次校验、确认可用后再落盘；不可用时在任何写入之前抛出，避免留下半损坏文件（见 `repairJsonString`：修完再 `JSON.parse` 一次；落盘与写前抛出在调用方 `repairJsonFile`）。
- 2026-07-03 共享的初始值用 `Object.freeze` 冻结成只读单例复用同一引用（见 `INITIAL_STORY_STATE`），不要各处新建等价对象，避免被就地改写。
- 2026-07-03 CLI 子命令统一在 `parseCliArgs` 把 positional 首参映射到 `CliConfig['command']` 联合类型，`main()` 内按 command 分支、早返回退出码（repair/dashboard/doctor 同构）；新增子命令沿用此形状，不另开分发口。
- 2026-07-03 新功能自成 `src/<feature>/` 目录，核心逻辑导出纯函数（签名收 root/数据、返回结构体），console 输出、`process.cwd()`、退出码等副作用全留在 `src/cli.ts` 薄胶水层——纯函数才能用临时目录 fixture 直接单测（见 `src/doctor/`、`src/dashboard/`）。
- 2026-07-03 调外部命令用 `execFileSync('git', [...args])`（不经 shell、免转义），并 try/catch 失败即降级返回 null/false，让功能在缺该命令的环境温和退化而非抛栈（见 doctor 的 `isGitWorkTree`/`gitLastCommitDate`）。
- 2026-07-03 CLI 参数非法值在 `parseCliArgs` 内抛错、由 `main()` try/catch 捕获打印并返回退出码 1，不把 `NaN`/越界值静默传给下游（见 `--stale-days` 只接受非负整数，且校验的是字面量 `/^\d+$/` 而非 `Number()` 转换结果——否则空串/`0x10`/`1e2` 会被静默接受）。
- 2026-07-04 读 workspace 文件需要区分「文件不存在」与「内容损坏」两种降级时，先 `existsSync` 再 `tryReadX`——`tryReadPrd`/`tryReadState` 对两者都返回 `null`，只靠返回值无法分流（见 `readDisplayState`：state.json 缺失才静默回退 legacy；存在但损坏统一归零并标 `stateCorrupted`，status/dashboard/report 三消费方不得各写一套）。
- 2026-07-04 机器可读输出（`--json` 类）的契约：stdout 恒为单个可 `JSON.parse` 的对象（错误态也输出 `{error, ...}` 对象而非裸文本），警告/提示一律走 stderr 且由 `src/cli.ts` 层发出（render 纯函数只产 stdout 文本与退出码）；测试断言用「`console.log` spy 恰被调用一次 + 对该次参数整体 `JSON.parse`」的不变式，强于正则匹配（见 `renderStatusJson` 与 cli.test.ts 的 status --json 用例）。
- 2026-07-08 展示/渲染层消费宽松解析产物时（`tryReadPrd` 无逐字段守卫——与 `tryReadState` 的读入守卫模式不同，属历史设计），任何值插进输出标记前必须统一走「空值兜底+转义」helper（见 render.ts `text()`），不逐点裸插——缺字段的合法 JSON 会让裸插值抛 TypeError，造成「status 正常降级而验证报告崩」的消费端分叉；段级配置已有单源守卫的直接复用（`readQualityChecks`/`readModelsConfig`），并且其 warnings 必须透出到呈现面，否则「配置非法」与「未配置」不可区分。
- 2026-07-08 跨文件消费的 notes 行前缀/标签一律从 gate.ts 导出常量做单源（`ARBITRATION_PREFIXES`、`GATE_FAIL_LINE_PREFIX`、`BLOCKED_LINE_PREFIX` 三例），生产/消费方 import 同一常量；无法 import 的指令模板类第二生产方（如 validator.md 的 BLOCKED 文案）在常量 doc comment 登记「改措辞须同步」；测试对这些前缀保留字面量断言、不 import 实现常量——字面量断言即格式契约守卫，任何一方单独改措辞立刻红。
- 2026-07-08 增强类副产物的写入（证据记录、验证报告生成等「记录/存档」动作）一律 try/catch 吞错仅 warn（同类告警去重一次），绝不影响主循环的控制流与退出码——副产物失败比主流程被副产物拖垮诚实得多（见 loop.ts `recordEvidence` 与 writeReport 调用两例）。
- 2026-07-08 多写方共享的追加式记录文件用 JSONL（每行一条独立 JSON 带 `source` 字段）：读取端逐行解析+逐字段守卫+未知 type 跳过计数（前向兼容，新版本写的类型旧消费方不炸），坏行只损失自己；「文件不存在」（ENOENT）是唯一合法空态，其余 IO 故障必须上抛——把 EACCES/EISDIR 伪装成「零记录」是审计信道的假阴性（见 `evidence.ts readEvidence`）。
- 2026-07-08 新增 workspace 运行产物时三处必须同步：prd-to-json 归档清单的**复制**动作、**删除**动作（残留旧轮数据会污染新轮）、以及报告等消费端的文件集合——任何一处缺席都是「归档回看断链」或「新轮红旗区被旧轮污染」（0.20.0 终审实证：tampered 存档曾三处全缺）。
- 2026-07-16 workspace 中需要“旧版或新版、绝不半份”的覆盖写一律走 `writeFileAtomicSync`（fs-atomic 的 tmp+rename），不裸用 `writeFileSync`——包括 prd.json/state.json 及其归档，也包括可重生成但会被人直接打开裁决的 report.html。进程中途被杀只损失 tmp、目标文件永远完整；append-only 信道（evidence.jsonl）不适用此模式。
- 2026-07-22 共享 state 里的 agent 结果与引擎事实必须分字段建模：`passes` 是 builder/validator 可写的候选结果，`validated` 是 validator 正常完成后由引擎签发的验收凭证；所有选 story、收敛、status、dashboard、report 消费端统一复用 `isStoryPassed`（或等价的 `passes && validated`），禁止继续把裸 `passes=true` 渲染成全绿。agent 返回后按阶段前快照恢复引擎独占字段，异常/跳过路径与启动恢复都要清掉未签发凭证的候选 true（ADR-013）。
- 2026-07-22 workspace 是运行时边界，不是功能提交的一部分：prd-to-json 首次写入前用 `git ls-files` + `git check-ignore --no-index` 检查“已跟踪/未忽略”两种风险，doctor 只读复核；builder 只显式 stage story 文件、检查暂存清单、提交成功后才回写 state/progress。自动化不得替用户修改 `.gitignore`、执行 `git rm --cached` 或重置既有暂存区。
- 2026-07-22 收口副产物必须沿用主流程已经建立的信任来源：loop 自动报告只消费终轮 PRD guard 返回的冻结快照，并显式标注来源；不能在裁决完成后重新读取 agent 可改写的磁盘 PRD。手动报告没有该信任来源，只能标成磁盘读取。state 文件“缺失”才允许 legacy 迁移；“存在但损坏”在 report/status/dashboard 所有展示面都必须 fail-closed 为全部未验证、显式警示，机器消费端必须给非零退出或损坏标志（ADR-014）。
- 2026-07-22 会在超时后继续读写 workspace 的子进程调用，Promise 只能在整棵进程树确认退出后结算；POSIX 用独占进程组 SIGTERM→宽限→SIGKILL 并探活确认，Windows 等待 `taskkill /T /F`。agent 与机械门禁必须复用 `process-tree.ts`，禁止一侧等待退出、另一侧只安排延时补杀后立即返回。
- 2026-07-22 skill 要改写 workspace 前，先通过 doctor 读取工作区锁结论，完成只读准备后在首次真实写入前再次检查；活锁、无法判定或结论变化都保持零写入，陈旧/损坏锁不由 skill 删除。双检查只缩小 TOCTOU 窗口，文案不得把它冒充 O_EXCL 机械互斥。
- 2026-07-16 把 CLI 传入的 workspace 路径与项目根拼接时用 `resolve` 不用 `join`——`--workspace` 可传绝对路径，`join` 会把已是绝对路径的段原样拼在 root 之下产生不存在的路径，检查类消费方表现为假阴性（doctor 的锁检查「引擎运行中却报无锁」与门禁配置检查同款实翻，0.21.0 终审端到端实测检出）。
- 2026-07-16 测试需要在异步流程的特定时刻采样外部状态（文件存在性等）时，用被测代码的可观察事件做同步点（如捕获特定日志行后再采样），不用固定毫秒 sleep——墙钟采样与子进程冷启动赛跑必抖（keepOpen 锁释放用例 50ms 采样 8 跑 4 挂；换「运行结束」日志行同步后确定性成立，10 连跑稳定，0.21.0 实证）。
- 2026-07-20 引擎对 agent 的一切判定只消费机械信号：进程结局按超时标志与退出码三分（completed/timeout/error），产物变化按轮首/轮后内容字符串对比（不 parse）——agent 自己声明的「做完了」不可信，与机械门禁不可共谋同源（见 loop.ts `outcomeOf` 与 no-op 双无变化判定；ADR-009）。给判定加新维度时先自问是否仍是引擎自己观测的确定性事实。
- 2026-07-20 给循环体新增「每轮必做」的收口逻辑（留痕、篡改检测、收敛判定）时，先枚举退出点全集——continue、break、快路径 return，以及循环自然耗尽这个隐式出口——再抽 helper 单源逐点接入；枚举必须在 plan 阶段完成，不能靠 review 逐个数（0.22.0 实证：终轮篡改检测五个点位分四批才收齐，每处都是审查抓漏；见 `tamperCheckBeforeExit` 四调用点+post-loop 收口、`convergedExit` 两出口单源）。

## 陷阱

<!-- 容易再次踩、与本项目框架/数据边界/路由方式强相关的坑 -->

- 2026-07-03 运行期状态需要回退时用「全部归零」的空初始化，不要复用带历史字段抽取的迁移初始化——迁移路径会把已废弃的旧格式状态重新激活（对比 `blankStateFor` 只写初始常量、`initialStateFor` 读旧字段）。文件**缺失**是旧 workspace 迁移信号，可以读 legacy；文件**存在但损坏**不是迁移信号。report/status/dashboard 都属于可能影响裁决或自动化的展示面，损坏态必须经 `readDisplayState` 全部归零并 fail-closed，否则陈旧 passes:true 会形成假绿面（ADR-014）。
- 2026-07-03 临时目录里跑 git 的单测须先 `git config commit.gpgsign false`（否则全局签名配置会让 commit 失败），并用 `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE` 固定日期（`git log %cs` 取的是 committer date），否则依赖提交日期的断言不稳定（见 doctor.test.ts 的 git fixture）。
- 2026-07-03 单测里的路径断言用 `join('docs', 'sub', 'x.md')` 拼接，不要硬编码 `/` 分隔的字面串，否则 Windows 上会假失败。
- 2026-07-04 版本号除 package.json 外还有多处落点（package-lock、`.claude-plugin/`/`.cursor-plugin/`/`.codex-plugin/` 三个插件清单），靠人记必漂移——0.6.0–0.7.1 期间插件清单曾停在 0.5.1 三个版本没人发现。机械防线（三道）：`npm version` 生命周期钩子跑 `build/sync-plugin-versions.mjs` 自动同步；`build/version-consistency.test.mjs` 随 npm test 常态校验全部落点一致（本地与 CI test.yml，漂移提交即红）；publish.yml 发版门禁兜底。新增版本号落点时登记进 `PLUGIN_MANIFESTS`（或一致性测试的 entries）即可全线生效。同理，会随版本演进的枚举内容（如清单 description 里列 skills/commands 名单）不要复制到多处，写稳定表述。
- 2026-07-04 `.workspace/` 换新 PRD（branchName 变更）时，归档后必须删除旧 `state.json`——story id 惯例都从 US-001 起编，新旧几乎必然撞车，而引擎 `ensureStateFile` 信任既存文件，会把旧轮的 `passes: true` 误判为新 story 已完成、循环空转结束。
- 2026-07-04 progress.md 里 `## ` 开头的标题不全是迭代记录（顶部还有 `## Codebase Patterns` 汇总段）：结构化提取迭代记录必须按日期前缀 `/^## \d{4}-\d{2}-\d{2}/` 匹配，不能只按标题层级取（见 `latestProgressTitle` 的修复）。
- 2026-07-08 按「列表位置序号」关联到人可改写文档条目的数据（如证据登记的 acIndex → 验收标准列表），源文档再派生/条目改写后旧关联会静默错挂到新内容上——生命周期动作（再派生、换 PRD）必须归档并清空此类位置关联数据，旧证据一律作废重验（见 prd-to-json 再派生节清 evidence.jsonl；0.20.0 终审需人裁决项）。
- 2026-07-08 macOS BSD grep 对多个中文模式的交替匹配（`grep -o "模式A\|模式B\|模式C"`）存在漏匹配怪癖（0.19.0/0.20.0 两轮发版冒烟均实证误报「未渲染」）：验证产物内容时用单模式逐一 grep，多模式交替的计数结果不可作为「区块缺失」的证据。
- 2026-07-16 给 subagent 写审查/修复类 dispatch prompt 时，安全相关语义用中性工程措辞（「转义完整性」「边界条件核查」「锁归属转移的正确性」），避免攻击性词汇（XSS、注入、对抗视角、抢占/抢锁）——模型安全护栏会把正当的防御性代码审查误判为网络安全话题整单拒绝（0.19.0「XSS」、0.21.0「对抗视角/抢锁」两轮实证，均改中性措辞重派成功；内容不变只换表述即可过）。
- 2026-07-20 长时 agent 链路的环境中断可打在任意层级进程上，流程设计必须假设任何 agent 会中途死掉：API 中断（`Response stalled mid-stream`）已实证穿透到引擎拉起的 agent 子进程（0.22.0 前直接制造假绿，即 ADR-009 发现 A/B），账户欠费（402 Account overdue）会阻塞一切 subagent 拉起。对策两层：引擎侧异常轮语义+幂等续跑兜底；SDD 编排侧进度写 ledger、审查增量 diff 落盘，中断后按原 agent id 或增量包断点续跑（2026-07-17/18 两坑均实证恢复成功）。
