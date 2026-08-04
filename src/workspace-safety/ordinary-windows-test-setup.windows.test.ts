import { describe, expect, it } from 'vitest';
import { invokeWindowsPathAttributeHelper as invokeAliasedWindowsPathAttributeHelper } from './windows-path-attributes-transport.js';
import {
  invokeWindowsPathAttributeHelper as invokeDirectWindowsPathAttributeHelper,
  WINDOWS_PATH_ATTRIBUTE_TEST_MAX_INVOCATIONS,
} from './windows-path-attributes-test-transport.js';

const options = {
  executablePath: 'C:\\coding-x-test\\path-inspector.exe',
  helperDigest: 'test-only',
  requestBytes: Buffer.from(
    JSON.stringify({ schemaVersion: 1, mode: 'paths-v1', payload: { paths: [] } }),
    'utf8',
  ),
  maxResponseBytes: 4096,
  timeoutMs: 1000,
};

describe.runIf(process.platform === 'win32')('ordinary Windows test setup', () => {
  it('keeps the aliased transport bounded within one test', () => {
    expect(invokeAliasedWindowsPathAttributeHelper).toBe(invokeDirectWindowsPathAttributeHelper);
    for (let index = 0; index < WINDOWS_PATH_ATTRIBUTE_TEST_MAX_INVOCATIONS; index += 1) {
      invokeAliasedWindowsPathAttributeHelper(options);
    }

    expect(() => invokeAliasedWindowsPathAttributeHelper(options)).toThrow(
      'test helper invocation bound exceeded',
    );
  });

  it('starts the next test with a fresh invocation boundary', () => {
    // This test deliberately has no local reset hook. Its first successful invocation proves the
    // ordinary Windows setup reset the same module instance selected by the production alias.
    expect(() => invokeAliasedWindowsPathAttributeHelper(options)).not.toThrow();
  });
});
