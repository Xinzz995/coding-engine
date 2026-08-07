import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { runLoop as runProductionLoop } from './loop.js';
import { readEvidence } from './evidence.js';
import { setup, story, fakeBoundValidator, strictConfig } from './loop-test-support.js';
import { FAKE_RUNNER_INPUT_SOURCE } from './loop-test-support.js';
import { QUARANTINE_FILE } from '../workspace-safety/quarantine.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from '../workspace-safety/types.js';

function expectIsolatedWithoutIteration(workspace: string): void {
  const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
  expect(existsSync(join(operation, QUARANTINE_FILE))).toBe(true);
  expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
  expect(readEvidence(workspace).records.some((record) => record.type === 'iteration')).toBe(false);
}

function discardingOutput(): Writable {
  return new Writable({
    write(_chunk, _encoding, callback): void {
      callback();
    },
  });
}

describe('runLoop structured validation protocol', { timeout: 30_000, concurrent: false }, () => {
  it('does not run Validator or return 5 when Developer leaves no passing candidate', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([
      story({ acceptanceCriteria: ['返回 401'] }),
    ]);
    const fake = join(workspace, 'fake-builder-without-candidate.mjs');
    const calls = join(projectRoot, 'builder-without-candidate-calls.txt');
    writeFileSync(
      fake,
      `
      import { appendFileSync } from 'node:fs';
      ${FAKE_RUNNER_INPUT_SOURCE}
      appendFileSync(${JSON.stringify(calls)}, 'builder\\n');
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder made progress\\n');
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(1);
      expect(readFileSync(calls, 'utf8')).toBe('builder\n');
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: false,
        validated: false,
        validationReceipt: null,
        retryCount: 0,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderRan: true,
        validatorRan: false,
        validatorOutcome: 'skipped',
      });
      expect(iteration).not.toHaveProperty('validationProtocol');
      expect(iteration).not.toHaveProperty('validationProtocolError');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('preserves a validation-only candidate and retry count when Validator is unverifiable', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([
      story({ acceptanceCriteria: ['返回 401'] }),
    ]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
          validationReceipt: null,
          notes: 'existing candidate',
          retryCount: 2,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const fake = fakeBoundValidator(workspace, 'missing');
    writeFileSync(join(projectRoot, 'bound-calls.txt'), '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runProductionLoop({
          ...strictConfig(workspace, instructionsDir),
          maxIterations: 3,
        }),
      ).toBe(5);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
        notes: 'existing candidate',
        retryCount: 2,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderRan: false,
        validatorRan: true,
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'missing-result' },
      });
      expect(iteration).not.toHaveProperty('validationRollback');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('clears a validation-only candidate and increments retry only for a valid failed claim', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([
      story({ acceptanceCriteria: ['返回 401'] }),
    ]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
          validationReceipt: null,
          notes: 'existing candidate',
          retryCount: 2,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const fake = fakeBoundValidator(workspace, 'failed');
    writeFileSync(join(projectRoot, 'bound-calls.txt'), '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runProductionLoop({
          ...strictConfig(workspace, instructionsDir),
          maxIterations: 3,
        }),
      ).toBe(1);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: false, validated: false, validationReceipt: null, retryCount: 3 });
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        builderRan: false,
        validatorRan: true,
        validationProtocol: 'failed',
      });
      expect(readFileSync(join(projectRoot, 'bound-calls.txt'), 'utf8')).toBe('2');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('stops at blocked after a fifth validation-only Validator failure without Developer', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([
      story({ acceptanceCriteria: ['返回 401'] }),
    ]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
          validationReceipt: null,
          notes: 'existing candidate',
          retryCount: 4,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const fake = fakeBoundValidator(workspace, 'failed');
    writeFileSync(join(projectRoot, 'bound-calls.txt'), '1');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(
        await runProductionLoop({
          ...strictConfig(workspace, instructionsDir),
          maxIterations: 3,
        }),
      ).toBe(3);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: false, retryCount: 5, blocked: true });
      expect(readFileSync(join(projectRoot, 'bound-calls.txt'), 'utf8')).toBe('2');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('issues a receipt only for a fresh, fully bound passed claim', async () => {
    const { workspace, instructionsDir } = setup([
      story({
        acceptanceCriteria: ['返回 401', '记录 request id'],
      }),
    ]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(0);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: true, validated: true, retryCount: 0 });
      const records = readEvidence(workspace).records;
      expect(records.find((r) => r.type === 'iteration')).toMatchObject({
        validationProtocol: 'passed',
        validationReceipt: true,
        validationTarget: { storyId: 'US-001', acceptanceHash: expect.stringMatching(/^sha256:/) },
        builderInvocation: { durationMs: expect.any(Number), exitCode: 0 },
        validatorInvocation: { durationMs: expect.any(Number), exitCode: 0 },
      });
      expect(records.find((r) => r.type === 'iteration')).not.toHaveProperty(
        'builderInvocation.diagnosticTail',
      );
      expect(records.find((r) => r.type === 'iteration')).not.toHaveProperty(
        'validatorInvocation.diagnosticTail',
      );
      expect(records.find((r) => r.type === 'validation-claim')).toMatchObject({
        source: 'validator',
        storyId: 'US-001',
        verdict: 'passed',
        checks: [
          { acIndex: 1, passed: true },
          { acIndex: 2, passed: true },
        ],
      });
      expect(existsSync(join(workspace, 'validation-result.json'))).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('lets the engine apply a valid failed claim without Validator editing state', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'failed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(1);
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'];
      expect(state).toMatchObject({
        passes: false,
        validated: false,
        retryCount: 1,
        blocked: false,
      });
      expect(state.notes).toContain('[验证失败 - 第1次]');
      expect(state.notes).toContain('expected 401, received 200');
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        validationProtocol: 'failed',
        validatorOutcome: 'completed',
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
      expect(iteration).not.toHaveProperty('validationRollback');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('clears a stale result and fails closed when this Validator writes no result', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    writeFileSync(join(workspace, 'validation-result.json'), JSON.stringify({ stale: true }));
    const fake = fakeBoundValidator(workspace, 'missing');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(5);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
        retryCount: 0,
      });
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'missing-result' },
      });
      expect(
        readEvidence(workspace).records.find((r) => r.type === 'iteration'),
      ).not.toHaveProperty('validationRollback');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('treats a bounded result bound to another story as unverifiable without isolating workspace', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'wrong-story');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(5);
      expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: true, validated: false, validationReceipt: null, retryCount: 0 });
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validatorOutcome: 'completed',
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'binding-mismatch' },
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it.each([
    ['invalid-json', 'invalid-json'],
    ['oversized', 'result-too-large'],
  ] as const)(
    'treats a %s result as unverifiable without consuming the candidate',
    async (mode, code) => {
      const { workspace, instructionsDir } = setup([
        story({ acceptanceCriteria: ['返回 401'] }),
      ]);
      const fake = fakeBoundValidator(workspace, mode);
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

      try {
        expect(
          await runProductionLoop({
            ...strictConfig(workspace, instructionsDir),
            validatorOutputForTests: {
              stdout: discardingOutput(),
              stderr: discardingOutput(),
            },
          }),
        ).toBe(5);
        expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
        expect(
          JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
        ).toMatchObject({
          passes: true,
          validated: false,
          validationReceipt: null,
          retryCount: 0,
        });
        expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
          validatorOutcome: 'completed',
          validationProtocol: 'invalid',
          validationProtocolError: { code },
        });
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
  );

  it('isolates a Validator that mutates state.json even when it also writes a valid claim', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'state-mutation');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'].notes).toBe(
        'Validator 越权改写',
      );
      expectIsolatedWithoutIteration(workspace);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rejects a well-shaped result when the Validator process exits abnormally', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'aborted-after-result');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(5);
      const records = readEvidence(workspace).records;
      expect(records.find((r) => r.type === 'iteration')).toMatchObject({
        validatorOutcome: 'error',
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'agent-aborted' },
      });
      expect(records.find((r) => r.type === 'iteration')).not.toHaveProperty('abortRollback');
      expect(records.some((r) => r.type === 'validation-claim')).toBe(false);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: true, validated: false, validationReceipt: null, retryCount: 0 });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('returns 5 and preserves the candidate when Validator exits 101 without a result', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'exit101-no-result');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(5);
      const records = readEvidence(workspace).records;
      expect(records.find((r) => r.type === 'iteration')).toMatchObject({
        validatorOutcome: 'error',
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'agent-aborted' },
      });
      expect(records.some((r) => r.type === 'validation-claim')).toBe(false);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
        retryCount: 0,
        validatorUnverifiable: { schemaVersion: 1 },
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it(
    'returns 5 with a durable marker and no receipt after bounded output overflow is safely contained',
    async () => {
      const { workspace, instructionsDir } = setup([
        story({ acceptanceCriteria: ['返回 401'] }),
      ]);
      const fake = fakeBoundValidator(workspace, 'output-overflow');
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

      try {
        expect(
          await runProductionLoop({
            ...strictConfig(workspace, instructionsDir),
            validatorOutputForTests: {
              stdout: discardingOutput(),
              stderr: discardingOutput(),
            },
          }),
        ).toBe(5);
        expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
        expect(
          JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
        ).toMatchObject({
          passes: true,
          validated: false,
          validationReceipt: null,
          retryCount: 0,
          validatorUnverifiable: { schemaVersion: 1 },
        });
        const records = readEvidence(workspace).records;
        expect(records.some((record) => record.type === 'validation-claim')).toBe(false);
        expect(records.find((record) => record.type === 'iteration')).toMatchObject({
          validatorOutcome: 'error',
          validationProtocol: 'invalid',
          validationProtocolError: {
            code: 'agent-aborted',
            diagnostic: expect.stringContaining('输出通道失败'),
          },
          validatorInvocation: {
            exitCode: null,
            diagnosticTail: expect.any(String),
          },
        });
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    60_000,
  );

  it(
    'returns 5 with no receipt when an asynchronous terminal write failure is safely contained',
    async () => {
      const { workspace, instructionsDir } = setup([
        story({ acceptanceCriteria: ['返回 401'] }),
      ]);
      const fake = fakeBoundValidator(workspace, 'output-then-missing');
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
      const failingStdout = new Writable({
        write(_chunk, _encoding, callback): void {
          setImmediate(() => callback(new Error('terminal-write-failed')));
        },
      });

      try {
        expect(
          await runProductionLoop({
            ...strictConfig(workspace, instructionsDir),
            validatorOutputForTests: {
              stdout: failingStdout,
              stderr: discardingOutput(),
            },
          }),
        ).toBe(5);
        expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
        const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'];
        expect(state).toMatchObject({
          passes: true,
          validated: false,
          validationReceipt: null,
          retryCount: 0,
          validatorUnverifiable: { schemaVersion: 1 },
        });
        const records = readEvidence(workspace).records;
        expect(records.some((record) => record.type === 'validation-claim')).toBe(false);
        expect(records.find((record) => record.type === 'iteration')).toMatchObject({
          validatorOutcome: 'error',
          validationProtocol: 'invalid',
          validationProtocolError: {
            code: 'agent-aborted',
            diagnostic: 'Validator 输出通道失败后被终止',
          },
          validatorInvocation: {
            exitCode: null,
            diagnosticTail: 'validator output before sink failure',
          },
        });
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
    60_000,
  );
});
