import { createHash } from 'node:crypto';
import type { QualityContract, QualityPlatform } from '../quality/contract.js';
import {
  GITHUB_ACTIONS_APP_ID,
  type GitHubRuleset,
  type RequiredStatusCheck,
} from '../quality/github.js';
import { findManagedRuleset, validateManagedRuleset } from '../quality/ruleset.js';

export const ISSUE_EXECUTION_CONTRACT_SCHEMA_VERSION = 1 as const;
export const ISSUE_EXECUTION_CONTRACT_DOMAIN = 'coding-x-ready-issue-execution-v1' as const;
export const ISSUE_RUN_METRICS = [
  'ready-to-trusted',
  'active',
  'waiting',
  'continuations',
] as const;

export type IssueCheckMode = 'scoped' | 'full';
export type IssueRunMetric = (typeof ISSUE_RUN_METRICS)[number];

export interface IssueExecutionContract {
  readonly schemaVersion: typeof ISSUE_EXECUTION_CONTRACT_SCHEMA_VERSION;
  readonly storyAcceptance: {
    readonly evidenceSource: 'validator';
    readonly network: 'disabled';
    readonly criteria: readonly string[];
  };
  readonly localChecks: {
    readonly evidenceSource: 'engine';
    readonly network: 'current-host';
    readonly mode: IssueCheckMode;
    readonly checkIds: readonly string[];
  };
  readonly remoteDelivery: {
    readonly evidenceSource: 'github';
    readonly network: 'github-actions';
    readonly mode: IssueCheckMode;
    readonly checkIds: readonly string[];
    readonly ruleset: 'required';
  };
  readonly runMetrics: {
    readonly evidenceSource: 'engine-clock';
    readonly metrics: readonly IssueRunMetric[];
  };
}

export type IssueExecutionContractParseResult =
  | { readonly ok: true; readonly contract: IssueExecutionContract; readonly digest: string }
  | { readonly ok: false; readonly errors: readonly string[] };

export interface IssueExecutionContractCapabilities {
  readonly localMode: IssueCheckMode;
  readonly localCheckIds: readonly string[];
  readonly remoteMode: IssueCheckMode;
  readonly remoteCheckIds: readonly string[];
}

export type IssueExecutionContractReconciliation =
  | { readonly ok: true; readonly capabilities: IssueExecutionContractCapabilities }
  | { readonly ok: false; readonly errors: readonly string[] };

type UnknownRecord = Record<string, unknown>;

export function qualityPlatformForNode(platform: NodeJS.Platform): QualityPlatform | null {
  if (platform === 'linux') return 'linux';
  if (platform === 'darwin') return 'macos';
  if (platform === 'win32') return 'windows';
  return null;
}

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function exactShape(
  value: unknown,
  path: string,
  keys: readonly string[],
  errors: string[],
): value is UnknownRecord {
  if (!isRecord(value)) {
    errors.push(`${path} 必须是对象`);
    return false;
  }
  const allowed = new Set(keys);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) errors.push(`${path}.${key} 是未知字段`);
  }
  for (const key of keys) {
    if (!(key in value)) errors.push(`${path}.${key} 缺失`);
  }
  return true;
}

function literal(value: unknown, expected: string, path: string, errors: string[]): boolean {
  if (value !== expected) {
    errors.push(`${path} 必须是 ${JSON.stringify(expected)}`);
    return false;
  }
  return true;
}

function mode(value: unknown, path: string, errors: string[]): value is IssueCheckMode {
  if (value !== 'scoped' && value !== 'full') {
    errors.push(`${path} 必须是 scoped 或 full`);
    return false;
  }
  return true;
}

function nonEmptyStrings(value: unknown, path: string, errors: string[]): string[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${path} 必须是非空字符串数组`);
    return null;
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (
      typeof entry !== 'string' ||
      entry.trim() === '' ||
      entry !== entry.trim() ||
      entry.includes('\0') ||
      entry.length > 4_000
    ) {
      errors.push(`${path}[${index}] 必须是首尾无空白且不超过 4000 字的非空字符串`);
      continue;
    }
    result.push(entry);
  }
  if (new Set(result).size !== result.length) errors.push(`${path} 不能包含重复条目`);
  return result;
}

function checkIds(value: unknown, path: string, errors: string[]): string[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是字符串数组`);
    return null;
  }
  const result: string[] = [];
  for (const [index, entry] of value.entries()) {
    if (typeof entry !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/u.test(entry)) {
      errors.push(`${path}[${index}] 不是稳定 check id`);
      continue;
    }
    result.push(entry);
  }
  if (new Set(result).size !== result.length) errors.push(`${path} 不能包含重复 check id`);
  return result;
}

