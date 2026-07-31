import { existsSync, writeFileSync } from 'node:fs';
import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { installCommandSignals } from '../workspace-safety/command-signals.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { QUARANTINE_FILE } from '../workspace-safety/quarantine.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from '../workspace-safety/types.js';
import { runLoop } from './loop.js';
import {
  fakeBoundValidator,
  setup,
  story,
  strictConfig,
  validationReceiptFor,
} from './loop-test-support.js';

async function within<T>(promise: Promise<T>, milliseconds = 10_000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      promise,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error('runLoop did not return')), milliseconds);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

describe('workspace 写租约', () => {
  it('拒绝第二个正式写入口，且不改业务文件', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      command: 'report',
    });
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    try {
      const code = await runLoop({
        ...strictConfig(workspace, instructionsDir),
        maxIterations: 1,
      });
      expect(code).toBe(2);
      expect(errors.some((line) => line.includes('workspace 不可进入正式运行'))).toBe(true);
      expect(existsSync(join(workspace, 'state.json'))).toBe(false);
      await expect(lease.verify()).resolves.toBeUndefined();
    } finally {
      console.error = originalError;
      await lease.release();
    }
  });

  it('正常运行结束后释放活动租约，但保留永久协议根', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        ...strictConfig(workspace, instructionsDir),
        maxIterations: 3,
      });
      expect(code).toBe(0);
      expect(existsSync(join(workspace, 'engine.lock'))).toBe(true);
      expect(existsSync(join(workspace, 'engine.lock', 'lease'))).toBe(false);
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 20_000);

  it('在 keepOpen 等待前释放活动租约', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = fakeBoundValidator(workspace, 'passed');
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    let leaseDuringWait = true;
    let resolveInterrupt!: () => void;
    const interrupt = new Promise<void>((resolve) => {
      resolveInterrupt = resolve;
    });
    const originalLog = console.log;
    console.log = (...args: unknown[]) => {
      if (args.join(' ').includes('运行结束')) {
        leaseDuringWait = existsSync(join(workspace, 'engine.lock', 'lease'));
        resolveInterrupt();
      }
    };
    try {
      const code = await runLoop({
        ...strictConfig(workspace, instructionsDir),
        maxIterations: 3,
        keepOpen: true,
        interrupt,
      });
      expect(code).toBe(0);
      expect(leaseDuringWait).toBe(false);
    } finally {
      console.log = originalLog;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 20_000);

  it('释放租约期间收到首个信号时完成原子收口并返回来源退出码', async () => {
    const target = story();
    const { workspace, instructionsDir, head } = setup([target]);
    writeFileSync(
      join(workspace, 'state.json'),
      JSON.stringify({
        [target.id]: {
          passes: true,
          validated: true,
          validationReceipt: validationReceiptFor(target, head()),
          notes: '',
          retryCount: 0,
          blocked: false,
          escalated: false,
        },
      }),
    );
    const source = new EventEmitter();
    const commandSignals = installCommandSignals({
      source,
      platform: 'linux',
      hardExit: () => {
        throw new Error('unexpected second signal');
      },
    });
    let leasePresentAtSignal = false;

    const code = await runLoop({
      ...strictConfig(workspace, instructionsDir),
      commandSignalsForTests: commandSignals,
      afterSessionCloseStartedForTests: () => {
        leasePresentAtSignal = existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR));
        source.emit('SIGTERM');
      },
    });

    expect(leasePresentAtSignal).toBe(true);
    expect(code).toBe(143);
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
    expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR))).toBe(true);
  });

  it('真实 Builder 越界后保留隔离现场并明确退出 2，不会卡在释放租约', async () => {
    const { workspace, instructionsDir } = setup([story()]);
    const fake = join(workspace, 'builder-writes-outside-scope.mjs');
    writeFileSync(
      fake,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'unexpected-business.txt'))}, 'forbidden');
      process.exit(0);
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const errors: string[] = [];
    const originalError = console.error;
    console.error = (...args: unknown[]) => errors.push(args.join(' '));
    try {
      const code = await within(
        runLoop({
          ...strictConfig(workspace, instructionsDir),
          maxIterations: 1,
        }),
      );

      expect(code).toBe(2);
      expect(errors.some((line) => line.includes('workspace 安全执行失败'))).toBe(true);
      const operation = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
      expect(existsSync(operation)).toBe(true);
      expect(existsSync(join(operation, QUARANTINE_FILE))).toBe(true);
      expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
    } finally {
      console.error = originalError;
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  }, 20_000);
});
