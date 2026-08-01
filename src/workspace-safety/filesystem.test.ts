import {
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  canonicalizeWorkspaceDirectory,
  createStagingDirectory,
  digestBytes,
  installDirectoryNoReplace,
  installFileNoReplace,
  inspectLinkedFileInstall,
  readLinkedFileInstall,
  recoverLinkedFileInstall,
  jsonBytes,
  moveDirectoryNoReplace,
  readExactFile,
  sameWorkspaceDirectoryEntry,
  workspaceDirectoryIdentity,
  workspacePathsReferToSameDirectory,
  writeNewFile,
} from './filesystem.js';
import { WorkspaceSafetyError } from './types.js';

const roots: string[] = [];

function temporaryRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

afterEach(() => {
  for (const root of roots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('workspace safety filesystem primitives', () => {
  it('serializes JSON deterministically and hashes the exact bytes', () => {
    const bytes = jsonBytes({ value: '中文', count: 2 });

    expect(bytes.toString('utf8')).toBe('{\n  "value": "中文",\n  "count": 2\n}\n');
    expect(digestBytes(bytes)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(digestBytes(bytes)).toBe(digestBytes(Buffer.from(bytes)));
  });

  it('binds Windows directory identity to the file ID instead of an unstable 8.3 spelling', () => {
    const entry = { dev: 11n, ino: 22n };
    const shortPath = String.raw`C:\Users\RUNNER~1\AppData\Local\Temp\coding-x`;
    const longPath = String.raw`C:\Users\runneradmin\AppData\Local\Temp\coding-x`;

    expect(workspaceDirectoryIdentity(shortPath, entry, 'win32')).toBe(
      workspaceDirectoryIdentity(longPath, entry, 'win32'),
    );
    expect(workspaceDirectoryIdentity(shortPath, entry, 'win32')).not.toBe(
      workspaceDirectoryIdentity(longPath, { ...entry, ino: 23n }, 'win32'),
    );
    expect(workspaceDirectoryIdentity('/tmp/short', entry, 'linux')).not.toBe(
      workspaceDirectoryIdentity('/tmp/long', entry, 'linux'),
    );
    expect(sameWorkspaceDirectoryEntry(entry, { ...entry })).toBe(true);
    expect(sameWorkspaceDirectoryEntry(entry, { ...entry, ino: 23n })).toBe(false);
  });

  it('installs a complete non-empty staging directory without replacing a target', async () => {
    const root = temporaryRoot('workspace-filesystem-');
    const staging = await createStagingDirectory(root, 'lease.prepare-', 'first');
    await writeNewFile(join(staging, 'owner.json'), Buffer.from('first'));
    const target = join(root, 'lease');

    await installDirectoryNoReplace(staging, target);
    expect(readFileSync(join(target, 'owner.json'), 'utf8')).toBe('first');

    const losing = await createStagingDirectory(root, 'lease.prepare-', 'second');
    await writeNewFile(join(losing, 'owner.json'), Buffer.from('second'));

    await expect(installDirectoryNoReplace(losing, target)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(readFileSync(join(target, 'owner.json'), 'utf8')).toBe('first');
    expect(readFileSync(join(losing, 'owner.json'), 'utf8')).toBe('second');
  });

  it('never replaces an existing file during first installation', async () => {
    const root = temporaryRoot('workspace-file-install-');
    const staged = join(root, 'marker.staged');
    const target = join(root, 'workspace-safety.json');
    writeFileSync(staged, 'candidate');
    writeFileSync(target, 'winner');

    await expect(installFileNoReplace(staged, target)).rejects.toMatchObject({
      code: 'conflict',
    });
    expect(readFileSync(target, 'utf8')).toBe('winner');
    expect(readFileSync(staged, 'utf8')).toBe('candidate');
  });

  it('installs one complete file and removes the staging hard link before success', async () => {
    const root = temporaryRoot('workspace-file-install-success-');
    const staged = join(root, 'marker.staged');
    const target = join(root, 'workspace-safety.json');
    writeFileSync(staged, 'candidate');

    await installFileNoReplace(staged, target);

    expect(readFileSync(target, 'utf8')).toBe('candidate');
    expect(() => readFileSync(staged)).toThrow();
    await expect(readExactFile(target)).resolves.toEqual(Buffer.from('candidate'));
  });

  it('does not replace a target that wins immediately before the hard-link commit', async () => {
    const root = temporaryRoot('workspace-file-install-race-');
    const staged = join(root, 'marker.staged');
    const target = join(root, 'workspace-safety.json');
    writeFileSync(staged, 'candidate');

    await expect(
      installFileNoReplace(staged, target, {
        beforeLink: () => writeFileSync(target, 'winner'),
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(readFileSync(target, 'utf8')).toBe('winner');
    expect(readFileSync(staged, 'utf8')).toBe('candidate');
  });

  it('never reports success when an exception occurs after the hard link exists', async () => {
    const root = temporaryRoot('workspace-file-install-post-link-');
    const staged = join(root, 'marker.staged');
    const target = join(root, 'workspace-safety.json');
    writeFileSync(staged, 'candidate');

    await expect(
      installFileNoReplace(staged, target, {
        afterLink: () => {
          throw new Error('stop-after-link');
        },
      }),
    ).rejects.toThrow('stop-after-link');

    expect(readFileSync(target, 'utf8')).toBe('candidate');
    await expect(readExactFile(target)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('recovers only an exact controlled two-link install window', async () => {
    const root = temporaryRoot('workspace-file-linked-recovery-');
    const staged = join(root, 'marker.staged');
    const target = join(root, 'workspace-safety.json');
    writeFileSync(staged, 'candidate');
    linkSync(staged, target);
    let authorityChecks = 0;

    await expect(
      inspectLinkedFileInstall({
        source: staged,
        target,
        expectedBytes: Buffer.from('candidate'),
      }),
    ).resolves.toBeUndefined();
    await expect(readLinkedFileInstall({ source: staged, target, maxBytes: 32 })).resolves.toEqual(
      Buffer.from('candidate'),
    );
    expect(existsSync(staged)).toBe(true);
    expect(existsSync(target)).toBe(true);

    await recoverLinkedFileInstall({
      source: staged,
      target,
      expectedBytes: Buffer.from('candidate'),
      authorize: () => {
        authorityChecks += 1;
      },
    });

    expect(authorityChecks).toBe(2);
    expect(existsSync(staged)).toBe(false);
    expect(readFileSync(target, 'utf8')).toBe('candidate');
    await expect(readExactFile(target)).resolves.toEqual(Buffer.from('candidate'));
  });

  it('bounds discovery reads and rejects linked files with any third alias', async () => {
    const root = temporaryRoot('workspace-file-linked-read-');
    const staged = join(root, 'marker.staged');
    const target = join(root, 'workspace-safety.json');
    writeFileSync(staged, 'candidate');
    linkSync(staged, target);

    await expect(
      readLinkedFileInstall({ source: staged, target, maxBytes: 4 }),
    ).rejects.toMatchObject({ code: 'invalid' });

    linkSync(staged, join(root, 'third-link'));
    await expect(
      readLinkedFileInstall({ source: staged, target, maxBytes: 32 }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it('keeps all bytes when controlled linked-install recovery loses authority', async () => {
    const root = temporaryRoot('workspace-file-linked-authority-');
    const staged = join(root, 'marker.staged');
    const target = join(root, 'workspace-safety.json');
    writeFileSync(staged, 'candidate');
    linkSync(staged, target);

    await expect(
      recoverLinkedFileInstall({
        source: staged,
        target,
        expectedBytes: Buffer.from('candidate'),
        authorize: () => {
          throw new WorkspaceSafetyError('lease-lost', 'authority changed');
        },
      }),
    ).rejects.toMatchObject({ code: 'lease-lost' });
    expect(readFileSync(staged, 'utf8')).toBe('candidate');
    expect(readFileSync(target, 'utf8')).toBe('candidate');
  });

  it.each(['extra-link', 'wrong-bytes', 'identity-change'] as const)(
    'rejects an unsafe linked-install recovery: %s',
    async (failure) => {
      const root = temporaryRoot(`workspace-file-linked-${failure}-`);
      const staged = join(root, 'marker.staged');
      const target = join(root, 'workspace-safety.json');
      writeFileSync(staged, 'candidate');
      linkSync(staged, target);
      if (failure === 'extra-link') linkSync(staged, join(root, 'third-link'));

      await expect(
        recoverLinkedFileInstall({
          source: staged,
          target,
          expectedBytes: Buffer.from(failure === 'wrong-bytes' ? 'different' : 'candidate'),
          authorize: () => undefined,
          beforeSourceUnlink:
            failure === 'identity-change'
              ? () => {
                  rmSync(staged);
                  writeFileSync(staged, 'candidate');
                }
              : undefined,
        }),
      ).rejects.toMatchObject({ code: 'invalid' });
      expect(existsSync(target)).toBe(true);
    },
  );

  it.each(['source', 'target'] as const)(
    'rejects when the linked %s path is replaced before validation',
    async (changedPath) => {
      const root = temporaryRoot(`workspace-file-install-${changedPath}-swap-`);
      const staged = join(root, 'marker.staged');
      const target = join(root, 'workspace-safety.json');
      writeFileSync(staged, 'candidate');

      await expect(
        installFileNoReplace(staged, target, {
          afterLink: () => {
            const path = changedPath === 'source' ? staged : target;
            rmSync(path);
            writeFileSync(path, 'candidate');
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid' });

      expect(readFileSync(changedPath === 'source' ? staged : target, 'utf8')).toBe('candidate');
    },
  );

  it.each(['source', 'target'] as const)(
    'rejects when the linked %s path is replaced after validation but before staging cleanup',
    async (changedPath) => {
      const root = temporaryRoot(`workspace-file-install-${changedPath}-late-swap-`);
      const staged = join(root, 'marker.staged');
      const target = join(root, 'workspace-safety.json');
      writeFileSync(staged, 'candidate');

      await expect(
        installFileNoReplace(staged, target, {
          beforeSourceUnlink: () => {
            const path = changedPath === 'source' ? staged : target;
            rmSync(path);
            writeFileSync(path, 'candidate');
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid' });

      expect(readFileSync(changedPath === 'source' ? staged : target, 'utf8')).toBe('candidate');
    },
  );

  it('rejects a symlink and a path swapped after open but before identity binding', async () => {
    const root = temporaryRoot('workspace-stable-read-');
    const first = join(root, 'first.txt');
    const second = join(root, 'second.txt');
    const target = join(root, 'target.txt');
    writeFileSync(first, 'first');
    writeFileSync(second, 'second');
    symlinkSync(first, target);

    await expect(readExactFile(target)).rejects.toMatchObject({ code: 'invalid' });

    rmSync(target);
    writeFileSync(target, 'first');
    await expect(
      readExactFile(target, {
        afterOpen: () => {
          rmSync(target);
          writeFileSync(target, 'second');
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    writeFileSync(target, 'stable');
    await expect(
      readExactFile(target, {
        afterRead: () => writeFileSync(target, 'changed-after-read'),
      }),
    ).rejects.toMatchObject({ code: 'invalid' });
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a FIFO without waiting for a writer',
    async () => {
      const root = temporaryRoot('workspace-fifo-read-');
      const fifo = join(root, 'blocked.fifo');
      const created = spawnSync('mkfifo', [fifo], { encoding: 'utf8', timeout: 5_000 });
      expect(created.error).toBeUndefined();
      expect(created.status, created.stderr).toBe(0);

      const startedAt = Date.now();
      await expect(readExactFile(fifo)).rejects.toMatchObject({ code: 'invalid' });
      expect(Date.now() - startedAt).toBeLessThan(1_000);
    },
  );

  it('rejects hard links so canonical safety bytes cannot alias another path', async () => {
    const root = temporaryRoot('workspace-hardlink-read-');
    const source = join(root, 'source.json');
    const alias = join(root, 'canonical.json');
    writeFileSync(source, '{}');
    linkSync(source, alias);

    await expect(readExactFile(alias)).rejects.toMatchObject({ code: 'invalid' });
  });

  it('cannot replace a complete non-empty competitor that wins at the rename boundary', async () => {
    const root = temporaryRoot('workspace-directory-race-');
    const candidate = await createStagingDirectory(root, 'lease.prepare-', 'candidate');
    await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
    const target = join(root, 'lease');

    await expect(
      moveDirectoryNoReplace(candidate, target, {
        beforeRename: () => {
          mkdirSync(target);
          writeFileSync(join(target, 'owner.json'), 'winner');
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(readFileSync(join(target, 'owner.json'), 'utf8')).toBe('winner');
    expect(readFileSync(join(candidate, 'owner.json'), 'utf8')).toBe('candidate');
  });

  it('runs the synchronous commit check after async preparation and before rename', async () => {
    const root = temporaryRoot('workspace-directory-commit-check-');
    const candidate = await createStagingDirectory(root, 'lease.prepare-', 'candidate');
    await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
    const target = join(root, 'lease');
    const order: string[] = [];

    await expect(
      moveDirectoryNoReplace(candidate, target, {
        beforeRename: async () => {
          await Promise.resolve();
          order.push('prepared');
        },
        commitCheck: () => {
          order.push('commit-check');
          throw new Error('preserve-before-rename');
        },
      }),
    ).rejects.toThrow('preserve-before-rename');

    expect(order).toEqual(['prepared', 'commit-check']);
    expect(readFileSync(join(candidate, 'owner.json'), 'utf8')).toBe('candidate');
    expect(() => readFileSync(join(target, 'owner.json'))).toThrow();
  });

  it.each(['EPERM', 'EACCES'])(
    'retries a transient Windows %s rename failure only after repeating every commit check',
    async (errorCode) => {
      const root = temporaryRoot('workspace-directory-windows-retry-');
      const protocolRoot = join(root, 'engine.lock');
      mkdirSync(protocolRoot);
      const candidate = await createStagingDirectory(
        protocolRoot,
        'operation.prepare-',
        'candidate',
      );
      await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
      const target = join(protocolRoot, 'operation');
      const delays: number[] = [];
      let renameCalls = 0;
      let commitChecks = 0;

      await moveDirectoryNoReplace(candidate, target, {
        platform: 'win32',
        commitCheck: () => {
          commitChecks += 1;
        },
        renameDirectory: (source, destination) => {
          renameCalls += 1;
          if (renameCalls === 1) {
            throw Object.assign(new Error('temporarily busy'), { code: errorCode });
          }
          renameSync(source, destination);
        },
        waitBeforeRetry: (delayMs) => {
          delays.push(delayMs);
        },
      });

      expect(renameCalls).toBe(2);
      expect(commitChecks).toBe(2);
      expect(delays).toEqual([25]);
      expect(readFileSync(join(target, 'owner.json'), 'utf8')).toBe('candidate');
      expect(existsSync(candidate)).toBe(false);
    },
  );

  it('bounds persistent Windows rename sharing failures without changing either directory', async () => {
    const root = temporaryRoot('workspace-directory-windows-busy-');
    const candidate = await createStagingDirectory(root, 'lease.prepare-', 'candidate');
    await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
    const target = join(root, 'lease');
    const delays: number[] = [];
    let renameCalls = 0;
    let commitChecks = 0;

    await expect(
      moveDirectoryNoReplace(candidate, target, {
        platform: 'win32',
        commitCheck: () => {
          commitChecks += 1;
        },
        renameDirectory: () => {
          renameCalls += 1;
          throw Object.assign(new Error('still busy'), { code: 'EACCES' });
        },
        waitBeforeRetry: (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(renameCalls).toBe(4);
    expect(commitChecks).toBe(4);
    expect(delays).toEqual([25, 50, 100]);
    expect(readFileSync(join(candidate, 'owner.json'), 'utf8')).toBe('candidate');
    expect(existsSync(target)).toBe(false);
  });

  it('does not retry when a competing Windows target appears during the retry wait', async () => {
    const root = temporaryRoot('workspace-directory-windows-competitor-');
    const candidate = await createStagingDirectory(root, 'lease.prepare-', 'candidate');
    await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
    const target = join(root, 'lease');
    const delays: number[] = [];
    let renameCalls = 0;

    await expect(
      moveDirectoryNoReplace(candidate, target, {
        platform: 'win32',
        renameDirectory: () => {
          renameCalls += 1;
          throw Object.assign(new Error('temporarily busy'), { code: 'EPERM' });
        },
        waitBeforeRetry: (delayMs) => {
          delays.push(delayMs);
          mkdirSync(target);
          writeFileSync(join(target, 'owner.json'), 'winner');
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(renameCalls).toBe(1);
    expect(delays).toEqual([25]);
    expect(readFileSync(join(target, 'owner.json'), 'utf8')).toBe('winner');
    expect(readFileSync(join(candidate, 'owner.json'), 'utf8')).toBe('candidate');
  });

  it('rechecks that the Windows source remains non-empty before retrying', async () => {
    const root = temporaryRoot('workspace-directory-windows-source-change-');
    const candidate = await createStagingDirectory(root, 'lease.prepare-', 'candidate');
    const owner = join(candidate, 'owner.json');
    await writeNewFile(owner, Buffer.from('candidate'));
    const target = join(root, 'lease');
    let renameCalls = 0;

    await expect(
      moveDirectoryNoReplace(candidate, target, {
        platform: 'win32',
        renameDirectory: () => {
          renameCalls += 1;
          throw Object.assign(new Error('temporarily busy'), { code: 'EPERM' });
        },
        waitBeforeRetry: () => {
          rmSync(owner);
        },
      }),
    ).rejects.toMatchObject({ code: 'invalid' });

    expect(renameCalls).toBe(1);
    expect(existsSync(candidate)).toBe(true);
    expect(existsSync(target)).toBe(false);
  });

  it.runIf(process.platform === 'win32')(
    'blocks a Windows retry when a junction appears in the protocol tree during the wait',
    async () => {
      const root = temporaryRoot('workspace-directory-windows-reparse-retry-');
      const external = temporaryRoot('workspace-directory-windows-reparse-target-');
      const protocolRoot = join(root, 'engine.lock');
      mkdirSync(protocolRoot);
      const candidate = await createStagingDirectory(
        protocolRoot,
        'operation.prepare-',
        'candidate',
      );
      await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
      const target = join(protocolRoot, 'operation');
      let renameCalls = 0;

      await expect(
        moveDirectoryNoReplace(candidate, target, {
          renameDirectory: () => {
            renameCalls += 1;
            throw Object.assign(new Error('temporarily busy'), { code: 'EPERM' });
          },
          waitBeforeRetry: () => {
            symlinkSync(external, join(protocolRoot, 'injected-junction'), 'junction');
          },
        }),
      ).rejects.toMatchObject({ code: 'invalid' });

      expect(renameCalls).toBe(1);
      expect(readFileSync(join(candidate, 'owner.json'), 'utf8')).toBe('candidate');
      expect(existsSync(target)).toBe(false);
    },
  );

  it('lets a repeated commit check cancel a Windows rename retry', async () => {
    const root = temporaryRoot('workspace-directory-windows-recheck-');
    const candidate = await createStagingDirectory(root, 'lease.prepare-', 'candidate');
    await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
    const target = join(root, 'lease');
    let renameCalls = 0;
    let commitChecks = 0;

    await expect(
      moveDirectoryNoReplace(candidate, target, {
        platform: 'win32',
        commitCheck: () => {
          commitChecks += 1;
          if (commitChecks === 2) throw new Error('authority changed');
        },
        renameDirectory: () => {
          renameCalls += 1;
          throw Object.assign(new Error('temporarily busy'), { code: 'EPERM' });
        },
        waitBeforeRetry: () => undefined,
      }),
    ).rejects.toThrow('authority changed');

    expect(renameCalls).toBe(1);
    expect(commitChecks).toBe(2);
    expect(readFileSync(join(candidate, 'owner.json'), 'utf8')).toBe('candidate');
    expect(existsSync(target)).toBe(false);
  });

  it.each([
    { label: 'POSIX EPERM', platform: 'linux' as const, code: 'EPERM' },
    { label: 'Windows EEXIST', platform: 'win32' as const, code: 'EEXIST' },
    { label: 'Windows ENOTEMPTY', platform: 'win32' as const, code: 'ENOTEMPTY' },
  ])('does not retry an immediate $label conflict', async ({ platform, code }) => {
    const root = temporaryRoot('workspace-directory-immediate-conflict-');
    const candidate = await createStagingDirectory(root, 'lease.prepare-', 'candidate');
    await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
    const target = join(root, 'lease');
    const delays: number[] = [];
    let renameCalls = 0;

    await expect(
      moveDirectoryNoReplace(candidate, target, {
        platform,
        renameDirectory: () => {
          renameCalls += 1;
          throw Object.assign(new Error('immediate conflict'), { code });
        },
        waitBeforeRetry: (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toMatchObject({ code: 'conflict' });

    expect(renameCalls).toBe(1);
    expect(delays).toEqual([]);
  });

  it('does not turn an unrelated Windows rename error into a retry or conflict', async () => {
    const root = temporaryRoot('workspace-directory-windows-io-error-');
    const candidate = await createStagingDirectory(root, 'lease.prepare-', 'candidate');
    await writeNewFile(join(candidate, 'owner.json'), Buffer.from('candidate'));
    const target = join(root, 'lease');
    const failure = Object.assign(new Error('storage failure'), { code: 'EIO' });
    const delays: number[] = [];

    await expect(
      moveDirectoryNoReplace(candidate, target, {
        platform: 'win32',
        renameDirectory: () => {
          throw failure;
        },
        waitBeforeRetry: (delayMs) => {
          delays.push(delayMs);
        },
      }),
    ).rejects.toBe(failure);

    expect(delays).toEqual([]);
    expect(readFileSync(join(candidate, 'owner.json'), 'utf8')).toBe('candidate');
    expect(existsSync(target)).toBe(false);
  });

  it('canonicalizes a stable symbolic-link alias to the same workspace identity', async () => {
    const root = temporaryRoot('workspace-real-');
    const parent = temporaryRoot('workspace-link-parent-');
    const link = join(parent, 'workspace');
    symlinkSync(root, link, process.platform === 'win32' ? 'junction' : 'dir');

    const direct = await canonicalizeWorkspaceDirectory(root);
    const aliased = await canonicalizeWorkspaceDirectory(link);

    expect(aliased.path).toBe(direct.path);
    expect(aliased.identity).toBe(direct.identity);
    expect(aliased.requestedKind).toBe('symlink');
    await expect(workspacePathsReferToSameDirectory(root, link)).resolves.toBe(true);
  });
});
