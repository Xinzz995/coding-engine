---
title: "TDD 工作流与可验证覆盖率设计"
status: done
updated: 2026-08-12
scope: root
---

# TDD 工作流与可验证覆盖率设计

## 目标

为 coding-x 增加一套 runner-neutral 的 TDD 能力：

1. Codex、Claude Code、Cursor 通过同一份 `tdd` skill 执行逐行为的红→绿→重构；
2. 三个宿主在 agent 准备执行 `git commit` 时提前运行真实覆盖率检查：Codex/Claude Code
   由插件接线，Cursor 由用户显式安装项目级配置；失败就阻止该次工具调用；
3. coding-x 引擎在 Builder 结束后、Validator 启动前重新执行同一检查，并以这一轮引擎观察到的结果作最终机械裁决；
4. 覆盖率只证明代码被测试执行，不把它包装成“TDD 顺序证明”或“测试断言有效证明”；假测试留给后续变异测试。

本设计不改目标仓库的 Git hooks，不依赖 qodercli，也不接入参考资料中的 AI 覆盖判断脚本。

## 完成合同

首版只有同时满足以下条件才算完成：

1. `skills/tdd/` 能在三个宿主中被发现；交互模式先确认公共接口与行为顺序，coding-x 模式使用已批准的 story AC，不重复向无人值守运行提问。
2. 每个行为必须完成一次真实 RED 与 GREEN：RED 的失败原因必须是待实现行为，不能是语法、依赖、路径或环境错误；GREEN 必须重跑同一条聚焦测试命令；只在 GREEN 后重构并重跑测试。
3. TDD 启用时，`.workspace/prd.json` 包含一条用户确认、基线已跑通的真实覆盖率检查；缺命令、命令错误、工具缺失、超时、零测试、阈值不达标都必须返回非零。
4. 新项目的检查策略默认要求行覆盖率与分支覆盖率都不低于 90%；存量项目要求总体行/分支覆盖率不低于启用时基线，且新增/改动可执行行覆盖率不低于 90%。
5. 覆盖率阈值、排除项、零测试策略及命令委托到的脚本/配置均属于受保护政策面。在这份声明并受保护的政策面内，Builder 不能在运行中降低阈值、扩大排除项、允许零测试，或新增覆盖忽略标记后仍取得通过。
6. Codex/Claude Code 共用插件 hook 配置；Cursor 通过
   `npx coding-x hooks cursor install` 安装项目根 `.cursor/hooks.json` 和同一份脚本；三者执行
   同一条项目检查命令。
7. 宿主 hook 只是提交前反馈。即使 hook 未触发、被关闭、宿主存在缺陷或提交方式未命中，coding-x 引擎仍独立重跑并拥有最终裁决权。
8. Validator 继续按 AC 验证行为，可指出明显无效测试，但不新增“AI 判断测试真假”的正式门禁，也不把 Validator 描述为假测试检测器。
9. Codex、Cursor、coding-x 引擎完成真实运行验收；Claude Code 若仍因账户 402 无法发起
   Bash 调用，必须保留为待补验，不能宣称四端全部完成。
10. 文档明确说明可信边界：同权限恶意进程仍可能伪造项目执行环境或覆盖工具输出；首版降低的是遗漏、配置漂移和常见规避，不声称形成密码学证明。

## 锁定决策

### 1. 强化版 A：流程约束与结果门禁分开

- `tdd` skill 负责开发行为：一次只处理一个行为、先红后绿、绿色状态下重构。
- hook 与引擎负责结果门禁：真实运行用户确认的覆盖率检查。
- 机器不尝试从 Git 历史或文件时间推断“测试一定先于实现”，因为这种推断既不可靠也容易制造假证明。
- skill 在本轮汇报中列出 RED/GREEN 命令和结局，属于可审计的 agent 声明，不升级为引擎事实。

### 2. 一个政策源，两次执行

不新增 `.coding-x/tdd.json`，也不把配置复制到三个宿主：

