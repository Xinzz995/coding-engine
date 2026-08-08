import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { installCommandSignals } from '../workspace-safety/command-signals.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import {
  ACTIVE_CHILD_FILE,
  DRAINED_RECEIPT_FILE,
  parseActiveChildRecord,
} from '../workspace-safety/operation.js';
import {
  recordDetachedPosixTestChild,
  recordPosixTestContainment,
  terminateRecordedPosixTestGroup,
  type RecordedPosixTestGroup,
} from '../workspace-safety/__fixtures__/posix-test-process-group.js';
import { parseQuarantineRecord, QUARANTINE_FILE } from '../workspace-safety/quarantine.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from '../workspace-safety/types.js';
import { readEvidence } from './evidence.js';
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

async function waitUntil(predicate: () => boolean, milliseconds = 10_000): Promise<void> {
  const deadline = Date.now() + milliseconds;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition did not become true');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function childExit(
  child: ChildProcess,
  milliseconds = 15_000,
): Promise<[number | null, NodeJS.Signals | null]> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return Promise.resolve([child.exitCode, child.signalCode]);
  }
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error('signal worker did not exit'));
    }, milliseconds);
    const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
      cleanup();
      resolve([code, signal]);
    };
    const onError = (error: Error): void => {
      cleanup();
      reject(error);
    };
    const cleanup = (): void => {
      clearTimeout(timer);
      child.removeListener('exit', onExit);
      child.removeListener('error', onError);
    };
    child.once('exit', onExit);
    child.once('error', onError);
  });
}

async function cleanupRecordedGroup(record: RecordedPosixTestGroup | undefined): Promise<void> {
  if (!record) return;
  await terminateRecordedPosixTestGroup(record, {
    termTimeoutMs: 200,
    killTimeoutMs: 5_000,
    pollIntervalMs: 20,
  });
}

function removeOwnedTemporaryTree(root: string): void {
  if (!existsSync(root)) return;
  const makeDirectoriesWritable = (directory: string): void => {
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const info = lstatSync(path);
      if (info.isDirectory() && !info.isSymbolicLink()) makeDirectoriesWritable(path);
    }
  };
  makeDirectoriesWritable(root);
  rmSync(root, { recursive: true, force: true });
}

