import { describe, it, expect, afterEach, vi } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { runLoop as runProductionLoop, renderInstruction, type LoopConfig } from './loop.js';
import { readEvidence } from './evidence.js';
import { readLockInfo, LOCK_FILE } from './lock.js';
import * as dashboard from '../dashboard/server.js';
import type { QualityContract, QualityContractReadResult } from '../quality/contract.js';
import { CODING_X_VERSION } from '../version.js';
import { writeFinalReviewState } from '../review/state.js';
import { digest } from '../review/common.js';
import type { FinalReviewState } from '../review/types.js';

const TEST_QUALITY_DIGEST = `sha256:${'a'.repeat(64)}`;
const TEST_QUALITY_CONTRACT = {
  codingXVersion: CODING_X_VERSION,
  checks: {
    test: { notApplicable: 'fixture' },
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
  },
} as QualityContract;
const readyQualityContract = (
  contract: QualityContract = TEST_QUALITY_CONTRACT,
  digest = TEST_QUALITY_DIGEST,
): QualityContractReadResult => ({
  status: 'ready',
  path: '/fixture/.coding-x/quality.json',
  contract,
  digest,
});

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
  delete process.env.CODING_X_CONFIG;
});

function setup(prdStories: unknown[], prdExtra: Record<string, unknown> = {}): { workspace: string; instructionsDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'loop-ws-'));
  const instructionsDir = mkdtempSync(join(tmpdir(), 'loop-ins-'));
  cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
  cleanup.push(() => rmSync(instructionsDir, { recursive: true, force: true }));
  writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
    project: 'p', branchName: 'ralph/x', description: 'd', userStories: prdStories,
    qualityContractDigest: TEST_QUALITY_DIGEST,
    qualityChecks: TEST_QUALITY_CONTRACT.checks,
    ...prdExtra,
  }));
  writeFileSync(join(instructionsDir, 'builder.md'), 'build it');
  writeFileSync(join(instructionsDir, 'validator.md'), 'validate it');
  return { workspace, instructionsDir };
}

const story = (over: Record<string, unknown> = {}) => ({
  id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [],
  priority: 1, ...over,
});

const routedStory = (over: Record<string, unknown> = {}) => story({
  difficulty: 'medium',
  difficultyReason: '命中 medium-1：沿用 src/api.ts 的既有接线模式。',
  ...over,
});

const modelConfig = () => ({
  runner: 'claude',
  builder: { low: 'low-m', medium: 'fast-m', high: 'high-m' },
  validator: 'val-m',
  escalation: 'esc-m',
});

const catalogWith = (...ids: string[]) => async () => ({
  status: 'available' as const,
  runner: 'claude' as const,
  source: 'global-config' as const,
  configPath: '/fixture/config.json',
  models: ids.map((id) => ({ id })),
});

const finalReviewPass: NonNullable<LoopConfig['finalReviewRunner']> = async (options) => ({
  exitCode: options.shadow ? 7 : 0,
  message: options.shadow ? 'fixture shadow review' : 'fixture final review passed',
});

function previousFinalReview(headSha: string): FinalReviewState {
  const risk = {
    triggered: false,
    categories: [],
    reasons: [],
    changedFiles: ['src/a.ts'],
    changedModules: ['root'],
  };
  const riskDigest = digest(risk);
  return {
    schemaVersion: 1,
    status: 'passed',
    deliveryStatus: 'ready',
    binding: {
      prNumber: 1,
      targetBranch: 'main',
      baseSha: 'b'.repeat(40),
      headSha,
      prTitleDigest: 'title',
      prBodyDigest: 'body',
      specDigest: 'spec',
      engineeringStandardsDigest: 'standards',
      qualityContractDigest: 'contract',
      codingXVersion: CODING_X_VERSION,
      runner: 'claude',
      model: 'review-model',
      runnerVersion: 'claude-test',
      reviewRulesVersion: '1.0.0',
      reviewRulesDigest: 'rules',
      riskDigest,
    },
    risk: { ...risk, digest: riskDigest },
    axes: [
      {
        axis: 'spec', status: 'passed', summary: 'ok', findings: [],
        requestDeepReview: false, durationMs: 1, attempts: 1,
      },
      {
        axis: 'engineering', status: 'passed', summary: 'ok', findings: [],
        requestDeepReview: false, durationMs: 1, attempts: 1,
      },
    ],
    remote: { status: 'ready', checks: [], rulesetErrors: [], checkedAt: '2026-07-26T00:00:00Z' },
    round: 1,
    shadow: false,
    startedAt: '2026-07-26T00:00:00Z',
    completedAt: '2026-07-26T00:01:00Z',
  };
}

// instruction assets 契约测试共享的文件读取 helper（两个 describe 曾各自重复定义，见 triage#9）。
const read = (f: string) =>
  readFileSync(new URL(`../../assets/instructions/${f}`, import.meta.url), 'utf-8');

// 历史 fixture 让 fake Validator 直接改 state；保留这些状态机回归时必须显式
// opt-in，生产 runLoop 默认始终走结构化 validation protocol。新协议集成测试直接
// 调 runProductionLoop，防止 test-only 兼容路径遮住假绿。
const runLoop = (cfg: LoopConfig): Promise<number> => runProductionLoop({
  ...cfg,
  qualityContractReader: () => readyQualityContract(),
  legacyValidatorProtocolForTests: true,
  finalReviewRunner: cfg.finalReviewRunner ?? finalReviewPass,
});

// builder 与 validator 共用同一 stub 二进制：以调用计数文件区分谁跑了。
function fakeCounting(workspace: string): { fake: string; calls: string } {
  const fake = join(workspace, 'fake.mjs');
  const calls = join(workspace, 'calls.txt');
  writeFileSync(fake, `
    import { writeFileSync, appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(calls)}, 'call\\n');
    writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
    }));
    process.exit(0);
  `);
  return { fake, calls };
}

type BoundValidatorMode =
  | 'passed'
  | 'failed'
  | 'missing'
  | 'wrong-story'
  | 'state-mutation'
  | 'aborted-after-result';

function fakeBoundValidator(workspace: string, mode: BoundValidatorMode): string {
  const fake = join(workspace, `fake-bound-${mode}.mjs`);
  const calls = join(workspace, 'bound-calls.txt');
  const statePath = join(workspace, 'state.json');
  const progressPath = join(workspace, 'progress.md');
  writeFileSync(fake, String.raw`
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    const statePath = ${JSON.stringify(statePath)};
    let call = 1;
    try { call = Number(readFileSync(${JSON.stringify(calls)}, 'utf8')) + 1; } catch {}
    writeFileSync(${JSON.stringify(calls)}, String(call));
    if (call === 1) {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = true;
      state['US-001'].validated = false;
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      appendFileSync(${JSON.stringify(progressPath)}, '## builder completed US-001\n');
      process.exit(0);
    }
    const prompt = process.argv.at(-1) ?? '';
    const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
    const jsonAt = prompt.indexOf('{', markerAt);
    const fenceAt = prompt.indexOf(String.fromCharCode(10, 96, 96, 96), jsonAt);
    if (markerAt < 0 || jsonAt < 0 || fenceAt < 0) process.exit(9);
    const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
    const mode = ${JSON.stringify(mode)};
    if (mode === 'missing') process.exit(0);
    const checks = request.acceptanceCriteria.map((_, index) => ({
      acIndex: index + 1,
      passed: mode !== 'failed' || index !== 0,
      evidence: mode === 'failed' && index === 0 ? 'expected 401, received 200' : 'fixture verified AC',
    }));
    const result = {
      version: 1,
      requestId: request.requestId,
      storyId: mode === 'wrong-story' ? 'US-999' : request.storyId,
      acceptanceHash: request.acceptanceHash,
      gitHead: request.gitHead,
      verdict: mode === 'failed' ? 'failed' : 'passed',
      checks,
      summary: mode === 'failed' ? 'AC 1 未通过' : '全部 AC 通过',
    };
    if (mode === 'state-mutation') {
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].notes = 'Validator 越权改写';
      writeFileSync(statePath, JSON.stringify(state));
    }
    writeFileSync(request.resultPath, JSON.stringify(result));
    process.exit(mode === 'aborted-after-result' ? 1 : 0);
  `);
  return fake;
}

function strictConfig(workspace: string, instructionsDir: string): LoopConfig {
  return {
    kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
    workspace, instructionsDir, port: 0, openBrowser: false, stallLimit: 3,
    qualityContractReader: () => readyQualityContract(),
    finalReviewRunner: finalReviewPass,
  };
}

