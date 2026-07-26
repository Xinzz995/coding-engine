import type { QualityContract } from '../quality/contract.js';
import { GITHUB_ACTIONS_APP_ID, type GitHubQualityClient } from '../quality/github.js';
import { findManagedRuleset, requiredChecksFromRuleset, validateManagedRuleset } from '../quality/ruleset.js';
import type { ReviewPreflightContext } from './preflight.js';
import type { ReviewRemoteState } from './types.js';

export function evaluateReviewRemoteState(options: {
  context: ReviewPreflightContext;
  contract: QualityContract;
  client: GitHubQualityClient;
  now?: Date;
}): ReviewRemoteState {
  const checkedAt = (options.now ?? new Date()).toISOString();
  try {
    const ruleset = findManagedRuleset(options.client.listRulesets(
      options.contract.repository.fullName,
    ));
    if (!ruleset) {
      return {
        status: 'invalid', checks: [], rulesetErrors: ['没有 coding-x 管理的 Ruleset'], checkedAt,
      };
    }
    requiredChecksFromRuleset(ruleset); // 先严格校验远端形状，再与固定来源比较。
    const expected = options.contract.github.requiredChecks.map((name) => ({
      context: name,
      integration_id: GITHUB_ACTIONS_APP_ID,
    }));
    const rulesetErrors = validateManagedRuleset(ruleset, expected);
    const runs = options.client.listCheckRuns(
      options.contract.repository.fullName,
      options.context.headSha,
    );
    const checks = expected.map((required) => {
      const matching = runs.filter((run) => (
        run.name === required.context && run.app.id === required.integration_id
      )).sort((a, b) => (b.id ?? 0) - (a.id ?? 0));
      const run = matching[0];
      return run ? {
        name: required.context,
        status: run.status,
        conclusion: run.conclusion,
        appId: run.app.id,
        appSlug: run.app.slug,
      } : {
        name: required.context,
        status: 'missing',
        conclusion: null,
        appId: required.integration_id,
        appSlug: 'unknown',
      };
    });
    if (rulesetErrors.length > 0) return { status: 'invalid', checks, rulesetErrors, checkedAt };
    if (checks.some((check) => check.status === 'completed' && check.conclusion !== 'success')) {
      return { status: 'failed', checks, rulesetErrors, checkedAt };
    }
    if (checks.some((check) => check.status !== 'completed' || check.conclusion !== 'success')) {
      return { status: 'pending', checks, rulesetErrors, checkedAt };
    }
    return { status: 'ready', checks, rulesetErrors, checkedAt };
  } catch (error) {
    return {
      status: 'invalid',
      checks: [],
      rulesetErrors: [],
      detail: error instanceof Error ? error.message : String(error),
      checkedAt,
    };
  }
}
