import { describe, expect, it } from 'vitest';
import { ModelPreflightError, preflightModelRouting, renderPreflightSummary, resolveRunKind } from './model-preflight.js';
import type { ModelDiscoveryResult } from './model-discovery.js';
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
  'US-001': { passes: false, notes: '', retryCount: 0, blocked: false, escalated: false, ...over },
});

const available = (...ids: string[]): ModelDiscoveryResult => ({
  status: 'available', runner: 'codex', source: 'fixture', models: ids.map((id) => ({ id })),
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
  it('在调用探测前拒绝空白 CLI 模型标识', async () => {
    let called = false;
    await expect(preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: '   ', discover: async () => { called = true; return available(); },
    })).rejects.toThrow('--builder-model');
    expect(called).toBe(false);
  });

  it('skips discovery for zero-config historical runs', async () => {
    const plain = { ...prd(), models: undefined };
    for (const story of plain.userStories) {
      delete story.difficulty;
      delete story.difficultyReason;
    }
    let called = false;
    const result = await preflightModelRouting({
      prd: plain, state: state(), requestedRunner: 'claude', runnerExplicit: false,
      discover: async () => { called = true; return available(); },
    });
    expect(called).toBe(false);
    expect(result.discovery.status).toBe('skipped');
  });

  it('validates all effective initial, escalation and validator routes', async () => {
    const result = await preflightModelRouting({
      prd: prd('low'), state: state(), requestedRunner: 'claude', runnerExplicit: false,
      discover: async () => available('low-m', 'esc-m', 'val-m'),
    });
    expect(result.runner).toBe('codex');
    expect(result.storyRoutes[0]).toMatchObject({
      difficulty: 'low', currentBuilder: { model: 'low-m' }, escalationBuilder: { model: 'esc-m' },
    });
  });

  it('rejects a missing effective model including a CLI model', async () => {
    await expect(preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: 'cli-b', discover: async () => available('esc-m', 'val-m'),
    })).rejects.toThrow('cli-b');
  });

  it('warns instead of failing for unavailable config fully shadowed by CLI', async () => {
    const result = await preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      builderOverride: 'cli-b', validatorOverride: 'cli-v', escalationOverride: 'cli-e',
      discover: async () => available('cli-b', 'cli-v', 'cli-e'),
    });
    expect(result.warnings).toHaveLength(3);
    expect(result.warnings.join('\n')).toContain('重新运行 prd-to-json');
    expect(renderPreflightSummary(result)).toContain('builder=cli-b');
    expect(renderPreflightSummary(result)).toContain('validator=cli-v');
    expect(renderPreflightSummary(result)).toContain('escalation=cli-e');
  });

  it('continues with an explicit warning when discovery is unsupported', async () => {
    const result = await preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      discover: async () => ({ status: 'unsupported', runner: 'codex', reason: 'no public API' }),
    });
    expect(result.warnings[0]).toContain('人工确认');
  });

  it('fails on discovery errors and invalid schemas before routing', async () => {
    await expect(preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      discover: async () => ({ status: 'error', runner: 'codex', error: 'auth failed' }),
    })).rejects.toThrow('auth failed');
    await expect(preflightModelRouting({
      prd: prd(), state: state(), requestedRunner: 'codex', runnerExplicit: true,
      discover: async () => ({ status: 'unsupported', runner: 'claude', reason: 'wrong runner' }),
    })).rejects.toThrow('模型发现 runner 错配：期望 codex，收到 claude');
    await expect(preflightModelRouting({
      prd: { ...prd(), models: 'old' } as unknown as Prd,
      state: state(), requestedRunner: 'codex', runnerExplicit: true,
    })).rejects.toThrow('models 形状非法');
  });

  it('validates only escalation for an already escalated story, plus validator', async () => {
    const result = await preflightModelRouting({
      prd: prd(), state: state({ escalated: true }), requestedRunner: 'codex', runnerExplicit: true,
      discover: async () => available('esc-m', 'val-m'),
    });
    expect(result.storyRoutes[0].currentBuilder.model).toBe('esc-m');
  });

  it('已收敛 workspace 仍校验 schema/runner，但不做无实际调用的模型发现', async () => {
    let called = false;
    const result = await preflightModelRouting({
      prd: prd(), state: state({ passes: true }), requestedRunner: 'claude', runnerExplicit: false,
      discover: async () => { called = true; return available(); },
    });
    expect(result.runner).toBe('codex');
    expect(result.discovery.status).toBe('skipped');
    expect(called).toBe(false);
  });
});
