import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { tryReadPrd, getCurrentStoryId, allStoriesResolved, type Prd } from './prd.js';

function makePrd(stories: Array<Partial<Prd['userStories'][number]>>): Prd {
  return {
    project: 'p', branchName: 'ralph/x', description: 'd',
    userStories: stories.map((s, i) => ({
      id: s.id ?? `US-00${i + 1}`, title: 't', description: 'd',
      acceptanceCriteria: [], priority: s.priority ?? i + 1,
      passes: s.passes ?? false, notes: '', retryCount: 0, blocked: s.blocked ?? false,
    })),
  };
}

describe('getCurrentStoryId', () => {
  it('returns first not-passing, not-blocked story', () => {
    const prd = makePrd([{ passes: true }, { id: 'US-099', passes: false, blocked: false }]);
    expect(getCurrentStoryId(prd)).toBe('US-099');
  });
  it('skips blocked stories', () => {
    const prd = makePrd([{ passes: false, blocked: true }, { id: 'US-077' }]);
    expect(getCurrentStoryId(prd)).toBe('US-077');
  });
  it('returns null when all resolved', () => {
    const prd = makePrd([{ passes: true }, { blocked: true }]);
    expect(getCurrentStoryId(prd)).toBeNull();
  });
});

describe('allStoriesResolved', () => {
  it('true when every story passes or blocked', () => {
    expect(allStoriesResolved(makePrd([{ passes: true }, { blocked: true }]))).toBe(true);
  });
  it('false when one is open', () => {
    expect(allStoriesResolved(makePrd([{ passes: true }, { passes: false }]))).toBe(false);
  });
});

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
