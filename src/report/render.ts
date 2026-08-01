import type { ReportData, ScreenshotEntry } from './report.js';
import { INITIAL_STORY_STATE, isStoryPassed, type StoryView } from '../engine/state.js';
import {
  isArbitrationLine, GATE_FAIL_LINE_PREFIX,
  VALIDATOR_FAIL_LINE_PREFIX, BLOCKED_LINE_PREFIX, ABORT_LINE_PREFIX,
} from '../engine/gate.js';
import { readModelRouting } from '../engine/models.js';
import type { EvidenceRecord, ScreenshotClaim } from '../engine/evidence.js';
import { readTddConfig } from '../engine/tdd-gate.js';

export function escapeHtml(s: string): string {
  return s.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');
}

/**
 * 插值兜底 helper：来自 prd/state 落盘数据的字段类型层声明为 string，但 tryReadPrd
 * 无逐字段运行期校验（legacyStateOf 同理）——实际值可能是 undefined/数字/对象等
 * 非字符串形状。缺失值渲染为空串，其余非字符串值用 JSON 表达，避免对象退化成
 * 无意义的 [object Object]，最后统一转义。
 */
function text(x: unknown): string {
  const value = typeof x === 'string' ? x : x == null ? '' : JSON.stringify(x);
  return escapeHtml(value ?? '');
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
  if (line.startsWith(GATE_FAIL_LINE_PREFIX) || line.startsWith(VALIDATOR_FAIL_LINE_PREFIX)) {
    return 'note-line gate-fail';
  }
  if (line.startsWith(BLOCKED_LINE_PREFIX)) return 'note-line blocked-line';
  // 中断轮待复核：与门禁失败行同属「引擎机械回写」性质，样式复用 gate-fail（不新开 CSS 类）
  if (line.startsWith(ABORT_LINE_PREFIX)) return 'note-line gate-fail';
  return 'note-line';
}

function renderNotes(notes: string): string {
  if (notes.trim() === '') return '';
  const lines = notes.split('\n')
    .map((l) => `<div class="${noteLineClass(l)}">${text(l)}</div>`)
    .join('');
  return `<div class="notes">${lines}</div>`;
}

function renderShotFigure(s: ScreenshotEntry, markUnclaimed: boolean): string {
  const name = text(s.filename);
  const tag = markUnclaimed ? '<span class="unclaimed">未登记</span>' : '';
  if (!s.isImage) {
    // download：非图片附件（pdf 等）不应在浏览器内联打开而应强制下载；
    // rel 防 target="_blank" 的反向 window.opener 访问——此处非 _blank 也一并加固，成本为零
    return `<div class="artifact-link"><a href="${imgSrc(s.filename)}" download rel="noopener noreferrer">📎 ${name}</a>${tag}</div>`;
  }
  return `<figure class="shot"><a href="${imgSrc(s.filename)}" target="_blank" rel="noopener noreferrer"><img src="${imgSrc(s.filename)}" alt="${name}" loading="lazy"></a><figcaption>${name}${tag}</figcaption></figure>`;
}

// claimedFiles=null：全局无任何 claim（无 evidence 或无登记）——不标注不排序，视觉与 0.19.0 一致
function renderGallery(shots: ScreenshotEntry[], claimedFiles: ReadonlySet<string> | null = null): string {
  if (shots.length === 0) return '';
  const groups = [
    { phase: 'builder' as const, label: 'builder 截图' },
    { phase: 'validator' as const, label: 'validator 截图' },
  ];
  const parts: string[] = [];
  for (const g of groups) {
    const own = shots.filter((s) => s.phase === g.phase);
    if (own.length === 0) continue;
    // 登记优先：有 claim 的排前（组内稳定排序，登记态相同保持名序）；无 claim 语境保持名序
    const sorted = claimedFiles === null ? own
      : [...own].sort((a, b) => Number(claimedFiles.has(b.filename)) - Number(claimedFiles.has(a.filename)));
    parts.push(
      `<div class="gallery-group"><div class="gallery-label">${g.label}（${own.length}）</div>` +
      `<div class="gallery">${sorted.map((s) => renderShotFigure(s, claimedFiles !== null && !claimedFiles.has(s.filename))).join('')}</div></div>`,
    );
  }
  return parts.join('');
}

function storyBadge(s: StoryView): string {
  if (isStoryPassed(s)) return '<span class="badge ok">✅ 通过</span>';
  if (s.blocked) return '<span class="badge blocked">⛔ blocked</span>';
  if (s.passes) return '<span class="badge pending">🟨 待引擎验收</span>';
  return '<span class="badge pending">⬜ 未完成</span>';
}

