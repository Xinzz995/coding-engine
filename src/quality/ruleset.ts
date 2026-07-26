import {
  LEGACY_BOOTSTRAP_RULESET_NAME,
  MANAGED_RULESET_NAME,
  type GitHubRuleset,
  type GitHubRulesetPayload,
  type GitHubRulesetRule,
  type RequiredStatusCheck,
} from './github.js';

const MANAGED_RULE_TYPES = new Set([
  'deletion', 'non_fast_forward', 'pull_request', 'required_status_checks',
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

export function buildManagedRulesetPayload(
  existing: GitHubRuleset | null,
  checks: RequiredStatusCheck[],
): GitHubRulesetPayload {
  const extraRules = (existing?.rules ?? []).filter((rule) => !MANAGED_RULE_TYPES.has(rule.type));
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
  return [...new Set(errors)];
}

