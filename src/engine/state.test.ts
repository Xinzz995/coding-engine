import { describe, it, expect } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, readdirSync, existsSync } from 'node:fs';
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
  restoreValidated,
  issueValidationReceipt,
  tryReadEngineOwnedFields,
  type RunState,
  parseValidationReceipt,
  evaluateStoryValidation,
  isStoryPassedAt,
  reconcileValidationReceipts,
  restoreValidationOwnership,
  validationOwnershipOf,
  selectNextStory,
  allStoriesResolvedAt,
  type ValidationReceipt,
} from './state.js';
import type { Prd } from './prd.js';
import { acceptanceHash, createValidationRequest } from './validation-protocol.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);

function storyIdentity(id: string, acceptanceCriteria: string[] = ['AC 1']) {
  return { id, acceptanceCriteria };
}

function receiptFor(
  id: string,
  acceptanceCriteria: string[] = ['AC 1'],
  gitHead: string = HEAD_A,
  requestId = 'request-1',
): ValidationReceipt {
  return {
    schemaVersion: 1,
    requestId,
    gitHead,
    acceptanceHash: acceptanceHash(id, acceptanceCriteria),
  };
}

// 用「纯内容 + 可选旧状态字段」的字面量造 PRD 并 cast：
// Task 4 之前 Story 类型仍含状态字段（必填），cast 让本测试在 Story 瘦身前后都成立。
function contentPrd(
  ids: string[],
  legacy: Record<
    string,
    Partial<{ passes: boolean; notes: string; retryCount: number; blocked: boolean }>
  > = {},
): Prd {
  return {
    project: 'p',
    branchName: 'ralph/x',
    description: 'd',
    userStories: ids.map((id, i) => ({
      id,
      title: 't',
      description: 'd',
      acceptanceCriteria: [],
      priority: i + 1,
      ...(legacy[id] ?? {}),
    })),
  };
}

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), 'state-'));
}

describe('parseValidationReceipt', () => {
  const valid = receiptFor('US-001');

  it('accepts exactly the v1 schema', () => {
    expect(parseValidationReceipt(valid)).toEqual(valid);
  });

  it.each([
    ['unknown key', { ...valid, extra: true }],
    ['missing key', { schemaVersion: 1, requestId: 'request-1', gitHead: HEAD_A }],
    ['empty request', { ...valid, requestId: '   ' }],
    ['bad head', { ...valid, gitHead: 'not-a-head' }],
    ['empty head', { ...valid, gitHead: '' }],
    ['bad hash', { ...valid, acceptanceHash: 'sha256:nope' }],
    ['wrong version', { ...valid, schemaVersion: 2 }],
  ])('rejects %s', (_label, value) => {
    expect(parseValidationReceipt(value)).toBeNull();
  });
});