function renderStoryCard(s: StoryView, shots: ScreenshotEntry[], claims: ScreenshotClaim[], anyClaims: boolean): string {
  const retry = s.retryCount > 0 ? ` <span class="retry">重试 ${s.retryCount} 次</span>` : '';
  const routeMeta = s.difficulty
    ? `<div class="meta-line">难度：<code>${text(s.difficulty)}</code>${s.escalated ? ' · ⬆️ 已升级' : ''}` +
      `${s.difficultyReason ? ` · 依据：${text(s.difficultyReason)}` : ''}</div>`
    : (s.escalated ? '<div class="meta-line">⬆️ 已升级</div>' : '');
  // tryReadPrd 无逐字段守卫，acceptanceCriteria 可能形状非法——渲染层兜底为空列表
  const acList = Array.isArray(s.acceptanceCriteria) ? s.acceptanceCriteria : [];
  // acIndex 从 1 数起；越界（<1 或 >AC 数）、非整数（如 1.5）与缺省一律归 story 级登记，不静默丢弃
  const isStoryLevel = (c: ScreenshotClaim) =>
    c.acIndex === undefined || !Number.isInteger(c.acIndex) || c.acIndex < 1 || c.acIndex > acList.length;
  const acs = acList.map((a, idx) => {
    const own = claims.filter((c) => c.acIndex === idx + 1);
    const badges = own.map((c) => ` ${claimLink(c)}${c.note ? `<span class="claim-note">${text(c.note)}</span>` : ''}`).join('');
    return `<li>${text(a)}${badges}</li>`;
  }).join('');
  const storyClaims = claims.filter(isStoryLevel);
  const storyClaimsHtml = storyClaims.length
    ? `<div class="meta-line">story 级登记：${storyClaims.map((c) => `${claimLink(c)}${c.note ? `（${text(c.note)}）` : ''}`).join(' · ')}</div>`
    : '';
  return `<section class="card story">
<h3>${text(s.id)} ${text(s.title)} ${storyBadge(s)}${retry}</h3>
${routeMeta}
<ul class="acs">${acs}</ul>
${storyClaimsHtml}
${renderNotes(s.notes)}
${renderGallery(shots, anyClaims ? new Set(claims.map((c) => c.file)) : null)}
</section>`;
}

function renderImplementationBanner(stories: StoryView[], stateCorrupted: boolean): string {
  if (stateCorrupted) return '<div class="banner blocked">❌ 状态不可验证：state.json 已损坏</div>';
  const total = stories.length;
  if (total === 0) return '<div class="banner blocked">⚠️ prd.json 中没有任何 story</div>';
  const passed = stories.filter(isStoryPassed).length;
  const blocked = stories.filter((x) => x.blocked).length;
  if (total > 0 && passed === total) return `<div class="banner ok">✅ Story 验证完成 ${passed}/${total}</div>`;
  if (blocked > 0) return `<div class="banner blocked">⛔ ${passed} 通过 · ${blocked} blocked · 共 ${total}</div>`;
  return `<div class="banner running">⏳ 进行中：${passed}/${total} 通过</div>`;
}

function reviewStatusLabel(status: 'passed' | 'failed' | 'unverifiable'): string {
  if (status === 'passed') return '已通过';
  if (status === 'failed') return '有待处理问题';
  return '无法验证';
}

function renderFinalReview(data: ReportData, stories: StoryView[]): string {
  const currentReview = data.finalReview;
  const review = currentReview.read;
  if (review.status === 'missing') {
    return `<section class="card"><h2>交付状态</h2>
<div class="banner running">⏳ Story 结果不等于可交付</div>
<p>本地最终 Review 尚未运行；GitHub 交付状态尚未由最终 Review 记录。</p></section>`;
  }
  if (review.status === 'invalid') {
    return `<section class="card red-flag"><h2>交付状态</h2>
<div class="banner blocked">❌ 本地最终 Review 状态损坏</div>
<p>${text(review.error)}</p></section>`;
  }
  const state = review.state;
  const remote = currentReview.refreshedRemote ?? state.remote;
  const findings = state.axes.flatMap((axis) => axis.findings);
  const axes = state.axes.map((axis) =>
    `<li>${text(axis.axis)}：${text(reviewStatusLabel(axis.status))} · ${axis.findings.length} 个 finding</li>`,
  ).join('');
  const implementationReady = !data.stateCorrupted
    && stories.length > 0
    && stories.every(isStoryPassed);
  const deliveryReady = implementationReady
    && currentReview.current
    && currentReview.refreshedRemote !== undefined
    && state.status === 'passed'
    && remote.status === 'ready'
    && !state.shadow;
  const banner = deliveryReady
    ? '<div class="banner ok">✅ 本地 Review 与 GitHub 交付条件已就绪</div>'
    : `<div class="banner ${
        state.status === 'failed'
        || state.status === 'unverifiable'
        || !implementationReady
        || !currentReview.current
          ? 'blocked'
          : 'running'
      }">` +
      `${
        state.shadow
          ? '🧪 Shadow 结果不能表示可交付'
          : !implementationReady
            ? '❌ Story 状态未完成或不可验证，不能交付'
            : !currentReview.current
              ? '❌ 本地最终 Review 已过期或未完成当前性核验'
              : currentReview.refreshedRemote === undefined
                ? '⏳ GitHub 交付条件尚未重新核验'
              : '⏳ 尚未达到交付条件'
      }</div>`;
  const staleReasons =
    currentReview.current || currentReview.staleReasons.length === 0
      ? ''
      : `<ul class="checks">${currentReview.staleReasons
          .map((reason) => `<li>当前性：${text(reason)}</li>`)
          .join('')}</ul>`;
  return `<section class="card"><h2>交付状态</h2>
${banner}
<div class="meta-line">本地 Review：${text(reviewStatusLabel(state.status))} · GitHub：${text(remote.status)} · finding：${findings.length}</div>
<div class="meta-line">PR #${state.binding.prNumber} · head <code>${text(state.binding.headSha.slice(0, 12))}</code> · ${text(state.binding.runner)} / ${text(state.binding.model)}</div>
${staleReasons}
${axes ? `<ul class="checks">${axes}</ul>` : ''}
<p class="placeholder">这是本机 workspace 中的结果展示，不是 GitHub 共享证明；共享交付记录以 GitHub 检查与 PR 历史为准。</p>
</section>`;
}

