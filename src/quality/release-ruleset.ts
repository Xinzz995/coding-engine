import {
  MANAGED_RELEASE_RULESET_NAME,
  type GitHubRuleset,
  type GitHubRulesetPayload,
  type GitHubRulesetRule,
} from './github.js';

const MANAGED_RULE_TYPES = new Set(['creation', 'deletion', 'update']);
const REQUIRED_RULE_TYPES = ['deletion', 'update'];

function uniqueByType(rules: GitHubRulesetRule[], type: string): GitHubRulesetRule | null {
  const found = rules.filter((rule) => rule.type === type);
  if (found.length > 1) throw new Error(`Release Ruleset 含重复规则 ${type}`);
  return found[0] ?? null;
}

function normalizedPatterns(patterns: string[]): string[] {
  return [...patterns].map((pattern) => `refs/tags/${pattern}`).sort();
}

export function findManagedReleaseRuleset(rulesets: GitHubRuleset[]): GitHubRuleset | null {
  const found = rulesets.filter((ruleset) => ruleset.name === MANAGED_RELEASE_RULESET_NAME);
  if (found.length > 1) throw new Error('发现多个 coding-x 发布标签 Ruleset，必须先人工消除歧义');
  return found[0] ?? null;
}

export function buildManagedReleaseRulesetPayload(
  existing: GitHubRuleset | null,
  protectedRefs: string[],
): GitHubRulesetPayload {
  const extraRules = (existing?.rules ?? []).filter((rule) => !MANAGED_RULE_TYPES.has(rule.type));
  return {
    name: MANAGED_RELEASE_RULESET_NAME,
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [],
    conditions: {
      ref_name: { include: normalizedPatterns(protectedRefs), exclude: [] },
    },
    rules: [
      ...extraRules,
      { type: 'deletion' },
      { type: 'update', parameters: { update_allows_fetch_and_merge: false } },
    ],
  };
}

export function validateManagedReleaseRuleset(
  ruleset: GitHubRuleset,
  protectedRefs: string[],
): string[] {
  const errors: string[] = [];
  if (ruleset.name !== MANAGED_RELEASE_RULESET_NAME) errors.push(`名称仍为 ${ruleset.name}`);
  if (ruleset.target !== 'tag') errors.push(`target=${ruleset.target}`);
  if (ruleset.enforcement !== 'active') errors.push(`enforcement=${ruleset.enforcement}`);
  if (ruleset.bypass_actors.length > 0) errors.push('发布标签规则存在日常绕过者');
  const actual = [...ruleset.conditions.ref_name.include].sort();
  const expected = normalizedPatterns(protectedRefs);
  if (
    actual.length !== expected.length ||
    actual.some((value, index) => value !== expected[index])
  ) {
    errors.push(`发布标签范围为 ${actual.join('、') || '<空>'}，契约要求 ${expected.join('、')}`);
  }
  if (ruleset.conditions.ref_name.exclude.length > 0) errors.push('发布标签规则存在排除范围');
  try {
    if (uniqueByType(ruleset.rules, 'creation')) {
      errors.push('发布标签规则禁止首次创建，且当前没有绕过者可完成发布');
    }
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  for (const type of REQUIRED_RULE_TYPES) {
    try {
      if (!uniqueByType(ruleset.rules, type)) errors.push(`缺少 ${type} 规则`);
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
  }
  return [...new Set(errors)];
}
