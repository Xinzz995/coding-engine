import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import type { GitHubQualityClient } from '../quality/github.js';
import { runReviewPreflight, validatePullRequestIntent } from './preflight.js';

const completeBody = `
## 本次目标
实现严格最终评审。

## 明确的非目标
不在 GitHub 调用模型。

## Spec 与验收标准来源
docs/specs/review.md 与 PR 验收说明。

## 验证方式
npm test

## 风险说明
本地 Runner 隔离。
`;

describe('validatePullRequestIntent', () => {
  it('accepts all required non-empty PR sections', () => {
    const result = validatePullRequestIntent(completeBody);
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.sections['本次目标']).toContain('最终评审');
  });

  it('does not count template comments or empty headings as intent', () => {
    const result = validatePullRequestIntent(completeBody.replace(
      'docs/specs/review.md 与 PR 验收说明。',
      '<!-- 请填写 -->',
    ));
    expect(result).toEqual({ ok: false, missing: ['Spec 与验收标准来源'] });
  });

  it.each([
    ['nested comment markers', '<!<!-- nested -->--><!-- 请填写 -->'],
    ['punctuation only', '<!-- 请填写 -->\n---'],
    ['unfinished comment', '<!-- 尚未填写'],
  ])('rejects %s as meaningful intent', (_label, replacement) => {
    const result = validatePullRequestIntent(completeBody.replace(
      'docs/specs/review.md 与 PR 验收说明。',
      replacement,
    ));
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.missing).toContain('Spec 与验收标准来源');
  });
});

function run(root: string, args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

describe('runReviewPreflight old-policy boundary', () => {
  it('uses the default-branch generated paths when deciding whether the worktree is clean', () => {
    const root = mkdtempSync(join(tmpdir(), 'review-preflight-'));
    const remote = mkdtempSync(join(tmpdir(), 'review-preflight-remote-'));
    try {
      run(remote, ['init', '--bare', '-q']);
      run(root, ['init', '-q', '-b', 'main']);
      run(root, ['config', 'user.email', 'review@test.local']);
      run(root, ['config', 'user.name', 'review-test']);
      const source = readQualityContract(process.cwd());
      if (source.status !== 'ready') throw new Error(`contract unavailable: ${source.status}`);
      const baseContract: QualityContract = structuredClone(source.contract);
      baseContract.repository = { provider: 'github', fullName: 'owner/repo', defaultBranch: 'main' };
      baseContract.generatedPaths = [];
      baseContract.sources.engineeringStandards = ['AGENTS.md'];
      mkdirSync(join(root, '.coding-x'), { recursive: true });
      mkdirSync(join(root, 'docs/specs'), { recursive: true });
      mkdirSync(join(root, 'src'), { recursive: true });
      writeFileSync(join(root, '.coding-x/quality.json'), `${JSON.stringify(baseContract, null, 2)}\n`);
      writeFileSync(join(root, 'AGENTS.md'), '# Rules\n');
      writeFileSync(join(root, 'docs/specs/review.md'), '# Spec\n');
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 1;\n');
      run(root, ['add', '-A']);
      run(root, ['commit', '-q', '-m', 'base']);
      run(root, ['remote', 'add', 'origin', remote]);
      run(root, ['push', '-q', '-u', 'origin', 'main']);
      const baseSha = run(root, ['rev-parse', 'HEAD']);

      run(root, ['switch', '-q', '-c', 'feature/review']);
      const currentContract = structuredClone(baseContract);
      currentContract.generatedPaths = ['src/**'];
      writeFileSync(join(root, '.coding-x/quality.json'), `${JSON.stringify(currentContract, null, 2)}\n`);
      run(root, ['add', '.coding-x/quality.json']);
      run(root, ['commit', '-q', '-m', 'weaken generated paths']);
      const headSha = run(root, ['rev-parse', 'HEAD']);
      writeFileSync(join(root, 'src/a.ts'), 'export const a = 999;\n');

      const client = {
        discoverRepository: () => ({ fullName: 'owner/repo', defaultBranch: 'main', isPrivate: true }),
        findOpenPullRequest: () => ({
          number: 1, headSha, baseBranch: 'main', baseSha,
          url: 'https://example.test/1', title: 'policy change', body: completeBody, labels: [],
        }),
      } as unknown as GitHubQualityClient;
      const result = runReviewPreflight({
        root, workspace: join(root, '.workspace'), currentContract, client,
      });
      expect(result).toMatchObject({ status: 'config-error' });
      if (result.status !== 'ready') expect(result.message).toContain('src/a.ts');
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(remote, { recursive: true, force: true });
    }
  });
});
