import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { bootstrapWorkspaceWithAuthority as bootstrapWorkspace } from './workspace-authority-test-seam.js';
import {
  ACCEPTANCE_HASH,
  HELPER_BYTES,
  OPERATION_ID,
  OWNER_ID as OPERATION_OWNER_ID,
  STORY_ID,
  defaultOptions,
  driveToArmed,
  operationPath,
  supervisor,
} from './__fixtures__/operation-test-support.js';
import { digestBytes, jsonBytes } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import { classifySameHostRebootIdentity } from './identity.js';
import { acquireWorkspaceLeaseWithAuthority as acquireWorkspaceLease } from './workspace-authority-test-seam.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from './operation-authority-test-seam.js';
import {
  createQuarantineRecordBytes,
  parseQuarantineRecord,
  QUARANTINE_FILE,
  type QuarantineRecord,
} from './quarantine.js';
import {
  acquireSameHostRebootRecoveryWithAuthority as acquireSameHostRebootRecovery,
  finalizeSameHostRebootRecoveryWithAuthority as finalizeSameHostRebootRecovery,
  inspectSameHostRebootRecoveryWithAuthority as inspectSameHostRebootRecovery,
  installSameHostRebootRecoveryWithAuthority as installSameHostRebootRecovery,
} from './recovery-authority-test-seam.js';
import { readRecoveryDomain } from './recovery-domain.js';
import { createWorkspaceSession } from './session.js';
import { encodeSupervisorStart } from './supervisor-protocol.js';
import {
  ACTIVE_LEASE_DIR,
  OWNER_FILE,
  PROTOCOL_ROOT_DIR,
  RECOVERY_DIR,
  type ProcessIdentityKind,
  type ProcessIdentitySnapshot,
} from './types.js';

const roots: string[] = [];
const OWNER_ID = '00000000-0000-4000-8000-000000000071';
const RECOVERY_ID = '00000000-0000-4000-8000-000000000072';
const ATTEMPT_A = '00000000-0000-4000-8000-000000000073';
const ATTEMPT_B = '00000000-0000-4000-8000-000000000074';
const BOOT_A = `sha256:${'a'.repeat(64)}`;
const BOOT_B = `sha256:${'b'.repeat(64)}`;
const HOST_A = `sha256:${'c'.repeat(64)}`;

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function leasePath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
}

function recoveryPath(workspace: string): string {
  return join(leasePath(workspace), RECOVERY_DIR);
}

function differentBoot(current: string): string {
  return current === BOOT_A ? BOOT_B : BOOT_A;
}

function identityValue(kind: ProcessIdentityKind, sequence: number): string {
  return kind === 'macos-boot-start'
    ? `Thu Jul 30 04:00:${String(sequence).padStart(2, '0')} 2026`
    : String(700 + sequence);
}

function sourceIdentity(current: ProcessIdentitySnapshot): ProcessIdentitySnapshot {
  return {
    pid: 2_000_000_017,
    processIdentity: {
      kind: current.processIdentity.kind,
      value: identityValue(current.processIdentity.kind, 1),
    },
    bootIdentity: differentBoot(current.bootIdentity),
    hostId: current.hostId,
  };
}

async function idleContainmentWorkspace(
  options: {
    readonly current?: ProcessIdentitySnapshot;
    readonly source?: ProcessIdentitySnapshot;
    readonly reason?: QuarantineRecord['reason'];
  } = {},
): Promise<{
  workspace: string;
  current: ProcessIdentitySnapshot;
  quarantineBytes: Buffer;
}> {
  const workspace = mkdtempSync(join(tmpdir(), 'coding-x-reboot-'));
  roots.push(workspace);
  const current = options.current ?? createIdentityProbe().current();
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity: current,
    ownerId: '00000000-0000-4000-8000-000000000070',
  });
  await acquireWorkspaceLease({
    workspacePath: workspace,
    identity: options.source ?? sourceIdentity(current),
    ownerId: OWNER_ID,
    command: 'run',
    now: () => new Date('2026-07-30T04:00:00.000Z'),
  });
  const ownerBytes = readFileSync(join(leasePath(workspace), OWNER_FILE));
  const quarantineBytes = createQuarantineRecordBytes({
    ownerId: OWNER_ID,
    operationId: null,
    activeChildDigest: null,
    delegatedBaselineDigest: null,
    creator: { kind: 'owner', id: OWNER_ID, recordDigest: digestBytes(ownerBytes) },
    reason: options.reason ?? 'containment-unconfirmed',
    priorQuarantineDigest: null,
    createdAt: new Date('2026-07-30T04:00:01.000Z'),
  });
  writeFileSync(join(leasePath(workspace), QUARANTINE_FILE), quarantineBytes);
  return { workspace, current, quarantineBytes };
}

