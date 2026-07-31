import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
import { REQUIRED_WINDOWS_NATIVE_SUITES } from './build/windows-native-proof.mjs';

export const ordinaryWindowsPathAttributesTransportAlias = {
  // Vite can present this import either as the original relative specifier or as a resolved
  // platform path. Match the whole id so replacement never retains a stale path prefix.
  find: /^(?:.*[\\/])?windows-path-attributes-transport\.js$/u,
  replacement: fileURLToPath(
    new URL('./src/workspace-safety/windows-path-attributes-test-transport.ts', import.meta.url),
  ),
};

export const ordinaryWindowsIdentityTransportAlias = {
  // Keep the identity comparison and authority code real; replace only the slow PowerShell/CIM
  // transport in ordinary Windows tests. The standard-user native proof uses a separate config.
  find: /^(?:.*[\\/])?windows-identity-transport\.js$/u,
  replacement: fileURLToPath(
    new URL('./src/workspace-safety/windows-identity-test-transport.ts', import.meta.url),
  ),
};

const windowsNativeSuitePaths = REQUIRED_WINDOWS_NATIVE_SUITES.map(
  (name) => `src/workspace-safety/${name}`,
);

export default defineConfig({
  resolve: {
    alias:
      process.platform === 'win32'
        ? [ordinaryWindowsPathAttributesTransportAlias, ordinaryWindowsIdentityTransportAlias]
        : [],
  },
  test: {
    include: ['src/**/*.test.ts', 'build/**/*.test.mjs'],
    // These real process-tree suites run once in the stronger, serial standard-user proof.
    // Ordinary Windows matrix jobs still run every other test, but must not duplicate the same
    // native processes in parallel CI jobs. The reparse suite always needs the native config.
    exclude:
      process.platform === 'win32'
        ? windowsNativeSuitePaths
        : ['src/workspace-safety/windows-reparse-point.windows.test.ts'],
    environment: 'node',
    // Windows runner 上大量临时 Git 仓库和子进程并行会争抢文件与 CPU，产生级联超时。
    // 保留完整测试集和原超时阈值，仅按文件顺序执行；其他平台继续并行。
    fileParallelism: process.platform !== 'win32',
  },
});
