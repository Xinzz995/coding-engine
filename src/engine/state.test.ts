import { describe, it, expect } from 'vitest';
import {
  mkdtempSync,
  writeFileSync,
  readFileSync,
  rmSync,
  readdirSync,
  existsSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  tryReadState,
  initialStateFor,
  blankStateFor,
  ensureStateFile,
  mergedStories,
  getCurrentStoryId,
  allStoriesResolved,
  INITIAL_STORY_STATE,
  restoreEscalated,
  enableEscalation,
  isStoryPassed,
  restoreValidationOwnership,
  validationOwnedFieldsOf,
  issueValidationReceipt,
  revokeValidationReceipt,
  tryReadEngineOwnedFields,
  evaluateValidationReceipt,
  reconcileValidationReceipts,
  validationReceiptsDigest,
  isValidationReceipt,
  type RunState,
  type StoryState,
  type ValidationReceipt,
} from './state.js';
import { acceptanceHash } from './validation-protocol.js';
import type { Prd } from './prd.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

// 用「纯内容 + 可选旧状态字段」的字面量造 PRD 并 cast：旧 workspace 的 story 曾内嵌状态字段。
function contentPrd(
  ids: string[],
  legacy: Record<
    string,
    Partial<{
      passes: boolean;
      notes: string;
      retryCount: number;
      blocked: boolean;
    }>
  > = {},
  criteria: Record<string, string[]> = {},
): Prd {
  return {
    project: 'p',
    branchName: 'ralph/x',
    description: 'd',
    userStories: ids.map((id, i) => ({
      id,
      title: 't',
      description: 'd',
      acceptanceCriteria: criteria[id] ?? [],
      priority: i + 1,
      ...(legacy[id] ?? {}),
    })),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'state-'));
}

function receipt(
  storyId = 'US-001',
  criteria: readonly string[] = [],
  gitHead = HEAD_A,
  requestId = `request-${storyId}`,
): ValidationReceipt {
  return {
    schemaVersion: 1,
    requestId,
    gitHead,
    acceptanceHash: acceptanceHash(storyId, criteria),
  };
}

function storyState(overrides: Partial<StoryState> = {}): StoryState {
  return { ...INITIAL_STORY_STATE, ...overrides };
}

function passedState(
  storyId = 'US-001',
  criteria: readonly string[] = [],
  gitHead = HEAD_A,
  requestId?: string,
): StoryState {
  return storyState({
    passes: true,
    validated: true,
    validationReceipt: receipt(storyId, criteria, gitHead, requestId),
  });
}

