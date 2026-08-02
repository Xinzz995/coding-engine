import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync, readFileSync, existsSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readEvidence } from './evidence.js';
import { runLoop as runProductionLoop } from './loop.js';
import type { QualityContract } from '../quality/contract.js';
import {
  setup,
  story,
  runLoop,
  fakeCounting,
  currentRepoTdd,
  fakeBoundValidator,
  readyQualityContract,
  strictConfig,
  TEST_QUALITY_CONTRACT,
} from './loop-test-support.js';

describe('runLoop quality gate', { timeout: 30_000, concurrent: false }, () => {
  it('validation-only clears the candidate only when a project command explicitly fails', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(7)"'],
    });
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
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
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(7)"'],
    });
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
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
    const { workspace, instructionsDir } = setup([story()], {
      qualityContractDigest: digest,
      qualityChecks: contract.checks,
    });
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: false,
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
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
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
