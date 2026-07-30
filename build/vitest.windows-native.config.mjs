import { defineConfig } from 'vitest/config';

// Required native proof: deliberately resolves the real PowerShell/GetFileAttributesW transport.
export default defineConfig({
  test: {
    environment: 'node',
    fileParallelism: false,
  },
});
