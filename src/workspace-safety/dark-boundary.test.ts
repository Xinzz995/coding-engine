import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const SOURCE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

function productionSources(root: string): string[] {
  const files: string[] = [];
  const walk = (directory: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const fromRoot = relative(root, path).replaceAll('\\', '/');
      if (entry.isDirectory()) {
        if (fromRoot === 'workspace-safety') continue;
        walk(path);
      } else if (entry.isFile() && entry.name.endsWith('.ts') && !entry.name.endsWith('.test.ts')) {
        files.push(path);
      }
    }
  };
  walk(root);
  return files.sort();
}

describe('workspace safety dark boundary', () => {
  it('is not imported by any production source before the atomic activation PR', () => {
    const violations = productionSources(SOURCE_ROOT)
      .filter((path) =>
        /(?:from\s+|import\s*\()['"][^'"]*workspace-safety\//u.test(readFileSync(path, 'utf8')),
      )
      .map((path) => relative(SOURCE_ROOT, path).replaceAll('\\', '/'));

    expect(violations).toEqual([]);
  });
});
