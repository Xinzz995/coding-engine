import { createHash } from 'node:crypto';
import { posix } from 'node:path';
import {
  parseDelegatedSemanticContract,
  type DelegatedSemanticCandidate,
  type DelegatedSemanticContract,
  type DelegatedSemanticEvaluation,
} from '../contracts/delegated-operation-contract.js';
import { PROTOCOL_ROOT_DIR, WORKSPACE_MARKER_FILE, WorkspaceSafetyError } from './types.js';

export type DelegatedChange = 'create' | 'modify' | 'delete';

export interface DelegationRule {
  path: string;
  semantics: 'whole-file' | 'append-only' | 'json-mutable-pointers' | 'add-only-directory';
  allow: DelegatedChange[];
  mutableJsonPointers?: string[];
}

export interface DelegationContract {
  version: string;
  semantic: DelegatedSemanticContract;
  rules: DelegationRule[];
}

export interface BaselineEntry {
  path: string;
  type: 'file' | 'directory';
  bytes?: number;
  digest: string;
  protectedProjectionDigest?: string;
}

export interface DelegatedBaseline {
  schemaVersion: 1;
  ownerId: string;
  operationId: string;
  workspaceIdentity: string;
  contract: DelegationContract;
  contractDigest: string;
  entries: BaselineEntry[];
  capturedAt: string;
  manifestDigest: string;
}

export type DeltaEvaluation =
  | { accepted: true; changes: string[]; candidate?: DelegatedSemanticCandidate }
  | { accepted: false; changes: string[]; violations: string[] };

export interface BaselineScanHooks {
  afterFirstScan?: () => void;
  limits?: Partial<BaselineScanLimits>;
}

export interface BaselineScanLimits {
  readonly fileBytes: number;
  readonly totalBytes: number;
  readonly depth: number;
}

export interface DeltaEvaluationOptions extends BaselineScanHooks {
  requireUnchanged?: boolean;
  beforeAppendPrefixRead?: (path: string) => void;
}

export const DELEGATION_LIMITS = Object.freeze({
  contractBytes: 64 * 1024,
  rules: 256,
  allowPerRule: 3,
  pointersPerRule: 256,
  pathBytes: 4096,
  versionBytes: 128,
  pointerBytes: 512,
  entries: 100_000,
  baselineBytes: 64 * 1024 * 1024,
  fileBytes: 64 * 1024 * 1024,
  totalBytes: 256 * 1024 * 1024,
  depth: 256,
} as const);

export const SHA256_PREFIX = 'sha256:';
const SHA256_PATTERN = /^sha256:[0-9a-f]{64}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const UTC_TIMESTAMP_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const SEMANTICS = new Set<DelegationRule['semantics']>([
  'whole-file',
  'append-only',
  'json-mutable-pointers',
  'add-only-directory',
]);
const CHANGES = new Set<DelegatedChange>(['create', 'modify', 'delete']);
export const DIRECTORY_DIGEST = digestBytes('directory-v1');
const MUTABLE_SENTINEL = Object.freeze({ $codingXMutable: true });

type StrictRecord = Record<string, unknown>;

export interface BigStatShape {
  dev: bigint;
  ino: bigint;
  mode: bigint;
  size: bigint;
  mtimeNs: bigint;
  ctimeNs: bigint;
  nlink: bigint;
  isFile(): boolean;
  isDirectory(): boolean;
  isSymbolicLink(): boolean;
}

export interface StatSignature {
  dev: string;
  ino: string;
  mode: string;
  size: string;
  mtimeNs: string;
  ctimeNs: string;
  nlink: string;
}

export interface ScanObservation {
  path: string;
  rawPath: string;
  absolutePath: string;
  type: 'file' | 'directory';
  stat: StatSignature;
}

export interface ScanSnapshot {
  entries: BaselineEntry[];
  observations: Map<string, ScanObservation>;
  semantic: DelegatedSemanticEvaluation;
  comparisonBytes: string;
}

export function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', message);
}

export function digestBytes(value: string | Buffer): string {
  return `${SHA256_PREFIX}${createHash('sha256').update(value).digest('hex')}`;
}

