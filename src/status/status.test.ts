import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStatus, renderStatusReport } from './status.js';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'status-ws-'));
}

const story = (id: string, title: string, priority: number) => ({
  id, title, description: 'd', acceptanceCriteria: ['ac'], priority,
});

const PRD = {
  project: 'demo-proj',
  branchName: 'ralph/demo',
  description: 'd',
  userStories: [story('US-001', '第一个故事', 1), story('US-002', '第二个故事', 2), story('US-003', '第三个故事', 3)],
};

describe('collectStatus', () => {
  it('reports missing when the workspace directory does not exist', () => {
    const report = collectStatus(join(tmpdir(), 'status-no-such-dir-xyz'));
    expect(report.status).toBe('missing');
  });

  it('reports missing when prd.json is absent in an existing workspace', () => {
    const ws = makeWorkspace();
    try {
      expect(collectStatus(ws).status).toBe('missing');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reports unparsable for broken JSON', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), '{ not json');
      expect(collectStatus(ws).status).toBe('unparsable');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reports unparsable when userStories is not an array', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ project: 'p', userStories: 'oops' }));
      expect(collectStatus(ws).status).toBe('unparsable');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('merges state.json onto stories when both files are valid', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '', retryCount: 2, blocked: false },
        'US-003': { passes: false, notes: '', retryCount: 1, blocked: true },
      }));
      const report = collectStatus(ws);
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
      expect(report.prd.project).toBe('demo-proj');
      expect(report.stories.map((s) => s.passes)).toEqual([true, false, false]);
      expect(report.stories[1].retryCount).toBe(2);
      expect(report.stories[2].blocked).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('renderStatusReport', () => {
  it('suggests prd-to-json and exits 2 for a missing workspace', () => {
    const { text, exitCode } = renderStatusReport({ status: 'missing', workspace: '.workspace' });
    expect(text).toContain('prd-to-json');
    expect(text).toContain(join('.workspace', 'prd.json'));
    expect(exitCode).toBe(2);
  });

  it('suggests coding-x repair and exits 2 for an unparsable prd.json', () => {
    const { text, exitCode } = renderStatusReport({ status: 'unparsable', workspace: '.workspace' });
    expect(text).toContain('coding-x repair');
    expect(exitCode).toBe(2);
  });

  it('prints overview (project, branch, passed/total), all-green message and exits 0 when every story passes', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify(Object.fromEntries(
        PRD.userStories.map((s) => [s.id, { passes: true, notes: '', retryCount: 0, blocked: false }]),
      )));
      const { text, exitCode } = renderStatusReport(collectStatus(ws));
      expect(text).toContain('demo-proj');
      expect(text).toContain('ralph/demo');
      expect(text).toContain('3/3');
      expect(text).toContain('全部 story 已通过');
      expect(exitCode).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('renders distinct leading marks for passed / pending / blocked, shows retry count, and exits 1', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '', retryCount: 2, blocked: false },
        'US-003': { passes: false, notes: '', retryCount: 0, blocked: true },
      }));
      const { text, exitCode } = renderStatusReport(collectStatus(ws));
      const lineOf = (id: string) => {
        const line = text.split('\n').find((l) => l.includes(id));
        if (!line) throw new Error(`no line for ${id}`);
        return line;
      };
      const markOf = (id: string) => lineOf(id).trimStart().split(' ')[0];
      expect(lineOf('US-001')).toContain('第一个故事');
      const marks = ['US-001', 'US-002', 'US-003'].map(markOf);
      expect(new Set(marks).size).toBe(3); // 三种状态行首标记互不相同
      expect(lineOf('US-002')).toContain('2'); // retryCount > 0 行内显示重试次数
      expect(lineOf('US-002')).toContain('重试');
      expect(lineOf('US-001')).not.toContain('重试'); // retryCount 为 0 不显示
      expect(lineOf('US-003')).not.toContain('重试');
      expect(exitCode).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('exits 1 when a story is blocked even if the rest pass', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-003': { passes: false, notes: '', retryCount: 3, blocked: true },
      }));
      const { exitCode } = renderStatusReport(collectStatus(ws));
      expect(exitCode).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('falls back to initial story state when state.json is absent', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      const { text, exitCode } = renderStatusReport(collectStatus(ws));
      expect(text).toContain('0/3');
      expect(exitCode).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('indents non-empty notes line by line under their story; empty notes add no lines', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '第一行失败记录\n第二行详情', retryCount: 1, blocked: false },
        'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
      }));
      const { text } = renderStatusReport(collectStatus(ws));
      const lines = text.split('\n');
      const idx1 = lines.findIndex((l) => l.includes('US-001'));
      expect(lines[idx1 + 1]).toContain('US-002'); // notes 为空的 story 后面不插入 notes 行
      const idx2 = lines.findIndex((l) => l.includes('US-002'));
      expect(lines[idx2 + 1]).toMatch(/^\s+/); // 缩进
      expect(lines[idx2 + 1]).toContain('第一行失败记录');
      expect(lines[idx2 + 2]).toMatch(/^\s+/);
      expect(lines[idx2 + 2]).toContain('第二行详情');
      expect(lines[idx2 + 3]).toContain('US-003'); // notes 行随 story 结束
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('marks [需求冲突] note lines with a warning distinct from ordinary note lines', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': {
          passes: false,
          notes: '普通失败说明\n[需求冲突] 2026-07-04 10:00 源文档说 X，acceptanceCriteria 说 Y，已按 Y 实现',
          retryCount: 0,
          blocked: false,
        },
        'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
      }));
      const { text } = renderStatusReport(collectStatus(ws));
      const lines = text.split('\n');
      const ordinary = lines.find((l) => l.includes('普通失败说明'));
      const conflict = lines.find((l) => l.includes('[需求冲突]'));
      expect(ordinary).toBeDefined();
      expect(conflict).toBeDefined();
      expect(conflict).toContain('🚨');
      expect(ordinary).not.toContain('🚨');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('points the current-story hint at the highest-priority pending unblocked story', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '', retryCount: 0, blocked: false },
        'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
      }));
      const { text } = renderStatusReport(collectStatus(ws));
      const hint = text.split('\n').find((l) => l.includes('当前 story'));
      expect(hint).toBeDefined();
      expect(hint).toContain('US-002');
      expect(hint).toContain('第二个故事');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('skips a blocked story when picking the current story, matching engine semantics', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '', retryCount: 0, blocked: true },
        'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
      }));
      const { text } = renderStatusReport(collectStatus(ws));
      const hint = text.split('\n').find((l) => l.includes('当前 story'));
      expect(hint).toContain('US-003');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('omits the current-story hint when no story is both pending and unblocked', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-003': { passes: false, notes: '', retryCount: 0, blocked: true },
      }));
      const { text } = renderStatusReport(collectStatus(ws));
      expect(text).not.toContain('当前 story');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('shows the blocked count in the summary when nonzero', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '', retryCount: 0, blocked: true },
        'US-003': { passes: false, notes: '', retryCount: 0, blocked: true },
      }));
      const { text } = renderStatusReport(collectStatus(ws));
      const summary = text.split('\n').find((l) => l.includes('story 通过'));
      expect(summary).toContain('阻塞 2');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('omits the blocked count from the summary when zero', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '', retryCount: 0, blocked: false },
        'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
      }));
      const { text } = renderStatusReport(collectStatus(ws));
      const summary = text.split('\n').find((l) => l.includes('story 通过'));
      expect(summary).not.toContain('阻塞');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('shows the latest ## heading of progress.md as recent progress', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'progress.md'), [
        '# Progress',
        '',
        '## Codebase Patterns',
        '- 某个 pattern',
        '',
        '## 2026-07-04 10:00 - US-001',
        '- 做了 A',
        '---',
        '## 2026-07-04 12:30 - US-002',
        '- 做了 B',
        '---',
      ].join('\n'));
      const { text } = renderStatusReport(collectStatus(ws));
      const line = text.split('\n').find((l) => l.includes('最近进展'));
      expect(line).toBeDefined();
      expect(line).toContain('2026-07-04 12:30 - US-002');
      expect(text).not.toContain('10:00'); // 只显示最后一条
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('omits the recent-progress line when progress.md is missing or has no ## records', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      // 文件缺失
      expect(renderStatusReport(collectStatus(ws)).text).not.toContain('最近进展');
      // 文件存在但没有 ## 开头的记录
      writeFileSync(join(ws, 'progress.md'), '# Progress\n\n还没有迭代记录\n');
      expect(renderStatusReport(collectStatus(ws)).text).not.toContain('最近进展');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