function writeSignalRunner(
  controlRoot: string,
  workspace: string,
  targetRole: 'builder' | 'validator',
): { runner: string; calls: string; ready: string } {
  const runner = join(controlRoot, 'signal-runner.mjs');
  const calls = join(controlRoot, 'calls.txt');
  const ready = join(controlRoot, 'runner-ready.json');
  writeFileSync(
    runner,
    String.raw`
      import { appendFileSync, readFileSync, writeFileSync } from 'node:fs';
      for await (const _chunk of process.stdin) {}
      const callsPath = ${JSON.stringify(calls)};
      let call = 1;
      try { call = Number(readFileSync(callsPath, 'utf8')) + 1; } catch {}
      writeFileSync(callsPath, String(call));
      const targetRole = ${JSON.stringify(targetRole)};
      if (targetRole === 'validator' && call === 1) {
        const statePath = ${JSON.stringify(join(workspace, 'state.json'))};
        const state = JSON.parse(readFileSync(statePath, 'utf8'));
        state['US-001'].passes = true;
        state['US-001'].validated = false;
        writeFileSync(statePath, JSON.stringify(state, null, 2));
        appendFileSync(${JSON.stringify(join(workspace, 'progress.md'))}, '## builder completed US-001\n');
        process.exit(0);
      }
      const expectedCall = targetRole === 'builder' ? 1 : 2;
      if (call !== expectedCall) process.exit(91);
      writeFileSync(
        ${JSON.stringify(ready)},
        JSON.stringify({ role: targetRole, call }),
        { flag: 'wx' },
      );
      setInterval(() => {}, 1000);
    `,
  );
  return { runner, calls, ready };
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

describe.runIf(process.platform !== 'win32')('POSIX 真实信号下的 opaque Runner 收口', () => {
  it.each([
    ['builder', 'SIGINT', 130],
    ['builder', 'SIGTERM', 143],
    ['validator', 'SIGINT', 130],
    ['validator', 'SIGTERM', 143],
  ] as const)(
    '活跃 %s 收到真实 %s 后永久隔离并保留来源退出码 %i',
    async (role, signal, expectedExitCode) => {
      const { workspace, instructionsDir } = setup([story()]);
      const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-loop-posix-signal-'));
      const fixture = writeSignalRunner(controlRoot, workspace, role);
      const workerPath = fileURLToPath(
        new URL('./__fixtures__/loop-posix-signal-worker.ts', import.meta.url),
      );
      let worker: ChildProcessWithoutNullStreams | undefined;
      let workerGroup: RecordedPosixTestGroup | undefined;
      let runnerGroup: RecordedPosixTestGroup | undefined;
      let exitPromise: Promise<[number | null, NodeJS.Signals | null]> | undefined;
      let stdout = '';
      let stderr = '';

      try {
        worker = spawn(
          process.execPath,
          ['--import', 'tsx', workerPath, workspace, instructionsDir],
          {
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: {
              ...process.env,
              CODING_X_CLAUDE_BIN: `${process.execPath} ${fixture.runner}`,
              TMPDIR: controlRoot,
            },
          },
        );
        worker.stdout.setEncoding('utf8');
        worker.stderr.setEncoding('utf8');
        worker.stdout.on('data', (chunk: string) => {
          stdout += chunk;
        });
        worker.stderr.on('data', (chunk: string) => {
          stderr += chunk;
        });
        worker.stdin.end();
        exitPromise = childExit(worker);
        await once(worker, 'spawn');
        workerGroup = recordDetachedPosixTestChild(worker);

        await Promise.race([
          waitUntil(() => existsSync(fixture.ready), 20_000),
          exitPromise.then(([code, exitSignal]) => {
            throw new Error(
              `signal worker exited before ${role} became active: ` +
                `${JSON.stringify({ code, exitSignal, stdout, stderr })}`,
            );
          }),
        ]);
        expect(JSON.parse(readFileSync(fixture.ready, 'utf8'))).toEqual({
          role,
          call: role === 'builder' ? 1 : 2,
        });
        expect(readFileSync(fixture.calls, 'utf8')).toBe(role === 'builder' ? '1' : '2');

        const lease = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
        const operation = join(lease, OPERATION_DIR);
        const active = parseActiveChildRecord(readFileSync(join(operation, ACTIVE_CHILD_FILE)));
        expect(active).toMatchObject({ state: 'armed', kind: role });
        if (active.state !== 'armed') throw new Error('runner operation is not armed');
        runnerGroup = recordPosixTestContainment(active.containment);

        expect(worker.kill(signal)).toBe(true);
        const [code, exitSignal] = await exitPromise;

        expect(code).toBe(expectedExitCode);
        expect(exitSignal).toBeNull();
        expect(readFileSync(fixture.calls, 'utf8')).toBe(role === 'builder' ? '1' : '2');
        expect(existsSync(lease)).toBe(true);
        expect(existsSync(operation)).toBe(true);
        expect(parseActiveChildRecord(readFileSync(join(operation, ACTIVE_CHILD_FILE))).state).toBe(
          'armed',
        );
        expect(existsSync(join(operation, DRAINED_RECEIPT_FILE))).toBe(false);
        expect(parseQuarantineRecord(readFileSync(join(operation, QUARANTINE_FILE))).reason).toBe(
          'operation-proof-missing',
        );
        expect(
          readEvidence(workspace).records.filter((record) => record.type === 'iteration'),
        ).toEqual([]);
        expect(stderr).toContain('workspace 安全执行失败');
      } finally {
        await cleanupRecordedGroup(runnerGroup);
        await cleanupRecordedGroup(workerGroup);
        if (worker && !workerGroup && worker.exitCode === null && worker.signalCode === null) {
          worker.kill('SIGKILL');
        }
        if (exitPromise) await exitPromise.catch(() => undefined);
        removeOwnedTemporaryTree(controlRoot);
      }
    },
    40_000,
  );
});
