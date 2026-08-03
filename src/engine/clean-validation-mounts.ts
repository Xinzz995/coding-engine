import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  statfsSync,
} from 'node:fs';
import { isAbsolute, posix, relative, resolve, sep } from 'node:path';
import { readDarwinMountTable } from '../workspace-safety/darwin-mount-table-transport.js';
import { assertWindowsWorkspaceTreeHasNoReparsePoints } from '../workspace-safety/windows-path-attributes.js';

const MAX_MOUNT_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_MOUNT_ENTRIES = 65_536;
const MAX_MOUNT_PATH_CHARS = 32_767;

const DARWIN_ORDINARY_LOCAL_FILE_SYSTEMS = new Set([
  'apfs',
  'cd9660',
  'exfat',
  'hfs',
  'msdos',
  'tmpfs',
  'udf',
]);

const DARWIN_TRUSTED_HARD_LINK_FILE_SYSTEMS = new Set(['apfs', 'hfs']);
const LINUX_TRUSTED_HARD_LINK_FILE_SYSTEMS = new Set<bigint>([
  0xef53n, // ext2/ext3/ext4
  0x58465342n, // XFS
  0x9123683en, // Btrfs
  0x01021994n, // tmpfs
]);

/** @internal 只供窄文件系统正面列表回归。 */
export function isTrustedLinuxHardLinkFileSystemForTests(type: bigint): boolean {
  return LINUX_TRUSTED_HARD_LINK_FILE_SYSTEMS.has(type);
}

/** @internal 只供 macOS 硬链接文件系统类型回归；卷的 local/fskit 属性仍单独核对。 */
export function isTrustedDarwinHardLinkFileSystemForTests(type: string): boolean {
  return DARWIN_TRUSTED_HARD_LINK_FILE_SYSTEMS.has(type.toLowerCase());
}

/** @internal 只供根目录与挂载表运行时文件系统身份绑定回归。 */
export function isTrustedDarwinHardLinkBackingForTests(
  type: string,
  rootRuntimeType: bigint,
  selectedRuntimeType: bigint,
  trustedLocalMount: boolean,
): boolean {
  return (
    trustedLocalMount &&
    isTrustedDarwinHardLinkFileSystemForTests(type) &&
    rootRuntimeType === selectedRuntimeType
  );
}

interface DarwinMountEntry {
  readonly path: string;
  readonly type: string;
  readonly options: ReadonlySet<string>;
}

export interface CleanValidationBackingFileSystemProof {
  readonly identity: string;
  readonly hardLinksTrusted: boolean;
  readonly description: string;
}

export class CleanValidationMountProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanValidationMountProofError';
  }
}

function invalid(message: string): CleanValidationMountProofError {
  return new CleanValidationMountProofError(`无法证明验证临时目录没有挂载点：${message}`);
}

function assertSupportedMountPath(path: string, context: string): void {
  if (path.length === 0 || path.length > MAX_MOUNT_PATH_CHARS || path.includes('\0')) {
    throw invalid(`${context}包含非法路径`);
  }
}

function supportedPosixMountPath(path: string, context: string): string {
  assertSupportedMountPath(path, context);
  if (!posix.isAbsolute(path)) throw invalid(`${context}包含非法路径`);
  return posix.normalize(path);
}

function supportedNativeMountPath(path: string, context: string): string {
  assertSupportedMountPath(path, context);
  if (!isAbsolute(path)) throw invalid(`${context}包含非法路径`);
  return resolve(path);
}

function boundedRead(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const opened = fstatSync(descriptor, { bigint: true });
    if (!opened.isFile()) throw invalid('Linux mountinfo 不是普通内核文件');
    const chunks: Buffer[] = [];
    let total = 0;
    while (true) {
      const chunk = Buffer.allocUnsafe(64 * 1024);
      const count = readSync(descriptor, chunk, 0, chunk.byteLength, null);
      if (count === 0) break;
      total += count;
      if (total > MAX_MOUNT_TABLE_BYTES) throw invalid('Linux mountinfo 超过读取上限');
      chunks.push(chunk.subarray(0, count));
    }
    return Buffer.concat(chunks, total);
  } catch (error) {
    if (error instanceof CleanValidationMountProofError) throw error;
    throw invalid(
      `Linux mountinfo 无法读取：${error instanceof Error ? error.message : String(error)}`,
    );
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function decodeLinuxMountField(value: string): string {
  let decoded = '';
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (character !== '\\') {
      decoded += character;
      continue;
    }
    const escaped = value.slice(index + 1, index + 4);
    if (!/^[0-7]{3}$/u.test(escaped)) throw invalid('Linux mountinfo 含未知转义');
    const code = Number.parseInt(escaped, 8);
    if (code !== 0o40 && code !== 0o11 && code !== 0o12 && code !== 0o134) {
      throw invalid('Linux mountinfo 含非标准路径转义');
    }
    decoded += String.fromCodePoint(code);
    index += 3;
  }
  return decoded;
}

