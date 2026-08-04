/**
 * TEST-ONLY transport selected by the ordinary Windows Vitest config.
 *
 * It preserves strict request, path, type, reparse, depth, and count behavior using Node's own
 * view of the disposable fixtures. The required native proof uses a separate config and therefore
 * cannot resolve this module; that suite proves the Windows-only gap Node cannot observe.
 */
import { spawnSync } from 'node:child_process';
import { lstatSync, readdirSync } from 'node:fs';
import { join, win32 } from 'node:path';
import { WorkspaceSafetyError } from './types.js';
import type { WindowsPathAttributeTransportOptions } from './windows-path-attributes-transport.js';

const FILE_ATTRIBUTE_DIRECTORY = 0x10;
const FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
export const WINDOWS_PATH_ATTRIBUTE_TEST_MAX_INVOCATIONS = 10_000;
let invocationCount = 0;

function invalid(message: string): never {
  throw new WorkspaceSafetyError(
    'invalid',
    `Invalid deterministic Windows path attribute test proof: ${message}`,
  );
}

function environmentValue(name: string): string {
  const keys = Object.keys(process.env).filter((key) => key.toLowerCase() === name);
  if (keys.length !== 1) invalid(`required ${name} environment value is ambiguous`);
  const value = process.env[keys[0]];
  if (typeof value !== 'string' || value.length === 0 || !win32.isAbsolute(value)) {
    invalid(`required ${name} environment value is unavailable`);
  }
  return value;
}

function invokeNativeProcessIdentity(options: WindowsPathAttributeTransportOptions): Buffer {
  const result = spawnSync(
    options.executablePath,
    ['--expected-helper-digest', options.helperDigest],
    {
      cwd: win32.dirname(options.executablePath),
      env: {
        SystemRoot: environmentValue('systemroot'),
        TEMP: environmentValue('temp'),
        TMP: environmentValue('tmp'),
      },
      input: options.requestBytes,
      encoding: 'buffer',
      maxBuffer: options.maxResponseBytes,
      timeout: options.timeoutMs,
      windowsHide: true,
      shell: false,
    },
  );
  if (result.error || result.status !== 0 || result.signal !== null) {
    invalid('native process identity proof is unavailable');
  }
  return Buffer.from(result.stdout);
}