describe('tryReadState', () => {
  it('returns null for missing or invalid file', () => {
    expect(tryReadState('/no/such/state.json')).toBeNull();
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{ broken');
    expect(tryReadState(join(dir, 'state.json'))).toBeNull();
    rmSync(dir, { recursive: true, force: true });
  });
  it('keeps a legacy pass as an unvalidated implementation candidate', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({ 'US-001': { passes: true, notes: 'n', retryCount: 2, blocked: false } }),
    );
    expect(tryReadState(file)?.['US-001'].retryCount).toBe(2);
    expect(tryReadState(file)?.['US-001'].escalated).toBe(false);
    expect(tryReadState(file)?.['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
    rmSync(dir, { recursive: true, force: true });
  });
  it('parses a valid current receipt', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    const validationReceipt = receiptFor('US-001');
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          validationReceipt,
          notes: 'n',
          retryCount: 2,
          blocked: false,
        },
      }),
    );
    expect(tryReadState(file)?.['US-001']).toMatchObject({
      passes: true,
      validated: true,
      validationReceipt,
    });
    rmSync(dir, { recursive: true, force: true });
  });
  it('does not let a receipt outlive its passing candidate state', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': {
          passes: false,
          validated: true,
          validationReceipt: receiptFor('US-001'),
          notes: '',
          retryCount: 0,
          blocked: false,
        },
      }),
    );
    expect(tryReadState(file)?.['US-001']).toMatchObject({
      validated: false,
      validationReceipt: null,
    });
    rmSync(dir, { recursive: true, force: true });
  });
  it('reads engine-owned fields without hiding missing legacy values', () => {
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
          passes: false,
          validated: false,
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: true,
        },
      }),
    );
    expect(tryReadEngineOwnedFields(file, 'US-001')).toEqual({
      validated: false,
      validationReceipt: 'missing',
      escalated: true,
    });
    expect(tryReadEngineOwnedFields(file, 'US-404')).toEqual({
      validated: 'missing',
      validationReceipt: 'missing',
      escalated: 'missing',
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
    writeFileSync(
      file,
      JSON.stringify({ 'US-001': { passes: 'yes', notes: '', retryCount: 0, blocked: false } }),
    );
    expect(tryReadState(file)).toBeNull();
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': { passes: false, notes: '', retryCount: 0, blocked: false, escalated: 'yes' },
      }),
    );
    expect(tryReadState(file)).toBeNull();
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': { passes: false, validated: 'yes', notes: '', retryCount: 0, blocked: false },
      }),
    );
    expect(tryReadState(file)).toBeNull();
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          validationReceipt: { ...receiptFor('US-001'), extra: true },
          notes: '',
          retryCount: 0,
          blocked: false,
        },
      }),
    );
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
    const s = initialStateFor(
      contentPrd(['US-001'], {
        'US-001': { passes: true, notes: 'x', retryCount: 3, blocked: true },
      }),
    );
    expect(s['US-001']).toEqual({
      passes: true,
      validated: false,
      validationReceipt: null,
      notes: 'x',
      retryCount: 3,
      blocked: true,
      escalated: false,
    });
  });
  it('never upgrades a legacy embedded pass into a Validator conclusion', () => {
    const state = initialStateFor(
      contentPrd(['US-001'], {
        'US-001': { passes: true, blocked: false },
      }),
    );
    expect(state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
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
    writeFileSync(
      join(dir, 'state.json'),
      JSON.stringify({ 'US-001': { passes: true, notes: '', retryCount: 0, blocked: false } }),
    );
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001'].passes).toBe(true); // 不被初始值覆盖
    expect(state['US-001'].escalated).toBe(false); // 旧 state 在内存兼容归一
    expect(state['US-001'].validated).toBe(false); // 旧 passed state 仅保留实现候选
    expect(state['US-001'].validationReceipt).toBeNull();
    expect(readFileSync(join(dir, 'state.json'), 'utf-8')).not.toContain('escalated'); // 读取不触发迁移写
    expect(readFileSync(join(dir, 'state.json'), 'utf-8')).not.toContain('validated');
    rmSync(dir, { recursive: true, force: true });
  });
  it('does not overwrite a corrupted state.json (leave it to repair)', () => {
    const dir = tempDir();
    writeFileSync(join(dir, 'state.json'), '{ broken');
    const state = ensureStateFile(dir, contentPrd(['US-001']));
    expect(state['US-001']).toEqual(INITIAL_STORY_STATE); // 内存回退
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

describe('current Validator receipt evaluation', () => {
  const story = storyIdentity('US-001', ['first', 'second']);
  const currentState = (): RunState => ({
    'US-001': {
      passes: true,
      validated: true,
      validationReceipt: receiptFor(story.id, story.acceptanceCriteria),
      notes: '',
      retryCount: 0,
      blocked: false,
      escalated: false,
    },
  });

  it('accepts only the exact current HEAD, Story ID and ordered AC snapshot', () => {
    const state = currentState()['US-001'];
    expect(evaluateStoryValidation(story, state, HEAD_A).valid).toBe(true);
    expect(isStoryPassedAt(story, state, HEAD_A)).toBe(true);

    expect(evaluateStoryValidation(story, state, HEAD_B)).toMatchObject({
      valid: false,
      reason: 'head-mismatch',
    });
    expect(evaluateStoryValidation({ ...story, id: 'US-002' }, state, HEAD_A)).toMatchObject({
      valid: false,
      reason: 'acceptance-mismatch',
    });
    expect(
      evaluateStoryValidation(
        { ...story, acceptanceCriteria: ['first', 'changed'] },
        state,
        HEAD_A,
      ),
    ).toMatchObject({
      valid: false,
      reason: 'acceptance-mismatch',
    });
    expect(
      evaluateStoryValidation({ ...story, acceptanceCriteria: ['second', 'first'] }, state, HEAD_A),
    ).toMatchObject({
      valid: false,
      reason: 'acceptance-mismatch',
    });
    expect(evaluateStoryValidation(story, state, 'not-a-head')).toMatchObject({
      valid: false,
      reason: 'invalid-current-head',
    });
  });

  it('rejects a receipt copied across Stories even when their AC text is identical', () => {
    const criteria = ['same text'];
    const copied = {
      ...currentState()['US-001'],
      validationReceipt: receiptFor('US-001', criteria),
    };
    expect(isStoryPassedAt(storyIdentity('US-002', criteria), copied, HEAD_A)).toBe(false);
  });

  it('reconciles every invalid receipt while preserving the implementation candidate and metadata', () => {
    const prd = contentPrd(['US-001', 'US-002']);
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt: receiptFor('US-001', []),
        notes: 'keep',
        retryCount: 3,
        blocked: false,
        escalated: true,
      },
      'US-002': {
        passes: true,
        validated: false,
        validationReceipt: null,
        notes: 'also keep',
        retryCount: 2,
        blocked: false,
        escalated: false,
      },
    };
    const reconciled = reconcileValidationReceipts(prd, state, HEAD_B);
    expect(reconciled.invalidatedStoryIds).toEqual(['US-001']);
    expect(reconciled.state['US-001']).toEqual({
      ...state['US-001'],
      validated: false,
      validationReceipt: null,
    });
    expect(reconciled.state['US-002']).toBe(state['US-002']);
    expect(reconciled.state['US-001'].passes).toBe(true);
  });

  it('invalidates only the Story whose ordered AC snapshot changed', () => {
    const prd = contentPrd(['US-001', 'US-002']);
    prd.userStories[0].acceptanceCriteria = ['changed'];
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        validationReceipt: receiptFor('US-001', []),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-002': {
        passes: true,
        validated: true,
        validationReceipt: receiptFor('US-002', []),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    const reconciled = reconcileValidationReceipts(prd, state, HEAD_A);
    expect(reconciled.invalidatedStoryIds).toEqual(['US-001']);
    expect(reconciled.state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
    expect(reconciled.state['US-002']).toBe(state['US-002']);
  });
});

describe('getCurrentStoryId / allStoriesResolved', () => {
  const prd = contentPrd(['US-001', 'US-002', 'US-003']);
  it('picks the first story that is neither passing nor blocked', () => {
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-002': {
        passes: false,
        validated: false,
        notes: '',
        retryCount: 5,
        blocked: true,
        escalated: false,
      },
    };
    // US-003 不在 state 中 → 按初始状态可选
    expect(getCurrentStoryId(prd, state)).toBe('US-003');
    expect(allStoriesResolved(prd, state)).toBe(false);
  });
  it('resolves when every story passes or is blocked', () => {
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-002': {
        passes: false,
        validated: false,
        notes: '',
        retryCount: 5,
        blocked: true,
        escalated: false,
      },
      'US-003': {
        passes: true,
        validated: true,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    expect(getCurrentStoryId(prd, state)).toBeNull();
    expect(allStoriesResolved(prd, state)).toBe(true);
  });
});

