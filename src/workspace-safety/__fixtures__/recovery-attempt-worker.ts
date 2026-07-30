import { existsSync } from 'node:fs';
import { createIdentityProbe } from '../identity.js';
import { acquireRecoveryAttemptWithAuthority as acquireRecoveryAttempt } from '../recovery-authority-test-seam.js';

const [workspacePath, attemptId, barrierPath] = process.argv.slice(2);
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
      identity: createIdentityProbe().current(),
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
