import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS } from './identity.js';
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
const WINDOWS_PARENT_WORKER_OUTPUT_TIMEOUT_MS = WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS + 30_000;
const WINDOWS_RECOVERY_WORKER_OUTPUT_TIMEOUT_MS = 2 * WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS + 30_000;
const WINDOWS_DELEGATED_RECOVERY_TEST_TIMEOUT_MS =
  WINDOWS_PARENT_WORKER_OUTPUT_TIMEOUT_MS +
  WINDOWS_RECOVERY_WORKER_OUTPUT_TIMEOUT_MS +
  2 * 60_000 +
  30_000;
const SAFE_IDENTITY_RECOVERY_WARNING =
  /^Windows identity snapshot recovered after one bounded retry firstCode=ETIMEDOUT firstStage=(?:powershell-startup|process-read|boot-read|host-read|response-write) firstElapsedMs=(\d{1,6}) totalElapsedMs=(\d{1,6})$/u;

afterEach(() => {
  for (const worker of workers) worker.kill('SIGKILL');
  workers.clear();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function startWorker(
  phase: string,
  args: readonly string[],
  outputTimeoutMs: number,
): {
  child: ChildProcessWithoutNullStreams;
  line: Promise<Record<string, unknown>>;
  closed: Promise<{ readonly code: number | null; readonly signal: NodeJS.Signals | null }>;
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
  const closed = new Promise<{
    readonly code: number | null;
    readonly signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once('close', (code, signal) => resolve({ code, signal }));
  });
  const line = new Promise<Record<string, unknown>>((resolve, reject) => {
    const timer = setTimeout(
      () =>
        reject(
          new Error(
            `Windows worker ${phase} output timed out after ${String(outputTimeoutMs)}ms; stdout=${stdout}; stderr=${stderr}`,
          ),
        ),
      outputTimeoutMs,
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
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code, signal) => {
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
  return { child, line, closed, stderr: () => stderr };
}

function expectOnlySafeIdentityRecoveryWarnings(stderr: string, maximum: number): void {
  const lines = stderr
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  expect(lines.length <= maximum).toBe(true);
  const allSafe = lines.every((line) => {
    const match = SAFE_IDENTITY_RECOVERY_WARNING.exec(line);
    if (!match) return false;
    const firstElapsedMs = Number(match[1]);
    const totalElapsedMs = Number(match[2]);
    return (
      firstElapsedMs < WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS &&
      totalElapsedMs < WINDOWS_IDENTITY_TOTAL_TIMEOUT_MS &&
      firstElapsedMs <= totalElapsedMs
    );
  });
  expect(allSafe).toBe(true);
}

describe.runIf(process.platform === 'win32')(
  'delegated recovery after a real Windows parent crash',
  { timeout: WINDOWS_DELEGATED_RECOVERY_TEST_TIMEOUT_MS, concurrent: false },
  () => {
    it.each(['legal', 'forbidden'] as const)(
      'uses the persisted empty-Job proof for a %s delta',
      async (delta) => {
        const workspace = mkdtempSync(join(tmpdir(), `coding-x-delegated-win-${delta}-`));
        roots.push(workspace);
        const parent = startWorker(
          `parent:${delta}`,
          ['parent', workspace, delta],
          WINDOWS_PARENT_WORKER_OUTPUT_TIMEOUT_MS,
        );
        const started = await parent.line;
        expect(started).toMatchObject({
          type: 'started',
          containmentPlatform: 'windows-job-v1',
        });
        roots.push(String(started.markerRoot));
        await waitForFile(String(started.markerPath), 60_000);

        expect(parent.child.kill('SIGKILL')).toBe(true);
        await parent.closed;
        workers.delete(parent.child);
        const operationPath = join(workspace, PROTOCOL_ROOT_DIR, ACTIVE_LEASE_DIR, OPERATION_DIR);
        const receiptPath = join(operationPath, DRAINED_RECEIPT_FILE);
        await Promise.all([
          waitForFile(receiptPath, 60_000),
          waitForProcessGone(Number(started.supervisorPid), 60_000),
          waitForProcessGone(Number(started.targetPid), 60_000),
        ]);
        expect(parseDrainedReceipt(readFileSync(receiptPath))).toMatchObject({
          proof: 'windows-job-zero-pipes-eof-output-settled-v2',
          drainReason: 'parent-shutdown',
        });
        expectOnlySafeIdentityRecoveryWarnings(parent.stderr(), 1);

        const recovery = startWorker(
          `recover:${delta}`,
          ['recover', workspace],
          WINDOWS_RECOVERY_WORKER_OUTPUT_TIMEOUT_MS,
        );
        const result = await recovery.line;
        const { code: exitCode } = await recovery.closed;
        workers.delete(recovery.child);
        expect(exitCode).toBe(0);
        expectOnlySafeIdentityRecoveryWarnings(recovery.stderr(), 2);

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
