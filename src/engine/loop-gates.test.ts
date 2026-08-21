import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readEvidence } from './evidence.js';
import { runLoop as runProductionLoop, type LoopConfig } from './loop.js';
import type { QualityContract } from '../quality/contract.js';
import { digest } from '../review/common.js';
import {
  digestIssueExecutionContract,
  type IssueExecutionContract,
} from './issue-execution-contract.js';
import { withReadyIssueRunAuthority } from './issue-run-authority.js';
import {
  ISSUE_WORKSPACE_IDENTITY_FILE,
  renderIssueWorkspaceIdentity,
} from './issue-workspace-identity.js';
import {
  setup,
  story,
  runLoop,
  fakeCounting,
  currentRepoTdd,
  fakeBoundValidator,
  readyQualityContract,
  qualityContractWithNodeScript,
  strictConfig,
  TEST_QUALITY_CONTRACT,
} from './loop-test-support.js';

const READY_ISSUE_RUN_ID = `sha256:${'a'.repeat(64)}`;
const READY_ISSUE_BODY_DIGEST = `sha256:${'b'.repeat(64)}`;
const READY_ISSUE_PROJECT = 'owner/repository';
const READY_ISSUE_BRANCH = 'codex/issue-42';
const READY_ISSUE_SOURCE = 'docs/prds/prd-issue-42.md';

function readyIssuePrdFields(): Record<string, unknown> {
  return {
    project: READY_ISSUE_PROJECT,
    branchName: READY_ISSUE_BRANCH,
    description: `ready Issue fixture\n\nIssue-Run-ID: ${READY_ISSUE_RUN_ID}`,
    sourcePrd: READY_ISSUE_SOURCE,
  };
}

async function runAuthorizedReadyIssue(
  config: LoopConfig,
  input: {
    projectRoot: string;
    workspace: string;
    gitHead: string;
    executionContractDigest: string;
  },
): Promise<number> {
  return await withReadyIssueRunAuthority(
    {
      projectRoot: realpathSync(input.projectRoot),
      workspace: realpathSync(input.workspace),
      repository: READY_ISSUE_PROJECT,
      issueNumber: 42,
      bodyDigest: READY_ISSUE_BODY_DIGEST,
      branch: READY_ISSUE_BRANCH,
      pullRequest: 7,
      runId: READY_ISSUE_RUN_ID,
      executionContractDigest: input.executionContractDigest,
      gitHead: input.gitHead,
    },
    async (authority) => await runProductionLoop({ ...config, readyIssueRunAuthority: authority }),
  );
}

