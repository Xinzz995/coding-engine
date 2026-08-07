import { spawn } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { MonotonicDeadline } from './deadline.js';
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

function outputEvent(
  sequence: number,
  stream: 'stdout' | 'stderr',
  data: Buffer,
): Record<string, unknown> {
  return {
    type: 'OUTPUT',
    operationId: OPERATION_ID,
    sequence,
    bytes: data.length,
    stream,
    data: data.toString('base64'),
  };
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
      proof: 'windows-job-zero-pipes-eof-output-settled-v2',
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

function deferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
} {
  let resolvePromise: (value: T | PromiseLike<T>) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

function rejectable<T>(): {
  readonly promise: Promise<T>;
  readonly reject: (error: Error) => void;
} {
  let rejectPromise = (_error: Error): void => undefined;
  const promise = new Promise<T>((_resolve, reject) => {
    rejectPromise = reject;
  });
  return { promise, reject: rejectPromise };
}

function outputTransportSource(
  outputFrames: readonly { readonly stream: 'stdout' | 'stderr'; readonly data: Buffer }[],
): string {
  const drainedMessage = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      type: 'DRAINED',
      operationId: OPERATION_ID,
      receiptDigest: DIGEST,
      proof: 'windows-job-zero-pipes-eof-output-settled-v2',
    }),
    'utf8',
  ).toString('base64');
  const frames = outputFrames.map(({ stream, data }, index) => ({
    schemaVersion: 1,
    ...outputEvent(index + 1, stream, data),
  }));
  const acknowledgements = outputFrames.map(({ data }, index) => [index + 1, data.length]);
  return [
    'const send=(value)=>process.stdout.write(`${JSON.stringify(value)}\\n`);',
    "const readline=require('node:readline');",
    `const expected=new Map(${JSON.stringify(acknowledgements)});const seen=new Set();`,
    `const drainedMessage=${JSON.stringify(drainedMessage)};`,
    "readline.createInterface({input:process.stdin}).on('line',(line)=>{",
    'const value=JSON.parse(line);',
    `if(value.schemaVersion!==1||value.type!=='OUTPUT_ACK'||value.operationId!==${JSON.stringify(OPERATION_ID)}||expected.get(value.sequence)!==value.bytes||seen.has(value.sequence))process.exit(91);`,
    'seen.add(value.sequence);',
    "if(seen.size===expected.size){send({schemaVersion:1,type:'RESULT',code:0,signal:null});send({schemaVersion:1,type:'DRAINED',messageBase64:drainedMessage});}",
    '});',
    `send({schemaVersion:1,type:'BOUND',supervisorPid:410,supervisorIdentity:'133700000000000000',helperDigest:${JSON.stringify(DIGEST)}});`,
    "send({schemaVersion:1,type:'ARMED',containment:{platform:'windows-job-v1',targetPid:510,targetIdentity:'133700000000000001'}});",
    "send({schemaVersion:1,type:'STARTED',targetPid:510});",
    ...frames.map((frame) => `send(${JSON.stringify(frame)});`),
    'process.stdin.resume();',
  ].join('');
}

function terminationSettledTransportSource(): string {
  const drainedMessage = Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      type: 'DRAINED',
      operationId: OPERATION_ID,
      receiptDigest: DIGEST,
      proof: 'windows-job-zero-pipes-eof-output-settled-v2',
    }),
    'utf8',
  ).toString('base64');
  const output = { schemaVersion: 1, ...outputEvent(1, 'stdout', Buffer.from('held')) };
  return [
    'const send=(value)=>process.stdout.write(`${JSON.stringify(value)}\\n`);',
    "const readline=require('node:readline');",
    "readline.createInterface({input:process.stdin}).on('line',(line)=>{",
    'const value=JSON.parse(line);',
    "if(value.type==='OUTPUT_ACK')process.exit(91);",
    `if(value.type==='TERMINATE'){send({schemaVersion:1,type:'DRAINED',messageBase64:${JSON.stringify(drainedMessage)}});}`,
    '});',
    `send({schemaVersion:1,type:'BOUND',supervisorPid:410,supervisorIdentity:'133700000000000000',helperDigest:${JSON.stringify(DIGEST)}});`,
    "send({schemaVersion:1,type:'ARMED',containment:{platform:'windows-job-v1',targetPid:510,targetIdentity:'133700000000000001'}});",
    "send({schemaVersion:1,type:'STARTED',targetPid:510});",
    `send(${JSON.stringify(output)});`,
    "send({schemaVersion:1,type:'RESULT',code:0,signal:null});",
    'process.stdin.resume();',
  ].join('');
}

