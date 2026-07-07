---
title: "静态 HTML 验证报告设计"
status: done
updated: 2026-07-08
scope: root
---

# 静态 HTML 验证报告设计

日期：2026-07-08
来源：validation gate 调研吸收轮 #3「静态 HTML 验证报告存档」（no-mistakes 借鉴候选 ④）；素材已由 2026-07-07 引擎真实跑 dogfood 备齐（61 个截图工件、review 留痕、tampered 归档）。

## 背景与动机

一次循环的验证证据散落在 `.workspace/` 各处：story 状态在 state.json、验收标准在 prd.json、过程记录在 progress.md、截图在 screenshots/、人审包在 review-*.md、篡改痕迹在 prd.tampered-*.json。现有查看渠道各有空档：实时 dashboard 要起 HTTP 服务且不展示截图/review/篡改记录；`coding-x status` 是终端速览。「跑完之后双击打开、证据齐全、可留档」这个位置是空的。

核心读者是**合并裁决者**：跑完循环、跑完 /review-loop 之后，打开一份报告核对全部证据（AC 状态、门禁、截图、红旗区、人审留痕），辅助「该不该合并」的裁决；合并后随 workspace 归档留存审计轨迹。

## 锁定决策

1. **生成时机=自动+子命令**：循环结束（无论退出码）自动生成一份；另提供 `coding-x report` 子命令随时重生成（幂等覆盖）。关键时序：循环结束时 review-*.md 尚不存在（/review-loop 是事后跑的，四态回填更晚），自动生成的报告 review 区诚实显示「尚无人审包」，人审与裁决回填之后重跑 `coding-x report` 刷新。
2. **截图=相对路径引用，不内嵌**：报告落 `.workspace/report.html`，与 `screenshots/` 天然同目录，`<img src="screenshots/…">` 直接工作。报告永远轻量；代价是离开 .workspace/ 断图，分享需带上 screenshots/ 目录（用户拍板接受）。
3. **架构=纯函数渲染，与 status 模块同构**：`collectReport` + `renderReportHtml` 纯函数、cli 编排写盘。渲染正确性就是产品正确性（blocked 不得被渲染成绿色），全链路 vitest 可测优先于模板文件的编辑体验；dashboard 的模板资产模式（浏览器端 JS 渲染，vitest 够不着）不采用。
4. **报告是存档不是门禁**：`coding-x report` 生成成功即退出 0，与 story 通过与否无关（循环成败的 CI 语义归 `coding-x status`）；workspace 不可用（missing/unparsable）退出 2（对齐 status），写盘失败退出 1。
5. **报告生成失败绝不影响循环结果**：loop.ts 里 try/catch 包裹，失败只 warn——报告是副产物。

## 报告信息架构（七区）

自上而下按裁决者的问题序列组织：

1. **头部概要**——project / branchName / sourcePrd / 生成时间；结果横幅三态：全部通过（N/N）、有 blocked（N passed, M blocked）、进行中（报告可在任意时刻生成，诚实呈现当下）；门禁配置 qualityChecks 逐条（未启用则明示）；模型路由 models 段（未配置则省略）；统计（story 数 / 截图工件数 / review 文件数）。
2. **红旗区**（条件渲染，置顶红色）——存在 `prd.tampered-*.json` 时逐个列出 + 核对指引（「diff 该存档与 prd.json，核对运行期被改了什么」，ADR-007），与 /review-loop 人审包红旗区同一语义。无篡改文件时整区不渲染。
3. **story 证据卡片**（核心区，每 story 一卡）——标题行：id + title + 状态徽章（✅ 通过 / ⛔ blocked / ⬜ 未完成，沿用 status 的三态符号）+ 重试次数（retryCount>0 才显示）；acceptanceCriteria 逐条列表；notes 全文等宽呈现，其中仲裁标签行（`ARBITRATION_PREFIXES`）、`[门禁失败…]` 行、`[BLOCKED…]` 行分别高亮样式；截图画廊按命名规范归属到 story，builder / validator 分组标注，图片点击 `<a target="_blank">` 看原图，非图片工件（如 `-export.pdf`）渲染为文件链接行。
4. **未归类工件**（条件渲染）——screenshots/ 内命名无法归属到任何 story 的文件列于卡片区之后。workspace 根的散落文件（如 agent 下载的临时产物）**不枚举**：报告只认结构化产物与 screenshots/，避免把 report.html 自身卷进来。
5. **review 留痕区**——全部 `review-*.md` 按文件名序渲染；一份都没有时显示「尚无人审包——循环结束后运行 /review-loop，再跑 `coding-x report` 刷新本报告」。
6. **progress 过程记录**——progress.md 全文，`<details>` 默认折叠的附录（对裁决是背景不是主线）。
7. **页脚**——生成时间、workspace 路径、「由 coding-x report 生成」。不追引擎版本号：tsup 单 bundle 与 tsx 直跑两形态下定位 package.json 的相对路径不一致，为一行小字引入路径脆弱点不值（取舍；需要版本追溯时看 git/npm 环境）。

