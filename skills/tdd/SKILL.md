---
name: tdd
description: "使用测试驱动开发（TDD）以测试先行的真实 RED→GREEN→重构循环实现行为或修复缺陷。Use when users request TDD, test-first development, 红-绿-重构、测试驱动、先写测试、回归测试，或要求用可执行测试重现并修复缺陷。"
---

# 测试驱动开发

## 核心合同

通过公共接口验证可观察行为。一次只处理一个行为，完成一次真实
RED→GREEN→重构后再选下一个；不要先批量写完测试再批量实现。

覆盖率证明代码在测试中被执行，不证明断言有意义，也不证明历史上一定先写测试。
RED/GREEN 过程记录属于 agent 声明；项目的 `coverageCheck` 与独立验收才是结果门禁。

## 选择模式

### 交互模式

在首次改代码前：

1. 与用户确认公共接口、按优先级排列的行为清单。
2. 确认聚焦测试命令、全量测试命令和覆盖率政策。
3. 运行现有测试基线。基线已失败时，先定位既有失败并请用户裁决，不把它冒充本轮 RED。

用户已经明确批准这些内容时直接使用，不重复提问。

### coding-x 模式

读取当前 story 的 `acceptanceCriteria`，把已获用户批准的 AC 作为行为清单，不在无人值守
运行中重新要求规划批准。读取 `prd.json.tdd.coverageCheck` 作为最终覆盖率命令。

若 AC 不足以确定公共行为、与源码事实冲突，或实现需要改变覆盖政策：

1. 不自行补意图或修改政策；不得自行新增覆盖排除、降低阈值或允许零测试；
2. 在 story notes 追加以 `[需要人工核实]` 开头的证据；
3. 将该 story 置为 `blocked`，等待人工裁决。

## 每个行为的循环

严格按以下顺序执行：

1. 选择尚未实现的最高优先级行为，只选一个。
2. 通过公共接口写一个聚焦测试；期望值来自规格、手工算例或已知良好字面量，不复用实现算法计算期望。
3. **RED：真实运行聚焦测试命令。**
   - 确认测试确实失败。
   - 确认失败原因是待实现行为缺失。
   - 语法、依赖、路径或环境错误不能算 RED；先修复测试运行条件，再重跑直到得到正确 RED。
   - 测试意外通过时，先确认行为已存在或测试无效；不要假造失败。
4. 写刚好足以满足当前行为的最小实现，不提前实现后续行为。
5. **GREEN：重跑与 RED 完全同一条聚焦测试命令。**
   - 只有退出成功且断言通过才算 GREEN。
   - 若失败，继续修当前行为；不要转向下一项。
6. **只在 GREEN 状态重构。**
   - 小步清理重复、命名与结构。
   - 每个重构步骤后重跑同一聚焦测试；必要时再跑受影响测试集。
7. 记录行为、RED 命令与正确失败、GREEN 的同一命令与成功结局。明确这是可复核的 agent 声明，不是机器对历史顺序的证明。

## 最终门禁

完成全部行为后：

1. 运行项目全量测试与必要的普通质量检查。
2. 原样运行已批准的 `coverageCheck`。
3. 缺工具、命令错误、超时、零测试、覆盖不足或总体回退都按失败处理。
4. 不得自行降低阈值、扩大排除、允许零测试、新增覆盖忽略标记，或修改受保护政策文件来换取通过。
5. 修复代码或测试后重新运行，直到命令真实返回成功；不能通过时报告准确阻碍。

提交前 hook 只提供提前反馈；coding-x 引擎会在 Validator 前独立重跑，不能复用或信任 hook
的旧结果。

## Cursor 项目检查

当前宿主是 Cursor 且项目已启用 TDD 时，在首次提交前运行
`npx coding-x hooks cursor status`。缺失、冲突或过期时不要静默安装或覆盖；向用户说明后，
由用户在项目根运行 `npx coding-x hooks cursor install`。升级 coding-x 后重新运行 install
刷新受管脚本，再用 status 确认。需要撤销时运行 `npx coding-x hooks cursor remove`。

这些命令只管理项目内 `.cursor/` 的 coding-x 检查，不修改 Git hooks，不暂存或提交文件。
项目文件是否进入 Git 由用户决定。Cursor 检查即使缺失或被绕过，也不改变引擎最终门禁。

## 按需参考

- 编写或评估行为测试时读取 [references/tests.md](references/tests.md)。
- 决定是否模拟依赖时读取 [references/mocking.md](references/mocking.md)。
- 设计可测试公共接口时读取 [references/interface-design.md](references/interface-design.md)。
- 收窄接口并隐藏复杂性时读取 [references/deep-modules.md](references/deep-modules.md)。
- GREEN 后选择重构项时读取 [references/refactoring.md](references/refactoring.md)。
