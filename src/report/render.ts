import type { ReportData, ScreenshotEntry } from './report.js';
import type { StoryView } from '../engine/state.js';
import { isArbitrationLine, readQualityChecks } from '../engine/gate.js';
import { readModelsConfig } from '../engine/models.js';

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * 插值兜底 helper：来自 prd/state 落盘数据的字段类型层声明为 string，但 tryReadPrd
 * 无逐字段运行期校验（legacyStateOf 同理）——实际值可能是 undefined/数字/对象等
 * 非字符串形状。String(x ?? '') 统一收敛：缺失值渲染为空串而非让 escapeHtml 内部
 * 的 .replaceAll 在非字符串上抛错，其余值按 String() 语义转字符串后再转义。
 */
function text(x: unknown): string {
  return escapeHtml(String(x ?? ''));
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
    .map((l) => `<div class="${noteLineClass(l)}">${text(l)}</div>`)
    .join('');
  return `<div class="notes">${lines}</div>`;
}

function renderShotFigure(s: ScreenshotEntry): string {
  const name = text(s.filename);
  if (!s.isImage) {
    // download：非图片附件（pdf 等）不应在浏览器内联打开而应强制下载；
    // rel 防 target="_blank" 的反向 window.opener 访问——此处非 _blank 也一并加固，成本为零
    return `<div class="artifact-link"><a href="${imgSrc(s.filename)}" download rel="noopener noreferrer">📎 ${name}</a></div>`;
  }
  return `<figure class="shot"><a href="${imgSrc(s.filename)}" target="_blank" rel="noopener noreferrer"><img src="${imgSrc(s.filename)}" alt="${name}" loading="lazy"></a><figcaption>${name}</figcaption></figure>`;
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
  const acs = acList.map((a) => `<li>${text(a)}</li>`).join('');
  return `<section class="card story">
<h3>${text(s.id)} ${text(s.title)} ${storyBadge(s)}${retry}</h3>
<ul class="acs">${acs}</ul>
${renderNotes(s.notes)}
${renderGallery(shots)}
</section>`;
}

function renderBanner(stories: StoryView[]): string {
  const total = stories.length;
  if (total === 0) return '<div class="banner blocked">⚠️ prd.json 中没有任何 story</div>';
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
  const files = tampered.map((f) => `<li><code>${text(f)}</code></li>`).join('');
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
  // 免责标注：.workspace/ 是 agent 可写目录，report.html 本身也是渲染产物——
  // 留痕内容的真实性以 git 提交历史中的 review-*.md 为准，报告只负责展示
  const disclaimer = '<p class="placeholder">留痕真实性以 git 提交的 review-*.md 为准（.workspace/ 属 agent 可写目录）。</p>';
  const sections = reviews.map((r) =>
    `<section class="card review"><h2>人审留痕：${text(r.filename)}</h2><div class="md">${renderMarkdownLite(r.content)}</div></section>`,
  ).join('\n');
  return disclaimer + sections;
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
    ? '<div class="meta-line warn">⚠️ state.json 已损坏，已按 prd.json 内嵌旧格式状态回退显示，可能非最新执行结果（建议 npx coding-x repair）</div>'
    : '';
  const title = `${text(prd.project)} · 验证报告`;
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
<div class="meta-line">分支：<code>${text(prd.branchName)}</code>${prd.sourcePrd ? ` · 源 PRD：<code>${text(prd.sourcePrd)}</code>` : ''}</div>
<div class="meta-line">生成时间：${formatStamp(data.generatedAt)} · workspace：<code>${text(data.workspace)}</code></div>
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
