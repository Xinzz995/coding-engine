import { describe, expect, it } from 'vitest';
import type { QualityContract } from '../quality/contract.js';
import { GITHUB_ACTIONS_APP_ID, type GitHubRuleset } from '../quality/github.js';
import { buildManagedRulesetPayload } from '../quality/ruleset.js';
import {
  digestIssueExecutionContract,
  parseIssueExecutionContract,
  reconcileIssueExecutionContract,
  reconcileIssueRemoteAuthority,
  type IssueExecutionContract,
} from './issue-execution-contract.js';

function rawContract() {
  return {
    schemaVersion: 1,
    storyAcceptance: {
      evidenceSource: 'validator',
      network: 'disabled',
      criteria: ['行为符合需求'],
    },
    localChecks: {
      evidenceSource: 'engine',
      network: 'current-host',
      mode: 'scoped',
      checkIds: ['tests'],
    },
    remoteDelivery: {
      evidenceSource: 'github',
      network: 'github-actions',
      mode: 'scoped',
      checkIds: ['dependency-audit'],
      ruleset: 'required',
    },
    runMetrics: {
      evidenceSource: 'engine-clock',
      metrics: ['ready-to-trusted', 'active', 'waiting', 'continuations'],
    },
  };
}

function qualityContract(): QualityContract {
  return {
    checks: {
      test: {
        checks: [
          {
            id: 'tests',
            module: 'root',
            command: {
              executable: 'npm',
              args: ['test'],
              cwd: '.',
              platforms: ['linux', 'macos', 'windows'],
              timeoutMs: 60_000,
            },
          },
        ],
      },
      build: { notApplicable: 'fixture' },
      static: { notApplicable: 'fixture' },
      security: {
        checks: [
          {
            id: 'dependency-audit',
            module: 'root',
            command: {
              executable: 'npm',
              args: ['audit'],
              cwd: '.',
              platforms: ['linux'],
              timeoutMs: 60_000,
            },
          },
        ],
      },
    },
    github: {
      jobs: [
        {
          id: 'linux',
          platform: 'linux',
          toolchains: [],
          setup: [],
          checkIds: ['tests', 'dependency-audit'],
        },
        {
          id: 'macos',
          platform: 'macos',
          toolchains: [],
          setup: [],
          checkIds: ['tests'],
        },
      ],
      requiredChecks: ['quality-gate'],
    },
  } as unknown as QualityContract;
}

function parsed(raw: unknown = rawContract()): IssueExecutionContract {
  const result = parseIssueExecutionContract(raw);
  if (!result.ok) throw new Error(result.errors.join('; '));
  return result.contract;
}

function managedRuleset(): GitHubRuleset {
  return {
    id: 7,
    ...buildManagedRulesetPayload(null, [
      { context: 'quality-gate', integration_id: GITHUB_ACTIONS_APP_ID },
    ]),
  };
}

describe('ready Issue execution contract', () => {
  it('strictly parses every responsibility layer and freezes a content digest', () => {
    const first = parseIssueExecutionContract(rawContract());
    expect(first).toMatchObject({
      ok: true,
      contract: {
        storyAcceptance: { evidenceSource: 'validator', network: 'disabled' },
        localChecks: { evidenceSource: 'engine', mode: 'scoped', checkIds: ['tests'] },
        remoteDelivery: {
          evidenceSource: 'github',
          mode: 'scoped',
          checkIds: ['dependency-audit'],
        },
        runMetrics: { evidenceSource: 'engine-clock' },
      },
    });
    if (!first.ok) throw new Error('fixture contract must parse');
    expect(first.digest).toBe(digestIssueExecutionContract(first.contract));

    const changed = rawContract();
    changed.storyAcceptance.criteria = ['另一个行为'];
    const second = parseIssueExecutionContract(changed);
    expect(second.ok).toBe(true);
    if (!second.ok) throw new Error('changed fixture contract must parse');
    expect(second.digest).not.toBe(first.digest);
  });

  it('rejects ambiguous modes, unknown fields and responsibility or network reassignment', () => {
    const fullWithIds = rawContract();
    fullWithIds.localChecks.mode = 'full';
    expect(parseIssueExecutionContract(fullWithIds)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('full 时 checkIds 必须为空')]),
    });

    const misplaced = rawContract();
    misplaced.storyAcceptance.evidenceSource = 'engine';
    misplaced.storyAcceptance.network = 'current-host';
    Object.assign(misplaced.localChecks, { command: 'npm test' });
    expect(parseIssueExecutionContract(misplaced)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([
        expect.stringContaining('storyAcceptance.evidenceSource'),
        expect.stringContaining('storyAcceptance.network'),
        expect.stringContaining('localChecks.command 是未知字段'),
      ]),
    });

    const invalidUnicode = rawContract();
    invalidUnicode.storyAcceptance.criteria = ['\ud800x'];
    expect(parseIssueExecutionContract(invalidUnicode)).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('非空字符串')]),
    });
  });

  it('reproduces #207 by rejecting a Linux-only local check on macOS before accepting remote ownership', () => {
    const local = rawContract();
    local.localChecks.checkIds = ['dependency-audit'];
    local.remoteDelivery.checkIds = [];
    const localResult = reconcileIssueExecutionContract(parsed(local), qualityContract(), 'macos');
    expect(localResult).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('dependency-audit 不支持当前平台 macos')],
    });

    const remoteResult = reconcileIssueExecutionContract(
      parsed(rawContract()),
      qualityContract(),
      'macos',
    );
    expect(remoteResult).toEqual({
      ok: true,
      capabilities: {
        localMode: 'scoped',
        localCheckIds: ['tests'],
        remoteMode: 'scoped',
        remoteCheckIds: ['dependency-audit'],
      },
    });
  });

  it('rejects unknown ids and remote checks without an authoritative GitHub job', () => {
    const unknown = rawContract();
    unknown.localChecks.checkIds = ['missing'];
    expect(
      reconcileIssueExecutionContract(parsed(unknown), qualityContract(), 'linux'),
    ).toMatchObject({ ok: false, errors: [expect.stringContaining('missing 不存在')] });

    const quality = qualityContract();
    quality.github.jobs[0].checkIds = ['tests'];
    expect(reconcileIssueExecutionContract(parsed(), quality, 'macos')).toMatchObject({
      ok: false,
      errors: [expect.stringContaining('dependency-audit 没有对应的 GitHub job')],
    });

    const unsupportedFull = rawContract();
    unsupportedFull.remoteDelivery.mode = 'full';
    unsupportedFull.remoteDelivery.checkIds = [];
    expect(
      reconcileIssueExecutionContract(parsed(unsupportedFull), qualityContract(), 'macos'),
    ).toMatchObject({
      ok: false,
      errors: expect.arrayContaining([expect.stringContaining('远端 full 当前无法')]),
    });
  });

  it('requires the live managed Ruleset before spending an Agent run', () => {
    expect(reconcileIssueRemoteAuthority(qualityContract(), [managedRuleset()])).toEqual([]);
    expect(reconcileIssueRemoteAuthority(qualityContract(), [])).toContain(
      '没有 coding-x 管理的默认分支 Ruleset',
    );

    const bypassed = managedRuleset();
    bypassed.bypass_actors = [
      {
        actor_id: 1,
        actor_type: 'RepositoryRole',
        bypass_mode: 'always',
      },
    ];
    expect(reconcileIssueRemoteAuthority(qualityContract(), [bypassed])).toContain(
      '存在日常绕过者',
    );
  });
});
