import { describe, it, expect } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectStatus as collectStatusProduction,
  renderStatusReport,
  renderStatusJson,
} from './status.js';
import { digest } from '../review/common.js';
import { acceptanceHash, readGitHead } from '../engine/validation-protocol.js';
import {
  evaluateStoryValidationDisplay,
  evaluateStoryValidationReceiptSet,
  readDisplayState,
} from '../engine/state.js';
import { tryReadPrd } from '../engine/prd.js';
import type { StoryValidationObservation } from '../review/story-validation-observation.js';
import { readQualityContract } from '../quality/contract.js';
import type {
  WorkspaceSafetyStatus,
  WorkspaceSafetyStatusSnapshot,
} from '../workspace-safety/status.js';

function makeWorkspace(): string {
  return mkdtempSync(join(tmpdir(), 'status-ws-'));
}

const OBSERVED_GIT_HEAD = readGitHead(process.cwd());
if (OBSERVED_GIT_HEAD === null) throw new Error('status tests require a Git HEAD');
const CURRENT_GIT_HEAD: string = OBSERVED_GIT_HEAD;
const TEST_ENVIRONMENT = `sha256:${'e'.repeat(64)}`;
const TEST_CONTRACT_READ = readQualityContract(process.cwd());
if (TEST_CONTRACT_READ.status !== 'ready') {
  throw new Error('status tests require a quality contract');
}
const TEST_CONTRACT = TEST_CONTRACT_READ.contract;
const TEST_CONTRACT_DIGEST = TEST_CONTRACT_READ.digest;

function observedStatusOptions(
  workspace: string,
  currentGitHead = CURRENT_GIT_HEAD,
): { currentGitHead: string; storyValidationObservation?: StoryValidationObservation } {
  const prd = tryReadPrd(join(workspace, 'prd.json'));
  if (!prd || !Array.isArray(prd.userStories)) return { currentGitHead };
  const state = readDisplayState(join(workspace, 'state.json'), prd).state;
  const display = evaluateStoryValidationDisplay(prd, state, currentGitHead, TEST_ENVIRONMENT);
  const receiptSet = evaluateStoryValidationReceiptSet(
    prd,
    state,
    currentGitHead,
    TEST_ENVIRONMENT,
  );
  return {
    currentGitHead,
    storyValidationObservation: {
      status: 'ready',
      workspacePath: workspace,
      observationToken: `sha256:${'f'.repeat(64)}`,
      headSha: currentGitHead,
      prd,
      state: display.state,
      display,
      storyValidationEnvironmentDigest: TEST_ENVIRONMENT,
      storyValidationDigest: receiptSet.digest,
      workingContract: TEST_CONTRACT,
      trackedContract: TEST_CONTRACT,
      workingContractDigest: TEST_CONTRACT_DIGEST,
      trackedContractDigest: TEST_CONTRACT_DIGEST,
      tddConfig: null,
      receiptSet,
    },
  };
}

/** Existing behavioral tests explicitly provide a completed managed observation fixture. */
function collectStatus(
  workspace: string,
  options: { currentGitHead?: string | null } = {},
): ReturnType<typeof collectStatusProduction> {
  const head = options.currentGitHead ?? CURRENT_GIT_HEAD;
  if (head === null) return collectStatusProduction(workspace, { currentGitHead: null });
  return collectStatusProduction(workspace, {
    ...options,
    ...observedStatusOptions(workspace, head),
  });
}

