---
title: 精确提交的干净检出验证
status: active
updated: 2026-08-03
scope: root
---

# 精确提交的干净检出验证实施计划

## 目标与边界

项目机械检查、TDD coverage 命令、Validator 和最终 Review 前机械检查必须在项目目录外、
绑定精确 Git HEAD 的临时干净检出中运行。开发目录里的 `.env`、`.claude`、ignored 源码、
旧依赖目录和未跟踪文件不得进入验证输入。Developer 仍在开发目录实现；GitHub CI、三层模型
Review、workspace 写租约和操作系统级文件系统沙箱不在本次扩展范围。

项目命令仍是用户明确授权的本机程序，现有 supervisor 只证明进程树收口与 workspace 写边界，
不声称限制它访问操作系统其他路径。本功能机械保证的是：验证输入来自精确提交；临时检出内
已跟踪内容不变；检出内新增内容只落在契约允许目录；异常后不把结果签成通过。

## 可证伪完成合同

| 验收标准                                                    | 通过证据                                                                      | 失败观察                                                                             |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ |
| 质量契约显式保存跨平台本地准备命令及允许产物目录            | 契约 parser 与 init discovery 测试；候选写入前确认摘要列出两项                | 缺字段、越界/过宽目录或未经确认时 init 拒绝                                          |
| 精确 HEAD 在项目外建立独立 Git 检出                         | checkout 集成测试核对路径、HEAD、tree；原目录 ignored 文件在检出中不存在      | HEAD 不可取、submodule、LFS/custom filter 或检出失败返回不可验证                     |
| prepare、项目检查、TDD、Validator、最终机械检查都使用隔离根 | loop/final-review 测试记录实际 cwd 与 `CODING_X_PROJECT_ROOT`                 | 任一步仍看到开发目录 `.env`/`.claude`/旧依赖即测试失败                               |
| 执行前后验证提交、tracked tree 与新增产物边界               | tracked 改写、ignored source、越界 hard link、特殊文件与挂载点 fixture 均阻断 | 任何身份漂移、跨文件系统入口或越界产物不能签发凭证                                   |
| 外部普通文件在统一期限内完整冻结                            | 受管 reader 完成链接链解析、magic 检查、精确 EOF 与复核；procfs/阻塞测试      | 动态内容、magic link、身份漂移、超时或进程未收口均返回不可验证                       |
| 回执绑定验证环境                                            | v2 receipt 含环境摘要；同 HEAD 的 v1/错误摘要自动失效                         | 旧回执或契约/平台/准备规则改变仍显示绿色即失败                                       |
| 单次 gate/TDD/Validator 共用同一检出，签发前安全清理        | cwd、清理失败与重启回归；下一次验证重新建立检出                               | 未安全清理就签 receipt，或旧检出跨 receipt 复用即失败                                |
| 异常、超时和结束都安全清理                                  | prepare 失败、Validator 失败、正常完成后临时根不存在                          | 进程未收口时不得假称已清理或接受结果                                                 |
| 跨语言不依赖 npm                                            | Node、Go 多模块及人工 schema-v2 Python venv 契约/检出 fixture                 | Go/Python 路径安装 coding-x 或硬编码 npm 即失败；Python 自动发现若猜测宿主依赖也失败 |

## 设计

1. 质量契约升级到 schema v2，新增 `localValidation.prepare` 与
   `localValidation.allowedPaths`。检查产物允许范围是 `generatedPaths` 与
   `localValidation.allowedPaths` 的并集；允许路径必须是明确目录的 `/**` 模式，禁止 `**` 根通配。
2. 新增验证检出管理器：在系统临时目录建立自有根，用受管 Git 进程从本地仓库只取得精确 HEAD
   及 TDD baseline，关闭系统/全局 Git 配置和 hooks；在 checkout 前拒绝 gitlink、LFS/custom filter
   与 working-tree encoding。
3. 同一 Story 的 gate、TDD 与 Validator 共用一个检出；Validator 通过后必须先安全清理，才签发
   receipt，后续 Story 或下次运行重新建检出。管理器每次都新建检出，不保留可复用的旧目录。
   环境摘要绑定 checkout 协议版本、平台、HEAD、完整 checks、TDD 政策、规范化
   prepare、允许目录与生成目录；工作树契约还必须等于待验证 HEAD 的 tracked 契约。
