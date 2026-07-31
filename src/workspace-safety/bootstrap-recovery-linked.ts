import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  assertExactFile,
  digestBytes,
  inspectLinkedFileInstall,
  pathExists,
  readExactFile,
} from './filesystem.js';
import {
  RECOVERY_FINAL_MANIFEST_FILE,
  createRecoveryFinalManifestBytes,
  recoveryInvalid,
  type RecoveryClaim,
  type RecoveryState,
} from './recovery-records.js';
import type { BootstrapRecords } from './bootstrap-recovery.js';

const RECOVERY_STAGING = /^recovery\.prepare-[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/u;

async function strictDirectory(path: string, label: string): Promise<string[]> {
  const info = await lstat(path);
  if (info.isSymbolicLink() || !info.isDirectory()) {
    throw recoveryInvalid(`${label} is not an ordinary directory`);
  }
  return await readdir(path);
}

export async function inspectBootstrapFinalManifestInstall(options: {
  readonly records: BootstrapRecords;
  readonly recoveryPath: string;
  readonly claim: RecoveryClaim;
  readonly claimBytes: Buffer;
  readonly state: RecoveryState;
}): Promise<{ bytes?: Buffer; linkedSource?: string }> {
  const expectedBytes = createRecoveryFinalManifestBytes({
    recoveryId: options.claim.recoveryId,
    claimDigest: digestBytes(options.claimBytes),
    workspaceMarkerDigest: digestBytes(options.records.expectedMarkerBytes),
    protocolDigest: digestBytes(options.records.protocolBytes),
    finalSourceSnapshotDigest: options.claim.sourceSnapshotDigest,
    mutationSnapshotDigest: null,
    delegatedCandidateDigest: null,
    createdAt: new Date(options.state.updatedAt),
  });
  const target = join(options.recoveryPath, RECOVERY_FINAL_MANIFEST_FILE);
  const candidates: Array<{
    path: string;
    info: Awaited<ReturnType<typeof lstat>>;
  }> = [];
  for (const entry of await readdir(options.records.activeLeasePath)) {
    if (!RECOVERY_STAGING.test(entry)) continue;
    const staging = join(options.records.activeLeasePath, entry);
    const entries = await strictDirectory(staging, `bootstrap recovery staging ${entry}`);
    if (!entries.includes(RECOVERY_FINAL_MANIFEST_FILE)) continue;
    if (entries.length !== 1) {
      throw recoveryInvalid('bootstrap final-manifest staging must contain exactly one file');
    }
    const path = join(staging, RECOVERY_FINAL_MANIFEST_FILE);
    const info = await lstat(path, { bigint: true });
    if (info.isSymbolicLink() || !info.isFile()) {
      throw recoveryInvalid('bootstrap final-manifest staging is not an ordinary file');
    }
    if (info.nlink === 1n) await assertExactFile(path, expectedBytes);
    else if (info.nlink !== 2n) {
      throw recoveryInvalid('bootstrap final-manifest staging has an unsupported link count');
    }
    candidates.push({ path, info });
  }

  if (!(await pathExists(target))) {
    if (candidates.some((candidate) => candidate.info.nlink !== 1n)) {
      throw recoveryInvalid('linked bootstrap final manifest is missing its target');
    }
    return {};
  }
  const targetInfo = await lstat(target, { bigint: true });
  if (targetInfo.isSymbolicLink() || !targetInfo.isFile()) {
    throw recoveryInvalid('bootstrap final manifest target is not an ordinary file');
  }
  if (targetInfo.nlink === 1n) {
    const bytes = await readExactFile(target);
    if (candidates.some((candidate) => candidate.info.nlink !== 1n)) {
      throw recoveryInvalid('bootstrap final manifest has an unrelated linked staging file');
    }
    return { bytes };
  }
  if (targetInfo.nlink !== 2n) {
    throw recoveryInvalid('bootstrap final manifest target has an unsupported link count');
  }
  const linked = candidates.filter(
    (candidate) => candidate.info.dev === targetInfo.dev && candidate.info.ino === targetInfo.ino,
  );
  if (
    linked.length !== 1 ||
    candidates.some((candidate) => candidate.info.nlink === 2n && candidate.path !== linked[0].path)
  ) {
    throw recoveryInvalid('bootstrap final manifest lacks one controlled staging source');
  }
  await inspectLinkedFileInstall({ source: linked[0].path, target, expectedBytes });
  return { bytes: expectedBytes, linkedSource: linked[0].path };
}