export function resolveScanLimits(input: Partial<BaselineScanLimits> = {}): BaselineScanLimits {
  const bounded = (value: number | undefined, maximum: number, label: string): number => {
    const resolved = value ?? maximum;
    if (!Number.isSafeInteger(resolved) || resolved < 1 || resolved > maximum) {
      return invalid(`${label} 必须是正整数且不能高于安全上限`);
    }
    return resolved;
  };
  const fileBytes = bounded(input.fileBytes, DELEGATION_LIMITS.fileBytes, 'fileBytes');
  const totalBytes = bounded(input.totalBytes, DELEGATION_LIMITS.totalBytes, 'totalBytes');
  if (fileBytes > totalBytes) invalid('fileBytes 不能高于 totalBytes');
  return {
    fileBytes,
    totalBytes,
    depth: bounded(input.depth, DELEGATION_LIMITS.depth, 'depth'),
  };
}

export function compareCanonicalStrings(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function asStrictRecord(value: unknown, label: string): StrictRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return invalid(`${label} 必须是普通 JSON object`);
  }
  const prototype: unknown = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    return invalid(`${label} 必须是普通 JSON object`);
  }
  return value as StrictRecord;
}

export function requireExactKeys(
  record: StrictRecord,
  keys: readonly string[],
  label: string,
): void {
  const expected = new Set(keys);
  for (const key of Reflect.ownKeys(record)) {
    if (typeof key !== 'string' || !expected.has(key)) invalid(`${label} 包含 unknown field`);
  }
  for (const key of keys) {
    if (!Object.hasOwn(record, key)) invalid(`${label} 缺少字段 ${key}`);
  }
}

function requireString(value: unknown, label: string, maxBytes: number): string {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    Buffer.byteLength(value, 'utf8') > maxBytes
  ) {
    return invalid(`${label} 长度非法`);
  }
  return value;
}

export function requireUuid(value: unknown, label: string): string {
  const parsed = requireString(value, label, 64);
  if (!UUID_PATTERN.test(parsed)) invalid(`${label} 必须是 canonical UUID`);
  return parsed;
}

export function requireDigest(value: unknown, label: string): string {
  if (typeof value !== 'string' || !SHA256_PATTERN.test(value)) {
    return invalid(`${label} 必须是 canonical sha256 digest`);
  }
  return value;
}

export function requireTimestamp(value: unknown, label: string): string {
  if (typeof value !== 'string' || !UTC_TIMESTAMP_PATTERN.test(value)) {
    return invalid(`${label} 必须是毫秒 UTC 时间`);
  }
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp) || new Date(timestamp).toISOString() !== value) {
    return invalid(`${label} 时间非法`);
  }
  return value;
}

export function canonicalJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return invalid('canonical JSON 不允许非有限 number');
    return JSON.stringify(value);
  }
  if (typeof value !== 'object') {
    return invalid('canonical JSON 不允许 undefined/function/symbol/bigint');
  }
  if (ancestors.has(value)) return invalid('canonical JSON 不允许循环引用');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const ownKeys = Reflect.ownKeys(value).filter((key) => key !== 'length');
      if (
        ownKeys.some(
          (key) =>
            typeof key !== 'string' || !/^(0|[1-9]\d*)$/.test(key) || Number(key) >= value.length,
        )
      ) {
        return invalid('canonical JSON array 包含非索引字段');
      }
      const items: string[] = [];
      for (let index = 0; index < value.length; index += 1) {
        if (!Object.hasOwn(value, index)) return invalid('canonical JSON 不允许数组空洞');
        items.push(canonicalJson(value[index], ancestors));
      }
      return `[${items.join(',')}]`;
    }
    const record = asStrictRecord(value, 'canonical JSON value');
    const keys = Reflect.ownKeys(record);
    if (keys.some((key) => typeof key !== 'string')) {
      return invalid('canonical JSON object 不允许 symbol key');
    }
    return `{${(keys as string[])
      .sort(compareCanonicalStrings)
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key], ancestors)}`)
      .join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function workspacePathCollisionKey(
  path: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const nfc = path.normalize('NFC');
  if (platform !== 'darwin' && platform !== 'win32') return nfc;
  // Repeating upper/lower reaches a stable caseless key even for mappings such as
  // capital sharp S, whose first lowercase pass expands only on the next round.
  let folded = nfc;
  for (let round = 0; round < 8; round += 1) {
    const next = folded.toUpperCase().toLowerCase().normalize('NFC');
    if (next === folded) return next;
    folded = next;
  }
  return invalid('workspace path Unicode casefold 无法稳定');
}

function isSafetyPathForPlatform(path: string, platform: NodeJS.Platform): boolean {
  const key = workspacePathCollisionKey(path, platform);
  const protocolKey = workspacePathCollisionKey(PROTOCOL_ROOT_DIR, platform);
  const markerKey = workspacePathCollisionKey(WORKSPACE_MARKER_FILE, platform);
  return key === markerKey || key === protocolKey || key.startsWith(`${protocolKey}/`);
}

