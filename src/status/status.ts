import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { tryReadPrd, type Prd } from '../engine/prd.js';
import {
  tryReadState, mergedStories, getCurrentStoryId, initialStateFor, type StoryView,
} from '../engine/state.js';
import { readProgress } from '../engine/progress.js';

export type StatusReport =
  | { status: 'missing'; workspace: string }
  | { status: 'unparsable'; workspace: string }
  | {
      status: 'ok';
      prd: Prd;
      stories: StoryView[];
      currentStoryId: string | null;
      latestProgress: string | null;
      /** state.json 存在但解析失败/形状非法；缺失是正常回退，不算损坏 */
      stateCorrupted: boolean;
    };

// progress.md 是追加式日志，最后一个 `## ` 标题行即最近一次迭代记录
function latestProgressTitle(progress: string): string | null {
  const headings = progress.split('\n').filter((l) => l.startsWith('## '));
  const last = headings.at(-1);
  return last ? last.slice(3).trim() : null;
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
  return {
    status: 'ok',
    prd,
    stories: mergedStories(prd, state),
    currentStoryId: getCurrentStoryId(prd, state),
    latestProgress: latestProgressTitle(readProgress(join(workspace, 'progress.md'))),
    stateCorrupted: stateExists && rawState === null,
  };
}

function summarize(stories: StoryView[]): { total: number; passed: number; blocked: number } {
  return {
    total: stories.length,
    passed: stories.filter((s) => s.passes).length,
    blocked: stories.filter((s) => s.blocked).length,
  };
}

function markOf(s: StoryView): string {
  return s.passes ? '✅' : s.blocked ? '⛔' : '⬜';
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
  for (const s of stories) {
    const retry = s.retryCount > 0 ? `（已重试 ${s.retryCount} 次）` : '';
    lines.push(`  ${markOf(s)} ${s.id} ${s.title}${retry}`);
    for (const raw of s.notes.split('\n')) {
      const note = raw.trim();
      if (note === '') continue;
      lines.push(note.startsWith('[需求冲突]') ? `      🚨 ${note}` : `      · ${note}`);
    }
  }
  const current = stories.find((s) => s.id === report.currentStoryId);
  const extras: string[] = [];
  if (current) extras.push(`👉 当前 story：${current.id} ${current.title}`);
  if (report.latestProgress !== null) extras.push(`🕐 最近进展：${report.latestProgress}`);
  if (extras.length > 0) lines.push('', ...extras);
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
    ...(prd.sourcePrd !== undefined ? { sourcePrd: prd.sourcePrd } : {}),
    stories: stories.map((s) => ({
      id: s.id,
      title: s.title,
      priority: s.priority,
      passes: s.passes,
      notes: s.notes,
      retryCount: s.retryCount,
      blocked: s.blocked,
    })),
    summary,
  };
  return { text: JSON.stringify(view, null, 2), exitCode: summary.passed === summary.total ? 0 : 1 };
}
