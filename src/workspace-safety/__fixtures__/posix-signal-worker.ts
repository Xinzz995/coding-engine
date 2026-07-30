import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-authority-test-seam.js';
import { createIdentityProbe } from '../identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from '../operation-authority-test-seam.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from '../posix-supervisor.js';
import { createWorkspaceSession } from '../session.js';

const workspace = resolve(process.argv[2] ?? '');
const signal = process.argv[3];
if (!workspace || (signal !== 'SIGINT' && signal !== 'SIGTERM')) process.exit(2);

const ownerId = '00000000-0000-4000-8000-000000000071';
const operationId = '00000000-0000-4000-8000-000000000072';
const controller = new AbortController();
let sourceExitCode: 130 | 143 | undefined;

process.once('SIGINT', () => {
  sourceExitCode = 130;
  controller.abort();
});
process.once('SIGTERM', () => {
  sourceExitCode = 143;
  controller.abort();
});

const identity = createIdentityProbe().current();
await bootstrapWorkspace({
  workspacePath: workspace,
  identity,
  ownerId: '00000000-0000-4000-8000-000000000070',
});
const lease = await acquireWorkspaceLease({
  workspacePath: workspace,
  identity,
  ownerId,
  command: 'run',
});
const session = createWorkspaceSession(lease);
const stubbornGrandchild = [
  "process.on('SIGTERM', () => {});",
  'setInterval(() => {}, 1000);',
].join('');
const stubbornRoot = [
  "const { spawn } = require('node:child_process');",
  "process.on('SIGTERM', () => {});",
  `spawn(process.execPath, ['-e', ${JSON.stringify(stubbornGrandchild)}], { stdio: ['ignore', 1, 2] });`,
  'setInterval(() => {}, 1000);',
].join('');

const outcome = await runWorkspaceOperation(
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
        args: ['-e', stubbornRoot],
        cwd: workspace,
        environment: [],
      },
      termination: { signal: controller.signal, reason: 'user-interrupt' },
      timeouts: { naturalDrainMs: 100, termMs: 100, killMs: 3000, pollMs: 20 },
      hooks: {
        onStarted: ({ supervisorPid, containment }) => {
          if (containment.platform !== 'posix-process-group-v1') throw new Error('not POSIX');
          process.stdout.write(
            `${JSON.stringify({
              type: 'ready',
              supervisorPid,
              pgid: containment.pgid,
              launcherPid: containment.launcherPid,
              launcherIdentity: containment.launcherIdentity,
            })}\n`,
          );
        },
      },
    }),
);

const settledExistedBeforeClose = existsSync(outcome.settledPath);
await session.close();
process.stdout.write(
  `${JSON.stringify({
    type: 'finished',
    supervisorPid: outcome.supervisorPid,
    pgid: outcome.containment.pgid,
    verdict: outcome.verdict,
    terminationReason: outcome.terminationReason,
    proof: outcome.receipt.proof,
    drainReason: outcome.receipt.drainReason,
    settledPath: outcome.settledPath,
    settledExistedBeforeClose,
  })}\n`,
);
process.exitCode = sourceExitCode ?? 2;
