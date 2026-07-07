---
title: "静态 HTML 验证报告实施计划"
status: active
updated: 2026-07-08
scope: root
---

# 静态 HTML 验证报告实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 一次循环的验证证据（story 状态/AC、门禁配置、截图、人审留痕、篡改红旗）汇总成 `.workspace/report.html` 静态单页——循环结束自动生成，`coding-x report` 子命令随时重生成。

**Architecture:** 与 `src/status/` 同构的纯函数三段式：`collectReport`（读 workspace → `ReportData`，三态容错）→ `renderReportHtml`（`ReportData` → HTML 字符串，零浏览器 JS）→ `writeReport` 编排落盘；cli 与 loop 两个调用方。截图相对路径引用不内嵌。规格：`docs/superpowers/specs/2026-07-08-static-html-report-design.md`。

**Tech Stack:** TypeScript strict / ESM（NodeNext）、node:fs 同步 API、Vitest（临时目录 fixture + fake-agent stub）。

## Global Constraints

- `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）。
- 零新增运行时依赖（引擎唯一运行时依赖保持 jsonrepair）。
- 引擎只读写 `--workspace` 目录；报告落 `<workspace>/report.html`，幂等覆盖。
- 所有来自文件的文本（notes/AC/md/文件名）必须 `escapeHtml` 后进标记；文件名进 `src`/`href` 必须 `encodeURIComponent`。
- 报告 HTML 零浏览器 JS（折叠用原生 `<details>`）。
- 每个任务提交前 `npm run typecheck` 与 `npm test` 必须全绿。
- 提交说明中文，conventional 前缀（feat:/docs:/release:）保留英文。
- 版本策略：全部任务完成 + /review-loop 人审通过后发 minor **0.19.0**（Task 5，含人审 gate）。

---

### Task 1: `src/report/report.ts` — 数据收集（collectReport）

**Files:**
- Create: `src/report/report.ts`
- Test: `src/report/report.test.ts`

**Interfaces:**
- Consumes: `tryReadPrd`/`Prd`（`../engine/prd.js`）、`tryReadState`/`mergedStories`/`initialStateFor`/`StoryView`（`../engine/state.js`）、`readProgress`（`../engine/progress.js`）。
- Produces（后续任务依赖的精确签名）:
  - `interface ScreenshotEntry { filename: string; storyId: string | null; phase: 'builder' | 'validator' | null; isImage: boolean }`
  - `interface ReportData { workspace: string; generatedAt: Date; prd: Prd; stories: StoryView[]; stateCorrupted: boolean; progress: string; reviews: { filename: string; content: string }[]; tamperedArchives: string[]; screenshots: ScreenshotEntry[] }`
  - `type ReportSource = { status: 'missing'; workspace: string } | { status: 'unparsable'; workspace: string } | { status: 'ok'; data: ReportData }`
  - `function collectReport(workspace: string, now: Date): ReportSource`
  - `function parseScreenshotEntry(filename: string, storyIds: string[]): ScreenshotEntry`（导出供单测）

- [ ] **Step 1: 写失败测试**

创建 `src/report/report.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectReport, parseScreenshotEntry } from './report.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'report-ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const story = (id: string) => ({
  id, title: `t-${id}`, description: 'd', acceptanceCriteria: [`ac of ${id}`], priority: 1,
});

function writePrd(dir: string, stories: unknown[], extra: Record<string, unknown> = {}): void {
  writeFileSync(join(dir, 'prd.json'), JSON.stringify({
    project: 'proj', branchName: 'ralph/x', description: 'd', userStories: stories, ...extra,
  }));
}

describe('collectReport 三态', () => {
  it('无 prd.json 返回 missing', () => {
    const dir = ws();
    expect(collectReport(dir, new Date())).toEqual({ status: 'missing', workspace: dir });
  });

  it('prd.json 解析失败或 userStories 非数组返回 unparsable', () => {
    const a = ws();
    writeFileSync(join(a, 'prd.json'), '{ broken');
    expect(collectReport(a, new Date()).status).toBe('unparsable');
    const b = ws();
    writeFileSync(join(b, 'prd.json'), JSON.stringify({ project: 'p', userStories: 'nope' }));
    expect(collectReport(b, new Date()).status).toBe('unparsable');
  });
});

describe('collectReport ok 收集', () => {
  it('全量素材各就各位：state 合并、review 名序、tampered 名序、截图归属', () => {
    const dir = ws();
    writePrd(dir, [story('US-001'), story('US-002')]);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      'US-002': { passes: false, notes: '[需求冲突] x', retryCount: 2, blocked: true },
    }));
    writeFileSync(join(dir, 'progress.md'), '# 进度日志\n- 学到了');
    writeFileSync(join(dir, 'review-2026-07-08-2.md'), 'second');
    writeFileSync(join(dir, 'review-2026-07-08.md'), 'first');
    writeFileSync(join(dir, 'prd.tampered-20260708-010101.json'), '{}');
    mkdirSync(join(dir, 'screenshots'));
    writeFileSync(join(dir, 'screenshots', 'builder-US-001-1.png'), 'x');
    writeFileSync(join(dir, 'screenshots', 'validator-us-002-pass-1.png'), 'x');
    const now = new Date('2026-07-08T12:00:00');
    const src = collectReport(dir, now);
    if (src.status !== 'ok') throw new Error('expected ok');
    const d = src.data;
    expect(d.generatedAt).toBe(now);
    expect(d.prd.project).toBe('proj');
    expect(d.stories.map((s) => [s.id, s.passes, s.blocked])).toEqual([
      ['US-001', true, false], ['US-002', false, true],
    ]);
    expect(d.stateCorrupted).toBe(false);
    expect(d.progress).toContain('学到了');
    expect(d.reviews.map((r) => r.filename)).toEqual(['review-2026-07-08-2.md', 'review-2026-07-08.md']);
    expect(d.reviews[1].content).toBe('first');
    expect(d.tamperedArchives).toEqual(['prd.tampered-20260708-010101.json']);
    expect(d.screenshots).toEqual([
      { filename: 'builder-US-001-1.png', storyId: 'US-001', phase: 'builder', isImage: true },
      { filename: 'validator-us-002-pass-1.png', storyId: 'US-002', phase: 'validator', isImage: true },
    ]);
  });

  it('state.json 缺失按初始态回退且不算损坏；无 screenshots 目录得空数组', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.stories[0].passes).toBe(false);
    expect(src.data.stateCorrupted).toBe(false);
    expect(src.data.screenshots).toEqual([]);
    expect(src.data.reviews).toEqual([]);
    expect(src.data.tamperedArchives).toEqual([]);
    expect(src.data.progress).toBe('');
  });

  it('state.json 损坏标记 stateCorrupted 且按初始态显示', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    writeFileSync(join(dir, 'state.json'), '{ broken');
    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.stateCorrupted).toBe(true);
    expect(src.data.stories[0].passes).toBe(false);
  });

  it('screenshots 子目录被忽略', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    mkdirSync(join(dir, 'screenshots', 'sub'), { recursive: true });
    writeFileSync(join(dir, 'screenshots', 'builder-US-001-1.png'), 'x');
    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.screenshots.map((s) => s.filename)).toEqual(['builder-US-001-1.png']);
  });
});

