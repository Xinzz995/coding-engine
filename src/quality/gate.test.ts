import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { describe, expect, it, vi } from 'vitest';
import { publishProjectCheck, runProjectQualityGate } from './gate.js';
import type { GitHubClient } from './github.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function setup(command = 'node -e "process.exit(0)"'): {
  root: string;
  baseSha: string;
  headSha: string;
  eventPath: string;
} {
  const root = mkdtempSync(join(tmpdir(), 'quality-gate-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.coding-x'));
  writeFileSync(join(root, 'README.md'), '# Project');
  writeFileSync(join(root, '.coding-x', 'quality.json'), JSON.stringify({
    version: 1,
    checks: [{ id: 'test', command, cwd: '.', paths: ['README.md'] }],
    review: {
      model: 'openai/gpt-4.1',
      specSources: ['README.md'],
      standardsSources: ['README.md'],
      deepReview: { highRiskPaths: [], changedProductionLines: 400, largeFileLines: 1000 },
    },
    github: {
      repository: 'owner/repo',
      defaultBranch: 'main',
      releaseRefs: [],
      codingXVersion: '0.30.0',
      requiredChecks: ['coding-x / project-checks'],
    },
    exceptionPolicy: { deferrableSeverities: ['medium'] },
    exceptionsFile: '.coding-x/exceptions.json',
  }));
  writeFileSync(
    join(root, '.coding-x', 'exceptions.json'),
    '{"version":1,"exceptions":[],"deliveries":[]}',
  );
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  git(root, 'branch', '-M', 'main');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  git(root, 'checkout', '-qb', 'feature');
  writeFileSync(join(root, 'README.md'), '# Changed');
  git(root, 'add', 'README.md');
  git(root, 'commit', '-qm', 'change');
  const headSha = git(root, 'rev-parse', 'HEAD');
  const eventPath = `${root}-event.json`;
  writeFileSync(eventPath, JSON.stringify({
    repository: { full_name: 'owner/repo' },
    pull_request: {
      number: 1,
      title: 'Change',
      body: '',
      base: { ref: 'main', sha: baseSha },
      head: { sha: headSha },
    },
  }));
  return { root, baseSha, headSha, eventPath };
}

describe('project quality gate', () => {
  it('runs commands from the base contract and binds the exact head', async () => {
    const { root, baseSha, headSha } = setup();
    const result = await runProjectQualityGate({
      root,
      workspace: join(root, '.workspace'),
      baseSha,
      headSha,
      contractRef: baseSha,
    });
    expect(result.receipt.status).toBe('passed');
    expect(result.receipt.contractSha256).toMatch(/^[0-9a-f]{64}$/);
    expect(result.checks?.results[0].id).toBe('test');
  });

  it('rejects an old head before running project commands', async () => {
    const { root, baseSha } = setup();
    const result = await runProjectQualityGate({
      root,
      workspace: join(root, '.workspace'),
      baseSha,
      headSha: baseSha,
      contractRef: baseSha,
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0].code).toBe('stale-head');
    expect(result.checks).toBeNull();
  });

  it('classifies a nonzero project command as failed', async () => {
    const { root, baseSha, headSha } = setup('node -e "process.exit(7)"');
    const result = await runProjectQualityGate({
      root,
      workspace: join(root, '.workspace'),
      baseSha,
      headSha,
      contractRef: baseSha,
    });
    expect(result.receipt.status).toBe('failed');
  });
});

describe('project check publisher', () => {
  it('rechecks PR identity and publishes the job result on the exact head', async () => {
    const { root, baseSha, headSha, eventPath } = setup();
    git(root, 'checkout', '-q', 'main');
    const createCheckRun = vi.fn(async () => ({ id: 9, url: null }));
    const client = {
      repository: 'owner/repo',
      getPullIdentity: vi.fn(async () => ({
        number: 1,
        title: 'Change',
        body: '',
        baseRef: 'main',
        baseSha,
        headSha,
      })),
      createCheckRun,
    } as unknown as GitHubClient;
    const result = await publishProjectCheck({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      jobResult: 'success',
      token: 'token',
      client,
    });
    expect(result.receipt.status).toBe('passed');
    expect(createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      name: 'coding-x / project-checks',
      headSha,
      status: 'passed',
    }));
  });
});
