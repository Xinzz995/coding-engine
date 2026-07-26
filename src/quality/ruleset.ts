import {
  LEGACY_BOOTSTRAP_RULESET_NAME,
  MANAGED_RULESET_NAME,
  type GitHubRuleset,
  type GitHubRulesetPayload,
  type GitHubRulesetRule,
  type RequiredStatusCheck,
} from './github.js';
import type {
  QualityCodeScanningAlertsThreshold,
  QualityCodeScanningSecurityAlertsThreshold,
  QualityCodeScanningTool,
} from './contract.js';

const MANAGED_RULE_TYPES = new Set([
  'deletion', 'non_fast_forward', 'pull_request', 'required_status_checks',
]);
const CODE_SCANNING_ALERTS_THRESHOLDS = new Set<QualityCodeScanningAlertsThreshold>([
  'none', 'errors', 'errors_and_warnings', 'all',
]);
const CODE_SCANNING_SECURITY_ALERTS_THRESHOLDS =
  new Set<QualityCodeScanningSecurityAlertsThreshold>([
    'none', 'critical', 'high_or_higher', 'medium_or_higher', 'all',
  ]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function uniqueByType(rules: GitHubRulesetRule[], type: string): GitHubRulesetRule | null {
  const found = rules.filter((rule) => rule.type === type);
  if (found.length > 1) throw new Error(`Ruleset 含重复规则 ${type}`);
  return found[0] ?? null;
}

export function findManagedRuleset(rulesets: GitHubRuleset[]): GitHubRuleset | null {
  const found = rulesets.filter((ruleset) => (
    ruleset.name === MANAGED_RULESET_NAME || ruleset.name === LEGACY_BOOTSTRAP_RULESET_NAME
  ));
  if (found.length > 1) throw new Error('发现多个 coding-x 管理的 Ruleset，必须先人工消除歧义');
  return found[0] ?? null;
}

export function requiredChecksFromRuleset(ruleset: GitHubRuleset | null): RequiredStatusCheck[] {
  if (!ruleset) return [];
  const rule = uniqueByType(ruleset.rules, 'required_status_checks');
  if (!rule) return [];
  const raw = rule.parameters?.required_status_checks;
  if (!Array.isArray(raw)) throw new Error('Ruleset required_status_checks 形状非法');
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.context !== 'string'
        || !Number.isInteger(entry.integration_id) || (entry.integration_id as number) <= 0) {
      throw new Error('Ruleset 必需检查缺少 context 或 integration_id');
    }
    return { context: entry.context, integration_id: entry.integration_id as number };
  });
}

export function codeScanningToolsFromRuleset(
  ruleset: GitHubRuleset | null,
): QualityCodeScanningTool[] {
  if (!ruleset) return [];
  const rule = uniqueByType(ruleset.rules, 'code_scanning');
  if (!rule) return [];
  const raw = rule.parameters?.code_scanning_tools;
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error('Ruleset code_scanning_tools 形状非法');
  }
  const seen = new Set<string>();
  const tools = raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.tool !== 'string' || entry.tool === ''
        || typeof entry.alerts_threshold !== 'string'
        || !CODE_SCANNING_ALERTS_THRESHOLDS.has(
          entry.alerts_threshold as QualityCodeScanningAlertsThreshold,
        )
        || typeof entry.security_alerts_threshold !== 'string'
        || !CODE_SCANNING_SECURITY_ALERTS_THRESHOLDS.has(
          entry.security_alerts_threshold as QualityCodeScanningSecurityAlertsThreshold,
        )) {
      throw new Error('Ruleset 代码扫描工具或阈值非法');
    }
    const identity = entry.tool.toLowerCase();
    if (seen.has(identity)) throw new Error(`Ruleset 含重复代码扫描工具 ${entry.tool}`);
    seen.add(identity);
    return {
      tool: entry.tool,
      alertsThreshold: entry.alerts_threshold as QualityCodeScanningAlertsThreshold,
      securityAlertsThreshold:
        entry.security_alerts_threshold as QualityCodeScanningSecurityAlertsThreshold,
    };
  });
  return tools.sort((a, b) => a.tool.localeCompare(b.tool));
}

export function buildManagedRulesetPayload(
  existing: GitHubRuleset | null,
  checks: RequiredStatusCheck[],
  codeScanning?: QualityCodeScanningTool[],
): GitHubRulesetPayload {
  const extraRules = (existing?.rules ?? []).filter((rule) => (
    !MANAGED_RULE_TYPES.has(rule.type)
    && !(codeScanning !== undefined && rule.type === 'code_scanning')
  ));
  const rules: GitHubRulesetRule[] = [
    ...extraRules,
    { type: 'deletion' },
    { type: 'non_fast_forward' },
    {
      type: 'pull_request',
      parameters: {
        required_approving_review_count: 0,
        dismiss_stale_reviews_on_push: false,
        required_reviewers: [],
        require_code_owner_review: false,
        require_last_push_approval: false,
        required_review_thread_resolution: true,
        allowed_merge_methods: ['merge', 'squash', 'rebase'],
      },
    },
  ];
  if (checks.length > 0) {
    rules.push({
      type: 'required_status_checks',
      parameters: {
        strict_required_status_checks_policy: true,
        do_not_enforce_on_create: false,
        required_status_checks: [...checks]
          .sort((a, b) => a.context.localeCompare(b.context)),
      },
    });
  }
  if (codeScanning && codeScanning.length > 0) {
    rules.push({
      type: 'code_scanning',
      parameters: {
        code_scanning_tools: [...codeScanning]
          .sort((a, b) => a.tool.localeCompare(b.tool))
          .map((tool) => ({
            tool: tool.tool,
            alerts_threshold: tool.alertsThreshold,
            security_alerts_threshold: tool.securityAlertsThreshold,
          })),
      },
    });
  }
  return {
    name: MANAGED_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: {
      ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] },
    },
    rules,
  };
}

