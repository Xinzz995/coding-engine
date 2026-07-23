---
title: 017-tdd-workflow-and-verifiable-coverage
status: active
updated: 2026-07-23
scope: root
---

# 017. TDD 流程约束与可验证覆盖率门禁分层

## 背景

开发 agent 可以声称自己遵循了 RED→GREEN→重构，也可以声称测试与覆盖率已经通过，但这些
自然语言结论不能成为引擎事实。Git 历史、文件时间和 transcript 同样无法可靠证明测试一定
先于实现。另一方面，只检查最终覆盖率又会漏掉 TDD 的小步行为纪律，且覆盖率本身不证明
断言有效。

首版需要同时支持 Codex、Claude Code、Cursor 与 coding-x 引擎，又不能在每个宿主复制一套
政策，或改写目标仓库的 Git hooks。

## 决策

采用两层合同：

1. `skills/tdd/` 约束开发行为：一次一个公共行为，真实运行正确失败的 RED，使用同一聚焦
   命令取得 GREEN，只在绿色状态重构。过程记录明确标为 agent 声明。
2. 项目级机械门禁验证最终结果：`prd.json.tdd` 保存一条经用户确认且跑通基线的
   `coverageCheck`、生产代码 pathspec、受保护政策文件摘要、完整 Git 基线和禁止新增的覆盖
   忽略标记。

`prd.json` 是唯一政策源，不新增第二份 TDD 配置。覆盖率的统计、阈值、零测试失败与存量
项目基线比较交给目标项目的原生工具；coding-x 不重新实现跨语言覆盖率计算。

宿主 hook 与引擎执行同一政策，但职责不同：

- Codex 与 Claude Code 使用插件内 `hooks/hooks.json`；Cursor 当前 CLI 不执行插件内 hook，
  因此由 `coding-x hooks cursor install` 显式、安全地安装项目根 `.cursor/hooks.json` 和
  同一脚本的离线副本；
- hook 只在 agent 准备执行可识别的 `git commit` 时提供提前反馈，不安装或修改目标 Git
  hook，不写持久日志；
- 引擎在 Builder 后、Validator 前重新校验政策并独立执行 `coverageCheck`，绝不复用 hook
  结果。失败沿用机械门禁的打回、升级、重试与 blocked 语义，并写 `source=engine` 的
  `tdd-gate` 证据。

配置一旦出现就严格校验。非法配置、不可达基线或启动前政策漂移在任何 agent 启动前
fail closed；Builder 后发生的摘要变化、新增覆盖忽略标记、命令失败或超时则打回 story 并
跳过 Validator。`doctor` 只读检查配置与政策完整性，不默认运行昂贵覆盖命令。

新项目默认要求行与分支覆盖率均不低于 90%；存量项目默认要求总体行/分支覆盖率不低于
启用基线，且新增/改动可执行行覆盖率不低于 90%。不同政策、合法排除或政策变化必须在
有人参与的派生阶段明确批准，不能由运行中 agent 自行放宽。

## 信任边界

- TDD skill 能提供明确步骤和可复核记录，不能证明 agent 的历史执行顺序。
- 宿主 hook 能说明该次提交前检查的结局，不能保证所有提交路径都命中。
- 引擎能证明它在当前冻结政策面下观察到命令结局，不能证明覆盖工具没有被同权限恶意
  进程伪造。
- Validator 继续验证 AC 行为，可以指出明显无效测试，但不升级成“假测试识别器”。
- 覆盖率证明代码被执行，不证明断言有意义；变异测试留作后续独立能力。

配置摘要与 PRD guard 能降低政策漂移和常见规避，但不构成密码学防伪。workspace、
目标仓库与覆盖工具都处于 agent 同权限边界内，报告必须诚实保留这一上限。

## 后果

- Builder/Validator 子进程获得当前项目根与实际 workspace 的绝对路径，宿主 hook 只有在
  项目根配对成功时才使用外部 workspace，否则回退到项目内 `.workspace/`。
- Cursor runner 自动兼容当前安装器提供的 `agent` 与旧版 `cursor-agent` 命令；自定义路径
  仍由 `CODING_X_CURSOR_BIN` 显式覆盖。
- `evidence.jsonl` 与验证报告新增 TDD 门禁历史，区分政策失败和覆盖命令失败。
- Cursor 安装、状态和卸载命令只管理项目内 `.cursor/` 的 coding-x 内容，保留原有配置；
  非法 JSON、结构冲突、符号链接或用户改过的受管内容一律拒绝覆盖。它们不修改 Git hooks、
  Git 索引或提交，也不会由 runner 或 PRD 转换偷偷触发。
- `prd-to-json` 必须在写入前确认项目类型、真实测试数、分支覆盖、阈值、排除与零测试语义，
  然后计算政策摘要；无法建立可信基线时不写半套配置。
- 未配置 `tdd` 的项目保持原行为和原报告视图。
- Cursor 桌面应用不等于 Cursor Agent 可用；只有独立 CLI 已安装、认证，并用构建产物完成
  项目级 hook 真实验收后，Cursor 链路才算完成。Claude Code 账户 402 等外部阻碍仍必须单列，
  不能据此宣称四端全部完成。
