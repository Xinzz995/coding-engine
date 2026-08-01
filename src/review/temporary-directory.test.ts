import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { ReviewTemporaryDirectory } from './temporary-directory.js';

const roots: string[] = [];
const expectedSettledRetentionProtection =
  process.platform === 'win32'
    ? ({ status: 'unverifiable', reason: 'platform-unsupported' } as const)
    : ({ status: 'restricted', mechanism: 'posix-bound-descriptor-v1' } as const);
const expectedTreeFailureProtection =
  process.platform === 'win32'
    ? expectedSettledRetentionProtection
    : ({ status: 'unverifiable', reason: 'identity-or-tree-unverified' } as const);

function makeFixtureRemovable(path: string): void {
  let info: ReturnType<typeof lstatSync>;
  try {
    info = lstatSync(path);
  } catch {
    return;
  }
  if (info.isSymbolicLink()) return;
  if (!info.isDirectory()) {
    chmodSync(path, 0o600);
    return;
  }
  chmodSync(path, 0o700);
  for (const name of readdirSync(path)) makeFixtureRemovable(join(path, name));
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    makeFixtureRemovable(root);
    rmSync(root, { recursive: true, force: true });
  }
});

function parent(): string {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-review-temp-test-parent-'));
  roots.push(root);
  return root;
}

function exactDomain(
  cleanupHooks?: Parameters<typeof ReviewTemporaryDirectory.create>[0]['cleanupHooks'],
): ReviewTemporaryDirectory {
  const temporary = ReviewTemporaryDirectory.create({
    prefix: 'coding-x-review-test-',
    projectRoot: process.cwd(),
    temporaryParent: parent(),
    cleanupHooks,
  });
  writeFileSync(join(temporary.root, 'input.json'), 'input\n', { mode: 0o444 });
  writeFileSync(join(temporary.root, 'schema.json'), 'schema\n', { mode: 0o444 });
  temporary.sealExactTree({
    files: [
      { path: 'input.json', bytes: Buffer.from('input\n'), maximumBytes: 32 },
      { path: 'schema.json', bytes: Buffer.from('schema\n'), maximumBytes: 32 },
    ],
  });
  return temporary;
}