function treeBytes(root: string): Buffer {
  const rows: string[] = [];
  const walk = (path: string, relative: string): void => {
    for (const name of readdirSync(path).sort()) {
      const child = join(path, name);
      const rel = relative ? `${relative}/${name}` : name;
      const info = lstatSync(child);
      if (info.isDirectory()) {
        rows.push(`d\0${rel}`);
        walk(child, rel);
      } else {
        rows.push(`f\0${rel}\0${digestBytes(readFileSync(child))}`);
      }
    }
  };
  walk(root, '');
  return Buffer.from(rows.join('\n'), 'utf8');
}

function platformIdentity(
  kind: ProcessIdentityKind,
  bootIdentity: string,
  hostId = HOST_A,
): ProcessIdentitySnapshot {
  return {
    pid: 701,
    processIdentity: { kind, value: identityValue(kind, 2) },
    bootIdentity,
    hostId,
  };
}

async function installInExitedWorker(
  mode: 'mechanical-empty' | 'prestart' | 'delegated-finalize',
  workspace: string,
): Promise<void> {
  const fixture = fileURLToPath(
    new URL('./__fixtures__/reboot-recovery-install-worker.ts', import.meta.url),
  );
  const child = spawn(
    process.execPath,
    ['--import=tsx', fixture, mode, workspace, RECOVERY_ID, ATTEMPT_A],
    { stdio: ['ignore', 'pipe', 'pipe'] },
  );
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stdout.on('data', (chunk: string) => {
    stdout += chunk;
  });
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const code = await new Promise<number | null>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (code !== 0) throw new Error(`reboot install worker exited ${code}: ${stderr}`);
  expect(JSON.parse(stdout)).toMatchObject({ mode, attemptId: ATTEMPT_A });
}

