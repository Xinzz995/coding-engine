import { afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runLoop as runProductionLoop, type LoopConfig } from './loop.js';
import type { QualityContract, QualityContractReadResult } from '../quality/contract.js';
import { CODING_X_VERSION } from '../version.js';
import { digest } from '../review/common.js';
import type { FinalReviewState } from '../review/types.js';

export const TEST_QUALITY_DIGEST = `sha256:${'a'.repeat(64)}`;

export const TEST_QUALITY_CONTRACT = {
  codingXVersion: CODING_X_VERSION,
  checks: {
    test: { notApplicable: 'fixture' },
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
  },
} as QualityContract;

export const readyQualityContract = (
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

export function setup(
  prdStories: unknown[],
  prdExtra: Record<string, unknown> = {},
): { workspace: string; instructionsDir: string } {
  const workspace = mkdtempSync(join(tmpdir(), 'loop-ws-'));
  const instructionsDir = mkdtempSync(join(tmpdir(), 'loop-ins-'));
  cleanup.push(() => rmSync(workspace, { recursive: true, force: true }));
  cleanup.push(() => rmSync(instructionsDir, { recursive: true, force: true }));
  writeFileSync(
    join(workspace, 'prd.json'),
    JSON.stringify({
      project: 'p',
      branchName: 'ralph/x',
      description: 'd',
      userStories: prdStories,
      qualityContractDigest: TEST_QUALITY_DIGEST,
      qualityChecks: TEST_QUALITY_CONTRACT.checks,
      ...prdExtra,
    }),
  );
  writeFileSync(join(instructionsDir, 'builder.md'), 'build it');
  writeFileSync(join(instructionsDir, 'validator.md'), 'validate it');
  return { workspace, instructionsDir };
}

export const story = (over: Record<string, unknown> = {}) => ({
  id: 'US-001',
  title: 't',
  description: 'd',
  acceptanceCriteria: [],
  priority: 1,
  ...over,
});

export const routedStory = (over: Record<string, unknown> = {}) =>
  story({
    difficulty: 'medium',
    difficultyReason: '命中 medium-1：沿用 src/api.ts 的既有接线模式。',
    ...over,
  });

export const modelConfig = () => ({
  runner: 'claude',
  builder: { low: 'low-m', medium: 'fast-m', high: 'high-m' },
  validator: 'val-m',
  escalation: 'esc-m',
});

export const catalogWith =
  (...ids: string[]) =>
  () =>
    Promise.resolve({
      status: 'available' as const,
      runner: 'claude' as const,
      source: 'global-config' as const,
      configPath: '/fixture/config.json',
      models: ids.map((id) => ({ id })),
    });

export const finalReviewPass: NonNullable<LoopConfig['finalReviewRunner']> = (options) =>
  Promise.resolve({
    exitCode: options.shadow ? 7 : 0,
    message: options.shadow ? 'fixture shadow review' : 'fixture final review passed',
  });

export function previousFinalReview(headSha: string): FinalReviewState {
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
        axis: 'spec',
        status: 'passed',
        summary: 'ok',
        findings: [],
        requestDeepReview: false,
        durationMs: 1,
        attempts: 1,
      },
      {
        axis: 'engineering',
        status: 'passed',
        summary: 'ok',
        findings: [],
        requestDeepReview: false,
        durationMs: 1,
        attempts: 1,
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
export const read = (f: string) =>
  readFileSync(new URL(`../../assets/instructions/${f}`, import.meta.url), 'utf-8');

// 历史 fixture 让 fake Validator 直接改 state；保留这些状态机回归时必须显式
// opt-in，生产 runLoop 默认始终走结构化 validation protocol。新协议集成测试直接
// 调 runProductionLoop，防止 test-only 兼容路径遮住假绿。
export const runLoop = (cfg: LoopConfig): Promise<number> =>
  runProductionLoop({
    ...cfg,
    qualityContractReader: () => readyQualityContract(),
    legacyValidatorProtocolForTests: true,
    finalReviewRunner: cfg.finalReviewRunner ?? finalReviewPass,
  });

// builder 与 validator 共用同一 stub 二进制：以调用计数文件区分谁跑了。
export function fakeCounting(workspace: string): { fake: string; calls: string } {
  const fake = join(workspace, 'fake.mjs');
  const calls = join(workspace, 'calls.txt');
  writeFileSync(
    fake,
    `
    import { writeFileSync, appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(calls)}, 'call\\n');
    writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
      'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
    }));
    process.exit(0);
  `,
  );
  return { fake, calls };
}

export type BoundValidatorMode =
  'passed' | 'failed' | 'missing' | 'wrong-story' | 'state-mutation' | 'aborted-after-result';

export function fakeBoundValidator(workspace: string, mode: BoundValidatorMode): string {
  const fake = join(workspace, `fake-bound-${mode}.mjs`);
  const calls = join(workspace, 'bound-calls.txt');
  const statePath = join(workspace, 'state.json');
  const progressPath = join(workspace, 'progress.md');
  writeFileSync(
    fake,
    String.raw`
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
  `,
  );
  return fake;
}

export function strictConfig(workspace: string, instructionsDir: string): LoopConfig {
  return {
    kind: 'claude',
    maxIterations: 1,
    devTimeoutMs: 5000,
    valTimeoutMs: 5000,
    workspace,
    instructionsDir,
    port: 0,
    openBrowser: false,
    stallLimit: 3,
    qualityContractReader: () => readyQualityContract(),
    finalReviewRunner: finalReviewPass,
  };
}

export function currentRepoTdd(coverageCheck: string): Record<string, unknown> {
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
