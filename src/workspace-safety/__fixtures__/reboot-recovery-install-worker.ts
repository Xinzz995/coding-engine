import { writeFileSync } from 'node:fs';
import { HELPER_BYTES } from './operation-test-support.js';
import { installSameHostRebootRecoveryWithAuthority as installSameHostRebootRecovery } from '../recovery-authority-test-seam.js';

const [mode, workspace, recoveryId, attemptId] = process.argv.slice(2);
if (
  (mode !== 'mechanical-empty' && mode !== 'prestart' && mode !== 'delegated-finalize') ||
  !workspace ||
  !recoveryId ||
  !attemptId
) {
  throw new Error('reboot recovery install worker arguments are invalid');
}

const handle = await installSameHostRebootRecovery({
  workspacePath: workspace,
  recoveryId,
  attemptId,
  ...(mode === 'prestart' ? { helperBytes: HELPER_BYTES } : {}),
});
writeFileSync(
  process.stdout.fd,
  `${JSON.stringify({ mode, attemptId, handleIssued: Object.isFrozen(handle) })}\n`,
);