markdown 呈现：review 与 progress 都是结构化 md，`<pre>` 原文太生硬；内置零依赖最小 md 渲染器，仅六种构造（`#`/`##`/`###` 标题、`-` 列表、`**粗体**`、`` `内联 code` ``、``` 围栏代码块、普通段落），HTML 转义先行，其余原样成段。不引依赖、不求全。

视觉：复制 dashboard 的 CSS 变量与 mac 配色定义（不共享文件——报告要永久自包含，两者生命周期不同）；中文界面；CSS 内联 `<style>`；**零浏览器 JS**（折叠用原生 `<details>`）。

## 数据模型与收集

`src/report/report.ts`：

```ts
export type ReportSource =
  | { status: 'missing'; workspace: string }      // 无 prd.json
  | { status: 'unparsable'; workspace: string }   // prd.json 解析失败或 userStories 非数组
  | { status: 'ok'; data: ReportData };

export interface ScreenshotEntry {
  filename: string;                    // 原始文件名
  storyId: string | null;              // 归属 story id（null=未归类）
  phase: 'builder' | 'validator' | null;
  isImage: boolean;                    // png/jpg/jpeg/gif/webp
}

export interface ReportData {
  workspace: string;
  generatedAt: Date;                   // 调用方注入，保持纯函数可测
  prd: Prd;
  stories: StoryView[];                // 复用 mergedStories（state 缺失/损坏回退语义与 status/dashboard 一致）
  stateCorrupted: boolean;             // state.json 存在但解析失败——报告内警示
  progress: string;                    // '' = 缺失
  reviews: { filename: string; content: string }[];  // review-*.md，文件名序
  tamperedArchives: string[];          // prd.tampered-*.json 文件名，名序
  screenshots: ScreenshotEntry[];
}

export function collectReport(workspace: string, now: Date): ReportSource;
```

- 三态判定与 `collectStatus` 同构：无 prd.json → missing；解析失败/形状非法 → unparsable；其余 ok（state/progress/screenshots/review 全容错，缺什么记什么）。
- 截图归属解析：文件名剥离 `builder-`/`validator-` 前缀后，与 prd userStories 的 id **大小写不敏感**匹配（实测两类命名：`builder-US-008-6.png`、`validator-us-008-pass-1.png`、`validator-us-008-export.pdf`——序号尾缀与语义尾缀都存在，匹配以 story id 段为锚而非尾缀格式）；匹配不到任何 story 的 `storyId=null` 落未归类。只读 screenshots/ 一层（忽略子目录）。
- 文件匹配：`/^review-.*\.md$/`、`/^prd\.tampered-.*\.json$/`。

## 渲染与安全

`src/report/render.ts`：`renderReportHtml(data: ReportData): string` 纯函数（missing/unparsable 不出报告，不进渲染层）。

**安全硬要求**：所有来自文件的文本（notes、AC、md 内容、文件名）一律 `escapeHtml`（`& < > "`）后进标记；文件名进 `src`/`href` 时 `encodeURIComponent`。威胁模型延续 ADR-007：builder 是半信任 agent，notes 里写 `<script>` 不得在裁决者浏览器里执行。

仲裁行高亮复用 gate.ts 的 `isArbitrationLine`——报告成为 `ARBITRATION_PREFIXES` 第六消费方，gate.ts 的消费方清单注释同步补一条。

## 接线

- **CLI**：`command` union 加 `'report'`；`coding-x report [--workspace]` → collect → missing/unparsable 报错退出 2（文案风格对齐 status）→ render → 写 `.workspace/report.html` → log 路径退出 0；写盘异常退出 1。
- **loop.ts**：for 循环结束后（完成 break 与 maxIterations 用尽两条路都过）、tamper summary 输出之后、keepOpen 判定之前，无条件 try 生成（进行中态也诚实存档）；成功 `📄 验证报告: <path>`，失败 warn 不动退出码。
- **版本**：新子命令 + 新自动产物 = 面向用户功能 → minor **0.19.0**。
- **文档同步**：README（CLI 参数表、`.workspace/` 目录结构加 report.html、快速开始一句）；architecture.md 模块表 +1 行、数据流节提及产物。

## 测试

- collect：三态；截图归属各变体（`builder-US-008-6.png` / `validator-us-008-pass-1.png` / `-export.pdf` 非图片 / 大小写混用 / 未归类）；review/tampered 收集与排序；state 损坏标记。
- render：徽章三态；红旗区条件渲染（有/无）；仲裁行高亮 class；AC 文本呈现；img 相对 src 与 URL 编码；**转义**（notes 含 `<script>` 输出必须是 `&lt;script&gt;`）；「尚无人审包」占位；md 渲染器六构造。
- cli：report 子命令解析与三退出码路径。
- loop：fake-agent 端到端跑完后 `report.html` 存在且含关键标记。
- 提交前 `npm run typecheck` + `npm test` 全绿（硬约束）。

## 非目标

- 不做历史轮（`archive-run-*/`）聚合——报告只呈现当前轮。
- 不做截图 base64 内嵌与体积预算（用户拍板走相对引用）。
- 不做完整 markdown 渲染器（六构造够用，其余原样）。
- 不做报告端交互（筛选/搜索/排序）——零 JS 静态存档。
- dogfood-regression.md 断言清单是否补报告项，留 /compound-docs 收口时定。
