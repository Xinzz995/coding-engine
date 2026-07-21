import { readFileSync } from 'node:fs';
import type { AgentKind } from './agent.js';

export type StoryDifficulty = 'low' | 'medium' | 'high';

export interface Story {
  id: string;
  title: string;
  description: string;
  acceptanceCriteria: string[];
  priority: number;
  /** 启用 models 时由 prd-to-json 派生；衡量可靠完成 story 所需的模型推理能力。 */
  difficulty?: StoryDifficulty;
  /** 一至两句可审计理由：包含规则编号与仓库具体证据。 */
  difficultyReason?: string;
}

/** runner 绑定的模型路由；五个模型值都必须是对应 runner 全局模型目录声明的实际标识。 */
export interface ModelsConfig {
  runner: AgentKind;
  builder: Record<StoryDifficulty, string>;
  validator: string;
  escalation: string;
}

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  /** 意图真相源（源 PRD）的仓库相对路径；由 prd-to-json 写入，引擎只透传不解析 */
  sourcePrd?: string;
  /** 机械门禁命令（完整 shell 命令行，引擎逐条执行）；缺失或空数组=门禁不启用 */
  qualityChecks?: string[];
  /** 模型路由；缺失时只使用 CLI 临时覆盖或 runner 默认模型。 */
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
