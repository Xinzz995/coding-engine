import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { collectStatus, renderStatusReport, renderStatusJson } from './status.js';
import { digest, reviewRoutingDigest } from '../review/common.js';
import { acceptanceHash, readGitHead } from '../engine/validation-protocol.js';
import { tryReadState, validationReceiptsDigest, type StoryState } from '../engine/state.js';
import { tryReadPrd, type Story } from '../engine/prd.js';
import { readFinalReviewState, reviewDecisionsDigest } from '../review/state.js';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'status-ws-'));
}

function currentHead(): string {
  const head = readGitHead(process.cwd());
  if (head === null) throw new Error('status tests require a Git HEAD');
  return head;
}

function passedState(story: Pick<Story, 'id' | 'acceptanceCriteria'>): StoryState {
  return {
    passes: true,
    validated: true,
    validationReceipt: {
      schemaVersion: 1,
      requestId: `request-${story.id}`,
      gitHead: currentHead(),
      acceptanceHash: acceptanceHash(story.id, story.acceptanceCriteria),
    },
    notes: '',
    retryCount: 0,
    blocked: false,
    escalated: false,
  };
}

function writePassedState(workspace: string, stories: Story[]): void {
  writeFileSync(
    join(workspace, 'state.json'),
    JSON.stringify(Object.fromEntries(stories.map((item) => [item.id, passedState(item)]))),
  );
}

function storyValidationDigest(workspace: string): string {
  const prd = tryReadPrd(join(workspace, 'prd.json'));
  const state = tryReadState(join(workspace, 'state.json'));
  if (prd === null || state === null) throw new Error('expected valid status fixture');
  const value = validationReceiptsDigest(prd, state, currentHead());
  if (value === null) throw new Error('expected current Story validation receipts');
  return value;
}

function writeReadyFinalReview(workspace: string, shadow = false, schemaVersion = 2): void {
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: ['src/demo.ts'],
    changedModules: ['src'],
  };
  const riskDigest = digest(risk);
  writeFileSync(
    join(workspace, 'final-review.json'),
    JSON.stringify({
      schemaVersion,
      status: 'passed',
      deliveryStatus: shadow ? 'shadow' : 'ready',
      binding: {
        prNumber: 123,
        targetBranch: 'main',
        baseSha: 'a'.repeat(40),
        headSha: 'b'.repeat(40),
        prTitleDigest: 'sha256:title',
        prBodyDigest: 'sha256:body',
        specDigest: 'sha256:spec',
        engineeringStandardsDigest: 'sha256:standards',
        qualityContractDigest: 'sha256:contract',
        storyValidationDigest: storyValidationDigest(workspace),
        reviewDecisionsDigest: reviewDecisionsDigest(null),
        reviewRoutingDigest: reviewRoutingDigest(undefined),
        codingXVersion: '0.29.0',
        runner: 'codex',
        model: 'gpt-test',
        runnerVersion: 'codex-test',
        reviewRulesVersion: '1.0.0',
        reviewRulesDigest: 'sha256:rules',
        riskDigest,
      },
      risk: { ...risk, digest: riskDigest },
      axes: [
        {
          axis: 'spec',
          status: 'passed',
          summary: 'spec ok',
          findings: [],
          requestDeepReview: false,
          durationMs: 1,
          attempts: 1,
        },
        {
          axis: 'engineering',
          status: 'passed',
          summary: 'engineering ok',
          findings: [],
          requestDeepReview: false,
          durationMs: 1,
          attempts: 1,
        },
      ],
      remote: {
        status: 'ready',
        checks: [],
        rulesetErrors: [],
        checkedAt: new Date().toISOString(),
      },
      round: 1,
      shadow,
      startedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
    }),
  );
}

const story = (id: string, title: string, priority: number) => ({
  id,
  title,
  description: 'd',
  acceptanceCriteria: ['ac'],
  priority,
});

