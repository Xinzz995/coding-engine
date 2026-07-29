import { describe, expect, it } from 'vitest';
import type { QualityContract } from '../quality/contract.js';
import type { ReviewPreflightContext } from './preflight.js';
import {
  applyReviewerDeepReviewRequest,
  assessReviewRisk,
  REVIEWER_DEEP_REVIEW_REASON,
} from './risk.js';

function context(over: Partial<ReviewPreflightContext> = {}): ReviewPreflightContext {
  const contract = {
    modules: [{ id: 'docs', path: 'docs' }, { id: 'api', path: 'api' }, { id: 'web', path: 'web' }],
    generatedPaths: ['dist/**'],
    risk: {
      defaultCategories: ['policy', 'subprocess', 'large-file'],
      highRiskPaths: ['src/engine/**'],
      pathRules: [{ paths: ['.github/workflows/**'], categories: ['policy', 'security'] }],
    },
  } as QualityContract;
  return {
    root: '/repo', workspace: '/repo/.workspace',
    branch: 'feature', baseSha: 'a'.repeat(40), headSha: 'b'.repeat(40),
    pullRequest: {
      number: 1, headSha: 'b'.repeat(40), baseBranch: 'main', baseSha: 'a'.repeat(40),
      url: 'https://example.test/1', title: 'change', body: '', labels: [],
    },
    baseContract: contract,
    baseContractDigest: 'sha256:x',
    changedFiles: ['docs/readme.md'],
    files: [{ path: 'docs/readme.md', base: 'old', head: 'new' }],
    diff: '+documentation only', specs: [], engineeringStandards: [], history: '',
    prSections: {
      '本次目标': 'x', '明确的非目标': 'x', 'Spec 与验收标准来源': 'x',
      '验证方式': 'x', '风险说明': 'x',
    },
    ...over,
  };
}

describe('assessReviewRisk', () => {
  it('does not deep-review an ordinary small documentation change', () => {
    expect(assessReviewRisk(context())).toMatchObject({ triggered: false, categories: [] });
  });

  it('triggers policy, high-risk and explicit reviewer signals without treating locks as large files', () => {
    const largeLock = `${'x\n'.repeat(1500)}`;
    const result = assessReviewRisk(context({
      changedFiles: ['.github/workflows/ci.yml', 'src/engine/loop.ts', 'package-lock.json'],
      files: [
        { path: '.github/workflows/ci.yml', base: '', head: 'jobs:' },
        { path: 'src/engine/loop.ts', base: '', head: 'spawn()' },
        { path: 'package-lock.json', base: '', head: largeLock },
      ],
      diff: '+spawn child process',
      pullRequest: { ...context().pullRequest, body: '- [x] 我主动要求深度结构评审\n' },
    }));
    expect(result.triggered).toBe(true);
    expect(result.categories).toEqual(expect.arrayContaining([
      'policy', 'security', 'high-risk-path', 'subprocess', 'reviewer-request',
    ]));
    expect(result.categories).not.toContain('large-file');
  });

  it('uses three declared modules and hand-written thousand-line files as investigation signals', () => {
    const result = assessReviewRisk(context({
      changedFiles: ['docs/a.md', 'api/a.go', 'web/a.py'],
      files: [
        { path: 'docs/a.md', base: '', head: 'x\n'.repeat(1001) },
        { path: 'api/a.go', base: '', head: 'package api' },
        { path: 'web/a.py', base: '', head: 'pass' },
      ],
    }));
    expect(result.categories).toEqual(expect.arrayContaining(['cross-module', 'large-file']));
  });

  it('adds a reproducible Reviewer escalation even when the PR already requested deep review', () => {
    const base = assessReviewRisk(context({
      pullRequest: { ...context().pullRequest, body: '- [x] 我主动要求深度结构评审\n' },
    }));
    const escalated = applyReviewerDeepReviewRequest(base, true);
    expect(escalated.categories.filter((item) => item === 'reviewer-request')).toHaveLength(1);
    expect(escalated.reasons).toContain(REVIEWER_DEEP_REVIEW_REASON);
    expect(applyReviewerDeepReviewRequest(escalated, true)).toEqual(escalated);
  });
});
