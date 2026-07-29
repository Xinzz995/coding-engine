import { execFileSync } from 'node:child_process';
import { describe, it, expect, afterEach } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectReport, parseScreenshotEntry, writeReport } from './report.js';
import { renderReportHtml } from './render.js';
import { appendEvidence } from '../engine/evidence.js';
import { acceptanceHash, readGitHead } from '../engine/validation-protocol.js';
import { isStoryPassed, type StoryState } from '../engine/state.js';
import type { Prd, Story } from '../engine/prd.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
});

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'report-ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const story = (id: string) => ({
  id,
  title: `t-${id}`,
  description: 'd',
  acceptanceCriteria: [`ac of ${id}`],
  priority: 1,
});

function currentHead(): string {
  const head = readGitHead(process.cwd());
  if (head === null) throw new Error('report tests require a Git HEAD');
  return head;
}

function passedState(item: Pick<Story, 'id' | 'acceptanceCriteria'>): StoryState {
  return {
    passes: true,
    validated: true,
    validationReceipt: {
      schemaVersion: 1,
      requestId: `request-${item.id}`,
      gitHead: currentHead(),
      acceptanceHash: acceptanceHash(item.id, item.acceptanceCriteria),
    },
    notes: '',
    retryCount: 0,
    blocked: false,
    escalated: false,
  };
}

function writePrd(dir: string, stories: unknown[], extra: Record<string, unknown> = {}): void {
  writeFileSync(
    join(dir, 'prd.json'),
    JSON.stringify({
      project: 'proj',
      branchName: 'ralph/x',
      description: 'd',
      userStories: stories,
      ...extra,
    }),
  );
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

  it.each([
    ['空 Story 集合', []],
    ['重复 Story ID', [story('US-001'), { ...story('US-002'), id: ' US-001 ' }]],
    ['空验收标准', [{ ...story('US-001'), acceptanceCriteria: [] }]],
    ['空白验收标准', [{ ...story('US-001'), acceptanceCriteria: ['  '] }]],
  ])('%s 返回 unparsable，不生成绿色报告', (_name, stories) => {
    const dir = ws();
    writePrd(dir, stories);
    expect(collectReport(dir, new Date())).toEqual({ status: 'unparsable', workspace: dir });
  });

  it('调用方提供引擎快照时不再读取磁盘 prd.json', () => {
    const dir = ws(); // 故意不创建 prd.json：模拟 guard 最终恢复失败
    const trustedPrd = {
      project: 'trusted',
      branchName: 'ralph/trusted',
      description: 'd',
      userStories: [story('US-TRUSTED')],
    };
    const src = collectReport(dir, new Date(), { trustedPrd });
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.prd).toBe(trustedPrd);
    expect(src.data.prdSource).toBe('engine-snapshot');
    expect(src.data.stories.map((s) => s.id)).toEqual(['US-TRUSTED']);
  });
});

