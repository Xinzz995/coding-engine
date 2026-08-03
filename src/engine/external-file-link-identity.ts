import { createHash } from 'node:crypto';
import { isAbsolute, relative, resolve, sep } from 'node:path';
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
  readonly nlink: bigint;
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
  readonly maxTargetReadBytes: number;
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
const POSIX_FILE_TYPE_MASK = 0o170000n;
const POSIX_REGULAR_FILE = 0o100000n;
const POSIX_SYMBOLIC_LINK = 0o120000n;

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
 * 一次拓扑核对共用一个预算。每条链接都计数量；每个受管 reader 只获得同一个绝对期限
 * 和实际读取字节上限的剩余额度。同批稳定目标只读取一次，跨批重复目标保守地再次计费。
 */
export class ExternalFileLinkSnapshotBudget {
  readonly #deadline: number;
  readonly #targets = new Map<string, { readonly bytes: number; readonly digest?: string }>();
  #darwinMountTableDigest: string | undefined;
  #links = 0;
  #targetReadBytes = 0;
  #readerBatchActive = false;

  constructor(
    private readonly limits: ExternalFileLinkSnapshotLimits,
    private readonly signal?: AbortSignal,
    now: () => number = () => performance.now(),
  ) {
    if (
      !Number.isSafeInteger(limits.maxLinks) ||
      limits.maxLinks < 1 ||
      !Number.isSafeInteger(limits.maxTargetReadBytes) ||
      limits.maxTargetReadBytes < 0 ||
      !Number.isSafeInteger(limits.deadlineMs) ||
      limits.deadlineMs < 1
    ) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对预算配置非法');
    }
    this.now = now;
    this.#deadline = now() + limits.deadlineMs;
  }

  private readonly now: () => number;
  #poisoned = false;

  checkpoint(): void {
    if (this.#poisoned) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对预算已经失效');
    }
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

  maximumTargetReadBytes(): number {
    return this.limits.maxTargetReadBytes;
  }

  beginReaderBatch(): number {
    this.checkpoint();
    if (this.#readerBatchActive) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对预算不能并发使用');
    }
    this.#readerBatchActive = true;
    return this.limits.maxTargetReadBytes - this.#targetReadBytes;
  }

  finishReaderBatch(bytes: number): void {
    if (!this.#readerBatchActive) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对批次没有活动预算');
    }
    this.#readerBatchActive = false;
    if (!Number.isSafeInteger(bytes) || bytes < 0) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接实际读取大小非法');
    }
    if (this.#targetReadBytes + bytes > this.limits.maxTargetReadBytes) {
      throw new ExternalFileLinkSnapshotBudgetError(
        `外部普通文件链接实际读取累计超过 ${this.limits.maxTargetReadBytes} bytes`,
      );
    }
    this.#targetReadBytes += bytes;
    this.checkpoint();
  }

  poisonReaderBatch(): void {
    this.#readerBatchActive = false;
    this.#poisoned = true;
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
    return this.#reserveTarget(identity, bytes);
  }

  reserveTargetSnapshot(identity: string, bytes: number, digest: string): boolean {
    if (!/^[0-9a-f]{64}$/u.test(digest)) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接目标摘要非法');
    }
    return this.#reserveTarget(identity, bytes, digest);
  }

  #reserveTarget(identity: string, bytes: number, digest?: string): boolean {
    this.checkpoint();
    const previous = this.#targets.get(identity);
    if (previous !== undefined) {
      if (previous.bytes !== bytes) {
        throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接目标去重大小不一致');
      }
      if (digest !== undefined && previous.digest !== undefined && previous.digest !== digest) {
        throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接目标去重身份不一致');
      }
      if (digest !== undefined && previous.digest === undefined) {
        this.#targets.set(identity, { bytes, digest });
      }
      return false;
    }
    if (bytes < 0 || !Number.isSafeInteger(bytes)) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接目标大小非法');
    }
    this.#targets.set(identity, { bytes, ...(digest === undefined ? {} : { digest }) });
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

export type ManagedExternalFileLinkBatchSnapshotOptions = Omit<
  ManagedExternalFileLinkSnapshotOptions,
  'linkPath'