function writeReadyFinalReview(workspace: string, shadow = false): void {
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: ['src/demo.ts'],
    changedModules: ['src'],
  };
  const riskDigest = digest(risk);
  const observed = observedStatusOptions(workspace, 'b'.repeat(40)).storyValidationObservation;
  writeFileSync(
    join(workspace, 'final-review.json'),
    JSON.stringify({
      schemaVersion: 2,
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
        validationEnvironmentDigest: `sha256:${'e'.repeat(64)}`,
        storyValidationDigest: observed?.storyValidationDigest ?? `sha256:${'f'.repeat(64)}`,
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

const passedState = (target: ReturnType<typeof story>) => ({
  passes: true,
  validated: true,
  validationReceipt: {
    schemaVersion: 2,
    requestId: `request-${target.id}`,
    gitHead: CURRENT_GIT_HEAD,
    acceptanceHash: acceptanceHash(target.id, target.acceptanceCriteria),
    validationEnvironmentDigest: `sha256:${'e'.repeat(64)}`,
  },
  notes: '',
  retryCount: 0,
  blocked: false,
  escalated: false,
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

function workspaceSafety(status: WorkspaceSafetyStatus): WorkspaceSafetyStatusSnapshot {
  return {
    status,
    observedClassification: status === 'uninitialized' ? 'uninitialized-empty' : status,
    reason: 'none',
    operationState: 'none',
    operationLocation: 'none',
    probeEvidence: 'system',
    safetyFingerprint: null,
    diagnostic: null,
    display: {
      label: status,
      summary: `${status} workspace`,
      guidance: status === 'ready' ? null : 'resolve workspace safety state',
    },
  };
}

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

  it('观察完成后 state、HEAD 或质量契约变化时同步撤销旧绿灯', () => {
    const ws = makeWorkspace();
    try {
      const target = PRD.userStories[0];
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ ...PRD, userStories: [target] }));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({ 'US-001': passedState(target) }));
      const observed = observedStatusOptions(ws).storyValidationObservation;
      if (!observed) throw new Error('expected Story observation');

      const changedState = JSON.parse(readFileSync(join(ws, 'state.json'), 'utf8')) as Record<
        string,
        { validationReceipt: { requestId: string } }
      >;
      changedState['US-001'].validationReceipt.requestId = 'changed-after-observation';
      writeFileSync(join(ws, 'state.json'), JSON.stringify(changedState));
      const stateReport = collectStatusProduction(ws, {
        projectRoot: process.cwd(),
        currentGitHead: CURRENT_GIT_HEAD,
        storyValidationObservation: observed,
      });
      if (stateReport.status !== 'ok') throw new Error('expected state report');
      expect(stateReport.stories[0].validated).toBe(false);
      expect(stateReport.storyValidation.configurationError).toContain('state.json 已变化');

      writeFileSync(join(ws, 'state.json'), JSON.stringify({ 'US-001': passedState(target) }));
      const headReport = collectStatusProduction(ws, {
        projectRoot: process.cwd(),
        currentGitHead: 'c'.repeat(40),
        storyValidationObservation: observed,
      });
      if (headReport.status !== 'ok') throw new Error('expected head report');
      expect(headReport.stories[0].validated).toBe(false);
      expect(headReport.storyValidation.configurationError).toContain('Git HEAD 已变化');

      const contractReport = collectStatusProduction(ws, {
        projectRoot: process.cwd(),
        currentGitHead: CURRENT_GIT_HEAD,
        storyValidationObservation: {
          ...observed,
          workingContractDigest: `sha256:${'0'.repeat(64)}`,
        },
      });
      if (contractReport.status !== 'ok') throw new Error('expected contract report');
      expect(contractReport.stories[0].validated).toBe(false);
      expect(contractReport.storyValidation.configurationError).toContain('质量契约已变化');
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('异常质量契约不会让 status 阻塞或沿用旧绿灯', () => {
    const ws = makeWorkspace();
    const project = makeWorkspace();
    try {
      const target = PRD.userStories[0];
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ ...PRD, userStories: [target] }));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({ 'US-001': passedState(target) }));
      const observed = observedStatusOptions(ws).storyValidationObservation;
      if (!observed) throw new Error('expected Story observation');
      mkdirSync(join(project, '.coding-x'));
      execFileSync('mkfifo', [join(project, '.coding-x', 'quality.json')]);

      const report = collectStatusProduction(ws, {
        projectRoot: project,
        currentGitHead: CURRENT_GIT_HEAD,
        storyValidationObservation: observed,
      });
      if (report.status !== 'ok') throw new Error('expected status report');
      expect(report.storyValidation.current).toBe(false);
      expect(report.storyValidation.configurationError).toContain('质量契约');
    } finally {
      rmSync(ws, { recursive: true, force: true });
      rmSync(project, { recursive: true, force: true });
    }
  });

  it('只在内存中撤销不属于当前 HEAD 的旧绿灯', () => {
    const ws = makeWorkspace();
    try {
      const target = PRD.userStories[0];
      const oldHead = 'a'.repeat(40);
      const nextHead = 'b'.repeat(40);
      const persisted = {
        'US-001': {
          ...passedState(target),
          validationReceipt: { ...passedState(target).validationReceipt, gitHead: oldHead },
        },
      };
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ ...PRD, userStories: [target] }));
      writeFileSync(join(ws, 'state.json'), JSON.stringify(persisted));

      const report = collectStatus(ws, { currentGitHead: nextHead });
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
      expect(report.stories[0]).toMatchObject({ passes: true, validated: false });
      expect(report.storyValidation).toEqual({
        gitHead: nextHead,
        current: false,
        invalidStoryIds: ['US-001'],
        configurationError: null,
      });
      expect(renderStatusReport(report)).toMatchObject({ exitCode: 1 });
      expect(renderStatusReport(report).text).toContain('验收凭证已过期');
      expect(JSON.parse(readFileSync(join(ws, 'state.json'), 'utf8'))).toEqual(persisted);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('混合 Story 对账时只撤销过期项，保留当前项和普通未完成项', () => {
    const ws = makeWorkspace();
    try {
      const oldHead = 'a'.repeat(40);
      const currentHead = 'b'.repeat(40);
      const [staleStory, currentStory] = PRD.userStories;
      const persisted = {
        'US-001': {
          ...passedState(staleStory),
          validationReceipt: {
            ...passedState(staleStory).validationReceipt,
            gitHead: oldHead,
          },
        },
        'US-002': {
          ...passedState(currentStory),
          validationReceipt: {
            ...passedState(currentStory).validationReceipt,
            gitHead: currentHead,
          },
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
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify(persisted));

      const report = collectStatus(ws, { currentGitHead: currentHead });
      if (report.status !== 'ok') throw new Error(`expected ok, got ${report.status}`);
      expect(
        report.stories.map(({ id, passes, validated, validationReceipt }) => ({
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
      expect(report.storyValidation).toEqual({
        gitHead: currentHead,
        current: false,
        invalidStoryIds: ['US-001'],
        configurationError: null,
      });
      expect(JSON.parse(readFileSync(join(ws, 'state.json'), 'utf8'))).toEqual(persisted);
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify(Object.fromEntries(PRD.userStories.map((s) => [s.id, passedState(s)]))),
      );
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

  it('renders distinct leading marks for passed / pending / blocked, shows retry count, and exits 1', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
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
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
          'US-002': { passes: true, notes: '', retryCount: 0, blocked: false },
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

  it('treats an empty userStories list as an explicit configuration error', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ ...PRD, userStories: [] }));
      const report = collectStatus(ws);
      if (report.status !== 'ok') throw new Error('expected ok');
      expect(report.storyValidation).toMatchObject({
        current: false,
        invalidStoryIds: [],
        configurationError: 'prd.json 必须包含至少一个 Story',
      });
      const { text, exitCode } = renderStatusReport(report);
      expect(text).toContain('Story 验收配置或观察不可用');
      expect(text).not.toContain('全部 story 已通过');
      expect(exitCode).toBe(2);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('非法 Story 元素不会让 status 崩溃，而是返回无法验证的配置错误', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ ...PRD, userStories: [null] }));
      const report = collectStatus(ws, { currentGitHead: CURRENT_GIT_HEAD });
      if (report.status !== 'ok') throw new Error('expected ok');
      expect(report.stories).toEqual([]);
      expect(report.currentStoryId).toBeNull();
      expect(report.storyValidation).toEqual({
        gitHead: CURRENT_GIT_HEAD,
        current: false,
        invalidStoryIds: [],
        configurationError: 'userStories[0] 的 Story ID 非法',
      });
      expect(renderStatusReport(report)).toMatchObject({ exitCode: 2 });
      expect(renderStatusReport(report).text).toContain('验收配置或观察不可用');
      expect(renderStatusJson(report)).toMatchObject({ exitCode: 2 });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('重复 Story ID 时文本和 JSON 都撤销全部绿灯并暴露同一配置错误', () => {
    const ws = makeWorkspace();
    try {
      const target = PRD.userStories[0];
      const duplicatePrd = { ...PRD, userStories: [target, { ...target }] };
      const persisted = { 'US-001': passedState(target) };
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(duplicatePrd));
      writeFileSync(join(ws, 'state.json'), JSON.stringify(persisted));

      const report = collectStatus(ws, { currentGitHead: CURRENT_GIT_HEAD });
      if (report.status !== 'ok') throw new Error('expected ok');
      expect(report.stories).toHaveLength(2);
      expect(report.stories.every((item) => item.passes && !item.validated)).toBe(true);
      expect(report.storyValidation).toEqual({
        gitHead: CURRENT_GIT_HEAD,
        current: false,
        invalidStoryIds: ['US-001'],
        configurationError: 'userStories 包含重复 Story ID：US-001',
      });

      const textResult = renderStatusReport(report);
      expect(textResult).toMatchObject({ exitCode: 2 });
      expect(textResult.text).toContain('Story 验收配置或观察不可用');
      expect(textResult.text).not.toContain('✅ US-001');

      const jsonResult = renderStatusJson(report);
      const json = JSON.parse(jsonResult.text) as {
        stories: Array<{ validated: boolean }>;
        storyValidation: { configurationError: string | null };
      };
      expect(jsonResult.exitCode).toBe(2);
      expect(json.stories.every((item) => !item.validated)).toBe(true);
      expect(json.storyValidation.configurationError).toBe('userStories 包含重复 Story ID：US-001');
      expect(JSON.parse(readFileSync(join(ws, 'state.json'), 'utf8'))).toEqual(persisted);
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

  it('展示最近一次提交检查链中止，并在 JSON 中保留精确身份', () => {
    const ws = makeWorkspace();
    const expectedGitHead = 'a'.repeat(40);
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
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
      writeFileSync(
        join(ws, 'evidence.jsonl'),
        JSON.stringify({
          type: 'iteration',
          source: 'engine',
          at: '2026-08-02T11:00:00.000Z',
          iteration: 6,
          storyId: 'US-001',
          builderRan: false,
          builderModel: null,
          validatorRan: false,
          validatorModel: null,
          skippedValidator: false,
          agentBlocked: false,
          validationHeadAbort: {
            phase: 'validator-start',
            reason: 'head-unreadable',
            expectedGitHead,
            actualGitHead: null,
            diagnostic: 'Validator 请求建立前无法读取 HEAD',
          },
        }) + '\n',
      );

      const report = collectStatus(ws);
      const human = renderStatusReport(report).text;
      expect(human).toContain('检查链中止：提交身份不可读@validator-start');
      expect(human).toContain('实际 unavailable');
      expect(human).toContain('相关执行结果未采用 · 第6轮');

      const json = JSON.parse(renderStatusJson(report).text);
      expect(json.recentValidationHeadAbort['US-001']).toEqual({
        iteration: 6,
        phase: 'validator-start',
        reason: 'head-unreadable',
        expectedGitHead,
        actualGitHead: null,
        diagnostic: 'Validator 请求建立前无法读取 HEAD',
      });
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it('后续完整验收成功后不再把历史提交漂移显示成当前中止', () => {
    const ws = makeWorkspace();
    const gitHead = 'a'.repeat(40);
    const baseIteration = {
      type: 'iteration',
      source: 'engine',
      storyId: 'US-001',
      builderRan: false,
      builderModel: null,
      validatorRan: false,
      validatorModel: null,
      skippedValidator: false,
      agentBlocked: false,
    };
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(join(ws, 'state.json'), JSON.stringify({}));
      writeFileSync(
        join(ws, 'evidence.jsonl'),
        [
          {
            ...baseIteration,
            at: '2026-08-02T11:00:00.000Z',
            iteration: 6,
            validationHeadAbort: {
              phase: 'quality-check-finish',
              reason: 'head-changed',
              expectedGitHead: gitHead,
              actualGitHead: 'b'.repeat(40),
              diagnostic: 'changed',
            },
          },
          {
            ...baseIteration,
            at: '2026-08-02T11:01:00.000Z',
            iteration: 7,
            validatorRan: true,
            validationReceipt: true,
            validationProtocol: 'passed',
          },
        ]
          .map((record) => JSON.stringify(record))
          .join('\n') + '\n',
      );

      const report = collectStatus(ws);
      expect(renderStatusReport(report).text).not.toContain('检查链中止');
      expect(JSON.parse(renderStatusJson(report).text).recentValidationHeadAbort).toEqual({});
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
      expect(obj.stories[1]).toEqual({
        id: 'US-002',
        title: '第二个故事',
        priority: 2,
        passes: false,
        validated: false,
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
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify(Object.fromEntries(PRD.userStories.map((s) => [s.id, passedState(s)]))),
      );
      const { text, exitCode } = renderStatusJson(collectStatus(ws));
      expect(JSON.parse(text).summary).toEqual({ total: 3, passed: 3, blocked: 0 });
      expect(exitCode).toBe(6);
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

  it('reflects legacy embedded state when state.json is absent (old-format fallback)', () => {
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
        notes: '旧备注',
        retryCount: 2,
        blocked: false,
        escalated: false,
      });
      expect(obj.stories[1].blocked).toBe(true);
      expect(obj.summary).toEqual({ total: 2, passed: 0, blocked: 1 });
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

  it('treats an empty userStories list as a machine-readable configuration error', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify({ ...PRD, userStories: [] }));
      const { text, exitCode } = renderStatusJson(collectStatus(ws));
      const json = JSON.parse(text);
      expect(json.summary).toEqual({ total: 0, passed: 0, blocked: 0 });
      expect(json.storyValidation.configurationError).toBe('prd.json 必须包含至少一个 Story');
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
      expect(human.text).toContain('待引擎验收');
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

  it('renders exit 0 only when stories, a current local Review and GitHub delivery are all ready', () => {
    const ws = makeWorkspace();
    try {
      writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify(Object.fromEntries(PRD.userStories.map((s) => [s.id, passedState(s)]))),
      );
      writeReadyFinalReview(ws);
      const collected = collectStatus(ws);
      if (collected.status !== 'ok') throw new Error(`expected ok, got ${collected.status}`);
      // Renderer contract fixture: production obtains `current=true` only after project, PR,
      // rules, risk and supervised Runner-version currentness have all been revalidated.
      const report = {
        ...collected,
        finalReview: { ...collected.finalReview, current: true, staleReasons: [] },
      };
      const human = renderStatusReport(report);
      expect(human.text).toContain('实现验证、本地 Review 与 GitHub 交付条件均已就绪');
      expect(human.exitCode).toBe(0);
      expect(renderStatusJson(report).exitCode).toBe(0);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });

  it.each(['active', 'recoverable', 'isolated'] satisfies WorkspaceSafetyStatus[])(
    'never reports delivery ready while workspace safety is %s',
    (safetyStatus) => {
      const ws = makeWorkspace();
      try {
        writeFileSync(join(ws, 'prd.json'), JSON.stringify(PRD));
        writeFileSync(
          join(ws, 'state.json'),
          JSON.stringify(Object.fromEntries(PRD.userStories.map((s) => [s.id, passedState(s)]))),
        );
        writeReadyFinalReview(ws);
        const report = { ...collectStatus(ws), workspaceSafety: workspaceSafety(safetyStatus) };
        const human = renderStatusReport(report);
        expect(human.text).toContain('workspace 安全状态未就绪');
        expect(human.text).not.toContain('均已就绪');
        expect(human.exitCode).toBe(2);
        expect(renderStatusJson(report).exitCode).toBe(2);
      } finally {
        rmSync(ws, { recursive: true, force: true });
      }
    },
  );

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
          'US-001': {
            passes: true,
            validated: true,
            notes: '',
            retryCount: 5,
            blocked: true,
            escalated: false,
          },
        }),
      );
      const report = collectStatus(ws);
      const human = renderStatusReport(report);
      expect(human.text).toContain('⛔ US-001');
      expect(human.text).not.toContain('待引擎验收');
      expect(human.exitCode).toBe(3);
      const json = renderStatusJson(report);
      expect(JSON.parse(json.text).summary).toEqual({ total: 1, passed: 0, blocked: 1 });
      expect(json.exitCode).toBe(3);
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  });
});
