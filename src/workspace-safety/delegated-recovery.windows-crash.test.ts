import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { once } from 'node:events';
import { afterEach, describe, expect, it } from 'vitest';
import { DRAINED_RECEIPT_FILE } from './operation-records.js';
import { parseQuarantineRecord, QUARANTINE_FILE } from './quarantine.js';
import { parseDrainedReceipt } from './supervisor-protocol.js';
import { ACTIVE_LEASE_DIR, OPERATION_DIR, PROTOCOL_ROOT_DIR } from './types.js';
import { waitForFile, waitForProcessGone } from './windows-supervisor.test-support.js';

const roots: string[] = [];
const workers = new Set<ChildProcessWithoutNullStreams>();
const workerPath = fileURLToPath(
  new URL('./__fixtures__/delegated-recovery-crash-worker.ts', import.meta.url),
);
const WINDOWS_WORKER_OUTPUT_TIMEOUT_MS = 90_000;

afterEach(() => {
  for (const worker of workers) worker.kill('SIGKILL');
  workers.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function startWorker(
  phase: string,
  args: readonly string[],
): {
  child: ChildProcessWithoutNullStreams;
  line: Promise<Record<string, unknown>>;
  stderr: () => string;
} {
  const child = spawn(process.execPath, ['--import', 'tsx', workerPath, ...args], {
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
    env: { ...process.env, PATH: process.env.PATH ?? '' },
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
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Windows worker ${phase} output timed out after ${WINDOWS_WORKER_OUTPUT_TIMEOUT_MS}ms; stdout=${stdout}; stderr=${stderr}`,
          ),
        ),
      WINDOWS_WORKER_OUTPUT_TIMEOUT_MS,
    );
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
        reject(
          new Error(
            `Windows worker ${phase} exited ${String(code)}/${String(signal)}; stdout=${stdout}; stderr=${stderr}`,
          ),
        );
      }
    });
  });
  return { child, line, stderr: () => stderr };
}

describe.runIf(process.platform === 'win32')(
  'delegated recovery after a real Windows parent crash',
  { timeout: 180_000, concurrent: false },
  () => {
    it.each(['legal', 'forbidden'] as const)(
      'uses the persisted empty-Job proof for a %s delta',
      async (delta) => {
        const workspace = mkdtempSync(join(tmpdir(), `coding-x-delegated-win-${delta}-`));
        roots.push(workspace);
        const parent = startWorker(`parent:${delta}`, ['parent', workspace, delta]);
        const started = await parent.line;
        expect(started).toMatchObject({
          type: 'started',
          containmentPlatform: 'windows-job-v1',
        });
        roots.push(String(started.markerRoot));
        await waitForFile(String(started.markerPath), 60_000);

        expect(parent.child.kill('SIGKILL')).toBe(true);
        await once(parent.child, 'exit');
        workers.delete(parent.child);
        const operationPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
        const receiptPath = join(operationPath, DRAINED_RECEIPT_FILE);
        await waitForFile(receiptPath, 60_000);
        await Promise.all([
          waitForProcessGone(Number(started.supervisorPid), 60_000),
          waitForProcessGone(Number(started.targetPid), 60_000),
        ]);
        expect(parseDrainedReceipt(readFileSync(receiptPath))).toMatchObject({
          proof: 'windows-job-zero-pipes-eof-output-settled-v2',
          drainReason: 'parent-shutdown',
        });
        expect(parent.stderr()).toBe('');

        const recovery = startWorker(`recover:${delta}`, ['recover', workspace]);
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
    );
  },
);