function parseMetrics(value: unknown, path: string, errors: string[]): IssueRunMetric[] | null {
  if (!Array.isArray(value)) {
    errors.push(`${path} 必须是数组`);
    return null;
  }
  if (
    value.length !== ISSUE_RUN_METRICS.length ||
    value.some((metric, index) => metric !== ISSUE_RUN_METRICS[index])
  ) {
    errors.push(`${path} 必须依次为 ${ISSUE_RUN_METRICS.join('、')}`);
    return null;
  }
  return [...ISSUE_RUN_METRICS];
}

export function digestIssueExecutionContract(contract: IssueExecutionContract): string {
  return `sha256:${createHash('sha256')
    .update(JSON.stringify({ domain: ISSUE_EXECUTION_CONTRACT_DOMAIN, contract }), 'utf8')
    .digest('hex')}`;
}

export function parseIssueExecutionContract(value: unknown): IssueExecutionContractParseResult {
  const errors: string[] = [];
  if (
    !exactShape(
      value,
      '执行合同',
      ['schemaVersion', 'storyAcceptance', 'localChecks', 'remoteDelivery', 'runMetrics'],
      errors,
    )
  ) {
    return { ok: false, errors };
  }
  if (value.schemaVersion !== ISSUE_EXECUTION_CONTRACT_SCHEMA_VERSION) {
    errors.push(
      `执行合同.schemaVersion 必须是 ${ISSUE_EXECUTION_CONTRACT_SCHEMA_VERSION}；旧格式请迁移后重新添加 ready-for-agent 标签`,
    );
  }

  let criteria: string[] | null = null;
  if (
    exactShape(
      value.storyAcceptance,
      '执行合同.storyAcceptance',
      ['evidenceSource', 'network', 'criteria'],
      errors,
    )
  ) {
    literal(
      value.storyAcceptance.evidenceSource,
      'validator',
      '执行合同.storyAcceptance.evidenceSource',
      errors,
    );
    literal(value.storyAcceptance.network, 'disabled', '执行合同.storyAcceptance.network', errors);
    criteria = nonEmptyStrings(
      value.storyAcceptance.criteria,
      '执行合同.storyAcceptance.criteria',
      errors,
    );
  }

  let localMode: IssueCheckMode | null = null;
  let localIds: string[] | null = null;
  if (
    exactShape(
      value.localChecks,
      '执行合同.localChecks',
      ['evidenceSource', 'network', 'mode', 'checkIds'],
      errors,
    )
  ) {
    literal(
      value.localChecks.evidenceSource,
      'engine',
      '执行合同.localChecks.evidenceSource',
      errors,
    );
    literal(value.localChecks.network, 'current-host', '执行合同.localChecks.network', errors);
    if (mode(value.localChecks.mode, '执行合同.localChecks.mode', errors)) {
      localMode = value.localChecks.mode;
    }
    localIds = checkIds(value.localChecks.checkIds, '执行合同.localChecks.checkIds', errors);
  }

  let remoteMode: IssueCheckMode | null = null;
  let remoteIds: string[] | null = null;
  if (
    exactShape(
      value.remoteDelivery,
      '执行合同.remoteDelivery',
      ['evidenceSource', 'network', 'mode', 'checkIds', 'ruleset'],
      errors,
    )
  ) {
    literal(
      value.remoteDelivery.evidenceSource,
      'github',
      '执行合同.remoteDelivery.evidenceSource',
      errors,
    );
    literal(
      value.remoteDelivery.network,
      'github-actions',
      '执行合同.remoteDelivery.network',
      errors,
    );
    literal(value.remoteDelivery.ruleset, 'required', '执行合同.remoteDelivery.ruleset', errors);
    if (mode(value.remoteDelivery.mode, '执行合同.remoteDelivery.mode', errors)) {
      remoteMode = value.remoteDelivery.mode;
    }
    remoteIds = checkIds(value.remoteDelivery.checkIds, '执行合同.remoteDelivery.checkIds', errors);
  }

  let metrics: IssueRunMetric[] | null = null;
  if (exactShape(value.runMetrics, '执行合同.runMetrics', ['evidenceSource', 'metrics'], errors)) {
    literal(
      value.runMetrics.evidenceSource,
      'engine-clock',
      '执行合同.runMetrics.evidenceSource',
      errors,
    );
    metrics = parseMetrics(value.runMetrics.metrics, '执行合同.runMetrics.metrics', errors);
  }

  if (localMode === 'full' && (localIds?.length ?? 0) > 0) {
    errors.push('执行合同.localChecks 使用 full 时 checkIds 必须为空；full 已表示全部当前平台检查');
  }
  if (remoteMode === 'full' && (remoteIds?.length ?? 0) > 0) {
    errors.push('执行合同.remoteDelivery 使用 full 时 checkIds 必须为空；full 已表示全部远端检查');
  }
  if (
    errors.length > 0 ||
    criteria === null ||
    localMode === null ||
    localIds === null ||
    remoteMode === null ||
    remoteIds === null ||
    metrics === null
  ) {
    return { ok: false, errors };
  }

  const contract: IssueExecutionContract = {
    schemaVersion: ISSUE_EXECUTION_CONTRACT_SCHEMA_VERSION,
    storyAcceptance: {
      evidenceSource: 'validator',
      network: 'disabled',
      criteria: [...criteria],
    },
    localChecks: {
      evidenceSource: 'engine',
      network: 'current-host',
      mode: localMode,
      checkIds: [...localIds],
    },
    remoteDelivery: {
      evidenceSource: 'github',
      network: 'github-actions',
      mode: remoteMode,
      checkIds: [...remoteIds],
      ruleset: 'required',
    },
    runMetrics: {
      evidenceSource: 'engine-clock',
      metrics: [...metrics],
    },
  };
  return { ok: true, contract, digest: digestIssueExecutionContract(contract) };
}

