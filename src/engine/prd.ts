import type { AgentKind } from './agent.js';
import type { FrozenQualityChecks } from '../quality/contract.js';
import { readStableFile } from '../workspace-safety/stable-file.js';
import type { IssueExecutionContract } from './issue-execution-contract.js';

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
  /** ready Issue 专用的责任分层合同；普通 PRD 不需要此字段。 */
  executionContract?: IssueExecutionContract;
  /** 规范化 executionContract 的冻结摘要；任一字段变化都会使旧运行失效。 */
  executionContractDigest?: string;
  /** 可验证 TDD 政策；字段一旦出现即严格校验，非法时 fail closed。 */
  tdd?: TddConfig;
  /** 模型路由；缺失时只使用 CLI 临时覆盖或 runner 默认模型。 */
  models?: ModelsConfig;
  userStories: Story[];
}

export type PrdStorySetValidation = { valid: true } | { valid: false; message: string };

/**
 * 正式循环用于判定 Story 集合是否能作为唯一执行身份。这里只收紧集合与 ID；
 * 更完整的内容约束仍由 PRD 生成链和各消费协议负责。
 */
export function validatePrdStorySet(prd: Prd): PrdStorySetValidation {
  const rawStories = (prd as unknown as { userStories?: unknown }).userStories;
  if (!Array.isArray(rawStories) || rawStories.length === 0) {
    return { valid: false, message: 'prd.json 必须包含至少一个 Story' };
  }
  const stories = rawStories as unknown[];
  const seen = new Set<string>();
  for (let index = 0; index < stories.length; index += 1) {
    const value: unknown = stories[index];
    const id =
      typeof value === 'object' && value !== null && !Array.isArray(value)
        ? (value as Record<string, unknown>).id
        : undefined;
    if (typeof id !== 'string' || id.length === 0 || id.trim() !== id || /[\0\r\n]/u.test(id)) {
      return { valid: false, message: `userStories[${index}] 的 Story ID 非法` };
    }
    const key = id.toLocaleLowerCase('en-US');
    if (seen.has(key)) {
      return { valid: false, message: `userStories 包含重复 Story ID：${id}` };
    }
    seen.add(key);
  }
  return { valid: true };
}

export function tryReadPrd(path: string): Prd | null {
  const file = readStableFile(path, { label: 'prd.json' });
  if (file.status !== 'ready') return null;
  try {
    return JSON.parse(file.bytes.toString('utf8')) as Prd;
  } catch {
    return null;
  }
}
