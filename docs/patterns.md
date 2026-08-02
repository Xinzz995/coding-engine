---
title: 约定与陷阱
status: active
updated: 2026-08-02
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
- 2026-07-08 主循环内的增强副产物（证据记录、自动验证报告）写入失败只 warn（同类告警去重一次），不改循环控制流与退出码；用户显式调用同一能力时仍须以非零退出报告失败（对比 loop.ts `recordEvidence`/自动 writeReport 与 CLI `report`）。但 workspace owner 丢失、子进程集合未确认清空或进入隔离态不是普通副产物故障：这时不得继续写证据或报告，必须保留隔离并停止；当前由 ADR-021 的 session/coordinator/writer 协议机械执行。
- 2026-07-08 多写方共享的追加式记录文件用 JSONL（每行一条独立 JSON 带 `source` 字段）：读取端逐行解析+逐字段守卫+未知 type 跳过计数（前向兼容，新版本写的类型旧消费方不炸），坏行只损失自己；「文件不存在」（ENOENT）是唯一合法空态，其余 IO 故障必须上抛——把 EACCES/EISDIR 伪装成「零记录」是审计信道的假阴性（见 `evidence.ts readEvidence`）。
- 2026-07-22 可变状态里的瞬时失败详情必须在机械确认失败的同一时点快照进 append-only 证据，不能等收口时从最终 state/progress 反推——成功重试会清空 notes、覆盖现场。生产端只保留接近失败点的有界尾部，读取端对同名字段逐类型/长度守卫，报告端折叠并按纯文本转义；当前门禁 outputTail 与引擎接受的 Validator failed claim 共用 2000 字符单源边界（见 `clipEvidenceDiagnostic`、`diagnosticTail`、`validatorDiagnostic`）。
- 2026-07-08 新增 workspace 运行产物时三处必须同步：`product-mutations` 固定动作里的归档白名单、失效清理白名单，以及报告等消费端的文件集合——调用方不得自行传入复制、删除或归档路径。任何一处缺席都是「归档回看断链」或「新轮红旗区被旧轮污染」（0.20.0 终审实证：tampered 存档曾三处全缺）。
- 2026-07-16 workspace 中需要“旧版或新版、绝不半份”的父进程覆盖写一律走当前 session 的 `WorkspaceWriter`；涉及多文件归档、删除和安装则走固定 mutation，不能裸用 `writeFileSync` 或只靠单文件 tmp+rename。append-only 信道同样必须经 writer 追加，不能把旧 `fs-atomic` helper 当正式写入口（ADR-021）。
- 2026-07-22 共享 state 里的 agent 声明与引擎事实必须分层：builder 只能写 `passes=true` 候选，Validator 只能写 `source=validator` 的结构化 claim，`validated`、凭证、retry/blocked/notes 与最终 verdict 全由引擎消费 claim 后写入。Story 完成不能再只看 `passes && validated`，必须用统一评估同时核对候选、完整凭证、当前 Git HEAD、Story ID 与有序 AC；非 blocked Story 的有序凭证集合摘要还要绑定 Final Review。凭证过期时保留实现候选并进入 validation-only；环境或协议不可验证时继续保留候选并失败关闭，只有明确验证失败才清除。status、report、dashboard 读取时只在内存撤销旧绿灯，正式循环才写回（ADR-013、015、020）。
- 2026-07-22 agent 结果协议不能把“文件存在/进程退出 0”当成功：request 必须带一次性 ID、精确 story、输入快照 hash 和可用的产物身份，result 要版本化、逐字段/大小守卫并回显绑定；每轮先清旧文件，缺失/畸形/错配/输入变化一律 fail closed。claim 与 engine protocol verdict 分 source 留痕，nonce/hash 只提供新鲜度和身份对账，不得文案升级成密码学防伪（见 `validation-protocol.ts`、ADR-015）。
- 2026-07-22 workspace 是运行时边界，不是功能提交的一部分：`prd-to-json` 对用户给出的 workspace 参数只做只读 Git 隔离核对，并把同一个原始参数逐字传给 `workspace apply-prd`；skill 只在系统临时目录准备候选和请求，正式命令才在租约内写 workspace。builder 只显式 stage story 文件、检查暂存清单、提交成功后才回写 state/progress。自动化不得替用户修改 `.gitignore`、执行 `git rm --cached` 或重置既有暂存区。
- 2026-07-22 收口副产物必须沿用主流程已经建立的信任来源：loop 自动报告只消费终轮 PRD guard 返回的冻结快照并显式标注来源，不能在裁决完成后重新读取 agent 可改写的磁盘 PRD；手动报告没有该信任来源，只能标成磁盘读取（ADR-014）。
- 2026-07-22 会继续读写 workspace 的受管子进程，只有 coordinator 已确认 containment 清空且文件 delta 合法后才能结算并允许父进程继续写。POSIX 使用独占进程组，Windows 使用 Job Object；父进程崩溃、终止失败、越界变化或未完成 mutation 都保留隔离并要求显式恢复，不得把根进程退出当作集合清空证明（ADR-021）。
- 2026-07-22 无人值守子进程的错误恢复不能依赖当时终端滚屏：stdout/stderr 用 pipe+tee 保持实时可见，同时只滚动保留统一上限的尾部；duration 必须覆盖超时后的受管进程集合收口。POSIX 主动 `setsid` 或其他平台 containment 逃逸是明确非目标，文案不得把它升级成操作系统沙箱或任意恶意后代的完整证明。成功 transcript 不持久化，异常尾部才进入 evidence/status/report；provider 的人类可读 token/费用文案不得用正则伪装成稳定计量，需等结构化 adapter 合同（ADR-016、021）。
- 2026-07-22 skill 不直接改写 workspace，也不通过双 doctor 检查模拟互斥：只在系统临时目录生成一次性候选/请求，再调用固定的 `workspace apply-prd` 或 `workspace record-review-decision` 入口。正式命令必须在同一 session 中完成租约获取、实时输入重核和产品动作；租约或输入失效时保持零业务写入，不允许 skill 删除协议根、租约或恢复记录。
- 2026-08-02 稳定裁判 N 验证候选 N+1 时，候选准备不能手写新版 workspace，也不能让普通版本检查降级：只允许同一绝对候选 CLI 依次执行 `workspace init`、`doctor --shadow`、`workspace apply-prd --shadow` 和最终 shadow run。doctor/apply 健康也返回 7，调用方必须同时核对结构化状态；任一非版本错误仍失败。Story 验收环境摘要必须在测试注入之后继续绑定实际 coding-x 版本与 formal/shadow 模式，防止测试 seam 或复制旧凭证绕过重验。
- 2026-07-16 `--workspace` 是一个需要端到端保持身份的输入：CLI 只在边界 canonicalize 一次，skills/commands 对用户显式值原样透传，所有读写和安全分类都复用同一结果。不能在不同阶段分别 `join`、补默认值或改写拼写；绝对路径、相对路径和别名若在不同入口被解释成不同目录，会产生假阴性或绕开同一租约竞争（0.21.0 的 `join` 事故是历史反例）。
- 2026-07-16 测试需要在异步流程的特定时刻采样外部状态（文件存在性等）时，用被测代码的可观察事件做同步点（如捕获特定日志行后再采样），不用固定毫秒 sleep——墙钟采样与子进程冷启动赛跑必抖（keepOpen 锁释放用例 50ms 采样 8 跑 4 挂；换「运行结束」日志行同步后确定性成立，10 连跑稳定，0.21.0 实证）。
- 2026-07-20 引擎对 agent 的一切判定只消费机械信号：进程结局按超时标志与退出码三分（completed/timeout/error），产物变化按轮首/轮后内容字符串对比（不 parse）——agent 自己声明的「做完了」不可信，与机械门禁不可共谋同源（见 loop.ts `outcomeOf` 与 no-op 双无变化判定；ADR-009）。给判定加新维度时先自问是否仍是引擎自己观测的确定性事实。
- 2026-07-20 给循环体新增「每轮必做」的收口逻辑（留痕、篡改检测、收敛判定）时，先枚举退出点全集——continue、break、快路径 return，以及循环自然耗尽这个隐式出口——再抽 helper 单源逐点接入；枚举必须在 plan 阶段完成，不能靠 review 逐个数（0.22.0 实证：终轮篡改检测五个点位分四批才收齐，每处都是审查抓漏；见 `tamperCheckBeforeExit` 四调用点+post-loop 收口、`convergedExit` 两出口单源）。
- 2026-07-23 开发过程约束与最终机械结论必须分层：TDD skill 的 RED/GREEN 顺序只能形成可复核的 agent 声明；宿主 hook 只给提交前反馈；引擎必须在 Validator 前独立重跑冻结政策下的 coverageCheck，不能复用 hook 通过结论或从 Git 时间推断“先写测试”（ADR-017）。
- 2026-07-23 把项目原生命令升级为安全门禁时，冻结的不能只有命令字符串：同时枚举并摘要保护阈值、排除、零测试、基线和 diff-coverage 委托文件，限制 realpath 在项目根内，再检查基线后生产路径新增的 ignore marker。摘要能发现常见政策漂移，但同权限工具链仍不防伪，文案不得越界（见 `tdd-gate.ts`、ADR-017）。
- 2026-07-23 宿主 hook 读取外部 workspace 时必须与项目根成对绑定：只有绝对 `CODING_X_WORKSPACE` 搭配 canonical `CODING_X_PROJECT_ROOT` 且后者等于当前 Git 根才采用，否则回退 `<git-root>/.workspace`；禁止单独信任会跨项目遗留的 workspace 环境变量。
- 2026-07-23 runner 的“插件发现”与“hook 实际调用”必须分层实测，不能由清单 schema 推断接线成功：Cursor Agent CLI `2026.07.20-8cc9c0b` 能通过插件目录发现能力，但提交前执行器实际读取项目根 `.cursor/hooks.json`；且 `failClosed` 下成功脚本必须输出原生明确放行 JSON，空 stdout 会被当作失败。对这种宿主差异使用显式、可逆的项目适配器，复制构建产物避免提交时依赖机器路径或联网，并保留引擎最终门禁（ADR-017）。
- 2026-08-02 检查命令“确实执行过”与“结果被当前提交裁决采用”必须分层：项目检查或 TDD 返回后若 Git HEAD 已变化或不可读，先持久化真实命令事实，再以 `accepted=false` 标明未采用，并在同轮 iteration 记录阶段、预期/实际 HEAD 与有界原因。展示面不得把未采用的成功画成绿灯，也不得把未采用的失败混成普通红灯；修复后必须从完整检查链重新开始。本地 evidence 是诊断，不是远端共享证明。
- 2026-07-26 跨 PRD 与 CI 复用的项目检查只允许一个人工维护来源：质量契约严格解析后由工具派生 PRD 快照和远端工作流；正式运行同时绑定精确 coding-x 版本、规范化契约摘要和逐字段相同的结构化快照。结构化命令默认 `shell=false`，只有用户在契约中显式选择 shell 时才允许管道/重定向；任何一层漂移都停止，不能静默退回旧字符串数组（ADR-018）。
- 2026-07-31 含真实进程树、临时 Git 仓库和平台隔离器的 Vitest 全量回归必须按文件串行；并行争抢会让用于识别真实卡死的 5 秒/10 秒短时限产生级联假失败。不能靠全局放宽时限、盲目重试或人工维护易漏的“串行测试名单”掩盖问题；真实集成流程可有贴合平台实测的独立预算，但单项生产安全判定时限保持不变。唯一的平台重试必须是已识别、可证明安全且有明确上限的系统瞬态；当前只有 Windows 在目标仍不存在并完整复查 source/安全树/commit check 后，对目录 rename 的 `EPERM/EACCES` 按 25/50/100ms 重试。只有五个平台都取得重复稳定数据后才能重新评估并行。
- 2026-08-02 系统临时目录下的固定名称前缀只能说明路径形状，不能证明“仍是本进程创建的目录”。涉及不可信子进程的临时域必须冻结创建身份，固定允许文件和大小，以已打开句柄读取，并在受管进程正常结束、没有外部终止、超时或残留后代后重核身份再清理；任一条件不确定时不得通过路径 `chmod` 或递归删除，应保留现场并让原成功结论变为不可验证。含源码、规格或 Prompt 的现场在创建时请求最小权限；保留时只有 POSIX 已绑定句柄能够重新证明对象、属主、内容并收紧 POSIX 权限位，才记录 `restricted`。Windows、进程未结算、身份或目录树异常、句柄不可用时必须记录保护状态不可验证并要求人工隔离。该状态只证明收口时返回路径的 POSIX 权限位，不证明扩展 ACL，也不证明历史上从未被读取、复制或泄露；诊断不得回显不可信目录项名称。当前 Reviewer 的五类临时域已统一使用该收口规则；该模式不声称抵御同一账号下持续并发的任意外部恶意进程。
- 2026-08-02 项目命令的“输入干净”不能由开发目录的普通 `git status` 证明：ignored 文件、旧依赖和本机配置仍会参与执行。正式机械检查、TDD 与 Validator 必须共享项目外的精确 HEAD 检出，准备命令和允许产物目录由质量契约显式确认；每个阶段前后核对 detached HEAD、tracked tree 和新增/ignored 目录。环境摘要只绑定引擎可重算的控制合同，不宣称封存工具链、网络或提供操作系统文件沙箱（ADR-022）。