```json
{
  "qualityChecks": ["npm run typecheck", "npm run lint"],
  "tdd": {
    "coverageCheck": "node scripts/tdd-coverage-gate.mjs",
    "sourcePathspecs": [
      ":(glob)src/**"
    ],
    "policyFiles": [
      {
        "path": "scripts/tdd-coverage-gate.mjs",
        "sha256": "<64 hex>"
      },
      {
        "path": "vitest.config.ts",
        "sha256": "<64 hex>"
      }
    ],
    "baselineRef": "<git commit sha>",
    "forbiddenAddedPatterns": [
      "istanbul ignore",
      "c8 ignore"
    ]
  }
}
```

含义：

- `coverageCheck` 是目标项目提供的完整检查命令。它负责真正运行测试，并按目标生态的原生工具执行覆盖率政策。
- `sourcePathspecs` 是用户批准的生产代码 Git pathspec；新增 ignore marker 检查只作用于这些路径，测试、fixture 和文档不被误判。覆盖命令的生产代码范围必须与这里对齐。
- `policyFiles` 固定命令依赖的阈值、排除、零测试和 diff-coverage 配置。阈值完全写在命令中时可以为空。
- `baselineRef` 是启用 TDD 时确认的 Git 起点，用于检查运行后新增的覆盖忽略标记；非 Git 项目不能启用此保护，因此首版 TDD 机械门禁要求 Git 仓库。
- `forbiddenAddedPatterns` 来自目标覆盖工具的忽略语法，由用户在派生时确认。运行期间新增命中项即失败；已有合法排除不受影响。
- 整个 `prd.json` 已由 ADR-007 冻结；`tdd` 命令和政策文件摘要随之不可被 Builder 静默改写。

`qualityChecks` 保留普通 typecheck/lint 等检查。若 `coverageCheck` 已运行全量测试，不再额外配置重复的普通 test 命令。

### 3. 覆盖率政策由项目原生工具执行

coding-x 不重新实现 Python、JavaScript、Go、Java 等语言的覆盖率计算。它只要求项目提供一条能以退出码作机械裁决的命令，并保护这条命令的政策面。

启用时必须确认：

| 项目类型 | 默认政策 |
|---|---|
| 新项目 | 行覆盖率 ≥90%，分支覆盖率 ≥90%，零测试失败 |
| 存量项目 | 总体行/分支覆盖率不低于启用基线；新增/改动可执行行覆盖率 ≥90%；零测试失败 |

项目若要采用不同阈值，必须在启用前由用户明确批准，不能由 agent 在运行中自行降低。合法排除同样必须先批准并进入受保护政策文件；运行中的新排除需要停止引擎、重新确认政策、重新派生 PRD。

### 4. 三宿主提交前适配

| 宿主 | 配置 | 触发点 | 输入命令位置 | 阻断方式 |
|---|---|---|---|---|
| Codex | `hooks/hooks.json` | `PreToolUse`, matcher `Bash` | `tool_input.command` | stderr + exit 2 |
| Claude Code | `hooks/hooks.json` | `PreToolUse`, matcher `Bash` | `tool_input.command` | stderr + exit 2 |
| Cursor | 项目根 `.cursor/hooks.json`，由 `coding-x hooks cursor install` 显式安装 | `beforeShellExecution` | `command` | 成功输出 `{"permission":"allow"}`；失败 stderr + exit 2 |

当前 Cursor Agent CLI `2026.07.20-8cc9c0b` 的真实行为是：`--plugin-dir` 能发现插件能力，
但不会执行插件目录内的 hook 配置；项目根 `.cursor/hooks.json` 会执行。因此 Cursor 插件
清单不再声明 hook，避免与项目配置重复；插件仍提供 commands 与 skills。

安装器管理且只管理以下项目文件：

- `.cursor/hooks.json`：安全合并一个 `beforeShellExecution` 项；
- `.cursor/coding-x/tdd-commit-check.mjs`：从 npm 构建产物复制的离线脚本；
- `.cursor/coding-x/install.json`：归属、版本摘要和安全卸载记录。

