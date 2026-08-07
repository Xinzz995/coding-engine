import { describe, expect, it } from 'vitest';
import {
  evaluateDelegatedSemantic,
  parseDelegatedSemanticContract,
  RUN_STATE_PATH,
  VALIDATION_RESULT_PATH,
  type BuilderStateSemanticContract,
  type ValidatorResultSemanticContract,
} from './delegated-operation-contract.js';
import { parseRunStateBytes } from './run-state-contract.js';
import { parseValidationResultBytes, type ValidationResult } from './validation-contract.js';

const STORY_ID = 'US-001';
const REQUEST_ID = '00000000-0000-4000-8000-000000000020';
const ACCEPTANCE_HASH = `sha256:${'a'.repeat(64)}`;
const GIT_HEAD = 'b'.repeat(40);

const builder: BuilderStateSemanticContract = {
  version: 'builder-state-v1',
  storyId: STORY_ID,
  acceptanceHash: ACCEPTANCE_HASH,
  checkCount: 1,
};

const validator: ValidatorResultSemanticContract = {
  version: 'validator-result-v1',
  requestId: REQUEST_ID,
  storyId: STORY_ID,
  acceptanceHash: ACCEPTANCE_HASH,
  checkCount: 1,
  gitHead: GIT_HEAD,
};

function state(overrides: Record<string, unknown> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      [STORY_ID]: {
        passes: false,
        validated: false,
        validationReceipt: null,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
        ...overrides,
      },
    }),
  );
}

function result(overrides: Partial<ValidationResult> = {}): Buffer {
  return Buffer.from(
    JSON.stringify({
      version: 1,
      requestId: REQUEST_ID,
      storyId: STORY_ID,
      acceptanceHash: ACCEPTANCE_HASH,
      gitHead: GIT_HEAD,
      verdict: 'passed',
      checks: [{ acIndex: 1, passed: true, evidence: 'verified' }],
      summary: 'verified',
      ...overrides,
    }),
  );
}

describe('neutral run state contract', () => {
  it('preserves the existing permissive fields while rejecting existing schema errors', () => {
    const compatible = parseRunStateBytes(
      state({ retryCount: -0.5, extensionOwnedByFutureVersion: true }),
    );
    expect(compatible.ok).toBe(true);
    if (compatible.ok) expect(compatible.value[STORY_ID].retryCount).toBe(-0.5);

    expect(parseRunStateBytes(state({ passes: 'true' }))).toMatchObject({
      ok: false,
      code: 'invalid-state-schema',
    });
    expect(parseRunStateBytes(Buffer.from('{broken'))).toMatchObject({
      ok: false,
      code: 'invalid-state-json',
    });
  });

  it('accepts only an exact Validator-unverifiable marker on a pending candidate', () => {
    const marker = {
      schemaVersion: 1,
      gitHead: GIT_HEAD,
      acceptanceHash: ACCEPTANCE_HASH,
    };
    const parsed = parseRunStateBytes(
      state({ passes: true, validatorUnverifiable: marker }),
    );
    expect(parsed).toMatchObject({
      ok: true,
      value: { [STORY_ID]: { validatorUnverifiable: marker } },
    });

    for (const invalid of [
      { ...marker, schemaVersion: 2 },
      { ...marker, gitHead: 'short' },
      { ...marker, acceptanceHash: 'bad' },
      { ...marker, extra: true },
    ]) {
      expect(parseRunStateBytes(state({ passes: true, validatorUnverifiable: invalid }))).toMatchObject({
        ok: false,
        code: 'invalid-state-schema',
      });
    }

    const completed = parseRunStateBytes(
      state({ passes: false, validatorUnverifiable: marker }),
    );
    expect(completed).toMatchObject({
      ok: true,
      value: { [STORY_ID]: { validatorUnverifiable: null } },
    });
  });
});

describe('neutral validation result contract', () => {
  it.each([
    ['passed', {}],
    [
      'failed',
      {
        verdict: 'failed' as const,
        checks: [{ acIndex: 1, passed: false, evidence: 'not verified' }],
      },
    ],
  ])('accepts a fully bound %s claim', (_label, overrides) => {
    expect(parseValidationResultBytes(result(overrides), validator)).toMatchObject({ ok: true });
  });

  it.each([
    ['requestId', { requestId: '00000000-0000-4000-8000-000000000099' }],
    ['storyId', { storyId: 'US-999' }],
    ['acceptanceHash', { acceptanceHash: `sha256:${'c'.repeat(64)}` }],
    ['gitHead', { gitHead: 'd'.repeat(40) }],
  ])('rejects a wrong %s binding', (_label, overrides) => {
    expect(parseValidationResultBytes(result(overrides), validator)).toMatchObject({
      ok: false,
      code: 'binding-mismatch',
    });
  });
});

describe('delegated semantic contract', () => {
  it('strictly preserves every applicable identity field', () => {
    expect(parseDelegatedSemanticContract(builder)).toEqual({ ok: true, value: builder });
    expect(parseDelegatedSemanticContract(validator)).toEqual({ ok: true, value: validator });
    for (const invalid of [
      { ...builder, requestId: REQUEST_ID },
      { ...validator, gitHead: null },
      { ...validator, requestId: 'request' },
      { ...validator, checkCount: -1 },
      { ...validator, acceptanceHash: 'not-a-hash' },
      { version: 'future-v2' },
    ]) {
      expect(parseDelegatedSemanticContract(invalid).ok).toBe(false);
    }
  });

  it('distinguishes missing output from a present invalid output', () => {
    expect(
      evaluateDelegatedSemantic({
        semantic: validator,
        phase: 'settlement',
        files: new Map(),
      }),
    ).toEqual({ accepted: true });
    expect(
      evaluateDelegatedSemantic({
        semantic: validator,
        phase: 'settlement',
        files: new Map([[VALIDATION_RESULT_PATH, Buffer.from('{broken')]]),
      }),
    ).toEqual({ accepted: true });
  });

  it('requires a valid target story from the exact state bytes', () => {
    expect(
      evaluateDelegatedSemantic({
        semantic: builder,
        phase: 'settlement',
        files: new Map([[RUN_STATE_PATH, state()]]),
      }),
    ).toMatchObject({ accepted: true, candidate: { version: 'builder-state-v1' } });
    expect(
      evaluateDelegatedSemantic({
        semantic: { ...builder, storyId: 'US-404' },
        phase: 'settlement',
        files: new Map([[RUN_STATE_PATH, state()]]),
      }),
    ).toEqual({ accepted: false, violation: 'state.json:semantic-story-missing' });
  });
});
