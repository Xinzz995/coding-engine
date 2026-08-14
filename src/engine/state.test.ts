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
  evaluateStoryValidationDisplay,
  evaluateStoryValidationReceiptSet,
  isStoryPassedAt,
  reconcileValidationReceipts,
  restoreValidationOwnership,
  validationOwnershipOf,
  selectNextStory,
  allStoriesResolvedAt,
  markValidatorUnverifiable,
  type ValidationReceipt,
} from './state.js';
import type { Prd } from './prd.js';
import { acceptanceHash, createValidationRequest } from './validation-protocol.js';

const HEAD_A = 'a'.repeat(40);
const HEAD_B = 'b'.repeat(40);
const ENVIRONMENT = `sha256:${'e'.repeat(64)}`;
const PROFILE_DIGEST = `sha256:${'d'.repeat(64)}`;
const CANARY_DIGEST = `sha256:${'c'.repeat(64)}`;
const CHANGE_MANIFEST_DIGEST = `sha256:${'f'.repeat(64)}`;
const RUNNER_BINDING = { profileDigest: PROFILE_DIGEST, canaryDigest: CANARY_DIGEST } as const;

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
    schemaVersion: 4,
    requestId,
    gitHead,
    acceptanceHash: acceptanceHash(id, acceptanceCriteria),
    validationEnvironmentDigest: ENVIRONMENT,
    runnerProfileDigest: PROFILE_DIGEST,
    canaryEvidenceDigest: CANARY_DIGEST,
    storyBaseGitHead: HEAD_B,
    changeManifestDigest: CHANGE_MANIFEST_DIGEST,
    changedPathCount: 2,
  };
}

