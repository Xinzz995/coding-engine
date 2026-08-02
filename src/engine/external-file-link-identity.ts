import { performance } from 'node:perf_hooks';
import { lstatSync, readFileSync } from 'node:fs';
import type { WorkspaceSession } from '../workspace-safety/session.js';
import { runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import type { SupervisorTerminationReason } from '../workspace-safety/supervisor-protocol.js';

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

// Darwin 的 statfs.type 使用系统 mount type。只拒绝已知动态、magic 或远程语义，
// APFS/HFS、tmpfs 及其他本地卷不需要与验证检出位于同一设备。
const DARWIN_MAGIC_OR_REMOTE_FILE_SYSTEMS = new Set<bigint>([
  2n, // NFS
  7n, // fdesc
  11n, // kernfs
  12n, // procfs
  13n, // AFS
  19n, // devfs
  20n, // WebDAV
  22n, // AFP
  24n, // CIFS
  25n, // FUSE/other network providers
]);

/** @internal 导出给平台 magic 回归测试；未知类型不靠猜测拒绝。 */
export function isExternalFileSystemMagicOrRemote(
  platform: NodeJS.Platform,
  type: bigint,
): boolean {
  if (platform === 'linux') return LINUX_MAGIC_OR_REMOTE_FILE_SYSTEMS.has(type);
  if (platform === 'darwin') return DARWIN_MAGIC_OR_REMOTE_FILE_SYSTEMS.has(type);
  return false;
}

/**
 * 一次拓扑核对共用一个预算。重复链接到同一个稳定目标只计一次字节，但每条链接
 * 都计数量；每个受管 helper 只获得同一个绝对期限的剩余时间。
 */
export class ExternalFileLinkSnapshotBudget {
  readonly #deadline: number;
  readonly #targets = new Set<string>();
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
  readonly readerPath?: string;
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
const fs = require('node:fs');
const path = require('node:path');

const linuxRejected = new Set([${[...LINUX_MAGIC_OR_REMOTE_FILE_SYSTEMS]
  .map((value) => `0x${value.toString(16)}n`)
  .join(',')}]);
const darwinRejected = new Set([${[...DARWIN_MAGIC_OR_REMOTE_FILE_SYSTEMS]
  .map((value) => `${value.toString()}n`)
  .join(',')}]);

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

function rejectedFileSystem(type) {
  if (process.platform === 'linux') return linuxRejected.has(type);
  if (process.platform === 'darwin') return darwinRejected.has(type);
  return true;
}

function resolveWithoutMagicLinks(original) {
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
      const fileSystemType = fs.statfsSync(current, { bigint: true }).type;
      if (rejectedFileSystem(fileSystemType)) {
        fail('external link crosses a magic, virtual or remote filesystem: ' + current);
      }
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
  const request = JSON.parse(Buffer.from(process.argv[2], 'base64url').toString('utf8'));
  const linkBefore = fs.lstatSync(request.linkPath, { bigint: true });
  if (!linkBefore.isSymbolicLink()) fail('external link identity changed before resolution');
  const linkTargetBefore = decodedLinkTarget(request.linkPath).bytes;
  const resolvedPath = resolveWithoutMagicLinks(request.linkPath);
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
      resolveWithoutMagicLinks(request.linkPath) !== resolvedPath
    ) fail('link changed while classifying');
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
    resolveWithoutMagicLinks(request.linkPath) !== resolvedPath
  ) {
    fail('external file identity changed while reading');
  }
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

export function externalFileLinkReaderBytes(): Buffer {
  return Buffer.from(EXTERNAL_FILE_LINK_READER, 'utf8');
}

function assertFixedExternalFileLinkReader(path: string): void {
  const info = lstatSync(path, { bigint: true });
  if (
    !info.isFile() ||
    info.isSymbolicLink() ||
    info.nlink !== 1n ||
    (info.mode & 0o22n) !== 0n ||
    !readFileSync(path).equals(externalFileLinkReaderBytes())
  ) {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接固定 reader 身份无效');
  }
}

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
    }),
    'utf8',
  ).toString('base64url');
  if (!options.readerProgramForTests) {
    if (!options.readerPath) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接缺少固定 reader');
    }
    assertFixedExternalFileLinkReader(options.readerPath);
  }
  const result = await runManagedWorkspaceProcess(options.session, {
    kind: options.kind,
    delegation: 'read-only-v1',
    executable: process.execPath,
    args: options.readerProgramForTests
      ? ['-e', options.readerProgramForTests, request]
      : [options.readerPath!, request],
    cwd: options.cwd,
    environment: [],
    timeoutMs: options.budget.remainingMs(),
    ...(options.termination ? { termination: options.termination } : {}),
  });
  if (!options.readerProgramForTests) assertFixedExternalFileLinkReader(options.readerPath!);
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
