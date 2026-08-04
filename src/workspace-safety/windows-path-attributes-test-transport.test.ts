import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  invokeWindowsPathAttributeHelper,
  resetWindowsPathAttributeTestTransport,
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

beforeEach(resetWindowsPathAttributeTestTransport);
afterEach(resetWindowsPathAttributeTestTransport);

describe('deterministic Windows path attribute test transport', () => {
  it('still fails closed when one test exceeds its invocation boundary', () => {
    for (let index = 0; index < WINDOWS_PATH_ATTRIBUTE_TEST_MAX_INVOCATIONS; index += 1) {
      invokeWindowsPathAttributeHelper(options);
    }

    expect(() => invokeWindowsPathAttributeHelper(options)).toThrow(
      'test helper invocation bound exceeded',
    );
  });

  it('accepts the first invocation after the per-test reset', () => {
    expect(() => invokeWindowsPathAttributeHelper(options)).not.toThrow();
  });
});