describe('collectReport ok 收集', () => {
  it('全量素材各就各位：state 合并、review 名序、tampered 名序、截图归属', () => {
    const dir = ws();
    writePrd(dir, [story('US-001'), story('US-002')]);
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '[需求冲突] x', retryCount: 2, blocked: true },
      }),
    );
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
    expect(d.prdSource).toBe('disk');
    expect(d.stories.map((s) => [s.id, s.passes, s.blocked])).toEqual([
      ['US-001', true, false],
      ['US-002', false, true],
    ]);
    expect(d.stateCorrupted).toBe(false);
    expect(d.progress).toContain('学到了');
    expect(d.reviews.map((r) => r.filename)).toEqual([
      'review-2026-07-08-2.md',
      'review-2026-07-08.md',
    ]);
    expect(d.reviews[1].content).toBe('first');
    expect(d.tamperedArchives).toEqual(['prd.tampered-20260708-010101.json']);
    expect(d.screenshots).toEqual([
      { filename: 'builder-US-001-1.png', storyId: 'US-001', phase: 'builder', isImage: true },
      {
        filename: 'validator-us-002-pass-1.png',
        storyId: 'US-002',
        phase: 'validator',
        isImage: true,
      },
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

  it.skipIf(process.platform === 'win32')(
    'FIFO、超限 review 与软链 screenshots 不会阻塞最终报告',
    () => {
      const dir = ws();
      writePrd(dir, [story('US-001')]);
      execFileSync('mkfifo', [join(dir, 'progress.md')]);
      execFileSync('mkfifo', [join(dir, 'evidence.jsonl')]);
      writeFileSync(join(dir, 'review-oversized.md'), 'x'.repeat(4 * 1024 * 1024 + 1));
      const outside = join(dir, 'outside-screenshots');
      mkdirSync(outside);
      writeFileSync(join(outside, 'builder-US-001-1.png'), 'outside');
      symlinkSync(outside, join(dir, 'screenshots'), 'dir');

      const started = Date.now();
      const src = collectReport(dir, new Date());
      expect(Date.now() - started).toBeLessThan(2_000);
      if (src.status !== 'ok') throw new Error('expected ok');
      expect(src.data.progress).toBe('');
      expect(src.data.reviews).toEqual([]);
      expect(src.data.screenshots).toEqual([]);
      expect(src.data.evidence).toEqual({ records: [], skippedLines: 1 });
    },
  );

  it('stops collecting report material when one workspace directory has too many entries', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    const screenshots = join(dir, 'screenshots');
    mkdirSync(screenshots);
    for (let index = 0; index < 4_097; index += 1) {
      writeFileSync(join(screenshots, `builder-US-001-${index}.png`), '');
    }
    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.screenshots).toEqual([]);
  }, 15_000);

  it('state.json 损坏时 fail-closed，不复活 prd 内嵌 legacy 通过态', () => {
    const dir = ws();
    writePrd(dir, [
      { ...story('US-001'), passes: true, notes: 'legacy', retryCount: 4, blocked: false },
    ]);
    writeFileSync(join(dir, 'state.json'), '{ broken');
    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.stateCorrupted).toBe(true);
    expect(src.data.stories[0]).toMatchObject({
      passes: false,
      validated: false,
      validationReceipt: null,
      notes: '',
      retryCount: 0,
      blocked: false,
      escalated: false,
    });
  });

  it('只有绑定当前 HEAD 与有序 AC 的结构化凭证显示为通过', () => {
    const dir = ws();
    const current = story('US-001');
    const legacy = story('US-002');
    writePrd(dir, [current, legacy]);
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        'US-001': passedState(current),
        'US-002': {
          passes: true,
          validated: true,
          notes: '旧布尔绿灯',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );

    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(isStoryPassed(src.data.stories[0])).toBe(true);
    expect(src.data.stories[0].validationReceipt).toEqual(passedState(current).validationReceipt);
    expect(src.data.stories[1]).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
    expect(isStoryPassed(src.data.stories[1])).toBe(false);
    expect(src.data.storyValidationDigest).toBeNull();
  });

  it('所有现代凭证都为当前状态时生成非空 Story 凭证摘要', () => {
    const dir = ws();
    const stories = [story('US-001'), story('US-002')];
    writePrd(dir, stories);
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify(Object.fromEntries(stories.map((item) => [item.id, passedState(item)]))),
    );

    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.stories.every(isStoryPassed)).toBe(true);
    expect(src.data.storyValidationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
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

  it('远程查询期间 Story 变为 blocked 时，报告使用最终快照并使旧 Review 失效', () => {
    const dir = ws();
    const current = story('US-001');
    writePrd(dir, [current]);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'US-001': passedState(current) }));

    const src = collectReport(dir, new Date(), {
      reviewCollector: () => {
        writeFileSync(
          join(dir, 'state.json'),
          JSON.stringify({ 'US-001': { ...passedState(current), blocked: true } }),
        );
        return { read: { status: 'missing' }, current: true, staleReasons: [] };
      },
    });
    if (src.status !== 'ok') throw new Error('expected ok');

    expect(src.data.stories[0]).toMatchObject({ blocked: true, validated: false });
    // blocked 会使展示凭证失效，但 blocked 状态本身仍进入摘要；交付继续被 Story 与 Review 双重阻断。
    expect(src.data.storyValidationDigest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(src.data.finalReview.current).toBe(false);
    expect(src.data.finalReview.staleReasons).toContain(
      '报告收集期间 Story 状态已变化；已使用最终快照',
    );
    const html = renderReportHtml(src.data);
    expect(html).toContain('0 通过 · 1 blocked');
    expect(html).not.toContain('Story 验证完成 1/1');
  });

  it('远程查询期间 Story 变为待验收时，报告不复用旧的通过结果', () => {
    const dir = ws();
    const current = story('US-001');
    writePrd(dir, [current]);
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'US-001': passedState(current) }));

    const src = collectReport(dir, new Date(), {
      reviewCollector: () => {
        writeFileSync(
          join(dir, 'state.json'),
          JSON.stringify({
            'US-001': {
              ...passedState(current),
              validated: false,
              validationReceipt: null,
            },
          }),
        );
        return { read: { status: 'missing' }, current: true, staleReasons: [] };
      },
    });
    if (src.status !== 'ok') throw new Error('expected ok');

    expect(src.data.stories[0]).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
      blocked: false,
    });
    expect(src.data.storyValidationDigest).toBeNull();
    expect(src.data.finalReview.current).toBe(false);
    const html = renderReportHtml(src.data);
    expect(html).toContain('实现候选待验收');
    expect(html).toContain('进行中：0/1 通过');
    expect(html).not.toContain('Story 验证完成 1/1');
  });

  it('引擎快照模式始终使用冻结 PRD，但使用最终 Story 状态', () => {
    const dir = ws();
    const trustedStory = story('US-TRUSTED');
    const trustedPrd: Prd = {
      project: 'trusted',
      branchName: 'ralph/trusted',
      description: 'd',
      userStories: [trustedStory],
    };
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ 'US-TRUSTED': passedState(trustedStory) }),
    );

    const src = collectReport(dir, new Date(), {
      trustedPrd,
      reviewCollector: () => {
        writeFileSync(join(dir, 'prd.json'), '{ broken disk prd');
        writeFileSync(
          join(dir, 'state.json'),
          JSON.stringify({
            'US-TRUSTED': {
              ...passedState(trustedStory),
              validated: false,
              validationReceipt: null,
            },
          }),
        );
        return { read: { status: 'missing' }, current: true, staleReasons: [] };
      },
    });
    if (src.status !== 'ok') throw new Error('expected ok');

    expect(src.data.prd).toBe(trustedPrd);
    expect(src.data.prdSource).toBe('engine-snapshot');
    expect(src.data.stories).toHaveLength(1);
    expect(src.data.stories[0]).toMatchObject({ id: 'US-TRUSTED', validated: false });
    expect(src.data.finalReview.staleReasons).toContain(
      '报告收集期间 Story 状态已变化；已使用最终快照',
    );
    expect(src.data.finalReview.staleReasons.some((reason) => reason.includes('PRD 已变化'))).toBe(
      false,
    );
  });

  it('手动报告使用 Review 收集结束时的最终磁盘 PRD', () => {
    const dir = ws();
    writePrd(dir, [story('US-OLD')]);
    const finalPrd = {
      project: 'final-project',
      branchName: 'ralph/final',
      description: 'final',
      userStories: [story('US-FINAL')],
    };

    const src = collectReport(dir, new Date(), {
      reviewCollector: () => {
        writeFileSync(join(dir, 'prd.json'), JSON.stringify(finalPrd));
        return { read: { status: 'missing' }, current: true, staleReasons: [] };
      },
    });
    if (src.status !== 'ok') throw new Error('expected ok');

    expect(src.data.prd.project).toBe('final-project');
    expect(src.data.stories.map((item) => item.id)).toEqual(['US-FINAL']);
    expect(src.data.finalReview.current).toBe(false);
    expect(src.data.finalReview.staleReasons).toContain('报告收集期间 PRD 已变化；已使用最终快照');
  });

  it('远程查询后的最终磁盘 PRD 损坏时返回 unparsable', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);

    const src = collectReport(dir, new Date(), {
      reviewCollector: () => {
        writeFileSync(join(dir, 'prd.json'), '{ broken');
        return { read: { status: 'missing' }, current: false, staleReasons: [] };
      },
    });

    expect(src).toEqual({ status: 'unparsable', workspace: dir });
  });

  it('Review 收集期间最终 Review 文件变化时，旧结果失效', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);

    const src = collectReport(dir, new Date(), {
      reviewCollector: () => {
        writeFileSync(join(dir, 'final-review.json'), '{}');
        return { read: { status: 'missing' }, current: true, staleReasons: [] };
      },
    });
    if (src.status !== 'ok') throw new Error('expected ok');

    expect(src.data.finalReview.current).toBe(false);
    expect(src.data.finalReview.staleReasons).toContain('报告收集期间本地最终 Review 状态已变化');
  });

  it('Review 收集期间裁决记录变化时，旧结果失效', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);

    const src = collectReport(dir, new Date(), {
      reviewCollector: () => {
        writeFileSync(
          join(dir, 'review-decisions.json'),
          JSON.stringify({ schemaVersion: 1, decisions: [] }),
        );
        return { read: { status: 'missing' }, current: true, staleReasons: [] };
      },
    });
    if (src.status !== 'ok') throw new Error('expected ok');

    expect(src.data.finalReview.current).toBe(false);
    expect(src.data.finalReview.staleReasons).toContain('报告收集期间 Review 裁决记录已变化');
  });
});