function renderGateConfig(data: ReportData): string {
  const value: unknown = data.prd.qualityChecks;
  if (value === undefined) return '<div class="meta-line warn">质量契约检查：PRD 未绑定派生快照</div>';
  if (Array.isArray(value)) {
    const legacy = value.every((entry) => typeof entry === 'string');
    return legacy
      ? '<div class="meta-line warn">质量契约检查：仍是旧版字符串命令数组，正式运行会拒绝</div>'
      : '<div class="meta-line warn">质量契约检查：派生快照形状非法</div>';
  }
  if (typeof value !== 'object' || value === null) {
    return '<div class="meta-line warn">质量契约检查：派生快照形状非法</div>';
  }
  const rows: string[] = [];
  for (const category of ['test', 'build', 'static', 'security']) {
    const group = (value as Record<string, unknown>)[category];
    if (typeof group !== 'object' || group === null || Array.isArray(group)) {
      return '<div class="meta-line warn">质量契约检查：派生快照形状非法</div>';
    }
    const record = group as Record<string, unknown>;
    if (typeof record.notApplicable === 'string' && record.notApplicable.trim() !== '') {
      rows.push(`<li>${text(category)}：不适用（${text(record.notApplicable)}）</li>`);
      continue;
    }
    if (!Array.isArray(record.checks) || record.checks.length === 0) {
      return '<div class="meta-line warn">质量契约检查：派生快照形状非法</div>';
    }
    for (const check of record.checks) {
      if (typeof check !== 'object' || check === null || Array.isArray(check)
          || typeof (check as Record<string, unknown>).id !== 'string') {
        return '<div class="meta-line warn">质量契约检查：派生快照形状非法</div>';
      }
      rows.push(`<li>${text(category)}：<code>${text((check as Record<string, unknown>).id)}</code></li>`);
    }
  }
  return `<div class="meta-line">质量契约派生检查：</div><ul class="checks">${rows.join('')}</ul>`;
}

function renderTddConfig(data: ReportData): string {
  const parsed = readTddConfig(data.prd);
  if (parsed.status === 'disabled') return '';
  if (parsed.status === 'invalid') {
    return `<div class="meta-line warn">TDD 门禁：配置非法（${text(parsed.error)}）</div>`;
  }
  const config = parsed.config;
  return '<div class="meta-line">TDD 门禁：已启用</div>'
    + `<ul class="checks"><li><code>${text(config.coverageCheck)}</code></li>`
    + `<li>政策文件 ${config.policyFiles.length} 个 · 生产路径 ${config.sourcePathspecs.length} 个`
    + ` · 基线 <code>${text(config.baselineRef.slice(0, 12))}</code></li></ul>`;
}

/** ISO at → 本地 YYYY-MM-DD HH:mm；非法输入原样转义呈现（evidence 是 agent 可写区数据） */
function stampOf(at: string): string {
  const d = new Date(at);
  return Number.isNaN(d.getTime()) ? text(at) : formatStamp(d);
}

function gateRunsOf(records: EvidenceRecord[]): Extract<EvidenceRecord, { type: 'gate-run' }>[] {
  return records.filter((r): r is Extract<EvidenceRecord, { type: 'gate-run' }> => r.type === 'gate-run');
}

function renderDiagnostic(label: string, value: string | undefined): string {
  if (!value) return '';
  return `<details class="evidence-diagnostic"><summary>${text(label)}</summary><pre>${text(value)}</pre></details>`;
}

