import { describe, expect, it } from 'vitest';
import {
  SupervisorProtocol,
  encodeSupervisorAbortBeforeStart,
  encodeSupervisorAcknowledgement,
  encodeSupervisorData,
  encodeSupervisorStart,
  encodeSupervisorTerminate,
  parseDrainedReceipt,
  parseSupervisorData,
  parseSupervisorDrained,
  parseSupervisorTerminate,
  type ArmedSafetyBinding,
  type BoundSupervisorDescriptor,
  type ContainmentDescriptor,
  type PreparedBoundSafetyBinding,
} from './supervisor-protocol.js';

const OWNER_ID = '00000000-0000-4000-8000-000000000001';
const OPERATION_ID = '00000000-0000-4000-8000-000000000002';
const SHA = (character: string): string => `sha256:${character.repeat(64)}`;

const supervisor: BoundSupervisorDescriptor = {
  platform: 'posix-process-group-v1',
  supervisorPid: 401,
  supervisorIdentity: '401001',
  signalIsolation: 'posix-supervisor-session-signal-shield-v1',
  helperDigest: SHA('a'),
};

const containment: ContainmentDescriptor = {
  platform: 'posix-process-group-v1',
  pgid: 501,
  launcherPid: 501,
  launcherIdentity: '501001',
};

function preparedBoundBinding(): PreparedBoundSafetyBinding {
  return {
    ownerId: OWNER_ID,
    operationId: OPERATION_ID,
    ownerRecordDigest: SHA('b'),
    protocolDigest: SHA('c'),
    activeChildDigest: SHA('d'),
    delegatedBaselineDigest: SHA('e'),
    delegationContractDigest: SHA('f'),
    helperDigest: supervisor.helperDigest,
    supervisor,
  };
}

function armedBinding(protocol: SupervisorProtocol): ArmedSafetyBinding {
  return {
    ...preparedBoundBinding(),
    activeChildDigest: SHA('1'),
    containmentDigest: protocol.containmentDigest,
    containment,
  };
}

function protocol(): SupervisorProtocol {
  return new SupervisorProtocol({ ownerId: OWNER_ID, operationId: OPERATION_ID, supervisor });
}

function dataBytes(operationId = OPERATION_ID): Buffer {
  return encodeSupervisorData({
    operationId,
    target: {
      executable: '/usr/bin/node',
      args: ['dist/cli.js', 'doctor'],
      cwd: '/tmp/package-owned-cwd',
      environment: [{ name: 'NODE_ENV', value: 'test' }],
    },
  });
}