function declaredChecks(contract: QualityContract): Map<
  string,
  {
    readonly id: string;
    readonly platforms: readonly QualityPlatform[];
  }
> {
  const checks = new Map<string, { id: string; platforms: readonly QualityPlatform[] }>();
  for (const category of ['test', 'build', 'static', 'security'] as const) {
    const policy = contract.checks[category];
    if (!('checks' in policy)) continue;
    for (const check of policy.checks) {
      checks.set(check.id, { id: check.id, platforms: check.command.platforms });
    }
  }
  return checks;
}

export function reconcileIssueExecutionContract(
  execution: IssueExecutionContract,
  quality: QualityContract,
  platform: QualityPlatform,
): IssueExecutionContractReconciliation {
  const errors: string[] = [];
  const checks = declaredChecks(quality);
  const localIds =
    execution.localChecks.mode === 'full'
      ? [...checks.values()]
          .filter((check) => check.platforms.includes(platform))
          .map((check) => check.id)
      : [...execution.localChecks.checkIds];
  for (const id of execution.localChecks.checkIds) {
    const check = checks.get(id);
    if (!check) {
      errors.push(`本地检查 ${id} 不存在于当前质量契约`);
    } else if (!check.platforms.includes(platform)) {
      errors.push(
        `本地检查 ${id} 不支持当前平台 ${platform}（仅支持 ${check.platforms.join('、')}）；` +
          '请移到 remoteDelivery 或修改质量契约',
      );
    }
  }
  if (localIds.length === 0 && execution.localChecks.mode === 'full') {
    errors.push(`本地 full 在当前平台 ${platform} 没有可运行检查`);
  }

  const jobCheckIds = new Set(quality.github.jobs.flatMap((job) => job.checkIds));
  const remoteIds =
    execution.remoteDelivery.mode === 'full'
      ? [...checks.keys()]
      : [...execution.remoteDelivery.checkIds];
  if (execution.remoteDelivery.mode === 'full') {
    errors.push(
      '远端 full 当前无法由一次 PR 事件强制取得完整矩阵凭证；请使用 remoteDelivery scoped 与稳定 check id',
    );
  }
  for (const id of remoteIds) {
    if (!checks.has(id)) {
      errors.push(`远端检查 ${id} 不存在于当前质量契约`);
    } else if (!jobCheckIds.has(id)) {
      errors.push(`远端检查 ${id} 没有对应的 GitHub job，当前流程无法取得权威凭证`);
    }
  }
  if (quality.github.requiredChecks.length === 0) {
    errors.push('远端交付没有质量契约声明的 GitHub 必需检查');
  }

  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    capabilities: {
      localMode: execution.localChecks.mode,
      localCheckIds: [...execution.localChecks.checkIds],
      remoteMode: execution.remoteDelivery.mode,
      remoteCheckIds: [...execution.remoteDelivery.checkIds],
    },
  };
}

/**
 * Agent 前只核对远端是否存在当前质量契约声明的权威裁决边界；
 * 当前 PR 的实际 check runs 仍由最终 Review 在具体 head 上读取。
 */
export function reconcileIssueRemoteAuthority(
  quality: QualityContract,
  rulesets: readonly GitHubRuleset[],
): string[] {
  try {
    const ruleset = findManagedRuleset([...rulesets]);
    if (!ruleset) return ['没有 coding-x 管理的默认分支 Ruleset'];
    const expectedChecks: RequiredStatusCheck[] = quality.github.requiredChecks.map((context) => ({
      context,
      integration_id: GITHUB_ACTIONS_APP_ID,
    }));
    return validateManagedRuleset(ruleset, expectedChecks, quality.github.requiredCodeScanning);
  } catch (error) {
    return [error instanceof Error ? error.message : String(error)];
  }
}
