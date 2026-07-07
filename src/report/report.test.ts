import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectReport, parseScreenshotEntry, writeReport } from './report.js';

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
  it('tie-break 真双命中：两个 id 都实际匹配同一文件名时取最长，且与遍历顺序无关', () => {
    const overlapIds = ['US-1', 'US-1-EXTRA'];
    expect(parseScreenshotEntry('builder-us-1-extra-2.png', overlapIds).storyId).toBe('US-1-EXTRA');
    expect(parseScreenshotEntry('builder-us-1-extra-2.png', [...overlapIds].reverse()).storyId).toBe('US-1-EXTRA');
  });
  it('无相位前缀或匹配不到任何 story 落未归类', () => {
    expect(parseScreenshotEntry('random.png', ids)).toEqual({
      filename: 'random.png', storyId: null, phase: null, isImage: true,
    });
    expect(parseScreenshotEntry('builder-US-999-1.png', ids).storyId).toBe(null);
    expect(parseScreenshotEntry('builder-US-999-1.png', ids).phase).toBe('builder');
  });
});

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
    expect(existsSync(join(dir, 'report.html'))).toBe(false);
    writeFileSync(join(dir, 'prd.json'), '{ broken');
    expect(writeReport(dir, new Date()).status).toBe('unparsable');
    expect(existsSync(join(dir, 'report.html'))).toBe(false);
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