function attributes(path: string): number | undefined {
  try {
    const info = lstatSync(path);
    return (
      (info.isDirectory() ? FILE_ATTRIBUTE_DIRECTORY : 0) |
      (info.isSymbolicLink() ? FILE_ATTRIBUTE_REPARSE_POINT : 0)
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}

function ordinaryAttributes(path: string): number {
  const value = attributes(path);
  if (value === undefined) return invalid('tree path disappeared during inspection');
  if ((value & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
    return invalid('tree contains a Windows reparse point');
  }
  return value;
}

function exactSafetyNames(root: string): void {
  const names = readdirSync(root);
  for (const expected of ['workspace-safety.json', 'engine.lock']) {
    const matches = names.filter((name) => name.toLowerCase() === expected.toLowerCase());
    if (matches.length > 1 || (matches.length === 1 && matches[0] !== expected)) {
      invalid('workspace safety root name does not use canonical spelling');
    }
  }
}

function walk(options: {
  readonly absolutePath: string;
  readonly firstSegment: string;
  readonly relativePath: string;
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxBusinessEntries: number;
  readonly maxSafetyEntries: number;
  readonly budget: { business: number; safety: number };
}): void {
  const value = ordinaryAttributes(options.absolutePath);
  const safety =
    options.firstSegment.toLowerCase() === 'engine.lock' ||
    options.relativePath.toLowerCase() === 'workspace-safety.json';
  if (safety) {
    options.budget.safety += 1;
    if (options.budget.safety > options.maxSafetyEntries) invalid('safety entry limit exceeded');
  } else {
    options.budget.business += 1;
    if (options.budget.business > options.maxBusinessEntries) {
      invalid('business entry limit exceeded');
    }
  }
  if ((value & FILE_ATTRIBUTE_DIRECTORY) === 0) return;
  if (options.depth > options.maxDepth) invalid('tree depth limit exceeded');
  for (const child of readdirSync(options.absolutePath)) {
    walk({
      ...options,
      absolutePath: join(options.absolutePath, child),
      relativePath: `${options.relativePath}/${child}`,
      depth: options.depth + 1,
    });
  }
}

function walkSafetyEntry(options: {
  readonly path: string;
  readonly relativePath: string;
  readonly expected: 'file' | 'directory';
  readonly depth: number;
  readonly maxDepth: number;
  readonly maxSafetyEntries: number;
  readonly budget: { safety: number };
}): void {
  const value = attributes(options.path);
  if (value === undefined) return;
  if ((value & FILE_ATTRIBUTE_REPARSE_POINT) !== 0) invalid('safety tree contains reparse point');
  const directory = (value & FILE_ATTRIBUTE_DIRECTORY) !== 0;
  if ((options.expected === 'directory') !== directory) invalid('safety root type is invalid');
  options.budget.safety += 1;
  if (options.budget.safety > options.maxSafetyEntries) invalid('safety entry limit exceeded');
  if (!directory) return;
  if (options.depth > options.maxDepth) invalid('safety depth limit exceeded');
  for (const child of readdirSync(options.path)) {
    const childPath = join(options.path, child);
    const childValue = ordinaryAttributes(childPath);
    const childDirectory = (childValue & FILE_ATTRIBUTE_DIRECTORY) !== 0;
    walkSafetyEntry({
      ...options,
      path: childPath,
      relativePath: `${options.relativePath}/${child}`,
      expected: childDirectory ? 'directory' : 'file',
      depth: options.depth + 1,
    });
  }
}

export function invokeWindowsPathAttributeHelper(
  options: WindowsPathAttributeTransportOptions,
): Buffer {
  invocationCount += 1;
  if (invocationCount > WINDOWS_PATH_ATTRIBUTE_TEST_MAX_INVOCATIONS) {
    invalid('test helper invocation bound exceeded');
  }
  const request = JSON.parse(options.requestBytes.toString('utf8')) as {
    readonly schemaVersion: number;
    readonly mode: string;
    readonly payload: Record<string, unknown>;
  };
  if (request.schemaVersion !== 1) invalid('unsupported schema');
  if (request.mode === 'process-identity-v1') {
    return invokeNativeProcessIdentity(options);
  }
  if (request.mode === 'paths-v1') {
    const paths = request.payload.paths;
    if (!Array.isArray(paths)) invalid('paths payload is invalid');
    return Buffer.from(
      JSON.stringify({
        schemaVersion: 1,
        mode: request.mode,
        records: paths.map((path) => {
          if (typeof path !== 'string') return invalid('path is not a string');
          const value = attributes(path);
          return value === undefined
            ? { path, status: 'missing', attributes: null, externalBacking: null }
            : {
                path,
                status: 'found',
                attributes: value,
                externalBacking:
                  (value & FILE_ATTRIBUTE_DIRECTORY) !== 0
                    ? { status: 'not-applicable', provider: null, algorithm: null }
                    : { status: 'physical', provider: null, algorithm: null },
              };
        }),
      }),
      'utf8',
    );
  }
  if (request.mode !== 'safety-tree-v1' && request.mode !== 'workspace-tree-v1') {
    return invalid('unsupported mode');
  }
  const root = request.payload.root;
  const maxDepth = request.payload.maxDepth;
  const maxSafetyEntries = request.payload.maxSafetyEntries;
  if (
    typeof root !== 'string' ||
    typeof maxDepth !== 'number' ||
    typeof maxSafetyEntries !== 'number'
  ) {
    return invalid('tree payload is invalid');
  }
  const rootAttributes = ordinaryAttributes(root);
  if ((rootAttributes & FILE_ATTRIBUTE_DIRECTORY) === 0) invalid('tree root is not a directory');
  exactSafetyNames(root);
  const budget = { business: 0, safety: 0 };
  if (request.mode === 'workspace-tree-v1') {
    const maxBusinessEntries = request.payload.maxBusinessEntries;
    if (typeof maxBusinessEntries !== 'number') invalid('business entry limit is invalid');
    for (const child of readdirSync(root)) {
      walk({
        absolutePath: join(root, child),
        firstSegment: child,
        relativePath: child,
        depth: 1,
        maxDepth,
        maxBusinessEntries,
        maxSafetyEntries,
        budget,
      });
    }
  } else {
    walkSafetyEntry({
      path: join(root, 'workspace-safety.json'),
      relativePath: 'workspace-safety.json',
      expected: 'file',
      depth: 1,
      maxDepth,
      maxSafetyEntries,
      budget,
    });
    walkSafetyEntry({
      path: join(root, 'engine.lock'),
      relativePath: 'engine.lock',
      expected: 'directory',
      depth: 1,
      maxDepth,
      maxSafetyEntries,
      budget,
    });
  }
  return Buffer.from(
    JSON.stringify({
      schemaVersion: 1,
      mode: request.mode,
      root,
      rootAttributes,
      ...(request.mode === 'workspace-tree-v1' ? { businessEntries: budget.business } : {}),
      safetyEntries: budget.safety,
      complete: true,
    }),
    'utf8',
  );
}

export function resetWindowsPathAttributeTestTransport(): void {
  invocationCount = 0;
}
