import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-authority-test-seam.js';
import { createIdentityProbe } from '../identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from '../operation-authority-test-seam.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from '../posix-supervisor.js';
import { createWorkspaceSession } from '../session.js';

const workspace = process.argv[2];
if (!workspace) throw new Error('workspace path is required');

const ownerId = '00000000-0000-4000-8000-000000000010';
const operationId = '00000000-0000-4000-8000-000000000020';
const markerRoot = mkdtempSync(join(tmpdir(), 'coding-x-posix-parent-marker-'));
const inventoryPath = join(markerRoot, 'target-fd-inventory.json');
const inventoryTarget = fileURLToPath(new URL('./posix-fd-inventory-target.mjs', import.meta.url));
const identity = createIdentityProbe().current();

await bootstrapWorkspace({
  workspacePath: workspace,
  identity,
  ownerId: '00000000-0000-4000-8000-000000000001',
});
const lease = await acquireWorkspaceLease({
  workspacePath: workspace,
  identity,
  ownerId,
  command: 'run',
});
const session = createWorkspaceSession(lease);

await runWorkspaceOperation(
  session,
  {
    operationId,
    kind: 'final-review',
    delegation: 'read-only-v1',
    platform: 'posix-process-group-v1',
    helperBytes: readDarkPosixHelperBundle(),
  },
  async (operation) =>
    runDarkPosixSupervisedOperation(operation, {
      target: {
        executable: process.execPath,
        args: [inventoryTarget, inventoryPath],
        cwd: workspace,
        environment: [],
      },
      timeouts: { naturalDrainMs: 100, termMs: 1000, killMs: 5000, pollMs: 20 },
      hooks: {
        onStarted: ({ supervisorPid, containment, targetPid }) => {
          if (containment.platform !== 'posix-process-group-v1') {
            throw new Error('expected POSIX containment');
          }
          writeFileSync(
            process.stdout.fd,
            `${JSON.stringify({
              supervisorPid,
              targetPid,
              pgid: containment.pgid,
              launcherPid: containment.launcherPid,
              launcherIdentity: containment.launcherIdentity,
              markerPath: inventoryPath,
              inventoryPath,
            })}\n`,
          );
        },
      },
    }),
);
