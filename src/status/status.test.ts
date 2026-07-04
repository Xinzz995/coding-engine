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
});