describe('selectNextStory / allStoriesResolvedAt', () => {
  const prd = contentPrd(['US-001', 'US-002', 'US-003']);
  const candidate = (id: string, validated: boolean): RunState[string] => ({
    passes: true,
    validated,
    validationReceipt: validated ? receiptFor(id, []) : null,
    notes: '',
    retryCount: 0,
    blocked: false,
    escalated: false,
  });

  it('selects missing implementations before earlier validation-only candidates', () => {
    const state: RunState = {
      'US-001': candidate('US-001', false),
      'US-002': { ...INITIAL_STORY_STATE },
      'US-003': candidate('US-003', true),
    };
    expect(selectNextStory(prd, state, HEAD_A)).toEqual({
      storyId: 'US-002',
      mode: 'implementation',
    });

    state['US-002'] = candidate('US-002', false);
    expect(selectNextStory(prd, state, HEAD_A)).toEqual({
      storyId: 'US-001',
      mode: 'validation-only',
    });
  });

  it('treats only current receipts or blocked Stories as resolved', () => {
    const state: RunState = {
      'US-001': candidate('US-001', true),
      'US-002': candidate('US-002', true),
      'US-003': { ...INITIAL_STORY_STATE, blocked: true },
    };
    expect(allStoriesResolvedAt(prd, state, HEAD_A)).toBe(true);
    expect(selectNextStory(prd, state, HEAD_A)).toBeNull();

    expect(allStoriesResolvedAt(prd, state, HEAD_B)).toBe(false);
    expect(selectNextStory(prd, state, HEAD_B)).toEqual({
      storyId: 'US-001',
      mode: 'validation-only',
    });
  });
});

