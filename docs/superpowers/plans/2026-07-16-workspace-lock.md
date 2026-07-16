---
title: "workspace 并发锁实施计划"
status: active
updated: 2026-07-16
scope: root
---

# workspace 并发锁实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** `<workspace>/engine.lock` 单写者互斥——run/repair 双开被机械拒绝（退出码 2）、stale 锁自动接管、轮首自愈防 agent 误删；顺带 state.json/prd 快照写入原子化（tmp+rename）。

**Architecture:** 新模块 `src/engine/lock.ts`（O_EXCL 原子创建 + pid 活性三分支判定 + 信号/exit 钩子清锁 + verify 自愈）与 `src/engine/fs-atomic.ts`（writeFileAtomicSync）；loop/cli-repair 两接入点，doctor 加 stale 锁建议项。规格：`docs/superpowers/specs/2026-07-16-workspace-lock-design.md`。

**Tech Stack:** TypeScript strict / ESM（NodeNext）、node:fs 同步 API、Vitest（临时目录 fixture + fake-agent stub 既有模式）。

## Global Constraints

- `src/` 内相对导入必须写 `.js` 扩展名（ESM/NodeNext）。
- 零新增运行时依赖（引擎唯一运行时依赖 jsonrepair，不得引入锁库）。
- 锁是关键路径：acquire 失败必须 fail-fast（绝不静默继续）；release/verify 失败只 warn（锁残留由下次 stale 接管兜底）。
- 锁冲突统一退出码 **2**（workspace 级问题，区别于循环失败的 1）。
- pid 活性判定必须拒绝非正整数（防 `process.kill(0/-1, 0)` 的进程组广播语义误判）。
- 每任务提交前 `npm run typecheck` 与 `npm test` 必须全绿。
- 提交说明中文，conventional 前缀（feat:/fix:/docs:/release:）保留英文。
- 版本策略：全部任务完成 + /review-loop 人审通过后发 minor **0.21.0**（Task 8，人审 gate；`npm version` 钩子自动同步插件清单与 lock，`push --follow-tags` 后停手，publish 归 CI）。

---

### Task 1: `src/engine/fs-atomic.ts` — 原子写工具

**Files:**
- Create: `src/engine/fs-atomic.ts`
- Test: `src/engine/fs-atomic.test.ts`

**Interfaces:**
- Consumes: 无（仅 node:fs）。
- Produces（后续任务依赖的精确签名）:
  - `function writeFileAtomicSync(path: string, data: string): void` — 写 `${path}.tmp-${process.pid}` 后 `renameSync` 覆盖目标；任一步失败时尽力删除 tmp 再向上抛。

- [ ] **Step 1: 写失败测试**

创建 `src/engine/fs-atomic.test.ts`：

```ts
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, writeFileSync, readFileSync, readdirSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomicSync } from './fs-atomic.js';

let cleanup: Array<() => void> = [];
afterEach(() => { cleanup.forEach((f) => f()); cleanup = []; });

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fs-atomic-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('writeFileAtomicSync', () => {
  it('writes new file content correctly with no tmp residue', () => {
    const dir = ws();
    const target = join(dir, 'state.json');
    writeFileAtomicSync(target, '{"a":1}');
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}');
    expect(readdirSync(dir).filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
  });

  it('overwrites an existing file', () => {
    const dir = ws();
    const target = join(dir, 'state.json');
    writeFileSync(target, 'old');
    writeFileAtomicSync(target, 'new');
    expect(readFileSync(target, 'utf-8')).toBe('new');
  });

  it('cleans up the tmp file and rethrows when rename fails', () => {
    const dir = ws();
    // 目标是非空目录 → renameSync 必败（POSIX EISDIR/ENOTEMPTY，win32 EPERM）
    mkdirSync(join(dir, 'target'));
    writeFileSync(join(dir, 'target', 'occupied'), 'x');
    expect(() => writeFileAtomicSync(join(dir, 'target'), 'data')).toThrow();
    expect(readdirSync(dir).filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/fs-atomic.test.ts`
Expected: FAIL——`Cannot find module './fs-atomic.js'`（模块不存在）。

- [ ] **Step 3: 最小实现**

创建 `src/engine/fs-atomic.ts`：

