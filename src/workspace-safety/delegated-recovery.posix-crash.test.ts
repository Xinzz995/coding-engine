import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { waitForPosixProcessGroupEmpty } from './posix-containment.js';
import { DRAINED_RECEIPT_FILE } from './operation-records.js';
import { parseQuarantineRecord, QUARANTINE_FILE } from './quarantine.js';
import { parseDrainedReceipt } from './supervisor-protocol.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR, RECOVERY_DIR } from './types.js';

const roots: string[] = [];
const workers = new Set<ChildProcessWithoutNullStreams>();
const groups = new Set<number>();
const workerPath = fileURLToPath(
  new URL('./__fixtures__/delegated-recovery-crash-worker.ts', import.meta.url),
);

afterEach(async () => {
  for (const worker of workers) worker.kill('SIGKILL');
  workers.clear();
  for (const pgid of groups) {
    try {
      process.kill(-pgid, 'SIGKILL');
    } catch {
      // Already empty is the expected successful path.
    }
  }
  groups.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

async function waitUntil(predicate: () => boolean, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for delegated recovery fact');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

function startWorker(args: readonly string[]): {
  child: ChildProcessWithoutNullStreams;
  line: Promise<Record<string, unknown>>;
  stderr: () => string;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, PATH: process.env.PATH ?? '/usr/bin:/bin' },
  });
  workers.add(child);
  let stdout = '';
  let stderr = '';
  child.stdout.setEncoding('utf8');
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const line = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`worker output timed out: ${stderr}`)), 15_000);
    child.stdout.on('data', (chunk: string) => {
      stdout += chunk;
      const newline = stdout.indexOf('\n');
      if (newline < 0) return;
      clearTimeout(timer);
      try {
        resolve(JSON.parse(stdout.slice(0, newline)) as Record<string, unknown>);
      } catch (error) {
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
    child.once('error', reject);
    child.once('exit', (code, signal) => {
      if (!stdout.includes('\n')) {
        clearTimeout(timer);
        reject(new Error(`worker exited ${String(code)}/${String(signal)}: ${stderr}`));
      }
    });
  });
  return { child, line, stderr: () => stderr };
}

describe.runIf(process.platform !== 'win32')('delegated recovery after a real parent crash', () => {
  it.each(['legal', 'forbidden'] as const)(
    'uses real dead-owner and empty-containment proofs for a %s delta',
    async (delta) => {
      const workspace = mkdtempSync(join(tmpdir(), `coding-x-delegated-${delta}-`));
      roots.push(workspace);
      const parent = startWorker(['parent', workspace, delta]);
      const started = await parent.line;
      expect(started.type).toBe('started');
      const pgid = Number(started.pgid);
      const supervisorPid = Number(started.supervisorPid);
      const markerPath = String(started.markerPath);
      roots.push(String(started.markerRoot));
      groups.add(pgid);
      await waitUntil(() => existsSync(markerPath));

      expect(parent.child.kill('SIGKILL')).toBe(true);
      await once(parent.child, 'exit');
      workers.delete(parent.child);

      const operationPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
      const receiptPath = join(operationPath, DRAINED_RECEIPT_FILE);
      await waitUntil(() => existsSync(receiptPath));
      await waitUntil(() => {
        try {
          process.kill(supervisorPid, 0);
          return false;
        } catch (error) {
          return (error as NodeJS.ErrnoException).code === 'ESRCH';
        }
      });
      expect(await waitForPosixProcessGroupEmpty(pgid, 5000, 20)).toBe(true);
      groups.delete(pgid);
      expect(parseDrainedReceipt(readFileSync(receiptPath))).toMatchObject({
        proof: 'posix-group-empty-and-pipes-eof-v1',
        drainReason: 'parent-shutdown',
      });
      expect(parent.stderr()).toBe('');

      const recovery = startWorker(['recover', workspace]);
      const result = await recovery.line;
      const [exitCode] = (await once(recovery.child, 'exit')) as [number | null];
      workers.delete(recovery.child);
      expect(exitCode).toBe(0);
      expect(recovery.stderr()).toBe('');

      if (delta === 'legal') {
        expect(result.type).toBe('completed');
        expect(result.candidateDigest).toMatch(/^sha256:[0-9a-f]{64}$/u);
        expect(existsSync(String(result.archivePath))).toBe(true);
        expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(false);
      } else {
        expect(result).toMatchObject({
          type: 'rejected',
          code: 'isolated',
          quarantine: {
            reason: 'workspace-integrity-violation',
            creator: { kind: 'recovery-attempt' },
          },
        });
        expect(existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR))).toBe(true);
        expect(
          parseQuarantineRecord(readFileSync(join(operationPath, QUARANTINE_FILE))).reason,
        ).toBe('workspace-integrity-violation');
      }
    },
    40_000,
  );

  it('permanently rejects recovery when an opaque POSIX runner loses its real parent over IPC', async () => {
    const workspace = mkdtempSync(join(tmpdir(), 'coding-x-delegated-opaque-parent-crash-'));
    roots.push(workspace);
    const parent = startWorker(['parent-opaque', workspace, 'legal']);
    const started = await parent.line;
    expect(started.type).toBe('started');
    const pgid = Number(started.pgid);
    const supervisorPid = Number(started.supervisorPid);
    const markerPath = String(started.markerPath);
    roots.push(String(started.markerRoot));
    groups.add(pgid);
    await waitUntil(() => existsSync(markerPath));

    expect(parent.child.kill('SIGKILL')).toBe(true);
    await once(parent.child, 'exit');
    workers.delete(parent.child);

    const operationPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
    const receiptPath = join(operationPath, DRAINED_RECEIPT_FILE);
    await waitUntil(() => {
      try {
        process.kill(supervisorPid, 0);
        return false;
      } catch (error) {
        return (error as NodeJS.ErrnoException).code === 'ESRCH';
      }
    });
    expect(await waitForPosixProcessGroupEmpty(pgid, 5000, 20)).toBe(true);
    groups.delete(pgid);
    expect(parent.stderr()).toBe('');
    const beforeRecovery = {
      operationExists: existsSync(operationPath),
      receiptExists: existsSync(receiptPath),
    };

    const recovery = startWorker(['recover', workspace]);
    const result = await recovery.line;
    const [exitCode] = (await once(recovery.child, 'exit')) as [number | null];
    workers.delete(recovery.child);
    expect(exitCode).toBe(0);
    expect(recovery.stderr()).toBe('');
    expect({
      beforeRecovery,
      result,
      activeLeaseExists: existsSync(join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR)),
      recoveryClaimExists: existsSync(
        join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, RECOVERY_DIR),
      ),
    }).toMatchObject({
      beforeRecovery: { operationExists: true, receiptExists: false },
      result: {
        type: 'rejected',
        code: 'isolated',
        message: expect.stringContaining('operation-proof-missing'),
        quarantine: null,
      },
      activeLeaseExists: true,
      recoveryClaimExists: false,
    });
  }, 40_000);
});
