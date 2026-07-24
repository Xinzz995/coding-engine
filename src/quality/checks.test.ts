import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { checkAppliesToChanges, runProjectChecks } from './checks.js';
import type { QualityCheck } from './types.js';

function check(command: string, cwd = '.'): QualityCheck {
  return { id: 'test', command, cwd, paths: ['src/'] };
}

describe('project quality checks', () => {
  it('matches exact files, directories and the all-path selector', () => {
    expect(checkAppliesToChanges(
      { id: 'a', command: 'true', cwd: '.', paths: ['packages/a/'] },
      ['packages/a/src/main.py'],
    )).toBe(true);
    expect(checkAppliesToChanges(
      { id: 'b', command: 'true', cwd: '.', paths: ['packages/b'] },
      ['packages/a/src/main.py'],
    )).toBe(false);
    expect(checkAppliesToChanges(
      { id: 'all', command: 'true', cwd: '.', paths: ['.'] },
      ['docs/readme.md'],
    )).toBe(true);
  });

  it('records a non-applicable check as an explicit passed result without executing it', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-checks-'));
    const result = await runProjectChecks([
      { id: 'other-module', command: 'exit 19', cwd: '.', paths: ['packages/b/'] },
    ], root, 5_000, ['packages/a/main.py']);
    expect(result.status).toBe('passed');
    expect(result.results[0]).toMatchObject({
      applicable: false,
      status: 'passed',
      exitCode: null,
    });
  });

  it('passes arbitrary non-Node project commands', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-check-pass-'));
    mkdirSync(join(root, 'src'));
    const result = await runProjectChecks([check(`${process.execPath} -e "process.exit(0)"`)], root);
    expect(result.status).toBe('passed');
    expect(result.results[0]).toMatchObject({ id: 'test', status: 'passed', exitCode: 0 });
  });

  it('fails on a nonzero command and stops before later checks', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-check-fail-'));
    mkdirSync(join(root, 'src'));
    const result = await runProjectChecks([
      check(`${process.execPath} -e "console.error('bad'); process.exit(7)"`),
      { ...check(`${process.execPath} -e "process.exit(0)"`), id: 'later' },
    ], root);
    expect(result.status).toBe('failed');
    expect(result.results).toHaveLength(1);
    expect(result.results[0]).toMatchObject({ status: 'failed', exitCode: 7 });
  });

  it('reports a missing working directory as unverifiable without spawning', async () => {
    const root = mkdtempSync(join(tmpdir(), 'quality-check-cwd-'));
    const result = await runProjectChecks([check('true', 'missing')], root);
    expect(result.status).toBe('unverifiable');
    expect(result.results[0].errorCode).toBe('check-cwd-missing');
  });
});