```ts
import { writeFileSync, renameSync, unlinkSync } from 'node:fs';

/**
 * 覆盖写的原子替代：写 `<path>.tmp-<pid>` 后 rename（同目录 rename 在 POSIX 原子；
 * win32 renameSync 对已存在目标同样覆盖成功）。进程写入中途被杀只损失 tmp，
 * 目标文件永远是完整旧版或完整新版——半截 JSON 不再可能（2.5h 被 kill 环境坑的风险源）。
 * tmp 命名模式与 lock.ts 的 acquire 后残留清理（/\.tmp-\d+$/）配对，改动需两处同步。
 */
export function writeFileAtomicSync(path: string, data: string): void {
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    writeFileSync(tmp, data, 'utf-8');
    renameSync(tmp, path);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* 尽力清理；失败无害（acquire 时兜底清） */ }
    throw err;
  }
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `npx vitest run src/engine/fs-atomic.test.ts`
Expected: PASS（3 用例）。

- [ ] **Step 5: 全量验证并提交**

```bash
npm run typecheck && npm test
git add src/engine/fs-atomic.ts src/engine/fs-atomic.test.ts
git commit -m "feat: fs-atomic 原子写工具——tmp+rename 防半截 JSON，失败清理 tmp 后向上抛（#6 并发锁 T1）"
```

---

### Task 2: 四处覆盖写换用原子写

**Files:**
- Modify: `src/engine/state.ts`（ensureStateFile 落盘）
- Modify: `src/engine/loop.ts`（门禁打回写 state）
- Modify: `src/engine/prd-guard.ts`（篡改归档写 + 快照恢复写）
- Test: `src/engine/state.test.ts`（追加无残留断言；其余靠既有测试回归）

**Interfaces:**
- Consumes: Task 1 的 `writeFileAtomicSync(path, data)`。
- Produces: 无新接口（行为等价替换，唯一可观察差异是不再产生半截文件）。

- [ ] **Step 1: 追加回归断言（先写测试）**

在 `src/engine/state.test.ts` 的 ensureStateFile 相关 describe 内追加（import 区按需补 `readdirSync`）：

```ts
it('ensureStateFile leaves no atomic-write tmp residue', () => {
  // workspace fixture 沿用该文件既有 mkdtempSync 模式
  const dir = mkdtempSync(join(tmpdir(), 'state-atomic-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  ensureStateFile(dir, { project: 'p', branchName: 'b', description: 'd',
    userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }] } as never);
  expect(readdirSync(dir).filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
  expect(existsSync(join(dir, 'state.json'))).toBe(true);
});
```

注意：`state.test.ts` 若无 cleanup 数组，按 `loop.test.ts` 的 `let cleanup / afterEach` 模式补；`as never` 仅当该文件对 Prd fixture 无既有 helper 时使用（有 helper 则沿用）。

- [ ] **Step 2: 跑测试确认当前状态**

Run: `npx vitest run src/engine/state.test.ts`
Expected: PASS——裸 writeFileSync 也不残留 tmp，此断言是防回归护栏而非红灯；真正的红灯验证靠 Step 3 替换后全量回归仍绿。

- [ ] **Step 3: 四处替换**

`src/engine/state.ts`——import 行 `import { readFileSync, writeFileSync, existsSync } from 'node:fs';` 改为：

```ts
import { readFileSync, existsSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
```

`writeFileSync(path, JSON.stringify(state, null, 2), 'utf-8');`（ensureStateFile 内）改为：

```ts
writeFileAtomicSync(path, JSON.stringify(state, null, 2));
```

`src/engine/loop.ts`——import 行 `import { readFileSync, writeFileSync } from 'node:fs';` 改为：

```ts
import { readFileSync } from 'node:fs';
import { writeFileAtomicSync } from './fs-atomic.js';
```

门禁打回处 `writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf-8');` 改为：

```ts
writeFileAtomicSync(statePath, JSON.stringify(next, null, 2));
```

`src/engine/prd-guard.ts`——import 区移除 `writeFileSync`、追加 `import { writeFileAtomicSync } from './fs-atomic.js';`，两处替换：

```ts
// 篡改归档写（原 writeFileSync(archivePath, raw, 'utf-8')）——归档是证据文件，半截=证据损坏
writeFileAtomicSync(archivePath, raw);
// 快照恢复写（原 writeFileSync(prdPath, snapshotRaw!, 'utf-8')）
writeFileAtomicSync(prdPath, snapshotRaw!);
```

- [ ] **Step 4: 全量回归**

Run: `npm run typecheck && npm test`
Expected: 全绿——state/loop/prd-guard 全部既有用例行为不变（替换是行为等价的）。

- [ ] **Step 5: 提交**

```bash
git add src/engine/state.ts src/engine/loop.ts src/engine/prd-guard.ts src/engine/state.test.ts
git commit -m "feat: state 落盘/门禁打回/prd 归档与恢复四处覆盖写换原子写——进程中途被杀不再产生半截 JSON（#6 并发锁 T2）"
```

---

### Task 3: `src/engine/lock.ts` — 锁模块完整实现

**Files:**
- Create: `src/engine/lock.ts`
- Test: `src/engine/lock.test.ts`

**Interfaces:**
- Consumes: 无（仅 node:fs / node:path；tmp 清理正则与 Task 1 的命名模式配对）。
- Produces（后续任务依赖的精确签名）:
  - `const LOCK_FILE = 'engine.lock'`
  - `type LockCommand = 'run' | 'repair'`
  - `interface LockInfo { pid: number; startedAt: string; command: string }`
  - `class LockConflictError extends Error`——`holder: LockInfo | null` 属性；message 已含完整人话（pid/命令/启动时间/手动删锁出路），消费方直接 `console.error(err.message)` 后返回 2
  - `interface LockHandle { release(): void; verify(): void }`
  - `function acquireLock(workspace: string, command: LockCommand): LockHandle`——冲突抛 LockConflictError；stale 自动接管告警；成功后清理 `*.tmp-<纯数字>` 残留并注册 SIGINT/SIGTERM/exit 钩子
  - `function isPidAlive(pid: number): boolean`（doctor 复用）
  - `function readLockInfo(lockPath: string): LockInfo | null`（doctor 复用；缺失/损坏/形状非法均 null）

本任务两轮 TDD：第一轮 acquire/冲突/stale/release，第二轮 verify/tmp 清理。

- [ ] **Step 1: 写第一轮失败测试**

创建 `src/engine/lock.test.ts`：

```ts
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
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/lock.test.ts`
Expected: FAIL——`Cannot find module './lock.js'`。

- [ ] **Step 3: 实现锁模块（第一轮，verify 先返回空实现占位会违反接口契约——一次写全，第二轮测试补 verify 行为覆盖）**

创建 `src/engine/lock.ts`（完整文件）：

```ts
import { writeFileSync, readFileSync, unlinkSync, readdirSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const LOCK_FILE = 'engine.lock';

export type LockCommand = 'run' | 'repair';

export interface LockInfo {
  pid: number;
  startedAt: string;
  command: string;
}

/** 活锁冲突。message 已含完整人话与手动删锁出路，消费方 console.error(err.message) 后以退出码 2 结束。 */
export class LockConflictError extends Error {
  constructor(readonly holder: LockInfo | null, lockPath: string) {
    super([
      holder
        ? `❌ workspace 已被另一个 coding-x 进程锁定（pid ${holder.pid}，命令 ${holder.command}，启动于 ${holder.startedAt}）。`
        : '❌ workspace 锁被并发抢占（另一个 coding-x 进程正在启动）。',
      `   若确认持锁进程已不存在，可手动删除 ${lockPath} 后重试。`,
    ].join('\n'));
    this.name = 'LockConflictError';
  }
}

export interface LockHandle {
  /** 幂等：删锁 + 注销信号/exit 钩子。失败只 warn（锁残留由下次 stale 接管兜底）。 */
  release(): void;
  /** 轮首自愈：锁丢失/被改写（pid 非本进程）→ 告警 + 重建；重建失败只告警不中断循环。 */
  verify(): void;
}

/**
 * pid 活性：kill(pid, 0) 成功或 EPERM = 存活。
 * 非正整数一律按死处理——kill(0)/kill(-1) 是进程组/广播语义，损坏锁解析出
 * 0/NaN 时误发会命中整个进程组，必须在入口拒绝。
 */
export function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** 读锁文件；缺失/JSON 损坏/字段形状非法一律 null（走 stale 处理线）。 */
export function readLockInfo(lockPath: string): LockInfo | null {
  try {
    const parsed = JSON.parse(readFileSync(lockPath, 'utf-8')) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (typeof o.pid !== 'number' || typeof o.startedAt !== 'string' || typeof o.command !== 'string') return null;
    return { pid: o.pid, startedAt: o.startedAt, command: o.command };
  } catch {
    return null;
  }
}

/**
 * 清理 fs-atomic 命名模式（*.tmp-<纯数字>）的崩溃残留。只在 acquire 成功后调用
 * （此刻本进程是唯一写者，残留必属已死进程）；不要求去掉后缀后的原文件存在。
 * 正则与 fs-atomic.ts 的 tmp 命名配对，改动需两处同步。
 */
function cleanTmpResidue(workspace: string): void {
  let entries: string[];
  try {
    entries = readdirSync(workspace);
  } catch {
    return;
  }
  for (const name of entries) {
    if (/\.tmp-\d+$/.test(name)) {
      try { unlinkSync(join(workspace, name)); } catch { /* 尽力清理，失败无害 */ }
    }
  }
}

/**
 * 单写者互斥（ADR-008）：wx（O_CREAT|O_EXCL）原子创建 engine.lock。
 * 已存在 → pid 活性三分支：存活=冲突抛错；已死/损坏=stale 告警接管。
 * kill -9 等无法拦截的死亡由下次启动的 stale 判定兜底。
 */
export function acquireLock(workspace: string, command: LockCommand): LockHandle {
  const lockPath = join(workspace, LOCK_FILE);
  const payload = (): string => JSON.stringify(
    { pid: process.pid, startedAt: new Date().toISOString(), command } satisfies LockInfo,
    null, 2,
  );
  const tryCreate = (): boolean => {
    try {
      writeFileSync(lockPath, payload(), { flag: 'wx' });
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
      if (code === 'ENOENT') {
        // workspace 目录尚不存在（首跑）：建目录重试一次
        mkdirSync(workspace, { recursive: true });
        writeFileSync(lockPath, payload(), { flag: 'wx' });
        return true;
      }
      throw err;
    }
  };

  if (!tryCreate()) {
    const holder = readLockInfo(lockPath);
    if (holder && isPidAlive(holder.pid)) throw new LockConflictError(holder, lockPath);
    console.warn(
      holder
        ? `⚠️  检测到上次异常退出遗留的锁（pid ${holder.pid}，启动于 ${holder.startedAt}），已接管`
        : '⚠️  检测到损坏的 engine.lock（上次异常退出痕迹），已接管',
    );
    try { unlinkSync(lockPath); } catch { /* 可能已被并发者清理 */ }
    if (!tryCreate()) {
      // 接管竞态：另一实例抢先重建——按活锁对待，不循环重试（简单诚实）
      throw new LockConflictError(readLockInfo(lockPath), lockPath);
    }
  }

  cleanTmpResidue(workspace);

  let released = false;
  const releaseNow = (): void => {
    if (released) return;
    released = true;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', onExit);
    try {
      unlinkSync(lockPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(`⚠️  engine.lock 释放失败（下次启动将按 stale 接管）：${err instanceof Error ? err.message : String(err)}`);
      }
    }
  };
  // Ctrl+C / kill 默认直接杀进程、不走 finally——handler 清锁后按惯例码退出。
  const onSignal = (signal: NodeJS.Signals): void => {
    releaseNow();
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  // process.exit 与正常结束的同步兜底（已 release 则幂等短路）
  const onExit = (): void => releaseNow();
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  process.on('exit', onExit);

  const verify = (): void => {
    const holder = readLockInfo(lockPath);
    if (holder && holder.pid === process.pid) return;
    console.warn(
      `⚠️  engine.lock ${holder ? `被改写（pid ${holder.pid}）` : '丢失或不可读'}——workspace 要求单写者，已重建`,
    );
    try { unlinkSync(lockPath); } catch { /* 缺失则无需删 */ }
    try {
      writeFileSync(lockPath, payload(), { flag: 'wx' });
    } catch (err) {
      // 引擎自身仍是合法写者：重建失败不中断循环（中断反而把胜利让给篡改方）
      console.warn(`⚠️  engine.lock 重建失败（不中断循环）：${err instanceof Error ? err.message : String(err)}`);
    }
  };

  return { release: releaseNow, verify };
}
```

- [ ] **Step 4: 跑第一轮测试确认通过**

Run: `npx vitest run src/engine/lock.test.ts`
Expected: PASS（isPidAlive 3 + acquireLock 5 + release 1 = 9 用例）。

- [ ] **Step 5: 提交第一轮**

```bash
npm run typecheck && npm test
git add src/engine/lock.ts src/engine/lock.test.ts
git commit -m "feat: engine.lock 单写者锁——wx 原子创建/pid 活性三分支/stale 自动接管/信号与 exit 钩子清锁（#6 并发锁 T3a）"
```

- [ ] **Step 6: 写第二轮失败测试（verify 自愈 + tmp 残留清理）**

`src/engine/lock.test.ts` 追加两个 describe：

```ts
describe('verify（轮首自愈）', () => {
  it('rebuilds the lock when it was deleted', () => {
    const dir = ws();
    const lock = acquireLock(dir, 'run');
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
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
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      lock.verify();
      expect(warns).toEqual([]);
    } finally {
      console.warn = orig;
      lock.release();
    }
  });
});

describe('tmp 残留清理', () => {
  it('removes *.tmp-<digits> residue on acquire but keeps other temp files', () => {
    const dir = ws();
    writeFileSync(join(dir, 'state.json.tmp-12345'), 'residue');
    writeFileSync(join(dir, 'note.tmp'), 'keep');       // 无数字后缀：不是 fs-atomic 模式
    writeFileSync(join(dir, 'foo.tmp-abc'), 'keep');    // 非纯数字：不清
    const lock = acquireLock(dir, 'run');
    try {
      expect(existsSync(join(dir, 'state.json.tmp-12345'))).toBe(false);
      expect(existsSync(join(dir, 'note.tmp'))).toBe(true);
      expect(existsSync(join(dir, 'foo.tmp-abc'))).toBe(true);
    } finally {
      lock.release();
    }
  });
});
```

- [ ] **Step 7: 跑第二轮测试确认通过（实现已含 verify/清理；若有红灯按实现修）**

Run: `npx vitest run src/engine/lock.test.ts`
Expected: PASS（累计 13 用例）。

- [ ] **Step 8: 提交第二轮**

```bash
npm run typecheck && npm test
git add src/engine/lock.test.ts
git commit -m "test: 锁轮首自愈（误删/改写重建、完好静默）与 tmp 残留清理边界用例（#6 并发锁 T3b）"
```

---

### Task 4: loop.ts 接线——acquire / 每轮 verify / keepOpen 前 release

**Files:**
- Modify: `src/engine/loop.ts`
- Test: `src/engine/loop.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `acquireLock/LockConflictError/LockHandle/readLockInfo/LOCK_FILE`。
- Produces: `runLoop` 新行为契约——workspace 活锁时返回 **2** 且不写任何文件、不启动 dashboard；正常结束（含 keepOpen 等待前）锁已删除。

- [ ] **Step 1: 写失败测试**

`src/engine/loop.test.ts` 追加（import 区补 `import { readLockInfo, LOCK_FILE } from './lock.js';`；`existsSync` 已在 import 中）：

```ts
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
    console.error = (...args: unknown[]) => { errs.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 1, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
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
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
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
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    const orig = console.warn;
    const warns: string[] = [];
    console.warn = (...args: unknown[]) => { warns.push(args.join(' ')); };
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
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
    writeFileSync(fake, `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(join(workspace, 'state.json'))}, JSON.stringify({
        'US-001': { passes: true, notes: '', retryCount: 0, blocked: false },
      }));
      process.exit(0);
    `);
    process.env.CODING_X_CLAUDE_BIN = `node ${fake}`;
    // interrupt 注入口（LoopConfig.interrupt）：等待期采样锁是否已释放
    let lockDuringWait = true;
    const interrupt = new Promise<void>((resolve) => {
      setTimeout(() => {
        lockDuringWait = existsSync(join(workspace, LOCK_FILE));
        resolve();
      }, 50);
    });
    try {
      const code = await runLoop({
        kind: 'claude', maxIterations: 5, devTimeoutMs: 5000, valTimeoutMs: 5000,
        workspace, instructionsDir, port: 0, openBrowser: false,
        keepOpen: true, interrupt,
      });
      expect(code).toBe(0);
      expect(lockDuringWait).toBe(false); // keepOpen 等待期间锁已不在
    } finally {
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/engine/loop.test.ts`
Expected: 新 describe 4 用例 FAIL（runLoop 尚无锁行为：活锁用例返回 1 而非 2、且 ensureStateFile 已创建 state.json 使「未写任何文件」断言失败；normal-run 用例锁文件本就不存在但 stale 用例无「已接管」告警）。

- [ ] **Step 3: 接线实现**

`src/engine/loop.ts` import 区追加：

```ts
import { acquireLock, LockConflictError, type LockHandle } from './lock.js';
```

`runLoop` 函数体最前（`const prdPath = ...` 之前）插入：

```ts
// 单写者互斥（ADR-008）：活锁 fail-fast、stale 自动接管；冲突时未启动任何资源，直接退出码 2
let lock: LockHandle;
try {
  lock = acquireLock(cfg.workspace, 'run');
} catch (err) {
  if (err instanceof LockConflictError) {
    console.error(err.message);
    return 2;
  }
  throw err;
}
```

for 循环体第一行（`const beforeRead = guard.read();` 之前）插入：

```ts
lock.verify(); // 轮首自愈：agent 误删/改写锁时告警重建（同 prd-guard 的机械防护哲学）
```

报告生成 try/catch 之后、`if (cfg.keepOpen)` 之前插入：

```ts
// keepOpen 等待阶段只读、无需持锁；此处释放同时注销信号 handler，
// 等待期 Ctrl+C 完全走既有 waitForSigint 语义（真实退出码保留）
lock.release();
```

既有 `finally { server.close(); }` 改为：

```ts
} finally {
  lock.release(); // 幂等：正常路径已释放则短路；异常路径在此兜底
  server.close();
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run src/engine/loop.test.ts && npm run typecheck && npm test`
Expected: 新 4 用例 PASS；既有 loop 用例全绿（无锁文件时行为不变——每个用例的临时 workspace 独立，acquire 总能成功）。

- [ ] **Step 5: 提交**

```bash
git add src/engine/loop.ts src/engine/loop.test.ts
git commit -m "feat: 引擎循环接入工作区锁——启动 acquire 冲突退 2/每轮 verify 自愈/keepOpen 等待前释放/finally 兜底（#6 并发锁 T4）"
```

---

### Task 5: cli.ts repair 接线

**Files:**
- Modify: `src/cli.ts`（repair 分支）
- Test: `src/cli.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `acquireLock/LockConflictError`。
- Produces: `main(['repair', ...])` 新行为契约——活锁返回 2 且不修文件；成功修复后锁已删除。

- [ ] **Step 1: 写失败测试**

`src/cli.test.ts` 追加（import 区补 `existsSync`，沿用该文件 `vi.spyOn` 模式）：

```ts
describe('repair 与工作区锁', () => {
  const validPrd = JSON.stringify({
    project: 'p', branchName: 'ralph/x', description: 'd',
    userStories: [{ id: 'US-001', title: 't', description: 'd', acceptanceCriteria: [], priority: 1 }],
  });

  it('refuses to repair while an alive lock exists (exit 2, files untouched)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-repair-lock-'));
    const brokenRaw = '{"project":"p","branchName":"b","description":"d","userStories":[],}'; // 尾逗号：可修复的坏 JSON
    writeFileSync(join(dir, 'prd.json'), brokenRaw);
    writeFileSync(join(dir, 'engine.lock'), JSON.stringify({
      pid: process.pid, startedAt: '2026-07-16T00:00:00.000Z', command: 'run',
    }));
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const code = await main(['repair', '--workspace', dir]);
      expect(code).toBe(2);
      expect(errSpy).toHaveBeenCalledWith(expect.stringContaining('已被另一个 coding-x 进程锁定'));
      expect(readFileSync(join(dir, 'prd.json'), 'utf-8')).toBe(brokenRaw); // 未动文件
    } finally {
      errSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('acquires and releases the lock across a successful repair', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cli-repair-ok-'));
    writeFileSync(join(dir, 'prd.json'), validPrd);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    try {
      const code = await main(['repair', '--workspace', dir]);
      expect(code).toBe(0);
      expect(existsSync(join(dir, 'engine.lock'))).toBe(false); // 修完锁已释放
    } finally {
      logSpy.mockRestore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
```

注意：`readFileSync` 若不在 cli.test.ts import 中则补上。

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/cli.test.ts`
Expected: 第一个用例 FAIL（现状无锁检查，repair 照常执行返回 0）。

- [ ] **Step 3: 接线实现**

`src/cli.ts` import 区追加：

```ts
import { acquireLock, LockConflictError } from './engine/lock.js';
```

repair 分支整体替换为：

```ts
if (cfg.command === 'repair') {
  // repair 重写 prd.json/state.json，与运行中的引擎互踩——与 run 同锁互斥（ADR-008）
  let lock;
  try {
    lock = acquireLock(cfg.workspace, 'repair');
  } catch (err) {
    if (err instanceof LockConflictError) {
      console.error(err.message);
      return 2;
    }
    throw err;
  }
  try {
    const repaired = repairWorkspaceFiles(cfg.workspace);
    console.log(`✅ 已修复: ${repaired.join('、')}`);
    return 0;
  } finally {
    lock.release();
  }
}
```

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run src/cli.test.ts && npm run typecheck && npm test`
Expected: 全绿（既有 repair 用例只测 parseCliArgs 识别子命令，不受影响）。

- [ ] **Step 5: 提交**

```bash
git add src/cli.ts src/cli.test.ts
git commit -m "feat: repair 子命令接入工作区锁——引擎运行中拒绝修复（退出码 2），修复完成即释放（#6 并发锁 T5）"
```

---

### Task 6: doctor 加 stale 锁建议项

**Files:**
- Modify: `src/doctor/doctor.ts`
- Test: `src/doctor/doctor.test.ts`

**Interfaces:**
- Consumes: Task 3 的 `isPidAlive/readLockInfo/LOCK_FILE`。
- Produces: `DoctorReport` 新增 `lock: LockCheckResult`；`interface LockCheckResult { found: boolean; stale: boolean; pid: number | null }`。建议级：不影响 exitCode。

- [ ] **Step 1: 写失败测试**

`src/doctor/doctor.test.ts` 追加（fixture 模式沿用该文件既有 `mkdtempSync` 用法）：

```ts
describe('runDoctor workspace lock check', () => {
  it('reports found=false when no engine.lock exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-lock-'));
    try {
      const report = runDoctor(root);
      expect(report.lock).toEqual({ found: false, stale: false, pid: null });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('flags a stale lock (dead pid) as advisory without failing the exit code', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-lock-stale-'));
    try {
      mkdirSync(join(root, '.workspace'), { recursive: true });
      writeFileSync(join(root, '.workspace', 'engine.lock'), JSON.stringify({
        pid: 999999999, startedAt: '2026-07-16T00:00:00.000Z', command: 'run',
      }));
      const report = runDoctor(root);
      expect(report.lock).toEqual({ found: true, stale: true, pid: 999999999 });
      const { text, exitCode } = renderDoctorReport(report);
      expect(text).toContain('自动接管');
      expect(exitCode).toBe(0); // 建议项不计失败
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('reports a live lock as engine-running info', () => {
    const root = mkdtempSync(join(tmpdir(), 'doc-lock-live-'));
    try {
      mkdirSync(join(root, '.workspace'), { recursive: true });
      writeFileSync(join(root, '.workspace', 'engine.lock'), JSON.stringify({
        pid: process.pid, startedAt: '2026-07-16T00:00:00.000Z', command: 'run',
      }));
      const report = runDoctor(root);
      expect(report.lock).toEqual({ found: true, stale: false, pid: process.pid });
      expect(renderDoctorReport(report).text).toContain('引擎运行中');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `npx vitest run src/doctor/doctor.test.ts`
Expected: FAIL——`report.lock` 为 undefined。

- [ ] **Step 3: 实现**

`src/doctor/doctor.ts` import 区追加：

```ts
import { isPidAlive, readLockInfo, LOCK_FILE } from '../engine/lock.js';
```

接口区追加，并在 `DoctorReport` 增加 `lock: LockCheckResult;` 字段：

```ts
export interface LockCheckResult {
  /** engine.lock 是否存在；不存在=无引擎实例在运行，正常态 */
  found: boolean;
  /** 存在时：持锁 pid 已死或锁损坏（stale，上次异常退出遗留）；引擎运行中为 false */
  stale: boolean;
  pid: number | null;
}
```

`runDoctor` 内（gate 检查块之后）追加，并把两个 `return` 的对象字面量都补上 `lock`：

```ts
const lockPath = join(root, workspace, LOCK_FILE);
let lock: LockCheckResult = { found: false, stale: false, pid: null };
if (existsSync(lockPath)) {
  const info = readLockInfo(lockPath);
  lock = { found: true, stale: !(info !== null && isPidAlive(info.pid)), pid: info?.pid ?? null };
}
```

渲染函数（`renderGateLines` 旁）追加：

```ts
function renderLockLines(lock: LockCheckResult): string[] {
  const lines = ['🔒 workspace 锁'];
  if (!lock.found) {
    lines.push('  ✅ 无 engine.lock（当前没有引擎实例在运行）');
  } else if (lock.stale) {
    lines.push(`  💡 发现 stale 锁${lock.pid !== null ? `（pid ${lock.pid} 已不存在）` : '（锁文件损坏）'}：上次异常退出遗留，下次 coding-x 运行将自动接管（建议项，不计失败）`);
  } else {
    lines.push(`  ℹ️  引擎运行中（pid ${lock.pid}）：请勿对同一 workspace 并行启动 run/repair`);
  }
  return lines;
}
```

`renderDoctorReport` 两处插入（`renderGateLines` 调用之后，与 gate 节同级并列）：docsFound=false 早退分支的数组尾部加 `'', ...renderLockLines(report.lock)`；正常路径 `lines.push('', ...renderGateLines(report.gate));` 之后加 `lines.push('', ...renderLockLines(report.lock));`。exitCode 计算不变（lock 不计入 total）。

- [ ] **Step 4: 跑测试确认通过 + 全量回归**

Run: `npx vitest run src/doctor/doctor.test.ts && npm run typecheck && npm test`
Expected: 全绿（既有 doctor 用例断言的是 `report.gate` 等局部字段与文本片段，加字段不破坏）。

- [ ] **Step 5: 提交**

```bash
git add src/doctor/doctor.ts src/doctor/doctor.test.ts
git commit -m "feat: doctor 增加 workspace 锁检查——stale 锁建议项提示自动接管、活锁提示引擎运行中（建议级不计失败）（#6 并发锁 T6）"
```

---

### Task 7: 文档四件套 + ADR-008

**Files:**
- Modify: `README.md`（三处）
- Modify: `docs/architecture.md`（模块表 + 数据流段）
- Modify: `docs/glossary.md`（词条）
- Create: `docs/decisions/008-workspace-single-writer-lock.md`

**Interfaces:**
- Consumes: Task 1-6 的实际行为（文档描述以代码为准）。
- Produces: 无代码接口；文档与 0.21.0 发版内容对齐（硬约束 5）。

- [ ] **Step 1: README 三处**

其一，「工作原理」列表（现 65 行「**完成即退出**」bullet 之后）追加一条：

```markdown
- **单实例锁**：启动时在 workspace 写 `engine.lock`（O_EXCL 原子创建），同一 workspace 的第二个 `run`/`repair` 以退出码 2 直接拒绝；异常退出（kill -9、断电）遗留的 stale 锁在下次启动时自动接管并告警，无需人工清理。
```

其二，命令行参数表 `repair` 行（现 239 行）说明列改为：

```markdown
| 位置参数 `repair` | — | 修复 `<workspace>/` 下的 prd.json 与 state.json 后退出；引擎运行中（engine.lock 活锁）时以退出码 2 拒绝 |
```

其三，目录结构注释区（现 354 行 `repair.ts` 行附近）在 engine 目录下补两行（对齐既有缩进与注释风格）：

```
│   │   ├── lock.ts               #   engine.lock 单写者互斥（pid 活性/stale 接管/轮首自愈）
│   │   ├── fs-atomic.ts          #   关键 JSON 原子写（tmp+rename）
```

- [ ] **Step 2: architecture.md 两处**

模块划分表（现 17 行起）追加一行（放「证据索引」行附近）：

```markdown
| workspace 锁 | `src/engine/lock.ts`、`src/engine/fs-atomic.ts` | engine.lock 单写者互斥（O_EXCL 原子创建、pid 活性三分支、stale 自动接管、轮首自愈防 agent 误删）；run/repair 持锁、只读子命令不锁；fs-atomic 为 state/prd 关键 JSON 提供 tmp+rename 原子写（ADR-008） |
```

数据流段（现 44 行）末尾追加一句：

```markdown
循环期间 workspace 根持有 `engine.lock`（启动 O_EXCL 创建、每轮开头自愈核对、结束释放；异常退出遗留的 stale 锁下次启动自动接管）——同一 workspace 同时只有一个写者，run 与 repair 互斥（ADR-008）。
```

- [ ] **Step 3: glossary 词条**

`docs/glossary.md` 词条区（按既有词条格式，插入到语义相近的位置，如「收口」附近）追加：

```markdown
**工作区锁（engine.lock）**
引擎在 workspace 根以 O_EXCL 原子创建的单写者互斥文件（pid/startedAt/command）；run 与 repair 持锁互斥、只读子命令不锁，持锁进程死亡遗留的 stale 锁下次启动自动接管，运行中每轮自愈核对。
禁用：进程锁、文件锁、互斥文件（统一用「工作区锁」，文件本体称 engine.lock）
```

- [ ] **Step 4: ADR-008**

创建 `docs/decisions/008-workspace-single-writer-lock.md`：

```markdown
---
title: 008-workspace-single-writer-lock
status: active
updated: 2026-07-16
scope: root
---

# 008. workspace 单写者锁（engine.lock）

## 背景

引擎对「同一 workspace 被多进程同时写」零防护：双终端误开、后台任务被系统 kill 后用户重新拉起（旧进程未死透）、运行中执行 repair——三类真实场景都会造成无痕迹的静默损坏（state 覆盖丢失、evidence.jsonl 轮号交错污染时间线重建、prd-guard 快照互踩致篡改检测失真）。幂等续跑设计恰恰训练用户「觉得死了就重新拉起」，放大了双实例风险。与 ADR-005/007 同族：单写者是「不可共谋」信任链的地基。

## 决策

新模块 `src/engine/lock.ts`：run/repair 启动时以 `writeFileSync(..., { flag: 'wx' })` 原子创建 `<workspace>/engine.lock`（pid/startedAt/command）。已存在时 pid 活性三分支：存活 → 退出码 2 拒绝（报错含手动删锁出路）；已死或锁损坏 → stale 告警自动接管。SIGINT/SIGTERM/exit 钩子清锁；kill -9 遗留交 stale 判定。运行中每轮开头 verify 自愈（agent 误删/改写 → 告警重建）。status/doctor/dashboard/report 只读或幂等覆盖写，不锁。配套 `fs-atomic.ts` 把 state 落盘、门禁打回、prd 归档与恢复四处覆盖写改为 tmp+rename 原子写。

## 理由与备选

- **为什么不引入 proper-lockfile 类库**：违反「引擎唯一运行时依赖 jsonrepair」硬约束；其 mtime 心跳为 NFS/长租约设计，单机 CLI 过度。
- **为什么不用 flock**：Node 无内置绑定，需原生模块。
- **为什么不靠约定（文档告诫勿双开）**：ADR-005 哲学——指令层禁止而无机械强制 = 不成立；无人值守场景没有人盯着防双开。
- **为什么 worktree 并行方案不能替代锁**：多 worktree × 多 workspace 解决「如何有意并行」，锁防的是「意外并发」；锁正是「不共享 workspace」约定的机械执行者，也是未来并行编排器的活性信号载体。
- **为什么 stale 自动接管而非人工删锁**：「被 kill 后重新拉起」是幂等续跑的设计内场景，人工干预会打断无人值守自动化。

## 后果

- 双开被拒（退出码 2）是面向用户的行为变更 → 0.21.0 minor（硬约束 5）。
- pid 复用有小概率误拒（活性判定把无关新进程当持锁者）——报错信息给出手动删锁出路，接受。
- agent 删锁由轮首自愈兜底；两实例同毫秒抢同一把 stale 锁的接管竞态按活锁报错处理，不循环重试。
- `prd-to-json` 再派生属 agent/skill 侧、不受引擎锁约束；skill 指令「派生前查锁」留作后续候选。
```

- [ ] **Step 5: doctor 自检 + 提交**

```bash
npx tsx src/cli.ts doctor   # 新文档 frontmatter/链接全过；stale 锁节正常渲染
npm run typecheck && npm test
git add README.md docs/architecture.md docs/glossary.md docs/decisions/008-workspace-single-writer-lock.md
git commit -m "docs: 工作区锁文档四件套——README 三处/架构地图/glossary 词条/ADR-008 单写者锁（#6 并发锁 T7）"
```

---

### Task 8: 发版 0.21.0（人审 gate）

**Files:**
- Modify: `docs/superpowers/specs/2026-07-16-workspace-lock-design.md`（status 置 done）
- Modify: `docs/superpowers/plans/2026-07-16-workspace-lock.md`（status 置 done）
- 版本产物由 `npm version` 钩子自动同步（package.json、插件清单、package-lock）

**Interfaces:**
- Consumes: Task 1-7 全部完成且 main 上全绿。
- Produces: npm 0.21.0（publish 由 tag 触发的 CI 完成）。

- [ ] **Step 1: 人审 gate——/review-loop**

运行 `/review-loop` 审查本轮全部提交（重点：锁竞态路径、信号 handler 对 keepOpen 语义的影响、四处原子写替换的行为等价性）。裁决完成（四态回填、无未处理「需人裁决」项）后才继续。

- [ ] **Step 2: 交付状态收尾**

spec 与本计划的 frontmatter `status: active` 改 `done`、`updated` 改当日：

```bash
git add docs/superpowers/specs/2026-07-16-workspace-lock-design.md docs/superpowers/plans/2026-07-16-workspace-lock.md
git commit -m "docs: workspace 并发锁 spec/plan 交付置 done"
```

- [ ] **Step 3: 发版**

```bash
npm run typecheck && npm test        # 最终全绿确认
npm version minor                    # 0.20.x → 0.21.0；钩子自动同步插件清单与 lock 并产生 release commit + tag
git push --follow-tags               # 推送后停手：publish 与 GitHub Release 归 tag 触发的 CI（勿本地抢发）
```

Expected: CI 完成 npm publish；`npm view coding-x version` 稍后显示 0.21.0。

---

## 自查记录（Self-Review）

1. **Spec 覆盖**：锁模块/生命周期/三分支/自愈/原子写四处/退出码 2/测试面/doctor 建议项/README+架构+glossary+ADR/0.21.0——spec 九节均有对应任务（Task 1-8）。spec「测试」节列的 keepOpen 释放时机、活锁不写文件、损坏锁接管等用例全部落在 Task 3/4/5。
2. **占位符**：无 TBD/TODO；全部步骤含完整代码或精确锚点。
3. **类型一致性**：`LockHandle{release,verify}`、`LockConflictError.holder: LockInfo | null`、`writeFileAtomicSync(path, data)`、`LockCheckResult{found,stale,pid}` 在 Task 3/4/5/6 的 Consumes/Produces 与代码中一致；tmp 清理正则 `/\.tmp-\d+$/` 与 fs-atomic 命名 `${path}.tmp-${process.pid}` 配对（两处注释互指）。
