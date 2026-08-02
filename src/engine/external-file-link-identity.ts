import { createHash } from 'node:crypto';
import { performance } from 'node:perf_hooks';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import {
  inlineCommonJsArguments,
  InlineProgramTransportError,
} from '../workspace-safety/inline-program.js';
import type { SupervisorTerminationReason } from '../workspace-safety/supervisor-protocol.js';
import { readDarwinMountTable } from '../workspace-safety/darwin-mount-table-transport.js';

export interface ExternalFileStatIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
  readonly mode: bigint;
  readonly size: bigint;
  readonly mtimeNs: bigint;
  readonly ctimeNs: bigint;
}

export interface ExternalFileLinkIdentity {
  readonly resolvedPath: string;
  readonly link: ExternalFileStatIdentity;
  readonly linkTargetDigest: string;
  readonly target: ExternalFileStatIdentity;
  readonly targetDigest: string;
}

export interface ExternalFileLinkSnapshotLimits {
  readonly maxLinks: number;
  readonly maxUniqueTargetBytes: number;
  readonly deadlineMs: number;
}

export class ExternalFileLinkSnapshotBudgetError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ExternalFileLinkSnapshotBudgetError';
  }
}

const LINUX_MAGIC_OR_REMOTE_FILE_SYSTEMS = new Set<bigint>([
  0x9fa0n, // procfs
  0x62656572n, // sysfs
  0x1cd1n, // devpts
  0x27e0ebn, // cgroup v1
  0x63677270n, // cgroup v2
  0x73636673n, // securityfs
  0x64626720n, // debugfs
  0x74726163n, // tracefs
  0xcafe4a11n, // bpf
  0x62656570n, // configfs
  0x19800202n, // mqueue
  0x42494e4dn, // binfmt_misc
  0x6165676cn, // pstore
  0xde5e81e4n, // efivarfs
  0x6e736673n, // namespace handles
  0x65735546n, // FUSE
  0x6969n, // NFS
  0xff534d42n, // CIFS/SMB
  0x01021997n, // 9P
  0x5346414fn, // AFS
  0x73757245n, // CODA
  0x00c36400n, // Ceph
  0x564cn, // NCP
]);

const DARWIN_ORDINARY_LOCAL_FILE_SYSTEMS = new Set([
  'apfs',
  'cd9660',
  'exfat',
  'hfs',
  'msdos',
  'tmpfs',
  'udf',
]);

/** @internal 导出给平台 magic 回归测试；Darwin 数字类型一律不能作为放行依据。 */
export function isExternalFileSystemMagicOrRemote(
  platform: NodeJS.Platform,
  type: bigint,
): boolean {
  if (platform === 'linux') return LINUX_MAGIC_OR_REMOTE_FILE_SYSTEMS.has(type);
  if (platform === 'darwin') return true;
  return false;
}

