import { describe, it, expect, vi } from 'vitest';
import { chmodSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { readEvidence } from './evidence.js';
import { setup, story, runLoop } from './loop-test-support.js';
import { ReviewTemporaryDirectory } from '../review/temporary-directory.js';

const originalClaudeBin = process.env.CODING_X_CLAUDE_BIN;

function useClaudeBin(command: string): () => void {
  process.env.CODING_X_CLAUDE_BIN = command;
  return () => {
    if (process.env.CODING_X_CLAUDE_BIN !== command) return;
    if (originalClaudeBin === undefined) delete process.env.CODING_X_CLAUDE_BIN;
    else process.env.CODING_X_CLAUDE_BIN = originalClaudeBin;
  };
}

describe('异常轮回写（builder 侧）', () => {
  it('迟到的 Runner 环境清理不会覆盖后续用例', () => {
    const restoreFirst = useClaudeBin('first-test-runner');
    const restoreSecond = useClaudeBin('second-test-runner');
    try {
      restoreFirst();
      expect(process.env.CODING_X_CLAUDE_BIN).toBe('second-test-runner');
    } finally {
      restoreSecond();
      restoreFirst();
    }
    expect(process.env.CODING_X_CLAUDE_BIN).toBe(originalClaudeBin);
  });

  it('builder 输出写入失败：POSIX 永久隔离，Windows 仍按 Job 结算后回写', async () => {
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
    const restoreBin = useClaudeBin(`node ${fake}`);
    const originalCreate = ReviewTemporaryDirectory.create.bind(ReviewTemporaryDirectory);
    let invocationRoot: string | undefined;
    const createSpy = vi.spyOn(ReviewTemporaryDirectory, 'create').mockImplementation((options) => {
      const temporary = originalCreate(options);
      if (options.prefix === 'coding-x-agent-invocation-') invocationRoot = temporary.root;
      return temporary;
    });
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
        builderOutputForTests: {
          stdout: new Writable({
            write(_chunk, _encoding, callback): void {
              setImmediate(() => callback(new Error('terminal-write-failed')));
            },
          }),
          stderr: discard(),
        },
      });
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8'))['US-001'];
      const iteration = readEvidence(workspace).records.find(
        (record) => record.type === 'iteration',
      );
      if (process.platform === 'win32') {
        expect(code).toBe(1);
        expect(state).toMatchObject({ passes: false, validated: false, retryCount: 0 });
        expect(state.notes).toContain('输出通道失败后被终止');
        expect(state.notes).not.toContain('被信号终止');
        expect(iteration).toMatchObject({
          builderOutcome: 'error',
          abortRollback: { storyId: 'US-001' },
          builderInvocation: {
            exitCode: null,
            terminationReason: 'output-failure',
          },
        });
      } else {
        expect(code).toBe(2);
        expect(state).toMatchObject({ passes: true, validated: false, retryCount: 0, notes: '' });
        expect(iteration).toBeUndefined();
        expect(invocationRoot).toBeDefined();
        expect(existsSync(invocationRoot!)).toBe(true);
      }
    } finally {
      createSpy.mockRestore();
      restoreBin();
      if (invocationRoot && existsSync(invocationRoot)) {
        chmodSync(invocationRoot, 0o700);
        rmSync(invocationRoot, { recursive: true, force: true });
      }
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
    const restoreBin = useClaudeBin(`node ${fake}`);
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
      restoreBin();
    }
  }, 60_000);

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
    const restoreBin = useClaudeBin(`node ${fake}`);
    try {
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
    } finally {
      restoreBin();
    }
  }, 60_000);

  it('builder 超时且未动 state：POSIX 永久隔离且不进入下一轮，Windows 保留 Job 结算语义', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(projectRoot, 'builder-calls.txt');
    // fake：先同步留下已启动事实，再睡到被引擎 SIGTERM（5 秒给高负载宿主足够启动预算）。
    writeFileSync(
      fake,
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'builder\\n');
      await new Promise((r) => setTimeout(r, 60_000));
    `,
    );
    const restoreBin = useClaudeBin(`node ${fake}`);
    const originalCreate = ReviewTemporaryDirectory.create.bind(ReviewTemporaryDirectory);
    let invocationRoot: string | undefined;
    const createSpy = vi.spyOn(ReviewTemporaryDirectory, 'create').mockImplementation((options) => {
      const temporary = originalCreate(options);
      if (options.prefix === 'coding-x-agent-invocation-') invocationRoot = temporary.root;
      return temporary;
    });
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 2,
        devTimeoutMs: 5_000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
      });
      const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf-8'));
      expect(state['US-001']).toMatchObject({ passes: false, validated: false, notes: '' });
      expect(existsSync(calls)).toBe(true);
      const callCount = readFileSync(calls, 'utf8').trim().split('\n').length;
      const iterations = readEvidence(workspace).records.filter((r) => r.type === 'iteration');

      if (process.platform === 'win32') {
        expect(code).toBe(1);
        expect(callCount).toBe(2);
        expect(iterations).toHaveLength(2);
        expect(iterations).toEqual(
          expect.arrayContaining([
            expect.objectContaining({ iteration: 1, builderOutcome: 'timeout' }),
            expect.objectContaining({ iteration: 2, builderOutcome: 'timeout' }),
          ]),
        );
      } else {
        expect(code).toBe(2);
        expect(callCount).toBe(1);
        expect(iterations).toEqual([]);
        expect(invocationRoot).toBeDefined();
        expect(existsSync(invocationRoot!)).toBe(true);
      }
    } finally {
      createSpy.mockRestore();
      restoreBin();
      if (invocationRoot && existsSync(invocationRoot)) {
        chmodSync(invocationRoot, 0o700);
        rmSync(invocationRoot, { recursive: true, force: true });
      }
    }
  }, 90_000);

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
    const restoreBin = useClaudeBin(`node ${fake}`);
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
    } finally {
      restoreBin();
    }
  }, 60_000);
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
    const restoreClaudeBin = useClaudeBin(`node ${fake}`);
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
    } finally {
      restoreClaudeBin();
    }
  }, 60_000);

  it('builder 置 true 后 validator 超时：POSIX 隔离现场，Windows 结算后回写', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake-validator-timeout.mjs');
    const calls = join(projectRoot, 'calls.txt');
    const statePath = join(workspace, 'state.json');
    writeFileSync(
      fake,
      `
      import { existsSync, readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const invocation = readFileSync(${JSON.stringify(calls)}, 'utf8').length;
      if (invocation === 1) {
        const state = JSON.parse(readFileSync(${JSON.stringify(statePath)}, 'utf-8'));
        state['US-001'].passes = true;
        writeFileSync(${JSON.stringify(statePath)}, JSON.stringify(state));
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, 'builder done\\n');
        process.exit(0);
      }
      await new Promise((resolve) => setTimeout(resolve, 60_000));
    `,
    );
    const restoreClaudeBin = useClaudeBin(`node ${fake}`);
    const originalCreate = ReviewTemporaryDirectory.create.bind(ReviewTemporaryDirectory);
    let invocationRoot: string | undefined;
    const createSpy = vi.spyOn(ReviewTemporaryDirectory, 'create').mockImplementation((options) => {
      const temporary = originalCreate(options);
      if (options.prefix === 'coding-x-agent-invocation-') invocationRoot = temporary.root;
      return temporary;
    });
    try {
      const code = await runLoop({
        kind: 'claude',
        maxIterations: 1,
        devTimeoutMs: 5000,
        // This case must time out the running Validator, not race the managed
        // supervisor and Node startup on a loaded CI host.
        valTimeoutMs: 10_000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
      });
      const state = JSON.parse(readFileSync(statePath, 'utf-8'))['US-001'];
      const iteration = readEvidence(workspace).records.find((r) => r.type === 'iteration');
      expect(readFileSync(calls, 'utf8')).toBe('xx');
      if (process.platform === 'win32') {
        expect(code).toBe(1);
        expect(state).toMatchObject({ passes: false, validated: false });
        expect(iteration).toMatchObject({
          builderOutcome: 'completed',
          validatorOutcome: 'timeout',
          abortRollback: { storyId: 'US-001' },
        });
        expect(iteration).not.toHaveProperty('validationReceipt');
      } else {
        expect(code).toBe(2);
        expect(state).toMatchObject({ passes: true, validated: false });
        expect(iteration).toBeUndefined();
        expect(invocationRoot).toBeDefined();
        expect(existsSync(invocationRoot!)).toBe(true);
      }
    } finally {
      createSpy.mockRestore();
      restoreClaudeBin();
      if (invocationRoot && existsSync(invocationRoot)) {
        chmodSync(invocationRoot, 0o700);
        rmSync(invocationRoot, { recursive: true, force: true });
      }
    }
  }, 60_000);

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
    const restoreClaudeBin = useClaudeBin(`node ${fake}`);
    try {
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
      expect(code).toBe(0);
      const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
      expect(iters[0]).toMatchObject({ validatorOutcome: 'completed' });
      expect((iters[0] as { abortRollback?: unknown }).abortRollback).toBeUndefined();
    } finally {
      restoreClaudeBin();
    }
  }, 60_000);
});
