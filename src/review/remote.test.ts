import { describe, expect, it } from 'vitest';
import { readQualityContract } from '../quality/contract.js';
import {
  GITHUB_ACTIONS_APP_ID,
  type GitHubQualityClient,
  type GitHubRuleset,
} from '../quality/github.js';
import { buildManagedRulesetPayload } from '../quality/ruleset.js';
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
    }))),
  };
  const client = {
    listRulesets: () => [ruleset],
    listCheckRuns: () => contract.github.requiredChecks.map((name, index) => ({
      id: index + 1, name, headSha, status: 'completed', conclusion: 'success',
      app: { id: integrationId, slug: 'github-actions', name: 'GitHub Actions' },
    })),
  } as unknown as GitHubQualityClient;
  return {
    contract,
    client,
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
});