describe('tryReadState', () => {
  it('returns null for missing or invalid file', () => {
    expect(tryReadState('/no/such/state.json')).toBeNull();
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{ broken');
    expect(tryReadState(join(dir, 'state.json'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it.skipIf(process.platform === 'win32')('never follows a state.json symlink', () => {
    const dir = tempDir();
    const outside = join(dir, 'outside.json');
    const file = join(dir, 'state.json');
    writeFileSync(outside, JSON.stringify({ 'US-001': passedState() }));
    symlinkSync(outside, file);
    expect(tryReadState(file)).toBeNull();
    expect(tryReadEngineOwnedFields(file, 'US-001')).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads legacy state but never mints a receipt or current pass', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': { passes: true, notes: 'n', retryCount: 2, blocked: false },
      }),
    );
    expect(tryReadState(file)?.['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
      escalated: false,
      retryCount: 2,
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('retains a historical validated flag only so reconciliation can explicitly revoke it', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          notes: '',
          retryCount: 0,
          blocked: false,
        },
      }),
    );
    const parsed = tryReadState(file)?.['US-001'];
    expect(parsed).toMatchObject({ validated: true, validationReceipt: null });
    expect(parsed && isStoryPassed(parsed)).toBe(false);
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves an exact valid receipt', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    const expected = passedState();
    writeFileSync(file, JSON.stringify({ 'US-001': expected }));
    expect(tryReadState(file)?.['US-001']).toEqual(expected);
    rmSync(dir, { recursive: true, force: true });
  });

  it('preserves known fields for reconciliation but never treats an incoherent pair as passed', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    for (const overrides of [{ passes: false }, { validated: false }, { blocked: true }]) {
      writeFileSync(file, JSON.stringify({ 'US-001': { ...passedState(), ...overrides } }));
      const parsed = tryReadState(file)?.['US-001'];
      expect(parsed?.validationReceipt).toEqual(receipt());
      expect(parsed && isStoryPassed(parsed)).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects malformed, incomplete, or extended receipt objects', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    const malformed = [
      { ...receipt(), schemaVersion: 2 },
      { ...receipt(), requestId: '' },
      { ...receipt(), gitHead: null },
      { ...receipt(), acceptanceHash: 'sha256:bad' },
      { ...receipt(), extra: true },
    ];
    for (const validationReceipt of malformed) {
      writeFileSync(
        file,
        JSON.stringify({
          'US-001': { ...passedState(), validationReceipt },
        }),
      );
      expect(tryReadState(file)).toBeNull();
      expect(isValidationReceipt(validationReceipt)).toBe(false);
    }
    rmSync(dir, { recursive: true, force: true });
  });

  it('reads all engine-owned fields without hiding missing legacy values', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': { passes: false, notes: '', retryCount: 0, blocked: false },
      }),
    );
    expect(tryReadEngineOwnedFields(file, 'US-001')).toEqual({
      validated: 'missing',
      validationReceipt: 'missing',
      escalated: 'missing',
    });
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': {
          ...passedState(),
          escalated: true,
        },
      }),
    );
    expect(tryReadEngineOwnedFields(file, 'US-001')).toEqual({
      validated: true,
      validationReceipt: receipt(),
      escalated: true,
    });
    expect(tryReadEngineOwnedFields(file, 'US-404')).toEqual({
      validated: 'missing',
      validationReceipt: 'missing',
      escalated: 'missing',
    });
    rmSync(dir, { recursive: true, force: true });
  });

  it('rejects structurally invalid state', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    const invalid = [
      { 'US-001': true },
      ['US-001'],
      { 'US-001': { passes: 'yes', notes: '', retryCount: 0, blocked: false } },
      {
        'US-001': {
          passes: false,
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: 'yes',
        },
      },
      {
        'US-001': {
          passes: false,
          validated: 'yes',
          notes: '',
          retryCount: 0,
          blocked: false,
        },
      },
    ];
    for (const value of invalid) {
      writeFileSync(file, JSON.stringify(value));
      expect(tryReadState(file)).toBeNull();
    }
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('initial and display-compatible state', () => {
  it('gives every new story the complete initial state', () => {
    const state = initialStateFor(contentPrd(['US-001', 'US-002']));
    expect(state['US-001']).toEqual(INITIAL_STORY_STATE);
    expect(state['US-002']).toEqual(INITIAL_STORY_STATE);
  });

  it('extracts legacy fields as an unverified candidate, never as a receipt', () => {
    const state = initialStateFor(
      contentPrd(['US-001'], {
        'US-001': { passes: true, notes: 'x', retryCount: 3, blocked: false },
      }),
    );
    expect(state['US-001']).toEqual({
      passes: true,
      validated: false,
      validationReceipt: null,
      notes: 'x',
      retryCount: 3,
      blocked: false,
      escalated: false,
    });
  });

  it('clears legacy validation state for a blocked story', () => {
    const state = initialStateFor(
      contentPrd(['US-001'], {
        'US-001': { passes: true, blocked: true },
      }),
    );
    expect(state['US-001']).toEqual({
      passes: true,
      validated: false,
      validationReceipt: null,
      notes: '',
      retryCount: 0,
      blocked: true,
      escalated: false,
    });
  });

  it('blank state ignores legacy in-story fields', () => {
    const state = blankStateFor(
      contentPrd(['US-001'], {
        'US-001': { passes: true, blocked: true },
      }),
    );
    expect(state['US-001']).toEqual(INITIAL_STORY_STATE);
  });
});

describe('ensureStateFile', () => {
  it('creates state.json from the prd when missing', () => {
    const dir = tempDir();
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001']).toEqual(INITIAL_STORY_STATE);
    expect(JSON.parse(readFileSync(join(dir, 'state.json'), 'utf-8'))['US-001']).toEqual(
      INITIAL_STORY_STATE,
    );
    rmSync(dir, { recursive: true, force: true });
  });

  it('returns a legacy file untouched while exposing it as unverified in memory', () => {
    const dir = tempDir();
    const path = join(dir, 'state.json');
    writeFileSync(
      path,
      JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }),
    );
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
      escalated: false,
    });
    expect(readFileSync(path, 'utf-8')).not.toContain('validated');
    expect(readFileSync(path, 'utf-8')).not.toContain('validationReceipt');
    rmSync(dir, { recursive: true, force: true });
  });

  it('does not overwrite a corrupted state.json', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{ broken');
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001']).toEqual(INITIAL_STORY_STATE);
    expect(readFileSync(join(dir, 'state.json'), 'utf-8')).toBe('{ broken');
    rmSync(dir, { recursive: true, force: true });
  });

  it('leaves no atomic-write temporary residue', () => {
    const dir = tempDir();
    ensureStateFile(dir, contentPrd(['US-001']));
    expect(readdirSync(dir).filter((name) => /\.tmp-\d+$/.test(name))).toEqual([]);
    expect(existsSync(join(dir, 'state.json'))).toBe(true);
    rmSync(dir, { recursive: true, force: true });
  });
});