## 陷阱

<!-- 容易再次踩、与本项目框架/数据边界/路由方式强相关的坑 -->

- 2026-07-03 需要区分持久化文件“缺失”与“损坏”时，先 `existsSync` 再调用会把两者都折叠成 `null` 的 `tryReadX`。文件缺失可以是 legacy 迁移信号；文件存在但损坏必须 fail-closed，不能复用会抽取历史字段的迁移初始化——state 的 report/status/dashboard 统一经 `readDisplayState` 全部归零并显式标记损坏，避免陈旧 passes:true 复活成假绿（ADR-014）。
- 2026-07-03 临时目录里跑 git 的单测须先 `git config commit.gpgsign false`（否则全局签名配置会让 commit 失败），并用 `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE` 固定日期（`git log %cs` 取的是 committer date），否则依赖提交日期的断言不稳定（见 doctor.test.ts 的 git fixture）。
- 2026-07-03 单测里的路径断言用 `join('docs', 'sub', 'x.md')` 拼接，不要硬编码 `/` 分隔的字面串，否则 Windows 上会假失败。
- 2026-07-04 版本号除 package.json 外还有多处落点（package-lock、`.claude-plugin/`/`.cursor-plugin/`/`.codex-plugin/` 三个插件清单），靠人记必漂移——0.6.0–0.7.1 期间插件清单曾停在 0.5.1 三个版本没人发现。机械防线（三道）：`npm version` 生命周期钩子跑 `build/sync-plugin-versions.mjs` 自动同步；`build/version-consistency.test.mjs` 随 npm test 常态校验全部落点一致（本地与 CI quality-gate.yml，漂移提交即红）；publish.yml 发版门禁兜底。新增版本号落点时登记进 `PLUGIN_MANIFESTS`（或一致性测试的 entries）即可全线生效。同理，会随版本演进的枚举内容（如清单 description 里列 skills/commands 名单）不要复制到多处，写稳定表述。
- 2026-07-04 workspace 换新 PRD（branchName 变更）时，必须通过 `workspace apply-prd` 的 `replace-feature` 固定动作归档旧运行，并把 `state.json` 作为不存在的候选状态原子应用——story id 惯例都从 US-001 起编，新旧几乎必然撞车，残留旧状态会把新 story 误判为已完成、循环空转结束。
- 2026-07-04 progress.md 里 `## ` 开头的标题不全是迭代记录（顶部还有 `## Codebase Patterns` 汇总段）：结构化提取迭代记录必须按日期前缀 `/^## \d{4}-\d{2}-\d{2}/` 匹配，不能只按标题层级取（见 `latestProgressTitle` 的修复）。
- 2026-07-08 按「列表位置序号」关联到人可改写文档条目的数据（如证据登记的 acIndex → 验收标准列表），源文档再派生/条目改写后旧关联会静默错挂到新内容上——`workspace apply-prd` 的固定 `rederive-feature` 动作必须归档并清空此类位置关联数据，旧证据一律作废重验；skill 不得自行维护另一份清理清单（0.20.0 终审需人裁决项）。
- 2026-07-08 macOS BSD grep 对多个中文模式的交替匹配（`grep -o "模式A\|模式B\|模式C"`）存在漏匹配怪癖（0.19.0/0.20.0 两轮发版冒烟均实证误报「未渲染」）：验证产物内容时用单模式逐一 grep，多模式交替的计数结果不可作为「区块缺失」的证据。
- 2026-07-29 识别 `git diff --binary` 的二进制内容时，只把 Git 自己输出的完整无前缀行 `GIT binary patch`，或以 `Binary files ` 开头且以 ` differ` 结尾的完整行，当作二进制标记；源码、测试或文档中提到同样文字仍是普通文本。检测函数必须按 LF 拆行并做精确字符串判断，不能用跨行模式或全文子串搜索，否则 CR、Unicode 行分隔符和受审源码都会产生假阳性。
