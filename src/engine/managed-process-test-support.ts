import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapWorkspace } from '../workspace-safety/bootstrap.js';
import { acquireWorkspaceLease } from '../workspace-safety/lease.js';
import { createWorkspaceSession, type WorkspaceSession } from '../workspace-safety/session.js';

export interface ManagedProcessTestSession {
  readonly session: WorkspaceSession;
  readonly workspacePath: string;
  close(): Promise<void>;
}

/**
 * 子进程测试也必须经过正式 bootstrap、lease 与 session；测试不能保留第二条
 * 未受控 spawn 路径。被测进程的 cwd/marker 应放在 workspace 之外。
 */
export async function createManagedProcessTestSession(): Promise<ManagedProcessTestSession> {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-managed-process-'));
  const workspacePath = join(root, '.workspace');
  try {
    await bootstrapWorkspace({ workspacePath });
    const lease = await acquireWorkspaceLease({ workspacePath, command: 'run' });
    const session = createWorkspaceSession(lease);
    let closed = false;
    return {
      session,
      workspacePath,
      async close() {
        if (closed) return;
        closed = true;
        try {
          await session.close();
        } finally {
          rmSync(root, { recursive: true, force: true });
        }
      },
    };
  } catch (error) {
    rmSync(root, { recursive: true, force: true });
    throw error;
  }
}
