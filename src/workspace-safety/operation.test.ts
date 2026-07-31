import { fork, type ChildProcess } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { parseDelegatedBaselineBytes } from './baseline.js';
import {
  createCrossProcessFixtureTracker,
  typeScriptFixtureExecArgv,
} from './cross-process-fixture.test-support.js';
import { digestBytes, jsonBytes } from './filesystem.js';
import {
  ACTIVE_CHILD_FILE,
  DELEGATED_BASELINE_FILE,
  DRAINED_RECEIPT_FILE,
  PRESTART_ABORT_FILE,
  SETTLED_OPERATIONS_DIR,
  parseActiveChildRecord,
} from './operation.js';
import { runWorkspaceOperationWithAuthority as runWorkspaceOperation } from './operation-authority-test-seam.js';
import {
  SupervisorProtocol,
  encodeSupervisorAcknowledgement,
  encodeSupervisorAbortBeforeStart,
  encodeSupervisorStart,
  parseDrainedReceipt,
} from './supervisor-protocol.js';
import {
  ACTIVE_LEASE_DIR,
  INCIDENTS_DIR,
  OPERATION_DIR,
  OWNER_FILE,
  PROTOCOL_FILE,
  PROTOCOL_ROOT_DIR,
} from './types.js';
import {
  HELPER_BYTES,
  OPERATION_ID,
  OWNER_ID,
  STORY_ID,
  containment,
  defaultOptions,
  driveToArmed,
  operationPath,
  readOnlyOptions,
  setupOperationTest,
  supervisor,
  validatorOptions,
} from './__fixtures__/operation-test-support.js';

const roots: string[] = [];
const fixtureProcesses = createCrossProcessFixtureTracker();
const ACCEPTANCE_HASH = `sha256:${'c'.repeat(64)}`;
const GIT_HEAD = 'd'.repeat(40);
const setup = async () => await setupOperationTest(roots);

afterEach(async () => {
  try {
    await fixtureProcesses.settle();
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

function waitForWorkerMessage(child: ChildProcess, expected: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => finish(new Error(`worker timed out before ${expected}`)),
      30_000,
    );
    function cleanup(): void {
      clearTimeout(timer);
      child.off('message', onMessage);
      child.off('error', finish);
      child.off('exit', onExit);
    }
    function finish(error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function onMessage(message: unknown): void {
      if (message === expected) finish();
    }
    function onExit(code: number | null): void {
      finish(new Error(`worker exited before ${expected}: ${String(code)}`));
    }
    child.on('message', onMessage);
    child.once('error', finish);
    child.once('exit', onExit);
  });
}

function waitForWorkerExit(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => finish(new Error('worker timed out while exiting')), 30_000);
    function cleanup(): void {
      clearTimeout(timer);
      child.off('error', finish);
      child.off('exit', onExit);
    }
    function finish(error?: Error): void {
      cleanup();
      if (error) reject(error);
      else resolve();
    }
    function onExit(code: number | null): void {
      if (code === 0) finish();
      else finish(new Error(`worker failed: ${String(code)}`));
    }
    child.once('error', finish);
    child.once('exit', onExit);
  });
}

