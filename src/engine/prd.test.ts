import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryReadPrd, validatePrdStorySet, type Prd } from './prd.js';

function makePrd(stories: Array<Partial<Prd['userStories'][number]>>): Prd {
  return {
    project: 'p', branchName: 'ralph/x', description: 'd',
    userStories: stories.map((s, i) => ({
      id: s.id ?? `US-00${i + 1}`, title: 't', description: 'd',
      acceptanceCriteria: [], priority: s.priority ?? i + 1,
    })),
  };
}

describe('tryReadPrd', () => {
  it('returns null for missing/invalid file', () => {
    expect(tryReadPrd('/no/such/file.json')).toBeNull();
  });
  it('parses a valid file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, JSON.stringify(makePrd([{ id: 'US-001' }])));
    expect(tryReadPrd(file)?.userStories[0].id).toBe('US-001');
    rmSync(dir, { recursive: true, force: true });
  });
  it('preserves sourcePrd when present', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prd-'));
    const file = join(dir, 'prd.json');
    writeFileSync(file, JSON.stringify({ ...makePrd([{ id: 'US-001' }]), sourcePrd: 'docs/prds/prd-x.md' }));
    expect(tryReadPrd(file)?.sourcePrd).toBe('docs/prds/prd-x.md');
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('validatePrdStorySet', () => {
  it('rejects an empty Story set', () => {
    expect(validatePrdStorySet(makePrd([]))).toEqual({
      valid: false,
      message: 'prd.json 必须包含至少一个 Story',
    });
  });

  it('rejects duplicate Story IDs case-insensitively', () => {
    expect(validatePrdStorySet(makePrd([{ id: 'US-001' }, { id: 'us-001' }]))).toEqual({
      valid: false,
      message: 'userStories 包含重复 Story ID：us-001',
    });
  });

  it('accepts a non-empty set of unique Story IDs', () => {
    expect(validatePrdStorySet(makePrd([{ id: 'US-001' }, { id: 'US-002' }]))).toEqual({
      valid: true,
    });
  });
});
