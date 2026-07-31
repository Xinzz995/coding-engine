import { randomUUID } from 'node:crypto';
import { lstatSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  driveToArmed,
  OPERATION_ID,
  OWNER_ID,
  readOnlyOptions,
} from './__fixtures__/operation-test-support.js';
import { createIdentityProbe } from './identity.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from './operation-authority-test-seam.js';
import {
  captureRecoverySourceSnapshotDigest,
  verifyMechanicalEmptyRecoveryArchive,
} from './recovery.js';
import {
  finalizeMechanicalEmptyRecoveryWithAuthority as finalizeMechanicalEmptyRecovery,
  installRecoveryDomainWithAuthority as installRecoveryDomain,
} from './recovery-authority-test-seam.js';
import { createWorkspaceSession } from './session.js';
import { encodeSupervisorAcknowledgement, encodeSupervisorStart } from './supervisor-protocol.js';
import { PROTOCOL_ROOT_DIR, WORKSPACE_MARKER_FILE } from './types.js';
import {
  acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease,
  bootstrapWorkspaceWithAuthority as bootstrapWorkspace,
} from './workspace-authority-test-seam.js';

const RECOVERY_ID = '00000000-0000-4000-8000-0000000000d1';
const ATTEMPT_ID = '00000000-0000-4000-8000-0000000000d2';
const roots: string[] = [];

interface SafetyByteScan {
  readonly paths: readonly string[];
  readonly totalBytes: number;
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scanSafetyAndArchiveBytes(workspace: string, forbidden: Buffer): SafetyByteScan {
  const paths: string[] = [];
  let totalBytes = 0;
  const scan = (path: string): void => {
    const info = lstatSync(path);
    const workspacePath = relative(workspace, path).replaceAll('\\', '/');
    if (info.isSymbolicLink()) throw new Error(`safety scan refuses symlink ${workspacePath}`);
    if (info.isDirectory()) {
      for (const entry of readdirSync(path).sort()) scan(join(path, entry));
      return;
    }
    if (!info.isFile()) throw new Error(`safety scan refuses special entry ${workspacePath}`);
    const bytes = readFileSync(path);
    if (bytes.includes(forbidden)) throw new Error(`secret canary leaked into ${workspacePath}`);
    paths.push(workspacePath);
    totalBytes += bytes.length;
  };

  scan(join(workspace, WORKSPACE_MARKER_FILE));
  scan(join(workspace, PROTOCOL_ROOT_DIR));
  return { paths: paths.sort(), totalBytes };
}

describe('workspace safety secret canary', () => {
  it('does not copy an unselected ordinary business secret into safety metadata', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-secret-canary-'));
    roots.push(workspace);
    const current = createIdentityProbe().current();
    await bootstrapWorkspace({
      workspacePath: workspace,
      identity: current,
      ownerId: '00000000-0000-4000-8000-0000000000d0',
    });
    const lease = await acquireWorkspaceLease({
      workspacePath: workspace,
      identity: { ...current, pid: 2_000_000_000 },
      ownerId: OWNER_ID,
      command: 'run',
    });
    const session = createWorkspaceSession(lease);

    // This proves only the unselected-secret boundary: the canary is never selected as mutation
    // input/archive data or passed through owner, operation, recovery, claim, or receipt inputs.
    // generic-v1 cannot prove that arbitrary caller-selected archive input contains no secrets.
    const canary = Buffer.from(`secret-canary-${randomUUID()}-${randomUUID()}`, 'utf8');
    await session.writer.writeFile('business-secret.txt', canary);

    const settlement = await runWorkspaceOperation(
      session,
      readOnlyOptions(),
      async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
        const drained = machine.drain(
          'posix-group-empty-and-pipes-eof-v1',
          'natural',
          new Date('2026-07-30T00:00:03.000Z'),
        );
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        machine.acknowledge(encodeSupervisorAcknowledgement(OPERATION_ID, drained.receiptDigest));
        return await operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
      },
    );
    expect(relative(workspace, settlement.settledPath).replaceAll('\\', '/')).toContain(
      'engine.lock/lease/settled-operations/',
    );

    const sourceSnapshotDigest = await captureRecoverySourceSnapshotDigest(workspace);
    const recovery = await installRecoveryDomain({
      workspacePath: workspace,
      expectedSourceSnapshotDigest: sourceSnapshotDigest,
      recoveryId: RECOVERY_ID,
      attemptId: ATTEMPT_ID,
      identity: current,
      mode: 'mechanical-empty',
      probeSourceOwner: () => 'dead',
      now: () => new Date('2026-07-30T00:10:00.000Z'),
    });

    const canonical = scanSafetyAndArchiveBytes(workspace, canary);
    expect(canonical.totalBytes).toBeGreaterThan(0);
    expect(canonical.paths).toContain('workspace-safety.json');
    expect(canonical.paths).toContain('engine.lock/protocol.json');
    expect(canonical.paths).toContain('engine.lock/lease/recovery/claim.json');
    expect(canonical.paths.some((path) => path.includes('/settled-operations/'))).toBe(true);

    const completion = await finalizeMechanicalEmptyRecovery(recovery, {
      probeSourceOwner: () => 'dead',
      now: () => new Date('2026-07-30T00:20:00.000Z'),
    });
    await expect(
      verifyMechanicalEmptyRecoveryArchive({
        workspacePath: workspace,
        targetArchive: completion.targetArchive,
      }),
    ).resolves.toEqual(completion);

    const archived = scanSafetyAndArchiveBytes(workspace, canary);
    expect(archived.paths.some((path) => path.includes('/incidents/recovery-'))).toBe(true);
    expect(archived.paths.some((path) => path.endsWith('/recovery/claim.json'))).toBe(true);
    expect(archived.paths.some((path) => path.includes('/settled-operations/'))).toBe(true);
    expect(readFileSync(join(workspace, 'business-secret.txt'))).toEqual(canary);

    const syntheticLeak = join(completion.archivePath, 'non-json-leak.bin');
    writeFileSync(syntheticLeak, Buffer.concat([Buffer.from([0]), canary, Buffer.from([0xff])]));
    expect(() => scanSafetyAndArchiveBytes(workspace, canary)).toThrow(
      /secret canary leaked into .*non-json-leak\.bin/u,
    );
  });
});
