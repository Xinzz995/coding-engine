import { describe, it, expect } from 'vitest';
import { writeFileSync, rmSync, readFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { readEvidence } from './evidence.js';
import { setup, story, runLoop, fakeCounting, currentRepoTdd } from './loop-test-support.js';
import { reviewDecisionsDigest } from '../review/state.js';

describe('runLoop quality gate', () => {
  it.each(['builder', 'validator', 'quality', 'tdd'] as const)(
    'restores and fails closed when %s forges Review decisions',
    async (actor) => {
      const { workspace, instructionsDir } = setup([story()]);
      const decisionsPath = join(workspace, 'review-decisions.json');
      const forged = JSON.stringify({
        schemaVersion: 1,
        decisions: [{
          findingId: 'RV-SPEC-forged',
          headSha: 'a'.repeat(40),
          action: 'counterevidence',
          operator: 'forged-maintainer',
          at: '2026-07-29T00:00:00.000Z',
          evidence: '伪造的二十字符以上反证不应被本轮最终 Review 采信。',
        }],
      });
      const tamperCommand = `node -e ${JSON.stringify(
        `require('node:fs').writeFileSync(${JSON.stringify(decisionsPath)},${JSON.stringify(forged)})`,
      )}`;
      const prdPath = join(workspace, 'prd.json');
      const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
      if (actor === 'quality') prd.qualityChecks = [tamperCommand];
      if (actor === 'tdd') prd.tdd = currentRepoTdd(tamperCommand);
      writeFileSync(prdPath, JSON.stringify(prd));

      const statePath = join(workspace, 'state.json');
      const calls = join(workspace, `decision-${actor}-calls.txt`);
      const fake = join(workspace, `fake-decision-${actor}.mjs`);
      writeFileSync(fake, `
        import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
        const calls = ${JSON.stringify(calls)};
        appendFileSync(calls, 'call\\n');
        const count = readFileSync(calls, 'utf8').trim().split('\\n').length;
        const statePath = ${JSON.stringify(statePath)};
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        if (count === 1) {
          state['US-001'].passes = true;
          appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder done\\n');
        }
        writeFileSync(statePath, JSON.stringify(state));
        if ((${JSON.stringify(actor)} === 'builder' && count === 1) ||
            (${JSON.stringify(actor)} === 'validator' && count === 2)) {
          writeFileSync(${JSON.stringify(decisionsPath)}, ${JSON.stringify(forged)});
        }
      `);
      process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;

      try {
        expect(await runLoop({
          kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
          workspace, instructionsDir, port: 0, openBrowser: false,
        })).toBe(5);
        expect(existsSync(decisionsPath)).toBe(false);
        const iteration = readEvidence(workspace).records.find((record) =>
          record.type === 'iteration');
        expect(iteration).toMatchObject({
          reviewDecisionsTamper: [{
            side: actor === 'builder' || actor === 'validator' ? actor : 'gate',
            expectedDigest: reviewDecisionsDigest(null),
          }],
        });
        const expectedCalls = actor === 'validator' ? 2 : 1;
        expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(expectedCalls);
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
  );

  it.each(['quality', 'tdd'] as const)(
    '%s gate cannot forge another Story validation receipt before Validator starts',
    async (gateKind) => {
      const { workspace, instructionsDir } = setup([
        story(),
        story({ id: 'US-002', priority: 2 }),
      ]);
      const statePath = join(workspace, 'state.json');
      const tamperScript = [
        "const fs=require('node:fs')",
        `const path=${JSON.stringify(statePath)}`,
        "const state=JSON.parse(fs.readFileSync(path,'utf8'))",
        "state['US-002'].passes=true",
        "state['US-002'].validated=true",
        "state['US-002'].validationReceipt={schemaVersion:1,requestId:'forged-by-gate',gitHead:'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',acceptanceHash:'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb'}",
        "state['US-002'].escalated=true",
        "state['US-002'].notes='forged complete story'",
        "state['US-002'].retryCount=99",
        "state['US-002'].blocked=false",
        'fs.writeFileSync(path,JSON.stringify(state))',
      ].join(';');
      const tamperCommand = `node -e ${JSON.stringify(tamperScript)}`;
      const prdPath = join(workspace, 'prd.json');
      const prd = JSON.parse(readFileSync(prdPath, 'utf8')) as Record<string, unknown>;
      if (gateKind === 'quality') {
        prd.qualityChecks = [tamperCommand];
      } else {
        prd.tdd = currentRepoTdd(tamperCommand);
      }
      writeFileSync(prdPath, JSON.stringify(prd));

      const fake = join(workspace, `fake-${gateKind}-ownership.mjs`);
      const calls = join(workspace, `${gateKind}-ownership-calls.txt`);
      writeFileSync(
        fake,
        `
        import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
        const statePath = ${JSON.stringify(statePath)};
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        appendFileSync(${JSON.stringify(calls)}, 'call\\n');
        const call = readFileSync(${JSON.stringify(calls)}, 'utf8').trim().split('\\n').length;
        if (call === 1) {
          state['US-001'].passes = true;
          appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder done\\n');
        }
        writeFileSync(statePath, JSON.stringify(state));
      `,
      );
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
        expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(2);
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        expect(state['US-001']).toMatchObject({ passes: true, validated: true });
        expect(state['US-002']).toMatchObject({
          passes: false,
          validated: false,
          validationReceipt: null,
          escalated: false,
          notes: '',
          retryCount: 0,
          blocked: false,
        });
        const iteration = readEvidence(workspace).records.find((record) =>
          record.type === 'iteration');
        expect(iteration).toMatchObject({
          storyId: 'US-001',
          gateStateMutation: true,
          stateRouteTamper: [
            { storyId: 'US-002', expected: false, received: true, side: 'gate' },
          ],
          stateValidationTamper: [{
            storyId: 'US-002',
            expected: false,
            received: true,
            side: 'gate',
            fields: ['validated', 'validationReceipt'],
          }],
        });
      } finally {
        delete process.env.CODING_X_CLAUDE_BIN;
      }
    },
  );

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
    const calls = join(workspace, 'calls.txt');
    writeFileSync(
      fake,
      `
      import { writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'call\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: false, notes: '[需要人工核实] 疑似配置异常，已附调查', retryCount: 0, blocked: true },
      }));
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

describe('runLoop TDD gate', () => {
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
    const { workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['node -e "process.exit(0)"'],
      tdd: currentRepoTdd('node -e "console.error(\'coverage 80% < 90%\'); process.exit(7)"'),
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

  it('passes coding-x workspace and project root to both agents and lets validator run after TDD passes', async () => {
    const { workspace, instructionsDir } = setup([story()], {
      tdd: currentRepoTdd('node -e "process.exit(0)"'),
    });
    const fake = join(workspace, 'fake-env.mjs');
    const calls = join(workspace, 'env-calls.jsonl');
    writeFileSync(
      fake,
      `
      import { appendFileSync, writeFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, JSON.stringify({
        workspace: process.env.CODING_X_WORKSPACE,
        projectRoot: process.env.CODING_X_PROJECT_ROOT,
      }) + '\\n');
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 2,
          devTimeoutMs: 5000,
          valTimeoutMs: 5000,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(0);
      const envs = readFileSync(calls, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(envs).toHaveLength(2);
      expect(envs).toEqual([
        { workspace: resolve(workspace), projectRoot: resolve(process.cwd()) },
        { workspace: resolve(workspace), projectRoot: resolve(process.cwd()) },
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
