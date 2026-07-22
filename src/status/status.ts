import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tryReadPrd, type Prd } from '../engine/prd.js';
import {
  tryReadState, mergedStories, getCurrentStoryId, initialStateFor, type StoryView,
  isStoryPassed,
} from '../engine/state.js';
import { readProgress } from '../engine/progress.js';
import { isArbitrationLine } from '../engine/gate.js';
import { readEvidence, type EvidenceRecord } from '../engine/evidence.js';
import { readModelRouting, type ModelRouteSource, type ModelRoutingReadResult } from '../engine/models.js';

export interface RecentModelRoute {
  model: string | null;
  source: ModelRouteSource | null;
  iteration: number;
}

export interface StoryRecentActual {
  builder?: RecentModelRoute;
  validator?: RecentModelRoute;
}

export type StatusReport =
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string }
  | {
      status: 'ok';
      prd: Prd;
      stories: StoryView[];
      currentStoryId: string | null;
      latestProgress: string | null;
      modelRouting: ModelRoutingReadResult;
      recentActual: Record<string, StoryRecentActual>;
      evidenceSkippedLines: number;
      evidenceUnavailable: boolean;
      /** state.json 存在但解析失败/形状非法；缺失是正常回退，不算损坏 */
      stateCorrupted: boolean;
    };