function invocationMeta(value: { durationMs: number; exitCode: number | null } | undefined): string {
  if (!value) return '';
  const exit = value.exitCode === null ? 'exit unavailable' : `exit ${value.exitCode}`;
  return ` · ${(value.durationMs / 1000).toFixed(1)}s · ${exit}`;
}

type GateOrTddRun = Extract<EvidenceRecord, { type: 'gate-run' | 'tdd-gate' }>;

function evidenceChainKey(record: {
  runId?: string;
  iteration: number;
  storyId: string | null;
}): string | null {
  return record.runId === undefined
    ? null
    : `${record.runId}\0${record.iteration}\0${record.storyId ?? ''}`;
}

/** gate/TDD 与 closing iteration 只用同一 run 身份关联；旧记录绝不靠邻接或轮号猜测。 */
function runsRejectedByLaterHeadAbort(records: EvidenceRecord[]): Set<GateOrTddRun> {
  const aborted = new Set(
    records
      .filter((record): record is Extract<EvidenceRecord, { type: 'iteration' }> =>
        record.type === 'iteration' && record.validationHeadAbort !== undefined)
      .map(evidenceChainKey)
      .filter((key): key is string => key !== null),
  );
  return new Set(
    records.filter((record): record is GateOrTddRun =>
      (record.type === 'gate-run' ||
        (record.type === 'tdd-gate' && record.phase === 'post-builder')) &&
      (() => {
        const key = evidenceChainKey(record);
        return key !== null && aborted.has(key);
      })()),
  );
}

function renderGateHistory(records: EvidenceRecord[]): string {
  const runs = gateRunsOf(records);
  if (runs.length === 0) return '';
  const rejectedByLaterAbort = runsRejectedByLaterHeadAbort(records);
  const rows = runs.map((r) => {
    const accepted = r.accepted !== false && !rejectedByLaterAbort.has(r);
    const failNote = r.ok
      ? accepted ? '' : '提交身份复核失败；命令结果未进入裁决'
      : `${text(r.failedCommand ?? '')}${r.timedOut ? '（超时）' : r.exitCode !== undefined && r.exitCode !== null ? `（退出码 ${r.exitCode}）` : ''}${renderDiagnostic('门禁输出尾部', r.diagnosticTail)}`;
    const result = !accepted
      ? `⚠️ 已执行，结果未采用（命令${r.ok ? '通过' : '未通过'}）`
      : r.ok ? '✅ 通过' : '❌ 未通过';
    return `<tr><td>${r.iteration}</td><td>${text(r.storyId ?? '—')}</td><td>${result}</td><td>${r.ran}/${r.total}</td><td>${(r.ms / 1000).toFixed(1)}s</td><td>${stampOf(r.at)}</td><td>${failNote}</td></tr>`;
  }).join('');
  return `<div class="meta-line">门禁执行历史（engine 记录）：</div>` +
    `<table class="evidence-table"><thead><tr><th>轮</th><th>story</th><th>结果</th><th>执行</th><th>耗时</th><th>时刻</th><th>失败摘要</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="placeholder">engine 记录同处 agent 可写目录，防伪加固属后续评估——关键裁决请交叉核对 git 历史与工件。</p>`;
}

function renderTddHistory(records: EvidenceRecord[]): string {
  const runs = records.filter((record): record is Extract<EvidenceRecord, { type: 'tdd-gate' }> =>
    record.type === 'tdd-gate');
  if (runs.length === 0) return '';
  const rejectedByLaterAbort = runsRejectedByLaterHeadAbort(records);
  const rows = runs.map((run) => {
    const phase = run.phase === 'preflight' ? '启动预检' : `第 ${run.iteration} 轮`;
    const policy = run.policyOk ? '政策通过' : '政策未通过';
    const commandPassed = run.commandRan &&
      (run.commandOk ?? run.failureCode !== 'coverage-check-failed');
    const commandFact = !run.commandRan
      ? '未执行'
      : commandPassed ? '覆盖命令通过' : '覆盖命令未通过';
    const accepted = run.accepted !== false && !rejectedByLaterAbort.has(run);
    const command = accepted ? commandFact : `${commandFact}，结果未采用`;
    const failure = run.ok
      ? ''
      : `${text(run.failureCode ?? '')} · ${text(run.failedCommand ?? '')}`
        + `${run.timedOut ? '（超时）' : run.exitCode !== undefined && run.exitCode !== null ? `（退出码 ${run.exitCode}）` : ''}`
        + renderDiagnostic('TDD 门禁输出尾部', run.diagnosticTail);
    const result = !accepted
      ? `⚠️ 流程结束，结果未采用（覆盖命令${run.commandRan ? commandPassed ? '通过' : '未通过' : '未执行'}）`
      : run.ok ? '✅ 通过' : '❌ 未通过';
    return `<tr><td>${phase}</td><td>${text(run.storyId ?? '—')}</td>`
      + `<td>${result}</td><td>${policy}</td><td>${command}</td>`
      + `<td>${(run.ms / 1000).toFixed(1)}s</td><td>${stampOf(run.at)}</td><td>${failure}</td></tr>`;
  }).join('');
  return '<div class="meta-line">TDD 门禁执行历史（engine 记录）：</div>'
    + '<table class="evidence-table"><thead><tr><th>阶段</th><th>story</th><th>结果</th>'
    + '<th>政策</th><th>覆盖命令</th><th>耗时</th><th>时刻</th><th>失败摘要</th></tr></thead>'
    + `<tbody>${rows}</tbody></table>`;
}

