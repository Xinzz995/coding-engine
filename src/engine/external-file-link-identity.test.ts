import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManagedProcessTestSession } from './managed-process-test-support.js';
import {
  ExternalFileLinkSnapshotBudget,
  ExternalFileLinkSnapshotBudgetError,
  canSnapshotExternalFileLinks,
  isExternalFileSystemMagicOrRemote,
  sameExternalFileLinkIdentity,
  snapshotManagedExternalFileLink,
  type ExternalFileLinkIdentity,
} from './external-file-link-identity.js';

describe('external file link identity', () => {
  it('requires both the raw link target and target content digests to remain unchanged', () => {
    const stat = {
      dev: 1n,
      ino: 2n,
      uid: 3n,
      mode: 0o100755n,
      size: 9n,
      mtimeNs: 4n,
      ctimeNs: 5n,
    };
    const captured = {
      resolvedPath: '/external/tool',
      link: { ...stat, ino: 6n, size: 14n },
      linkTargetDigest: 'link-target',
      target: stat,
      targetDigest: 'original-content',
    } satisfies ExternalFileLinkIdentity;

    expect(sameExternalFileLinkIdentity(captured, structuredClone(captured))).toBe(true);
    expect(
      sameExternalFileLinkIdentity(captured, {
        ...captured,
        linkTargetDigest: 'changed-link-target',
      }),
    ).toBe(false);
    expect(
      sameExternalFileLinkIdentity(captured, {
        ...captured,
        targetDigest: 'changed-content',
      }),
    ).toBe(false);
  });
});

describe('external file link snapshot budget', () => {
  const limits = {
    maxLinks: 2,
    maxUniqueTargetBytes: 10,
    deadlineMs: 30,
  };

  it('counts every link but charges duplicate stable targets only once', () => {
    const budget = new ExternalFileLinkSnapshotBudget(limits, undefined, () => 0);
    budget.countLink();
    budget.countLink();
    expect(budget.reserveTarget('same-target', 8)).toBe(true);
    expect(budget.reserveTarget('same-target', 8)).toBe(false);
    expect(() => budget.countLink()).toThrow(/超过 2 条/u);
    expect(() => budget.reserveTarget('different-target', 3)).toThrow(/累计超过 10 bytes/u);
  });

  it('uses one absolute deadline and checks interruption at every checkpoint', () => {
    let now = 100;
    const timed = new ExternalFileLinkSnapshotBudget(limits, undefined, () => now);
    timed.checkpoint();
    now = 110;
    expect(timed.remainingMs()).toBe(20);
    now = 131;
    expect(() => timed.checkpoint()).toThrow(ExternalFileLinkSnapshotBudgetError);
    expect(() => timed.checkpoint()).toThrow(/统一期限/u);

    const controller = new AbortController();
    const interrupted = new ExternalFileLinkSnapshotBudget(limits, controller.signal, () => 0);
    controller.abort();
    expect(() => interrupted.reserveTarget('target', 1)).toThrow(/被中断/u);
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'rejects a platform magic link before its target can be canonicalized',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-external-proc-'));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const linkPath = join(checkoutRoot, 'runtime');
      symlinkSync(process.platform === 'linux' ? '/proc/self/exe' : '/dev/fd/1', linkPath);
      const managed = await createManagedProcessTestSession();
      try {
        const budget = new ExternalFileLinkSnapshotBudget({
          maxLinks: 1,
          maxUniqueTargetBytes: 1024,
          deadlineMs: 5_000,
        });
        await expect(
          snapshotManagedExternalFileLink({
            linkPath,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024 * 1024,
            budget,
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).rejects.toThrow(/magic, virtual or remote filesystem/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'captures an ordinary external file with the built-in production reader',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-external-happy-'));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const target = join(root, 'target');
      const linkPath = join(checkoutRoot, 'target');
      writeFileSync(target, 'content\n');
      symlinkSync(target, linkPath);
      const managed = await createManagedProcessTestSession();
      try {
        const budget = new ExternalFileLinkSnapshotBudget({
          maxLinks: 1,
          maxUniqueTargetBytes: 1024,
          deadlineMs: 5_000,
        });
        const observed = await snapshotManagedExternalFileLink({
          linkPath,
          checkoutRoot,
          sourceRoot,
          maxFileBytes: 1024,
          budget,
          session: managed.session,
          kind: 'quality-check',
          cwd: checkoutRoot,
        });
        expect(observed).toMatchObject({
          scope: 'external',
          identity: {
            resolvedPath: realpathSync.native(target),
            targetDigest: createHash('sha256').update('content\n').digest('hex'),
          },
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'bounds a blocked content reader by the same deadline',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-external-reader-'));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const target = join(root, 'target');
      const linkPath = join(checkoutRoot, 'target');
      writeFileSync(target, 'content\n');
      symlinkSync(target, linkPath);
      const managed = await createManagedProcessTestSession();
      const startedAt = performance.now();
      try {
        const budget = new ExternalFileLinkSnapshotBudget({
          maxLinks: 1,
          maxUniqueTargetBytes: 1024,
          deadlineMs: 100,
        });
        await expect(
          snapshotManagedExternalFileLink({
            linkPath,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget,
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
            readerProgramForTests: 'setInterval(() => {}, 1000)',
          }),
        ).rejects.toThrow(/统一期限/u);
        expect(performance.now() - startedAt).toBeLessThan(5_000);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform !== 'win32')(
    'rejects a reader result that does not prove EOF after the declared size',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-external-eof-'));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const linkPath = join(checkoutRoot, 'target');
      const target = join(root, 'target');
      writeFileSync(target, 'content\n');
      symlinkSync(target, linkPath);
      const stat = {
        dev: '1',
        ino: '2',
        uid: '3',
        mode: '33188',
        size: '8',
        mtimeNs: '4',
        ctimeNs: '5',
      };
      const output = JSON.stringify({
        schemaVersion: 1,
        scope: 'external',
        resolvedPath: target,
        link: stat,
        linkTargetDigest: 'a'.repeat(64),
        target: stat,
        bytesRead: 8,
        eof: false,
        targetDigest: 'b'.repeat(64),
      });
      const managed = await createManagedProcessTestSession();
      try {
        const budget = new ExternalFileLinkSnapshotBudget({
          maxLinks: 1,
          maxUniqueTargetBytes: 1024,
          deadlineMs: 5_000,
        });
        await expect(
          snapshotManagedExternalFileLink({
            linkPath,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget,
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
            readerProgramForTests: `process.stdout.write(${JSON.stringify(output)})`,
          }),
        ).rejects.toThrow(/精确大小和 EOF/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it('fails closed for unverified Windows reparse points', () => {
    expect(canSnapshotExternalFileLinks('win32')).toBe(false);
    expect(canSnapshotExternalFileLinks('linux')).toBe(true);
    expect(canSnapshotExternalFileLinks('darwin')).toBe(true);
  });

  it('rejects known Linux and macOS magic or remote filesystems without an allowlist', () => {
    expect(isExternalFileSystemMagicOrRemote('linux', 0x9fa0n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('linux', 0x65735546n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('linux', 0x6969n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('linux', 0xef53n)).toBe(false);
    expect(isExternalFileSystemMagicOrRemote('linux', 0x01021994n)).toBe(false);
    expect(isExternalFileSystemMagicOrRemote('darwin', 19n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('darwin', 26n)).toBe(false);
    expect(isExternalFileSystemMagicOrRemote('freebsd', 0x9fa0n)).toBe(false);
  });
});