describe('quality contract preflight and shadow mode', () => {
  it('fails before any Story agent when a production final Review model is not explicit', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    const config = strictConfig(workspace, instructionsDir);
    delete config.finalReviewRunner;

    expect(await runProductionLoop(config)).toBe(2);
    expect(existsSync(fake.calls)).toBe(false);
  });

  it('reruns Story validation when a commit appears after the previous final Review', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': {
        passes: true, validated: true, notes: '', retryCount: 0, blocked: false, escalated: false,
      },
    }));
    writeFinalReviewState(workspace, previousFinalReview('a'.repeat(40)));
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;

    expect(await runLoop(strictConfig(workspace, instructionsDir))).toBe(0);
    expect(readFileSync(fake.calls, 'utf8').trim().split('\n')).toHaveLength(2);
    expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'])
      .toMatchObject({ passes: true, validated: true });
  });

  it.each([
    ['missing', { status: 'missing', path: '/fixture/.coding-x/quality.json' }],
    ['invalid-json', { status: 'invalid-json', path: '/fixture/.coding-x/quality.json', error: 'bad json' }],
    ['invalid', { status: 'invalid', path: '/fixture/.coding-x/quality.json', errors: ['bad schema'] }],
  ] as const)('fails with exit 2 before any agent when the contract is %s', async (_name, result) => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    expect(await runProductionLoop({
      ...strictConfig(workspace, instructionsDir),
      qualityContractReader: () => result as QualityContractReadResult,
    })).toBe(2);
    expect(existsSync(fake.calls)).toBe(false);
  });

  it('rejects a formal version mismatch and a stale PRD contract digest before any agent', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const mismatch = { ...TEST_QUALITY_CONTRACT, codingXVersion: '0.30.0' } as QualityContract;
    expect(await runProductionLoop({
      ...strictConfig(workspace, instructionsDir),
      qualityContractReader: () => readyQualityContract(mismatch),
    })).toBe(2);

    writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
      project: 'p', branchName: 'ralph/x', description: 'd', userStories: [story()],
      qualityContractDigest: `sha256:${'b'.repeat(64)}`,
    }));
    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);
  });

  it('allows a mismatched candidate only in shadow mode and returns 7 instead of delivery-ready', async () => {
    const { workspace, instructionsDir } = setup([story({ passes: true })]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: true, validated: true, notes: '', retryCount: 0, blocked: false, escalated: false },
    }));
    const candidate = { ...TEST_QUALITY_CONTRACT, codingXVersion: '0.30.0' } as QualityContract;
    expect(await runProductionLoop({
      ...strictConfig(workspace, instructionsDir),
      shadow: true,
      qualityContractReader: () => readyQualityContract(candidate),
    })).toBe(7);
  });

  it('rejects a legacy command array or a snapshot that differs from the contract in formal mode', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);

    writeFileSync(join(workspace, 'prd.json'), JSON.stringify({
      project: 'p', branchName: 'ralph/x', description: 'd', userStories: [story()],
      qualityContractDigest: TEST_QUALITY_DIGEST,
      qualityChecks: {
        ...TEST_QUALITY_CONTRACT.checks,
        test: { notApplicable: 'manually weakened' },
      },
    }));
    expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);
  });

  it('stops with exit 2 before Validator when Developer changes the quality contract', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake.fake}`;
    let reads = 0;
    const changedDigest = `sha256:${'c'.repeat(64)}`;
    const code = await runProductionLoop({
      ...strictConfig(workspace, instructionsDir),
      qualityContractReader: () => {
        reads += 1;
        return readyQualityContract(
          TEST_QUALITY_CONTRACT,
          reads >= 3 ? changedDigest : TEST_QUALITY_DIGEST,
        );
      },
    });
    expect(code).toBe(2);
    expect(readFileSync(fake.calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});

function currentRepoTdd(coverageCheck: string): Record<string, unknown> {
  return {
    coverageCheck,
    sourcePathspecs: [':(glob)src/__coding_x_tdd_fixture_only__/**'],
    policyFiles: [],
    baselineRef: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: process.cwd(),
      encoding: 'utf8',
    }).trim(),
    forbiddenAddedPatterns: ['istanbul ignore', 'c8 ignore'],
  };
}

describe('runLoop structured validation protocol', () => {
  it('issues a receipt only for a fresh, fully bound passed claim', async () => {
    const { workspace, instructionsDir } = setup([story({
      acceptanceCriteria: ['返回 401', '记录 request id'],
    })]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(0);
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'])
        .toMatchObject({ passes: true, validated: true, retryCount: 0 });
      const records = readEvidence(workspace).records;
      expect(records.find((r) => r.type === 'iteration')).toMatchObject({
        validationProtocol: 'passed', validationReceipt: true,
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
        source: 'validator', storyId: 'US-001', verdict: 'passed',
        checks: [{ acIndex: 1, passed: true }, { acIndex: 2, passed: true }],
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
      expect(state).toMatchObject({ passes: false, validated: false, retryCount: 1, blocked: false });
      expect(state.notes).toContain('[验证失败 - 第1次]');
      expect(state.notes).toContain('expected 401, received 200');
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({ validationProtocol: 'failed', validatorOutcome: 'completed' });
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
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'])
        .toMatchObject({ passes: false, validated: false });
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validationProtocol: 'invalid',
        validationProtocolError: { code: 'missing-result' },
        validationRollback: true,
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
        validationRollback: true,
      });
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
      expect(state).toMatchObject({ passes: false, validated: false });
      expect(state.notes).not.toContain('Validator 越权改写');
      expect(readEvidence(workspace).records.find((r) => r.type === 'iteration')).toMatchObject({
        validationProtocol: 'invalid', validatorStateMutation: true,
        validationProtocolError: { code: 'state-mutated' },
        validationRollback: true,
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
        validatorOutcome: 'error', validationProtocol: 'invalid',
        validationProtocolError: { code: 'agent-aborted' },
        abortRollback: { storyId: 'US-001' },
      });
      expect(records.some((r) => r.type === 'validation-claim')).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('runLoop', () => {
  it('returns 0 when all stories are already resolved after one pass', async () => {
    // fake agent: developer pass marks the only story passes=true by writing state.json
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, validated: false, notes: '', retryCount: 0, blocked: false, escalated: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'])
      .toMatchObject({ passes: true, validated: true });
    expect(readEvidence(workspace).records.find((r) => r.type === 'iteration'))
      .toMatchObject({ validatorOutcome: 'completed', validationReceipt: true });
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('does not accept a builder-only passes=true when validator.md is missing', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    rmSync(join(instructionsDir, 'validator.md'));
    const fake = join(workspace, 'fake-builder-only.mjs');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, validated: false, notes: '', retryCount: 0, blocked: false, escalated: false },
      }));
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## 2026-07-22 10:00 - US-001\\n');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false, stallLimit: 3,
      });
      expect(code).toBe(1);
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'])
        .toMatchObject({ passes: false, validated: false });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        validatorRan: false, validatorOutcome: 'skipped', validationRollback: true,
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('does not issue a receipt from a restored candidate when validator deletes the story', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-delete-story.mjs');
    const calls = join(workspace, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(fake, `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!existsSync(${JSON.stringify(calls)})) {
        state['US-001'].passes = true;
        writeFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## builder done\\n');
      } else {
        delete state['US-001'];
      }
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001'])
        .toMatchObject({ passes: false, validated: false });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        validatorOutcome: 'completed', validationRollback: true,
        stateValidationTamper: [
          { expected: false, received: 'missing', side: 'validator' },
        ],
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('records field-only validated deletion before issuing a legitimate receipt', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-delete-field.mjs');
    const calls = join(workspace, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(fake, `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!existsSync(${JSON.stringify(calls)})) {
        state['US-001'].passes = true;
        writeFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## builder done\\n');
      } else {
        delete state['US-001'].validated;
      }
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(0);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001'])
        .toMatchObject({ passes: true, validated: true });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        validationReceipt: true,
        stateValidationTamper: [
          { expected: false, received: 'missing', side: 'validator' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('restores builder-forged ownership fields on a non-current story instead of exiting false-green', async () => {
    const { workspace, instructionsDir } = setup([
      story(), story({ id: 'US-002', priority: 2 }),
    ]);
    const fake = join(workspace, 'fake-builder-cross-story.mjs');
    const calls = join(workspace, 'calls.txt');
    const observed = join(workspace, 'call3-passes.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(fake, `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const call = readFileSync(${JSON.stringify(calls)}, 'utf-8').length;
      if (call === 1) {
        state['US-001'].passes = true;
        state['US-002'].passes = true;
        state['US-002'].validated = true;
        state['US-002'].escalated = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## US-001 builder done\\n');
      } else if (call === 3) {
        writeFileSync(${JSON.stringify(observed)}, String(state['US-002'].passes));
        if (state['US-002'].passes !== false) process.exit(0);
        state['US-002'].passes = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## US-002 builder done\\n');
      }
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(0);
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(state['US-001']).toMatchObject({ passes: true, validated: true });
      expect(state['US-002']).toMatchObject({ passes: true, validated: true, escalated: false });
      expect(readFileSync(observed, 'utf-8')).toBe('false');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations).toHaveLength(2);
      const iteration = iterations[0];
      expect(iteration).toMatchObject({
        storyId: 'US-001', validationReceipt: true,
        stateRouteTamper: [
          { storyId: 'US-002', expected: false, received: true, side: 'builder' },
        ],
        stateValidationTamper: [
          { storyId: 'US-002', expected: false, received: true, side: 'builder' },
        ],
      });
      expect(iterations[1]).toMatchObject({ storyId: 'US-002', validationReceipt: true });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('restores validator-forged ownership fields on a non-current story instead of exiting false-green', async () => {
    const { workspace, instructionsDir } = setup([
      story(), story({ id: 'US-002', priority: 2 }),
    ]);
    const fake = join(workspace, 'fake-validator-cross-story.mjs');
    const calls = join(workspace, 'calls.txt');
    const observed = join(workspace, 'call3-passes.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(fake, `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const call = readFileSync(${JSON.stringify(calls)}, 'utf-8').length;
      if (call === 1) {
        state['US-001'].passes = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## US-001 builder done\\n');
      } else if (call === 2) {
        state['US-002'].passes = true;
        state['US-002'].validated = true;
        state['US-002'].escalated = true;
      } else if (call === 3) {
        writeFileSync(${JSON.stringify(observed)}, String(state['US-002'].passes));
        if (state['US-002'].passes !== false) process.exit(0);
        state['US-002'].passes = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## US-002 builder done\\n');
      }
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(0);
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      expect(state['US-001']).toMatchObject({ passes: true, validated: true });
      expect(state['US-002']).toMatchObject({ passes: true, validated: true, escalated: false });
      expect(readFileSync(observed, 'utf-8')).toBe('false');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations).toHaveLength(2);
      const iteration = iterations[0];
      expect(iteration).toMatchObject({
        storyId: 'US-001', validationReceipt: true,
        stateRouteTamper: [
          { storyId: 'US-002', expected: false, received: true, side: 'validator' },
        ],
        stateValidationTamper: [
          { storyId: 'US-002', expected: false, received: true, side: 'validator' },
        ],
      });
      expect(iterations[1]).toMatchObject({ storyId: 'US-002', validationReceipt: true });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('restores a non-current story deleted by the builder and records its real storyId', async () => {
    const { workspace, instructionsDir } = setup([
      story(), story({ id: 'US-002', priority: 2 }),
    ]);
    const fake = join(workspace, 'fake-builder-delete-other.mjs');
    const calls = join(workspace, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(fake, `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (!existsSync(${JSON.stringify(calls)})) {
        state['US-001'].passes = true;
        delete state['US-002'];
        writeFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## builder done\\n');
      }
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-002'])
        .toMatchObject({ passes: false, validated: false, escalated: false });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        stateRouteTamper: [
          { storyId: 'US-002', expected: false, received: 'missing', side: 'builder' },
        ],
        stateValidationTamper: [
          { storyId: 'US-002', expected: false, received: 'missing', side: 'builder' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rolls a crash-left passes=true validated=false back before selecting work', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: true, validated: false, notes: 'builder done', retryCount: 0, blocked: false, escalated: false },
    }));
    const fake = join(workspace, 'fake-noop.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warnings: string[] = [];
    const originalWarn = console.warn;
    console.warn = (...args: unknown[]) => { warnings.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'])
        .toMatchObject({ passes: false, validated: false, notes: 'builder done' });
      expect(warnings.some((line) => line.includes('待验收状态') && line.includes('US-001'))).toBe(true);
    } finally {
      console.warn = originalWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('materializes legacy engine-owned fields before the agent without faking progress or tamper', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const statePath = join(workspace, 'state.json');
    writeFileSync(statePath, JSON.stringify({
      'US-001': { passes: false, notes: '', retryCount: 0, blocked: false },
    }));
    const fake = join(workspace, 'fake-legacy-noop.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001'])
        .toMatchObject({ passes: false, validated: false, escalated: false });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({ builderOutcome: 'completed', noop: true });
      expect(iteration).not.toHaveProperty('stateValidationTamper');
      expect(iteration).not.toHaveProperty('stateRouteTamper');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('enters final review instead of treating story convergence as delivery-ready', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const orig = console.log;
    console.log = (...args: unknown[]) => { logs.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      expect(logs.some((l) => l.includes('开始针对当前 PR 最新提交执行本地最终 Review'))).toBe(true);
      expect(logs.some((l) => l.includes('fixture final review passed'))).toBe(true);
    } finally {
      console.log = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('returns 1 when stories never resolve within maxIterations', async () => {
    const { workspace, instructionsDir } = setup([story()]); // never flips to passes
    // 真实 stub 文件而非 `node -e` 一行式（见 :187 注释：`-e` 后的脚本会被引擎追加的
    // --dangerously-skip-permissions 当成 node 自己的 CLI 选项、以退出码 9 假崩溃）。
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    expect(code).toBe(1);
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('spawns the agent at the project root, not inside the workspace dir', async () => {
    // Regression: runLoop used to pass cwd: cfg.workspace to runAgent, which made
    // the agent resolve `.workspace/prd.json` against `.workspace/` itself
    // (<root>/.workspace/.workspace/prd.json) — engine and agent never shared
    // state, passes:true was never observed, and the loop always hit maxIterations.
    // The engine itself reads prd.json at join(cfg.workspace, 'prd.json') which
    // resolves against the PROCESS cwd (= project root), so the agent must be
    // spawned at process.cwd() too. This fake records its own process.cwd() to a
    // marker file (absolute path) and flips the single story to passes:true so
    // the loop resolves and exits.
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-cwd.mjs');
    const marker = join(workspace, 'agent-cwd.txt');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      const cwd = process.cwd();
      writeFileSync(${JSON.stringify(marker)}, cwd);
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const recorded = readFileSync(marker, 'utf8');
      // The agent must run at the engine process's cwd (project root), NOT at the
      // temp workspace dir — otherwise the engine and agent diverge on prd.json.
      expect(recorded).toBe(process.cwd());
      expect(recorded).not.toBe(workspace);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('renders the actual workspace into the agent prompt instead of a hardcoded path', async () => {
    // The instruction files use the {{WORKSPACE}} placeholder so a custom
    // --workspace path reaches the agent. This fake records the prompt it
    // received (its last argv) so we can assert the placeholder was substituted
    // with the real workspace value and no literal {{WORKSPACE}} leaks through.
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(instructionsDir, 'builder.md'), 'read {{WORKSPACE}}/prd.json and {{WORKSPACE}}/progress.md');
    const fake = join(workspace, 'fake-prompt.mjs');
    const marker = join(workspace, 'agent-prompt.txt');
    writeFileSync(fake, `
      import { writeFileSync, existsSync } from 'node:fs';
      // Capture only the first (Developer) invocation's prompt; the Validator
      // runs afterward with the same binary and would otherwise overwrite it.
      if (!existsSync(${JSON.stringify(marker)})) writeFileSync(${JSON.stringify(marker)}, process.argv[process.argv.length - 1]);
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const prompt = readFileSync(marker, 'utf8');
      expect(prompt).toContain(`${workspace}/prd.json`);
      expect(prompt).toContain(`${workspace}/progress.md`);
      expect(prompt).not.toContain('{{WORKSPACE}}');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('migrates legacy prd.json state fields into state.json on startup', async () => {
    // v0.4 旧格式：story 自带 passes:true 且无 state.json —— 引擎启动即抽取迁移，
    // 循环第一轮就判定全部完成并以 0 退出。
    const { workspace, instructionsDir } = setup([story({ passes: true, notes: '', retryCount: 0, blocked: false })]);
    // 用真实 stub 文件而非 `node -e` 一行式：后者的脚本字符串后面还跟着
    // buildAgentArgs 拼的 --print --dangerously-skip-permissions 等参数，
    // node 会把它们当成自己的 CLI 选项重新解析（非脚本 argv），导致
    // "bad option" 报错、以非 0 码退出——`-e` 从未真正跑到 process.exit(0)。
    // 旧实现只看 timedOut 不看 exitCode，这个假崩溃被无声吞掉；
    // 本任务后 exitCode!=0 会被判 error 并 continue，必须让 stub 真的干净退出 0。
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const migrated = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(migrated['US-001'].passes).toBe(true);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('does not resurrect legacy in-story state when state.json is corrupted mid-run', async () => {
    // 胖 prd.json（story 自带 passes:true）+ 损坏的 state.json：
    // 运行期回退必须按全部未开始处理（而非复活 legacy passes），循环跑满返回 1，且不覆盖损坏文件。
    const { workspace, instructionsDir } = setup([story({ passes: true, notes: '', retryCount: 0, blocked: false })]);
    writeFileSync(join(workspace, 'state.json'), '{ broken');
    // 用真实 stub 文件而非 `node -e` 一行式：见 :187 注释，`-e` 后面的脚本字符串会被
    // buildAgentArgs 拼的 --print --dangerously-skip-permissions 参数干扰，node 把它们
    // 当自己的 CLI 选项重新解析、以退出码 9 崩溃——脚本从未真正跑到 process.exit(0)。
    // 这个假崩溃会让每轮都走 builder-error continue，完成判定永远到不了，
    // 而完成判定（allStoriesResolved）正是本用例要守的位置：legacy passes 若被复活，
    // 只有走到这里才会被判定误判全绿吃掉。stub 必须真的干净退出 0。
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      expect(readFileSync(join(workspace, 'state.json'), 'utf-8')).toBe('{ broken');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes report.html when the loop completes', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const html = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(html).toContain('<!DOCTYPE html>');
      expect(html).toContain('US-001');
      expect(html).toContain('Story 验证完成');
      expect(html).toContain('Story 结果不等于可交付');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes report.html even when the loop hits maxIterations unfinished', async () => {
    const { workspace, instructionsDir } = setup([story()]); // never flips
    // 真实 stub 文件而非 `node -e` 一行式（见 :187 注释：`-e` 后的脚本会被引擎追加的
    // --dangerously-skip-permissions 当成 node 自己的 CLI 选项、以退出码 9 假崩溃）。
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      const html = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(html).toContain('进行中'); // 未完成态诚实存档
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('uses the PRD guard snapshot for the final report even when restoring disk fails', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-prd-directory.mjs');
    // 把 prd.json 换成目录：guard 能检出篡改，但原子 rename 无法覆盖目录，稳定制造 restoreFailed。
    writeFileSync(fake, `
      import { rmSync, mkdirSync } from 'node:fs';
      rmSync(${JSON.stringify(prdPath)});
      mkdirSync(${JSON.stringify(prdPath)});
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      const html = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(html).toContain('US-001');
      expect(html).toContain('引擎启动快照');
      expect(html).not.toContain('验证报告未生成');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('runLoop quality gate', () => {
  it('gate failure rolls the story back and skips the validator for that round', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // 打回后 story 未完成，跑满 maxIterations
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].passes).toBe(false);
      expect(state['US-001'].retryCount).toBe(1);
      expect(state['US-001'].blocked).toBe(false);
      expect(state['US-001'].notes).toContain('[门禁失败 - 第1次]');
      expect(state['US-001'].notes).toContain('退出码 7');
      expect(state['US-001'].notes).toContain('gate-boom');
      // builder 被调用、validator 被跳过：stub 恰好只跑了一次
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('gate pass lets the validator run and the loop complete', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      // builder + validator 都跑了
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('warns and disables the gate on malformed qualityChecks without touching state', async () => {
    const { workspace, instructionsDir } = setup([story()], { qualityChecks: 'npm test' });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0); // 门禁未启用，行为与未配置一致
      expect(warns.some((w) => w.includes('qualityChecks 形状非法'))).toBe(true);
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      console.warn = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('an agent-set blocked story skips the gate and validator for that round and resolves the loop', async () => {
    const gateMark = join(tmpdir(), `coding-x-gate-mark-${Date.now()}`);
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: [`node -e 'require("node:fs").writeFileSync("${gateMark}", "ran")'`],
    });
    // stub agent：不置 passes，而是显式置 blocked（模拟 dogfood US-009 的仲裁上报）
    const fake = join(workspace, 'fake-blocking.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: false, notes: '[需要人工核实] 疑似配置异常，已附调查', retryCount: 0, blocked: true },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 3, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(3); // blocked 属 resolved，完成判定当轮收敛为 exit 3（Task 6：M>0 走 blocked 收敛出口）
      expect(existsSync(gateMark)).toBe(false); // 门禁命令未执行
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1); // 只有 builder，validator 未拉起
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].blocked).toBe(true);
      expect(state['US-001'].retryCount).toBe(0); // 未被门禁打回推进
      expect(state['US-001'].notes).toContain('[需要人工核实]'); // 仲裁记录未被覆盖
      // C2（triage 7）：轮末 iteration 记录须如实反映 agent blocked 与 validator 未跑
      const { records } = readEvidence(workspace);
      const iters = records.filter((r) => r.type === 'iteration');
      expect(iters).toHaveLength(1);
      expect(iters[0]).toMatchObject({ agentBlocked: true, validatorRan: false, validatorOutcome: 'skipped' });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
      rmSync(gateMark, { force: true });
    }
  });
});

describe('runLoop TDD gate', () => {
  it('fails closed before any agent starts when tdd config is malformed', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      tdd: { coverageCheck: '' },
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      expect(existsSync(calls)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('reruns the TDD command after builder, rejects the story, and skips validator', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
      tdd: currentRepoTdd('node -e "console.error(\'coverage 80% < 90%\'); process.exit(7)"'),
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'];
      expect(state).toMatchObject({ passes: false, retryCount: 1, blocked: false });
      expect(state.notes).toContain('coverage 80% < 90%');
      const records = readEvidence(workspace).records;
      expect(records.filter((record) => record.type === 'tdd-gate')).toHaveLength(2);
      expect(records.find((record) =>
        record.type === 'tdd-gate' && record.phase === 'post-builder')).toMatchObject({
        ok: false,
        policyOk: true,
        commandRan: true,
        failureCode: 'coverage-check-failed',
        exitCode: 7,
      });
      expect(records.find((record) => record.type === 'iteration')).toMatchObject({
        gateRejected: true,
        validatorOutcome: 'skipped',
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('passes coding-x workspace and project root to both agents and lets validator run after TDD passes', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      tdd: currentRepoTdd('node -e "process.exit(0)"'),
    });
    const fake = join(workspace, 'fake-env.mjs');
    const calls = join(workspace, 'env-calls.jsonl');
    writeFileSync(fake, `
      import { appendFileSync, writeFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
        workspace: process.env.CODING_X_WORKSPACE,
        projectRoot: process.env.CODING_X_PROJECT_ROOT,
      }) + '\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(0);
      const envs = readFileSync(calls, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
      expect(envs).toHaveLength(2);
      expect(envs).toEqual([
        { workspace: resolve(workspace), projectRoot: resolve(process.cwd()) },
        { workspace: resolve(workspace), projectRoot: resolve(process.cwd()) },
      ]);
      expect(readEvidence(workspace).records.find((record) =>
        record.type === 'tdd-gate' && record.phase === 'post-builder')).toMatchObject({
        ok: true,
        policyOk: true,
        commandRan: true,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('runLoop evidence records', () => {
  it('writes gate-run (pass) and iteration records for a completing run', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const { records, skippedLines } = readEvidence(workspace);
      expect(skippedLines).toBe(0);
      const gateRuns = records.filter((r) => r.type === 'gate-run');
      expect(gateRuns).toHaveLength(1);
      expect(gateRuns[0]).toMatchObject({ source: 'engine', iteration: 1, storyId: 'US-001', ok: true, total: 1, ran: 1 });
      const iters = records.filter((r) => r.type === 'iteration');
      expect(iters).toHaveLength(1);
      expect(iters[0]).toMatchObject({
        source: 'engine', iteration: 1, storyId: 'US-001',
        builderRan: true, validatorRan: true, skippedValidator: false, agentBlocked: false,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes a failing gate-run and a gateRejected iteration record for the rolled-back round', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const { fake } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      const { records } = readEvidence(workspace);
      const gateRuns = records.filter((r) => r.type === 'gate-run');
      expect(gateRuns).toHaveLength(1);
      expect(gateRuns[0]).toMatchObject({
        ok: false, total: 1, ran: 1, failedCommand: 'node -e "console.error(\'gate-boom\'); process.exit(7)"',
        exitCode: 7, timedOut: false, diagnosticTail: 'gate-boom',
      });
      // 每轮一条 iteration 不变式（Task 5）：打回轮 continue 前补记录，不再是空洞
      const iters = records.filter((r) => r.type === 'iteration');
      expect(iters).toHaveLength(1);
      expect(iters[0]).toMatchObject({ gateRejected: true, validatorOutcome: 'skipped', validatorRan: false });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('保留 validator 打回 notes，即使成功重试已清空当前 state', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-diagnostic.mjs');
    const calls = join(workspace, 'diagnostic-calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(fake, `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const callsPath = ${JSON.stringify(calls)};
      const count = existsSync(callsPath) ? Number(readFileSync(callsPath, 'utf-8')) + 1 : 1;
      writeFileSync(callsPath, String(count));
      const statePath = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (count === 1 || count === 3) {
        state['US-001'].passes = true;
        state['US-001'].notes = '';
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder progress ' + count + '\\n');
      } else if (count === 2) {
        state['US-001'].passes = false;
        state['US-001'].retryCount += 1;
        state['US-001'].notes = '首轮失败：test_signature\\nexpected 401 <script>alert(1)</script>';
      }
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(0);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001'].notes).toBe('');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations).toHaveLength(2);
      expect(iterations[0]).toMatchObject({
        validatorOutcome: 'completed',
        validatorDiagnostic: '首轮失败：test_signature\nexpected 401 <script>alert(1)</script>',
      });
      expect(iterations[1]).not.toHaveProperty('validatorDiagnostic');
      const report = readFileSync(join(workspace, 'report.html'), 'utf-8');
      expect(report).toContain('首轮失败：test_signature');
      expect(report).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
      expect(report).not.toContain('<script>alert(1)</script>');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('writes a tamper record with the archive filename when builder tampers prd.json', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-tamper-ev.mjs');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, existsSync } from 'node:fs';
      // 只在 prd 未被篡改过时篡改一次，然后翻绿收敛
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      if (prd.project !== 'evil') {
        prd.project = 'evil';
        writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      }
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const { records } = readEvidence(workspace);
      const tampers = records.filter((r) => r.type === 'tamper');
      expect(tampers).toHaveLength(1); // 同内容去重：只记新事件
      expect(tampers[0].archive).toMatch(/^prd\.tampered-.*\.json$/); // 文件名而非路径
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('runLoop model routing', () => {
  // fake 记录每次调用收到的 argv（一行一次），并把 story 翻绿让循环结束。
  // 行 1 = builder、行 2 = validator（同轮内先后调用）。
  function fakeArgvRecorder(workspace: string): { fake: string; argvLog: string } {
    const fake = join(workspace, 'fake-argv.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 1, blocked: false },
      }));
      process.exit(0);
    `);
    return { fake, argvLog };
  }

  it('routes stage models and uses sticky escalation state', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], {
      models: modelConfig(),
    });
    // 升级与 retryCount 分离：只有 engine-owned escalated 决定本轮路由。
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: false, notes: '', retryCount: 1, blocked: false, escalated: true },
    }));
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        modelCatalog: catalogWith('esc-m', 'val-m'),
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(2);
      expect(lines[0]).toContain('--model esc-m'); // builder 升级
      expect(lines[1]).toContain('--model val-m'); // validator 恒定
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated).toBe(true);
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderRouteSource: 'escalation', validatorRouteSource: 'validator',
        stateRouteTamper: [
          { expected: true, received: 'missing', side: 'builder' },
          { expected: true, received: 'missing', side: 'validator' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it.each([
    ['low', 'low-m'], ['medium', 'fast-m'], ['high', 'high-m'],
  ] as const)('uses the %s story difficulty mapping for the initial builder', async (difficulty, expectedModel) => {
    const { workspace, instructionsDir } = setup([routedStory({ difficulty })], {
      models: modelConfig(),
    });
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        modelCatalog: catalogWith(expectedModel, 'esc-m', 'val-m'),
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain(`--model ${expectedModel}`);
      expect(lines[1]).toContain('--model val-m');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it.each([
    ['claude', 'CODING_X_CLAUDE_BIN', '--print --dangerously-skip-permissions'],
    ['codex', 'CODING_X_CODEX_BIN', 'exec --dangerously-bypass-approvals-and-sandbox'],
    ['cursor', 'CODING_X_CURSOR_BIN', '-p --force'],
  ] as const)('models.runner auto-selects %s and reaches the fake agent with its public argv', async (
    runner, envName, argvPrefix,
  ) => {
    const { workspace, instructionsDir } = setup([routedStory()], {
      models: { ...modelConfig(), runner },
    });
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env[envName] = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', kindExplicit: false, maxIterations: 2,
        devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        modelCatalog: async () => ({
          status: 'available', runner, source: 'global-config', configPath: '/fixture/config.json',
          models: ['fast-m', 'esc-m', 'val-m'].map((id) => ({ id })),
        }),
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain(argvPrefix);
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model val-m');
    } finally {
      delete process.env[envName];
    }
  });

  it('lets CLI overrides beat prd.json models', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], {
      models: modelConfig(),
    });
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        builderModel: 'cli-b', validatorModel: 'cli-v',
        modelCatalog: catalogWith('cli-b', 'cli-v', 'esc-m'),
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model cli-b');
      expect(lines[1]).toContain('--model cli-v');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('reads a valid CODING_X_CONFIG through the production preflight path', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const configPath = join(workspace, 'global-models.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1,
      models: { claude: ['fast-m', 'esc-m', 'val-m'].map((id) => ({ id })) },
    }));
    process.env.CODING_X_CONFIG = configPath;
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model val-m');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('passes no --model at all when nothing is configured', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    process.env.CODING_X_CONFIG = join(workspace, 'missing-global-config.json');
    const { fake, argvLog } = fakeArgvRecorder(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).not.toContain('--model');
      expect(lines[1]).not.toContain('--model');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('fails before starting an agent on malformed models', async () => {
    const { workspace, instructionsDir } = setup([story()], { models: 'opus' });
    // 非法配置必须在循环前失败，不能回退到 runner 默认模型。
    const fake = join(workspace, 'fake-argv-only.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      // progress.md 每次调用递增写入：让每轮都有非空转产出，本用例只关心 models 警告去重，
      // 不是 Task 5 的 no-op 检测——真空转会跳过 validator，把 builder+validator 各跑一次的假设打破。
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'x');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(2);
      expect(existsSync(argvLog)).toBe(false);
      expect(errors.some((w) => w.includes('models 形状非法'))).toBe(true);
    } finally {
      console.error = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('fails before dashboard/agent when routed models have no global catalog', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    process.env.CODING_X_CONFIG = join(workspace, 'missing-global-config.json');
    const fake = join(workspace, 'must-not-run.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argvLog)}, 'ran');`);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const dashboardStart = vi.spyOn(dashboard, 'start');
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(2);
      expect(dashboardStart).not.toHaveBeenCalled();
      expect(existsSync(argvLog)).toBe(false);
      expect(errors.join('\n')).toContain('未找到全局模型配置');
    } finally {
      dashboardStart.mockRestore();
      console.error = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('does not let a CLI model override bypass the catalog when prd.json is missing', async () => {
    const { workspace, instructionsDir } = setup([]);
    rmSync(join(workspace, 'prd.json'));
    const configPath = join(workspace, 'global-models.json');
    writeFileSync(configPath, JSON.stringify({
      version: 1, models: { claude: [{ id: 'some-other-model' }] },
    }));
    process.env.CODING_X_CONFIG = configPath;
    const fake = join(workspace, 'must-not-run.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argvLog)}, 'ran');`);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const errors: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errors.push(args.join(' ')); };
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        builderModel: 'cli-b', workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(2);
      expect(existsSync(argvLog)).toBe(false);
      expect(errors.join('\n')).toContain('cli-b');
      expect(errors.join('\n')).toContain('claude 全局模型目录');
    } finally {
      console.error = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rejects a missing final-review model catalog even when stories are already settled', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false, escalated: false },
    }));
    process.env.CODING_X_CONFIG = join(workspace, 'missing-global-models.json');
    const argvLog = join(workspace, 'argv.log');
    const fake = join(workspace, 'must-not-run.mjs');
    writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(argvLog)}, 'ran');`);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', kindExplicit: false, maxIterations: 1,
        devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(2);
      expect(existsSync(argvLog)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('模型升级触发与状态所有权', () => {
  it('completed no-op 首次触发，下轮改走 escalation 且不增加 retryCount', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const fake = join(workspace, 'fake-noop-route.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false, stallLimit: 3,
        modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
      })).toBe(1);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model esc-m');
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'];
      expect(state).toMatchObject({ escalated: true, retryCount: 0 });
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations[0]).toMatchObject({ noop: true, escalationTriggeredBy: 'noop' });
      expect(iterations[1]).not.toHaveProperty('escalationTriggeredBy');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('机械门禁首次打回后，下轮改走 escalation', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], {
      models: modelConfig(), qualityChecks: ['node -e "process.exit(1)"'],
    });
    const fake = join(workspace, 'fake-gate-route.mjs');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      const path = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      state['US-001'].passes = true;
      writeFileSync(path, JSON.stringify(state));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
      })).toBe(1);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model esc-m');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations[0]).toMatchObject({ gateRejected: true, escalationTriggeredBy: 'gate' });
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated).toBe(true);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('引擎接受 Validator failed claim 后，下轮 builder 改走 escalation', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const fake = join(workspace, 'fake-validator-route.mjs');
    const calls = join(workspace, 'calls.txt');
    const argvLog = join(workspace, 'argv.log');
    writeFileSync(fake, `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const callsPath = ${JSON.stringify(calls)};
      const count = existsSync(callsPath) ? Number(readFileSync(callsPath, 'utf-8')) + 1 : 1;
      writeFileSync(callsPath, String(count));
      appendFileSync(${JSON.stringify(argvLog)}, process.argv.slice(2).join(' ') + '\\n');
      const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(statePath, 'utf-8'));
      if (count % 2 === 1) {
        state['US-001'].passes = true;
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder progress\\n');
      } else {
        state['US-001'].passes = false;
        state['US-001'].retryCount += 1;
      }
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
      })).toBe(1);
      const lines = readFileSync(argvLog, 'utf-8').trim().split('\n');
      expect(lines).toHaveLength(4);
      expect(lines[0]).toContain('--model fast-m');
      expect(lines[1]).toContain('--model val-m');
      expect(lines[2]).toContain('--model esc-m');
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iterations[0]).toMatchObject({ escalationTriggeredBy: 'validator' });
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated).toBe(true);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('异常退出不触发升级', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const fake = join(workspace, 'fake-error-route.mjs');
    writeFileSync(fake, 'process.exit(9);');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
      })).toBe(1);
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated).toBe(false);
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).not.toHaveProperty('escalationTriggeredBy');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('agent 擅自置位 escalated 会被恢复并留痕', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const fake = join(workspace, 'fake-tamper-route.mjs');
    writeFileSync(fake, `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const path = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      state['US-001'].passes = true;
      state['US-001'].escalated = true;
      writeFileSync(path, JSON.stringify(state));
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'progress\\n');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        modelCatalog: catalogWith('fast-m', 'esc-m', 'val-m'),
      })).toBe(0);
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'].escalated).toBe(false);
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        stateRouteTamper: [
          { expected: false, received: true, side: 'builder' },
          { expected: false, received: true, side: 'validator' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('agent 删除整条 story 状态时恢复路由所有权与其余状态', async () => {
    const { workspace, instructionsDir } = setup([routedStory()], { models: modelConfig() });
    const statePath = join(workspace, 'state.json');
    writeFileSync(statePath, JSON.stringify({
      'US-001': { passes: false, notes: 'keep', retryCount: 2, blocked: false, escalated: true },
    }));
    const fake = join(workspace, 'fake-delete-story-route.mjs');
    writeFileSync(fake, `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      const path = ${JSON.stringify(statePath)};
      const state = JSON.parse(readFileSync(path, 'utf-8'));
      delete state['US-001'];
      writeFileSync(path, JSON.stringify(state));
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'progress\\n');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        modelCatalog: catalogWith('esc-m', 'val-m'),
      })).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001']).toEqual({
        passes: false, validated: false, notes: 'keep', retryCount: 2, blocked: false, escalated: true,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        stateRouteTamper: [
          { expected: true, received: 'missing', side: 'builder' },
          { expected: true, received: 'missing', side: 'validator' },
        ],
        stateValidationTamper: [
          { expected: false, received: 'missing', side: 'builder' },
          { expected: false, received: 'missing', side: 'validator' },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('runLoop keepOpen', () => {
  it('keeps the dashboard serving after completion until interrupt resolves', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const port = 18100 + (process.pid % 1000);
    let release!: () => void;
    const interrupt = new Promise<void>((r) => { release = r; });
    try {
      const running = runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port, openBrowser: false,
        keepOpen: true, interrupt,
      });
      // With keepOpen the loop must NOT resolve on its own after completion.
      const pending = await Promise.race([
        running.then(() => 'resolved'),
        new Promise((r) => setTimeout(() => r('pending'), 300)),
      ]);
      expect(pending).toBe('pending');
      // The dashboard must still answer while we wait.
      const res = await fetch(`http://127.0.0.1:${port}/api/state`);
      expect(res.status).toBe(200);
      const body = await res.json() as { runtime: { phase: string } };
      expect(body.runtime.phase).toBe('done');
      // Releasing the interrupt lets the loop return its real exit code and close.
      release();
      expect(await running).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('closes immediately after completion when keepOpen is not set', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const port = 19100 + (process.pid % 1000);
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port, openBrowser: false,
      });
      expect(code).toBe(0);
      await expect(fetch(`http://127.0.0.1:${port}/api/state`)).rejects.toThrow();
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('renderInstruction', () => {
  it('substitutes every {{WORKSPACE}} occurrence with the given path', () => {
    const out = renderInstruction('a {{WORKSPACE}}/prd.json b {{WORKSPACE}}/progress.md', '/abs/state');
    expect(out).toBe('a /abs/state/prd.json b /abs/state/progress.md');
  });

  it('leaves text without the placeholder unchanged', () => {
    expect(renderInstruction('no placeholder here', '.workspace')).toBe('no placeholder here');
  });

  it('substitutes {{MAX_RETRIES}} with the engine constant', () => {
    const out = renderInstruction('如果 retryCount 已经达到 {{MAX_RETRIES}}：', '.workspace');
    expect(out).toBe('如果 retryCount 已经达到 5：');
  });

  it('injects the TDD skill reference only when TDD is enabled', () => {
    expect(renderInstruction('x{{TDD_WORKFLOW}}y', '.workspace', false)).toBe('xy');
    const enabled = renderInstruction('x{{TDD_WORKFLOW}}y', '.workspace', true);
    expect(enabled).toContain('`tdd` skill');
    expect(enabled).toContain('acceptanceCriteria');
  });
});

describe('renderInstruction arbitration placeholder', () => {
  it('renders {{ARBITRATION_PREFIXES}} as a 、-joined label list', () => {
    const out = renderInstruction('保全 {{ARBITRATION_PREFIXES}} 行', '.workspace');
    expect(out).toBe('保全 [需求冲突]、[需要人工核实] 行');
  });
});

describe('instruction assets arbitration contract', () => {
  it('builder.md references the arbitration placeholder; Validator verdict state is engine-owned', () => {
    expect(read('builder.md')).toContain('{{ARBITRATION_PREFIXES}}');
    expect(read('validator.md')).not.toContain('{{ARBITRATION_PREFIXES}}');
    expect(read('validator.md')).toContain('最终状态由引擎裁决和写入');
  });

  it('builder uses guarded prd while Validator uses the engine-bound AC snapshot', () => {
    expect(read('builder.md')).toContain('prd.tampered-');
    expect(read('builder.md')).toContain('快照保护');
    expect(read('validator.md')).toContain('request.acceptanceCriteria');
    expect(read('validator.md')).toContain('唯一验收标准');
  });
});

describe('instruction assets evidence contract', () => {
  it('builder.md and validator.md carry the screenshot-claim registration template', () => {
    for (const f of ['builder.md', 'validator.md']) {
      const content = read(f);
      expect(content).toContain('evidence.jsonl');
      expect(content).toContain('screenshot-claim');
      expect(content).toContain('从 1 数起'); // acIndex 1-based 明示
      expect(content).toContain('登记失败不阻塞'); // 弱依赖声明
    }
    expect(read('builder.md')).toContain('"source":"builder"');
    expect(read('validator.md')).toContain('"source":"validator"');
  });
});

describe('instruction assets engine-owned state contract', () => {
  it('builder preserves engine fields and Validator must not write any verdict state', () => {
    const builder = read('builder.md');
    expect(builder).toContain('`validated`');
    expect(builder).toContain('`escalated`');
    expect(builder).toContain('引擎独占字段');
    expect(builder).toContain('原样保留');
    expect(read('builder.md')).toContain('待 Validator 复核的候选结果');
    const validator = read('validator.md');
    expect(validator).toContain('不得修改 `{{WORKSPACE}}/state.json`');
    expect(validator).toContain('`validated`');
    expect(validator).toContain('`escalated`');
    expect(validator).toContain('全部由引擎根据 result 写入');
  });
});

describe('instruction assets structured validation contract', () => {
  it('binds Validator to the injected request and exact v1 result schema', () => {
    const content = read('validator.md');
    expect(content).toContain('ENGINE-BOUND VALIDATION REQUEST');
    expect(content).toContain('不得从 `{{WORKSPACE}}/progress.md`');
    expect(content).toContain('"acceptanceHash"');
    expect(content).toContain('"gitHead"');
    expect(content).toContain('"checks"');
    expect(content).toContain('字段必须恰好匹配');
    expect(content).toContain('source=validator');
  });
});

describe('instruction assets workspace commit isolation contract', () => {
  it('builder commits story files before updating runtime state and never stages the workspace', () => {
    const content = read('builder.md');
    expect(content).toContain('只 stage/commit 本 story 的实现、测试与必要文档');
    expect(content).toContain('禁止 stage 或 commit `{{WORKSPACE}}`');
    expect(content).toContain('不要使用 `git add .` 或 `git add -A`');
    expect(content).toContain('`git diff --cached --name-only`');
    expect(content).toContain('提交成功后再更新');
  });
});

describe('runLoop prd freeze', () => {
  it('builder 删除 qualityChecks 也架空不了门禁：文件被恢复、门禁照跑照打回', async () => {
    // 漏洞路径：builder 改写 prd.json 删掉 qualityChecks → 下轮门禁静默失效。
    // 修复后：builder 之后的检测点恢复文件，门禁按快照命令执行、失败打回并跳过 validator。
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const prdPath = join(workspace, 'prd.json');
    const original = readFileSync(prdPath, 'utf-8');
    const fake = join(workspace, 'fake-tamper.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      delete prd.qualityChecks;
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      // progress.md 留痕：这轮的 tamper 只碰了 prd.json，state/progress 双静止会被
      // Task 5 的 no-op 检测提前跳过门禁，抹掉本用例要验的“门禁按快照命令执行”。
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'x');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      // 门禁没有被架空：按快照命令执行并打回
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001'].notes).toContain('[门禁失败 - 第1次]');
      expect(state['US-001'].notes).toContain('gate-boom');
      // 门禁失败跳过 validator：stub 只被调了一次（builder）
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      // 磁盘被恢复为原版、篡改版被存档
      expect(readFileSync(prdPath, 'utf-8')).toBe(original);
      const archived = readdirSync(workspace).filter((f) => f.startsWith('prd.tampered-'));
      expect(archived).toHaveLength(1);
      expect(warns.some((w) => w.includes('检测到 prd.json 在运行期被修改'))).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('builder 改弱 AC 后 validator 读到的磁盘已是恢复的原版', async () => {
    // validator 是独立进程直读磁盘——第四检测点（builder 后）必须先恢复文件。
    const { workspace, instructionsDir } = setup([story({ acceptanceCriteria: ['原始验收标准'] })]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-weaken.mjs');
    const calls = join(workspace, 'calls.txt');
    const seenByValidator = join(workspace, 'validator-saw.json');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, appendFileSync, existsSync, copyFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const n = readFileSync(${JSON.stringify(calls)}, 'utf-8').trim().split('\\n').length;
      if (n === 1) {
        // builder：改弱 AC 并翻绿
        const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
        prd.userStories[0].acceptanceCriteria = ['被改弱的标准'];
        writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
        writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        }));
      } else {
        // validator：记录此刻磁盘上的 prd.json（它验收时读到的东西）
        copyFileSync(${JSON.stringify(prdPath)}, ${JSON.stringify(seenByValidator)});
      }
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0); // builder 翻绿、validator 跑过、完成判定放行
      const saw = JSON.parse(readFileSync(seenByValidator, 'utf-8'));
      expect(saw.userStories[0].acceptanceCriteria).toEqual(['原始验收标准']); // 不是被改弱的
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('删 story 骗不过完成判定：完成判定用快照，未完成照样跑满返回 1', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-drop.mjs');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      prd.userStories = []; // 删光 story：若完成判定读磁盘会误判全绿提前 exit 0
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      // 只碰 prd.json、不碰 state/progress 会被 Task 5 的 no-op 检测提前 continue，
      // 完成判定压根不会跑到——留痕 progress.md 保住本用例要测的完成判定代码路径。
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'x');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // story 从未通过，不被空列表骗成 0
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('写回失败的轮次跳过 validator，结束摘要报告篡改', async () => {
    // builder 删 prd.json 并在原路径建同名目录：读抛 EISDIR（按删除篡改）、写回时 tmp 写入成功、rename 到目录路径抛 EISDIR（恢复失败）。
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const fake = join(workspace, 'fake-break.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { appendFileSync, unlinkSync, mkdirSync, existsSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      if (existsSync(${JSON.stringify(prdPath)})) {
        unlinkSync(${JSON.stringify(prdPath)});
        mkdirSync(${JSON.stringify(prdPath)});
      }
      // state/progress 双静止会被 Task 5 的 no-op 检测提前 continue，跳过本用例要测的
      // 门禁前检测点（正是发现写回失败、跳过 validator 的那一步）——留痕 progress.md 保住它。
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'x');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1);
      // 写回失败 → 本轮 validator 被跳过：stub 只跑了一次
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      expect(warns.some((w) => w.includes('快照写回失败'))).toBe(true);
      expect(warns.some((w) => w.includes('跳过本轮 validator'))).toBe(true);
      // 结束摘要报告篡改事件
      expect(warns.some((w) => w.includes('运行期间检测到 prd.json 被修改'))).toBe(true);
      // C3（triage 8）：删除类篡改（读回抛 EISDIR）必须记一条 archive:null 的 tamper evidence
      const { records } = readEvidence(workspace);
      const tampers = records.filter((r) => r.type === 'tamper');
      expect(tampers.some((t) => t.archive === null)).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('快照写回失败跳过 validator 时不会保留 builder 的 passes=true', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const statePath = join(workspace, 'state.json');
    const fake = join(workspace, 'fake-break-after-pass.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { appendFileSync, unlinkSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'));
      state['US-001'].passes = true;
      writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
      appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder done\\n');
      unlinkSync(${JSON.stringify(prdPath)});
      mkdirSync(${JSON.stringify(prdPath)});
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const origWarn = console.warn;
    console.warn = () => {};
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001'])
        .toMatchObject({ passes: false, validated: false });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderOutcome: 'completed', validatorRan: false, validatorOutcome: 'skipped',
        skippedValidator: true, validationRollback: true,
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('终轮 builder 异常且篡改 prd：循环自然耗尽后磁盘已恢复、篡改被存档并计入 evidence', async () => {
    // 回归用例（I-2）：i === maxIterations 且本轮走 builder 异常 continue 路径（未触发 stall
    // 熔断）时，此前循环结束直接 guard.summary()，中间不再有任何 guard.read()——本轮对
    // prd.json 的篡改留在磁盘上，成为下次启动 createPrdGuard 的新基线，跨运行架空 ADR-007。
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const original = readFileSync(prdPath, 'utf-8');
    const fake = join(workspace, 'fake-final-tamper.mjs');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      prd.project = 'evil-final-round';
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(1); // builder 异常结局：走 continue，不会经过门禁前的 gateRead
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // 唯一一轮异常、未 resolved，跑满 maxIterations
      expect(readFileSync(prdPath, 'utf-8')).toBe(original); // 磁盘已恢复为启动快照
      const archived = readdirSync(workspace).filter((f) => f.startsWith('prd.tampered-'));
      expect(archived).toHaveLength(1); // 篡改版已存档
      expect(warns.some((w) => w.includes('运行期间检测到 prd.json 被修改'))).toBe(true);
      const { records } = readEvidence(workspace);
      const tampers = records.filter((r) => r.type === 'tamper');
      expect(tampers).toHaveLength(1);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('终轮 no-op 且篡改 prd：循环自然耗尽后磁盘已恢复、篡改被存档', async () => {
    // 同一收口点的第二个入口：no-op continue 路径（builder 正常退出但 state/progress
    // 双无变化）同样绕开所有既有 guard.read()——只要本轮 builder 在退出前篡改了 prd.json。
    const { workspace, instructionsDir } = setup([story()]);
    const prdPath = join(workspace, 'prd.json');
    const original = readFileSync(prdPath, 'utf-8');
    const fake = join(workspace, 'fake-final-tamper-noop.mjs');
    writeFileSync(fake, `
      import { writeFileSync, readFileSync } from 'node:fs';
      const prd = JSON.parse(readFileSync(${JSON.stringify(prdPath)}, 'utf-8'));
      prd.project = 'evil-final-noop';
      writeFileSync(${JSON.stringify(prdPath)}, JSON.stringify(prd));
      process.exit(0); // 干净退出，但 state/progress 双无变化 = no-op
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const warns: string[] = [];
    const origWarn = console.warn;
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(1); // 唯一一轮 no-op、未 resolved，跑满 maxIterations
      expect(readFileSync(prdPath, 'utf-8')).toBe(original); // 磁盘已恢复为启动快照
      const archived = readdirSync(workspace).filter((f) => f.startsWith('prd.tampered-'));
      expect(archived).toHaveLength(1);
      expect(warns.some((w) => w.includes('运行期间检测到 prd.json 被修改'))).toBe(true);
    } finally {
      console.warn = origWarn;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('workspace 并发锁', () => {
  const lockJson = (pid: number) =>
    JSON.stringify({ pid, startedAt: '2026-07-16T00:00:00.000Z', command: 'run' });

  it('returns 2 without touching the workspace when an alive lock exists', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, LOCK_FILE), lockJson(process.pid)); // 本进程必存活
    // stub agent 必须设置：红灯阶段（锁未实现）循环会真的跑，绝不能 spawn 真 claude
    process.env.CODING_X_CLAUDE_BIN = 'node -e process.exit(0)';
    const errs: string[] = [];
    const orig = console.error;
    console.error = (...args: unknown[]) => { errs.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(2);
      expect(errs.some((l) => l.includes('已被另一个 coding-x 进程锁定'))).toBe(true);
    } finally {
      console.error = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
    expect(existsSync(join(workspace, 'state.json'))).toBe(false); // 锁生效=未写任何文件（含 ensureStateFile）
    expect(readLockInfo(join(workspace, LOCK_FILE))!.pid).toBe(process.pid); // 别人的锁原样保留
  });

  it('removes engine.lock after a normal run', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      expect(existsSync(join(workspace, LOCK_FILE))).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('takes over a stale lock (dead pid) and completes normally', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, LOCK_FILE), lockJson(999999999)); // 超 pid 上限，必死
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      });
      expect(code).toBe(0);
      expect(warns.some((w) => w.includes('已接管'))).toBe(true);
    } finally {
      console.warn = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('releases the lock before the keepOpen wait begins', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    // interrupt 注入口（LoopConfig.interrupt）：以 keepOpen 分支「运行结束」日志行为事件驱动
    // 同步点采样锁是否已释放——该行在 lock.release() 之后、await interrupt 之前打印（见
    // loop.ts），比固定墙钟 setTimeout 更可靠：后者与真实子进程冷启动赛跑，冷启动超时窗口
    // 就会误采到「循环仍在跑」的假失败。
    let lockDuringWait = true;
    let resolveInterrupt!: () => void;
    const interrupt = new Promise<void>((resolve) => { resolveInterrupt = resolve; });
    const orig = console.log;
    console.log = (...args: unknown[]) => {
      const line = args.join(' ');
      if (line.includes('运行结束')) {
        lockDuringWait = existsSync(join(workspace, LOCK_FILE));
        resolveInterrupt();
      }
    };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        keepOpen: true, interrupt,
      });
      expect(code).toBe(0);
      expect(lockDuringWait).toBe(false); // keepOpen 等待期间锁已不在
    } finally {
      console.log = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});

describe('异常轮回写（builder 侧）', () => {
  it('builder provider 402：state 保持未通过，iteration 留退出码/耗时/诊断供报告恢复', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-402.mjs');
    writeFileSync(fake, `
      process.stderr.write('API Error: 402 Account overdue\\n');
      process.exit(1);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      expect(JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'])
        .toMatchObject({ passes: false, validated: false, retryCount: 0 });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderOutcome: 'error', validatorRan: false,
        builderInvocation: {
          durationMs: expect.any(Number), exitCode: 1,
          diagnosticTail: 'API Error: 402 Account overdue',
        },
      });
      expect(readFileSync(join(workspace, 'report.html'), 'utf-8'))
        .toContain('API Error: 402 Account overdue');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('builder 写 true 后非零退出：回写 false+待复核标记，evidence 记 error 结局与回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    // fake：置 US-001 通过后以非零码退出（对应「干完活但进程异常收尾」）
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(1);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    // 每轮都回写 → 永不 resolved → 跑满 maxIterations，exit 1
    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toContain('[中断轮待复核]');
    expect(state['US-001'].retryCount).toBe(0);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(2);
    expect(iters[0]).toMatchObject({
      iteration: 1, storyId: 'US-001',
      builderOutcome: 'error', abortRollback: { storyId: 'US-001' },
    });
    expect((iters[0] as { validatorRan: boolean }).validatorRan).toBe(false);
  });

  it('builder 超时且未动 state：不回写、不产生标记，iteration 记 timeout', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    // fake：不写任何文件，睡到被引擎 SIGTERM（devTimeoutMs=400 触发超时）
    writeFileSync(fake, `
      await new Promise((r) => setTimeout(r, 60_000));
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 1, devTimeoutMs: 400, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toBe('');
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({ iteration: 1, builderOutcome: 'timeout' });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
  });

  it('agent 同轮置 blocked 且非零退出：不回写、evidence 如实记 agentBlocked', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '[需要人工核实] 环境异常', retryCount: 0, blocked: true },
      }));
      process.exit(1);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    // blocked 优先：不回写（passes 保持 true）、notes 不被改写
    expect(state['US-001'].blocked).toBe(true);
    expect(state['US-001'].passes).toBe(true);
    expect(state['US-001'].notes).toContain('[需要人工核实]');
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({ builderOutcome: 'error', agentBlocked: true });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
    // 本轮 builder 非零退出触发早退 continue（loop.ts 异常轮熔断分支），整段（门禁/validator/完成判定）本轮跳过；
    // blocked→resolved 的收敛判定只在“到达完成判定”的轮次生效，需等下一轮 builder 干净退出才会跑到
    // （Task 3 报告 self-review 已记录此边界：“识别会推迟到下一轮…而非当轮收敛”）。
    // maxIterations=1 没有下一轮，故跑满收尾，退出码 1 是跑满语义——与 Task 6 的 blocked 收敛 exit 3 无关：
    // exit 3 要求到达完成判定分支，本用例的异常轮 continue 到不了那里。
    expect(code).toBe(1);
  });
});

describe('异常轮回写（validator 侧）', () => {
  it('builder 置 true 后 validator 非零退出：回写 false，iteration 记 validator error 与回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    // 同一 stub 以调用次数区分：第 1 次（builder）置 true 正常退出；第 2 次（validator）非零退出
    writeFileSync(fake, `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const n = readFileSync(${JSON.stringify(calls)}, 'utf-8').length;
      if (n === 1) {
        writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
          'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        }));
        process.exit(0);
      }
      process.exit(1);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1); // 回写后未 resolved，跑满 1 轮
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toContain('[中断轮待复核]');
    expect(state['US-001'].notes).toContain('validator');
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({
      builderOutcome: 'completed', validatorOutcome: 'error',
      abortRollback: { storyId: 'US-001' },
    });
  });

  it('builder 置 true 后 validator 超时：回写 false 且不会从完成出口假绿', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-timeout.mjs');
    const calls = join(workspace, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(fake, `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      if (!existsSync(${JSON.stringify(calls)})) {
        const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'));
        state['US-001'].passes = true;
        writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
        writeFileSync(${JSON.stringify(calls)}, 'builder');
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder done\\n');
        process.exit(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 400,
        workspace, instructionsDir, port: 0, openBrowser: false,
      })).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001'])
        .toMatchObject({ passes: false, validated: false });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderOutcome: 'completed', validatorOutcome: 'timeout',
        abortRollback: { storyId: 'US-001' },
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('validator 正常完成：iteration 记 validatorOutcome completed，无回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters[0]).toMatchObject({ validatorOutcome: 'completed' });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
  });
});

describe('no-op 检测与 stall 熔断', () => {
  it('builder 空转（双无变化）：跳过验收只跑 builder，连续 3 轮熔断 exit 1', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    // fake：只计数，什么都不写，正常退出（completed 但零产出 = no-op）
    writeFileSync(fake, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 10, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    // 缺省 stallLimit=3：恰 3 轮、每轮只有 builder 一次调用（validator 从未拉起）
    expect(readFileSync(calls, 'utf-8').length).toBe(3);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(3);
    expect(iters.every((r) => (r as { noop?: true }).noop === true)).toBe(true);
  });

  it('门禁打回轮不计 stall 且清零：打回多于 stallLimit 也不熔断', async () => {
    // qualityChecks 必败（false 命令）+ builder 每轮置 true → 每轮门禁打回（有 state 写入=有活动）
    const { workspace, instructionsDir } = setup([story()], { qualityChecks: ['false'] });
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 4, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    // 4 轮全是门禁打回（stallLimit=3 未触发熔断）→ 跑满，builder 每轮都拉起
    expect(readFileSync(calls, 'utf-8').length).toBe(4);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(4);
    expect(iters.every((r) => (r as { gateRejected?: true }).gateRejected === true)).toBe(true);
    expect(iters.every((r) => (r as { validatorOutcome?: string }).validatorOutcome === 'skipped')).toBe(true);
    expect(code).toBe(1);
  });

  it('stallLimit 可经配置调整', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(workspace, 'calls.txt');
    writeFileSync(fake, `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 10, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false, stallLimit: 1,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1);
    expect(readFileSync(calls, 'utf-8').length).toBe(1);
  });

  it('启动时已全部 resolved：完成判定优先于 stall 计数，直接 exit 0', async () => {
    // 断点续跑接手已完工 workspace 时，bootstrap 直接收敛，不需要制造 no-op 轮。
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
    }));
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);'); // 干净退出、不碰任何文件 = 真空转
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 3, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
  });

  it('已完工 workspace 启动即收敛：不调 agent，也不伪造 iteration', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    // 预置已完工 state；fake 不写任何文件（空转）
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
    }));
    const fake = join(workspace, 'fake.mjs');
    const called = join(workspace, 'called.txt');
    writeFileSync(fake, `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(called)}, 'x');`);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
    expect(existsSync(called)).toBe(false);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(0);
  });

  it('已收敛但含 blocked 的工作区重跑：no-op 快路径同样 exit 3 并列出 blocked story', async () => {
    const { workspace, instructionsDir } = setup([story(), story({ id: 'US-002', priority: 2 })]);
    writeFileSync(join(workspace, 'state.json'), JSON.stringify({
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      'US-002': { passes: false, notes: '[需要人工核实] 待裁决', retryCount: 0, blocked: true },
    }));
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `process.exit(0);`);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); origLog(...a); };
    const code = await runLoop({
      kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    console.log = origLog;
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(3);
    const banner = logs.find((l) => l.includes('blocked'));
    expect(banner).toContain('US-002');
    expect(logs.some((l) => l.includes('全部 story 已通过'))).toBe(false);
  });
});

describe('blocked 收敛出口', () => {
  it('全部 resolved 但存在 blocked：文案列出 story 号，exit 3', async () => {
    const { workspace, instructionsDir } = setup([story(), story({ id: 'US-002', priority: 2 })]);
    const fake = join(workspace, 'fake.mjs');
    // fake：US-001 通过、US-002 置 blocked（agent 仲裁上报形态）
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
        'US-002': { passes: false, notes: '[需要人工核实] 环境缺失', retryCount: 0, blocked: true },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => { logs.push(a.join(' ')); origLog(...a); };
    const code = await runLoop({
      kind: 'claude', maxIterations: 3, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    console.log = origLog;
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(3);
    const banner = logs.find((l) => l.includes('blocked'));
    expect(banner).toBeDefined();
    expect(banner).toContain('US-002');
    expect(banner).toContain('1 个 story 通过');
    expect(logs.some((l) => l.includes('全部 story 已通过'))).toBe(false);
  });

  it('全部通过无 blocked：维持 exit 0 与既有文案', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude', maxIterations: 2, devTimeoutMs: 5000, valTimeoutMs: 5000,
      workspace, instructionsDir, port: 0, openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
  });
});