// progress.md 是追加式日志，迭代记录标题固定以日期开头（`## yyyy-mm-dd HH:mm - Story ID`），
// 按日期前缀匹配以排除 `## Codebase Patterns` 等非记录标题；最后一条即最近一次迭代
function latestProgressTitle(progress: string): string | null {
  const records = progress.split('\n').filter((l) => /^## \d{4}-\d{2}-\d{2}/.test(l));
  const last = records.at(-1);
  return last ? last.slice(3).trim() : null;
}

function recentActualOf(records: EvidenceRecord[]): Record<string, StoryRecentActual> {
  const recent: Record<string, StoryRecentActual> = {};
  for (const record of records) {
    if (record.type !== 'iteration' || record.storyId === null) continue;
    const current = recent[record.storyId] ?? {};
    if (record.builderRan) {
      current.builder = {
        model: record.builderModel,
        source: record.builderRouteSource ?? null,
        iteration: record.iteration,
      };
    }
    if (record.validatorRan) {
      current.validator = {
        model: record.validatorModel,
        source: record.validatorRouteSource ?? null,
        iteration: record.iteration,
      };
    }
    recent[record.storyId] = current;
  }
  return recent;
}

/** 只读收集 workspace 执行状态；state.json 缺失或损坏时回退读 story 上的旧格式内嵌字段。 */
export function collectStatus(workspace: string): StatusReport {
  const prdPath = join(workspace, 'prd.json');
  if (!existsSync(prdPath)) return { status: 'missing', workspace };
  const prd = tryReadPrd(prdPath);
  // userStories 非数组的 prd.json 对 status 同样不可用，与 JSON 解析失败同等对待
  if (prd === null || !Array.isArray(prd.userStories)) return { status: 'unparsable', workspace };
  const statePath = join(workspace, 'state.json');
  const stateExists = existsSync(statePath);
  // 缺失与损坏都回退读 story 上的旧格式内嵌字段（与 dashboard 离线回看语义一致）；损坏需另行标记供 cli 层警告
  const rawState = stateExists ? tryReadState(statePath) : null;
  const state = rawState ?? initialStateFor(prd);
  let evidence: ReturnType<typeof readEvidence> = { records: [], skippedLines: 0 };
  let evidenceUnavailable = false;
  try {
    evidence = readEvidence(workspace);
  } catch {
    evidenceUnavailable = true;
  }
  return {
    status: 'ok',
    prd,
    stories: mergedStories(prd, state),
    currentStoryId: getCurrentStoryId(prd, state),
    latestProgress: latestProgressTitle(readProgress(join(workspace, 'progress.md'))),
    modelRouting: readModelRouting(prd),
    recentActual: recentActualOf(evidence.records),
    evidenceSkippedLines: evidence.skippedLines,
    evidenceUnavailable,
    stateCorrupted: stateExists && rawState === null,
  };
}

function summarize(stories: StoryView[]): { total: number; passed: number; blocked: number } {
  return {
    total: stories.length,
    passed: stories.filter(isStoryPassed).length,
    blocked: stories.filter((s) => s.blocked).length,
  };
}

function markOf(s: StoryView): string {
  return isStoryPassed(s) ? '✅' : s.blocked ? '⛔' : s.passes ? '🟨' : '⬜';
}

export function renderStatusReport(report: StatusReport): { text: string; exitCode: number } {
  if (report.status === 'missing') {
    return {
      text: `❌ 未找到工作区：${join(report.workspace, 'prd.json')} 不存在。建议先用 prd-to-json 从源 PRD 生成工作区。`,
      exitCode: 2,
    };
  }
  if (report.status === 'unparsable') {
    return {
      text: `❌ 无法解析 ${join(report.workspace, 'prd.json')}。建议运行 npx coding-x repair 修复后重试。`,
      exitCode: 2,
    };
  }
  const { prd, stories } = report;
  const { total, passed, blocked } = summarize(stories);
  const lines: string[] = [
    `📋 ${prd.project}（分支 ${prd.branchName}）`,
    `   story 通过 ${passed}/${total}${blocked > 0 ? `，阻塞 ${blocked}` : ''}`,
    '',
  ];
  if (report.modelRouting.status === 'enabled') {
    const m = report.modelRouting.config;
    lines.push(
      `🧭 模型路由（${m.runner}）`,
      `   builder low=${m.builder.low} · medium=${m.builder.medium} · high=${m.builder.high}`,
      `   validator=${m.validator} · escalation=${m.escalation}`,
      '',
    );
  } else if (report.modelRouting.status === 'invalid') {
    lines.push('⚠️  模型路由配置无效：', ...report.modelRouting.errors.map((e) => `   · ${e}`), '');
  } else {
    lines.push('🧭 PRD 模型路由：未启用', '');
  }
  for (const s of stories) {
    const retry = s.retryCount > 0 ? `（已重试 ${s.retryCount} 次）` : '';
    const difficulty = s.difficulty ? ` [${s.difficulty}]` : '';
    const escalated = s.escalated ? ' ⬆️ 已升级' : '';
    const validation = !s.blocked && s.passes && !s.validated ? ' ⏳ 待引擎验收' : '';
    lines.push(`  ${markOf(s)} ${s.id} ${s.title}${difficulty}${escalated}${validation}${retry}`);
    if (s.difficultyReason) lines.push(`      · 难度依据：${s.difficultyReason}`);
    const actual = report.recentActual[s.id];
    if (actual?.builder || actual?.validator) {
      const route = (side: RecentModelRoute | undefined) => side
        ? `${side.model ?? '默认'} [${side.source ?? '来源未知'}]@第${side.iteration}轮`
        : '无';
      lines.push(`      · 最近实际：builder=${route(actual.builder)} · validator=${route(actual.validator)}`);
    }
    for (const raw of s.notes.split('\n')) {
      const note = raw.trim();
      if (note === '') continue;
      lines.push(isArbitrationLine(note) ? `      🚨 ${note}` : `      · ${note}`);
    }
  }
  const current = stories.find((s) => s.id === report.currentStoryId);
  const extras: string[] = [];
  if (current) extras.push(`👉 当前 story：${current.id} ${current.title}`);
  if (report.latestProgress !== null) extras.push(`🕐 最近进展：${report.latestProgress}`);
  if (extras.length > 0) lines.push('', ...extras);
  if (report.evidenceSkippedLines > 0) {
    lines.push(`⚠️ evidence.jsonl 有 ${report.evidenceSkippedLines} 行无法解析已跳过`);
  }
  if (report.evidenceUnavailable) lines.push('⚠️ evidence.jsonl 当前不可读，最近实际路由可能不完整');
  // 空 story 列表不算全绿：status 的退出码用作 CI 门禁，对退化的 prd.json 必须保守
  if (total === 0) {
    lines.push('', '⚠️ prd.json 中没有任何 story');
    return { text: lines.join('\n'), exitCode: 1 };
  }
  const allPassed = passed === total;
  lines.push('', allPassed ? '✅ 全部 story 已通过' : `⏳ 还有 ${total - passed} 个 story 未完成`);
  return { text: lines.join('\n'), exitCode: allPassed ? 0 : 1 };
}

/**
 * --json 机器可读输出：text 恒为单个可 JSON.parse 的对象（错误态输出 { error, workspace }），
 * 退出码语义与人类可读模式一致（0 全通过 / 1 未全通过 / 2 无可读工作区）。
 * 损坏警告不在此处——它走 stderr，由 cli 层负责，保证 stdout 纯净。
 */
export function renderStatusJson(report: StatusReport): { text: string; exitCode: number } {
  if (report.status !== 'ok') {
    return {
      text: JSON.stringify({ error: report.status, workspace: report.workspace }, null, 2),
      exitCode: 2,
    };
  }
  const { prd, stories } = report;
  const summary = summarize(stories);
  const view = {
    project: prd.project,
    branchName: prd.branchName,
    sourcePrd: prd.sourcePrd, // undefined 时 JSON.stringify 自动省略该键
    stories: stories.map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      passes: s.passes,
      validated: s.validated,
      notes: s.notes,
      retryCount: s.retryCount,
      blocked: s.blocked,
      escalated: s.escalated,
      ...(s.difficulty ? { difficulty: s.difficulty, difficultyReason: s.difficultyReason } : {}),
    })),
    modelRouting: report.modelRouting,
    recentActual: report.recentActual,
    evidence: {
      skippedLines: report.evidenceSkippedLines,
      unavailable: report.evidenceUnavailable,
    },
    summary,
  };
  // 与人类可读模式同一保守语义：空 story 列表不算全绿
  const allPassed = summary.total > 0 && summary.passed === summary.total;
  return { text: JSON.stringify(view, null, 2), exitCode: allPassed ? 0 : 1 };
}
