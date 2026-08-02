---
title: 022-clean-checkout-validation
status: active
updated: 2026-08-02
scope: root
implementation: planned
---

# 022. 用精确提交的项目外检出签发本地验证结果

## 背景

ADR-015 把 Validator 结果绑定到 Git HEAD 与验收标准，ADR-021 又保证受管子进程收口和 workspace
委托边界，但二者都没有定义项目执行目录的完整输入。Git 不会把 ignored 未跟踪文件列入普通脏树
判断，开发目录中的 `.env`、`.claude`、忽略源码、旧 `node_modules` 或虚拟环境仍可能改变项目检查
和 Validator 结论。只检查常见目录、mtime 或文件数量都会漏掉已有文件、等长改写和未知语言生态。

## 决策

正式本地验证使用项目目录外、绑定精确 HEAD 的引擎自有临时 Git 检出：

- Developer 仍在开发目录写代码；项目机械检查、TDD coverage 命令和 Validator 转到验证检出；
- Final Review 仍在开发目录读取 PR/提交上下文，但其前置机械检查在 context.headSha 的验证检出运行；
- workspace 保持原绝对路径，Validator 结果和引擎状态只回到受控 workspace；
- 质量契约 schema v2 显式保存本地 prepare 命令和允许产物目录，不能从 GitHub setup 暗推；
- 检出关闭系统/全局 Git 配置和 hooks，在 materialize 前拒绝 submodule、LFS/custom filter 与
  working-tree encoding；首版不静默降级复制工作树；
- 每个阶段前后机械核对 detached HEAD、index/tracked tree 与新增/ignored 产物边界；项目生成物和
  本地依赖只能出现在契约的明确目录模式中；
- 允许目录的基路径必须是字面目录，不能用 glob 扩大边界；prepare 产生的项目外目录链接一律拒绝，
  Python venv 等确需的项目外普通文件链接只在大小有界时冻结链接及目标身份与内容，后续逐阶段复核；
- 同一 Story 的机械检查、TDD 与 Validator 共用检出；Validator 通过后先安全清理再签 receipt，后续
  Story 或下次运行重建。管理器内部若复用仍先清空非 tracked 内容并重跑 prepare；
- Validator receipt v2 额外绑定验证环境摘要。v1 receipt 保持可读以便安全迁移，但不能成为当前通过。

环境摘要只证明控制平面可重算的执行合同：checkout 协议版本、平台、HEAD、完整机械检查、完整 TDD
政策、prepare 命令和允许目录。正式运行还要求工作树契约的规范摘要等于每个待验证 HEAD 中已跟踪
的契约。
它不声称逐字节封存编译器、系统库、网络下载或外部缓存。项目命令仍以当前用户权限运行；ADR-021
的 supervisor 是进程树与 workspace 协议，不是操作系统文件系统沙箱。因此本决策保证隔绝开发目录
污染、检测检出内越界变化并失败关闭，不虚构“命令绝对无法写宿主其他位置”。

## 被否备选

- **只加强开发目录 `git status`**：ignored 文件本来就不在普通状态中，无法证明完整输入。
- **复制 tracked 文件到普通目录**：TDD baseline 与 Git 身份丢失，复制过程还要另造 tree 证明。
- **`git worktree add`**：把生命周期注册进开发仓库共同 `.git/worktrees`，异常恢复和并发清理会修改
  原仓库控制面；独立临时仓库更容易界定归属。
- **复用 GitHub job setup**：同一平台可有多个 job/工具版本，远端 setup 与本机验证目的不同；暗推会
  让合同随工作流布局漂移。
- **自动复制 `.env` 或本机依赖目录**：直接重建 Issue #91 的不可提交输入缺口。
- **首版支持 submodule/LFS/custom smudge**：这些需要递归来源、凭据和内容身份合同；缺证据时拒绝比
  取到 pointer 或执行本机 filter 后假绿更安全。

## 后果

- 每次待签 receipt 的验证都要准备新的依赖环境，耗时上升；这是清理完成后才签发的安全成本。
- 新契约必须由用户确认 prepare 与允许目录；跨语言核心不依赖 npm。
- schema v1 只在读取默认分支旧裁判时做一次只读兼容：prepare 必须能从该平台旧 GitHub jobs 的一致
  setup 推导；候选 PR 不能为自己提供迁移命令。v1 receipt 不能继续正式签发通过，需要重新验收。
- 真实工具链、下载来源和宿主隔离仍属于后续增强，报告必须保持这个证据边界。
- Python 自动发现不会猜测 venv 或依赖来源；新项目必须提供人工确认的 schema-v2 契约。schema-v1
  Python 也不自动迁移；若未来出现旧项目，必须另行设计明确的 bootstrap，而不能信任候选 PR 补规则。