describe('Windows supervisor protocol parser', () => {
  it('accepts the fixed Windows event order and bounded output chunks', () => {
    const order = new WindowsSupervisorEventOrder();
    const output = parseWindowsSupervisorEvent(
      event(outputEvent(1, 'stdout', Buffer.alloc(16 * 1024))),
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
    const output = parseWindowsSupervisorEvent(event(outputEvent(1, 'stderr', Buffer.from('x'))));

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
          ...outputEvent(1, 'stdout', Buffer.alloc(16 * 1024 + 1)),
        }),
      ),
    ).toThrow(/fixed bound/i);
    expect(() =>
      parseWindowsSupervisorEvent(
        event({ ...outputEvent(1, 'stdout', Buffer.from('x')), data: 'eA' }),
      ),
    ).toThrow(/base64/i);
    expect(() =>
      parseWindowsSupervisorEvent(
        event({ ...outputEvent(1, 'stdout', Buffer.from('x')), bytes: 2 }),
      ),
    ).toThrow(/does not match/i);
    expect(() =>
      parseWindowsSupervisorEvent(
        event({ ...outputEvent(1, 'stdout', Buffer.from('x')), operationId: DIGEST }),
      ),
    ).toThrow(/operationId/i);
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

  it.each([
    ['byte budget', 17, 16 * 1024],
    ['frame budget', 1025, 1],
  ] as const)(
    'rejects a helper that exceeds the explicit unacknowledged %s',
    async (_label, frameCount, chunkBytes) => {
      const chunk = Buffer.alloc(chunkBytes, 120).toString('base64');
      const source = [
        `const chunk=${JSON.stringify(chunk)};`,
        'const send=(value)=>process.stdout.write(`${JSON.stringify(value)}\\n`);',
        `send({schemaVersion:1,type:'BOUND',supervisorPid:410,supervisorIdentity:'133700000000000000',helperDigest:${JSON.stringify(DIGEST)}});`,
        "send({schemaVersion:1,type:'ARMED',containment:{platform:'windows-job-v1',targetPid:510,targetIdentity:'133700000000000001'}});",
        `for(let index=1;index<=${frameCount};index++)send({schemaVersion:1,type:'OUTPUT',operationId:${JSON.stringify(OPERATION_ID)},sequence:index,bytes:${chunkBytes},stream:'stdout',data:chunk});`,
        'process.stdin.resume();',
      ].join('');
      const child = spawn(process.execPath, ['-e', source], {
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const processHandle = new WindowsSupervisorProcess(
        child,
        15_000,
        {
          onOutput: () => new Promise<void>(() => undefined),
          onFailure: () => undefined,
        },
        OPERATION_ID,
      );

      try {
        await expect(processHandle.next('BOUND')).resolves.toMatchObject({ type: 'BOUND' });
        await expect(processHandle.next('ARMED')).resolves.toMatchObject({ type: 'ARMED' });
        await expect(processHandle.next('DRAINED')).rejects.toThrow(/credit window/i);
      } finally {
        await processHandle.abort(MonotonicDeadline.after(5000));
      }
    },
    30_000,
  );

  it('rejects DRAINED before a consumed OUTPUT is acknowledged', async () => {
    const drainedMessage = Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        type: 'DRAINED',
        operationId: OPERATION_ID,
        receiptDigest: DIGEST,
        proof: 'windows-job-zero-pipes-eof-output-settled-v2',
      }),
      'utf8',
    ).toString('base64');
    const output = JSON.stringify({
      schemaVersion: 1,
      ...outputEvent(1, 'stdout', Buffer.from('held')),
    });
    const source = [
      'const send=(value)=>process.stdout.write(`${JSON.stringify(value)}\\n`);',
      `send({schemaVersion:1,type:'BOUND',supervisorPid:410,supervisorIdentity:'133700000000000000',helperDigest:${JSON.stringify(DIGEST)}});`,
      "send({schemaVersion:1,type:'ARMED',containment:{platform:'windows-job-v1',targetPid:510,targetIdentity:'133700000000000001'}});",
      "send({schemaVersion:1,type:'STARTED',targetPid:510});",
      `send(${output});`,
      `setTimeout(()=>{send({schemaVersion:1,type:'RESULT',code:0,signal:null});send({schemaVersion:1,type:'DRAINED',messageBase64:${JSON.stringify(drainedMessage)}});},20);`,
      'process.stdin.resume();',
    ].join('');
    const child = spawn(process.execPath, ['-e', source], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const processHandle = new WindowsSupervisorProcess(
      child,
      15_000,
      {
        onOutput: () => new Promise<void>(() => undefined),
        onFailure: () => undefined,
      },
      OPERATION_ID,
    );

    try {
      await processHandle.next('BOUND');
      await processHandle.next('ARMED');
      await processHandle.next('STARTED');
      await processHandle.next('RESULT');
      await expect(processHandle.next('DRAINED')).rejects.toThrow(/before every OUTPUT/i);
    } finally {
      processHandle.discardOutput();
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });

  it('rejects a non-consecutive global OUTPUT sequence', async () => {
    const source = [
      'const send=(value)=>process.stdout.write(`${JSON.stringify(value)}\\n`);',
      `send({schemaVersion:1,type:'BOUND',supervisorPid:410,supervisorIdentity:'133700000000000000',helperDigest:${JSON.stringify(DIGEST)}});`,
      "send({schemaVersion:1,type:'ARMED',containment:{platform:'windows-job-v1',targetPid:510,targetIdentity:'133700000000000001'}});",
      "send({schemaVersion:1,type:'STARTED',targetPid:510});",
      `setTimeout(()=>send(${JSON.stringify({ schemaVersion: 1, ...outputEvent(2, 'stderr', Buffer.from('gap')) })}),20);`,
      'process.stdin.resume();',
    ].join('');
    const child = spawn(process.execPath, ['-e', source], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const processHandle = new WindowsSupervisorProcess(child, 15_000, undefined, OPERATION_ID);

    try {
      await processHandle.next('BOUND');
      await processHandle.next('ARMED');
      await processHandle.next('STARTED');
      await expect(processHandle.next('RESULT')).rejects.toThrow(/globally consecutive/i);
    } finally {
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });

  it('keeps per-stream callback order and withholds DRAINED until both slow streams consume output', async () => {
    const stdoutRelease = deferred<void>();
    const stderrRelease = deferred<void>();
    const seen: Record<'stdout' | 'stderr', number[]> = { stdout: [], stderr: [] };
    const source = outputTransportSource([
      { stream: 'stdout', data: Buffer.from([1]) },
      { stream: 'stderr', data: Buffer.from([11]) },
      { stream: 'stdout', data: Buffer.from([2]) },
      { stream: 'stderr', data: Buffer.from([12]) },
      { stream: 'stdout', data: Buffer.from([3]) },
      { stream: 'stderr', data: Buffer.from([13]) },
    ]);
    const child = spawn(process.execPath, ['-e', source], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const processHandle = new WindowsSupervisorProcess(child, 15_000, {
      onOutput: async (stream, chunk) => {
        seen[stream].push(chunk[0]);
        if (seen[stream].length === 1) {
          await (stream === 'stdout' ? stdoutRelease.promise : stderrRelease.promise);
        }
      },
      onFailure: () => undefined,
    });

    try {
      await processHandle.next('BOUND');
      await processHandle.next('ARMED');
      await processHandle.next('STARTED');
      const result = processHandle.next('RESULT');
      let resultSettled = false;
      void result.then(
        () => {
          resultSettled = true;
        },
        () => {
          resultSettled = true;
        },
      );
      for (
        let index = 0;
        index < 20 && (seen.stdout.length < 1 || seen.stderr.length < 1);
        index += 1
      ) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(resultSettled).toBe(false);
      expect(seen).toEqual({ stdout: [1], stderr: [11] });

      stdoutRelease.resolve();
      for (let index = 0; index < 20 && seen.stdout.length < 3; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(resultSettled).toBe(false);
      expect(seen.stdout).toEqual([1, 2, 3]);

      stderrRelease.resolve();
      await expect(result).resolves.toMatchObject({ code: 0 });
      await expect(processHandle.next('DRAINED')).resolves.toMatchObject({ type: 'DRAINED' });
      expect(seen.stderr).toEqual([11, 12, 13]);
      expect(processHandle.stdout).toEqual([]);
      expect(processHandle.stderr).toEqual([]);
    } finally {
      stdoutRelease.resolve();
      stderrRelease.resolve();
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });

  it('sends no false consumption ACK when the root exits before a delayed callback rejects', async () => {
    let failures = 0;
    let callbackStarted = false;
    const sink = rejectable<void>();
    const source = terminationSettledTransportSource();
    const child = spawn(process.execPath, ['-e', source], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const processHandle = new WindowsSupervisorProcess(
      child,
      15_000,
      {
        onOutput: () => {
          callbackStarted = true;
          return sink.promise;
        },
        onFailure: () => {
          failures += 1;
        },
      },
      OPERATION_ID,
    );

    try {
      await processHandle.next('BOUND');
      await processHandle.next('ARMED');
      await processHandle.next('STARTED');
      await processHandle.next('RESULT');
      for (let index = 0; index < 20 && !callbackStarted; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(callbackStarted).toBe(true);
      sink.reject(new Error('sink rejected after root exit'));
      for (let index = 0; index < 20 && failures === 0; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      await processHandle.send({
        schemaVersion: 1,
        type: 'TERMINATE',
        operationId: OPERATION_ID,
      });
      await expect(processHandle.next('DRAINED')).resolves.toMatchObject({ type: 'DRAINED' });
      expect(failures).toBe(1);
      expect(processHandle.stdout).toEqual([]);
      expect(processHandle.stderr).toEqual([]);
    } finally {
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });

  it('sends TERMINATE without a late ACK when cancellation releases a blocked callback', async () => {
    const sink = deferred<void>();
    let callbackStarted = false;
    const child = spawn(process.execPath, ['-e', terminationSettledTransportSource()], {
      shell: false,
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const processHandle = new WindowsSupervisorProcess(
      child,
      15_000,
      {
        onOutput: async () => {
          callbackStarted = true;
          await sink.promise;
        },
        onFailure: () => undefined,
      },
      OPERATION_ID,
    );

    try {
      await processHandle.next('BOUND');
      await processHandle.next('ARMED');
      await processHandle.next('STARTED');
      await processHandle.next('RESULT');
      for (let index = 0; index < 20 && !callbackStarted; index += 1) {
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(callbackStarted).toBe(true);
      sink.resolve();
      processHandle.discardOutput();
      await processHandle.send({
        schemaVersion: 1,
        type: 'TERMINATE',
        operationId: OPERATION_ID,
      });
      await expect(processHandle.next('DRAINED')).resolves.toMatchObject({ type: 'DRAINED' });
    } finally {
      sink.resolve();
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });
});
