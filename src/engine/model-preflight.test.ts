import { describe, expect, it } from 'vitest';
import { ModelPreflightError, preflightModelRouting, renderPreflightSummary, resolveRunKind } from './model-preflight.js';
import type { ModelCatalogResult } from './model-catalog.js';
import type { Prd } from './prd.js';
import type { RunState } from './state.js';

const models = {
  runner: 'codex' as const,
  builder: { low: 'low-m', medium: 'mid-m', high: 'high-m' },
  validator: 'val-m', escalation: 'esc-m',
};

const prd = (difficulty: 'low' | 'medium' | 'high' = 'medium'): Prd => ({
  project: 'p', branchName: 'b', description: 'd', models,
  userStories: [{
    id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1,
    difficulty, difficultyReason: `命中 ${difficulty}-1：见 src/x.ts。`,
  }],
});

const state = (over: Partial<RunState[string]> = {}): RunState => ({
  'US-001': {
    passes: false,
    validated: false,
    validationReceipt: null,
    notes: '',
    retryCount: 0,
    blocked: false,
    escalated: false,
    ...over,
  },
});

const available = (...ids: string[]): ModelCatalogResult => ({
  status: 'available', runner: 'codex', source: 'global-config', configPath: '/fixture/config.json',
  models: ids.map((id) => ({ id })),
});

describe('resolveRunKind', () => {
  it('uses models.runner when runner was omitted and preserves historical requested default without models', () => {
    expect(resolveRunKind(models, 'claude', false)).toBe('codex');
    expect(resolveRunKind(null, 'claude', false)).toBe('claude');
  });

  it('rejects an explicit mismatch', () => {
    expect(() => resolveRunKind(models, 'claude', true)).toThrow(ModelPreflightError);
    expect(resolveRunKind(models, 'codex', true)).toBe('codex');
  });
});

