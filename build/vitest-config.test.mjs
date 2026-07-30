import { describe, expect, it } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ordinaryWindowsPathAttributesTransportAlias } from '../vitest.config.ts';
import { nativeWindowsPathAttributesTransportAlias } from './vitest.windows-native.config.mjs';

const transportImportIds = [
  './windows-path-attributes-transport.js',
  '/home/runner/work/coding-engine/src/workspace-safety/windows-path-attributes-transport.js',
  String.raw`D:\a\coding-engine\src\workspace-safety\windows-path-attributes-transport.js`,
];

describe('ordinary Windows Vitest transport alias', () => {
  it('replaces relative and resolved ids using either path separator', () => {
    const { find, replacement } = ordinaryWindowsPathAttributesTransportAlias;
    for (const importId of transportImportIds) {
      expect(importId).toMatch(find);
      expect(importId.replace(find, replacement)).toBe(replacement);
    }
  });

  it('does not redirect similarly named modules', () => {
    const { find, replacement } = ordinaryWindowsPathAttributesTransportAlias;

    for (const importId of [
      './windows-path-attributes-test-transport.js',
      './other-windows-path-attributes-transport.js',
      './windows-path-attributes-transport.ts',
    ]) {
      expect(importId).not.toMatch(find);
      expect(importId.replace(find, replacement)).toBe(importId);
    }
  });
});

describe('native Windows Vitest transport alias', () => {
  it('resolves every supported id form to the real production transport', () => {
    const { find, replacement } = nativeWindowsPathAttributesTransportAlias;
    const expected = fileURLToPath(
      new URL('../src/workspace-safety/windows-path-attributes-transport.ts', import.meta.url),
    );

    expect(replacement).toBe(expected);
    expect(replacement).not.toContain('test-transport');
    for (const importId of transportImportIds) {
      expect(importId).toMatch(find);
      expect(importId.replace(find, replacement)).toBe(expected);
    }
  });
});
