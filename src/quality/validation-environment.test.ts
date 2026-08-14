import { describe, expect, it } from 'vitest';
import type { QualityContract } from './contract.js';
import {
  CLEAN_VALIDATION_CHECKOUT_VERSION,
  normalizeValidationAdditionalRefs,
  normalizeValidationReferenceAliases,
  validationEnvironmentDigest,
} from './validation-environment.js';

const CONTRACT = {
  checks: {
    test: { notApplicable: 'fixture' },
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
  },
  generatedPaths: [],
  localValidation: {
    prepare: [],
    allowedPaths: [],
  },
} as Pick<QualityContract, 'checks' | 'generatedPaths' | 'localValidation'>;

describe('validation environment', () => {
  it('invalidates earlier evidence after default-branch aliases join the checkout protocol', () => {
    const previousDigests = [
      'sha256:ca874acba601396e4985b832b2d82ee5f5743e022d8a3a859164d1da47dbfa09',
      'sha256:6b1cfd25f621e22e61776af5531c763c4c83ee510f8dfc2c91bf12e0a81e3d73',
      'sha256:f0a3064fe26b962cd510d52b2c73c994ddb9c174c1d69741394ff2b01af327e1',
    ];
    const v4Digest = validationEnvironmentDigest({
      contract: CONTRACT,
      head: 'a'.repeat(40),
      platform: 'linux',
      additionalRefs: [],
      additionalPolicy: null,
    });

    expect(CLEAN_VALIDATION_CHECKOUT_VERSION).toBe('clean-checkout-v4');
    expect(v4Digest).toBe(
      'sha256:06067ec9e263f2e70da2942f5f9fcda9e6a454f4d2d5ea2a38f17f5051b5988f',
    );
    expect(previousDigests).not.toContain(v4Digest);
  });

  it('normalizes duplicate additional refs and excludes HEAD from the validation identity', () => {
    const head = 'a'.repeat(40);
    const baseline = 'b'.repeat(40);
    expect(normalizeValidationAdditionalRefs(head, [baseline, head, baseline, head])).toEqual([
      baseline,
    ]);
    expect(
      validationEnvironmentDigest({
        contract: CONTRACT,
        head,
        platform: 'linux',
        additionalRefs: [baseline, head, baseline],
      }),
    ).toBe(
      validationEnvironmentDigest({
        contract: CONTRACT,
        head,
        platform: 'linux',
        additionalRefs: [baseline],
      }),
    );
  });

  it('binds a normalized origin alias and its exact target into the environment identity', () => {
    const head = 'a'.repeat(40);
    const first = 'b'.repeat(40);
    const second = 'c'.repeat(40);
    const aliases = [
      { ref: 'refs/remotes/origin/main', target: first },
      { ref: 'refs/remotes/origin/main', target: first },
    ];
    expect(normalizeValidationReferenceAliases(aliases)).toEqual([aliases[0]]);
    const digestFor = (target: string) =>
      validationEnvironmentDigest({
        contract: CONTRACT,
        head,
        platform: 'linux',
        referenceAliases: [{ ref: 'refs/remotes/origin/main', target }],
      });
    expect(digestFor(first)).not.toBe(digestFor(second));
    expect(() =>
      normalizeValidationReferenceAliases([
        ...aliases,
        { ref: 'refs/remotes/origin/main', target: second },
      ]),
    ).toThrow('不能指向多个提交');
    expect(() =>
      normalizeValidationReferenceAliases([
        { ref: 'refs/heads/main', target: first },
      ]),
    ).toThrow('origin');
  });
});