describe('preflightModelRouting', () => {
  it('在读取目录前拒绝空白 CLI 模型标识', async () => {
    let called = false;
    await expect(preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: '   ', catalog: async () => { called = true; return available(); },
    })).rejects.toThrow('--builder-model');
    expect(called).toBe(false);
  });

  it('skips the global catalog for zero-config historical runs', async () => {
    const plain = { ...prd(), models: undefined };
    for (const story of plain.userStories) {
      delete story.difficulty;
      delete story.difficultyReason;
    }
    let called = false;
    const result = await preflightModelRouting({
      prd: plain, state: state(), requestedRunner: 'claude', runnerExplicit: false,
      catalog: async () => { called = true; return available(); },
    });
    expect(called).toBe(false);
    expect(result.catalog.status).toBe('skipped');
  });

  it('validates all effective initial, escalation and validator routes', async () => {
    const result = await preflightModelRouting({
      prd: prd('low'), state: state(), requestedRunner: 'claude', runnerExplicit: false,
      catalog: async () => available('low-m', 'esc-m', 'val-m'),
    });
    expect(result.runner).toBe('codex');
    expect(result.storyRoutes[0]).toMatchObject({
      difficulty: 'low', currentBuilder: { model: 'low-m' }, escalationBuilder: { model: 'esc-m' },
    });
  });

  it.each([
    ['current builder', ['esc-m', 'val-m'], 'low-m'],
    ['escalation', ['low-m', 'val-m'], 'esc-m'],
    ['validator', ['low-m', 'esc-m'], 'val-m'],
  ] as const)('rejects a missing effective %s model', async (_route, configured, missing) => {
    await expect(preflightModelRouting({
      prd: prd('low'), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      catalog: async () => available(...configured),
    })).rejects.toThrow(missing);
  });

  it('rejects a missing effective model including a CLI model', async () => {
    await expect(preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: 'cli-b', catalog: async () => available('esc-m', 'val-m'),
    })).rejects.toThrow('cli-b');
  });

  it('requires the global catalog for a CLI-only model override', async () => {
    const plain = { ...prd(), models: undefined };
    for (const story of plain.userStories) {
      delete story.difficulty;
      delete story.difficultyReason;
    }
    await expect(preflightModelRouting({
      prd: plain, state: state(), requestedRunner: 'claude', runnerExplicit: false,
      builderOverride: 'cli-b',
      catalog: async () => ({
        status: 'error', runner: 'claude', configPath: '/missing/config.json',
        error: '未找到全局模型配置',
      }),
    })).rejects.toThrow('未找到全局模型配置');
  });

  it('does not let CLI overrides bypass the catalog when prd.json is unavailable', async () => {
    await expect(preflightModelRouting({
      prd: null, state: null, requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: 'cli-b', validatorOverride: 'cli-v', escalationOverride: 'cli-e',
      catalog: async () => available('some-other-model'),
    })).rejects.toThrow('cli-b');
  });

  it('warns instead of failing for unavailable config fully shadowed by CLI', async () => {
    const result = await preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: 'cli-b', validatorOverride: 'cli-v', escalationOverride: 'cli-e',
      catalog: async () => available('cli-b', 'cli-v', 'cli-e'),
    });
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join('\n')).toContain('重新运行 prd-to-json');
    expect(renderPreflightSummary(result)).toContain('builder=cli-b');
    expect(renderPreflightSummary(result)).toContain('validator=cli-v');
    expect(renderPreflightSummary(result)).toContain('escalation=cli-e');
  });

  it('fails on catalog errors, runner mismatch and invalid schemas before routing', async () => {
    await expect(preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      catalog: async () => ({
        status: 'error', runner: 'codex', error: '全局配置缺失', configPath: '/missing/config.json',
      }),
    })).rejects.toThrow('全局配置缺失');
    await expect(preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      catalog: async () => ({
        status: 'available', runner: 'claude', source: 'global-config', configPath: '/fixture/config.json',
        models: [],
      }),
    })).rejects.toThrow('全局模型目录 runner 错配：期望 codex，收到 claude');
    await expect(preflightModelRouting({
      prd: { ...prd(), models: 'old' } as unknown as Prd,
      state: state(), requestedRunner: 'codex', runnerExplicit: true,
    })).rejects.toThrow('models 形状非法');
  });

  it('validates only escalation for an already escalated story, plus validator', async () => {
    const result = await preflightModelRouting({
      prd: prd(), state: state({ escalated: true }), requestedRunner: 'codex', runnerExplicit: true,
      catalog: async () => available('esc-m', 'val-m'),
    });
    expect(result.storyRoutes[0].currentBuilder.model).toBe('esc-m');
  });

  it('does not report the initial config builder as CLI-shadowed for an already escalated story', async () => {
    const result = await preflightModelRouting({
      prd: prd(), state: state({ escalated: true }), requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: 'cli-b', catalog: async () => available('esc-m', 'val-m'),
    });
    expect(result.storyRoutes[0].currentBuilder).toMatchObject({ model: 'esc-m', source: 'escalation' });
    expect(result.warnings).toEqual([]);
  });

  it('skips the final reviewer catalog when blocked convergence cannot enter Review', async () => {
    let called = false;
    const result = await preflightModelRouting({
      prd: prd(), state: state({ blocked: true }), requestedRunner: 'codex', runnerExplicit: true,
      reviewRequired: false,
      catalog: async () => { called = true; return available('val-m'); },
    });
    expect(result.storyRoutes).toEqual([]);
    expect(result.catalog.status).toBe('skipped');
    expect(result.review.model).toBe('val-m');
    expect(called).toBe(false);
  });

  it('已收敛 workspace 仍校验 schema、runner 与即将调用的 final reviewer', async () => {
    let called = false;
    const result = await preflightModelRouting({
      prd: prd(),
      state: state({
        passes: true,
        validated: true,
        validationReceipt: {
          schemaVersion: 1,
          requestId: 'resolved-fixture',
          gitHead: 'a'.repeat(40),
          acceptanceHash: `sha256:${'b'.repeat(64)}`,
        },
      }),
      requestedRunner: 'claude',
      runnerExplicit: false,
      catalog: async () => { called = true; return available('val-m'); },
    });
    expect(result.runner).toBe('codex');
    expect(result.catalog.status).toBe('available');
    expect(result.review.model).toBe('val-m');
    expect(called).toBe(true);
  });

  it('纯重验只要求 Validator 与 Final Reviewer，不要求 Builder 或 escalation', async () => {
    let called = false;
    const result = await preflightModelRouting({
      prd: prd(), state: state({ passes: true, validated: false }),
      requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: 'not-in-catalog-builder',
      escalationOverride: 'not-in-catalog-escalation',
      catalog: async () => { called = true; return available('val-m'); },
    });
    expect(result.storyRoutes).toHaveLength(1);
    expect(result.storyRoutes[0].mode).toBe('validation-only');
    expect(result.validator.model).toBe('val-m');
    expect(result.review.model).toBe('val-m');
    expect(result.warnings).toEqual([]);
    expect(called).toBe(true);
  });
});
