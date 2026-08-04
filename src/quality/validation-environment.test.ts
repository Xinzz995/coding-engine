import { describe, expect, it } from 'vitest';
import type { QualityContract } from './contract.js';
import {
  CLEAN_VALIDATION_CHECKOUT_VERSION,
  normalizeValidationAdditionalRefs,
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
  it('invalidates v1 and v2 evidence after the reachable-history protocol changes', () => {
    const previousDigests = [
      'sha256:ca874acba601396e4985b832b2d82ee5f5743e022d8a3a859164d1da47dbfa09',
      'sha256:6b1cfd25f621e22e61776af5531c763c4c83ee510f8dfc2c91bf12e0a81e3d73',
    ];
    const v3Digest = validationEnvironmentDigest({
      contract: CONTRACT,
      head: 'a'.repeat(40),
      platform: 'linux',
      additionalRefs: [],
      additionalPolicy: null,
    });

    expect(CLEAN_VALIDATION_CHECKOUT_VERSION).toBe('clean-checkout-v3');
    expect(v3Digest).toBe(
      'sha256:f0a3064fe26b962cd510d52b2c73c994ddb9c174c1d69741394ff2b01af327e1',
    );
    expect(previousDigests).not.toContain(v3Digest);
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
});
