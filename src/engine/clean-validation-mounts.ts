import {
  closeSync,
  constants as fsConstants,
  fstatSync,
  openSync,
  readSync,
  realpathSync,
} from 'node:fs';
import { isAbsolute, relative, resolve, sep } from 'node:path';
import { readDarwinMountTable } from '../workspace-safety/darwin-mount-table-transport.js';
import { assertWindowsWorkspaceTreeHasNoReparsePoints } from '../workspace-safety/windows-path-attributes.js';

const MAX_MOUNT_TABLE_BYTES = 4 * 1024 * 1024;
const MAX_MOUNT_ENTRIES = 65_536;
const MAX_MOUNT_PATH_CHARS = 32_767;

export class CleanValidationMountProofError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CleanValidationMountProofError';
  }
}

function invalid(message: string): CleanValidationMountProofError {
  return new CleanValidationMountProofError(`无法证明验证临时目录没有挂载点：${message}`);
}

function supportedMountPath(path: string, context: string): string {
  if (
    path.length === 0 ||
    path.length > MAX_MOUNT_PATH_CHARS ||
    path.includes('\0') ||
    !isAbsolute(path)
  ) {
    throw invalid(`${context}包含非法路径`);
  }
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
  return lines.map((line) => {
    const separator = line.indexOf(' - ');
    if (separator < 0 || separator !== line.lastIndexOf(' - ')) {
      throw invalid('Linux mountinfo 行无法唯一解析');
    }
    const fields = line.slice(0, separator).split(' ');
    if (fields.length < 6 || fields.some((field) => field.length === 0)) {
      throw invalid('Linux mountinfo 前置字段不完整');
    }
    return supportedMountPath(decodeLinuxMountField(fields[4]), 'Linux mountinfo');
  });
}

/** @internal 只供平台解析回归测试；任何格式歧义都必须 fail-closed。 */
export function parseDarwinMountOutputForTests(bytes: Uint8Array): string[] {
  const text = Buffer.from(bytes).toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(Buffer.from(bytes))) {
    throw invalid('macOS mount 输出不是有效 UTF-8');
  }
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length === 0 || lines.length > MAX_MOUNT_ENTRIES) {
    throw invalid('macOS mount 条目数不在支持范围内');
  }
  return lines.map((line) => {
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
    return supportedMountPath(line.slice(delimiter + 4, options), 'macOS mount');
  });
}

/** @internal 只供包含关系回归；root 自身被覆盖也属于必须拒绝的挂载点。 */
export function assertNoMountedPathsAtOrBelowForTests(
  root: string,
  mountedPaths: readonly string[],
): void {
  const canonicalRoot = resolve(root);
  for (const rawPath of mountedPaths) {
    const mountedPath = supportedMountPath(rawPath, '挂载表');
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
export function assertCleanValidationTreeHasNoMountPoints(root: string): void {
  const canonicalRoot = realpathSync.native(resolve(root));
  try {
    if (process.platform === 'linux') {
      assertNoMountedPathsAtOrBelowForTests(
        canonicalRoot,
        parseLinuxMountInfoForTests(boundedRead(`/proc/${process.pid}/mountinfo`)),
      );
      return;
    }
    if (process.platform === 'darwin') {
      assertNoMountedPathsAtOrBelowForTests(
        canonicalRoot,
        parseDarwinMountOutputForTests(readDarwinMountTable()),
      );
      return;
    }
    if (process.platform === 'win32') {
      assertWindowsWorkspaceTreeHasNoReparsePoints(canonicalRoot);
      return;
    }
    throw invalid(`当前平台 ${process.platform} 不受支持`);
  } catch (error) {
    if (error instanceof CleanValidationMountProofError) throw error;
    throw invalid(error instanceof Error ? error.message : String(error));
  }
}
