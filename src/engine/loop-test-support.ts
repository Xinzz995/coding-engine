import { afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  writeFileSync,
  rmSync,
  readFileSync,
  realpathSync,
  statSync,
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { createHash } from 'node:crypto';
import { runLoop as runProductionLoop, type LoopConfig } from './loop.js';
import type { QualityContract, QualityContractReadResult } from '../quality/contract.js';
import { CODING_X_VERSION } from '../version.js';
import { digest } from '../review/common.js';
import type { FinalReviewState } from '../review/types.js';
import { acceptanceHash } from './validation-protocol.js';
import type { ValidationReceipt } from './state.js';
import {
  bindStoryValidationRuntimeIdentity,
  type StoryValidationRuntimeIdentity,
} from './story-validation-currentness.js';
import {
  INCIDENTS_DIR,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
  PROTOCOL_SCHEMA_VERSION,
  WORKSPACE_MARKER_FILE,
  WORKSPACE_MARKER_SCHEMA_VERSION,
  WORKSPACE_PROTOCOL,
  WORKSPACE_SAFETY_VERSION,
} from '../workspace-safety/types.js';
import { workspaceDirectoryIdentity } from '../workspace-safety/filesystem.js';

/** Test Runner shim: production Codex/Claude receive prompts on stdin; Cursor uses its last arg. */
export const FAKE_RUNNER_INPUT_SOURCE = String.raw`
const codingXPromptChunks = [];
for await (const chunk of process.stdin) codingXPromptChunks.push(chunk);
const codingXStdinPrompt = Buffer.concat(codingXPromptChunks).toString('utf8');
const prompt = codingXStdinPrompt.length > 0
  ? codingXStdinPrompt
  : (process.argv.at(-1) ?? '');
const runnerArgv = codingXStdinPrompt.length > 0
  ? process.argv.slice(2)
  : process.argv.slice(2, -1);
`;

export const TEST_QUALITY_DIGEST = `sha256:${'a'.repeat(64)}`;
export const TEST_VALIDATION_ENVIRONMENT_DIGEST = `sha256:${'e'.repeat(64)}`;
/** 历史 fixture 的 Runner 宿主隔离绑定（ADR-025）；真实链路测试用真实 profile/canary 摘要。 */
export const TEST_VALIDATOR_PROFILE_DIGEST = `sha256:${'d'.repeat(64)}`;
export const TEST_VALIDATOR_CANARY_DIGEST = `sha256:${'c'.repeat(64)}`;
export const TEST_VALIDATOR_RUNNER_BINDING = {
  profileDigest: TEST_VALIDATOR_PROFILE_DIGEST,
  canaryDigest: TEST_VALIDATOR_CANARY_DIGEST,
} as const;
export const TEST_FORMAL_VALIDATION_ENVIRONMENT_DIGEST = bindStoryValidationRuntimeIdentity(
  TEST_VALIDATION_ENVIRONMENT_DIGEST,
  { mode: 'formal', actualCodingXVersion: CODING_X_VERSION },
);

export const TEST_QUALITY_CONTRACT = {
  codingXVersion: CODING_X_VERSION,
  checks: {
    test: {
      checks: [
        {
          id: 'fixture-pass',
          module: 'root',
          command: {
            executable: process.execPath,
            args: ['--input-type=module', '-e', 'process.exit(0)'],
            cwd: '.',
            platforms: ['linux', 'macos', 'windows'],
            timeoutMs: 5_000,
          },
        },
      ],
    },
    build: { notApplicable: 'fixture' },
    static: { notApplicable: 'fixture' },
    security: { notApplicable: 'fixture' },
  },
  generatedPaths: [],
  localValidation: { prepare: [], allowedPaths: [] },
} as unknown as QualityContract;

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
): ReturnType<typeof setupGitProject> {
  return setupGitProject(prdStories, prdExtra);
}

/**
 * 需要验证提交身份的集成测试必须拥有自己的仓库，不能借用测试进程所在仓库的 HEAD。
 * workspace 被首个提交忽略，后续 H1→H2 只由测试显式提交的文件推进。
 */
