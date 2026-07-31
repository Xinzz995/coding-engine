import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { invokeWindowsPathAttributeHelper } from './windows-path-attributes-transport.js';
import { WorkspaceSafetyError } from './types.js';

vi.mock('node:child_process', () => ({ spawnSync: vi.fn() }));

const originalPlatform = Object.getOwnPropertyDescriptor(process, 'platform');

describe('Windows path attribute executable transport', () => {
  beforeEach(() => {
    Object.defineProperty(process, 'platform', {
      configurable: true,
      enumerable: true,
      value: 'win32',
    });
    vi.stubEnv('SystemRoot', 'C:\\Windows');
    vi.stubEnv('TEMP', 'C:\\Temp');
    vi.stubEnv('TMP', 'C:\\Temp');
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetAllMocks();
    if (originalPlatform) Object.defineProperty(process, 'platform', originalPlatform);
  });

  // Ordinary Windows tests deliberately alias this production module to the deterministic
  // test transport. Exercise the real spawn error branch on the unaliased Linux/macOS jobs.
  it.skipIf(process.platform === 'win32')(
    'turns a missing executable with no stderr into a bounded invalid result',
    () => {
      const error = Object.assign(new Error('spawn failure'), { code: 'ENOENT' });
      vi.mocked(spawnSync).mockReturnValue({
        pid: 0,
        output: [null, null, null],
        stdout: undefined,
        stderr: undefined,
        status: null,
        signal: null,
        error,
      } as unknown as ReturnType<typeof spawnSync>);

      let observed: unknown;
      try {
        invokeWindowsPathAttributeHelper({
          executablePath: 'C:\\missing\\coding-x-windows-path-inspector.exe',
          helperDigest: `sha256:${'0'.repeat(64)}`,
          requestBytes: Buffer.from('{}'),
          maxResponseBytes: 1024,
        });
      } catch (caught) {
        observed = caught;
      }

      expect(observed).toBeInstanceOf(WorkspaceSafetyError);
      expect((observed as WorkspaceSafetyError).code).toBe('invalid');
      expect((observed as Error).message).toContain(
        'fixed helper execution failed (code ENOENT, stage unavailable',
      );
      expect((observed as Error).cause).toBe(error);
    },
  );

  it('honors the bounded process-identity helper timeout', () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1234,
      output: [null, Buffer.from('{}'), Buffer.alloc(0)],
      stdout: Buffer.from('{}'),
      stderr: Buffer.alloc(0),
      status: 0,
      signal: null,
    });

    invokeWindowsPathAttributeHelper({
      executablePath: 'C:\\fixed\\coding-x-windows-path-inspector.exe',
      helperDigest: `sha256:${'0'.repeat(64)}`,
      requestBytes: Buffer.from('{}'),
      maxResponseBytes: 1024,
      timeoutMs: 3_000,
    });

    expect(spawnSync).toHaveBeenCalledWith(
      'C:\\fixed\\coding-x-windows-path-inspector.exe',
      expect.any(Array),
      expect.objectContaining({ timeout: 3_000 }),
    );
  });

  it('reports the bounded process identity failure stage without stderr details', () => {
    vi.mocked(spawnSync).mockReturnValue({
      pid: 1234,
      output: [
        null,
        Buffer.alloc(0),
        Buffer.from('CXWPI_FAILURE_V1 stage=process-identity-read code=incomplete'),
      ],
      stdout: Buffer.alloc(0),
      stderr: Buffer.from('CXWPI_FAILURE_V1 stage=process-identity-read code=incomplete'),
      status: 2,
      signal: null,
    });

    expect(() =>
      invokeWindowsPathAttributeHelper({
        executablePath: 'C:\\fixed\\coding-x-windows-path-inspector.exe',
        helperDigest: `sha256:${'0'.repeat(64)}`,
        requestBytes: Buffer.from('{}'),
        maxResponseBytes: 1024,
        timeoutMs: 3_000,
      }),
    ).toThrow(/stage process-identity-read/u);
  });
});
