---
title: "builder 反过度工程阶梯与取舍标记收账 实施计划"
status: done
updated: 2026-07-06
scope: root
---

# builder 反过度工程阶梯与取舍标记收账 实施计划

> **For agentic workers:** Execute this plan task by task using the available agent workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** builder 指令获得可执行的反过度工程阶梯与「绝不简化」边界；有意识的简化以 `取舍:` 注释留痕，/compound-docs 收口时汇总成账本；随 0.8.0 发布。

**Architecture:** 纯指令/文档文本改动（无 src 代码）：assets/instructions/builder.md 质量要求区扩 7 条 → commands/compound-docs.md 交叉取证与交付说明两处加收账 → README 两处同步 → npm version 0.8.0 发版（P0 三道版本防线全链路首战）。

**Tech Stack:** Markdown 指令文件；验证靠 grep 存在性断言 + `npm run build` 后 dist 拷贝链路检查。

**Spec:** `docs/specs/2026-07-04-builder-anti-overengineering-design.md`

## Global Constraints

- 只改四类文件：`assets/instructions/builder.md`、`commands/compound-docs.md`、`README.md`、发版版本文件（package.json/lock/三清单由 npm version 钩子自动同步）。**不改** `validator.md`、不改 `src/`。
- 提交说明中文，conventional 类型前缀保留英文；每任务一个独立提交。
- grep 断言短语必须一字不差取自任务正文给出的最终文本（禁止用计划叙述词）。
- builder.md 每轮循环注入 agent，质量要求区净增控制在约 11 行内，不新开章节。
- 标记词锁定 `取舍:`，格式 `// 取舍: <当前上限>，<升级触发条件>`。

---

### Task 1: builder.md 质量要求区改造

**Files:**
- Modify: `assets/instructions/builder.md:52-57`（`## 质量要求` 区，现为 4 条）

**Interfaces:**
- Produces: `取舍:` 标记约定文本（Task 2 的收账对象、Task 3 的 README 表述与之一致）

- [ ] **Step 1: 改前红断言**

```bash
grep -c "停在第一个成立的台阶" assets/instructions/builder.md   # 预期 0
grep -c "保持更改专注且最小化" assets/instructions/builder.md   # 预期 1（将被吸收删除）
```

- [ ] **Step 2: 用以下全文替换 `## 质量要求` 区（原 4 条 → 新 7 条）**

原文（被替换）：

```markdown
## 质量要求

- 所有 commits 必须通过项目的质量检查（typecheck、lint、test）
- 不要提交损坏的代码
- 保持更改专注且最小化
- 遵循现有的代码 patterns
```

新文（替换后）：

```markdown
## 质量要求

- 所有 commits 必须通过项目的质量检查（typecheck、lint、test）
- 不要提交损坏的代码
- 遵循现有的代码 patterns
- **写码前按序自查，停在第一个成立的台阶**：本项目已有的 helper/util/pattern 能复用吗 → 标准库能做吗 → 运行时/平台原生特性能覆盖吗 → 已装依赖能解决吗 → 都不能，才写只满足当前 acceptanceCriteria 的最小实现
- 不为「以后可能用到」预留结构：不写只有一个实现的接口、没人读的配置项、只有一个调用方的抽象层；只调用一次的函数优先内联（除非内联后明显更难读）
- **绝不简化掉**：信任边界的输入校验、防数据丢失的错误处理、安全措施、测试；acceptanceCriteria 要求的内容一律不打折
- 修复类改动（含 Validator 打回的重试）修根因不修症状：动手前 grep 你要改的函数的所有调用方，把修复放在共享路径上——只修报告提到的那条路径会留下其他调用方继续坏
- 选择了有已知上限的简单实现时，就地留取舍标记：`// 取舍: <当前上限>，<升级触发条件>`（如 `// 取舍: 全局锁，吞吐量成瓶颈时改按账户锁`）。只标真实的取舍决策，不是每处简化都标
```

- [ ] **Step 3: 改后绿断言（源文件）**

```bash
grep -c "停在第一个成立的台阶" assets/instructions/builder.md   # 预期 1
grep -c "只标真实的取舍决策" assets/instructions/builder.md     # 预期 1
grep -c "修根因不修症状" assets/instructions/builder.md         # 预期 1
grep -c "保持更改专注且最小化" assets/instructions/builder.md   # 预期 0（已吸收）
```

- [ ] **Step 4: dist 拷贝链路验证**

```bash
npm run build
grep -c "停在第一个成立的台阶" dist/instructions/builder.md    # 预期 1
```

- [ ] **Step 5: Commit**

```bash
git add assets/instructions/builder.md
git commit -m "feat: builder 质量要求扩为反过度工程阶梯——按序自查、绝不简化边界、根因修复、取舍标记（借鉴 ponytail）"
```

---

### Task 2: compound-docs.md 收账两处

**Files:**
- Modify: `commands/compound-docs.md:57`（`### 2. 交叉取证` 段末尾追加）
- Modify: `commands/compound-docs.md:96-98`（`### 6. 交付说明` 段追加）