安装前先定位 Git 根并完整校验现有结构。非法 JSON、结构冲突、路径越界、符号链接、受管
脚本或受管配置被修改时拒绝写入；正常写入使用临时文件替换，失败时恢复原内容。重复安装
不增加检查项，升级 coding-x 后重跑 install 会刷新未被用户修改的受管脚本。status 只读，
remove 只移除 coding-x 拥有的条目和文件，并保留用户原有 Cursor 配置。三个命令都不修改
Git hooks、索引或提交。

共同脚本：

- 只处理 agent 发起、文本中可识别为 `git commit` 的 shell 调用；
- 从 hook 输入的 `cwd` 定位 Git 根和 `.workspace/prd.json`；
- coding-x 启动 agent 时把实际 `--workspace` 和项目根绝对路径分别注入 `CODING_X_WORKSPACE`、`CODING_X_PROJECT_ROOT`；hook 只有在后者等于当前 Git 根时才使用前者，否则回退到当前 Git 根的 `.workspace/`。这样兼容仓库外的自定义 workspace，同时避免误读另一个项目遗留的环境变量；
- 未配置 `tdd` 时放行，避免影响普通项目；Codex/Claude 成功保持静默，Cursor 返回原生明确
  放行结果；
- 已配置但结构非法、政策文件缺失/摘要变化或检查失败时阻断；
- 不写 `/tmp` 调试日志，不保存命令输入或环境变量；
- hook 自身不修改源码、覆盖率配置、Git 索引或提交。

命令识别不是安全边界：Git alias、宿主缺陷或非标准提交路径可能绕过提前反馈，因此最终引擎门禁不能复用 hook 的“已通过”结果。

### 5. 引擎最终门禁

引擎顺序保持：

```text
Builder
  → 普通 qualityChecks
  → TDD 政策完整性检查
  → coverageCheck
  → Validator
```

- `tdd` 缺失：保持当前行为，完全向后兼容。
- `tdd` 存在但结构非法：在启动前 fail closed，不拉起 Builder，不消耗五轮重试。
- 启动前同时验证 `baselineRef` 可达、政策文件摘要匹配和 `sourcePathspecs` 合法；启动前已有漂移属于配置问题，直接退出，不让 Builder 猜测修复。
- 政策摘要变化、覆盖忽略标记新增、coverageCheck 非零/启动错误/超时：按现有机械门禁失败路径打回当前 story，跳过 Validator。
- 引擎每轮独立执行，不信任 hook、Builder 汇报或已有覆盖率文件。
- 新增 `tdd-gate` engine evidence，记录 story、政策完整性结论、命令结局、耗时及有界失败诊断；成功不保存完整测试输出。

### 6. TDD skill 两种工作模式

#### 交互模式

1. 编码前确认公共接口、按优先级排序的行为和覆盖率政策。
2. 检查现有测试基线；基线已红时先处理或请用户裁决。
3. 每次只选一个行为：
   - 写一个通过公共接口观察行为的测试；
   - 运行聚焦命令并确认因缺少该行为而失败；
   - 写刚好足够的实现；
   - 重跑同一命令并确认通过；
   - 仅在绿色状态重构，重构后重跑。
4. 所有行为完成后运行项目级 coverageCheck。
5. 汇报各行为的 RED/GREEN 结局及最终门禁结局，并明确这些过程记录是 agent 声明。

#### coding-x 无人值守模式

- story AC 已经过用户批准，视为本轮行为清单；不重新发起规划审批。
- AC 不足以确定公共行为、与源码事实冲突或需要新增覆盖排除时，将 story 置为 `[需要人工核实]` + blocked，不自行补意图。
- Builder 指令只引用 `tdd` skill，不复制其正文；`skills/` 继续是唯一源。

## 保留与修正参考 skill 的内容

保留：

- 公共接口与行为测试；
- 一次一个测试的垂直切片；
- 只模拟外部系统边界；
- 依赖注入和深模块；
- 绿色状态下重构。

加强：

- RED 必须真实运行，且失败原因必须正确；
- GREEN 必须重跑同一聚焦命令；
- 环境错误不能冒充 RED；
- 增加交互/coding-x 两种审批语义；
- 增加最终覆盖率门禁和可信边界；
- 明确过程记录不能证明历史顺序。

