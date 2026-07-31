import { describe, it, expect, vi } from 'vitest';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { buildAgentArgs, resolveBinary, resolveExecutablePath, runAgent } from './agent.js';
import { createManagedProcessTestSession } from './managed-process-test-support.js';

const here = dirname(fileURLToPath(import.meta.url));
const fake = join(here, '__fixtures__', 'fake-agent.mjs');

async function runManagedAgent(
  options: Omit<Parameters<typeof runAgent>[0], 'managed'>,
): ReturnType<typeof runAgent> {
  const fixture = await createManagedProcessTestSession();
  try {
    return await runAgent({
      ...options,
      managed: {
        session: fixture.session,
        operation: { kind: 'final-review', delegation: 'read-only-v1' },
      },
    });
  } finally {
    await fixture.close();
  }
}

async function expectTimedOutTreeExited(mode: 'tree' | 'stubborn-tree'): Promise<void> {
  const cwd = mkdtempSync(join(tmpdir(), 'coding-x-agent-tree-'));
  const marker = join(cwd, 'fake-agent-child.pid');
  const originalBin = process.env.CODING_X_CLAUDE_BIN;
  const exitListenersBefore = process.listenerCount('exit');
  let childPid: number | null = null;
  let childConfirmedGone = false;
  process.env.CODING_X_CLAUDE_BIN = `node ${fake} ${mode}`;
  try {
    const r = await runManagedAgent({ kind: 'claude', prompt: '', cwd, timeoutMs: 1000 });
    expect(r).toMatchObject({ timedOut: true, exitCode: null });
    expect(r.durationMs).toBeGreaterThanOrEqual(1000);
    expect(r.outputTail).toBe('');
    childPid = Number(readFileSync(marker, 'utf-8'));
    expect(Number.isSafeInteger(childPid) && childPid > 0).toBe(true);

    let probeError: string | undefined;
    try {
      process.kill(childPid, 0);
    } catch (err) {
      probeError = (err as NodeJS.ErrnoException).code;
    }
    childConfirmedGone = probeError === 'ESRCH';
    expect(probeError).toBe('ESRCH');
    expect(process.listenerCount('exit')).toBe(exitListenersBefore);
  } finally {
    if (originalBin === undefined) delete process.env.CODING_X_CLAUDE_BIN;
    else process.env.CODING_X_CLAUDE_BIN = originalBin;
    if (!childConfirmedGone) {
      if (childPid === null && existsSync(marker)) childPid = Number(readFileSync(marker, 'utf-8'));
      if (childPid !== null && Number.isSafeInteger(childPid) && childPid > 0) {
        try {
          process.kill(childPid, 0);
          process.kill(childPid, 'SIGKILL');
        } catch {
          /* 已退出 */
        }
      }
    }
    rmSync(cwd, { recursive: true, force: true });
  }
}

describe('buildAgentArgs', () => {
  it('builds claude print command by default', () => {
    expect(buildAgentArgs('claude', 'P')).toEqual([
      'claude',
      '--print',
      '--dangerously-skip-permissions',
      'P',
    ]);
  });
  it('builds codex exec command', () => {
    expect(buildAgentArgs('codex', 'P')).toEqual([
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      'P',
    ]);
  });
  it('builds cursor headless force command', () => {
    const original = process.env.CODING_X_CURSOR_BIN;
    process.env.CODING_X_CURSOR_BIN = 'agent';
    try {
      expect(buildAgentArgs('cursor', 'P')).toEqual(['agent', '-p', '--force', 'P']);
    } finally {
      if (original === undefined) delete process.env.CODING_X_CURSOR_BIN;
      else process.env.CODING_X_CURSOR_BIN = original;
    }
  });
  it('appends --model before the prompt for claude when a model is given', () => {
    expect(buildAgentArgs('claude', 'P', 'opus')).toEqual([
      'claude',
      '--print',
      '--dangerously-skip-permissions',
      '--model',
      'opus',
      'P',
    ]);
  });
  it('appends --model before the prompt for codex when a model is given', () => {
    expect(buildAgentArgs('codex', 'P', 'gpt-5')).toEqual([
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-5',
      'P',
    ]);
  });
  it('appends --model before the prompt for cursor when a model is given', () => {
    const original = process.env.CODING_X_CURSOR_BIN;
    process.env.CODING_X_CURSOR_BIN = 'agent';
    try {
      expect(buildAgentArgs('cursor', 'P', 'composer-1')).toEqual([
        'agent',
        '-p',
        '--force',
        '--model',
        'composer-1',
        'P',
      ]);
    } finally {
      if (original === undefined) delete process.env.CODING_X_CURSOR_BIN;
      else process.env.CODING_X_CURSOR_BIN = original;
    }
  });
});

