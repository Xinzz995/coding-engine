import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { collectAddedCodeFiles, isCodeFile, runFormatGate } from './check-format.mjs';

const roots = [];

function git(root, ...args) {
  execFileSync('git', args, { cwd: root, stdio: 'ignore' });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'format-gate-'));
  roots.push(root);
  git(root, 'init');
  git(root, 'config', 'user.email', 'format@example.test');
  git(root, 'config', 'user.name', 'Format Test');
  writeFileSync(join(root, 'legacy.ts'), 'export const legacy={value:1}\n');
  git(root, 'add', 'legacy.ts');
  git(root, 'commit', '-m', 'baseline');
  return root;
}

afterEach(() => {
  while (roots.length > 0) rmSync(roots.pop(), { recursive: true, force: true });
});

describe('incremental format gate', () => {
  it('checks only added code files with Prettier while checking whitespace in every diff', async () => {
    const root = fixture();
    writeFileSync(join(root, 'new.ts'), 'export const value = 1;\n');
    expect(collectAddedCodeFiles(root, 'HEAD')).toEqual(['new.ts']);
    expect(await runFormatGate({ root, base: 'HEAD', write: false })).toMatchObject({
      unformatted: [],
      whitespaceIssues: [],
    });

    writeFileSync(join(root, 'new.ts'), 'export const value={answer:42}\n');
    expect((await runFormatGate({ root, base: 'HEAD', write: false })).unformatted).toEqual([
      'new.ts',
    ]);

    writeFileSync(join(root, 'legacy.ts'), 'export const legacy = 1;  \n');
    expect(
      (await runFormatGate({ root, base: 'HEAD', write: false })).whitespaceIssues.join('\n'),
    ).toContain('trailing whitespace');
  });

  it('recognizes code extensions without treating generated data as source code', () => {
    expect(isCodeFile('src/main.ts')).toBe(true);
    expect(isCodeFile('build/check.mjs')).toBe(true);
    expect(isCodeFile('package.json')).toBe(false);
  });
});
