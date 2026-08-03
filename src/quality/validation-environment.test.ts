import { describe, expect, it } from 'vitest';
import type { QualityContract } from './contract.js';
import {
  CLEAN_VALIDATION_CHECKOUT_VERSION,
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
  it('invalidates clean-checkout-v1 evidence after the internal-link protocol changes', () => {
    const v1Digest = 'sha256:ca874acba601396e4985b832b2d82ee5f5743e022d8a3a859164d1da47dbfa09';
    const v2Digest = validationEnvironmentDigest({
      contract: CONTRACT,
      head: 'a'.repeat(40),
      platform: 'linux',
      additionalRefs: [],
      additionalPolicy: null,
    });

    expect(CLEAN_VALIDATION_CHECKOUT_VERSION).toBe('clean-checkout-v2');
    expect(v2Digest).toBe(
      'sha256:6b1cfd25f621e22e61776af5531c763c4c83ee510f8dfc2c91bf12e0a81e3d73',
    );
    expect(v2Digest).not.toBe(v1Digest);
  });
});
