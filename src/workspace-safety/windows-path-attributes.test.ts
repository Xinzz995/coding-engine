import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_PATH_ATTRIBUTES_EXECUTABLE,
  WINDOWS_PATH_ATTRIBUTES_EXECUTABLE_DIGEST,
  parseWindowsPathAttributeResponse,
  windowsPathAttributeExecutableDigest,
} from './windows-path-attributes.js';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
const assetRoot = fileURLToPath(new URL('../../assets/workspace-safety/', import.meta.url));

describe('fixed Windows path attribute protocol', () => {
  it('binds the exact reproducible native inspector and reviewed source bytes', () => {
    const executable = readFileSync(join(assetRoot, WINDOWS_PATH_ATTRIBUTES_EXECUTABLE));
    const attributesSource = readFileSync(join(assetRoot, 'WindowsPathAttributes.cs'), 'utf8');
    const programSource = readFileSync(join(assetRoot, 'WindowsPathInspectorProgram.cs'), 'utf8');
    expect(windowsPathAttributeExecutableDigest(executable)).toBe(
      WINDOWS_PATH_ATTRIBUTES_EXECUTABLE_DIGEST,
    );
    expect(executable.subarray(0, 2).toString('ascii')).toBe('MZ');
    expect(attributesSource).not.toContain('\r\n');
    expect(programSource).not.toContain('\r\n');
    const attributes = readFileSync(join(assetRoot, '..', '..', '.gitattributes'), 'utf8');
    expect(attributes).toContain('assets/workspace-safety/WindowsPathAttributes.cs text eol=lf');
    expect(attributes).toContain(
      'assets/workspace-safety/WindowsPathInspectorProgram.cs text eol=lf',
    );
    expect(attributes).toContain(
      'assets/workspace-safety/coding-x-windows-path-inspector.exe binary -filter',
    );

    expect(attributesSource).toContain('FindFirstFileW');
    expect(attributesSource).toContain('FindNextFileW');
    expect(attributesSource).toContain('FindClose');
    expect(attributesSource).toContain('StringComparison.OrdinalIgnoreCase');
    expect(attributesSource).not.toContain('Directory.EnumerateFileSystemEntries');
    expect(programSource).toContain('CXWPI_FAILURE_V1 stage=');

    const transport = readFileSync(
      join(sourceRoot, 'windows-path-attributes-transport.ts'),
      'utf8',
    );
    expect(transport).toContain('HELPER_FAILURE_STAGES');
    expect(transport).toContain('result.status');
    expect(transport).toContain('result.signal');
    expect(transport).not.toContain('String(result.stderr)');
    expect(transport).not.toContain('PowerShell');
  });

  it('accepts only a complete path response bound to exact request order', () => {
    const request = {
      schemaVersion: 1 as const,
      mode: 'paths-v1' as const,
      payload: { paths: ['C:\\proof one', 'C:\\proof two'] },
    };
    expect(
      parseWindowsPathAttributeResponse(
        JSON.stringify({
          schemaVersion: 1,
          mode: 'paths-v1',
          records: [
            { path: 'C:\\proof one', status: 'found', attributes: 16 },
            { path: 'C:\\proof two', status: 'missing', attributes: null },
          ],
        }),
        request,
      ),
    ).toMatchObject({ mode: 'paths-v1' });
    expect(() =>
      parseWindowsPathAttributeResponse(
        JSON.stringify({
          schemaVersion: 1,
          mode: 'paths-v1',
          records: [
            { path: 'C:\\proof two', status: 'missing', attributes: null },
            { path: 'C:\\proof one', status: 'found', attributes: 16 },
          ],
        }),
        request,
      ),
    ).toThrow(/order or identity/u);
  });

  it('uses bounded summary responses instead of returning workspace paths', () => {
    const request = {
      schemaVersion: 1 as const,
      mode: 'workspace-tree-v1' as const,
      payload: {
        root: 'C:\\Unicode 空格\\workspace',
        maxBusinessEntries: 100_000,
        maxSafetyEntries: 100_000,
        maxDepth: 256,
      },
    };
    expect(
      parseWindowsPathAttributeResponse(
        JSON.stringify({
          schemaVersion: 1,
          mode: 'workspace-tree-v1',
          root: request.payload.root,
          rootAttributes: 16,
          businessEntries: 100_000,
          safetyEntries: 100_000,
          complete: true,
        }),
        request,
      ),
    ).toEqual({
      schemaVersion: 1,
      mode: 'workspace-tree-v1',
      root: request.payload.root,
      rootAttributes: 16,
      businessEntries: 100_000,
      safetyEntries: 100_000,
      complete: true,
    });
    expect(() =>
      parseWindowsPathAttributeResponse(
        JSON.stringify({
          schemaVersion: 1,
          mode: 'workspace-tree-v1',
          root: request.payload.root,
          rootAttributes: 16,
          businessEntries: 1,
          safetyEntries: 1,
          complete: true,
          records: [{ path: 'secret.txt' }],
        }),
        request,
      ),
    ).toThrow(/unknown or missing fields/u);
  });

  it('limits production transport imports to reviewed high-level safety modules', () => {
    const allowed = new Set([
      'baseline.ts',
      'bootstrap-recovery.ts',
      'bootstrap.ts',
      'disk-evaluator.ts',
      'filesystem.ts',
      'lease.ts',
      'mutation.ts',
      'mutation-recovery.ts',
      'windows-path-attributes.ts',
    ]);
    const offenders: string[] = [];
    for (const name of readdirSync(sourceRoot).filter((entry) => entry.endsWith('.ts'))) {
      if (
        name.includes('.test.') ||
        name.endsWith('-test-seam.ts') ||
        name.endsWith('-test-transport.ts')
      ) {
        continue;
      }
      const source = readFileSync(join(sourceRoot, name), 'utf8');
      if (
        source.includes("from './windows-path-attributes.js'") ||
        source.includes("from './windows-path-attributes-transport.js'")
      ) {
        if (!allowed.has(basename(name))) offenders.push(name);
      }
    }
    expect(offenders).toEqual([]);

    const filesystem = readFileSync(join(sourceRoot, 'filesystem.ts'), 'utf8');
    const exactRead = filesystem.slice(
      filesystem.indexOf('async function readExactFileSnapshot'),
      filesystem.indexOf(
        'export async function readExactFile',
        filesystem.indexOf('async function readExactFileSnapshot'),
      ),
    );
    expect(exactRead).not.toContain('assertNoWindowsReparsePoints');
    expect(exactRead).not.toContain('assertWindowsSafetyTreeHasNoReparsePoints');
  });

  it('keeps the ordinary Windows suite seam out of the required native config', () => {
    const ordinary = readFileSync(join(sourceRoot, '..', '..', 'vitest.config.ts'), 'utf8');
    const nativeRunner = readFileSync(
      join(sourceRoot, '..', '..', 'build', 'windows-native-proof.mjs'),
      'utf8',
    );
    const native = readFileSync(
      join(sourceRoot, '..', '..', 'build', 'vitest.windows-native.config.mjs'),
      'utf8',
    );
    const register = readFileSync(
      join(sourceRoot, '__fixtures__', 'ordinary-windows-test-register.mjs'),
      'utf8',
    );
    const loader = readFileSync(
      join(sourceRoot, '__fixtures__', 'ordinary-windows-test-loader.mjs'),
      'utf8',
    );
    const pathRegister = readFileSync(
      join(sourceRoot, '__fixtures__', 'ordinary-windows-path-test-register.mjs'),
      'utf8',
    );
    const pathLoader = readFileSync(
      join(sourceRoot, '__fixtures__', 'ordinary-windows-path-test-loader.mjs'),
      'utf8',
    );
    expect(ordinary).toContain('windows-path-attributes-test-transport.ts');
    expect(register).toContain("register(new URL('./ordinary-windows-test-loader.mjs'");
    expect(register).not.toContain('NODE_OPTIONS');
    expect(loader).toContain('PATH_ATTRIBUTES_PARENT');
    expect(loader).toContain('IDENTITY_PARENT');
    expect(loader).toContain('PATH_ATTRIBUTES_PRODUCTION_TRANSPORTS');
    expect(loader).toContain('IDENTITY_PRODUCTION_TRANSPORTS');
    expect(pathRegister).toContain("register(new URL('./ordinary-windows-path-test-loader.mjs'");
    expect(pathLoader).toContain('PATH_ATTRIBUTES_PRODUCTION_TRANSPORTS');
    expect(pathLoader).not.toContain('IDENTITY_PARENT');
    const prestartRecovery = readFileSync(join(sourceRoot, 'prestart-recovery.test.ts'), 'utf8');
    const ownerFixtureLaunch = prestartRecovery.slice(
      prestartRecovery.indexOf("new URL('./__fixtures__/prestart-recovery-owner-worker.ts'"),
    );
    expect(ownerFixtureLaunch).toContain("windowsIdentity: 'production'");
    expect(prestartRecovery.match(/windowsIdentity: 'production'/gu)).toHaveLength(1);
    expect(native).not.toContain('windows-path-attributes-test-transport');
    expect(native).not.toContain('setupFiles');
    for (const forbidden of [
      'ordinary-windows-test-register',
      'ordinary-windows-test-loader',
      'ordinary-windows-path-test-register',
      'ordinary-windows-path-test-loader',
      'cross-process-fixture.test-support',
    ]) {
      expect(native).not.toContain(forbidden);
      expect(nativeRunner).not.toContain(forbidden);
    }
    for (const suite of [
      'windows-supervisor.test.ts',
      'windows-supervisor.crash.test.ts',
      'windows-supervisor-integration.test.ts',
      'delegated-recovery.windows-crash.test.ts',
      'windows-reparse-point.windows.test.ts',
    ]) {
      const source = readFileSync(join(sourceRoot, suite), 'utf8');
      expect(source, suite).not.toContain('ordinary-windows-test-register');
      expect(source, suite).not.toContain('cross-process-fixture.test-support');
    }
  });
});
