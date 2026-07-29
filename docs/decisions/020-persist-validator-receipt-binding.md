---
title: 020-persist-validator-receipt-binding
status: active
updated: 2026-07-29
scope: root
---

# 020. 持久保存并持续核对 Validator 目标绑定

## 背景

ADR-015 保证单次 Validator 调用的结构化结果与本轮 request、story、验收标准摘要和 Git HEAD
一致，但 ADR-013 的持久完成态仍只有 `validated` 布尔值。提交或验收标准随后变化时，该布尔值
无法证明仍然新鲜。现有启动失效又以旧 Final Review 为间接锚点，导致没有 Final Review、文件
损坏或多 Story 后续提交时，旧 Story 可能未经最终提交重验就进入 Final Review。

## 决策

每个 Story 的引擎独占状态增加结构化 `validationReceipt`，固定记录 schema 版本、request ID、
非空 Git HEAD 和有序 acceptanceCriteria 摘要。引擎只有在合法 Validator claim 已通过全部
协议检查且调用期间 HEAD 未变化时，才原子写入 `validated=true` 与完整凭证。

正式通过不再由裸布尔值决定。引擎以当前 PRD、当前 Git HEAD 和 Story 状态统一评估：非
blocked、`passes=true`、`validated=true`、凭证结构合法、凭证 HEAD 等于当前 HEAD 且验收
摘要等于当前有序标准，缺一不可。

Validator 启动前后都必须确认已跟踪内容与索引等于 HEAD，没有除受控 workspace
外的未忽略未跟踪路径，且 Git HEAD 没有变化。凭证因此绑定已提交内容的身份，
不会把 Git 可见的未提交源码包装成某个提交的验证结果。Git ignored 文件、依赖与本机
配置仍可被 Developer/Validator 或项目命令观察，不在当前凭证内；Issue #91 跟踪精确 HEAD
临时干净检出中的本地 setup、机械检查与 Validator 执行。

启动、每轮选取前、Validator 完成后以及 Final Review 前后都执行同一对账。失效的实现候选
保留 `passes=true`，清除验证态和凭证，进入 validation-only 轮：跳过 Developer，仍完整运行
机械检查和 Validator。若重验失败，再回到 `passes=false` 交给 Developer。所有 Story 因此在
最终 Review 前收敛到同一 HEAD，且不会因纯新鲜度问题产生重复实现调用。

项目机械检查会执行仓库代码，但没有 workspace 状态所有权。普通检查和 TDD 检查前后对
`state.json` 做完整快照比较；任何改写都恢复并以 `gate` 来源留痕，不能替其他 Story 伪造凭证。
`--max-iter` 继续约束实现/修复轮；validation-only 的总余量按“Story 数量 × `stall-limit`”
计算，相当于为每个 Story 预留 `stall-limit` 轮，允许瞬时失败后仍有成功机会，同时不让确定性
收敛步骤挤占实现预算。

正式模式无法读取 Git HEAD 时，在任何 Agent 或 Review 模型调用前返回配置/状态错误。旧状态
可解析但不自动视为当前有效；不从 evidence、Final Review 或当前文件反向补造凭证。

status、report、dashboard 与循环消费同一评估结果。Final Review 前置先核对 Git 可见的
工作树状态，再在项目机械检查前冻结全部 Story 凭证摘要；检查返回后重新核对凭证
身份和同一状态，再允许 Reviewer 运行；模型后、远端查询后及结果写入后继续核对，防止
项目命令伪造凭证、留下 Git 可见的未提交源码或运行中漂移。
最终机械检查前还冻结 `state.json` 与旧 Final Review 文件；项目命令、Reviewer 或远端查询改写
任一文件时恢复原快照并阻断，刚写的新结果返回前再次按完整内容复核。

正式 Agent 的可执行程序在任何项目代码运行前解析到绝对真实路径，并冻结文件身份、内容摘要和版本。
同一启动文件供 Developer、Validator 与三个 Review 轴复用，并在项目检查、模型调用和结果返回边界
复核；PATH、软链接或文件任一漂移都使本轮不可验证。Developer/Validator 保留项目执行环境，只有
只读 Reviewer 另用受控 HOME、TMP、系统 PATH 和认证快照，不能把两种权限边界混写。
首版只接受项目外的原生单文件程序；Node、shell、npm 与 Windows 命令脚本都保守返回不可验证。
当前仍依赖脚本包装器的 Cursor 入口，以及尚不能可靠收口进程树的 Windows 正式 Review，等待专用
适配后再声明支持。