export function setupGitProject(
  prdStories: unknown[],
  prdExtra: Record<string, unknown> = {},
): {
  projectRoot: string;
  workspace: string;
  instructionsDir: string;
  head: () => string;
  commitFile: (contents: string, message?: string) => string;
} {
  const projectRoot = mkdtempSync(join(tmpdir(), 'loop-project-'));
  const workspace = join(projectRoot, '.workspace');
  const instructionsDir = mkdtempSync(join(tmpdir(), 'loop-ins-'));
  mkdirSync(workspace, { recursive: true });
  cleanup.push(() => rmSync(projectRoot, { recursive: true, force: true }));
  cleanup.push(() => rmSync(instructionsDir, { recursive: true, force: true }));
  execFileSync('git', ['init', '-q', '-b', 'main'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.name', 'coding-x test'], { cwd: projectRoot });
  execFileSync('git', ['config', 'user.email', 'coding-x-test@example.invalid'], {
    cwd: projectRoot,
  });
  execFileSync('git', ['config', 'commit.gpgsign', 'false'], { cwd: projectRoot });
  writeFileSync(join(projectRoot, '.gitignore'), '.workspace/\n');
  writeFileSync(join(projectRoot, 'source.txt'), 'H1\n');
  execFileSync('git', ['add', '.gitignore', 'source.txt'], { cwd: projectRoot });
  execFileSync('git', ['commit', '-q', '-m', 'test: H1'], { cwd: projectRoot });
  initializeReadyWorkspaceFixture(workspace);
  mkdirSync(join(workspace, 'screenshots'));
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
  const head = () =>
    execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: projectRoot,
      encoding: 'utf8',
    })
      .trim()
      .toLowerCase();
  const commitFile = (contents: string, message = 'test: H2') => {
    writeFileSync(join(projectRoot, 'source.txt'), contents);
    execFileSync('git', ['add', 'source.txt'], { cwd: projectRoot });
    execFileSync('git', ['commit', '-q', '-m', message], { cwd: projectRoot });
    return head();
  };
  return { projectRoot, workspace, instructionsDir, head, commitFile };
}

/**
 * 为同步的 loop 测试夹具建立与正式 bootstrap 完全相同的静态 ready 记录。
 *
 * 正式 bootstrap 是异步且会短暂持有 lease；这里仅用于测试准备阶段，并且必须在
 * 写入任何业务文件前调用。身份与摘要都从真实目录重新计算，避免用伪标记绕过
 * 运行时校验。
 */