export function isProtocolPath(path: string): boolean {
  return isSafetyPathForPlatform(path, process.platform);
}

export function isReservedSafetyPath(path: string): boolean {
  return isSafetyPathForPlatform(path, 'win32');
}

export function validateRelativePath(value: unknown, label: string): string {
  const raw = requireString(value, label, DELEGATION_LIMITS.pathBytes);
  if (raw.includes('\\')) invalid(`${label} 必须使用 / 分隔`);
  const normalized = raw.normalize('NFC');
  if (
    normalized.startsWith('/') ||
    normalized.includes('\0') ||
    normalized.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    posix.normalize(normalized) !== normalized ||
    Buffer.byteLength(normalized, 'utf8') > DELEGATION_LIMITS.pathBytes
  ) {
    invalid(`${label} 不是安全的 workspace relative path`);
  }
  if (isReservedSafetyPath(normalized)) {
    invalid(`${label} 不能授权安全协议路径`);
  }
  return normalized;
}

function parseJsonPointer(pointerValue: unknown): { pointer: string; tokens: string[] } {
  const pointer = requireString(pointerValue, 'JSON pointer', DELEGATION_LIMITS.pointerBytes);
  if (!pointer.startsWith('/')) invalid('JSON pointer 必须是非 root RFC 6901 pointer');
  const rawTokens = pointer.slice(1).split('/');
  const tokens = rawTokens.map((token) => {
    if (/~(?:[^01]|$)/.test(token)) invalid('JSON pointer 包含非法 ~ escape');
    return token.replaceAll('~1', '/').replaceAll('~0', '~');
  });
  return { pointer, tokens };
}

function tokensOverlap(left: string[], right: string[]): boolean {
  const length = Math.min(left.length, right.length);
  if (left.slice(0, length).some((token, index) => token !== right[index])) return false;
  return true;
}

