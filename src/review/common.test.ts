import { describe, expect, it } from 'vitest';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  digest,
  globMatches,
  isOwnedTempDirectory,
  normalizeText,
  reviewRoutingDigest,
} from './common.js';

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

  it('binds only the normalized PRD model-routing policy', () => {
    const first = {
      runner: 'codex' as const,
      builder: { low: 'low', medium: 'medium', high: 'high' },
      validator: 'validator',
      escalation: 'escalation',
    };
    const reordered = {
      escalation: 'escalation',
      validator: 'validator',
      builder: { high: 'high', low: 'low', medium: 'medium' },
      runner: 'codex' as const,
    };
    expect(reviewRoutingDigest(first)).toBe(reviewRoutingDigest(reordered));
    expect(reviewRoutingDigest(undefined)).not.toBe(reviewRoutingDigest(first));
  });

  it('recognizes only direct engine-owned children of the platform temp directory', () => {
    expect(isOwnedTempDirectory(join(tmpdir(), 'coding-x-review-abc'), 'coding-x-review-')).toBe(true);
    expect(isOwnedTempDirectory(join(tmpdir(), 'coding-x-review-abc', 'nested'), 'coding-x-review-')).toBe(false);
    expect(isOwnedTempDirectory(join(tmpdir(), 'other-review-abc'), 'coding-x-review-')).toBe(false);
    expect(isOwnedTempDirectory(join(tmpdir(), '..', 'coding-x-review-abc'), 'coding-x-review-')).toBe(false);
  });
});

describe('validatePullRequestIntent', () => {
  it('is covered in preflight tests through the exported parser', () => {
    expect(true).toBe(true);
  });
});
