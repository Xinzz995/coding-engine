import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCleanValidationTreeHasNoMountPoints,
  assertNoMountedPathsAtOrBelowForTests,
  parseDarwinMountOutputForTests,
  parseLinuxMountInfoForTests,
} from './clean-validation-mounts.js';

const roots: string[] = [];
const linuxMounts = new Set<string>();

afterEach(() => {
  for (const target of [...linuxMounts]) {
    execFileSync('/usr/bin/sudo', ['-n', '/bin/umount', target], {
      stdio: ['ignore', 'ignore', 'pipe'],
    });
    linuxMounts.delete(target);
  }
  while (roots.length > 0) rmSync(roots.pop()!, { recursive: true, force: true });
});

describe('clean validation mount proof', () => {
  it('parses escaped Linux mountinfo paths and rejects malformed records', () => {
    expect(
      parseLinuxMountInfoForTests(
        Buffer.from(
          [
            '36 25 0:32 / / rw,relatime - overlay overlay rw',
            '37 36 0:33 / /tmp/coding-x\\040validation rw,nosuid - tmpfs tmpfs rw',
            '',
          ].join('\n'),
        ),
      ),
    ).toEqual(['/', '/tmp/coding-x validation']);
    expect(() =>
      parseLinuxMountInfoForTests(Buffer.from('36 25 0:32 / /tmp/escape\\999 rw - tmpfs x rw\n')),
    ).toThrow(/无法证明/u);
    expect(() => parseLinuxMountInfoForTests(Buffer.from('not mountinfo\n'))).toThrow(/无法证明/u);
  });

  it('parses macOS mount output and rejects delimiter ambiguity', () => {
    expect(
      parseDarwinMountOutputForTests(
        Buffer.from(
          [
            '/dev/disk3s1s1 on / (apfs, sealed, local, read-only)',
            'map auto_home on /System/Volumes/Data/home (autofs, automounted)',
            '',
          ].join('\n'),
        ),
      ),
    ).toEqual(['/', '/System/Volumes/Data/home']);
    expect(() =>
      parseDarwinMountOutputForTests(
        Buffer.from('/dev/disk on /tmp/coding-x on escaped (apfs, local)\n'),
      ),
    ).toThrow(/无法证明/u);
    expect(() => parseDarwinMountOutputForTests(Buffer.from('not mount output\n'))).toThrow(
      /无法证明/u,
    );
  });

  it('rejects the root and true descendants without confusing a same-prefix sibling', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-mount-containment-'));
    roots.push(root);
    expect(() => assertNoMountedPathsAtOrBelowForTests(root, [root])).toThrow(/挂载点/u);
    expect(() =>
      assertNoMountedPathsAtOrBelowForTests(root, [join(root, 'checkout', 'mounted')]),
    ).toThrow(/挂载点/u);
    expect(() => assertNoMountedPathsAtOrBelowForTests(root, [`${root}-sibling`])).not.toThrow();
  });

  it.runIf(
    process.platform === 'linux' || process.platform === 'darwin' || process.platform === 'win32',
  )('accepts an ordinary empty temporary directory using the live platform proof', () => {
    const root = mkdtempSync(join(tmpdir(), 'coding-x-mount-live-'));
    roots.push(root);
    expect(() => assertCleanValidationTreeHasNoMountPoints(root)).not.toThrow();
  });

  it.runIf(process.platform === 'linux' && process.env.CODING_X_RUN_LINUX_MOUNT_PROOF === '1')(
    'rejects a real Linux bind mount before recursive cleanup',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-mount-native-linux-'));
      roots.push(root);
      const source = join(root, 'external-source');
      const target = join(root, 'checkout', 'dist', 'mounted');
      mkdirSync(source, { recursive: true });
      mkdirSync(target, { recursive: true });
      writeFileSync(join(source, 'sentinel.txt'), 'must survive\n');
      execFileSync('/usr/bin/sudo', ['-n', '/bin/mount', '--bind', source, target], {
        stdio: ['ignore', 'ignore', 'pipe'],
      });
      linuxMounts.add(target);
      try {
        expect(() => assertCleanValidationTreeHasNoMountPoints(root)).toThrow(/挂载点/u);
      } finally {
        execFileSync('/usr/bin/sudo', ['-n', '/bin/umount', target], {
          stdio: ['ignore', 'ignore', 'pipe'],
        });
        linuxMounts.delete(target);
      }
    },
  );

  it.runIf(process.platform === 'win32')(
    'rejects a real Windows junction before recursive cleanup',
    () => {
      const root = mkdtempSync(join(tmpdir(), 'coding-x-mount-native-windows-'));
      roots.push(root);
      const source = join(root, 'external-source');
      const target = join(root, 'checkout', 'dist', 'mounted');
      mkdirSync(source, { recursive: true });
      mkdirSync(join(root, 'checkout', 'dist'), { recursive: true });
      writeFileSync(join(source, 'sentinel.txt'), 'must survive\n');
      symlinkSync(source, target, 'junction');
      try {
        expect(() => assertCleanValidationTreeHasNoMountPoints(root)).toThrow(/reparse point/u);
      } finally {
        rmSync(target, { force: true });
      }
    },
  );
});
