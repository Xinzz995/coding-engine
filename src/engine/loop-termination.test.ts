import { describe, it, expect } from 'vitest';
import { writeFileSync, readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readEvidence } from './evidence.js';
import { setup, story, runLoop, validationReceiptFor } from './loop-test-support.js';

describe('no-op 检测与 stall 熔断', { timeout: 30_000, concurrent: false }, () => {
  it('builder 空转（双无变化）：跳过验收只跑 builder，连续 3 轮熔断 exit 1', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(projectRoot, 'calls.txt');
    // fake：只计数，什么都不写，正常退出（completed 但零产出 = no-op）
    writeFileSync(
      fake,
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      process.exit(0);
    `,
    );
    const code = await runLoop({
      kind: 'claude',
      runnerEnvironmentForTests: { CODING_X_CLAUDE_BIN: `node ${fake}` },
      maxIterations: 10,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    expect(code).toBe(1);
    // 缺省 stallLimit=3：恰 3 轮、每轮只有 builder 一次调用（validator 从未拉起）
    expect(readFileSync(calls, 'utf-8').length).toBe(3);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(3);
    expect(iters.every((r) => (r as { noop?: true }).noop === true)).toBe(true);
  });

  it('门禁打回轮不计 stall 且清零：打回多于 stallLimit 也不熔断', async () => {
    // qualityChecks 必败（false 命令）+ builder 每轮置 true → 每轮门禁打回（有 state 写入=有活动）
    const { projectRoot, workspace, instructionsDir } = setup([story()], {
      qualityChecks: ['false'],
    });
    const fake = join(workspace, 'fake.mjs');
    const calls = join(projectRoot, 'calls.txt');
    writeFileSync(
      fake,
      `
      import { readFileSync, writeFileSync, appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
      const state = JSON.parse(readFileSync(statePath, 'utf8'));
      state['US-001'].passes = true;
      writeFileSync(statePath, JSON.stringify(state));
      process.exit(0);
    `,
    );
    const code = await runLoop({
      kind: 'claude',
      runnerEnvironmentForTests: { CODING_X_CLAUDE_BIN: `node ${fake}` },
      maxIterations: 4,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    // 4 轮全是门禁打回（stallLimit=3 未触发熔断）→ 跑满，builder 每轮都拉起
    expect(readFileSync(calls, 'utf-8').length).toBe(4);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(4);
    expect(iters.every((r) => (r as { gateRejected?: true }).gateRejected === true)).toBe(true);
    expect(
      iters.every((r) => (r as { validatorOutcome?: string }).validatorOutcome === 'skipped'),
    ).toBe(true);
    expect(code).toBe(1);
  }, 60_000);

  it('stallLimit 可经配置调整', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(projectRoot, 'calls.txt');
    writeFileSync(
      fake,
      `
      import { appendFileSync } from 'node:fs';
      appendFileSync(${JSON.stringify(calls)}, 'x');
      process.exit(0);
    `,
    );
    const code = await runLoop({
      kind: 'claude',
      runnerEnvironmentForTests: { CODING_X_CLAUDE_BIN: `node ${fake}` },
      maxIterations: 10,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
      stallLimit: 1,
    });
    expect(code).toBe(1);
    expect(readFileSync(calls, 'utf-8').length).toBe(1);
  });

  it('启动时已全部 resolved：完成判定优先于 stall 计数，直接 exit 0', async () => {
    // 断点续跑接手已完工 workspace 时，bootstrap 直接收敛，不需要制造 no-op 轮。
    const target = story();
    const { workspace, instructionsDir, head } = setup([target]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head(),
          validationReceipt: validationReceiptFor(target, head()),
          notes: '',
          retryCount: 0,
          blocked: false,
        },
      }),
    );
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, 'process.exit(0);'); // 干净退出、不碰任何文件 = 真空转
    const code = await runLoop({
      kind: 'claude',
      runnerEnvironmentForTests: { CODING_X_CLAUDE_BIN: `node ${fake}` },
      maxIterations: 3,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    expect(code).toBe(0);
  });

  it('已完工 workspace 启动即收敛：不调 agent，也不伪造 iteration', async () => {
    const target = story();
    const { projectRoot, workspace, instructionsDir, head } = setup([target]);
    // 预置已完工 state；fake 不写任何文件（空转）
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head(),
          validationReceipt: validationReceiptFor(target, head()),
          notes: '',
          retryCount: 0,
          blocked: false,
        },
      }),
    );
    const fake = join(workspace, 'fake.mjs');
    const called = join(projectRoot, 'called.txt');
    writeFileSync(
      fake,
      `import { writeFileSync } from 'node:fs'; writeFileSync(${JSON.stringify(called)}, 'x');`,
    );
    const code = await runLoop({
      kind: 'claude',
      runnerEnvironmentForTests: { CODING_X_CLAUDE_BIN: `node ${fake}` },
      maxIterations: 5,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    expect(code).toBe(0);
    expect(existsSync(called)).toBe(false);
    const iters = readEvidence(workspace).records.filter((r) => r.type === 'iteration');
    expect(iters).toHaveLength(0);
  });

  it('已收敛但含 blocked 的工作区重跑：no-op 快路径同样 exit 3 并列出 blocked story', async () => {
    const passed = story();
    const { workspace, instructionsDir, head } = setup([
      passed,
      story({ id: 'US-002', priority: 2 }),
    ]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: true,
          validated: true,
          storyBaseGitHead: head(),
          validationReceipt: validationReceiptFor(passed, head()),
          notes: '',
          retryCount: 0,
          blocked: false,
        },
        'US-002': { passes: false, notes: '[需要人工核实] 待裁决', retryCount: 0, blocked: true },
      }),
    );
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(fake, `process.exit(0);`);
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(' '));
      origLog(...a);
    };
    const code = await runLoop({
      kind: 'claude',
      runnerEnvironmentForTests: { CODING_X_CLAUDE_BIN: `node ${fake}` },
      maxIterations: 5,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    console.log = origLog;
    expect(code).toBe(3);
    const banner = logs.find((l) => l.includes('blocked'));
    expect(banner).toContain('US-002');
    expect(logs.some((l) => l.includes('全部 story 已通过'))).toBe(false);
  });
});

describe('blocked 收敛出口', { timeout: 30_000, concurrent: false }, () => {
  it('全部 resolved 但存在 blocked：文案列出 story 号，exit 3', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([
      story(),
      story({ id: 'US-002', priority: 2 }),
    ]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        'US-001': {
          passes: false,
          validated: false,
          validationReceipt: null,
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
        'US-002': {
          passes: false,
          validated: false,
          validationReceipt: null,
          notes: '[需要人工核实] 环境缺失',
          retryCount: 0,
          blocked: true,
          escalated: false,
        },
      }),
    );
    const fake = join(workspace, 'fake.mjs');
    const calls = join(projectRoot, 'blocked-convergence-calls.txt');
    // US-002 的人工 blocked 状态由引擎启动前已有数据提供；Builder 只获准更新当前 US-001。
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
    const logs: string[] = [];
    const origLog = console.log;
    console.log = (...a: unknown[]) => {
      logs.push(a.join(' '));
      origLog(...a);
    };
    const code = await runLoop({
      kind: 'claude',
      runnerEnvironmentForTests: { CODING_X_CLAUDE_BIN: `node ${fake}` },
      maxIterations: 3,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    console.log = origLog;
    expect(code).toBe(3);
    const banner = logs.find((l) => l.includes('blocked'));
    expect(banner).toBeDefined();
    expect(banner).toContain('US-002');
    expect(banner).toContain('1 个 story 通过');
    expect(logs.some((l) => l.includes('全部 story 已通过'))).toBe(false);
  });

  it('全部通过无 blocked：维持 exit 0 与既有文案', async () => {
    const { projectRoot, workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'fake.mjs');
    const calls = join(projectRoot, 'all-passed-calls.txt');
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
    const code = await runLoop({
      kind: 'claude',
      runnerEnvironmentForTests: { CODING_X_CLAUDE_BIN: `node ${fake}` },
      maxIterations: 2,
      devTimeoutMs: 5000,
      valTimeoutMs: 5000,
      workspace,
      instructionsDir,
      port: 0,
      openBrowser: false,
    });
    expect(code).toBe(0);
  });
});
