import { describe, it, expect } from 'vitest';
import { writeFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { readLockInfo, LOCK_FILE } from './lock.js';
import { setup, story, runLoop } from './loop-test-support.js';

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
    console.error = (...args: unknown[]) => {
      errs.push(args.join(' '));
    };
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
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `,
    );
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
      expect(existsSync(join(workspace, LOCK_FILE))).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('takes over a stale lock (dead pid) and completes normally', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    writeFileSync(join(workspace, LOCK_FILE), lockJson(999999999)); // 超 pid 上限，必死
    const fake = join(workspace, 'fake.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const orig = console.warn;
    const warns: string[] = [];
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
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    // interrupt 注入口（LoopConfig.interrupt）：以 keepOpen 分支「运行结束」日志行为事件驱动
    // 同步点采样锁是否已释放——该行在 lock.release() 之后、await interrupt 之前打印（见
    // loop.ts），比固定墙钟 setTimeout 更可靠：后者与真实子进程冷启动赛跑，冷启动超时窗口
    // 就会误采到「循环仍在跑」的假失败。
    let lockDuringWait = true;
    let resolveInterrupt!: () => void;
    const interrupt = new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    });
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
        kind: 'claude',
        maxIterations: 5,
        devTimeoutMs: 5000,
        valTimeoutMs: 5000,
        workspace,
        instructionsDir,
        port: 0,
        openBrowser: false,
        keepOpen: true,
        interrupt,
      });
      expect(code).toBe(0);
      expect(lockDuringWait).toBe(false); // keepOpen 等待期间锁已不在
    } finally {
      console.log = orig;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});
