import { describe, expect, it } from 'vitest';
import { summarizeTopLevelPaths } from './__fixtures__/candidate-path-summary.js';

describe('summarizeTopLevelPaths', () => {
  it('returns an empty summary for empty or blank input', () => {
    expect(summarizeTopLevelPaths([])).toEqual([]);
    expect(summarizeTopLevelPaths(['', '  ', '\t', '././'])).toEqual([]);
  });

  it('normalizes and uniquely groups mixed paths in first-seen order', () => {
    expect(
      summarizeTopLevelPaths([
        '.\\src\\index.ts',
        '  README.md  ',
        './docs\\guide.md',
        '././src/index.ts',
        'LICENSE',
        'src\\engine\\loop.ts',
        './docs/guide.md',
        'docs\\reference.md',
      ]),
    ).toEqual([
      {
        topLevel: 'src',
        paths: ['src/index.ts', 'src/engine/loop.ts'],
      },
      {
        topLevel: '.',
        paths: ['README.md', 'LICENSE'],
      },
      {
        topLevel: 'docs',
        paths: ['docs/guide.md', 'docs/reference.md'],
      },
    ]);
  });

  it('does not modify or reuse the caller array', () => {
    const input = ['./src/first.ts', 'src\\second.ts', 'package.json'];
    const original = [...input];

    const summary = summarizeTopLevelPaths(input);

    expect(input).toEqual(original);
    expect(summary).not.toBe(input);
    expect(summary).toEqual([
      {
        topLevel: 'src',
        paths: ['src/first.ts', 'src/second.ts'],
      },
      {
        topLevel: '.',
        paths: ['package.json'],
      },
    ]);
  });
});
