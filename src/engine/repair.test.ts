import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repairJsonString, repairPrdFile } from './repair.js';

describe('repairJsonString', () => {
  it('fixes trailing commas and returns valid JSON', () => {
    const out = repairJsonString('{ "a": 1, "b": [1, 2,], }');
    expect(JSON.parse(out)).toEqual({ a: 1, b: [1, 2] });
  });
  it('preserves non-ASCII characters unescaped', () => {
    const out = repairJsonString('{ "project": "任务应用" }');
    expect(out).toContain('任务应用');
  });
});

describe('repairPrdFile', () => {
  it('rewrites the file in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, '{ "userStories": [], }');
    repairPrdFile(file);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ userStories: [] });
    rmSync(dir, { recursive: true, force: true });
  });
});
