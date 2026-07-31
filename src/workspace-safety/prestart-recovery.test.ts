import { fork, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  HELPER_BYTES,
  OPERATION_ID,
  defaultOptions,
  operationPath,
  setupOperationTest,
  supervisor,
  type OperationTestSetup,
} from './__fixtures__/operation-test-support.js';
import {
  createCrossProcessFixtureTracker,
  typeScriptFixtureExecArgv,
} from './cross-process-fixture.test-support.js';
import { jsonBytes } from './filesystem.js';
import { createIdentityProbe } from './identity.js';
import { SETTLED_OPERATIONS_DIR } from './operation.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from './operation-authority-test-seam.js';
import {
  acquirePrestartRecoveryWithAuthority as acquirePrestartRecovery,
  finalizePrestartRecoveryWithAuthority as finalizePrestartRecovery,
  inspectPrestartRecoveryEligibilityWithAuthority as inspectPrestartRecoveryEligibility,
  installPrestartRecoveryWithAuthority as installPrestartRecovery,
  type PrestartRecoveryWithAuthorityOptions as PrestartRecoveryProbeOptions,
} from './recovery-authority-test-seam.js';
import { readDarkPosixHelperBundle } from './posix-supervisor.js';
import { readDarkWindowsHelperBundle } from './windows-supervisor.js';
import { readRecoveryDomain } from './recovery-domain.js';
import { QUARANTINE_FILE } from './quarantine.js';
import { ACTIVE_LEASE_DIR, PROTOCOL_ROOT_DIR, RECOVERY_DIR } from './types.js';

const roots: string[] = [];
const fixtureProcesses = createCrossProcessFixtureTracker();
const RECOVERY_ID = '00000000-0000-4000-8000-0000000000f1';
const ATTEMPT_A = '00000000-0000-4000-8000-0000000000f2';
const ATTEMPT_B = '00000000-0000-4000-8000-0000000000f3';
const ATTEMPT_C = '00000000-0000-4000-8000-0000000000f5';

interface OwnerCrashMessage {
  readonly type: 'ready';
  readonly mode: 'prepared' | 'prepared-bound';
  readonly supervisorPid: number;
}

afterEach(async () => {
  try {
    await fixtureProcesses.settle();
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function recoveryPath(workspace: string): string {
  return join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, RECOVERY_DIR);
}

function waitForOwnerReady(child: ChildProcess): Promise<OwnerCrashMessage> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('owner crash worker timed out')), 10_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    }
    function finish(error?: Error, message?: OwnerCrashMessage): void {
      cleanup();
      if (error) reject(error);
      else resolve(message!);
    }
    function onError(error: Error): void {
      finish(error);
    }
    function onExit(code: number | null): void {
      finish(new Error(`owner crash worker exited before ready: ${String(code)}`));
    }
    function onMessage(value: unknown): void {
      if (
        typeof value === 'object' &&
        value !== null &&
        (value as { type?: unknown }).type === 'ready'
      ) {
        finish(undefined, value as OwnerCrashMessage);
      }
    }
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

async function hardKill(child: ChildProcess): Promise<void> {
  const closed = new Promise<void>((resolve, reject) => {
    child.once('error', reject);
    child.once('close', () => resolve());
  });
  child.kill('SIGKILL');
  await closed;
}

function waitForFinalizeBarrier(child: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('finalize worker timed out')), 10_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.off('error', onError);
      child.off('exit', onExit);
      child.off('message', onMessage);
    }
    function finish(error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function onError(error: Error): void {
      finish(error);
    }
    function onExit(code: number | null): void {
      finish(new Error(`finalize worker exited before barrier: ${String(code)}`));
    }
    function onMessage(value: unknown): void {
      if (value === 'ready') finish();
    }
    child.once('error', onError);
    child.once('exit', onExit);
    child.on('message', onMessage);
  });
}

