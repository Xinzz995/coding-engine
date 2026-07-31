import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-authority-test-seam.js';
import {
  currentCrossProcessTestIdentity,
  probeCrossProcessTestIdentity,
} from './identity-test-support.js';
import {
  finalizeBootstrapRecoveryWithAuthority as finalizeBootstrapRecovery,
  installBootstrapRecoveryDomainWithAuthority as installBootstrapRecoveryDomain,
} from '../recovery-authority-test-seam.js';
import { captureBootstrapRecoverySourceSnapshotDigest } from '../recovery.js';

const [mode, workspacePath, barrier] = process.argv.slice(2);

function blockAt(name: string): Promise<never> {
  process.stdout.write(`READY:${name}\n`);
  return new Promise<never>(() => undefined);
}

if (!mode || !workspacePath) throw new Error('mode and workspace are required');

if (mode === 'bootstrap-root' || mode === 'bootstrap-linked') {
  await bootstrapWorkspace({
    workspacePath,
    identity: currentCrossProcessTestIdentity(),
    hooks:
      mode === 'bootstrap-root'
        ? { afterProtocolRootInstalled: () => blockAt('bootstrap-root') }
        : { beforeMarkerSourceUnlink: () => blockAt('bootstrap-linked') },
  });
} else if (mode === 'recover') {
  const sourceSnapshotDigest = await captureBootstrapRecoverySourceSnapshotDigest(workspacePath);
  const handle = await installBootstrapRecoveryDomain({
    workspacePath,
    expectedSourceSnapshotDigest: sourceSnapshotDigest,
    identity: currentCrossProcessTestIdentity(),
    probeSourceOwner: probeCrossProcessTestIdentity,
  });
  await finalizeBootstrapRecovery(handle, {
    attemptIdentity: currentCrossProcessTestIdentity(),
    hooks: {
      beforeMarkerInstall: barrier === 'before-marker' ? () => blockAt('before-marker') : undefined,
      beforeMarkerSourceUnlink:
        barrier === 'linked-marker' ? () => blockAt('linked-marker') : undefined,
      afterMarkerInstalled: barrier === 'after-marker' ? () => blockAt('after-marker') : undefined,
      beforeFinalManifestSourceUnlink:
        barrier === 'linked-final-manifest' ? () => blockAt('linked-final-manifest') : undefined,
      beforeFinalRename:
        barrier === 'before-final-rename' ? () => blockAt('before-final-rename') : undefined,
    },
  });
} else {
  throw new Error(`unsupported worker mode: ${mode}`);
}
