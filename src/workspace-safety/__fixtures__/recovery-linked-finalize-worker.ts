import {
  currentCrossProcessTestIdentity,
  probeCrossProcessTestIdentity,
} from './identity-test-support.js';
import {
  acquireRecoveryAttemptWithAuthority as acquireRecoveryAttempt,
  finalizeMechanicalEmptyRecoveryWithAuthority as finalizeMechanicalEmptyRecovery,
} from '../recovery-authority-test-seam.js';

const [workspacePath, attemptId] = process.argv.slice(2);
if (!workspacePath || !attemptId || !process.send) {
  throw new Error('linked finalization worker arguments are missing');
}

function send(message: string): Promise<void> {
  return new Promise((resolve, reject) => {
    process.send?.(message, (error) => (error ? reject(error) : resolve()));
  });
}

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
  hooks: {
    beforeFinalManifestSourceUnlink: async () => {
      await send('linked');
      await new Promise<never>(() => undefined);
    },
  },
});
