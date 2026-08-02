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
import {
  agentTemporaryRetentionFailure,
  buildManagedAgentArgs,
  resolveBinary,
  resolveExecutablePath,
  resolveRunnerExecutablePath,
  resolveRunnerInvocation,
  runAgent,
} from './agent.js';
import { createManagedProcessTestSession } from './managed-process-test-support.js';
import { createValidationRequest, renderValidatorInstruction } from './validation-protocol.js';
import {
  ReviewTemporaryDirectory,
  ReviewTemporaryDirectoryError,
} from '../review/temporary-directory.js';
import { WorkspaceSafetyError } from '../workspace-safety/types.js';

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

describe('buildManagedAgentArgs', () => {
  it('uses stdin for Codex and Claude while keeping Cursor prompt-free for the proxy', () => {
    expect(buildManagedAgentArgs('codex', 'gpt-5')).toEqual([
      'codex',
      'exec',
      '--dangerously-bypass-approvals-and-sandbox',
      '--model',
      'gpt-5',
      '-',
    ]);
    expect(buildManagedAgentArgs('claude', 'opus')).toEqual([
      'claude',
      '--print',
      '--dangerously-skip-permissions',
      '--model',
      'opus',
    ]);
    const original = process.env.CODING_X_CURSOR_BIN;
    process.env.CODING_X_CURSOR_BIN = 'agent';
    try {
      expect(buildManagedAgentArgs('cursor', 'composer-1')).toEqual([
        'agent',
        '-p',
        '--force',
        '--model',
        'composer-1',
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

describe('resolveRunnerExecutablePath', () => {
  it.each(['runner.CMD', 'runner.bat'])(
    'rejects the Windows AI Runner script wrapper %s',
    (name) => {
      const dir = mkdtempSync(join(tmpdir(), 'coding-x-windows-runner-shim-'));
      const executable = join(dir, name);
      writeFileSync(executable, '@echo off\r\n');
      chmodSync(executable, 0o755);
      try {
        expect(() =>
          resolveRunnerExecutablePath('codex', executable, dir, process.env, 'win32'),
        ).toThrow(/原生可执行文件/u);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  it('allows a Windows native runner and does not apply the restriction to POSIX', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-x-runner-native-'));
    const native = join(dir, 'runner.EXE');
    const script = join(dir, 'runner.cmd');
    writeFileSync(native, '');
    writeFileSync(script, '');
    chmodSync(native, 0o755);
    chmodSync(script, 0o755);
    try {
      expect(resolveRunnerExecutablePath('claude', native, dir, process.env, 'win32')).toBe(
        realpathSync.native(native),
      );
      expect(resolveRunnerExecutablePath('claude', script, dir, process.env, 'linux')).toBe(
        realpathSync.native(script),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('prefers an exact native executable path containing spaces before legacy test splitting', () => {
    const dir = mkdtempSync(join(tmpdir(), 'coding-x runner native-'));
    const executable = join(dir, 'native runner.exe');
    writeFileSync(executable, '');
    chmodSync(executable, 0o755);
    try {
      expect(
        resolveRunnerInvocation('codex', executable, ['exec', 'prompt'], dir, process.env, 'win32'),
      ).toEqual({
        executable: realpathSync.native(executable),
        args: ['exec', 'prompt'],
      });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('runAgent', () => {
  it.runIf(process.platform === 'win32')(
    'rejects an AI Runner script wrapper before managed execution',
    async () => {
      const dir = mkdtempSync(join(tmpdir(), 'coding-x-agent-shim-'));
      const executable = join(dir, 'claude.cmd');
      const marker = join(dir, 'runner-started.txt');
      const originalBin = process.env.CODING_X_CLAUDE_BIN;
      const stderr = vi.spyOn(console, 'error').mockImplementation(() => undefined);
      writeFileSync(
        executable,
        `@echo off\r\n> ${JSON.stringify(marker)} echo started\r\nexit /b 0\r\n`,
      );
      process.env.CODING_X_CLAUDE_BIN = executable;
      try {
        const result = await runManagedAgent({
          kind: 'claude',
          prompt: '不可进入 shell 的提示词 & "quoted"',
          cwd: dir,
          timeoutMs: 5_000,
        });
        expect(result).toMatchObject({ timedOut: false, exitCode: 1, durationMs: 0 });
        expect(result.outputTail).toContain('原生可执行文件');
        expect(existsSync(marker)).toBe(false);
      } finally {
        stderr.mockRestore();
        if (originalBin === undefined) delete process.env.CODING_X_CLAUDE_BIN;
        else process.env.CODING_X_CLAUDE_BIN = originalBin;
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

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

  it('preserves a workspace safety failure when the prompt invocation directory must be retained', () => {
    const original = new WorkspaceSafetyError('invalid', 'fixture workspace failure');
    const preserved = agentTemporaryRetentionFailure(original, {
      status: 'retained',
      location: { status: 'verified', path: '/bounded/fixture-path' },
      reason: 'fixture retention reason',
      protection: {
        status: 'restricted',
        mechanism: 'posix-bound-descriptor-v1',
        scope: 'retained-root-at-closeout',
      },
    });

    expect(preserved).toBeInstanceOf(WorkspaceSafetyError);
    expect(preserved).toMatchObject({ code: 'invalid', cause: original });
    expect(preserved.message.startsWith(original.message)).toBe(true);
    expect(preserved.message.match(/fixture workspace failure/gu)).toHaveLength(1);
    expect(preserved.message).toContain('Agent Runner 临时域已保留');
  });

  it('stops immediately when the protected prompt invocation directory cannot be established', async () => {
    const originalBin = process.env.CODING_X_CLAUDE_BIN;
    const original = new ReviewTemporaryDirectoryError('fixture invocation setup failed');
    const createSpy = vi.spyOn(ReviewTemporaryDirectory, 'create').mockImplementation(() => {
      throw original;
    });
    process.env.CODING_X_CLAUDE_BIN = `node ${fake} ok`;
    try {
      let observed: unknown;
      try {
        await runManagedAgent({
          kind: 'claude',
          prompt: 'fixture prompt',
          cwd: here,
          timeoutMs: 5000,
        });
      } catch (error) {
        observed = error;
      }
      expect(observed).toBeInstanceOf(WorkspaceSafetyError);
      expect(observed).toMatchObject({ code: 'isolated', cause: original });
      expect((observed as Error).message).toContain('fixture invocation setup failed');
    } finally {
      createSpy.mockRestore();
      if (originalBin === undefined) delete process.env.CODING_X_CLAUDE_BIN;
      else process.env.CODING_X_CLAUDE_BIN = originalBin;
    }
  });

  it('rejects an oversized Cursor prompt without retrying or truncating it', async () => {
    const originalBin = process.env.CODING_X_CURSOR_BIN;
    process.env.CODING_X_CURSOR_BIN = `node ${fake} ok`;
    try {
      await expect(
        runManagedAgent({
          kind: 'cursor',
          prompt: 'x'.repeat(16 * 1024 + 1),
          cwd: here,
          timeoutMs: 5000,
        }),
      ).rejects.toMatchObject({ name: 'WorkspaceSafetyError', code: 'invalid' });
    } finally {
      if (originalBin === undefined) delete process.env.CODING_X_CURSOR_BIN;
      else process.env.CODING_X_CURSOR_BIN = originalBin;
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

  it.each([
    ['builder.md', undefined],
    ['validator.md', 'fixture-model'],
  ] as const)(
    'delivers the complete packaged %s prompt through every managed Runner',
    async (instructionFile, model) => {
      const cwd = mkdtempSync(join(tmpdir(), 'coding-x-agent-prompt-'));
      const script = join(cwd, 'capture-prompt.mjs');
      const basePrompt = readFileSync(
        join(here, '../../assets/instructions', instructionFile),
        'utf8',
      );
      const prompt =
        instructionFile === 'validator.md'
          ? renderValidatorInstruction(
              basePrompt,
              createValidationRequest(
                {
                  id: 'US-001',
                  acceptanceCriteria: Array.from(
                    { length: 9 },
                    (_, index) => `验收标准 ${index + 1}：逐项核对真实产物与当前提交绑定。`,
                  ),
                },
                join(cwd, '.workspace'),
                'a'.repeat(40),
                '11111111-1111-4111-8111-111111111111',
              ),
            )
          : basePrompt;
      expect(prompt.length).toBeGreaterThan(4096);
      writeFileSync(
        script,
        `
        import { writeFileSync } from 'node:fs';
        const chunks = [];
        process.stdin.on('data', (chunk) => chunks.push(chunk));
        process.stdin.on('end', () => {
          const stdinPrompt = Buffer.concat(chunks).toString('utf8');
          const received = process.env.CODING_X_TEST_RUNNER === 'cursor'
            ? process.argv.at(-1)
            : stdinPrompt;
          writeFileSync(
            process.env.CODING_X_TEST_PROMPT_OUTPUT,
            JSON.stringify({ prompt: received, argv: process.argv.slice(2) }),
          );
        });
        process.stdin.resume();
      `,
      );
      const runners = [
        ['codex', 'CODING_X_CODEX_BIN'],
        ['claude', 'CODING_X_CLAUDE_BIN'],
        ['cursor', 'CODING_X_CURSOR_BIN'],
      ] as const;
      try {
        for (const [kind, variable] of runners) {
          const output = join(cwd, `${kind}-${instructionFile}.json`);
          const original = process.env[variable];
          process.env[variable] = `node ${script}`;
          try {
            const result = await runManagedAgent({
              kind,
              prompt,
              cwd,
              timeoutMs: 5000,
              ...(model ? { model } : {}),
              env: {
                CODING_X_TEST_RUNNER: kind,
                CODING_X_TEST_PROMPT_OUTPUT: output,
              },
            });
            expect(result).toMatchObject({ timedOut: false, exitCode: 0 });
            const captured = JSON.parse(readFileSync(output, 'utf8')) as {
              prompt: string;
              argv: string[];
            };
            expect(captured.prompt).toBe(prompt);
            if (kind !== 'cursor') expect(captured.argv).not.toContain(prompt);
            if (model) expect(captured.argv).toContain(model);
          } finally {
            if (original === undefined) delete process.env[variable];
            else process.env[variable] = original;
          }
        }
      } finally {
        rmSync(cwd, { recursive: true, force: true });
      }
    },
  );

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
