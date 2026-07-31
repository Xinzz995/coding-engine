import { existsSync } from 'node:fs';
import {
  currentCrossProcessTestIdentity,
  probeCrossProcessTestIdentity,
} from './identity-test-support.js';
import {
  acquireRecoveryAttemptWithAuthority as acquireRecoveryAttempt,
  finalizeMechanicalEmptyRecoveryWithAuthority as finalizeMechanicalEmptyRecovery,
} from '../recovery-authority-test-seam.js';

const [workspacePath, attemptId, barrierPath] = process.argv.slice(2);
if (!workspacePath || !attemptId || !barrierPath || !process.send) {
  throw new Error('recovery finalize worker arguments are missing');
}

function send(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
}

await send('ready');
while (!existsSync(barrierPath)) {
  await new Promise((resolve) => setTimeout(resolve, 5));
}

try {
  const handle = await acquireRecoveryAttempt({
    workspacePath,
    attemptId,
    identity: currentCrossProcessTestIdentity(),
    probeSourceOwner: probeCrossProcessTestIdentity,
    probeAttemptOwner: probeCrossProcessTestIdentity,
  });
  await finalizeMechanicalEmptyRecovery(handle, {
    attemptIdentity: currentCrossProcessTestIdentity(),
    probeSourceOwner: probeCrossProcessTestIdentity,
  });
  await send('completed');
} catch {
  await send('rejected');
}
process.disconnect();
