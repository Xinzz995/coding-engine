import { readFileSync } from 'node:fs';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  /**
   * builder 阶段模型覆盖（可选，只作用于 builder；validator 恒定不受影响）。
   * 字符串=对所运行 agent 工具原样透传；按工具分段（{ claude: "opus", codex: "…" }）
   * =取当前工具的条目，缺条目回落阶段链——模型名对工具不可移植。
   */
  model?: string | Record<string, string>;
}

/** 一个阶段配置段：builder/validator 默认模型与打回升级模型 */
export interface ModelsStageConfig {
  builder?: string;
  validator?: string;
  escalation?: string;
  escalateAfter?: number;
}

/**
 * 模型路由配置（可选）；缺失=不传 --model，行为与历史版本一致。
 * 扁平段=对所运行工具原样生效（兼容旧 PRD）；按 agent 工具分段
 * （键=工具名 claude/codex/…）=每个工具定位自己的模型名，运行时取所用工具的段。
 */
export type ModelsConfig = ModelsStageConfig | Record<string, ModelsStageConfig>;

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  /** 意图真相源（源 PRD）的仓库相对路径；由 prd-to-json 写入，引擎只透传不解析 */
  sourcePrd?: string;
  /** 机械门禁命令（完整 shell 命令行，引擎逐条执行）；缺失或空数组=门禁不启用 */
  qualityChecks?: string[];
  /** 模型路由（阶段默认/story 覆盖/重试升级）；缺失=模型路由不启用 */
  models?: ModelsConfig;
  userStories: Story[];
}

export function tryReadPrd(path: string): Prd | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as Prd;
  } catch {
    return null;
  }
}
