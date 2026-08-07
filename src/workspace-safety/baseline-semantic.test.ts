import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  captureDelegatedBaseline,
  evaluateDelegatedDelta,
  type DelegationContract,
} from './baseline.js';
import {
  OPERATION_ID,
  OWNER_ID,
  REQUEST_ID,
  STORY_ID,
  baselineWorkspace as workspace,
  builderContract,
  cleanupBaselineWorkspaces,
  validatorContract,
  validationResult,
  writeValidState,
} from './__fixtures__/baseline-test-support.js';

afterEach(cleanupBaselineWorkspaces);

describe('delegated business semantics', () => {
  it('binds semantic identity into the persisted contract digest', () => {
    const root = workspace();
    writeValidState(root);
    const first = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, builderContract());
    const changedIdentity: DelegationContract = {
      ...builderContract(),
      semantic: {
        version: 'builder-state-v1',
        storyId: STORY_ID,
        acceptanceHash: `sha256:${'c'.repeat(64)}`,
        checkCount: 1,
      },
    };
    const second = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, changedIdentity);

    expect(first.contract.semantic).toEqual(builderContract().semantic);
    expect(first.contractDigest).not.toBe(second.contractDigest);
    expect(first.manifestDigest).not.toBe(second.manifestDigest);
  });

  it('rejects a semantically invalid state before project code can start', () => {
    const wrongCurrent = workspace();
    writeValidState(wrongCurrent, { passes: 'false' });
    expect(() =>
      captureDelegatedBaseline(wrongCurrent, OWNER_ID, OPERATION_ID, builderContract()),
    ).toThrow(/state\.json:invalid-state-schema/i);

    const wrongOther = workspace();
    writeValidState(wrongOther);
    const state = JSON.parse(readFileSync(join(wrongOther, 'state.json'), 'utf8')) as Record<
      string,
      unknown
    >;
    state['US-002'] = { passes: 'false' };
    writeFileSync(join(wrongOther, 'state.json'), JSON.stringify(state));
    expect(() =>
      captureDelegatedBaseline(wrongOther, OWNER_ID, OPERATION_ID, builderContract()),
    ).toThrow(/state\.json:invalid-state-schema/i);
  });

  it('preserves the existing RunState compatibility width in both scans', () => {
    const root = workspace();
    writeValidState(root, { retryCount: -0.5, futureField: true });
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, builderContract());
    writeValidState(root, { passes: true, retryCount: -0.5, futureField: true });

    expect(evaluateDelegatedDelta(root, baseline)).toMatchObject({
      accepted: true,
      changes: ['state.json'],
      candidate: { version: 'builder-state-v1' },
    });
  });

  it.each([
    ['passes string', { passes: 'true' }],
    ['notes object', { notes: { forged: true } }],
    ['blocked null', { blocked: null }],
  ])('rejects an invalid Builder mutable field at settlement: %s', (_label, overrides) => {
    const root = workspace();
    writeValidState(root);
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, builderContract());
    writeValidState(root, overrides);

    const outcome = evaluateDelegatedDelta(root, baseline);
    expect(outcome).toMatchObject({ accepted: false });
    if (!outcome.accepted) {
      expect(outcome.violations).toContain('state.json:invalid-state-schema');
    }
  });

  it('requires Validator baseline to start without a stale result', () => {
    const root = workspace();
    writeValidState(root);
    writeFileSync(join(root, 'validation-result.json'), validationResult());

    expect(() => captureDelegatedBaseline(root, OWNER_ID, REQUEST_ID, validatorContract())).toThrow(
      /preexisting-result/i,
    );
  });

  it('settles a missing Validator result without manufacturing a candidate', () => {
    const root = workspace();
    writeValidState(root);
    const baseline = captureDelegatedBaseline(root, OWNER_ID, REQUEST_ID, validatorContract());

    expect(evaluateDelegatedDelta(root, baseline)).toEqual({ accepted: true, changes: [] });
  });

  it.each([
    ['passed', {}],
    [
      'failed',
      {
        verdict: 'failed',
        checks: [{ acIndex: 1, passed: false, evidence: 'failed verification' }],
      },
    ],
  ])('settles a fully bound Validator %s result as an unsigned candidate', (_label, overrides) => {
    const root = workspace();
    writeValidState(root);
    const baseline = captureDelegatedBaseline(root, OWNER_ID, REQUEST_ID, validatorContract());
    writeFileSync(join(root, 'validation-result.json'), validationResult(overrides));

    const outcome = evaluateDelegatedDelta(root, baseline);
    expect(outcome).toMatchObject({
      accepted: true,
      changes: ['validation-result.json'],
      candidate: {
        version: 'validator-result-v1',
        result: { verdict: _label },
      },
    });
  });

  it.each([
    ['invalid JSON', '{broken', 'invalid-json'],
    ['unknown field', validationResult({ unknown: true }), 'invalid-schema'],
    ['missing check', validationResult({ checks: [] }), 'invalid-schema'],
    [
      'verdict contradiction',
      validationResult({
        verdict: 'failed',
        checks: [{ acIndex: 1, passed: true, evidence: 'verified' }],
      }),
      'invalid-schema',
    ],
    [
      'wrong request',
      validationResult({ requestId: '00000000-0000-4000-8000-000000000099' }),
      'binding-mismatch',
    ],
    ['wrong story', validationResult({ storyId: 'US-999' }), 'binding-mismatch'],
    [
      'wrong acceptance hash',
      validationResult({ acceptanceHash: `sha256:${'d'.repeat(64)}` }),
      'binding-mismatch',
    ],
    ['wrong Git HEAD', validationResult({ gitHead: 'e'.repeat(40) }), 'binding-mismatch'],
  ])('leaves a bounded present-invalid Validator result for the engine protocol: %s', (_label, contents) => {
    const root = workspace();
    writeValidState(root);
    const baseline = captureDelegatedBaseline(root, OWNER_ID, REQUEST_ID, validatorContract());
    writeFileSync(join(root, 'validation-result.json'), contents);

    const outcome = evaluateDelegatedDelta(root, baseline);
    expect(outcome).toEqual({ accepted: true, changes: ['validation-result.json'] });
  });

  it('leaves a bounded result above the protocol limit for the engine to classify', () => {
    const root = workspace();
    writeValidState(root);
    const baseline = captureDelegatedBaseline(root, OWNER_ID, REQUEST_ID, validatorContract());
    writeFileSync(join(root, 'validation-result.json'), 'x'.repeat(64 * 1024 + 1));

    const outcome = evaluateDelegatedDelta(root, baseline);
    expect(outcome).toEqual({ accepted: true, changes: ['validation-result.json'] });
  });

  it('keeps malformed evidence and unclaimed screenshots non-blocking', () => {
    const root = workspace();
    writeValidState(root);
    writeFileSync(join(root, 'evidence.jsonl'), 'old-valid-prefix\n');
    const baseline = captureDelegatedBaseline(root, OWNER_ID, OPERATION_ID, builderContract());
    writeFileSync(join(root, 'evidence.jsonl'), 'old-valid-prefix\n{broken evidence\n');
    writeFileSync(join(root, 'screenshots', 'unclaimed.bin'), Buffer.from([0, 1, 2, 3]));

    expect(evaluateDelegatedDelta(root, baseline)).toMatchObject({
      accepted: true,
      changes: ['evidence.jsonl', 'screenshots/unclaimed.bin'],
    });
  });
});
