import { existsSync } from 'node:fs';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import { currentCrossProcessTestIdentity } from './identity-test-support.js';

const [workspacePath, barrierPath] = process.argv.slice(2);

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
      identity: currentCrossProcessTestIdentity(),
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
