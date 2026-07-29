import { describe, it, expect, afterEach } from 'vitest';
import { existsSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, readLockInfo, isPidAlive, LockConflictError, LOCK_FILE } from './lock.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
});

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'lock-ws-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

// 不存在的 pid：远超 macOS（~99998）与 Linux 默认 pid_max（4194304）上限。
// kill 对其报 ESRCH 或 EINVAL——两者都判「死」，正好是 stale 语义。
const DEAD_PID = 999999999;

const lockJson = (pid: number) =>
  JSON.stringify({ pid, startedAt: '2026-07-16T00:00:00.000Z', command: 'run' });

describe('isPidAlive', () => {
  it('detects the current process as alive', () => {
    expect(isPidAlive(process.pid)).toBe(true);
  });
  it('treats a nonexistent pid as dead', () => {
    expect(isPidAlive(DEAD_PID)).toBe(false);
  });
  it('rejects non-positive pids (kill(0)/kill(-1) broadcast semantics)', () => {
    expect(isPidAlive(0)).toBe(false);
    expect(isPidAlive(-1)).toBe(false);
    expect(isPidAlive(NaN)).toBe(false);
  });
});

describe('acquireLock', () => {
  it('creates engine.lock with pid/startedAt/command', () => {
    const dir = ws();
    const lock = acquireLock(dir, 'run');
    try {
      const info = readLockInfo(join(dir, LOCK_FILE))!;
      expect(info.pid).toBe(process.pid);
      expect(info.command).toBe('run');
      expect(typeof info.startedAt).toBe('string');
    } finally {
      lock.release();
    }
  });

  it('throws LockConflictError when the holder is alive, leaving the lock untouched', () => {
    const dir = ws();
    writeFileSync(join(dir, LOCK_FILE), lockJson(process.pid)); // 本进程必存活
    expect(() => acquireLock(dir, 'run')).toThrow(LockConflictError);
    try {
      acquireLock(dir, 'repair');
    } catch (err) {
      expect((err as LockConflictError).message).toContain(String(process.pid));
      expect((err as LockConflictError).message).toContain('手动删除');
    }
    expect(readLockInfo(join(dir, LOCK_FILE))!.pid).toBe(process.pid); // 别人的锁原样保留
  });

  it('takes over a stale lock (dead pid) with a warning', () => {
    const dir = ws();
    writeFileSync(join(dir, LOCK_FILE), lockJson(DEAD_PID));
    const warns: string[] = [];
    const orig = console.warn;
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
    try {
      const lock = acquireLock(dir, 'run');
      expect(readLockInfo(join(dir, LOCK_FILE))!.pid).toBe(process.pid);
      expect(warns.some((w) => w.includes('已接管'))).toBe(true);
      lock.release();
    } finally {
      console.warn = orig;
    }
  });

  it('treats a corrupt lock file as stale', () => {
    const dir = ws();
    writeFileSync(join(dir, LOCK_FILE), 'not json{{{');
    const orig = console.warn;
    console.warn = () => {};
    try {
      const lock = acquireLock(dir, 'run');
      expect(readLockInfo(join(dir, LOCK_FILE))!.pid).toBe(process.pid);
      lock.release();
    } finally {
      console.warn = orig;
    }
  });

  it('creates the workspace directory when it does not exist yet', () => {
    const parent = ws();
    const dir = join(parent, 'not-yet');
    const lock = acquireLock(dir, 'run');
    expect(existsSync(join(dir, LOCK_FILE))).toBe(true);
    lock.release();
  });
});

describe('release', () => {
  it('removes the lock and deregisters signal handlers; idempotent', () => {
    const dir = ws();
    const sigintBefore = process.listenerCount('SIGINT');
    const lock = acquireLock(dir, 'run');
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore + 1);
    lock.release();
    expect(existsSync(join(dir, LOCK_FILE))).toBe(false);
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
    lock.release(); // 幂等：二次调用无事发生
    expect(process.listenerCount('SIGINT')).toBe(sigintBefore);
  });
});

