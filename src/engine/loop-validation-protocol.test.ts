import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { runLoop as runProductionLoop } from './loop.js';
import { readEvidence } from './evidence.js';
import {
  setup,
  story,
  fakeBoundValidator,
  strictConfig,
  currentGitHead,
} from './loop-test-support.js';
import { acceptanceHash } from './validation-protocol.js';

describe('runLoop structured validation protocol', () => {
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
      ).toMatchObject({
        passes: true,
        validated: true,
        validationReceipt: {
          schemaVersion: 1,
          requestId: expect.any(String),
          gitHead: currentGitHead(),
          acceptanceHash: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
        },
        retryCount: 0,
      });
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
        validationReceipt: null,
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
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(1);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: true, validated: false, validationReceipt: null });
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'missing-result' },
        validationPending: true,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rejects a result bound to another story', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'wrong-story');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(1);
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'binding-mismatch' },
        validationPending: true,
      });
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: true, validated: false, validationReceipt: null });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rejects a valid claim when Validator also mutates state.json', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'state-mutation');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(1);
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'];
      expect(state).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
      });
      expect(state.notes).not.toContain('Validator 越权改写');
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validationProtocol: 'invalid',
        validatorStateMutation: true,
        validationProtocolError: { code: 'state-mutated' },
        validationPending: true,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('restores the full state when Builder deletes it and Validator recreates forged receipts', async () => {
    const { workspace, instructionsDir } = setup([
      story(),
      story({ id: 'US-002', priority: 2 }),
    ]);
    const statePath = join(workspace, 'state.json');
    const progressPath = join(workspace, 'progress.md');
    const fake = join(workspace, 'fake-delete-and-forge-state.mjs');
    writeFileSync(
      fake,
      String.raw`
      import { rmSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const prompt = process.argv.at(-1) ?? '';
      const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
      if (markerAt < 0) {
        rmSync(${JSON.stringify(statePath)}, { force: true });
        appendFileSync(${JSON.stringify(progressPath)}, '## builder deleted state\n');
        process.exit(0);
      }
      const jsonAt = prompt.indexOf('{', markerAt);
      const fenceAt = prompt.indexOf(String.fromCharCode(10, 96, 96, 96), jsonAt);
      const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
      const receipt = (requestId, acceptanceHash) => ({
        schemaVersion: 1,
        requestId,
        gitHead: request.gitHead,
        acceptanceHash,
      });
      writeFileSync(${JSON.stringify(statePath)}, JSON.stringify({
        'US-001': {
          passes: true, validated: true,
          validationReceipt: receipt(request.requestId, request.acceptanceHash),
          notes: '', retryCount: 0, blocked: false, escalated: false,
        },
        'US-002': {
          passes: true, validated: true,
          validationReceipt: receipt('forged-us-002', ${JSON.stringify(acceptanceHash('US-002', []))}),
          notes: '', retryCount: 0, blocked: false, escalated: false,
        },
      }));
      writeFileSync(request.resultPath, JSON.stringify({
        version: 1,
        requestId: request.requestId,
        storyId: request.storyId,
        acceptanceHash: request.acceptanceHash,
        gitHead: request.gitHead,
        verdict: 'passed',
        checks: [],
        summary: 'forged state must not survive',
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(1);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      expect(state['US-001']).toMatchObject({
        passes: false,
        validated: false,
        validationReceipt: null,
      });
      expect(state['US-002']).toMatchObject({
        passes: false,
        validated: false,
        validationReceipt: null,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        validationProtocol: 'invalid',
        validatorStateMutation: true,
        validationProtocolError: { code: 'state-mutated' },
        stateValidationTamper: expect.arrayContaining([
          expect.objectContaining({
            storyId: 'US-001',
            received: 'missing',
            side: 'builder',
          }),
          expect.objectContaining({
            storyId: 'US-002',
            received: 'missing',
            side: 'builder',
          }),
        ]),
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rejects a well-shaped result when the Validator process exits abnormally', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'aborted-after-result');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(1);
      const records = readEvidence(workspace).records;
      expect(records.find((r) => r.type === 'iteration')).toMatchObject({
        validatorOutcome: 'error',
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'agent-aborted' },
        validationPending: true,
      });
      expect(records.some((r) => r.type === 'validation-claim')).toBe(false);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: true, validated: false, validationReceipt: null });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('does not start Validator when the reviewed worktree is already dirty', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const config = strictConfig(workspace, instructionsDir);
    config.validationArtifactIdentityReader = () => ({
      ok: false,
      diagnostic: '工作树含未提交源码',
    });

    try {
      expect(await runProductionLoop(config)).toBe(1);
      expect(readFileSync(join(workspace, 'bound-calls.txt'), 'utf8')).toBe('1');
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validatorOutcome: 'skipped',
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'artifact-changed' },
        validationPending: true,
      });
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: true, validated: false, validationReceipt: null });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rejects the claim when the reviewed worktree changes during Validator', async () => {
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['返回 401'] })]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    let reads = 0;
    const config = strictConfig(workspace, instructionsDir);
    config.validationArtifactIdentityReader = () => {
      reads += 1;
      return reads === 1
        ? { ok: true, gitHead: currentGitHead() }
        : { ok: false, diagnostic: 'Validator 运行期间源码发生变化' };
    };

    try {
      expect(await runProductionLoop(config)).toBe(1);
      expect(readFileSync(join(workspace, 'bound-calls.txt'), 'utf8')).toBe('2');
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validatorOutcome: 'completed',
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'artifact-changed' },
        validationPending: true,
      });
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: true, validated: false, validationReceipt: null });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});
