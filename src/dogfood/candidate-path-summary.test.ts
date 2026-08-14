import { describe, expect, it } from 'vitest';
import { summarizeTopLevelPaths } from './__fixtures__/candidate-path-summary.js';

describe('summarizeTopLevelPaths', () => {
  it('returns an empty summary for an empty input', () => {
    expect([...summarizeTopLevelPaths([])]).toEqual([]);
  });

  it('normalizes, deduplicates, groups, and preserves first-seen order', () => {
    const input = [
      './src\\dogfood\\first.ts',
      '.\\src/dogfood/second.ts',
      './README.md',
      'src/dogfood/first.ts',
      './docs\\guide.md',
      './package.json',
      '././src\\dogfood\\third.ts',
      '   ',
      'docs/guide.md',
    ];
    const originalInput = [...input];

    const summary = summarizeTopLevelPaths(input);

    expect([...summary]).toEqual([
      ['src', ['src/dogfood/first.ts', 'src/dogfood/second.ts', 'src/dogfood/third.ts']],
      ['.', ['README.md', 'package.json']],
      ['docs', ['docs/guide.md']],
    ]);
    expect(input).toEqual(originalInput);
  });

  it('does not reuse a mutable input array in its result', () => {
    const input = ['README.md'];

    const summary = summarizeTopLevelPaths(input);

    expect(summary.get('.')).not.toBe(input);
    input.push('LICENSE');
    expect(summary.get('.')).toEqual(['README.md']);
  });
});