**Interfaces:**
- Consumes: Task 1 的 `// 取舍: <当前上限>，<升级触发条件>` 格式（grep 目标）

- [ ] **Step 1: 改前红断言**

```bash
grep -c "取舍账本" commands/compound-docs.md    # 预期 0
grep -c "不是沉淀候选" commands/compound-docs.md # 预期 0
```

- [ ] **Step 2: 在 `### 2. 交叉取证` 段落（现第 57 行，以「以 git log 补齐这部分来源。」结尾）之后追加一段**

```markdown
另外收集取舍标记：`grep -rn "取舍:" .`（跳过 node_modules、.git 与构建产物等非源码目录）。builder 在有意识选择带已知上限的简单实现时，会就地留下 `// 取舍: <当前上限>，<升级触发条件>` 注释。这些标记是交付说明中收账的对象，**不是沉淀候选**——不要把它们当成经验写进项目文档。
```

- [ ] **Step 3: 在 `### 6. 交付说明` 段落（现第 98 行「完成后简短汇报……」）之后追加**

```markdown
交付说明最后附「取舍账本」：

- 每处标记一行：`<文件>:<行号> <简述>。上限：<...>。升级条件：<...>`
- 缺升级触发条件的行标注 `[无触发条件]`，并提请用户补全或处理——这类标记最容易烂掉
- 末行汇总：`共 N 处取舍，M 处无触发条件`；仓库没有任何标记时写「无取舍债务」即可
- 账本只出现在交付说明里，不写入项目文档、不落盘新文件
```

- [ ] **Step 4: 改后绿断言**

```bash
grep -c "取舍账本" commands/compound-docs.md      # 预期 1
grep -c "不是沉淀候选" commands/compound-docs.md   # 预期 1
grep -c "无取舍债务" commands/compound-docs.md     # 预期 1
```

- [ ] **Step 5: Commit**

```bash
git add commands/compound-docs.md
git commit -m "feat: compound-docs 收口收账——交叉取证收集取舍标记，交付说明附取舍账本"
```

---

### Task 3: README 两处同步

**Files:**
- Modify: `README.md:211`（/compound-docs 教程段）
- Modify: `README.md:259`（命令表 `/compound-docs` 行）

**Interfaces:**
- Consumes: Task 1/2 的「取舍标记」「账本」表述（保持一致）

说明：spec 原文为「builder 工作原理段落与 /compound-docs 介绍处各补一句」；经 grep 核实 README 无 builder 行为详述段（仅 ASCII 架构图），故 builder 侧约定通过收账语境在教程段带出，README 共改两处。

- [ ] **Step 1: 改前红断言**

```bash
grep -c "取舍" README.md   # 预期 0
```