function receiptV2For(id: string, acceptanceCriteria: string[] = ['AC 1']): ValidationReceipt {
  return {
    schemaVersion: 2,
    requestId: 'request-1',
    gitHead: HEAD_A,
    acceptanceHash: acceptanceHash(id, acceptanceCriteria),
    validationEnvironmentDigest: ENVIRONMENT,
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

  it('accepts exactly the v4 schema and keeps v1-v3 readable for fail-closed migration', () => {
    expect(parseValidationReceipt(valid)).toEqual(valid);
    expect(
      parseValidationReceipt({
        schemaVersion: 1,
        requestId: valid.requestId,
        gitHead: valid.gitHead,
        acceptanceHash: valid.acceptanceHash,
      }),
    ).toMatchObject({ schemaVersion: 1 });
    expect(parseValidationReceipt(receiptV2For('US-001'))).toMatchObject({ schemaVersion: 2 });
    expect(
      parseValidationReceipt({
        schemaVersion: 3,
        requestId: valid.requestId,
        gitHead: valid.gitHead,
        acceptanceHash: valid.acceptanceHash,
        validationEnvironmentDigest: valid.validationEnvironmentDigest,
        runnerProfileDigest: valid.runnerProfileDigest,
        canaryEvidenceDigest: valid.canaryEvidenceDigest,
      }),
    ).toMatchObject({ schemaVersion: 3 });
  });

  it.each([
    ['unknown key', { ...valid, extra: true }],
    ['missing key', { schemaVersion: 2, requestId: 'request-1', gitHead: HEAD_A }],
    ['empty request', { ...valid, requestId: '   ' }],
    ['bad head', { ...valid, gitHead: 'not-a-head' }],
    ['empty head', { ...valid, gitHead: '' }],
    ['bad hash', { ...valid, acceptanceHash: 'sha256:nope' }],
    ['wrong version', { ...valid, schemaVersion: 5 }],
    ['v2 with runner binding', { ...receiptV2For('US-001'), runnerProfileDigest: PROFILE_DIGEST }],
    ['missing runner binding', (() => {
      const { canaryEvidenceDigest: _omitted, ...rest } = valid;
      return rest;
    })()],
    ['bad profile digest', { ...valid, runnerProfileDigest: 'not-a-digest' }],
    ['bad canary digest', { ...valid, canaryEvidenceDigest: 'not-a-digest' }],
    ['bad Story base', { ...valid, storyBaseGitHead: 'not-a-head' }],
    ['bad change manifest', { ...valid, changeManifestDigest: 'not-a-digest' }],
    ['bad changed path count', { ...valid, changedPathCount: -1 }],
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
      storyBaseGitHead: null,
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
          storyBaseGitHead: HEAD_B,
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
  it('keeps a legacy receipt readable but never displays it as current validation', () => {
    const dir = tempDir();
    const file = join(dir, 'state.json');
    writeFileSync(
      file,
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          validationReceipt: {
            schemaVersion: 1,
            requestId: 'legacy-request',
            gitHead: HEAD_A,
            acceptanceHash: acceptanceHash('US-001', ['AC 1']),
          },
          notes: '',
          retryCount: 0,
          blocked: false,
        },
      }),
    );
    expect(tryReadState(file)?.['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
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
      storyBaseGitHead: undefined,
      validationReceipt: 'missing',
      validatorUnverifiable: 'missing',
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
      storyBaseGitHead: undefined,
      validationReceipt: 'missing',
      validatorUnverifiable: 'missing',
      escalated: true,
    });
    expect(tryReadEngineOwnedFields(file, 'US-404')).toEqual({
      validated: 'missing',
      storyBaseGitHead: undefined,
      validationReceipt: 'missing',
      validatorUnverifiable: 'missing',
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
      storyBaseGitHead: null,
      validationReceipt: null,
      validatorUnverifiable: null,
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
      storyBaseGitHead: HEAD_B,
      validationReceipt: receiptFor(story.id, story.acceptanceCriteria),
      notes: '',
      retryCount: 0,
      blocked: false,
      escalated: false,
    },
  });

  it('accepts only the exact current HEAD, Story ID and ordered AC snapshot', () => {
    const state = currentState()['US-001'];
    expect(evaluateStoryValidation(story, state, HEAD_A, ENVIRONMENT).valid).toBe(true);
    expect(isStoryPassedAt(story, state, HEAD_A, ENVIRONMENT)).toBe(true);

    expect(evaluateStoryValidation(story, state, HEAD_B, ENVIRONMENT)).toMatchObject({
      valid: false,
      reason: 'head-mismatch',
    });
    expect(
      evaluateStoryValidation({ ...story, id: 'US-002' }, state, HEAD_A, ENVIRONMENT),
    ).toMatchObject({
      valid: false,
      reason: 'acceptance-mismatch',
    });
    expect(
      evaluateStoryValidation(
        { ...story, acceptanceCriteria: ['first', 'changed'] },
        state,
        HEAD_A,
        ENVIRONMENT,
      ),
    ).toMatchObject({
      valid: false,
      reason: 'acceptance-mismatch',
    });
    expect(
      evaluateStoryValidation(
        { ...story, acceptanceCriteria: ['second', 'first'] },
        state,
        HEAD_A,
        ENVIRONMENT,
      ),
    ).toMatchObject({
      valid: false,
      reason: 'acceptance-mismatch',
    });
    expect(evaluateStoryValidation(story, state, 'not-a-head', ENVIRONMENT)).toMatchObject({
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
    expect(isStoryPassedAt(storyIdentity('US-002', criteria), copied, HEAD_A, ENVIRONMENT)).toBe(
      false,
    );
  });

  it('rejects a legacy receipt and a receipt from a different validation environment at the same HEAD', () => {
    const current = currentState()['US-001'];
    const legacy: RunState[string] = {
      ...current,
      validationReceipt: {
        schemaVersion: 1,
        requestId: 'request-1',
        gitHead: HEAD_A,
        acceptanceHash: acceptanceHash(story.id, story.acceptanceCriteria),
      },
    };
    expect(evaluateStoryValidation(story, legacy, HEAD_A, ENVIRONMENT)).toMatchObject({
      valid: false,
      reason: 'missing-environment-binding',
    });
    // v2 凭证缺 Runner 宿主隔离绑定（ADR-025）：沿 v1 先例安全失效，等待重验签 v3。
    const v2: RunState[string] = {
      ...current,
      validationReceipt: receiptV2For(story.id, story.acceptanceCriteria),
    };
    expect(evaluateStoryValidation(story, v2, HEAD_A, ENVIRONMENT)).toMatchObject({
      valid: false,
      reason: 'missing-runner-binding',
    });
    expect(
      evaluateStoryValidation(story, current, HEAD_A, `sha256:${'f'.repeat(64)}`),
    ).toMatchObject({ valid: false, reason: 'environment-mismatch' });
  });

  it.each([undefined, 'not-a-digest'])(
    'fails every Story-currentness API closed for an invalid expected environment: %s',
    (invalidEnvironment) => {
      const prd = contentPrd(['US-001']);
      const state: RunState = {
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: HEAD_B,
          validationReceipt: receiptFor('US-001', []),
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      };
      const expected = invalidEnvironment as unknown as string;

      expect(
        evaluateStoryValidation(prd.userStories[0], state['US-001'], HEAD_A, expected),
      ).toMatchObject({ valid: false, reason: 'invalid-expected-environment' });
      expect(isStoryPassedAt(prd.userStories[0], state['US-001'], HEAD_A, expected)).toBe(false);
      expect(evaluateStoryValidationReceiptSet(prd, state, HEAD_A, expected)).toMatchObject({
        valid: false,
        digest: null,
        receipts: [],
        invalid: [{ storyId: 'US-001', reason: 'invalid-expected-environment' }],
      });
      const reconciled = reconcileValidationReceipts(prd, state, HEAD_A, expected);
      expect(reconciled.invalidatedStoryIds).toEqual(['US-001']);
      expect(reconciled.state['US-001']).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
      });
      expect(selectNextStory(prd, state, HEAD_A, expected)).toEqual({
        storyId: 'US-001',
        mode: 'validation-only',
      });
      expect(allStoriesResolvedAt(prd, state, HEAD_A, expected)).toBe(false);
    },
  );

  it('clears display-only validation and emits no digest when the expected environment is unavailable', () => {
    const prd = contentPrd(['US-001']);
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        storyBaseGitHead: HEAD_B,
        validationReceipt: receiptFor('US-001', []),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };

    const display = evaluateStoryValidationDisplay(prd, state, HEAD_A, null);
    expect(display.digest).toBeNull();
    expect(display.currentness).toMatchObject({
      current: false,
      invalidStoryIds: ['US-001'],
      configurationError: null,
    });
    expect(display.state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
    expect(state['US-001'].validated).toBe(true);
  });

  it('never emits an empty receipt-set digest when every Story is blocked but the environment is invalid', () => {
    const prd = contentPrd(['US-001']);
    const state: RunState = {
      'US-001': { ...INITIAL_STORY_STATE, blocked: true },
    };
    expect(
      evaluateStoryValidationReceiptSet(prd, state, HEAD_A, undefined as unknown as string),
    ).toEqual({ valid: false, digest: null, receipts: [], invalid: [] });
    expect(allStoriesResolvedAt(prd, state, HEAD_A, undefined as unknown as string)).toBe(false);
  });

  it('reconciles every invalid receipt while preserving the implementation candidate and metadata', () => {
    const prd = contentPrd(['US-001', 'US-002']);
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        storyBaseGitHead: HEAD_B,
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
    const reconciled = reconcileValidationReceipts(prd, state, HEAD_B, ENVIRONMENT);
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
        storyBaseGitHead: HEAD_B,
        validationReceipt: receiptFor('US-001', []),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-002': {
        passes: true,
        validated: true,
        storyBaseGitHead: HEAD_B,
        validationReceipt: receiptFor('US-002', []),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    const reconciled = reconcileValidationReceipts(prd, state, HEAD_A, ENVIRONMENT);
    expect(reconciled.invalidatedStoryIds).toEqual(['US-001']);
    expect(reconciled.state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
    });
    expect(reconciled.state['US-002']).toBe(state['US-002']);
  });

  it('binds the ordered non-blocked Story receipt set including each request ID', () => {
    const prd = contentPrd(['US-001', 'US-002', 'US-003']);
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        storyBaseGitHead: HEAD_B,
        validationReceipt: receiptFor('US-001', [], HEAD_A, 'request-a'),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-002': {
        passes: false,
        validated: false,
        validationReceipt: null,
        notes: '',
        retryCount: 0,
        blocked: true,
        escalated: false,
      },
      'US-003': {
        passes: true,
        validated: true,
        storyBaseGitHead: HEAD_B,
        validationReceipt: receiptFor('US-003', [], HEAD_A, 'request-c'),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    const first = evaluateStoryValidationReceiptSet(prd, state, HEAD_A, ENVIRONMENT);
    const again = evaluateStoryValidationReceiptSet(
      prd,
      structuredClone(state),
      HEAD_A,
      ENVIRONMENT,
    );
    expect(first).toMatchObject({
      valid: true,
      digest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      receipts: [{ storyId: 'US-001' }, { storyId: 'US-003' }],
      invalid: [],
    });
    expect(again.digest).toBe(first.digest);

    const resigned = structuredClone(state);
    resigned['US-001'].validationReceipt = receiptFor('US-001', [], HEAD_A, 'request-new');
    expect(evaluateStoryValidationReceiptSet(prd, resigned, HEAD_A, ENVIRONMENT).digest).not.toBe(
      first.digest,
    );

    const reordered = structuredClone(prd);
    reordered.userStories = [prd.userStories[2], prd.userStories[1], prd.userStories[0]];
    expect(
      evaluateStoryValidationReceiptSet(reordered, state, HEAD_A, ENVIRONMENT).digest,
    ).not.toBe(first.digest);
  });

  it('does not issue a receipt-set digest while any non-blocked Story is stale', () => {
    const prd = contentPrd(['US-001', 'US-002']);
    const state: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        storyBaseGitHead: HEAD_B,
        validationReceipt: receiptFor('US-001', [], HEAD_A),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
      'US-002': {
        passes: true,
        validated: true,
        storyBaseGitHead: HEAD_B,
        validationReceipt: receiptFor('US-002', [], HEAD_B),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    expect(evaluateStoryValidationReceiptSet(prd, state, HEAD_A, ENVIRONMENT)).toMatchObject({
      valid: false,
      digest: null,
      invalid: [{ storyId: 'US-002', reason: 'head-mismatch' }],
    });
  });

  it('does not issue a digest or report convergence for empty or duplicate Story identities', () => {
    const empty = contentPrd([]);
    expect(evaluateStoryValidationReceiptSet(empty, {}, HEAD_A, ENVIRONMENT)).toMatchObject({
      valid: false,
      digest: null,
      configurationError: 'prd.json 必须包含至少一个 Story',
    });
    expect(allStoriesResolvedAt(empty, {}, HEAD_A, ENVIRONMENT)).toBe(false);

    const duplicate = contentPrd(['US-001', 'US-001']);
    const shared: RunState = {
      'US-001': {
        passes: true,
        validated: true,
        storyBaseGitHead: HEAD_B,
        validationReceipt: receiptFor('US-001', [], HEAD_A),
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    };
    expect(evaluateStoryValidationReceiptSet(duplicate, shared, HEAD_A, ENVIRONMENT)).toMatchObject(
      {
        valid: false,
        digest: null,
        configurationError: 'userStories 包含重复 Story ID：US-001',
      },
    );
    const persisted = structuredClone(shared);
    const display = evaluateStoryValidationDisplay(duplicate, shared, HEAD_A, ENVIRONMENT);
    expect(display.currentness).toEqual({
      gitHead: HEAD_A,
      current: false,
      invalidStoryIds: ['US-001'],
      configurationError: 'userStories 包含重复 Story ID：US-001',
    });
    expect(mergedStories(duplicate, display.state)).toHaveLength(2);
    expect(mergedStories(duplicate, display.state).every((story) => !story.validated)).toBe(true);
    expect(shared).toEqual(persisted);
    expect(allStoriesResolvedAt(duplicate, shared, HEAD_A, ENVIRONMENT)).toBe(false);

    const malformed = {
      ...contentPrd([]),
      userStories: [null],
    } as unknown as Prd;
    expect(initialStateFor(malformed)).toEqual({});
    expect(blankStateFor(malformed)).toEqual({});
    const malformedDisplay = evaluateStoryValidationDisplay(malformed, {}, HEAD_A, ENVIRONMENT);
    expect(malformedDisplay.currentness).toEqual({
      gitHead: HEAD_A,
      current: false,
      invalidStoryIds: [],
      configurationError: 'userStories[0] 的 Story ID 非法',
    });
    expect(mergedStories(malformed, malformedDisplay.state)).toEqual([]);
    expect(getCurrentStoryId(malformed, malformedDisplay.state)).toBeNull();
    expect(allStoriesResolved(malformed, malformedDisplay.state)).toBe(false);
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
    storyBaseGitHead: HEAD_B,
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
    expect(selectNextStory(prd, state, HEAD_A, ENVIRONMENT)).toEqual({
      storyId: 'US-002',
      mode: 'implementation',
    });

    state['US-002'] = candidate('US-002', false);
    expect(selectNextStory(prd, state, HEAD_A, ENVIRONMENT)).toEqual({
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
    expect(allStoriesResolvedAt(prd, state, HEAD_A, ENVIRONMENT)).toBe(true);
    expect(selectNextStory(prd, state, HEAD_A, ENVIRONMENT)).toBeNull();

    expect(allStoriesResolvedAt(prd, state, HEAD_B, ENVIRONMENT)).toBe(false);
    expect(selectNextStory(prd, state, HEAD_B, ENVIRONMENT)).toEqual({
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
      storyBaseGitHead: HEAD_B,
      validationReceipt: null,
      validatorUnverifiable: null,
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
    const expected = {
      validated: true,
      storyBaseGitHead: HEAD_B,
      validationReceipt: expectedReceipt,
      validatorUnverifiable: null,
    };
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
        storyBaseGitHead: HEAD_B,
        validationReceipt: { ...expectedReceipt, requestId: 'forged-request' },
        validatorUnverifiable: null,
      },
    });

    const fallback = { ...base()['US-001'], notes: 'keep' };
    const deleted = restoreValidationOwnership({}, 'US-001', expected, fallback);
    expect(deleted.state['US-001']).toEqual({
      ...fallback,
      validated: true,
      storyBaseGitHead: HEAD_B,
      validationReceipt: expectedReceipt,
      validatorUnverifiable: null,
    });
    expect(deleted.tamper?.received).toEqual({
      validated: 'missing',
      storyBaseGitHead: undefined,
      validationReceipt: 'missing',
      validatorUnverifiable: 'missing',
    });
  });

  it('detects deleting either ownership field and preserves identity when unchanged', () => {
    const expected = {
      validated: false,
      storyBaseGitHead: HEAD_B,
      validationReceipt: null,
      validatorUnverifiable: null,
    };
    const state = base();
    const unchanged = restoreValidationOwnership(state, 'US-001', expected, undefined, {
      validated: false,
      storyBaseGitHead: HEAD_B,
      validationReceipt: null,
      validatorUnverifiable: null,
    });
    expect(unchanged.state).toBe(state);
    expect(unchanged.tamper).toBeNull();

    const missingReceipt = restoreValidationOwnership(state, 'US-001', expected, undefined, {
      validated: false,
      storyBaseGitHead: HEAD_B,
      validationReceipt: 'missing',
      validatorUnverifiable: null,
    });
    expect(missingReceipt.state['US-001'].validationReceipt).toBeNull();
    expect(missingReceipt.tamper?.received.validationReceipt).toBe('missing');
  });

  it('issues a complete request-bound receipt only for the matching passing candidate', () => {
    const story = storyIdentity('US-001', ['first', 'second']);
    const request = createValidationRequest(
      story,
      '/tmp/workspace',
      {
        gitHead: HEAD_A,
        storyBaseGitHead: HEAD_B,
        changeManifestDigest: CHANGE_MANIFEST_DIGEST,
        changedPathCount: 2,
      },
      'request-1',
    );
    const issued = issueValidationReceipt(base(), story, request, ENVIRONMENT, RUNNER_BINDING);
    expect(issued.changed).toBe(true);
    expect(validationOwnershipOf(issued.state['US-001'])).toEqual({
      validated: true,
      storyBaseGitHead: HEAD_B,
      validationReceipt: receiptFor('US-001', ['first', 'second']),
      validatorUnverifiable: null,
    });
    expect(isStoryPassedAt(story, issued.state['US-001'], HEAD_A, ENVIRONMENT)).toBe(true);
    expect(
      issueValidationReceipt(issued.state, story, request, ENVIRONMENT, RUNNER_BINDING).changed,
    ).toBe(false);

    // 旧入口不能再签发无身份的裸布尔结论；缺 Runner 隔离绑定同样失败关闭（ADR-025）。
    expect(issueValidationReceipt(base(), 'US-001').changed).toBe(false);
    expect(issueValidationReceipt(base(), story, request, ENVIRONMENT).changed).toBe(false);
    expect(
      issueValidationReceipt(base(), story, request, ENVIRONMENT, {
        profileDigest: 'not-a-digest',
        canaryDigest: CANARY_DIGEST,
      }).changed,
    ).toBe(false);
    expect(
      issueValidationReceipt(
        {
          'US-001': { ...base()['US-001'], passes: false },
        },
        story,
        request,
        ENVIRONMENT,
        RUNNER_BINDING,
      ).changed,
    ).toBe(false);
    expect(
      issueValidationReceipt(
        {
          'US-001': { ...base()['US-001'], blocked: true },
        },
        story,
        request,
        ENVIRONMENT,
        RUNNER_BINDING,
      ).changed,
    ).toBe(false);
  });

  it('binds a Validator-unverifiable marker to the exact candidate and clears it on receipt', () => {
    const story = storyIdentity('US-001', ['first', 'second']);
    const request = createValidationRequest(
      story,
      '/tmp/workspace',
      {
        gitHead: HEAD_A,
        storyBaseGitHead: HEAD_B,
        changeManifestDigest: CHANGE_MANIFEST_DIGEST,
        changedPathCount: 2,
      },
      'request-1',
    );
    const marked = markValidatorUnverifiable(base(), story, HEAD_A);
    expect(marked.changed).toBe(true);
    expect(marked.state['US-001']).toMatchObject({
      passes: true,
      validated: false,
      validationReceipt: null,
      validatorUnverifiable: {
        schemaVersion: 1,
        gitHead: HEAD_A,
        acceptanceHash: acceptanceHash('US-001', ['first', 'second']),
      },
    });
    expect(markValidatorUnverifiable(marked.state, story, HEAD_A).changed).toBe(false);

    const issued = issueValidationReceipt(marked.state, story, request, ENVIRONMENT, RUNNER_BINDING);
    expect(issued.changed).toBe(true);
    expect(issued.state['US-001'].validatorUnverifiable).toBeNull();
  });

  it('does not mark a missing, failed, blocked, or invalid-head candidate unverifiable', () => {
    const story = storyIdentity('US-001');
    expect(markValidatorUnverifiable({}, story, HEAD_A).changed).toBe(false);
    expect(
      markValidatorUnverifiable(
        { 'US-001': { ...base()['US-001'], passes: false } },
        story,
        HEAD_A,
      ).changed,
    ).toBe(false);
    expect(
      markValidatorUnverifiable(
        { 'US-001': { ...base()['US-001'], blocked: true } },
        story,
        HEAD_A,
      ).changed,
    ).toBe(false);
    expect(markValidatorUnverifiable(base(), story, 'not-a-head').changed).toBe(false);
  });

  it('refuses empty/non-Git/wrong Story/wrong hash/wrong ordered criteria requests', () => {
    const story = storyIdentity('US-001', ['first', 'second']);
    const request = createValidationRequest(
      story,
      '/tmp/workspace',
      {
        gitHead: HEAD_A,
        storyBaseGitHead: HEAD_B,
        changeManifestDigest: CHANGE_MANIFEST_DIGEST,
        changedPathCount: 2,
      },
      'request-1',
    );
    const invalidRequests = [
      { ...request, requestId: '' },
      { ...request, gitHead: null },
      { ...request, storyId: 'US-002' },
      { ...request, acceptanceHash: acceptanceHash('US-001', ['different']) },
      { ...request, acceptanceCriteria: ['second', 'first'] },
    ];
    for (const invalid of invalidRequests) {
      expect(
        issueValidationReceipt(base(), story, invalid, ENVIRONMENT, RUNNER_BINDING).changed,
      ).toBe(false);
    }
  });

  it('keeps an unvalidated pass current and unresolved', () => {
    const prd = contentPrd(['US-001']);
    expect(getCurrentStoryId(prd, base())).toBe('US-001');
    expect(allStoriesResolved(prd, base())).toBe(false);
  });
});