describe('verify（轮首自愈）', () => {
  it('rebuilds the lock when it was deleted', () => {
    const dir = ws();
    const lock = acquireLock(dir, 'run');
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
    try {
      rmSync(join(dir, LOCK_FILE)); // 模拟 agent 误删
      lock.verify();
      expect(readLockInfo(join(dir, LOCK_FILE))!.pid).toBe(process.pid);
      expect(warns.some((w) => w.includes('已重建'))).toBe(true);
    } finally {
      console.warn = orig;
      lock.release();
    }
  });

  it('rebuilds the lock when it was overwritten by someone else', () => {
    const dir = ws();
    const lock = acquireLock(dir, 'run');
    const orig = console.warn;
    console.warn = () => {};
    try {
      writeFileSync(join(dir, LOCK_FILE), lockJson(DEAD_PID)); // 模拟 agent 改写
      lock.verify();
      expect(readLockInfo(join(dir, LOCK_FILE))!.pid).toBe(process.pid);
    } finally {
      console.warn = orig;
      lock.release();
    }
  });

  it('is a no-op when the lock is intact', () => {
    const dir = ws();
    const lock = acquireLock(dir, 'run');
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => {
      warns.push(args.join(' '));
    };
    try {
      lock.verify();
      expect(warns).toEqual([]);
    } finally {
      console.warn = orig;
      lock.release();
    }
  });

  it.skipIf(process.platform === 'win32')('rebuilds a FIFO lock without blocking', () => {
    const dir = ws();
    const lock = acquireLock(dir, 'run');
    const orig = console.warn;
    console.warn = () => {};
    try {
      rmSync(join(dir, LOCK_FILE));
      execFileSync('mkfifo', [join(dir, LOCK_FILE)]);
      const started = Date.now();
      lock.verify();
      expect(Date.now() - started).toBeLessThan(1_000);
      expect(readLockInfo(join(dir, LOCK_FILE))?.pid).toBe(process.pid);
    } finally {
      console.warn = orig;
      lock.release();
    }
  });

  it.skipIf(process.platform === 'win32')(
    'workspace 被整体替换为软链时抛错且不触碰外部目录',
    () => {
      const dir = ws();
      const outside = ws();
      const moved = `${dir}-moved`;
      cleanup.push(() => rmSync(moved, { recursive: true, force: true }));
      const lock = acquireLock(dir, 'run');
      const orig = console.warn;
      console.warn = () => {};
      try {
        renameSync(dir, moved);
        symlinkSync(outside, dir, 'dir');
        expect(() => lock.verify()).toThrow(/工作区/);
        expect(existsSync(join(outside, LOCK_FILE))).toBe(false);
      } finally {
        lock.release();
        console.warn = orig;
      }
    },
  );
});

describe('tmp 残留清理', () => {
  it('removes *.tmp-<digits> residue on acquire but keeps other temp files', () => {
    const dir = ws();
    writeFileSync(join(dir, 'state.json.tmp-12345'), 'residue');
    writeFileSync(join(dir, 'note.tmp'), 'keep'); // 无数字后缀：不是 fs-atomic 模式
    writeFileSync(join(dir, 'foo.tmp-abc'), 'keep'); // 非纯数字：不清
    const lock = acquireLock(dir, 'run');
    try {
      expect(existsSync(join(dir, 'state.json.tmp-12345'))).toBe(false);
      expect(existsSync(join(dir, 'note.tmp'))).toBe(true);
      expect(existsSync(join(dir, 'foo.tmp-abc'))).toBe(true);
    } finally {
      lock.release();
    }
  });

  it('stops residue cleanup after the bounded workspace entry limit', () => {
    const dir = ws();
    for (let index = 0; index < 4_097; index += 1) {
      writeFileSync(join(dir, `entry-${index}`), '');
    }
    const warnings: string[] = [];
    const original = console.warn;
    console.warn = (...args: unknown[]) => warnings.push(args.join(' '));
    try {
      const lock = acquireLock(dir, 'run');
      lock.release();
      expect(warnings).toContainEqual(expect.stringContaining('已停止清理临时残留'));
    } finally {
      console.warn = original;
    }
  }, 15_000);
});
import { execFileSync } from 'node:child_process';
