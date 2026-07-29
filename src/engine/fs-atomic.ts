import { writeFileSync, renameSync, unlinkSync } from 'node:fs';
import { assertRegisteredWorkspacePath, assertWorkspaceDirectory } from './workspace-identity.js';

/**
 * 覆盖写的原子替代：写 `<path>.tmp-<pid>` 后 rename（同目录 rename 在 POSIX 原子；
 * win32 renameSync 对已存在目标同样覆盖成功）。进程写入中途被杀只损失 tmp，
 * 目标文件永远是完整旧版或完整新版——半截 JSON 不再可能（2.5h 被 kill 环境坑的风险源）。
 * tmp 命名模式与 lock.ts 的 acquire 后残留清理（/\.tmp-\d+$/）配对，改动需两处同步。
 */
export function writeFileAtomicSync(path: string, data: string): void {
  const workspaceIdentity = assertRegisteredWorkspacePath(path);
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    // wx 同时拒绝预先放置的软链/文件；项目进程知道 pid 也只能让本次写入失败，
    // 不能借可预测临时名把内容重定向到 workspace 外。
    writeFileSync(tmp, data, { encoding: 'utf-8', flag: 'wx' });
    if (workspaceIdentity) assertWorkspaceDirectory(workspaceIdentity);
    renameSync(tmp, path);
    if (workspaceIdentity) assertWorkspaceDirectory(workspaceIdentity);
  } catch (err) {
    try {
      if (workspaceIdentity) assertWorkspaceDirectory(workspaceIdentity);
      unlinkSync(tmp);
    } catch {
      /* 尽力清理；身份变化时绝不能沿新路径删除（其余残留由 acquire 兜底） */
    }
    throw err;
  }
}