function renderTimeline(records: EvidenceRecord[]): string {
  const iters = records.filter((r): r is Extract<EvidenceRecord, { type: 'iteration' }> => r.type === 'iteration');
  if (iters.length === 0) return '';
  const rows = iters.map((r) => {
    const flags: string[] = [];
    if (r.builderOutcome === 'timeout') flags.push('builder 超时');
    if (r.builderOutcome === 'error') flags.push('builder 异常退出');
    if (r.noop) flags.push('空转（无产出）');
    if (r.gateRejected) flags.push('门禁打回');
    if (r.validatorOutcome === 'timeout') flags.push('validator 超时');
    if (r.validatorOutcome === 'error') flags.push('validator 异常退出');
    if (r.abortRollback) flags.push(`已回写 ${text(r.abortRollback.storyId)} 待复核`);
    if (r.validationRollback) flags.push('未签发验收凭证，已回写待复核');
    if (r.validationHeadAbort) {
      const expected = r.validationHeadAbort.expectedGitHead?.slice(0, 12) ?? 'unavailable';
      const actual = r.validationHeadAbort.actualGitHead?.slice(0, 12) ?? 'unavailable';
      const reason = r.validationHeadAbort.reason === 'head-unreadable'
        ? '提交身份不可读'
        : '提交身份变化';
      flags.push(
        `检查链中止：${reason}@${text(r.validationHeadAbort.phase)}` +
        `（期望 ${text(expected)}，实际 ${text(actual)}）；相关执行结果未采用`,
      );
    }
    if (r.validationReceipt) flags.push('验收凭证已签发');
    if (r.validationProtocol === 'passed') flags.push('结构化验收协议通过');
    if (r.validationProtocol === 'failed') flags.push('结构化验收结论未通过');
    if (r.validationProtocol === 'invalid') flags.push('结构化验收协议无效');
    if (r.validationTarget) {
      flags.push(
        `目标 ${text(r.validationTarget.storyId)} · AC ${text(r.validationTarget.acceptanceHash.slice(0, 15))}…` +
        ` · Git ${text(r.validationTarget.gitHead?.slice(0, 12) ?? 'unavailable')}`,
      );
    }
    if (r.validatorStateMutation) flags.push('Validator 改写 state.json，快照已恢复');
    if (r.validatorDiagnostic) flags.push('Validator 打回');
    if (r.escalationTriggeredBy) flags.push(`已触发升级（${text(r.escalationTriggeredBy)}）`);
    for (const tamper of r.stateRouteTamper ?? []) {
      flags.push(`${text(tamper.storyId ?? r.storyId ?? '—')}：${tamper.side} 改写 escalated（${tamper.expected} → ${tamper.received}）已恢复`);
    }
    for (const tamper of r.stateValidationTamper ?? []) {
      flags.push(`${text(tamper.storyId ?? r.storyId ?? '—')}：${tamper.side} 改写 validated（${tamper.expected} → ${tamper.received}）已恢复`);
    }
    const protocolDiagnostic = r.validationProtocolError
      ? `${r.validationProtocolError.code}: ${r.validationProtocolError.diagnostic}`
      : undefined;
    const flagCell = `${flags.length > 0 ? `⚠️ ${flags.join('；')}` : '—'}` +
      `${renderDiagnostic('Builder 进程输出尾部', r.builderInvocation?.diagnosticTail)}` +
      `${renderDiagnostic('Validator 进程输出尾部', r.validatorInvocation?.diagnosticTail)}` +
      `${renderDiagnostic('结构化验收协议错误', protocolDiagnostic)}` +
      `${renderDiagnostic('Validator 打回详情', r.validatorDiagnostic)}`;
    const builder = r.builderRan
      ? `${text(r.builderModel ?? '默认')} [${text(r.builderRouteSource ?? '来源未知')}]` +
        invocationMeta(r.builderInvocation)
      : '未跑';
    const validator = r.validatorRan
      ? `${text(r.validatorModel ?? '默认')} [${text(r.validatorRouteSource ?? '来源未知')}]` +
        invocationMeta(r.validatorInvocation)
      : (r.agentBlocked ? '跳过（agent blocked）' : r.skippedValidator ? '跳过（快照写回失败）' : '未跑');
    return `<tr><td>${r.iteration}</td><td>${text(r.storyId ?? '—')}</td><td>${text(r.storyDifficulty ?? '—')}</td><td>${builder}</td><td>${validator}</td><td>${flagCell}</td><td>${stampOf(r.at)}</td></tr>`;
  }).join('');
  return `<section class="card"><details><summary><h2>轮次时间线（engine 记录）</h2></summary>` +
    `<table class="evidence-table"><thead><tr><th>轮</th><th>story</th><th>难度</th><th>builder 实际路由</th><th>validator 实际路由</th><th>状态</th><th>时刻</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="placeholder">engine 记录同处 agent 可写目录，防伪加固属后续评估——关键裁决请交叉核对 git 历史与工件。</p>` +
    `<p class="placeholder">每轮一条记录；异常轮（超时/异常退出/空转/门禁打回）见状态列标注。</p></details></section>`;
}

