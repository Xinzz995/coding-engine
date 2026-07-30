import { readFileSync, readdirSync } from 'node:fs';
import { basename, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  WINDOWS_PATH_ATTRIBUTES_BUNDLE_DIGEST,
  WINDOWS_PATH_ATTRIBUTES_HELPER,
  WINDOWS_PATH_ATTRIBUTES_SOURCE,
  parseWindowsPathAttributeResponse,
  windowsPathAttributeBundleDigest,
} from './windows-path-attributes.js';

const sourceRoot = fileURLToPath(new URL('.', import.meta.url));
const assetRoot = fileURLToPath(new URL('../../assets/workspace-safety/', import.meta.url));

describe('fixed Windows path attribute protocol', () => {
  it('binds the exact LF-normalized reviewed helper bundle bytes', () => {
    const helper = readFileSync(join(assetRoot, WINDOWS_PATH_ATTRIBUTES_HELPER));
    const source = readFileSync(join(assetRoot, WINDOWS_PATH_ATTRIBUTES_SOURCE));
    expect(windowsPathAttributeBundleDigest(helper, source)).toBe(
      WINDOWS_PATH_ATTRIBUTES_BUNDLE_DIGEST,
    );
    expect(readFileSync(join(assetRoot, WINDOWS_PATH_ATTRIBUTES_HELPER), 'utf8')).not.toContain(
      '\r\n',
    );
    expect(readFileSync(join(assetRoot, WINDOWS_PATH_ATTRIBUTES_SOURCE), 'utf8')).not.toContain(
      '\r\n',
    );
    const attributes = readFileSync(join(assetRoot, '..', '..', '.gitattributes'), 'utf8');
    expect(attributes).toContain('assets/workspace-safety/windows-path-attributes.ps1 text eol=lf');
    expect(attributes).toContain('assets/workspace-safety/WindowsPathAttributes.cs text eol=lf');
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
    const native = readFileSync(
      join(sourceRoot, '..', '..', 'build', 'vitest.windows-native.config.mjs'),
      'utf8',
    );
    expect(ordinary).toContain('windows-path-attributes-test-transport.ts');
    expect(native).not.toContain('windows-path-attributes-test-transport');
    expect(native).not.toContain('setupFiles');
  });
});