`review-decisions.json` 在 coding-x 启动、任何项目代码执行前按原始字节冻结。Agent、机械检查或
Reviewer 在运行中改写它时，引擎恢复启动快照、删除已产生的 Final Review 并返回不可验证；
合法新裁决只能在本轮退出后由 `/review-loop` 写入，再由下一次运行消费。

Final Review 还绑定启动 PRD 中 `models` 路由政策的稳定摘要；命令行临时模型覆盖不进入该摘要，
但实际 Runner、模型与 Runner 版本继续分别绑定。Spec 或工程 Reviewer 主动要求深度评审时，
引擎以固定风险类别和原因更新唯一风险判断；读取状态时由已保存的评审轴重建同一判断，无法
重建或轴与风险矛盾的结果一律视为损坏。

status 与 report 在远端查询结束后重读 PRD、Story 状态和 HEAD，以最终快照决定展示与退出码，
不能一边显示旧绿态、一边只把 Review 标成过期。依赖 P1 延期的结果还必须重新查询关联 Issue；
本地模式无法刷新、Issue 关闭、字段缺失或过期时均不得继续显示为当前可交付。

## 信任边界

该凭证是引擎控制流中的持久身份记录，不是数字签名。engine、agent 和用户仍共享本机权限，
有权限直接改 workspace 的恶意进程可以伪造文件。本决策消除正常运行、异常恢复和展示消费中
的过期/错绑假绿，不声称建立本机外部可信根，也不让 GitHub 证明本地 Review。

Runner 冻结只覆盖实际原生入口、Reviewer 的受控环境与可复核的本地 Git 控制面，不覆盖原生动态库
或操作系统组件。Node 也没有跨平台的通用“按已打开文件描述符执行”能力，因此调用前后复核不能宣称消除同一
系统用户在极短窗口内主动替换文件的竞态。当前目标是阻止项目正常命令、PATH 漂移、Git 替代对象
和常见入口替换造成的错绑；若以后把主动同账户本机攻击者纳入威胁模型，需要独立安装根、完整制品
清单或签名验证，不能继续扩大本地摘要的含义。

## 理由与备选

- **保留布尔字段并增加结构化凭证**：兼容现有展示和 schema，同时让完成判定有可复核身份；
  单纯扩展 `validated` 的含义仍无法判断新鲜度。
- **validation-only 收敛而非全部退回 Developer**：过期表示证据需重验，不等于实现已知错误；
  只有机械检查或 Validator 发现失败才需要再次实现。
- **任一提交使所有旧凭证失效**：无法低成本且可靠地证明某个后续提交不会影响另一 Story；
  保守全量重验比基于路径猜测更真实。
- **精确有序 AC 摘要**：验收标准文字、数量或顺序任一变化都可能改变要求，不采用“实质变化”
  的模型判断。
- **不从历史证据迁移**：旧 evidence 和 Final Review 是不同目的的记录，反推会把无法证明的
  历史结论包装成当前凭证。
- **不使用全工作树哈希或签名**：当前核对已跟踪内容、索引和未忽略路径；直接读取全部
  ignored 文件会引入密钥、庞大依赖树与正常可变缓存，同权限签名也不能增加真实隔离。
  这一本地执行环境边界必须用 Issue #91 的干净检出执行解决，不把未实现的全树绑定写成事实。

## 后果

- 旧 workspace 第一次由新版本正式运行时需要重新验证已通过 Story；没有旧项目迁移承诺。
- Final Review v1 缺少 Story 凭证、冻结裁决与 PRD 路由绑定，不迁移、补造或继续视作通过；
  必须重新运行正式流程生成 v2。
- `passes=true, validated=false, validationReceipt=null` 从异常残态升级为明确的“实现候选待验收”
  状态，循环不得在启动时无条件打回。
- 状态、status JSON 和 dashboard API 增加公开字段：每个 Story 暴露 `validationReceipt`，status 与
  dashboard 暴露 `validationInvalidations`，Final Review v2 增加 Story 凭证、冻结裁决与 PRD 路由
  摘要绑定；属于需要 minor 版本的行为变化。
- ADR-013 的 legacy 自动视作已验证、ADR-015 的 `gitHead:null` 正式降级，以及 ADR-014 的
  缺失 state 历史绿灯兼容范围被本 ADR 取代。