function renderValidationClaims(records: EvidenceRecord[]): string {
  const claims = records.filter((record): record is Extract<EvidenceRecord, { type: 'validation-claim' }> =>
    record.type === 'validation-claim');
  if (claims.length === 0) return '';
  const rows = claims.map((claim) => {
    const checks = claim.checks.map((check) =>
      `<li>${check.passed ? '✅' : '❌'} AC ${check.acIndex}：${text(check.evidence)}</li>`).join('');
    const detail = `<details><summary>${text(claim.summary)}</summary><ol>${checks}</ol></details>`;
    return `<tr><td>${claim.iteration}</td><td>${text(claim.storyId)}</td>` +
      `<td>${claim.verdict === 'passed' ? '✅ passed' : '❌ failed'}</td>` +
      `<td>${text(claim.acceptanceHash.slice(0, 15))}…</td>` +
      `<td>${text(claim.gitHead?.slice(0, 12) ?? 'unavailable')}</td><td>${detail}</td></tr>`;
  }).join('');
  return `<section class="card"><details><summary><h2>Validator 结构化声明</h2></summary>` +
    `<table class="evidence-table"><thead><tr><th>轮</th><th>story</th><th>claim</th><th>AC hash</th><th>Git HEAD</th><th>逐项证据</th></tr></thead><tbody>${rows}</tbody></table>` +
    `<p class="placeholder">这些记录的 source=validator，是经引擎做新鲜度与目标绑定校验后的 agent claim；它们不是安全签名或 CI 证明。</p>` +
    `</details></section>`;
}

function claimLink(c: ScreenshotClaim): string {
  return `<a class="ac-claim" href="${imgSrc(c.file)}" target="_blank" rel="noopener noreferrer"${c.note ? ` title="${text(c.note)}"` : ''}>📎 ${text(c.file)}</a><span class="claim-tag">agent 声明</span>`;
}

function renderModels(data: ReportData): string {
  const routing = readModelRouting(data.prd);
  if (routing.status === 'disabled') return '';
  if (routing.status === 'invalid') {
    return routing.errors.map((e) => `<div class="meta-line warn">${escapeHtml(e)}</div>`).join('');
  }
  const { config } = routing;
  return `<div class="meta-line">模型路由（${escapeHtml(config.runner)}）：` +
    `builder low=<code>${escapeHtml(config.builder.low)}</code> · ` +
    `medium=<code>${escapeHtml(config.builder.medium)}</code> · ` +
    `high=<code>${escapeHtml(config.builder.high)}</code> · ` +
    `validator=<code>${escapeHtml(config.validator)}</code> · ` +
    `escalation=<code>${escapeHtml(config.escalation)}</code></div>`;
}