describe('supervisor protocol', () => {
  it('round-trips an optional absolute executable argv0 without weakening strict fields', () => {
    const parsed = parseSupervisorData(
      encodeSupervisorData({
        operationId: OPERATION_ID,
        target: {
          executable: '/usr/bin/python3',
          executableArgv0: '/tmp/project/.venv/bin/python',
          args: ['-c', 'pass'],
          cwd: '/tmp/project',
          environment: [],
        },
      }),
    );
    expect(parsed.target).toMatchObject({
      executable: '/usr/bin/python3',
      executableArgv0: '/tmp/project/.venv/bin/python',
    });
  });

  it('keeps a legal DATA message below 64 KiB even when canonical base64 exceeds 4096 chars', () => {
    const bytes = encodeSupervisorData({
      operationId: OPERATION_ID,
      target: {
        executable: '/usr/bin/node',
        args: ['dist/cli.js'],
        cwd: '/tmp/package-owned-cwd',
        environment: [
          { name: 'CODING_X_PAD_A', value: 'a'.repeat(3000) },
          { name: 'CODING_X_PAD_B', value: 'b'.repeat(3000) },
        ],
      },
    });
    const encoded = bytes.toString('base64');

    expect(bytes.byteLength).toBeLessThanOrEqual(64 * 1024);
    expect(encoded.length).toBeGreaterThan(4096);
    expect(encoded.length).toBeLessThanOrEqual(4 * Math.ceil((64 * 1024) / 3));
    expect(parseSupervisorData(bytes).target.environment).toHaveLength(2);
  });

  it('authorizes DATA, containment, one START, one DRAINED receipt, and one ACK in order', () => {
    const machine = protocol();
    const acceptedTarget = machine.acceptData(dataBytes(), preparedBoundBinding());
    expect(acceptedTarget.executable).toBe('/usr/bin/node');
    expect(machine.state).toBe('data-accepted');

    machine.containmentReady(containment);
    const armed = armedBinding(machine);
    machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
    expect(machine.state).toBe('start-accepted');

    const drained = machine.drain(
      'posix-group-empty-and-pipes-eof-v1',
      'natural',
      new Date('2026-07-30T00:00:03.000Z'),
    );
    expect(parseDrainedReceipt(drained.receiptBytes)).toMatchObject({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      proof: 'posix-group-empty-and-pipes-eof-v1',
      drainReason: 'natural',
      activeChildDigest: armed.activeChildDigest,
      containmentDigest: armed.containmentDigest,
    });
    expect(parseSupervisorDrained(drained.messageBytes).receiptDigest).toBe(drained.receiptDigest);

    machine.acknowledge(encodeSupervisorAcknowledgement(OPERATION_ID, drained.receiptDigest));
    expect(machine.state).toBe('acknowledged');
  });

  it.each(['timeout', 'user-interrupt', 'parent-shutdown'] as const)(
    'accepts one platform-neutral TERMINATE(%s) after START and still requires drain then ACK',
    (reason) => {
      const machine = protocol();
      machine.acceptData(dataBytes(), preparedBoundBinding());
      machine.containmentReady(containment);
      const armed = armedBinding(machine);
      machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);

      const bytes = encodeSupervisorTerminate(OPERATION_ID, reason);
      expect(parseSupervisorTerminate(bytes)).toEqual({
        schemaVersion: 1,
        type: 'TERMINATE',
        operationId: OPERATION_ID,
        reason,
      });
      expect(machine.acceptTerminate(bytes)).toBe(reason);
      expect(machine.state).toBe('termination-requested-after-start');
      expect(machine.terminationReason).toBe(reason);

      const drained = machine.drainAfterTermination('posix-group-empty-and-pipes-eof-v1');
      expect(parseDrainedReceipt(drained.receiptBytes).drainReason).toBe(reason);
      machine.acknowledge(encodeSupervisorAcknowledgement(OPERATION_ID, drained.receiptDigest));
      expect(machine.state).toBe('acknowledged');
    },
  );

  it('rejects early, wrong-operation, open-ended, and platform-shaped TERMINATE input while freezing the first valid cause', () => {
    const early = protocol();
    expect(() => early.acceptTerminate(encodeSupervisorTerminate(OPERATION_ID, 'timeout'))).toThrow(
      /state/i,
    );
    expect(early.state).toBe('failed');

    const machine = protocol();
    machine.acceptData(dataBytes(), preparedBoundBinding());
    machine.containmentReady(containment);
    const armed = armedBinding(machine);
    machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
    expect(() =>
      machine.acceptTerminate(
        encodeSupervisorTerminate('00000000-0000-4000-8000-000000000099', 'timeout'),
      ),
    ).toThrow(/operation/i);
    expect(machine.state).toBe('failed');

    for (const value of [
      { reason: 'SIGKILL' },
      { reason: 'timeout', pid: 123 },
      { reason: 'timeout', command: 'kill -9 123' },
      { reason: 'timeout', platform: 'posix' },
    ]) {
      expect(() =>
        parseSupervisorTerminate(
          Buffer.from(
            JSON.stringify({
              schemaVersion: 1,
              type: 'TERMINATE',
              operationId: OPERATION_ID,
              ...value,
            }),
          ),
        ),
      ).toThrow(/unsupported|unknown/i);
    }

    const duplicate = protocol();
    duplicate.acceptData(dataBytes(), preparedBoundBinding());
    duplicate.containmentReady(containment);
    const duplicateArmed = armedBinding(duplicate);
    duplicate.acceptStart(
      encodeSupervisorStart(OPERATION_ID, duplicateArmed.activeChildDigest),
      duplicateArmed,
    );
    const terminate = encodeSupervisorTerminate(OPERATION_ID, 'parent-shutdown');
    duplicate.acceptTerminate(terminate);
    expect(duplicate.acceptTerminate(terminate)).toBe('parent-shutdown');
    expect(duplicate.acceptTerminate(encodeSupervisorTerminate(OPERATION_ID, 'timeout'))).toBe(
      'parent-shutdown',
    );
    expect(duplicate.state).toBe('termination-requested-after-start');
  });

  it.each(['timeout', 'user-interrupt', 'parent-shutdown'] as const)(
    'lets TERMINATE(%s) win after canonical armed but before START without poisoning the proof',
    (reason) => {
      const machine = protocol();
      machine.acceptData(dataBytes(), preparedBoundBinding());
      machine.containmentReady(containment);
      const armed = armedBinding(machine);
      expect(machine.acceptTerminate(encodeSupervisorTerminate(OPERATION_ID, reason), armed)).toBe(
        reason,
      );
      expect(machine.state).toBe('termination-requested-before-start');

      expect(
        machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed),
      ).toBe(false);
      expect(machine.state).toBe('termination-requested-before-start');

      const drained = machine.drainAfterTermination('never-started-containment-empty-v1');
      expect(parseDrainedReceipt(drained.receiptBytes)).toMatchObject({
        proof: 'never-started-containment-empty-v1',
        drainReason: reason,
      });
      expect(machine.acceptTerminate(encodeSupervisorTerminate(OPERATION_ID, 'timeout'))).toBe(
        reason,
      );
      machine.acknowledge(encodeSupervisorAcknowledgement(OPERATION_ID, drained.receiptDigest));
      expect(machine.state).toBe('acknowledged');
    },
  );

  it('fails closed on malformed or wrong-bound late START without launching', () => {
    for (const lateStart of [
      Buffer.from('{not-json'),
      encodeSupervisorStart('00000000-0000-4000-8000-000000000099', SHA('1')),
      encodeSupervisorStart(OPERATION_ID, SHA('9')),
    ]) {
      const machine = protocol();
      machine.acceptData(dataBytes(), preparedBoundBinding());
      machine.containmentReady(containment);
      const armed = armedBinding(machine);
      machine.acceptTerminate(encodeSupervisorTerminate(OPERATION_ID, 'timeout'), armed);
      expect(() => machine.acceptStart(lateStart, armed)).toThrow();
      expect(machine.state).toBe('failed');
    }
  });

  it('rejects impossible receipt proof/reason combinations and binds process-tree-not-empty in receipt bytes', () => {
    const drainedAt = new Date('2026-07-30T00:00:03.000Z');
    const machine = protocol();
    machine.acceptData(dataBytes(), preparedBoundBinding());
    machine.containmentReady(containment);
    const armed = armedBinding(machine);
    machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
    const drained = machine.drain(
      'posix-group-empty-and-pipes-eof-v1',
      'process-tree-not-empty',
      drainedAt,
    );
    expect(parseDrainedReceipt(drained.receiptBytes).drainReason).toBe('process-tree-not-empty');

    expect(() =>
      parseDrainedReceipt(
        Buffer.from(
          drained.receiptBytes
            .toString('utf8')
            .replace('posix-group-empty-and-pipes-eof-v1', 'never-started-containment-empty-v1'),
        ),
      ),
    ).toThrow(/inconsistent/i);

    const naturalMachine = protocol();
    naturalMachine.acceptData(dataBytes(), preparedBoundBinding());
    naturalMachine.containmentReady(containment);
    const naturalArmed = armedBinding(naturalMachine);
    naturalMachine.acceptStart(
      encodeSupervisorStart(OPERATION_ID, naturalArmed.activeChildDigest),
      naturalArmed,
    );
    const natural = naturalMachine.drain(
      'posix-group-empty-and-pipes-eof-v1',
      'natural',
      drainedAt,
    );
    expect(natural.receiptDigest).not.toBe(drained.receiptDigest);
  });

  it('strictly parses bounded DATA without persisting or echoing target values', () => {
    expect(parseSupervisorData(dataBytes()).target.args).toEqual(['dist/cli.js', 'doctor']);
    expect(() =>
      parseSupervisorData(
        Buffer.from(
          `{"schemaVersion":1,"type":"DATA","operationId":"${OPERATION_ID}","operationId":"${OPERATION_ID}","target":{}}`,
        ),
      ),
    ).toThrow(/duplicate/i);
    expect(() =>
      parseSupervisorData(
        Buffer.from(
          dataBytes()
            .toString('utf8')
            .replace(OPERATION_ID, '00000000-0000-0000-0000-000000000002'),
        ),
      ),
    ).toThrow(/format/i);
    expect(() =>
      parseSupervisorData(
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            type: 'DATA',
            operationId: OPERATION_ID,
            target: { executable: 'node', args: [], cwd: '/tmp', environment: [], extra: true },
          }),
        ),
      ),
    ).toThrow(/unknown/i);
    expect(() =>
      parseSupervisorData(
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            type: 'DATA',
            operationId: OPERATION_ID,
            target: { executable: 'x'.repeat(5000), args: [], cwd: '/tmp', environment: [] },
          }),
        ),
      ),
    ).toThrow(/bounded/i);
    expect(() =>
      parseSupervisorData(
        Buffer.from(
          JSON.stringify({
            schemaVersion: 1,
            type: 'DATA',
            operationId: OPERATION_ID,
            target: {
              executable: 'node',
              args: [],
              cwd: '/tmp',
              environment: [
                { name: 'A', value: '1' },
                { name: 'a', value: '2' },
              ],
            },
          }),
        ),
      ),
    ).toThrow(/duplicate/i);
  });

  it('fails closed on duplicate, late, or wrong-operation DATA', () => {
    const duplicate = protocol();
    duplicate.acceptData(dataBytes(), preparedBoundBinding());
    expect(() => duplicate.acceptData(dataBytes(), preparedBoundBinding())).toThrow(/state/i);
    expect(duplicate.state).toBe('failed');

    const wrong = protocol();
    expect(() =>
      wrong.acceptData(dataBytes('00000000-0000-4000-8000-000000000099'), preparedBoundBinding()),
    ).toThrow(/operation/i);
    expect(wrong.state).toBe('failed');
  });

  it('rejects START before containment and permanently closes on a wrong digest', () => {
    const early = protocol();
    early.acceptData(dataBytes(), preparedBoundBinding());
    expect(() =>
      early.acceptStart(encodeSupervisorStart(OPERATION_ID, SHA('1')), armedBinding(early)),
    ).toThrow(/state/i);
    expect(early.state).toBe('failed');

    const wrong = protocol();
    wrong.acceptData(dataBytes(), preparedBoundBinding());
    wrong.containmentReady(containment);
    const armed = armedBinding(wrong);
    expect(() => wrong.acceptStart(encodeSupervisorStart(OPERATION_ID, SHA('9')), armed)).toThrow(
      /digest/i,
    );
    expect(wrong.state).toBe('failed');
  });

  it.each([
    'ownerRecordDigest',
    'protocolDigest',
    'delegatedBaselineDigest',
    'delegationContractDigest',
    'helperDigest',
    'containmentDigest',
  ] as const)('rejects a changed %s before START', (field) => {
    const machine = protocol();
    machine.acceptData(dataBytes(), preparedBoundBinding());
    machine.containmentReady(containment);
    const armed = { ...armedBinding(machine), [field]: SHA('9') };

    expect(() =>
      machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed),
    ).toThrow(/binding/i);
    expect(machine.state).toBe('failed');
  });

  it('separates prestart abort from armed never-started receipt facts', () => {
    const beforeArmed = protocol();
    beforeArmed.acceptData(dataBytes(), preparedBoundBinding());
    const prestart = beforeArmed.abortBeforeStart(
      encodeSupervisorAbortBeforeStart(OPERATION_ID),
      new Date('2026-07-30T00:00:02.000Z'),
    );
    expect(prestart.type).toBe('PRESTART_DRAINED');
    expect(beforeArmed.state).toBe('prestart-drained');
    expect(() =>
      beforeArmed.drainNeverStartedAfterParentShutdown(armedBinding(beforeArmed)),
    ).toThrow(/state/i);

    const armedButNotStarted = protocol();
    armedButNotStarted.acceptData(dataBytes(), preparedBoundBinding());
    armedButNotStarted.containmentReady(containment);
    const frozen = armedBinding(armedButNotStarted);
    const drained = armedButNotStarted.drainNeverStartedAfterParentShutdown(
      frozen,
      new Date('2026-07-30T00:00:03.000Z'),
    );
    expect(parseDrainedReceipt(drained.receiptBytes).proof).toBe(
      'never-started-containment-empty-v1',
    );
    expect(() =>
      armedButNotStarted.abortBeforeStart(encodeSupervisorAbortBeforeStart(OPERATION_ID)),
    ).toThrow(/state/i);
  });

  it('rejects a forged DRAINED message or receipt and does not accept a second drain or ACK', () => {
    const machine = protocol();
    machine.acceptData(dataBytes(), preparedBoundBinding());
    machine.containmentReady(containment);
    const armed = armedBinding(machine);
    machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);
    const drained = machine.drain(
      'posix-group-empty-and-pipes-eof-v1',
      'natural',
      new Date('2026-07-30T00:00:03.000Z'),
    );

    expect(() =>
      parseSupervisorDrained(
        Buffer.from(drained.messageBytes.toString('utf8').replace(drained.receiptDigest, SHA('9'))),
      ),
    ).not.toThrow();
    expect(() =>
      parseDrainedReceipt(
        Buffer.from(drained.receiptBytes.toString('utf8').replace(OPERATION_ID, OWNER_ID)),
      ),
    ).toThrow(/binding|operation|owner/i);

    machine.acknowledge(encodeSupervisorAcknowledgement(OPERATION_ID, drained.receiptDigest));
    expect(() =>
      machine.acknowledge(encodeSupervisorAcknowledgement(OPERATION_ID, drained.receiptDigest)),
    ).toThrow(/state/i);

    const duplicateDrain = protocol();
    duplicateDrain.acceptData(dataBytes(), preparedBoundBinding());
    duplicateDrain.containmentReady(containment);
    const duplicateArmed = armedBinding(duplicateDrain);
    duplicateDrain.acceptStart(
      encodeSupervisorStart(OPERATION_ID, duplicateArmed.activeChildDigest),
      duplicateArmed,
    );
    duplicateDrain.drain('posix-group-empty-and-pipes-eof-v1');
    expect(() => duplicateDrain.drain('posix-group-empty-and-pipes-eof-v1')).toThrow(/state/i);
  });

  it('only permits platform-matching drained proofs', () => {
    const machine = protocol();
    machine.acceptData(dataBytes(), preparedBoundBinding());
    machine.containmentReady(containment);
    const armed = armedBinding(machine);
    machine.acceptStart(encodeSupervisorStart(OPERATION_ID, armed.activeChildDigest), armed);

    expect(() => machine.drain('windows-job-zero-and-pipes-eof-v1')).toThrow(/platform/i);
    expect(machine.state).toBe('failed');
  });
});