const PRD = {
  project: 'demo-proj',
  branchName: 'ralph/demo',
  description: 'd',
  userStories: [
    story('US-001', '第一个故事', 1),
    story('US-002', '第二个故事', 2),
    story('US-003', '第三个故事', 3),
  ],
};

// v0.4 旧格式：状态字段内嵌在 story 上（无独立 state.json）
const LEGACY_PRD = {
  project: 'legacy-proj',
  branchName: 'ralph/legacy',
  description: 'd',
  userStories: [
    { ...story('US-001', '旧一', 1), passes: true, notes: '旧备注', retryCount: 2, blocked: false },
    { ...story('US-002', '旧二', 2), passes: false, notes: '', retryCount: 0, blocked: true },
  ],
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

  it.skipIf(process.platform === 'win32')(
    'rejects a workspace symlink instead of reading through it',
    () => {
      const target = makeWorkspace();
      const parent = mkdtempSync(join(tmpdir(), 'status-link-parent-'));
      const link = join(parent, 'workspace-link');
      try {
        writeFileSync(join(target, 'prd.json'), JSON.stringify(PRD));
        symlinkSync(target, link, 'dir');
        expect(collectStatus(link)).toEqual({ status: 'unparsable', workspace: link });
      } finally {
        rmSync(parent, { recursive: true, force: true });
        rmSync(target, { recursive: true, force: true });
      }
    },
  );

  it('reports unparsable for broken JSON', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), '{ not json');
      expect(collectStatus(ws).status).toBe('unparsable');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it.each([
    ['an empty Story set', { ...PRD, userStories: [] }],
    [
      'duplicate Story IDs',
      { ...PRD, userStories: [PRD.userStories[0], { ...PRD.userStories[1], id: ' US-001 ' }] },
    ],
    [
      'empty acceptance criteria',
      {
        ...PRD,
        userStories: [{ ...PRD.userStories[0], acceptanceCriteria: [] }],
      },
    ],
    [
      'a blank acceptance criterion',
      {
        ...PRD,
        userStories: [{ ...PRD.userStories[0], acceptanceCriteria: ['  '] }],
      },
    ],
  ])('reports unparsable for %s instead of exposing a green state', (_name, prd) => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(prd));
      expect(collectStatus(ws)).toEqual({ status: 'unparsable', workspace: ws });
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
          'US-002': { passes: false, notes: '', retryCount: 2, blocked: false },
          'US-003': { passes: false, notes: '', retryCount: 1, blocked: true },
        }),
      );
      const report = collectStatus(ws);
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
      expect(report.prd.project).toBe('demo-proj');
      expect(report.stories.map((s) => s.passes)).toEqual([true, false, false]);
      expect(report.stories[1].retryCount).toBe(2);
      expect(report.stories[2].blocked).toBe(true);
      expect(report.stateCorrupted).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('falls back silently (stateCorrupted=false) when state.json is absent', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(LEGACY_PRD));
      const report = collectStatus(ws);
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
      expect(report.stateCorrupted).toBe(false);
      // 回退读 story 上的旧格式内嵌字段（v0.4 workspace / 历史归档零迁移可看）
      expect(report.stories.map((s) => s.passes)).toEqual([true, false]);
      expect(report.stories[0].notes).toBe('旧备注');
      expect(report.stories[0].retryCount).toBe(2);
      expect(report.stories[1].blocked).toBe(true);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('flags stateCorrupted and fails closed when state.json is broken JSON', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(LEGACY_PRD));
      writeFileSync(join(ws, 'state.json'), '{ not json');
      const report = collectStatus(ws);
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
      expect(report.stateCorrupted).toBe(true);
      expect(
        report.stories.map((s) => ({
          passes: s.passes,
          validated: s.validated,
          notes: s.notes,
          retryCount: s.retryCount,
          blocked: s.blocked,
        })),
      ).toEqual([
        { passes: false, validated: false, notes: '', retryCount: 0, blocked: false },
        { passes: false, validated: false, notes: '', retryCount: 0, blocked: false },
      ]);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('flags stateCorrupted when state.json parses but has an invalid shape', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(LEGACY_PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({ 'US-001': { passes: 'yes' } }));
      const report = collectStatus(ws);
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
      expect(report.stateCorrupted).toBe(true);
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
    const { text, exitCode } = renderStatusReport({
      status: 'unparsable',
      workspace: '.workspace',
    });
    expect(text).toContain('coding-x repair');
    expect(exitCode).toBe(2);
  });

  it('separates completed stories from delivery readiness when final Review is missing', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writePassedState(ws, PRD.userStories);
      const { text, exitCode } = renderStatusReport(collectStatus(ws));
      expect(text).toContain('demo-proj');
      expect(text).toContain('ralph/demo');
      expect(text).toContain('3/3');
      expect(text).toContain('Story 已通过');
      expect(text).toContain('本地最终 Review 尚未完成');
      expect(exitCode).toBe(6);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('reports an old Final Review as stale instead of corrupted and exits 6', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writePassedState(ws, PRD.userStories);
      writeReadyFinalReview(ws, false, 1);
      const report = collectStatus(ws);
      const human = renderStatusReport(report);
      expect(human.text).toContain('旧格式 v1 已失效');
      expect(human.text).toContain('请重新运行 coding-x');
      expect(human.text).not.toContain('状态损坏');
      expect(human.exitCode).toBe(6);
      const json = renderStatusJson(report);
      expect(JSON.parse(json.text).finalReview.read).toEqual({
        status: 'unsupported',
        schemaVersion: 1,
      });
      expect(json.exitCode).toBe(6);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('uses the final blocked Story snapshot and exits 3 when state changes during Review collection', () => {
    const ws = makeWorkspace();
    try {
      const single = { ...PRD, userStories: [PRD.userStories[0]] };
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(single));
      writePassedState(ws, single.userStories);
      writeReadyFinalReview(ws);
      const ready = readFinalReviewState(ws);
      if (ready.status !== 'ready') throw new Error('expected ready Final Review fixture');

      const report = collectStatus(ws, {
        reviewCollector: () => {
          writeFileSync(
            join(ws, 'state.json'),
            JSON.stringify({
              'US-001': { ...passedState(single.userStories[0]), blocked: true },
            }),
          );
          return { read: ready, current: true, staleReasons: [] };
        },
      });
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);

      expect(report.stories[0]).toMatchObject({ blocked: true, validated: false });
      expect(report.finalReview.current).toBe(false);
      expect(report.finalReview.staleReasons).toContain(
        '状态收集期间 Story 状态已变化；已使用最终快照',
      );
      expect(renderStatusReport(report).exitCode).toBe(3);
      expect(renderStatusJson(report).exitCode).toBe(3);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('uses the final pending-validation Story snapshot and exits 1', () => {
    const ws = makeWorkspace();
    try {
      const single = { ...PRD, userStories: [PRD.userStories[0]] };
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(single));
      writePassedState(ws, single.userStories);
      writeReadyFinalReview(ws);
      const ready = readFinalReviewState(ws);
      if (ready.status !== 'ready') throw new Error('expected ready Final Review fixture');

      const report = collectStatus(ws, {
        reviewCollector: () => {
          writeFileSync(
            join(ws, 'state.json'),
            JSON.stringify({
              'US-001': {
                ...passedState(single.userStories[0]),
                validated: false,
                validationReceipt: null,
              },
            }),
          );
          return { read: ready, current: true, staleReasons: [] };
        },
      });
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);

      expect(report.stories[0]).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
        blocked: false,
      });
      expect(report.finalReview.current).toBe(false);
      expect(renderStatusReport(report).text).toContain('实现候选待验收');
      expect(renderStatusReport(report).exitCode).toBe(1);
      expect(renderStatusJson(report).exitCode).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('returns unparsable when the final PRD snapshot becomes invalid', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      const report = collectStatus(ws, {
        reviewCollector: () => {
          writeFileSync(join(ws, 'prd.json'), '{ broken');
          return { read: { status: 'missing' }, current: false, staleReasons: [] };
        },
      });
      expect(report).toEqual({ status: 'unparsable', workspace: ws });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('invalidates the collected result when another Review replaces final-review.json before the final snapshot', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writePassedState(ws, PRD.userStories);
      writeReadyFinalReview(ws);
      const ready = readFinalReviewState(ws);
      if (ready.status !== 'ready') throw new Error('expected ready Final Review fixture');

      const report = collectStatus(ws, {
        reviewCollector: () => {
          writeFileSync(
            join(ws, 'final-review.json'),
            JSON.stringify({
              ...ready.state,
              round: ready.state.round + 1,
              completedAt: '2026-07-30T00:00:00.000Z',
            }),
          );
          return { read: ready, current: true, staleReasons: [] };
        },
      });
      if (report.status !== 'ok') throw new Error('expected ok');

      expect(report.finalReview.current).toBe(false);
      expect(report.finalReview.staleReasons).toContain('状态收集期间本地最终 Review 状态已变化');
      expect(renderStatusReport(report).exitCode).toBe(6);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('invalidates the collected result when Review decisions change before the final snapshot', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writePassedState(ws, PRD.userStories);
      writeReadyFinalReview(ws);
      const ready = readFinalReviewState(ws);
      if (ready.status !== 'ready') throw new Error('expected ready Final Review fixture');

      const report = collectStatus(ws, {
        reviewCollector: () => {
          writeFileSync(
            join(ws, 'review-decisions.json'),
            JSON.stringify({ schemaVersion: 1, decisions: [] }),
          );
          return { read: ready, current: true, staleReasons: [] };
        },
      });
      if (report.status !== 'ok') throw new Error('expected ok');

      expect(report.finalReview.current).toBe(false);
      expect(report.finalReview.staleReasons).toContain('状态收集期间 Review 裁决记录已变化');
      expect(renderStatusJson(report).exitCode).toBe(6);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('使用 Review 收集结束时的 PRD、当前 Story 和模型路由', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(
        join(ws, 'prd.json'),
        JSON.stringify({ ...PRD, userStories: [PRD.userStories[0]] }),
      );
      const finalPrd = {
        project: 'final-project',
        branchName: 'ralph/final',
        description: 'final',
        models: {
          runner: 'claude',
          builder: { low: 'low-final', medium: 'medium-final', high: 'high-final' },
          validator: 'validator-final',
          escalation: 'escalation-final',
        },
        userStories: [
          {
            ...story('US-FINAL', '最终故事', 1),
            difficulty: 'high',
            difficultyReason: '最终快照需要高强度路由',
          },
        ],
      };

      const report = collectStatus(ws, {
        reviewCollector: () => {
          writeFileSync(join(ws, 'prd.json'), JSON.stringify(finalPrd));
          return { read: { status: 'missing' }, current: true, staleReasons: [] };
        },
      });
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);

      expect(report.prd.project).toBe('final-project');
      expect(report.stories.map((item) => item.id)).toEqual(['US-FINAL']);
      expect(report.currentStoryId).toBe('US-FINAL');
      expect(report.modelRouting.status).toBe('enabled');
      if (report.modelRouting.status !== 'enabled') throw new Error('expected enabled routing');
      expect(report.modelRouting.config.runner).toBe('claude');
      expect(report.finalReview.current).toBe(false);
      expect(report.finalReview.staleReasons).toContain('状态收集期间 PRD 已变化；已使用最终快照');
      expect(report.finalReview.staleReasons).toContain(
        '状态收集期间 PRD 模型路由已变化；已使用最终快照',
      );
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('renders distinct leading marks for passed / pending / blocked, shows retry count, and exits 1', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': passedState(PRD.userStories[0]),
          'US-002': { passes: false, notes: '', retryCount: 2, blocked: false },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: true },
        }),
      );
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
      expect(exitCode).toBe(3);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('exits 3 when a story is blocked even if the rest pass', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': passedState(PRD.userStories[0]),
          'US-002': passedState(PRD.userStories[1]),
          'US-003': { passes: false, notes: '', retryCount: 3, blocked: true },
        }),
      );
      const { exitCode } = renderStatusReport(collectStatus(ws));
      expect(exitCode).toBe(3);
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
          'US-002': {
            passes: false,
            notes: '第一行失败记录\n第二行详情',
            retryCount: 1,
            blocked: false,
          },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
        }),
      );
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
          'US-002': {
            passes: false,
            notes:
              '普通失败说明\n[需求冲突] 2026-07-04 10:00 源文档说 X，acceptanceCriteria 说 Y，已按 Y 实现',
            retryCount: 0,
            blocked: false,
          },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
        }),
      );
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

  it('marks [需要人工核实] note lines with the same warning as [需求冲突]', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
          'US-002': {
            passes: false,
            notes:
              '普通失败说明\n[需要人工核实] 2026-07-07 19:00 门禁配置来源存疑，已置 blocked 待人工',
            retryCount: 0,
            blocked: false,
          },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
        }),
      );
      const { text } = renderStatusReport(collectStatus(ws));
      const line = text.split('\n').find((l) => l.includes('[需要人工核实]'));
      expect(line).toBeDefined();
      expect(line).toContain('🚨');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('points the current-story hint at the highest-priority pending unblocked story', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': passedState(PRD.userStories[0]),
          'US-002': { passes: false, notes: '', retryCount: 0, blocked: false },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
        }),
      );
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': passedState(PRD.userStories[0]),
          'US-002': { passes: false, notes: '', retryCount: 0, blocked: true },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
        }),
      );
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': passedState(PRD.userStories[0]),
          'US-002': passedState(PRD.userStories[1]),
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: true },
        }),
      );
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
          'US-002': { passes: false, notes: '', retryCount: 0, blocked: true },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: true },
        }),
      );
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
          'US-002': { passes: false, notes: '', retryCount: 0, blocked: false },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: false },
        }),
      );
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
      writeFileSync(
        join(ws, 'progress.md'),
        [
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
        ].join('\n'),
      );
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
      // 只有 Codebase Patterns 段、尚无日期开头的迭代记录：不把 Patterns 标题当最近进展
      writeFileSync(
        join(ws, 'progress.md'),
        '# Progress\n\n## Codebase Patterns\n- 某个 pattern\n',
      );
      expect(renderStatusReport(collectStatus(ws)).text).not.toContain('最近进展');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('treats an empty userStories list as an invalid PRD', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ ...PRD, userStories: [] }));
      expect(collectStatus(ws)).toEqual({ status: 'unparsable', workspace: ws });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('同时展示配置路由、story 难度/升级态与最近实际命中', () => {
    const ws = makeWorkspace();
    try {
      const routed = {
        ...PRD,
        models: {
          runner: 'codex',
          builder: { low: 'lo', medium: 'mid', high: 'hi' },
          validator: 'val',
          escalation: 'esc',
        },
        userStories: PRD.userStories.map((s) => ({
          ...s,
          difficulty: 'medium',
          difficultyReason: `命中 medium-1：${s.id} 涉及多文件。`,
        })),
      };
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(routed));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { passes: false, notes: '', retryCount: 1, blocked: false, escalated: true },
        }),
      );
      writeFileSync(
        join(ws, 'evidence.jsonl'),
        JSON.stringify({
          type: 'iteration',
          source: 'engine',
          at: '2026-07-21T00:00:00.000Z',
          iteration: 4,
          storyId: 'US-001',
          builderRan: true,
          builderModel: 'esc',
          validatorRan: true,
          validatorModel: 'val',
          skippedValidator: false,
          agentBlocked: false,
          builderRouteSource: 'escalation',
          validatorRouteSource: 'validator',
          storyDifficulty: 'medium',
        }) + '\n',
      );

      const report = collectStatus(ws);
      const human = renderStatusReport(report).text;
      expect(human).toContain('模型路由（codex）');
      expect(human).toContain('low=lo');
      expect(human).toContain('[medium]');
      expect(human).toContain('⬆️ 已升级');
      expect(human).toContain('难度依据');
      expect(human).toContain('builder=esc [escalation]@第4轮');
      expect(human).toContain('validator=val [validator]@第4轮');

      const json = JSON.parse(renderStatusJson(report).text);
      expect(json.modelRouting.status).toBe('enabled');
      expect(json.stories[0]).toMatchObject({ difficulty: 'medium', escalated: true });
      expect(json.recentActual['US-001'].builder).toMatchObject({
        model: 'esc',
        source: 'escalation',
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('最近实际调用展示耗时/退出码，并在文本与 JSON 保留 402 恢复诊断', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(
        join(ws, 'evidence.jsonl'),
        JSON.stringify({
          type: 'iteration',
          source: 'engine',
          at: '2026-07-22T10:40:23.145Z',
          iteration: 1,
          storyId: 'US-001',
          builderRan: true,
          builderModel: null,
          validatorRan: false,
          validatorModel: null,
          skippedValidator: false,
          agentBlocked: false,
          builderRouteSource: 'runner-default',
          builderOutcome: 'error',
          builderInvocation: {
            durationMs: 4571,
            exitCode: 1,
            diagnosticTail: 'API Error: 402 Account overdue',
          },
        }) + '\n',
      );

      const report = collectStatus(ws);
      const human = renderStatusReport(report).text;
      expect(human).toContain('builder=默认 [runner-default]@第1轮 · error · 4.6s · exit=1');
      expect(human).toContain('builder 诊断：API Error: 402 Account overdue');
      const json = JSON.parse(renderStatusJson(report).text);
      expect(json.recentActual['US-001'].builder).toMatchObject({
        outcome: 'error',
        invocation: {
          durationMs: 4571,
          exitCode: 1,
          diagnosticTail: 'API Error: 402 Account overdue',
        },
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('展示最近一次结构化验收绑定与 invalid 原因', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': {
            passes: false,
            validated: false,
            notes: '',
            retryCount: 0,
            blocked: false,
            escalated: false,
          },
        }),
      );
      writeFileSync(
        join(ws, 'evidence.jsonl'),
        JSON.stringify({
          type: 'iteration',
          source: 'engine',
          at: '2026-07-22T11:00:00.000Z',
          iteration: 5,
          storyId: 'US-001',
          builderRan: true,
          builderModel: null,
          validatorRan: true,
          validatorModel: null,
          skippedValidator: false,
          agentBlocked: false,
          validationProtocol: 'invalid',
          validationTarget: {
            requestId: 'request-5',
            storyId: 'US-001',
            acceptanceHash: `sha256:${'a'.repeat(64)}`,
            gitHead: null,
          },
          validationProtocolError: { code: 'binding-mismatch', diagnostic: 'story ID 不匹配' },
        }) + '\n',
      );

      const report = collectStatus(ws);
      const human = renderStatusReport(report).text;
      expect(human).toContain('最近验收协议：invalid@第5轮');
      expect(human).toContain('binding-mismatch：story ID 不匹配');
      expect(human).toContain('Git=unavailable');

      const json = JSON.parse(renderStatusJson(report).text);
      expect(json.recentValidation['US-001']).toMatchObject({
        protocol: 'invalid',
        iteration: 5,
        error: { code: 'binding-mismatch', diagnostic: 'story ID 不匹配' },
        target: { gitHead: null },
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});

describe('renderStatusJson', () => {
  it('emits a single JSON.parse-able object with all required fields and exits 1 while unfinished', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(
        join(ws, 'prd.json'),
        JSON.stringify({ ...PRD, sourcePrd: 'docs/prds/demo.md' }),
      );
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': passedState(PRD.userStories[0]),
          'US-002': { passes: false, notes: '一条失败记录', retryCount: 2, blocked: false },
          'US-003': { passes: false, notes: '', retryCount: 0, blocked: true },
        }),
      );
      const { text, exitCode } = renderStatusJson(collectStatus(ws));
      const obj = JSON.parse(text); // 可解析性
      expect(obj.project).toBe('demo-proj');
      expect(obj.branchName).toBe('ralph/demo');
      expect(obj.sourcePrd).toBe('docs/prds/demo.md');
      expect(obj.stories).toHaveLength(3);
      expect(obj.stories[0].validationReceipt).toEqual(
        passedState(PRD.userStories[0]).validationReceipt,
      );
      expect(obj.stories[1]).toEqual({
        id: 'US-002',
        title: '第二个故事',
        priority: 2,
        passes: false,
        validated: false,
        validationReceipt: null,
        notes: '一条失败记录',
        retryCount: 2,
        blocked: false,
        escalated: false,
      });
      expect(obj.summary).toEqual({ total: 3, passed: 1, blocked: 1 });
      expect(exitCode).toBe(3);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('omits sourcePrd when the prd.json has none', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      const obj = JSON.parse(renderStatusJson(collectStatus(ws)).text);
      expect('sourcePrd' in obj).toBe(false);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('exits 6 when every story passes but final Review is missing', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writePassedState(ws, PRD.userStories);
      const { text, exitCode } = renderStatusJson(collectStatus(ws));
      expect(JSON.parse(text).summary).toEqual({ total: 3, passed: 3, blocked: 0 });
      expect(exitCode).toBe(6);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('publishes validation invalidations and all Final Review v2 binding digests', () => {
    const ws = makeWorkspace();
    try {
      const single = { ...PRD, userStories: [PRD.userStories[0]] };
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(single));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': {
            ...passedState(PRD.userStories[0]),
            validationReceipt: {
              ...passedState(PRD.userStories[0]).validationReceipt!,
              gitHead: '0'.repeat(40),
            },
          },
        }),
      );
      const stale = JSON.parse(renderStatusJson(collectStatus(ws)).text);
      expect(stale.validationInvalidations).toEqual([
        { storyId: 'US-001', reason: 'git-head-mismatch' },
      ]);

      writePassedState(ws, single.userStories);
      writeReadyFinalReview(ws);
      const ready = JSON.parse(renderStatusJson(collectStatus(ws)).text);
      expect(ready.finalReview.read.state.binding).toMatchObject({
        storyValidationDigest: storyValidationDigest(ws),
        reviewDecisionsDigest: reviewDecisionsDigest(null),
        reviewRoutingDigest: reviewRoutingDigest(undefined),
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('emits parseable error JSON and exits 2 for missing workspace and unparsable prd.json', () => {
    const missing = renderStatusJson({ status: 'missing', workspace: '.workspace' });
    expect(JSON.parse(missing.text)).toEqual({ error: 'missing', workspace: '.workspace' });
    expect(missing.exitCode).toBe(2);
    const unparsable = renderStatusJson({ status: 'unparsable', workspace: '.workspace' });
    expect(JSON.parse(unparsable.text)).toEqual({ error: 'unparsable', workspace: '.workspace' });
    expect(unparsable.exitCode).toBe(2);
  });

  it('keeps legacy embedded passes as pending revalidation when the receipt is absent', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(LEGACY_PRD));
      const { text, exitCode } = renderStatusJson(collectStatus(ws));
      const obj = JSON.parse(text);
      expect(obj.stories[0]).toEqual({
        id: 'US-001',
        title: '旧一',
        priority: 1,
        passes: true,
        validated: false,
        validationReceipt: null,
        notes: '旧备注',
        retryCount: 2,
        blocked: false,
        escalated: false,
      });
      expect(obj.stories[1].blocked).toBe(true);
      expect(obj.summary).toEqual({ total: 2, passed: 0, blocked: 1 });
      expect(renderStatusReport(collectStatus(ws)).text).toContain('实现候选待验收');
      expect(exitCode).toBe(3);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('renders a machine-readable fail-closed view when state.json is corrupt', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(LEGACY_PRD));
      writeFileSync(join(ws, 'state.json'), '{ not json');
      const rendered = renderStatusJson(collectStatus(ws));
      const obj = JSON.parse(rendered.text);
      expect(obj.stateCorrupted).toBe(true);
      expect(obj.summary).toEqual({ total: 2, passed: 0, blocked: 0 });
      expect(obj.stories[0]).toMatchObject({
        passes: false,
        validated: false,
        notes: '',
        retryCount: 0,
        blocked: false,
      });
      expect(rendered.exitCode).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('emits an unparsable error for an empty Story set', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ ...PRD, userStories: [] }));
      const { text, exitCode } = renderStatusJson(collectStatus(ws));
      expect(JSON.parse(text)).toEqual({ error: 'unparsable', workspace: ws });
      expect(exitCode).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('does not count passes=true without an engine validation receipt as passed', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(
        join(ws, 'prd.json'),
        JSON.stringify({ ...PRD, userStories: [PRD.userStories[0]] }),
      );
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': {
            passes: true,
            validated: false,
            notes: '',
            retryCount: 0,
            blocked: false,
            escalated: false,
          },
        }),
      );
      const report = collectStatus(ws);
      const human = renderStatusReport(report);
      expect(human.text).toContain('实现候选待验收');
      expect(human.text).not.toContain('✅ 全部 story 已通过');
      expect(human.exitCode).toBe(1);
      const json = renderStatusJson(report);
      expect(JSON.parse(json.text)).toMatchObject({
        stories: [{ passes: true, validated: false }],
        summary: { total: 1, passed: 0, blocked: 0 },
      });
      expect(json.exitCode).toBe(1);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('exits 0 only when stories, local Review and GitHub delivery are all ready', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writePassedState(ws, PRD.userStories);
      writeReadyFinalReview(ws);
      const report = collectStatus(ws);
      const human = renderStatusReport(report);
      expect(human.text).toContain('实现验证、本地 Review 与 GitHub 交付条件均已就绪');
      expect(human.exitCode).toBe(0);
      expect(renderStatusJson(report).exitCode).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('marks an otherwise valid Final Review stale when the current receipt digest changes', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writePassedState(ws, PRD.userStories);
      writeReadyFinalReview(ws);

      const changed = Object.fromEntries(
        PRD.userStories.map((item) => {
          const base = passedState(item);
          return [
            item.id,
            item.id === 'US-001'
              ? {
                  ...base,
                  validationReceipt: {
                    ...base.validationReceipt!,
                    requestId: 'request-US-001-revalidated',
                  },
                }
              : base,
          ];
        }),
      );
      writeFileSync(join(ws, 'state.json'), JSON.stringify(changed));

      const report = collectStatus(ws);
      if (report.status !== 'ok') throw new Error('expected ok');
      expect(report.finalReview.current).toBe(false);
      expect(report.finalReview.staleReasons).toContain('Story Validator 凭证已变化');
      expect(renderStatusReport(report).exitCode).toBe(6);
      expect(renderStatusJson(report).exitCode).toBe(6);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('gives blocked precedence over contradictory pass and receipt fields', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(
        join(ws, 'prd.json'),
        JSON.stringify({ ...PRD, userStories: [PRD.userStories[0]] }),
      );
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { ...passedState(PRD.userStories[0]), retryCount: 5, blocked: true },
        }),
      );
      const report = collectStatus(ws);
      const human = renderStatusReport(report);
      expect(human.text).toContain('⛔ US-001');
      expect(human.text).not.toContain('实现候选待验收');
      expect(human.exitCode).toBe(3);
      const json = renderStatusJson(report);
      expect(JSON.parse(json.text).summary).toEqual({ total: 1, passed: 0, blocked: 1 });
      expect(json.exitCode).toBe(3);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
