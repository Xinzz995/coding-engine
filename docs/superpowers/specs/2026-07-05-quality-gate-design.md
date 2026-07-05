# 引擎机械门禁（quality gate）设计

日期：2026-07-05
状态：已批准（用户逐项拍板：上限统一到引擎、缺失静默+doctor、gate.ts 独立模块；7 节设计整体确认「好的」）
来源：雷哥《Agents增加指令遵从的方法》的「结果验证方向：Hooks 独立再校验」，映射到本项目——Hooks 的宿主不是 git hook（侵入目标仓库、可被 `--no-verify` 绕过），而是引擎自身这个确定性 TS 程序

## 背景与动机

引擎循环的完成判定完全信任 `state.json` 的 `passes` 字段（`loop.ts` 的 `allStoriesResolved`），引擎自身从不跑一行质量检查。整条验证链是 builder（LLM 自报）→ validator（LLM 复核）→ /review-loop（LLM 再复核）→ 人，全部是概率性防线；「validator 共谋假绿」已有实证（0.12.x 轮教训，见 glossary「假绿」词条）。

机械门禁把可机械化的验证下沉到引擎：builder 之后、validator 之前，引擎确定性地执行项目质量检查命令，非零退出码即机械打回。builder 谎报「检查通过」的造假成本变为无穷大（必然被零成本戳穿）；不可共谋、不可绕过。这与项目定位同构——「把 Developer → Validator 循环固化成确定性程序」：目前只有编排是确定性的，验证里可机械化的部分应当下沉。

## 锁定决策

1. **循环时序**：builder →（新）机械门禁 → validator → 完成判定。门禁失败 → 引擎写 `state.json` 打回 → `continue` 跳过本轮 validator（省一轮 validator 的 token）。门禁通过 → 静默放行，**不写任何状态**（清 notes、重置 retryCount 仍是 validator 通过时的职责）。
2. **门禁条件**：`prd.json` 顶层有非空 `qualityChecks` 且本轮 currentStory 非 null（循环开始时已计算，作为打回目标）。currentStory 为 null 或字段缺失 → 跳过门禁，行为与现在完全一致（向后兼容）。builder 超时照旧 `continue`，不跑门禁。
3. **数据契约**：`Prd` 接口加可选 `qualityChecks?: string[]`，每条是完整 shell 命令行。字段存在但形状非法（非字符串数组）→ stderr 警告一行 + 视为未配置（沿用 patterns.md 的守卫降级约定）。
4. **实现形态**（用户拍板）：新模块 `src/engine/gate.ts`——`runQualityChecks(checks, cwd)` 副作用只有 spawn；`applyGateFailure(state, storyId, result, now)` 纯函数返回新 RunState；`MAX_RETRIES = 5` 常量。loop.ts 薄调用。符合「核心逻辑纯函数、副作用留胶水层」约定。
5. **打回语义与 validator 同构**：`passes=false`、`retryCount+1`、达 `MAX_RETRIES` 转 `blocked`；notes 覆盖写 `[门禁失败 - 第N次] YYYY-MM-DD HH:mm` + 失败命令、退出码、输出尾部，**原有 `[需求冲突]` 开头的行原样保留在前**（与 validator 的 notes 规则一致）。
6. **上限单一真相源**（用户拍板）：`MAX_RETRIES` 定义在引擎（gate.ts），`validator.md` 里写死的「5」改为 `{{MAX_RETRIES}}` 占位符，`renderInstruction` 从单键替换扩展为多键渲染。
7. **fail-fast**：逐条执行，第一条非零退出码即停，后续不跑。典型排序 typecheck（秒级）→ test（分钟级），早失败早打回；builder 一次修一个焦点。
8. **shell 语义执行**：`spawn(cmd, { shell: true })`。patterns.md 的「execFileSync 不经 shell」约定针对*代码拼接固定命令+变量参数*的场景；`qualityChecks` 是用户在 prd.json 亲手声明的完整命令行（如 `npm test -- --run`），shell 语义才是声明者的预期，prd.json 不是不可信输入边界。
9. **输出 tee**：实时转发到 console（无人值守跑分钟级命令不能黑屏），同时缓冲捕获；失败时取尾部 2000 字符进 notes（vitest/jest 失败摘要在尾部；全量会污染 builder 每轮要读的 notes）。
10. **超时**：每条命令 10 分钟，SIGTERM→5s→SIGKILL；shell:true 下命令 detached 自成进程组、信号发给整组（防复合命令/包裹进程的孙进程泄漏，win32 回退单进程 kill）；SIGKILL 升级不随组长（shell）退出取消——陷 SIGTERM 的孙进程等得到组补刀，升级 timer unref 防拖住引擎退出。代价：detached 使 Ctrl+C 不再传播给运行中的门禁命令（正常命令自会跑完；挂起命令+人工中断=孤儿，接受）。超时算失败打回、notes 注明超时。不加 CLI 参数（YAGNI）。
11. **命令不存在不特判**：`shell: true` 下 command not found 是退出码 127，与真实失败无法可靠区分（脚本自身也可能 exit 127，跨平台语义不一）→ 照常打回。配置错误的正确拦截层在派生环节（决策 15），不在无人值守的循环里。
12. **validator 不减负**：门禁通过后 validator 仍逐条验收（含「Typecheck passes」类 AC）。让 validator 跳过已覆盖条目需要 AC↔命令映射，复杂度不值——保留冗余防线，有实证再优化。
13. **dashboard**：`Phase` 枚举加 `'gating'`，门禁运行期间如实显示（跑分钟级测试时显示 developing/validating 都是误导）；前端消费点是 `assets/dashboard/dashboard.html` 的 `PHASE_MAP`（未知 phase 回退 idle 显示，不加条目不崩但会误显示「等待启动」）；phase 是运行态不落盘，对归档回看无影响。
14. **doctor**（用户拍板：循环内零噪音，发现性归 doctor）：加建议级检查项——workspace 有 prd.json 但无 `qualityChecks` → 提示建议配置。
15. **派生链（prd-to-json）**：输出格式加顶层 `qualityChecks`；转换规则新增——从目标项目提取候选（package.json scripts 的 typecheck/test/lint、AGENTS.md 关键命令节），在对照表环节请用户确认，提不出时省略字段；保存前检查清单加一项：**写入前逐条真实跑一遍 qualityChecks，确认当前基线全绿**——命令不存在、命令配置错、基线本来就红，都在有人在场的派生环节拦截（否则 builder 会在循环里白烧 5 轮到 blocked；且基线绿保证了循环中门禁失败必然是 builder 引入的）。
16. **prd-generate 不动**：质量命令是项目属性不是需求属性，PRD 不声明，转换时从项目提取。
17. **state.json 损坏边界**：门禁失败但 `state.json` 损坏无法安全读-改-写时不覆盖（留给 `npx coding-x repair`，同 `ensureStateFile` 语义），stderr 警告 + 本轮 continue。
18. **版本与文档**：面向用户新能力 → minor 升版（0.13.0 → 0.14.0）+ README 同步（硬约束 5）；发版走 `npm version`（钩子自动同步插件清单）。另立 ADR-005 记录「验证链引入确定性机械层」的决策与否因（为什么不用 git hooks、为什么 validator 不减负）。

