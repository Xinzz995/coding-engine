import { describe, expect, it, vi } from 'vitest';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { runGitHubReviewAxis } from './remote-review.js';
import type { GitHubClient } from './github.js';
import type { ModelCall } from './remote-review.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function setup(): { root: string; baseSha: string; eventPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'quality-remote-review-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.coding-x'));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(root, 'docs', 'specs', 'feature.md'), '# Feature\nMust return true.');
  writeFileSync(join(root, 'AGENTS.md'), '# Rules\nHandle errors.');
  writeFileSync(join(root, 'src.py'), 'def result(): return True\n');
  writeFileSync(join(root, '.coding-x', 'exceptions.json'), JSON.stringify({
    version: 1, exceptions: [], deliveries: [],
  }));
  writeFileSync(join(root, '.coding-x', 'quality.json'), JSON.stringify({
    version: 1,
    checks: [{ id: 'test', command: 'python -m unittest', cwd: '.', paths: ['src.py'] }],
    review: {
      model: 'openai/gpt-4.1',
      specSources: ['docs/specs/'],
      standardsSources: ['AGENTS.md'],
      deepReview: {
        highRiskPaths: ['.coding-x/'],
        changedProductionLines: 400,
        largeFileLines: 1000,
      },
    },
    github: {
      repository: 'owner/repo',
      defaultBranch: 'main',
      releaseRefs: [],
      codingXVersion: '0.30.0',
      requiredChecks: [
        'coding-x / project-checks',
        'coding-x / spec-review',
        'coding-x / standards-review',
        'coding-x / deep-review',
      ],
    },
    exceptionPolicy: { deferrableSeverities: ['medium'] },
    exceptionsFile: '.coding-x/exceptions.json',
  }));
  git(root, 'add', '.');
  git(root, 'commit', '-qm', 'base');
  git(root, 'branch', '-M', 'main');
  const baseSha = git(root, 'rev-parse', 'HEAD');
  const eventPath = join(root, 'event.json');
  writeFileSync(eventPath, JSON.stringify({
    repository: { full_name: 'owner/repo' },
    pull_request: {
      number: 1,
      title: 'Feature',
      body: `## 意图\nReturn true.\n## 验收标准\nReturns true.\n## 非目标\nNo IO.\n## 验证方式\nUnit test.`,
      base: { ref: 'main', sha: baseSha },
      head: { sha: 'b'.repeat(40) },
    },
  }));
  return { root, baseSha, eventPath };
}

function client(baseSha: string, body?: string): Partial<GitHubClient> {
  return {
    repository: 'owner/repo',
    getPullIdentity: vi.fn(async () => ({
      number: 1,
      title: 'Feature',
      body: body ?? `## 意图\nReturn true.\n## 验收标准\nReturns true.\n## 非目标\nNo IO.\n## 验证方式\nUnit test.`,
      baseRef: 'main',
      baseSha,
      headSha: 'b'.repeat(40),
    })),
    getPullDiff: vi.fn(async () => 'diff --git a/src.py b/src.py\n+def result(): return True'),
    getPullFiles: vi.fn(async () => [{
      filename: 'src.py', status: 'modified', additions: 1, deletions: 0,
      patch: '+def result(): return True',
    }]),
    getTreePaths: vi.fn(async () => ['AGENTS.md', 'docs/specs/feature.md', 'src.py']),
    getTextFile: vi.fn(async (path: string) =>
      path === 'AGENTS.md' ? '# Rules\nHandle errors.' : '# Feature\nMust return true.'),
    createCheckRun: vi.fn(async () => ({ id: 1, url: 'https://github.com/check/1' })),
  };
}

describe('remote review axis', () => {
  it('publishes a passed exact-head spec check from structured model output', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'spec',
      token: 'token',
      client: api as GitHubClient,
      modelCall: vi.fn(async () => ({
        status: 'valid',
        output: {
          summary: 'matches',
          findings: [{
            id: 'spec:src-py:1:abc',
            axis: 'spec',
            severity: 'low',
            file: 'src.py',
            line: 1,
            title: 'minor note',
            evidence: 'concrete evidence',
            source: 'AC 1',
            impact: 'small maintenance cost',
            recommendation: 'consider later',
          }],
        },
        error: null,
      })) as ModelCall,
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(result.receipt.status).toBe('passed');
    expect(result.receipt.headSha).toBe('b'.repeat(40));
    expect(result.receipt.reviewSummary).toBe('matches');
    expect(result.receipt.findings[0]).toMatchObject({
      headSha: 'b'.repeat(40),
      round: 1,
    });
    expect(api.createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      name: 'coding-x / spec-review',
      headSha: 'b'.repeat(40),
      status: 'passed',
    }));
  });

  it('does not call the model and publishes unverifiable when PR intent is incomplete', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha, '## 意图\nOnly intent');
    const modelCall = vi.fn();
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'spec',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0].code).toBe('intent-missing');
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('marks deep not-required as passed without spending a model call', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const modelCall = vi.fn();
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'deep',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(result.receipt).toMatchObject({ status: 'passed', deepRequired: false });
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('refuses stale event identity before publishing a success', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    (api.getPullIdentity as ReturnType<typeof vi.fn>).mockResolvedValue({
      number: 1,
      title: 'Feature',
      body: 'body',
      baseRef: 'main',
      baseSha,
      headSha: 'c'.repeat(40),
    });
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall: vi.fn(),
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0].code).toBe('stale-head');
  });

  it('publishes unverifiable when GitHub omits a changed file patch', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    (api.getPullFiles as ReturnType<typeof vi.fn>).mockResolvedValue([{
      filename: 'src.py',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: null,
    }]);
    const modelCall = vi.fn();
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0].code).toBe('diff-incomplete');
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('turns a thrown model call into a retained unverifiable check', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall: vi.fn(async () => {
        throw new Error('provider unavailable');
      }),
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0]).toMatchObject({ code: 'model-output-invalid' });
    expect(result.receipt.errors[0].message).toContain('provider unavailable');
    expect(api.createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      status: 'unverifiable',
    }));
  });

  it('rechecks PR identity after the model returns and rejects a superseded head', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    (api.getPullIdentity as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({
        number: 1,
        title: 'Feature',
        body: `## 意图\nReturn true.\n## 验收标准\nReturns true.\n## 非目标\nNo IO.\n## 验证方式\nUnit test.`,
        baseRef: 'main',
        baseSha,
        headSha: 'b'.repeat(40),
      })
      .mockResolvedValueOnce({
        number: 1,
        title: 'Feature',
        body: '',
        baseRef: 'main',
        baseSha,
        headSha: 'c'.repeat(40),
      });
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall: vi.fn(async () => ({
        status: 'valid' as const,
        output: { summary: 'old result', findings: [] },
        error: null,
      })),
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0]).toMatchObject({ code: 'stale-head' });
    expect(api.createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      headSha: 'b'.repeat(40),
      status: 'unverifiable',
    }));
  });

  it('rejects findings that invent paths outside the diff and declared sources', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall: vi.fn(async () => ({
        status: 'valid' as const,
        output: {
          summary: 'invented path',
          findings: [{
            id: 'standards:missing:1:x',
            axis: 'standards' as const,
            severity: 'high' as const,
            file: 'src/missing.py',
            line: 1,
            title: 'not in evidence',
            evidence: 'guessed',
            source: 'general',
            impact: 'unknown',
            recommendation: 'none',
          }],
        },
        error: null,
      })),
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0]).toMatchObject({ code: 'model-output-invalid' });
  });
});
