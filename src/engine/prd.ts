import { readFileSync } from 'node:fs';
import type { AgentKind } from './agent.js';
import type { FrozenQualityChecks } from '../quality/contract.js';

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

export interface TddPolicyFile {
  /** 相对项目根的受保护政策文件；运行时会校验 realpath 与 SHA-256。 */
  path: string;
  sha256: string;
}

export interface TddConfig {
  /** 项目提供的完整覆盖率门禁命令；必须自行保证零测试与阈值不达标时返回非零。 */
  coverageCheck: string;
  /** 用户批准的生产代码 Git pathspec；只在这些路径内扫描新增覆盖忽略标记。 */
  sourcePathspecs: string[];
  /** 阈值、排除项、零测试策略及命令委托脚本的受保护文件摘要。 */
  policyFiles: TddPolicyFile[];
  /** 启用 TDD 时冻结的完整 Git commit id。 */
  baselineRef: string;
  /** baselineRef 之后不得新增的覆盖忽略标记（按大小写不敏感字面匹配）。 */
  forbiddenAddedPatterns: string[];
}

export interface Prd {
  project: string;
  branchName: string;
  description: string;
  /** 意图真相源（源 PRD）的仓库相对路径；由 prd-to-json 写入，引擎只透传不解析 */
  sourcePrd?: string;
  /** 派生该 PRD 时冻结的 .coding-x/quality.json 规范化摘要。 */
  qualityContractDigest?: string;
  /**
   * 由质量契约原样派生的检查快照；正式模式必须存在且与契约一致。
   * string[] 只为读取 0.29 及更早的历史 workspace，正式模式会拒绝。
   */
  qualityChecks?: FrozenQualityChecks | string[];
  /** 可验证 TDD 政策；字段一旦出现即严格校验，非法时 fail closed。 */
  tdd?: TddConfig;
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
