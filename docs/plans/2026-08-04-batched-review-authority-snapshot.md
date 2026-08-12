---
title: Final Review 权威快照单进程批量核对
status: done
updated: 2026-08-12
scope: root
---

# Final Review 权威快照单进程批量核对实施计划

## 背景与完成合同

0.34.0 Go Dogfood 的真实运行表明，Final Review 的十个 currentness 检查点合计启动了 100 次
受管操作：每个检查点分别读取两轮 Story 权威输入、Runner 版本、Git 分支/base/head/工作树及
GitHub 仓库和 PR。十个检查点本身消耗约 315 秒，并随 `settled-operations` 增长而继续变慢。
`settled-operations` 属于安全证明，不能通过排除扫描来换取速度；十个检查点也全部保留。
GitHub Issue #151 跟踪本轮修复；后续提交与 PR 必须关联该 Issue。

本轮把同一检查点内的固定只读观察收口为一个受管 authority-snapshot 操作，不跨检查点缓存，
不减少复核次数，不执行项目代码，也不加载项目的 hooks、插件、MCP 或可执行配置。

| 验收标准                     | 通过证据                                                                                                  | 失败观察                                                    |
| ---------------------------- | --------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- |
| 十个检查点只启动十次受管操作 | 真实 Final Review 成功夹具统计 authority-snapshot operation 为 10                                         | 仍按 Git/gh/Runner/Story 项逐次启动受管进程                 |
| 每个检查点保留完整当前性     | 同一操作内完成 Story 前后双快照、Runner 版本、本地 Git、远端 base、仓库/PR 及可选裁决读取                 | 任一来源被遗漏、跨检查点复用或只读一次                      |
| 旧失败语义不变               | Story、Runner、branch/base/head、PR 标题/正文/标签、工作树和裁决变化仍逐项失败关闭                        | 篡改被吞掉、降级成警告或旧绿灯保留                          |
| helper 是固定可信只读程序    | 只以内存固定程序和严格请求启动；Git 禁用系统/全局配置与 hooks，GitHub 固定 API，Runner 仅执行 `--version` | shell、项目脚本、项目配置、任意命令或任意路径进入 helper    |
| 输出有界且严格绑定请求       | schema/version/request digest、精确字段、UTF-8、字节上限和 EOF 反例测试                                   | 坏 JSON、额外字段、复制旧结果、超限或截断输出仍通过         |
| 写入和残留后代失败关闭       | helper/Runner 写临时域、改项目或 workspace、根进程退出后留后代均使 Review 不可验证                        | 写入或后代残留后仍采用观察结果                              |
| 安全证明不被削弱             | `captureStableFrozenSafetyTree` 和 `settled-operations` 逻辑零改动                                        | 通过排除历史操作、放宽 delta/containment 或延长期限掩盖问题 |

## 设计裁决与信任边界

1. 新增 runner-neutral 的 authority-snapshot 观察器。调用方一次传入已由 preflight 冻结的固定
   project/workspace、PR、仓库、默认分支、Runner 身份和允许生成路径；所有路径先在父进程规范化并
   校验，再编码为有上限的请求。
2. 一个受管 Node helper 顺序完成所有读取。它只使用 Node 核心模块和父进程解析出的项目外绝对
   `git`、`gh`、Runner 路径；不使用 shell，不导入项目模块，不读取 package.json、Git hooks、项目
   Agent 配置或 Runner 项目配置。唯一读取的本地 Git 配置事实是 origin，用于保留既有仓库身份核对；
   每个检查点通过头尾两次 `gh repo view` 复核本地 origin 解析出的仓库身份。helper 根是唯一持有合并
   认证环境的固定可信代码，并为子进程派生互不混用的最小环境：Runner 不得取得 GitHub 凭据，Git 不得
   取得 GitHub 或模型凭据，GitHub CLI 不得取得模型凭据。
3. Story 权威文件在同一 helper 中前后各稳定读取一次；PRD、state、工作树/HEAD 质量契约和由 PRD
   派生的 TDD 配置进入与初始 Story 观察同形的摘要。裁决文件只打开一次，以同一稳定 descriptor
   读取的字节完成解析和摘要；不先 fingerprint 再重新打开。TDD `policyFiles` 始终重建为固定的
   `{path, sha256}` 字段顺序，与 `readTddConfig` 的规范形状一致。helper 只输出有界摘要与当前性字段。
4. 远端 base 改用 GitHub API 的默认分支提交身份，不在 currentness 检查点执行 `git fetch`，因此
   helper 对项目仓库保持只读。preflight 仍负责首次 fetch、祖先关系和完整上下文建立。工作树状态在
   远端读取前后各采样一次，最终一次放在 Story、裁决、分支、HEAD 和尾部仓库身份读取之后；任一轮出现
   未允许改动，或两轮规范状态字节不完全一致（包括允许生成路径发生变化），都失败关闭。PR 还必须
   保持 `head.ref` 与当前本地功能分支一致，不能只靠 PR 编号和 head SHA 间接绑定。
