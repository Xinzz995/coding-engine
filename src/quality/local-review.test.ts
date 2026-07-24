import { describe, expect, it, vi } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLocalQualityReview } from './local-review.js';

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function setup(): { root: string; intentPath: string } {
  const root = mkdtempSync(join(tmpdir(), 'quality-local-review-'));
  git(root, 'init', '-q');
  git(root, 'config', 'user.email', 'test@example.com');
  git(root, 'config', 'user.name', 'Test');
  git(root, 'config', 'commit.gpgsign', 'false');
  mkdirSync(join(root, '.coding-x'));
  mkdirSync(join(root, 'docs', 'specs'), { recursive: true });
  writeFileSync(join(root, 'AGENTS.md'), '# Standards');
  writeFileSync(join(root, 'docs', 'specs', 'one.md'), '# Spec');
  writeFileSync(join(root, 'docs', 'specs', 'unrelated.md'), '# Unrelated');
  writeFileSync(join(root, 'app.py'), 'def value(): return 1\n');
  writeFileSync(join(root, 'other.py'), 'def other(): return 10\n');
  writeFileSync(join(root, '.coding-x', 'quality.json'), JSON.stringify({
    version: 1,
    checks: [{ id: 'test', command: 'python -m unittest', cwd: '.', paths: ['app.py'] }],
    review: {
      provider: 'github-copilot',
      model: 'auto',
      copilotCliVersion: '1.0.74',
      specSources: ['docs/specs/'],
      standardsSources: ['AGENTS.md'],
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
  git(root, 'checkout', '-qb', 'feature');
  writeFileSync(join(root, 'app.py'), 'def value(): return 2\n');
  writeFileSync(join(root, 'other.py'), 'def other(): return 20\n');
  git(root, 'add', 'app.py', 'other.py');
  git(root, 'commit', '-qm', 'change');
  const intentPath = `${root}-intent.md`;
  writeFileSync(
    intentPath,
    '## 意图\nchange\n## 验收标准\nreturns 2\n## 非目标\nno IO\n## 验证方式\nunit test\n## 关联规格\n- docs/specs/one.md',
  );
  return { root, intentPath };
}

describe('local quality review', () => {
  it('runs isolated spec and standards reviews and records deep not-required', async () => {
    const { root, intentPath } = setup();
    const agentCall = vi.fn(async ({ axis }: { axis: string; prompt: string }) => ({
      status: 'valid' as const,
      output: { summary: `${axis} clear`, findings: [] },
      error: null,
      durationMs: 1,
    }));
    const workspace = join(root, '.workspace');
    const result = await runLocalQualityReview({
      root,
      workspace,
      baseRef: 'main',
      intentPath,
      kind: 'codex',
      agentCall,
      now: new Date('2026-07-24T00:00:00Z'),
    });
    expect(result.status).toBe('passed');
    expect(result.receipts.map((receipt) => receipt.axis)).toEqual(['spec', 'standards', 'deep']);
    expect(agentCall).toHaveBeenCalledTimes(2);
    const specPrompt = agentCall.mock.calls.find(([call]) => call.axis === 'spec')?.[0].prompt;
    expect(specPrompt).toContain('docs/specs/one.md');
    expect(specPrompt).not.toContain('docs/specs/unrelated.md');
    expect(readFileSync(join(workspace, 'quality', 'review-latest.md'), 'utf8'))
      .toContain('交付凭证');
  });

  it('requires a clean exact-head worktree', async () => {
    const { root, intentPath } = setup();
    writeFileSync(join(root, 'untracked.txt'), 'dirty');
    const result = await runLocalQualityReview({
      root,
      workspace: join(root, '.workspace'),
      baseRef: 'main',
      intentPath,
      kind: 'codex',
      agentCall: vi.fn(),
    });
    expect(result.status).toBe('unverifiable');
    expect(result.receipts[0].errors[0].code).toBe('worktree-dirty');
  });

  it('retains thrown reviewer failures as unverifiable axis receipts', async () => {
    const { root, intentPath } = setup();
    const result = await runLocalQualityReview({
      root,
      workspace: join(root, '.workspace'),
      baseRef: 'main',
      intentPath,
      kind: 'codex',
      agentCall: vi.fn(async () => {
        throw new Error('runner unavailable');
      }),
    });
    expect(result.status).toBe('unverifiable');
    expect(result.receipts.slice(0, 2).every((receipt) =>
      receipt.errors[0]?.message.includes('runner unavailable'))).toBe(true);
  });

  it('records interruption and does not start a new deep reviewer', async () => {
    const { root, intentPath } = setup();
    const agentCall = vi.fn(async () => ({
      status: 'invalid' as const,
      output: null,
      error: '只读 reviewer 被 SIGINT 中断',
      durationMs: 1,
    }));
    const result = await runLocalQualityReview({
      root,
      workspace: join(root, '.workspace'),
      baseRef: 'main',
      intentPath,
      kind: 'codex',
      agentCall,
    });
    expect(result.status).toBe('unverifiable');
    expect(agentCall).toHaveBeenCalledTimes(2);
    expect(result.receipts[2].errors[0]).toMatchObject({
      code: 'review-interrupted',
    });
    expect(result.receipts[0].durationMs).toBe(1);
  });

  it('rejects locally fabricated finding evidence instead of treating it as a defect', async () => {
    const { root, intentPath } = setup();
    const agentCall = vi.fn(async ({ axis }: { axis: string }) => ({
      status: 'valid' as const,
      output: axis === 'spec'
        ? { summary: 'clear', findings: [] }
        : {
            summary: 'invented',
            findings: [{
              id: 'standards:app-py:1:x',
              axis: 'standards' as const,
              severity: 'high' as const,
              file: 'app.py',
              line: 1,
              title: 'invented return value',
              evidence: '+def value(): return 3',
              source: 'general engineering baseline',
              impact: 'would return an unsupported value',
              recommendation: 'return the intended value',
            }],
          },
      error: null,
      durationMs: 1,
    }));
    const result = await runLocalQualityReview({
      root,
      workspace: join(root, '.workspace'),
      baseRef: 'main',
      intentPath,
      kind: 'codex',
      agentCall,
    });
    expect(result.status).toBe('unverifiable');
    expect(result.receipts[1].errors[0]).toMatchObject({
      code: 'model-output-invalid',
      message: expect.stringContaining('逐字原文'),
    });
  });

  it('does not borrow local diff evidence from another changed file', async () => {
    const { root, intentPath } = setup();
    const agentCall = vi.fn(async ({ axis }: { axis: string }) => ({
      status: 'valid' as const,
      output: axis === 'spec'
        ? { summary: 'clear', findings: [] }
        : {
            summary: 'wrong file',
            findings: [{
              id: 'standards:app-py:1:x',
              axis: 'standards' as const,
              severity: 'high' as const,
              file: 'app.py',
              line: 1,
              title: 'wrongly attributed return value',
              evidence: '+def other(): return 20',
              source: 'general engineering baseline',
              impact: 'attributes another file to app.py',
              recommendation: 'cite the matching file',
            }],
          },
      error: null,
      durationMs: 1,
    }));
    const result = await runLocalQualityReview({
      root,
      workspace: join(root, '.workspace'),
      baseRef: 'main',
      intentPath,
      kind: 'codex',
      agentCall,
    });
    expect(result.status).toBe('unverifiable');
    expect(result.receipts[1].errors[0]).toMatchObject({
      code: 'model-output-invalid',
      message: expect.stringContaining('对应文件'),
    });
  });

  it('rejects a positive confirmation instead of reporting it as a local finding', async () => {
    const { root, intentPath } = setup();
    const agentCall = vi.fn(async ({ axis }: { axis: string }) => ({
      status: 'valid' as const,
      output: axis === 'spec'
        ? { summary: 'clear', findings: [] }
        : {
            summary: 'already correct',
            findings: [{
              id: 'standards:app-py:1:positive',
              axis: 'standards' as const,
              severity: 'medium' as const,
              file: 'app.py',
              line: 1,
              title: '行为已经被覆盖',
              evidence: 'def value(): return 2',
              source: 'general engineering baseline',
              impact: 'none',
              recommendation: '符合要求，无需修改。',
            }],
          },
      error: null,
      durationMs: 1,
    }));
    const result = await runLocalQualityReview({
      root,
      workspace: join(root, '.workspace'),
      baseRef: 'main',
      intentPath,
      kind: 'codex',
      agentCall,
    });
    expect(result.status).toBe('unverifiable');
    expect(result.receipts[1].errors[0]).toMatchObject({
      code: 'model-output-invalid',
      message: expect.stringContaining('无需修改'),
    });
  });
});
