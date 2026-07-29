import { describe, it, expect, afterEach } from 'vitest';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { writeFileAtomicSync } from './fs-atomic.js';

let cleanup: Array<() => void> = [];
afterEach(() => {
  cleanup.forEach((f) => f());
  cleanup = [];
});

function ws(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fs-atomic-'));
  cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
  return dir;
}

describe('writeFileAtomicSync', () => {
  it('writes new file content correctly with no tmp residue', () => {
    const dir = ws();
    const target = join(dir, 'state.json');
    writeFileAtomicSync(target, '{"a":1}');
    expect(readFileSync(target, 'utf-8')).toBe('{"a":1}');
    expect(readdirSync(dir).filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
  });

  it('overwrites an existing file', () => {
    const dir = ws();
    const target = join(dir, 'state.json');
    writeFileSync(target, 'old');
    writeFileAtomicSync(target, 'new');
    expect(readFileSync(target, 'utf-8')).toBe('new');
  });

  it('cleans up the tmp file and rethrows when rename fails', () => {
    const dir = ws();
    // 目标是非空目录 → renameSync 必败（POSIX EISDIR/ENOTEMPTY，win32 EPERM）
    mkdirSync(join(dir, 'target'));
    writeFileSync(join(dir, 'target', 'occupied'), 'x');
    expect(() => writeFileAtomicSync(join(dir, 'target'), 'data')).toThrow();
    expect(readdirSync(dir).filter((n) => /\.tmp-\d+$/.test(n))).toEqual([]);
  });

  it.skipIf(process.platform === 'win32')('never follows a pre-positioned tmp symlink', () => {
    const dir = ws();
    const target = join(dir, 'state.json');
    const outside = join(dir, 'outside.txt');
    writeFileSync(outside, 'outside');
    symlinkSync(outside, `${target}.tmp-${process.pid}`);
    expect(() => writeFileAtomicSync(target, 'forged')).toThrow();
    expect(readFileSync(outside, 'utf8')).toBe('outside');
  });
});