> & {
  readonly linkPaths: readonly string[];
};

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
    nlink: info.nlink.toString(),
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

function pathTargetsGitControlDirectory(checkoutRoot, candidate) {
  if (!pathInside(checkoutRoot, candidate)) return false;
  const relativePath = path.relative(path.resolve(checkoutRoot), path.resolve(candidate));
  return relativePath.split(path.sep)[0]?.toLowerCase() === '.git';
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

function resolveWithoutMagicLinks(original, darwinMounts, checkoutRoot) {
  const first = decodedLinkTarget(original).text;
  let pendingPath = path.isAbsolute(first)
    ? path.resolve(first)
    : path.resolve(path.dirname(original), first);
  let leftCheckout = !pathInside(checkoutRoot, pendingPath);
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
      if (!pathInside(checkoutRoot, pendingPath)) leftCheckout = true;
      restarted = true;
      break;
    }
    if (restarted) continue;
    const canonical = fs.realpathSync.native(original);
    if (path.resolve(canonical) !== path.resolve(current)) {
      fail('external link changed while resolving');
    }
    return { canonical, leftCheckout };
  }
}

function assertLinkProof(linkPath, proof, darwinMounts, checkoutRoot) {
  const link = fs.lstatSync(linkPath, { bigint: true });
  const linkTarget = decodedLinkTarget(linkPath).bytes;
  const resolution = resolveWithoutMagicLinks(linkPath, darwinMounts, checkoutRoot);
  const resolvedPath = resolution.canonical;
  const target = fs.lstatSync(resolvedPath, { bigint: true });
  if (
    !link.isSymbolicLink() || link.nlink !== 1n ||
    !same(proof.link, link) ||
    crypto.createHash('sha256').update(linkTarget).digest('hex') !== proof.linkTargetDigest ||
    resolvedPath !== proof.resolvedPath ||
    resolution.leftCheckout !== proof.leftCheckout ||
    !same(proof.target, target)
  ) fail('link identity changed before the batch completed');
}

function snapshotLink(request, linkPath, darwinMounts, batchTargetBudget) {
  let descriptor;
  try {
  const linkBefore = fs.lstatSync(linkPath, { bigint: true });
  if (!linkBefore.isSymbolicLink() || linkBefore.nlink !== 1n) {
    fail('external link is not a single-name symbolic link');
  }
  const linkTargetBefore = decodedLinkTarget(linkPath).bytes;
  const resolution = resolveWithoutMagicLinks(linkPath, darwinMounts, request.checkoutRoot);
  const resolvedPath = resolution.canonical;
  const scope = pathInside(request.checkoutRoot, resolvedPath)
    ? 'internal'
    : pathInside(request.sourceRoot, resolvedPath)
      ? 'source'
      : 'external';

  if (scope === 'internal' && pathTargetsGitControlDirectory(request.checkoutRoot, resolvedPath)) {
    fail('link resolves into Git control directory');
  }
  if (scope === 'internal' && resolution.leftCheckout) {
    fail('internal link resolution left the validation checkout');
  }

  const targetBefore = fs.lstatSync(resolvedPath, { bigint: true });
  if (scope === 'internal' && targetBefore.isDirectory() && !targetBefore.isSymbolicLink()) {
    const proof = {
      resolvedPath,
      link: identity(linkBefore),
      linkTargetDigest: crypto.createHash('sha256').update(linkTargetBefore).digest('hex'),
      target: identity(targetBefore),
      leftCheckout: resolution.leftCheckout,
    };
    assertLinkProof(linkPath, proof, darwinMounts, request.checkoutRoot);
    return { result: { scope, resolvedPath }, proof };
  }
  const expectedSize = Number(targetBefore.size);
  if (
    !targetBefore.isFile() || targetBefore.isSymbolicLink() ||
    !Number.isSafeInteger(expectedSize) || expectedSize < 0 || expectedSize > request.maxFileBytes
  ) {
    fail('link target is not a bounded ordinary file');
  }
  const proof = {
    resolvedPath,
    link: identity(linkBefore),
    linkTargetDigest: crypto.createHash('sha256').update(linkTargetBefore).digest('hex'),
    target: identity(targetBefore),
    leftCheckout: resolution.leftCheckout,
  };

  if (scope !== 'external') {
    assertLinkProof(linkPath, proof, darwinMounts, request.checkoutRoot);
    return { result: { scope, resolvedPath }, proof };
  }

  const targetKey = [resolvedPath, ...Object.values(identity(targetBefore))].join('\0');
  const cachedDigest = batchTargetBudget.targets.get(targetKey);
  if (cachedDigest !== undefined) {
    assertLinkProof(linkPath, proof, darwinMounts, request.checkoutRoot);
    return {
      result: {
        scope: 'external',
        resolvedPath,
        link: proof.link,
        linkTargetDigest: proof.linkTargetDigest,
        target: proof.target,
        bytesRead: expectedSize,
        eof: true,
        targetDigest: cachedDigest,
      },
      proof,
    };
  }
  if (batchTargetBudget.bytes + expectedSize > request.maxTargetReadBytes) {
    fail('external link batch reads exceed the remaining shared byte limit');
  }
  batchTargetBudget.bytes += expectedSize;

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
  if (!same(identity(targetBefore), openedAfter)) {
    fail('external file identity changed while reading');
  }
  assertLinkProof(linkPath, proof, darwinMounts, request.checkoutRoot);
  const targetDigest = digest.digest('hex');
  batchTargetBudget.targets.set(targetKey, targetDigest);
  return {
    result: {
      scope: 'external',
      resolvedPath,
      link: proof.link,
      linkTargetDigest: proof.linkTargetDigest,
      target: proof.target,
      bytesRead: offset,
      eof: true,
      targetDigest,
    },
    proof,
  };
  } finally {
    if (descriptor !== undefined) fs.closeSync(descriptor);
  }
}