- [ ] **Step 2: 教程段（第 211 行，句尾「只改文档不改代码，越用文档越准。」）之后追加一句**

在该段末尾追加：

```markdown
收口同时会汇总代码中的 `// 取舍:` 标记（builder 对带已知上限简化的就地记录）成取舍账本，提醒你处理未兑现的升级条件。
```

- [ ] **Step 3: 命令表行（第 259 行）描述尾部追加**

原：

```markdown
| `/compound-docs` | 循环/分支收口时把经验提炼、验证、分层沉淀回项目文档（约定与陷阱进 `docs/patterns.md`）；只改文档不改代码 |
```

新：

```markdown
| `/compound-docs` | 循环/分支收口时把经验提炼、验证、分层沉淀回项目文档（约定与陷阱进 `docs/patterns.md`）；只改文档不改代码；并汇总代码中 `取舍:` 标记为账本 |
```

- [ ] **Step 4: 改后绿断言**

```bash
grep -c "取舍" README.md   # 预期 2（教程段 1 行 + 命令表 1 行）
```

- [ ] **Step 5: Commit**

```bash
git add README.md
git commit -m "docs: README 同步取舍标记约定与收口账本——教程段与命令表两处"
```

---

### Task 4: 发版 0.8.0

**Files:**
- Modify: `package.json`、`package-lock.json`、`.claude-plugin/plugin.json`、`.cursor-plugin/plugin.json`、`.codex-plugin/plugin.json`（全部由 `npm version` 钩子自动完成，不手改）

- [ ] **Step 1: 发版前检查**

```bash
npm run typecheck && npm test        # 全绿（108 tests；版本一致性测试在内）
ls docs/decisions/                    # 确认本轮无 ADR 需要状态同步（预期：无新增/无状态变化）
git status --short                    # 预期干净（Task 1-3 已各自提交）
```

- [ ] **Step 2: bump 0.8.0（钩子自动同步清单与 lock）**

```bash
npm version 0.8.0 --no-git-tag-version
# 预期输出含：插件清单已同步到 0.8.0：.claude-plugin/plugin.json, .cursor-plugin/plugin.json, .codex-plugin/plugin.json
grep -h '"version"' package.json .claude-plugin/plugin.json .cursor-plugin/plugin.json .codex-plugin/plugin.json  # 四行均 0.8.0
npm test  # 版本一致性测试再确认（含 lock 两处）
```

- [ ] **Step 3: release 提交 + tag 推送**

```bash
git add package.json package-lock.json .claude-plugin .cursor-plugin .codex-plugin
git commit -m "release: v0.8.0"
git tag v0.8.0
git push origin main && git push origin v0.8.0
```

- [ ] **Step 4: CI 验证（两个 workflow）**

```bash
gh run list --limit 3                                  # test.yml（push 触发）与 publish.yml（tag 触发）
gh run watch <publish-run-id> --exit-status            # 预期 success
npm view coding-x version                              # 预期 0.8.0
gh release view v0.8.0 --json tagName --jq .tagName    # 预期 v0.8.0
```

- [ ] **Step 5: 收尾**

记忆更新（0.8.0 发布、P1 完成、延迟验证项：下次引擎真实运行观察取舍标记使用与收账）。

---

## Self-Review 记录

1. **Spec 覆盖**：spec 节 3→Task 1；节 4→Task 2；节 5→Task 3（含 README 无 builder 详述段的调整说明）；节 6 验证→各任务 grep+build 步骤；节 7 发版→Task 4；节 2 决策表（validator 不改）→Global Constraints。无缺口。
2. **占位符扫描**：所有改动给出最终全文；无 TBD/「适当处理」类表述。
3. **一致性**：`取舍:` 格式三处表述一致（`// 取舍: <当前上限>，<升级触发条件>`）；「取舍账本」「无触发条件」「无取舍债务」用词 Task 2/3 一致。
