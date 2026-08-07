import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { readEvidence } from './evidence.js';
import { setup, story, runLoop } from './loop-test-support.js';

describe('异常轮回写（builder 侧）', () => {
  it('builder 输出写入失败后回写候选，并持久化准确的输出故障原因', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-output-failure.mjs');
    writeFileSync(
      fake,
      String.raw`
        import { readFileSync, writeFileSync } from 'node:fs';
        const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state['US-001'].passes = true;
        writeFileSync(statePath, JSON.stringify(state));
        process.stdout.write('builder output before sink failure\n');
      `,
    );
    const discard = (): Writable =>
      new Writable({
        write(_chunk, _encoding, callback): void {
          callback();
        },
      });
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
          builderOutputForTests: {
            stdout: new Writable({
              write(_chunk, _encoding, callback): void {
                setImmediate(() => callback(new Error('terminal-write-failed')));
              },
            }),
            stderr: discard(),
          },
        }),
      ).toBe(1);
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'];
      expect(state).toMatchObject({ passes: false, validated: false, retryCount: 0 });
      expect(state.notes).toContain('输出通道失败后被终止');
      expect(state.notes).not.toContain('被信号终止');
      expect(
        readEvidence(workspace).records.find((record) => record.type === 'iteration'),
      ).toMatchObject({
        builderOutcome: 'error',
        abortRollback: { storyId: 'US-001' },
        builderInvocation: {
          exitCode: null,
          terminationReason: 'output-failure',
        },
      });
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 60_000);

  it('builder provider 402：state 保持未通过，iteration 留退出码/耗时/诊断供报告恢复', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-402.mjs');
    writeFileSync(
      fake,
      `
      process.stderr.write('API Error: 402 Account overdue\\n');
      process.exit(1);
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
      expect(
        JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'))['US-001'],
      ).toMatchObject({ passes: false, validated: false, retryCount: 0 });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderOutcome: 'error',
        validatorRan: false,
        builderInvocation: {
          durationMs: expect.any(Number),
          exitCode: 1,
          diagnosticTail: 'API Error: 402 Account overdue',
        },
      });
      expect(readFileSync(join(workspace, 'report.html'), 'utf-8')).toContain(
        'API Error: 402 Account overdue',
      );
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('builder 写 true 后非零退出：回写 false+待复核标记，evidence 记 error 结局与回写', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    // fake：置 US-001 通过后以非零码退出（对应「干完活但进程异常收尾」）
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = true;
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(1);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 2,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
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
      iteration: 1,
      storyId: 'US-001',
      builderOutcome: 'error',
      abortRollback: { storyId: 'US-001' },
    });
    expect((iters[0] as { validatorRan: boolean }).validatorRan).toBe(false);
  });

  it('builder 超时且未动 state：不回写、不产生标记，iteration 记 timeout', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    // fake：不写任何文件，睡到被引擎 SIGTERM（devTimeoutMs=400 触发超时）
    writeFileSync(
      fake,
      `
      await new Promise((r) => setTimeout(r, 60_000));
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 1,
      devTimeoutMs: 400,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
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
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync } from 'node:fs';
      const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = true;
      state['US-001'].notes = '[需要人工核实] 环境异常';
      state['US-001'].blocked = true;
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(1);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
    const { projectRoot, workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(projectRoot, 'calls.txt');
    // 同一 stub 以调用次数区分：第 1 次（builder）置 true 正常退出；第 2 次（validator）非零退出
    writeFileSync(
      fake,
      `
      import { writeFileSync, readFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const n = readFileSync(${JSON.stringify(calls)}, 'utf-8').length;
      if (n === 1) {
        const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state['US-001'].passes = true;
        writeFileSync(statePath, JSON.stringify(state));
        process.exit(0);
      }
      process.exit(1);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
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
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(1); // 回写后未 resolved，跑满 1 轮
    const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
    expect(state['US-001'].passes).toBe(false);
    expect(state['US-001'].notes).toContain('[中断轮待复核]');
    expect(state['US-001'].notes).toContain('validator');
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(1);
    expect(iters[0]).toMatchObject({
      builderOutcome: 'completed',
      validatorOutcome: 'error',
      abortRollback: { storyId: 'US-001' },
    });
  });

  it('builder 置 true 后 validator 超时：回写 false 且不会从完成出口假绿', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-timeout.mjs');
    const calls = join(projectRoot, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
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
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      expect(
        await runLoop({
          kind: 'claude',
          maxIterations: 1,
          devTimeoutMs: 5000,
          valTimeoutMs: 400,
          workspace,
          instructionsDir,
          port: 0,
          openBrowser: false,
        }),
      ).toBe(1);
      expect(JSON.parse(readFileSync(statePath, 'utf-8'))['US-001']).toMatchObject({
        passes: false,
        validated: false,
      });
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(iteration).toMatchObject({
        builderOutcome: 'completed',
        validatorOutcome: 'timeout',
        abortRollback: { storyId: 'US-001' },
      });
      expect(iteration).not.toHaveProperty('validationReceipt');
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('validator 正常完成：iteration 记 validatorOutcome completed，无回写', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(projectRoot, 'validator-completed-calls.txt');
    writeFileSync(
      fake,
      `
      import { existsSync, readFileSync, writeFileSync } from 'node:fs';
      const callsPath = ${JSON.stringify(calls)};
      const call = existsSync(callsPath) ? Number(readFileSync(callsPath, 'utf8')) + 1 : 1;
      writeFileSync(callsPath, String(call));
      if (call === 1) {
        const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state['US-001'].passes = true;
        writeFileSync(statePath, JSON.stringify(state));
      }
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const code = await runLoop({
      kind: 'claude',
      maxIterations: 2,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    delete process.env.CODING_X_CLAUDE_BIN;
    expect(code).toBe(0);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters[0]).toMatchObject({ validatorOutcome: 'completed' });
    expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
  });
});
