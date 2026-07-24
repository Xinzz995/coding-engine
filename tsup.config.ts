import { defineConfig } from 'tsup';
import { cpSync, mkdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    mkdirSync('dist/instructions', { recursive: true });
    mkdirSync('dist/public', { recursive: true });
    mkdirSync('dist/hooks', { recursive: true });
    mkdirSync('dist/quality', { recursive: true });
    cpSync('assets/instructions', 'dist/instructions', { recursive: true });
    cpSync('assets/dashboard', 'dist/public', { recursive: true });
    cpSync('assets/quality', 'dist/quality', { recursive: true });
    cpSync('hooks/tdd-commit-check.mjs', 'dist/hooks/tdd-commit-check.mjs');
    // 发布物烟测：真实执行 bundle，防止源码测试全绿但 npm bin 入口不认 --help。
    const smoke = spawnSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
    if (smoke.error) throw smoke.error;
    if (smoke.status !== 0 || !smoke.stdout.includes('coding-x') || !smoke.stdout.includes('--stall-limit')) {
      throw new Error(`dist CLI help 烟测失败（exit=${smoke.status}）：${smoke.stderr}`);
    }
  },
});
