import { describe, expect, it } from 'vitest';
import { readQualityContract } from '../quality/contract.js';
import { createReviewPackage } from './package.js';
import type { ReviewPreflightContext } from './preflight.js';
import { assessReviewRisk } from './risk.js';

function context(): ReviewPreflightContext {
  const contract = readQualityContract(process.cwd());
  if (contract.status !== 'ready') throw new Error(`contract unavailable: ${contract.status}`);
  const baseSha = 'a'.repeat(40);
  const headSha = 'b'.repeat(40);
  return {
    root: process.cwd(), branch: 'feature/review', baseSha, headSha,
    pullRequest: {
      number: 1, headSha, baseBranch: 'main', baseSha,
      url: 'https://example.test/1', title: 'review', labels: [],
      body: '## 本次目标\nreview',
    },
    baseContract: contract.contract,
    baseContractDigest: contract.digest,
    changedFiles: ['README.md'],
    files: [{ path: 'README.md', base: 'old', head: 'new' }],
    diff: '-old\n+new\n',
    specs: [{ path: 'docs/specs/review.md', content: '# Review' }],
    engineeringStandards: [{ path: 'AGENTS.md', content: '# Rules' }],
    history: `${headSha}\treview`,
    prSections: {
      '本次目标': 'review', '明确的非目标': 'none',
      'Spec 与验收标准来源': 'docs/specs/review.md', '验证方式': 'tests',
      '风险说明': 'local',
    },
  };
}

describe('createReviewPackage', () => {
  it('contains the bound old quality contract and only engine-selected review data', () => {
    const ctx = context();
    const reviewPackage = createReviewPackage({
      context: ctx,
      risk: assessReviewRisk(ctx),
      axis: 'engineering',
      runner: 'codex',
      model: 'gpt-5.6-terra',
    });
    try {
      const input = JSON.parse(reviewPackage.input) as Record<string, unknown>;
      expect(input.qualityContract).toEqual(ctx.baseContract);
      expect(input).toMatchObject({
        axis: 'engineering',
        binding: { baseSha: ctx.baseSha, headSha: ctx.headSha },
        changedFiles: ['README.md'],
      });
      expect(input).not.toHaveProperty('workspace');
      reviewPackage.assertUnchanged();
    } finally {
      reviewPackage.cleanup();
    }
  });
});
