import { describe, it, expect } from 'vitest';
import { existsSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './evidence.js';
import { runLoop as runProductionLoop } from './loop.js';
import type { QualityContract } from '../quality/contract.js';
import {
  currentRepoTdd,
  fakeBoundValidator,
  fakeCounting,
  readyQualityContract,
  runLoop as runLegacyLoop,
  setup,
  story,
  strictConfig,
  TEST_QUALITY_CONTRACT,
  validationReceiptFor,
} from './loop-test-support.js';

const candidate = () => ({
  passes: true,
  validated: false,
  validationReceipt: null,
  notes: 'candidate',
  retryCount: 2,
  blocked: false,
  escalated: false,
});

// These cases exercise real child processes and temporary Git repositories. The
// outer test budget must outlive the loop's own 5-second agent timeout so Vitest
// never starts cleanup while an in-flight child is still settling on Windows.
const HEAD_BINDING_TEST_TIMEOUT_MS = 30_000;

function writeHeadAdvanceScript(
  fixture: ReturnType<typeof setup>,
  filename: string,
  contents: string,
  message: string,
  exitCode = 0,
): string {
  const script = join(fixture.projectRoot, filename);
  writeFileSync(
    script,
    `
    import { writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    const root = process.cwd();
    writeFileSync(join(root, 'source.txt'), ${JSON.stringify(contents)});
    execFileSync('git', ['add', 'source.txt'], { cwd: root });
    execFileSync('git', ['commit', '-q', '-m', ${JSON.stringify(message)}], { cwd: root });
    process.exit(${exitCode});
  `,
  );
  return script;
}

function writeHeadAdvancingValidator(
  fixture: ReturnType<typeof setup>,
  mode: 'valid' | 'missing' | 'invalid' | 'state-mutation',
): { fake: string; marker: string } {
  const fake = join(fixture.workspace, `validator-advances-head-${mode}.mjs`);
  const marker = join(fixture.workspace, `validator-advances-head-${mode}.txt`);
  writeFileSync(
    fake,
    String.raw`
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    const prompt = process.argv.at(-1) ?? '';
    const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
    const jsonAt = prompt.indexOf('{', markerAt);
    const fenceAt = prompt.indexOf(String.fromCharCode(10, 96, 96, 96), jsonAt);
    const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
    appendFileSync(${JSON.stringify(marker)}, 'called\n');
    writeFileSync(join(process.cwd(), 'source.txt'), 'H2 during Validator\n');
    execFileSync('git', ['add', 'source.txt'], { cwd: process.cwd() });
    execFileSync('git', ['commit', '-q', '-m', 'test: Validator advanced HEAD'], {
      cwd: process.cwd(),
    });
    const mode = ${JSON.stringify(mode)};
    if (mode === 'state-mutation') {
      const statePath = join(process.env.CODING_X_WORKSPACE, 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-002'].notes = 'Validator tampered notes';
      writeFileSync(statePath, JSON.stringify(state));
    }
    if (mode === 'invalid') writeFileSync(request.resultPath, '{');
    if (mode === 'valid' || mode === 'state-mutation') writeFileSync(request.resultPath, JSON.stringify({
      version: 1,
      requestId: request.requestId,
      storyId: request.storyId,
      acceptanceHash: request.acceptanceHash,
      gitHead: request.gitHead,
      verdict: 'passed',
      checks: request.acceptanceCriteria.map((_, index) => ({
        acIndex: index + 1,
        passed: true,
        evidence: 'fixture verified',
      })),
      summary: 'passed',
    }));
  `,
  );
  return { fake, marker };
}

function writeBuilderThenHeadAdvancingValidator(fixture: ReturnType<typeof setup>): {
  fake: string;
  calls: string;
} {
  const fake = join(fixture.workspace, 'builder-then-validator-head-drift.mjs');
  const calls = join(fixture.workspace, 'builder-then-validator-head-drift.txt');
  writeFileSync(
    fake,
    String.raw`
    import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
    import { execFileSync } from 'node:child_process';
    import { join } from 'node:path';
    const prompt = process.argv.at(-1) ?? '';
    const statePath = join(process.env.CODING_X_WORKSPACE, 'state.json');
    const progressPath = join(process.env.CODING_X_WORKSPACE, 'progress.md');
    const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
    if (markerAt < 0) {
      appendFileSync(${JSON.stringify(calls)}, 'builder\n');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = true;
      state['US-001'].notes = 'new candidate';
      writeFileSync(statePath, JSON.stringify(state));
      appendFileSync(progressPath, '## builder completed US-001\n');
      process.exit(0);
    }
    appendFileSync(${JSON.stringify(calls)}, 'validator\n');
    const jsonAt = prompt.indexOf('{', markerAt);
    const fenceAt = prompt.indexOf(String.fromCharCode(10, 96, 96, 96), jsonAt);
    const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
    writeFileSync(join(process.cwd(), 'source.txt'), 'H2 during ordinary Validator\n');
    execFileSync('git', ['add', 'source.txt'], { cwd: process.cwd() });
    execFileSync('git', ['commit', '-q', '-m', 'test: ordinary Validator advanced HEAD'], {
      cwd: process.cwd(),
    });
    writeFileSync(request.resultPath, JSON.stringify({
      version: 1,
      requestId: request.requestId,
      storyId: request.storyId,
      acceptanceHash: request.acceptanceHash,
      gitHead: request.gitHead,
      verdict: 'passed',
      checks: request.acceptanceCriteria.map((_, index) => ({
        acIndex: index + 1,
        passed: true,
        evidence: 'fixture verified',
      })),
      summary: 'passed',
    }));
  `,
  );
  return { fake, calls };
}

describe('runLoop Git HEAD validation chain', () => {
  it.each([
    ['successful', 0],
    ['failed', 7],
  ] as const)(
    'treats a %s gate result as unverifiable when the checked HEAD changes',
    async (_label, gateExitCode) => {
      const first = story({ acceptanceCriteria: ['first'] });
      const second = story({ id: 'US-002', acceptanceCriteria: ['second'], priority: 2 });
      const fixture = setup([first, second]);
      const initialHead = fixture.head();
      const gateScript = writeHeadAdvanceScript(
        fixture,
        'commit-during-gate.mjs',
        'H2 from gate\n',
        'test: gate advanced HEAD',
        gateExitCode,
      );
      const digest = `sha256:${'d'.repeat(64)}`;
      const contract = {
        ...TEST_QUALITY_CONTRACT,
        checks: {
          test: {
            checks: [
              {
                id: 'advance-head',
                module: 'root',
                command: {
                  executable: process.execPath,
                  args: [gateScript],
                  cwd: '.',
                  platforms: ['linux', 'macos', 'windows'],
                  timeoutMs: 5000,
                },
              },
            ],
          },
          build: { notApplicable: 'fixture' },
          static: { notApplicable: 'fixture' },
          security: { notApplicable: 'fixture' },
        },
      } as QualityContract;
      const prdPath = join(fixture.workspace, 'prd.json');
      const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      prd.qualityContractDigest = digest;
      prd.qualityChecks = contract.checks;
      writeFileSync(prdPath, JSON.stringify(prd));
      writeFileSync(
        join(fixture.workspace, 'state.json'),
        JSON.stringify({
          'US-001': candidate(),
          'US-002': {
            passes: true,
            validated: true,
            validationReceipt: validationReceiptFor(second, initialHead),
            notes: 'old validated story',
            retryCount: 0,
            blocked: false,
            escalated: false,
          },
        }),
      );
      const { fake, calls } = fakeCounting(fixture.workspace);
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

      try {
        expect(
          await runProductionLoop({
            ...strictConfig(fixture.workspace, fixture.instructionsDir),
            qualityContractReader: () => readyQualityContract(contract, digest),
          }),
        ).toBe(1);
        expect(fixture.head()).not.toBe(initialHead);
        const state = JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'));
        expect(state['US-001']).toMatchObject({ ...candidate(), notes: 'candidate' });
        expect(state['US-002']).toMatchObject({
          passes: true,
          validated: false,
          validationReceipt: null,
          retryCount: 0,
        });
        expect(existsSync(calls)).toBe(false);
        const evidence = readEvidence(fixture.workspace);
        expect(evidence.records.some((record) => record.type === 'gate-run')).toBe(false);
        const iteration = evidence.records.find((record) => record.type === 'iteration');
        expect(iteration).toMatchObject({
          builderRan: false,
          validatorRan: false,
          validatorOutcome: 'skipped',
        });
        expect(iteration).not.toHaveProperty('validationProtocol');
        expect(iteration).not.toHaveProperty('validationProtocolError');
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    HEAD_BINDING_TEST_TIMEOUT_MS,
  );

  it('rolls back a new unvalidated candidate when a gate changes HEAD', async () => {
    const fixture = setup([story()]);
    writeHeadAdvanceScript(
      fixture,
      'commit-during-builder-gate.mjs',
      'H2 after Builder\n',
      'test: Builder gate advanced HEAD',
    );
    const prdPath = join(fixture.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.qualityChecks = ['node commit-during-builder-gate.mjs'];
    writeFileSync(prdPath, JSON.stringify(prd));
    const { fake, calls } = fakeCounting(fixture.workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runLegacyLoop({
          kind: 'claude',
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace: fixture.workspace,
          instructionsDir: fixture.instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(1);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: false,
        validated: false,
        validationReceipt: null,
        retryCount: 0,
      });
      const iteration = readEvidence(fixture.workspace).records.find(
        (record) => record.type === 'iteration',
      );
      expect(iteration).toMatchObject({
        builderRan: true,
        validatorRan: false,
        validatorOutcome: 'skipped',
        validationRollback: true,
      });
      expect(iteration).not.toHaveProperty('validationProtocol');
      expect(iteration).not.toHaveProperty('validationProtocolError');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, HEAD_BINDING_TEST_TIMEOUT_MS);

  it('rechecks HEAD at the exact Validator request boundary', async () => {
    const fixture = setup([story({ acceptanceCriteria: ['works'] })]);
    const marker = join(fixture.workspace, 'validator-called.txt');
    const fake = join(fixture.workspace, 'unexpected-validator.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'called');
    `,
    );
    writeFileSync(
      join(fixture.workspace, 'state.json'),
      JSON.stringify({
        'US-001': candidate(),
      }),
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runProductionLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          beforeValidatorRequestForTests: () => {
            fixture.commitFile(
              'H2 before Validator request\n',
              'test: advance before Validator request',
            );
          },
        }),
      ).toBe(1);
      expect(existsSync(marker)).toBe(false);
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject(candidate());
      const iteration = readEvidence(fixture.workspace).records.find(
        (record) => record.type === 'iteration',
      );
      expect(iteration).toMatchObject({
        builderRan: false,
        validatorRan: false,
        validatorOutcome: 'skipped',
      });
      expect(iteration).not.toHaveProperty('validationProtocol');
      expect(iteration).not.toHaveProperty('validationProtocolError');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, HEAD_BINDING_TEST_TIMEOUT_MS);

  it('rolls back an ordinary Builder candidate at the exact Validator request boundary', async () => {
    const fixture = setup([story({ acceptanceCriteria: ['works'] })]);
    const fake = fakeBoundValidator(fixture.workspace, 'passed');
    const calls = join(fixture.workspace, 'bound-calls.txt');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runProductionLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          beforeValidatorRequestForTests: () => {
            fixture.commitFile(
              'H2 after ordinary Builder\n',
              'test: advance at ordinary Validator request boundary',
            );
          },
        }),
      ).toBe(1);
      expect(readFileSync(calls, 'utf8')).toBe('1');
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: false,
        validated: false,
        validationReceipt: null,
        retryCount: 0,
        blocked: false,
        escalated: false,
      });
      const iteration = readEvidence(fixture.workspace).records.find(
        (record) => record.type === 'iteration',
      );
      expect(iteration).toMatchObject({
        builderRan: true,
        validatorRan: false,
        validatorOutcome: 'skipped',
        validationRollback: true,
      });
      expect(iteration).not.toHaveProperty('validationProtocol');
      expect(iteration).not.toHaveProperty('validationProtocolError');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, HEAD_BINDING_TEST_TIMEOUT_MS);

  it('rolls back a Builder candidate when HEAD becomes unreadable after Developer returns', async () => {
    const fixture = setup([story({ acceptanceCriteria: ['works'] })]);
    const headPath = join(fixture.projectRoot, '.git', 'HEAD');
    const headContents = readFileSync(headPath, 'utf8');
    const calls = join(fixture.workspace, 'builder-removes-head.txt');
    const fake = join(fixture.workspace, 'builder-removes-head.mjs');
    writeFileSync(
      fake,
      `
      import { appendFileSync, readFileSync, unlinkSync, writeFileSync } from 'node:fs';
      import { join } from 'node:path';
      appendFileSync(${JSON.stringify(calls)}, 'builder\\n');
      const statePath = join(process.env.CODING_X_WORKSPACE, 'state.json');
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = true;
      state['US-001'].notes = 'candidate before HEAD failure';
      writeFileSync(statePath, JSON.stringify(state));
      appendFileSync(join(process.env.CODING_X_WORKSPACE, 'progress.md'), 'builder done\\n');
      unlinkSync(join(process.cwd(), '.git', 'HEAD'));
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    let exitCode: number | undefined;

    try {
      exitCode = await runProductionLoop(strictConfig(fixture.workspace, fixture.instructionsDir));
    } finally {
      writeFileSync(headPath, headContents);
      delete process.env.CODING_X_CLAUDE_BIN;
    }

    expect(exitCode).toBe(2);
    expect(readFileSync(calls, 'utf8')).toBe('builder\n');
    expect(
      JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
    ).toMatchObject({
      passes: false,
      validated: false,
      validationReceipt: null,
      retryCount: 0,
      blocked: false,
      escalated: false,
    });
    expect(
      readEvidence(fixture.workspace).records.find((record) => record.type === 'iteration'),
    ).toMatchObject({
      builderRan: true,
      validatorRan: false,
      builderOutcome: 'completed',
      validationRollback: true,
    });
  }, HEAD_BINDING_TEST_TIMEOUT_MS);

  it('fails closed when HEAD becomes unreadable at the Validator request boundary', async () => {
    const fixture = setup([story({ acceptanceCriteria: ['works'] })]);
    const marker = join(fixture.workspace, 'validator-called-without-head.txt');
    const fake = join(fixture.workspace, 'unexpected-validator-without-head.mjs');
    const headPath = join(fixture.projectRoot, '.git', 'HEAD');
    const headContents = readFileSync(headPath, 'utf8');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(marker)}, 'called');
    `,
    );
    writeFileSync(
      join(fixture.workspace, 'state.json'),
      JSON.stringify({
        'US-001': candidate(),
      }),
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    let exitCode: number | undefined;

    try {
      exitCode = await runProductionLoop({
        ...strictConfig(fixture.workspace, fixture.instructionsDir),
        beforeValidatorRequestForTests: () => unlinkSync(headPath),
      });
    } finally {
      writeFileSync(headPath, headContents);
      delete process.env.CODING_X_CLAUDE_BIN;
    }

    expect(exitCode).toBe(1);
    expect(existsSync(marker)).toBe(false);
    expect(
      JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
    ).toMatchObject(candidate());
    const iteration = readEvidence(fixture.workspace).records.find(
      (record) => record.type === 'iteration',
    );
    expect(iteration).toMatchObject({
      builderRan: false,
      validatorRan: false,
      validatorOutcome: 'skipped',
    });
    expect(iteration).not.toHaveProperty('validationProtocol');
    expect(iteration).not.toHaveProperty('validationProtocolError');
  }, HEAD_BINDING_TEST_TIMEOUT_MS);

  it.each(['valid', 'missing', 'invalid', 'state-mutation'] as const)(
    'prioritizes Validator-time HEAD drift over a %s result',
    async (mode) => {
      const first = story({ acceptanceCriteria: ['first'] });
      const second = story({ id: 'US-002', acceptanceCriteria: ['second'], priority: 2 });
      const fixture = setup([first, second]);
      const initialHead = fixture.head();
      writeFileSync(
        join(fixture.workspace, 'state.json'),
        JSON.stringify({
          'US-001': candidate(),
          'US-002': {
            passes: true,
            validated: true,
            validationReceipt: validationReceiptFor(second, initialHead),
            notes: 'old validated story',
            retryCount: 0,
            blocked: false,
            escalated: false,
          },
        }),
      );
      const { fake, marker } = writeHeadAdvancingValidator(fixture, mode);
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
      let finalReviewCalls = 0;

      try {
        expect(
          await runProductionLoop({
            ...strictConfig(fixture.workspace, fixture.instructionsDir),
            finalReviewRunner: async () => {
              finalReviewCalls += 1;
              return { exitCode: 0, message: 'unexpected review' };
            },
          }),
        ).toBe(1);
        expect(readFileSync(marker, 'utf8')).toBe('called\n');
        expect(fixture.head()).not.toBe(initialHead);
        const state = JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'));
        expect(state['US-001']).toMatchObject(candidate());
        expect(state['US-002']).toMatchObject({
          passes: true,
          validated: false,
          validationReceipt: null,
          notes: 'old validated story',
          retryCount: 0,
        });
        expect(finalReviewCalls).toBe(0);
        expect(existsSync(join(fixture.workspace, 'validation-result.json'))).toBe(false);
        const evidence = readEvidence(fixture.workspace).records;
        expect(evidence.some((record) => record.type === 'validation-claim')).toBe(false);
        expect(evidence.find((record) => record.type === 'iteration')).toMatchObject({
          builderRan: false,
          validatorRan: true,
          validatorOutcome: 'completed',
          validationProtocol: 'invalid',
          validationProtocolError: { code: 'artifact-changed' },
        });
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    HEAD_BINDING_TEST_TIMEOUT_MS,
  );

  it('rolls back an ordinary Builder candidate when Validator changes HEAD', async () => {
    const fixture = setup([story({ acceptanceCriteria: ['works'] })]);
    const initialHead = fixture.head();
    const { fake, calls } = writeBuilderThenHeadAdvancingValidator(fixture);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    let finalReviewCalls = 0;

    try {
      expect(
        await runProductionLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          finalReviewRunner: async () => {
            finalReviewCalls += 1;
            return { exitCode: 0, message: 'unexpected review' };
          },
        }),
      ).toBe(1);
      expect(readFileSync(calls, 'utf8')).toBe('builder\nvalidator\n');
      expect(fixture.head()).not.toBe(initialHead);
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: false,
        validated: false,
        validationReceipt: null,
        retryCount: 0,
        blocked: false,
        escalated: false,
      });
      expect(finalReviewCalls).toBe(0);
      expect(existsSync(join(fixture.workspace, 'validation-result.json'))).toBe(false);
      const evidence = readEvidence(fixture.workspace).records;
      expect(evidence.some((record) => record.type === 'validation-claim')).toBe(false);
      expect(evidence.find((record) => record.type === 'iteration')).toMatchObject({
        builderRan: true,
        validatorRan: true,
        validatorOutcome: 'completed',
        validationRollback: true,
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'artifact-changed' },
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, HEAD_BINDING_TEST_TIMEOUT_MS);

  it('reruns the full validation chain on the new HEAD and converges after drift', async () => {
    const target = story({ acceptanceCriteria: ['works'] });
    const fixture = setup([target]);
    const initialHead = fixture.head();
    const gateScript = writeHeadAdvanceScript(
      fixture,
      'commit-once-during-gate.mjs',
      'H2 from first gate\n',
      'test: first gate advanced HEAD',
    );
    const digest = `sha256:${'e'.repeat(64)}`;
    const changingContract = {
      ...TEST_QUALITY_CONTRACT,
      checks: {
        test: {
          checks: [
            {
              id: 'advance-head-once',
              module: 'root',
              command: {
                executable: process.execPath,
                args: [gateScript],
                cwd: '.',
                platforms: ['linux', 'macos', 'windows'],
                timeoutMs: 5000,
              },
            },
          ],
        },
        build: { notApplicable: 'fixture' },
        static: { notApplicable: 'fixture' },
        security: { notApplicable: 'fixture' },
      },
    } as QualityContract;
    const prdPath = join(fixture.workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.qualityContractDigest = digest;
    prd.qualityChecks = changingContract.checks;
    writeFileSync(prdPath, JSON.stringify(prd));
    writeFileSync(
      join(fixture.workspace, 'state.json'),
      JSON.stringify({
        'US-001': candidate(),
      }),
    );
    const firstRunner = fakeCounting(fixture.workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${firstRunner.fake}`;

    try {
      expect(
        await runProductionLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          qualityContractReader: () => readyQualityContract(changingContract, digest),
        }),
      ).toBe(1);
      expect(fixture.head()).not.toBe(initialHead);
      expect(existsSync(firstRunner.calls)).toBe(false);

      const recoveryMarker = join(fixture.workspace, 'recovery-gate-calls.txt');
      const recoveryGate = join(fixture.projectRoot, 'recovery-gate.mjs');
      writeFileSync(
        recoveryGate,
        `
        import { appendFileSync } from 'node:fs';
        appendFileSync(${JSON.stringify(recoveryMarker)}, 'checked\\n');
      `,
      );
      const stableContract = {
        ...TEST_QUALITY_CONTRACT,
        checks: {
          test: {
            checks: [
              {
                id: 'recovery-check',
                module: 'root',
                command: {
                  executable: process.execPath,
                  args: [recoveryGate],
                  cwd: '.',
                  platforms: ['linux', 'macos', 'windows'],
                  timeoutMs: 5000,
                },
              },
            ],
          },
          build: { notApplicable: 'fixture' },
          static: { notApplicable: 'fixture' },
          security: { notApplicable: 'fixture' },
        },
      } as QualityContract;
      const stablePrd = JSON.parse(readFileSync(prdPath, 'utf8'));
      stablePrd.qualityChecks = stableContract.checks;
      writeFileSync(prdPath, JSON.stringify(stablePrd));
      const validator = fakeBoundValidator(fixture.workspace, 'passed');
      const validatorCalls = join(fixture.workspace, 'bound-calls.txt');
      writeFileSync(validatorCalls, '1');
      process.env.CODING_X_CLAUDE_BIN = `node ${validator}`;

      expect(
        await runProductionLoop({
          ...strictConfig(fixture.workspace, fixture.instructionsDir),
          qualityContractReader: () => readyQualityContract(stableContract, digest),
        }),
      ).toBe(0);
      expect(readFileSync(recoveryMarker, 'utf8')).toBe('checked\n');
      expect(readFileSync(validatorCalls, 'utf8')).toBe('2');
      expect(
        JSON.parse(readFileSync(join(fixture.workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: true,
        validationReceipt: { gitHead: fixture.head() },
      });
      const evidence = readEvidence(fixture.workspace).records;
      expect(evidence.filter((record) => record.type === 'iteration')).toHaveLength(2);
      const gateRuns = evidence.filter((record) => record.type === 'gate-run');
      expect(gateRuns).toHaveLength(1);
      expect(gateRuns[0]).toMatchObject({ ok: true, ran: 1 });
      expect(evidence.find((record) => record.type === 'validation-claim')).toMatchObject({
        verdict: 'passed',
        gitHead: fixture.head(),
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, HEAD_BINDING_TEST_TIMEOUT_MS);

  it.each([
    ['successful', 0],
    ['failed', 7],
  ] as const)(
    'treats a %s TDD result as unverifiable when the checked HEAD changes',
    async (_label, tddExitCode) => {
      const fixture = setup([story({ acceptanceCriteria: ['works'] })]);
      const { workspace, instructionsDir } = fixture;
      const initialHead = fixture.head();
      writeHeadAdvanceScript(
        fixture,
        'commit-during-tdd.mjs',
        'H2 from TDD\n',
        'test: TDD advanced HEAD',
        tddExitCode,
      );
      const prdPath = join(workspace, 'prd.json');
      const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
      prd.tdd = currentRepoTdd('node commit-during-tdd.mjs', initialHead);
      writeFileSync(prdPath, JSON.stringify(prd));
      writeFileSync(
        join(workspace, 'state.json'),
        JSON.stringify({
          'US-001': candidate(),
        }),
      );
      const { fake, calls } = fakeCounting(workspace);
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

      try {
        expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(1);
        expect(fixture.head()).not.toBe(initialHead);
        expect(
          JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
        ).toMatchObject(candidate());
        expect(existsSync(calls)).toBe(false);
        const records = readEvidence(workspace).records;
        expect(
          records.some((record) => record.type === 'tdd-gate' && record.phase === 'post-builder'),
        ).toBe(false);
        const iteration = records.find((record) => record.type === 'iteration');
        expect(iteration).toMatchObject({
          builderRan: false,
          validatorRan: false,
          validatorOutcome: 'skipped',
        });
        expect(iteration).not.toHaveProperty('validationProtocol');
        expect(iteration).not.toHaveProperty('validationProtocolError');
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    HEAD_BINDING_TEST_TIMEOUT_MS,
  );
});
