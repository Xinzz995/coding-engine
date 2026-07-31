import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

const proxyPath = fileURLToPath(
  new URL('../../assets/workspace-safety/review-runner-proxy.mjs', import.meta.url),
);

function withInvocation(
  runner: 'codex' | 'cursor',
  prompt: string,
  run: (configPath: string) => void,
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
          runner === 'cursor'
            ? ['-e', 'process.stdout.write(process.argv[1])']
            : [
                '-e',
                'const values=[];process.stdin.on("data",c=>values.push(c));' +
                  'process.stdin.on("end",()=>process.stdout.write(Buffer.concat(values)));',
                '',
              ],
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
});
