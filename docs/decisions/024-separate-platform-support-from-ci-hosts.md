---
title: 024-separate-platform-support-from-ci-hosts
status: active
updated: 2026-08-08
scope: root
---

# 024. 分开表达产品平台、项目验证平台与 CI 宿主

## 背景

coding-x 会直接处理路径、文件身份、进程树和系统原生 helper，因此“能在某个系统安装”不能只由
TypeScript 单测或在 Ubuntu 上构建成功推断。另一方面，目标项目通常只部署到一个系统；让每个项目
无条件生成 Linux、macOS、Windows 三套任务，会增加无意义的成本，也会把 CI 机器误写成产品需求。

当前仓库已经在三类系统运行源码测试，但候选发布物只在 Ubuntu 打包和检查。Unix 的 npm 命令入口
通常是符号链接，Windows 是 `.cmd` 包装文件；直接执行 `node dist/cli.js` 不能证明用户实际安装后的
命令入口可用。

## 决策

1. coding-x 产品继续支持 `linux`、`darwin`、`win32`，并在 npm 元数据中明确该边界；不声明未验证的
   处理器架构组合。
2. 质量契约新增 `github.requiredPlatforms`。它表示目标项目交付前必须验证的系统族，不等于 CI 通用
   任务必须运行的宿主，也不要求每个项目都选择三项。
3. `coding-x init` 只把已提交 GitHub workflow 中明确写死的 runner 当作提示；最终平台必须由用户明确
   选择。动态 matrix、表达式和 self-hosted runner 不猜测。非交互初始化必须提供人工确认的契约。
4. 通用格式、静态检查、安全扫描、候选构建、暂存和发布继续集中在固定 Ubuntu 宿主；平台相关行为在
   对应系统运行。
5. coding-engine 自身持续验证 Linux、macOS、Windows 和 Node 22/24，并补齐 macOS Node 22。
6. 候选只在 Ubuntu 构建一次。三个系统下载同一 artifact、核对同一摘要、在全新目录通过 npm 安装，
   再经真实 npm 命令入口启动。三项由同一次候选工作流的总闸汇总；任一失败、取消、超时或跳过都会让
   候选运行失败，因此现有 stage 工作流不能提升该候选。
7. GitHub hosted runner 最终使用明确稳定版本；`latest` 只留给另行设置的观察性 canary，不作为正式
   凭证。唯一过渡例外是仍由 0.34.1 逐字核对的 quality/policy 两个托管流程：功能 PR 保持旧字节，
   0.35.0 发布后的独立 Policy PR 才与固定裁判版本一起切换。

`requiredPlatforms` 是 schema v2 的可选扩展：旧 v2 文件缺少该字段时，从已声明 jobs 的平台并集只读
派生，不改写文件，也不改变旧文件摘要。新生成的契约必须显式写入。契约仍固定精确 coding-x 版本，
因此不承诺旧版解析器读取新字段。coding-engine 的功能/版本 PR 继续由已发布旧裁判审查：先通过旧字段
派生平台并发布新 minor，之后才用独立 Policy PR 同时更新固定裁判版本和显式字段，候选不能先把自己
写成正式裁判。

## 后果

- 服务器项目可以只选择 Linux，桌面项目可以选择 macOS 和 Windows，跨平台 CLI 可以选择三项；
- Ubuntu 仍可承担 CodeQL、格式、安全发布等控制任务，而不会被误解为目标项目必须部署到 Linux；
- 发布前新增一次三系统安装证明，但只构建一个候选，不产生三个不同制品；
- coding-engine 的正式参考环境固定为 Ubuntu 24.04 x64、macOS 26 arm64、Windows Server 2022 x64；
  其他发行版、系统版本和架构不由这组自动证据单独证明；
- 这是面向用户的支持合同变化，随下一 minor 版本发布。

## 不采用的方案

- 不删除 Linux：真实服务型下游和发布控制面仍以 Linux 为主，且 Linux 专属安全边界必须在真机验证；
- 不把全部任务复制到三系统：格式、CodeQL 和发布授权没有平台差异，重复运行只增加噪声；
- 不让 `init` 根据现有 workflow 自动决定产品平台：CodeQL 或发布任务使用 Ubuntu，并不能证明目标项目
  部署到 Linux；
- 不分别构建三个候选：这会破坏 Dogfood、暂存和稳定发布消费同一 tarball 的既有可信链；
- 不以直接运行 `dist/cli.js` 代替 npm 安装证明。