/** @internal 只供平台解析回归测试；生产入口是 assertCleanValidationTreeHasNoMountPoints。 */
export function parseLinuxMountInfoForTests(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw invalid('Linux mountinfo 不是有效 UTF-8');
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.length > MAX_MOUNT_ENTRIES) {
    throw invalid('Linux mountinfo 条目数不在支持范围内');
  }
  const entries = lines.map((line) => {
    const separator = line.indexOf(' - ');
    if (separator < 0 || separator !== line.lastIndexOf(' - ')) {
      throw invalid('Linux mountinfo 行无法唯一解析');
    }
    const fields = line.slice(0, separator).split(' ');
    if (fields.length < 6 || fields.some((field) => field.length === 0)) {
      throw invalid('Linux mountinfo 前置字段不完整');
    }
    return supportedPosixMountPath(decodeLinuxMountField(fields[4]), 'Linux mountinfo');
  });
  return entries;
}

/** @internal 只供平台解析回归测试；任何格式歧义都必须 fail-closed。 */
function parseDarwinMountEntries(bytes: Uint8Array): DarwinMountEntry[] {
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw invalid('macOS mount 输出不是有效 UTF-8');
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.length > MAX_MOUNT_ENTRIES) {
    throw invalid('macOS mount 条目数不在支持范围内');
  }
  const entries = lines.map((line) => {
    const options = line.lastIndexOf(' (');
    const delimiter = line.indexOf(' on ');
    if (
      options < 0 ||
      !line.endsWith(')') ||
      delimiter <= 0 ||
      delimiter !== line.lastIndexOf(' on ') ||
      delimiter + 4 >= options
    ) {
      throw invalid('macOS mount 行无法唯一解析');
    }
    const fields = line.slice(options + 2, -1).split(', ');
    if (fields.length === 0 || fields.some((field) => field.length === 0)) {
      throw invalid('macOS mount 选项不完整');
    }
    return {
      path: supportedPosixMountPath(line.slice(delimiter + 4, options), 'macOS mount'),
      type: fields[0],
      options: new Set(fields.slice(1)),
    };
  });
  const uniquePaths = new Set(entries.map((entry) => entry.path));
  if (uniquePaths.size !== entries.length) throw invalid('macOS mount 含重复挂载路径');
  return entries;
}

/** @internal 只供平台解析回归测试；任何格式歧义都必须 fail-closed。 */
export function parseDarwinMountOutputForTests(bytes: Uint8Array): string[] {
  return parseDarwinMountEntries(bytes).map((entry) => entry.path);
}

function isTrustedLocalDarwinMount(entry: DarwinMountEntry): boolean {
  const type = entry.type.toLowerCase();
  return (
    entry.options.has('local') &&
    !entry.options.has('fskit') &&
    DARWIN_ORDINARY_LOCAL_FILE_SYSTEMS.has(type)
  );
}

function selectedDarwinMount(
  entries: readonly DarwinMountEntry[],
  target: string,
): DarwinMountEntry | undefined {
  const candidate = supportedPosixMountPath(target, 'macOS 目标');
  let selected: DarwinMountEntry | undefined;
  for (const entry of entries) {
    const child = posix.relative(entry.path, candidate);
    if (child !== '' && (child === '..' || child.startsWith('../') || posix.isAbsolute(child))) {
      continue;
    }
    if (selected === undefined || entry.path.length > selected.path.length) selected = entry;
  }
  return selected;
}

/** @internal 只供证明本地卷筛选不依赖易变的 Darwin f_type 编号。 */
export function parseTrustedLocalDarwinMountPathsForTests(bytes: Uint8Array): string[] {
  return parseDarwinMountEntries(bytes)
    .filter(isTrustedLocalDarwinMount)
    .map((entry) => entry.path);
}

/** @internal 只供最长挂载点分类回归；未知或非普通本地卷一律拒绝。 */
export function isPathOnTrustedLocalDarwinMountForTests(
  bytes: Uint8Array,
  target: string,
): boolean {
  const selected = selectedDarwinMount(parseDarwinMountEntries(bytes), target);
  return selected !== undefined && isTrustedLocalDarwinMount(selected);
}

