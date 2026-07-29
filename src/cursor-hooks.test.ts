import { createHash } from 'node:crypto';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterEach, describe, expect, it } from 'vitest';
import { CURSOR_HOOK_COMMAND, CURSOR_HOOK_MATCHER, runCursorHookAction } from './cursor-hooks.js';

const cleanups: Array<() => void> = [];

afterEach(() => {
  cleanups
    .splice(0)
    .reverse()
    .forEach((cleanup) => cleanup());
});

function git(root: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
}

function fixture(prefix = 'coding-x cursor hooks repo with spaces-'): {
  root: string;
  bundle: string;
} {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const bundleDir = mkdtempSync(join(tmpdir(), 'coding-x cursor hook bundle-'));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  cleanups.push(() => rmSync(bundleDir, { recursive: true, force: true }));
  git(root, 'init', '-q');
  const bundle = join(bundleDir, 'tdd-commit-check.mjs');
  writeFileSync(bundle, '#!/usr/bin/env node\nconsole.log("bundle-v1");\n');
  return { root, bundle };
}

function config(root: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, '.cursor', 'hooks.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function managedEntries(root: string): Array<Record<string, unknown>> {
  const value = config(root);
  const hooks = value.hooks as Record<string, unknown>;
  return (hooks.beforeShellExecution as Array<Record<string, unknown>>).filter(
    (entry) => entry.command === CURSOR_HOOK_COMMAND,
  );
}

