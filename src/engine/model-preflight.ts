import { listConfiguredModels, type ModelCatalogResult } from './model-catalog.js';
import { readModelRouting, resolveBuilderModel, resolveValidatorModel, type ModelChoice } from './models.js';
import type { AgentKind } from './agent.js';
import type { ModelsConfig, Prd, StoryDifficulty } from './prd.js';
import { isStoryPassed, type RunState } from './state.js';

export class ModelPreflightError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ModelPreflightError';
  }
}

export interface StoryRoutePreview {
  storyId: string;
  difficulty: StoryDifficulty | null;
  currentBuilder: ModelChoice;
  initialBuilder: ModelChoice;
  escalationBuilder: ModelChoice | null;
  escalated: boolean;
}

export interface ModelPreflightResult {
  runner: AgentKind;
  config: ModelsConfig | null;
  catalog: ModelCatalogResult | { status: 'skipped'; runner: AgentKind };
  warnings: string[];
  storyRoutes: StoryRoutePreview[];
  validator: ModelChoice;
  review: ModelChoice;
  overrides: { builder?: string; validator?: string; escalation?: string; review?: string };
}

export interface ModelPreflightOptions {
  prd: Prd | null;
  state: RunState | null;
  requestedRunner: AgentKind;
  runnerExplicit: boolean;
  builderOverride?: string;
  validatorOverride?: string;
  escalationOverride?: string;
  reviewOverride?: string;
  catalog?: (runner: AgentKind) => ModelCatalogResult | Promise<ModelCatalogResult>;
}

export function resolveRunKind(
  config: ModelsConfig | null,
  requestedRunner: AgentKind,
  runnerExplicit: boolean,
): AgentKind {
  if (config && runnerExplicit && config.runner !== requestedRunner) {
    throw new ModelPreflightError(
      `显式 runner「${requestedRunner}」与 models.runner「${config.runner}」不一致；请改用配置 runner 或重新运行 prd-to-json`,
    );
  }
  return config?.runner ?? requestedRunner;
}

function storyPending(state: RunState | null, storyId: string): boolean {
  const current = state?.[storyId];
  return !current || (!isStoryPassed(current) && !current.blocked);
}

function storyNeedsImplementation(state: RunState | null, storyId: string): boolean {
  const current = state?.[storyId];
  return !current || (!current.blocked && !current.passes);
}

function addModel(target: Map<string, string[]>, model: string | undefined, path: string): void {
  if (!model) return;
  const paths = target.get(model) ?? [];
  paths.push(path);
  target.set(model, paths);
}

