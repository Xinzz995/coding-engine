import { describe, expect, it } from 'vitest';
import { verifyReleaseDelivery } from './verify-release-delivery.mjs';

const releaseSha = 'a'.repeat(40);
const headSha = 'b'.repeat(40);
const exceptionSha = 'c'.repeat(40);

function contract() {
  return {
    github: {
      defaultBranch: 'main',
      requiredChecks: ['coding-x / project-checks', 'coding-x / spec-review'],
      releaseRefs: ['refs/tags/v*'],
    },
  };
}

function branchRuleset() {
  return {
    name: 'coding-x quality gate',
    target: 'branch',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['refs/heads/main'], exclude: [] } },
    rules: [
      { type: 'deletion' },
      { type: 'non_fast_forward' },
      { type: 'pull_request', parameters: {} },
      {
        type: 'required_status_checks',
        parameters: {
          strict_required_status_checks_policy: true,
          do_not_enforce_on_create: false,
          required_status_checks: [
            { context: 'coding-x / project-checks', integration_id: 15368 },
            { context: 'coding-x / spec-review', integration_id: 15368 },
          ],
        },
      },
    ],
  };
}

function releaseRuleset() {
  return {
    name: 'coding-x release refs',
    target: 'tag',
    enforcement: 'active',
    bypass_actors: [],
    conditions: { ref_name: { include: ['refs/tags/v*'], exclude: [] } },
    rules: [{ type: 'deletion' }, { type: 'non_fast_forward' }],
  };
}

function pulls() {
  return [{
    number: 15,
    merged_at: '2026-07-24T00:00:00Z',
    merge_commit_sha: releaseSha,
    base: { ref: 'main' },
    head: { sha: headSha },
  }];
}

function checkRuns(appId = 15368) {
  return {
    check_runs: contract().github.requiredChecks.map((name, index) => ({
      id: index + 1,
      name,
      app: { id: appId },
      status: 'completed',
      conclusion: 'success',
      completed_at: `2026-07-24T00:00:0${index}Z`,
    })),
  };
}

function exceptions(overrides = {}) {
  return {
    version: 1,
    exceptions: [],
    deliveries: [{
      id: 'delivery-bootstrap',
      commitSha: exceptionSha,
      owner: 'owner',
      reason: 'bounded bootstrap',
      expiresAt: '2026-07-25T00:00:00Z',
      followUpUrl: 'https://github.com/owner/repo/issues/1',
      auditUrl: 'https://github.com/owner/repo/actions/runs/1',
      ...overrides,
    }],
  };
}

function verify(overrides = {}) {
  return verifyReleaseDelivery({
    contract: contract(),
    exceptions: exceptions(),
    pulls: pulls(),
    checkRuns: checkRuns(),
    branchRuleset: branchRuleset(),
    releaseRuleset: releaseRuleset(),
    releaseSha,
    now: new Date('2026-07-24T12:00:00Z'),
    isAncestor: () => true,
    ...overrides,
  });
}

describe('release delivery verification', () => {
  it('accepts only latest successful checks from the ruleset-bound GitHub App', () => {
    expect(verify()).toEqual({
      status: 'passed',
      pullNumber: 15,
      deliveryHead: headSha,
      missingChecks: [],
      exceptionIds: [],
    });
  });

  it('rejects a spoofed same-name check from another app', () => {
    expect(() => verify({
      checkRuns: checkRuns(999),
      exceptions: { version: 1, exceptions: [], deliveries: [] },
    })).toThrow(/没有有效异常记录/);
  });

  it('allows a missing check only through an active ancestor delivery exception', () => {
    const failed = checkRuns();
    failed.check_runs[1].conclusion = 'failure';
    expect(verify({ checkRuns: failed })).toEqual({
      status: 'exceptional',
      pullNumber: 15,
      deliveryHead: headSha,
      missingChecks: ['coding-x / spec-review'],
      exceptionIds: ['delivery-bootstrap'],
    });
  });

  it.each([
    ['expired', exceptions({ expiresAt: '2026-07-24T11:59:59Z' }), () => true],
    ['resolved', exceptions({ resolvedAt: '2026-07-24T11:00:00Z' }), () => true],
    ['not ancestor', exceptions(), () => false],
  ])('rejects an %s delivery exception', (_name, exceptionFile, isAncestor) => {
    expect(() => verify({
      checkRuns: { check_runs: [] },
      exceptions: exceptionFile,
      isAncestor,
    })).toThrow(/没有有效异常记录/);
  });

  it('fails if either remote ruleset is disabled', () => {
    expect(() => verify({
      branchRuleset: { ...branchRuleset(), enforcement: 'disabled' },
    })).toThrow(/分支 ruleset/);
    expect(() => verify({
      releaseRuleset: { ...releaseRuleset(), enforcement: 'disabled' },
    })).toThrow(/tag ruleset/);
  });

  it('requires an exact associated merge result on the default branch', () => {
    expect(() => verify({ pulls: [] })).toThrow(/恰好一个合并结果/);
  });
});