let requestDigest = null;
let failedIndex = null;
try {
  const rawRequest = process.argv[1];
  requestDigest = crypto.createHash('sha256').update(rawRequest).digest('hex');
  const request = JSON.parse(rawRequest);
  if (
    request.schemaVersion !== 2 ||
    !Array.isArray(request.links) || request.links.length < 1 || request.links.length > 1024 ||
    request.links.some((entry) => !entry || typeof entry !== 'object' || !Number.isSafeInteger(entry.index) || entry.index < 0 || typeof entry.relativePath !== 'string' || entry.relativePath.length < 1 || entry.relativePath.length > 32767 || path.isAbsolute(entry.relativePath) || entry.relativePath.includes('\0')) ||
    typeof request.checkoutRoot !== 'string' || !path.isAbsolute(request.checkoutRoot) ||
    typeof request.sourceRoot !== 'string' || !path.isAbsolute(request.sourceRoot) ||
    !Number.isSafeInteger(request.maxFileBytes) || request.maxFileBytes < 0 ||
    !Number.isSafeInteger(request.maxTargetReadBytes) || request.maxTargetReadBytes < 0
  ) fail('external link batch request is invalid');
  if (
    new Set(request.links.map((entry) => entry.index)).size !== request.links.length ||
    new Set(request.links.map((entry) => entry.relativePath)).size !== request.links.length
  ) fail('external link batch request contains duplicate entries');
  request.checkoutRoot = path.resolve(request.checkoutRoot);
  request.sourceRoot = path.resolve(request.sourceRoot);
  const linkPaths = request.links.map((entry) => path.resolve(request.checkoutRoot, entry.relativePath));
  if (linkPaths.some((value) => value === request.checkoutRoot || !pathInside(request.checkoutRoot, value))) {
    fail('external link batch path leaves checkout');
  }
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
  const batchTargetBudget = { targets: new Map(), bytes: 0 };
  const observations = linkPaths.map((linkPath, offset) => {
    failedIndex = request.links[offset].index;
    try {
      return snapshotLink(request, linkPath, darwinMounts, batchTargetBudget);
    } catch (error) {
      fail('link ' + failedIndex + ' failed: ' + (error instanceof Error ? error.message : String(error)));
    }
  });
  for (let offset = 0; offset < observations.length; offset += 1) {
    failedIndex = request.links[offset].index;
    assertLinkProof(
      linkPaths[offset],
      observations[offset].proof,
      darwinMounts,
      request.checkoutRoot,
    );
  }
  assertDarwinMountTableCurrent();
  failedIndex = null;
  const items = observations.map((observation, offset) => ({
    index: request.links[offset].index,
    ...observation.result,
  }));
  const response = JSON.stringify({ schemaVersion: 2, requestDigest, ok: true, items });
  if (Buffer.byteLength(response, 'utf8') > 16 * 1024 * 1024) {
    fail('external link batch response exceeds 16 MiB');
  }
  process.stdout.write(response);
} catch (error) {
  const diagnostic = (error instanceof Error ? error.message : String(error)).slice(-1000);
  process.stdout.write(JSON.stringify({
    schemaVersion: 2,
    requestDigest,
    ok: false,
    failedIndex,
    diagnostic,
  }));
  process.exitCode = 1;
}
`;

/** @internal 只供在生产 reader 上注入确定性竞态的回归测试。 */
export function externalFileLinkReaderProgramForTests(): string {
  return EXTERNAL_FILE_LINK_READER;
}

function parsedStatIdentity(value: unknown): ExternalFileStatIdentity | null {
  if (!value || typeof value !== 'object') return null;
  const record = value as Record<string, unknown>;
  const fields = ['dev', 'ino', 'uid', 'nlink', 'mode', 'size', 'mtimeNs', 'ctimeNs'] as const;
  if (
    Object.keys(record).length !== fields.length ||
    !fields.every(
      (field) =>
        typeof record[field] === 'string' &&
        record[field].length <= 32 &&
        /^(?:0|[1-9]\d*)$/u.test(record[field]),
    )
  ) {
    return null;
  }
  return {
    dev: BigInt(record.dev as string),
    ino: BigInt(record.ino as string),
    uid: BigInt(record.uid as string),
    nlink: BigInt(record.nlink as string),
    mode: BigInt(record.mode as string),
    size: BigInt(record.size as string),
    mtimeNs: BigInt(record.mtimeNs as string),
    ctimeNs: BigInt(record.ctimeNs as string),
  };
}

function hasOnlyKeys(record: Record<string, unknown>, keys: readonly string[]): boolean {
  const actual = Object.keys(record).sort();
  const expected = [...keys].sort();
  return actual.length === expected.length && actual.every((key, index) => key === expected[index]);
}

function lexicalPathInside(parent: string, candidate: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function parseExternalFileLinkSnapshotValue(
  value: unknown,
  options: {
    readonly expectedIndex: number;
    readonly checkoutRoot: string;
    readonly sourceRoot: string;
    readonly maxFileBytes: number;
  },
): ManagedExternalFileLinkSnapshot {
  if (!value || typeof value !== 'object') {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对结果形状非法');
  }
  const record = value as Record<string, unknown>;
  if (
    record.index !== options.expectedIndex ||
    typeof record.resolvedPath !== 'string' ||
    record.resolvedPath.length < 1 ||
    record.resolvedPath.length > 32_767 ||
    record.resolvedPath.includes('\0') ||
    !isAbsolute(record.resolvedPath)
  ) {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对结果缺少身份');
  }
  const insideCheckout = lexicalPathInside(options.checkoutRoot, record.resolvedPath);
  const insideSource = lexicalPathInside(options.sourceRoot, record.resolvedPath);
  if (record.scope === 'internal' || record.scope === 'source') {
    if (
      !hasOnlyKeys(record, ['index', 'scope', 'resolvedPath']) ||
      (record.scope === 'internal' ? !insideCheckout : insideCheckout || !insideSource)
    ) {
      throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接核对 scope 与路径不一致');
    }
    return { scope: record.scope, resolvedPath: record.resolvedPath };
  }
  const link = parsedStatIdentity(record.link);
  const target = parsedStatIdentity(record.target);
  if (
    record.scope !== 'external' ||
    !hasOnlyKeys(record, [
      'index',
      'scope',
      'resolvedPath',
      'link',
      'linkTargetDigest',
      'target',
      'bytesRead',
      'eof',
      'targetDigest',
    ]) ||
    insideCheckout ||
    insideSource ||
    !link ||
    !target ||
    link.nlink !== 1n ||
    (link.mode & POSIX_FILE_TYPE_MASK) !== POSIX_SYMBOLIC_LINK ||
    target.nlink < 1n ||
    (target.mode & POSIX_FILE_TYPE_MASK) !== POSIX_REGULAR_FILE ||
    target.size > BigInt(options.maxFileBytes) ||
    target.size > BigInt(Number.MAX_SAFE_INTEGER) ||
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

function parseExternalFileLinkBatchSnapshot(
  bytes: Buffer,
  options: {
    readonly requestDigest: string;
    readonly firstIndex: number;
    readonly count: number;
    readonly checkoutRoot: string;
    readonly sourceRoot: string;
    readonly maxFileBytes: number;
  },
): ManagedExternalFileLinkSnapshot[] {
  if (bytes.length < 1 || bytes.length > 16 * 1024 * 1024) {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接批量核对结果大小非法');
  }
  const text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接批量核对结果不是有效 UTF-8');
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接批量核对结果无法解析');
  }
  if (!value || typeof value !== 'object') {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接批量核对结果形状非法');
  }
  const record = value as Record<string, unknown>;
  if (
    !hasOnlyKeys(record, ['schemaVersion', 'requestDigest', 'ok', 'items']) ||
    record.schemaVersion !== 2 ||
    record.requestDigest !== options.requestDigest ||
    record.ok !== true ||
    !Array.isArray(record.items) ||
    record.items.length !== options.count
  ) {
    throw new ExternalFileLinkSnapshotBudgetError(
      '外部普通文件链接批量核对结果数量、版本或请求摘要非法',
    );
  }
  return record.items.map((item, offset) =>
    parseExternalFileLinkSnapshotValue(item, {
      expectedIndex: options.firstIndex + offset,
      checkoutRoot: options.checkoutRoot,
      sourceRoot: options.sourceRoot,
      maxFileBytes: options.maxFileBytes,
    }),
  );
}

/** @internal 只供批量协议的损坏结果回归；生产入口始终由受管 reader 调用私有解析器。 */
export function parseExternalFileLinkBatchSnapshotForTests(
  bytes: Uint8Array,
  options: {
    readonly requestDigest: string;
    readonly firstIndex: number;
    readonly count: number;
    readonly checkoutRoot: string;
    readonly sourceRoot: string;
    readonly maxFileBytes: number;
  },
): ManagedExternalFileLinkSnapshot[] {
  return parseExternalFileLinkBatchSnapshot(Buffer.from(bytes), options);
}

interface ManagedExternalFileLinkBatch {
  readonly links: readonly { readonly index: number; readonly relativePath: string }[];
  readonly firstIndex: number;
  readonly count: number;
}

function managedExternalFileLinkRequest(options: {
  readonly readerProgram: string;
  readonly links: readonly { readonly index: number; readonly relativePath: string }[];
  readonly checkoutRoot: string;
  readonly sourceRoot: string;
  readonly maxFileBytes: number;
  readonly maxTargetReadBytes: number;
  readonly darwinMountTableDigest: string | null;
}): { readonly args: string[]; readonly requestDigest: string } {
  const request = JSON.stringify({
    schemaVersion: 2,
    links: options.links,
    checkoutRoot: options.checkoutRoot,
    sourceRoot: options.sourceRoot,
    maxFileBytes: options.maxFileBytes,
    maxTargetReadBytes: options.maxTargetReadBytes,
    darwinMountTableDigest: options.darwinMountTableDigest,
  });
  return {
    args: inlineCommonJsArguments(options.readerProgram, request),
    requestDigest: createHash('sha256').update(request).digest('hex'),
  };
}

function managedLinkRelativePath(checkoutRoot: string, linkPath: string): string {
  const root = resolve(checkoutRoot);
  const link = resolve(linkPath);
  const value = relative(root, link);
  if (
    value === '' ||
    value === '..' ||
    value.startsWith(`..${sep}`) ||
    isAbsolute(value) ||
    value.includes('\0')
  ) {
    throw new ExternalFileLinkSnapshotBudgetError('受管普通文件链接路径不在验证检出内');
  }
  return value;
}

function managedExternalFileLinkBatches(options: {
  readonly readerProgram: string;
  readonly relativePaths: readonly string[];
  readonly checkoutRoot: string;
  readonly sourceRoot: string;
  readonly maxFileBytes: number;
  readonly maxTargetReadBytes: number;
  readonly darwinMountTableDigest: string | null;
}): ManagedExternalFileLinkBatch[] {
  const argsFor = (
    links: readonly { readonly index: number; readonly relativePath: string }[],
  ): { readonly args: string[]; readonly requestDigest: string } =>
    managedExternalFileLinkRequest({
      readerProgram: options.readerProgram,
      links,
      checkoutRoot: options.checkoutRoot,
      sourceRoot: options.sourceRoot,
      maxFileBytes: options.maxFileBytes,
      maxTargetReadBytes: options.maxTargetReadBytes,
      darwinMountTableDigest: options.darwinMountTableDigest,
    });
  const batches: ManagedExternalFileLinkBatch[] = [];
  let currentLinks: Array<{ readonly index: number; readonly relativePath: string }> = [];
  let current: { readonly args: string[]; readonly requestDigest: string } | undefined;
  for (let index = 0; index < options.relativePaths.length; index += 1) {
    const link = { index, relativePath: options.relativePaths[index] };
    try {
      current = argsFor([...currentLinks, link]);
      currentLinks.push(link);
    } catch (error) {
      if (!(error instanceof InlineProgramTransportError)) throw error;
      if (currentLinks.length === 0 || current === undefined) {
        throw new ExternalFileLinkSnapshotBudgetError(
          `外部普通文件链接 reader 无法固定传输：${error.message}`,
        );
      }
      batches.push({
        links: currentLinks,
        firstIndex: currentLinks[0].index,
        count: currentLinks.length,
      });
      currentLinks = [link];
      try {
        current = argsFor(currentLinks);
      } catch (singleError) {
        if (singleError instanceof InlineProgramTransportError) {
          throw new ExternalFileLinkSnapshotBudgetError(
            `外部普通文件链接 reader 无法固定传输：${singleError.message}`,
          );
        }
        throw singleError;
      }
    }
  }
  if (currentLinks.length > 0 && current !== undefined) {
    batches.push({
      links: currentLinks,
      firstIndex: currentLinks[0].index,
      count: currentLinks.length,
    });
  }
  return batches;
}

/**
 * 多条链接按真实 24k 命令行上限贪心分批；每批在同一个固定受管 reader 中依次解析，
 * 所有批次共享调用方的绝对期限。主进程只消费结构化快照，不读取链接目标。
 */
export async function snapshotManagedExternalFileLinks(
  options: ManagedExternalFileLinkBatchSnapshotOptions,
): Promise<ManagedExternalFileLinkSnapshot[]> {
  if (!canSnapshotExternalFileLinks(process.platform)) {
    throw new ExternalFileLinkSnapshotBudgetError(
      `当前平台 ${process.platform} 尚未完成普通文件链接可信绑定验证`,
    );
  }
  if (!Number.isSafeInteger(options.maxFileBytes) || options.maxFileBytes < 0) {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接单文件上限非法');
  }
  if (options.linkPaths.length < 1 || options.linkPaths.length > 1024) {
    throw new ExternalFileLinkSnapshotBudgetError('受管普通文件链接批量数量必须在 1 到 1024 之间');
  }
  const checkoutRoot = resolve(options.checkoutRoot);
  const sourceRoot = resolve(options.sourceRoot);
  const relativePaths = options.linkPaths.map((path) =>
    managedLinkRelativePath(checkoutRoot, path),
  );
  if (new Set(relativePaths).size !== relativePaths.length) {
    throw new ExternalFileLinkSnapshotBudgetError('受管普通文件链接批量路径重复');
  }
  for (const _path of relativePaths) options.budget.countLink();
  const readerProgram = options.readerProgramForTests ?? EXTERNAL_FILE_LINK_READER;
  const batches = managedExternalFileLinkBatches({
    readerProgram,
    relativePaths,
    checkoutRoot,
    sourceRoot,
    maxFileBytes: options.maxFileBytes,
    maxTargetReadBytes: options.budget.maximumTargetReadBytes(),
    darwinMountTableDigest: options.budget.darwinMountTableDigest(),
  });
  const snapshots: ManagedExternalFileLinkSnapshot[] = [];
  for (let index = 0; index < batches.length; index += 1) {
    const batch = batches[index];
    let budgetGranted = false;
    try {
      const maxTargetReadBytes = options.budget.beginReaderBatch();
      budgetGranted = true;
      const request = managedExternalFileLinkRequest({
        readerProgram,
        links: batch.links,
        checkoutRoot,
        sourceRoot,
        maxFileBytes: options.maxFileBytes,
        maxTargetReadBytes,
        darwinMountTableDigest: options.budget.darwinMountTableDigest(),
      });
      const result = await runManagedWorkspaceProcess(options.session, {
        kind: options.kind,
        delegation: 'read-only-v1',
        executable: process.execPath,
        // 固定 reader 从当前受信任进程内存分块传输，避免先检查脚本路径、再由 Node 重新打开的竞态。
        args: request.args,
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
        result.processTreeNotEmpty ||
        result.stderr.length !== 0
      ) {
        const diagnostic = Buffer.concat([result.stdout, result.stderr])
          .toString('utf8')
          .slice(-500);
        throw new ExternalFileLinkSnapshotBudgetError(
          result.timedOut
            ? '外部普通文件链接核对超过统一期限'
            : `外部普通文件链接批次 ${index + 1}/${batches.length} 核对失败${
                diagnostic ? `：${diagnostic}` : ''
              }`,
        );
      }
      const parsed = parseExternalFileLinkBatchSnapshot(result.stdout, {
        requestDigest: request.requestDigest,
        firstIndex: batch.firstIndex,
        count: batch.count,
        checkoutRoot,
        sourceRoot,
        maxFileBytes: options.maxFileBytes,
      });
      const batchTargets = new Map<string, number>();
      for (const snapshot of parsed) {
        if (snapshot.scope !== 'external') continue;
        const key = externalFileTargetIdentityKey(
          snapshot.identity.resolvedPath,
          snapshot.identity.target,
        );
        const bytes = Number(snapshot.identity.target.size);
        const previous = batchTargets.get(key);
        if (previous !== undefined && previous !== bytes) {
          throw new ExternalFileLinkSnapshotBudgetError(
            '外部普通文件链接批次目标大小不一致',
          );
        }
        batchTargets.set(key, bytes);
      }
      let batchReadBytes = 0;
      for (const bytes of batchTargets.values()) {
        if (!Number.isSafeInteger(batchReadBytes + bytes)) {
          throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接实际读取累计非法');
        }
        batchReadBytes += bytes;
      }
      options.budget.finishReaderBatch(batchReadBytes);
      for (const snapshot of parsed) {
        if (snapshot.scope !== 'external') continue;
        const key = externalFileTargetIdentityKey(
          snapshot.identity.resolvedPath,
          snapshot.identity.target,
        );
        options.budget.reserveTargetSnapshot(
          key,
          Number(snapshot.identity.target.size),
          snapshot.identity.targetDigest,
        );
      }
      snapshots.push(...parsed);
    } catch (error) {
      if (budgetGranted) options.budget.poisonReaderBatch();
      throw error;
    }
  }
  if (snapshots.length !== options.linkPaths.length) {
    throw new ExternalFileLinkSnapshotBudgetError('外部普通文件链接批量核对结果不完整');
  }
  return snapshots;
}

/** 单链接兼容入口复用同一批量协议，不再为拓扑中的每条链接分别启动受管操作。 */
export async function snapshotManagedExternalFileLink(
  options: ManagedExternalFileLinkSnapshotOptions,
): Promise<ManagedExternalFileLinkSnapshot> {
  const snapshots = await snapshotManagedExternalFileLinks({
    ...options,
    linkPaths: [options.linkPath],
  });
  return snapshots[0];
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
    identity.nlink,
    identity.mode,
    identity.size,
    identity.mtimeNs,
    identity.ctimeNs,
  ].join('\0');
}

/** Windows reparse point 的目标绑定语义尚未完成真实平台验证，因此暂时拒绝。 */
export function canSnapshotExternalFileLinks(platform: NodeJS.Platform): boolean {
  return platform === 'linux' || platform === 'darwin';
}

function sameExternalFileStatIdentity(
  left: ExternalFileStatIdentity,
  right: ExternalFileStatIdentity,
): boolean {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid &&
    left.nlink === right.nlink &&
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