describe('mergedStories', () => {
  it('overlays state onto content when state is present', () => {
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        notes: 'ok',
        retryCount: 1,
        blocked: false,
        escalated: false,
      },
    };
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
    'US-001': {
      passes: false,
      validated: false,
      notes: '',
      retryCount: 2,
      blocked: false,
      escalated: false,
    },
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
    'US-001': {
      passes: true,
      validated: false,
      validationReceipt: null,
      notes: '',
      retryCount: 1,
      blocked: false,
      escalated: false,
    },
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

  it('restores validated and validationReceipt as one engine-owned value', () => {
    const expectedReceipt = receiptFor('US-001');
    const expected = { validated: true, validationReceipt: expectedReceipt };
    const tampered = base();
    tampered['US-001'] = {
      ...tampered['US-001'],
      validated: true,
      validationReceipt: { ...expectedReceipt, requestId: 'forged-request' },
    };
    const restored = restoreValidationOwnership(tampered, 'US-001', expected);
    expect(validationOwnershipOf(restored.state['US-001'])).toEqual(expected);
    expect(restored.tamper).toEqual({
      expected,
      received: {
        validated: true,
        validationReceipt: { ...expectedReceipt, requestId: 'forged-request' },
      },
    });

    const fallback = { ...base()['US-001'], notes: 'keep' };
    const deleted = restoreValidationOwnership({}, 'US-001', expected, fallback);
    expect(deleted.state['US-001']).toEqual({
      ...fallback,
      validated: true,
      validationReceipt: expectedReceipt,
    });
    expect(deleted.tamper?.received).toEqual({
      validated: 'missing',
      validationReceipt: 'missing',
    });
  });

  it('detects deleting either ownership field and preserves identity when unchanged', () => {
    const expected = {
      validated: false,
      validationReceipt: null,
    };
    const state = base();
    const unchanged = restoreValidationOwnership(state, 'US-001', expected, undefined, {
      validated: false,
      validationReceipt: null,
    });
    expect(unchanged.state).toBe(state);
    expect(unchanged.tamper).toBeNull();

    const missingReceipt = restoreValidationOwnership(state, 'US-001', expected, undefined, {
      validated: false,
      validationReceipt: 'missing',
    });
    expect(missingReceipt.state['US-001'].validationReceipt).toBeNull();
    expect(missingReceipt.tamper?.received.validationReceipt).toBe('missing');
  });

  it('issues a complete request-bound receipt only for the matching passing candidate', () => {
    const story = storyIdentity('US-001', ['first', 'second']);
    const request = createValidationRequest(story, '/tmp/workspace', HEAD_A, 'request-1');
    const issued = issueValidationReceipt(base(), story, request);
    expect(issued.changed).toBe(true);
    expect(validationOwnershipOf(issued.state['US-001'])).toEqual({
      validated: true,
      validationReceipt: receiptFor('US-001', ['first', 'second']),
    });
    expect(isStoryPassedAt(story, issued.state['US-001'], HEAD_A)).toBe(true);
    expect(issueValidationReceipt(issued.state, story, request).changed).toBe(false);

    // 旧入口不能再签发无身份的裸布尔结论。
    expect(issueValidationReceipt(base(), 'US-001').changed).toBe(false);
    expect(
      issueValidationReceipt(
        {
          'US-001': { ...base()['US-001'], passes: false },
        },
        story,
        request,
      ).changed,
    ).toBe(false);
    expect(
      issueValidationReceipt(
        {
          'US-001': { ...base()['US-001'], blocked: true },
        },
        story,
        request,
      ).changed,
    ).toBe(false);
  });

  it('refuses empty/non-Git/wrong Story/wrong hash/wrong ordered criteria requests', () => {
    const story = storyIdentity('US-001', ['first', 'second']);
    const request = createValidationRequest(story, '/tmp/workspace', HEAD_A, 'request-1');
    const invalidRequests = [
      { ...request, requestId: '' },
      { ...request, gitHead: null },
      { ...request, storyId: 'US-002' },
      { ...request, acceptanceHash: acceptanceHash('US-001', ['different']) },
      { ...request, acceptanceCriteria: ['second', 'first'] },
    ];
    for (const invalid of invalidRequests) {
      expect(issueValidationReceipt(base(), story, invalid).changed).toBe(false);
    }
  });

  it('keeps an unvalidated pass current and unresolved', () => {
    const prd = contentPrd(['US-001']);
    expect(getCurrentStoryId(prd, base())).toBe('US-001');
    expect(allStoriesResolved(prd, base())).toBe(false);
  });
});
