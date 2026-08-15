import { defineConfig } from 'tsup';
import { cpSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { spawnSync } from 'node:child_process';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node22',
  // 候选身份只覆盖发布包文件；唯一运行库必须并入 dist，不能从包外加载未绑定字节。
  noExternal: ['jsonrepair'],
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    mkdirSync('dist/instructions', { recursive: true });
    mkdirSync('dist/public', { recursive: true });
    mkdirSync('dist/hooks', { recursive: true });
    mkdirSync('dist/workspace-safety', { recursive: true });
    cpSync('assets/instructions', 'dist/instructions', { recursive: true });
    cpSync('assets/dashboard', 'dist/public', { recursive: true });
    cpSync('hooks/tdd-commit-check.mjs', 'dist/hooks/tdd-commit-check.mjs');
    cpSync('assets/workspace-safety', 'dist/workspace-safety', { recursive: true });
    for (const name of readdirSync('assets/workspace-safety').sort()) {
      const source = readFileSync(`assets/workspace-safety/${name}`);
      const distributed = readFileSync(`dist/workspace-safety/${name}`);
      if (!source.equals(distributed)) {
        throw new Error(`workspace safety helper 发布字节不一致：${name}`);
      }
    }
    // 发布物烟测：真实执行 bundle，防止源码测试全绿但 npm bin 入口不认 --help。
    const smoke = spawnSync(process.execPath, ['dist/cli.js', '--help'], { encoding: 'utf8' });
    if (smoke.error) throw smoke.error;
    if (
      smoke.status !== 0 ||
      !smoke.stdout.includes('coding-x') ||
      !smoke.stdout.includes('--stall-limit')
    ) {
      throw new Error(`dist CLI help 烟测失败（exit=${smoke.status}）：${smoke.stderr}`);
    }
  },
});
