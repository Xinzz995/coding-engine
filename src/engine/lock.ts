import { mkdirSync, opendirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { readSafeControlFileUtf8Sync } from './safe-control-file.js';
import {
  assertRegisteredWorkspacePath,
  assertWorkspaceDirectory,
  freezeWorkspaceDirectory,
  removeRegisteredWorkspaceFileSync,
  type WorkspaceDirectoryIdentity,
} from './workspace-identity.js';

export const LOCK_FILE = 'engine.lock';
const LOCK_CONTROL_FILE_MAX_BYTES = 8 * 1024;
const WORKSPACE_DIRECTORY_ENTRY_LIMIT = 4_096;

export type LockCommand = 'run' | 'repair';

export interface LockInfo {
  pid: number;
  startedAt: string;
  command: string;
}

/** 活锁冲突。message 已含完整人话与手动删锁出路，消费方 console.error(err.message) 后以退出码 2 结束。 */
export class LockConflictError extends Error {
  constructor(
    readonly holder: LockInfo | null,
    lockPath: string,
  ) {
    super(
      [
        holder
          ? `❌ workspace 已被另一个 coding-x 进程锁定（pid ${holder.pid}，命令 ${holder.command}，启动于 ${holder.startedAt}）。`
          : '❌ workspace 锁被并发抢占（另一个 coding-x 进程正在启动）。',
        `   若确认持锁进程已不存在，可手动删除 ${lockPath} 后重试。`,
      ].join('\n'),
    );
    this.name = 'LockConflictError';
  }
}

export interface LockHandle {
  /** 幂等：删锁 + 注销信号/exit 钩子。失败只 warn（锁残留由下次 stale 接管兜底）。 */
  release(): void;
  /**
   * 轮首自愈：锁丢失/被改写（pid 非本进程）→ 告警 + 重建；重建失败只告警不中断循环。
   * 前提假设：verify 只在本进程合法持锁的运行期间被循环调用，故锁内容 pid 与本进程不符
   * 只能来自外部篡改，无条件夺回（删旧建新）是正确语义。
   */
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
    const raw = readSafeControlFileUtf8Sync(lockPath, {
      maxBytes: LOCK_CONTROL_FILE_MAX_BYTES,
      allowMissing: true,
    });
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as unknown;
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return null;
    const o = parsed as Record<string, unknown>;
    if (
      typeof o.pid !== 'number' ||
      typeof o.startedAt !== 'string' ||
      typeof o.command !== 'string'
    )
      return null;
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
function cleanTmpResidue(workspace: string, identity: WorkspaceDirectoryIdentity): void {
  let handle: ReturnType<typeof opendirSync> | null = null;
  try {
    assertWorkspaceDirectory(identity);
    handle = opendirSync(workspace);
    let count = 0;
    let entry = handle.readSync();
    while (entry !== null) {
      count += 1;
      if (count > WORKSPACE_DIRECTORY_ENTRY_LIMIT) {
        console.warn(
          `⚠️  workspace 条目超过 ${WORKSPACE_DIRECTORY_ENTRY_LIMIT} 个，已停止清理临时残留`,
        );
        break;
      }
      if (/\.tmp-\d+$/.test(entry.name)) {
        try {
          removeRegisteredWorkspaceFileSync(join(workspace, entry.name), true);
        } catch {
          /* 尽力清理，失败无害 */
        }
      }
      entry = handle.readSync();
    }
    assertWorkspaceDirectory(identity);
  } catch {
    return;
  } finally {
    try {
      handle?.closeSync();
    } catch {
      // 最佳努力清理不因目录关闭失败阻断启动。
    }
  }
}

/**
 * 单写者互斥（ADR-008）：wx（O_CREAT|O_EXCL）原子创建 engine.lock。
 * 已存在 → pid 活性三分支：存活=冲突抛错；已死/损坏=stale 告警接管。
 * kill -9 等无法拦截的死亡由下次启动的 stale 判定兜底。
 */
export function acquireLock(workspace: string, command: LockCommand): LockHandle {
  const workspacePath = resolve(workspace);
  mkdirSync(workspacePath, { recursive: true });
  const workspaceIdentity = freezeWorkspaceDirectory(workspacePath);
  const lockPath = join(workspacePath, LOCK_FILE);
  const payload = (): string =>
    JSON.stringify(
      { pid: process.pid, startedAt: new Date().toISOString(), command } satisfies LockInfo,
      null,
      2,
    );
  const tryCreate = (): boolean => {
    try {
      assertRegisteredWorkspacePath(lockPath);
      writeFileSync(lockPath, payload(), { flag: 'wx' });
      assertWorkspaceDirectory(workspaceIdentity);
      return true;
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code === 'EEXIST') return false;
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
    try {
      removeRegisteredWorkspaceFileSync(lockPath, true);
    } catch {
      /* 可能已被并发者清理；workspace 身份变化会在下次创建时再次失败 */
    }
    if (!tryCreate()) {
      // 接管竞态：另一实例抢先重建——按活锁对待，不循环重试（简单诚实）
      throw new LockConflictError(readLockInfo(lockPath), lockPath);
    }
  }

  cleanTmpResidue(workspacePath, workspaceIdentity);

  let released = false;
  const releaseNow = (): void => {
    if (released) return;
    released = true;
    process.removeListener('SIGINT', onSignal);
    process.removeListener('SIGTERM', onSignal);
    process.removeListener('exit', onExit);
    try {
      removeRegisteredWorkspaceFileSync(lockPath, true);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
        console.warn(
          `⚠️  engine.lock 释放失败（下次启动将按 stale 接管）：${err instanceof Error ? err.message : String(err)}`,
        );
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
    try {
      removeRegisteredWorkspaceFileSync(lockPath, true);
    } catch (error) {
      // workspace 整体被替换时不能沿新路径重建；必须终止本轮。
      assertWorkspaceDirectory(workspaceIdentity);
      console.warn(
        `⚠️  engine.lock 清理失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    try {
      assertRegisteredWorkspacePath(lockPath);
      writeFileSync(lockPath, payload(), { flag: 'wx' });
      assertWorkspaceDirectory(workspaceIdentity);
    } catch (err) {
      // 普通文件竞态仍沿用“告警但不中断”；workspace 目录身份变化绝不能吞掉，
      // 否则后续写入可能落到攻击者替换的新目录。
      assertWorkspaceDirectory(workspaceIdentity);
      // 引擎自身仍是合法写者：重建失败不中断循环（中断反而把胜利让给篡改方）
      console.warn(
        `⚠️  engine.lock 重建失败（不中断循环）：${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  return { release: releaseNow, verify };
}
