import { describe, it, expect } from 'vitest';
import { readProgress } from './progress.js';

describe('readProgress', () => {
  it('returns empty string for a missing file', () => {
    expect(readProgress('/no/such/progress.md')).toBe('');
  });
});
