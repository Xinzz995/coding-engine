import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/**/*.test.ts', 'build/**/*.test.mjs'],
    environment: 'node',
    // Windows runner 上大量临时 Git 仓库和子进程并行会争抢文件与 CPU，产生级联超时。
    // 保留完整测试集和原超时阈值，仅按文件顺序执行；其他平台继续并行。
    fileParallelism: process.platform !== 'win32',
  },
});
