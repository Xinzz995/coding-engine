import { describe, expect, it } from 'vitest';
import { assessDeepReviewRisk } from './risk.js';
import type { DeepReviewPolicy } from './types.js';
import type { GitDiffBundle } from './git.js';

const policy: DeepReviewPolicy = {
  highRiskPaths: ['.github/', '.coding-x/', 'src/security/'],
  changedProductionLines: 400,
  largeFileLines: 1000,
};

function bundle(overrides: Partial<GitDiffBundle> = {}): GitDiffBundle {
  return {
    baseSha: 'a'.repeat(40),
    headSha: 'b'.repeat(40),
    diff: '',
    changedFiles: [],
    numstat: [],
    ...overrides,
  };
}

describe('deep review risk', () => {
  it('does not trigger for a small documentation-only change', () => {
    const result = assessDeepReviewRisk(bundle({
      changedFiles: ['docs/guide.md'],
      numstat: [{ path: 'docs/guide.md', added: 5, deleted: 1 }],
    }), policy, () => 20);
    expect(result.required).toBe(false);
    expect(result.reasons).toEqual([]);
  });

  it.each([
    ['quality policy', bundle({
      changedFiles: ['.coding-x/quality.json'],
      numstat: [{ path: '.coding-x/quality.json', added: 5, deleted: 1 }],
    })],
    ['high risk path', bundle({
      changedFiles: ['src/security/auth.ts'],
      numstat: [{ path: 'src/security/auth.ts', added: 5, deleted: 1 }],
    })],
    ['risk terms', bundle({
      changedFiles: ['src/store.ts'],
      numstat: [{ path: 'src/store.ts', added: 5, deleted: 1 }],
      diff: '+ acquire distributed lock before database migration',
    })],
    ['large production diff', bundle({
      changedFiles: ['src/app.ts'],
      numstat: [{ path: 'src/app.ts', added: 350, deleted: 51 }],
    })],
    ['binary unknown', bundle({
      changedFiles: ['src/model.bin'],
      numstat: [{ path: 'src/model.bin', added: null, deleted: null }],
    })],
    ['three modules', bundle({
      changedFiles: ['app/a.ts', 'lib/b.ts', 'server/c.ts'],
      numstat: [
        { path: 'app/a.ts', added: 1, deleted: 0 },
        { path: 'lib/b.ts', added: 1, deleted: 0 },
        { path: 'server/c.ts', added: 1, deleted: 0 },
      ],
    })],
  ])('triggers for %s', (_name, input) => {
    expect(assessDeepReviewRisk(input, policy, () => 10).required).toBe(true);
  });

  it('uses large file size as a trigger, not a finding', () => {
    const result = assessDeepReviewRisk(bundle({
      changedFiles: ['src/huge.ts'],
      numstat: [{ path: 'src/huge.ts', added: 1, deleted: 0 }],
    }), policy, () => 1001);
    expect(result.required).toBe(true);
    expect(result.reasons.join(' ')).toContain('1001');
  });
});
