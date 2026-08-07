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

export const ordinaryWindowsTestSetupPath = fileURLToPath(
  new URL('./src/workspace-safety/ordinary-windows-test-setup.ts', import.meta.url),
);

export function ordinaryWindowsTestSetupFiles(platform: NodeJS.Platform): string[] {
  return platform === 'win32' ? [ordinaryWindowsTestSetupPath] : [];
}

const windowsNativeSuitePaths = REQUIRED_WINDOWS_NATIVE_SUITES.map(
  (name) => `src/workspace-safety/${name}`,
);
export const ordinaryWindowsIdentityTransportTestPath =
  'src/workspace-safety/windows-identity-transport.test.ts';

export function ordinaryWindowsExcludedSuitePaths(platform: NodeJS.Platform): string[] {
  return platform === 'win32'
    ? [...windowsNativeSuitePaths, ordinaryWindowsIdentityTransportTestPath]
    : ['src/workspace-safety/windows-reparse-point.windows.test.ts'];
}

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
    exclude: ordinaryWindowsExcludedSuitePaths(process.platform),
    environment: 'node',
    setupFiles: ordinaryWindowsTestSetupFiles(process.platform),
    // 安全回归会启动大量真实进程树、临时 Git 仓库和本机检查器；按文件并行会争抢
    // 进程与 CPU，并让原本用于判定隔离失败的短超时产生级联假失败。保留完整测试集
    // 和原超时阈值，在所有平台按文件顺序执行。
    fileParallelism: false,
  },
});