describe('ReviewTemporaryDirectory', () => {
  it('removes one unchanged exact domain only after the managed use is settled', () => {
    const temporary = exactDomain();
    const root = temporary.root;

    temporary.prepareManagedUse();
    temporary.beginManagedUse();
    temporary.confirmManagedUseSettled();

    expect(temporary.cleanup()).toEqual({ status: 'removed' });
    expect(temporary.cleanup()).toEqual({ status: 'removed' });
    expect(existsSync(root)).toBe(false);
  });

  it('retains an exposed domain when process settlement was not observed', () => {
    const temporary = exactDomain();
    temporary.prepareManagedUse();
    temporary.beginManagedUse();
    if (process.platform !== 'win32') chmodSync(temporary.root, 0o755);

    expect(temporary.cleanup()).toMatchObject({
      status: 'retained',
      location: { status: 'verified', path: temporary.root },
      reason: expect.stringContaining('未证明'),
      protection: { status: 'unverifiable', reason: 'process-unsettled' },
    });
    expect(readFileSync(join(temporary.root, 'input.json'), 'utf8')).toBe('input\n');
    if (process.platform !== 'win32') {
      expect(lstatSync(temporary.root).mode & 0o777).toBe(0o755);
    }
  });

  it('permanently retains a domain after one post-run identity check fails', () => {
    const temporary = exactDomain();
    const pollution = join(temporary.root, 'transient-pollution');
    temporary.prepareManagedUse();
    temporary.beginManagedUse();
    writeFileSync(pollution, 'transient\n');

    expect(() => temporary.confirmManagedUseSettled()).toThrow('固定目录树发生变化');
    unlinkSync(pollution);
    expect(temporary.cleanup()).toMatchObject({
      status: 'retained',
      location: { status: 'verified', path: temporary.root },
      reason: expect.stringContaining('曾失败'),
      protection: expectedSettledRetentionProtection,
    });
    expect(readFileSync(join(temporary.root, 'input.json'), 'utf8')).toBe('input\n');
  });

  it('permanently retains a settled domain after a later identity check fails', () => {
    const temporary = exactDomain();
    const pollution = join(temporary.root, 'late-transient-pollution');
    temporary.prepareManagedUse();
    temporary.beginManagedUse();
    temporary.confirmManagedUseSettled();
    writeFileSync(pollution, 'transient\n');

    expect(() => temporary.assertUnchanged()).toThrow('固定目录树发生变化');
    unlinkSync(pollution);
    expect(temporary.cleanup()).toMatchObject({
      status: 'retained',
      location: { status: 'verified', path: temporary.root },
      reason: expect.stringContaining('曾失败'),
      protection: expectedSettledRetentionProtection,
    });
    expect(readFileSync(join(temporary.root, 'input.json'), 'utf8')).toBe('input\n');
  });

  it.skipIf(process.platform === 'win32')(
    'restricts a permission-drifted exact tree through its frozen descriptors',
    () => {
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-permission-drift-',
        projectRoot: process.cwd(),
        temporaryParent: parent(),
      });
      const nested = join(temporary.root, 'nested');
      const input = join(temporary.root, 'input.json');
      const detail = join(nested, 'detail.json');
      mkdirSync(nested, { mode: 0o700 });
      writeFileSync(input, 'input\n', { mode: 0o400 });
      writeFileSync(detail, 'detail\n', { mode: 0o400 });
      chmodSync(nested, 0o500);
      temporary.sealExactTree({
        directories: ['nested'],
        files: [
          { path: 'input.json', bytes: Buffer.from('input\n'), maximumBytes: 32 },
          { path: 'nested/detail.json', bytes: Buffer.from('detail\n'), maximumBytes: 32 },
        ],
      });
      temporary.prepareManagedUse();
      temporary.beginManagedUse();

      chmodSync(nested, 0o755);
      chmodSync(input, 0o444);
      chmodSync(detail, 0o444);

      expect(() => temporary.confirmManagedUseSettled()).toThrow('固定子目录发生变化');
      expect(temporary.cleanup()).toMatchObject({
        status: 'retained',
        location: { status: 'verified', path: temporary.root },
        protection: {
          status: 'restricted',
          mechanism: 'posix-bound-descriptor-v1',
          scope: 'retained-root-at-closeout',
        },
      });
      expect(lstatSync(temporary.root).mode & 0o777).toBe(0o500);
      expect(lstatSync(nested).mode & 0o777).toBe(0o500);
      expect(lstatSync(input).mode & 0o777).toBe(0o400);
      expect(lstatSync(detail).mode & 0o777).toBe(0o400);
    },
  );

  it('retains the complete domain when an extra file appears', () => {
    const temporary = exactDomain();
    writeFileSync(join(temporary.root, 'extra.txt'), 'unexpected');

    expect(() => temporary.assertUnchanged()).toThrow('固定目录树发生变化');
    expect(temporary.cleanup()).toMatchObject({
      status: 'retained',
      location: { status: 'verified', path: temporary.root },
      protection: expectedTreeFailureProtection,
    });
    expect(readFileSync(join(temporary.root, 'extra.txt'), 'utf8')).toBe('unexpected');
    if (process.platform !== 'win32') {
      expect(lstatSync(temporary.root).mode & 0o777).toBe(0o500);
    }
  });

  it.skipIf(process.platform === 'win32')(
    'detects and restricts permission drift on a safe-tree root',
    () => {
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-safe-retention-',
        projectRoot: process.cwd(),
        temporaryParent: parent(),
      });
      temporary.sealSafeTree();
      temporary.prepareManagedUse();
      temporary.beginManagedUse();
      const output = join(temporary.root, 'runner-output.json');
      writeFileSync(output, '{}\n', { mode: 0o644 });
      chmodSync(temporary.root, 0o755);

      expect(() => temporary.confirmManagedUseSettled()).toThrow(
        'Reviewer 临时域根目录权限发生变化',
      );

      expect(temporary.cleanup()).toMatchObject({
        status: 'retained',
        protection: {
          status: 'restricted',
          mechanism: 'posix-bound-descriptor-v1',
          scope: 'retained-root-at-closeout',
        },
      });
      expect(lstatSync(temporary.root).mode & 0o777).toBe(0o500);
      expect(lstatSync(output).mode & 0o777).toBe(0o644);
    },
  );

  it('rejects a hard-linked fixed file instead of accepting aliased bytes', () => {
    const temporary = ReviewTemporaryDirectory.create({
      prefix: 'coding-x-review-hardlink-',
      projectRoot: process.cwd(),
      temporaryParent: parent(),
    });
    const outside = join(parent(), 'outside.txt');
    writeFileSync(outside, 'same');
    linkSync(outside, join(temporary.root, 'input.json'));

    try {
      expect(() =>
        temporary.sealExactTree({
          files: [{ path: 'input.json', bytes: Buffer.from('same'), maximumBytes: 16 }],
        }),
      ).toThrow('固定文件无效');
    } finally {
      expect(temporary.retain('测试失败现场')).toMatchObject({ status: 'retained' });
    }
  });

  it('rejects an oversized fixed file before reading it', () => {
    const temporary = ReviewTemporaryDirectory.create({
      prefix: 'coding-x-review-oversized-',
      projectRoot: process.cwd(),
      temporaryParent: parent(),
    });
    writeFileSync(join(temporary.root, 'input.json'), 'x'.repeat(64));

    try {
      expect(() =>
        temporary.sealExactTree({
          files: [{ path: 'input.json', bytes: Buffer.from('expected'), maximumBytes: 16 }],
        }),
      ).toThrow('固定文件无效');
    } finally {
      expect(temporary.cleanup()).toEqual({ status: 'removed' });
    }
  });

  it('does not allow a failed preflight seal to be repaired and retried', () => {
    const temporary = ReviewTemporaryDirectory.create({
      prefix: 'coding-x-review-failed-seal-',
      projectRoot: process.cwd(),
      temporaryParent: parent(),
    });
    const unexpected = join(temporary.root, 'unexpected.json');
    writeFileSync(unexpected, '{}\n');

    expect(() => temporary.sealExactTree({ files: [] })).toThrow('固定目录树不匹配');
    unlinkSync(unexpected);
    expect(() => temporary.sealExactTree({ files: [] })).toThrow('已经冻结');
    expect(temporary.cleanup()).toEqual({ status: 'removed' });
  });

  it('accepts a fixed file whose size exactly matches the declared limit', () => {
    const temporary = ReviewTemporaryDirectory.create({
      prefix: 'coding-x-review-boundary-',
      projectRoot: process.cwd(),
      temporaryParent: parent(),
    });
    const bytes = Buffer.from('1234567890abcdef');
    writeFileSync(join(temporary.root, 'input.json'), bytes);
    temporary.sealExactTree({
      files: [{ path: 'input.json', bytes, maximumBytes: bytes.byteLength }],
    });

    expect(() => temporary.assertUnchanged()).not.toThrow();
    expect(temporary.cleanup()).toEqual({ status: 'removed' });
  });

  it('closes earlier file handles when a later fixed file does not match', () => {
    const temporary = ReviewTemporaryDirectory.create({
      prefix: 'coding-x-review-partial-seal-',
      projectRoot: process.cwd(),
      temporaryParent: parent(),
    });
    writeFileSync(join(temporary.root, 'first.json'), 'first\n');
    writeFileSync(join(temporary.root, 'second.json'), 'actual\n');

    expect(() =>
      temporary.sealExactTree({
        files: [
          { path: 'first.json', bytes: Buffer.from('first\n'), maximumBytes: 32 },
          { path: 'second.json', bytes: Buffer.from('expected\n'), maximumBytes: 32 },
        ],
      }),
    ).toThrow('字节或身份不匹配');
    expect(() =>
      temporary.sealExactTree({
        files: [
          { path: 'first.json', bytes: Buffer.from('first\n'), maximumBytes: 32 },
          { path: 'second.json', bytes: Buffer.from('actual\n'), maximumBytes: 32 },
        ],
      }),
    ).toThrow('已经冻结');
    expect(temporary.cleanup()).toEqual({ status: 'removed' });
  });

  it('retains the domain when a sealed leaf is replaced with identical bytes', () => {
    const temporary = exactDomain();
    const inputPath = join(temporary.root, 'input.json');
    unlinkSync(inputPath);
    writeFileSync(inputPath, 'input\n', { mode: 0o400 });

    expect(() => temporary.assertUnchanged()).toThrow('固定文件发生变化');
    expect(temporary.cleanup()).toMatchObject({
      status: 'retained',
      location: { status: 'verified', path: temporary.root },
      protection: expectedTreeFailureProtection,
    });
    expect(readFileSync(inputPath, 'utf8')).toBe('input\n');
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a symbolic-link leaf without reading its target',
    () => {
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-symlink-',
        projectRoot: process.cwd(),
        temporaryParent: parent(),
      });
      const outside = join(parent(), 'outside-secret.txt');
      writeFileSync(outside, 'outside-secret');
      symlinkSync(outside, join(temporary.root, 'input.json'));

      try {
        expect(() =>
          temporary.sealExactTree({
            files: [{ path: 'input.json', bytes: Buffer.from('outside-secret'), maximumBytes: 64 }],
          }),
        ).toThrow('包含链接');
        expect(readFileSync(outside, 'utf8')).toBe('outside-secret');
      } finally {
        expect(temporary.retain('测试失败现场')).toMatchObject({ status: 'retained' });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a real FIFO without waiting for a writer',
    () => {
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-fifo-',
        projectRoot: process.cwd(),
        temporaryParent: parent(),
      });
      const fifo = join(temporary.root, 'input.json');
      const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5_000 });
      expect(created.error).toBeUndefined();
      expect(created.status, created.stderr).toBe(0);
      expect(lstatSync(fifo).isFIFO()).toBe(true);

      try {
        const startedAt = Date.now();
        expect(() =>
          temporary.sealExactTree({
            files: [{ path: 'input.json', bytes: Buffer.alloc(0), maximumBytes: 16 }],
          }),
        ).toThrow('固定文件无效');
        expect(Date.now() - startedAt).toBeLessThan(1_000);
      } finally {
        expect(temporary.retain('测试失败现场')).toMatchObject({ status: 'retained' });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not chmod or remove a replacement installed at the original root path',
    () => {
      const temporary = exactDomain();
      const original = `${temporary.root}-original`;
      renameSync(temporary.root, original);
      mkdirSync(temporary.root, { mode: 0o711 });
      writeFileSync(join(temporary.root, 'sentinel.txt'), 'replacement');
      chmodSync(temporary.root, 0o711);

      expect(temporary.cleanup()).toMatchObject({
        status: 'unverifiable',
        location: { status: 'unverifiable', candidates: [temporary.root] },
        protection: { status: 'unverifiable', reason: 'identity-or-tree-unverified' },
      });
      expect(readFileSync(join(temporary.root, 'sentinel.txt'), 'utf8')).toBe('replacement');
      expect(lstatSync(temporary.root).mode & 0o777).toBe(0o711);
      expect(readFileSync(join(original, 'input.json'), 'utf8')).toBe('input\n');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never follows a same-prefix sibling link during cleanup',
    () => {
      const temporary = exactDomain();
      const original = `${temporary.root}-original`;
      const sibling = join(dirname(temporary.root), 'coding-x-review-test-sibling');
      mkdirSync(sibling);
      writeFileSync(join(sibling, 'sentinel.txt'), 'sibling');
      renameSync(temporary.root, original);
      symlinkSync(sibling, temporary.root, 'dir');

      expect(temporary.cleanup()).toMatchObject({
        status: 'unverifiable',
        location: { status: 'unverifiable', candidates: [temporary.root] },
      });
      expect(readFileSync(join(sibling, 'sentinel.txt'), 'utf8')).toBe('sibling');
      expect(lstatSync(temporary.root).isSymbolicLink()).toBe(true);
    },
  );

  it.skipIf(process.platform === 'win32')(
    'retains both trees when the frozen temporary parent is replaced',
    () => {
      const temporary = exactDomain();
      const originalParent = `${temporary.parent}-original`;
      renameSync(temporary.parent, originalParent);
      roots.push(originalParent);
      mkdirSync(temporary.parent);
      mkdirSync(temporary.root);
      writeFileSync(join(temporary.root, 'sentinel.txt'), 'replacement-parent');

      expect(temporary.cleanup()).toMatchObject({
        status: 'unverifiable',
        location: { status: 'unverifiable', candidates: [temporary.root] },
      });
      expect(readFileSync(join(temporary.root, 'sentinel.txt'), 'utf8')).toBe('replacement-parent');
      expect(
        readFileSync(join(originalParent, basename(temporary.root), 'input.json'), 'utf8'),
      ).toBe('input\n');
    },
  );

  it('rejects a configured temporary parent that resolves inside the project', () => {
    const inside = mkdtempSync(join(process.cwd(), '.review-temp-inside-'));
    roots.push(inside);
    expect(() =>
      ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-inside-',
        projectRoot: process.cwd(),
        temporaryParent: inside,
      }),
    ).toThrow('位于项目目录内');
  });

  it('reports the exact retained path when creation rollback cannot remove a non-empty domain', () => {
    const temporaryParent = parent();
    let retainedPath = '';
    expect(() =>
      ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-create-failure-',
        projectRoot: process.cwd(),
        temporaryParent,
        afterCreate: (path) => {
          retainedPath = path;
          writeFileSync(join(path, 'failure-evidence.txt'), 'fixture\n');
          throw new Error('injected post-create failure');
        },
      }),
    ).toThrow(/injected post-create failure.*初始化现场已保留.*descriptor-unavailable/u);
    expect(retainedPath).not.toBe('');
    expect(readFileSync(join(retainedPath, 'failure-evidence.txt'), 'utf8')).toBe('fixture\n');
  });

  it.skipIf(process.platform === 'win32')(
    'safely removes the partial domain after a second initialization write fails',
    () => {
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-review-partial-write-',
        projectRoot: process.cwd(),
        temporaryParent: parent(),
      });
      writeFileSync(join(temporary.root, 'first.json'), 'first\n', { mode: 0o400 });
      chmodSync(temporary.root, 0o500);

      expect(() => writeFileSync(join(temporary.root, 'second.json'), 'second\n')).toThrow();
      expect(temporary.cleanup()).toEqual({ status: 'removed' });
      expect(existsSync(temporary.root)).toBe(false);
    },
  );

  it('retains the original path when cleanup rename fails', () => {
    const temporary = exactDomain({
      beforeRename: () => {
        throw new Error('injected rename failure');
      },
    });

    expect(temporary.cleanup()).toMatchObject({
      status: 'retained',
      location: { status: 'verified', path: temporary.root },
      reason: expect.stringContaining('Reviewer 临时域墓碑清理失败'),
      protection: expectedSettledRetentionProtection,
    });
    expect(readFileSync(join(temporary.root, 'input.json'), 'utf8')).toBe('input\n');
  });

  it.each(['beforeMakeRemovable', 'beforeRemove'] as const)(
    'reports the verified tombstone when %s fails after rename',
    (stage) => {
      const temporary = exactDomain({
        [stage]: () => {
          throw new Error(`injected ${stage} failure`);
        },
      });

      const cleanup = temporary.cleanup();
      expect(cleanup).toMatchObject({
        status: 'retained',
        reason: expect.stringContaining('Reviewer 临时域墓碑清理失败'),
        protection: expectedSettledRetentionProtection,
      });
      if (cleanup.status !== 'retained') throw new Error('expected retained cleanup');
      expect(cleanup.location.status).toBe('verified');
      if (cleanup.location.status !== 'verified') throw new Error('expected verified location');
      expect(cleanup.location.path).not.toBe(temporary.root);
      roots.push(cleanup.location.path);
      expect(basename(cleanup.location.path)).toMatch(/^\.coding-x-review-cleanup-/u);
      expect(readFileSync(join(cleanup.location.path, 'input.json'), 'utf8')).toBe('input\n');
    },
  );

  it('reports an unverifiable location when removal completed before cleanup threw', () => {
    const temporary = exactDomain({
      afterRemove: () => {
        throw new Error('injected post-remove failure');
      },
    });

    const cleanup = temporary.cleanup();
    expect(cleanup).toMatchObject({
      status: 'unverifiable',
      location: { status: 'unverifiable' },
      protection: { status: 'unverifiable', reason: 'identity-or-tree-unverified' },
      reason: expect.stringContaining('Reviewer 临时域墓碑清理失败'),
    });
    if (cleanup.status !== 'unverifiable') throw new Error('expected unverifiable cleanup');
    expect(cleanup.location.candidates).toContain(temporary.root);
    expect(cleanup.location.candidates.every((path) => !existsSync(path))).toBe(true);
  });

  it('does not invent a retained path after an already removed domain', () => {
    const temporary = exactDomain();
    expect(temporary.cleanup()).toEqual({ status: 'removed' });

    expect(temporary.retain('too late')).toEqual({
      status: 'unverifiable',
      location: { status: 'unverifiable', candidates: [temporary.root] },
      reason: 'Reviewer 临时域已安全删除，无法再保留',
      protection: { status: 'unverifiable', reason: 'descriptor-unavailable' },
    });
  });

  it.skipIf(process.platform === 'win32')(
    'safe-tree cleanup rejects a link and preserves its external target',
    () => {
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-status-runner-test-',
        projectRoot: process.cwd(),
        temporaryParent: parent(),
      });
      const outside = join(parent(), 'outside.txt');
      writeFileSync(outside, 'outside');
      symlinkSync(outside, join(temporary.root, 'linked.txt'));

      try {
        const secretName = 'PROMPT_FRAGMENT_SECRET';
        renameSync(join(temporary.root, 'linked.txt'), join(temporary.root, secretName));
        expect(() => temporary.sealSafeTree()).toThrow('包含链接');
        expect(readFileSync(outside, 'utf8')).toBe('outside');
      } finally {
        const cleanup = temporary.cleanup();
        expect(cleanup).toMatchObject({ status: 'retained' });
        if (cleanup.status === 'retained') {
          expect(cleanup.reason).not.toContain('PROMPT_FRAGMENT_SECRET');
        }
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'does not allow a failed safe-tree seal to be retried',
    () => {
      const temporary = ReviewTemporaryDirectory.create({
        prefix: 'coding-x-status-runner-retry-',
        projectRoot: process.cwd(),
        temporaryParent: parent(),
      });
      const outside = join(parent(), 'outside-retry.txt');
      const link = join(temporary.root, 'linked.txt');
      writeFileSync(outside, 'outside');
      symlinkSync(outside, link);

      expect(() => temporary.sealSafeTree()).toThrow('包含链接');
      unlinkSync(link);
      expect(() => temporary.sealSafeTree()).toThrow('已经冻结');
      expect(temporary.cleanup()).toEqual({ status: 'removed' });
    },
  );
});
