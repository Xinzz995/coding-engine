import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runInNewContext } from 'node:vm';
import { execFileSync } from 'node:child_process';
import { acceptanceHash } from '../engine/validation-protocol.js';
import { tryReadPrd } from '../engine/prd.js';
import {
  evaluateStoryValidationDisplay,
  evaluateStoryValidationReceiptSet,
  readDisplayState,
} from '../engine/state.js';
import { readQualityContract } from '../quality/contract.js';
import { REVIEW_RULES_DIGEST } from '../review/rules.js';
import type { ReviewStateRead } from '../review/state.js';
import type { StoryValidationObservation } from '../review/story-validation-observation.js';
import { REVIEW_RULES_VERSION } from '../review/types.js';
import {
  setState,
  buildApiResponse,
  buildApiResponseWithWorkspaceSafety,
  start,
  configureWorkspace,
  evaluateDashboardReviewCompletion,
} from './server.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
  vi.restoreAllMocks();
});

function tempWorkspace(): string {
  const dir = mkdtempSync(join(tmpdir(), 'ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  writeFileSync(
    join(dir, 'prd.json'),
    JSON.stringify({
      project: '任务应用',
      branchName: 'ralph/x',
      description: 'd',
      sourcePrd: 'docs/prds/prd-x.md',
      userStories: [
        { id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 },
      ],
    }),
  );
  writeFileSync(
    join(dir, 'state.json'),
    JSON.stringify({
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
    }),
  );
  writeFileSync(join(dir, 'progress.md'), '## US-001\n- done');
  return dir;
}

const TEST_VALIDATION_ENVIRONMENT = `sha256:${'e'.repeat(64)}`;

function readyStoryValidationObservation(
  workspace: string,
  headSha: string,
  projectRoot = process.cwd(),
): Extract<StoryValidationObservation, { status: 'ready' }> {
  const prd = tryReadPrd(join(workspace, 'prd.json'));
  if (!prd) throw new Error('dashboard observation fixture requires a readable PRD');
  const state = readDisplayState(join(workspace, 'state.json'), prd).state;
  const display = evaluateStoryValidationDisplay(prd, state, headSha, TEST_VALIDATION_ENVIRONMENT);
  const receiptSet = evaluateStoryValidationReceiptSet(
    prd,
    state,
    headSha,
    TEST_VALIDATION_ENVIRONMENT,
  );
  const contract = readQualityContract(projectRoot);
  if (contract.status !== 'ready') {
    throw new Error('dashboard observation fixture requires a readable quality contract');
  }
  return {
    status: 'ready',
    workspacePath: workspace,
    observationToken: `sha256:${'f'.repeat(64)}`,
    headSha,
    prd,
    state: display.state,
    display,
    storyValidationEnvironmentDigest: TEST_VALIDATION_ENVIRONMENT,
    storyValidationDigest: receiptSet.digest,
    workingContract: contract.contract,
    trackedContract: contract.contract,
    workingContractDigest: contract.digest,
    trackedContractDigest: contract.digest,
    tddConfig: null,
    receiptSet,
  };
}

type DashboardStory = {
  id: string;
  passes: boolean;
  validated: boolean;
  notes: string;
  retryCount: number;
  blocked: boolean;
};

type DashboardStoryValidation = {
  gitHead: string | null;
  current: boolean;
  invalidStoryIds: string[];
  configurationError: string | null;
};

type DashboardReviewCompletion = {
  current: boolean;
  reason: string | null;
};

const dashboardAssets = [
  {
    label: '普通页',
    file: 'dashboard.html',
    stateFunction: 'getState',
    currentStoryArgument: true,
  },
  {
    label: '像素页',
    file: 'dashboard-p.html',
    stateFunction: 'getStoryState',
    currentStoryArgument: false,
  },
] as const;

function readDashboardAsset(file: string): string {
  return readFileSync(join(process.cwd(), 'assets', 'dashboard', file), 'utf-8');
}

function extractInlineFunction(html: string, name: string): string {
  const source = html.match(
    new RegExp(`function\\s+${name}\\s*\\([^)]*\\)\\s*\\{[\\s\\S]*?\\n\\}`),
  );
  expect(source, `${name} should remain an inline dashboard function`).not.toBeNull();
  return source![0];
}

function dashboardState(
  asset: (typeof dashboardAssets)[number],
  story: DashboardStory,
  currentStory: string | null = null,
  storyValidation: DashboardStoryValidation | null = {
    gitHead: 'a'.repeat(40),
    current: true,
    invalidStoryIds: [],
    configurationError: null,
  },
): string {
  const html = readDashboardAsset(asset.file);
  const passedSource = extractInlineFunction(html, 'isStoryPassed');
  const stateSource = extractInlineFunction(html, asset.stateFunction);
  const invocation = asset.currentStoryArgument
    ? `${asset.stateFunction}(story, currentStory, storyValidation)`
    : `${asset.stateFunction}(story, storyValidation)`;
  return runInNewContext(`${passedSource}\n${stateSource}\n${invocation}`, {
    story,
    currentStory,
    storyValidation,
    getRuntime: () => ({ current_story: currentStory }),
  }) as string;
}

function dashboardPassedCount(
  asset: (typeof dashboardAssets)[number],
  stories: DashboardStory[],
  storyValidation: DashboardStoryValidation | null,
): number {
  const html = readDashboardAsset(asset.file);
  const passedSource = extractInlineFunction(html, 'isStoryPassed');
  const countSource = extractInlineFunction(html, 'countPassedStories');
  return runInNewContext(
    `${passedSource}\n${countSource}\ncountPassedStories(stories, storyValidation)`,
    { stories, storyValidation },
  ) as number;
}

function dashboardEffectivePhase(
  asset: (typeof dashboardAssets)[number],
  runtimePhase: string,
  stateCorrupted: boolean,
  storyValidation: DashboardStoryValidation | null,
  reviewCompletion: DashboardReviewCompletion | null = { current: true, reason: null },
): string {
  const html = readDashboardAsset(asset.file);
  const phaseSource = extractInlineFunction(html, 'effectiveDashboardPhase');
  return runInNewContext(
    `${phaseSource}\neffectiveDashboardPhase(runtimePhase, stateCorrupted, storyValidation, reviewCompletion)`,
    { runtimePhase, stateCorrupted, storyValidation, reviewCompletion },
  ) as string;
}

describe.each(dashboardAssets)('$label dashboard published-state contract', (asset) => {
  const story = (over: Partial<DashboardStory> = {}): DashboardStory => ({
    id: 'US-001',
    passes: false,
    validated: false,
    notes: '',
    retryCount: 0,
    blocked: false,
    ...over,
  });

  it('按 active/blocked/passed/awaiting/failed/pending 状态矩阵分类', () => {
    expect(dashboardState(asset, story(), 'US-001')).toBe('active');
    expect(dashboardState(asset, story({ blocked: true }))).toBe('blocked');
    expect(dashboardState(asset, story({ passes: true, validated: true }))).toBe('passed');
    expect(dashboardState(asset, story({ passes: true, validated: false }))).toBe('awaiting');
    expect(dashboardState(asset, story({ retryCount: 1 }))).toBe('failed');
    expect(dashboardState(asset, story())).toBe('pending');
  });

  it('将待验收标记为「待引擎验收」，并真实消费 Story 验收评估结果', () => {
    const html = readDashboardAsset(asset.file);
    expect(html).toMatch(/awaiting\s*:\s*(?:\{[^}]*label\s*:\s*)?['"]待引擎验收['"]/);
    const green = story({ passes: true, validated: true });
    const current: DashboardStoryValidation = {
      gitHead: 'a'.repeat(40),
      current: true,
      invalidStoryIds: [],
      configurationError: null,
    };
    expect(dashboardState(asset, green, null, current)).toBe('passed');
    expect(dashboardPassedCount(asset, [green], current)).toBe(1);

    const invalidIdentity = {
      ...current,
      current: false,
      invalidStoryIds: ['US-001'],
    };
    expect(dashboardState(asset, green, null, invalidIdentity)).toBe('awaiting');
    expect(dashboardPassedCount(asset, [green], invalidIdentity)).toBe(0);

    const configurationError = {
      ...current,
      configurationError: 'userStories 包含重复 Story ID：US-001',
    };
    expect(dashboardState(asset, green, null, configurationError)).toBe('awaiting');
    expect(dashboardPassedCount(asset, [green], configurationError)).toBe(0);
    expect(dashboardState(asset, green, null, null)).toBe('awaiting');
    expect(dashboardPassedCount(asset, [green], null)).toBe(0);

    const anotherStoryIsStale = {
      ...current,
      current: false,
      invalidStoryIds: ['US-002'],
    };
    expect(dashboardState(asset, green, null, anotherStoryIsStale)).toBe('passed');
    expect(html.match(/countPassedStories\(stories, storyValidation\)/g)).toHaveLength(2);
    expect(html).toContain('PRD Story 集合配置错误，验收无法验证');
    if (asset.currentStoryArgument) {
      expect(html).toContain(
        'renderStories(data.stories, data.runtime.current_story, data.storyValidation);',
      );
      expect(html).toContain('renderProgress(data.stories, data.storyValidation);');
    } else {
      expect(html).toContain('const storyValidation = dashboardData.storyValidation;');
      expect(html).toContain('const passedCount = countPassedStories(stories, storyValidation);');
    }
  });

  it('state 损坏时展示 fail-closed 警告', () => {
    const html = readDashboardAsset(asset.file);
    expect(html).toContain('state.json 已损坏');
    expect(html).toContain('stateCorrupted');
  });

  it('只有当前验收状态才能显示绿色完成阶段', () => {
    const current: DashboardStoryValidation = {
      gitHead: 'a'.repeat(40),
      current: true,
      invalidStoryIds: [],
      configurationError: null,
    };
    expect(dashboardEffectivePhase(asset, 'done', false, current)).toBe('done');
    expect(
      dashboardEffectivePhase(asset, 'done', false, {
        ...current,
        current: false,
        invalidStoryIds: ['US-001'],
      }),
    ).toBe('error');
    expect(
      dashboardEffectivePhase(asset, 'done', false, {
        ...current,
        configurationError: 'Story 集合非法',
      }),
    ).toBe('error');
    expect(dashboardEffectivePhase(asset, 'done', false, null)).toBe('error');
    expect(dashboardEffectivePhase(asset, 'done', true, current)).toBe('error');
    expect(
      dashboardEffectivePhase(asset, 'done', false, current, {
        current: false,
        reason: '最终 Review 对应的 Story 验收凭证集合已变化',
      }),
    ).toBe('error');
    expect(dashboardEffectivePhase(asset, 'validating', false, null)).toBe('validating');
    expect(dashboardEffectivePhase(asset, 'blocked', false, current, null)).toBe('blocked');
    expect(dashboardEffectivePhase(asset, 'shadow', false, current, null)).toBe('shadow');
  });

  it('展示统一的 workspace 安全分类、摘要与处理提示', () => {
    const html = readDashboardAsset(asset.file);
    expect(html).toContain('workspaceSafety');
    expect(html).toContain('display.label');
    expect(html).toContain('display.summary');
    expect(html).toContain('display.guidance');
  });
});

describe('buildApiResponse', () => {
  it.runIf(process.platform !== 'win32')(
    '异步入口遇到特殊状态文件时不会阻塞或保留旧绿灯',
    async () => {
      const ws = tempWorkspace();
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim();
      const observation = readyStoryValidationObservation(ws, head);
      for (const filename of ['state.json', 'progress.md', 'final-review.json']) {
        rmSync(join(ws, filename), { force: true });
        execFileSync('mkfifo', [join(ws, filename)]);
      }
      configureWorkspace(ws, 50, process.cwd(), async () => observation);

      const response = await buildApiResponseWithWorkspaceSafety();

      expect(response.stateCorrupted).toBe(true);
      expect(response.storyValidation.current).toBe(false);
      expect(response.reviewCompletion.current).toBe(false);
      expect(response.logs).toBe('');
      expect(response.stories[0]?.validated).not.toBe(true);
    },
  );

  it.runIf(process.platform !== 'win32')(
    '异步入口遇到 PRD FIFO 时返回不可验证视图而不等待写端',
    async () => {
      const ws = tempWorkspace();
      const head = execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim();
      const observation = readyStoryValidationObservation(ws, head);
      rmSync(join(ws, 'prd.json'));
      execFileSync('mkfifo', [join(ws, 'prd.json')]);
      configureWorkspace(ws, 50, process.cwd(), async () => observation);

      const response = await buildApiResponseWithWorkspaceSafety();

      expect(response.project).toBe('');
      expect(response.stories).toEqual([]);
      expect(response.storyValidation.current).toBe(false);
    },
  );

  it('只有绑定当前 HEAD 和整组 Story 凭证的可交付 Review 才保持完成态', () => {
    const head = 'a'.repeat(40);
    const receiptSet = `sha256:${'b'.repeat(64)}`;
    const ready = {
      status: 'ready',
      state: {
        status: 'passed',
        deliveryStatus: 'ready',
        shadow: false,
        binding: {
          headSha: head,
          storyValidationDigest: receiptSet,
          reviewRulesVersion: REVIEW_RULES_VERSION,
          reviewRulesDigest: REVIEW_RULES_DIGEST,
        },
      },
    } as unknown as Parameters<typeof evaluateDashboardReviewCompletion>[0];

    expect(evaluateDashboardReviewCompletion(ready, head, receiptSet)).toEqual({
      current: true,
      reason: null,
    });
    expect(
      evaluateDashboardReviewCompletion(ready, head, `sha256:${'c'.repeat(64)}`),
    ).toMatchObject({
      current: false,
      reason: '最终 Review 对应的 Story 验收凭证集合已变化',
    });
    expect(evaluateDashboardReviewCompletion(ready, 'd'.repeat(40), receiptSet)).toMatchObject({
      current: false,
      reason: '最终 Review 对应的提交已变化',
    });
    const staleVersion = structuredClone(ready) as Extract<ReviewStateRead, { status: 'ready' }>;
    staleVersion.state.binding.reviewRulesVersion = '1.3.0';
    expect(evaluateDashboardReviewCompletion(staleVersion, head, receiptSet)).toMatchObject({
      current: false,
      reason: '最终 Review 使用的规则已变化',
    });
    const staleDigest = structuredClone(ready) as Extract<ReviewStateRead, { status: 'ready' }>;
    staleDigest.state.binding.reviewRulesDigest = `sha256:${'d'.repeat(64)}`;
    expect(evaluateDashboardReviewCompletion(staleDigest, head, receiptSet)).toMatchObject({
      current: false,
      reason: '最终 Review 使用的规则已变化',
    });
    expect(evaluateDashboardReviewCompletion({ status: 'missing' }, head, receiptSet)).toEqual({
      current: false,
      reason: '最终 Review 尚未完成',
    });
  });

  it('同步读取没有受管观察时保留实现候选，但撤销全部验收绿灯', () => {
    const ws = tempWorkspace();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(ws, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head,
          validationReceipt: {
            schemaVersion: 4,
            requestId: 'offline-dashboard-receipt',
            gitHead: head,
            acceptanceHash: acceptanceHash('US-001', []),
            validationEnvironmentDigest: TEST_VALIDATION_ENVIRONMENT,
            runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
            canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
            storyBaseGitHead: head,
            changeManifestDigest: `sha256:${'a'.repeat(64)}`,
            changedPathCount: 1,
          },
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    configureWorkspace(ws, 50);
    setState({ iteration: 3, phase: 'validating', currentStory: 'US-001' });
    const r = buildApiResponse();
    expect(r.runtime.iteration).toBe(3);
    expect(r.runtime.phase).toBe('validating');
    expect(r.project).toBe('任务应用');
    expect(r.branchName).toBe('ralph/x');
    expect(r.sourcePrd).toBe('docs/prds/prd-x.md');
    expect(r.stories.length).toBe(1);
    expect(r.stories[0].passes).toBe(true); // 状态来自 state.json
    expect(r.stories[0].validated).toBe(false);
    expect(r.stories[0].validationReceipt).toBeNull();
    expect(r.storyValidation).toEqual({
      gitHead: head,
      current: false,
      invalidStoryIds: ['US-001'],
      configurationError: 'Dashboard 未获得活跃受管 Story 当前性观察',
    });
    expect(r.logs).toContain('US-001');
  });

  it('异步读取注入当前受管观察后可以展示当前验收结果', async () => {
    const ws = tempWorkspace();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(ws, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head,
          validationReceipt: {
            schemaVersion: 4,
            requestId: 'managed-dashboard-receipt',
            gitHead: head,
            acceptanceHash: acceptanceHash('US-001', []),
            validationEnvironmentDigest: TEST_VALIDATION_ENVIRONMENT,
            runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
            canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
            storyBaseGitHead: head,
            changeManifestDigest: `sha256:${'a'.repeat(64)}`,
            changedPathCount: 1,
          },
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const observation = readyStoryValidationObservation(ws, head);
    const observer = vi.fn(async () => observation);
    configureWorkspace(ws, 50, process.cwd(), observer);

    const response = await buildApiResponseWithWorkspaceSafety();

    expect(observer).toHaveBeenCalledOnce();
    expect(response.storyValidation).toEqual({
      gitHead: head,
      current: true,
      invalidStoryIds: [],
      configurationError: null,
    });
    expect(response.stories[0]).toMatchObject({
      passes: true,
      validated: true,
      validationReceipt: observation.state['US-001'].validationReceipt,
    });
  });

  it.each([
    ['其他 workspace', 'workspace', 'Story 当前性观察来自其他 workspace'],
    ['旧 PRD', 'prd', 'Story 当前性观察后 prd.json 已变化'],
  ] as const)('受管观察绑定%s时失败关闭', async (_label, mismatch, expectedError) => {
    const ws = tempWorkspace();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(ws, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head,
          validationReceipt: {
            schemaVersion: 4,
            requestId: 'mismatched-dashboard-receipt',
            gitHead: head,
            acceptanceHash: acceptanceHash('US-001', []),
            validationEnvironmentDigest: TEST_VALIDATION_ENVIRONMENT,
            runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
            canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
            storyBaseGitHead: head,
            changeManifestDigest: `sha256:${'a'.repeat(64)}`,
            changedPathCount: 1,
          },
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const observation = readyStoryValidationObservation(ws, head);
    const mismatchedObservation =
      mismatch === 'workspace'
        ? { ...observation, workspacePath: tempWorkspace() }
        : { ...observation, prd: { ...observation.prd, description: '观察后的旧描述' } };
    configureWorkspace(ws, 50, process.cwd(), async () => mismatchedObservation);

    const response = await buildApiResponseWithWorkspaceSafety();

    expect(response.stories[0]).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
    expect(response.storyValidation).toEqual({
      gitHead: head,
      current: false,
      invalidStoryIds: ['US-001'],
      configurationError: expectedError,
    });
  });

  it('观察完成后 state、HEAD 或质量契约变化时撤销旧绿灯', async () => {
    const ws = tempWorkspace();
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    const writePassedState = (gitHead: string, requestId: string) => {
      writeFileSync(
        join(ws, 'state.json'),
        JSON.stringify({
          'US-001': {
            passes: true,
            validated: true,
            storyBaseGitHead: gitHead,
            validationReceipt: {
              schemaVersion: 4,
              requestId,
              gitHead,
              acceptanceHash: acceptanceHash('US-001', []),
              validationEnvironmentDigest: TEST_VALIDATION_ENVIRONMENT,
              runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
              canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
              storyBaseGitHead: gitHead,
              changeManifestDigest: `sha256:${'a'.repeat(64)}`,
              changedPathCount: 1,
            },
            notes: '',
            retryCount: 0,
            blocked: false,
            escalated: false,
          },
        }),
      );
    };

    writePassedState(head, 'before-state-change');
    const beforeStateChange = readyStoryValidationObservation(ws, head);
    writePassedState(head, 'after-state-change');
    configureWorkspace(ws, 50, process.cwd(), async () => beforeStateChange);
    const stateResponse = await buildApiResponseWithWorkspaceSafety();
    expect(stateResponse.stories[0].validated).toBe(false);
    expect(stateResponse.storyValidation.configurationError).toContain('state.json 已变化');

    const staleHead = 'c'.repeat(40);
    writePassedState(staleHead, 'head-change');
    const beforeHeadChange = readyStoryValidationObservation(ws, staleHead);
    configureWorkspace(ws, 50, process.cwd(), async () => beforeHeadChange);
    const headResponse = await buildApiResponseWithWorkspaceSafety();
    expect(headResponse.stories[0].validated).toBe(false);
    expect(headResponse.storyValidation.configurationError).toContain('Git HEAD 已变化');

    writePassedState(head, 'contract-change');
    const beforeContractChange = readyStoryValidationObservation(ws, head);
    configureWorkspace(ws, 50, process.cwd(), async () => ({
      ...beforeContractChange,
      workingContractDigest: `sha256:${'0'.repeat(64)}`,
    }));
    const contractResponse = await buildApiResponseWithWorkspaceSafety();
    expect(contractResponse.stories[0].validated).toBe(false);
    expect(contractResponse.storyValidation.configurationError).toContain('质量契约已变化');
  });

  it('非法空 Story 集合不能显示为当前验收结果', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-empty-stories-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = join(root, '.workspace');
    mkdirSync(ws);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'coding-x test');
    git('config', 'user.email', 'coding-x@example.test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'tracked.txt'), 'initial\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'initial');
    const head = git('rev-parse', 'HEAD');
    writeFileSync(
      join(ws, 'prd.json'),
      JSON.stringify({
        project: 'empty-stories',
        branchName: 'feature/empty',
        description: 'd',
        userStories: [],
      }),
    );
    writeFileSync(join(ws, 'state.json'), '{}');
    writeFileSync(join(ws, 'progress.md'), '');

    configureWorkspace(ws, 50, root);
    expect(buildApiResponse().storyValidation).toEqual({
      gitHead: head,
      current: false,
      invalidStoryIds: [],
      configurationError: 'prd.json 必须包含至少一个 Story',
    });
  });

  it('非法 Story 元素不会让 dashboard API 崩溃，而是返回配置错误', () => {
    const ws = tempWorkspace();
    writeFileSync(
      join(ws, 'prd.json'),
      JSON.stringify({
        project: 'malformed-stories',
        branchName: 'feature/malformed',
        description: 'd',
        userStories: [null],
      }),
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();

    configureWorkspace(ws, 50, process.cwd());
    const response = buildApiResponse();
    expect(response.stories).toEqual([]);
    expect(response.storyValidation).toEqual({
      gitHead: head,
      current: false,
      invalidStoryIds: [],
      configurationError: 'userStories[0] 的 Story ID 非法',
    });
  });

  it('userStories 不是数组时 dashboard API 返回配置错误而不是 500', () => {
    const ws = tempWorkspace();
    writeFileSync(
      join(ws, 'prd.json'),
      JSON.stringify({
        project: 'non-array-stories',
        branchName: 'feature/non-array',
        description: 'd',
        userStories: {},
      }),
    );
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();

    configureWorkspace(ws, 50, process.cwd());
    const response = buildApiResponse();
    expect(response.stories).toEqual([]);
    expect(response.storyValidation).toEqual({
      gitHead: head,
      current: false,
      invalidStoryIds: [],
      configurationError: 'prd.json 必须包含至少一个 Story',
    });
  });

  it('重复 Story ID 时 API 撤销全部绿灯、暴露配置错误且不改写状态文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-duplicate-stories-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = join(root, '.workspace');
    mkdirSync(ws);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'coding-x test');
    git('config', 'user.email', 'coding-x@example.test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'tracked.txt'), 'initial\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'initial');
    const head = git('rev-parse', 'HEAD');
    const duplicateStory = {
      id: 'US-001',
      title: 'duplicate',
      description: 'd',
      acceptanceCriteria: ['ac'],
      priority: 1,
    };
    writeFileSync(
      join(ws, 'prd.json'),
      JSON.stringify({
        project: 'duplicate-stories',
        branchName: 'feature/duplicate',
        description: 'd',
        userStories: [duplicateStory, { ...duplicateStory }],
      }),
    );
    const persisted = {
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt: {
          schemaVersion: 1,
          requestId: 'duplicate-dashboard-receipt',
          gitHead: head,
          acceptanceHash: acceptanceHash('US-001', ['ac']),
        },
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    writeFileSync(join(ws, 'state.json'), JSON.stringify(persisted));
    writeFileSync(join(ws, 'progress.md'), '');

    configureWorkspace(ws, 50, root);
    const response = buildApiResponse();
    expect(response.stories).toHaveLength(2);
    expect(response.stories.every((item) => item.passes && !item.validated)).toBe(true);
    expect(response.storyValidation).toEqual({
      gitHead: head,
      current: false,
      invalidStoryIds: ['US-001'],
      configurationError: 'userStories 包含重复 Story ID：US-001',
    });
    expect(JSON.parse(readFileSync(join(ws, 'state.json'), 'utf8'))).toEqual(persisted);
  });

  it('离线同步路径不尝试自行重建当前性观察', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-head-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = join(root, '.workspace');
    mkdirSync(ws);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'coding-x test');
    git('config', 'user.email', 'coding-x@example.test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'tracked.txt'), 'first\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'first');
    const receiptHead = git('rev-parse', 'HEAD');
    writeFileSync(
      join(ws, 'prd.json'),
      JSON.stringify({
        project: 'head-currentness',
        branchName: 'feature/head',
        description: 'd',
        userStories: [
          {
            id: 'US-001',
            title: 't',
            description: 'd',
            acceptanceCriteria: ['ac'],
            priority: 1,
          },
        ],
      }),
    );
    const persisted = {
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt: {
          schemaVersion: 1,
          requestId: 'dashboard-receipt',
          gitHead: receiptHead,
          acceptanceHash: acceptanceHash('US-001', ['ac']),
        },
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    writeFileSync(join(ws, 'state.json'), JSON.stringify(persisted));
    writeFileSync(join(ws, 'progress.md'), '');
    writeFileSync(join(root, 'tracked.txt'), 'second\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'second');
    const currentHead = git('rev-parse', 'HEAD');

    configureWorkspace(ws, 50, root);
    const response = buildApiResponse();

    expect(response.stories[0]).toMatchObject({ passes: true, validated: false });
    expect(response.storyValidation).toEqual({
      gitHead: currentHead,
      current: false,
      invalidStoryIds: [],
      configurationError: 'Dashboard 未获得活跃受管 Story 当前性观察',
    });
    expect(JSON.parse(readFileSync(join(ws, 'state.json'), 'utf8'))).toEqual(persisted);
  });

  it('离线同步路径对混合 Story 也不猜测任何验收绿灯', () => {
    const root = mkdtempSync(join(tmpdir(), 'dashboard-mixed-head-'));
    cleanup.push(() => rmSync(root, { recursive: true, force: true }));
    const ws = join(root, '.workspace');
    mkdirSync(ws);
    const git = (...args: string[]) =>
      execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
    git('init', '-q');
    git('config', 'user.name', 'coding-x test');
    git('config', 'user.email', 'coding-x@example.test');
    git('config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'tracked.txt'), 'first\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'first');
    const oldHead = git('rev-parse', 'HEAD');
    writeFileSync(join(root, 'tracked.txt'), 'second\n');
    git('add', 'tracked.txt');
    git('commit', '-qm', 'second');
    const currentHead = git('rev-parse', 'HEAD');
    const stories = [
      { id: 'US-001', title: 'stale', description: 'd', acceptanceCriteria: ['ac-1'], priority: 1 },
      {
        id: 'US-002',
        title: 'current',
        description: 'd',
        acceptanceCriteria: ['ac-2'],
        priority: 2,
      },
      {
        id: 'US-003',
        title: 'unfinished',
        description: 'd',
        acceptanceCriteria: ['ac-3'],
        priority: 3,
      },
    ];
    writeFileSync(
      join(ws, 'prd.json'),
      JSON.stringify({
        project: 'mixed-head-currentness',
        branchName: 'feature/mixed-head',
        description: 'd',
        userStories: stories,
      }),
    );
    const persisted = {
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt: {
          schemaVersion: 1,
          requestId: 'stale-dashboard-receipt',
          gitHead: oldHead,
          acceptanceHash: acceptanceHash('US-001', ['ac-1']),
        },
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-002': {
        passes: true,
        validated: true,
        validationReceipt: {
          schemaVersion: 1,
          requestId: 'current-dashboard-receipt',
          gitHead: currentHead,
          acceptanceHash: acceptanceHash('US-002', ['ac-2']),
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
    writeFileSync(join(ws, 'state.json'), JSON.stringify(persisted));
    writeFileSync(join(ws, 'progress.md'), '');

    configureWorkspace(ws, 50, root);
    const response = buildApiResponse();

    expect(
      response.stories.map(({ id, passes, validated, validationReceipt }) => ({
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
        validated: false,
        validationReceipt: null,
      },
      { id: 'US-003', passes: false, validated: false, validationReceipt: null },
    ]);
    expect(response.storyValidation).toEqual({
      gitHead: currentHead,
      current: false,
      invalidStoryIds: [],
      configurationError: 'Dashboard 未获得活跃受管 Story 当前性观察',
    });
    expect(JSON.parse(readFileSync(join(ws, 'state.json'), 'utf8'))).toEqual(persisted);
  });

  it('falls back to legacy in-story state when state.json is absent (v0.4 workspace)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-legacy-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, 'prd.json'),
      JSON.stringify({
        project: 'p',
        branchName: 'ralph/x',
        description: 'd',
        userStories: [
          {
            id: 'US-001',
            title: 't',
            description: 'd',
            acceptanceCriteria: [],
            priority: 1,
            passes: true,
            notes: '',
            retryCount: 0,
            blocked: false,
          },
        ],
      }),
    );
    writeFileSync(join(dir, 'progress.md'), '');
    configureWorkspace(dir, 50);
    const r = buildApiResponse();
    expect(r.stateCorrupted).toBe(false);
    expect(r.stories[0].passes).toBe(true);
    expect(r.stories[0].validated).toBe(false);
  });

  it('fails closed and exposes a warning flag when state.json exists but is corrupt', () => {
    const dir = mkdtempSync(join(tmpdir(), 'ws-corrupt-'));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, 'prd.json'),
      JSON.stringify({
        project: 'p',
        branchName: 'ralph/x',
        description: 'd',
        userStories: [
          {
            id: 'US-001',
            title: 't',
            description: 'd',
            acceptanceCriteria: [],
            priority: 1,
            passes: true,
            notes: '旧备注',
            retryCount: 2,
            blocked: false,
          },
        ],
      }),
    );
    writeFileSync(join(dir, 'state.json'), '{ broken');
    writeFileSync(join(dir, 'progress.md'), '');
    configureWorkspace(dir, 50);
    const r = buildApiResponse();
    expect(r.stateCorrupted).toBe(true);
    expect(r.stories[0]).toMatchObject({
      passes: false,
      validated: false,
      notes: '',
      retryCount: 0,
      blocked: false,
    });
  });

  it('exposes the current actual route in runtime and defaults it to null', () => {
    setState({
      phase: 'developing',
      model: 'opus',
      routeSource: 'difficulty',
      storyDifficulty: 'high',
      runner: 'claude',
    });
    expect(buildApiResponse().runtime.model).toBe('opus');
    expect(buildApiResponse().runtime.route_source).toBe('difficulty');
    expect(buildApiResponse().runtime.story_difficulty).toBe('high');
    expect(buildApiResponse().runtime.runner).toBe('claude');
    setState({ model: null, routeSource: null, storyDifficulty: null });
    expect(buildApiResponse().runtime.model).toBe(null);
  });

  it('exposes the complete configured routing separately from the actual route', () => {
    const ws = tempWorkspace();
    const path = join(ws, 'prd.json');
    const prd = JSON.parse(readFileSync(path, 'utf-8')) as Record<string, unknown>;
    prd.models = {
      runner: 'codex',
      builder: { low: 'lo', medium: 'mid', high: 'hi' },
      validator: 'val',
      escalation: 'esc',
    };
    (prd.userStories as Array<Record<string, unknown>>)[0].difficulty = 'medium';
    (prd.userStories as Array<Record<string, unknown>>)[0].difficultyReason = '命中 medium-1';
    writeFileSync(path, JSON.stringify(prd));
    configureWorkspace(ws, 50);
    expect(buildApiResponse().modelRouting).toMatchObject({
      status: 'enabled',
      config: { runner: 'codex', validator: 'val', escalation: 'esc' },
    });
  });
});

describe('start', () => {
  it('serves /api/state as JSON', async () => {
    const ws = tempWorkspace();
    const pub = mkdtempSync(join(tmpdir(), 'pub-'));
    cleanup.push(() => rmSync(pub, { recursive: true, force: true }));
    mkdirSync(pub, { recursive: true });
    writeFileSync(join(pub, 'dashboard.html'), '<html>main</html>');
    writeFileSync(join(pub, 'dashboard-p.html'), '<html>pixel</html>');

    const srv = start({ workspace: ws, maxIterations: 50, port: 0, publicDir: pub });
    cleanup.push(() => srv.close());
    const addr = await srv.ready;
    expect(srv.address()).toEqual(addr);
    const res = await fetch(`http://127.0.0.1:${addr.port}/api/state`);
    const body = await res.json();
    expect(body.runtime.max_iterations).toBe(50);
    expect(body.workspaceSafety).toMatchObject({
      status: 'legacy',
      observedClassification: 'legacy',
      probeEvidence: 'system',
      display: { label: '旧版工作区' },
    });
    expect(body.stories[0]).toMatchObject({ passes: true, validated: false });
    expect(body.storyValidation).toMatchObject({
      current: false,
      invalidStoryIds: [],
      configurationError: 'Dashboard 未获得活跃受管 Story 当前性观察',
    });
    expect(res.headers.get('content-type')).toContain('application/json');
    expect(res.headers.get('access-control-allow-origin')).toBe('*');
  });

  it('通过 start 注入的受管观察驱动 HTTP API 当前结果', async () => {
    const ws = tempWorkspace();
    const pub = mkdtempSync(join(tmpdir(), 'pub-observed-'));
    cleanup.push(() => rmSync(pub, { recursive: true, force: true }));
    mkdirSync(pub, { recursive: true });
    writeFileSync(join(pub, 'dashboard.html'), '<html>main</html>');
    writeFileSync(join(pub, 'dashboard-p.html'), '<html>pixel</html>');
    const head = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim();
    writeFileSync(
      join(ws, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head,
          validationReceipt: {
            schemaVersion: 4,
            requestId: 'start-dashboard-receipt',
            gitHead: head,
            acceptanceHash: acceptanceHash('US-001', []),
            validationEnvironmentDigest: TEST_VALIDATION_ENVIRONMENT,
            runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
            canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
            storyBaseGitHead: head,
            changeManifestDigest: `sha256:${'a'.repeat(64)}`,
            changedPathCount: 1,
          },
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const observer = vi.fn(async () => readyStoryValidationObservation(ws, head));
    const srv = start({
      workspace: ws,
      maxIterations: 50,
      projectRoot: process.cwd(),
      port: 0,
      publicDir: pub,
      storyValidationObserver: observer,
    });
    cleanup.push(() => srv.close());
    const addr = await srv.ready;

    const res = await fetch(`http://127.0.0.1:${addr.port}/api/state`);
    const body = await res.json();

    expect(observer).toHaveBeenCalledOnce();
    expect(body.storyValidation).toEqual({
      gitHead: head,
      current: true,
      invalidStoryIds: [],
      configurationError: null,
    });
    expect(body.stories[0]).toMatchObject({ passes: true, validated: true });
  });

  it('keeps dashboard asset failures out of the HTTP response', async () => {
    const ws = tempWorkspace();
    const pub = mkdtempSync(join(tmpdir(), 'pub-missing-'));
    cleanup.push(() => rmSync(pub, { recursive: true, force: true }));
    const log = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const srv = start({ workspace: ws, maxIterations: 50, port: 0, publicDir: pub });
    cleanup.push(() => srv.close());
    const addr = await srv.ready;
    const res = await fetch(`http://127.0.0.1:${addr.port}/`);
    const body = await res.text();

    expect(res.status).toBe(500);
    expect(res.headers.get('content-type')).toContain('text/plain');
    expect(body).toBe('Internal Server Error');
    expect(body).not.toContain(pub);
    expect(body).not.toContain('ENOENT');
    expect(log).toHaveBeenCalledOnce();
  });

  it('lets the OS allocate unique ephemeral ports for concurrent dashboards', async () => {
    const ws = tempWorkspace();
    const pub = mkdtempSync(join(tmpdir(), 'pub-concurrent-'));
    cleanup.push(() => rmSync(pub, { recursive: true, force: true }));
    writeFileSync(join(pub, 'dashboard.html'), '<html>main</html>');
    writeFileSync(join(pub, 'dashboard-p.html'), '<html>pixel</html>');

    const servers = Array.from({ length: 12 }, () =>
      start({ workspace: ws, maxIterations: 50, port: 0, publicDir: pub }),
    );
    cleanup.push(() => servers.forEach((server) => server.close()));
    const addresses = await Promise.all(servers.map((server) => server.ready));

    expect(new Set(addresses.map(({ port }) => port)).size).toBe(servers.length);
  });
});
