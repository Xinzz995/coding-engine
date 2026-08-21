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
      source: 'engine-effective-gate',
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

  it('binds a scoped result to the exact change manifest and selected check ids', () => {
    const base = input();
    base.contract.checks = {
      test: {
        checks: [
          {
            id: 'docs-health',
            module: 'root',
            paths: ['docs/**'],
            command: {
              executable: 'node',
              args: ['docs-health.mjs'],
              cwd: '.',
              platforms: ['linux'],
              timeoutMs: 5_000,
            },
          },
          {
            id: 'tests',
            module: 'root',
            paths: ['src/**'],
            command: {
              executable: 'node',
              args: ['tests.mjs'],
              cwd: '.',
              platforms: ['linux'],
              timeoutMs: 5_000,
            },
          },
        ],
      },
      build: { notApplicable: 'fixture' },
      static: { notApplicable: 'fixture' },
      security: { notApplicable: 'fixture' },
    };
    const scoped: FullGateInput = {
      ...base,
      changeScope: {
        baseGitHead: 'b'.repeat(40),
        manifestDigest: `sha256:${'c'.repeat(64)}`,
        selectedCheckIds: ['docs-health'],
      },
    };
    const result: ContractGateResult = {
      ok: true,
      failure: null,
      total: 1,
      ran: 1,
      ms: 25,
      skipped: ['tests'],
      skippedByPath: ['tests'],
      selectionMode: 'scoped',
      selectedCheckIds: ['docs-health'],
    };
    const proof = createFullGateProof(scoped, result);
    expect(reusableFullGateResult(proof, { ...scoped, changeScope: undefined }, 'b'.repeat(40)))
      .toEqual(result);
    expect(
      reusableFullGateResult(proof, { ...scoped, changeScope: undefined }, 'd'.repeat(40)),
    ).toBeNull();
    expect(engineQualityGateEvidence(proof)).toMatchObject({
      schemaVersion: 3,
      selectionMode: 'scoped',
      changeBaseGitHead: 'b'.repeat(40),
      changeManifestDigest: `sha256:${'c'.repeat(64)}`,
      checks: [{ id: 'docs-health' }],
      skippedCheckIds: ['tests'],
    });
  });

  it('does not reuse the same check ids when the ready Issue selection reason changes', () => {
    const original = input({
      selectionRequirement: { mode: 'scoped', checkIds: ['tests'] },
      changeScope: {
        baseGitHead: 'b'.repeat(40),
        manifestDigest: `sha256:${'c'.repeat(64)}`,
        selectedCheckIds: ['tests'],
        selectionReasons: [{ checkId: 'tests', sources: ['path', 'explicit'] }],
      },
    });
    const declared = (['test', 'build', 'static', 'security'] as const).flatMap((category) => {
      const policy = original.contract.checks[category];
      return 'checks' in policy ? policy.checks : [];
    });
    const skippedByPlatform = declared
      .filter((check) => !check.command.platforms.includes('linux'))
      .map((check) => check.id);
    const skippedByPath = declared
      .filter((check) => check.command.platforms.includes('linux') && check.id !== 'tests')
      .map((check) => check.id);
    const skipped = [...skippedByPlatform, ...skippedByPath];
    const result: ContractGateResult = {
      ok: true,
      failure: null,
      total: 1,
      ran: 1,
      ms: 10,
      skipped,
      skippedByPath,
      selectionMode: 'scoped',
      selectedCheckIds: ['tests'],
      selectionRequirement: { mode: 'scoped', checkIds: ['tests'] },
      selectionReasons: [{ checkId: 'tests', sources: ['path', 'explicit'] }],
    };
    const proof = createFullGateProof(original, result);
    expect(
      reusableFullGateResult(
        proof,
        { ...original, changeScope: undefined },
        'b'.repeat(40),
      ),
    ).toEqual(result);
    expect(
      reusableFullGateResult(
        proof,
        {
          ...original,
          selectionRequirement: { mode: 'scoped', checkIds: [] },
          changeScope: undefined,
        },
        'b'.repeat(40),
      ),
    ).toBeNull();
  });

  it('rejects a proof that names an explicit requirement without selecting it explicitly', () => {
    const original = input();
    const policy = original.contract.checks.test;
    if (!('checks' in policy) || policy.checks.length < 2) {
      throw new Error('fixture requires at least two test checks');
    }
    const selected = policy.checks[0].id;
    const required = policy.checks[1].id;
    const skipped = (['test', 'build', 'static', 'security'] as const)
      .flatMap((category) => {
        const group = original.contract.checks[category];
        return 'checks' in group ? group.checks : [];
      })
      .filter((check) => check.id !== selected)
      .map((check) => check.id);
    const bound: FullGateInput = {
      ...original,
      selectionRequirement: { mode: 'scoped', checkIds: [required] },
      changeScope: {
        baseGitHead: 'b'.repeat(40),
        manifestDigest: `sha256:${'c'.repeat(64)}`,
        selectedCheckIds: [selected],
        selectionReasons: [{ checkId: selected, sources: ['path'] }],
      },
    };
    expect(() =>
      createFullGateProof(bound, {
        ok: true,
        failure: null,
        total: 1,
        ran: 1,
        ms: 1,
        skipped,
        skippedByPath: skipped,
        selectionMode: 'scoped',
        selectedCheckIds: [selected],
        selectionRequirement: { mode: 'scoped', checkIds: [required] },
        selectionReasons: [{ checkId: selected, sources: ['path'] }],
      }),
    ).toThrow('显式检查要求');
  });
});
