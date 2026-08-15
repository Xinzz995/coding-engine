import { describe, expect, it } from 'vitest';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import type { ContractGateResult } from './gate.js';
import {
  createFullGateProof,
  reusableFullGateResult,
  type FullGateInput,
} from './full-gate-proof.js';

function contract(): QualityContract {
  const read = readQualityContract(process.cwd());
  if (read.status !== 'ready') throw new Error(`contract unavailable: ${read.status}`);
  return structuredClone(read.contract);
}

function input(over: Partial<FullGateInput> = {}): FullGateInput {
  return {
    contract: contract(),
    headSha: 'a'.repeat(40),
    defaultBranchGitHead: 'b'.repeat(40),
    platform: 'linux',
    additionalRefs: ['b'.repeat(40)],
    referenceAliases: [{ ref: 'refs/remotes/origin/main', target: 'b'.repeat(40) }],
    ...over,
  };
}

const passed: ContractGateResult = {
  ok: true,
  failure: null,
  total: 3,
  ran: 3,
  ms: 50,
  skipped: ['windows-only'],
};

describe('full gate proof', () => {
  it('reuses a complete result only for the exact same effective input', () => {
    const original = input();
    const proof = createFullGateProof(original, passed);
    expect(reusableFullGateResult(proof, input())).toEqual(passed);

    const changedContract = contract();
    changedContract.generatedPaths = [...changedContract.generatedPaths, 'different/**'];
    for (const changed of [
      input({ headSha: 'c'.repeat(40) }),
      input({ defaultBranchGitHead: 'd'.repeat(40) }),
      input({ contract: changedContract }),
      input({ platform: 'macos' }),
      input({ additionalRefs: ['b'.repeat(40), 'e'.repeat(40)] }),
    ]) {
      expect(reusableFullGateResult(proof, changed)).toBeNull();
    }
  });

  it('never turns a partial or failed result into a reusable proof', () => {
    expect(() =>
      createFullGateProof(input(), {
        ...passed,
        ok: false,
        ran: 1,
        failure: {
          command: 'test',
          exitCode: 1,
          timedOut: false,
          outputTail: 'failed',
        },
      }),
    ).toThrow('完整通过');
    expect(() => createFullGateProof(input(), { ...passed, ran: 2 })).toThrow('完整通过');
  });
});