async function waitForProcessMissing(pid: number): Promise<void> {
  const deadline = Date.now() + 10_000;
  while (true) {
    try {
      process.kill(pid, 0);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ESRCH') return;
      throw error;
    }
    if (Date.now() >= deadline) throw new Error(`supervisor ${pid} did not exit after owner death`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const preparedProbes: PrestartRecoveryProbeOptions = {
  helperBytes: HELPER_BYTES,
  probeSourceOwner: () => 'dead',
};

async function crashedPrepared(): Promise<OperationTestSetup> {
  const setup = await setupOperationTest(roots);
  let prepared!: () => void;
  const ready = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  void runWorkspaceOperation(setup.session, defaultOptions(), async () => {
    prepared();
    return await new Promise<never>(() => undefined);
  });
  await ready;
  return setup;
}

async function crashedPreparedBound(): Promise<{
  setup: OperationTestSetup;
}> {
  const setup = await setupOperationTest(roots);
  let prepared!: () => void;
  const ready = new Promise<void>((resolve) => {
    prepared = resolve;
  });
  void runWorkspaceOperation(setup.session, defaultOptions(), async (operation) => {
    await operation.bindSupervisorControlled(supervisor);
    prepared();
    return await new Promise<never>(() => undefined);
  });
  await ready;
  return { setup };
}

function boundProbes(): PrestartRecoveryProbeOptions {
  return {
    helperBytes: HELPER_BYTES,
    probeSourceOwner: () => 'dead',
    probeSupervisor: () => 'dead',
  };
}

async function install(
  setup: OperationTestSetup,
  probes: PrestartRecoveryProbeOptions,
  attemptId = ATTEMPT_A,
  identity = createIdentityProbe().current(),
) {
  return await installPrestartRecovery({
    workspacePath: setup.workspace,
    identity,
    recoveryId: RECOVERY_ID,
    attemptId,
    now: () => new Date('2026-07-30T03:00:00.000Z'),
    ...probes,
  });
}

describe('prestart mechanical recovery eligibility', () => {
  it('installs a mechanical-empty claim with immutable prepared operation identity', async () => {
    const setup = await crashedPrepared();
    const inspected = await inspectPrestartRecoveryEligibility(setup.workspace, preparedProbes);
    expect(inspected.binding).toMatchObject({
      activeState: 'prepared',
      operationId: OPERATION_ID,
      prestartDrainedDigest: null,
      existingAbortDigest: null,
    });

    await install(setup, preparedProbes);
    await expect(readRecoveryDomain(setup.workspace)).resolves.toMatchObject({
      claim: {
        mode: 'mechanical-empty',
        delegatedOperation: null,
        prestartOperation: inspected.binding,
      },
    });
  });

  it('requires exact supervisor death and the fixed helper for prepared-bound recovery', async () => {
    const { setup } = await crashedPreparedBound();
    await expect(
      inspectPrestartRecoveryEligibility(setup.workspace, {
        ...boundProbes(),
        probeSupervisor: () => 'unknown',
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    await expect(
      inspectPrestartRecoveryEligibility(setup.workspace, {
        ...boundProbes(),
        helperBytes: Buffer.from('wrong-helper'),
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
  });

  it('rejects armed operations instead of downgrading them to mechanical-empty', async () => {
    const { setup } = await crashedPreparedBound();
    const activePath = join(operationPath(setup.workspace), 'active-child.json');
    const active = JSON.parse(readFileSync(activePath, 'utf8')) as Record<string, unknown>;
    active.state = 'armed';
    active.containment = {
      platform: 'posix-process-group-v1',
      pgid: 510,
      launcherPid: 510,
      launcherIdentity: '510001',
    };
    active.containmentDigest = `sha256:${'1'.repeat(64)}`;
    writeFileSync(activePath, jsonBytes(active));
    await expect(
      installPrestartRecovery({
        workspacePath: setup.workspace,
        identity: createIdentityProbe().current(),
        ...boundProbes(),
      }),
    ).rejects.toMatchObject({ code: expect.stringMatching(/invalid|isolated/u) });
    expect(existsSync(recoveryPath(setup.workspace))).toBe(false);
  });
});

describe('prestart mechanical recovery finalization', () => {
  it.each([
    ['prepared', crashedPrepared, () => preparedProbes],
    ['prepared-bound', crashedPreparedBound, () => boundProbes()],
  ] as const)(
    'settles and archives a %s operation without an outcome',
    async (_label, make, probesFor) => {
      const value = await make();
      const setup = 'setup' in value ? value.setup : value;
      const probes = probesFor();
      const attemptIdentity = { ...createIdentityProbe().current(), pid: 2_000_000_005 };
      const completion = await finalizePrestartRecovery(
        await install(setup, probes, ATTEMPT_A, attemptIdentity),
        {
          ...probes,
          attemptIdentity,
          now: () => new Date('2026-07-30T03:01:00.000Z'),
        },
      );

      expect(existsSync(join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
      expect(existsSync(completion.archivePath)).toBe(true);
      const settledRoot = join(completion.archivePath, SETTLED_OPERATIONS_DIR);
      expect(readdirSync(settledRoot)).toHaveLength(1);
      const settled = join(settledRoot, readdirSync(settledRoot)[0]);
      expect(readdirSync(settled).sort()).toEqual([
        'active-child.json',
        'delegated-baseline.json',
        'prestart-abort.json',
      ]);
      expect(readdirSync(completion.archivePath)).not.toContain('outcome.json');
    },
  );

  it('allows only one recovery attempt and supports exact recovery-of-recovery', async () => {
    const setup = await crashedPrepared();
    await install(setup, preparedProbes);
    const replacement = await acquirePrestartRecovery({
      workspacePath: setup.workspace,
      identity: createIdentityProbe().current(),
      attemptId: ATTEMPT_B,
      probeAttemptOwner: () => 'dead',
      ...preparedProbes,
    });
    await expect(replacement.verify()).resolves.toMatchObject({
      attemptOwner: { attemptId: ATTEMPT_B },
    });
    expect(
      readdirSync(join(recoveryPath(setup.workspace), 'attempts')).some((name) =>
        name.startsWith('abandoned-'),
      ),
    ).toBe(true);
  });

  it('closes an exact abort hardlink window after the first finalizer dies', async () => {
    const setup = await crashedPrepared();
    const first = await install(setup, preparedProbes);
    await expect(
      finalizePrestartRecovery(first, {
        ...preparedProbes,
        hooks: {
          beforeAbortInstallSourceUnlink: () => {
            throw new Error('simulated SIGKILL after abort link');
          },
        },
      }),
    ).rejects.toThrow(/SIGKILL/u);
    const operation = operationPath(setup.workspace);
    const sourceName = readdirSync(operation).find((name) =>
      name.startsWith('prestart-abort.prepare-'),
    );
    expect(sourceName).toBeDefined();
    expect(statSync(join(operation, sourceName!)).nlink).toBe(2);
    expect(statSync(join(operation, 'prestart-abort.json')).nlink).toBe(2);

    const replacement = await acquirePrestartRecovery({
      workspacePath: setup.workspace,
      identity: createIdentityProbe().current(),
      attemptId: ATTEMPT_B,
      probeAttemptOwner: () => 'dead',
      ...preparedProbes,
    });
    const completion = await finalizePrestartRecovery(replacement, preparedProbes);
    const settledRoot = join(completion.archivePath, SETTLED_OPERATIONS_DIR);
    const settled = join(settledRoot, readdirSync(settledRoot)[0]);
    expect(statSync(join(settled, 'prestart-abort.json')).nlink).toBe(1);
  });

  it('closes an exact final-manifest hardlink window after recovery-of-recovery', async () => {
    const setup = await crashedPrepared();
    const first = await install(setup, preparedProbes);
    await expect(
      finalizePrestartRecovery(first, {
        ...preparedProbes,
        hooks: {
          beforeFinalManifestSourceUnlink: () => {
            throw new Error('simulated SIGKILL after final-manifest link');
          },
        },
      }),
    ).rejects.toThrow(/SIGKILL/u);
    const lease = join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
    const staging = readdirSync(lease).find(
      (name) =>
        name.startsWith('recovery.prepare-') &&
        existsSync(join(lease, name, 'final-manifest.json')),
    );
    expect(staging).toBeDefined();
    const source = join(lease, staging!, 'final-manifest.json');
    const target = join(lease, RECOVERY_DIR, 'final-manifest.json');
    expect(statSync(source).nlink).toBe(2);
    expect(statSync(target).nlink).toBe(2);

    const replacement = await acquirePrestartRecovery({
      workspacePath: setup.workspace,
      identity: createIdentityProbe().current(),
      attemptId: ATTEMPT_B,
      probeAttemptOwner: () => 'dead',
      ...preparedProbes,
    });
    const completion = await finalizePrestartRecovery(replacement, preparedProbes);
    expect(statSync(join(completion.archivePath, RECOVERY_DIR, 'final-manifest.json')).nlink).toBe(
      1,
    );
  });

  it.each(['abort-link', 'manifest-link'] as const)(
    'closes the exact %s window after the real finalizer receives SIGKILL',
    async (barrier) => {
      const setup = await crashedPrepared();
      await install(setup, preparedProbes);
      const fixture = fileURLToPath(
        new URL('./__fixtures__/prestart-recovery-finalize-worker.ts', import.meta.url),
      );
      const child = fixtureProcesses.track(
        fork(fixture, [setup.workspace, ATTEMPT_B, barrier], {
          execArgv: typeScriptFixtureExecArgv(),
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        }),
      );
      try {
        await waitForFinalizeBarrier(child);

        if (barrier === 'abort-link') {
          const operation = operationPath(setup.workspace);
          const sourceName = readdirSync(operation).find((name) =>
            name.startsWith('prestart-abort.prepare-'),
          );
          expect(sourceName).toBeDefined();
          expect(statSync(join(operation, sourceName!)).nlink).toBe(2);
          expect(statSync(join(operation, 'prestart-abort.json')).nlink).toBe(2);
        } else {
          const lease = join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
          const staging = readdirSync(lease).find(
            (name) =>
              name.startsWith('recovery.prepare-') &&
              existsSync(join(lease, name, 'final-manifest.json')),
          );
          expect(staging).toBeDefined();
          expect(statSync(join(lease, staging!, 'final-manifest.json')).nlink).toBe(2);
          expect(statSync(join(lease, RECOVERY_DIR, 'final-manifest.json')).nlink).toBe(2);
        }

        await hardKill(child);
        const replacement = await acquirePrestartRecovery({
          workspacePath: setup.workspace,
          identity: createIdentityProbe().current(),
          attemptId: ATTEMPT_C,
          probeAttemptOwner: () => 'dead',
          ...preparedProbes,
        });
        const completion = await finalizePrestartRecovery(replacement, preparedProbes);

        if (barrier === 'abort-link') {
          const settledRoot = join(completion.archivePath, SETTLED_OPERATIONS_DIR);
          const settled = join(settledRoot, readdirSync(settledRoot)[0]);
          expect(statSync(join(settled, 'prestart-abort.json')).nlink).toBe(1);
        } else {
          expect(
            statSync(join(completion.archivePath, RECOVERY_DIR, 'final-manifest.json')).nlink,
          ).toBe(1);
        }
      } finally {
        if (child.exitCode === null && child.signalCode === null) await hardKill(child);
      }
    },
    30_000,
  );

  it('allows only one of two concurrent initial claims to become canonical', async () => {
    const setup = await crashedPrepared();
    const current = createIdentityProbe().current();
    const results = await Promise.allSettled([
      installPrestartRecovery({
        workspacePath: setup.workspace,
        identity: current,
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        ...preparedProbes,
      }),
      installPrestartRecovery({
        workspacePath: setup.workspace,
        identity: current,
        recoveryId: '00000000-0000-4000-8000-0000000000f4',
        attemptId: ATTEMPT_B,
        ...preparedProbes,
      }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.filter((result) => result.status === 'rejected')).toHaveLength(1);
    expect(existsSync(recoveryPath(setup.workspace))).toBe(true);
  });

  it('quarantines a changed baseline and never archives the lease', async () => {
    const setup = await crashedPrepared();
    const handle = await install(setup, preparedProbes);
    writeFileSync(join(setup.workspace, 'forbidden.txt'), 'outside delegated contract');
    await expect(
      finalizePrestartRecovery(handle, {
        ...preparedProbes,
        now: () => new Date('2026-07-30T03:01:00.000Z'),
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(join(operationPath(setup.workspace), QUARANTINE_FILE))).toBe(true);
    expect(existsSync(join(setup.workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
  });
});

describe('real owner hard-crash recovery', () => {
  it.each(['prepared', 'prepared-bound'] as const)(
    'recovers a %s operation after the real owner receives SIGKILL',
    async (mode) => {
      const workspace = mkdtempSync(join(tmpdir(), `coding-x-prestart-${mode}-`));
      roots.push(workspace);
      const markerPath = join(workspace, 'project-code-started.txt');
      const fixture = fileURLToPath(
        new URL('./__fixtures__/prestart-recovery-owner-worker.ts', import.meta.url),
      );
      const child = fixtureProcesses.track(
        fork(fixture, [workspace, mode, markerPath], {
          execArgv: typeScriptFixtureExecArgv(),
          stdio: ['ignore', 'ignore', 'ignore', 'ipc'],
        }),
      );
      const message = await waitForOwnerReady(child);
      expect(existsSync(markerPath)).toBe(false);
      await hardKill(child);
      await waitForProcessMissing(message.supervisorPid);
      const helperBytes =
        process.platform === 'win32' ? readDarkWindowsHelperBundle() : readDarkPosixHelperBundle();

      const probes: PrestartRecoveryProbeOptions =
        mode === 'prepared'
          ? {
              helperBytes,
            }
          : {
              helperBytes,
            };
      const handle = await installPrestartRecovery({
        workspacePath: workspace,
        identity: createIdentityProbe().current(),
        recoveryId: RECOVERY_ID,
        attemptId: ATTEMPT_A,
        ...probes,
      });
      const completion = await finalizePrestartRecovery(handle, probes);
      expect(existsSync(completion.archivePath)).toBe(true);
      expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
      expect(existsSync(markerPath)).toBe(false);
    },
    60_000,
  );
});