/** @internal 只供包含关系回归；root 自身被覆盖也属于必须拒绝的挂载点。 */
export function assertNoMountedPathsAtOrBelowForTests(
  root: string,
  mountedPaths: readonly string[],
): void {
  const canonicalRoot = resolve(root);
  for (const rawPath of mountedPaths) {
    const mountedPath = supportedNativeMountPath(rawPath, '挂载表');
    const child = relative(canonicalRoot, mountedPath);
    if (child === '' || (!child.startsWith(`..${sep}`) && child !== '..' && !isAbsolute(child))) {
      throw invalid(`临时目录内存在挂载点 ${child === '' ? '.' : child}`);
    }
  }
}

/**
 * 递归读取或删除干净检出前的跨文件系统证明。Linux 读取当前 mount namespace，macOS
 * 使用固定系统工具读取 getmntinfo 输出，Windows 则要求整棵树不存在 reparse point。
 * 任一平台无法完整证明时均抛错，不降级为普通目录遍历。
 */
export function assertCleanValidationTreeHasNoMountPoints(
  root: string,
): CleanValidationBackingFileSystemProof {
  try {
    const suppliedRoot = resolve(root);
    const suppliedRootInfo = lstatSync(suppliedRoot, { bigint: true });
    if (!suppliedRootInfo.isDirectory() || suppliedRootInfo.isSymbolicLink()) {
      throw invalid('传入的验证临时根最终分量不是普通目录');
    }
    const canonicalRoot = realpathSync.native(suppliedRoot);
    const canonicalRootInfo = lstatSync(canonicalRoot, { bigint: true });
    if (!canonicalRootInfo.isDirectory() || canonicalRootInfo.isSymbolicLink()) {
      throw invalid('验证临时根不是普通目录');
    }
    if (
      suppliedRootInfo.dev !== canonicalRootInfo.dev ||
      suppliedRootInfo.ino !== canonicalRootInfo.ino ||
      suppliedRootInfo.uid !== canonicalRootInfo.uid
    ) {
      throw invalid('传入的验证临时根与解析后的目录身份不一致');
    }
    const suppliedRootIdentity = [suppliedRootInfo.dev, suppliedRootInfo.ino, suppliedRootInfo.uid]
      .map((value) => value.toString())
      .join(':');
    const canonicalRootIdentity = [
      canonicalRootInfo.dev,
      canonicalRootInfo.ino,
      canonicalRootInfo.uid,
    ]
      .map((value) => value.toString())
      .join(':');
    const rootIdentity = `${suppliedRootIdentity}:${canonicalRoot}:${canonicalRootIdentity}`;
    if (process.platform === 'linux') {
      const mountPaths = parseLinuxMountInfoForTests(boundedRead(`/proc/${process.pid}/mountinfo`));
      assertNoMountedPathsAtOrBelowForTests(canonicalRoot, mountPaths);
      const type = statfsSync(canonicalRoot, { bigint: true }).type;
      return {
        identity: `linux:${rootIdentity}:${type.toString(16)}`,
        hardLinksTrusted: isTrustedLinuxHardLinkFileSystemForTests(type),
        description: `Linux filesystem 0x${type.toString(16)}`,
      };
    }
    if (process.platform === 'darwin') {
      const mountTable = readDarwinMountTable();
      const entries = parseDarwinMountEntries(mountTable);
      assertNoMountedPathsAtOrBelowForTests(
        canonicalRoot,
        entries.map((entry) => entry.path),
      );
      const selected = selectedDarwinMount(entries, canonicalRoot);
      if (selected === undefined) throw invalid('macOS 无法定位验证临时根所属卷');
      const type = statfsSync(canonicalRoot, { bigint: true }).type;
      const selectedRuntimeType = statfsSync(selected.path, { bigint: true }).type;
      const normalizedType = selected.type.toLowerCase();
      const options = [...selected.options].sort().join(',');
      return {
        identity: `darwin:${rootIdentity}:${selected.path}:${normalizedType}:${options}:${type.toString(16)}:${selectedRuntimeType.toString(16)}`,
        hardLinksTrusted: isTrustedDarwinHardLinkBackingForTests(
          normalizedType,
          type,
          selectedRuntimeType,
          isTrustedLocalDarwinMount(selected),
        ),
        description: `macOS ${normalizedType} volume`,
      };
    }
    if (process.platform === 'win32') {
      assertWindowsWorkspaceTreeHasNoReparsePoints(canonicalRoot);
      return {
        identity: `win32:${rootIdentity}`,
        hardLinksTrusted: false,
        description: 'Windows filesystem',
      };
    }
    throw invalid(`当前平台 ${process.platform} 不受支持`);
  } catch (error) {
    if (error instanceof CleanValidationMountProofError) throw error;
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}
