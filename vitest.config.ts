import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  resolve: {
    alias:
      process.platform === 'win32'
        ? [
            {
              find: /\/windows-path-attributes-transport\.js$/u,
              replacement: fileURLToPath(
                new URL(
                  './src/workspace-safety/windows-path-attributes-test-transport.ts',
                  import.meta.url,
                ),
              ),
            },
          ]
        : [],
  },
  test: {
    include: ['src/**/*.test.ts', 'build/**/*.test.mjs'],
    // This one suite must use build/vitest.windows-native.config.mjs so it cannot resolve the
    // deterministic ordinary-Windows transport above.
    exclude: ['src/workspace-safety/windows-reparse-point.windows.test.ts'],
    environment: 'node',
    // Windows runner 上大量临时 Git 仓库和子进程并行会争抢文件与 CPU，产生级联超时。
    // 保留完整测试集和原超时阈值，仅按文件顺序执行；其他平台继续并行。
    fileParallelism: process.platform !== 'win32',
  },
});
