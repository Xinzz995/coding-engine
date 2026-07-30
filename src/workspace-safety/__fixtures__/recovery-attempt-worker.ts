import { existsSync } from 'node:fs';
import { acquireRecoveryAttemptWithAuthority as acquireRecoveryAttempt } from '../recovery-authority-test-seam.js';
import type { ProcessIdentitySnapshot } from '../types.js';

const [workspacePath, attemptId, barrierPath] = process.argv.slice(2);

function workerIdentity(): ProcessIdentitySnapshot {
  return {
    pid: process.pid,
    processIdentity: { kind: 'linux-boot-start', value: String(100_000 + process.pid) },
    bootIdentity: `sha256:${'a'.repeat(64)}`,
    hostId: `sha256:${'b'.repeat(64)}`,
  };
}

if (!workspacePath || !attemptId || !barrierPath || typeof process.send !== 'function') {
  process.exitCode = 2;
} else {
  process.send('ready');
  while (!existsSync(barrierPath)) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  try {
    await acquireRecoveryAttempt({
      workspacePath,
      attemptId,
      identity: workerIdentity(),
      probeSourceOwner: () => 'dead',
      probeAttemptOwner: (owner) => (owner.pid === 2_000_000_001 ? 'dead' : 'alive'),
    });
    const stopped = new Promise<void>((resolve) => {
      process.once('message', (message) => {
        if (message === 'stop') resolve();
      });
    });
    process.send('acquired');
    await stopped;
  } catch {
    process.send('rejected');
  }
}
