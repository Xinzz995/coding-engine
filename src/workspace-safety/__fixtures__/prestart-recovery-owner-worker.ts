import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-authority-test-seam.js';
import { currentCrossProcessTestIdentity } from './identity-test-support.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from '../operation-authority-test-seam.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from '../posix-supervisor.js';
import { createWorkspaceSession } from '../session.js';
import {
  readDarkWindowsHelperBundle,
  runDarkWindowsSupervisedOperation,
} from '../windows-supervisor.js';
import { windowsTestTargetEnvironment } from '../windows-test-environment.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000010';
const OPERATION_ID = '00000000-0000-4000-8000-000000000020';
const [workspace, mode, markerPath] = process.argv.slice(2);

if (
  !workspace ||
  !markerPath ||
  (mode !== 'prepared' && mode !== 'prepared-bound') ||
  typeof process.send !== 'function'
) {
  process.exitCode = 2;
} else {
  const identity = currentCrossProcessTestIdentity();
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity,
    ownerId: '00000000-0000-4000-8000-0000000000b1',
  });
  const lease = await acquireWorkspaceLease({
    workspacePath: workspace,
    identity,
    ownerId: OWNER_ID,
    command: 'run',
  });
  const session = createWorkspaceSession(lease);
  const windows = process.platform === 'win32';
  const helperBytes = windows ? readDarkWindowsHelperBundle() : readDarkPosixHelperBundle();
  let supervisorPid: number | undefined;
  const blocked = new Promise<never>(() => undefined);
  void runWorkspaceOperation(
    session,
    {
      operationId: OPERATION_ID,
      kind: 'final-review',
      delegation: 'read-only-v1',
      platform: windows ? 'windows-job-v1' : 'posix-process-group-v1',
      helperBytes,
      hooks: {
        afterActiveCommitted: async (state) => {
          if (mode !== 'prepared-bound' || state !== 'prepared-bound' || !supervisorPid) return;
          process.send?.({ type: 'ready', mode, supervisorPid });
          await blocked;
        },
      },
    },
    async (operation) => {
      const options = {
        target: {
          executable: process.execPath,
          args: [
            '-e',
            `require('node:fs').writeFileSync(${JSON.stringify(markerPath)}, 'started')`,
          ],
          cwd: workspace,
          environment: windows ? windowsTestTargetEnvironment() : [],
        },
        hooks: {
          onBound: async (facts: { readonly supervisorPid: number }) => {
            supervisorPid = facts.supervisorPid;
            if (mode !== 'prepared') return;
            process.send?.({ type: 'ready', mode, supervisorPid });
            await blocked;
          },
        },
      };
      return windows
        ? await runDarkWindowsSupervisedOperation(operation, options)
        : await runDarkPosixSupervisedOperation(operation, options);
    },
  );
  // Keep the owner alive at the selected durable barrier until the test sends SIGKILL.
  setInterval(() => undefined, 1_000);
  await blocked;
}
