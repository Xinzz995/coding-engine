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
      provider: 'github-copilot',
      model: 'auto',
      copilotCliVersion: '1.0.74',
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
      codingXVersion: '0.31.0',
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
      body: `## 意图\nReturn true.\n## 验收标准\nReturns true.\n## 非目标\nNo IO.\n## 验证方式\nUnit test.\n## 关联规格\n- docs/specs/feature.md`,
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
      body: body ?? `## 意图\nReturn true.\n## 验收标准\nReturns true.\n## 非目标\nNo IO.\n## 验证方式\nUnit test.\n## 关联规格\n- docs/specs/feature.md`,
      baseRef: 'main',
      baseSha,
      headSha: 'b'.repeat(40),
    })),
    getPullDiff: vi.fn(async () => 'diff --git a/src.py b/src.py\n+def result(): return True'),
    getPullFiles: vi.fn(async () => [{
      filename: 'src.py', status: 'modified', additions: 1, deletions: 0,
      patch: '+def result(): return True',
    }]),
    getTreePaths: vi.fn(async () => [
      'AGENTS.md',
      'docs/specs/feature.md',
      'docs/specs/unrelated.md',
      'src.py',
    ]),
    getTextFile: vi.fn(async (path: string) =>
      path === 'AGENTS.md' ? '# Rules\nHandle errors.' : '# Feature\nMust return true.'),
    createCheckRun: vi.fn(async () => ({ id: 1, url: 'https://github.com/check/1' })),
  };
}

