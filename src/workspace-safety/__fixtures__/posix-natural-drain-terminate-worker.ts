import { writeFileSync } from 'node:fs';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-authority-test-seam.js';
import { createIdentityProbe, createSystemIdentityAdapter } from '../identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from '../operation-authority-test-seam.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from '../posix-supervisor.js';
import { createWorkspaceSession } from '../session.js';

const workspace = process.argv[2];
if (!workspace) throw new Error('workspace path is required');

const ownerId = '00000000-0000-4000-8000-000000000010';
const operationId = '00000000-0000-4000-8000-000000000020';
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
const controller = new AbortController();
const descendant = 'setInterval(() => {}, 1000)';
const root = [
  "const {spawn}=require('node:child_process');",
  `spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:['ignore',1,2]});`,
  'process.exit(0);',
].join('');

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
        args: ['-e', root],
        cwd: workspace,
        environment: [],
      },
      termination: { signal: controller.signal, reason: 'user-interrupt' },
      timeouts: {
        handshakeMs: 2000,
        naturalDrainMs: 5000,
        termMs: 50,
        killMs: 500,
        ackMs: 100,
        pollMs: 10,
      },
      hooks: {
        onStarted: ({ supervisorPid, containment }) => {
          if (containment.platform !== 'posix-process-group-v1') {
            throw new Error('expected POSIX containment');
          }
          const supervisorIdentity =
            createSystemIdentityAdapter().readProcessIdentity(supervisorPid);
          if (supervisorIdentity.status !== 'found') {
            throw new Error('supervisor identity is unavailable');
          }
          writeFileSync(
            process.stdout.fd,
            `${JSON.stringify({
              phase: 'started',
              supervisorPid,
              supervisorIdentity: supervisorIdentity.value,
              pgid: containment.pgid,
              launcherPid: containment.launcherPid,
              launcherIdentity: containment.launcherIdentity,
            })}\n`,
          );
        },
        onRootResult: ({ containment }) => {
          if (containment.platform !== 'posix-process-group-v1') {
            throw new Error('expected POSIX containment');
          }
          process.kill(containment.launcherPid, 'SIGSTOP');
          controller.abort();
        },
        onTerminating: ({ reason }) => {
          writeFileSync(
            process.stdout.fd,
            `${JSON.stringify({ phase: 'terminate-sent', reason })}\n`,
          );
        },
      },
    }),
);
