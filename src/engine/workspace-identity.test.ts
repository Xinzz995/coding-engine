import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { writeFileAtomicSync } from './fs-atomic.js';
import { readSafeControlFileUtf8Sync } from './safe-control-file.js';
import {
  freezeWorkspaceDirectory,
  removeRegisteredWorkspaceFileSync,
} from './workspace-identity.js';

describe('workspace directory identity', () => {
  it.skipIf(process.platform === 'win32')(
    'rejects reads and writes after the whole workspace becomes an external symlink',
    () => {
      const parent = mkdtempSync(join(tmpdir(), 'workspace-identity-'));
      const workspace = join(parent, 'workspace');
      const moved = join(parent, 'workspace-original');
      const outside = join(parent, 'outside');
      try {
        mkdirSync(workspace);
        mkdirSync(outside);
        writeFileSync(join(workspace, 'state.json'), '{"trusted":true}\n');
        writeFileSync(join(outside, 'state.json'), '{"outside":true}\n');
        freezeWorkspaceDirectory(workspace);

        renameSync(workspace, moved);
        symlinkSync(outside, workspace, 'dir');

        expect(() =>
          readSafeControlFileUtf8Sync(join(workspace, 'state.json'), { maxBytes: 1024 }),
        ).toThrow(/工作区.*(?:移动|替换|软链)/);
        expect(() =>
          writeFileAtomicSync(join(workspace, 'state.json'), '{"forged":true}\n'),
        ).toThrow(/工作区.*(?:移动|替换|软链)/);
        expect(() =>
          removeRegisteredWorkspaceFileSync(join(workspace, 'state.json'), true),
        ).toThrow(/工作区.*(?:移动|替换|软链)/);
        expect(readFileSync(join(outside, 'state.json'), 'utf8')).toBe('{"outside":true}\n');
      } finally {
        rmSync(parent, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')('rejects a workspace that starts as a symlink', () => {
    const parent = mkdtempSync(join(tmpdir(), 'workspace-symlink-'));
    try {
      const target = join(parent, 'target');
      const workspace = join(parent, 'workspace');
      mkdirSync(target);
      symlinkSync(target, workspace, 'dir');
      expect(() => freezeWorkspaceDirectory(workspace)).toThrow(/不能是软链/);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});
