import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import {
  applyQualityInitFiles,
  buildQualityInitPlan,
  configureRemoteQuality,
  discoverQualityCandidates,
} from './init.js';
import {
  qualityBranchRulesetPayload,
  qualityReleaseRulesetPayload,
  type GitHubClient,
} from './github.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function project(): string {
  const root = mkdtempSync(join(tmpdir(), 'quality-init-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  git(root, 'remote', 'add', 'origin', 'https://github.com/owner/repo.git');
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'specs', 'feature.md'), '# Feature');
  writeFileSync(join(root, 'AGENTS.md'), '# Standards');
  writeFileSync(join(root, 'package.json'), JSON.stringify({
    scripts: { test: 'vitest run', build: 'tsc' },
  }));
  writeFileSync(join(root, 'package-lock.json'), '{}');
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'initial');
  git(root, 'branch', '-M', 'main');
  return root;
}

describe('quality init', () => {
  it('discovers commands but only writes after the caller confirms and applies', () => {
    const root = project();
    const candidates = discoverQualityCandidates(root);
    expect(candidates.map((item) => item.id)).toEqual(['install', 'test', 'build']);
    const plan = buildQualityInitPlan(root);
    expect(plan.files.some((file) => file.path === '.coding-x/quality.json')).toBe(true);
    expect(existsSync(join(root, '.coding-x', 'quality.json'))).toBe(false);
    const changed = applyQualityInitFiles(plan);
    expect(changed).toContain('.coding-x/quality.json');
    expect(changed).toContain('.gitignore');
    expect(JSON.parse(readFileSync(join(root, '.coding-x', 'quality.json'), 'utf8')))
      .toMatchObject({
        version: 1,
        review: { model: 'openai/gpt-4.1-mini' },
        github: { codingXVersion: expect.any(String) },
      });
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toContain('/.workspace/');
    expect(existsSync(join(root, '.github', 'workflows', 'coding-x-review.yml'))).toBe(true);
  });

  it('preserves an existing gitignore and appends workspace isolation once', () => {
    const root = project();
    writeFileSync(join(root, '.gitignore'), 'dist/\n');
    applyQualityInitFiles(buildQualityInitPlan(root));
    expect(readFileSync(join(root, '.gitignore'), 'utf8')).toBe('dist/\n/.workspace/\n');
    expect(buildQualityInitPlan(root).files.find((file) => file.path === '.gitignore')?.action)
      .toBe('unchanged');
  });

  it('is idempotent and refuses to overwrite a user-edited managed-looking file', () => {
    const root = project();
    applyQualityInitFiles(buildQualityInitPlan(root));
    expect(buildQualityInitPlan(root).files.every((file) => file.action === 'unchanged')).toBe(true);
    writeFileSync(
      join(root, '.github', 'workflows', 'coding-x-review.yml'),
      '# Managed by coding-x quality init. The workflow runs from the trusted default branch.\nuser edit\n',
    );
    expect(() => buildQualityInitPlan(root)).toThrow('拒绝覆盖');
  });

  it('upgrades only the managed coding-x version and refuses silent policy overrides', () => {
    const root = project();
    const first = buildQualityInitPlan(root);
    applyQualityInitFiles(first);
    const path = join(root, '.coding-x', 'quality.json');
    const contract = JSON.parse(readFileSync(path, 'utf8'));
    contract.github.codingXVersion = '0.29.0';
    writeFileSync(path, `${JSON.stringify(contract, null, 2)}\n`);
    const upgraded = buildQualityInitPlan(root);
    expect(upgraded.contract.github.codingXVersion).toBe('0.30.10');
    expect(upgraded.files.find((file) => file.path === '.coding-x/quality.json')?.action)
      .toBe('update');
    expect(() => buildQualityInitPlan(root, { model: 'other/model' }))
      .toThrow('不会静默改写');
  });

  it('requires explicit Spec and standards sources instead of inventing them', () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-init-empty-'));
    git(root, 'init', '-q');
    git(root, 'config', 'user.email', 'test@example.com');
    git(root, 'config', 'user.name', 'Test');
    git(root, 'config', 'commit.gpgsign', 'false');
    writeFileSync(join(root, 'app.py'), 'print("ok")');
    git(root, 'add', '.');
    git(root, 'commit', '-qm', 'initial');
    git(root, 'branch', '-M', 'main');
    expect(() => buildQualityInitPlan(root, {
      repository: 'owner/repo',
      checks: [{ id: 'test', command: 'python app.py', cwd: '.', paths: ['app.py'] }],
    })).toThrow('Spec 来源');
  });
});

describe('remote quality configuration', () => {
  it('binds every required check to GitHub Actions and verifies readback', async () => {
    const root = project();
    const plan = buildQualityInitPlan(root);
    const contract = plan.contract;
    const integrationId = 15368;
    const getRepository = vi.fn(async () => ({
      fullName: 'owner/repo',
      defaultBranch: 'main',
    }));
    const upsertRuleset = vi.fn(async (name: string) => {
      const payload = name === 'coding-x quality gate'
        ? qualityBranchRulesetPayload(
            'main',
            contract.github.requiredChecks.map((context) => ({
              context,
              integration_id: integrationId,
            })),
            1,
          )
        : qualityReleaseRulesetPayload([]);
      return { id: 1, ...payload };
    });
    const client = {
      getRepository,
      countAdditionalPushCollaborators: vi.fn(async () => 1),
      discoverGitHubActionsIntegrationId: vi.fn(async () => integrationId),
      getTextFile: vi.fn(async (path: string) => {
        const file = plan.files.find((item) => item.path.replace(/\\/g, '/') === path);
        if (!file) throw new Error(`missing ${path}`);
        return file.content;
      }),
      upsertRuleset,
    } as unknown as GitHubClient;
    const result = await configureRemoteQuality({ contract, token: 'token', client });
    expect(result.status).toBe('passed');
    expect(result.requiredApprovals).toBe(1);
    expect(upsertRuleset).toHaveBeenCalledWith(
      'coding-x quality gate',
      expect.objectContaining({ enforcement: 'active' }),
    );
  });

  it('fails closed before writing when no trusted check source exists', async () => {
    const contract = buildQualityInitPlan(project()).contract;
    const upsertRuleset = vi.fn();
    const client = {
      getRepository: vi.fn(async () => ({ fullName: 'owner/repo', defaultBranch: 'main' })),
      countAdditionalPushCollaborators: vi.fn(async () => 0),
      discoverGitHubActionsIntegrationId: vi.fn(async () => null),
      upsertRuleset,
    } as unknown as GitHubClient;
    const result = await configureRemoteQuality({ contract, token: 'token', client });
    expect(result.status).toBe('unverifiable');
    expect(upsertRuleset).not.toHaveBeenCalled();
  });

  it('does not activate rules before managed files exist on the default branch', async () => {
    const contract = buildQualityInitPlan(project()).contract;
    const upsertRuleset = vi.fn();
    const client = {
      getRepository: vi.fn(async () => ({ fullName: 'owner/repo', defaultBranch: 'main' })),
      countAdditionalPushCollaborators: vi.fn(async () => 0),
      discoverGitHubActionsIntegrationId: vi.fn(async () => 15368),
      getTextFile: vi.fn(async () => {
        throw new Error('not found');
      }),
      upsertRuleset,
    } as unknown as GitHubClient;
    const result = await configureRemoteQuality({ contract, token: 'token', client });
    expect(result.status).toBe('unverifiable');
    expect(result.errors.join(' ')).toContain('先把质量契约和受管工作流合并');
    expect(upsertRuleset).not.toHaveBeenCalled();
  });
});
