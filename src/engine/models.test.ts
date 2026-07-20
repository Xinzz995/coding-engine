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
    expect(r.config).toEqual({ builder: 'b-m', validator: 'v-m', escalation: 'e-m', escalateAfter: 2, profiles: {} });
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

  // ——具名模型档案 profiles（配置一次，任何 agent 工具各自定位模型名，ADR-010）——

  const profiles = {
    fast: { claude: 'sonnet', codex: 'x-mini', cursor: 'composer' },
    strong: { claude: 'opus', codex: 'x-big' },
  };

  it('profiles: stage refs resolve to the running kind entry', () => {
    const models = { profiles, builder: 'fast', validator: 'strong', escalation: 'strong', escalateAfter: 2 };
    const c = readModelsConfig(prdWith(models), 'claude');
    expect(c.config).toEqual({ builder: 'sonnet', validator: 'opus', escalation: 'opus', escalateAfter: 2, profiles });
    expect(c.warnings).toEqual([]);
    const x = readModelsConfig(prdWith(models), 'codex');
    expect(x.config).toMatchObject({ builder: 'x-mini', validator: 'x-big', escalation: 'x-big' });
    const cur = readModelsConfig(prdWith(models), 'cursor');
    expect(cur.config?.builder).toBe('composer');
  });

  it('profiles: a ref not matching any profile passes through as a literal model name', () => {
    const r = readModelsConfig(prdWith({ profiles, builder: 'my-exact-model' }), 'claude');
    expect(r.config?.builder).toBe('my-exact-model');
    expect(r.warnings).toEqual([]);
  });

  it('profiles: missing kind entry warns and leaves the stage without a model', () => {
    const r = readModelsConfig(prdWith({ profiles, validator: 'strong' }), 'cursor');
    expect(r.config?.validator).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('strong') && w.includes('cursor'))).toBe(true);
  });

  it('profiles: invalid shapes disable the whole models config with a located warning', () => {
    for (const [bad, locator] of [
      ['not-an-object', 'profiles'],
      [{ fast: 'sonnet' }, 'profiles.fast'],
      [{ fast: { claude: 42 } }, 'profiles.fast.claude'],
    ] as const) {
      const r = readModelsConfig(prdWith({ profiles: bad, builder: 'fast' }), 'claude');
      expect(r.config).toBeNull();
      expect(r.warnings.some((w) => w.includes(locator))).toBe(true);
    }
  });

  it('profiles: an empty profile is legal but every ref to it warns per kind', () => {
    const r = readModelsConfig(prdWith({ profiles: { fast: {} }, builder: 'fast' }), 'claude');
    expect(r.config?.builder).toBeUndefined();
    expect(r.warnings.some((w) => w.includes('fast') && w.includes('claude'))).toBe(true);
  });
});

describe('resolveBuilderModel', () => {
  const cfg = { builder: 'b-m', validator: 'v-m', escalation: 'e-m', escalateAfter: 1, profiles: {} };

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
      config: { builder: 'b-m', escalateAfter: 1, profiles: {} }, story: story(), retryCount: 4, kind: 'claude',
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

  // ——story.model 写模型引用：档案名按当前工具解析，非档案名当字面模型名——

  const cfgWithProfiles = {
    ...cfg,
    profiles: { strong: { claude: 'opus', codex: 'x-big' } },
  };

  it('story ref: resolves a profile name via the running kind', () => {
    expect(resolveBuilderModel({ config: cfgWithProfiles, story: story({ model: 'strong' }), retryCount: 0, kind: 'claude' }).model).toBe('opus');
    expect(resolveBuilderModel({ config: cfgWithProfiles, story: story({ model: 'strong' }), retryCount: 0, kind: 'codex' }).model).toBe('x-big');
  });

  it('story ref: a non-profile name passes through as a literal model name', () => {
    const r = resolveBuilderModel({ config: cfgWithProfiles, story: story({ model: 'my-exact-model' }), retryCount: 0, kind: 'claude' });
    expect(r.model).toBe('my-exact-model');
    expect(r.warnings).toEqual([]);
  });

  it('story ref: profile hit but missing kind entry warns and falls through to the stage chain', () => {
    const r = resolveBuilderModel({ config: cfgWithProfiles, story: story({ model: 'strong' }), retryCount: 0, kind: 'cursor' });
    expect(r.model).toBe('b-m');
    expect(r.warnings.some((w) => w.includes('strong') && w.includes('cursor'))).toBe(true);
  });

  it('story ref: without a models config the value is a literal (old behavior)', () => {
    const r = resolveBuilderModel({ config: null, story: story({ model: 'strong' }), retryCount: 0, kind: 'claude' });
    expect(r.model).toBe('strong');
  });
});

describe('resolveValidatorModel', () => {
  const cfg = { builder: 'b-m', validator: 'v-m', escalateAfter: 1, profiles: {} };

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
