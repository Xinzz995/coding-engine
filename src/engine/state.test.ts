import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  tryReadState, initialStateFor, blankStateFor, ensureStateFile, mergedStories,
  getCurrentStoryId, allStoriesResolved, INITIAL_STORY_STATE, restoreEscalated,
  enableEscalation, isStoryPassed, restoreValidated, issueValidationReceipt,
  rollbackUnvalidatedPasses, tryReadEngineOwnedFields, type RunState,
} from './state.js';
import type { Prd } from './prd.js';

// 用「纯内容 + 可选旧状态字段」的字面量造 PRD 并 cast：
// Task 4 之前 Story 类型仍含状态字段（必填），cast 让本测试在 Story 瘦身前后都成立。
function contentPrd(
  ids: string[],
  legacy: Record<string, Partial<{ passes: boolean; notes: string; retryCount: number; blocked: boolean }>> = {},
): Prd {
  return {
    project: 'p', branchName: 'ralph/x', description: 'd',
    userStories: ids.map((id, i) => ({
      id, title: 't', description: 'd', acceptanceCriteria: [], priority: i + 1,
      ...(legacy[id] ?? {}),
    })),
  } as Prd;
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'state-'));
}

describe('tryReadState', () => {
  it('returns null for missing or invalid file', () => {
    expect(tryReadState('/no/such/state.json')).toBeNull();
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{ broken');
    expect(tryReadState(join(dir, 'state.json'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it('parses a valid file', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ 'US-001': { passes: true, notes: 'n', retryCount: 2, blocked: false } }));
    expect(tryReadState(file)?.['US-001'].retryCount).toBe(2);
    expect(tryReadState(file)?.['US-001'].escalated).toBe(false);
    expect(tryReadState(file)?.['US-001'].validated).toBe(true); // 旧 passed state 兼容为已验收
    rmSync(dir, { recursive: true, force: true });
  });
  it('does not let a receipt outlive its passing candidate state', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({
      'US-001': { passes: false, validated: true, notes: '', retryCount: 0, blocked: false },
    }));
    expect(tryReadState(file)?.['US-001'].validated).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  it('reads engine-owned fields without hiding missing legacy values', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({
      'US-001': { passes: false, notes: '', retryCount: 0, blocked: false },
    }));
    expect(tryReadEngineOwnedFields(file, 'US-001')).toEqual({
      validated: 'missing', escalated: 'missing',
    });
    writeFileSync(file, JSON.stringify({
      'US-001': {
        passes: false, validated: false, notes: '', retryCount: 0, blocked: false, escalated: true,
      },
    }));
    expect(tryReadEngineOwnedFields(file, 'US-001')).toEqual({
      validated: false, escalated: true,
    });
    expect(tryReadEngineOwnedFields(file, 'US-404')).toEqual({
      validated: 'missing', escalated: 'missing',
    });
    rmSync(dir, { recursive: true, force: true });
  });
  it('rejects structurally invalid state (valid JSON, wrong shape)', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(file, JSON.stringify({ 'US-001': true }));
    expect(tryReadState(file)).toBeNull();
    writeFileSync(file, JSON.stringify(['US-001']));
    expect(tryReadState(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ 'US-001': { passes: 'yes', notes: '', retryCount: 0, blocked: false } }));
    expect(tryReadState(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ 'US-001': { passes: false, notes: '', retryCount: 0, blocked: false, escalated: 'yes' } }));
    expect(tryReadState(file)).toBeNull();
    writeFileSync(file, JSON.stringify({ 'US-001': { passes: false, validated: 'yes', notes: '', retryCount: 0, blocked: false } }));
    expect(tryReadState(file)).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('initialStateFor', () => {
  it('gives every story the initial state', () => {
    const s = initialStateFor(contentPrd(['US-001', 'US-002']));
    expect(s['US-001']).toEqual(INITIAL_STORY_STATE);
    expect(s['US-002']).toEqual(INITIAL_STORY_STATE);
  });
  it('extracts legacy state fields from v0.4-style stories (migration)', () => {
    const s = initialStateFor(contentPrd(['US-001'], { 'US-001': { passes: true, notes: 'x', retryCount: 3, blocked: true } }));
    expect(s['US-001']).toEqual({ passes: true, validated: false, notes: 'x', retryCount: 3, blocked: true, escalated: false });
  });
});

describe('blankStateFor', () => {
  it('ignores legacy in-story fields (runtime fallback must not resurrect stale state)', () => {
    const s = blankStateFor(contentPrd(['US-001'], { 'US-001': { passes: true, blocked: true } }));
    expect(s['US-001']).toEqual(INITIAL_STORY_STATE);
  });
});

describe('ensureStateFile', () => {
  it('creates state.json from the prd when missing', () => {
    const dir = tempDir();
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001'].passes).toBe(false);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))['US-001'].passes).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });
  it('returns the existing file untouched when present', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), JSON.stringify({ 'US-001': { passes: true, notes: '', retryCount: 0, blocked: false } }));
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001'].passes).toBe(true); // 不被初始值覆盖
    expect(state['US-001'].escalated).toBe(false); // 旧 state 在内存兼容归一
    expect(state['US-001'].validated).toBe(true); // 旧 passed state 保持已完成
    expect(readFileSync(join(dir, 'state.json'), 'utf-8')).not.toContain('escalated'); // 读取不触发迁移写
    expect(readFileSync(join(dir, 'state.json'), 'utf-8')).not.toContain('validated');
    rmSync(dir, { recursive: true, force: true });
  });
  it('does not overwrite a corrupted state.json (leave it to repair)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{ broken');
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001']).toEqual(INITIAL_STORY_STATE);            // 内存回退
    expect(readFileSync(join(dir, 'state.json'), 'utf-8')).toBe('{ broken'); // 文件原样
    rmSync(dir, { recursive: true, force: true });
  });
  it('ensureStateFile leaves no atomic-write tmp residue', () => {
    const dir = tempDir();
    ensureStateFile(dir, contentPrd(['US-001']));
    expect(readdirSync(dir).filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
    expect(existsSync(join(dir, 'state.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('getCurrentStoryId / allStoriesResolved', () => {
  const prd = contentPrd(['US-001', 'US-002', 'US-003']);
  it('picks the first story that is neither passing nor blocked', () => {
    const state: RunState = {
      'US-001': { passes: true, validated: true, notes: '', retryCount: 0, blocked: false, escalated: false },
      'US-002': { passes: false, validated: false, notes: '', retryCount: 5, blocked: true, escalated: false },
    };
    // US-003 不在 state 中 → 按初始状态可选
    expect(getCurrentStoryId(prd, state)).toBe('US-003');
    expect(allStoriesResolved(prd, state)).toBe(false);
  });
  it('resolves when every story passes or is blocked', () => {
    const state: RunState = {
      'US-001': { passes: true, validated: true, notes: '', retryCount: 0, blocked: false, escalated: false },
      'US-002': { passes: false, validated: false, notes: '', retryCount: 5, blocked: true, escalated: false },
      'US-003': { passes: true, validated: true, notes: '', retryCount: 0, blocked: false, escalated: false },
    };
    expect(getCurrentStoryId(prd, state)).toBeNull();
    expect(allStoriesResolved(prd, state)).toBe(true);
  });
});

describe('mergedStories', () => {
  it('overlays state onto content when state is present', () => {
    const state: RunState = { 'US-001': { passes: true, validated: true, notes: 'ok', retryCount: 1, blocked: false, escalated: false } };
    const view = mergedStories(contentPrd(['US-001', 'US-002']), state);
    expect(view[0].passes).toBe(true);
    expect(view[0].notes).toBe('ok');
    expect(view[1].passes).toBe(false); // 缺失 id → 初始
  });
  it('falls back to legacy story fields when state is null (v0.4 离线回看)', () => {
    const view = mergedStories(contentPrd(['US-001'], { 'US-001': { passes: true } }), null);
    expect(view[0].passes).toBe(true);
  });
});

describe('escalated engine ownership', () => {
  const base = (): RunState => ({
    'US-001': { passes: false, validated: false, notes: '', retryCount: 2, blocked: false, escalated: false },
  });

  it('restores both unauthorized enable and downgrade attempts', () => {
    const enabled = base();
    enabled['US-001'].escalated = true;
    const down = restoreEscalated(enabled, 'US-001', false);
    expect(down.state['US-001'].escalated).toBe(false);
    expect(down.tamper).toEqual({ expected: false, received: true });

    const disabled = base();
    const up = restoreEscalated(disabled, 'US-001', true);
    expect(up.state['US-001'].escalated).toBe(true);
    expect(up.tamper).toEqual({ expected: true, received: false });
  });

  it('restores the whole engine-owned story when an agent deletes it', () => {
    const expected = base()['US-001'];
    expected.escalated = true;
    expected.notes = 'keep';
    const restored = restoreEscalated({}, 'US-001', true, expected);
    expect(restored.state['US-001']).toEqual(expected);
    expect(restored.tamper).toEqual({ expected: true, received: 'missing' });
  });

  it('enables only with a dedicated target and never changes retryCount', () => {
    const without = enableEscalation(base(), 'US-001', false);
    expect(without.changed).toBe(false);
    const withTarget = enableEscalation(base(), 'US-001', true);
    expect(withTarget.changed).toBe(true);
    expect(withTarget.state['US-001']).toMatchObject({ escalated: true, retryCount: 2 });
    expect(enableEscalation(withTarget.state, 'US-001', true).changed).toBe(false);
  });
});

describe('validated engine ownership', () => {
  const base = (): RunState => ({
    'US-001': { passes: true, validated: false, notes: '', retryCount: 1, blocked: false, escalated: false },
  });

  it('requires both the builder claim and engine receipt for an effective pass', () => {
    expect(isStoryPassed(base()['US-001'])).toBe(false);
    expect(isStoryPassed({ ...base()['US-001'], validated: true })).toBe(true);
    expect(isStoryPassed({ ...base()['US-001'], validated: true, blocked: true })).toBe(false);
  });

  it('restores agent attempts to forge or remove the receipt', () => {
    const forged = base();
    forged['US-001'].validated = true;
    const restored = restoreValidated(forged, 'US-001', false);
    expect(restored.state['US-001'].validated).toBe(false);
    expect(restored.tamper).toEqual({ expected: false, received: true });

    const missing = restoreValidated({}, 'US-001', false, base()['US-001']);
    expect(missing.state['US-001']).toEqual(base()['US-001']);
    expect(missing.tamper).toEqual({ expected: false, received: 'missing' });

    const fieldOnly = restoreValidated(base(), 'US-001', false, undefined, 'missing');
    expect(fieldOnly.state['US-001'].validated).toBe(false);
    expect(fieldOnly.tamper).toEqual({ expected: false, received: 'missing' });
  });

  it('issues only for a passing non-blocked story and is idempotent', () => {
    const issued = issueValidationReceipt(base(), 'US-001');
    expect(issued.changed).toBe(true);
    expect(issued.state['US-001'].validated).toBe(true);
    expect(issueValidationReceipt(issued.state, 'US-001').changed).toBe(false);
    expect(issueValidationReceipt({
      'US-001': { ...base()['US-001'], passes: false },
    }, 'US-001').changed).toBe(false);
    expect(issueValidationReceipt({
      'US-001': { ...base()['US-001'], blocked: true },
    }, 'US-001').changed).toBe(false);
  });

  it('rolls explicit unvalidated passes back at startup but preserves receipts and blocked', () => {
    const rolled = rollbackUnvalidatedPasses({
      'US-001': base()['US-001'],
      'US-002': { ...base()['US-001'], validated: true },
      'US-003': { ...base()['US-001'], blocked: true },
    });
    expect(rolled.storyIds).toEqual(['US-001']);
    expect(rolled.state['US-001']).toMatchObject({ passes: false, validated: false, retryCount: 1 });
    expect(rolled.state['US-002'].passes).toBe(true);
    expect(rolled.state['US-003'].passes).toBe(true);
  });

  it('keeps an unvalidated pass current and unresolved', () => {
    const prd = contentPrd(['US-001']);
    expect(getCurrentStoryId(prd, base())).toBe('US-001');
    expect(allStoriesResolved(prd, base())).toBe(false);
  });
});
