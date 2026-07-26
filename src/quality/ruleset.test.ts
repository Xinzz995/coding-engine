import { describe, expect, it } from 'vitest';
import {
  LEGACY_BOOTSTRAP_RULESET_NAME,
  MANAGED_RULESET_NAME,
  type GitHubRuleset,
  type RequiredStatusCheck,
} from './github.js';
import {
  buildManagedRulesetPayload,
  findManagedRuleset,
  requiredChecksFromRuleset,
  validateManagedRuleset,
} from './ruleset.js';

function ruleset(over: Partial<GitHubRuleset> = {}): GitHubRuleset {
  return {
    id: 1,
    name: MANAGED_RULESET_NAME,
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      {
        type: 'pull_request',
        parameters: {
          required_approving_review_count: 0,
          required_review_thread_resolution: true,
        },
      },
    ],
    ...over,
  };
}

const checks: RequiredStatusCheck[] = [
  { context: 'quality-gate', integration_id: 15368 },
  { context: 'policy-guard', integration_id: 15368 },
];

describe('managed GitHub ruleset', () => {
  it('finds either bootstrap or final name but refuses an ambiguous pair', () => {
    const legacy = ruleset({ id: 2, name: LEGACY_BOOTSTRAP_RULESET_NAME });
    expect(findManagedRuleset([legacy])).toBe(legacy);
    expect(findManagedRuleset([])).toBeNull();
    expect(() => findManagedRuleset([legacy, ruleset()])).toThrow('多个');
  });

  it('builds the minimum lock with no bypass and preserves unrelated stricter rules', () => {
    const payload = buildManagedRulesetPayload(ruleset({
      rules: [...ruleset().rules, { type: 'required_linear_history' }],
    }), []);
    expect(payload).toMatchObject({
      name: MANAGED_RULESET_NAME,
      target: 'branch',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['~DEFAULT_BRANCH'], exclude: [] } },
    });
    expect(payload.rules.map((rule) => rule.type)).toEqual([
      'required_linear_history', 'deletion', 'non_fast_forward', 'pull_request',
    ]);
    expect(validateManagedRuleset({ id: 1, ...payload }, [])).toEqual([]);
  });

  it('adds strict app-bound required checks and reads them back', () => {
    const payload = buildManagedRulesetPayload(ruleset(), checks);
    const remote = { id: 1, ...payload };
    expect(requiredChecksFromRuleset(remote)).toEqual([
      { context: 'policy-guard', integration_id: 15368 },
      { context: 'quality-gate', integration_id: 15368 },
    ]);
    expect(validateManagedRuleset(remote, checks)).toEqual([]);
  });

  it('reports disabled enforcement, bypass, missing rules, stale-branch policy, and app drift', () => {
    const payload = buildManagedRulesetPayload(ruleset(), checks);
    const remote = {
      id: 1,
      ...payload,
      enforcement: 'disabled',
      bypass_actors: [{ actor_id: 1 }],
      rules: payload.rules
        .filter((rule) => rule.type !== 'non_fast_forward')
        .map((rule) => rule.type === 'required_status_checks'
          ? {
              ...rule,
              parameters: {
                ...rule.parameters,
                strict_required_status_checks_policy: false,
                required_status_checks: [
                  { context: 'quality-gate', integration_id: 999 },
                  { context: 'unexpected', integration_id: 15368 },
                ],
              },
            }
          : rule),
    } as GitHubRuleset;
    const errors = validateManagedRuleset(remote, checks).join('\n');
    expect(errors).toContain('enforcement=disabled');
    expect(errors).toContain('日常绕过者');
    expect(errors).toContain('缺少 non_fast_forward');
    expect(errors).toContain('未要求分支包含最新默认分支');
    expect(errors).toContain('quality-gate 未绑定预期 GitHub App 15368');
    expect(errors).toContain('policy-guard 未绑定预期 GitHub App 15368');
    expect(errors).toContain('契约外必需检查 unexpected');
  });
});

