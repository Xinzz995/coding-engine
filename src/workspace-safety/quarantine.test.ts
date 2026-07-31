import { linkSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { digestBytes } from './filesystem.js';
import {
  QUARANTINE_FILE,
  createQuarantineRecordBytes,
  installQuarantineNoReplace,
  parseQuarantineRecord,
  readQuarantinePresence,
  recoverLinkedQuarantineInstall,
  upgradeContainmentQuarantine,
} from './quarantine.js';
import { WorkspaceSafetyError } from './types.js';

const created: string[] = [];
const ownerId = '123e4567-e89b-42d3-a456-426614174000';
const operationId = '223e4567-e89b-42d3-a456-426614174000';
const attemptId = '323e4567-e89b-42d3-a456-426614174000';
const attemptIdB = '423e4567-e89b-42d3-a456-426614174000';
const digest = `sha256:${'a'.repeat(64)}`;

afterEach(async () => {
  const { rm } = await import('node:fs/promises');
  await Promise.all(created.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});

function container(): string {
  const path = mkdtempSync(join(tmpdir(), 'coding-x-quarantine-'));
  created.push(path);
  return path;
}

function bytes(
  reason: 'containment-unconfirmed' | 'operation-proof-missing' | 'workspace-integrity-violation',
  overrides: Partial<Parameters<typeof createQuarantineRecordBytes>[0]> = {},
): Buffer {
  return createQuarantineRecordBytes({
    ownerId,
    operationId,
    activeChildDigest: digest,
    delegatedBaselineDigest: digest,
    creator: { kind: 'owner', id: ownerId, recordDigest: digest },
    reason,
    priorQuarantineDigest: null,
    createdAt: '2026-07-30T00:00:00.000Z',
    ...overrides,
  });
}

describe('quarantine safety record', () => {
  it('round-trips an exact bounded operation binding without retaining diagnostics', () => {
    const parsed = parseQuarantineRecord(bytes('containment-unconfirmed'));
    expect(parsed).toMatchObject({ ownerId, operationId, reason: 'containment-unconfirmed' });
    expect(JSON.stringify(parsed)).not.toMatch(/argv|prompt|stdout|stderr|secret/i);
  });

  it('requires operation identity and frozen digests as one complete binding', () => {
    expect(() =>
      bytes('containment-unconfirmed', {
        operationId: null,
        activeChildDigest: digest,
        delegatedBaselineDigest: null,
      }),
    ).toThrow(/present or absent together/i);
    expect(() =>
      parseQuarantineRecord(
        Buffer.from(
          JSON.stringify({
            ...JSON.parse(bytes('containment-unconfirmed').toString('utf8')),
            unknown: true,
          }),
        ),
      ),
    ).toThrow(/unknown field/i);
    expect(() =>
      bytes('containment-unconfirmed', {
        creator: { kind: 'owner', id: attemptId, recordDigest: digest },
      }),
    ).toThrow(/bind the quarantine ownerId/i);
    expect(() =>
      bytes('containment-unconfirmed', {
        creator: { kind: 'recovery-attempt', id: attemptId, recordDigest: digest },
      }),
    ).toThrow(/only create an integrity quarantine/i);
  });

  it('accepts both direct and prior-bound recovery-attempt integrity records', async () => {
    const direct = bytes('workspace-integrity-violation', {
      creator: { kind: 'recovery-attempt', id: attemptId, recordDigest: digest },
    });
    expect(parseQuarantineRecord(direct)).toMatchObject({
      creator: { kind: 'recovery-attempt', id: attemptId },
      reason: 'workspace-integrity-violation',
      priorQuarantineDigest: null,
    });
    const directPath = container();
    await installQuarantineNoReplace({
      containerPath: directPath,
      recordBytes: direct,
      verifyAuthority: () => undefined,
    });
    expect(readFileSync(join(directPath, QUARANTINE_FILE))).toEqual(direct);

    const prior = bytes('containment-unconfirmed');
    const upgrade = bytes('workspace-integrity-violation', {
      creator: { kind: 'recovery-attempt', id: attemptId, recordDigest: digest },
      priorQuarantineDigest: digestBytes(prior),
    });
    expect(parseQuarantineRecord(upgrade).priorQuarantineDigest).toBe(digestBytes(prior));
  });

  it('rejects malformed, duplicate-key, oversized, and unsupported records', () => {
    expect(() => parseQuarantineRecord('{"schemaVersion":1,"schemaVersion":1}')).toThrow(
      /duplicate/i,
    );
    expect(() => parseQuarantineRecord(Buffer.alloc(64 * 1024 + 1, 0x20))).toThrow(/too large/i);
    expect(() => bytes('containment-unconfirmed', { priorQuarantineDigest: digest })).toThrow(
      /only an integrity violation/i,
    );
    expect(() =>
      parseQuarantineRecord(
        Buffer.from(bytes('containment-unconfirmed').toString('utf8').replace(ownerId, 'bad-id')),
      ),
    ).toThrow(/canonical UUID/i);
  });

  it('installs once with authority checks on both sides of staging', async () => {
    const path = container();
    let checks = 0;
    const source = bytes('operation-proof-missing');
    await installQuarantineNoReplace({
      containerPath: path,
      recordBytes: source,
      verifyAuthority: () => {
        checks += 1;
      },
    });
    expect(checks).toBe(2);
    expect(readFileSync(join(path, QUARANTINE_FILE))).toEqual(source);
    await expect(
      installQuarantineNoReplace({
        containerPath: path,
        recordBytes: source,
        verifyAuthority: () => undefined,
      }),
    ).rejects.toBeInstanceOf(WorkspaceSafetyError);
  });

  it('strictly recognizes and closes the linked quarantine crash window', async () => {
    const path = container();
    const sourceBytes = bytes('operation-proof-missing');
    const staging = join(
      path,
      `quarantine.prepare-${ownerId}-523e4567-e89b-42d3-a456-426614174000.json`,
    );
    const target = join(path, QUARANTINE_FILE);
    writeFileSync(staging, sourceBytes, { flag: 'wx', mode: 0o600 });
    linkSync(staging, target);

    const observed = await readQuarantinePresence(path);
    expect(observed.canonical).toMatchObject({
      bytes: sourceBytes,
      linkedSource: staging,
      record: { operationId, reason: 'operation-proof-missing' },
    });
    let authorityChecks = 0;
    await recoverLinkedQuarantineInstall({
      containerPath: path,
      linkedSource: staging,
      expectedBytes: sourceBytes,
      verifyAuthority: () => {
        authorityChecks += 1;
      },
    });
    expect(authorityChecks).toBe(2);
    expect(statSync(target).nlink).toBe(1);
    expect(readFileSync(target)).toEqual(sourceBytes);
  });

  it('rejects an aliased or misbound quarantine staging window', async () => {
    const path = container();
    const sourceBytes = bytes('operation-proof-missing');
    const staging = join(
      path,
      `quarantine.prepare-${ownerId}-523e4567-e89b-42d3-a456-426614174000.json`,
    );
    writeFileSync(staging, sourceBytes, { flag: 'wx', mode: 0o600 });
    linkSync(staging, join(path, QUARANTINE_FILE));
    linkSync(staging, join(path, 'third-alias.json'));

    await expect(readQuarantinePresence(path)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('only upgrades containment uncertainty to bound integrity failure', async () => {
    const path = container();
    const prior = bytes('containment-unconfirmed');
    await installQuarantineNoReplace({
      containerPath: path,
      recordBytes: prior,
      verifyAuthority: () => undefined,
    });
    const next = bytes('workspace-integrity-violation', {
      creator: { kind: 'recovery-attempt', id: attemptId, recordDigest: digest },
      priorQuarantineDigest: digestBytes(prior),
      createdAt: '2026-07-30T00:01:00.000Z',
    });
    await expect(
      installQuarantineNoReplace({
        containerPath: container(),
        recordBytes: next,
        verifyAuthority: () => undefined,
      }),
    ).rejects.toThrow(/one-way upgrade path/i);
    await upgradeContainmentQuarantine({
      containerPath: path,
      priorBytes: prior,
      recordBytes: next,
      verifyAuthority: () => undefined,
    });
    expect(readFileSync(join(path, QUARANTINE_FILE))).toEqual(next);

    await expect(
      upgradeContainmentQuarantine({
        containerPath: path,
        priorBytes: next,
        recordBytes: next,
        verifyAuthority: () => undefined,
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('serializes competing one-way upgrades and never overwrites the winner', async () => {
    const path = container();
    const prior = bytes('containment-unconfirmed');
    await installQuarantineNoReplace({
      containerPath: path,
      recordBytes: prior,
      verifyAuthority: () => undefined,
    });
    const candidates = [attemptId, attemptIdB].map((id, index) =>
      bytes('workspace-integrity-violation', {
        creator: { kind: 'recovery-attempt', id, recordDigest: digest },
        priorQuarantineDigest: digestBytes(prior),
        createdAt: `2026-07-30T00:0${index + 1}:00.000Z`,
      }),
    );

    const results = await Promise.allSettled(
      candidates.map((recordBytes) =>
        upgradeContainmentQuarantine({
          containerPath: path,
          priorBytes: prior,
          recordBytes,
          verifyAuthority: () => undefined,
        }),
      ),
    );
    const winners = results.flatMap((result, index) =>
      result.status === 'fulfilled' ? [index] : [],
    );
    expect(winners).toHaveLength(1);
    expect(readFileSync(join(path, QUARANTINE_FILE))).toEqual(candidates[winners[0]]);
    expect(readdirSync(path).filter((name) => name.startsWith('quarantine.upgrade-'))).toEqual([]);
  });
});
