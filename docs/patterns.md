---
title: 约定与陷阱
status: active
updated: 2026-07-03
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

## 陷阱

<!-- 容易再次踩、与本项目框架/数据边界/路由方式强相关的坑 -->

- 2026-07-03 运行期状态需要回退时用「全部归零」的空初始化，不要复用带历史字段抽取的迁移初始化——迁移路径会把已废弃的旧格式状态重新激活（对比 `blankStateFor` 只写初始常量、`initialStateFor` 读旧字段）。
- 2026-07-03 临时目录里跑 git 的单测须先 `git config commit.gpgsign false`（否则全局签名配置会让 commit 失败），并用 `GIT_COMMITTER_DATE`/`GIT_AUTHOR_DATE` 固定日期（`git log %cs` 取的是 committer date），否则依赖提交日期的断言不稳定（见 doctor.test.ts 的 git fixture）。
- 2026-07-03 单测里的路径断言用 `join('docs', 'sub', 'x.md')` 拼接，不要硬编码 `/` 分隔的字面串，否则 Windows 上会假失败。
