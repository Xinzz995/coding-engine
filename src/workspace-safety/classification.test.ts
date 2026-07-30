import { describe, expect, it } from 'vitest';
import { classifyWorkspaceSafetyFacts, type WorkspaceSafetyFacts } from './classification.js';

const base: WorkspaceSafetyFacts = {
  canonical: 'valid',
  quarantine: null,
  recovery: 'absent',
  bootstrapLease: false,
  legacyArtifacts: false,
  owner: 'absent',
  containment: 'not-applicable',
  recoveryInputs: 'valid',
  foreignHost: false,
  protocol: 'absent',
  marker: 'absent',
  lease: 'absent',
  directoryEmpty: false,
};

function classify(overrides: Partial<WorkspaceSafetyFacts>) {
  const facts = { ...base, ...overrides };
  if (overrides.lease === 'valid') {
    if (overrides.protocol === undefined) facts.protocol = 'valid';
    if (overrides.marker === undefined) facts.marker = 'valid';
  }
  if (overrides.bootstrapLease) {
    if (overrides.protocol === undefined) facts.protocol = 'valid';
    if (overrides.lease === undefined) facts.lease = 'valid';
  }
  return classifyWorkspaceSafetyFacts(facts);
}

describe('workspace safety classification priority', () => {
  it('applies the frozen priority without lower states masking higher states', () => {
    expect(
      classify({
        canonical: 'invalid',
        quarantine: 'workspace-integrity-violation',
        recovery: 'valid',
      }),
    ).toBe('invalid');

    expect(classify({ quarantine: 'operation-proof-missing', recovery: 'valid' })).toBe('isolated');

    expect(classify({ recovery: 'valid', quarantine: 'containment-unconfirmed' })).toBe(
      'recovering',
    );

    expect(
      classify({
        quarantine: 'containment-unconfirmed',
        bootstrapLease: true,
        owner: 'alive',
      }),
    ).toBe('isolated');

    expect(
      classify({
        bootstrapLease: true,
        legacyArtifacts: true,
        owner: 'alive',
        protocol: 'valid',
        lease: 'valid',
      }),
    ).toBe('active');

    expect(classify({ legacyArtifacts: true })).toBe('legacy');
  });

  it.each([
    ['live containment', { owner: 'dead', containment: 'alive', lease: 'valid' }],
    ['unknown containment', { owner: 'dead', containment: 'unknown', lease: 'valid' }],
    ['foreign host', { owner: 'dead', containment: 'empty', foreignHost: true, lease: 'valid' }],
    [
      'insufficient recovery inputs',
      { owner: 'dead', containment: 'empty', recoveryInputs: 'insufficient', lease: 'valid' },
    ],
  ] satisfies [string, Partial<WorkspaceSafetyFacts>][])('maps %s to isolated', (_label, facts) => {
    expect(classify(facts)).toBe('isolated');
  });

  it('requires exact owner death, empty/no containment and valid inputs for recoverable', () => {
    expect(classify({ owner: 'dead', containment: 'empty', lease: 'valid' })).toBe('recoverable');
    expect(classify({ owner: 'dead', containment: 'not-applicable', lease: 'valid' })).toBe(
      'recoverable',
    );
    expect(classify({ owner: 'unknown', containment: 'empty', lease: 'valid' })).toBe('isolated');
  });

  it('maps an exact live owner to active', () => {
    expect(classify({ owner: 'alive', lease: 'valid' })).toBe('active');
    expect(classify({ owner: 'alive', containment: 'alive', lease: 'valid' })).toBe('active');
  });

  it('recognizes ready and uninitialized-empty only after all higher states are excluded', () => {
    expect(classify({ protocol: 'valid', marker: 'valid', lease: 'absent' })).toBe('ready');
    expect(
      classify({
        protocol: 'valid',
        marker: 'valid',
        lease: 'absent',
        legacyArtifacts: true,
      }),
    ).toBe('ready');
    expect(classify({ directoryEmpty: true })).toBe('uninitialized-empty');
  });

  it('does not let a no-lease race hide containment or foreign-host uncertainty', () => {
    expect(
      classify({
        protocol: 'valid',
        marker: 'valid',
        lease: 'absent',
        containment: 'unknown',
      }),
    ).toBe('isolated');
    expect(classify({ directoryEmpty: true, foreignHost: true })).toBe('isolated');
  });

  it('marks impossible partial canonical shapes invalid', () => {
    expect(classify({ protocol: 'valid', marker: 'absent', lease: 'absent' })).toBe('invalid');
    expect(classify({ protocol: 'absent', marker: 'valid', lease: 'absent' })).toBe('invalid');
    expect(classify({ protocol: 'valid', marker: 'valid', lease: 'valid' })).toBe('invalid');
  });

  it('fails closed to isolated when otherwise valid facts prove no terminal class', () => {
    expect(classify({ directoryEmpty: false })).toBe('isolated');
  });
});
