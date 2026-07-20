import { readFileSync } from 'node:fs';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  /**
   * builder 阶段模型覆盖（可选，只作用于 builder；validator 恒定不受影响）。
   * 写模型引用：命中 models.profiles 的档案名按当前工具解析，否则当字面模型名透传。
   */
  model?: string;
}

/**
 * 模型路由配置（可选）；缺失=不传 --model，行为与历史版本一致。
 * profiles=具名模型档案（档案名 → { 工具名 → 模型名 }），配置一次、任何 agent 工具可用；
 * 各阶段字段写模型引用（档案名或字面模型名）。模型名对工具不可移植（claude 的
 * sonnet/codex 的 gpt-*），档案让同一份配置在不同工具下各自定位到正确名字（ADR-010）。
 */
export interface ModelsConfig {
  profiles?: Record<string, Record<string, string>>;
  builder?: string;
  validator?: string;
  escalation?: string;
  escalateAfter?: number;
}

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
