import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect } from 'vitest';
import { PROGRESS_CONTROL_FILE_MAX_BYTES, readProgress } from './progress.js';

describe('readProgress', () => {
  it('returns empty string for a missing file', () => {
    expect(readProgress('/no/such/progress.md')).toBe('');
  });

  it.skipIf(process.platform === 'win32')('returns promptly for a FIFO', () => {
    const root = mkdtempSync(join(tmpdir(), 'progress-fifo-'));
    try {
      const path = join(root, 'progress.md');
      execFileSync('mkfifo', [path]);
      const started = Date.now();
      expect(readProgress(path)).toBe('');
      expect(Date.now() - started).toBeLessThan(1_000);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it('returns empty string instead of loading an oversized progress file', () => {
    const root = mkdtempSync(join(tmpdir(), 'progress-large-'));
    try {
      const path = join(root, 'progress.md');
      writeFileSync(path, 'x'.repeat(PROGRESS_CONTROL_FILE_MAX_BYTES + 1));
      expect(readProgress(path)).toBe('');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
