import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  openSync,
  readFileSync,
} from 'node:fs';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WorkspaceSafetyError } from './types.js';
import { invokeWindowsPathAttributeHelper } from './windows-path-attributes-transport.js';

export const WINDOWS_PATH_ATTRIBUTES_EXECUTABLE = 'coding-x-windows-path-inspector.exe';
export const WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT = 0x400;
export const WINDOWS_PATH_ATTRIBUTES_EXECUTABLE_DIGEST =
  'sha256:66761b7e7bd45ec144b268d022f2a30bc4905ce84da083d0269fe84ee320763b';
export const WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS = 3_000;
const EXECUTABLE_DIGEST_DOMAIN = Buffer.from('coding-x-windows-path-inspector-exe-v1\0', 'utf8');
const UNSIGNED_64_MAX = 18_446_744_073_709_551_615n;
const MAX_HELPER_BYTES = 4 * 1024 * 1024;
const MAX_REQUEST_BYTES = 1024 * 1024;
const MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const MAX_PATHS = 4096;
const MAX_PATH_LENGTH = 32767;
const MAX_BUSINESS_TREE_ENTRIES = 100_000;
const MAX_SAFETY_TREE_ENTRIES = 100_000;
const MAX_TREE_DEPTH = 256;

type WindowsPathRequest =
  | {
      readonly schemaVersion: 1;
      readonly mode: 'process-identity-v1';
      readonly payload: { readonly pid: number };
    }
  | {
      readonly schemaVersion: 1;
      readonly mode: 'paths-v1';
      readonly payload: { readonly paths: readonly string[] };
    }
  | {
      readonly schemaVersion: 1;
      readonly mode: 'safety-tree-v1';
      readonly payload: {
        readonly root: string;
        readonly maxSafetyEntries: number;
        readonly maxDepth: number;
      };
    }
  | {
      readonly schemaVersion: 1;
      readonly mode: 'workspace-tree-v1';
      readonly payload: {
        readonly root: string;
        readonly maxBusinessEntries: number;
        readonly maxSafetyEntries: number;
        readonly maxDepth: number;
      };
    };

export type WindowsExternalBacking =
  | { readonly status: 'not-applicable'; readonly provider: null; readonly algorithm: null }
  | { readonly status: 'physical'; readonly provider: null; readonly algorithm: null }
  | {
      readonly status: 'external';
      readonly provider: 'file';
      readonly algorithm: 'xpress4k' | 'lzx' | 'xpress8k' | 'xpress16k';
    }
  | { readonly status: 'external'; readonly provider: 'wim'; readonly algorithm: null };

export type WindowsPathAttributeRecord =
  | {
      readonly path: string;
      readonly status: 'found';
      readonly attributes: number;
      readonly externalBacking: WindowsExternalBacking;
    }
  | {
      readonly path: string;
      readonly status: 'missing';
      readonly attributes: null;
      readonly externalBacking: null;
    };

export interface WindowsPathAttributeResponse {
  readonly schemaVersion: 1;
  readonly mode: 'paths-v1';
  readonly records: readonly WindowsPathAttributeRecord[];
}

export interface WindowsWorkspaceTreeResponse {
  readonly schemaVersion: 1;
  readonly mode: 'safety-tree-v1' | 'workspace-tree-v1';
  readonly root: string;
  readonly rootAttributes: number;
  readonly businessEntries?: number;
  readonly safetyEntries: number;
  readonly complete: true;
}

export type WindowsProcessIdentityResponse =
  | {
      readonly schemaVersion: 1;
      readonly mode: 'process-identity-v1';
      readonly pid: number;
      readonly status: 'found';
      readonly value: string;
    }
  | {
      readonly schemaVersion: 1;
      readonly mode: 'process-identity-v1';
      readonly pid: number;
      readonly status: 'missing' | 'unknown';
      readonly value: null;
    };

type WindowsPathResponse =
  WindowsPathAttributeResponse | WindowsWorkspaceTreeResponse | WindowsProcessIdentityResponse;