describe('runLoop quality gate', { timeout: 30_000, concurrent: false }, () => {
  it('does not let a persistent Issue workspace become an ordinary run after contract removal', async () => {
    const { workspace, instructionsDir } = setup([story()], readyIssuePrdFields());
    writeFileSync(
      join(workspace, ISSUE_WORKSPACE_IDENTITY_FILE),
      renderIssueWorkspaceIdentity({
        schemaVersion: 1,
        repository: READY_ISSUE_PROJECT,
        issueNumber: 42,
        bodyDigest: READY_ISSUE_BODY_DIGEST,
        branch: READY_ISSUE_BRANCH,
        pullRequest: 7,
        runId: READY_ISSUE_RUN_ID,
        sourcePrd: READY_ISSUE_SOURCE,
        executionContractDigest: `sha256:${'c'.repeat(64)}`,
      }),
    );
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(2);
      expect(existsSync(calls)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('validation-only clears the candidate only when a project command explicitly fails', async () => {
    const { workspace, instructionsDir, head } = setup([story()], {
      qualityChecks: ['node -e "process.exit(7)"'],
    });
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
          storyBaseGitHead: head(),
          validationReceipt: null,
          notes: 'candidate',
          retryCount: 2,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 3,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(1);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: false, validated: false, validationReceipt: null, retryCount: 3 });
      expect(existsSync(calls)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('stops at blocked after a fifth validation-only project-check failure without Developer', async () => {
    const { workspace, instructionsDir, head } = setup([story()], {
      qualityChecks: ['node -e "process.exit(7)"'],
    });
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
          storyBaseGitHead: head(),
          validationReceipt: null,
          notes: 'candidate',
          retryCount: 4,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 3,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(3);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: false, retryCount: 5, blocked: true });
      expect(existsSync(calls)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('validation-only preserves the candidate when a structured project command cannot start', async () => {
    const digest = `sha256:${'c'.repeat(64)}`;
    const contract = {
      ...TEST_QUALITY_CONTRACT,
      checks: {
        test: {
          checks: [
            {
              id: 'missing-executable',
              module: 'root',
              command: {
                executable: 'coding-x-command-that-does-not-exist',
                args: [],
                cwd: '.',
                platforms: ['linux', 'macos', 'windows'],
                timeoutMs: 1000,
              },
            },
          ],
        },
        build: { notApplicable: 'fixture' },
        static: { notApplicable: 'fixture' },
        security: { notApplicable: 'fixture' },
      },
    } as QualityContract;
    const { workspace, instructionsDir, head } = setup([story()], {
      qualityContractDigest: digest,
      qualityChecks: contract.checks,
    });
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
          storyBaseGitHead: head(),
          validationReceipt: null,
          notes: 'candidate',
          retryCount: 2,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runProductionLoop({
          ...strictConfig(workspace, instructionsDir),
          qualityContractReader: () => readyQualityContract(contract, digest),
        }),
      ).toBe(1);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({
        passes: true,
        validated: false,
        validationReceipt: null,
        notes: 'candidate',
        retryCount: 2,
      });
      expect(existsSync(calls)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('gate failure rolls the story back and skips the validator for that round', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "console.error(\'gate-boom\'); process.exit(7)"'],
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 1,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
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
    const contract = qualityContractWithNodeScript('process.exit(0)', 'passing-check');
    const contractDigest = digest(contract);
    const { workspace, instructionsDir } = setup([story()], {
      qualityContractDigest: contractDigest,
      qualityChecks: contract.checks,
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 5,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
        qualityContractReader: () => readyQualityContract(contract, contractDigest),
      });
      expect(code).toBe(0);
      // builder + validator 都跑了
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('injects the exact passed full gate into the structured Validator request', async () => {
    const contract = qualityContractWithNodeScript('process.exit(0)', 'passing-check');
    const contractDigest = digest(contract);
    const { workspace, instructionsDir } = setup(
      [story({ acceptanceCriteria: ['Tests pass'] })],
      {
        qualityContractDigest: contractDigest,
        qualityChecks: contract.checks,
      },
    );
    const promptMarker = join(resolve(workspace, '..'), 'validator-prompt.txt');
    const fake = fakeBoundValidator(workspace, 'passed', {
      validatorPromptMarker: promptMarker,
    });
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runProductionLoop({
          ...strictConfig(workspace, instructionsDir),
          qualityContractReader: () => readyQualityContract(contract, contractDigest),
        }),
      ).toBe(0);
      const prompt = readFileSync(promptMarker, 'utf8');
      expect(prompt).toContain('禁止重复执行相同命令');
      const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
      const jsonAt = prompt.indexOf('{', markerAt);
      const fenceAt = prompt.indexOf('\n```', jsonAt);
      const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
      expect(request.engineQualityGate).toMatchObject({
        source: 'engine-effective-gate',
        status: 'passed',
        gitHead: request.gitHead,
        total: 1,
        ran: 1,
        checks: [{ category: 'test', id: 'passing-check', module: 'root' }],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('sends only semantic criteria while binding explicit local reasons and leaving remote checks out', async () => {
    const base = qualityContractWithNodeScript('process.exit(0)', 'passing-check');
    const passingPolicy = base.checks.test;
    if (!('checks' in passingPolicy)) throw new Error('fixture requires a test check');
    passingPolicy.checks[0].paths = ['source.txt'];
    const contract = {
      ...base,
      checks: {
        ...base.checks,
        security: {
          checks: [
            {
              id: 'dependency-audit',
              module: 'root',
              paths: ['package.json', 'package-lock.json'],
              command: {
                executable: process.execPath,
                args: ['-e', 'process.exit(0)'],
                cwd: '.',
                platforms: ['linux'],
                timeoutMs: 5_000,
              },
            },
          ],
        },
      },
      github: {
        jobs: [
          {
            id: 'linux',
            platform: 'linux',
            toolchains: [],
            setup: [],
            checkIds: ['passing-check', 'dependency-audit'],
          },
          {
            id: 'macos',
            platform: 'macos',
            toolchains: [],
            setup: [],
            checkIds: ['passing-check'],
          },
          {
            id: 'windows',
            platform: 'windows',
            toolchains: [],
            setup: [],
            checkIds: ['passing-check'],
          },
        ],
        requiredChecks: ['quality-gate'],
      },
    } as QualityContract;
    const executionContract: IssueExecutionContract = {
      schemaVersion: 1,
      storyAcceptance: {
        evidenceSource: 'validator',
        network: 'disabled',
        criteria: ['返回结果符合语义要求'],
      },
      localChecks: {
        evidenceSource: 'engine',
        network: 'current-host',
        mode: 'scoped',
        checkIds: ['passing-check'],
      },
      remoteDelivery: {
        evidenceSource: 'github',
        network: 'github-actions',
        mode: 'scoped',
        checkIds: ['dependency-audit'],
        ruleset: 'required',
      },
      runMetrics: {
        evidenceSource: 'engine-clock',
        metrics: ['ready-to-trusted', 'active', 'waiting', 'continuations'],
      },
    };
    const contractDigest = digest(contract);
    const executionContractDigest = digestIssueExecutionContract(executionContract);
    const { projectRoot, workspace, instructionsDir, head } = setup(
      [story({ acceptanceCriteria: ['返回结果符合语义要求'] })],
      {
        ...readyIssuePrdFields(),
        qualityContractDigest: contractDigest,
        qualityChecks: contract.checks,
        executionContract,
        executionContractDigest,
      },
    );
    const promptMarker = join(resolve(workspace, '..'), 'responsibility-validator-prompt.txt');
    const fake = fakeBoundValidator(workspace, 'passed', {
      validatorPromptMarker: promptMarker,
    });
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const config: LoopConfig = {
        ...strictConfig(workspace, instructionsDir),
        qualityContractReader: () => readyQualityContract(contract, contractDigest),
        storyChangeManifestForTests: () => ({
          digest: `sha256:${'f'.repeat(64)}`,
          changedPathCount: 1,
          changeSelection: {
            matchedPathCheckIds: ['passing-check'],
            allChangedPathsMatched: true,
          },
        }),
      };
      expect(await runProductionLoop(config)).toBe(2);
      expect(existsSync(promptMarker)).toBe(false);
      expect(
        await runAuthorizedReadyIssue(config, {
          projectRoot,
          workspace,
          gitHead: head(),
          executionContractDigest,
        }),
      ).toBe(0);
      const prompt = readFileSync(promptMarker, 'utf8');
      const markerAt = prompt.indexOf('<!-- ENGINE-BOUND VALIDATION REQUEST');
      const jsonAt = prompt.indexOf('{', markerAt);
      const fenceAt = prompt.indexOf('\n```', jsonAt);
      const request = JSON.parse(prompt.slice(jsonAt, fenceAt));
      expect(request.acceptanceCriteria).toEqual(['返回结果符合语义要求']);
      expect(request.engineQualityGate).toMatchObject({
        checks: [{ id: 'passing-check' }],
        skippedCheckIds: ['dependency-audit'],
        selectionRequirement: { mode: 'scoped', checkIds: ['passing-check'] },
        selectionReasons: [
          { checkId: 'passing-check', sources: ['path', 'explicit'] },
        ],
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('rejects a non-Codex ready Issue workspace before any Agent starts', async () => {
    const contract = {
      ...TEST_QUALITY_CONTRACT,
      github: {
        jobs: [
          {
            id: 'fixture',
            platform: 'linux',
            toolchains: [],
            setup: [],
            checkIds: ['fixture-pass'],
          },
        ],
        requiredChecks: ['quality-gate'],
      },
    } as QualityContract;
    const contractDigest = digest(contract);
    const executionContract: IssueExecutionContract = {
      schemaVersion: 1,
      storyAcceptance: {
        evidenceSource: 'validator',
        network: 'disabled',
        criteria: ['行为成立'],
      },
      localChecks: {
        evidenceSource: 'engine',
        network: 'current-host',
        mode: 'scoped',
        checkIds: [],
      },
      remoteDelivery: {
        evidenceSource: 'github',
        network: 'github-actions',
        mode: 'scoped',
        checkIds: [],
        ruleset: 'required',
      },
      runMetrics: {
        evidenceSource: 'engine-clock',
        metrics: ['ready-to-trusted', 'active', 'waiting', 'continuations'],
      },
    };
    const executionContractDigest = digestIssueExecutionContract(executionContract);
    const { projectRoot, workspace, instructionsDir, head } = setup(
      [story({ acceptanceCriteria: ['行为成立'] })],
      {
        ...readyIssuePrdFields(),
        qualityContractDigest: contractDigest,
        qualityChecks: contract.checks,
        executionContract,
        executionContractDigest,
      },
    );
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runAuthorizedReadyIssue(
          {
            ...strictConfig(workspace, instructionsDir),
            validatorRunnerBindingForTests: undefined,
            qualityContractReader: () => readyQualityContract(contract, contractDigest),
          },
          {
            projectRoot,
            workspace,
            gitHead: head(),
            executionContractDigest,
          },
        ),
      ).toBe(2);
      expect(existsSync(calls)).toBe(false);
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
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 5,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
      });
      // 历史兼容路径仍会报警并跳过该字段，但新当前性规则不会让无效快照
      // 获得最终 Review 绿灯。
      expect(code).toBe(2);
      expect(warns.some((w) => w.includes('qualityChecks 形状非法'))).toBe(true);
      expect(readFileSync(calls, 'utf-8').trim().split('\n')).toHaveLength(2);
    } finally {
      console.warn = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('an agent-set blocked story skips the gate and validator for that round and resolves the loop', async () => {
    const gateMark = join(tmpdir(), `coding-x-gate-mark-${Date.now()}`);
    const contract = qualityContractWithNodeScript(
      `require('node:fs').writeFileSync(${JSON.stringify(gateMark)}, 'ran')`,
      'must-be-skipped',
    );
    const contractDigest = digest(contract);
    const { workspace, instructionsDir } = setup([story()], {
      qualityContractDigest: contractDigest,
      qualityChecks: contract.checks,
    });
    // stub agent：不置 passes，而是显式置 blocked（模拟 dogfood US-009 的仲裁上报）
    const fake = join(workspace, 'fake-blocking.mjs');
    const calls = join(resolve(workspace, '..'), 'calls.txt');
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = false;
      state['US-001'].notes = '[需要人工核实] 疑似配置异常，已附调查';
      state['US-001'].blocked = true;
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 3,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
        qualityContractReader: () => readyQualityContract(contract, contractDigest),
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
      expect(iters[0]).toMatchObject({
        agentBlocked: true,
        validatorRan: false,
        validatorOutcome: 'skipped',
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
      rmSync(gateMark, { force: true });
    }
  });
});

describe('runLoop TDD gate', { timeout: 30_000, concurrent: false }, () => {
  it('fails closed before any agent starts when tdd config is malformed', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      tdd: { coverageCheck: '' },
    });
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(1);
      expect(existsSync(calls)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('reruns the TDD command after builder, rejects the story, and skips validator', async () => {
    const fixture = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
    });
    const { workspace, instructionsDir } = fixture;
    const prdPath = join(workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.tdd = currentRepoTdd(
      'node -e "console.error(\'coverage 80% < 90%\'); process.exit(7)"',
      fixture.head(),
    );
    writeFileSync(prdPath, JSON.stringify(prd));
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(1);
      expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'];
      expect(state).toMatchObject({ passes: false, retryCount: 1, blocked: false });
      expect(state.notes).toContain('coverage 80% < 90%');
      const records = readEvidence(workspace).records;
      expect(records.filter((record) => record.type === 'tdd-gate')).toHaveLength(2);
      expect(
        records.find((record) => record.type === 'tdd-gate' && record.phase === 'post-builder'),
      ).toMatchObject({
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

  it('stops at blocked after a fifth validation-only TDD failure without Developer', async () => {
    const fixture = setup([story()]);
    const { workspace, instructionsDir } = fixture;
    const prdPath = join(workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.tdd = currentRepoTdd('node -e "process.exit(7)"', fixture.head());
    writeFileSync(prdPath, JSON.stringify(prd));
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
          storyBaseGitHead: fixture.head(),
          validationReceipt: null,
          notes: 'candidate',
          retryCount: 4,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const { fake, calls } = fakeCounting(workspace);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 3,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(3);
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'],
      ).toMatchObject({ passes: false, retryCount: 5, blocked: true });
      expect(existsSync(calls)).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('passes coding-x workspace and project root to both agents and lets validator run after TDD passes', async () => {
    const fixture = setup([story()]);
    const { workspace, instructionsDir, projectRoot } = fixture;
    const prdPath = join(workspace, 'prd.json');
    const prd = JSON.parse(readFileSync(prdPath, 'utf8'));
    prd.tdd = currentRepoTdd('node -e "process.exit(0)"', fixture.head());
    writeFileSync(prdPath, JSON.stringify(prd));
    const calls = join(resolve(workspace, '..'), 'env-calls.jsonl');
    const fake = fakeBoundValidator(workspace, 'passed', { environmentMarker: calls });
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(await runProductionLoop(strictConfig(workspace, instructionsDir))).toBe(0);
      const envs = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(envs).toHaveLength(2);
      expect(envs).toEqual([
        { workspace: realpathSync.native(workspace), projectRoot: resolve(projectRoot) },
        { workspace: realpathSync.native(workspace), projectRoot: resolve(projectRoot) },
      ]);
      expect(
        readEvidence(workspace).records.find(
          (record) => record.type === 'tdd-gate' && record.phase === 'post-builder',
        ),
      ).toMatchObject({
        ok: true,
        policyOk: true,
        commandRan: true,
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});