function equalStrings(actual: unknown, expected: readonly string[]): boolean {
  return Array.isArray(actual)
    && actual.length === expected.length
    && actual.every((value, index) => value === expected[index]);
}

/** 回读真实远端后执行；空数组才表示当前 Ruleset 与期望一致。 */
export function validateManagedRuleset(
  ruleset: GitHubRuleset,
  expectedChecks: RequiredStatusCheck[],
  expectedCodeScanning?: QualityCodeScanningTool[],
): string[] {
  const errors: string[] = [];
  if (ruleset.name !== MANAGED_RULESET_NAME) errors.push(`名称仍为 ${ruleset.name}`);
  if (ruleset.target !== 'branch') errors.push(`target=${ruleset.target}`);
  if (ruleset.enforcement !== 'active') errors.push(`enforcement=${ruleset.enforcement}`);
  if (ruleset.bypass_actors.length > 0) errors.push('存在日常绕过者');
  if (!equalStrings(ruleset.conditions.ref_name.include, ['~DEFAULT_BRANCH'])
      || ruleset.conditions.ref_name.exclude.length > 0) {
    errors.push('默认分支匹配条件不正确');
  }
  for (const type of ['deletion', 'non_fast_forward']) {
    try {
      if (!uniqueByType(ruleset.rules, type)) errors.push(`缺少 ${type} 规则`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  let pull: GitHubRulesetRule | null = null;
  try { pull = uniqueByType(ruleset.rules, 'pull_request'); } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (!pull) {
    errors.push('缺少 pull_request 规则');
  } else {
    const parameters = pull.parameters ?? {};
    if (parameters.required_approving_review_count !== 0) errors.push('单人阶段批准人数不是 0');
    if (parameters.required_review_thread_resolution !== true) errors.push('未要求解决所有对话');
  }

  let actualChecks: RequiredStatusCheck[] = [];
  try { actualChecks = requiredChecksFromRuleset(ruleset); } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  const actualMap = new Map(actualChecks.map((check) => [check.context, check.integration_id]));
  const expectedMap = new Map(expectedChecks.map((check) => [check.context, check.integration_id]));
  for (const [context, integration] of expectedMap) {
    if (actualMap.get(context) !== integration) {
      errors.push(`必需检查 ${context} 未绑定预期 GitHub App ${integration}`);
    }
  }
  for (const context of actualMap.keys()) {
    if (!expectedMap.has(context)) errors.push(`存在契约外必需检查 ${context}`);
  }
  const statusRule = ruleset.rules.find((rule) => rule.type === 'required_status_checks');
  if (expectedChecks.length > 0) {
    if (!statusRule) errors.push('缺少 required_status_checks 规则');
    else {
      if (statusRule.parameters?.strict_required_status_checks_policy !== true) {
        errors.push('未要求分支包含最新默认分支');
      }
      if (statusRule.parameters?.do_not_enforce_on_create !== false) {
        errors.push('必需检查未对分支创建生效');
      }
    }
  } else if (statusRule) {
    errors.push('最小阶段不应提前存在必需检查规则');
  }

  if (expectedCodeScanning !== undefined) {
    const codeScanningRule = ruleset.rules.find((rule) => rule.type === 'code_scanning');
    let actualTools: QualityCodeScanningTool[] = [];
    try { actualTools = codeScanningToolsFromRuleset(ruleset); } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
    if (expectedCodeScanning.length > 0 && !codeScanningRule) {
      errors.push('缺少 code_scanning 规则');
    } else if (expectedCodeScanning.length === 0 && codeScanningRule) {
      errors.push('存在契约外 code_scanning 规则');
    } else if (codeScanningRule) {
      const actualMap = new Map(actualTools.map((tool) => [tool.tool, tool]));
      const expectedMap = new Map(expectedCodeScanning.map((tool) => [tool.tool, tool]));
      for (const [toolName, expected] of expectedMap) {
        const actual = actualMap.get(toolName);
        if (!actual) {
          errors.push(`缺少代码扫描工具 ${toolName}`);
          continue;
        }
        if (actual.alertsThreshold !== expected.alertsThreshold) {
          errors.push(
            `代码扫描工具 ${toolName} 普通告警阈值为 ${actual.alertsThreshold}，` +
            `契约要求 ${expected.alertsThreshold}`,
          );
        }
        if (actual.securityAlertsThreshold !== expected.securityAlertsThreshold) {
          errors.push(
            `代码扫描工具 ${toolName} 安全告警阈值为 ${actual.securityAlertsThreshold}，` +
            `契约要求 ${expected.securityAlertsThreshold}`,
          );
        }
      }
      for (const toolName of actualMap.keys()) {
        if (!expectedMap.has(toolName)) errors.push(`存在契约外代码扫描工具 ${toolName}`);
      }
    }
  }
  return [...new Set(errors)];
}