describe('selection and completion', () => {
  const prd = contentPrd(['US-001', 'US-002', 'US-003']);

  it('selects unimplemented stories before earlier validation-only candidates', () => {
    const state: RunState = {
      'US-001': storyState({ passes: true }),
      'US-002': storyState({ passes: false }),
      'US-003': passedState('US-003'),
    };
    expect(getCurrentStoryId(prd, state)).toBe('US-002');
  });

  it('selects the first validation-only candidate after implementation work is complete', () => {
    const state: RunState = {
      'US-001': storyState({ passes: true }),
      'US-002': storyState({ passes: true }),
      'US-003': passedState('US-003'),
    };
    expect(getCurrentStoryId(prd, state)).toBe('US-001');
    expect(allStoriesResolved(prd, state)).toBe(false);
  });

  it('resolves only structurally receipted or blocked stories', () => {
    const state: RunState = {
      'US-001': passedState('US-001'),
      'US-002': storyState({ passes: false, blocked: true }),
      'US-003': passedState('US-003'),
    };
    expect(getCurrentStoryId(prd, state)).toBeNull();
    expect(allStoriesResolved(prd, state)).toBe(true);
  });
});

describe('mergedStories', () => {
  it('overlays state onto content when state is present', () => {
    const state: RunState = {
      'US-001': { ...passedState(), notes: 'ok', retryCount: 1 },
    };
    const view = mergedStories(contentPrd(['US-001', 'US-002']), state);
    expect(view[0].passes).toBe(true);
    expect(view[0].validationReceipt).toEqual(receipt());
    expect(view[0].notes).toBe('ok');
    expect(view[1]).toMatchObject({ passes: false, validationReceipt: null });
  });

  it('shows legacy story fields only as an unverified candidate', () => {
    const view = mergedStories(contentPrd(['US-001'], { 'US-001': { passes: true } }), null);
    expect(view[0]).toMatchObject({ passes: true, validated: false, validationReceipt: null });
  });
});

describe('escalated engine ownership', () => {
  const base = (): RunState => ({
    'US-001': storyState({ retryCount: 2 }),
  });

  it('restores both unauthorized enable and downgrade attempts', () => {
    const enabled = base();
    enabled['US-001'].escalated = true;
    const down = restoreEscalated(enabled, 'US-001', false);
    expect(down.state['US-001'].escalated).toBe(false);
    expect(down.tamper).toEqual({ expected: false, received: true });

    const up = restoreEscalated(base(), 'US-001', true);
    expect(up.state['US-001'].escalated).toBe(true);
    expect(up.tamper).toEqual({ expected: true, received: false });
  });

  it('restores the whole engine-owned story when an agent deletes it', () => {
    const expected = { ...base()['US-001'], escalated: true, notes: 'keep' };
    const restored = restoreEscalated({}, 'US-001', true, expected);
    expect(restored.state['US-001']).toEqual(expected);
    expect(restored.tamper).toEqual({ expected: true, received: 'missing' });
  });

  it('enables only with a dedicated target and never changes retryCount', () => {
    expect(enableEscalation(base(), 'US-001', false).changed).toBe(false);
    const enabled = enableEscalation(base(), 'US-001', true);
    expect(enabled.changed).toBe(true);
    expect(enabled.state['US-001']).toMatchObject({ escalated: true, retryCount: 2 });
    expect(enableEscalation(enabled.state, 'US-001', true).changed).toBe(false);
  });
});

