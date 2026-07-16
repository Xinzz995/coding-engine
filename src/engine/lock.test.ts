import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { acquireLock, readLockInfo, isPidAlive, LockConflictError, LOCK_FILE } from './lock.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

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
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
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
