import { describe, expect, it } from 'vitest';
import { acceptanceHash } from '../contracts/validation-contract.js';
import { CODING_X_VERSION } from '../version.js';
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
const DEFAULT_BRANCH_HEAD = 'd'.repeat(40);
const STORY_BASE_HEAD = 'e'.repeat(40);
const QUALITY_DIGEST = `sha256:${'b'.repeat(64)}`;
const OTHER_QUALITY_DIGEST = `sha256:${'c'.repeat(64)}`;
const FORMAL_RUNTIME = {
  mode: 'formal',
  actualCodingXVersion: CODING_X_VERSION,
} as const;

const contract = {
  checks: {
    test: { notApplicable: 'fixture' },
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
  },
  generatedPaths: [],
  localValidation: { prepare: [], allowedPaths: [] },
  repository: { defaultBranch: 'main' },
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
        schemaVersion: 4,
        requestId: 'request-1',
        gitHead: HEAD,
        acceptanceHash: acceptanceHash('US-001', ['works']),
        validationEnvironmentDigest: environmentDigest,
        runnerProfileDigest: `sha256:${'d'.repeat(64)}`,
        canaryEvidenceDigest: `sha256:${'c'.repeat(64)}`,
        storyBaseGitHead: STORY_BASE_HEAD,
        changeManifestDigest: `sha256:${'f'.repeat(64)}`,
        changedPathCount: 1,
      },
      storyBaseGitHead: STORY_BASE_HEAD,
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
    defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
    tddConfig: null,
    runtimeIdentity: FORMAL_RUNTIME,
    platform: 'linux',
  });
  return {
    prd: prd(),
    state: state(environmentDigest),
    stateStatus: 'ready' as const,
    headSha: HEAD,
    defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
    workingContract: readyContract(),
    trackedContract: readyContract(),
    platform: 'linux' as const,
    runtimeIdentity: FORMAL_RUNTIME,
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
      defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
      tddConfig: null,
      runtimeIdentity: FORMAL_RUNTIME,
      platform: 'linux',
    });
    const mechanical = digestFinalReviewMechanicalEnvironment({
      contract,
      headSha: HEAD,
      defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
      platform: 'linux',
    });

    expect(candidate).not.toBe(mechanical);
    expect(candidateStoryValidationEnvironmentPolicy(null, contract, DEFAULT_BRANCH_HEAD)).toEqual({
      additionalRefs: [DEFAULT_BRANCH_HEAD],
      referenceAliases: [
        { ref: 'refs/remotes/origin/main', target: DEFAULT_BRANCH_HEAD },
      ],
      additionalPolicy: { domain: 'story-validation-v3', tdd: null },
    });
  });

  it('separates formal, shadow, and candidate-version receipt environments', () => {
    const digestFor = (mode: 'formal' | 'shadow', actualCodingXVersion: string) =>
      digestCandidateStoryValidationEnvironment({
        contract,
        headSha: HEAD,
        defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
        tddConfig: null,
        platform: 'linux',
        runtimeIdentity: { mode, actualCodingXVersion },
      });
    const formal = digestFor('formal', '0.34.0');
    const shadow = digestFor('shadow', '0.34.0');
    const nextShadow = digestFor('shadow', '0.35.0');

    expect(formal).not.toBe(shadow);
    expect(shadow).not.toBe(nextShadow);
    expect(digestFor('shadow', '0.34.0')).toBe(shadow);
  });

  it('separates two candidate packages even when their semantic version is identical', () => {
    const digestFor = (candidateIdentityDigest: string) =>
      digestCandidateStoryValidationEnvironment({
        contract,
        headSha: HEAD,
        defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
        tddConfig: null,
        platform: 'linux',
        runtimeIdentity: {
          mode: 'shadow',
          actualCodingXVersion: '0.35.0',
          candidateIdentityDigest,
        },
      });

    expect(digestFor(`sha256:${'a'.repeat(64)}`)).not.toBe(
      digestFor(`sha256:${'b'.repeat(64)}`),
    );
  });

  it('expires a shadow receipt in formal mode and in another candidate version', () => {
    const shadowRuntime = { mode: 'shadow', actualCodingXVersion: '0.34.0' } as const;
    const shadowDigest = digestCandidateStoryValidationEnvironment({
      contract,
      headSha: HEAD,
      defaultBranchGitHead: DEFAULT_BRANCH_HEAD,
      tddConfig: null,
      platform: 'linux',
      runtimeIdentity: shadowRuntime,
    });
    const original = input({ state: state(shadowDigest), runtimeIdentity: shadowRuntime });
    expect(evaluateStoryValidationCurrentness(original)).toMatchObject({
      status: 'ready',
      display: { currentness: { current: true } },
    });

    for (const runtimeIdentity of [
      FORMAL_RUNTIME,
      { mode: 'shadow', actualCodingXVersion: '0.35.0' } as const,
    ]) {
      const evaluated = evaluateStoryValidationCurrentness({ ...original, runtimeIdentity });
      expect(evaluated).toMatchObject({
        status: 'ready',
        storyValidationDigest: null,
        display: {
          currentness: { current: false, invalidStoryIds: ['US-001'] },
          state: { 'US-001': { passes: true, validated: false, validationReceipt: null } },
        },
      });
    }
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