## 改动清单

| 文件 | 改动 |
|---|---|
| `src/engine/gate.ts` | 新建：`MAX_RETRIES`、`runQualityChecks`（spawn shell + fail-fast + tee + 超时）、`applyGateFailure`（纯函数）、qualityChecks 形状守卫（决策 3） |
| `src/engine/prd.ts` | `Prd` 接口加 `qualityChecks?: string[]` |
| `src/engine/loop.ts` | builder 成功后调用门禁：失败 → 写 state.json + `continue`；`renderInstruction` 扩展 `{{MAX_RETRIES}}` 渲染 |
| `src/dashboard/server.ts` + `assets/dashboard/dashboard.html` | `Phase` 加 `'gating'`；前端 `PHASE_MAP` 加对应条目 |
| `src/doctor/doctor.ts` | 加建议级检查项：prd.json 存在但无 qualityChecks |
| `assets/instructions/validator.md` | 「5」→ `{{MAX_RETRIES}}` |
| `skills/prd-to-json/SKILL.md` | 输出格式、转换规则（提取候选+试跑验证）、保存前检查清单 |
| `README.md` | qualityChecks 字段说明、门禁行为、prd-to-json 提取 |
| `docs/decisions/005-engine-quality-gate.md` | 新 ADR：确定性机械验证层 |
| 测试 | gate 单测（fail-fast/捕获/超时/表驱动打回）、loop 集成测（门禁失败跳过 validator stub、通过则照跑）、renderInstruction 多键渲染、doctor 新项 |

## 非目标

- 不做 `npx coding-x gate` 独立子命令（用户手动验证直接敲 npm test 即可）
- 不做 maxRetries 可配置化（无人要求，YAGNI）
- 不做 validator 按门禁覆盖跳过 AC 的优化（需 AC↔命令映射，无实证需求）
- 不动 prd-generate 与 PRD 模板
