import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export const nativeWindowsPathAttributesTransportAlias = {
  // The native proof must resolve the checked-in production transport, never the deterministic
  // ordinary-Windows test seam. Match both relative ids and resolved Windows/POSIX paths.
  find: /^(?:.*[\\/])?windows-path-attributes-transport\.js$/u,
  replacement: fileURLToPath(
    new URL('../src/workspace-safety/windows-path-attributes-transport.ts', import.meta.url),
  ),
};

// Required native proof: deliberately resolves the real PowerShell/GetFileAttributesW transport.
export default defineConfig({
  resolve: {
    alias: [nativeWindowsPathAttributesTransportAlias],
  },
  test: {
    environment: 'node',
    fileParallelism: false,
  },
});
