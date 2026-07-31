import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import {
  createCrossProcessFixtureTracker,
  typeScriptFixtureNodeArgs,
} from './cross-process-fixture.test-support.js';
import { digestBytes, jsonBytes, readExactFile } from './filesystem.js';
import {
  ABORT_STAGING_PATTERN,
  DRAINED_RECEIPT_FILE,
  PRESTART_ABORT_FILE,
  RECEIPT_STAGING_PATTERN,
  parsePrestartAbortRecord,
  readOperationInstalledFact,
  recoverOperationInstalledFact,
} from './operation-records.js';
import {
  QUARANTINE_FILE,
  createQuarantineRecordBytes,
  readQuarantinePresence,
  recoverLinkedQuarantineInstall,
} from './quarantine.js';
import { parseDrainedReceipt } from './supervisor-protocol.js';

const OWNER_ID = '123e4567-e89b-42d3-a456-426614174000';
const OPERATION_ID = '223e4567-e89b-42d3-a456-426614174000';
const DIGEST = `sha256:${'a'.repeat(64)}`;
const roots: string[] = [];
const fixtureProcesses = createCrossProcessFixtureTracker();
const worker = fileURLToPath(
  new URL('./__fixtures__/linked-file-install-crash-worker.ts', import.meta.url),
);

afterEach(async () => {
  try {
    await fixtureProcesses.settle();
  } finally {
    for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  }
});

async function leaveHardCrashWindow(source: string, target: string): Promise<void> {
  const child = fixtureProcesses.track(
    spawn(process.execPath, typeScriptFixtureNodeArgs(worker, [source, target]), {
      stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
      env: { ...process.env },
    }),
  );
  let stderr = '';
  child.stderr?.setEncoding('utf8');
  child.stderr?.on('data', (chunk: string) => {
    stderr += chunk;
  });
  const [message] = (await once(child, 'message')) as [unknown];
  expect(message).toEqual({ schemaVersion: 1, type: 'LINKED' });
  expect(statSync(source).nlink).toBe(2);
  expect(statSync(target).nlink).toBe(2);
  child.kill('SIGKILL');
  await once(child, 'exit');
  expect(stderr).toBe('');
}

function operationRoot(): string {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-linked-hard-crash-'));
  roots.push(root);
  return root;
}

function receiptBytes(): Buffer {
  return jsonBytes({
    schemaVersion: 1,
    ownerId: OWNER_ID,
    operationId: OPERATION_ID,
    ownerRecordDigest: DIGEST,
    protocolDigest: DIGEST,
    activeChildDigest: DIGEST,
    delegatedBaselineDigest: DIGEST,
    delegationContractDigest: DIGEST,
    containmentDigest: DIGEST,
    helperDigest: DIGEST,
    supervisorIdentity: 'linux:1:1',
    proof: 'posix-group-empty-and-pipes-eof-v1',
    drainReason: 'natural',
    drainedAt: '2026-07-30T00:00:00.000Z',
  });
}

describe('real hard-crash linked install recovery', () => {
  it.each([
    {
      label: 'drained receipt',
      canonical: DRAINED_RECEIPT_FILE,
      staging: `drained-receipt.prepare-${OPERATION_ID}.json`,
      pattern: RECEIPT_STAGING_PATTERN,
      bytes: receiptBytes(),
      parse: parseDrainedReceipt,
    },
    {
      label: 'prestart abort',
      canonical: PRESTART_ABORT_FILE,
      staging: `prestart-abort.prepare-${OPERATION_ID}.json`,
      pattern: ABORT_STAGING_PATTERN,
      bytes: jsonBytes({
        schemaVersion: 1,
        ownerId: OWNER_ID,
        operationId: OPERATION_ID,
        activeChildDigest: DIGEST,
        delegatedBaselineDigest: DIGEST,
        reason: 'setup-failed',
        proof: 'supervisor-never-bound-v1',
        prestartDrainedDigest: null,
        abortedAt: '2026-07-30T00:00:00.000Z',
      }),
      parse: parsePrestartAbortRecord,
    },
  ])(
    'recovers a $label only after replacement authority validates exact bytes',
    async (fixture) => {
      const root = operationRoot();
      const source = join(root, fixture.staging);
      const target = join(root, fixture.canonical);
      writeFileSync(source, fixture.bytes, { flag: 'wx', mode: 0o600 });
      await leaveHardCrashWindow(source, target);

      const observed = await readOperationInstalledFact({
        operationPath: root,
        canonicalName: fixture.canonical,
        stagingPattern: fixture.pattern,
        maxBytes: 64 * 1024,
      });
      fixture.parse(observed.bytes);
      let authorityChecks = 0;
      await recoverOperationInstalledFact({
        source: observed.linkedSource!,
        target,
        expectedBytes: observed.bytes,
        authorize: () => {
          authorityChecks += 1;
          expect(digestBytes(observed.bytes)).toBe(digestBytes(fixture.bytes));
        },
      });
      expect(authorityChecks).toBe(2);
      expect(statSync(target).nlink).toBe(1);
      await expect(readExactFile(target)).resolves.toEqual(fixture.bytes);
    },
  );

  it('recovers the same real hard-crash window for a bound quarantine', async () => {
    const root = operationRoot();
    const bytes = createQuarantineRecordBytes({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      activeChildDigest: DIGEST,
      delegatedBaselineDigest: DIGEST,
      creator: { kind: 'owner', id: OWNER_ID, recordDigest: DIGEST },
      reason: 'operation-proof-missing',
      priorQuarantineDigest: null,
      createdAt: '2026-07-30T00:00:00.000Z',
    });
    const source = join(
      root,
      `quarantine.prepare-${OWNER_ID}-323e4567-e89b-42d3-a456-426614174000.json`,
    );
    const target = join(root, QUARANTINE_FILE);
    writeFileSync(source, bytes, { flag: 'wx', mode: 0o600 });
    await leaveHardCrashWindow(source, target);

    const observed = await readQuarantinePresence(root);
    expect(observed.canonical?.record).toMatchObject({
      ownerId: OWNER_ID,
      operationId: OPERATION_ID,
      reason: 'operation-proof-missing',
    });
    let authorityChecks = 0;
    await recoverLinkedQuarantineInstall({
      containerPath: root,
      linkedSource: observed.canonical!.linkedSource!,
      expectedBytes: observed.canonical!.bytes,
      verifyAuthority: () => {
        authorityChecks += 1;
      },
    });
    expect(authorityChecks).toBe(2);
    expect(statSync(target).nlink).toBe(1);
    await expect(readExactFile(target)).resolves.toEqual(bytes);
  });
});
