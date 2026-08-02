import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const proxyPath = fileURLToPath(
  new URL('../../assets/workspace-safety/review-runner-proxy.mjs', import.meta.url),
);

function withInvocation(
  runner: 'codex' | 'cursor',
  prompt: string,
  run: (configPath: string) => void,
  argsOverride?: readonly string[],
): void {
  const root = mkdtempSync(join(tmpdir(), 'review-runner-proxy-test-'));
  try {
    const promptPath = join(root, 'prompt.txt');
    const configPath = join(root, 'proxy-config.json');
    writeFileSync(promptPath, prompt, { mode: 0o444 });
    writeFileSync(
      configPath,
      `${JSON.stringify({
        schemaVersion: 1,
        runner,
        executable: process.execPath,
        args:
          argsOverride ??
          (runner === 'cursor'
            ? ['-e', 'process.stdout.write(process.argv[1])']
            : [
                '-e',
                'const values=[];process.stdin.on("data",c=>values.push(c));' +
                  'process.stdin.on("end",()=>process.stdout.write(Buffer.concat(values)));',
                '',
              ]),
        cwd: root,
        promptPath,
        promptMode: runner === 'cursor' ? 'argument' : 'stdin',
      })}\n`,
      { mode: 0o444 },
    );
    run(configPath);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

describe('fixed Review Runner proxy', () => {
  it('delivers the complete prompt to Codex and Claude style stdin contracts', () => {
    const prompt = `full prompt:${'内容'.repeat(48 * 1024)}`;
    withInvocation('codex', prompt, (configPath) => {
      const result = spawnSync(process.execPath, [proxyPath, configPath], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(Buffer.byteLength(result.stdout)).toBe(Buffer.byteLength(prompt));
      expect(createHash('sha256').update(result.stdout).digest('hex')).toBe(
        createHash('sha256').update(prompt).digest('hex'),
      );
    });
  });

  it('preserves Cursor argument delivery only within its fixed safe bound', () => {
    withInvocation('cursor', 'cursor prompt', (configPath) => {
      const result = spawnSync(process.execPath, [proxyPath, configPath], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe('cursor prompt');
    });

    withInvocation('cursor', 'x'.repeat(16 * 1024 + 1), (configPath) => {
      const result = spawnSync(process.execPath, [proxyPath, configPath], {
        encoding: 'utf8',
        timeout: 5000,
      });
      expect(result.status).toBe(126);
      expect(result.stderr).toContain('exceeds the fixed');
    });
  });

  it.each([
    [23, 23],
    [0, 126],
  ])(
    'settles a deterministic stdin EPIPE with child exit %i as proxy exit %i',
    (childExitCode, expectedProxyExitCode) => {
      withInvocation('codex', 'fixture prompt', (configPath) => {
        const preloadPath = join(dirname(configPath), 'fake-spawn-preload.mjs');
        writeFileSync(
          preloadPath,
          `
          import childProcess from 'node:child_process';
          import { EventEmitter } from 'node:events';
          import { syncBuiltinESMExports } from 'node:module';
          childProcess.spawn = () => {
            const child = new EventEmitter();
            child.stdin = new EventEmitter();
            child.stdin.end = () => queueMicrotask(() => {
              const error = Object.assign(new Error('fixture broken pipe'), { code: 'EPIPE' });
              child.stdin.emit('error', error);
              queueMicrotask(() => child.emit('close', ${childExitCode}, null));
            });
            return child;
          };
          syncBuiltinESMExports();
        `,
        );
        const result = spawnSync(
          process.execPath,
          ['--import', preloadPath, proxyPath, configPath],
          { encoding: 'utf8', timeout: 5000 },
        );
        expect(result.status, result.stderr).toBe(expectedProxyExitCode);
        if (childExitCode === 0) {
          expect(result.stderr).toContain('failed to deliver runner input');
        } else {
          expect(result.stderr).toBe('');
        }
      });
    },
  );

  it.runIf(process.platform !== 'win32')(
    'refuses a config path that resolves through a symbolic link',
    () => {
      withInvocation('codex', 'prompt', (configPath) => {
        const linkedConfigPath = join(dirname(configPath), 'linked-config.json');
        symlinkSync(configPath, linkedConfigPath);
        const result = spawnSync(process.execPath, [proxyPath, linkedConfigPath], {
          encoding: 'utf8',
          timeout: 5000,
        });
        expect(result.status).toBe(126);
        expect(result.stderr).toContain('coding-x review runner proxy');
      });
    },
  );
});
