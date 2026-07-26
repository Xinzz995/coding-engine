import { describe, expect, it } from 'vitest';
import { MANAGED_RELEASE_RULESET_NAME, type GitHubRuleset } from './github.js';
import {
  buildManagedReleaseRulesetPayload,
  findManagedReleaseRuleset,
  validateManagedReleaseRuleset,
} from './release-ruleset.js';

describe('release tag Ruleset', () => {
  it('builds an active no-bypass tag rule and preserves unrelated stricter rules', () => {
    const existing: GitHubRuleset = {
      id: 9,
      name: MANAGED_RELEASE_RULESET_NAME,
      target: 'tag',
      enforcement: 'active',
      bypass_actors: [],
      conditions: { ref_name: { include: ['refs/tags/old*'], exclude: [] } },
      rules: [{ type: 'required_signatures' }, { type: 'creation' }, { type: 'deletion' }],
    };
    const payload = buildManagedReleaseRulesetPayload(existing, ['v*', 'releases/v*']);
    expect(payload).toMatchObject({
      name: MANAGED_RELEASE_RULESET_NAME,
      target: 'tag',
      enforcement: 'active',
      bypass_actors: [],
      conditions: {
        ref_name: { include: ['refs/tags/releases/v*', 'refs/tags/v*'], exclude: [] },
      },
    });
    expect(payload.rules.map((rule) => rule.type)).toEqual([
      'required_signatures',
      'deletion',
      'update',
    ]);
    expect(payload.rules.at(-1)?.parameters).toEqual({ update_allows_fetch_and_merge: false });
    expect(validateManagedReleaseRuleset({ id: 9, ...payload }, ['releases/v*', 'v*'])).toEqual([]);
  });

  it('reports drift and ambiguous managed rulesets', () => {
    const value: GitHubRuleset = {
      id: 9,
      ...buildManagedReleaseRulesetPayload(null, ['v*']),
    };
    value.enforcement = 'disabled';
    value.bypass_actors = [{}];
    value.conditions.ref_name.include = ['refs/tags/beta*'];
    value.rules.push({ type: 'creation' });
    value.rules = value.rules.filter((rule) => rule.type !== 'deletion');
    value.rules = value.rules.filter((rule) => rule.type !== 'update');
    expect(validateManagedReleaseRuleset(value, ['v*'])).toEqual(
      expect.arrayContaining([
        'enforcement=disabled',
        '发布标签规则存在日常绕过者',
        '发布标签规则禁止首次创建，且当前没有绕过者可完成发布',
        expect.stringContaining('发布标签范围为 refs/tags/beta*'),
        '缺少 deletion 规则',
        '缺少 update 规则',
      ]),
    );
    expect(() => findManagedReleaseRuleset([value, { ...value, id: 10 }])).toThrow(
      '多个 coding-x 发布标签 Ruleset',
    );
  });
});
