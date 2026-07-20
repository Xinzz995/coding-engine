import type { Prd, Story } from './prd.js';
import { MAX_RETRIES } from './gate.js';

/**
 * 规范化后的模型路由配置：阶段字段已按当前运行的 agent 工具解析为具体模型名；
 * profiles 原样保留（story 级引用在 resolveBuilderModel 里解析）。
 * escalateAfter 总有值（缺省/非法一律归 1）。
 */
export interface ResolvedModels {
  builder?: string;
  validator?: string;
  escalation?: string;
  escalateAfter: number;
  /** 具名模型档案：档案名 → { 工具名 → 模型名 }；未配置时为空对象 */
  profiles: Record<string, Record<string, string>>;
}

export interface ModelsReadResult {
  /** null = 未配置或整体形状非法（按未配置运行） */
  config: ResolvedModels | null;
  warnings: string[];
}

const STAGE_KEYS = ['builder', 'validator', 'escalation'] as const;

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 形状校验通过、但未按工具解析的 models 原始配置（报告展示直接消费它） */
export interface ModelsSpec {
  /** 阶段字段的原始模型引用（档案名或字面模型名） */
  stages: { builder?: string; validator?: string; escalation?: string };
  escalateAfter: number;
  profiles: Record<string, Record<string, string>>;
}

/**
 * 读取并校验 prd.json 顶层 models 的形状（不做按工具解析）：
 * spec=null 且无警告 = 未配置；spec=null 有警告 = 整体形状非法
 * （阶段字段非字符串 / profiles 结构错）。绝不对落盘数据直接类型断言（patterns 约定）。
 */
export function readModelsSpec(prd: Prd | null): { spec: ModelsSpec | null; warnings: string[] } {
  if (!prd || prd.models === undefined) return { spec: null, warnings: [] };
  const v: unknown = prd.models;
  if (!isRecord(v)) {
    return { spec: null, warnings: ['⚠️  prd.json 的 models 形状非法（应为对象），模型路由未启用'] };
  }
  for (const key of STAGE_KEYS) {
    if (v[key] !== undefined && typeof v[key] !== 'string') {
      return { spec: null, warnings: [`⚠️  prd.json 的 models 形状非法（${key} 应为字符串），模型路由未启用`] };
    }
  }
  const profiles: Record<string, Record<string, string>> = {};
  if (v.profiles !== undefined) {
    if (!isRecord(v.profiles)) {
      return { spec: null, warnings: ['⚠️  prd.json 的 models 形状非法（profiles 应为对象），模型路由未启用'] };
    }
    for (const [name, entry] of Object.entries(v.profiles)) {
      if (!isRecord(entry)) {
        return { spec: null, warnings: [`⚠️  prd.json 的 models 形状非法（profiles.${name} 应为「工具名 → 模型名」对象），模型路由未启用`] };
      }
      for (const [kind, model] of Object.entries(entry)) {
        if (typeof model !== 'string') {
          return { spec: null, warnings: [`⚠️  prd.json 的 models 形状非法（profiles.${name}.${kind} 应为字符串），模型路由未启用`] };
        }
      }
      profiles[name] = entry as Record<string, string>;
    }
  }
  const warnings: string[] = [];
  let escalateAfter = 1;
  if (v.escalateAfter !== undefined) {
    const n = v.escalateAfter;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) {
      escalateAfter = n;
    } else {
      warnings.push(`⚠️  models.escalateAfter 应为正整数，收到「${String(n)}」，已按缺省 1 处理`);
    }
  }
  if (escalateAfter >= MAX_RETRIES && typeof v.escalation === 'string') {
    warnings.push(`⚠️  models.escalateAfter (${escalateAfter}) ≥ 打回上限 ${MAX_RETRIES}，story 会先 blocked，升级永不生效`);
  }
  return {
    spec: {
      stages: {
        builder: v.builder as string | undefined,
        validator: v.validator as string | undefined,
        escalation: v.escalation as string | undefined,
      },
      escalateAfter,
      profiles,
    },
    warnings,
  };
}

/**
 * 解析一个模型引用：命中档案名 → 取当前工具的条目（缺条目=不生效+警告，
 * 不传比传错名诚实）；未命中 → 当字面模型名原样透传（旧扁平 PRD 零迁移）。
 */
function resolveRef(
  ref: string | undefined,
  profiles: Record<string, Record<string, string>>,
  kind: string,
  warnings: string[],
): string | undefined {
  if (ref === undefined) return undefined;
  const profile = profiles[ref];
  if (profile === undefined) return ref;
  const model = profile[kind];
  if (model === undefined) {
    warnings.push(`⚠️  models 档案「${ref}」未配置 ${kind} 工具的模型名，该引用不生效（不传 --model）`);
    return undefined;
  }
  return model;
}

/**
 * 读取 models 并按当前运行的 agent 工具（kind）解析阶段模型：
 * 未配置返回 null（静默）；形状非法返回 null + 警告。
 * profiles 让同一份配置在任何工具下各自定位到正确的模型名（ADR-010）。
 */
export function readModelsConfig(prd: Prd | null, kind: string): ModelsReadResult {
  const { spec, warnings: specWarnings } = readModelsSpec(prd);
  if (spec === null) return { config: null, warnings: specWarnings };
  const warnings = [...specWarnings];
  return {
    config: {
      builder: resolveRef(spec.stages.builder, spec.profiles, kind, warnings),
      validator: resolveRef(spec.stages.validator, spec.profiles, kind, warnings),
      escalation: resolveRef(spec.stages.escalation, spec.profiles, kind, warnings),
      escalateAfter: spec.escalateAfter,
      profiles: spec.profiles,
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

/**
 * builder 阶段模型：CLI 覆盖 > escalation（retryCount ≥ escalateAfter）> story.model > 顶层 builder > 不传。
 * story.model 写模型引用：档案名按当前工具解析（缺条目警告并回落阶段链），否则当字面模型名。
 */
export function resolveBuilderModel(opts: {
  cliOverride?: string;
  config: ResolvedModels | null;
  story: Story | null;
  retryCount: number;
  kind: string;
}): BuilderModelChoice {
  const warnings: string[] = [];
  let storyModel: string | undefined;
  const rawStoryModel: unknown = opts.story?.model;
  if (rawStoryModel !== undefined) {
    if (typeof rawStoryModel === 'string') {
      storyModel = resolveRef(rawStoryModel, opts.config?.profiles ?? {}, opts.kind, warnings);
    } else {
      warnings.push(`⚠️  story ${opts.story!.id} 的 model 非字符串，已忽略该覆盖`);
    }
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
