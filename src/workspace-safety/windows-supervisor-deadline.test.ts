import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { MonotonicDeadline } from './deadline.js';
import { WindowsSupervisorProcess } from './windows-supervisor-protocol.js';

const OPERATION_ID = '00000000-0000-4000-8000-000000000020';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function protocolPrefix(): string {
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
  return [
    'const send=(value)=>process.stdout.write(`${JSON.stringify(value)}\\n`);',
    `send({schemaVersion:1,type:'BOUND',supervisorPid:410,supervisorIdentity:'133700000000000000',helperDigest:${JSON.stringify(DIGEST)}});`,
    "send({schemaVersion:1,type:'ARMED',containment:{platform:'windows-job-v1',targetPid:510,targetIdentity:'133700000000000001'}});",
    "send({schemaVersion:1,type:'STARTED',targetPid:510});",
    "send({schemaVersion:1,type:'RESULT',code:0,signal:null});",
    `const drained=${JSON.stringify(drainedMessage)};`,
  ].join('');
}

function fakeSupervisor(source: string): WindowsSupervisorProcess {
  const child = spawn(process.execPath, ['-e', source], {
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
  return new WindowsSupervisorProcess(child, 5000);
}

async function consumeThroughResult(processHandle: WindowsSupervisorProcess): Promise<void> {
  await processHandle.next('BOUND');
  await processHandle.next('ARMED');
  await processHandle.next('STARTED');
  await processHandle.next('RESULT');
}

async function consumeThroughDrained(processHandle: WindowsSupervisorProcess): Promise<void> {
  await consumeThroughResult(processHandle);
  await processHandle.next('DRAINED');
}

describe('Windows supervisor parent deadline contract', () => {
  it('bounds an alive helper that never emits DRAINED', async () => {
    const processHandle = fakeSupervisor(
      `${protocolPrefix()}process.stdin.resume();setInterval(()=>{},1000);`,
    );
    try {
      await consumeThroughResult(processHandle);
      const deadline = MonotonicDeadline.after(80);
      const pending = processHandle.nextAny(['DRAINED'], null);
      await expect(
        processHandle.racePendingBefore(pending, deadline, 'termination and drain'),
      ).rejects.toThrow(/termination and drain timed out/u);
      await expect(
        processHandle.nextBefore(['DRAINED'], MonotonicDeadline.after(20), 'second drain wait'),
      ).rejects.toThrow(/second drain wait timed out/u);
    } finally {
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });

  it('reuses one pending event after termination wins and releases it on closeout timeout', async () => {
    const processHandle = fakeSupervisor(
      `${protocolPrefix()}process.stdin.resume();setInterval(()=>{},1000);`,
    );
    try {
      await consumeThroughResult(processHandle);
      const pending = processHandle.nextAny(['DRAINED'], null);
      const deadline = MonotonicDeadline.after(80);
      await expect(
        processHandle.racePendingBefore(
          pending,
          deadline,
          'termination and drain',
          Promise.resolve('user-interrupt'),
        ),
      ).resolves.toEqual({ kind: 'termination', reason: 'user-interrupt' });
      await expect(
        processHandle.racePendingBefore(pending, deadline, 'termination and drain'),
      ).rejects.toThrow(/termination and drain timed out/u);
      await expect(
        processHandle.nextBefore(['DRAINED'], MonotonicDeadline.after(20), 'released waiter'),
      ).rejects.toThrow(/released waiter timed out/u);
    } finally {
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });

  it('rejects and releases an active pending event when the parent aborts', async () => {
    const processHandle = fakeSupervisor(
      `${protocolPrefix()}process.stdin.resume();setInterval(()=>{},1000);`,
    );
    await consumeThroughResult(processHandle);
    const pending = processHandle.nextAny(['DRAINED'], null);
    const rejected = expect(pending).rejects.toThrow(/supervisor aborted/u);

    await processHandle.abort(MonotonicDeadline.after(5000));
    await rejected;
    await expect(processHandle.nextAny(['DRAINED'], null)).rejects.toThrow();
  });

  it('does not start a new wait after the owning phase expired', async () => {
    const processHandle = fakeSupervisor(
      `${protocolPrefix()}process.stdin.resume();setInterval(()=>{},1000);`,
    );
    await consumeThroughResult(processHandle);
    const pending = processHandle.nextAny(['DRAINED'], null);
    const rejected = expect(pending).rejects.toThrow(/supervisor aborted/u);
    const deadline = MonotonicDeadline.after(0);
    const startedAt = performance.now();

    await processHandle.abort(deadline);

    expect(performance.now() - startedAt).toBeLessThan(50);
    await rejected;
  });

  it('uses one ACK/exit budget when the helper accepts ACK but never exits', async () => {
    const processHandle = fakeSupervisor(
      `${protocolPrefix()}send({schemaVersion:1,type:'DRAINED',messageBase64:drained});process.stdin.resume();setInterval(()=>{},1000);`,
    );
    try {
      await consumeThroughDrained(processHandle);
      processHandle.expectCleanExit();
      const deadline = MonotonicDeadline.after(100);
      await processHandle.sendBefore({ schemaVersion: 1, type: 'ACK' }, deadline, 'ACK delivery');
      await expect(processHandle.waitForCleanExit(deadline)).rejects.toThrow(
        /supervisor exit after ACK timed out/u,
      );
    } finally {
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });

  it('does not reset the ACK/exit budget when the process exits but stdout remains open', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-windows-output-deadline-'));
    roots.push(root);
    const holderPidPath = join(root, 'holder.pid');
    const source = [
      protocolPrefix(),
      "send({schemaVersion:1,type:'DRAINED',messageBase64:drained});",
      "process.stdin.once('data',()=>{",
      "const {spawn}=require('node:child_process');const fs=require('node:fs');",
      `const holder=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{detached:true,stdio:['ignore',process.stdout,'ignore']});`,
      `fs.writeFileSync(${JSON.stringify(holderPidPath)},String(holder.pid));`,
      'holder.unref();process.exit(0);});process.stdin.resume();',
    ].join('');
    const processHandle = fakeSupervisor(source);

    try {
      await consumeThroughDrained(processHandle);
      processHandle.expectCleanExit();
      const deadline = MonotonicDeadline.after(150);
      await processHandle.sendBefore({ schemaVersion: 1, type: 'ACK' }, deadline, 'ACK delivery');
      await expect(processHandle.waitForCleanExit(deadline)).rejects.toThrow(
        /stdout close after ACK timed out/u,
      );
    } finally {
      if (existsSync(holderPidPath)) {
        const holderPid = Number(readFileSync(holderPidPath, 'utf8'));
        if (Number.isSafeInteger(holderPid) && holderPid > 0) {
          try {
            process.kill(holderPid);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
          }
        }
      }
      await processHandle.abort(MonotonicDeadline.after(5000));
    }
  });
});
