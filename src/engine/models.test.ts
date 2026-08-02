import { describe, expect, it } from 'vitest';
import { readModelRouting, resolveBuilderModel, resolveValidatorModel } from './models.js';
import type { ModelsConfig, Prd, Story } from './prd.js';

const story = (over: Record<string, unknown> = {}): Story => ({
  id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1,
  difficulty: 'medium', difficultyReason: '命中 medium-1：沿用 src/api.ts 的既有接线模式。',
  ...over,
});

const storyWithoutRouting = (): Story => ({
  id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1,
});

const config: ModelsConfig = {
  runner: 'codex',
  builder: { low: 'low-m', medium: 'mid-m', high: 'high-m' },
  validator: 'val-m',
  escalation: 'esc-m',
};

const prd = (models: unknown = config, stories: Story[] = [story()]): Prd => ({
  project: 'p', branchName: 'b', description: 'd', userStories: stories,
  ...(models === null ? {} : { models }),
} as Prd);

describe('readModelRouting', () => {
  it('distinguishes disabled from a complete enabled config', () => {
    expect(readModelRouting(prd(null, [storyWithoutRouting()]))).toEqual({
      status: 'disabled', config: null, errors: [],
    });
    expect(readModelRouting(prd())).toEqual({ status: 'enabled', config, errors: [] });
  });

  it('reports malformed Story elements instead of dereferencing them', () => {
    const malformed = {
      ...prd(null, []),
      userStories: [null],
    } as unknown as Prd;
    expect(readModelRouting(malformed)).toEqual({
      status: 'invalid',
      config: null,
      errors: ['userStories[0] 形状非法：必须是对象'],
    });
  });

  it('requires all five non-empty model identifiers and a known runner', () => {
    const result = readModelRouting(prd({
      runner: 'other', builder: { low: '', medium: 'm' }, validator: ' ', escalation: 42,
    }));
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.errors).toEqual(expect.arrayContaining([
      expect.stringContaining('models.runner'),
      expect.stringContaining('models.builder.low'),
      expect.stringContaining('models.builder.high'),
      expect.stringContaining('models.validator'),
      expect.stringContaining('models.escalation'),
    ]));
  });

  it('rejects unknown keys inside models and builder', () => {
    const result = readModelRouting(prd({
      ...config, typo: true, builder: { ...config.builder, ultra: 'u' },
    }));
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.errors.some((e) => e.includes('models.typo'))).toBe(true);
    expect(result.errors.some((e) => e.includes('models.builder.ultra'))).toBe(true);
  });

  it.each([
    [{ builder: 'fast', validator: 'v', escalation: 'e' }, 'models.builder'],
    [{ ...config, profiles: { fast: { codex: 'm' } } }, 'models.profiles'],
    [{ ...config, escalateAfter: 1 }, 'models.escalateAfter'],
    [{ codex: config }, 'models.<runner>'],
  ])('rejects unpublished old schemas and points to re-derivation', (models, locator) => {
    const result = readModelRouting(prd(models));
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.errors.some((e) => e.includes(locator) && e.includes('prd-to-json'))).toBe(true);
  });

  it('rejects story.model even without a models block', () => {
    const result = readModelRouting(prd(null, [story({
      difficulty: undefined, difficultyReason: undefined, model: 'old-m',
    })]));
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.errors[0]).toContain('userStories[US-001].model');
    expect(result.errors[0]).toContain('prd-to-json');
  });

  it('requires difficulty and a non-empty reason for every story when enabled', () => {
    const result = readModelRouting(prd(config, [story({ difficulty: 'unknown', difficultyReason: ' ' })]));
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.errors.some((e) => e.includes('.difficulty '))).toBe(true);
    expect(result.errors.some((e) => e.includes('.difficultyReason'))).toBe(true);
  });

  it('rejects difficulty metadata without models as a half-configured route', () => {
    const result = readModelRouting(prd(null));
    expect(result.status).toBe('invalid');
    if (result.status !== 'invalid') return;
    expect(result.errors[0]).toContain('半套配置');
  });
});

describe('resolveBuilderModel', () => {
  it('selects the story difficulty for an initial builder', () => {
    expect(resolveBuilderModel({ config, story: story({ difficulty: 'low' }), escalated: false })).toMatchObject({
      model: 'low-m', source: 'difficulty', escalated: false,
    });
    expect(resolveBuilderModel({ config, story: story({ difficulty: 'high' }), escalated: false }).model).toBe('high-m');
  });

  it('lets the builder CLI override only the initial route', () => {
    expect(resolveBuilderModel({
      builderOverride: 'cli-b', config, story: story(), escalated: false,
    })).toMatchObject({ model: 'cli-b', source: 'cli-builder', escalated: false });
    expect(resolveBuilderModel({
      builderOverride: 'cli-b', config, story: story(), escalated: true,
    })).toMatchObject({ model: 'esc-m', source: 'escalation', escalated: true });
  });

  it('uses the dedicated CLI escalation before configured escalation', () => {
    expect(resolveBuilderModel({
      builderOverride: 'cli-b', escalationOverride: 'cli-e', config, story: story(), escalated: true,
    })).toMatchObject({ model: 'cli-e', source: 'cli-escalation', escalated: true });
  });

  it('falls back through builder override and runner default without a dedicated escalation', () => {
    expect(resolveBuilderModel({
      builderOverride: 'cli-b', config: null, story: story(), escalated: true,
    })).toMatchObject({ model: 'cli-b', source: 'cli-builder', escalated: false });
    expect(resolveBuilderModel({ config: null, story: story(), escalated: false })).toMatchObject({
      model: undefined, source: 'runner-default', escalated: false,
    });
  });
});

describe('resolveValidatorModel', () => {
  it('uses CLI, configured validator, then runner default', () => {
    expect(resolveValidatorModel({ cliOverride: 'cli-v', config })).toEqual({ model: 'cli-v', source: 'cli-validator' });
    expect(resolveValidatorModel({ config })).toEqual({ model: 'val-m', source: 'validator' });
    expect(resolveValidatorModel({ config: null })).toEqual({ model: undefined, source: 'runner-default' });
  });
});
