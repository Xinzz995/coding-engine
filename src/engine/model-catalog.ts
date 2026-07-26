import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import type { AgentKind } from './agent.js';

export interface ConfiguredModel {
  id: string;
  label?: string;
}

export interface GlobalModelConfig {
  version: 1;
  models: Partial<Record<AgentKind, ConfiguredModel[]>>;
}

export type GlobalModelConfigReadResult =
  | { status: 'available'; path: string; config: GlobalModelConfig }
  | { status: 'error'; path: string; errors: string[] };

export type ModelCatalogResult =
  | {
      status: 'available';
      runner: AgentKind;
      models: ConfiguredModel[];
      source: 'global-config';
      configPath: string;
    }
  | { status: 'error'; runner: AgentKind; error: string; configPath: string };

export type InitializeGlobalModelConfigResult =
  | { status: 'created'; path: string }
  | { status: 'exists'; path: string }
  | { status: 'error'; path: string; error: string };

const RUNNERS: AgentKind[] = ['claude', 'codex', 'cursor'];

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownFields(value: Record<string, unknown>, allowed: string[], prefix: string): string[] {
  return Object.keys(value)
    .filter((key) => !allowed.includes(key))
    .map((key) => `${prefix}未知字段 ${key}`);
}

/**
 * 全局模型目录位置。环境变量只提供一个显式覆盖层；默认路径固定，避免同一机器上
 * 因不同 shell 的 XDG 设置读到两份互相漂移的配置。
 */
export function resolveGlobalConfigPath(
  env: NodeJS.ProcessEnv = process.env,
  homeDir = homedir(),
): string {
  const override = env.CODING_X_CONFIG?.trim();
  if (override) return isAbsolute(override) ? override : resolve(override);
  return join(homeDir, '.config', 'coding-x', 'config.json');
}

function parseGlobalModelConfig(value: unknown): { config: GlobalModelConfig | null; errors: string[] } {
  if (!isRecord(value)) return { config: null, errors: ['全局模型配置必须是对象'] };
  const errors = unknownFields(value, ['version', 'models'], '顶层');
  if (value.version !== 1) errors.push('version 必须是 1');
  if (!isRecord(value.models)) {
    errors.push('models 必须是对象');
    return { config: null, errors };
  }
  errors.push(...Object.keys(value.models)
    .filter((key) => !RUNNERS.includes(key as AgentKind))
    .map((key) => `models 未知 runner ${key}`));
  const models: Partial<Record<AgentKind, ConfiguredModel[]>> = {};
  for (const runner of RUNNERS) {
    const rawModels = value.models[runner];
    if (rawModels === undefined) continue;
    if (!Array.isArray(rawModels)) {
      errors.push(`models.${runner} 必须是数组`);
      continue;
    }
    const parsed: ConfiguredModel[] = [];
    const ids = new Set<string>();
    rawModels.forEach((raw, index) => {
      const prefix = `models.${runner}[${index}]`;
      if (!isRecord(raw)) {
        errors.push(`${prefix} 必须是对象`);
        return;
      }
      errors.push(...unknownFields(raw, ['id', 'label'], `${prefix} `));
      if (typeof raw.id !== 'string' || raw.id.length === 0) {
        errors.push(`${prefix}.id 必须是非空字符串`);
        return;
      }
      if (raw.id.trim() !== raw.id) {
        errors.push(`${prefix}.id 不得包含首尾空白`);
        return;
      }
      if (raw.label !== undefined
        && (typeof raw.label !== 'string' || raw.label.length === 0 || raw.label.trim() !== raw.label)) {
        errors.push(`${prefix}.label 必须是非空字符串且不得包含首尾空白`);
        return;
      }
      if (ids.has(raw.id)) {
        errors.push(`models.${runner} 包含重复模型 ID ${raw.id}`);
        return;
      }
      ids.add(raw.id);
      parsed.push({ id: raw.id, ...(typeof raw.label === 'string' ? { label: raw.label } : {}) });
    });
    models[runner] = parsed;
  }
  if (errors.length > 0) return { config: null, errors };
  return { config: { version: 1, models }, errors: [] };
}

export function readGlobalModelConfig(
  path = resolveGlobalConfigPath(),
): GlobalModelConfigReadResult {
  if (!existsSync(path)) {
    return { status: 'error', path, errors: [`未找到全局模型配置：${path}`] };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf-8');
  } catch {
    return { status: 'error', path, errors: [`无法读取全局模型配置：${path}`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(raw) as unknown;
  } catch {
    return { status: 'error', path, errors: [`全局模型配置不是合法 JSON：${path}`] };
  }
  const parsed = parseGlobalModelConfig(value);
  if (parsed.config === null) return { status: 'error', path, errors: parsed.errors };
  return { status: 'available', path, config: parsed.config };
}

export function listConfiguredModels(
  runner: AgentKind,
  path = resolveGlobalConfigPath(),
): ModelCatalogResult {
  const read = readGlobalModelConfig(path);
  if (read.status === 'error') {
    return { status: 'error', runner, configPath: path, error: read.errors.join('；') };
  }
  const models = read.config.models[runner] ?? [];
  if (models.length === 0) {
    return {
      status: 'error', runner, configPath: path,
      error: `全局模型目录未配置任何模型（runner: ${runner}）：${path}`,
    };
  }
  return { status: 'available', runner, source: 'global-config', configPath: path, models };
}

export function initializeGlobalModelConfig(
  path = resolveGlobalConfigPath(),
): InitializeGlobalModelConfigResult {
  try {
    mkdirSync(dirname(path), { recursive: true });
  } catch (err) {
    return {
      status: 'error', path,
      error: `无法创建全局模型配置：${err instanceof Error ? err.message : String(err)}`,
    };
  }
  try {
    writeFileSync(path, `${JSON.stringify({ version: 1, models: {} }, null, 2)}\n`, { flag: 'wx' });
    return { status: 'created', path };
  } catch (err) {
    const code = isRecord(err) && typeof err.code === 'string' ? err.code : null;
    // 父目录已单独创建成功，因此这里的 EEXIST 只能来自目标的原子 wx 创建竞争；
    // 不再先 exists 再 write，避免检查与创建之间的竞态窗口。
    if (code === 'EEXIST') return { status: 'exists', path };
    return {
      status: 'error', path,
      error: `无法创建全局模型配置：${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

export function renderModelCatalogJson(result: ModelCatalogResult): string {
  return JSON.stringify(result, null, 2);
}

export function renderModelCatalogText(result: ModelCatalogResult): string {
  if (result.status === 'error') return `❌ ${result.error}`;
  const rows = result.models.map((model) => `- ${model.id}${model.label ? ` — ${model.label}` : ''}`);
  return [
    `${result.runner} 全局模型目录（${result.configPath}）：`,
    ...rows,
    'ℹ️  该目录表示用户允许使用的模型 ID，不证明 provider 当前一定可用。',
  ].join('\n');
}
