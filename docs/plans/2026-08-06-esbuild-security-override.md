---
title: esbuild Windows 开发服务器安全修复
status: active
updated: 2026-08-06
scope: root
---

# esbuild Windows 开发服务器安全修复

## Context

`npm audit` 报告 GHSA-g7r4-m6w7-qqqr：esbuild 0.27.3 至 0.28.0 的 Windows 本地开发
服务器可能接受反斜杠路径并读到服务目录之外。项目不启动 esbuild 开发服务器，因此实际暴露面低；
但 `tsup@8.5.1` 仍安装受影响的 esbuild 0.27.7，仓库安全检查不能得到零告警结果。

上游 esbuild 0.28.1 已修复问题。`tsx@4.23.9` 已使用该安全版本；当前最新的
`tsup@8.5.1` 仍声明 `esbuild ^0.27.0`，且没有更高 tsup 版本可升级。普通
`npm audit fix` 不会修改依赖树。

本任务由限时政策例外 Issue #182 跟踪。

## Goals

- 仅针对版本范围落后的 tsup 使用 npm 原生、精确且可撤销的 override，将完整依赖树统一到
  esbuild 0.28.1，不限制其他工具未来独立升级。
- 删除已不再安装的 esbuild 0.27.7 脚本许可。
- 证明 tsup 构建、tsx 执行、Vitest 测试和跨平台检查在 override 下保持兼容。
- 在 tsup 正式支持 esbuild 0.28.x 后删除临时 override。

## Non-Goals

- 不替换构建工具，不升级 TypeScript、Node 类型或其他无关依赖。
- 不改变运行时代码、npm 发布流程或质量契约。
- 不因告警等级低而降低或跳过现有检查。

## Acceptance Criteria

1. `npm ci` 成功，`npm ls esbuild --all` 只显示 esbuild 0.28.1。
2. `npm audit --json` 报告漏洞总数为 0。
3. `package.json` 只保留 esbuild 0.28.1 的安装脚本许可，并精确记录临时 override。
4. 格式、静态检查、类型检查、全量测试、构建、成品 CLI、仓库健康和兼容性检查通过。
5. PR 关联 Issue #182；政策检查、CodeQL、六个平台检查和 `quality-gate` 全部通过。
6. 合并后 `main` 的安全检查保持绿色，Issue #182 记录合并证据后关闭。

## Golden Principles

| 原则 | 适用性与设计裁决 | 验证证据 |
|---|---|---|
| 1. 可证伪完成合同 | 适用。依赖树、审计总数、构建与测试都有精确成功和失败结果。 | `npm ls`、`npm audit`、本地与远端检查。 |
| 2. 生成方不得自签 | 适用。版本声明不算修复，必须由 npm 审计、构建和 CI 独立裁决。 | 锁文件、审计 JSON、GitHub checks。 |
| 3. 自治与可逆性对称 | 适用。override 精确固定且可由普通 PR 删除；不扩大自动合并或发布权限。 | `package.json`、Issue #182、回退 PR。 |
| 4. 原生执行能力优先 | 适用。使用 npm 原生 override，不引入新服务、脚本或依赖管理器。 | npm 安装结果和锁文件。 |
| 5. 假绿与失败恢复优先 | 适用。审计必须从一项降为零项，完整构建和跨平台测试证明范围外版本仍兼容。 | 审计前后对照、全量测试、六平台 CI。 |

## Removal Condition

当 tsup 发布的新版本正式声明支持 esbuild 0.28.x 或更高安全版本时，另开 PR 删除 override，
让上游依赖范围重新成为唯一版本来源。该 PR 必须同步删除或改写临时版本 guard，并证明实际锁定
的所有 esbuild 版本都不在漏洞范围、`npm audit` 仍为零，以及其余格式、类型、测试、构建和
跨平台门禁全部通过；不再要求满足“override 必须存在”或“只能是 0.28.1”这两项临时条件。

## Rollback

若 override 导致任何构建、执行或跨平台异常，回退本 PR并重新打开 Issue #182。不得用忽略审计、
强制安装、跳过测试或降低门禁来制造绿色结果。
