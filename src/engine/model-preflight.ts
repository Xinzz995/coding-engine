import { discoverModels, type ModelDiscoveryResult } from './model-discovery.js';
import { readModelRouting, resolveBuilderModel, resolveValidatorModel, type ModelChoice } from './models.js';
import type { AgentKind } from './agent.js';
import type { ModelsConfig, Prd, StoryDifficulty } from './prd.js';
import type { RunState } from './state.js';

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
  discovery: ModelDiscoveryResult | { status: 'skipped'; runner: AgentKind };
  warnings: string[];
  storyRoutes: StoryRoutePreview[];
  validator: ModelChoice;
  overrides: { builder?: string; validator?: string; escalation?: string };
}

export interface ModelPreflightOptions {
  prd: Prd | null;
  state: RunState | null;
  requestedRunner: AgentKind;
  runnerExplicit: boolean;
  builderOverride?: string;
  validatorOverride?: string;
  escalationOverride?: string;
  discover?: (runner: AgentKind) => Promise<ModelDiscoveryResult>;
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
  return !current?.passes && !current?.blocked;
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
    if (!storyPending(opts.state, story.id)) continue;
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

    if (config && opts.builderOverride && story.difficulty) {
      addModel(shadowed, config.builder[story.difficulty], `models.builder.${story.difficulty}`);
    }
  }

  const hasPending = storyRoutes.length > 0;
  const validator = resolveValidatorModel({ cliOverride: opts.validatorOverride, config });
  if (hasPending) addModel(required, validator.model, 'validator');
  if (hasPending && config && opts.validatorOverride) addModel(shadowed, config.validator, 'models.validator');
  if (hasPending && config && opts.escalationOverride) addModel(shadowed, config.escalation, 'models.escalation');

  // 没有待执行 story 就不会发生模型调用：schema/runner 仍严格校验，
  // 但不为一个已收敛 workspace 做无意义的认证/模型发现。
  const hasPolicy = hasPending && (config !== null
    || opts.builderOverride !== undefined
    || opts.validatorOverride !== undefined
    || opts.escalationOverride !== undefined);
  if (!hasPolicy) {
    return {
      runner, config, discovery: { status: 'skipped', runner }, warnings: [], storyRoutes, validator,
      overrides: {
        ...(opts.builderOverride !== undefined ? { builder: opts.builderOverride } : {}),
        ...(opts.validatorOverride !== undefined ? { validator: opts.validatorOverride } : {}),
        ...(opts.escalationOverride !== undefined ? { escalation: opts.escalationOverride } : {}),
      },
    };
  }

  const discovery = await (opts.discover ?? discoverModels)(runner);
  if (discovery.runner !== runner) {
    throw new ModelPreflightError(`模型发现 runner 错配：期望 ${runner}，收到 ${discovery.runner}`);
  }
  if (discovery.status === 'error') throw new ModelPreflightError(discovery.error);
  const warnings: string[] = [];
  if (discovery.status === 'unsupported') {
    warnings.push(`无法自动复核 ${runner} 当前模型清单：${discovery.reason}；本次信任 prd-to-json 中的人工确认`);
  } else {
    const available = new Set(discovery.models.map((model) => model.id));
    const missingRequired = [...required.entries()].filter(([model]) => !available.has(model));
    if (missingRequired.length > 0) {
      const detail = missingRequired.map(([model, paths]) => `${model}（${paths.join('、')}）`).join('；');
      throw new ModelPreflightError(`本次实际路由包含当前不可用模型：${detail}`);
    }
    for (const [model, paths] of shadowed) {
      if (!available.has(model)) {
        warnings.push(`配置模型 ${model}（${paths.join('、')}）当前不可用，但已被 CLI 完全覆盖；本次继续，建议重新运行 prd-to-json`);
      }
    }
  }
  return {
    runner, config, discovery, warnings, storyRoutes, validator,
    overrides: {
      ...(opts.builderOverride !== undefined ? { builder: opts.builderOverride } : {}),
      ...(opts.validatorOverride !== undefined ? { validator: opts.validatorOverride } : {}),
      ...(opts.escalationOverride !== undefined ? { escalation: opts.escalationOverride } : {}),
    },
  };
}

export function renderPreflightSummary(result: ModelPreflightResult): string {
  const lines = [`🧭 runner: ${result.runner}`];
  if (result.config) {
    lines.push(
      `   builder: low=${result.config.builder.low} · medium=${result.config.builder.medium} · high=${result.config.builder.high}`,
      `   validator: ${result.config.validator} · escalation: ${result.config.escalation}`,
    );
  } else {
    lines.push('   prd.json 模型路由：未启用');
  }
  const overrides = Object.entries(result.overrides);
  if (overrides.length > 0) {
    lines.push(`   CLI 临时覆盖：${overrides.map(([key, value]) => `${key}=${value}`).join(' · ')}`);
  }
  lines.push(`   模型复核：${result.discovery.status}`);
  return lines.join('\n');
}
