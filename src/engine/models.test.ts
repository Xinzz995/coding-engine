import { describe, it, expect } from 'vitest';
import { readModelsConfig, resolveBuilderModel, resolveValidatorModel } from './models.js';
import type { Prd, Story } from './prd.js';

// models 参数保持 unknown：非法形状用例要传数组/字符串/错误字段类型
const prdWith = (models?: unknown): Prd => ({
  project: 'p', branchName: 'b', description: 'd', userStories: [],
  ...(models !== undefined ? { models } : {}),
} as Prd);

const story = (over: Record<string, unknown> = {}): Story => ({
  id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1, ...over,
} as Story);

describe('readModelsConfig', () => {
  it('returns null config without warnings when prd is null or models is missing', () => {
    expect(readModelsConfig(null, 'claude')).toEqual({ config: null, warnings: [] });
    expect(readModelsConfig(prdWith(), 'claude')).toEqual({ config: null, warnings: [] });
  });

  it('normalizes a full valid config and keeps escalateAfter', () => {
    const r = readModelsConfig(prdWith({ builder: 'b-m', validator: 'v-m', escalation: 'e-m', escalateAfter: 2 }), 'claude');
    expect(r.config).toEqual({ builder: 'b-m', validator: 'v-m', escalation: 'e-m', escalateAfter: 2 });
    expect(r.warnings).toEqual([]);
  });

  it('defaults escalateAfter to 1 when missing', () => {
    const r = readModelsConfig(prdWith({ builder: 'b-m' }), 'claude');
    expect(r.config?.escalateAfter).toBe(1);
    expect(r.warnings).toEqual([]);
  });

  it('treats a non-object models value as invalid (array, string)', () => {
    for (const bad of [['opus'], 'opus']) {
      const r = readModelsConfig(prdWith(bad), 'claude');
      expect(r.config).toBeNull();
      expect(r.warnings.some((w) => w.includes('models 形状非法'))).toBe(true);
    }
  });

  it('treats non-string stage fields as invalid as a whole', () => {
    const r = readModelsConfig(prdWith({ builder: 42 }), 'claude');
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes('models 形状非法'))).toBe(true);
  });

  it('degrades an invalid escalateAfter to 1 with a warning (0, negative, float, non-number)', () => {
    for (const bad of [0, -1, 2.5, '2']) {
      const r = readModelsConfig(prdWith({ builder: 'b-m', escalateAfter: bad }), 'claude');
      expect(r.config?.escalateAfter).toBe(1);
      expect(r.warnings.some((w) => w.includes('escalateAfter'))).toBe(true);
    }
  });

  it('warns that escalation never fires when escalateAfter >= MAX_RETRIES', () => {
    const r = readModelsConfig(prdWith({ escalation: 'e-m', escalateAfter: 5 }), 'claude');
    expect(r.config?.escalateAfter).toBe(5); // 值保留，行为上永不触发（达 5 已 blocked）
    expect(r.warnings.some((w) => w.includes('永不生效'))).toBe(true);
  });

  // ——按 agent 工具分段（每个 agent 工具定位自己的模型名，模型名对工具不可移植）——

  const perKind = {
    claude: { builder: 'sonnet', validator: 'fable', escalation: 'fable', escalateAfter: 2 },
    codex: { builder: 'x-builder' },
    cursor: { builder: 'composer', validator: 'composer' },
  };

  it('per-kind: picks the section matching the running agent kind', () => {
    const c = readModelsConfig(prdWith(perKind), 'claude');
    expect(c.config).toEqual({ builder: 'sonnet', validator: 'fable', escalation: 'fable', escalateAfter: 2 });
    expect(c.warnings).toEqual([]);
    const x = readModelsConfig(prdWith(perKind), 'codex');
    expect(x.config).toEqual({ builder: 'x-builder', validator: undefined, escalation: undefined, escalateAfter: 1 });
  });

  it('per-kind: unknown-to-engine kind keys are legal sections for other tools', () => {
    const r = readModelsConfig(prdWith(perKind), 'cursor');
    expect(r.config?.builder).toBe('composer');
  });

  it('per-kind: warns and disables routing when the running kind has no section', () => {
    const r = readModelsConfig(prdWith({ claude: { builder: 'sonnet' } }), 'codex');
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes('codex') && w.includes('未配置'))).toBe(true);
  });

  it('per-kind: a bad stage field inside a section is invalid and names the section', () => {
    const r = readModelsConfig(prdWith({ claude: { builder: 42 } }), 'claude');
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes('models.claude'))).toBe(true);
  });

  it('per-kind: escalateAfter degrades per section with a warning', () => {
    const r = readModelsConfig(prdWith({ claude: { builder: 'b-m', escalateAfter: 0 } }), 'claude');
    expect(r.config?.escalateAfter).toBe(1);
    expect(r.warnings.some((w) => w.includes('escalateAfter'))).toBe(true);
  });

  it('mixed flat fields and kind sections are invalid as a whole', () => {
    const r = readModelsConfig(prdWith({ builder: 'b-m', claude: { builder: 'sonnet' } }), 'claude');
    expect(r.config).toBeNull();
    expect(r.warnings.some((w) => w.includes('models 形状非法'))).toBe(true);
  });
});

