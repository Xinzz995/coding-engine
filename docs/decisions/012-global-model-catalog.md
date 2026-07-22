---
title: 012-global-model-catalog
status: active
updated: 2026-07-22
scope: root
---

# 012. 模型目录采用全局配置，不再依赖 runner 自主发现

## 背景

ADR-011 为按 story 难度分档的模型路由建立了稳定的项目合同，但其中的模型来源仍依赖 runner 能否提供公开、机器可读的枚举接口：Codex 走 app-server `model/list`，Claude Code 与 Cursor 无接口时退回人工清单。实践表明，这条边界并不稳定：不同 runner、版本、账号、provider 与中转站暴露能力各异，同一接口也可能改变；认证状态检查与“模型是否可列举”还会把项目派生和循环启动耦合到当前机器的外部状态。

用户真正需要的是一份跨项目复用、由自己维护且可审计的“允许使用哪些模型”目录，而不是让 coding-x 猜测当前账号可能看到什么。项目仍需要独立保存 low/medium/high、validator 与 escalation 的具体选择，因为这些映射属于当前 PRD 的执行策略，不能被全局偏好悄悄改写。

## 决策

1. 新增当前 OS 用户级的**全局模型目录**，默认路径为 `~/.config/coding-x/config.json`；环境变量 `CODING_X_CONFIG` 可显式覆盖完整路径。coding-x 不再读取 runner 的模型枚举接口、交互 TUI、内部缓存或私有协议，也不使用 `XDG_CONFIG_HOME` 引入第二条隐式路径优先级。
2. 配置格式带 `version: 1`，按 `claude`、`codex`、`cursor` 保存模型数组；每项只有必填 `id` 与可选展示字段 `label`。目录允许只配置部分 runner，数组顺序即展示顺序；同 runner 重复 ID、空白 ID、未知字段、未知 runner、错误版本或非法 JSON 均拒绝。
3. 全局目录只声明“用户允许 coding-x 选择或传给该 runner 的模型 ID”，不声称当前账号/provider 此刻一定接受它。provider 在实际调用时拒绝模型，按既有 agent 异常轮与 stall 熔断处理，不触发 escalation。
4. `coding-x models [runner] [--json]` 改为全局目录的只读查询命令，不拉起 runner CLI、不检查安装/认证、不访问网络、不自动创建或补写配置。原 `unsupported` 状态删除；三个 runner 使用同一套配置能力。
5. 新增 `coding-x config path|init|validate`：`path` 只打印解析后的路径；`init` 创建不含内置模型名单的空模板且绝不覆盖已有文件；`validate` 只做文件与 schema 校验。只有 `config init` 可写全局配置，run、models、doctor 与 skills 都只读。
6. 未启用 `prd.json.models` 且没有 CLI 模型覆盖时，继续使用 runner 默认模型，不要求全局配置。存在待执行 story，且启用了项目模型路由或传入任一 `--builder-model` / `--validator-model` / `--escalation-model` 时，启动预检只允许本次可能实际调用且已在对应 runner 全局目录声明的 ID；缺配置、runner 无目录或所需 ID 未声明均在 agent 与 dashboard 启动前失败。若 PRD 缺失/无法解析而历史修复循环仍可能启动 agent，任何 CLI 模型覆盖也必须先通过目录复核。
7. 被 CLI 完全遮蔽、因此本次不会实际调用的旧 PRD 模型不阻塞运行，但给出“未在全局模型目录声明”的警告并提示重新执行 `prd-to-json`。已收敛 workspace 没有模型调用，仍校验 PRD schema 与 runner 一致性，但跳过目录读取。
8. `prd-to-json` 继续把项目的 runner 与五项映射写入 `prd.json`，但候选只能来自全局目录；目录缺失或非法时不得接受会话内临时模型列表绕过。用户可以先维护全局配置，也可以选择不启用模型路由并继续普通转换。再派生只在原五项仍存在于当前目录时保留原选择。
9. 全局配置不是 workspace 运行时状态：不写入 `--workspace`，不进入 `engine.lock`，不复制进 `prd.json`、state、evidence 或验证报告。evidence 仍只记录某轮实际传给 runner 的模型与路由来源。

本 ADR 只取代 ADR-011 中“公开接口发现 + unsupported/人工降级 + 启动时在线模型可用性复核”的部分；ADR-011 的 runner 绑定、难度分档、首次有效失败升级、CLI 优先级与可观测性继续生效。完整合同见 `docs/archive/superpowers/specs/2026-07-22-global-model-catalog.md`。

## 理由与被否备选

- **用户维护目录而非自主发现**：模型 ID 是显式运行策略；把选择边界固定为用户配置，比依赖三个版本节奏不同的 CLI 更确定、可测试、可审计。
- **全局目录而非项目重复清单**：可选模型属于用户与 runner 环境的偏好，多个项目重复保存会漂移；项目只保存从目录中选出的当前映射，职责清晰。
- **目录声明而非实时可用性证明**：认证、配额、provider 路由和模型下线会在任意时刻变化。静态目录无法证明实时可用，coding-x 不再给出这种承诺；真实调用结果才是运行证据。
- **不内置厂商名单**：内置名单会随模型发布、别名和中转站变化而过时，也会把包升级变成目录更新前提。
- **不保留会话内人工列表兜底**：临时输入会绕开唯一来源，使同一项目在不同会话得到不同候选；正确动作是先更新全局目录。
- **不把五项路由也全局化**：story 难度映射、validator 与 escalation 是项目执行意图。全局默认映射会让项目结果受外部文件变化影响，削弱 `prd.json` 的可审计性。
- **不自动写回发现结果**：本决策明确取消发现；任何自动补全都会重新引入外部状态和隐式变更。
- **固定默认路径 + 单一环境变量覆盖**：路径规则越少越可预测。CI、测试和多环境用 `CODING_X_CONFIG` 显式注入，不再叠加 XDG/runner 私有路径。

## 后果

- 启用模型路由的 v0.23 workspace 在 v0.24 首次运行前，需要把所引用模型登记进全局目录；`prd.json` schema 本身不迁移。零配置 runner-default 行为保持兼容。
- `coding-x models --json` 的公开语义从“尝试查询当前 provider”变成“读取用户目录”，且不再返回 `unsupported`；属于面向用户的行为变化，随 minor 版本 **0.24.0** 发布。
- 模型目录查询不再受 runner 是否安装、登录、欠费或联网影响，派生和预检更确定；代价是目录可能陈旧，真实调用仍可能失败。
- 全局配置增加一个 workspace 之外的用户文件；它不是运行时状态，只有显式 `config init` 写入，且不存账号、密钥、base URL、provider 或二进制路径。
- doctor 增加目录健康检查：无模型路由时配置缺失仅提示；配置文件存在但非法，或当前 PRD 启用路由却缺目录/runner/模型 ID 时计为失败；不做在线探测。
- token/费用统计、reasoning effort/mode、service tier、runner 安装与认证诊断仍是独立议题，不随本决策实现。