function sha256(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

describe('Cursor project TDD hook management', () => {
  it('matches commit commands without using the old backtracking expression', () => {
    const matcher = new RegExp(CURSOR_HOOK_MATCHER, 'i');
    expect(matcher.test('git -C "repo with spaces" commit -m story')).toBe(true);
    expect(matcher.test('/usr/bin/git -c user.name=test commit --amend')).toBe(true);
    expect(matcher.test('git status')).toBe(false);
  });

  it('installs once, reports healthy, and stays idempotent', () => {
    const value = fixture();

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 0,
      status: 'installed',
    });
    expect(runCursorHookAction('status', value)).toMatchObject({
      exitCode: 0,
      status: 'healthy',
    });
    expect(runCursorHookAction('install', value).exitCode).toBe(0);
    expect(managedEntries(value.root)).toHaveLength(1);

    const installed = join(value.root, '.cursor', 'coding-x', 'tdd-commit-check.mjs');
    const record = JSON.parse(
      readFileSync(join(value.root, '.cursor', 'coding-x', 'install.json'), 'utf8'),
    ) as { hookSha256: string };
    expect(readFileSync(installed, 'utf8')).toContain('bundle-v1');
    expect(record.hookSha256).toBe(sha256(installed));
  });

  it('preserves unrelated Cursor configuration and removes only managed content', () => {
    const value = fixture();
    const cursorDir = join(value.root, '.cursor');
    mkdirSync(cursorDir);
    const original = {
      version: 1,
      custom: { keep: true },
      hooks: {
        beforeShellExecution: [{ command: 'node existing-hook.mjs', timeout: 12 }],
        afterShellExecution: [{ command: 'node after.mjs' }],
      },
    };
    writeFileSync(join(cursorDir, 'hooks.json'), `${JSON.stringify(original, null, 2)}\n`);

    expect(runCursorHookAction('install', value).exitCode).toBe(0);
    expect(runCursorHookAction('remove', value)).toMatchObject({
      exitCode: 0,
      status: 'removed',
    });
    expect(config(value.root)).toEqual(original);
    expect(existsSync(join(cursorDir, 'coding-x'))).toBe(false);
    expect(runCursorHookAction('status', value)).toMatchObject({
      exitCode: 1,
      status: 'missing',
    });
  });

  it('removes directories and config that were created by the installer', () => {
    const value = fixture();

    expect(runCursorHookAction('install', value).exitCode).toBe(0);
    rmSync(value.bundle);
    expect(runCursorHookAction('remove', value).exitCode).toBe(0);
    expect(existsSync(join(value.root, '.cursor'))).toBe(false);
  });

  it('detects an old managed copy and safely refreshes it from the current bundle', () => {
    const value = fixture();
    expect(runCursorHookAction('install', value).exitCode).toBe(0);

    writeFileSync(value.bundle, '#!/usr/bin/env node\nconsole.log("bundle-v2");\n');
    expect(runCursorHookAction('status', value)).toMatchObject({
      exitCode: 1,
      status: 'stale',
    });
    expect(runCursorHookAction('install', value).exitCode).toBe(0);
    expect(
      readFileSync(join(value.root, '.cursor', 'coding-x', 'tdd-commit-check.mjs'), 'utf8'),
    ).toContain('bundle-v2');
    expect(runCursorHookAction('status', value).exitCode).toBe(0);
  });

  it('refuses invalid JSON without creating any managed files', () => {
    const value = fixture();
    const cursorDir = join(value.root, '.cursor');
    mkdirSync(cursorDir);
    const path = join(cursorDir, 'hooks.json');
    writeFileSync(path, '{ invalid');

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
    });
    expect(readFileSync(path, 'utf8')).toBe('{ invalid');
    expect(existsSync(join(cursorDir, 'coding-x'))).toBe(false);
  });

  it('rejects an oversized Cursor config before parsing or copying it', () => {
    const value = fixture();
    const cursorDir = join(value.root, '.cursor');
    mkdirSync(cursorDir);
    const path = join(cursorDir, 'hooks.json');
    writeFileSync(path, Buffer.alloc(2 * 1024 * 1024 + 1, 0x78));

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
      message: expect.stringContaining('超过 2097152 bytes'),
    });
    expect(existsSync(join(cursorDir, 'coding-x'))).toBe(false);
  });

  it('rejects invalid UTF-8 even when the surrounding Cursor config is valid JSON text', () => {
    const value = fixture();
    const cursorDir = join(value.root, '.cursor');
    mkdirSync(cursorDir);
    writeFileSync(
      join(cursorDir, 'hooks.json'),
      Buffer.concat([
        Buffer.from('{"version":1,"hooks":{},"note":"'),
        Buffer.from([0xff]),
        Buffer.from('"}\n'),
      ]),
    );

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
      message: expect.stringContaining('不是合法 UTF-8'),
    });
    expect(existsSync(join(cursorDir, 'coding-x'))).toBe(false);
  });

  it('rejects an oversized published hook without creating project files', () => {
    const value = fixture();
    writeFileSync(value.bundle, Buffer.alloc(4 * 1024 * 1024 + 1, 0x78));

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'error',
      message: expect.stringContaining('TDD hook 无效（too-large）'),
    });
    expect(existsSync(join(value.root, '.cursor'))).toBe(false);
  });

  it('refuses a conflicting hooks structure without changing it', () => {
    const value = fixture();
    const cursorDir = join(value.root, '.cursor');
    mkdirSync(cursorDir);
    const path = join(cursorDir, 'hooks.json');
    const original = '{"version":1,"hooks":{"beforeShellExecution":{}}}\n';
    writeFileSync(path, original);

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
    });
    expect(readFileSync(path, 'utf8')).toBe(original);
    expect(existsSync(join(cursorDir, 'coding-x'))).toBe(false);
  });

  it('does not overwrite or remove a user-modified managed script', () => {
    const value = fixture();
    expect(runCursorHookAction('install', value).exitCode).toBe(0);
    const installed = join(value.root, '.cursor', 'coding-x', 'tdd-commit-check.mjs');
    writeFileSync(installed, '// user changed this file\n');
    const configBefore = readFileSync(join(value.root, '.cursor', 'hooks.json'), 'utf8');

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
    });
    expect(runCursorHookAction('remove', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
    });
    expect(readFileSync(installed, 'utf8')).toBe('// user changed this file\n');
    expect(readFileSync(join(value.root, '.cursor', 'hooks.json'), 'utf8')).toBe(configBefore);
  });

  it('does not overwrite or remove a user-modified managed config entry', () => {
    const value = fixture();
    expect(runCursorHookAction('install', value).exitCode).toBe(0);
    const path = join(value.root, '.cursor', 'hooks.json');
    const changed = config(value.root);
    const hooks = changed.hooks as Record<string, unknown>;
    const entries = hooks.beforeShellExecution as Array<Record<string, unknown>>;
    entries.find((entry) => entry.command === CURSOR_HOOK_COMMAND)!.timeout = 12;
    writeFileSync(path, `${JSON.stringify(changed, null, 2)}\n`);

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
    });
    expect(runCursorHookAction('remove', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
    });
    expect((managedEntries(value.root)[0] as { timeout: number }).timeout).toBe(12);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked .cursor directory', () => {
    const value = fixture();
    const outside = mkdtempSync(join(tmpdir(), 'coding-x cursor hooks outside-'));
    cleanups.push(() => rmSync(outside, { recursive: true, force: true }));
    symlinkSync(outside, join(value.root, '.cursor'), 'dir');

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
    });
    expect(lstatSync(join(value.root, '.cursor')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(outside, 'hooks.json'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses a dangling symlink at a managed file', () => {
    const value = fixture();
    const cursorDir = join(value.root, '.cursor');
    mkdirSync(cursorDir);
    symlinkSync('missing-hooks.json', join(cursorDir, 'hooks.json'));

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'conflict',
    });
    expect(lstatSync(join(cursorDir, 'hooks.json')).isSymbolicLink()).toBe(true);
    expect(existsSync(join(cursorDir, 'coding-x'))).toBe(false);
  });

  it.runIf(process.platform !== 'win32')('refuses a symlinked published hook bundle', () => {
    const value = fixture();
    const outside = join(value.root, 'untrusted-hook.mjs');
    writeFileSync(outside, 'console.log("untrusted");\n');
    rmSync(value.bundle);
    symlinkSync(outside, value.bundle);

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'error',
    });
    expect(existsSync(join(value.root, '.cursor'))).toBe(false);
  });

  it('fails without writes outside a Git repository', () => {
    const value = fixture('coding-x cursor hooks non-git-');
    rmSync(join(value.root, '.git'), { recursive: true, force: true });

    expect(runCursorHookAction('install', value)).toMatchObject({
      exitCode: 1,
      status: 'error',
    });
    expect(existsSync(join(value.root, '.cursor'))).toBe(false);
  });
});
