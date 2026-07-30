import { HELPER_BYTES } from './operation-test-support.js';
import { createIdentityProbe } from '../identity.js';
import {
  acquirePrestartRecoveryWithAuthority as acquirePrestartRecovery,
  finalizePrestartRecoveryWithAuthority as finalizePrestartRecovery,
} from '../recovery-authority-test-seam.js';

const [workspacePath, attemptId, barrier] = process.argv.slice(2);
if (
  !workspacePath ||
  !attemptId ||
  (barrier !== 'abort-link' && barrier !== 'manifest-link') ||
  typeof process.send !== 'function'
) {
  process.exitCode = 2;
} else {
  const handle = await acquirePrestartRecovery({
    workspacePath,
    attemptId,
    identity: createIdentityProbe().current(),
    helperBytes: HELPER_BYTES,
    probeSourceOwner: () => 'dead',
    probeAttemptOwner: () => 'dead',
  });
  const stopped = new Promise<never>(() => undefined);
  await finalizePrestartRecovery(handle, {
    helperBytes: HELPER_BYTES,
    probeSourceOwner: () => 'dead',
    hooks: {
      beforeAbortInstallSourceUnlink:
        barrier === 'abort-link'
          ? async () => {
              process.send?.('ready');
              await stopped;
            }
          : undefined,
      beforeFinalManifestSourceUnlink:
        barrier === 'manifest-link'
          ? async () => {
              process.send?.('ready');
              await stopped;
            }
          : undefined,
    },
  });
}
