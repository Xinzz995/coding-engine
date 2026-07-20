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

const STAGE_KEYS = ['builder', 'validator', 'escalation'] as const;

function isSection(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * 解析一个扁平配置段（builder/validator/escalation + escalateAfter）。
 * label 用于警告定位：扁平形状是「models」，按工具分段是「models.<工具>」。
 * 阶段字段非字符串按整段非法（绝不对落盘数据直接类型断言）；
 * escalateAfter 单独字段级降级：非正整数按 1 并警告。
 */
function parseSection(o: Record<string, unknown>, label: string): ModelsReadResult {
  for (const key of STAGE_KEYS) {
    if (o[key] !== undefined && typeof o[key] !== 'string') {
      return { config: null, warnings: [`⚠️  prd.json 的 ${label} 形状非法（${key} 应为字符串），模型路由未启用`] };
    }
  }
  const warnings: string[] = [];
  let escalateAfter = 1;
  if (o.escalateAfter !== undefined) {
    const n = o.escalateAfter;
    if (typeof n === 'number' && Number.isInteger(n) && n >= 1) {
      escalateAfter = n;
    } else {
      warnings.push(`⚠️  ${label}.escalateAfter 应为正整数，收到「${String(n)}」，已按缺省 1 处理`);
    }
  }
  if (escalateAfter >= MAX_RETRIES && typeof o.escalation === 'string') {
    warnings.push(`⚠️  ${label}.escalateAfter (${escalateAfter}) ≥ 打回上限 ${MAX_RETRIES}，story 会先 blocked，升级永不生效`);
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

/**
 * models 两种形状的机械判别：任一键的值是对象 → 按 agent 工具分段（键=工具名）；
 * 否则为扁平段（对所运行工具原样生效，兼容既有 PRD）。两种形状混用整体非法——
 * 模型名对 agent 工具不可移植（claude 的 sonnet/codex 的 gpt-*），混用无法判定归属。
 */
function kindSectionKeys(o: Record<string, unknown>): string[] {
  return Object.keys(o).filter((k) => isSection(o[k]));
}

function hasFlatFields(o: Record<string, unknown>): boolean {
  return STAGE_KEYS.some((k) => o[k] !== undefined && !isSection(o[k])) || o.escalateAfter !== undefined;
}

/**
 * 读取并校验 prd.json 顶层 models，按当前运行的 agent 工具（kind）定位配置：
 * 未配置返回 null（静默）；整体形状非法返回 null + 警告；按工具分段但缺当前
 * 工具的段，返回 null + 警告（该工具无法定位模型名，路由不启用比传错名诚实）。
 */
export function readModelsConfig(prd: Prd | null, kind: string): ModelsReadResult {
  if (!prd || prd.models === undefined) return { config: null, warnings: [] };
  const v: unknown = prd.models;
  if (!isSection(v)) {
    return { config: null, warnings: ['⚠️  prd.json 的 models 形状非法（应为对象），模型路由未启用'] };
  }
  const kinds = kindSectionKeys(v);
  if (kinds.length > 0) {
    if (hasFlatFields(v)) {
      return { config: null, warnings: ['⚠️  prd.json 的 models 形状非法（按 agent 工具分段与扁平字段混用），模型路由未启用'] };
    }
    const section = v[kind];
    if (!isSection(section)) {
      return { config: null, warnings: [`⚠️  prd.json 的 models 未配置 ${kind} 段（已配置：${kinds.join('、')}），本次运行模型路由未启用`] };
    }
    return parseSection(section, `models.${kind}`);
  }
  return parseSection(v, 'models');
}

export interface ModelsSection {
  /** null = 扁平形状（不区分工具）；否则为 agent 工具名（claude/codex/…） */
  kind: string | null;
  config: ResolvedModels;
}

/**
 * 报告展示用：枚举 models 的全部配置段（扁平=单段 kind null；按工具分段=每工具一段）。
 * 报告不知道运行用的是哪个工具，如实列出全部段；段内非法只丢该段、警告保留。
 */
export function readModelsSections(prd: Prd | null): { sections: ModelsSection[]; warnings: string[] } {
  if (!prd || prd.models === undefined) return { sections: [], warnings: [] };
  const v: unknown = prd.models;
  if (!isSection(v)) {
    return { sections: [], warnings: ['⚠️  prd.json 的 models 形状非法（应为对象），模型路由未启用'] };
  }
  const kinds = kindSectionKeys(v);
  if (kinds.length > 0) {
    if (hasFlatFields(v)) {
      return { sections: [], warnings: ['⚠️  prd.json 的 models 形状非法（按 agent 工具分段与扁平字段混用），模型路由未启用'] };
    }
    const sections: ModelsSection[] = [];
    const warnings: string[] = [];
    for (const k of kinds) {
      const parsed = parseSection(v[k] as Record<string, unknown>, `models.${k}`);
      warnings.push(...parsed.warnings);
      if (parsed.config) sections.push({ kind: k, config: parsed.config });
    }
    return { sections, warnings };
  }
  const parsed = parseSection(v, 'models');
  return { sections: parsed.config ? [{ kind: null, config: parsed.config }] : [], warnings: parsed.warnings };
}

export interface BuilderModelChoice {
  model: string | undefined;
  /** 本轮因重试触发了升级（供日志标注原因） */
  escalated: boolean;
  warnings: string[];
}

/**
 * builder 阶段模型：CLI 覆盖 > escalation（retryCount ≥ escalateAfter）> story.model > 顶层 builder > 不传。
 * story.model 同样支持按工具分段（{ claude: "opus", codex: "…" }）：取当前工具的条目，
 * 缺该工具条目时静默回落阶段链（story 作者只为部分工具标注是合法姿势）。
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
      storyModel = rawStoryModel;
    } else if (isSection(rawStoryModel)) {
      const entry = rawStoryModel[opts.kind];
      if (entry !== undefined) {
        if (typeof entry === 'string') storyModel = entry;
        else warnings.push(`⚠️  story ${opts.story!.id} 的 model.${opts.kind} 非字符串，已忽略该覆盖`);
      }
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