function digestDarwinMountTable(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/**
 * 一次拓扑核对共用一个预算。重复链接到同一个稳定目标只计一次字节，但每条链接
 * 都计数量；每个受管 helper 只获得同一个绝对期限的剩余时间。
 */
export class ExternalFileLinkSnapshotBudget {
  readonly #deadline: number;
  readonly #targets = new Set<string>();
  #darwinMountTableDigest: string | undefined;
  #links = 0;
  #uniqueTargetBytes = 0;

  constructor(
    private readonly limits: ExternalFileLinkSnapshotLimits,
    private readonly signal?: AbortSignal,
    now: () => number = () => performance.now(),
  ) {
    this.now = now;
    this.#deadline = now() + limits.deadlineMs;
  }

  private readonly now: () => number;

  checkpoint(): void {
    if (this.signal?.aborted) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对被中断');
    }
    if (this.now() >= this.#deadline) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对超过统一期限');
    }
  }

  /** 把所有目标内容读取绑定到同一个绝对期限，而不是为每个文件重新获得 30 秒。 */
  remainingMs(): number {
    this.checkpoint();
    const remaining = Math.floor(this.#deadline - this.now());
    if (remaining < 1) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对超过统一期限');
    }
    return remaining;
  }

  countLink(): void {
    this.checkpoint();
    this.#links += 1;
    if (this.#links > this.limits.maxLinks) {
      throw new ExternalFileLinkSnapshotBudgetError(
        `外部普通文件链接超过 ${this.limits.maxLinks} 条`,
      );
    }
  }

  reserveTarget(identity: string, bytes: number): boolean {
    this.checkpoint();
    if (this.#targets.has(identity)) return false;
    if (bytes < 0 || !Number.isSafeInteger(bytes)) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接目标大小非法');
    }
    if (this.#uniqueTargetBytes + bytes > this.limits.maxUniqueTargetBytes) {
      throw new ExternalFileLinkSnapshotBudgetError(
        `外部普通文件链接唯一目标累计超过 ${this.limits.maxUniqueTargetBytes} bytes`,
      );
    }
    this.#targets.add(identity);
    this.#uniqueTargetBytes += bytes;
    return true;
  }

  darwinMountTableDigest(): string | null {
    if (process.platform !== 'darwin') return null;
    this.checkpoint();
    try {
      this.#darwinMountTableDigest ??= digestDarwinMountTable(readDarwinMountTable());
    } catch (error) {
      throw new ExternalFileLinkSnapshotBudgetError(
        `macOS mount 表无法建立稳定快照：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    this.checkpoint();
    return this.#darwinMountTableDigest;
  }

  assertDarwinMountTableCurrent(): void {
    if (process.platform !== 'darwin' || this.#darwinMountTableDigest === undefined) return;
    this.checkpoint();
    let current: string;
    try {
      current = digestDarwinMountTable(readDarwinMountTable());
    } catch (error) {
      throw new ExternalFileLinkSnapshotBudgetError(
        `macOS mount 表无法复核：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (current !== this.#darwinMountTableDigest) {
      throw new ExternalFileLinkSnapshotBudgetError('macOS mount 表在外部链接核对期间发生变化');
    }
    this.checkpoint();
  }
}

export type ManagedExternalFileLinkSnapshot =
  | {
      readonly scope: 'internal';
      readonly resolvedPath: string;
    }
  | {
      readonly scope: 'source';
      readonly resolvedPath: string;
    }
  | {
      readonly scope: 'external';
      readonly identity: ExternalFileLinkIdentity;
    };

export interface ManagedExternalFileLinkSnapshotOptions {
  readonly linkPath: string;
  readonly checkoutRoot: string;
  readonly sourceRoot: string;
  readonly maxFileBytes: number;
  readonly budget: ExternalFileLinkSnapshotBudget;
  readonly session: WorkspaceSession;
  readonly kind: 'quality-check' | 'tdd-check' | 'final-review';
  readonly cwd: string;
  readonly termination?: {
    readonly signal: AbortSignal;
    readonly reason: Exclude<SupervisorTerminationReason, 'timeout'>;
  };
  /** @internal 仅用于证明阻塞 reader 受统一期限约束；生产调用不得提供。 */
  readonly readerProgramForTests?: string;
}

const EXTERNAL_FILE_LINK_READER = String.raw`
'use strict';
const crypto = require('node:crypto');
const childProcess = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const linuxRejected = new Set([${[...LINUX_MAGIC_OR_REMOTE_FILE_SYSTEMS]
  .map((value) => `0x${value.toString(16)}n`)
  .join(',')}]);
const darwinOrdinaryLocal = new Set([${[...DARWIN_ORDINARY_LOCAL_FILE_SYSTEMS]
  .map((value) => JSON.stringify(value))
  .join(',')}]);
const darwinMountExecutable = '/sbin/mount';
const maxDarwinMountTableBytes = 4 * 1024 * 1024;
const maxDarwinMountEntries = 65536;
const maxDarwinMountPathChars = 32767;
function fail(message) {
  throw new Error(message);
}

function identity(info) {
  return {
    dev: info.dev.toString(),
    ino: info.ino.toString(),
    uid: info.uid.toString(),
    mode: info.mode.toString(),
    size: info.size.toString(),
    mtimeNs: info.mtimeNs.toString(),
    ctimeNs: info.ctimeNs.toString(),
  };
}

function same(left, right) {
  const observed = identity(right);
  return Object.keys(left).every((key) => left[key] === observed[key]);
}

function pathInside(parent, candidate) {
  const value = path.relative(path.resolve(parent), path.resolve(candidate));
  return value === '' || (
    !value.startsWith('..' + path.sep) && value !== '..' && !path.isAbsolute(value)
  );
}

function decodedLinkTarget(target) {
  const bytes = fs.readlinkSync(target, { encoding: 'buffer' });
  const text = bytes.toString('utf8');
  if (text.includes('\0') || !Buffer.from(text, 'utf8').equals(bytes)) {
    fail('external link target is not valid UTF-8');
  }
  return { bytes, text };
}

function readDarwinMountTableBytes() {
  const executable = fs.realpathSync.native(darwinMountExecutable);
  const info = fs.lstatSync(executable, { bigint: true });
  if (
    !info.isFile() || info.isSymbolicLink() || info.nlink !== 1n || info.uid !== 0n ||
    (info.mode & 0o22n) !== 0n
  ) fail('fixed macOS mount executable identity is not trusted');
  return childProcess.execFileSync(executable, [], {
    encoding: 'buffer',
    env: { LANG: 'C', LC_ALL: 'C', PATH: '/usr/bin:/bin:/usr/sbin:/sbin' },
    maxBuffer: maxDarwinMountTableBytes,
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 4000,
    windowsHide: true,
  });
}

function parseDarwinMountTable(bytes) {
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) fail('macOS mount table is not valid UTF-8');
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.length > maxDarwinMountEntries) {
    fail('macOS mount table entry count is invalid');
  }
  const entries = lines.map((line) => {
    const optionsAt = line.lastIndexOf(' (');
    const delimiter = line.indexOf(' on ');
    if (
      optionsAt < 0 || !line.endsWith(')') || delimiter <= 0 ||
      delimiter !== line.lastIndexOf(' on ') || delimiter + 4 >= optionsAt
    ) fail('macOS mount table line is ambiguous');
    const mountPath = line.slice(delimiter + 4, optionsAt);
    if (
      mountPath.length === 0 || mountPath.length > maxDarwinMountPathChars ||
      mountPath.includes('\0') || !path.posix.isAbsolute(mountPath)
    ) fail('macOS mount table path is invalid');
    const fields = line.slice(optionsAt + 2, -1).split(', ');
    if (fields.length === 0 || fields.some((field) => field.length === 0)) {
      fail('macOS mount table options are invalid');
    }
    const type = fields[0].toLowerCase();
    const options = new Set(fields.slice(1));
    return {
      path: path.posix.normalize(mountPath),
      safe: options.has('local') && !options.has('fskit') && darwinOrdinaryLocal.has(type),
    };
  });
  const uniquePaths = new Set(entries.map((entry) => entry.path));
  if (uniquePaths.size !== entries.length) fail('macOS mount table has duplicate mount paths');
  for (const entry of entries) {
    if (entry.safe) entry.runtimeType = fs.statfsSync(entry.path, { bigint: true }).type;
  }
  return entries;
}

function assertSupportedFileSystem(current, darwinMounts) {
  if (process.platform === 'linux') {
    const type = fs.statfsSync(current, { bigint: true }).type;
    if (linuxRejected.has(type)) {
      fail('external link crosses a magic, virtual or remote filesystem: ' + current);
    }
    return;
  }
  if (process.platform === 'darwin') {
    let selected;
    for (const mount of darwinMounts) {
      if (!pathInside(mount.path, current)) continue;
      if (selected === undefined || mount.path.length > selected.path.length) selected = mount;
    }
    if (
      selected === undefined || !selected.safe || selected.runtimeType === undefined ||
      fs.statfsSync(current, { bigint: true }).type !== selected.runtimeType
    ) {
      fail('external link crosses a magic, virtual or remote filesystem: ' + current);
    }
    return;
  }
  fail('external link filesystem classification is unsupported');
}

function resolveWithoutMagicLinks(original, darwinMounts) {
  const first = decodedLinkTarget(original).text;
  let pendingPath = path.isAbsolute(first)
    ? path.resolve(first)
    : path.resolve(path.dirname(original), first);
  let linkDepth = 1;
  while (true) {
    const parsed = path.parse(pendingPath);
    const components = path.relative(parsed.root, pendingPath).split(path.sep).filter(Boolean);
    let current = parsed.root;
    let restarted = false;
    for (let index = 0; index < components.length; index += 1) {
      current = path.join(current, components[index]);
      assertSupportedFileSystem(current, darwinMounts);
      const info = fs.lstatSync(current, { bigint: true });
      if (!info.isSymbolicLink()) continue;
      linkDepth += 1;
      if (linkDepth > 64) fail('external link resolution exceeds 64 symbolic links');
      const target = decodedLinkTarget(current).text;
      pendingPath = path.resolve(
        path.isAbsolute(target) ? target : path.resolve(path.dirname(current), target),
        ...components.slice(index + 1),
      );
      restarted = true;
      break;
    }
    if (restarted) continue;
    const canonical = fs.realpathSync.native(original);
    if (path.resolve(canonical) !== path.resolve(current)) {
      fail('external link changed while resolving');
    }
    return canonical;
  }
}

let descriptor;
try {
  snapshot: {
  const request = JSON.parse(Buffer.from(process.argv[1], 'base64url').toString('utf8'));
  if (
    request.darwinMountTableDigest !== null &&
    (typeof request.darwinMountTableDigest !== 'string' || !/^[0-9a-f]{64}$/.test(request.darwinMountTableDigest))
  ) fail('trusted macOS mount table digest is invalid');
  let darwinMounts = [];
  let assertDarwinMountTableCurrent = () => {};
  if (process.platform === 'darwin') {
    if (request.darwinMountTableDigest === null) fail('trusted macOS mount table is unavailable');
    const expectedDigest = request.darwinMountTableDigest;
    const readCurrent = () => {
      const bytes = readDarwinMountTableBytes();
      const digest = crypto.createHash('sha256').update(bytes).digest('hex');
      if (digest !== expectedDigest) fail('macOS mount table changed during external link review');
      return bytes;
    };
    darwinMounts = parseDarwinMountTable(readCurrent());
    assertDarwinMountTableCurrent = () => { readCurrent(); };
  }
  const linkBefore = fs.lstatSync(request.linkPath, { bigint: true });
  if (!linkBefore.isSymbolicLink()) fail('external link identity changed before resolution');
  const linkTargetBefore = decodedLinkTarget(request.linkPath).bytes;
  const resolvedPath = resolveWithoutMagicLinks(request.linkPath, darwinMounts);
  const scope = pathInside(request.checkoutRoot, resolvedPath)
    ? 'internal'
    : pathInside(request.sourceRoot, resolvedPath)
      ? 'source'
      : 'external';

  if (scope !== 'external') {
    const linkAfter = fs.lstatSync(request.linkPath, { bigint: true });
    const linkTargetAfter = decodedLinkTarget(request.linkPath).bytes;
    if (
      !same(identity(linkBefore), linkAfter) ||
      !linkTargetBefore.equals(linkTargetAfter) ||
      resolveWithoutMagicLinks(request.linkPath, darwinMounts) !== resolvedPath
    ) fail('link changed while classifying');
    assertDarwinMountTableCurrent();
    process.stdout.write(JSON.stringify({ schemaVersion: 1, scope, resolvedPath }));
    break snapshot;
  }

  const targetBefore = fs.lstatSync(resolvedPath, { bigint: true });
  const expectedSize = Number(targetBefore.size);
  if (
    !targetBefore.isFile() || targetBefore.isSymbolicLink() ||
    !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > request.maxFileBytes
  ) {
    fail('external link target is not a bounded ordinary file');
  }
  descriptor = fs.openSync(resolvedPath, fs.constants.O_RDONLY | fs.constants.O_NOFOLLOW);
  const openedBefore = fs.fstatSync(descriptor, { bigint: true });
  if (!openedBefore.isFile() || !same(identity(targetBefore), openedBefore)) {
    fail('external file descriptor identity does not match the path');
  }

  const digest = crypto.createHash('sha256');
  const chunk = Buffer.allocUnsafe(1024 * 1024);
  let offset = 0;
  while (offset < expectedSize) {
    const count = fs.readSync(
      descriptor,
      chunk,
      0,
      Math.min(chunk.byteLength, expectedSize - offset),
      offset,
    );
    if (count <= 0) fail('external file ended before its declared size');
    digest.update(chunk.subarray(0, count));
    offset += count;
  }

  // st_size 为 0 的 procfs 等动态文件会在这里暴露；只读声明字节数而不验证 EOF
  // 会把未读取的动态内容错误地冻结成空文件。
  const trailing = Buffer.allocUnsafe(1);
  if (fs.readSync(descriptor, trailing, 0, 1, expectedSize) !== 0) {
    fail('external file has bytes beyond its declared size');
  }

  const openedAfter = fs.fstatSync(descriptor, { bigint: true });
  const targetAfter = fs.lstatSync(resolvedPath, { bigint: true });
  const linkAfter = fs.lstatSync(request.linkPath, { bigint: true });
  const linkTargetAfter = decodedLinkTarget(request.linkPath).bytes;
  if (
    !same(identity(targetBefore), openedAfter) ||
    !same(identity(targetBefore), targetAfter) ||
    !same(identity(linkBefore), linkAfter) ||
    !linkTargetBefore.equals(linkTargetAfter) ||
    resolveWithoutMagicLinks(request.linkPath, darwinMounts) !== resolvedPath
  ) {
    fail('external file identity changed while reading');
  }
  assertDarwinMountTableCurrent();
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    scope: 'external',
    resolvedPath,
    link: identity(linkBefore),
    linkTargetDigest: crypto.createHash('sha256').update(linkTargetBefore).digest('hex'),
    target: identity(targetBefore),
    bytesRead: offset,
    eof: true,
    targetDigest: digest.digest('hex'),
  }));
  }
} catch (error) {
  process.stderr.write(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  if (descriptor !== undefined) fs.closeSync(descriptor);
}
`;

function parsedStatIdentity(value: unknown): ExternalFileStatIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const fields = ['dev', 'ino', 'uid', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const;
  if (!fields.every((field) => typeof record[field] === 'string' && /^\d+$/u.test(record[field]))) {
    return null;
  }
  return {
    dev: BigInt(record.dev as string),
    ino: BigInt(record.ino as string),
    uid: BigInt(record.uid as string),
    mode: BigInt(record.mode as string),
    size: BigInt(record.size as string),
    mtimeNs: BigInt(record.mtimeNs as string),
    ctimeNs: BigInt(record.ctimeNs as string),
  };
}

function parseExternalFileLinkSnapshot(bytes: Buffer): ManagedExternalFileLinkSnapshot {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对结果无法解析');
  }
  if (!value || typeof value !== 'object') {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对结果形状非法');
  }
  const record = value as Record<string, unknown>;
  if (record.schemaVersion !== 1 || typeof record.resolvedPath !== 'string') {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对结果缺少身份');
  }
  if (record.scope === 'internal' || record.scope === 'source') {
    return { scope: record.scope, resolvedPath: record.resolvedPath };
  }
  const link = parsedStatIdentity(record.link);
  const target = parsedStatIdentity(record.target);
  if (
    record.scope !== 'external' ||
    !link ||
    !target ||
    record.bytesRead !== Number(target.size) ||
    record.eof !== true ||
    typeof record.linkTargetDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record.linkTargetDigest) ||
    typeof record.targetDigest !== 'string' ||
    !/^[0-9a-f]{64}$/u.test(record.targetDigest)
  ) {
    throw new ExternalFileLinkSnapshotBudgetError(
      '外部普通文件链接核对结果未证明身份、精确大小和 EOF',
    );
  }
  return {
    scope: 'external',
    identity: {
      resolvedPath: record.resolvedPath,
      link,
      linkTargetDigest: record.linkTargetDigest,
      target,
      targetDigest: record.targetDigest,
    },
  };
}