export function validateContract(value: unknown): DelegationContract {
  const record = asStrictRecord(value, 'delegation contract');
  requireExactKeys(record, ['version', 'semantic', 'rules'], 'delegation contract');
  const version = requireString(
    record.version,
    'delegation contract version',
    DELEGATION_LIMITS.versionBytes,
  );
  const semanticResult = parseDelegatedSemanticContract(record.semantic);
  if (!semanticResult.ok) invalid(semanticResult.diagnostic);
  const semantic = semanticResult.value;
  if (!Array.isArray(record.rules) || record.rules.length > DELEGATION_LIMITS.rules) {
    return invalid('delegation contract rules 超出 limit');
  }

  const seenPaths = new Set<string>();
  const parsedRules: DelegationRule[] = [];
  for (const [index, rawRule] of record.rules.entries()) {
    const rule = asStrictRecord(rawRule, `delegation rule ${index}`);
    const rawSemantics = rule.semantics;
    if (
      typeof rawSemantics !== 'string' ||
      !SEMANTICS.has(rawSemantics as DelegationRule['semantics'])
    ) {
      invalid(`delegation rule ${index} semantics 非法`);
    }
    const semantics = rawSemantics as DelegationRule['semantics'];
    if (semantics !== 'json-mutable-pointers' && Object.hasOwn(rule, 'mutableJsonPointers')) {
      invalid(`delegation rule ${index} 不允许 mutableJsonPointers（包括 undefined）`);
    }
    requireExactKeys(
      rule,
      semantics === 'json-mutable-pointers'
        ? ['path', 'semantics', 'allow', 'mutableJsonPointers']
        : ['path', 'semantics', 'allow'],
      `delegation rule ${index}`,
    );
    const path = validateRelativePath(rule.path, `delegation rule ${index} path`);
    const collisionKey = workspacePathCollisionKey(path);
    if (seenPaths.has(collisionKey)) invalid(`重复 delegation rule path：${path}`);
    seenPaths.add(collisionKey);

    if (
      !Array.isArray(rule.allow) ||
      rule.allow.length === 0 ||
      rule.allow.length > DELEGATION_LIMITS.allowPerRule
    ) {
      invalid(`delegation rule allow 超出 limit：${path}`);
    }
    const allow: DelegatedChange[] = [];
    const seenAllow = new Set<string>();
    for (const item of rule.allow) {
      if (typeof item !== 'string' || !CHANGES.has(item as DelegatedChange)) {
        invalid(`delegation rule allow 非法：${path}`);
      }
      if (seenAllow.has(item)) invalid(`delegation rule allow 重复：${path}`);
      seenAllow.add(item);
      allow.push(item as DelegatedChange);
    }
    allow.sort(compareCanonicalStrings);

    if (
      semantics === 'append-only' &&
      canonicalJson(allow) !== canonicalJson(['modify']) &&
      canonicalJson(allow) !== canonicalJson(['create', 'modify'])
    ) {
      invalid(`append-only 只允许 modify 或 create+modify：${path}`);
    }
    if (
      semantics === 'json-mutable-pointers' &&
      canonicalJson(allow) !== canonicalJson(['modify'])
    ) {
      invalid(`json-mutable-pointers 只允许 modify：${path}`);
    }
    if (semantics === 'add-only-directory' && canonicalJson(allow) !== canonicalJson(['create'])) {
      invalid(`add-only-directory 只允许 create：${path}`);
    }

    if (semantics === 'json-mutable-pointers') {
      if (
        !Array.isArray(rule.mutableJsonPointers) ||
        rule.mutableJsonPointers.length === 0 ||
        rule.mutableJsonPointers.length > DELEGATION_LIMITS.pointersPerRule
      ) {
        invalid(`JSON rule mutable pointers 超出 limit：${path}`);
      }
      const parsedPointers = rule.mutableJsonPointers.map(parseJsonPointer);
      for (let left = 0; left < parsedPointers.length; left += 1) {
        for (let right = left + 1; right < parsedPointers.length; right += 1) {
          if (tokensOverlap(parsedPointers[left].tokens, parsedPointers[right].tokens)) {
            invalid(`JSON pointer 重复或祖先重叠：${path}`);
          }
        }
      }
      parsedRules.push({
        path,
        semantics,
        allow,
        mutableJsonPointers: parsedPointers
          .map((item) => item.pointer)
          .sort(compareCanonicalStrings),
      });
    } else {
      parsedRules.push({ path, semantics, allow });
    }
  }

  parsedRules.sort((left, right) => compareCanonicalStrings(left.path, right.path));
  for (let left = 0; left < parsedRules.length; left += 1) {
    for (let right = left + 1; right < parsedRules.length; right += 1) {
      const a = parsedRules[left];
      const b = parsedRules[right];
      if (
        (a.semantics === 'add-only-directory' && b.path.startsWith(`${a.path}/`)) ||
        (b.semantics === 'add-only-directory' && a.path.startsWith(`${b.path}/`))
      ) {
        invalid(`add-only-directory 与子 rule 重叠：${a.path} / ${b.path}`);
      }
    }
  }

  const contract = { version, semantic, rules: parsedRules };
  if (Buffer.byteLength(canonicalJson(contract), 'utf8') > DELEGATION_LIMITS.contractBytes) {
    invalid('delegation contract canonical size 超过 64KiB limit');
  }
  return contract;
}

export function assertBaselineEntryLimit(count: number): void {
  if (!Number.isSafeInteger(count) || count < 0 || count > DELEGATION_LIMITS.entries) {
    invalid('delegated baseline entries 超出 limit');
  }
}

class DuplicateKeyScanner {
  private index = 0;

  constructor(private readonly text: string) {}

  scan(): void {
    this.skipWhitespace();
    this.value();
    this.skipWhitespace();
    if (this.index !== this.text.length) throw new Error('trailing JSON input');
  }

  private value(): void {
    const character = this.text[this.index];
    if (character === '{') return this.object();
    if (character === '[') return this.array();
    if (character === '"') {
      this.string();
      return;
    }
    for (const literal of ['true', 'false', 'null']) {
      if (this.text.startsWith(literal, this.index)) {
        this.index += literal.length;
        return;
      }
    }
    const match = /^-?(?:0|[1-9]\d*)(?:\.\d+)?(?:[eE][+-]?\d+)?/.exec(this.text.slice(this.index));
    if (!match) throw new Error('invalid JSON value');
    this.index += match[0].length;
  }

