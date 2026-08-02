import { describe, expect, it } from 'vitest';
import { acceptanceHash } from '../contracts/validation-contract.js';
import type { QualityContract, QualityContractReadResult } from '../quality/contract.js';
import type { Prd } from './prd.js';
import type { RunState } from './state.js';
import {
  candidateStoryValidationEnvironmentPolicy,
  digestCandidateStoryValidationEnvironment,
  digestFinalReviewMechanicalEnvironment,
  evaluateStoryValidationCurrentness,
} from './story-validation-currentness.js';

const HEAD = 'a'.repeat(40);
const QUALITY_DIGEST = `sha256:${'b'.repeat(64)}`;
const OTHER_QUALITY_DIGEST = `sha256:${'c'.repeat(64)}`;

const contract = {
  checks: {
    test: { notApplicable: 'fixture' },
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
  },
  generatedPaths: [],
  localValidation: { prepare: [], allowedPaths: [] },
} as unknown as QualityContract;

function readyContract(
  digest = QUALITY_DIGEST,
  value: QualityContract = contract,
): QualityContractReadResult {
  return {
    status: 'ready',
    path: '/project/.coding-x/quality.json',
    contract: value,
    digest,
  };
}

function prd(): Prd {
  return {
    project: 'fixture',
    branchName: 'feature/currentness',
    description: 'fixture',
    qualityContractDigest: QUALITY_DIGEST,
    qualityChecks: structuredClone(contract.checks),
    userStories: [
      {
        id: 'US-001',
        title: 'Story',
        description: 'Description',
        acceptanceCriteria: ['works'],
        priority: 1,
      },
    ],
  };
}

function state(environmentDigest: string): RunState {
  return {
    'US-001': {
      passes: true,
      validated: true,
      validationReceipt: {
        schemaVersion: 2,
        requestId: 'request-1',
        gitHead: HEAD,
        acceptanceHash: acceptanceHash('US-001', ['works']),
        validationEnvironmentDigest: environmentDigest,
      },
      notes: 'keep',
      retryCount: 2,
      blocked: false,
      escalated: false,
    },
  };
}

function input(overrides: Partial<Parameters<typeof evaluateStoryValidationCurrentness>[0]> = {}) {
  const environmentDigest = digestCandidateStoryValidationEnvironment({
    contract,
    headSha: HEAD,
    tddConfig: null,
    platform: 'linux',
  });
  return {
    prd: prd(),
    state: state(environmentDigest),
    stateStatus: 'ready' as const,
    headSha: HEAD,
    workingContract: readyContract(),
    trackedContract: readyContract(),
    platform: 'linux' as const,
    ...overrides,
  };
}

describe('evaluateStoryValidationCurrentness', () => {
  it('binds the current candidate contract, strict TDD policy, HEAD and full receipt set', () => {
    const result = evaluateStoryValidationCurrentness(input());

    expect(result).toMatchObject({
      status: 'ready',
      headSha: HEAD,
      workingContractDigest: QUALITY_DIGEST,
      trackedContractDigest: QUALITY_DIGEST,
      storyValidationEnvironmentDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      storyValidationDigest: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      display: { currentness: { current: true, configurationError: null } },
    });
  });

  it('keeps candidate Story and default-branch mechanical environments in separate domains', () => {
    const candidate = digestCandidateStoryValidationEnvironment({
      contract,
      headSha: HEAD,
      tddConfig: null,
      platform: 'linux',
    });
    const mechanical = digestFinalReviewMechanicalEnvironment({
      contract,
      headSha: HEAD,
      platform: 'linux',
    });

    expect(candidate).not.toBe(mechanical);
    expect(candidateStoryValidationEnvironmentPolicy(null)).toEqual({
      additionalRefs: [],
      additionalPolicy: { domain: 'story-validation-v1', tdd: null },
    });
  });

  it.each([
    {
      name: 'state is missing',
      overrides: { stateStatus: 'missing' as const },
      reason: 'state-missing',
    },
    {
      name: 'tracked and working contracts differ',
      overrides: { trackedContract: readyContract(OTHER_QUALITY_DIGEST) },
      reason: 'contract-mismatch',
    },
    {
      name: 'PRD contract digest is stale',
      overrides: { prd: { ...prd(), qualityContractDigest: OTHER_QUALITY_DIGEST } },
      reason: 'prd-contract-digest-mismatch',
    },
    {
      name: 'PRD quality-check snapshot is stale',
      overrides: {
        prd: {
          ...prd(),
          qualityChecks: {
            ...contract.checks,
            test: { notApplicable: 'changed' },
          },
        },
      },
      reason: 'prd-quality-checks-mismatch',
    },
    {
      name: 'TDD policy is invalid',
      overrides: {
        prd: { ...prd(), tdd: { baselineRef: HEAD } } as unknown as Prd,
      },
      reason: 'tdd-invalid',
    },
    {
      name: 'Story collection is not unique',
      overrides: {
        prd: { ...prd(), userStories: [prd().userStories[0], prd().userStories[0]] },
      },
      reason: 'story-set-invalid',
    },
  ])('fails closed when $name', ({ overrides, reason }) => {
    const original = input(overrides);
    const result = evaluateStoryValidationCurrentness(original);

    expect(result).toMatchObject({
      status: 'unverifiable',
      reason,
      storyValidationEnvironmentDigest: null,
      storyValidationDigest: null,
      display: {
        digest: null,
        currentness: { current: false },
        state: {
          'US-001': {
            passes: true,
            validated: false,
            validationReceipt: null,
            notes: 'keep',
            retryCount: 2,
          },
        },
      },
    });
    expect(original.state['US-001'].validated).toBe(true);
  });
});
