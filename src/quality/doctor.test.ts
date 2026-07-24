import { execFileSync } from 'node:child_process';
import {
  mkdtempSync,
  mkdirSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  applyQualityInitFiles,
  buildQualityInitPlan,
} from './init.js';
import { runQualityDoctor } from './doctor.js';
import {
  qualityBranchRulesetPayload,
  type GitHubClient,
} from './github.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function setup(): string {
  const root = mkdtempSync(join(tmpdir(), 'quality-doctor-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'specs', 'feature.md'), '# Feature');
  writeFileSync(join(root, 'AGENTS.md'), '# Standards');
  writeFileSync(join(root, 'Makefile'), 'test:\n\ttrue\n');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  git(root, 'branch', '-M', 'main');
  applyQualityInitFiles(buildQualityInitPlan(root));
  git(root, 'add', '.coding-x', '.github', '.gitignore');
  git(root, 'commit', '-qm', 'quality');
  return root;
}

describe('quality doctor', () => {
  it('passes local managed-file and contract checks without claiming remote readiness', async () => {
    const root = setup();
    const result = await runQualityDoctor({
      root,
      workspace: join(root, '.workspace'),
      remote: false,
    });
    expect(result.receipt.status).toBe('passed');
    expect(result.checks.find((item) => item.id === 'exceptions-current')?.message)
      .toContain('没有过期记录');
    expect(result.checks.find((item) => item.id === 'remote-not-checked')?.message)
      .toContain('未证明远端');
    expect(result.checks.find((item) => item.id === 'workspace-isolated')?.status)
      .toBe('passed');
  });

  it('fails closed when workspace feedback is not ignored by tracked policy', async () => {
    const root = setup();
    writeFileSync(join(root, '.gitignore'), '');
    const result = await runQualityDoctor({
      root,
      workspace: join(root, '.workspace'),
      remote: false,
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors.some((item) => item.code === 'workspace-isolated'))
      .toBe(true);
  });

  it('fails closed on an expired exception', async () => {
    const root = setup();
    writeFileSync(join(root, '.coding-x', 'exceptions.json'), JSON.stringify({
      version: 1,
      exceptions: [{
        id: 'EX-1',
        findingId: 'standards:file:1:x',
        reason: 'temporary',
        owner: 'owner',
        expiresAt: '2020-01-01T00:00:00Z',
        followUpUrl: 'https://github.com/owner/repo/issues/1',
      }],
      deliveries: [],
    }));
    const result = await runQualityDoctor({
      root,
      workspace: join(root, '.workspace'),
      remote: false,
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors.some((item) => item.message.includes('过期异常'))).toBe(true);
  });

  it('shows an unresolved emergency bypass as exceptional delivery, never normal passage', async () => {
    const root = setup();
    writeFileSync(join(root, '.coding-x', 'exceptions.json'), JSON.stringify({
      version: 1,
      exceptions: [],
      deliveries: [{
        id: 'DELIVERY-1',
        commitSha: 'a'.repeat(40),
        reason: 'production recovery',
        owner: 'owner',
        expiresAt: '2026-07-30T00:00:00Z',
        followUpUrl: 'https://github.com/owner/repo/issues/2',
        auditUrl: 'https://github.com/owner/repo/settings/rules',
      }],
    }));
    const result = await runQualityDoctor({
      root,
      workspace: join(root, '.workspace'),
      remote: false,
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors.some((item) => item.message.includes('异常交付'))).toBe(true);
  });

  it('semantically verifies the live GitHub ruleset', async () => {
    const root = setup();
    const contract = buildQualityInitPlan(root).contract;
    const integrationId = 15368;
    const payload = qualityBranchRulesetPayload(
      'main',
      contract.github.requiredChecks.map((context) => ({
        context,
        integration_id: integrationId,
      })),
      0,
    );
    const client = {
      getRepository: vi.fn(async () => ({ fullName: 'owner/repo', defaultBranch: 'main' })),
      discoverGitHubActionsIntegrationId: vi.fn(async () => integrationId),
      countAdditionalPushCollaborators: vi.fn(async () => 0),
      listRulesets: vi.fn(async () => [{
        id: 1,
        name: 'coding-x quality gate',
        enforcement: 'active',
        target: 'branch',
      }]),
      getRuleset: vi.fn(async () => ({ id: 1, ...payload })),
    } as unknown as GitHubClient;
    const result = await runQualityDoctor({
      root,
      workspace: join(root, '.workspace'),
      remote: true,
      token: 'token',
      client,
    });
    expect(result.receipt.status).toBe('passed');
  });
});
