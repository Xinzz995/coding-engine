import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  assertCleanValidationTreeHasNoMountPoints,
  assertNoMountedPathsAtOrBelowForTests,
  isPathOnTrustedLocalDarwinMountForTests,
  isTrustedDarwinHardLinkBackingForTests,
  isTrustedDarwinHardLinkFileSystemForTests,
  isTrustedLinuxHardLinkFileSystemForTests,
  parseDarwinMountOutputForTests,
  parseTrustedLocalDarwinMountPathsForTests,
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
  it('uses a narrow positive list for filesystems with trusted hard-link counts', () => {
    for (const type of [0xef53n, 0x58465342n, 0x9123683en, 0x01021994n]) {
      expect(isTrustedLinuxHardLinkFileSystemForTests(type)).toBe(true);
    }
    for (const type of [0x794c7630n, 0x65735546n, 0x6969n, 0x12345678n]) {
      expect(isTrustedLinuxHardLinkFileSystemForTests(type)).toBe(false);
    }
    expect(isTrustedDarwinHardLinkFileSystemForTests('apfs')).toBe(true);
    expect(isTrustedDarwinHardLinkFileSystemForTests('HFS')).toBe(true);
    expect(isTrustedDarwinHardLinkFileSystemForTests('exfat')).toBe(false);
    expect(isTrustedDarwinHardLinkFileSystemForTests('macfuse')).toBe(false);
    expect(isTrustedDarwinHardLinkBackingForTests('apfs', 0x1an, 0x1an, true)).toBe(true);
    expect(isTrustedDarwinHardLinkBackingForTests('apfs', 0x1an, 0x19n, true)).toBe(false);
    expect(isTrustedDarwinHardLinkBackingForTests('apfs', 0x1an, 0x1an, false)).toBe(false);
  });

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

  it('derives trusted local Darwin volumes from names and local flags, not f_type numbers', () => {
    const table = Buffer.from(
      [
        '/dev/disk3s1s1 on / (apfs, sealed, local, read-only)',
        'devfs on /dev (devfs, local, nobrowse)',
        'map auto_home on /System/Volumes/Data/home (autofs, automounted)',
        'server:/share on /Volumes/share (nfs)',
        'fuse-t on /Volumes/tool (macfuse, local)',
        'kit-t on /Volumes/kit (apfs, local, fskit)',
        'synth on /Volumes/synth (synthfs, local)',
        '/dev/disk4s1 on /Volumes/portable (exfat, local)',
        '',
      ].join('\n'),
    );
    expect(parseTrustedLocalDarwinMountPathsForTests(table)).toEqual(['/', '/Volumes/portable']);
    expect(isPathOnTrustedLocalDarwinMountForTests(table, '/private/tmp/tool')).toBe(true);
    expect(isPathOnTrustedLocalDarwinMountForTests(table, '/Volumes/portable/tool')).toBe(true);
    expect(isPathOnTrustedLocalDarwinMountForTests(table, '/Volumes/share/tool')).toBe(false);
    expect(isPathOnTrustedLocalDarwinMountForTests(table, '/Volumes/kit/tool')).toBe(false);
    expect(isPathOnTrustedLocalDarwinMountForTests(table, '/Volumes/synth/tool')).toBe(false);
    expect(isPathOnTrustedLocalDarwinMountForTests(table, '/dev/fd/1')).toBe(false);
    expect(isPathOnTrustedLocalDarwinMountForTests(table, '/Volumes/share-sibling/tool')).toBe(
      true,
    );
    expect(() =>
      parseDarwinMountOutputForTests(
        Buffer.from('/dev/disk1 on / (apfs, local)\n/dev/disk2 on / (apfs, local)\n'),
      ),
    ).toThrow(/重复挂载路径/u);
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

  it.runIf(process.platform === 'linux' || process.platform === 'darwin')(
    'allows an intermediate path link but rejects moving the root and linking its final name back',
    () => {
      const container = mkdtempSync(join(tmpdir(), 'coding-x-mount-root-identity-'));
      roots.push(container);
      const realParent = join(container, 'real-parent');
      const parentAlias = join(container, 'parent-alias');
      const root = join(realParent, 'checkout');
      const movedRoot = join(realParent, 'moved-checkout');
      mkdirSync(root, { recursive: true });
      symlinkSync(realParent, parentAlias, 'dir');
      const rootThroughIntermediateLink = join(parentAlias, 'checkout');

      expect(() =>
        assertCleanValidationTreeHasNoMountPoints(rootThroughIntermediateLink),
      ).not.toThrow();

      renameSync(root, movedRoot);
      symlinkSync(movedRoot, root, 'dir');
      expect(() => assertCleanValidationTreeHasNoMountPoints(rootThroughIntermediateLink)).toThrow(
        /最终分量不是普通目录/u,
      );
    },
  );

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
