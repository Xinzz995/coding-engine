import { describe, it, expect } from 'vitest';
import { readProgress, extractLastStoryId } from './progress.js';

describe('readProgress', () => {
  it('returns empty string for a missing file', () => {
    expect(readProgress('/no/such/progress.md')).toBe('');
  });
});

describe('extractLastStoryId', () => {
  it('returns the story id from the last "## " section', () => {
    const text = [
      '## Codebase Patterns',
      '- foo',
      '## 2026-06-30 10:00 - US-001',
      '- did things',
      '## 2026-06-30 11:00 - US-002',
      '- more things',
    ].join('\n');
    expect(extractLastStoryId(text)).toBe('US-002');
  });
  it('returns null when no story id present', () => {
    expect(extractLastStoryId('## Codebase Patterns\n- foo')).toBeNull();
  });
});