async function operationContainmentWorkspace(
  state: 'prepared' | 'prepared-bound' | 'armed',
  change: 'none' | 'legal' = 'none',
  source?: ProcessIdentitySnapshot,
): Promise<{ workspace: string; current: ProcessIdentitySnapshot }> {
  const workspace = mkdtempSync(join(tmpdir(), `coding-x-reboot-${state}-`));
  roots.push(workspace);
  const current = createIdentityProbe().current();
  await bootstrapWorkspace({
    workspacePath: workspace,
    identity: current,
    ownerId: '00000000-0000-4000-8000-000000000075',
  });
  const lease = await acquireWorkspaceLease({
    workspacePath: workspace,
    identity: source ?? sourceIdentity(current),
    ownerId: OPERATION_OWNER_ID,
    command: 'run',
    now: () => new Date('2026-07-30T04:30:00.000Z'),
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
  const session = createWorkspaceSession(lease);
  let ready!: () => void;
  const operationReady = new Promise<void>((resolve) => {
    ready = resolve;
  });
  void runWorkspaceOperation(session, defaultOptions(), async (operation) => {
    if (state === 'prepared-bound') {
      await operation.bindSupervisorControlled(supervisor);
    } else if (state === 'armed') {
      const { machine, armed } = await driveToArmed(operation);
      machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
      if (change === 'legal') {
        const record = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8')) as Record<
          string,
          Record<string, unknown>
        >;
        record[STORY_ID].passes = true;
        record[STORY_ID].notes = `${ACCEPTANCE_HASH}: reboot candidate`;
        writeFileSync(join(workspace, 'state.json'), JSON.stringify(record));
      }
      const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
      await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
    }
    await operation.installQuarantineControlled('containment-unconfirmed');
    ready();
    return await new Promise<never>(() => undefined);
  });
  await operationReady;
  return { workspace, current };
}

describe('same-host reboot proof planning', () => {
  it.each([
    ['linux', 'linux-boot-start'],
    ['darwin', 'macos-boot-start'],
    ['win32', 'windows-filetime'],
  ] as const)('proves only the platform-neutral %s adapter logic', (_platform, kind) => {
    expect(
      classifySameHostRebootIdentity(
        platformIdentity(kind, BOOT_A),
        platformIdentity(kind, BOOT_B),
      ),
    ).toBe('same-host-boot-changed');
  });

  it.each([
    [
      'foreign host',
      (source: ProcessIdentitySnapshot) => ({ ...source, hostId: `sha256:${'8'.repeat(64)}` }),
    ],
    [
      'same boot',
      (source: ProcessIdentitySnapshot, current: ProcessIdentitySnapshot) => ({
        ...source,
        bootIdentity: current.bootIdentity,
      }),
    ],
    [
      'different platform kind',
      (source: ProcessIdentitySnapshot) => {
        const kind =
          source.processIdentity.kind === 'windows-filetime'
            ? ('linux-boot-start' as const)
            : ('windows-filetime' as const);
        return { ...source, processIdentity: { kind, value: identityValue(kind, 3) } };
      },
    ],
  ] as const)('keeps %s isolated and writes nothing', async (_label, change) => {
    const current = createIdentityProbe().current();
    const source = change(sourceIdentity(current), current);
    const setup = await idleContainmentWorkspace({ current, source });
    const before = treeBytes(setup.workspace);
    await expect(
      inspectSameHostRebootRecovery({ workspacePath: setup.workspace }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(treeBytes(setup.workspace)).toEqual(before);
  });

  it.each(['operation-proof-missing', 'workspace-integrity-violation'] as const)(
    'never converts terminal %s into a reboot claim',
    async (reason) => {
      const setup = await idleContainmentWorkspace({ reason });
      const before = treeBytes(setup.workspace);
      await expect(
        installSameHostRebootRecovery({
          workspacePath: setup.workspace,
        }),
      ).rejects.toMatchObject({ code: 'isolated' });
      expect(treeBytes(setup.workspace)).toEqual(before);
      expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
    },
  );
});

describe('same-host reboot mechanical continuation', () => {
  it('keeps one controlled identity source bound through install and finalization', async () => {
    const setup = await idleContainmentWorkspace();
    let reads = 0;
    const readCurrentIdentity = (): ProcessIdentitySnapshot => {
      reads += 1;
      return setup.current;
    };
    const handle = await installSameHostRebootRecovery({
      workspacePath: setup.workspace,
      readCurrentIdentity,
    });
    const readsAfterInstall = reads;

    await finalizeSameHostRebootRecovery(handle);

    expect(readsAfterInstall).toBeGreaterThan(1);
    expect(reads).toBeGreaterThan(readsAfterInstall);
    expect(existsSync(leasePath(setup.workspace))).toBe(false);
  });

  it('archives the original containment reason with the lease instead of deleting or relabeling it', async () => {
    const setup = await idleContainmentWorkspace();
    await installInExitedWorker('mechanical-empty', setup.workspace);
    expect((await readRecoveryDomain(setup.workspace)).claim.rebootProof).toMatchObject({
      previousBootIdentity: differentBoot(setup.current.bootIdentity),
      currentBootIdentity: setup.current.bootIdentity,
    });

    const replacement = await acquireSameHostRebootRecovery({
      workspacePath: setup.workspace,
      attemptId: ATTEMPT_B,
      now: () => new Date('2026-07-30T04:11:00.000Z'),
    });
    expect(Object.keys(replacement)).toEqual([]);
    expect(Object.isFrozen(replacement)).toBe(true);
    expect(() => Object.assign(replacement, { mode: 'delegated-finalize' })).toThrow(TypeError);
    const completion = await finalizeSameHostRebootRecovery(replacement, {
      now: () => new Date('2026-07-30T04:12:00.000Z'),
    });

    expect(existsSync(leasePath(setup.workspace))).toBe(false);
    const archived = readFileSync(join(completion.archivePath, QUARANTINE_FILE));
    expect(archived).toEqual(setup.quarantineBytes);
    expect(parseQuarantineRecord(archived).reason).toBe('containment-unconfirmed');
    expect(
      readdirSync(join(completion.archivePath, RECOVERY_DIR, 'attempts')).some((name) =>
        name.startsWith('abandoned-'),
      ),
    ).toBe(true);
  });

  it('rechecks exact quarantine bytes before recovery staging', async () => {
    const setup = await idleContainmentWorkspace();
    await expect(
      installSameHostRebootRecovery({
        workspacePath: setup.workspace,
        beforeClaimInstall: () => {
          const changed = JSON.parse(setup.quarantineBytes.toString('utf8')) as Record<
            string,
            unknown
          >;
          changed.createdAt = '2026-07-30T04:20:00.000Z';
          writeFileSync(join(leasePath(setup.workspace), QUARANTINE_FILE), jsonBytes(changed));
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
    expect(
      readdirSync(leasePath(setup.workspace)).filter((name) =>
        name.startsWith('recovery.prepare-'),
      ),
    ).toEqual([]);
  });

  it('does not expose a caller-supplied identity or liveness probe on the production entry', () => {
    const source = readFileSync(new URL('./reboot-recovery.ts', import.meta.url), 'utf8');
    for (const name of [
      'InspectSameHostRebootRecoveryOptions',
      'InstallSameHostRebootRecoveryOptions',
      'AcquireSameHostRebootRecoveryOptions',
    ]) {
      const start = source.indexOf(`export interface ${name}`);
      const end = source.indexOf('\n}', start);
      const declaration = source.slice(start, end);
      expect(declaration).not.toMatch(/readonly identity\??:/u);
      expect(declaration).not.toMatch(/readonly identityProbe\??:/u);
      expect(declaration).not.toMatch(/readonly readCurrentIdentity\??:/u);
      expect(declaration).not.toMatch(/readonly probeAttemptOwner\??:/u);
    }
    expect(source).toContain('return createIdentityProbe().current()');
  });
});

describe('same-host reboot operation continuation', () => {
  it.each(['prepared', 'prepared-bound'] as const)(
    'uses the existing %s prestart authority and archives the containment fact',
    async (state) => {
      const setup = await operationContainmentWorkspace(state);
      const plan = await inspectSameHostRebootRecovery({
        workspacePath: setup.workspace,
        helperBytes: HELPER_BYTES,
      });
      expect(plan.mode).toBe('prestart');

      await installInExitedWorker('prestart', setup.workspace);
      const replacement = await acquireSameHostRebootRecovery({
        workspacePath: setup.workspace,
        helperBytes: HELPER_BYTES,
        attemptId: ATTEMPT_B,
      });
      const completion = await finalizeSameHostRebootRecovery(replacement, {
        now: () => new Date('2026-07-30T04:32:00.000Z'),
      });

      expect(Object.keys(replacement)).toEqual([]);
      expect(existsSync(leasePath(setup.workspace))).toBe(false);
      const settledRoot = join(completion.archivePath, 'settled-operations');
      const settled = join(settledRoot, readdirSync(settledRoot)[0]);
      expect(parseQuarantineRecord(readFileSync(join(settled, QUARANTINE_FILE))).reason).toBe(
        'containment-unconfirmed',
      );
      expect(
        readdirSync(join(completion.archivePath, RECOVERY_DIR, 'attempts')).some((name) =>
          name.startsWith('abandoned-'),
        ),
      ).toBe(true);
    },
  );

  it('requires a complete cached-digest receipt before an armed reboot claim can exist', async () => {
    const setup = await operationContainmentWorkspace('armed');
    rmSync(join(operationPath(setup.workspace), 'drained-receipt.json'));
    const before = treeBytes(setup.workspace);
    await expect(
      installSameHostRebootRecovery({
        workspacePath: setup.workspace,
      }),
    ).rejects.toMatchObject({
      code: 'isolated',
      message: expect.stringMatching(/operation-proof-missing/u),
    });
    expect(treeBytes(setup.workspace)).toEqual(before);
    expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
  });

  it('runs the normal delegated delta evaluator and returns only an unsigned candidate', async () => {
    const setup = await operationContainmentWorkspace('armed', 'legal');
    await installInExitedWorker('delegated-finalize', setup.workspace);
    const replacement = await acquireSameHostRebootRecovery({
      workspacePath: setup.workspace,
      attemptId: ATTEMPT_B,
    });
    const completion = await finalizeSameHostRebootRecovery(replacement, {
      now: () => new Date('2026-07-30T04:41:00.000Z'),
    });

    expect(Object.keys(replacement)).toEqual([]);
    expect('candidateDigest' in completion && completion.candidateDigest).toMatch(/^sha256:/u);
    expect(existsSync(leasePath(setup.workspace))).toBe(false);
    const settledRoot = join(completion.archivePath, 'settled-operations');
    const settled = join(settledRoot, readdirSync(settledRoot)[0]);
    expect(parseQuarantineRecord(readFileSync(join(settled, QUARANTINE_FILE))).reason).toBe(
      'containment-unconfirmed',
    );
    expect(
      readdirSync(join(completion.archivePath, RECOVERY_DIR, 'attempts')).some((name) =>
        name.startsWith('abandoned-'),
      ),
    ).toBe(true);
  });

  it('upgrades containment to integrity on a forbidden delegated delta and remains isolated', async () => {
    const setup = await operationContainmentWorkspace('armed');
    const original = readFileSync(join(operationPath(setup.workspace), QUARANTINE_FILE));
    const handle = await installSameHostRebootRecovery({
      workspacePath: setup.workspace,
      recoveryId: randomUUID(),
      attemptId: randomUUID(),
      now: () => new Date('2026-07-30T04:50:00.000Z'),
    });
    writeFileSync(join(setup.workspace, 'forbidden.txt'), 'outside delegated scope');

    await expect(
      finalizeSameHostRebootRecovery(handle, {
        now: () => new Date('2026-07-30T04:51:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    const terminal = parseQuarantineRecord(
      readFileSync(join(operationPath(setup.workspace), QUARANTINE_FILE)),
    );
    expect(terminal).toMatchObject({
      reason: 'workspace-integrity-violation',
      priorQuarantineDigest: digestBytes(original),
      creator: { kind: 'recovery-attempt' },
    });
    expect(existsSync(leasePath(setup.workspace))).toBe(true);
  });

  it.each(['prepared', 'armed'] as const)(
    'rejects stale-boot and foreign-host continuation for %s with zero recovery writes',
    async (state) => {
      const current = createIdentityProbe().current();
      for (const source of [
        { ...sourceIdentity(current), bootIdentity: current.bootIdentity },
        { ...sourceIdentity(current), hostId: `sha256:${'e'.repeat(64)}` },
      ]) {
        const setup = await operationContainmentWorkspace(state, 'none', source);
        const before = treeBytes(setup.workspace);
        await expect(
          installSameHostRebootRecovery({
            workspacePath: setup.workspace,
            ...(state === 'prepared' ? { helperBytes: HELPER_BYTES } : {}),
          }),
        ).rejects.toMatchObject({ code: 'isolated' });
        expect(treeBytes(setup.workspace)).toEqual(before);
        expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
      }
    },
  );

  it.each(['prepared', 'armed'] as const)(
    'rejects a wrongly bound canonical quarantine for %s before claim staging',
    async (state) => {
      const setup = await operationContainmentWorkspace(state);
      const path = join(operationPath(setup.workspace), QUARANTINE_FILE);
      const broken = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
      broken.activeChildDigest = `sha256:${'f'.repeat(64)}`;
      writeFileSync(path, jsonBytes(broken));
      const before = treeBytes(setup.workspace);
      await expect(
        installSameHostRebootRecovery({
          workspacePath: setup.workspace,
          ...(state === 'prepared' ? { helperBytes: HELPER_BYTES } : {}),
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/invalid|isolated/u) });
      expect(treeBytes(setup.workspace)).toEqual(before);
      expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
    },
  );
});