/**
 * 外部目标的链接链解析、magic 检查、身份、内容、EOF 与复核全部在固定受管子进程中
 * 完成。主进程只消费结构化快照；supervisor 无法收口时沿既有协议隔离 workspace。
 */
export async function snapshotManagedExternalFileLink(
  options: ManagedExternalFileLinkSnapshotOptions,
): Promise<ManagedExternalFileLinkSnapshot> {
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 0) {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接单文件上限非法');
  }
  const request = Buffer.from(
    JSON.stringify({
      linkPath: options.linkPath,
      checkoutRoot: options.checkoutRoot,
      sourceRoot: options.sourceRoot,
      maxFileBytes: options.maxFileBytes,
      darwinMountTableDigest: options.budget.darwinMountTableDigest(),
    }),
    'utf8',
  ).toString('base64url');
  const readerProgram = options.readerProgramForTests ?? EXTERNAL_FILE_LINK_READER;
  let args: string[];
  try {
    args = inlineCommonJsArguments(readerProgram, request);
  } catch (error) {
    if (error instanceof InlineProgramTransportError) {
      throw new ExternalFileLinkSnapshotBudgetError(
        `外部普通文件链接 reader 无法固定传输：${error.message}`,
      );
    }
    throw error;
  }
  const result = await runManagedWorkspaceProcess(options.session, {
    kind: options.kind,
    delegation: 'read-only-v1',
    executable: process.execPath,
    // 固定 reader 从当前受信任进程内存分块传输，避免先检查脚本路径、再由 Node 重新打开的竞态。
    args,
    cwd: options.cwd,
    environment: [],
    timeoutMs: options.budget.remainingMs(),
    ...(options.termination ? { termination: options.termination } : {}),
  });
  options.budget.checkpoint();
  if (
    result.verdict !== 'completed' ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.processTreeNotEmpty
  ) {
    const diagnostic = Buffer.concat([result.stdout, result.stderr]).toString('utf8').slice(-500);
    throw new ExternalFileLinkSnapshotBudgetError(
      result.timedOut
        ? '外部普通文件链接核对超过统一期限'
        : `外部普通文件链接核对失败${diagnostic ? `：${diagnostic}` : ''}`,
    );
  }
  return parseExternalFileLinkSnapshot(result.stdout);
}

export function externalFileTargetIdentityKey(
  resolvedPath: string,
  identity: ExternalFileStatIdentity,
): string {
  return [
    resolvedPath,
    identity.dev,
    identity.ino,
    identity.uid,
    identity.mode,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join('\0');
}

/** Windows reparse point 的目标绑定语义尚未完成真实平台验证，因此暂时拒绝。 */
export function canSnapshotExternalFileLinks(platform: NodeJS.Platform): boolean {
  return platform !== 'win32';
}

function sameExternalFileStatIdentity(
  left: ExternalFileStatIdentity,
  right: ExternalFileStatIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.mode === right.mode &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs &&
    left.ctimeNs === right.ctimeNs
  );
}

export function sameExternalFileLinkIdentity(
  left: ExternalFileLinkIdentity,
  right: ExternalFileLinkIdentity,
): boolean {
  return (
    left.resolvedPath === right.resolvedPath &&
    sameExternalFileStatIdentity(left.link, right.link) &&
    left.linkTargetDigest === right.linkTargetDigest &&
    sameExternalFileStatIdentity(left.target, right.target) &&
    left.targetDigest === right.targetDigest
  );
}
