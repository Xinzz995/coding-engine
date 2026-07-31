import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { DelegationContract } from '../baseline.js';
import { delegationContractForOperation } from '../operation.js';

const cleanup: string[] = [];

export const OWNER_ID = '123e4567-e89b-42d3-a456-426614174000';
export const OPERATION_ID = '223e4567-e89b-42d3-a456-426614174000';
export const REQUEST_ID = '323e4567-e89b-42d3-a456-426614174000';
export const STORY_ID = 'US-001';
export const ACCEPTANCE_HASH = `sha256:${'a'.repeat(64)}`;
export const GIT_HEAD = 'b'.repeat(40);

export function cleanupBaselineWorkspaces(): void {
  for (const path of cleanup.splice(0)) rmSync(path, { recursive: true, force: true });
}

export function baselineWorkspace(): string {
  const path = mkdtempSync(join(tmpdir(), 'coding-x-baseline-'));
  cleanup.push(path);
  return path;
}

export function genericContract(rules: DelegationContract['rules']): DelegationContract {
  return { version: 'test-v1', semantic: { version: 'read-only-v1' }, rules };
}

export function builderContract(): DelegationContract {
  return delegationContractForOperation({
    kind: 'builder',
    delegation: 'builder-v1',
    storyId: STORY_ID,
    acceptanceHash: ACCEPTANCE_HASH,
    checkCount: 1,
  });
}

export function validatorContract(): DelegationContract {
  return delegationContractForOperation({
    kind: 'validator',
    delegation: 'validator-v1',
    storyId: STORY_ID,
    requestId: REQUEST_ID,
    acceptanceHash: ACCEPTANCE_HASH,
    checkCount: 1,
    gitHead: GIT_HEAD,
  });
}

export function writeValidState(root: string, overrides: Record<string, unknown> = {}): void {
  writeFileSync(
    join(root, 'state.json'),
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
  mkdirSync(join(root, 'screenshots'), { recursive: true });
}

export function validationResult(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    version: 1,
    requestId: REQUEST_ID,
    storyId: STORY_ID,
    acceptanceHash: ACCEPTANCE_HASH,
    gitHead: GIT_HEAD,
    verdict: 'passed',
    checks: [{ acIndex: 1, passed: true, evidence: 'verified' }],
    summary: 'verified',
    ...overrides,
  });
}
