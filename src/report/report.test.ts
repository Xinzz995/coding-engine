import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectReport, parseScreenshotEntry, writeReport } from './report.js';
import { appendEvidence } from '../engine/evidence.js';
import { previousFinalReview } from '../engine/loop-test-support.js';
import { acceptanceHash } from '../engine/validation-protocol.js';
import { tryReadPrd } from '../engine/prd.js';
import {
  evaluateStoryValidationDisplay,
  evaluateStoryValidationReceiptSet,
  tryReadState,
} from '../engine/state.js';
import type { StoryValidationObservation } from '../review/story-validation-observation.js';

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

const TEST_STORY_ENVIRONMENT = `sha256:${'1'.repeat(64)}`;
const STORY_BASE_HEAD = 'e'.repeat(40);
const CHANGE_MANIFEST_DIGEST = `sha256:${'f'.repeat(64)}`;

function observedStoryValidation(
  workspace: string,
  headSha: string,
  environmentDigest = TEST_STORY_ENVIRONMENT,
): StoryValidationObservation {
  const prd = tryReadPrd(join(workspace, 'prd.json'));
  const state = tryReadState(join(workspace, 'state.json'));
  if (!prd || !state) throw new Error('expected observable Story fixture');
  const display = evaluateStoryValidationDisplay(prd, state, headSha, environmentDigest);
  return {
    status: 'ready',
    workspacePath: workspace,
    observationToken: `sha256:${'2'.repeat(64)}`,
    headSha,
    prd,
    state: display.state,
    display,
    storyValidationEnvironmentDigest: environmentDigest,
    storyValidationDigest: display.digest,
  } as unknown as StoryValidationObservation;
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
  it('没有可信当前性观察时不把保存的 Review 当作当前结果，且拒绝观察后的状态替换', () => {
    const dir = ws();
    writePrd(dir, [story('US-001')]);
    const head = 'b'.repeat(40);
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: STORY_BASE_HEAD,
          validationReceipt: {
            schemaVersion: 4,
            requestId: 'report-observation',
            gitHead: head,
            acceptanceHash: acceptanceHash('US-001', ['ac of US-001']),
            validationEnvironmentDigest: TEST_STORY_ENVIRONMENT,
            runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
            canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
            storyBaseGitHead: STORY_BASE_HEAD,
            changeManifestDigest: CHANGE_MANIFEST_DIGEST,
            changedPathCount: 1,
          },
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const prd = tryReadPrd(join(dir, 'prd.json'));
    const state = tryReadState(join(dir, 'state.json'));
    if (!prd || !state) throw new Error('expected current report fixture');
    const storyValidation = evaluateStoryValidationReceiptSet(
      prd,
      state,
      head,
      TEST_STORY_ENVIRONMENT,
    );
    if (!storyValidation.digest) throw new Error('expected current Story validation digest');
    const first = previousFinalReview(head);
    first.binding.storyValidationDigest = storyValidation.digest;
    writeFileSync(join(dir, 'final-review.json'), `${JSON.stringify(first)}\n`);

    const unobserved = collectReport(dir, new Date(), { currentGitHead: head });
    if (unobserved.status !== 'ok') throw new Error('expected ok');
    expect(unobserved.data.finalReview).toMatchObject({
      current: false,
      staleReasons: [expect.stringContaining('未重新核验')],
    });
    expect(unobserved.data.stories[0]).toMatchObject({ validated: false });
    expect(unobserved.data.storyValidation.configurationError).toContain('未完成受管 Story');

    const observed = {
      read: { status: 'ready' as const, state: first },
      current: true,
      staleReasons: [],
      refreshedRemote: first.remote,
    };
    const storyObservation = observedStoryValidation(dir, head);
    const current = collectReport(dir, new Date(), {
      currentReview: observed,
      currentGitHead: head,
      storyValidationObservation: storyObservation,
    });
    if (current.status !== 'ok') throw new Error('expected ok');
    expect(current.data.finalReview.current).toBe(true);

    const reissued = JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8')) as Record<
      string,
      { validationReceipt: { requestId: string } }
    >;
    reissued['US-001'].validationReceipt.requestId = 'report-observation-reissued';
    writeFileSync(join(dir, 'state.json'), JSON.stringify(reissued));
    const replacedReceipt = collectReport(dir, new Date(), {
      currentReview: observed,
      currentGitHead: head,
      storyValidationObservation: storyObservation,
    });
    if (replacedReceipt.status !== 'ok') throw new Error('expected ok');
    expect(replacedReceipt.data.finalReview).toMatchObject({
      current: false,
      staleReasons: [expect.stringContaining('凭证集合无法验证')],
    });
    expect(replacedReceipt.data.storyValidation.configurationError).toContain('state.json 已变化');

    writeFileSync(
      join(dir, 'final-review.json'),
      `${JSON.stringify(previousFinalReview('c'.repeat(40)))}\n`,
    );
    const replaced = collectReport(dir, new Date(), {
      currentReview: observed,
      currentGitHead: head,
    });
    if (replaced.status !== 'ok') throw new Error('expected ok');
    expect(replaced.data.finalReview).toMatchObject({
      current: false,
      staleReasons: [expect.stringContaining('状态已变化')],
    });
  });

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
      notes: '',
      retryCount: 0,
      blocked: false,
      escalated: false,
    });
  });

  it('按调用方观察的当前 HEAD 只在报告内撤销过期绿灯', () => {
    const dir = ws();
    const target = story('US-001');
    const oldHead = 'a'.repeat(40);
    const nextHead = 'b'.repeat(40);
    writePrd(dir, [target]);
    const persisted = {
      'US-001': {
        passes: true,
        validated: true,
        storyBaseGitHead: STORY_BASE_HEAD,
        validationReceipt: {
          schemaVersion: 4,
          requestId: 'stale-report-receipt',
          gitHead: oldHead,
          acceptanceHash: acceptanceHash(target.id, target.acceptanceCriteria),
          validationEnvironmentDigest: TEST_STORY_ENVIRONMENT,
          runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
          canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
          storyBaseGitHead: STORY_BASE_HEAD,
          changeManifestDigest: CHANGE_MANIFEST_DIGEST,
          changedPathCount: 1,
        },
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(persisted));

    const src = collectReport(dir, new Date(), {
      currentGitHead: nextHead,
      storyValidationObservation: observedStoryValidation(dir, nextHead),
    });
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(src.data.stories[0]).toMatchObject({ passes: true, validated: false });
    expect(src.data.storyValidation).toEqual({
      gitHead: nextHead,
      current: false,
      invalidStoryIds: ['US-001'],
      configurationError: null,
    });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual(persisted);
  });

  it('混合 Story 对账时只撤销过期项，保留当前项和普通未完成项', () => {
    const dir = ws();
    const stories = [story('US-001'), story('US-002'), story('US-003')];
    const oldHead = 'a'.repeat(40);
    const currentHead = 'b'.repeat(40);
    writePrd(dir, stories);
    const persisted = {
      'US-001': {
        passes: true,
        validated: true,
        storyBaseGitHead: STORY_BASE_HEAD,
        validationReceipt: {
          schemaVersion: 4,
          requestId: 'stale-report-receipt',
          gitHead: oldHead,
          acceptanceHash: acceptanceHash('US-001', ['ac of US-001']),
          validationEnvironmentDigest: TEST_STORY_ENVIRONMENT,
          runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
          canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
          storyBaseGitHead: STORY_BASE_HEAD,
          changeManifestDigest: CHANGE_MANIFEST_DIGEST,
          changedPathCount: 1,
        },
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-002': {
        passes: true,
        validated: true,
        storyBaseGitHead: STORY_BASE_HEAD,
        validationReceipt: {
          schemaVersion: 4,
          requestId: 'current-report-receipt',
          gitHead: currentHead,
          acceptanceHash: acceptanceHash('US-002', ['ac of US-002']),
          validationEnvironmentDigest: TEST_STORY_ENVIRONMENT,
          runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
          canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
          storyBaseGitHead: STORY_BASE_HEAD,
          changeManifestDigest: CHANGE_MANIFEST_DIGEST,
          changedPathCount: 1,
        },
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-003': {
        passes: false,
        validated: false,
        validationReceipt: null,
        notes: 'ordinary unfinished',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(persisted));

    const src = collectReport(dir, new Date(), {
      currentGitHead: currentHead,
      storyValidationObservation: observedStoryValidation(dir, currentHead),
    });
    if (src.status !== 'ok') throw new Error('expected ok');
    expect(
      src.data.stories.map(({ id, passes, validated, validationReceipt }) => ({
        id,
        passes,
        validated,
        validationReceipt,
      })),
    ).toEqual([
      { id: 'US-001', passes: true, validated: false, validationReceipt: null },
      {
        id: 'US-002',
        passes: true,
        validated: true,
        validationReceipt: persisted['US-002'].validationReceipt,
      },
      { id: 'US-003', passes: false, validated: false, validationReceipt: null },
    ]);
    expect(src.data.storyValidation).toEqual({
      gitHead: currentHead,
      current: false,
      invalidStoryIds: ['US-001'],
      configurationError: null,
    });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual(persisted);
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

  it('非法空 Story 集合不能显示为当前验收结果', () => {
    const dir = ws();
    writePrd(dir, []);
    const result = collectReport(dir, new Date(), { currentGitHead: 'a'.repeat(40) });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.storyValidation).toEqual({
      gitHead: 'a'.repeat(40),
      current: false,
      invalidStoryIds: [],
      configurationError: 'prd.json 必须包含至少一个 Story',
    });
  });

  it('非法 Story 元素不会让报告崩溃，而是输出无法验证的配置错误', () => {
    const dir = ws();
    const head = 'a'.repeat(40);
    writePrd(dir, [null]);
    const result = collectReport(dir, new Date(), { currentGitHead: head });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.stories).toEqual([]);
    expect(result.data.storyValidation).toEqual({
      gitHead: head,
      current: false,
      invalidStoryIds: [],
      configurationError: 'userStories[0] 的 Story ID 非法',
    });
    expect(() => writeReport(dir, new Date(), { currentGitHead: head })).not.toThrow();
    expect(readFileSync(join(dir, 'report.html'), 'utf8')).toContain('Story 验收配置或观察不可用');
  });

  it('重复 Story ID 时报告数据和 HTML 都撤销全部绿灯且不改写状态文件', () => {
    const dir = ws();
    const head = 'a'.repeat(40);
    const target = story('US-001');
    writePrd(dir, [target, { ...target }]);
    const persisted = {
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt: {
          schemaVersion: 1,
          requestId: 'duplicate-report-receipt',
          gitHead: head,
          acceptanceHash: acceptanceHash(target.id, target.acceptanceCriteria),
        },
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    writeFileSync(join(dir, 'state.json'), JSON.stringify(persisted));

    const result = collectReport(dir, new Date(), { currentGitHead: head });
    if (result.status !== 'ok') throw new Error('expected ok');
    expect(result.data.stories).toHaveLength(2);
    expect(result.data.stories.every((item) => item.passes && !item.validated)).toBe(true);
    expect(result.data.storyValidation).toEqual({
      gitHead: head,
      current: false,
      invalidStoryIds: ['US-001'],
      configurationError: 'userStories 包含重复 Story ID：US-001',
    });

    writeReport(dir, new Date(), { currentGitHead: head });
    const html = readFileSync(join(dir, 'report.html'), 'utf8');
    expect(html).toContain('Story 验收配置或观察不可用');
    expect(html).not.toContain('Story 验证完成');
    expect(html).not.toContain('✅ 通过');
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf8'))).toEqual(persisted);
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