function renderRedFlags(tampered: string[], records: EvidenceRecord[]): string {
  const tamperEvents = records.filter((r): r is Extract<EvidenceRecord, { type: 'tamper' }> => r.type === 'tamper');
  const stateRouteTampers = records
    .filter((r): r is Extract<EvidenceRecord, { type: 'iteration' }> => r.type === 'iteration')
    .flatMap((r) => (r.stateRouteTamper ?? []).map((t) => ({
      ...t, iteration: r.iteration, at: r.at, storyId: t.storyId ?? r.storyId,
    })));
  const stateValidationTampers = records
    .filter((r): r is Extract<EvidenceRecord, { type: 'iteration' }> => r.type === 'iteration')
    .flatMap((r) => (r.stateValidationTamper ?? []).map((t) => ({
      ...t, iteration: r.iteration, at: r.at, storyId: t.storyId ?? r.storyId,
    })));
  const validatorStateMutations = records
    .filter((r): r is Extract<EvidenceRecord, { type: 'iteration' }> =>
      r.type === 'iteration' && r.validatorStateMutation === true);
  if (tampered.length === 0 && tamperEvents.length === 0
      && stateRouteTampers.length === 0 && stateValidationTampers.length === 0
      && validatorStateMutations.length === 0) return '';
  const eventOf = new Map(tamperEvents.filter((t) => t.archive !== null).map((t) => [t.archive as string, t]));
  const files = tampered.map((f) => {
    const ev = eventOf.get(f);
    return `<li><code>${text(f)}</code>${ev ? `（第 ${ev.iteration} 轮 ${stampOf(ev.at)} 检出）` : ''}</li>`;
  }).join('');
  const deletions = tamperEvents.filter((t) => t.archive === null).map((t) =>
    `<li>第 ${t.iteration} 轮 ${stampOf(t.at)} 检出删除类篡改（无存档）</li>`,
  ).join('');
  // 存档已记名但工作区找不到对应文件（如归档目录未携带 tampered 文件、或人工清理过）：
  // 不能静默消失——单独成行提示「已不在工作区」，取证链断裂时红旗区不得只剩空 <ul>
  const missing = tamperEvents.filter((t) => t.archive !== null && !tampered.includes(t.archive)).map((t) =>
    `<li>第 ${t.iteration} 轮 ${stampOf(t.at)} 检出，存档 <code>${text(t.archive)}</code> 已不在工作区</li>`,
  ).join('');
  const routeItems = stateRouteTampers.map((t) =>
    `<li>第 ${t.iteration} 轮 ${stampOf(t.at)} ${text(t.storyId ?? '—')}：${t.side} 改写引擎独占字段 <code>escalated</code>（${t.expected} → ${t.received}），已恢复</li>`,
  ).join('');
  const validationItems = stateValidationTampers.map((t) =>
    `<li>第 ${t.iteration} 轮 ${stampOf(t.at)} ${text(t.storyId ?? '—')}：${t.side} 改写引擎独占字段 <code>validated</code>（${t.expected} → ${t.received}），已恢复</li>`,
  ).join('');
  const validatorMutationItems = validatorStateMutations.map((r) =>
    `<li>第 ${r.iteration} 轮 ${stampOf(r.at)} ${text(r.storyId ?? '—')}：Validator 改写 <code>state.json</code>，引擎已恢复调用前快照并拒绝该轮 claim</li>`,
  ).join('');
  return `<section class="card red-flag">
<h2>🚩 红旗区：运行期状态 / PRD 篡改</h2>
<p>引擎检出并恢复了不应由 agent 修改的数据（PRD 防护见 ADR-007，状态所有权见 ADR-013/ADR-015）。合并裁决前请逐个核对：</p>
<ul>${files}${deletions}${missing}${routeItems}${validationItems}${validatorMutationItems}</ul>
<p>指引：核对上述记录及对应存档；与预期不符须停止合并。</p>
</section>`;
}

function renderUnattributed(shots: ScreenshotEntry[], orphanClaims: ScreenshotClaim[]): string {
  const orphan = shots.filter((s) => s.storyId === null);
  if (orphan.length === 0 && orphanClaims.length === 0) return '';
  const claimLines = orphanClaims.map((c) =>
    `<div class="artifact-link">${claimLink(c)}（登记 storyId：<code>${text(c.storyId)}</code> 未匹配任何 story）${c.note ? ` ${text(c.note)}` : ''}</div>`,
  ).join('');
  return `<section class="card"><h2>未归类工件</h2><div class="gallery">${orphan.map((s) => renderShotFigure(s, false)).join('')}</div>${claimLines}</section>`;
}