4. 每个验证阶段开始和结束均检查 detached HEAD、index/tracked tree、未跟踪/ignored 路径；准备命令
   通过与项目检查相同的受管命令执行器运行。产物树只允许完整、同一声明产物根内且由可信本地
   文件系统证明的 hard link 组，拒绝不完整或跨边界 hard link、特殊文件和挂载点；递归清理前
   再按操作系统真实挂载信息复核根身份、整树拓扑与 hard link 组。失败返回不可验证，不转化为实现
   缺陷重试；清理失败同时隔离 workspace 会话并保留租约，禁止后续流程继续。
5. Validator 的 cwd 与 `CODING_X_PROJECT_ROOT` 指向检出，`CODING_X_WORKSPACE` 继续指向原绝对
   workspace；Builder 不改变。v2 Validator receipt 由引擎在检出安全清理后写入环境摘要，v1 继续
   可读但当前性为失效。
6. Final Review 先在开发目录完成 PR/提交只读预检，再按 context.headSha 建检出并运行旧默认分支
   契约的准备和机械检查；清理后才把机械证据交给 Reviewer。
7. 所有完整遍历都设置公开上限：检出树 10 万项；产物路径每组 128 项、每项 512 字符；受管链接
   1024 条、单个外部目标 256 MiB、外部内容实际读取累计 1 GiB、总计 30 秒；Final Review 最多 128 个变更
   文件。链接链解析、magic 检查、身份、内容和 EOF 只由固定受管 reader 使用同一剩余期限完成；
   链接清单只按实际命令传输上限分批，不拆分证明语义或重置预算。主进程不接触链接目标；超限、
   动态内容或 reader 无法收口统一返回不可验证，不静默截断。

## 黄金原则逐项对照

### 1. 先定义可证伪的完成合同

- **适用性**：适用，验证环境身份不能用“干净”口号代替。
- **裁决**：以上八条均有成功与失败观察；submodule/LFS/custom filter 明确为不可验证而非静默支持。
- **验证证据**：契约、checkout、loop、receipt、final-review 与跨语言 fixture 的定向测试，加全量四项检查。

### 2. 生成方不得给自己签发通过

- **适用性**：适用，Validator 和项目命令都可能看到或制造本地污染。
- **裁决**：检出、HEAD/tree/产物核对、receipt 环境摘要均由引擎机械执行；Validator claim 不拥有摘要。
- **验证证据**：Validator 声称通过但改 tracked 文件、读取 ignored secret、制造越界产物时不签 receipt。

### 3. 自治范围扩大时同步增加防线与可逆性

- **适用性**：适用，新增自动准备命令和临时目录生命周期。
- **裁决**：命令沿用受管超时/平台 containment 收口；只运行契约确认命令；临时根带固定前缀并做归属核对；
  失败关闭并清理，无法确认收口时不接受结果。
- **验证证据**：prepare 非零/超时、阻塞外部 reader、procfs magic link、错误 EOF、越界产物、tracked 改写、正常与异常清理测试。

### 4. 原生执行优先，差异只在控制平面

- **适用性**：适用且 runner-neutral。
- **原生能力对照**：Git 原生对象传输、detached checkout、status/diff 足以表达精确提交和 tree；
  Node/Go/Python 继续运行项目自身命令；Claude/Codex/Cursor 只接收不同 cwd，不新增供应商协议。
- **build/adapt 裁决**：自建的只有检出生命周期、策略核对和摘要控制平面，不复制包管理器、测试器或 runner。
- **验证证据**：三类项目 fixture 使用同一核心；runner 类型不进入验证环境合同。

### 5. 以假绿率和失败恢复衡量价值

- **适用性**：适用，Issue #91 源于 ignored 文件可制造假绿的真实缺口。
- **裁决**：先固化 `.env`、`.claude`、ignored source、旧 `node_modules` 和 tracked 改写失败场景，
  再覆盖成功复用；预期降低“同 HEAD 但环境不同”的假绿，不以多跑一次命令作为价值。
- **验证证据**：恶意 ignored fixture 不能改变凭证；旧回执同 HEAD 失效；失败后临时根清理并可重跑。

## 实施顺序

1. 契约 v2、初始化候选与 coding-engine 自身契约。
2. 干净检出管理器、准备执行、边界核对和环境摘要。
3. receipt v2 与当前性判定。
4. loop 的 gate/TDD/Validator 接线与复用/清理。
5. Final Review 机械检查接线。
6. 文档、定向测试、全量格式/lint/typecheck/test/build/smoke。

## 当前状态与保留验收

- 核心实现、边界测试和仓库内跨语言契约样例随本计划对应 PR 交付。
- 真实 Go 多模块与 Python Monorepo 的业务仓库验收按已确认范围暂缓；在该证据完成前，Issue #91
  保持开放，不把仓库内测试描述成真实下游证明。
