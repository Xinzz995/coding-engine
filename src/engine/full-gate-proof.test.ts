import { describe, expect, it } from 'vitest';
import { readQualityContract, type QualityContract } from '../quality/contract.js';
import type { ContractGateResult } from './gate.js';
import {
  createFullGateProof,
  engineQualityGateEvidence,
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

function passedFor(value: FullGateInput): ContractGateResult {
  const declared = (['test', 'build', 'static', 'security'] as const).flatMap((category) => {
    const policy = value.contract.checks[category];
    return 'checks' in policy ? policy.checks : [];
  });
  const platform = value.platform ?? 'linux';
  const total = declared.filter((check) => check.command.platforms.includes(platform)).length;
  return {
    ok: true,
    failure: null,
    total,
    ran: total,
    ms: 50,
    skipped: declared
      .filter((check) => !check.command.platforms.includes(platform))
      .map((check) => check.id),
  };
}

describe('full gate proof', () => {
  it('reuses a complete result only for the exact same effective input', () => {
    const original = input();
    const passed = passedFor(original);
    const proof = createFullGateProof(original, passed);
    expect(reusableFullGateResult(proof, input())).toEqual(passed);
    expect(engineQualityGateEvidence(proof)).toMatchObject({
      source: 'engine-full-gate',
      status: 'passed',
      gitHead: original.headSha,
      defaultBranchGitHead: original.defaultBranchGitHead,
      total: passed.total,
      ran: passed.total,
    });
    expect(proof.checks).toHaveLength(passed.total);

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
    const original = input();
    const passed = passedFor(original);
    expect(() =>
      createFullGateProof(original, {
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
    expect(() => createFullGateProof(original, { ...passed, ran: passed.ran - 1 })).toThrow(
      '完整通过',
    );
    expect(() =>
      createFullGateProof(original, { ...passed, skipped: [...passed.skipped].reverse() }),
    ).toThrow('实际检查范围不一致');
  });
});