function invalid(message: string, cause?: unknown): WorkspaceSafetyError {
  const error = new WorkspaceSafetyError(
    'invalid',
    `Invalid Windows path attribute proof: ${message}`,
  );
  if (cause !== undefined) Object.defineProperty(error, 'cause', { value: cause });
  return error;
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
  label: string,
): void {
  const actual = Reflect.ownKeys(value);
  if (
    actual.some((key) => typeof key !== 'string' || !expected.includes(key)) ||
    expected.some((key) => !Object.hasOwn(value, key))
  ) {
    throw invalid(`${label} has unknown or missing fields`);
  }
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(`${label} must be an object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalid(`${label} must be a plain object`);
  }
  return value as Record<string, unknown>;
}

function supportedAbsolutePath(path: string, label: string): string {
  if (
    path.length === 0 ||
    path.length > MAX_PATH_LENGTH ||
    path.includes('\0') ||
    !isAbsolute(path)
  ) {
    throw invalid(`${label} is not a supported absolute path`);
  }
  return resolve(path);
}

function fixedAssetBundleRoot(): string {
  const candidates = [
    fileURLToPath(new URL('./workspace-safety/', import.meta.url)),
    fileURLToPath(new URL('../../assets/workspace-safety/', import.meta.url)),
  ];
  const root = candidates.find((candidate) =>
    existsSync(join(candidate, WINDOWS_PATH_ATTRIBUTES_EXECUTABLE)),
  );
  if (!root) throw invalid('fixed Windows path attribute asset bundle is missing');
  return root;
}

function stableHelperBytes(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > BigInt(MAX_HELPER_BYTES)
    ) {
      throw invalid('fixed helper must be an ordinary bounded single-link file');
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    const bytes = readFileSync(descriptor);
    const afterHandle = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino ||
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterPath.nlink !== 1n ||
      afterHandle.dev !== opened.dev ||
      afterHandle.ino !== opened.ino ||
      afterHandle.size !== opened.size ||
      afterHandle.mtimeNs !== opened.mtimeNs ||
      afterHandle.ctimeNs !== opened.ctimeNs ||
      afterPath.dev !== afterHandle.dev ||
      afterPath.ino !== afterHandle.ino ||
      afterPath.size !== afterHandle.size ||
      BigInt(bytes.byteLength) !== afterHandle.size
    ) {
      throw invalid('fixed helper changed during read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

export function windowsPathAttributeExecutableDigest(executableBytes: Uint8Array): string {
  return `sha256:${createHash('sha256')
    .update(EXECUTABLE_DIGEST_DOMAIN)
    .update(executableBytes)
    .digest('hex')}`;
}

function integer(value: unknown, minimum: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    throw invalid(`${label} is outside its supported boundary`);
  }
  return value as number;
}

function parseExternalBacking(
  value: unknown,
  attributes: number,
  label: string,
): WindowsExternalBacking {
  const backing = record(value, label);
  exactKeys(backing, ['status', 'provider', 'algorithm'], label);
  const directory = (attributes & 0x10) !== 0;
  if (
    backing.status === 'not-applicable' &&
    backing.provider === null &&
    backing.algorithm === null
  ) {
    if (!directory) throw invalid(`${label} is not applicable only to directories`);
    return { status: 'not-applicable', provider: null, algorithm: null };
  }
  if (directory) throw invalid(`${label} must be not-applicable for a directory`);
  if (backing.status === 'physical' && backing.provider === null && backing.algorithm === null) {
    return { status: 'physical', provider: null, algorithm: null };
  }
  if (backing.status !== 'external') {
    throw invalid(`${label} status is invalid`);
  }
  if (backing.provider === 'wim' && backing.algorithm === null) {
    return { status: 'external', provider: 'wim', algorithm: null };
  }
  if (
    backing.provider === 'file' &&
    (backing.algorithm === 'xpress4k' ||
      backing.algorithm === 'lzx' ||
      backing.algorithm === 'xpress8k' ||
      backing.algorithm === 'xpress16k')
  ) {
    return { status: 'external', provider: 'file', algorithm: backing.algorithm };
  }
  throw invalid(`${label} provider and algorithm are inconsistent`);
}

export function parseWindowsPathAttributeResponse(
  input: string | Buffer,
  expected: WindowsPathRequest,
): WindowsPathResponse {
  const bytes = Buffer.isBuffer(input) ? input : Buffer.from(input, 'utf8');
  if (bytes.byteLength === 0 || bytes.byteLength > MAX_RESPONSE_BYTES) {
    throw invalid('response exceeds its size boundary');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch (error) {
    throw invalid('response is not valid JSON', error);
  }
  const response = record(parsed, 'response');
  if (expected.mode === 'process-identity-v1') {
    exactKeys(response, ['schemaVersion', 'mode', 'pid', 'status', 'value'], 'response');
    if (
      response.schemaVersion !== 1 ||
      response.mode !== expected.mode ||
      response.pid !== expected.payload.pid
    ) {
      throw invalid('process identity response binding is incomplete or mismatched');
    }
    if (response.status === 'found') {
      if (
        typeof response.value !== 'string' ||
        !/^[1-9]\d{0,19}$/u.test(response.value) ||
        BigInt(response.value) > UNSIGNED_64_MAX
      ) {
        throw invalid('process identity value is not a canonical unsigned 64-bit integer');
      }
      return {
        schemaVersion: 1,
        mode: expected.mode,
        pid: expected.payload.pid,
        status: 'found',
        value: response.value,
      };
    }
    if (
      (response.status !== 'missing' && response.status !== 'unknown') ||
      response.value !== null
    ) {
      throw invalid('process identity status and value are inconsistent');
    }
    return {
      schemaVersion: 1,
      mode: expected.mode,
      pid: expected.payload.pid,
      status: response.status,
      value: null,
    };
  }
  if (expected.mode === 'safety-tree-v1' || expected.mode === 'workspace-tree-v1') {
    const responseKeys = [
      'schemaVersion',
      'mode',
      'root',
      'rootAttributes',
      'safetyEntries',
      'complete',
      ...(expected.mode === 'workspace-tree-v1' ? ['businessEntries'] : []),
    ];
    exactKeys(response, responseKeys, 'response');
    if (
      response.schemaVersion !== 1 ||
      response.mode !== expected.mode ||
      response.root !== expected.payload.root ||
      response.complete !== true
    ) {
      throw invalid('workspace tree response binding is incomplete or mismatched');
    }
    const rootAttributes = integer(response.rootAttributes, 0, 0xffffffff, 'root attributes');
    if ((rootAttributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      throw invalid('workspace tree root is a Windows reparse point');
    }
    return {
      schemaVersion: 1,
      mode: expected.mode,
      root: expected.payload.root,
      rootAttributes,
      ...(expected.mode === 'workspace-tree-v1'
        ? {
            businessEntries: integer(
              response.businessEntries,
              0,
              expected.payload.maxBusinessEntries ?? 0,
              'businessEntries',
            ),
          }
        : {}),
      safetyEntries: integer(
        response.safetyEntries,
        0,
        expected.payload.maxSafetyEntries,
        'safetyEntries',
      ),
      complete: true,
    };
  }

  exactKeys(response, ['schemaVersion', 'mode', 'records'], 'response');
  if (response.schemaVersion !== 1 || response.mode !== expected.mode) {
    throw invalid('response binding does not match the request');
  }
  if (!Array.isArray(response.records)) throw invalid('response records must be an array');
  const records = response.records.map((item, index): WindowsPathAttributeRecord => {
    const parsedRecord = record(item, `response record ${index}`);
    exactKeys(
      parsedRecord,
      ['path', 'status', 'attributes', 'externalBacking'],
      `response record ${index}`,
    );
    if (
      typeof parsedRecord.path !== 'string' ||
      parsedRecord.path.length > MAX_PATH_LENGTH ||
      parsedRecord.path.includes('\0')
    ) {
      throw invalid(`response record ${index} path is invalid`);
    }
    if (parsedRecord.status === 'missing') {
      if (parsedRecord.attributes !== null || parsedRecord.externalBacking !== null) {
        throw invalid(`response record ${index} missing proof must be null`);
      }
      return {
        path: parsedRecord.path,
        status: 'missing',
        attributes: null,
        externalBacking: null,
      };
    }
    if (parsedRecord.status !== 'found') {
      throw invalid(`response record ${index} status is invalid`);
    }
    const attributes = integer(parsedRecord.attributes, 0, 0xffffffff, 'file attributes');
    return {
      path: parsedRecord.path,
      status: 'found',
      attributes,
      externalBacking: parseExternalBacking(
        parsedRecord.externalBacking,
        attributes,
        `response record ${index} external backing`,
      ),
    };
  });
  if (
    records.length !== expected.payload.paths.length ||
    records.some((item, index) => item.path !== expected.payload.paths[index])
  ) {
    throw invalid('path response order or identity does not match the request');
  }
  return { schemaVersion: 1, mode: 'paths-v1', records };
}

function runWindowsPathAttributeProbe(request: WindowsPathRequest): WindowsPathResponse {
  if (process.platform !== 'win32') {
    throw new WorkspaceSafetyError('unsupported', 'Windows path attributes require Windows');
  }
  const requestBytes = Buffer.from(JSON.stringify(request), 'utf8');
  if (requestBytes.byteLength === 0 || requestBytes.byteLength > MAX_REQUEST_BYTES) {
    throw invalid('request exceeds its size boundary');
  }
  const assetRoot = fixedAssetBundleRoot();
  const executablePath = join(assetRoot, WINDOWS_PATH_ATTRIBUTES_EXECUTABLE);
  const executableBytes = stableHelperBytes(executablePath);
  const helperDigest = windowsPathAttributeExecutableDigest(executableBytes);
  if (helperDigest !== WINDOWS_PATH_ATTRIBUTES_EXECUTABLE_DIGEST) {
    throw invalid('fixed helper executable digest is not the reviewed digest');
  }
  const responseBytes = invokeWindowsPathAttributeHelper({
    executablePath,
    helperDigest,
    requestBytes,
    maxResponseBytes: MAX_RESPONSE_BYTES,
    ...(request.mode === 'process-identity-v1'
      ? { timeoutMs: WINDOWS_PROCESS_IDENTITY_TIMEOUT_MS }
      : {}),
  });
  return parseWindowsPathAttributeResponse(responseBytes, request);
}

export function inspectWindowsProcessIdentity(pid: number): WindowsProcessIdentityResponse {
  if (process.platform !== 'win32') {
    throw new WorkspaceSafetyError('unsupported', 'Windows process identity requires Windows');
  }
  const request: WindowsPathRequest = {
    schemaVersion: 1,
    mode: 'process-identity-v1',
    payload: { pid: integer(pid, 1, 0xffffffff, 'pid') },
  };
  const response = runWindowsPathAttributeProbe(request);
  if (response.mode !== 'process-identity-v1') {
    throw invalid('process identity probe returned the wrong response mode');
  }
  return response;
}

export function inspectWindowsPathAttributes(
  paths: readonly string[],
): WindowsPathAttributeRecord[] {
  if (process.platform !== 'win32') return [];
  if (paths.length === 0 || paths.length > MAX_PATHS) {
    throw invalid('path count exceeds its supported boundary');
  }
  const canonical = paths.map((path, index) => supportedAbsolutePath(path, `path ${index}`));
  const request: WindowsPathRequest = {
    schemaVersion: 1,
    mode: 'paths-v1',
    payload: { paths: canonical },
  };
  const response = runWindowsPathAttributeProbe(request);
  if (response.mode !== 'paths-v1') throw invalid('path probe returned the wrong response mode');
  return [...response.records];
}

export function assertNoWindowsReparsePoints(
  paths: readonly string[],
  options: { readonly allowMissing?: boolean } = {},
): void {
  if (process.platform !== 'win32') return;
  for (const item of inspectWindowsPathAttributes(paths)) {
    if (item.status === 'missing') {
      if (options.allowMissing === true) continue;
      throw invalid('required path is missing');
    }
    if ((item.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      throw invalid('path is a Windows reparse point');
    }
    if (item.externalBacking.status === 'external') {
      throw invalid('path has Windows external backing');
    }
  }
}

function windowsPathAncestry(path: string): string[] {
  const absolute = win32.resolve(path);
  const parsed = win32.parse(absolute);
  const parts = absolute.slice(parsed.root.length).split(win32.sep).filter(Boolean);
  const ancestry = [parsed.root];
  let current = parsed.root;
  for (const part of parts) {
    current = win32.join(current, part);
    ancestry.push(current);
  }
  return ancestry;
}

export function assertWindowsWorkspacePathAncestry(
  requestedPath: string,
  canonicalPath: string,
): void {
  if (process.platform !== 'win32') return;
  const requested = windowsPathAncestry(supportedAbsolutePath(requestedPath, 'requested path'));
  const canonical = windowsPathAncestry(supportedAbsolutePath(canonicalPath, 'canonical path'));
  const paths = [...new Set([...requested, ...canonical])];
  const byPath = new Map(inspectWindowsPathAttributes(paths).map((item) => [item.path, item]));
  for (const path of requested) {
    const item = byPath.get(path);
    if (!item) throw invalid('requested path ancestry proof is incomplete');
    if (item.status !== 'found') throw invalid('requested path ancestry is incomplete');
    if (item.externalBacking.status === 'external') {
      throw invalid('requested path ancestry contains Windows external backing');
    }
    if ((item.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) === 0) continue;
    const info = lstatSync(item.path);
    if (!info.isSymbolicLink()) {
      throw invalid('requested path ancestry contains an unrecognized Windows reparse point');
    }
  }
  for (const path of canonical) {
    const item = byPath.get(path);
    if (!item || item.status !== 'found') throw invalid('canonical path ancestry is incomplete');
    if (item.externalBacking.status === 'external') {
      throw invalid('canonical path ancestry contains Windows external backing');
    }
    if ((item.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) !== 0) {
      throw invalid('canonical path ancestry contains a Windows reparse point');
    }
  }
}

export function assertWindowsRequestedPathAncestryBeforeCreate(requestedPath: string): void {
  if (process.platform !== 'win32') return;
  const requested = windowsPathAncestry(supportedAbsolutePath(requestedPath, 'requested path'));
  let missing = false;
  for (const item of inspectWindowsPathAttributes(requested)) {
    if (item.status === 'missing') {
      missing = true;
      continue;
    }
    if (missing) throw invalid('requested path ancestry is discontinuous');
    if (item.externalBacking.status === 'external') {
      throw invalid('requested path ancestry contains Windows external backing');
    }
    if ((item.attributes & WINDOWS_FILE_ATTRIBUTE_REPARSE_POINT) === 0) continue;
    const info = lstatSync(item.path);
    if (!info.isSymbolicLink()) {
      throw invalid('requested path ancestry contains an unrecognized Windows reparse point');
    }
  }
}

export function assertWindowsSafetyTreeHasNoReparsePoints(
  root: string,
): WindowsWorkspaceTreeResponse | undefined {
  if (process.platform !== 'win32') return;
  const canonicalRoot = supportedAbsolutePath(root, 'safety tree root');
  const request: WindowsPathRequest = {
    schemaVersion: 1,
    mode: 'safety-tree-v1',
    payload: {
      root: canonicalRoot,
      maxSafetyEntries: MAX_SAFETY_TREE_ENTRIES,
      maxDepth: MAX_TREE_DEPTH,
    },
  };
  const response = runWindowsPathAttributeProbe(request);
  if (response.mode !== 'safety-tree-v1') {
    throw invalid('safety tree probe returned the wrong response mode');
  }
  return response;
}

export function assertWindowsWorkspaceTreeHasNoReparsePoints(
  root: string,
  options: {
    readonly maxBusinessEntries?: number;
    readonly maxSafetyEntries?: number;
    readonly maxDepth?: number;
  } = {},
): WindowsWorkspaceTreeResponse | undefined {
  if (process.platform !== 'win32') return;
  const canonicalRoot = supportedAbsolutePath(root, 'tree root');
  const maxBusinessEntries = integer(
    options.maxBusinessEntries ?? MAX_BUSINESS_TREE_ENTRIES,
    0,
    MAX_BUSINESS_TREE_ENTRIES,
    'maxBusinessEntries',
  );
  const maxSafetyEntries = integer(
    options.maxSafetyEntries ?? MAX_SAFETY_TREE_ENTRIES,
    0,
    MAX_SAFETY_TREE_ENTRIES,
    'maxSafetyEntries',
  );
  const maxDepth = integer(options.maxDepth ?? MAX_TREE_DEPTH, 0, MAX_TREE_DEPTH, 'maxDepth');
  const request: WindowsPathRequest = {
    schemaVersion: 1,
    mode: 'workspace-tree-v1',
    payload: { root: canonicalRoot, maxBusinessEntries, maxSafetyEntries, maxDepth },
  };
  const response = runWindowsPathAttributeProbe(request);
  if (response.mode !== 'workspace-tree-v1') {
    throw invalid('workspace tree probe returned the wrong response mode');
  }
  return response;
}