describe('workspace operation protocol', () => {
  it('installs prepared as one directory, freezes armed, validates a receipt, and settles atomically', async () => {
    const { workspace, session } = await setup();
    let queuedWrite: Promise<void> | undefined;
    let queuedFinished = false;

    const result = await runWorkspaceOperation(session, defaultOptions(), async (operation) => {
      const root = operationPath(workspace);
      expect(parseActiveChildRecord(readFileSync(join(root, ACTIVE_CHILD_FILE))).state).toBe(
        'prepared',
      );
      expect(existsSync(join(root, DELEGATED_BASELINE_FILE))).toBe(true);

      queuedWrite = session.writer.writeFile('after-operation.txt', 'done').then(() => {
        queuedFinished = true;
      });
      await Promise.resolve();
      expect(queuedFinished).toBe(false);

      const { machine, armed } = await driveToArmed(operation);
      const frozen = readFileSync(join(root, ACTIVE_CHILD_FILE));
      machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
      expect(readFileSync(join(root, ACTIVE_CHILD_FILE))).toEqual(frozen);

      const drained = machine.drain(
        'posix-group-empty-and-pipes-eof-v1',
        'natural',
        new Date('2026-07-30T00:00:03.000Z'),
      );
      await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
      machine.acknowledge(encodeSupervisorAcknowledgement(OPERATION_ID, drained.receiptDigest));
      const settled = await operation.settleArmedControlled({
        supervisor: 'dead',
        containment: 'empty',
      });
      return settled;
    });

    expect(existsSync(operationPath(workspace))).toBe(false);
    expect(result.settledPath).toContain(`${OPERATION_ID}-`);
    expect(result.candidate).toMatchObject({ version: 'builder-state-v1' });
    await queuedWrite;
    expect(queuedFinished).toBe(true);
    expect(readFileSync(join(workspace, 'after-operation.txt'), 'utf8')).toBe('done');
    await session.close();
  });

  it('captures the delegated baseline inside the exclusive operation boundary', async () => {
    const { workspace, session } = await setup();
    const queuedWrite = session.writer.writeFile('progress.md', 'parent-before-operation\n');

    const settled = await runWorkspaceOperation(session, defaultOptions(), async (operation) => {
      await queuedWrite;
      const baseline = JSON.parse(
        readFileSync(join(operationPath(workspace), DELEGATED_BASELINE_FILE), 'utf8'),
      ) as {
        workspaceIdentity: string;
        entries: Array<{ path: string; digest: string }>;
      };
      expect(baseline.workspaceIdentity).toBe(session.lease.workspace.identity);
      expect(baseline.entries.find((entry) => entry.path === 'progress.md')?.digest).toBe(
        digestBytes(Buffer.from('parent-before-operation\n')),
      );
      return operation.abortPrestartControlled({
        reason: 'setup-failed',
        proof: 'supervisor-never-bound-v1',
        supervisor: 'never-created',
        containment: 'not-created',
      });
    });

    expect(existsSync(settled.settledPath)).toBe(true);
    expect(settled).not.toHaveProperty('candidate');
    await session.close();
  });

  it('returns the Builder candidate from the final stable scan after the settle hook', async () => {
    const { workspace, session } = await setup();
    const settled = await runWorkspaceOperation(
      session,
      defaultOptions({
        beforeSettle: () => {
          const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8')) as Record<
            string,
            Record<string, unknown>
          >;
          state[STORY_ID].notes = 'from-final-scan';
          writeFileSync(join(workspace, 'state.json'), JSON.stringify(state));
        },
      }),
      async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
        const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8')) as Record<
          string,
          Record<string, unknown>
        >;
        state[STORY_ID].passes = true;
        state[STORY_ID].notes = 'from-first-scan';
        writeFileSync(join(workspace, 'state.json'), JSON.stringify(state));
        const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
      },
    );

    expect(settled.candidate).toMatchObject({
      version: 'builder-state-v1',
      state: { [STORY_ID]: { passes: true, notes: 'from-final-scan' } },
    });
    await session.close();
  });

  it('does not manufacture a candidate for an armed read-only operation', async () => {
    const { session } = await setup();
    const settled = await runWorkspaceOperation(session, readOnlyOptions(), async (operation) => {
      const { machine, armed } = await driveToArmed(operation);
      machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
      const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
      await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
      return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
    });

    expect(settled).not.toHaveProperty('candidate');
    await session.close();
  });

  it('rejects a workspace change between baseline capture and canonical install', async () => {
    const { workspace, session } = await setup();
    let actionCalled = false;

    await expect(
      runWorkspaceOperation(
        session,
        defaultOptions({
          beforeOperationInstall: () => {
            writeFileSync(join(workspace, 'late-parent-state.json'), '{}');
          },
        }),
        async () => {
          actionCalled = true;
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(actionCalled).toBe(false);
    expect(existsSync(operationPath(workspace))).toBe(false);
    await session.close();
  });

  it.each(['before-arm', 'before-start'] as const)(
    'rejects business state changed %s authorization',
    async (phase) => {
      const { workspace, session } = await setup();

      await expect(
        runWorkspaceOperation(session, defaultOptions(), async (operation) => {
          await operation.bindSupervisorControlled(supervisor);
          await operation.readPreparedBoundBindingControlled(HELPER_BYTES);
          if (phase === 'before-arm') {
            writeFileSync(join(workspace, 'progress.md'), 'too early\n');
            await operation.armContainmentControlled(containment);
            return;
          }
          await operation.armContainmentControlled(containment);
          writeFileSync(join(workspace, 'progress.md'), 'too early\n');
          await operation.readArmedBindingControlled(HELPER_BYTES);
        }),
      ).rejects.toMatchObject({ code: 'isolated' });
      expect(existsSync(operationPath(workspace))).toBe(true);
    },
  );

  it('ignores a real contender lease staging directory while preserving the active operation', async () => {
    const { workspace, session } = await setup();
    const controlRoot = mkdtempSync(join(tmpdir(), 'coding-x-lease-contender-'));
    roots.push(controlRoot);
    const barrier = join(controlRoot, 'continue');
    const workerPath = fileURLToPath(
      new URL('./__fixtures__/lease-contender-worker.ts', import.meta.url),
    );
    let worker: ChildProcess | undefined;

    const settled = await runWorkspaceOperation(session, defaultOptions(), async (operation) => {
      worker = fixtureProcesses.track(
        fork(workerPath, [workspace, barrier], {
          execArgv: typeScriptFixtureExecArgv(),
          stdio: ['ignore', 'ignore', 'inherit', 'ipc'],
        }),
      );
      await waitForWorkerMessage(worker, 'staged');
      expect(
        readdirSync(join(workspace, PROTOCOL_ROOT_DIR)).filter((entry) =>
          entry.startsWith('lease.prepare-'),
        ),
      ).toHaveLength(1);
      return operation.abortPrestartControlled({
        reason: 'setup-failed',
        proof: 'supervisor-never-bound-v1',
        supervisor: 'never-created',
        containment: 'not-created',
      });
    });

    expect(existsSync(settled.settledPath)).toBe(true);
    expect(settled).not.toHaveProperty('candidate');
    writeFileSync(barrier, 'continue');
    await waitForWorkerMessage(worker!, 'rejected');
    await waitForWorkerExit(worker!);
    await session.close();
  }, 60_000);

  it('rejects a validly named lease staging entry when it is not an ordinary directory', async () => {
    const { workspace, session } = await setup();
    const forged = join(
      workspace,
      PROTOCOL_ROOT_DIR,
      'lease.prepare-00000000-0000-4000-8000-000000000099',
    );

    await expect(
      runWorkspaceOperation(session, defaultOptions(), async (operation) => {
        writeFileSync(forged, '{}');
        return operation.abortPrestartControlled({
          reason: 'setup-failed',
          proof: 'supervisor-never-bound-v1',
          supervisor: 'never-created',
          containment: 'not-created',
        });
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(operationPath(workspace))).toBe(true);
  });

  it('rejects a Builder story identity that cannot fit the JSON pointer contract', async () => {
    const { workspace, session } = await setup();
    let actionCalled = false;

    await expect(
      runWorkspaceOperation(
        session,
        { ...defaultOptions(), storyId: 's'.repeat(512) },
        async () => {
          actionCalled = true;
        },
      ),
    ).rejects.toThrow(/storyId.*pointer byte limit/i);
    expect(actionCalled).toBe(false);
    expect(existsSync(operationPath(workspace))).toBe(false);
    await session.close();
  });

  it('binds Validator scope to the exact request and its fixed output paths', async () => {
    const matching = await setup();
    const settled = await runWorkspaceOperation(
      matching.session,
      validatorOptions(),
      async (operation) => {
        const baseline = parseDelegatedBaselineBytes(
          readFileSync(join(operationPath(matching.workspace), DELEGATED_BASELINE_FILE)),
        );
        expect(baseline.contract.semantic).toEqual({
          version: 'validator-result-v1',
          requestId: OPERATION_ID,
          storyId: STORY_ID,
          acceptanceHash: ACCEPTANCE_HASH,
          checkCount: 1,
          gitHead: GIT_HEAD,
        });
        const { machine, armed } = await driveToArmed(operation);
        expect(armed.delegationContractDigest).toBe(baseline.contractDigest);
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
        writeFileSync(
          join(matching.workspace, 'validation-result.json'),
          JSON.stringify({
            version: 1,
            requestId: OPERATION_ID,
            storyId: STORY_ID,
            acceptanceHash: ACCEPTANCE_HASH,
            gitHead: GIT_HEAD,
            verdict: 'passed',
            checks: [{ acIndex: 1, passed: true, evidence: 'verified' }],
            summary: 'verified',
          }),
        );
        const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        expect(parseDrainedReceipt(drained.receiptBytes).delegationContractDigest).toBe(
          baseline.contractDigest,
        );
        return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
      },
    );
    expect(existsSync(settled.settledPath)).toBe(true);
    expect(settled.candidate).toMatchObject({
      version: 'validator-result-v1',
      result: { verdict: 'passed' },
    });
    await matching.session.close();

    const mismatched = await setup();
    let actionCalled = false;
    await expect(
      runWorkspaceOperation(
        mismatched.session,
        {
          ...validatorOptions(),
          requestId: '00000000-0000-4000-8000-000000000099',
        },
        async () => {
          actionCalled = true;
        },
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(actionCalled).toBe(false);
    expect(existsSync(operationPath(mismatched.workspace))).toBe(false);
    await mismatched.session.close();
  });

  it.each([
    ['missing', undefined],
    ['failed', 'failed'],
  ] as const)(
    'settles a Validator %s result state without manufacturing success',
    async (_label, verdict) => {
      const { workspace, session } = await setup();
      const settled = await runWorkspaceOperation(
        session,
        validatorOptions(),
        async (operation) => {
          const { machine, armed } = await driveToArmed(operation);
          machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
          if (verdict === 'failed') {
            writeFileSync(
              join(workspace, 'validation-result.json'),
              JSON.stringify({
                version: 1,
                requestId: OPERATION_ID,
                storyId: STORY_ID,
                acceptanceHash: ACCEPTANCE_HASH,
                gitHead: GIT_HEAD,
                verdict,
                checks: [{ acIndex: 1, passed: false, evidence: 'not verified' }],
                summary: 'not verified',
              }),
            );
          }
          const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
          await operation.installDrainedReceiptControlled(
            drained.receiptBytes,
            drained.messageBytes,
          );
          return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
        },
      );

      expect(existsSync(settled.settledPath)).toBe(true);
      if (verdict === 'failed') {
        expect(settled.candidate).toMatchObject({
          version: 'validator-result-v1',
          result: { verdict: 'failed' },
        });
      } else {
        expect(settled).not.toHaveProperty('candidate');
      }
      expect(existsSync(join(workspace, 'validation-result.json'))).toBe(verdict === 'failed');
      await session.close();
    },
  );

  it('keeps a present-invalid Validator result isolated instead of settling it', async () => {
    const { workspace, session } = await setup();

    await expect(
      runWorkspaceOperation(session, validatorOptions(), async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
        writeFileSync(join(workspace, 'validation-result.json'), '{broken');
        const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
      }),
    ).rejects.toMatchObject({ code: 'isolated' });

    expect(existsSync(operationPath(workspace))).toBe(true);
  });

  it('does not let Builder modify engine-owned fields of the current story', async () => {
    const { workspace, session } = await setup();

    await expect(
      runWorkspaceOperation(session, defaultOptions(), async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
        const state = JSON.parse(readFileSync(join(workspace, 'state.json'), 'utf8')) as Record<
          string,
          Record<string, unknown>
        >;
        state[STORY_ID].retryCount = 1;
        writeFileSync(join(workspace, 'state.json'), JSON.stringify(state));
        const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(operationPath(workspace))).toBe(true);
  });

  it('allows exactly one concurrent prepared to prepared-bound transition', async () => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(session, defaultOptions(), async (operation) => {
        const outcomes = await Promise.allSettled([
          operation.bindSupervisorControlled(supervisor),
          operation.bindSupervisorControlled({ ...supervisor, supervisorPid: 411 }),
        ]);
        expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
        expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
        throw new Error('simulate parent stop after observing the race');
      }),
    ).rejects.toThrow(/simulate parent stop/);

    const active = parseActiveChildRecord(
      readFileSync(join(operationPath(workspace), ACTIVE_CHILD_FILE)),
    );
    expect(active.state).toBe('prepared-bound');
  });

  it('leaves only inert staging when it crashes before operation install', async () => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(
        session,
        defaultOptions({
          beforeOperationInstall: () => {
            throw new Error('crash-before-install');
          },
        }),
        async () => undefined,
      ),
    ).rejects.toThrow(/crash-before-install/);

    const leaseRoot = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
    expect(existsSync(join(leaseRoot, OPERATION_DIR))).toBe(false);
    expect(
      readdirSync(leaseRoot).filter((name) => name.startsWith('operation.prepare-')),
    ).toHaveLength(1);
    await session.close();
  });

  it.each([
    ['prepared', { afterOperationInstalled: () => Promise.reject(new Error('crash-prepared')) }],
    [
      'prepared-bound',
      {
        afterActiveCommitted: (state: string) => {
          if (state === 'prepared-bound') return Promise.reject(new Error('crash-bound'));
        },
      },
    ],
    [
      'armed',
      {
        afterActiveCommitted: (state: string) => {
          if (state === 'armed') return Promise.reject(new Error('crash-armed'));
        },
      },
    ],
  ] as const)(
    'preserves the canonical %s fact when the parent crashes after commit',
    async (state, hooks) => {
      const { workspace, session } = await setup();
      await expect(
        runWorkspaceOperation(session, defaultOptions(hooks), async (operation) => {
          if (state !== 'prepared') await operation.bindSupervisorControlled(supervisor);
          if (state === 'armed') await operation.armContainmentControlled(containment);
        }),
      ).rejects.toThrow(/crash-/);

      const root = operationPath(workspace);
      expect(parseActiveChildRecord(readFileSync(join(root, ACTIVE_CHILD_FILE))).state).toBe(state);
      expect(existsSync(join(root, DRAINED_RECEIPT_FILE))).toBe(false);
    },
  );

  it('re-reads helper, baseline, owner, protocol, active, and containment before START', async () => {
    const tamperCases = ['helper', 'baseline', 'owner', 'protocol', 'active', 'settled'] as const;
    for (const tamper of tamperCases) {
      const { workspace, session } = await setup();
      await expect(
        runWorkspaceOperation(session, defaultOptions(), async (operation) => {
          await driveToArmed(operation);
          const root = operationPath(workspace);
          if (tamper === 'helper') {
            await operation.readArmedBindingControlled(Buffer.from('different-helper'));
            return;
          }
          if (tamper === 'settled') {
            writeFileSync(
              join(
                workspace,
                PROTOCOL_ROOT_DIR,
                ACTIVE_LEASE_DIR,
                SETTLED_OPERATIONS_DIR,
                'forged-history',
              ),
              'tampered',
            );
            await operation.readArmedBindingControlled(HELPER_BYTES);
            return;
          }
          const path =
            tamper === 'baseline'
              ? join(root, DELEGATED_BASELINE_FILE)
              : tamper === 'owner'
                ? join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OWNER_FILE)
                : tamper === 'protocol'
                  ? join(workspace, PROTOCOL_ROOT_DIR, PROTOCOL_FILE)
                  : join(root, ACTIVE_CHILD_FILE);
          writeFileSync(path, `${readFileSync(path, 'utf8')}\n`);
          await operation.readArmedBindingControlled(HELPER_BYTES);
        }),
      ).rejects.toMatchObject({ code: expect.stringMatching(/invalid|lease-lost/) });
      expect(existsSync(operationPath(workspace))).toBe(true);
    }
  });

  it('settles a prepared abort only with unchanged baseline and the matching fact boundary', async () => {
    const first = await setup();
    const settledPrepared = await runWorkspaceOperation(
      first.session,
      defaultOptions(),
      async (operation) =>
        operation.abortPrestartControlled({
          reason: 'setup-failed',
          proof: 'supervisor-never-bound-v1',
          supervisor: 'never-created',
          containment: 'not-created',
        }),
    );
    expect(existsSync(join(settledPrepared.settledPath, PRESTART_ABORT_FILE))).toBe(true);
    expect(settledPrepared).not.toHaveProperty('candidate');
    await first.session.close();

    const second = await setup();
    const settledBound = await runWorkspaceOperation(
      second.session,
      defaultOptions(),
      async (operation) => {
        await operation.bindSupervisorControlled(supervisor);
        const machine = new SupervisorProtocol({
          ownerId: OWNER_ID,
          operationId: OPERATION_ID,
          supervisor,
        });
        const prestart = machine.abortBeforeStart(
          encodeSupervisorAbortBeforeStart(OPERATION_ID),
          new Date('2026-07-30T00:00:02.000Z'),
        );
        return operation.abortPrestartControlled({
          reason: 'capability-unavailable',
          proof: 'supervisor-prestart-empty-v1',
          supervisor: 'dead',
          containment: 'empty',
          prestartDrainedBytes: jsonBytes(prestart),
        });
      },
    );
    expect(existsSync(join(settledBound.settledPath, PRESTART_ABORT_FILE))).toBe(true);
    expect(settledBound).not.toHaveProperty('candidate');
    await second.session.close();
  });

  it('rechecks unchanged business state after the final prestart settle boundary', async () => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(
        session,
        defaultOptions({
          beforeSettle: () => {
            writeFileSync(join(workspace, 'progress.md'), 'late delta\n');
          },
        }),
        async (operation) =>
          operation.abortPrestartControlled({
            reason: 'setup-failed',
            proof: 'supervisor-never-bound-v1',
            supervisor: 'never-created',
            containment: 'not-created',
          }),
      ),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(operationPath(workspace))).toBe(true);
    expect(readFileSync(join(workspace, 'progress.md'), 'utf8')).toContain('late delta');
  });

  it('requires an unchanged baseline for an armed operation that never accepted START', async () => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(session, defaultOptions(), async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        writeFileSync(join(workspace, 'progress.md'), 'would be allowed\n');
        const drained = machine.drainNeverStartedAfterParentShutdown(
          armed,
          new Date('2026-07-30T00:00:03.000Z'),
        );
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(operationPath(workspace))).toBe(true);
  });

  it('accepts only contract-authorized semantic delta after START', async () => {
    const allowed = await setup();
    const settled = await runWorkspaceOperation(
      allowed.session,
      defaultOptions(),
      async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
        writeFileSync(join(allowed.workspace, 'progress.md'), 'authorized\n');
        const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
      },
    );
    expect(existsSync(settled.settledPath)).toBe(true);
    await allowed.session.close();

    const rejected = await setup();
    await expect(
      runWorkspaceOperation(rejected.session, defaultOptions(), async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
        writeFileSync(join(rejected.workspace, 'unexpected-business.txt'), 'not-authorized');
        const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
        await operation.installDrainedReceiptControlled(drained.receiptBytes, drained.messageBytes);
        return operation.settleArmedControlled({ supervisor: 'dead', containment: 'empty' });
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(existsSync(operationPath(rejected.workspace))).toBe(true);
  });

  it('never lets a parent downgrade armed to prestart abort', async () => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(session, defaultOptions(), async (operation) => {
        await driveToArmed(operation);
        await operation.abortPrestartControlled({
          reason: 'user-interrupt',
          proof: 'supervisor-prestart-empty-v1',
          supervisor: 'dead',
          containment: 'empty',
          prestartDrainedBytes: Buffer.from('{}'),
        });
      }),
    ).rejects.toMatchObject({ code: 'isolated' });
    expect(
      parseActiveChildRecord(readFileSync(join(operationPath(workspace), ACTIVE_CHILD_FILE))).state,
    ).toBe('armed');
    expect(existsSync(join(operationPath(workspace), PRESTART_ABORT_FILE))).toBe(false);
  });

  it.each([
    ['unknown.json', '{}'],
    ['active-child.prepare-00000000-0000-4000-8000-000000000099.json', '{}'],
    [DRAINED_RECEIPT_FILE, '{}'],
    [PRESTART_ABORT_FILE, '{}'],
  ])('refuses to settle with a forged or conflicting operation fact: %s', async (file, bytes) => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(
        session,
        defaultOptions({
          afterAbortInstalled: () => {
            writeFileSync(join(operationPath(workspace), file), bytes);
          },
        }),
        async (operation) =>
          operation.abortPrestartControlled({
            reason: 'setup-failed',
            proof: 'supervisor-never-bound-v1',
            supervisor: 'never-created',
            containment: 'not-created',
          }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(operationPath(workspace))).toBe(true);
  });

  it('rechecks the exact operation layout after the final pre-settle boundary', async () => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(
        session,
        defaultOptions({
          beforeSettle: () => {
            writeFileSync(join(operationPath(workspace), 'late-forgery.json'), '{}');
          },
        }),
        async (operation) =>
          operation.abortPrestartControlled({
            reason: 'setup-failed',
            proof: 'supervisor-never-bound-v1',
            supervisor: 'never-created',
            containment: 'not-created',
          }),
      ),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(operationPath(workspace))).toBe(true);
    expect(existsSync(join(operationPath(workspace), 'late-forgery.json'))).toBe(true);
  });

  it('rejects a delegated child that writes a forged permanent incident before settling', async () => {
    const { workspace, session } = await setup();
    const forgedIncident = join(
      workspace,
      PROTOCOL_ROOT_DIR,
      INCIDENTS_DIR,
      'forged-by-delegated-child.json',
    );

    await expect(
      runWorkspaceOperation(session, defaultOptions(), async (operation) => {
        writeFileSync(forgedIncident, '{}');
        return operation.abortPrestartControlled({
          reason: 'setup-failed',
          proof: 'supervisor-never-bound-v1',
          supervisor: 'never-created',
          containment: 'not-created',
        });
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
    expect(existsSync(forgedIncident)).toBe(true);
    expect(existsSync(operationPath(workspace))).toBe(true);
  });

  it('rejects a forged receipt and keeps the canonical armed bytes unchanged', async () => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(session, defaultOptions(), async (operation) => {
        const { machine, armed } = await driveToArmed(operation);
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
        const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
        const forged = Buffer.from(
          drained.receiptBytes
            .toString('utf8')
            .replace(armed.ownerRecordDigest, `sha256:${'9'.repeat(64)}`),
        );
        await operation.installDrainedReceiptControlled(forged, drained.messageBytes);
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    const root = operationPath(workspace);
    expect(parseActiveChildRecord(readFileSync(join(root, ACTIVE_CHILD_FILE))).state).toBe('armed');
    expect(existsSync(join(root, DRAINED_RECEIPT_FILE))).toBe(false);
  });

  it('keeps a valid armed receipt after a crash and refuses settlement without exact final facts', async () => {
    const { workspace, session } = await setup();
    await expect(
      runWorkspaceOperation(
        session,
        defaultOptions({
          afterReceiptInstalled: () => {
            throw new Error('crash-after-receipt');
          },
        }),
        async (operation) => {
          const { machine, armed } = await driveToArmed(operation);
          machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
          const drained = machine.drain('posix-group-empty-and-pipes-eof-v1');
          await operation.installDrainedReceiptControlled(
            drained.receiptBytes,
            drained.messageBytes,
          );
        },
      ),
    ).rejects.toThrow(/crash-after-receipt/);

    const root = operationPath(workspace);
    expect(existsSync(join(root, DRAINED_RECEIPT_FILE))).toBe(true);
    expect(parseActiveChildRecord(readFileSync(join(root, ACTIVE_CHILD_FILE))).state).toBe('armed');
  });

  it('does not replace a canonical competing operation directory', async () => {
    const { workspace, session } = await setup();
    const canonical = operationPath(workspace);
    mkdirSync(canonical);
    writeFileSync(join(canonical, 'competitor'), 'complete');

    await expect(
      runWorkspaceOperation(session, defaultOptions(), async () => undefined),
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(readFileSync(join(canonical, 'competitor'), 'utf8')).toBe('complete');
  });

  it('creates one stable settled parent and never writes outside the owner lease', async () => {
    const { workspace, session } = await setup();
    await runWorkspaceOperation(session, defaultOptions(), async (operation) =>
      operation.abortPrestartControlled({
        reason: 'setup-failed',
        proof: 'supervisor-never-bound-v1',
        supervisor: 'never-created',
        containment: 'not-created',
      }),
    );
    const leaseRoot = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR);
    expect(readdirSync(join(leaseRoot, SETTLED_OPERATIONS_DIR))).toHaveLength(1);
    expect(readdirSync(workspace).sort()).toEqual([
      'engine.lock',
      'screenshots',
      'state.json',
      'workspace-safety.json',
    ]);
    await session.close();
  });
});
