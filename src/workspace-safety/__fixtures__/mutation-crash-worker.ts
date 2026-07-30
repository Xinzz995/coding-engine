import { existsSync } from 'node:fs';
import { createIdentityProbe } from '../identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import { acquireMutationRecoveryAttempt, resumeMutationRecovery } from '../mutation-recovery.js';
import {
  acquireMutationRecoveryAttemptWithAuthority,
  resumeMutationRecoveryWithAuthority,
} from '../recovery-authority-test-seam.js';
import { runWorkspaceMutationWithAuthority as runWorkspaceMutation } from '../mutation-authority-test-seam.js';
import { createWorkspaceSession } from '../session.js';

const [mode, workspacePath, barrier] = process.argv.slice(2);
if (!mode || !workspacePath || !barrier || !process.send) {
  throw new Error('mutation crash worker arguments are missing');
}

async function stopAt(name: string): Promise<void> {
  if (name !== barrier) return;
  await new Promise<void>((resolve, reject) => {
    process.send?.(`reached:${name}`, (error) => {
      if (error) reject(error);
      else resolve();
    });
  });
  await new Promise<never>(() => undefined);
}

if (mode === 'normal') {
  let businessStep = 0;
  const lease = await acquireWorkspaceLease({
    workspacePath,
    identity: createIdentityProbe().current(),
    command: 'repair',
  });
  await runWorkspaceMutation(createWorkspaceSession(lease), {
    kind: 'repair-v1',
    writes: [
      { path: 'created.txt', data: 'created' },
      { path: 'state.json', data: 'after' },
    ],
    deletes: ['obsolete.txt'],
    archivePaths: ['archive-me', 'state.json'],
    hooks: {
      afterMutationInstalled: () => stopAt('staged'),
      afterArchivingState: () => stopAt('archiving'),
      duringArchiveCopy: () => stopAt('archive-mid-copy'),
      afterApplyingState: () => stopAt('applying'),
      afterBusinessStep: async () => {
        businessStep += 1;
        await stopAt(`business-step-${businessStep}`);
      },
      afterCommittedState: () => stopAt('committed'),
    },
  });
} else if (mode === 'resume') {
  const handle = await acquireMutationRecoveryAttemptWithAuthority({
    workspacePath,
    identity: createIdentityProbe().current(),
    probeAttemptOwner: () => 'dead',
  });
  await resumeMutationRecoveryWithAuthority(handle, {
    hooks: {
      afterMutationStateInstalled: (phase) => stopAt(`mutation-state-${phase}`),
      beforeFinalManifestSourceUnlink: () => stopAt('final-manifest-linked'),
      beforeFinalRename: () => stopAt('finalizing'),
    },
  });
} else if (mode === 'race') {
  process.send('ready');
  while (!existsSync(barrier)) await new Promise((resolve) => setTimeout(resolve, 5));
  try {
    const handle = await acquireMutationRecoveryAttempt({
      workspacePath,
    });
    await resumeMutationRecovery(handle);
    process.send('completed');
  } catch {
    process.send('rejected');
  }
} else {
  throw new Error(`unknown mutation worker mode: ${mode}`);
}

if (mode !== 'race') process.send('completed');
process.disconnect();