describe('resolveBinary', () => {
  it('honors all runner env overrides', () => {
    process.env.CODING_X_CLAUDE_BIN = '/tmp/x';
    process.env.CODING_X_CODEX_BIN = '/tmp/y';
    process.env.CODING_X_CURSOR_BIN = '/tmp/z';
    expect(resolveBinary('claude')).toBe('/tmp/x');
    expect(resolveBinary('codex')).toBe('/tmp/y');
    expect(resolveBinary('cursor')).toBe('/tmp/z');
    delete process.env.CODING_X_CLAUDE_BIN;
    delete process.env.CODING_X_CODEX_BIN;
    delete process.env.CODING_X_CURSOR_BIN;
  });

  it('supports the current agent command and the legacy cursor-agent command without configuration', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-x-cursor-bin-'));
    const originalPath = process.env.PATH;
    const originalOverride = process.env.CODING_X_CURSOR_BIN;
    delete process.env.CODING_X_CURSOR_BIN;
    try {
      process.env.PATH = dir;
      expect(resolveBinary('cursor')).toBe('agent');

      const suffix = process.platform === 'win32' ? '.CMD' : '';
      const current = join(dir, `agent${suffix}`);
      writeFileSync(current, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
      chmodSync(current, 0o755);
      expect(resolveBinary('cursor')).toBe('agent');

      const legacy = join(dir, `cursor-agent${suffix}`);
      writeFileSync(legacy, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
      chmodSync(legacy, 0o755);
      expect(resolveBinary('cursor')).toBe('cursor-agent');
    } finally {
      if (originalPath === undefined) delete process.env.PATH;
      else process.env.PATH = originalPath;
      if (originalOverride === undefined) delete process.env.CODING_X_CURSOR_BIN;
      else process.env.CODING_X_CURSOR_BIN = originalOverride;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('resolveExecutablePath', () => {
  it('uses Windows environment names case-insensitively without duplicating an existing suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-x-windows-bin-'));
    const executable = join(dir, 'cmd.exe');
    writeFileSync(executable, '');
    chmodSync(executable, 0o755);
    try {
      expect(
        resolveExecutablePath(
          'cmd.exe',
          dir,
          {
            Path: dir,
            Pathext: '.COM;.EXE;.CMD',
            PATH: join(dir, 'missing'),
            PATHEXT: '.NOPE',
          },
          'win32',
        ),
      ).toBe(realpathSync.native(executable));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('uses Windows PATHEXT for an executable without a suffix', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-x-windows-pathext-'));
    const executable = join(dir, 'git.CMD');
    writeFileSync(executable, '');
    chmodSync(executable, 0o755);
    try {
      expect(
        resolveExecutablePath(
          'git',
          dir,
          {
            Path: dir,
            Pathext: '.CMD;.EXE',
          },
          'win32',
        ),
      ).toBe(realpathSync.native(executable));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAgent', () => {
  it('returns a deterministic failed result when the runner executable is missing', async () => {
    const originalBin = process.env.CODING_X_CLAUDE_BIN;
    process.env.CODING_X_CLAUDE_BIN = 'coding-x-definitely-missing-runner';
    const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    try {
      const result = await runManagedAgent({
        kind: 'claude',
        prompt: '',
        cwd: here,
        timeoutMs: 5_000,
      });
      expect(result).toMatchObject({ timedOut: false, exitCode: 1 });
      expect(result.outputTail).toContain('找不到可执行文件');
    } finally {
      stderr.mockRestore();
      if (originalBin === undefined) delete process.env.CODING_X_CLAUDE_BIN;
      else process.env.CODING_X_CLAUDE_BIN = originalBin;
    }
  });

  it('merges explicit coding-x context into the child environment', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'coding-x-agent-env-'));
    const script = join(cwd, 'capture-env.mjs');
    const output = join(cwd, 'env.json');
    const originalBin = process.env.CODING_X_CLAUDE_BIN;
    writeFileSync(
      script,
      `
      import { writeFileSync } from 'node:fs';
      writeFileSync(${JSON.stringify(output)}, JSON.stringify({
        workspace: process.env.CODING_X_WORKSPACE,
        projectRoot: process.env.CODING_X_PROJECT_ROOT,
      }));
    `,
    );
    process.env.CODING_X_CLAUDE_BIN = `node ${script}`;
    try {
      const result = await runManagedAgent({
        kind: 'claude',
        prompt: '',
        cwd,
        timeoutMs: 5000,
        env: {
          CODING_X_WORKSPACE: '/tmp/custom workspace',
          CODING_X_PROJECT_ROOT: '/tmp/project root',
        },
      });
      expect(result).toMatchObject({ timedOut: false, exitCode: 0 });
      expect(JSON.parse(readFileSync(output, 'utf8'))).toEqual({
        workspace: '/tmp/custom workspace',
        projectRoot: '/tmp/project root',
      });
    } finally {
      if (originalBin === undefined) delete process.env.CODING_X_CLAUDE_BIN;
      else process.env.CODING_X_CLAUDE_BIN = originalBin;
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it('resolves timedOut=false when the process exits in time', async () => {
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} ok`;
    const r = await runManagedAgent({ kind: 'claude', prompt: '', cwd: here, timeoutMs: 5000 });
    expect(r.timedOut).toBe(false);
    expect(r.exitCode).toBe(0);
    expect(r.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.outputTail).toBe('');
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it('tees stdout/stderr while returning a bounded diagnostic tail', async () => {
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} diagnostic`;
    const stdout = vi.spyOn(process.stdout, 'write').mockImplementation(() => true);
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const r = await runManagedAgent({ kind: 'claude', prompt: '', cwd: here, timeoutMs: 5000 });
      expect(r).toMatchObject({ timedOut: false, exitCode: 1 });
      expect(r.durationMs).toBeGreaterThanOrEqual(0);
      expect(r.outputTail).toContain('runner started');
      expect(r.outputTail).toContain('API Error: 402 Account overdue');
      expect(stdout.mock.calls.flat().join('')).toContain('runner started');
      expect(stderr.mock.calls.flat().join('')).toContain('API Error: 402 Account overdue');
    } finally {
      stdout.mockRestore();
      stderr.mockRestore();
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('keeps only the bounded tail of long runner output', async () => {
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} long-diagnostic`;
    const stderr = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
    try {
      const r = await runManagedAgent({ kind: 'claude', prompt: '', cwd: here, timeoutMs: 5000 });
      expect(r.exitCode).toBe(1);
      expect(r.outputTail.length).toBeLessThanOrEqual(2000);
      expect(r.outputTail).toContain('TAIL-END');
    } finally {
      stderr.mockRestore();
      delete process.env.CODING_X_CLAUDE_BIN;
    }
  });

  it('resolves timedOut=true and kills a hanging process', async () => {
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} hang`;
    const r = await runManagedAgent({ kind: 'claude', prompt: '', cwd: here, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(r.durationMs).toBeGreaterThanOrEqual(300);
    delete process.env.CODING_X_CLAUDE_BIN;
  });

  it.runIf(process.platform !== 'win32')(
    'does not resolve a timeout until the whole agent process tree has exited',
    async () => {
      await expectTimedOutTreeExited('tree');
    },
  );

  it.runIf(process.platform !== 'win32')(
    'escalates to SIGKILL before resolving when an agent descendant traps SIGTERM',
    async () => {
      await expectTimedOutTreeExited('stubborn-tree');
    },
    12_000,
  );
});