舍弃：

- 参考 hook 的 Python 目录、文件名和方法名硬编码；
- “测试函数名包含方法名”等静态猜测；
- 未接线且依赖 qodercli 的 AI 语义覆盖判断；
- 覆盖率等同测试质量的表述。

## 可信分层

| 层 | 能证明什么 | 不能证明什么 |
|---|---|---|
| TDD skill | 给 agent 明确的开发步骤；留下可复核过程记录 | agent 必然按历史顺序执行 |
| 宿主 hook | 提交前这一次真实检查返回了什么 | 所有提交路径都经过它；最终产物仍相同 |
| coding-x 引擎 | 当前 story 在受保护命令与政策面下通过了机械检查 | 测试断言一定有意义；覆盖工具未被同权限恶意伪造 |
| Validator | AC 行为验证的结构化 claim | 正式识别所有假测试 |
| 后续变异测试 | 测试能否杀死所选变异 | 等价变异、未覆盖算子和所有业务意图 |

## 失败语义

| 场景 | hook | 引擎 |
|---|---|---|
| 未启用 TDD | 放行 | 保持现状 |
| `tdd` 结构非法 | 阻断 commit | 启动前退出 1 |
| 政策文件缺失/摘要变化 | 阻断 commit | 门禁打回，跳过 Validator |
| 新增覆盖忽略标记 | 阻断 commit | 门禁打回，跳过 Validator |
| 覆盖工具缺失/命令错误 | 阻断 commit | 门禁打回，跳过 Validator |
| 检查超时 | 阻断 commit | 终止进程树后门禁打回 |
| 零测试但 runner 默认返回 0 | 启用前拒绝这条命令；不得写入配置 | 若错误配置被手工绕过，不能声称首版已保证零测试失败 |
| 覆盖率不足/总体回退 | 阻断 commit | 门禁打回，跳过 Validator |
| hook 未触发或被宿主关闭 | 无提前反馈 | 引擎仍重跑并裁决 |

“零测试失败”依赖用户确认的项目命令明确开启对应选项；coding-x 不从自然语言输出猜测试数量。

## 非目标

- 从提交历史、时间戳或 transcript 机械证明测试先写。
- 自动安装或修改目标仓库 Git hooks。
- 在 `coding-x cursor`、`prd-to-json` 或插件加载时自动安装 Cursor 项目配置。
- 为所有语言实现一套新的覆盖率计算器。
- 首版加入变异测试。
- 调用 AI 判断测试是否“有意义”并作为机械门禁。
- 自动批准新的覆盖排除、阈值下降或零测试放行。
- 兼容 qodercli 或保留参考脚本的业务目录假设。

## 宿主事实与验收边界

- Codex 与 Claude Code 已安装；Codex 可做真实 hook 运行验证，Claude Code 当前账户若仍返回
  402，只能验证发现与共享脚本兼容，真实 Bash hook 保持待补验。
- Cursor Agent 已安装在 `/Users/xinzz/.local/bin/agent`，当前版本
  `2026.07.20-8cc9c0b`。必须用构建后的 coding-x 在临时 Git 仓库验证项目级安装、失败阻断、
  成功放行、幂等与安全卸载，不能用桌面应用存在或静态 schema 代替。

## 设计批准点

进入编码前，用户批准本规格即同时批准以下细节：

1. TDD 机械配置只放 `.workspace/prd.json`，不新增第二份项目配置；
2. hook 只在已启用 coding-x TDD 的项目中执行，否则静默；
3. 覆盖率数学由目标项目原生命令负责，coding-x 负责冻结政策面、真实执行和按退出码裁决；
4. 零测试保证来自已验证的项目命令，不由引擎解析测试输出猜测；
5. 自定义 `--workspace` 通过 `CODING_X_WORKSPACE` 与 `CODING_X_PROJECT_ROOT` 成对传给 agent/hook，默认路径才使用 `.workspace/`；
6. Cursor 使用显式项目级安装，不依赖插件内 hook；安装器不在 runner 或 PRD 转换时自动执行，
   项目文件是否提交到 Git 由使用者决定。
