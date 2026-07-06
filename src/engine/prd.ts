import { readFileSync } from 'node:fs';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  /** builder 阶段模型覆盖（可选，只作用于 builder；validator 恒定不受影响） */
  model?: string;
}

/** 模型路由配置（可选）；缺失=不传 --model，行为与历史版本一致 */
export interface ModelsConfig {
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
