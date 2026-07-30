import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { WindowsSupervisorProcess } from './windows-supervisor-protocol.js';
import {
  WindowsSupervisorEventOrder,
  parseWindowsSupervisorEvent,
  readDarkWindowsHelperBundle,
} from './windows-supervisor.js';

const OPERATION_ID = '00000000-0000-4000-8000-000000000020';
const DIGEST = `sha256:${'a'.repeat(64)}`;

function event(value: Record<string, unknown>): Buffer {
  return Buffer.from(JSON.stringify({ schemaVersion: 1, ...value }), 'utf8');
}

function bound() {
  return parseWindowsSupervisorEvent(
    event({
      type: 'BOUND',
      supervisorPid: 410,
      supervisorIdentity: '133700000000000000',
      helperDigest: DIGEST,
    }),
  );
}

function armed() {
  return parseWindowsSupervisorEvent(
    event({
      type: 'ARMED',
      containment: {
        platform: 'windows-job-v1',
        targetPid: 510,
        targetIdentity: '133700000000000001',
      },
    }),
  );
}

function drained() {
  const message = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      type: 'DRAINED',
      operationId: OPERATION_ID,
      receiptDigest: DIGEST,
      proof: 'windows-job-zero-and-pipes-eof-v1',
    }),
    'utf8',
  );
  return parseWindowsSupervisorEvent(
    event({ type: 'DRAINED', messageBase64: message.toString('base64') }),
  );
}

function prestartDrained() {
  const message = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      type: 'PRESTART_DRAINED',
      operationId: OPERATION_ID,
      supervisorPid: 410,
      supervisorIdentity: '133700000000000000',
      proof: 'prestart-containment-empty-and-pipes-eof-v1',
      drainedAt: '2026-07-30T00:00:00.000Z',
    }),
    'utf8',
  );
  return parseWindowsSupervisorEvent(
    event({ type: 'PRESTART_DRAINED', messageBase64: message.toString('base64') }),
  );
}

describe('Windows supervisor protocol parser', () => {
  it('accepts the fixed Windows event order and bounded output chunks', () => {
    const order = new WindowsSupervisorEventOrder();
    const output = parseWindowsSupervisorEvent(
      event({ type: 'OUTPUT', stream: 'stdout', data: Buffer.alloc(16 * 1024).toString('base64') }),
    );
    const sequence = [
      bound(),
      armed(),
      output,
      parseWindowsSupervisorEvent(event({ type: 'STARTED', targetPid: 510 })),
      parseWindowsSupervisorEvent(event({ type: 'RESULT', code: 0, signal: null })),
      drained(),
    ];

    for (const item of sequence) order.accept(item);
    expect(order.state).toBe('drained');
    expect(output).toMatchObject({ type: 'OUTPUT', stream: 'stdout' });
    if (output.type === 'OUTPUT') expect(output.data).toHaveLength(16 * 1024);
  });

  it('also accepts the never-started ARMED to DRAINED path', () => {
    const order = new WindowsSupervisorEventOrder();
    order.accept(bound());
    order.accept(armed());
    order.accept(drained());
    expect(order.state).toBe('drained');
  });

  it('accepts prepared-bound and armed prestart abort completion only as terminal paths', () => {
    for (const withContainment of [false, true]) {
      const order = new WindowsSupervisorEventOrder();
      order.accept(bound());
      if (withContainment) order.accept(armed());
      order.accept(prestartDrained());
      expect(order.state).toBe('prestart-drained');
      expect(() => order.accept(drained())).toThrow(/not allowed/i);
    }
  });

  it('rejects out-of-order, duplicate, and late events', () => {
    const result = parseWindowsSupervisorEvent(event({ type: 'RESULT', code: 0, signal: null }));
    const output = parseWindowsSupervisorEvent(
      event({ type: 'OUTPUT', stream: 'stderr', data: Buffer.from('x').toString('base64') }),
    );

    expect(() => new WindowsSupervisorEventOrder().accept(result)).toThrow(/not allowed/i);
    expect(() => new WindowsSupervisorEventOrder().accept(output)).toThrow(/not allowed/i);
    const duplicate = new WindowsSupervisorEventOrder();
    duplicate.accept(bound());
    expect(() => duplicate.accept(bound())).toThrow(/not allowed/i);
    const late = new WindowsSupervisorEventOrder();
    late.accept(bound());
    late.accept(armed());
    late.accept(drained());
    expect(() => late.accept(output)).toThrow(/not allowed/i);
  });

  it('rejects oversized or non-canonical output and malformed event shapes', () => {
    expect(() =>
      parseWindowsSupervisorEvent(
        event({
          type: 'OUTPUT',
          stream: 'stdout',
          data: Buffer.alloc(16 * 1024 + 1).toString('base64'),
        }),
      ),
    ).toThrow(/fixed bound/i);
    expect(() =>
      parseWindowsSupervisorEvent(event({ type: 'OUTPUT', stream: 'stdout', data: 'eA' })),
    ).toThrow(/base64/i);
    expect(() =>
      parseWindowsSupervisorEvent(event({ type: 'RESULT', code: 0, signal: 'SIGTERM' })),
    ).toThrow(/code\/signal/i);
    expect(() =>
      parseWindowsSupervisorEvent(
        event({ type: 'PRESTART_DRAINED', messageBase64: Buffer.from('{}').toString('base64') }),
      ),
    ).toThrow(/prestart|schema|missing/i);
    expect(() =>
      parseWindowsSupervisorEvent(
        event({
          type: 'BOUND',
          supervisorPid: 1,
          supervisorIdentity: 'x',
          helperDigest: DIGEST,
          extra: 1,
        }),
      ),
    ).toThrow(/unknown|missing/i);
    expect(() =>
      parseWindowsSupervisorEvent(
        `{"schemaVersion":1,"type":"STARTED","targetPid":1,"targetPid":2}`,
      ),
    ).toThrow(/duplicate/i);
  });

  it('does not expose the production helper bundle on non-Windows hosts', () => {
    if (process.platform === 'win32') {
      expect(readDarkWindowsHelperBundle().length).toBeGreaterThan(0);
    } else {
      expect(() => readDarkWindowsHelperBundle()).toThrow(/unavailable/i);
    }
  });

  it('enforces the aggregate output bound in the real JSONL transport', async () => {
    const chunk = Buffer.alloc(16 * 1024, 120).toString('base64');
    const source = [
      `const chunk=${JSON.stringify(chunk)};`,
      'const send=(value)=>process.stdout.write(`${JSON.stringify(value)}\\n`);',
      `send({schemaVersion:1,type:'BOUND',supervisorPid:410,supervisorIdentity:'133700000000000000',helperDigest:${JSON.stringify(DIGEST)}});`,
      "send({schemaVersion:1,type:'ARMED',containment:{platform:'windows-job-v1',targetPid:510,targetIdentity:'133700000000000001'}});",
      "for(let index=0;index<1025;index++)send({schemaVersion:1,type:'OUTPUT',stream:'stdout',data:chunk});",
      'process.stdin.resume();',
    ].join('');
    const child = spawn(process.execPath, ['-e', source], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const processHandle = new WindowsSupervisorProcess(child, 15_000);

    try {
      await expect(processHandle.next('BOUND')).resolves.toMatchObject({ type: 'BOUND' });
      await expect(processHandle.next('ARMED')).resolves.toMatchObject({ type: 'ARMED' });
      await expect(processHandle.next('DRAINED')).rejects.toThrow(
        /output exceeded the total bound/i,
      );
    } finally {
      await processHandle.abort();
    }
  }, 30_000);
});
