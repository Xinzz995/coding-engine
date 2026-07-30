import { existsSync } from 'node:fs';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import type { ProcessIdentitySnapshot } from '../types.js';

const [workspacePath, barrierPath] = process.argv.slice(2);

function workerIdentity(): ProcessIdentitySnapshot {
  return {
    pid: process.pid,
    processIdentity: { kind: 'linux-boot-start', value: String(100_000 + process.pid) },
    bootIdentity: `sha256:${'a'.repeat(64)}`,
    hostId: `sha256:${'b'.repeat(64)}`,
  };
}

async function send(message: string): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

if (!workspacePath || !barrierPath || typeof process.send !== 'function') {
  process.exitCode = 2;
} else {
  try {
    const lease = await acquireWorkspaceLease({
      workspacePath,
      // This fixture proves a real cross-process directory race. OS identity transport is covered
      // separately and must not make the deterministic contention barrier depend on PowerShell.
      identity: workerIdentity(),
      command: 'run',
      hooks: {
        beforeLeaseInstall: async () => {
          await send('staged');
          while (!existsSync(barrierPath)) {
            await new Promise((resolve) => setTimeout(resolve, 5));
          }
        },
      },
    });
    await lease.release();
    await send('acquired');
  } catch {
    await send('rejected');
  }
}