describe('validation engine ownership', () => {
  const base = (): RunState => ({
    'US-001': storyState({ passes: true, retryCount: 1 }),
  });

  it('requires candidate, flag, exact receipt shape, and non-blocked state', () => {
    expect(isStoryPassed(base()['US-001'])).toBe(false);
    expect(isStoryPassed({ ...base()['US-001'], validated: true })).toBe(false);
    expect(isStoryPassed(passedState())).toBe(true);
    expect(isStoryPassed({ ...passedState(), blocked: true })).toBe(false);
  });

  it('restores forged, removed, or changed receipt ownership as one unit', () => {
    const expected = validationOwnedFieldsOf(base()['US-001']);
    const forged = { ...passedState(), retryCount: 1 };
    const restored = restoreValidationOwnership(
      { 'US-001': forged },
      'US-001',
      expected,
      undefined,
      { validated: true, validationReceipt: forged.validationReceipt },
    );
    expect(validationOwnedFieldsOf(restored.state['US-001'])).toEqual(expected);
    expect(restored.tamper).toEqual({
      expected,
      received: { validated: true, validationReceipt: receipt() },
    });

    const missing = restoreValidationOwnership({}, 'US-001', expected, base()['US-001']);
    expect(missing.state['US-001']).toEqual(base()['US-001']);
    expect(missing.tamper?.received).toEqual({
      validated: 'missing',
      validationReceipt: 'missing',
    });

    const fieldOnly = restoreValidationOwnership(base(), 'US-001', expected, undefined, {
      validated: false,
      validationReceipt: 'missing',
    });
    expect(fieldOnly.tamper?.received.validationReceipt).toBe('missing');
  });

  it('issues a complete receipt only for a passing non-blocked candidate', () => {
    const target = receipt();
    const issued = issueValidationReceipt(base(), 'US-001', target);
    expect(issued.changed).toBe(true);
    expect(issued.state['US-001']).toMatchObject({
      validated: true,
      validationReceipt: target,
    });
    expect(issueValidationReceipt(issued.state, 'US-001', target).changed).toBe(false);
    expect(
      issueValidationReceipt(
        {
          'US-001': storyState({ passes: false }),
        },
        'US-001',
        target,
      ).changed,
    ).toBe(false);
    expect(
      issueValidationReceipt(
        {
          'US-001': storyState({ passes: true, blocked: true }),
        },
        'US-001',
        target,
      ).changed,
    ).toBe(false);
  });

  it('replaces an old receipt atomically and revokes without deleting the candidate', () => {
    const old = { 'US-001': passedState() };
    const replacement = receipt('US-001', [], HEAD_B, 'request-new');
    const issued = issueValidationReceipt(old, 'US-001', replacement);
    expect(issued.state['US-001'].validationReceipt).toEqual(replacement);

    const revoked = revokeValidationReceipt(issued.state, 'US-001');
    expect(revoked.changed).toBe(true);
    expect(revoked.state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
    expect(revokeValidationReceipt(revoked.state, 'US-001').changed).toBe(false);
  });
});

describe('receipt freshness reconciliation', () => {
  const criteria = {
    'US-001': ['A then B', 'C'],
    'US-002': ['D'],
    'US-003': ['E'],
  };
  const prd = contentPrd(['US-001', 'US-002', 'US-003'], {}, criteria);

  it('evaluates exact current HEAD and ordered acceptance criteria', () => {
    const story = prd.userStories[0];
    const current = passedState(story.id, story.acceptanceCriteria, HEAD_A);
    expect(evaluateValidationReceipt(story, current, HEAD_A)).toMatchObject({
      valid: true,
      reason: null,
    });
    expect(evaluateValidationReceipt(story, current, HEAD_B)).toMatchObject({
      valid: false,
      reason: 'git-head-mismatch',
    });
    expect(evaluateValidationReceipt(story, current, null)).toMatchObject({
      valid: false,
      reason: 'git-head-unavailable',
    });
    expect(
      evaluateValidationReceipt(
        { ...story, acceptanceCriteria: [...story.acceptanceCriteria].reverse() },
        current,
        HEAD_A,
      ),
    ).toMatchObject({ valid: false, reason: 'acceptance-hash-mismatch' });
  });

  it('invalidates old commits and blocked residue while preserving implementation candidates', () => {
    const state: RunState = {
      'US-001': passedState('US-001', criteria['US-001'], HEAD_A),
      'US-002': passedState('US-002', criteria['US-002'], HEAD_B),
      'US-003': { ...passedState('US-003', criteria['US-003'], HEAD_B), blocked: true },
    };
    const reconciled = reconcileValidationReceipts(prd, state, HEAD_B);
    expect(reconciled.changed).toBe(true);
    expect(reconciled.invalidated).toEqual([
      { storyId: 'US-001', reason: 'git-head-mismatch' },
      { storyId: 'US-003', reason: 'story-blocked' },
    ]);
    expect(reconciled.state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
    expect(reconciled.state['US-002']).toBe(state['US-002']);
    expect(reconciled.state['US-003']).toMatchObject({
      blocked: true,
      validated: false,
      validationReceipt: null,
    });
  });

  it('reports a legacy candidate as missing without manufacturing state', () => {
    const state: RunState = {
      'US-001': storyState({ passes: true }),
      'US-002': passedState('US-002', criteria['US-002'], HEAD_A),
      'US-003': passedState('US-003', criteria['US-003'], HEAD_A),
    };
    const reconciled = reconcileValidationReceipts(prd, state, HEAD_A);
    expect(reconciled.changed).toBe(false);
    expect(reconciled.state).toBe(state);
    expect(reconciled.invalidated).toEqual([{ storyId: 'US-001', reason: 'missing-receipt' }]);
    expect(reconciled.state['US-001'].validationReceipt).toBeNull();
  });

  it('persistently revokes a historical validated flag that has no receipt', () => {
    const state: RunState = {
      'US-001': storyState({ passes: true, validated: true }),
      'US-002': passedState('US-002', criteria['US-002'], HEAD_A),
      'US-003': passedState('US-003', criteria['US-003'], HEAD_A),
    };
    const reconciled = reconcileValidationReceipts(prd, state, HEAD_A);
    expect(reconciled.changed).toBe(true);
    expect(reconciled.invalidated).toContainEqual({
      storyId: 'US-001',
      reason: 'missing-receipt',
    });
    expect(reconciled.state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
  });

  it('returns a stable ordered digest only when all non-blocked stories are current', () => {
    const state: RunState = {
      'US-001': passedState('US-001', criteria['US-001'], HEAD_A, 'request-a'),
      'US-002': passedState('US-002', criteria['US-002'], HEAD_A, 'request-b'),
      'US-003': storyState({ blocked: true }),
    };
    const first = validationReceiptsDigest(prd, state, HEAD_A);
    expect(first).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(validationReceiptsDigest(prd, state, HEAD_A)).toBe(first);
    expect(validationReceiptsDigest(prd, state, HEAD_B)).toBeNull();

    const changedRequest: RunState = {
      ...state,
      'US-002': passedState('US-002', criteria['US-002'], HEAD_A, 'request-c'),
    };
    expect(validationReceiptsDigest(prd, changedRequest, HEAD_A)).not.toBe(first);
  });

  it('does not mint a Final Review binding for an empty Story set', () => {
    expect(validationReceiptsDigest({ ...prd, userStories: [] }, {}, HEAD_A)).toBeNull();
  });
});
