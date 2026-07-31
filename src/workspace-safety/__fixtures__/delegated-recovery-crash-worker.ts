import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ACCEPTANCE_HASH, OPERATION_ID, OWNER_ID, STORY_ID } from './operation-test-support.js';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from '../workspace-authority-test-seam.js';
import {
  acquireDelegatedFinalizeRecovery,
  finalizeDelegatedRecovery,
  installDelegatedFinalizeRecovery,
  verifyDelegatedRecoveryArchive,
} from '../delegated-recovery.js';
import { createIdentityProbe } from '../identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from '../workspace-authority-test-seam.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from '../operation-authority-test-seam.js';
import { readDarkPosixHelperBundle, runDarkPosixSupervisedOperation } from '../posix-supervisor.js';
import { QUARANTINE_FILE, parseQuarantineRecord } from '../quarantine.js';
import { createWorkspaceSession } from '../session.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR, RECOVERY_DIR } from '../types.js';
import {
  readDarkWindowsHelperBundle,
  runDarkWindowsSupervisedOperation,
} from '../windows-supervisor.js';
import { windowsTestTargetEnvironment } from '../windows-test-environment.js';

const [mode, workspace, delta] = process.argv.slice(2);
if (!mode || !workspace) throw new Error('delegated recovery worker arguments are missing');

function output(value: unknown): void {
  writeFileSync(process.stdout.fd, `${JSON.stringify(value)}\n`);
}

if (mode === 'parent') {
  if (delta !== 'legal' && delta !== 'forbidden') throw new Error('parent delta is invalid');
  const identity = createIdentityProbe().current();
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity,
    ownerId: '00000000-0000-4000-8000-000000000001',
  });
  const lease = await acquireWorkspaceLease({
    workspacePath: workspace,
    identity,
    ownerId: OWNER_ID,
    command: 'run',
  });
  writeFileSync(
    join(workspace, 'state.json'),
    JSON.stringify({
      [STORY_ID]: {
        passes: false,
        validated: false,
        validationReceipt: null,
        notes: '',
        retryCount: 0,
        blocked: false,
        escalated: false,
      },
    }),
  );
  mkdirSync(join(workspace, 'screenshots'));
  const markerRoot = mkdtempSync(join(tmpdir(), 'coding-x-delegated-recovery-target-'));
  const markerPath = join(markerRoot, 'ready');
  const targetSource = `
    const fs = require('node:fs');
    const path = require('node:path');
    const workspace = ${JSON.stringify(workspace)};
    if (${JSON.stringify(delta)} === 'legal') {
      const statePath = path.join(workspace, 'state.json');
      const state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
      state[${JSON.stringify(STORY_ID)}].passes = true;
      state[${JSON.stringify(STORY_ID)}].notes = ${JSON.stringify(`${ACCEPTANCE_HASH}: recovered candidate`)};
      fs.writeFileSync(statePath, JSON.stringify(state));
    } else {
      fs.writeFileSync(path.join(workspace, 'forbidden.txt'), 'outside delegated scope');
    }
    fs.writeFileSync(${JSON.stringify(markerPath)}, 'ready');
    setInterval(() => {}, 1000);
  `;
  const session = createWorkspaceSession(lease);
  const helperBytes =
    process.platform === 'win32' ? readDarkWindowsHelperBundle() : readDarkPosixHelperBundle();
  const onStarted = (facts: {
    supervisorPid: number;
    targetPid: number;
    containment: { platform: string };
  }): void => {
    output({
      type: 'started',
      supervisorPid: facts.supervisorPid,
      targetPid: facts.targetPid,
      containmentPlatform: facts.containment.platform,
      ...('pgid' in facts.containment ? { pgid: facts.containment.pgid } : {}),
      markerPath,
      markerRoot,
    });
  };
  await runWorkspaceOperation(
    session,
    {
      operationId: OPERATION_ID,
      kind: 'builder',
      delegation: 'builder-v1',
      storyId: STORY_ID,
      acceptanceHash: ACCEPTANCE_HASH,
      checkCount: 1,
      platform: process.platform === 'win32' ? 'windows-job-v1' : 'posix-process-group-v1',
      helperBytes,
    },
    async (operation) => {
      const invocation = {
        target: {
          executable: process.execPath,
          args: ['-e', targetSource],
          cwd: workspace,
          environment: process.platform === 'win32' ? windowsTestTargetEnvironment() : [],
        },
        hooks: { onStarted },
      };
      if (process.platform === 'win32') {
        await runDarkWindowsSupervisedOperation(operation, {
          ...invocation,
          timeouts: { naturalDrainMs: 100, terminateMs: 1000, ackMs: 5000, pollMs: 20 },
        });
        return;
      }
      await runDarkPosixSupervisedOperation(operation, {
        ...invocation,
        timeouts: { naturalDrainMs: 100, termMs: 1000, killMs: 5000, pollMs: 20 },
      });
    },
  );
} else if (mode === 'recover') {
  try {
    const recoveryPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, RECOVERY_DIR);
    const options = { workspacePath: workspace };
    const handle = existsSync(recoveryPath)
      ? await acquireDelegatedFinalizeRecovery(options)
      : await installDelegatedFinalizeRecovery(options);
    const completion = await finalizeDelegatedRecovery(handle);
    const verified = await verifyDelegatedRecoveryArchive({
      workspacePath: workspace,
      targetArchive: completion.targetArchive,
    });
    output({
      type: 'completed',
      archivePath: verified.archivePath,
      candidateDigest: verified.candidateDigest,
      candidate: verified.candidate,
    });
  } catch (error) {
    const operationPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
    const quarantinePath = join(operationPath, QUARANTINE_FILE);
    output({
      type: 'rejected',
      code: error instanceof Error && 'code' in error ? String(error.code) : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      quarantine: existsSync(quarantinePath)
        ? parseQuarantineRecord(readFileSync(quarantinePath))
        : null,
    });
  }
} else {
  throw new Error(`unknown delegated recovery worker mode: ${mode}`);
}
