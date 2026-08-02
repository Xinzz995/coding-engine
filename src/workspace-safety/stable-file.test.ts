import { execFileSync } from 'node:child_process';
import { mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { readStableFile } from './stable-file.js';

function temporaryFile(): { root: string; path: string } {
  const root = mkdtempSync(join(tmpdir(), 'coding-x-stable-file-'));
  return { root, path: join(root, 'authority.json') };
}

describe('readStableFile', () => {
  it('reads one bounded ordinary file and binds its bytes', () => {
    const target = temporaryFile();
    try {
      writeFileSync(target.path, '{"ok":true}\n');
      expect(readStableFile(target.path)).toMatchObject({
        status: 'ready',
        bytes: Buffer.from('{"ok":true}\n'),
        fingerprint: expect.stringMatching(/^sha256:[a-f0-9]{64}$/u),
      });
    } finally {
      rmSync(target.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('rejects a FIFO without waiting for a writer', () => {
    const target = temporaryFile();
    try {
      execFileSync('mkfifo', [target.path]);
      expect(readStableFile(target.path)).toMatchObject({
        status: 'invalid',
        diagnostic: expect.stringContaining('不是独立普通文件'),
      });
    } finally {
      rmSync(target.root, { recursive: true, force: true });
    }
  });

  it('rejects a file above the caller bound before allocating it', () => {
    const target = temporaryFile();
    try {
      writeFileSync(target.path, Buffer.alloc(9));
      expect(readStableFile(target.path, { maxBytes: 8 })).toMatchObject({
        status: 'invalid',
        diagnostic: expect.stringContaining('超过 8 bytes'),
      });
    } finally {
      rmSync(target.root, { recursive: true, force: true });
    }
  });

  it.runIf(process.platform !== 'win32')('rejects path replacement after opening', () => {
    const target = temporaryFile();
    const replacement = join(target.root, 'replacement.json');
    try {
      writeFileSync(target.path, 'first');
      writeFileSync(replacement, 'other');
      const result = readStableFile(target.path, {
        hooks: { afterOpen: () => renameSync(replacement, target.path) },
      });
      expect(result).toMatchObject({
        status: 'invalid',
        diagnostic: expect.stringContaining('身份在打开期间发生变化'),
      });
    } finally {
      rmSync(target.root, { recursive: true, force: true });
    }
  });
});