export async function preflightModelRouting(opts: ModelPreflightOptions): Promise<ModelPreflightResult> {
  for (const [flag, value] of [
    ['--builder-model', opts.builderOverride],
    ['--validator-model', opts.validatorOverride],
    ['--escalation-model', opts.escalationOverride],
    ['--review-model', opts.reviewOverride],
  ] as const) {
    if (value !== undefined && value.trim().length === 0) {
      throw new ModelPreflightError(`${flag} 必须是非空模型标识`);
    }
  }
  const routing = readModelRouting(opts.prd);
  if (routing.status === 'invalid') throw new ModelPreflightError(routing.errors.join('；'));
  const config = routing.status === 'enabled' ? routing.config : null;
  const runner = resolveRunKind(config, opts.requestedRunner, opts.runnerExplicit);
  const storyRoutes: StoryRoutePreview[] = [];
  const required = new Map<string, string[]>();
  const shadowed = new Map<string, string[]>();

  for (const story of opts.prd?.userStories ?? []) {
    if (!storyNeedsImplementation(opts.state, story.id)) continue;
    // enabled 已严格校验；disabled stories 无 difficulty，不进入 config 索引。
    const difficulty = story.difficulty ?? null;
    const escalated = opts.state?.[story.id]?.escalated ?? false;
    const initialBuilder = resolveBuilderModel({
      builderOverride: opts.builderOverride, escalationOverride: opts.escalationOverride,
      config, story, escalated: false,
    });
    const currentBuilder = resolveBuilderModel({
      builderOverride: opts.builderOverride, escalationOverride: opts.escalationOverride,
      config, story, escalated,
    });
    const dedicated = opts.escalationOverride ?? config?.escalation;
    const escalationBuilder = dedicated
      ? resolveBuilderModel({
          builderOverride: opts.builderOverride, escalationOverride: opts.escalationOverride,
          config, story, escalated: true,
        })
      : null;
    storyRoutes.push({ storyId: story.id, difficulty, currentBuilder, initialBuilder, escalationBuilder, escalated });
    addModel(required, currentBuilder.model, `story ${story.id} 当前 builder`);
    if (!escalated) addModel(required, escalationBuilder?.model, `story ${story.id} escalation`);

    if (config && opts.builderOverride && story.difficulty && !escalated) {
      addModel(shadowed, config.builder[story.difficulty], `models.builder.${story.difficulty}`);
    }
  }

  const hasPending = (opts.prd?.userStories ?? []).some((story) => storyPending(opts.state, story.id));
  const validator = resolveValidatorModel({ cliOverride: opts.validatorOverride, config });
  const review: ModelChoice = opts.reviewOverride
    ? { model: opts.reviewOverride, source: 'cli-review' }
    : { ...resolveValidatorModel({ cliOverride: opts.validatorOverride, config }), source: 'review' };
  if (hasPending) addModel(required, validator.model, 'validator');
  // 最终 Review 在 story 收敛后必然发生；已经明确的模型必须在任何 agent 启动前进入允许目录。
  // 正式 runLoop 还会在本预检返回后拒绝未固定的 Review 模型。
  addModel(required, review.model, 'final reviewer');
  if (hasPending && config && opts.validatorOverride) addModel(shadowed, config.validator, 'models.validator');
  if (hasPending && config && opts.escalationOverride) addModel(shadowed, config.escalation, 'models.escalation');

  // prd.json 缺失/无法解析时 loop 的历史行为仍会进入 agent 修复轮。此时若用户给了
  // CLI 模型覆盖，它们不能因为没有可枚举 story 而绕过全局允许目录。
  const prdUnavailable = opts.prd === null;
  if (prdUnavailable) {
    addModel(required, opts.builderOverride, '--builder-model');
    addModel(required, opts.validatorOverride, '--validator-model');
    addModel(required, opts.escalationOverride, '--escalation-model');
    addModel(required, opts.reviewOverride, '--review-model');
  }

  // 没有待执行 story 就不会发生模型调用：schema/runner 仍严格校验，
  // 但不为一个已收敛 workspace 做无意义的全局模型目录读取。prd 不可用且显式
  // 传入覆盖是例外：loop 仍可能启动修复 agent，必须先复核这些 ID。
  const hasOverrides = opts.builderOverride !== undefined
    || opts.validatorOverride !== undefined
    || opts.escalationOverride !== undefined;
  const hasReviewModel = review.model !== undefined;
  const hasPolicy = (hasPending && (config !== null || hasOverrides))
    || hasReviewModel
    || (prdUnavailable && hasOverrides);
  if (!hasPolicy) {
    return {
      runner, config, catalog: { status: 'skipped', runner }, warnings: [], storyRoutes, validator, review,
      overrides: {
        ...(opts.builderOverride !== undefined ? { builder: opts.builderOverride } : {}),
        ...(opts.validatorOverride !== undefined ? { validator: opts.validatorOverride } : {}),
        ...(opts.escalationOverride !== undefined ? { escalation: opts.escalationOverride } : {}),
        ...(opts.reviewOverride !== undefined ? { review: opts.reviewOverride } : {}),
      },
    };
  }

  const catalog = await (opts.catalog ?? listConfiguredModels)(runner);
  if (catalog.runner !== runner) {
    throw new ModelPreflightError(`全局模型目录 runner 错配：期望 ${runner}，收到 ${catalog.runner}`);
  }
  if (catalog.status === 'error') throw new ModelPreflightError(catalog.error);
  const warnings: string[] = [];
  const configured = new Set(catalog.models.map((model) => model.id));
  const missingRequired = [...required.entries()].filter(([model]) => !configured.has(model));
  if (missingRequired.length > 0) {
    const detail = missingRequired.map(([model, paths]) => `${model}（${paths.join('、')}）`).join('；');
    throw new ModelPreflightError(`本次实际路由包含未在 ${runner} 全局模型目录声明的模型：${detail}`);
  }
  for (const [model, paths] of shadowed) {
    if (!configured.has(model)) {
      warnings.push(`配置模型 ${model}（${paths.join('、')}）未在全局模型目录声明，但已被 CLI 完全覆盖；本次继续，建议重新运行 prd-to-json`);
    }
  }
  return {
    runner, config, catalog, warnings, storyRoutes, validator, review,
    overrides: {
      ...(opts.builderOverride !== undefined ? { builder: opts.builderOverride } : {}),
      ...(opts.validatorOverride !== undefined ? { validator: opts.validatorOverride } : {}),
      ...(opts.escalationOverride !== undefined ? { escalation: opts.escalationOverride } : {}),
      ...(opts.reviewOverride !== undefined ? { review: opts.reviewOverride } : {}),
    },
  };
}

export function renderPreflightSummary(result: ModelPreflightResult): string {
  const lines = [`🧭 runner: ${result.runner}`];
  if (result.config) {
    lines.push(
      `   builder: low=${result.config.builder.low} · medium=${result.config.builder.medium} · high=${result.config.builder.high}`,
      `   validator: ${result.config.validator} · escalation: ${result.config.escalation}`,
      `   final reviewer: ${result.review.model ?? '未固定'}`,
    );
  } else {
    lines.push(`   prd.json 模型路由：未启用 · final reviewer=${result.review.model ?? '未固定'}`);
  }
  const overrides = Object.entries(result.overrides);
  if (overrides.length > 0) {
    lines.push(`   CLI 临时覆盖：${overrides.map(([key, value]) => `${key}=${value}`).join(' · ')}`);
  }
  lines.push(`   全局模型目录：${result.catalog.status}${result.catalog.status === 'available' ? `（${result.catalog.configPath}）` : ''}`);
  return lines.join('\n');
}