describe('parseScreenshotEntry 归属解析', () => {
  const ids = ['US-001', 'US-008', 'US-1', 'US-10'];
  it('builder 序号命名归属', () => {
    expect(parseScreenshotEntry('builder-US-008-6.png', ids)).toEqual({
      filename: 'builder-US-008-6.png',
      storyId: 'US-008',
      phase: 'builder',
      isImage: true,
    });
  });
  it('validator pass 命名归属（story id 段大小写不敏感）', () => {
    expect(parseScreenshotEntry('validator-us-008-pass-1.png', ids)).toEqual({
      filename: 'validator-us-008-pass-1.png',
      storyId: 'US-008',
      phase: 'validator',
      isImage: true,
    });
  });
  it('语义尾缀 + 非图片扩展：归属成功且 isImage=false', () => {
    expect(parseScreenshotEntry('validator-us-008-export.pdf', ids)).toEqual({
      filename: 'validator-us-008-export.pdf',
      storyId: 'US-008',
      phase: 'validator',
      isImage: false,
    });
  });
  it('前缀重叠 id 取最长命中：US-10 不被 US-1 抢走', () => {
    expect(parseScreenshotEntry('builder-us-10-3.png', ids).storyId).toBe('US-10');
    expect(parseScreenshotEntry('builder-us-1-3.png', ids).storyId).toBe('US-1');
  });
  it('tie-break 真双命中：两个 id 都实际匹配同一文件名时取最长，且与遍历顺序无关', () => {
    const overlapIds = ['US-1', 'US-1-EXTRA'];
    expect(parseScreenshotEntry('builder-us-1-extra-2.png', overlapIds).storyId).toBe('US-1-EXTRA');
    expect(
      parseScreenshotEntry('builder-us-1-extra-2.png', [...overlapIds].reverse()).storyId,
    ).toBe('US-1-EXTRA');
  });
  it('无相位前缀或匹配不到任何 story 落未归类', () => {
    expect(parseScreenshotEntry('random.png', ids)).toEqual({
      filename: 'random.png',
      storyId: null,
      phase: null,
      isImage: true,
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
    expect(result).toEqual({
      status: 'written',
      path: join(dir, 'report.html'),
      stateCorrupted: false,
    });
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

  it('state 损坏仍原子写出保守诊断报告，并在结果中暴露不可信状态', () => {
    const dir = ws();
    writePrd(dir, [{ ...story('US-001'), passes: true }]);
    writeFileSync(join(dir, 'state.json'), '{ broken');
    const result = writeReport(dir, new Date('2026-07-08T12:00:00'));
    expect(result).toEqual({
      status: 'written',
      path: join(dir, 'report.html'),
      stateCorrupted: true,
    });
    const html = readFileSync(join(dir, 'report.html'), 'utf-8');
    expect(html).toContain('状态不可验证');
    expect(html).not.toContain('全部通过');
  });

  it('旧版内嵌 passes 没有结构化凭证时报告保持待重验', () => {
    const dir = ws();
    writePrd(dir, [
      {
        ...story('US-001'),
        passes: true,
        validated: true,
        notes: '旧结论',
        retryCount: 0,
        blocked: false,
      },
    ]);
    const result = writeReport(dir, new Date('2026-07-08T12:00:00'));
    expect(result.status).toBe('written');
    const html = readFileSync(join(dir, 'report.html'), 'utf-8');
    expect(html).toContain('实现候选待验收');
    expect(html).toContain('进行中：0/1 通过');
    expect(html).not.toContain('Story 验证完成 1/1');
  });

  it('原子写失败时保留上一份完整 report.html', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    const reportPath = join(dir, 'report.html');
    writeFileSync(reportPath, 'trusted-old-report');
    // writeFileAtomicSync 的已知 tmp 命名；目录占位让临时写失败，目标文件不应先被截断。
    mkdirSync(`${reportPath}.tmp-${process.pid}`);
    expect(() => writeReport(dir, new Date())).toThrow();
    expect(readFileSync(reportPath, 'utf-8')).toBe('trusted-old-report');
  });
});

describe('collectReport evidence 收集', () => {
  it('读入 evidence.jsonl 记录与跳过计数；缺失时为空', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    const empty = collectReport(dir, new Date());
    if (empty.status !== 'ok') throw new Error('expected ok');
    expect(empty.data.evidence).toEqual({ records: [], skippedLines: 0 });

    appendEvidence(dir, {
      type: 'gate-run',
      source: 'engine',
      at: '2026-07-08T06:00:00.000Z',
      iteration: 1,
      storyId: 'US-001',
      ok: true,
      total: 1,
      ran: 1,
      ms: 100,
    });
    writeFileSync(
      join(dir, 'evidence.jsonl'),
      readFileSync(join(dir, 'evidence.jsonl'), 'utf-8') + '{ bad\n',
    );
    const src = collectReport(dir, new Date());
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.evidence.records).toHaveLength(1);
    expect(src.data.evidence.skippedLines).toBe(1);
  });
});
