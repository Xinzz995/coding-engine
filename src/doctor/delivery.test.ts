import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import {
  GITHUB_ACTIONS_APP_ID,
  type GitHubIssueInfo,
  type GitHubPullRequestInfo,
  type GitHubQualityClient,
  type GitHubRepositoryInfo,
  type GitHubRuleset,
  type GitHubRulesetPayload,
  type GitHubSecurityFeatures,
} from '../quality/github.js';
import { renderManagedGitHubFiles } from '../quality/github-workflows.js';
import { buildManagedRulesetPayload } from '../quality/ruleset.js';
import { checkDeliveryGate } from './delivery.js';

function contract(): QualityContract {
  const read = readQualityContract(process.cwd());
  if (read.status !== 'ready') throw new Error(`fixture contract unavailable: ${read.status}`);
  return read.contract;
}

function rootWithManagedFiles(value: QualityContract): string {
  const root = mkdtempSync(join(tmpdir(), 'delivery-doctor-'));
  for (const [relativePath, content] of Object.entries(renderManagedGitHubFiles(value))) {
    mkdirSync(join(root, relativePath, '..'), { recursive: true });
    writeFileSync(join(root, relativePath), content);
  }
  return root;
}

class FakeClient implements GitHubQualityClient {
  repository: GitHubRepositoryInfo;
  ruleset: GitHubRuleset;
  issues: GitHubIssueInfo[] = [];
  securityFeatures: GitHubSecurityFeatures;

  constructor(value: QualityContract, integrationId = GITHUB_ACTIONS_APP_ID) {
    this.repository = {
      fullName: value.repository.fullName,
      defaultBranch: value.repository.defaultBranch,
      isPrivate: true,
    };
    this.ruleset = {
      id: 7,
      ...buildManagedRulesetPayload(null, value.github.requiredChecks.map((context) => ({
        context, integration_id: integrationId,
      }))),
    };
    this.securityFeatures = structuredClone(value.github.securityFeatures ?? {
      dependabotSecurityUpdates: false,
      secretScanning: false,
      secretScanningPushProtection: false,
    });
  }

  discoverRepository(): GitHubRepositoryInfo { return this.repository; }
  verifyDefaultBranch(): void {}
  listRulesets(): GitHubRuleset[] { return [this.ruleset]; }
  getRuleset(): GitHubRuleset { return this.ruleset; }
  createRuleset(_repository: string, payload: GitHubRulesetPayload): GitHubRuleset {
    return { id: 7, ...payload };
  }
  updateRuleset(_repository: string, _id: number, payload: GitHubRulesetPayload): GitHubRuleset {
    return { id: 7, ...payload };
  }
  findOpenPullRequest(): GitHubPullRequestInfo | null { return null; }
  listCheckRuns() { return []; }
  getSecurityFeatures(): GitHubSecurityFeatures { return this.securityFeatures; }
  getIssue(_repository: string, number: number): GitHubIssueInfo {
    const issue = this.issues.find((candidate) => candidate.number === number);
    if (!issue) throw new Error(`missing issue ${number}`);
    return issue;
  }
  listOpenIssuesByLabel(_repository: string, label: string): GitHubIssueInfo[] {
    return this.issues.filter((issue) => issue.state === 'open' && issue.labels.includes(label));
  }
  ensureLabel(): void {}
}

function issue(over: Partial<GitHubIssueInfo> = {}): GitHubIssueInfo {
  return {
    number: 10,
    state: 'open',
    title: 'temporary exception',
    body: [
      '### 负责人', '@owner', '### 原因', '等待依赖修复',
      '### 到期日', '2026-08-01', '### 跟进事项', '更新依赖并关闭例外',
    ].join('\n'),
    labels: ['quality-p1-deferral'],
    url: 'https://example.test/issues/10',
    isPullRequest: false,
    ...over,
  };
}

describe('checkDeliveryGate', () => {
  it('compares every managed local file to the deterministic contract output', () => {
    const value = contract();
    const root = rootWithManagedFiles(value);
    try {
      const ready = checkDeliveryGate({ root, workspace: '.workspace', contract: value, local: true });
      expect(ready).toMatchObject({ status: 'local-ready', remoteChecked: false, issues: [] });

      const path = join(root, '.github/workflows/quality-gate.yml');
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
      const windowsCheckout = checkDeliveryGate({ root, workspace: '.workspace', contract: value, local: true });
      expect(windowsCheckout).toMatchObject({ status: 'local-ready', issues: [] });

      writeFileSync(path, `${readFileSync(path, 'utf8')}# drift\n`);
      const drift = checkDeliveryGate({ root, workspace: '.workspace', contract: value, local: true });
      expect(drift.status).toBe('invalid');
      expect(drift.issues).toContainEqual(expect.objectContaining({
        file: '.github/workflows/quality-gate.yml',
      }));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads back the real Ruleset source binding and open exceptions', () => {
    const value = contract();
    const root = rootWithManagedFiles(value);
    const client = new FakeClient(value);
    try {
      const ready = checkDeliveryGate({
        root, workspace: '.workspace', contract: value, local: false, client,
        now: new Date('2026-07-26T00:00:00Z'),
      });
      expect(ready).toMatchObject({ status: 'ready', remoteChecked: true, rulesetId: 7, issues: [] });

      client.ruleset = new FakeClient(value, 999).ruleset;
      client.securityFeatures.secretScanningPushProtection = false;
      client.issues = [issue({ body: issue().body.replace('2026-08-01', '2026-07-20') })];
      const invalid = checkDeliveryGate({
        root, workspace: '.workspace', contract: value, local: false, client,
        now: new Date('2026-07-26T00:00:00Z'),
      });
      expect(invalid.status).toBe('invalid');
      expect(invalid.issues.map((entry) => entry.message)).toEqual(expect.arrayContaining([
        expect.stringContaining('未绑定预期 GitHub App'),
        expect.stringContaining('秘密推送保护实际为关闭'),
        '延期 Issue 已过期',
      ]));
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