describe('resolveBuilderModel', () => {
  const cfg = { builder: 'b-m', validator: 'v-m', escalation: 'e-m', escalateAfter: 1 };

  it('returns undefined when nothing is configured', () => {
    const r = resolveBuilderModel({ config: null, story: null, retryCount: 0, kind: 'claude' });
    expect(r).toEqual({ model: undefined, escalated: false, warnings: [] });
  });

  it('falls back to the top-level builder model', () => {
    const r = resolveBuilderModel({ config: cfg, story: story(), retryCount: 0, kind: 'claude' });
    expect(r.model).toBe('b-m');
    expect(r.escalated).toBe(false);
  });

  it('lets story.model override the top-level builder model', () => {
    const r = resolveBuilderModel({ config: cfg, story: story({ model: 's-m' }), retryCount: 0, kind: 'claude' });
    expect(r.model).toBe('s-m');
  });

  it('applies story.model even without a top-level models config', () => {
    const r = resolveBuilderModel({ config: null, story: story({ model: 's-m' }), retryCount: 0, kind: 'claude' });
    expect(r.model).toBe('s-m');
  });

  it('escalates past story.model once retryCount reaches escalateAfter', () => {
    const r = resolveBuilderModel({ config: cfg, story: story({ model: 's-m' }), retryCount: 1, kind: 'claude' });
    expect(r).toMatchObject({ model: 'e-m', escalated: true });
  });

  it('does not escalate below the threshold', () => {
    const r = resolveBuilderModel({ config: { ...cfg, escalateAfter: 3 }, story: story(), retryCount: 2, kind: 'claude' });
    expect(r).toMatchObject({ model: 'b-m', escalated: false });
  });

  it('does not escalate when escalation is not configured', () => {
    const r = resolveBuilderModel({
      config: { builder: 'b-m', escalateAfter: 1 }, story: story(), retryCount: 4, kind: 'claude',
    });
    expect(r).toMatchObject({ model: 'b-m', escalated: false });
  });

  it('lets the CLI override beat everything, including escalation', () => {
    const r = resolveBuilderModel({ cliOverride: 'cli-m', config: cfg, story: story({ model: 's-m' }), retryCount: 3, kind: 'claude' });
    expect(r).toMatchObject({ model: 'cli-m', escalated: false });
  });

  it('ignores a non-string story.model with a warning and falls back', () => {
    const r = resolveBuilderModel({ config: cfg, story: story({ model: 123 }), retryCount: 0, kind: 'claude' });
    expect(r.model).toBe('b-m');
    expect(r.warnings.some((w) => w.includes('US-001') && w.includes('model'))).toBe(true);
  });

  // ——story.model 按 agent 工具分段——

  it('per-kind story.model: picks the entry for the running kind', () => {
    const m = { claude: 'opus', codex: 'x-big' };
    expect(resolveBuilderModel({ config: cfg, story: story({ model: m }), retryCount: 0, kind: 'claude' }).model).toBe('opus');
    expect(resolveBuilderModel({ config: null, story: story({ model: m }), retryCount: 0, kind: 'codex' }).model).toBe('x-big');
  });

  it('per-kind story.model: missing kind entry falls through to the stage chain silently', () => {
    const r = resolveBuilderModel({ config: cfg, story: story({ model: { codex: 'x-big' } }), retryCount: 0, kind: 'claude' });
    expect(r.model).toBe('b-m');
    expect(r.warnings).toEqual([]);
  });

  it('per-kind story.model: non-string entry is ignored with a warning', () => {
    const r = resolveBuilderModel({ config: cfg, story: story({ model: { claude: 42 } }), retryCount: 0, kind: 'claude' });
    expect(r.model).toBe('b-m');
    expect(r.warnings.some((w) => w.includes('US-001'))).toBe(true);
  });
});

describe('resolveValidatorModel', () => {
  const cfg = { builder: 'b-m', validator: 'v-m', escalateAfter: 1 };

  it('returns undefined when nothing is configured', () => {
    expect(resolveValidatorModel({ config: null })).toBeUndefined();
  });

  it('uses the top-level validator model', () => {
    expect(resolveValidatorModel({ config: cfg })).toBe('v-m');
  });

  it('lets the CLI override win', () => {
    expect(resolveValidatorModel({ cliOverride: 'cli-m', config: cfg })).toBe('cli-m');
  });
});
