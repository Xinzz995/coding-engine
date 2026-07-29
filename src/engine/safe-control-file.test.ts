import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  appendSafeControlFileUtf8Sync,
  SafeControlFileError,
  readSafeControlFileUtf8Sync,
  readSafeProjectFileUtf8Sync,
} from './safe-control-file.js';

function workspace(): string {
  return mkdtempSync(join(tmpdir(), 'safe-control-file-'));
}

describe('safe control file reader', () => {
  it('reads one bounded regular UTF-8 file and distinguishes genuine absence', () => {
    const root = workspace();
    try {
      const path = join(root, 'state.json');
      writeFileSync(path, '{"safe":true}\n');
      expect(readSafeControlFileUtf8Sync(path, { maxBytes: 64 })).toBe('{"safe":true}\n');
      expect(
        readSafeControlFileUtf8Sync(join(root, 'missing.json'), {
          maxBytes: 64,
          allowMissing: true,
        }),
      ).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('fails closed for directories, oversized files and invalid UTF-8', () => {
    const root = workspace();
    try {
      const directory = join(root, 'directory');
      mkdirSync(directory);
      expect(() => readSafeControlFileUtf8Sync(directory, { maxBytes: 64 })).toThrow(
        SafeControlFileError,
      );

      const oversized = join(root, 'oversized.json');
      writeFileSync(oversized, 'x'.repeat(65));
      expect(() => readSafeControlFileUtf8Sync(oversized, { maxBytes: 64 })).toThrow(
        expect.objectContaining({ code: 'too-large' }),
      );

      const invalid = join(root, 'invalid.json');
      writeFileSync(invalid, Buffer.from([0xff]));
      expect(() => readSafeControlFileUtf8Sync(invalid, { maxBytes: 64 })).toThrow(
        expect.objectContaining({ code: 'invalid-encoding' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')('never follows the final control-file symlink', () => {
    const root = workspace();
    try {
      const outside = join(root, 'outside.json');
      const linked = join(root, 'state.json');
      writeFileSync(outside, '{"forged":true}\n');
      symlinkSync(outside, linked);
      expect(() => readSafeControlFileUtf8Sync(linked, { maxBytes: 64 })).toThrow(
        SafeControlFileError,
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it.skipIf(process.platform === 'win32')(
    'rejects a project file whose parent directory resolves outside the project',
    () => {
      const root = workspace();
      const outside = workspace();
      try {
        writeFileSync(join(outside, 'quality.json'), '{"outside":true}\n');
        symlinkSync(outside, join(root, '.coding-x'), 'dir');
        expect(() =>
          readSafeProjectFileUtf8Sync(root, join(root, '.coding-x', 'quality.json'), {
            maxBytes: 64,
          }),
        ).toThrow(expect.objectContaining({ code: 'unsafe-type' }));
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(outside, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'rejects a real FIFO without waiting for a writer',
    () => {
      const root = workspace();
      try {
        const fifo = join(root, 'state.json');
        execFileSync('mkfifo', [fifo]);
        const started = Date.now();
        expect(() => readSafeControlFileUtf8Sync(fifo, { maxBytes: 64 })).toThrow(
          expect.objectContaining({ code: 'unsafe-type' }),
        );
        expect(Date.now() - started).toBeLessThan(1_000);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'never follows or blocks on an unsafe append target',
    () => {
      const root = workspace();
      try {
        const fifo = join(root, 'evidence.jsonl');
        execFileSync('mkfifo', [fifo]);
        const started = Date.now();
        expect(() => appendSafeControlFileUtf8Sync(fifo, '{}\n', { maxBytes: 64 })).toThrow(
          SafeControlFileError,
        );
        expect(Date.now() - started).toBeLessThan(1_000);

        const outside = join(root, 'outside.jsonl');
        const linked = join(root, 'linked.jsonl');
        writeFileSync(outside, 'outside\n');
        symlinkSync(outside, linked);
        expect(() => appendSafeControlFileUtf8Sync(linked, '{}\n', { maxBytes: 64 })).toThrow(
          SafeControlFileError,
        );
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    },
  );

  it('appends only within the declared byte bound', () => {
    const root = workspace();
    try {
      const path = join(root, 'evidence.jsonl');
      writeFileSync(path, '1234');
      appendSafeControlFileUtf8Sync(path, '56', { maxBytes: 6 });
      expect(readSafeControlFileUtf8Sync(path, { maxBytes: 6 })).toBe('123456');
      expect(() => appendSafeControlFileUtf8Sync(path, '7', { maxBytes: 6 })).toThrow(
        expect.objectContaining({ code: 'too-large' }),
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