  private object(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.take('}')) return;
    const keys = new Set<string>();
    while (true) {
      if (this.text[this.index] !== '"') throw new Error('invalid JSON object key');
      const key = this.string();
      if (keys.has(key)) throw new Error('duplicate JSON key');
      keys.add(key);
      this.skipWhitespace();
      this.expect(':');
      this.skipWhitespace();
      this.value();
      this.skipWhitespace();
      if (this.take('}')) return;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private array(): void {
    this.index += 1;
    this.skipWhitespace();
    if (this.take(']')) return;
    while (true) {
      this.value();
      this.skipWhitespace();
      if (this.take(']')) return;
      this.expect(',');
      this.skipWhitespace();
    }
  }

  private string(): string {
    const start = this.index;
    this.expect('"');
    while (this.index < this.text.length) {
      const character = this.text[this.index++];
      if (character === '"') return JSON.parse(this.text.slice(start, this.index)) as string;
      if (character === '\\') {
        const escape = this.text[this.index++];
        if (escape === 'u') {
          if (!/^[0-9a-fA-F]{4}$/.test(this.text.slice(this.index, this.index + 4))) {
            throw new Error('invalid JSON unicode escape');
          }
          this.index += 4;
        } else if (!escape || !'"\\/bfnrt'.includes(escape)) {
          throw new Error('invalid JSON string escape');
        }
      } else if (!character || character.charCodeAt(0) < 0x20) {
        throw new Error('invalid JSON string');
      }
    }
    throw new Error('unterminated JSON string');
  }

  private skipWhitespace(): void {
    while (' \t\r\n'.includes(this.text[this.index] ?? '\0')) this.index += 1;
  }

  private take(character: string): boolean {
    if (this.text[this.index] !== character) return false;
    this.index += 1;
    return true;
  }

  private expect(character: string): void {
    if (!this.take(character)) throw new Error(`expected ${character}`);
  }
}

export function parseStrictJson(bytes: Buffer, path: string): unknown {
  if (bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) {
    invalid(`JSON delegation 不允许 BOM：${path}`);
  }
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalid(`JSON delegation 不是严格 UTF-8：${path}`);
  }
  if (text.charCodeAt(0) === 0xfeff) invalid(`JSON delegation 不允许 BOM：${path}`);
  try {
    new DuplicateKeyScanner(text).scan();
  } catch (error) {
    const detail = error instanceof Error ? error.message : 'invalid JSON';
    return invalid(`JSON delegation 输入不可解析：${path} (${detail})`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text) as unknown;
  } catch {
    return invalid(`JSON delegation 输入不可解析：${path}`);
  }
  canonicalJson(parsed);
  return parsed;
}

function resolvePointerParent(
  root: unknown,
  tokens: string[],
): { parent: StrictRecord | unknown[]; leaf: string } | null {
  let cursor = root;
  for (const token of tokens.slice(0, -1)) {
    if (Array.isArray(cursor)) {
      if (!/^(0|[1-9]\d*)$/.test(token)) return null;
      const index = Number(token);
      if (index >= cursor.length || !Object.hasOwn(cursor, index)) return null;
      cursor = cursor[index];
    } else if (cursor !== null && typeof cursor === 'object') {
      const record = cursor as StrictRecord;
      if (!Object.hasOwn(record, token)) return null;
      cursor = record[token];
    } else {
      return null;
    }
  }
  if (Array.isArray(cursor)) return { parent: cursor, leaf: tokens.at(-1)! };
  if (cursor !== null && typeof cursor === 'object') {
    return { parent: cursor as StrictRecord, leaf: tokens.at(-1)! };
  }
  return null;
}

function protectedProjection(value: unknown, pointers: string[], baseline: boolean): unknown {
  const root = structuredClone(value);
  for (const pointer of pointers) {
    const { tokens } = parseJsonPointer(pointer);
    const resolved = resolvePointerParent(root, tokens);
    if (!resolved) {
      if (baseline) invalid(`JSON pointer ancestor/parent 不存在：${pointer}`);
      continue;
    }
    const { parent, leaf } = resolved;
    if (Array.isArray(parent)) {
      if (!/^(0|[1-9]\d*)$/.test(leaf)) {
        if (baseline) invalid(`JSON pointer array index 非法：${pointer}`);
        continue;
      }
      const index = Number(leaf);
      if (index >= parent.length || !Object.hasOwn(parent, index)) {
        if (baseline) invalid(`JSON pointer array index 必须已存在：${pointer}`);
        continue;
      }
      parent[index] = MUTABLE_SENTINEL;
      continue;
    }
    Object.defineProperty(parent, leaf, {
      value: MUTABLE_SENTINEL,
      enumerable: true,
      configurable: true,
      writable: true,
    });
  }
  return root;
}

export function projectionDigest(
  bytes: Buffer,
  rule: DelegationRule | undefined,
  path: string,
  baseline: boolean,
): string | undefined {
  if (rule?.semantics !== 'json-mutable-pointers') return undefined;
  const parsed = parseStrictJson(bytes, path);
  return digestBytes(
    canonicalJson(protectedProjection(parsed, rule.mutableJsonPointers!, baseline)),
  );
}
