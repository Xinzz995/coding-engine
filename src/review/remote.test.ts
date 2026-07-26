import { describe, expect, it } from 'vitest';
import { readQualityContract } from '../quality/contract.js';
import {
  GITHUB_ACTIONS_APP_ID,
  type GitHubQualityClient,
  type GitHubRuleset,
} from '../quality/github.js';
import { buildManagedRulesetPayload } from '../quality/ruleset.js';
import { buildManagedReleaseRulesetPayload } from '../quality/release-ruleset.js';
import { evaluateReviewRemoteState } from './remote.js';
import type { ReviewPreflightContext } from './preflight.js';

function fixture(integrationId: number) {
  const read = readQualityContract(process.cwd());
  if (read.status !== 'ready') throw new Error(`contract unavailable: ${read.status}`);
  const contract = read.contract;
  const headSha = 'b'.repeat(40);
  const ruleset: GitHubRuleset = {
    id: 1,
    ...buildManagedRulesetPayload(null, contract.github.requiredChecks.map((context) => ({
      context, integration_id: integrationId,
    })), contract.github.requiredCodeScanning),
  };
  const releaseRuleset: GitHubRuleset = {
    id: 2,
    ...buildManagedReleaseRulesetPayload(null, contract.release.protectedRefs),
  };
  const client = {
    listRulesets: () => [ruleset, releaseRuleset],
    getImmutableReleases: () => ({ enabled: true, enforcedByOwner: false }),
    listCheckRuns: () => contract.github.requiredChecks.map((name, index) => ({
      id: index + 1, name, headSha, status: 'completed', conclusion: 'success',
      app: { id: integrationId, slug: 'github-actions', name: 'GitHub Actions' },
    })),
  } as unknown as GitHubQualityClient;
  return {
    contract,
    client,
    ruleset,
    releaseRuleset,
    context: { headSha } as ReviewPreflightContext,
  };
}

describe('evaluateReviewRemoteState', () => {
  it('accepts successful required checks only from the GitHub Actions App binding', () => {
    const ready = fixture(GITHUB_ACTIONS_APP_ID);
    expect(evaluateReviewRemoteState(ready).status).toBe('ready');

    const spoofed = fixture(999);
    const result = evaluateReviewRemoteState(spoofed);
    expect(result.status).toBe('invalid');
    expect(result.rulesetErrors).toEqual(expect.arrayContaining([
      expect.stringContaining('未绑定预期 GitHub App'),
    ]));
  });

  it('fails closed when the required code scanning rule drifts', () => {
    const value = fixture(GITHUB_ACTIONS_APP_ID);
    value.ruleset.rules = value.ruleset.rules.filter((rule) => rule.type !== 'code_scanning');
    value.client.listRulesets = () => [value.ruleset, value.releaseRuleset];

    const result = evaluateReviewRemoteState(value);
    expect(result.status).toBe('invalid');
    expect(result.rulesetErrors).toContain('缺少 code_scanning 规则');
  });

  it('fails closed when release tag protection or immutability drifts', () => {
    const value = fixture(GITHUB_ACTIONS_APP_ID);
    value.releaseRuleset.rules = value.releaseRuleset.rules
      .filter((rule) => rule.type !== 'deletion');
    value.client.getImmutableReleases = () => ({ enabled: false, enforcedByOwner: false });

    const result = evaluateReviewRemoteState(value);
    expect(result.status).toBe('invalid');
    expect(result.rulesetErrors).toEqual(expect.arrayContaining([
      '缺少 deletion 规则',
      '不可变 Release 实际为关闭',
    ]));
  });
});
