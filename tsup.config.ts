import { defineConfig } from 'tsup';
import { cpSync, mkdirSync } from 'node:fs';

export default defineConfig({
  entry: ['src/cli.ts'],
  format: ['esm'],
  target: 'node18',
  clean: true,
  banner: { js: '#!/usr/bin/env node' },
  async onSuccess() {
    mkdirSync('dist/instructions', { recursive: true });
    mkdirSync('dist/public', { recursive: true });
    cpSync('assets/instructions', 'dist/instructions', { recursive: true });
    cpSync('assets/dashboard', 'dist/public', { recursive: true });
  },
});