function renderReviews(reviews: ReportData['reviews']): string {
  if (reviews.length === 0) {
    return '<section class="card"><h2>本地裁决记录</h2><p class="placeholder">尚无历史 Markdown 反馈；正式裁决只写入结构化记录。</p></section>';
  }
  // 旧 review-*.md 只作为本地历史反馈展示；它被 Git 忽略，不能成为共享交付凭证。
  const disclaimer = '<p class="placeholder">以下 Markdown 仅为被 Git 忽略的本地历史反馈；不能作为通过证明。共享交付记录以 GitHub 检查与 PR 历史为准。</p>';
  const sections = reviews.map((r) =>
    `<section class="card review"><h2>历史本地反馈：${text(r.filename)}</h2><div class="md">${renderMarkdownLite(r.content)}</div></section>`,
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
.evidence-table { border-collapse: collapse; font-size: 12px; margin: 6px 0 10px; }
.evidence-table th, .evidence-table td { border: 1px solid var(--border); padding: 4px 10px; text-align: left; }
.evidence-table th { background: hsl(240 4% 93%); font-weight: 600; }
.evidence-diagnostic { margin-top: 4px; max-width: 440px; }
.evidence-diagnostic summary { color: hsl(4 90% 40%); font-weight: 600; }
.evidence-diagnostic pre { max-height: 240px; overflow: auto; white-space: pre-wrap; overflow-wrap: anywhere; background: hsl(240 4% 95%); border-radius: 6px; padding: 8px; margin: 4px 0 0; font-family: var(--font-mono); }
.ac-claim { font-size: 12px; margin-left: 6px; word-break: break-all; }
.claim-tag { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: hsl(36 100% 50% / 0.15); color: hsl(36 100% 32%); margin-left: 4px; vertical-align: middle; }
.claim-note { font-size: 12px; color: var(--muted); margin-left: 6px; }
.unclaimed { font-size: 10px; padding: 1px 6px; border-radius: 999px; background: hsl(0 0% 72% / 0.25); color: var(--muted); margin-left: 4px; vertical-align: middle; }
`;

export function renderReportHtml(data: ReportData): string {
  const { prd } = data;
  // 双层 fail-closed：collectReport 已使用空白 state；渲染层再消毒一次，避免未来
  // 其他调用方直接构造 ReportData 时把损坏态与通过态组合成假绿报告。
  const stories = data.stateCorrupted
    ? data.stories.map((story) => ({ ...story, ...INITIAL_STORY_STATE }))
    : data.stories;
  const byStory = new Map<string, ScreenshotEntry[]>();
  for (const s of data.screenshots) {
    if (s.storyId === null) continue;
    const list = byStory.get(s.storyId) ?? [];
    list.push(s);
    byStory.set(s.storyId, list);
  }
  // claim 归属：storyId 大小写不敏感匹配（对齐 parseScreenshotEntry 先例）；匹配不到的落未归类
  const allClaims = data.evidence.records.filter((r): r is ScreenshotClaim => r.type === 'screenshot-claim');
  const idByLower = new Map(stories.map((s) => [String(s.id).toLowerCase(), s.id]));
  const claimsByStory = new Map<string, ScreenshotClaim[]>();
  const orphanClaims: ScreenshotClaim[] = [];
  for (const c of allClaims) {
    const realId = idByLower.get(c.storyId.toLowerCase());
    if (realId === undefined) { orphanClaims.push(c); continue; }
    const list = claimsByStory.get(realId) ?? [];
    list.push(c);
    claimsByStory.set(realId, list);
  }
  const cards = stories.map((s) => renderStoryCard(s, byStory.get(s.id) ?? [], claimsByStory.get(s.id) ?? [], allClaims.length > 0)).join('\n');
  const claimDisclaimer = allClaims.length > 0
    ? '<p class="placeholder">「agent 声明」类证据由 builder/validator 自行登记，真实性以截图内容与 git 历史为准。</p>'
    : '';
  const stateWarn = data.stateCorrupted
    ? '<div class="meta-line warn">⚠️ state.json 已损坏，按全部 story 未验证处理；未使用 prd.json 内嵌旧格式状态（建议 npx coding-x repair）</div>'
    : '';
  const prdSource = data.prdSource === 'engine-snapshot'
    ? '<div class="meta-line">需求来源：引擎启动快照（运行期冻结）</div>'
    : '';
  const evidenceWarn = data.evidence.skippedLines > 0
    ? `<div class="meta-line warn">⚠️ evidence.jsonl 有 ${data.evidence.skippedLines} 行无法解析已跳过</div>`
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
${renderImplementationBanner(stories, data.stateCorrupted)}
<div class="meta-line">分支：<code>${text(prd.branchName)}</code>${prd.sourcePrd ? ` · 源 PRD：<code>${text(prd.sourcePrd)}</code>` : ''}</div>
<div class="meta-line">生成时间：${formatStamp(data.generatedAt)} · workspace：<code>${text(data.workspace)}</code></div>
${prdSource}
${stateWarn}
${evidenceWarn}
${renderGateConfig(data)}
${renderTddConfig(data)}
${renderGateHistory(data.evidence.records)}
${renderTddHistory(data.evidence.records)}
${renderModels(data)}
<div class="meta-line">统计：${stories.length} story · ${data.screenshots.length} 个截图工件 · ${data.reviews.length} 份人审留痕</div>
</header>
${renderRedFlags(data.tamperedArchives, data.evidence.records)}
${renderFinalReview(data, stories)}
<h2 class="section-title">story 证据</h2>
${claimDisclaimer}
${cards}
${renderUnattributed(data.screenshots, orphanClaims)}
${renderValidationClaims(data.evidence.records)}
${renderTimeline(data.evidence.records)}
${renderReviews(data.reviews)}
${renderProgressSection(data.progress)}
<footer>由 coding-x report 生成 · ${formatStamp(data.generatedAt)}</footer>
</main>
</body>
</html>`;
}