describe('parseScreenshotEntry 归属解析', () => {
  const ids = ['US-001', 'US-008', 'US-1', 'US-10'];
  it('builder 序号命名归属', () => {
    expect(parseScreenshotEntry('builder-US-008-6.png', ids)).toEqual({
      filename: 'builder-US-008-6.png', storyId: 'US-008', phase: 'builder', isImage: true,
    });
  });
  it('validator pass 命名归属（story id 段大小写不敏感）', () => {
    expect(parseScreenshotEntry('validator-us-008-pass-1.png', ids)).toEqual({
      filename: 'validator-us-008-pass-1.png', storyId: 'US-008', phase: 'validator', isImage: true,
    });
  });
  it('语义尾缀 + 非图片扩展：归属成功且 isImage=false', () => {
    expect(parseScreenshotEntry('validator-us-008-export.pdf', ids)).toEqual({
      filename: 'validator-us-008-export.pdf', storyId: 'US-008', phase: 'validator', isImage: false,
    });
  });
  it('前缀重叠 id 取最长命中：US-10 不被 US-1 抢走', () => {
    expect(parseScreenshotEntry('builder-us-10-3.png', ids).storyId).toBe('US-10');
    expect(parseScreenshotEntry('builder-us-1-3.png', ids).storyId).toBe('US-1');
  });
  it('无相位前缀或匹配不到任何 story 落未归类', () => {
    expect(parseScreenshotEntry('random.png', ids)).toEqual({
      filename: 'random.png', storyId: null, phase: null, isImage: true,
    });
    expect(parseScreenshotEntry('builder-US-999-1.png', ids).storyId).toBe(null);
    expect(parseScreenshotEntry('builder-US-999-1.png', ids).phase).toBe('builder');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/report/report.test.ts`
Expected: FAIL——模块 `./report.js` 不存在（Cannot find module / Failed to resolve import）。

- [ ] **Step 3: 最小实现**

创建 `src/report/report.ts`：

```ts
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tryReadPrd, type Prd } from '../engine/prd.js';
import { tryReadState, mergedStories, initialStateFor, type StoryView } from '../engine/state.js';
import { readProgress } from '../engine/progress.js';

export interface ScreenshotEntry {
  filename: string;
  /** 归属 story id（null=未归类） */
  storyId: string | null;
  phase: 'builder' | 'validator' | null;
  isImage: boolean;
}

export interface ReportData {
  workspace: string;
  /** 由调用方注入，保持纯函数可测 */
  generatedAt: Date;
  prd: Prd;
  /** mergedStories 合并视图；state 缺失/损坏回退语义与 status/dashboard 一致 */
  stories: StoryView[];
  /** state.json 存在但解析失败——报告内警示 */
  stateCorrupted: boolean;
  progress: string;
  reviews: { filename: string; content: string }[];
  tamperedArchives: string[];
  screenshots: ScreenshotEntry[];
}

export type ReportSource =
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string }
  | { status: 'ok'; data: ReportData };

const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp']);

// 只读一层、只收常规文件；目录不存在/不可读一律按空处理（报告容错：有什么记什么）
function listFiles(dir: string): string[] {
  try {
    return readdirSync(dir, { withFileTypes: true }).filter((e) => e.isFile()).map((e) => e.name);
  } catch {
    return [];
  }
}

// 截图命名实测两类形态：builder-US-008-6.png / validator-us-008-pass-1.png / validator-us-008-export.pdf
// ——序号尾缀与语义尾缀并存，解析以 story id 段为锚（剥相位前缀后，某 id 恰为余段或其 '-' 前缀），
// 大小写不敏感；多 id 命中取最长（防 US-1 抢走 US-10 的文件）。
export function parseScreenshotEntry(filename: string, storyIds: string[]): ScreenshotEntry {
  const ext = filename.slice(filename.lastIndexOf('.') + 1).toLowerCase();
  const isImage = IMAGE_EXTS.has(ext);
  const m = /^(builder|validator)-(.+)\.[^.]+$/i.exec(filename);
  if (!m) return { filename, storyId: null, phase: null, isImage };
  const phase = m[1].toLowerCase() as 'builder' | 'validator';
  const rest = m[2].toLowerCase();
  let hit: string | null = null;
  for (const id of storyIds) {
    const idl = id.toLowerCase();
    if ((rest === idl || rest.startsWith(idl + '-')) && (hit === null || id.length > hit.length)) hit = id;
  }
  return { filename, storyId: hit, phase, isImage };
}

export function collectReport(workspace: string, now: Date): ReportSource {
  const prdPath = join(workspace, 'prd.json');
  if (!existsSync(prdPath)) return { status: 'missing', workspace };
  const prd = tryReadPrd(prdPath);
  if (prd === null || !Array.isArray(prd.userStories)) return { status: 'unparsable', workspace };
  const statePath = join(workspace, 'state.json');
  const stateExists = existsSync(statePath);
  const rawState = stateExists ? tryReadState(statePath) : null;
  const state = rawState ?? initialStateFor(prd);
  const rootFiles = listFiles(workspace);
  const reviews: { filename: string; content: string }[] = [];
  for (const filename of rootFiles.filter((n) => /^review-.*\.md$/.test(n)).sort()) {
    try {
      reviews.push({ filename, content: readFileSync(join(workspace, filename), 'utf-8') });
    } catch { /* 单文件读取失败跳过——容错：有什么记什么 */ }
  }
  const storyIds = prd.userStories.map((s) => s.id);
  return {
    status: 'ok',
    data: {
      workspace,
      generatedAt: now,
      prd,
      stories: mergedStories(prd, state),
      stateCorrupted: stateExists && rawState === null,
      progress: readProgress(join(workspace, 'progress.md')),
      reviews,
      tamperedArchives: rootFiles.filter((n) => /^prd\.tampered-.*\.json$/.test(n)).sort(),
      screenshots: listFiles(join(workspace, 'screenshots')).sort().map((f) => parseScreenshotEntry(f, storyIds)),
    },
  };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/report/report.test.ts`
Expected: PASS（全部用例绿）。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。

```bash
git add src/report/report.ts src/report/report.test.ts
git commit -m "feat: 验证报告数据收集 collectReport——三态容错与截图归属解析（#3 静态 HTML 报告 T1）"
```

---

### Task 2: `src/report/render.ts` — HTML 渲染（renderReportHtml）

**Files:**
- Create: `src/report/render.ts`
- Test: `src/report/render.test.ts`

**Interfaces:**
- Consumes: `ReportData`/`ScreenshotEntry`（`import type`，来自 `./report.js`——type-only，运行时依赖单向 report→render 无环）、`StoryView`（`../engine/state.js`）、`isArbitrationLine`/`readQualityChecks`（`../engine/gate.js`）、`readModelsConfig`（`../engine/models.js`）。
- Produces:
  - `function renderReportHtml(data: ReportData): string`
  - `function escapeHtml(s: string): string`
  - `function renderMarkdownLite(md: string): string`

- [ ] **Step 1: 写失败测试**

创建 `src/report/render.test.ts`：

```ts
import { describe, it, expect } from 'vitest';
import { renderReportHtml, escapeHtml, renderMarkdownLite } from './render.js';
import type { ReportData } from './report.js';

function data(over: Partial<ReportData> = {}): ReportData {
  return {
    workspace: '.workspace',
    generatedAt: new Date('2026-07-08T12:34:00'),
    prd: {
      project: 'proj', branchName: 'ralph/x', description: 'd',
      userStories: [
        { id: 'US-001', title: '第一个', description: 'd', acceptanceCriteria: ['能打开页面'], priority: 1 },
      ],
    },
    stories: [
      {
        id: 'US-001', title: '第一个', description: 'd', acceptanceCriteria: ['能打开页面'],
        priority: 1, passes: true, notes: '', retryCount: 0, blocked: false,
      },
    ],
    stateCorrupted: false,
    progress: '',
    reviews: [],
    tamperedArchives: [],
    screenshots: [],
    ...over,
  };
}

describe('escapeHtml', () => {
  it('转义 & < > "', () => {
    expect(escapeHtml('<a href="x">&</a>')).toBe('&lt;a href=&quot;x&quot;&gt;&amp;&lt;/a&gt;');
  });
});

describe('renderMarkdownLite 六构造', () => {
  it('标题映射 h4-h6（报告自身占用 h1-h3）', () => {
    expect(renderMarkdownLite('# A')).toBe('<h4>A</h4>');
    expect(renderMarkdownLite('## B')).toBe('<h5>B</h5>');
    expect(renderMarkdownLite('### C')).toBe('<h6>C</h6>');
  });
  it('列表、粗体、内联 code、段落', () => {
    const out = renderMarkdownLite('- 项目 **重点** `代码`\n\n普通段落');
    expect(out).toContain('<ul><li>项目 <strong>重点</strong> <code>代码</code></li></ul>');
    expect(out).toContain('<p>普通段落</p>');
  });
  it('围栏代码块内不再解析构造且转义生效', () => {
    const out = renderMarkdownLite('```\n- 不是列表 <b>\n```');
    expect(out).toContain('<pre class="code-block">- 不是列表 &lt;b&gt;</pre>');
  });
  it('md 文本先转义：注入标记不落地', () => {
    expect(renderMarkdownLite('<script>alert(1)</script>')).not.toContain('<script>');
  });
});

describe('renderReportHtml', () => {
  it('骨架：DOCTYPE、中文 lang、标题带 project、生成时间与 workspace 入页脚区', () => {
    const html = renderReportHtml(data());
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain('proj · 验证报告');
    expect(html).toContain('2026-07-08 12:34');
    expect(html).toContain('.workspace');
  });

  it('徽章三态：通过 ✅ / blocked ⛔ / 未完成 ⬜，重试次数仅 >0 显示', () => {
    const passed = renderReportHtml(data());
    expect(passed).toContain('✅ 通过');
    expect(passed).not.toContain('重试');
    const s = data().stories[0];
    const blocked = renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: true, retryCount: 5 }],
    }));
    expect(blocked).toContain('⛔ blocked');
    expect(blocked).toContain('重试 5 次');
    const pending = renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: false }],
    }));
    expect(pending).toContain('⬜ 未完成');
  });

  it('结果横幅三态', () => {
    expect(renderReportHtml(data())).toContain('全部通过 1/1');
    const s = data().stories[0];
    expect(renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: true }],
    }))).toContain('blocked');
    expect(renderReportHtml(data({
      stories: [{ ...s, passes: false, blocked: false }],
    }))).toContain('进行中');
  });

  it('AC 逐条呈现且转义', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{ ...s, acceptanceCriteria: ['支持 <b> 标签展示'] }],
    }));
    expect(html).toContain('支持 &lt;b&gt; 标签展示');
  });

  it('notes 行分类高亮：仲裁标签行/门禁失败行/BLOCKED 行', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{
        ...s, passes: false,
        notes: '[需求冲突] 与文档矛盾\n[门禁失败 - 第1次] 2026-07-08 12:00\n[BLOCKED: 已达到最大重试次数，跳过此 story]\n普通行',
      }],
    }));
    expect(html).toContain('class="note-line arbitration"');
    expect(html).toContain('class="note-line gate-fail"');
    expect(html).toContain('class="note-line blocked-line"');
  });

  it('notes 注入不执行：<script> 必须被转义', () => {
    const s = data().stories[0];
    const html = renderReportHtml(data({
      stories: [{ ...s, notes: '<script>alert(1)</script>' }],
    }));
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)');
  });

  it('截图画廊：相对 src、URL 编码、builder/validator 分组、非图片成链接、未归类单列', () => {
    const html = renderReportHtml(data({
      screenshots: [
        { filename: 'builder-US-001-1.png', storyId: 'US-001', phase: 'builder', isImage: true },
        { filename: 'validator us 001.png', storyId: 'US-001', phase: 'validator', isImage: true },
        { filename: 'builder-US-001-export.pdf', storyId: 'US-001', phase: 'builder', isImage: false },
        { filename: 'random.png', storyId: null, phase: null, isImage: true },
      ],
    }));
    expect(html).toContain('src="screenshots/builder-US-001-1.png"');
    expect(html).toContain('screenshots/validator%20us%20001.png');
    expect(html).toContain('builder 截图');
    expect(html).toContain('validator 截图');
    expect(html).toContain('builder-US-001-export.pdf');
    expect(html).not.toContain('img src="screenshots/builder-US-001-export.pdf"');
    expect(html).toContain('未归类工件');
    expect(html).toContain('random.png');
  });

  it('红旗区条件渲染：有 tampered 才出现', () => {
    expect(renderReportHtml(data())).not.toContain('红旗区');
    const html = renderReportHtml(data({ tamperedArchives: ['prd.tampered-20260708-010101.json'] }));
    expect(html).toContain('红旗区');
    expect(html).toContain('prd.tampered-20260708-010101.json');
    expect(html).toContain('ADR-007');
  });

  it('review 留痕：无 → 占位指引；有 → 渲染 md 内容', () => {
    expect(renderReportHtml(data())).toContain('尚无人审包');
    const html = renderReportHtml(data({
      reviews: [{ filename: 'review-2026-07-08.md', content: '## 层 2 发现清单\n- 发现 A' }],
    }));
    expect(html).toContain('review-2026-07-08.md');
    expect(html).toContain('<h5>层 2 发现清单</h5>');
    expect(html).toContain('<li>发现 A</li>');
    expect(html).not.toContain('尚无人审包');
  });

  it('progress 折叠附录：空则整节省略，有则在 details 内', () => {
    expect(renderReportHtml(data())).not.toContain('过程记录');
    const html = renderReportHtml(data({ progress: '## Codebase Patterns\n- 约定一' }));
    expect(html).toContain('<details>');
    expect(html).toContain('过程记录');
    expect(html).toContain('<li>约定一</li>');
  });

  it('门禁配置：未配置显示未启用；配置则逐条列出；形状非法显示警示', () => {
    expect(renderReportHtml(data())).toContain('机械门禁：未启用');
    const withChecks = data();
    withChecks.prd.qualityChecks = ['npm test', 'npm run typecheck'];
    const html = renderReportHtml(withChecks);
    expect(html).toContain('npm test');
    expect(html).toContain('npm run typecheck');
    const invalid = data();
    (invalid.prd as { qualityChecks?: unknown }).qualityChecks = 'npm test';
    expect(renderReportHtml(invalid)).toContain('形状非法');
  });

  it('模型路由：未配置整行省略；配置则显示', () => {
    expect(renderReportHtml(data())).not.toContain('模型路由');
    const withModels = data();
    withModels.prd.models = { builder: 'fast-m', validator: 'val-m', escalation: 'esc-m' };
    const html = renderReportHtml(withModels);
    expect(html).toContain('模型路由');
    expect(html).toContain('fast-m');
    expect(html).toContain('esc-m');
  });

  it('state 损坏警示条件渲染', () => {
    expect(renderReportHtml(data())).not.toContain('state.json 已损坏');
    expect(renderReportHtml(data({ stateCorrupted: true }))).toContain('state.json 已损坏');
  });

  it('报告零浏览器 JS', () => {
    expect(renderReportHtml(data())).not.toContain('<script');
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/report/render.test.ts`
Expected: FAIL——模块 `./render.js` 不存在。

- [ ] **Step 3: 实现 render.ts**

创建 `src/report/render.ts`（完整文件）：

```ts
import type { ReportData, ScreenshotEntry } from './report.js';
import type { StoryView } from '../engine/state.js';
import { isArbitrationLine, readQualityChecks } from '../engine/gate.js';
import { readModelsConfig } from '../engine/models.js';

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

function inlineMd(s: string): string {
  return escapeHtml(s)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>');
}

/**
 * 零依赖最小 markdown 渲染（review-*.md 与 progress.md 用）：仅六种构造——
 * #/##/### 标题（映射 h4-h6，报告自身占用 h1-h3）、- 列表、**粗体**、`内联 code`、
 * ``` 围栏代码块、普通段落；先转义后构造，其余原样成段。刻意不求全（spec 非目标）。
 */
export function renderMarkdownLite(md: string): string {
  const out: string[] = [];
  let listBuf: string[] = [];
  let codeBuf: string[] | null = null;
  const flushList = () => {
    if (listBuf.length) { out.push(`<ul>${listBuf.join('')}</ul>`); listBuf = []; }
  };
  for (const line of md.split('\n')) {
    if (line.startsWith('```')) {
      if (codeBuf === null) { flushList(); codeBuf = []; }
      else { out.push(`<pre class="code-block">${codeBuf.join('\n')}</pre>`); codeBuf = null; }
      continue;
    }
    if (codeBuf !== null) { codeBuf.push(escapeHtml(line)); continue; }
    const h = /^(#{1,3}) (.*)$/.exec(line);
    if (h) {
      flushList();
      const lv = h[1].length + 3;
      out.push(`<h${lv}>${inlineMd(h[2])}</h${lv}>`);
      continue;
    }
    if (line.startsWith('- ')) { listBuf.push(`<li>${inlineMd(line.slice(2))}</li>`); continue; }
    if (line.trim() === '') { flushList(); continue; }
    flushList();
    out.push(`<p>${inlineMd(line)}</p>`);
  }
  if (codeBuf !== null && codeBuf.length) out.push(`<pre class="code-block">${codeBuf.join('\n')}</pre>`);
  flushList();
  return out.join('\n');
}

/** 与 gate.ts/validator 记录同格式的本地时间戳：YYYY-MM-DD HH:mm */
function formatStamp(d: Date): string {
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

function imgSrc(filename: string): string {
  return `screenshots/${encodeURIComponent(filename)}`;
}

function noteLineClass(line: string): string {
  if (isArbitrationLine(line)) return 'note-line arbitration';
  if (line.startsWith('[门禁失败')) return 'note-line gate-fail';
  if (line.startsWith('[BLOCKED')) return 'note-line blocked-line';
  return 'note-line';
}

function renderNotes(notes: string): string {
  if (notes.trim() === '') return '';
  const lines = notes.split('\n')
    .map((l) => `<div class="${noteLineClass(l)}">${escapeHtml(l)}</div>`)
    .join('');
  return `<div class="notes">${lines}</div>`;
}

function renderShotFigure(s: ScreenshotEntry): string {
  const name = escapeHtml(s.filename);
  if (!s.isImage) {
    return `<div class="artifact-link"><a href="${imgSrc(s.filename)}" target="_blank">📎 ${name}</a></div>`;
  }
  return `<figure class="shot"><a href="${imgSrc(s.filename)}" target="_blank"><img src="${imgSrc(s.filename)}" alt="${name}" loading="lazy"></a><figcaption>${name}</figcaption></figure>`;
}

function renderGallery(shots: ScreenshotEntry[]): string {
  if (shots.length === 0) return '';
  const groups = [
    { phase: 'builder' as const, label: 'builder 截图' },
    { phase: 'validator' as const, label: 'validator 截图' },
  ];
  const parts: string[] = [];
  for (const g of groups) {
    const own = shots.filter((s) => s.phase === g.phase);
    if (own.length === 0) continue;
    parts.push(
      `<div class="gallery-group"><div class="gallery-label">${g.label}（${own.length}）</div>` +
      `<div class="gallery">${own.map(renderShotFigure).join('')}</div></div>`,
    );
  }
  return parts.join('');
}

function storyBadge(s: StoryView): string {
  if (s.passes) return '<span class="badge ok">✅ 通过</span>';
  if (s.blocked) return '<span class="badge blocked">⛔ blocked</span>';
  return '<span class="badge pending">⬜ 未完成</span>';
}

function renderStoryCard(s: StoryView, shots: ScreenshotEntry[]): string {
  const retry = s.retryCount > 0 ? ` <span class="retry">重试 ${s.retryCount} 次</span>` : '';
  // tryReadPrd 无逐字段守卫，acceptanceCriteria 可能形状非法——渲染层兜底为空列表
  const acList = Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria : [];
  const acs = acList.map((a) => `<li>${escapeHtml(String(a))}</li>`).join('');
  return `<section class="card story">
<h3>${escapeHtml(s.id)} ${escapeHtml(s.title)} ${storyBadge(s)}${retry}</h3>
<ul class="acs">${acs}</ul>
${renderNotes(s.notes)}
${renderGallery(shots)}
</section>`;
}

function renderBanner(stories: StoryView[]): string {
  const total = stories.length;
  const passed = stories.filter((x) => x.passes).length;
  const blocked = stories.filter((x) => x.blocked).length;
  if (total > 0 && passed === total) return `<div class="banner ok">✅ 全部通过 ${passed}/${total}</div>`;
  if (blocked > 0) return `<div class="banner blocked">⛔ ${passed} 通过 · ${blocked} blocked · 共 ${total}</div>`;
  return `<div class="banner running">⏳ 进行中：${passed}/${total} 通过</div>`;
}

function renderGateConfig(data: ReportData): string {
  const checks = readQualityChecks(data.prd);
  if (checks === null) return '<div class="meta-line">机械门禁：未启用</div>';
  if (checks === 'invalid') {
    return '<div class="meta-line warn">机械门禁：配置形状非法（应为字符串数组），运行期未启用</div>';
  }
  return `<div class="meta-line">机械门禁（${checks.length} 条）：</div>` +
    `<ul class="checks">${checks.map((c) => `<li><code>${escapeHtml(c)}</code></li>`).join('')}</ul>`;
}

// warnings 必须透出（T2 审查订正）：models 形状非法时 config=null 但 warnings 有描述，
// 丢弃它会让「配置非法」与「未配置」在报告上不可区分——与 renderGateConfig 的诚实度一致。
function renderModels(data: ReportData): string {
  const { config, warnings } = readModelsConfig(data.prd);
  const warnLines = warnings.map((w) => `<div class="meta-line warn">${escapeHtml(w)}</div>`).join('');
  if (!config) return warnLines;
  const items: string[] = [];
  if (config.builder) items.push(`builder=<code>${escapeHtml(config.builder)}</code>`);
  if (config.validator) items.push(`validator=<code>${escapeHtml(config.validator)}</code>`);
  if (config.escalation) items.push(`escalation=<code>${escapeHtml(config.escalation)}</code>（第 ${config.escalateAfter} 次重试起）`);
  if (items.length === 0) return warnLines;
  return `<div class="meta-line">模型路由：${items.join(' · ')}</div>${warnLines}`;
}

function renderRedFlags(tampered: string[]): string {
  if (tampered.length === 0) return '';
  const files = tampered.map((f) => `<li><code>${escapeHtml(f)}</code></li>`).join('');
  return `<section class="card red-flag">
<h2>🚩 红旗区：运行期篡改存档</h2>
<p>运行期间 prd.json 被修改过，引擎已按启动快照恢复并存档（ADR-007）。合并裁决前请逐个核对：</p>
<ul>${files}</ul>
<p>指引：<code>diff</code> 存档与 <code>prd.json</code>，核对运行期被改了什么；与预期不符须停止合并。</p>
</section>`;
}

function renderUnattributed(shots: ScreenshotEntry[]): string {
  const orphan = shots.filter((s) => s.storyId === null);
  if (orphan.length === 0) return '';
  return `<section class="card"><h2>未归类工件</h2><div class="gallery">${orphan.map(renderShotFigure).join('')}</div></section>`;
}

function renderReviews(reviews: ReportData['reviews']): string {
  if (reviews.length === 0) {
    return '<section class="card"><h2>人审留痕</h2><p class="placeholder">尚无人审包——循环结束后运行 /review-loop，再跑 <code>coding-x report</code> 刷新本报告。</p></section>';
  }
  return reviews.map((r) =>
    `<section class="card review"><h2>人审留痕：${escapeHtml(r.filename)}</h2><div class="md">${renderMarkdownLite(r.content)}</div></section>`,
  ).join('\n');
}

function renderProgressSection(progress: string): string {
  if (progress.trim() === '') return '';
  return `<section class="card"><details><summary><h2>过程记录（progress.md）</h2></summary><div class="md">${renderMarkdownLite(progress)}</div></details></section>`;
}

// 配色沿 dashboard 的 mac 色板复制（不共享文件：报告要永久自包含，两者生命周期不同）
const REPORT_CSS = `
*, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
:root {
  --bg: hsl(240 5% 96%); --fg: hsl(0 0% 13%); --card: hsl(0 0% 100%);
  --border: hsl(0 0% 88%); --muted: hsl(0 0% 45%); --blue: hsl(211 100% 50%);
  --font-sans: -apple-system, BlinkMacSystemFont, 'SF Pro Text', 'Helvetica Neue', Helvetica, Arial, sans-serif;
  --font-mono: 'SF Mono', Menlo, Monaco, Consolas, monospace;
}
body { background: var(--bg); color: var(--fg); font-family: var(--font-sans); line-height: 1.6; }
main { max-width: 980px; margin: 0 auto; padding: 24px 16px 60px; }
.card { background: var(--card); border: 1px solid var(--border); border-radius: 10px; padding: 20px; margin-bottom: 16px; }
h1 { font-size: 22px; margin-bottom: 12px; }
h2 { font-size: 17px; margin-bottom: 10px; }
h3 { font-size: 15px; margin-bottom: 8px; }
.section-title { margin: 24px 0 12px; }
code { font-family: var(--font-mono); font-size: 0.9em; background: hsl(240 4% 93%); padding: 1px 5px; border-radius: 4px; }
a { color: var(--blue); }
.banner { padding: 10px 14px; border-radius: 8px; font-weight: 600; margin-bottom: 12px; }
.banner.ok { background: hsl(142 71% 45% / 0.12); color: hsl(142 71% 30%); }
.banner.blocked { background: hsl(4 90% 58% / 0.12); color: hsl(4 90% 40%); }
.banner.running { background: hsl(36 100% 50% / 0.12); color: hsl(36 100% 32%); }
.meta-line { color: var(--muted); font-size: 13px; margin: 3px 0; }
.meta-line.warn { color: hsl(36 100% 32%); }
.checks { margin: 4px 0 8px 22px; font-size: 13px; }
.badge { font-size: 12px; padding: 2px 8px; border-radius: 999px; vertical-align: middle; }
.badge.ok { background: hsl(142 71% 45% / 0.15); color: hsl(142 71% 28%); }
.badge.blocked { background: hsl(4 90% 58% / 0.15); color: hsl(4 90% 40%); }
.badge.pending { background: hsl(0 0% 72% / 0.25); color: var(--muted); }
.retry { font-size: 12px; color: hsl(36 100% 32%); }
.acs { margin: 6px 0 10px 22px; font-size: 14px; }
.notes { font-family: var(--font-mono); font-size: 12px; background: hsl(240 4% 95%); border-radius: 8px; padding: 10px 12px; margin: 8px 0; overflow-x: auto; }
.note-line { white-space: pre-wrap; }
.note-line.arbitration { background: hsl(280 68% 60% / 0.14); font-weight: 600; }
.note-line.gate-fail { color: hsl(4 90% 40%); }
.note-line.blocked-line { color: hsl(4 90% 40%); font-weight: 600; }
.red-flag { border-color: hsl(4 90% 58%); background: hsl(4 90% 58% / 0.05); }
.red-flag h2 { color: hsl(4 90% 40%); }
.gallery-group { margin-top: 10px; }
.gallery-label { font-size: 12px; color: var(--muted); margin-bottom: 6px; }
.gallery { display: flex; flex-wrap: wrap; gap: 10px; }
.shot { width: 180px; }
.shot img { width: 100%; border: 1px solid var(--border); border-radius: 6px; display: block; }
.shot figcaption { font-size: 11px; color: var(--muted); word-break: break-all; margin-top: 3px; }
.artifact-link { font-size: 13px; margin: 4px 0; width: 100%; }
.placeholder { color: var(--muted); }
.md h4 { font-size: 15px; margin: 12px 0 6px; }
.md h5 { font-size: 14px; margin: 10px 0 5px; }
.md h6 { font-size: 13px; margin: 8px 0 4px; color: var(--muted); }
.md ul { margin: 6px 0 6px 22px; font-size: 14px; }
.md p { font-size: 14px; margin: 6px 0; }
.md .code-block { font-family: var(--font-mono); font-size: 12px; background: hsl(240 4% 95%); border-radius: 8px; padding: 10px 12px; margin: 8px 0; overflow-x: auto; white-space: pre; }
summary { cursor: pointer; }
summary h2 { display: inline; }
footer { text-align: center; color: var(--muted); font-size: 12px; margin-top: 24px; }
`;

export function renderReportHtml(data: ReportData): string {
  const { prd, stories } = data;
  const byStory = new Map<string, ScreenshotEntry[]>();
  for (const s of data.screenshots) {
    if (s.storyId === null) continue;
    const list = byStory.get(s.storyId) ?? [];
    list.push(s);
    byStory.set(s.storyId, list);
  }
  const cards = stories.map((s) => renderStoryCard(s, byStory.get(s.id) ?? [])).join('\n');
  const stateWarn = data.stateCorrupted
    ? '<div class="meta-line warn">⚠️ state.json 已损坏，story 状态按未开始显示（建议 npx coding-x repair）</div>'
    : '';
  const title = `${escapeHtml(prd.project)} · 验证报告`;
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${title}</title>
<style>${REPORT_CSS}</style>
</head>
<body>
<main>
<header class="card">
<h1>${title}</h1>
${renderBanner(stories)}
<div class="meta-line">分支：<code>${escapeHtml(prd.branchName)}</code>${prd.sourcePrd ? ` · 源 PRD：<code>${escapeHtml(prd.sourcePrd)}</code>` : ''}</div>
<div class="meta-line">生成时间：${formatStamp(data.generatedAt)} · workspace：<code>${escapeHtml(data.workspace)}</code></div>
${stateWarn}
${renderGateConfig(data)}
${renderModels(data)}
<div class="meta-line">统计：${stories.length} story · ${data.screenshots.length} 个截图工件 · ${data.reviews.length} 份人审留痕</div>
</header>
${renderRedFlags(data.tamperedArchives)}
<h2 class="section-title">story 证据</h2>
${cards}
${renderUnattributed(data.screenshots)}
${renderReviews(data.reviews)}
${renderProgressSection(data.progress)}
<footer>由 coding-x report 生成 · ${formatStamp(data.generatedAt)}</footer>
</main>
</body>
</html>`;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/report/render.test.ts`
Expected: PASS。若「零浏览器 JS」用例因 `<style>` 误伤——断言是 `<script` 前缀不会匹配 `<style>`，应绿；任何红先修实现再动断言。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。

```bash
git add src/report/render.ts src/report/render.test.ts
git commit -m "feat: 验证报告 HTML 渲染 renderReportHtml——七区信息架构/仲裁行高亮/全文本转义/零浏览器 JS（#3 静态 HTML 报告 T2）"
```

---

### Task 3: writeReport 编排 + `coding-x report` 子命令

**Files:**
- Modify: `src/report/report.ts`（追加 writeReport）
- Modify: `src/cli.ts`（command union、parse、main 分支）
- Test: `src/report/report.test.ts`（追加）、`src/cli.test.ts`（追加）

**Interfaces:**
- Consumes: `collectReport`（T1）、`renderReportHtml`（T2）。
- Produces:
  - `type WriteReportResult = { status: 'written'; path: string } | { status: 'missing'; workspace: string } | { status: 'unparsable'; workspace: string }`
  - `function writeReport(workspace: string, now: Date): WriteReportResult`（写盘 IO 失败向上抛，调用方定语义）
  - CLI：`coding-x report [--workspace <dir>]`，退出码 0=已生成 / 1=写盘失败 / 2=workspace 不可用。

- [ ] **Step 1: 写失败测试**

`src/report/report.test.ts` 追加（import 行并入 `writeReport`、`readFileSync`）：

```ts
// 顶部 import 调整：
// import { collectReport, parseScreenshotEntry, writeReport } from './report.js';
// import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';

describe('writeReport', () => {
  it('ok 时写 report.html 并返回路径', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    const result = writeReport(dir, new Date('2026-07-08T12:00:00'));
    expect(result).toEqual({ status: 'written', path: join(dir, 'report.html') });
    const html = readFileSync(join(dir, 'report.html'), 'utf-8');
    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('US-001');
  });

  it('missing/unparsable 透传且不写盘', () => {
    const dir = ws();
    expect(writeReport(dir, new Date()).status).toBe('missing');
    writeFileSync(join(dir, 'prd.json'), '{ broken');
    expect(writeReport(dir, new Date()).status).toBe('unparsable');
  });

  it('重生成幂等覆盖', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    writeReport(dir, new Date('2026-07-08T12:00:00'));
    writePrd(dir, [story('US-001'), story('US-002')]);
    writeReport(dir, new Date('2026-07-08T13:00:00'));
    const html = readFileSync(join(dir, 'report.html'), 'utf-8');
    expect(html).toContain('US-002');
    expect(html).toContain('2026-07-08 13:00');
  });
});
```

`src/cli.test.ts` 追加：

```ts
// parseCliArgs describe 内：
  it('recognizes the report subcommand with default workspace', () => {
    const c = parseCliArgs(['report']);
    expect(c.command).toBe('report');
    expect(c.workspace).toBe('.workspace');
  });
  it('passes --workspace through to the report subcommand', () => {
    expect(parseCliArgs(['report', '--workspace', 'ws-x']).workspace).toBe('ws-x');
  });

// 文件末尾新增（沿用文件既有 mkdtempSync/rmSync/join/tmpdir import）：
describe('main — report subcommand', () => {
  it('writes report.html and returns 0 on a valid workspace', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      writeFileSync(join(dir, 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd',
        userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
      }));
      const logs: string[] = [];
      const orig = console.log;
      console.log = (...a: unknown[]) => { logs.push(a.join(' ')); };
      try {
        expect(await main(['report', '--workspace', dir])).toBe(0);
      } finally { console.log = orig; }
      expect(logs.some((l) => l.includes('report.html'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns 2 when the workspace is missing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      const errs: string[] = [];
      const orig = console.error;
      console.error = (...a: unknown[]) => { errs.push(a.join(' ')); };
      try {
        expect(await main(['report', '--workspace', dir])).toBe(2);
      } finally { console.error = orig; }
      expect(errs.some((e) => e.includes('prd-to-json'))).toBe(true);
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });

  it('returns 1 when writing report.html fails', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-report-'));
    try {
      writeFileSync(join(dir, 'prd.json'), JSON.stringify({
        project: 'p', branchName: 'b', description: 'd',
        userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
      }));
      mkdirSync(join(dir, 'report.html')); // 同名目录占位 → writeFileSync 抛 EISDIR
      const orig = console.error;
      console.error = () => {};
      try {
        expect(await main(['report', '--workspace', dir])).toBe(1);
      } finally { console.error = orig; }
    } finally { rmSync(dir, { recursive: true, force: true }); }
  });
});
```

注意：`cli.test.ts` 现有 import 无 `mkdirSync`，追加到 `node:fs` import 中。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/report/report.test.ts src/cli.test.ts`
Expected: FAIL——`writeReport` 未导出；`parseCliArgs(['report']).command` 得 `'run'` 而非 `'report'`。

- [ ] **Step 3: 实现**

`src/report/report.ts`——import 行加入 `writeFileSync` 与 render：

```ts
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
// …既有 import 不变，追加：
import { renderReportHtml } from './render.js';
```

文件末尾追加：

```ts
export type WriteReportResult =
  | { status: 'written'; path: string }
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string };

/**
 * 编排：collect → render → 落盘 <workspace>/report.html（幂等覆盖）。
 * missing/unparsable 原样透传不写盘；写盘 IO 失败向上抛——调用方定语义
 * （cli 退出 1 / loop 仅 warn，报告是副产物绝不影响循环结果）。
 */
export function writeReport(workspace: string, now: Date): WriteReportResult {
  const source = collectReport(workspace, now);
  if (source.status !== 'ok') return source;
  const path = join(workspace, 'report.html');
  writeFileSync(path, renderReportHtml(source.data), 'utf-8');
  return { status: 'written', path };
}
```

`src/cli.ts`：

```ts
// import 区追加：
import { writeReport } from './report/report.js';

// CliConfig.command union 扩为：
  command: 'run' | 'repair' | 'dashboard' | 'doctor' | 'status' | 'report';

// parseCliArgs 的 command 判定链加一支（在 status 之后）：
    : first === 'status' ? 'status'
    : first === 'report' ? 'report'
    : 'run';

// main：status 分支之后、dashboard 分支之前插入：
  if (cfg.command === 'report') {
    try {
      const result = writeReport(cfg.workspace, new Date());
      if (result.status === 'missing') {
        console.error(`❌ 未找到工作区：${join(cfg.workspace, 'prd.json')} 不存在。建议先用 prd-to-json 从源 PRD 生成工作区。`);
        return 2;
      }
      if (result.status === 'unparsable') {
        console.error(`❌ 无法解析 ${join(cfg.workspace, 'prd.json')}。建议运行 npx coding-x repair 修复后重试。`);
        return 2;
      }
      console.log(`📄 验证报告: ${result.path}`);
      return 0;
    } catch (err) {
      console.error(`❌ 验证报告写入失败：${err instanceof Error ? err.message : String(err)}`);
      return 1;
    }
  }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/report/report.test.ts src/cli.test.ts`
Expected: PASS。

- [ ] **Step 5: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。

```bash
git add src/report/report.ts src/report/report.test.ts src/cli.ts src/cli.test.ts
git commit -m "feat: coding-x report 子命令——writeReport 编排落盘 report.html，退出码 0/1/2 对齐 status 语义（#3 静态 HTML 报告 T3）"
```

---

### Task 4: loop 自动生成接线 + 消费方注释 + 文档同步

**Files:**
- Modify: `src/engine/loop.ts`（循环结束生成报告）
- Modify: `src/engine/gate.ts`（ARBITRATION_PREFIXES 消费方清单注释）
- Modify: `README.md`、`docs/architecture.md`
- Test: `src/engine/loop.test.ts`（追加）

**Interfaces:**
- Consumes: `writeReport`（T3，`../report/report.js`）。
- Produces: 循环结束后 `<workspace>/report.html` 存在；stdout 提示 `📄 验证报告: <path>`。依赖方向新增 `engine/loop → report`（report → engine 数据读取模块，无环）。

- [ ] **Step 1: 写失败测试**

`src/engine/loop.test.ts` 的 `describe('runLoop', …)` 内追加两用例（沿用文件既有 setup/story/cleanup 基建）：

```ts
  it('writes report.html when the loop completes', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const html = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('US-001');
      expect(html).toContain('全部通过');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes report.html even when the loop hits maxIterations unfinished', async () => {
    const { workspace, instructionsDir } = setup([story()]); // never flips
    process.env.CODING_X_CLAUDE_BIN = `node -e process.exit(0)`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      const html = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(html).toContain('进行中'); // 未完成态诚实存档
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: 新增两用例 FAIL（`report.html` 不存在，readFileSync ENOENT）；既有用例保持绿。

- [ ] **Step 3: 实现 loop 接线**

`src/engine/loop.ts` import 区追加：

```ts
import { writeReport } from '../report/report.js';
```

`runLoop` 内 tamper summary 输出之后、`if (cfg.keepOpen)` 之前插入（现有代码 `const tamper = guard.summary(); if (tamper.count > 0) {…}` 块与 `if (cfg.keepOpen) {` 之间）：

```ts
    // 循环结束无条件生成静态验证报告（进行中态也诚实存档）；
    // 报告是副产物：任何失败只 warn，绝不影响循环退出码。
    try {
      const report = writeReport(cfg.workspace, new Date());
      if (report.status === 'written') {
        console.log(`📄 验证报告: ${report.path}`);
      } else {
        console.warn(`⚠️  验证报告未生成（prd.json ${report.status === 'missing' ? '缺失' : '不可解析'}）`);
      }
    } catch (err) {
      console.warn(`⚠️  验证报告生成失败：${err instanceof Error ? err.message : String(err)}`);
    }
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: PASS（含既有全部用例——特别确认 keepOpen 两用例不受插入位置影响）。

- [ ] **Step 5: gate.ts 消费方注释同步**

`src/engine/gate.ts` 的 `ARBITRATION_PREFIXES` doc comment 更新消费方清单——将：

```ts
/**
 * 仲裁类标签前缀族的单一真相源：agent 请求人工裁决的 notes 行以这些前缀开头，
 * 打回与清理路径必须保全。消费方：applyGateFailure 过滤、status 醒目标记、
 * builder.md/validator.md 经 {{ARBITRATION_PREFIXES}} 占位符渲染（loop.ts renderInstruction）。
 */
```

改为：

```ts
/**
 * 仲裁类标签前缀族的单一真相源：agent 请求人工裁决的 notes 行以这些前缀开头，
 * 打回与清理路径必须保全。消费方：applyGateFailure 过滤、status 醒目标记、
 * builder.md/validator.md 经 {{ARBITRATION_PREFIXES}} 占位符渲染（loop.ts renderInstruction）、
 * report/render.ts 报告内仲裁行高亮（isArbitrationLine）。
 */
```

- [ ] **Step 6: 文档同步**

`docs/architecture.md`：
1. 模块表「状态速览」行之后插入一行：

```markdown
| 验证报告 | `src/report/` | `coding-x report` / 循环结束自动生成 `<workspace>/report.html` 静态验证证据存档（story 状态+AC、门禁配置、截图相对引用、review 留痕、篡改红旗区）；collectReport/renderReportHtml/writeReport 纯函数，零浏览器 JS，全文本转义 |
```

2. 「分层与依赖方向」段，`cli → engine（loop → agent / prd / state / progress / repair）；` 后补一句：

```markdown
report 模块被 cli 与 loop 调用，反向只读 engine 的 prd/state/progress 读取函数与 gate 的仲裁判定——与 dashboard 同为消费端。
```

3. 「数据流」节末尾补一句：

```markdown
循环结束（或手动 `coding-x report`）由三份文件+screenshots/+review 留痕+篡改存档派生 `report.html` 静态验证报告——只读派生物，不回写任何执行状态。
```

4. frontmatter `updated:` 刷新为提交当日。

`README.md`：
1. 快速命令区（`npx coding-x doctor --stale-days 14` 行之后）加：

```
npx coding-x report             # 手动（重）生成 .workspace/report.html 静态验证报告
```

2. 位置参数表（`| 位置参数 \`status\` | …` 行之后）加：

```markdown
| 位置参数 `report` | — | （重）生成 `<workspace>/report.html` 静态验证报告（story 状态+AC、门禁、截图、review 留痕、篡改红旗区）；循环结束时也会自动生成；退出码 0=已生成 / 1=写入失败 / 2=无可读工作区 |
```

3. 特性列表（`- **实时 Web 仪表盘**：…` 条目之后）加：

```markdown
- **静态验证报告**：循环结束自动生成 `.workspace/report.html`——story 验收证据（AC/notes/截图）、门禁配置、人审留痕（review-*.md）、篡改红旗区汇总为零依赖单页，双击打开；/review-loop 裁决回填后 `npx coding-x report` 随时刷新。截图为相对引用，分享报告需连同 `screenshots/` 目录。
```

4. 目录结构 `src/` 区（`│   │   └── repair.ts` 行之后、对齐现有缩进风格）加：

```
│   ├── report/
│   │   ├── report.ts             #   验证报告数据收集与写盘（collectReport/writeReport）
│   │   └── render.ts             #   验证报告 HTML 渲染（零浏览器 JS、全文本转义）
```

- [ ] **Step 7: 全量回归 + 提交**

Run: `npm run typecheck && npm test`
Expected: 双绿。

```bash
git add src/engine/loop.ts src/engine/loop.test.ts src/engine/gate.ts README.md docs/architecture.md
git commit -m "feat: 循环结束自动生成验证报告+文档同步——报告失败仅告警不动退出码，ARBITRATION_PREFIXES 注释登记第六消费方（#3 静态 HTML 报告 T4）"
```

---

### Task 5: 发版 0.19.0（前置：人审通过）

**前置 gate：本任务只在 /review-loop 人审 + 用户裁决放行之后执行，不随 T1-T4 连跑。**

**Files:**
- Modify: `docs/superpowers/specs/2026-07-08-static-html-report-design.md`（status → done）
- Modify: `docs/superpowers/plans/2026-07-08-static-html-report.md`（status → done）
- `package.json` 等版本文件由 `npm version` 钩子自动同步（插件清单+lock），不手改。

- [ ] **Step 1: 终验**

Run: `npm run typecheck && npm test && npm run build`
Expected: 三绿（build 产出 dist/cli.js）。

- [ ] **Step 2: 真实 workspace 冒烟**

Run: `node dist/cli.js report --workspace .superpowers/fixtures/study-report-dogfood/.workspace && ls -la .superpowers/fixtures/study-report-dogfood/.workspace/report.html`
Expected: 退出码 0、打印 `📄 验证报告:` 路径、report.html 生成；浏览器打开抽查：61 个工件按 story 归类、review-2026-07-07.md 渲染、红旗区列出 prd.tampered-20260707-165439.json。冒烟后删除生成物：`rm .superpowers/fixtures/study-report-dogfood/.workspace/report.html`（fixture 不留生成物）。

- [ ] **Step 3: 文档状态收尾**

spec 与本计划 frontmatter `status: active` → `status: done`、`updated` 刷新为当日；提交：

```bash
git add docs/superpowers/specs/2026-07-08-static-html-report-design.md docs/superpowers/plans/2026-07-08-static-html-report.md
git commit -m "docs: 静态 HTML 报告 spec/plan 交付置 done"
```

- [ ] **Step 4: 发版**

```bash
npm version minor -m "release: v%s"
git push --follow-tags
```

Expected: 版本落 0.19.0，钩子自动同步三个插件清单与 package-lock；push 后**停手**——npm publish 与 GitHub Release 由 tag 触发的 CI（publish.yml）完成，本地不抢发（0.14.3 实翻教训）。

- [ ] **Step 5: CI 确认**

Run: `gh run list --limit 3`（或稍后 `npm view coding-x version`）
Expected: publish workflow 绿、npm 显示 0.19.0。

---

## Self-Review（计划完成后自检记录）

1. **Spec coverage**：七区信息架构→T2 render 各函数；三态收集/容错→T1；自动+子命令双时机→T3（cli）+T4（loop）；截图相对引用→T2 imgSrc；转义硬要求→T2 测试「notes 注入不执行」「md 先转义」；零浏览器 JS→T2 断言；退出码 0/1/2→T3；报告失败不影响循环→T4 try/catch+两用例；README/architecture 同步→T4 Step 6；0.19.0→T5；非目标（历史轮聚合/内嵌/完整 md/交互）未出现在任何任务 ✓。
2. **Placeholder scan**：全任务代码块完整可抄，无 TBD/「适当处理」类表述 ✓。
3. **Type consistency**：`ReportData`/`ScreenshotEntry`/`ReportSource`/`WriteReportResult` 与 `collectReport(workspace, now)`/`renderReportHtml(data)`/`writeReport(workspace, now)` 签名在 T1/T2/T3/T4 的 Interfaces 与代码块中一致；render 对 report.js 仅 `import type`（运行时 report→render 单向）✓。
