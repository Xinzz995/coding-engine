import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repairJsonString, repairJsonFile, repairWorkspaceFiles } from './repair.js';

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

describe('repairJsonFile', () => {
  it('rewrites the file in place', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, '{ "userStories": [], }');
    repairJsonFile(file);
    expect(JSON.parse(readFileSync(file, 'utf-8'))).toEqual({ userStories: [] });
    rmSync(dir, { recursive: true, force: true });
  });

  it('落盘走 rename 语义（inode 必变）：中途被杀不留半截目标文件', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, '{ "userStories": [], }');
    const inoBefore = statSync(file).ino;
    repairJsonFile(file);
    // 覆盖写保留 inode；tmp+rename 替换必换 inode——rename 语义的可观测面
    expect(statSync(file).ino).not.toBe(inoBefore);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('repairWorkspaceFiles', () => {
  it('repairs prd.json and state.json when both exist', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-ws-'));
    writeFileSync(join(dir, 'prd.json'), '{ "userStories": [], }');
    writeFileSync(join(dir, 'state.json'), '{ "US-001": { "passes": true, }, }');
    const repaired = repairWorkspaceFiles(dir);
    expect(repaired).toEqual(['prd.json', 'state.json']);
    expect(JSON.parse(readFileSync(join(dir, 'prd.json'), 'utf-8'))).toEqual({ userStories: [] });
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))).toEqual({ 'US-001': { passes: true } });
    rmSync(dir, { recursive: true, force: true });
  });
  it('skips state.json when absent', () => {
    const dir = mkdtempSync(join(tmpdir(), 'repair-ws-'));
    writeFileSync(join(dir, 'prd.json'), '{ "userStories": [], }');
    expect(repairWorkspaceFiles(dir)).toEqual(['prd.json']);
    rmSync(dir, { recursive: true, force: true });
  });
});
