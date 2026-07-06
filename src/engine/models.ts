import type { Prd, Story } from './prd.js';
import { MAX_RETRIES } from './gate.js';

/** 规范化后的模型路由配置：escalateAfter 总有值（缺省/非法一律归 1） */
export interface ResolvedModels {
  builder?: string;
  validator?: string;
  escalation?: string;
  escalateAfter: number;
}

export interface ModelsReadResult {
  /** null = 未配置或整体形状非法（按未配置运行） */
  config: ResolvedModels | null;
  warnings: string[];
}

/**
 * 读取并校验 prd.json 顶层 models：未配置返回 null（静默）；整体形状非法
 * （非对象/阶段字段非字符串）返回 null + 警告——与 readQualityChecks 同款防御，
 * 绝不对落盘数据直接类型断言。escalateAfter 单独字段级降级：非正整数按 1 并警告。
 */
export function readModelsConfig(prd: Prd | null): ModelsReadResult {
  if (!prd || prd.models === undefined) return { config: null, warnings: [] };
  const v: unknown = prd.models;
  if (typeof v !== 'object' || v === null || Array.isArray(v)) {
    return { config: null, warnings: ['⚠️  prd.json 的 models 形状非法（应为对象），模型路由未启用'] };
  }
  const o = v as Record<string, unknown>;
  for (const key of ['builder', 'validator', 'escalation'] as const) {
    if (o[key] !== undefined && typeof o[key] !== 'string') {
      return { config: null, warnings: [`⚠️  prd.json 的 models 形状非法（${key} 应为字符串），模型路由未启用`] };
    }
  }
  const warnings: string[] = [];
  let escalateAfter = 1;
  if (o.escalateAfter !== undefined) {
    const n = o.escalateAfter;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) {
      escalateAfter = n;
    } else {
      warnings.push(`⚠️  models.escalateAfter 应为正整数，收到「${String(n)}」，已按缺省 1 处理`);
    }
  }
  if (escalateAfter >= MAX_RETRIES && typeof o.escalation === 'string') {
    warnings.push(`⚠️  models.escalateAfter (${escalateAfter}) ≥ 打回上限 ${MAX_RETRIES}，story 会先 blocked，升级永不生效`);
  }
  return {
    config: {
      builder: o.builder as string | undefined,
      validator: o.validator as string | undefined,
      escalation: o.escalation as string | undefined,
      escalateAfter,
    },
    warnings,
  };
}

export interface BuilderModelChoice {
  model: string | undefined;
  /** 本轮因重试触发了升级（供日志标注原因） */
  escalated: boolean;
  warnings: string[];
}

/** builder 阶段模型：CLI 覆盖 > escalation（retryCount ≥ escalateAfter）> story.model > 顶层 builder > 不传 */
export function resolveBuilderModel(opts: {
  cliOverride?: string;
  config: ResolvedModels | null;
  story: Story | null;
  retryCount: number;
}): BuilderModelChoice {
  const warnings: string[] = [];
  let storyModel: string | undefined;
  const rawStoryModel: unknown = opts.story?.model;
  if (rawStoryModel !== undefined) {
    if (typeof rawStoryModel === 'string') storyModel = rawStoryModel;
    else warnings.push(`⚠️  story ${opts.story!.id} 的 model 非字符串，已忽略该覆盖`);
  }
  if (opts.cliOverride) return { model: opts.cliOverride, escalated: false, warnings };
  const cfg = opts.config;
  if (cfg?.escalation && opts.retryCount >= cfg.escalateAfter) {
    return { model: cfg.escalation, escalated: true, warnings };
  }
  if (storyModel) return { model: storyModel, escalated: false, warnings };
  return { model: cfg?.builder, escalated: false, warnings };
}

/** validator 阶段模型：CLI 覆盖 > 顶层 validator > 不传。刻意不做 story 级/升级——把关水位恒定 */
export function resolveValidatorModel(opts: {
  cliOverride?: string;
  config: ResolvedModels | null;
}): string | undefined {
  return opts.cliOverride ?? opts.config?.validator;
}
