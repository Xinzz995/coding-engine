import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import {
  GITHUB_ACTIONS_APP_ID,
  GitHubQualityError,
  type GitHubIssueInfo,
  type GitHubPullRequestInfo,
  type GitHubQualityClient,
  type GitHubRepositoryInfo,
  type GitHubRuleset,
  type GitHubRulesetPayload,
  type GitHubSecurityFeatures,
  type GitHubImmutableReleases,
} from '../quality/github.js';
import { renderManagedGitHubFiles } from '../quality/github-workflows.js';
import { buildManagedRulesetPayload } from '../quality/ruleset.js';
import { buildManagedReleaseRulesetPayload } from '../quality/release-ruleset.js';
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
  rulesets: GitHubRuleset[];
  issues: GitHubIssueInfo[] = [];
  securityFeatures: GitHubSecurityFeatures;
  immutableReleases: GitHubImmutableReleases = { enabled: true, enforcedByOwner: false };

  constructor(value: QualityContract, integrationId = GITHUB_ACTIONS_APP_ID) {
    this.repository = {
      fullName: value.repository.fullName,
      defaultBranch: value.repository.defaultBranch,
      isPrivate: true,
    };
    const ruleset: GitHubRuleset = {
      id: 7,
      ...buildManagedRulesetPayload(
        null,
        value.github.requiredChecks.map((context) => ({
          context,
          integration_id: integrationId,
        })),
        value.github.requiredCodeScanning,
      ),
    };
    this.rulesets = [
      ruleset,
      { id: 8, ...buildManagedReleaseRulesetPayload(null, value.release.protectedRefs) },
    ];
    this.securityFeatures = structuredClone(
      value.github.securityFeatures ?? {
        dependabotSecurityUpdates: false,
        secretScanning: false,
        secretScanningPushProtection: false,
      },
    );
  }

  discoverRepository(): GitHubRepositoryInfo {
    return this.repository;
  }
  verifyDefaultBranch(): void {}
  listRulesets(): GitHubRuleset[] {
    return this.rulesets;
  }
  getRuleset(_repository: string, id: number): GitHubRuleset {
    const ruleset = this.rulesets.find((candidate) => candidate.id === id);
    if (!ruleset) throw new Error(`missing ruleset ${id}`);
    return ruleset;
  }
  createRuleset(_repository: string, payload: GitHubRulesetPayload): GitHubRuleset {
    return { id: 7, ...payload };
  }
  updateRuleset(_repository: string, _id: number, payload: GitHubRulesetPayload): GitHubRuleset {
    return { id: 7, ...payload };
  }
  findOpenPullRequest(): GitHubPullRequestInfo | null {
    return null;
  }
  listCheckRuns() {
    return [];
  }
  getSecurityFeatures(): GitHubSecurityFeatures {
    return this.securityFeatures;
  }
  getImmutableReleases(): GitHubImmutableReleases {
    return this.immutableReleases;
  }
  enableImmutableReleases(): void {
    this.immutableReleases.enabled = true;
  }
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
      '### 负责人',
      '@owner',
      '### 原因',
      '等待依赖修复',
      '### 到期日',
      '2026-08-01',
      '### 跟进事项',
      '更新依赖并关闭例外',
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
      const ready = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: true,
      });
      expect(ready).toMatchObject({ status: 'local-ready', remoteChecked: false, issues: [] });

      const path = join(root, '.github/workflows/quality-gate.yml');
      writeFileSync(path, readFileSync(path, 'utf8').replaceAll('\n', '\r\n'));
      const windowsCheckout = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: true,
      });
      expect(windowsCheckout).toMatchObject({ status: 'local-ready', issues: [] });

      writeFileSync(path, `${readFileSync(path, 'utf8')}# drift\n`);
      const drift = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: true,
      });
      expect(drift.status).toBe('invalid');
      expect(drift.issues).toContainEqual(
        expect.objectContaining({
          file: '.github/workflows/quality-gate.yml',
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a managed FIFO without waiting for a writer',
    () => {
      const value = contract();
      const root = rootWithManagedFiles(value);
      try {
        const path = join(root, '.github/workflows/quality-gate.yml');
        rmSync(path);
        execFileSync('mkfifo', [path]);
        const started = Date.now();
        const result = checkDeliveryGate({
          root,
          workspace: '.workspace',
          contract: value,
          local: true,
        });
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(result.status).toBe('invalid');
        expect(result.issues).toContainEqual(
          expect.objectContaining({ file: '.github/workflows/quality-gate.yml' }),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not read managed files through a parent directory outside the project',
    () => {
      const value = contract();
      const root = rootWithManagedFiles(value);
      const outside = mkdtempSync(join(tmpdir(), 'delivery-doctor-outside-'));
      try {
        const workflows = join(root, '.github', 'workflows');
        rmSync(workflows, { recursive: true, force: true });
        mkdirSync(outside, { recursive: true });
        const rendered = renderManagedGitHubFiles(value);
        writeFileSync(
          join(outside, 'quality-gate.yml'),
          rendered['.github/workflows/quality-gate.yml'],
        );
        writeFileSync(
          join(outside, 'policy-guard.yml'),
          rendered['.github/workflows/policy-guard.yml'],
        );
        symlinkSync(outside, workflows, 'dir');

        const result = checkDeliveryGate({
          root,
          workspace: '.workspace',
          contract: value,
          local: true,
        });
        expect(result.status).toBe('invalid');
        expect(result.issues).toContainEqual(
          expect.objectContaining({
            file: '.github/workflows/quality-gate.yml',
            message: expect.stringContaining('安全读取'),
          }),
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it('rejects an oversized managed file instead of loading it without a bound', () => {
    const value = contract();
    const root = rootWithManagedFiles(value);
    try {
      writeFileSync(
        join(root, '.github/workflows/quality-gate.yml'),
        'x'.repeat(4 * 1024 * 1024 + 1),
      );
      const result = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: true,
      });
      expect(result.status).toBe('invalid');
      expect(result.issues).toContainEqual(
        expect.objectContaining({
          file: '.github/workflows/quality-gate.yml',
          message: expect.stringContaining('安全读取'),
        }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('blocks an unsupported Final Review with a rerun message instead of corruption', () => {
    const value = contract();
    const root = rootWithManagedFiles(value);
    try {
      const workspace = join(root, '.workspace');
      mkdirSync(workspace, { recursive: true });
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify({ schemaVersion: 1 }));
      const result = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: true,
      });
      expect(result.status).toBe('invalid');
      expect(result.issues).toContainEqual({
        file: '.workspace/final-review.json',
        message: expect.stringContaining('v1 已失效'),
      });
      expect(result.issues.map((issue) => issue.message).join('\n')).not.toContain('损坏');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('checks Review state in an absolute workspace instead of joining it under the project', () => {
    const value = contract();
    const root = rootWithManagedFiles(value);
    const workspace = mkdtempSync(join(tmpdir(), 'delivery-absolute-workspace-'));
    try {
      writeFileSync(join(workspace, 'final-review.json'), JSON.stringify({ schemaVersion: 1 }));
      const result = checkDeliveryGate({
        root,
        workspace,
        contract: value,
        local: true,
      });

      expect(result.status).toBe('invalid');
      expect(result.issues).toContainEqual({
        file: join(workspace, 'final-review.json'),
        message: expect.stringContaining('v1 已失效'),
      });
    } finally {
      rmSync(workspace, { recursive: true, force: true });
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reads back the real Ruleset source binding and open exceptions', () => {
    const value = contract();
    const root = rootWithManagedFiles(value);
    const client = new FakeClient(value);
    try {
      const ready = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: false,
        client,
        now: new Date('2026-07-26T00:00:00Z'),
      });
      expect(ready).toMatchObject({
        status: 'ready',
        remoteChecked: true,
        rulesetId: 7,
        issues: [],
      });

      client.rulesets = new FakeClient(value, 999).rulesets;
      client.securityFeatures.secretScanningPushProtection = false;
      client.immutableReleases.enabled = false;
      const codeScanningRule = client.rulesets[0].rules.find(
        (rule) => rule.type === 'code_scanning',
      );
      const codeScanningTools = codeScanningRule?.parameters?.code_scanning_tools as
        Array<Record<string, unknown>> | undefined;
      if (codeScanningTools) codeScanningTools[0].alerts_threshold = 'all';
      client.issues = [issue({ body: issue().body.replace('2026-08-01', '2026-07-20') })];
      const invalid = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: false,
        client,
        now: new Date('2026-07-26T00:00:00Z'),
      });
      expect(invalid.status).toBe('invalid');
      expect(invalid).toMatchObject({ remoteChecked: true, remoteFailure: null });
      expect(invalid.issues.map((entry) => entry.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('未绑定预期 GitHub App'),
          expect.stringContaining('普通告警阈值为 all'),
          expect.stringContaining('秘密推送保护实际为关闭'),
          '不可变 Release 实际为关闭',
          '延期 Issue 已过期',
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('distinguishes an unavailable remote probe from completed drift detection', () => {
    const value = contract();
    const root = rootWithManagedFiles(value);
    const client = new FakeClient(value);
    client.discoverRepository = () => {
      throw new GitHubQualityError(
        'GitHub 远端暂时不可用',
        'Get "https://api.github.com/repos/owner/repository": EOF',
        { kind: 'transient', retryable: true, attempts: 3 },
      );
    };
    try {
      const unavailable = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: false,
        client,
      });
      expect(unavailable).toMatchObject({
        status: 'invalid',
        remoteChecked: false,
        remoteFailure: { kind: 'transient', attempts: 3 },
      });
      expect(unavailable.issues).toContainEqual(
        expect.objectContaining({
          file: 'GitHub Probe',
          message: expect.stringContaining('暂时不可用'),
        }),
      );
      expect(unavailable.issues.map((entry) => entry.message).join('\n')).not.toContain('Ruleset');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps earlier drift findings when a later remote read becomes unavailable', () => {
    const value = contract();
    const root = rootWithManagedFiles(value);
    const client = new FakeClient(value);
    client.securityFeatures.secretScanningPushProtection = false;
    client.listRulesets = () => {
      throw new GitHubQualityError('GitHub 远端暂时不可用', 'gh: HTTP 503', {
        kind: 'transient',
        retryable: true,
        attempts: 3,
      });
    };
    try {
      const unavailable = checkDeliveryGate({
        root,
        workspace: '.workspace',
        contract: value,
        local: false,
        client,
      });
      expect(unavailable).toMatchObject({
        status: 'invalid',
        remoteChecked: false,
        remoteFailure: { kind: 'transient', attempts: 3 },
      });
      expect(unavailable.issues.map((entry) => entry.message)).toEqual(
        expect.arrayContaining([
          expect.stringContaining('秘密推送保护实际为关闭'),
          expect.stringContaining('暂时不可用'),
        ]),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
