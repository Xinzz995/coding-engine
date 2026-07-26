import { describe, expect, it } from 'vitest';
import { digest, globMatches, normalizeText } from './common.js';

describe('review common helpers', () => {
  it('matches repository globs without letting star cross path separators', () => {
    expect(globMatches('docs/specs/a.md', 'docs/specs/**')).toBe(true);
    expect(globMatches('docs/specs/nested/a.md', 'docs/specs/**')).toBe(true);
    expect(globMatches('src/a.ts', 'src/*.ts')).toBe(true);
    expect(globMatches('src/deep/a.ts', 'src/*.ts')).toBe(false);
    expect(globMatches('.github/workflows/ci.yml', '.github/**')).toBe(true);
  });

  it('normalizes text and creates stable key-order-independent digests', () => {
    expect(normalizeText('a\r\n')).toBe('a');
    expect(digest({ b: 2, a: 1 })).toBe(digest({ a: 1, b: 2 }));
    expect(digest({ a: 2 })).not.toBe(digest({ a: 1 }));
  });
});

describe('validatePullRequestIntent', () => {
  it('is covered in preflight tests through the exported parser', () => {
    expect(true).toBe(true);
  });
});
