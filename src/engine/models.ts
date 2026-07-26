import type { ModelsConfig, Prd, Story, StoryDifficulty } from './prd.js';

export type ModelRouteSource =
  | 'cli-builder'
  | 'cli-escalation'
  | 'cli-validator'
  | 'cli-review'
  | 'difficulty'
  | 'escalation'
  | 'validator'
  | 'review'
  | 'runner-default';

export type ModelRoutingReadResult =
  | { status: 'disabled'; config: null; errors: [] }
  | { status: 'enabled'; config: ModelsConfig; errors: [] }
  | { status: 'invalid'; config: null; errors: string[] };

export interface ModelChoice {
  model: string | undefined;
  source: ModelRouteSource;
}

export interface BuilderModelChoice extends ModelChoice {
  /** 本轮实际选中了专用 escalation 路由。 */
  escalated: boolean;
  warnings: string[];
}

const MODEL_KEYS = ['runner', 'builder', 'validator', 'escalation'] as const;
const BUILDER_KEYS = ['low', 'medium', 'high'] as const;
const RUNNERS = ['claude', 'codex', 'cursor'] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasOwn(value: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(value, key);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isDifficulty(value: unknown): value is StoryDifficulty {
  return value === 'low' || value === 'medium' || value === 'high';
}

function oldSchemaMessage(path: string): string {
  return `${path} 使用了未发布的旧模型路由格式；请重新运行 prd-to-json 派生当前格式`;
}

/**
 * 严格读取 prd.json 的模型路由合同。路由本身可选，但一旦出现就必须完整有效；
 * 任何旧格式、未知键或与 story 难度字段不成套的情况都显式返回 invalid。
 */
export function readModelRouting(prd: Prd | null): ModelRoutingReadResult {
  if (!prd) return { status: 'disabled', config: null, errors: [] };

  const stories = Array.isArray(prd.userStories) ? prd.userStories : [];
  const errors: string[] = [];
  for (const story of stories) {
    const raw = story as Story & Record<string, unknown>;
    if (hasOwn(raw, 'model')) errors.push(oldSchemaMessage(`userStories[${story.id}].model`));
  }

  if (prd.models === undefined) {
    for (const story of stories) {
      const raw = story as Story & Record<string, unknown>;
      if (hasOwn(raw, 'difficulty') || hasOwn(raw, 'difficultyReason')) {
        errors.push(`userStories[${story.id}] 含 difficulty/difficultyReason，但顶层 models 缺失；请补全路由或移除半套配置`);
      }
    }
    return errors.length > 0
      ? { status: 'invalid', config: null, errors }
      : { status: 'disabled', config: null, errors: [] };
  }

  const rawModels: unknown = prd.models;
  if (!isRecord(rawModels)) {
    return { status: 'invalid', config: null, errors: ['models 形状非法：必须是对象；请重新运行 prd-to-json 派生当前格式'] };
  }

  if (hasOwn(rawModels, 'profiles')) errors.push(oldSchemaMessage('models.profiles'));
  if (hasOwn(rawModels, 'escalateAfter')) errors.push(oldSchemaMessage('models.escalateAfter'));
  if (['claude', 'codex', 'cursor'].some((key) => hasOwn(rawModels, key))) {
    errors.push(oldSchemaMessage('models.<runner>'));
  }
  for (const key of Object.keys(rawModels)) {
    if (!(MODEL_KEYS as readonly string[]).includes(key)
      && key !== 'profiles' && key !== 'escalateAfter'
      && !['claude', 'codex', 'cursor'].includes(key)) {
      errors.push(`models.${key} 是未知字段；允许字段仅为 runner、builder、validator、escalation`);
    }
  }

  if (!(RUNNERS as readonly unknown[]).includes(rawModels.runner)) {
    errors.push('models.runner 必须是 claude、codex 或 cursor');
  }

  const rawBuilder = rawModels.builder;
  if (!isRecord(rawBuilder)) {
    errors.push(typeof rawBuilder === 'string'
      ? oldSchemaMessage('models.builder')
      : 'models.builder 必须是包含 low、medium、high 的对象');
  } else {
    for (const key of Object.keys(rawBuilder)) {
      if (!(BUILDER_KEYS as readonly string[]).includes(key)) {
        errors.push(`models.builder.${key} 是未知字段；允许字段仅为 low、medium、high`);
      }
    }
    for (const key of BUILDER_KEYS) {
      if (!isNonEmptyString(rawBuilder[key])) errors.push(`models.builder.${key} 必须是非空模型标识`);
    }
  }

  if (!isNonEmptyString(rawModels.validator)) errors.push('models.validator 必须是非空模型标识');
  if (!isNonEmptyString(rawModels.escalation)) errors.push('models.escalation 必须是非空模型标识');

  for (const story of stories) {
    if (!isDifficulty(story.difficulty)) {
      errors.push(`userStories[${story.id}].difficulty 必须是 low、medium 或 high`);
    }
    if (!isNonEmptyString(story.difficultyReason)) {
      errors.push(`userStories[${story.id}].difficultyReason 必须是非空字符串`);
    }
  }

  if (errors.length > 0) return { status: 'invalid', config: null, errors };
  return {
    status: 'enabled',
    config: rawModels as unknown as ModelsConfig,
    errors: [],
  };
}

export function resolveBuilderModel(opts: {
  builderOverride?: string;
  escalationOverride?: string;
  config: ModelsConfig | null;
  story: Story | null;
  escalated: boolean;
}): BuilderModelChoice {
  if (opts.escalated) {
    if (opts.escalationOverride) {
      return { model: opts.escalationOverride, source: 'cli-escalation', escalated: true, warnings: [] };
    }
    if (opts.config?.escalation) {
      return { model: opts.config.escalation, source: 'escalation', escalated: true, warnings: [] };
    }
  }
  if (opts.builderOverride) {
    return { model: opts.builderOverride, source: 'cli-builder', escalated: false, warnings: [] };
  }
  const difficulty = opts.story?.difficulty;
  if (opts.config && isDifficulty(difficulty)) {
    return { model: opts.config.builder[difficulty], source: 'difficulty', escalated: false, warnings: [] };
  }
  return { model: undefined, source: 'runner-default', escalated: false, warnings: [] };
}

export function resolveValidatorModel(opts: {
  cliOverride?: string;
  config: ModelsConfig | null;
}): ModelChoice {
  if (opts.cliOverride) return { model: opts.cliOverride, source: 'cli-validator' };
  if (opts.config) return { model: opts.config.validator, source: 'validator' };
  return { model: undefined, source: 'runner-default' };
}