export function initializeReadyWorkspaceFixture(workspacePath: string): void {
  const canonicalPath = realpathSync.native(workspacePath);
  const info = statSync(canonicalPath, { bigint: true });
  const digestBytes = (bytes: string | Buffer) =>
    `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
  const workspaceIdentity = workspaceDirectoryIdentity(canonicalPath, info);
  const timestamp = '2026-07-30T00:00:00.000Z';
  const protocolBytes = `${JSON.stringify(
    {
      schemaVersion: PROTOCOL_SCHEMA_VERSION,
      protocol: WORKSPACE_PROTOCOL,
      workspaceIdentity,
      createdBy: WORKSPACE_SAFETY_VERSION,
      createdAt: timestamp,
    },
    null,
    2,
  )}\n`;
  const protocolRoot = join(canonicalPath, PROTOCOL_ROOT_DIR);
  mkdirSync(join(protocolRoot, INCIDENTS_DIR), { recursive: true, mode: 0o700 });
  writeFileSync(join(protocolRoot, PROTOCOL_FILE), protocolBytes, { mode: 0o600 });
  writeFileSync(
    join(canonicalPath, WORKSPACE_MARKER_FILE),
    `${JSON.stringify(
      {
        schemaVersion: WORKSPACE_MARKER_SCHEMA_VERSION,
        initializedBy: WORKSPACE_SAFETY_VERSION,
        workspaceIdentity,
        protocolDigest: digestBytes(protocolBytes),
        initializedAt: timestamp,
      },
      null,
      2,
    )}\n`,
    { mode: 0o600 },
  );
}

export const story = (over: Record<string, unknown> = {}) => ({
  id: 'US-001',
  title: 't',
  description: 'd',
  acceptanceCriteria: [],
  priority: 1,
  ...over,
});

export function validationReceiptFor(
  target: { id: string; acceptanceCriteria: string[] },
  gitHead: string,
  requestId = 'fixture-validator-request',
  runtimeIdentity: StoryValidationRuntimeIdentity = {
    mode: 'formal',
    actualCodingXVersion: CODING_X_VERSION,
  },
): ValidationReceipt {
  return {
    schemaVersion: 3,
    requestId,
    gitHead,
    acceptanceHash: acceptanceHash(target.id, target.acceptanceCriteria),
    validationEnvironmentDigest: bindStoryValidationRuntimeIdentity(
      TEST_VALIDATION_ENVIRONMENT_DIGEST,
      runtimeIdentity,
    ),
    runnerProfileDigest: TEST_VALIDATOR_PROFILE_DIGEST,
    canaryEvidenceDigest: TEST_VALIDATOR_CANARY_DIGEST,
  };
}

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
    schemaVersion: 2,
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
      validationEnvironmentDigest: `sha256:${'0'.repeat(64)}`,
      storyValidationDigest: `sha256:${'1'.repeat(64)}`,
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
    projectRoot: cfg.projectRoot ?? resolve(cfg.workspace, '..'),
    qualityContractReader: cfg.qualityContractReader ?? (() => readyQualityContract()),
    legacyValidatorProtocolForTests: true,
    unsafeUseProjectRootForValidationTests: true,
    validationEnvironmentDigestForTests: TEST_VALIDATION_ENVIRONMENT_DIGEST,
    validatorRunnerBindingForTests: cfg.validatorRunnerBindingForTests ?? TEST_VALIDATOR_RUNNER_BINDING,
    finalReviewRunner: cfg.finalReviewRunner ?? finalReviewPass,
  });

/** 为需要真实执行一条项目检查的 loop fixture 建立与 PRD 完全一致的结构化契约。 */
export function qualityContractWithNodeScript(
  script: string,
  id = 'fixture-node-check',
): QualityContract {
  return {
    ...structuredClone(TEST_QUALITY_CONTRACT),
    checks: {
      test: {
        checks: [
          {
            id,
            module: 'root',
            command: {
              executable: process.execPath,
              args: ['-e', script],
              cwd: '.',
              platforms: ['linux', 'macos', 'windows'],
              timeoutMs: 5_000,
            },
          },
        ],
      },
      build: { notApplicable: 'fixture' },
      static: { notApplicable: 'fixture' },
      security: { notApplicable: 'fixture' },
    },
  };
}

// builder 与 validator 共用同一 stub 二进制：以调用计数文件区分谁跑了。
export function fakeCounting(workspace: string): { fake: string; calls: string } {
  const fake = join(workspace, 'fake.mjs');
  const calls = join(resolve(workspace, '..'), 'calls.txt');
  writeFileSync(
    fake,
    `
    import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    appendFileSync(${JSON.stringify(calls)}, 'call\\n');
    const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    state['US-001'].passes = true;
    state['US-001'].notes = '';
    state['US-001'].blocked = false;
    writeFileSync(statePath, JSON.stringify(state));
    process.exit(0);
  `,
  );
  return { fake, calls };
}

export type BoundValidatorMode =
  | 'passed'
  | 'failed'
  | 'missing'
  | 'invalid-json'
  | 'oversized'
  | 'wrong-story'
  | 'state-mutation'
  | 'exit101-no-result'
  | 'output-overflow'
  | 'output-then-missing'
  | 'aborted-after-result';

export interface FakeBoundValidatorOptions {
  readonly builderCwdMarker?: string;
  readonly builderPromptMarker?: string;
  readonly environmentMarker?: string;
  readonly validatorCwdMarker?: string;
  readonly validatorVisibilityMarker?: string;
}

export function fakeBoundValidator(
  workspace: string,
  mode: BoundValidatorMode,
  options: FakeBoundValidatorOptions = {},
): string {
  const fake = join(workspace, `fake-bound-${mode}.mjs`);
  const calls = join(resolve(workspace, '..'), 'bound-calls.txt');
  const statePath = join(workspace, 'state.json');
  const progressPath = join(workspace, 'progress.md');
  writeFileSync(
    fake,
    String.raw`
    import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
    ${FAKE_RUNNER_INPUT_SOURCE}
    const statePath = ${JSON.stringify(statePath)};
    let call = 1;
    try { call = Number(readFileSync(${JSON.stringify(calls)}, 'utf8')) + 1; } catch {}
    writeFileSync(${JSON.stringify(calls)}, String(call));
    const environmentMarker = ${JSON.stringify(options.environmentMarker ?? null)};
    if (environmentMarker !== null) {
      appendFileSync(environmentMarker, JSON.stringify({
        workspace: process.env.CODING_X_WORKSPACE,
        projectRoot: process.env.CODING_X_PROJECT_ROOT,
      }) + '\n');
    }
    if (call === 1) {
      const cwdMarker = ${JSON.stringify(options.builderCwdMarker ?? null)};
      const promptMarker = ${JSON.stringify(options.builderPromptMarker ?? null)};
      if (cwdMarker !== null) writeFileSync(cwdMarker, process.cwd());
      if (promptMarker !== null) writeFileSync(promptMarker, prompt);
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = true;
      state['US-001'].validated = false;
      writeFileSync(statePath, JSON.stringify(state, null, 2));
      appendFileSync(${JSON.stringify(progressPath)}, '## builder completed US-001\n');
      process.exit(0);
    }
    const validatorCwdMarker = ${JSON.stringify(options.validatorCwdMarker ?? null)};
    if (validatorCwdMarker !== null) writeFileSync(validatorCwdMarker, process.cwd());
    const validatorVisibilityMarker = ${JSON.stringify(options.validatorVisibilityMarker ?? null)};
    if (validatorVisibilityMarker !== null) {
      writeFileSync(validatorVisibilityMarker, JSON.stringify({
        env: existsSync('.env'),
        claude: existsSync('.claude'),
        nodeModules: existsSync('node_modules'),
        virtualEnv: process.env.VIRTUAL_ENV ?? null,
        pythonPath: process.env.PYTHONPATH ?? null,
        nodePath: process.env.NODE_PATH ?? null,
        nodeOptions: process.env.NODE_OPTIONS ?? null,
        path: process.env.PATH ?? '',
      }));
    }
    const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
    const jsonAt = prompt.indexOf('{', markerAt);
    const fenceAt = prompt.indexOf(String.fromCharCode(10, 96, 96, 96), jsonAt);
    if (markerAt < 0 || jsonAt < 0 || fenceAt < 0) process.exit(9);
    const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
    const mode = ${JSON.stringify(mode)};
    if (mode === 'missing') process.exit(0);
    if (mode === 'exit101-no-result') process.exit(101);
    if (mode === 'output-overflow') {
      let remaining = 16 * 1024 * 1024 + 1;
      const chunk = 'x'.repeat(64 * 1024);
      while (remaining > 0) {
        const bytes = chunk.slice(0, Math.min(chunk.length, remaining));
        remaining -= bytes.length;
        if (!process.stdout.write(bytes)) {
          await new Promise((resolveDrain) => process.stdout.once('drain', resolveDrain));
        }
      }
      await new Promise((resolveWrite) => process.stdout.write('', resolveWrite));
      process.exit(0);
    }
    if (mode === 'output-then-missing') {
      process.stdout.write('validator output before sink failure\n');
      process.exit(0);
    }
    if (mode === 'invalid-json') {
      writeFileSync(request.resultPath, '{broken');
      process.exit(0);
    }
    if (mode === 'oversized') {
      writeFileSync(request.resultPath, 'x'.repeat(64 * 1024 + 1));
      process.exit(0);
    }
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
    process.exit(mode === 'aborted-after-result' ? 101 : 0);
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
    projectRoot: resolve(workspace, '..'),
    instructionsDir,
    port: 0,
    openBrowser: false,
    stallLimit: 3,
    qualityContractReader: () => readyQualityContract(),
    finalReviewRunner: finalReviewPass,
    unsafeUseProjectRootForValidationTests: true,
    validationEnvironmentDigestForTests: TEST_VALIDATION_ENVIRONMENT_DIGEST,
    validatorRunnerBindingForTests: TEST_VALIDATOR_RUNNER_BINDING,
  };
}

export function currentRepoTdd(
  coverageCheck: string,
  baselineRef: string,
): Record<string, unknown> {
  return {
    coverageCheck,
    sourcePathspecs: [':(glob)src/__coding_x_tdd_fixture_only__/**'],
    policyFiles: [],
    baselineRef,
    forbiddenAddedPatterns: ['istanbul ignore', 'c8 ignore'],
  };
}