describe('remote review axis', () => {
  it('publishes a passed exact-head spec check from structured model output', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const modelCall = vi.fn(async () => ({
      status: 'valid' as const,
      output: {
        summary: 'matches',
        findings: [{
          id: 'spec:src-py:1:abc',
          axis: 'spec' as const,
          severity: 'low' as const,
          file: 'src.py',
          line: 1,
          title: 'minor note',
          evidence: '+def result(): return True',
          source: 'AC 1',
          impact: 'small maintenance cost',
          recommendation: 'consider later',
        }],
      },
      error: null,
      model: 'gpt-5-mini',
      premiumRequests: 0.33,
    }));
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'spec',
      token: 'github-api-token',
      client: api as GitHubClient,
      modelCall: modelCall as ModelCall,
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(result.receipt.status).toBe('passed');
    expect(result.receipt.headSha).toBe('b'.repeat(40));
    expect(result.receipt.reviewSummary).toBe('matches');
    expect(result.receipt).toMatchObject({
      model: 'github-copilot:gpt-5-mini',
      modelCalls: 1,
      premiumRequests: 0.33,
    });
    expect(result.receipt.findings[0]).toMatchObject({
      headSha: 'b'.repeat(40),
      round: 1,
    });
    expect(api.createCheckRun).toHaveBeenCalledWith(expect.objectContaining({
      name: 'coding-x / spec-review',
      headSha: 'b'.repeat(40),
      status: 'passed',
    }));
    expect(modelCall).toHaveBeenCalledWith(expect.objectContaining({
      token: 'github-api-token',
      model: 'auto',
      cliVersion: '1.0.74',
    }));
    const specReads = (api.getTextFile as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0].startsWith('docs/specs/'))
      .map((call) => call[0]);
    expect(specReads).toEqual(['docs/specs/feature.md']);
  });

  it('uses an explicitly self-contained PR Spec without loading the allowed directory', async () => {
    const { root, baseSha, eventPath } = setup();
    const body = `## 意图\nReturn true.\n## 验收标准\nReturns true.\n## 非目标\nNo IO.\n## 验证方式\nUnit test.\n## 关联规格\n本 PR 意图即完整 Spec`;
    const api = client(baseSha, body);
    const modelCall = vi.fn(async () => ({
      status: 'valid' as const,
      output: { summary: 'self-contained intent matches', findings: [] },
      error: null,
    }));
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'spec',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(result.receipt.status).toBe('passed');
    expect((api.getTextFile as ReturnType<typeof vi.fn>).mock.calls
      .some((call) => call[0].startsWith('docs/specs/'))).toBe(false);
  });

  it('automatically includes a changed Spec even when the PR intent is self-contained', async () => {
    const { root, baseSha, eventPath } = setup();
    const body = `## 意图\nClarify behavior.\n## 验收标准\nSpec is precise.\n## 非目标\nNo code change.\n## 验证方式\nReview the diff.\n## 关联规格\nself-contained`;
    const api = client(baseSha, body);
    (api.getPullDiff as ReturnType<typeof vi.fn>).mockResolvedValue(
      'diff --git a/docs/specs/feature.md b/docs/specs/feature.md\n+Must return true.',
    );
    (api.getPullFiles as ReturnType<typeof vi.fn>).mockResolvedValue([{
      filename: 'docs/specs/feature.md',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '+Must return true.',
    }]);
    const modelCall = vi.fn(async () => ({
      status: 'valid' as const,
      output: { summary: 'changed Spec matches', findings: [] },
      error: null,
    }));
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'spec',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(result.receipt.status).toBe('passed');
    expect((api.getTextFile as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[0] === 'docs/specs/feature.md')).toHaveLength(2);
  });

  it('fails closed when a declared Spec is outside the contract allowlist', async () => {
    const { root, baseSha, eventPath } = setup();
    const body = `## 意图\nReturn true.\n## 验收标准\nReturns true.\n## 非目标\nNo IO.\n## 验证方式\nUnit test.\n## 关联规格\nREADME.md`;
    const api = client(baseSha, body);
    const modelCall = vi.fn();
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'spec',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0]).toMatchObject({ code: 'review-source-invalid' });
    expect(modelCall).not.toHaveBeenCalled();
  });

  it('reviews every lossless shard and keeps the most severe duplicate result', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const modelCall = vi.fn()
      .mockResolvedValueOnce({
        status: 'invalid' as const,
        output: null,
        error: 'provider input exceeded',
        reason: 'input-too-large' as const,
      })
      .mockResolvedValueOnce({
        status: 'valid' as const,
        output: {
          summary: 'fragment clear',
          findings: [{
            id: 'spec:src-py:1:duplicate',
            axis: 'spec' as const,
            severity: 'low' as const,
            file: 'docs/specs/feature.md',
            line: 1,
            title: 'minor note',
            evidence: 'Must return true.',
            source: 'acceptance criteria',
            impact: 'small',
            recommendation: 'consider later',
          }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        status: 'valid' as const,
        output: {
          summary: 'fragment found a blocker',
          findings: [{
            id: 'spec:src-py:1:duplicate',
            axis: 'spec' as const,
            severity: 'high' as const,
            file: 'docs/specs/feature.md',
            line: 1,
            title: 'minor note',
            evidence: 'Must return true.',
            source: 'acceptance criteria',
            impact: 'breaks the promised behavior',
            recommendation: 'fix before merging',
          }],
        },
        error: null,
      });
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'spec',
      token: 'token',
      client: api as GitHubClient,
      modelCall: modelCall as ModelCall,
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(modelCall).toHaveBeenCalledTimes(3);
    expect(result.receipt.status).toBe('failed');
    expect(result.receipt.findings).toHaveLength(1);
    expect(result.receipt.findings[0].severity).toBe('high');
    expect(result.receipt.reviewSummary).toContain('2 个隔离输入分片');
  });

  it('pre-shards oversized prompts and paces valid provider calls', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    (api.getTextFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) =>
      path === 'AGENTS.md'
        ? 'Always handle the declared failure path.\n'.repeat(1_800)
        : '# Feature\nMust return true.');
    const modelCall = vi.fn(async () => ({
      status: 'valid' as const,
      output: { summary: 'fragment clear', findings: [] },
      error: null,
    }));
    const modelPause = vi.fn(async () => {});
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
      modelPause,
      modelPaceMs: 7,
    });
    expect(result.receipt.status).toBe('passed');
    expect(modelCall.mock.calls.length).toBeGreaterThan(1);
    expect(modelCall.mock.calls.length).toBeLessThanOrEqual(8);
    expect(modelPause).toHaveBeenCalledTimes(modelCall.mock.calls.length - 1);
    expect(modelPause).toHaveBeenCalledWith(7);
  });

  it('fails closed instead of dropping input when eight source shards are insufficient', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    (api.getTextFile as ReturnType<typeof vi.fn>).mockImplementation(async (path: string) =>
      path === 'AGENTS.md' ? 'Always handle the declared failure path.\n'.repeat(2_000) : 'src');
    const modelCall = vi.fn(async () => ({
      status: 'invalid' as const,
      output: null,
      error: 'provider input exceeded',
      reason: 'input-too-large' as const,
    }));
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(modelCall.mock.calls.length).toBeGreaterThan(0);
    expect(modelCall.mock.calls.length).toBeLessThanOrEqual(8);
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0]).toMatchObject({
      code: 'review-input-too-large',
    });
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

  it('keeps deep review isolated from Spec sources already reviewed by the Spec axis', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    (api.getPullDiff as ReturnType<typeof vi.fn>).mockResolvedValue(
      'diff --git a/.coding-x/quality.json b/.coding-x/quality.json\n+{"changed":true}',
    );
    (api.getPullFiles as ReturnType<typeof vi.fn>).mockResolvedValue([{
      filename: '.coding-x/quality.json',
      status: 'modified',
      additions: 1,
      deletions: 0,
      patch: '+{"changed":true}',
    }]);
    const modelCall = vi.fn(async () => ({
      status: 'valid' as const,
      output: { summary: 'structure remains clear', findings: [] },
      error: null,
    }));
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'deep',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(result.receipt).toMatchObject({ status: 'passed', deepRequired: true });
    const trustedSourceReads = (api.getTextFile as ReturnType<typeof vi.fn>).mock.calls
      .filter((call) => call[1] === baseSha)
      .map((call) => call[0]);
    expect(trustedSourceReads).toEqual(['AGENTS.md']);
    expect(trustedSourceReads).not.toContain('docs/specs/feature.md');
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
    const modelCall = vi.fn(async () => {
      throw new Error('provider unavailable');
    });
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(modelCall).toHaveBeenCalledTimes(1);
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

  it('retries one positive confirmation and uses only the corrected complete output', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const modelCall = vi.fn()
      .mockResolvedValueOnce({
        status: 'valid' as const,
        output: {
          summary: 'implementation is already correct',
          findings: [{
            id: 'standards:src-py:1:positive',
            axis: 'standards' as const,
            severity: 'medium' as const,
            file: 'src.py',
            line: 1,
            title: '测试已经覆盖正确实现',
            evidence: 'def result(): return True',
            source: 'general engineering baseline',
            impact: 'none',
            recommendation: '符合要求，无需修改。',
          }],
        },
        error: null,
      })
      .mockResolvedValueOnce({
        status: 'valid' as const,
        output: { summary: 'corrected complete review', findings: [] },
        error: null,
      });
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(modelCall.mock.calls[1][0].systemPrompt).toContain('调用方机械拒绝');
    expect(modelCall.mock.calls[1][0].systemPrompt).toContain('无需修改');
    expect(result.receipt.status).toBe('passed');
    expect(result.receipt.reviewSummary).toBe('corrected complete review');
    expect(result.receipt.findings).toEqual([]);
  });

  it('retries one schema-invalid model output but not a provider failure', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const modelCall = vi.fn()
      .mockResolvedValueOnce({
        status: 'invalid' as const,
        output: null,
        error: '模型输出 findings 字段非法',
        reason: 'invalid-output' as const,
      })
      .mockResolvedValueOnce({
        status: 'valid' as const,
        output: { summary: 'corrected schema', findings: [] },
        error: null,
      });
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(result.receipt.status).toBe('passed');
    expect(result.receipt.reviewSummary).toBe('corrected schema');
  });

  it('fails closed when auto routing changes model within one review axis', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const modelCall = vi.fn()
      .mockResolvedValueOnce({
        status: 'invalid' as const,
        output: null,
        error: 'schema invalid',
        reason: 'invalid-output' as const,
        model: 'gpt-5-mini',
        premiumRequests: 0.2,
      })
      .mockResolvedValueOnce({
        status: 'valid' as const,
        output: { summary: 'corrected schema', findings: [] },
        error: null,
        model: 'claude-haiku-4.5',
        premiumRequests: 0.3,
      });
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(result.receipt).toMatchObject({
      status: 'unverifiable',
      model: 'github-copilot:claude-haiku-4.5',
      modelCalls: 2,
      premiumRequests: 0.5,
      errors: [{
        code: 'model-output-invalid',
        message: expect.stringContaining('不一致的实际模型'),
      }],
    });
  });

  it('rejects a finding with fabricated evidence even when its file is in scope', async () => {
    const { root, baseSha, eventPath } = setup();
    const api = client(baseSha);
    const modelCall = vi.fn(async () => ({
      status: 'valid' as const,
      output: {
        summary: 'fabricated evidence',
        findings: [{
          id: 'standards:src-py:1:x',
          axis: 'standards' as const,
          severity: 'high' as const,
          file: 'src.py',
          line: 1,
          title: 'invented implementation',
          evidence: '+def result(): return False',
          source: 'general engineering baseline',
          impact: 'would return the wrong result',
          recommendation: 'return the promised result',
        }],
      },
      error: null,
    }));
    const result = await runGitHubReviewAxis({
      root,
      workspace: join(root, '.workspace'),
      eventPath,
      axis: 'standards',
      token: 'token',
      client: api as GitHubClient,
      modelCall,
    });
    expect(modelCall).toHaveBeenCalledTimes(2);
    expect(result.receipt.status).toBe('unverifiable');
    expect(result.receipt.errors[0]).toMatchObject({
      code: 'model-output-invalid',
      message: expect.stringContaining('逐字原文'),
    });
  });
});
