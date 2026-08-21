import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { createManagedProcessTestSession } from './managed-process-test-support.js';
import {
  ExternalFileLinkSnapshotBudget,
  ExternalFileLinkSnapshotBudgetError,
  canSnapshotExternalFileLinks,
  externalFileLinkSnapshotBudgetMsForTests,
  externalFileLinkReaderProgramForTests,
  isExternalFileSystemMagicOrRemote,
  parseExternalFileLinkBatchSnapshotForTests,
  sameExternalFileLinkIdentity,
  snapshotManagedExternalFileLink,
  snapshotManagedExternalFileLinks,
  snapshotManagedExternalFileLinksWithAdaptiveBudget,
  type ExternalFileLinkIdentity,
} from './external-file-link-identity.js';

describe('external file link identity', () => {
  it('requires both the raw link target and target content digests to remain unchanged', () => {
    const stat = {
      dev: 1n,
      ino: 2n,
      uid: 3n,
      nlink: 1n,
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

describe('external file link batch response parser', () => {
  const requestDigest = 'd'.repeat(64);
  const protocolRoot = join(tmpdir(), 'coding-x-link-protocol');
  const checkoutRoot = join(protocolRoot, 'checkout');
  const sourceRoot = join(protocolRoot, 'source');
  const link = {
    dev: '1',
    ino: '2',
    uid: '3',
    nlink: '1',
    mode: String(0o120777),
    size: '6',
    mtimeNs: '4',
    ctimeNs: '5',
  };
  const target = {
    ...link,
    ino: '3',
    mode: String(0o100644),
    size: '8',
  };
  const item = {
    index: 0,
    scope: 'external',
    resolvedPath: join(protocolRoot, 'external'),
    link,
    linkTargetDigest: 'a'.repeat(64),
    target,
    bytesRead: 8,
    eof: true,
    targetDigest: 'b'.repeat(64),
  };
  const response = {
    schemaVersion: 2,
    requestDigest,
    ok: true,
    items: [item],
  };
  const parse = (bytes: Uint8Array) =>
    parseExternalFileLinkBatchSnapshotForTests(bytes, {
      requestDigest,
      firstIndex: 0,
      count: 1,
      checkoutRoot,
      sourceRoot,
      maxFileBytes: 1024,
    });
  const encoded = (value: unknown): Buffer => Buffer.from(JSON.stringify(value));

  it('accepts one exact external-file result with possible POSIX identities', () => {
    expect(parse(encoded(response))).toMatchObject([{ scope: 'external' }]);
  });

  it.each([
    ['zero link count', { ...item, link: { ...link, nlink: '0' } }],
    ['ordinary-file link mode', { ...item, link: { ...link, mode: String(0o100644) } }],
    ['zero target link count', { ...item, target: { ...target, nlink: '0' } }],
    ['symbolic-link target mode', { ...item, target: { ...target, mode: String(0o120777) } }],
  ])(
    'rejects an impossible %s even when digest and EOF fields look valid',
    (_name, invalidItem) => {
      expect(() => parse(encoded({ ...response, items: [invalidItem] }))).toThrow(/身份/u);
    },
  );

  it.each([
    ['invalid JSON', Buffer.from('{')],
    ['invalid UTF-8', Buffer.from([0xff])],
    ['oversized response', Buffer.alloc(16 * 1024 * 1024 + 1)],
    ['wrong schema', encoded({ ...response, schemaVersion: 3 })],
    ['missing item', encoded({ ...response, items: [] })],
    ['extra item', encoded({ ...response, items: [item, { ...item, index: 1 }] })],
    ['extra top-level field', encoded({ ...response, unexpected: true })],
    ['extra item field', encoded({ ...response, items: [{ ...item, unexpected: true }] })],
  ])('rejects %s', (_name, bytes) => {
    expect(() => parse(bytes)).toThrow(/大小|UTF-8|解析|非法|身份/u);
  });
});

describe('external file link snapshot budget', () => {
  const limits = {
    maxLinks: 2,
    maxTargetReadBytes: 10,
    deadlineMs: 30,
  };

  it('counts every link and retains one consistent digest record per stable target', () => {
    const budget = new ExternalFileLinkSnapshotBudget(limits, undefined, () => 0);
    budget.countLink();
    budget.countLink();
    expect(budget.reserveTarget('same-target', 8)).toBe(true);
    expect(budget.reserveTarget('same-target', 8)).toBe(false);
    expect(() => budget.countLink()).toThrow(/超过 2 条/u);
    expect(budget.reserveTarget('different-target', 3)).toBe(true);
  });

  it('grants each reader only the remaining physical-read budget and rejects concurrent reuse', () => {
    const budget = new ExternalFileLinkSnapshotBudget(limits, undefined, () => 0);
    expect(budget.beginReaderBatch()).toBe(10);
    expect(() => budget.beginReaderBatch()).toThrow(/不能并发/u);
    budget.finishReaderBatch(8);
    expect(budget.beginReaderBatch()).toBe(2);
    budget.finishReaderBatch(2);
    expect(budget.beginReaderBatch()).toBe(0);
    budget.poisonReaderBatch();
    expect(() => budget.checkpoint()).toThrow(/已经失效/u);
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
      const magicTarget =
        process.platform === 'linux'
          ? '/proc/self/exe'
          : existsSync('/DEV/fd/1')
            ? '/DEV/fd/1'
            : '/dev/fd/1';
      symlinkSync(magicTarget, linkPath);
      const managed = await createManagedProcessTestSession();
      try {
        const budget = new ExternalFileLinkSnapshotBudget({
          maxLinks: 1,
          maxTargetReadBytes: 1024,
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
    'keeps symlink-and-parent traversal on the managed fail-closed path',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-external-folding-'));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      const bin = join(checkoutRoot, 'bin');
      const external = join(root, 'external');
      mkdirSync(join(checkoutRoot, 'pkg'), { recursive: true });
      mkdirSync(bin);
      mkdirSync(sourceRoot);
      mkdirSync(join(external, 'subdir'), { recursive: true });
      mkdirSync(join(external, 'pkg'), { recursive: true });
      writeFileSync(join(checkoutRoot, 'pkg', 'cli.js'), 'internal\n');
      writeFileSync(join(external, 'pkg', 'cli.js'), 'external\n');
      symlinkSync(join(external, 'subdir'), join(checkoutRoot, 'alias'), 'dir');
      const linkPath = join(bin, 'tool');
      symlinkSync('../alias/../pkg/cli.js', linkPath);
      expect(realpathSync.native(linkPath)).toBe(
        realpathSync.native(join(external, 'pkg', 'cli.js')),
      );
      const managed = await createManagedProcessTestSession();
      try {
        const budget = new ExternalFileLinkSnapshotBudget({
          maxLinks: 1,
          maxTargetReadBytes: 1024,
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
          }),
        ).rejects.toThrow(/changed while resolving/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'rejects an apparently internal target when its resolution chain leaves and re-enters checkout',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-link-reentry-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      writeFileSync(join(checkoutRoot, 'target'), 'content\n');
      symlinkSync(checkoutRoot, join(sourceRoot, 'back'), 'dir');
      const linkPath = join(checkoutRoot, 'tool');
      symlinkSync(join(sourceRoot, 'back', 'target'), linkPath);
      expect(realpathSync.native(linkPath)).toBe(join(checkoutRoot, 'target'));
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLink({
            linkPath,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget: new ExternalFileLinkSnapshotBudget({
              maxLinks: 1,
              maxTargetReadBytes: 1024,
              deadlineMs: 5_000,
            }),
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).rejects.toThrow(/internal link resolution left the validation checkout/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'accepts a stable internal directory link for standard toolchain layouts',
    async () => {
      const root = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'coding-x-internal-directory-link-')),
      );
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(join(checkoutRoot, 'package'), { recursive: true });
      mkdirSync(sourceRoot);
      const linkPath = join(checkoutRoot, 'package-link');
      symlinkSync('package', linkPath, 'dir');
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLink({
            linkPath,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget: new ExternalFileLinkSnapshotBudget({
              maxLinks: 1,
              maxTargetReadBytes: 1024,
              deadlineMs: 5_000,
            }),
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).resolves.toEqual({ scope: 'internal', resolvedPath: join(checkoutRoot, 'package') });
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'rejects a symbolic-link inode that has more than one directory name',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-hard-symlink-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      writeFileSync(join(checkoutRoot, 'target'), 'content\n');
      const first = join(checkoutRoot, 'first');
      symlinkSync('target', first);
      execFileSync('/bin/ln', ['-P', first, join(checkoutRoot, 'second')]);
      expect(lstatSync(first).isSymbolicLink()).toBe(true);
      expect(lstatSync(first).nlink).toBe(2);
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLink({
            linkPath: first,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget: new ExternalFileLinkSnapshotBudget({
              maxLinks: 1,
              maxTargetReadBytes: 1024,
              deadlineMs: 5_000,
            }),
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).rejects.toThrow(/single-name symbolic link/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'rechecks an earlier link at the end of its reader batch',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-batch-recheck-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      writeFileSync(join(checkoutRoot, 'first-target'), 'first\n');
      writeFileSync(join(checkoutRoot, 'second-target'), 'second\n');
      const linkPath = join(checkoutRoot, 'tool');
      symlinkSync('first-target', linkPath);
      const marker = join(root, 'ready');
      const finalProofLoop = '  for (let offset = 0; offset < observations.length; offset += 1) {';
      const productionReader = externalFileLinkReaderProgramForTests();
      const delayedReader = productionReader.replace(
        finalProofLoop,
        `  fs.writeFileSync(${JSON.stringify(marker)}, 'ready');\n` +
          '  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 1000);\n' +
          finalProofLoop,
      );
      expect(delayedReader).not.toBe(productionReader);
      const managed = await createManagedProcessTestSession();
      try {
        const reviewing = snapshotManagedExternalFileLink({
          linkPath,
          checkoutRoot,
          sourceRoot,
          maxFileBytes: 1024,
          budget: new ExternalFileLinkSnapshotBudget({
            maxLinks: 1,
            maxTargetReadBytes: 1024,
            deadlineMs: 10_000,
          }),
          session: managed.session,
          kind: 'quality-check',
          cwd: checkoutRoot,
          readerProgramForTests: delayedReader,
        });
        for (let attempt = 0; attempt < 200 && !existsSync(marker); attempt += 1) {
          await new Promise((resolvePromise) => setTimeout(resolvePromise, 10));
        }
        expect(existsSync(marker)).toBe(true);
        rmSync(linkPath);
        symlinkSync('second-target', linkPath);
        await expect(reviewing).rejects.toThrow(/identity changed before the batch completed/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'charges every internal link to the shared batch budget before launching the reader',
    async () => {
      const root = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'coding-x-internal-link-budget-')),
      );
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      writeFileSync(join(checkoutRoot, 'target'), 'content\n');
      const links = [join(checkoutRoot, 'first'), join(checkoutRoot, 'second')];
      for (const link of links) symlinkSync('target', link);
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLinks({
            linkPaths: links,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget: new ExternalFileLinkSnapshotBudget({
              maxLinks: 1,
              maxTargetReadBytes: 1024,
              deadlineMs: 5_000,
            }),
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).rejects.toThrow(/超过 1 条/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'charges a repeated external target again when separate reader calls share a budget',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-shared-link-budget-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const target = join(root, 'target');
      writeFileSync(target, 'content\n');
      const links = [join(checkoutRoot, 'first'), join(checkoutRoot, 'second')];
      for (const link of links) symlinkSync(target, link);
      const managed = await createManagedProcessTestSession();
      try {
        const budget = new ExternalFileLinkSnapshotBudget({
          maxLinks: 2,
          maxTargetReadBytes: 8,
          deadlineMs: 10_000,
        });
        await expect(
          snapshotManagedExternalFileLink({
            linkPath: links[0],
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget,
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).resolves.toMatchObject({ scope: 'external' });
        await expect(
          snapshotManagedExternalFileLink({
            linkPath: links[1],
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget,
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).rejects.toThrow(/remaining shared byte limit/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'reads one stable external target only once when multiple links share a reader batch',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-batch-link-cache-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const target = join(root, 'target');
      writeFileSync(target, 'content\n');
      const links = [join(checkoutRoot, 'first'), join(checkoutRoot, 'second')];
      for (const link of links) symlinkSync(target, link);
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLinks({
            linkPaths: links,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget: new ExternalFileLinkSnapshotBudget({
              maxLinks: 2,
              maxTargetReadBytes: 8,
              deadlineMs: 10_000,
            }),
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).resolves.toMatchObject([{ scope: 'external' }, { scope: 'external' }]);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'enforces the physical external target read limit inside one reader batch',
    async () => {
      const root = realpathSync.native(
        mkdtempSync(join(tmpdir(), 'coding-x-batch-target-budget-')),
      );
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const links = [join(checkoutRoot, 'first'), join(checkoutRoot, 'second')];
      for (let index = 0; index < links.length; index += 1) {
        const target = join(root, `target-${index}`);
        writeFileSync(target, '123456');
        symlinkSync(target, links[index]);
      }
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLinks({
            linkPaths: links,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget: new ExternalFileLinkSnapshotBudget({
              maxLinks: 2,
              maxTargetReadBytes: 10,
              deadlineMs: 5_000,
            }),
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
          }),
        ).rejects.toThrow(/reads exceed/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'rejects a batch response bound to a different request digest',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-batch-digest-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLinks({
            linkPaths: [join(checkoutRoot, 'tool')],
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget: new ExternalFileLinkSnapshotBudget({
              maxLinks: 1,
              maxTargetReadBytes: 1024,
              deadlineMs: 5_000,
            }),
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
            readerProgramForTests: `
              const path = require('node:path');
              const request = JSON.parse(process.argv[1]);
              process.stdout.write(JSON.stringify({
                schemaVersion: 2,
                requestDigest: '${'0'.repeat(64)}',
                ok: true,
                items: request.links.map((entry) => ({
                  index: entry.index,
                  scope: 'internal',
                  resolvedPath: path.resolve(request.checkoutRoot, entry.relativePath),
                })),
              }));
            `,
          }),
        ).rejects.toThrow(/请求摘要/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'rejects a batch response whose result indexes are out of order',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-batch-order-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLinks({
            linkPaths: [join(checkoutRoot, 'first'), join(checkoutRoot, 'second')],
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget: new ExternalFileLinkSnapshotBudget({
              maxLinks: 2,
              maxTargetReadBytes: 0,
              deadlineMs: 5_000,
            }),
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
            readerProgramForTests: `
              const crypto = require('node:crypto');
              const path = require('node:path');
              const raw = process.argv[1];
              const request = JSON.parse(raw);
              process.stdout.write(JSON.stringify({
                schemaVersion: 2,
                requestDigest: crypto.createHash('sha256').update(raw).digest('hex'),
                ok: true,
                items: request.links.map((entry) => ({
                  index: entry.index,
                  scope: 'internal',
                  resolvedPath: path.resolve(request.checkoutRoot, entry.relativePath),
                })).reverse(),
              }));
            `,
          }),
        ).rejects.toThrow(/结果缺少身份/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    20_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'splits oversized requests while preserving every result in input order',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-batch-split-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const longDirectory = 'long-segment-'.repeat(40);
      const linkPaths = Array.from({ length: 100 }, (_, index) =>
        join(checkoutRoot, longDirectory, `tool-${index}`),
      );
      const managed = await createManagedProcessTestSession();
      try {
        const snapshots = await snapshotManagedExternalFileLinks({
          linkPaths,
          checkoutRoot,
          sourceRoot,
          maxFileBytes: 1024,
          budget: new ExternalFileLinkSnapshotBudget({
            maxLinks: 100,
            maxTargetReadBytes: 0,
            deadlineMs: 20_000,
          }),
          session: managed.session,
          kind: 'quality-check',
          cwd: checkoutRoot,
          readerProgramForTests: `
            const crypto = require('node:crypto');
            const path = require('node:path');
            const raw = process.argv[1];
            const request = JSON.parse(raw);
            process.stdout.write(JSON.stringify({
              schemaVersion: 2,
              requestDigest: crypto.createHash('sha256').update(raw).digest('hex'),
              ok: true,
              items: request.links.map((entry) => ({
                index: entry.index,
                scope: 'internal',
                resolvedPath: path.resolve(request.checkoutRoot, entry.relativePath),
              })),
            }));
          `,
        });

        expect(snapshots).toHaveLength(linkPaths.length);
        expect(snapshots.every((snapshot) => snapshot.scope === 'internal')).toBe(true);
        expect(snapshots.at(-1)).toMatchObject({
          scope: 'internal',
          resolvedPath: linkPaths.at(-1),
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'grants a later reader batch only the physical-read bytes left by earlier batches',
    async () => {
      const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'coding-x-batch-read-cap-')));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      const longDirectory = 'long-segment-'.repeat(40);
      const linkPaths = Array.from({ length: 100 }, (_, index) =>
        join(checkoutRoot, longDirectory, `tool-${index}`),
      );
      const managed = await createManagedProcessTestSession();
      const budget = new ExternalFileLinkSnapshotBudget({
        maxLinks: 100,
        maxTargetReadBytes: 10,
        deadlineMs: 20_000,
      });
      try {
        await expect(
          snapshotManagedExternalFileLinks({
            linkPaths,
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            budget,
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
            readerProgramForTests: `
              const crypto = require('node:crypto');
              const path = require('node:path');
              const raw = process.argv[1];
              const request = JSON.parse(raw);
              if (request.maxTargetReadBytes < 6) {
                process.stderr.write('later batch received only the remaining read grant');
                process.exit(1);
              }
              const target = {
                dev: '1', ino: '2', uid: '3', nlink: '1', mode: '33188', size: '6',
                mtimeNs: '4', ctimeNs: '5',
              };
              process.stdout.write(JSON.stringify({
                schemaVersion: 2,
                requestDigest: crypto.createHash('sha256').update(raw).digest('hex'),
                ok: true,
                items: request.links.map((entry) => ({
                  index: entry.index,
                  scope: 'external',
                  resolvedPath: path.resolve(request.checkoutRoot, '..', 'shared-target'),
                  link: { ...target, ino: String(1000 + entry.index), mode: '41471' },
                  linkTargetDigest: 'a'.repeat(64),
                  target,
                  bytesRead: 6,
                  eof: true,
                  targetDigest: 'b'.repeat(64),
                })),
              }));
            `,
          }),
        ).rejects.toThrow(/remaining read grant/u);
        expect(() => budget.checkpoint()).toThrow(/已经失效/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    30_000,
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
          maxTargetReadBytes: 1024,
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
          maxTargetReadBytes: 1024,
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
      const targetStat = {
        dev: '1',
        ino: '2',
        uid: '3',
        nlink: '1',
        mode: '33188',
        size: '8',
        mtimeNs: '4',
        ctimeNs: '5',
      };
      const linkStat = { ...targetStat, ino: '3', mode: String(0o120777), size: '6' };
      const item = {
        scope: 'external',
        resolvedPath: target,
        link: linkStat,
        linkTargetDigest: 'a'.repeat(64),
        target: targetStat,
        bytesRead: 8,
        eof: false,
        targetDigest: 'b'.repeat(64),
      };
      const managed = await createManagedProcessTestSession();
      try {
        const budget = new ExternalFileLinkSnapshotBudget({
          maxLinks: 1,
          maxTargetReadBytes: 1024,
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
            readerProgramForTests: `
              const crypto = require('node:crypto');
              const raw = process.argv[1];
              const request = JSON.parse(raw);
              process.stdout.write(JSON.stringify({
                schemaVersion: 2,
                requestDigest: crypto.createHash('sha256').update(raw).digest('hex'),
                ok: true,
                items: [{ index: request.links[0].index, ...${JSON.stringify(item)} }],
              }));
            `,
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
    expect(canSnapshotExternalFileLinks('freebsd')).toBe(false);
  });

  it('rejects known Linux and macOS magic or remote filesystems without an allowlist', () => {
    expect(isExternalFileSystemMagicOrRemote('linux', 0x9fa0n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('linux', 0x65735546n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('linux', 0x6969n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('linux', 0xef53n)).toBe(false);
    expect(isExternalFileSystemMagicOrRemote('linux', 0x01021994n)).toBe(false);
    expect(isExternalFileSystemMagicOrRemote('darwin', 19n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('darwin', 25n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('darwin', 26n)).toBe(true);
    expect(isExternalFileSystemMagicOrRemote('freebsd', 0x9fa0n)).toBe(false);
  });
});

describe('adaptive external file link snapshot deadline', () => {
  it.each([
    ['zero workload', 0, 0, 30_000],
    ['one 8 MiB target and two links', 2, 8 * 1024 * 1024, 31_040],
    ['maximum permitted workload', 1024, 1024 * 1024 * 1024, 178_480],
  ])('uses the fixed formula for %s', (_name, linkCount, distinctTargetBytes, expected) => {
    expect(externalFileLinkSnapshotBudgetMsForTests(linkCount, distinctTargetBytes)).toBe(expected);
  });

  it('rejects invalid or over-cap workloads and never exceeds the 180 second ceiling', () => {
    expect(() => externalFileLinkSnapshotBudgetMsForTests(-1, 0)).toThrow(/非法/u);
    expect(() => externalFileLinkSnapshotBudgetMsForTests(1025, 0)).toThrow(/超过/u);
    expect(() => externalFileLinkSnapshotBudgetMsForTests(1, 1024 * 1024 * 1024 + 1)).toThrow(
      /超过/u,
    );
    expect(externalFileLinkSnapshotBudgetMsForTests(1024, 1024 * 1024 * 1024)).toBeLessThanOrEqual(
      180_000,
    );
  });

  it('keeps a controlled legal read that crosses the old deadline inside its adaptive budget', async () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-adaptive-reader-'));
    const checkoutRoot = join(root, 'checkout');
    const sourceRoot = join(root, 'source');
    const target = join(root, 'target');
    const linkPath = join(checkoutRoot, 'tool');
    mkdirSync(checkoutRoot);
    mkdirSync(sourceRoot);
    writeFileSync(target, 'content\n');
    symlinkSync(target, linkPath);
    const managed = await createManagedProcessTestSession();
    let now = 0;
    const budget = new ExternalFileLinkSnapshotBudget(
      {
        maxLinks: 1,
        maxTargetReadBytes: 1024,
        deadlineMs: 31_020,
        workload: { linkCount: 1, distinctTargets: 1, distinctTargetBytes: 8 },
      },
      undefined,
      () => now,
      0,
    );
    const advance = setTimeout(() => {
      now = 30_001;
    }, 1);
    try {
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
          readerProgramForTests: `
            const crypto = require('node:crypto');
            const path = require('node:path');
            const raw = process.argv[1];
            const request = JSON.parse(raw);
            Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
            const target = {
              dev: '1', ino: '2', uid: '3', nlink: '1', mode: '33188', size: '8',
              mtimeNs: '4', ctimeNs: '5',
            };
            process.stdout.write(JSON.stringify({
              schemaVersion: 2,
              requestDigest: crypto.createHash('sha256').update(raw).digest('hex'),
              ok: true,
              items: request.links.map((entry) => ({
                index: entry.index,
                scope: 'external',
                resolvedPath: path.resolve(request.checkoutRoot, '..', 'target'),
                link: { ...target, ino: '3', mode: '41471', size: '6' },
                linkTargetDigest: 'a'.repeat(64),
                target,
                bytesRead: 8,
                eof: true,
                targetDigest: 'b'.repeat(64),
              })),
            }));
          `,
        }),
      ).resolves.toMatchObject({ scope: 'external' });
      expect(now).toBe(30_001);
      const oldBudget = new ExternalFileLinkSnapshotBudget(
        { maxLinks: 1, maxTargetReadBytes: 1024, deadlineMs: 30_000 },
        undefined,
        () => now,
        0,
      );
      expect(() => oldBudget.checkpoint()).toThrow(/统一期限/u);
    } finally {
      clearTimeout(advance);
      rmSync(root, { recursive: true, force: true });
      await managed.close();
    }
  }, 20_000);

  it('reports bounded mechanical progress when the adaptive deadline expires', () => {
    let now = 31_020;
    const budget = new ExternalFileLinkSnapshotBudget(
      {
        maxLinks: 1,
        maxTargetReadBytes: 1024,
        deadlineMs: 31_020,
        workload: { linkCount: 1, distinctTargets: 1, distinctTargetBytes: 8 },
      },
      undefined,
      () => now,
      0,
    );
    expect(() => budget.checkpoint()).toThrow(
      /budgetMs=31020, elapsedMs=31020, links=1, distinctTargets=1, completedLinks=0, completedTargets=0, readBytes=0, remainingBytes=8/u,
    );
    now = 31_021;
    expect(() => budget.checkpoint()).toThrow(/budgetMs=31020/u);
  });

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'derives one workload from managed metadata and reads a repeated external target once',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-adaptive-workload-'));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      const target = join(root, 'target');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      writeFileSync(target, 'content\n');
      const links = [join(checkoutRoot, 'first'), join(checkoutRoot, 'second')];
      for (const link of links) symlinkSync(target, link);
      const managed = await createManagedProcessTestSession();
      let workload:
        | { linkCount: number; distinctTargets: number; distinctTargetBytes: number }
        | undefined;
      try {
        const snapshots = await snapshotManagedExternalFileLinksWithAdaptiveBudget({
          linkPaths: links,
          checkoutRoot,
          sourceRoot,
          maxFileBytes: 1024,
          maxLinks: 2,
          maxTargetReadBytes: 1024,
          session: managed.session,
          kind: 'quality-check',
          cwd: checkoutRoot,
          onWorkloadForTests: (observed) => {
            workload = observed;
          },
        });
        expect(workload).toEqual({ linkCount: 2, distinctTargets: 1, distinctTargetBytes: 8 });
        expect(snapshots).toHaveLength(2);
        expect(snapshots).toMatchObject([
          { scope: 'external', identity: { targetDigest: createHash('sha256').update('content\n').digest('hex') } },
          { scope: 'external', identity: { targetDigest: createHash('sha256').update('content\n').digest('hex') } },
        ]);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    30_000,
  );

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'fails closed when a same-sized target changes after metadata and before content reading',
    async () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-adaptive-drift-'));
      const checkoutRoot = join(root, 'checkout');
      const sourceRoot = join(root, 'source');
      const target = join(root, 'target');
      const linkPath = join(checkoutRoot, 'tool');
      mkdirSync(checkoutRoot);
      mkdirSync(sourceRoot);
      writeFileSync(target, 'content\n');
      symlinkSync(target, linkPath);
      const managed = await createManagedProcessTestSession();
      try {
        await expect(
          snapshotManagedExternalFileLinksWithAdaptiveBudget({
            linkPaths: [linkPath],
            checkoutRoot,
            sourceRoot,
            maxFileBytes: 1024,
            maxLinks: 1,
            maxTargetReadBytes: 1024,
            session: managed.session,
            kind: 'quality-check',
            cwd: checkoutRoot,
            afterMetadataForTests: () => {
              writeFileSync(target, 'changed\n');
            },
          }),
        ).rejects.toThrow(/元数据与内容读取身份不一致/u);
      } finally {
        rmSync(root, { recursive: true, force: true });
        await managed.close();
      }
    },
    30_000,
  );
});