5. Runner `--version` 在固定临时域中运行。helper 返回后，临时域仍须通过既有身份、固定树和安全
   清理核对；每个子命令超时都用强制终止信号结束直接子进程，不依赖可被忽略的温和信号，也不按 PID
   手工追杀；整个受管 operation 继续负责发现、终止和结算任何残留后代。写入、替换、超时、外部终止
   或后代残留都撤销观察结果。
6. 每个检查点都重新启动一个受管 operation；没有跨检查点缓存。第一轮结果也必须与 preflight、
   初始 Story 观察和初始 Runner 版本对账，不能成为新的自签基线。
7. 测试 seam 只能替换整个 authority-snapshot 结果，不能让生产路径退回十个独立观察。旧细粒度
   currentness fixture 只能通过明确命名的内部测试开关使用；正式调用和普通注入默认仍走新边界。
8. Git、文件系统与 GitHub 没有共同原子快照，因此最后一次只读采样结束后仍存在不可消除的末端窗口。
   本轮不宣称线性一致性；通过头尾双读、把工作树状态置于最后，以及检查点间不缓存，使窗口不宽于旧
   路径逐项核对，并由下一个检查点重新覆盖。若未来要求原子证明，需要另立项引入仓库级冻结协议。
9. 每个 Git、GitHub CLI 或 Runner 子命令继续保留独立的 30 秒默认上限；整个 batch 的上限按固定 14
   个子进程预算之和再加有界收口余量计算。这样不会把旧路径“每项可等待 30 秒”误收窄成“全部累计只
   能等待 30 秒”，同时单项卡死仍按原上限失败关闭。固定 helper 对每次子进程启动机械计数，超过 14
   立即失败，成功输出前必须精确等于 14；结果协议再次回传并核对该计数，避免未来新增调用后预算静默
   漂移。

## 验证边界与后续事项

真实受管 authority snapshot 夹具当前依赖 POSIX 可执行脚本，因此 macOS/Linux 覆盖 operation 计数、
写入、残留后代和时序篡改；Windows 本轮只有协议与裁决单测、静态检查、类型检查、构建和现有
coordinator/Job Object 回归证据，不能称为 Windows 新路径真实运行已验证。GitHub Issue #153 独立跟踪
Windows 真实受管夹具；该缺口不阻断 #151，因为本轮没有修改跨平台 coordinator/supervisor，且扩大
夹具会把性能修复升级为跨平台测试基础设施改造。

## 黄金原则逐项对照

### 1. 先定义可证伪的完成合同

- **适用性**：适用。上表给出每一项成功证据与失败观察。
- **裁决**：完成不是“运行变快”，而是十个检查点准确计为十次且所有旧 currentness 反例保持阻断。
- **验证**：真实 coordinator 计数回归、严格协议反例、定向与全量测试。

### 2. 生成方不得给自己签发通过

- **适用性**：适用。helper 只提供机械观察，不解释模型输出，也不签发 Review。
- **裁决**：父进程继续用冻结 binding 和纯函数裁决；helper 的 schema、请求绑定、临时域与 containment
  任一项不可验证即退出 5。
- **验证**：复制结果、篡改请求、坏输出、写入与残留后代均不能产生 ready 状态。

### 3. 自治范围扩大时同步增加防线与可逆性

- **适用性**：没有扩大 Agent 自治，但一个 helper 现在负责更多只读观察，故必须收紧程序与输出边界。
- **裁决**：固定程序、绝对可执行文件、无 shell、最小环境、独立临时域、统一期限和失败关闭；回退本
  PR 即恢复旧实现，不迁移持久数据。
- **验证**：危险写入、项目配置诱导、超时、中断和后代残留测试。

### 4. 原生执行优先，差异只在控制平面

- **适用性**：适用且跨语言。
- **原生能力对照**：继续调用 host Git、GitHub CLI 和 Runner 的原生只读接口；不复制 GitHub 协议、
  不运行下游构建系统。
- **裁决**：批量编排和 schema 只存在于 runner-neutral 控制平面；Codex/Claude/Cursor 只影响已解析
  Runner 路径和最小认证环境。

### 5. 以假绿率和失败恢复衡量价值

- **适用性**：适用。本轮来自真实 Dogfood 性能故障。
- **裁决**：先固定各类失败，再实现成功路径；预期把十个检查点的受管操作从 100 降到 10，同时不
  改变任一 currentness 失败结论。
- **验证**：操作计数、真实 wall-time 对照、全部篡改矩阵及旧测试套件。

## 实施与验证顺序

1. 先写 operation 计数、协议破坏、Story/Runner/Git/GitHub/裁决篡改、写入和残留后代失败测试。
2. 实现固定 helper、严格 request/result schema、输出预算和临时域收口。
3. 接入 `verifyReviewAuthorities`，保留十个调用点与全部状态撤销行为。
4. 更新架构地图，记录“同检查点批量、检查点间不缓存”的控制边界。
5. 运行定向测试、`npm run format:check`、`npm run lint`、`npm run typecheck`、`npm test` 和构建。
6. 本轮只提供提交前 diff 与风险复核；不提交、不推送、不创建 PR。
