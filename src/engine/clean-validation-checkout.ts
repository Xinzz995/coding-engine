import { createHash } from 'node:crypto';
import {
  constants as fsConstants,
  closeSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  readlinkSync,
  readSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
  type BigIntStats,
} from 'node:fs';
import { devNull, tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ManagedGateContext } from './gate.js';
import { runContractPrepareCommands } from './gate.js';
import { resolveExecutablePath } from './agent.js';
import { isGitHead } from '../contracts/validation-contract.js';
import type { QualityContract } from '../quality/contract.js';
import {
  CLEAN_VALIDATION_CHECKOUT_VERSION,
  validationEnvironmentDigest,
} from '../quality/validation-environment.js';
import { environmentEntries, runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import { globMatches } from '../review/common.js';
import {
  sameExternalFileLinkIdentity,
  type ExternalFileLinkIdentity,
  type ExternalFileStatIdentity,
} from './external-file-link-identity.js';

export { CLEAN_VALIDATION_CHECKOUT_VERSION, validationEnvironmentDigest };
const TEMP_PREFIX = 'coding-x-validation-';
const GIT_TIMEOUT_MS = 10 * 60_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
const MAX_VALIDATION_TREE_ENTRIES = 200_000;
const MAX_GIT_CONTROL_ENTRIES = 20_000;
const MAX_GIT_CONTROL_BYTES = 32 * 1024 * 1024;
const MAX_EXTERNAL_LINK_FILE_BYTES = 256 * 1024 * 1024;

export type CleanValidationCheckoutErrorCode =
  | 'invalid-source'
  | 'unsupported-git-content'
  | 'git-failed'
  | 'prepare-failed'
  | 'identity-changed'
  | 'tracked-content-changed'
  | 'artifact-boundary-violated'
  | 'cleanup-unverifiable';

export class CleanValidationCheckoutError extends Error {
  constructor(
    readonly code: CleanValidationCheckoutErrorCode,
    message: string,
  ) {
    super(message);
    this.name = 'CleanValidationCheckoutError';
  }
}

interface DirectoryIdentity {
  readonly dev: bigint;
  readonly ino: bigint;
  readonly uid: bigint;
}

export interface CleanValidationCheckoutOptions {
  readonly sourceRoot: string;
  readonly head: string;
  readonly contract: QualityContract;
  readonly additionalRefs?: readonly string[];
  readonly additionalPolicy?: unknown;
  readonly managed: ManagedGateContext;
  /** @internal 精确清理测试观察；生产不设置。 */
  readonly onContainerCreatedForTests?: (path: string) => void;
}

export interface CleanValidationCheckoutCleanup {
  readonly status: 'removed' | 'retained' | 'location-unverifiable';
  readonly path: string;
  readonly reason?: string;
}

export function describeCleanValidationCheckoutCleanup(
  cleanup: CleanValidationCheckoutCleanup,
): string {
  if (cleanup.status === 'removed') return `已清理 ${cleanup.path}`;
  const location =
    cleanup.status === 'retained'
      ? `已保留 ${cleanup.path}`
      : `原临时容器为 ${cleanup.path}，但验证内容的实际位置无法确认`;
  return `${location}：${cleanup.reason ?? 'unknown'}`;
}

export interface CleanValidationCheckout {
  readonly root: string;
  readonly head: string;
  readonly tree: string;
  readonly environmentDigest: string;
  /** 供 prepare、机械检查、TDD 与 Validator 共用的去项目污染环境。 */
  readonly processEnvironment: NodeJS.ProcessEnv;
  /** 在任何项目命令运行前解析并固定的 Git executable，供 TDD 内部探测使用。 */
  readonly gitExecutable: string;
  readonly additionalRefs: readonly string[];
  assertCurrent(context: string): Promise<void>;
  resetForReuse(): Promise<void>;
  cleanup(): CleanValidationCheckoutCleanup;
}

function directoryIdentity(path: string): DirectoryIdentity {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CleanValidationCheckoutError('cleanup-unverifiable', '验证临时根不是普通目录');
  }
  return { dev: info.dev, ino: info.ino, uid: info.uid };
}

function fileIdentity(path: string): DirectoryIdentity {
  const info = lstatSync(path, { bigint: true });
  if (!info.isFile() || info.isSymbolicLink()) {
    throw new CleanValidationCheckoutError('cleanup-unverifiable', '验证 helper 不是普通文件');
  }
  return { dev: info.dev, ino: info.ino, uid: info.uid };
}

function sameDirectoryIdentity(left: DirectoryIdentity, right: BigIntStats): boolean {
  return (
    right.isDirectory() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid
  );
}

function sameFileIdentity(left: DirectoryIdentity, right: BigIntStats): boolean {
  return (
    right.isFile() &&
    !right.isSymbolicLink() &&
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.uid === right.uid
  );
}

function externalFileStatIdentity(info: BigIntStats): ExternalFileStatIdentity {
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    mode: info.mode,
    size: info.size,
    mtimeNs: info.mtimeNs,
    ctimeNs: info.ctimeNs,
  };
}

function sameExternalFileStat(left: ExternalFileStatIdentity, right: BigIntStats): boolean {
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

function pathInside(parent: string, candidate: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

function snapshotExternalFileLink(
  linkPath: string,
  resolvedPath: string,
  relativePath: string,
  context: string,
): ExternalFileLinkIdentity {
  let descriptor: number | null = null;
  try {
    const linkBefore = lstatSync(linkPath, { bigint: true });
    if (!linkBefore.isSymbolicLink()) {
      throw new CleanValidationCheckoutError(
        'artifact-boundary-violated',
        `${context}外部普通文件链接身份发生变化：${relativePath}`,
      );
    }
    const linkTargetBefore = readlinkSync(linkPath, { encoding: 'buffer' });
    const targetPathBefore = lstatSync(resolvedPath, { bigint: true });
    if (!targetPathBefore.isFile() || targetPathBefore.isSymbolicLink()) {
      throw new CleanValidationCheckoutError(
        'artifact-boundary-violated',
        `${context}验证检出只允许链接到项目外普通文件：${relativePath}`,
      );
    }
    if (targetPathBefore.size > BigInt(MAX_EXTERNAL_LINK_FILE_BYTES)) {
      throw new CleanValidationCheckoutError(
        'artifact-boundary-violated',
        `${context}外部普通文件链接超过 ${MAX_EXTERNAL_LINK_FILE_BYTES} bytes：${relativePath}`,
      );
    }
    const noFollow = process.platform === 'win32' ? 0 : fsConstants.O_NOFOLLOW;
    descriptor = openSync(resolvedPath, fsConstants.O_RDONLY | noFollow);
    const openedBefore = fstatSync(descriptor, { bigint: true });
    if (
      !openedBefore.isFile() ||
      !sameExternalFileStat(externalFileStatIdentity(targetPathBefore), openedBefore)
    ) {
      throw new CleanValidationCheckoutError(
        'artifact-boundary-violated',
        `${context}外部普通文件链接目标无法绑定：${relativePath}`,
      );
    }
    const digest = createHash('sha256');
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    const size = Number(openedBefore.size);
    let offset = 0;
    while (offset < size) {
      const count = readSync(
        descriptor,
        buffer,
        0,
        Math.min(buffer.byteLength, size - offset),
        offset,
      );
      if (count <= 0) {
        throw new CleanValidationCheckoutError(
          'artifact-boundary-violated',
          `${context}读取外部普通文件链接时提前结束：${relativePath}`,
        );
      }
      digest.update(buffer.subarray(0, count));
      offset += count;
    }
    const openedAfter = fstatSync(descriptor, { bigint: true });
    const targetPathAfter = lstatSync(resolvedPath, { bigint: true });
    const linkAfter = lstatSync(linkPath, { bigint: true });
    const linkTargetAfter = readlinkSync(linkPath, { encoding: 'buffer' });
    if (
      !sameExternalFileStat(externalFileStatIdentity(openedBefore), openedAfter) ||
      !sameExternalFileStat(externalFileStatIdentity(openedBefore), targetPathAfter) ||
      !sameExternalFileStat(externalFileStatIdentity(linkBefore), linkAfter) ||
      !linkTargetBefore.equals(linkTargetAfter) ||
      realpathSync.native(linkPath) !== resolvedPath
    ) {
      throw new CleanValidationCheckoutError(
        'artifact-boundary-violated',
        `${context}外部普通文件链接在核对期间发生变化：${relativePath}`,
      );
    }
    return {
      resolvedPath,
      link: externalFileStatIdentity(linkBefore),
      linkTargetDigest: createHash('sha256').update(linkTargetBefore).digest('hex'),
      target: externalFileStatIdentity(openedBefore),
      targetDigest: digest.digest('hex'),
    };
  } catch (error) {
    if (error instanceof CleanValidationCheckoutError) throw error;
    throw new CleanValidationCheckoutError(
      'artifact-boundary-violated',
      `${context}无法冻结外部普通文件链接：${relativePath}`,
    );
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

const PROJECT_PROCESS_ENVIRONMENT_KEYS = new Set([
  'BASH_ENV',
  'CDPATH',
  'CLASSPATH',
  'CONDA_DEFAULT_ENV',
  'CONDA_PREFIX',
  'DYLD_INSERT_LIBRARIES',
  'DYLD_LIBRARY_PATH',
  'ENV',
  'INIT_CWD',
  'JAVA_TOOL_OPTIONS',
  'JDK_JAVA_OPTIONS',
  'LD_LIBRARY_PATH',
  'LD_PRELOAD',
  'NODE_OPTIONS',
  'NODE_PATH',
  'OLDPWD',
  'PERL5LIB',
  'PERL5OPT',
  'PIPENV_ACTIVE',
  'POETRY_ACTIVE',
  'PYTHONHOME',
  'PYTHONPATH',
  'PYTHONSTARTUP',
  'RUBYLIB',
  'RUBYOPT',
  'UV_PROJECT_ENVIRONMENT',
  'VIRTUAL_ENV',
  'ZDOTDIR',
  // 这些变量即使指向项目根之外，也会替换测试/构建实际读取的项目或配置；不能把
  // 任意宿主文件悄悄带入 exact-HEAD 验证输入。
  'BABEL_CONFIG_FILE',
  'BABEL_ENV',
  'COVERAGE_PROCESS_START',
  'COVERAGE_RCFILE',
  'GOFLAGS',
  'GOWORK',
  'MAKEFILES',
  'MAKEFLAGS',
  'MFLAGS',
  'MYPY_CONFIG_FILE',
  'PYTEST_ADDOPTS',
  'RUFF_CONFIG',
]);

function pathEntryInside(root: string, value: string): boolean {
  if (value === '') return true;
  const absolute = isAbsolute(value) ? value : resolve(root, value);
  if (pathInside(root, absolute)) return true;
  try {
    return pathInside(root, realpathSync.native(absolute));
  } catch {
    return false;
  }
}

function environmentValueReferencesSource(sourceRoot: string, value: string): boolean {
  const normalize = (entry: string): string =>
    process.platform === 'win32' ? entry.replaceAll('\\', '/').toLowerCase() : entry;
  const source = normalize(sourceRoot).replace(/\/$/u, '');
  const text = normalize(value);
  if (text === source || text.includes(`${source}/`)) return true;
  const candidates = value
    .split(/[\s,;=]+/u)
    .map((entry) => entry.replace(/^['"]|['"]$/gu, ''))
    .filter((entry) => isAbsolute(entry));
  return candidates.some((candidate) => {
    try {
      return pathInside(sourceRoot, realpathSync.native(candidate));
    } catch {
      return false;
    }
  });
}

export function valueReferencesProjectPath(sourceRoot: string, value: string): boolean {
  const input = resolve(sourceRoot);
  let canonical = input;
  try {
    canonical = realpathSync.native(input);
  } catch {
    // The caller will fail separately if its project root cannot be resolved.
  }
  return [input, canonical].some((root) => environmentValueReferencesSource(root, value));
}

/** 在任何项目命令运行前固定 Git，并拒绝 PATH 外部目录中的链接回开发工作树。 */
export function resolveValidationGitExecutable(
  sourceRoot: string,
  workingDirectory: string,
  environment: NodeJS.ProcessEnv,
): string {
  const canonicalSource = realpathSync.native(resolve(sourceRoot));
  const git = realpathSync.native(resolveExecutablePath('git', workingDirectory, environment));
  if (pathInside(canonicalSource, git)) {
    throw new CleanValidationCheckoutError(
      'invalid-source',
      'Git executable 解析到开发工作树，不能建立可信验证检出',
    );
  }
  return git;
}

function validationProcessEnvironment(
  sourceRoot: string,
  validationRoot: string,
  sourceAliases: readonly string[],
): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    const normalized = name.toUpperCase();
    const value = environment[name];
    if (normalized.startsWith('CODING_X_')) {
      delete environment[name];
      continue;
    }
    if (normalized === 'PATH') {
      environment[name] = (environment[name] ?? '')
        .split(delimiter)
        .filter(
          (entry) => ![sourceRoot, ...sourceAliases].some((root) => pathEntryInside(root, entry)),
        )
        .join(delimiter);
      continue;
    }
    if (
      value !== undefined &&
      [sourceRoot, ...sourceAliases].some((root) => environmentValueReferencesSource(root, value))
    ) {
      delete environment[name];
      continue;
    }
    if (
      normalized.startsWith('GIT_') ||
      normalized.startsWith('NPM_LIFECYCLE_') ||
      normalized.startsWith('NPM_PACKAGE_') ||
      PROJECT_PROCESS_ENVIRONMENT_KEYS.has(normalized)
    ) {
      delete environment[name];
      continue;
    }
    if (
      (normalized === 'NPM_CONFIG_LOCAL_PREFIX' ||
        normalized === 'NPM_CONFIG_USERCONFIG' ||
        normalized === 'NPM_CONFIG_GLOBALCONFIG') &&
      environment[name] !== undefined &&
      [sourceRoot, ...sourceAliases].some((root) => pathEntryInside(root, environment[name]!))
    ) {
      delete environment[name];
    }
  }
  environment.PWD = validationRoot;
  environment.CODING_X_PROJECT_ROOT = validationRoot;
  return environment;
}

export function createValidationProcessEnvironment(
  sourceRoot: string,
  validationRoot: string,
): NodeJS.ProcessEnv {
  const sourceInputRoot = resolve(sourceRoot);
  return validationProcessEnvironment(
    realpathSync.native(sourceInputRoot),
    realpathSync.native(validationRoot),
    [sourceInputRoot],
  );
}

function safeGitEnvironment(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return {
    ...base,
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: devNull,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ATTR_NOSYSTEM: '1',
  };
}

function diagnostic(stdout: Buffer, stderr: Buffer): string {
  return Buffer.concat([stdout, stderr]).toString('utf8').slice(-2000).trim();
}

const MANAGED_GIT_HELPER = String.raw`
import { spawnSync } from 'node:child_process';
import {
  closeSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, readdirSync, readlinkSync,
} from 'node:fs';
import { createHash } from 'node:crypto';
import { join, posix } from 'node:path';
const request = JSON.parse(process.argv[2]);
const run = (args) => {
  const result = spawnSync(request.git, args, {
    cwd: request.root,
    env: process.env,
    encoding: null,
    maxBuffer: ${MAX_GIT_OUTPUT_BYTES},
    windowsHide: true,
  });
  const stdout = Buffer.from(result.stdout ?? []);
  const stderr = Buffer.from(result.stderr ?? []);
  if (result.error || result.status !== 0) {
    throw new Error(Buffer.concat([stdout, stderr]).toString('utf8').slice(-2000) || result.error?.message || args[0]);
  }
  return stdout;
};
const runOptionalMatch = (args) => {
  const result = spawnSync(request.git, args, {
    cwd: request.root,
    env: process.env,
    encoding: null,
    maxBuffer: ${MAX_GIT_OUTPUT_BYTES},
    windowsHide: true,
  });
  const stdout = Buffer.from(result.stdout ?? []);
  const stderr = Buffer.from(result.stderr ?? []);
  if (result.error || (result.status !== 0 && result.status !== 1)) {
    throw new Error(Buffer.concat([stdout, stderr]).toString('utf8').slice(-2000) || result.error?.message || args[0]);
  }
  return result.status === 0 ? stdout : Buffer.alloc(0);
};
const treeEntries = (ref) => run(['ls-tree', '-rz', '--full-tree', ref])
  .toString('utf8').split('\0').filter(Boolean).map((entry) => {
    const tab = entry.indexOf('\t');
    const meta = tab < 0 ? [] : entry.slice(0, tab).split(' ');
    const path = tab < 0 ? '' : entry.slice(tab + 1);
    if (
      tab < 0 || meta.length !== 3 || path === '' || posix.isAbsolute(path) ||
      path.split('/').includes('..') || path.includes('\\')
    ) throw new Error('Git tree 输出无法安全解析');
    return { mode: meta[0], type: meta[1], object: meta[2], path };
  });
const controlIdentity = () => {
  const gitRoot = join(request.root, '.git');
  const records = [];
  let entries = 0;
  let bytes = 0;
  const addFile = (target, path) => {
    const info = lstatSync(target);
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('.git/' + path + ' 不是可核对的普通文件');
    }
    entries += 1;
    bytes += info.size;
    if (entries > ${MAX_GIT_CONTROL_ENTRIES} || bytes > ${MAX_GIT_CONTROL_BYTES}) {
      throw new Error('Git 控制面超过核对上限');
    }
    records.push('f\0' + path + '\0' + (info.mode & 0o777).toString(8) + '\0' +
      createHash('sha256').update(readFileSync(target)).digest('hex'));
  };
  const visit = (directory, prefix = '') => {
    const listed = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of listed) {
      const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
      const target = join(directory, entry.name);
      if (prefix === '' && entry.name === 'objects') {
        const info = lstatSync(target);
        if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('.git/objects 不是普通目录');
        records.push('d\0objects');
        for (const name of ['alternates', 'http-alternates']) {
          const alternate = join(target, 'info', name);
          try { addFile(alternate, 'objects/info/' + name); }
          catch (error) {
            if (!error || typeof error !== 'object' || error.code !== 'ENOENT') throw error;
            records.push('missing\0objects/info/' + name);
          }
        }
        continue;
      }
      if (prefix === '' && entry.name === 'index') {
        const info = lstatSync(target);
        if (!info.isFile() || info.isSymbolicLink()) throw new Error('.git/index 不是普通文件');
        records.push('index\0regular');
        continue;
      }
      const info = lstatSync(target);
      if (info.isSymbolicLink()) throw new Error('.git/' + path + ' 不得是符号链接');
      if (info.isDirectory()) {
        entries += 1;
        if (entries > ${MAX_GIT_CONTROL_ENTRIES}) throw new Error('Git 控制面超过核对上限');
        records.push('d\0' + path + '\0' + (info.mode & 0o777).toString(8));
        visit(target, path);
      } else {
        addFile(target, path);
      }
    }
  };
  visit(gitRoot);
  return { tree: createHash('sha256').update(records.join('\0')).digest('hex') };
};
const blobHash = (entry) => {
  try {
    const target = join(request.root, ...entry.path.split('/'));
    const info = lstatSync(target);
    let bytes;
    if (entry.mode === '120000') {
      if (!info.isSymbolicLink()) return null;
      bytes = Buffer.from(readlinkSync(target), 'utf8');
    } else {
      if (!info.isFile() || info.isSymbolicLink()) return null;
      const hash = createHash(request.objectFormat);
      hash.update('blob ' + info.size + '\0');
      const buffer = Buffer.allocUnsafe(1024 * 1024);
      const file = openSync(target, 'r');
      try {
        let offset = 0;
        while (offset < info.size) {
          const count = readSync(file, buffer, 0, Math.min(buffer.length, info.size - offset), offset);
          if (count <= 0) throw new Error('读取 tracked 文件时提前结束');
          hash.update(buffer.subarray(0, count));
          offset += count;
        }
      } finally {
        closeSync(file);
      }
      if (process.platform !== 'win32') {
        const executable = (info.mode & 0o111) !== 0;
        if ((entry.mode === '100755') !== executable) return null;
      }
      return hash.digest('hex');
    }
    return createHash(request.objectFormat)
      .update('blob ' + bytes.byteLength + '\0')
      .update(bytes)
      .digest('hex');
  } catch (error) {
    if (error && typeof error === 'object' && error.code === 'ENOENT') return null;
    throw error;
  }
};
try {
  if (request.mode === 'create') {
    const objectFormat = run([
      '-C', request.sourceRoot, 'rev-parse', '--show-object-format',
    ]).toString('utf8').trim();
    if (objectFormat !== 'sha1' && objectFormat !== 'sha256') {
      throw new Error('不支持的 Git object format：' + objectFormat);
    }
    run(['init', '--quiet', ...(objectFormat === 'sha256' ? ['--object-format=sha256'] : [])]);
    const hooksPath = join(request.root, '.git', 'coding-x-empty-hooks');
    mkdirSync(hooksPath, { recursive: true });
    for (const ref of request.refs) {
      run([
        '-c', 'core.hooksPath=' + hooksPath,
        '-c', 'protocol.file.allow=always',
        'fetch', '--quiet', '--no-tags', '--no-recurse-submodules', '--depth=1',
        '--no-write-fetch-head', request.repositoryUrl, ref,
      ]);
    }
    const entries = treeEntries(request.head);
    const gitlink = entries.find((entry) => entry.mode === '160000');
    if (gitlink) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'unsupported-git-content', diagnostic: '提交包含 submodule ' + gitlink.path + '；本地验证暂不支持递归来源身份' }));
      process.exit(0);
    }
    const lfsSignature = 'version https://git-lfs.github.com/spec/v1';
    const lfsCandidates = runOptionalMatch([
      'grep', '-I', '-z', '-l', '-F', lfsSignature, request.head, '--',
    ]).toString('utf8').split('\0').filter(Boolean);
    for (const candidate of lfsCandidates) {
      const prefix = request.head + ':';
      if (!candidate.startsWith(prefix)) throw new Error('Git LFS 候选路径无法解析');
      const path = candidate.slice(prefix.length);
      const bytes = run(['cat-file', 'blob', request.head + ':' + path]);
      if (bytes.toString('utf8', 0, lfsSignature.length) === lfsSignature) {
        process.stdout.write(JSON.stringify({ ok: false, code: 'unsupported-git-content', diagnostic: '提交包含未展开的 Git LFS pointer ' + path }));
        process.exit(0);
      }
    }
    for (const entry of entries.filter((item) => item.path.split('/').at(-1) === '.gitattributes')) {
      const bytes = run(['cat-file', 'blob', entry.object]);
      if (bytes.byteLength > 1024 * 1024) {
        process.stdout.write(JSON.stringify({ ok: false, code: 'unsupported-git-content', diagnostic: entry.path + ' 超过 1 MiB，无法安全核对 checkout filter' }));
        process.exit(0);
      }
      for (const rawLine of bytes.toString('utf8').split(/\r?\n/u)) {
        const line = rawLine.trim();
        if (line === '' || line.startsWith('#')) continue;
        const attributes = line.split(/\s+/u).slice(1);
        if (attributes.some((attribute) => /^(?:filter(?:=|$)|working-tree-encoding(?:=|$))/iu.test(attribute))) {
          process.stdout.write(JSON.stringify({ ok: false, code: 'unsupported-git-content', diagnostic: entry.path + ' 声明了本地验证暂不支持的 filter/working-tree-encoding' }));
          process.exit(0);
        }
      }
    }
    run([
      '-c', 'core.hooksPath=' + hooksPath,
      '-c', 'core.autocrlf=false',
      'checkout', '--quiet', '--detach', '--force', request.head,
    ]);
    const tree = run(['rev-parse', request.head + '^{tree}']).toString('utf8').trim();
    process.stdout.write(JSON.stringify({
      ok: true, tree, objectFormat, control: controlIdentity(),
    }));
    process.exit(0);
  }
  if (request.mode === 'assert' || request.mode === 'clean') {
    const control = controlIdentity();
    if (JSON.stringify(control) !== JSON.stringify(request.control)) {
      process.stdout.write(JSON.stringify({ ok: false, code: 'identity-changed', diagnostic: '验证检出的 Git 控制文件发生变化' }));
      process.exit(0);
    }
    if (request.mode === 'clean') {
      run(['clean', '-ffdx', '--']);
      process.stdout.write(JSON.stringify({ ok: true }));
      process.exit(0);
    }
    const head = run(['rev-parse', 'HEAD']).toString('utf8').trim();
    const branch = run(['rev-parse', '--abbrev-ref', 'HEAD']).toString('utf8').trim();
    const indexTree = run(['write-tree']).toString('utf8').trim();
    const status = run([
      '-c', 'core.fsmonitor=false', '-c', 'core.untrackedCache=false',
      'status', '--porcelain=v1', '-z', '--untracked-files=all', '--ignored=matching', '--no-renames',
    ]).toString('base64');
    const entries = treeEntries('HEAD');
    const trackedMismatches = [];
    for (const entry of entries) {
      if (entry.type !== 'blob' || blobHash(entry) !== entry.object) {
        trackedMismatches.push(entry.path);
        if (trackedMismatches.length >= 20) break;
      }
    }
    const trackedDirectories = new Set();
    for (const path of entries.map((entry) => entry.path)) {
      let parent = posix.dirname(path);
      while (parent !== '.') {
        trackedDirectories.add(parent);
        parent = posix.dirname(parent);
      }
    }
    const untrackedDirectories = [];
    const visit = (directory, prefix = '') => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (prefix === '' && entry.name === '.git') continue;
        if (!entry.isDirectory()) continue;
        const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
        if (!trackedDirectories.has(path)) {
          untrackedDirectories.push(path);
          if (untrackedDirectories.length > 100000) throw new Error('未跟踪目录数量超过安全上限');
          continue;
        }
        visit(join(directory, entry.name), path);
      }
    };
    visit(request.root);
    process.stdout.write(JSON.stringify({
      ok: true, head, branch, indexTree, status, trackedMismatches, untrackedDirectories,
    }));
    process.exit(0);
  }
  throw new Error('未知 Git helper mode');
} catch (error) {
  process.stdout.write(JSON.stringify({ ok: false, code: 'git-failed', diagnostic: error instanceof Error ? error.message : String(error) }));
}
`;

interface GitHelperResult {
  readonly ok: boolean;
  readonly code?: CleanValidationCheckoutErrorCode;
  readonly diagnostic?: string;
  readonly tree?: string;
  readonly objectFormat?: 'sha1' | 'sha256';
  readonly control?: { readonly tree: string };
  readonly head?: string;
  readonly branch?: string;
  readonly indexTree?: string;
  readonly status?: string;
  readonly trackedMismatches?: string[];
  readonly untrackedDirectories?: string[];
}

async function runGitHelper(options: {
  readonly request: Record<string, unknown>;
  readonly cwd: string;
  readonly helperPath: string;
  readonly helperIdentity: DirectoryIdentity;
  readonly environment: NodeJS.ProcessEnv;
  readonly managed: ManagedGateContext;
}): Promise<GitHelperResult> {
  let helperInfo: BigIntStats;
  try {
    helperInfo = lstatSync(options.helperPath, { bigint: true });
  } catch {
    throw new CleanValidationCheckoutError('identity-changed', 'Git helper 文件无法重新读取');
  }
  if (
    !helperInfo.isFile() ||
    helperInfo.isSymbolicLink() ||
    !sameFileIdentity(options.helperIdentity, helperInfo) ||
    !readFileSync(options.helperPath).equals(Buffer.from(MANAGED_GIT_HELPER, 'utf8'))
  ) {
    throw new CleanValidationCheckoutError('identity-changed', 'Git helper 文件身份或内容发生变化');
  }
  const result = await runManagedWorkspaceProcess(options.managed.session, {
    kind: options.managed.kind,
    delegation: 'read-only-v1',
    executable: realpathSync.native(process.execPath),
    args: [options.helperPath, JSON.stringify(options.request)],
    cwd: options.cwd,
    environment: environmentEntries(options.environment),
    timeoutMs: GIT_TIMEOUT_MS,
    termination: options.managed.termination,
  });
  if (result.stdout.byteLength > MAX_GIT_OUTPUT_BYTES) {
    throw new CleanValidationCheckoutError('git-failed', 'Git 输出超过本地验证安全上限');
  }
  if (
    result.verdict !== 'completed' ||
    result.exitCode !== 0 ||
    result.timedOut ||
    result.processTreeNotEmpty
  ) {
    throw new CleanValidationCheckoutError(
      'git-failed',
      `Git 操作失败：${diagnostic(result.stdout, result.stderr) || 'managed helper'}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(result.stdout.toString('utf8'));
  } catch {
    throw new CleanValidationCheckoutError('git-failed', 'Git helper 输出无法解析');
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new CleanValidationCheckoutError('git-failed', 'Git helper 返回非法结果');
  }
  return parsed as GitHelperResult;
}

function artifactAllowed(path: string, patterns: readonly string[]): boolean {
  const normalized = path.replaceAll('\\', '/').replace(/\/$/u, '');
  return patterns.some((pattern) => {
    const directoryPattern = pattern.slice(0, -3);
    return globMatches(normalized, directoryPattern) || globMatches(normalized, pattern);
  });
}

function parseStatusPaths(bytes: Buffer): Array<{ code: string; path: string }> {
  return bytes
    .toString('utf8')
    .split('\0')
    .filter(Boolean)
    .map((entry) => {
      if (entry.length < 4) {
        throw new CleanValidationCheckoutError('git-failed', 'Git status 输出无法解析');
      }
      return { code: entry.slice(0, 2), path: entry.slice(3) };
    });
}

function assertSafeArtifactTopology(
  root: string,
  sourceRoot: string,
  patterns: readonly string[],
  context: string,
  options: {
    readonly capturePreparedExternalLinks: boolean;
    readonly permittedExternalLinks: ReadonlyMap<string, ExternalFileLinkIdentity>;
  },
): Map<string, ExternalFileLinkIdentity> {
  const directoryPatterns = patterns.map((pattern) => pattern.slice(0, -3));
  const capturedExternalLinks = new Map<string, ExternalFileLinkIdentity>();
  const observedExternalLinks = new Set<string>();
  let entries = 0;
  const visit = (directory: string, prefix = ''): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (prefix === '' && entry.name === '.git') continue;
      entries += 1;
      if (entries > MAX_VALIDATION_TREE_ENTRIES) {
        throw new CleanValidationCheckoutError(
          'artifact-boundary-violated',
          `${context}验证检出内容超过 ${MAX_VALIDATION_TREE_ENTRIES} 项，无法完整核对产物边界`,
        );
      }
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const target = join(directory, entry.name);
      if (entry.isSymbolicLink()) {
        if (directoryPatterns.some((pattern) => globMatches(path, pattern))) {
          throw new CleanValidationCheckoutError(
            'artifact-boundary-violated',
            `${context}允许的产物根不是普通目录：${path}`,
          );
        }
        let resolved: string;
        try {
          resolved = realpathSync.native(target);
        } catch {
          throw new CleanValidationCheckoutError(
            'artifact-boundary-violated',
            `${context}验证检出含无法解析的链接：${path}`,
          );
        }
        if (!pathInside(root, resolved)) {
          if (pathInside(sourceRoot, resolved)) {
            throw new CleanValidationCheckoutError(
              'artifact-boundary-violated',
              `${context}验证检出链接回开发工作树：${path}`,
            );
          }
          if (options.capturePreparedExternalLinks && artifactAllowed(path, patterns)) {
            capturedExternalLinks.set(
              path,
              snapshotExternalFileLink(target, resolved, path, context),
            );
          } else {
            const permitted = options.permittedExternalLinks.get(path);
            if (!permitted) {
              throw new CleanValidationCheckoutError(
                'artifact-boundary-violated',
                `${context}验证检出含未经准备阶段确认的外部链接：${path}`,
              );
            }
            const observed = snapshotExternalFileLink(target, resolved, path, context);
            if (!sameExternalFileLinkIdentity(permitted, observed)) {
              throw new CleanValidationCheckoutError(
                'artifact-boundary-violated',
                `${context}外部普通文件链接身份或内容发生变化：${path}`,
              );
            }
            observedExternalLinks.add(path);
          }
        }
        continue;
      }
      if (directoryPatterns.some((pattern) => globMatches(path, pattern)) && !entry.isDirectory()) {
        throw new CleanValidationCheckoutError(
          'artifact-boundary-violated',
          `${context}允许的产物根不是普通目录：${path}`,
        );
      }
      if (entry.isDirectory()) visit(target, path);
    }
  };
  visit(root);
  if (!options.capturePreparedExternalLinks) {
    const missing = [...options.permittedExternalLinks.keys()].filter(
      (path) => !observedExternalLinks.has(path),
    );
    if (missing.length > 0) {
      throw new CleanValidationCheckoutError(
        'artifact-boundary-violated',
        `${context}准备阶段确认的外部普通文件链接缺失或改变：${missing.slice(0, 20).join('、')}`,
      );
    }
  }
  return capturedExternalLinks;
}

export async function createCleanValidationCheckout(
  options: CleanValidationCheckoutOptions,
): Promise<CleanValidationCheckout> {
  if (!isGitHead(options.head)) {
    throw new CleanValidationCheckoutError('invalid-source', '验证检出需要完整 Git HEAD');
  }
  const sourceInputRoot = resolve(options.sourceRoot);
  const sourceRoot = realpathSync.native(sourceInputRoot);
  const additionalRefs = [...new Set(options.additionalRefs ?? [])].sort();
  if (additionalRefs.some((ref) => !isGitHead(ref))) {
    throw new CleanValidationCheckoutError(
      'invalid-source',
      '验证检出的附加 Git ref 必须是完整 commit id',
    );
  }
  const temporaryRoot = realpathSync.native(tmpdir());
  if (pathInside(sourceRoot, temporaryRoot)) {
    throw new CleanValidationCheckoutError(
      'invalid-source',
      '系统临时目录解析到项目根内，不能建立独立验证检出',
    );
  }
  const container = realpathSync.native(mkdtempSync(join(temporaryRoot, TEMP_PREFIX)));
  options.onContainerCreatedForTests?.(container);
  let identity: DirectoryIdentity;
  try {
    identity = directoryIdentity(container);
  } catch (error) {
    try {
      rmSync(container, { recursive: true, force: true });
    } catch {
      // No untrusted process has run; preserve the original construction error.
    }
    throw error;
  }
  let checkoutRoot = join(container, 'checkout');
  const helperPath = join(container, 'git-helper.mjs');
  let checkoutIdentity: DirectoryIdentity | null = null;
  const cleanup = (): CleanValidationCheckoutCleanup => {
    if (options.managed.session.state !== 'open') {
      return {
        status: 'retained',
        path: container,
        reason: `workspace session 处于 ${options.managed.session.state}，无法证明受管进程已经收口`,
      };
    }
    const temporaryRelative = relative(temporaryRoot, container);
    if (
      temporaryRelative === '' ||
      temporaryRelative === '..' ||
      temporaryRelative.startsWith(`..${sep}`) ||
      isAbsolute(temporaryRelative) ||
      temporaryRelative.includes(sep) ||
      !temporaryRelative.startsWith(TEMP_PREFIX)
    ) {
      return { status: 'retained', path: container, reason: '临时根不再满足归属前缀' };
    }
    let current: BigIntStats;
    try {
      current = lstatSync(container, { bigint: true });
    } catch (error) {
      return {
        status: 'location-unverifiable',
        path: container,
        reason: `临时根原位置无法核对，不能证明对象已删除或确认实际位置：${error instanceof Error ? error.message : String(error)}`,
      };
    }
    if (!sameDirectoryIdentity(identity, current)) {
      return {
        status: 'location-unverifiable',
        path: container,
        reason: '临时根身份发生变化，不能推断原验证内容被移动到哪里',
      };
    }
    if (checkoutIdentity !== null) {
      let currentCheckout: BigIntStats;
      try {
        currentCheckout = lstatSync(checkoutRoot, { bigint: true });
      } catch (error) {
        return {
          status: 'location-unverifiable',
          path: container,
          reason: `验证 checkout 原位置无法核对：${error instanceof Error ? error.message : String(error)}`,
        };
      }
      if (!sameDirectoryIdentity(checkoutIdentity, currentCheckout)) {
        return {
          status: 'location-unverifiable',
          path: container,
          reason: '验证 checkout 身份发生变化，原验证内容的实际位置无法确认',
        };
      }
    }
    try {
      rmSync(container, { recursive: true, force: false });
      return { status: 'removed', path: container };
    } catch (error) {
      return {
        status: 'retained',
        path: container,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  };

  try {
    writeFileSync(helperPath, MANAGED_GIT_HELPER, {
      encoding: 'utf8',
      mode: 0o500,
      flag: 'wx',
    });
    const helperIdentity = fileIdentity(helperPath);
    mkdirSync(checkoutRoot);
    checkoutRoot = realpathSync.native(checkoutRoot);
    checkoutIdentity = directoryIdentity(checkoutRoot);
    if (pathInside(sourceRoot, container)) {
      throw new CleanValidationCheckoutError(
        'invalid-source',
        '系统临时目录位于项目根内，不能建立独立验证检出',
      );
    }
    const processEnvironment = createValidationProcessEnvironment(sourceInputRoot, checkoutRoot);
    const environment = safeGitEnvironment(processEnvironment);
    const git = resolveValidationGitExecutable(sourceRoot, sourceRoot, environment);
    const repositoryUrl = pathToFileURL(sourceRoot).href;
    const created = await runGitHelper({
      request: {
        mode: 'create',
        git,
        root: checkoutRoot,
        repositoryUrl,
        sourceRoot,
        head: options.head,
        refs: [options.head, ...additionalRefs],
      },
      cwd: checkoutRoot,
      helperPath,
      helperIdentity,
      environment,
      managed: options.managed,
    });
    if (
      !created.ok ||
      typeof created.tree !== 'string' ||
      (created.objectFormat !== 'sha1' && created.objectFormat !== 'sha256') ||
      typeof created.control?.tree !== 'string'
    ) {
      throw new CleanValidationCheckoutError(
        created.code ?? 'git-failed',
        created.diagnostic ?? '无法建立验证检出',
      );
    }
    const tree = created.tree;
    const objectFormat = created.objectFormat;
    const control = created.control;
    const environmentDigest = validationEnvironmentDigest({
      contract: options.contract,
      head: options.head,
      additionalRefs,
      ...(options.additionalPolicy === undefined
        ? {}
        : { additionalPolicy: options.additionalPolicy }),
    });
    const allowedPaths = [
      ...options.contract.generatedPaths,
      ...options.contract.localValidation.allowedPaths,
    ];
    let permittedExternalLinks = new Map<string, ExternalFileLinkIdentity>();

    const assertCurrent = async (
      context: string,
      capturePreparedExternalLinks = false,
    ): Promise<void> => {
      const observed = await runGitHelper({
        request: { mode: 'assert', git, root: checkoutRoot, control, objectFormat },
        cwd: checkoutRoot,
        helperPath,
        helperIdentity,
        environment,
        managed: options.managed,
      });
      if (!observed.ok) {
        throw new CleanValidationCheckoutError(
          observed.code ?? 'git-failed',
          observed.diagnostic ?? `${context}无法核对验证检出`,
        );
      }
      const currentHead = observed.head;
      const branch = observed.branch;
      if (currentHead !== options.head || branch !== 'HEAD') {
        throw new CleanValidationCheckoutError(
          'identity-changed',
          `${context}验证检出身份变化（期望 detached ${options.head}，当前 ${branch} ${currentHead}）`,
        );
      }
      const indexTree = observed.indexTree;
      if (
        typeof observed.status !== 'string' ||
        !Array.isArray(observed.trackedMismatches) ||
        !observed.trackedMismatches.every((path) => typeof path === 'string') ||
        !Array.isArray(observed.untrackedDirectories) ||
        !observed.untrackedDirectories.every((path) => typeof path === 'string')
      ) {
        throw new CleanValidationCheckoutError('git-failed', `${context}缺少 Git status 结果`);
      }
      const status = parseStatusPaths(Buffer.from(observed.status, 'base64'));
      const tracked = status.filter((entry) => entry.code !== '??' && entry.code !== '!!');
      if (indexTree !== tree || tracked.length > 0 || observed.trackedMismatches.length > 0) {
        throw new CleanValidationCheckoutError(
          'tracked-content-changed',
          `${context}验证检出的已跟踪内容发生变化：${
            [
              ...new Set([...tracked.map((entry) => entry.path), ...observed.trackedMismatches]),
            ].join('、') || 'index tree'
          }`,
        );
      }
      const unexpected = status
        .filter((entry) => entry.code === '??' || entry.code === '!!')
        .map((entry) => entry.path)
        .filter((path) => !artifactAllowed(path, allowedPaths));
      unexpected.push(
        ...observed.untrackedDirectories.filter((path) => !artifactAllowed(path, allowedPaths)),
      );
      if (unexpected.length > 0) {
        throw new CleanValidationCheckoutError(
          'artifact-boundary-violated',
          `${context}验证检出产生未允许内容：${unexpected.slice(0, 20).join('、')}`,
        );
      }
      const captured = assertSafeArtifactTopology(checkoutRoot, sourceRoot, allowedPaths, context, {
        capturePreparedExternalLinks,
        permittedExternalLinks,
      });
      if (capturePreparedExternalLinks) permittedExternalLinks = captured;
    };

    const prepare = async (context: string): Promise<void> => {
      const prepared = await runContractPrepareCommands(
        options.contract.localValidation.prepare,
        checkoutRoot,
        undefined,
        {
          ...options.managed,
          environment: processEnvironment,
          forbiddenExecutableRoot: sourceInputRoot,
        },
      );
      if (!prepared.ok) {
        const failure = prepared.failure;
        throw new CleanValidationCheckoutError(
          'prepare-failed',
          `${context}本地验证准备失败：${failure?.command ?? 'unknown'}${
            failure?.timedOut
              ? '（超时）'
              : failure?.exitCode !== null && failure?.exitCode !== undefined
                ? `（退出码 ${failure.exitCode}）`
                : ''
          }${failure?.outputTail ? `：${failure.outputTail}` : ''}`,
        );
      }
      await assertCurrent(`${context}准备后`, true);
    };
    await assertCurrent('准备前');
    await prepare('');
    const resetForReuse = async (): Promise<void> => {
      await assertCurrent('复用重置前');
      const cleaned = await runGitHelper({
        request: { mode: 'clean', git, root: checkoutRoot, control, objectFormat },
        cwd: checkoutRoot,
        helperPath,
        helperIdentity,
        environment,
        managed: options.managed,
      });
      if (!cleaned.ok) {
        throw new CleanValidationCheckoutError(
          cleaned.code ?? 'git-failed',
          cleaned.diagnostic ?? '无法重置复用验证检出',
        );
      }
      permittedExternalLinks = new Map();
      await assertCurrent('复用重新准备前');
      await prepare('复用');
    };
    return {
      root: checkoutRoot,
      head: options.head,
      tree,
      environmentDigest,
      processEnvironment,
      gitExecutable: git,
      additionalRefs,
      assertCurrent: async (context) => await assertCurrent(context),
      resetForReuse,
      cleanup,
    };
  } catch (error) {
    const cleaned = cleanup();
    const base = error instanceof Error ? error.message : String(error);
    if (cleaned.status !== 'removed') {
      throw new CleanValidationCheckoutError(
        error instanceof CleanValidationCheckoutError ? error.code : 'cleanup-unverifiable',
        `${base}；临时验证目录未能安全清理，${describeCleanValidationCheckoutCleanup(cleaned)}`,
      );
    }
    if (error instanceof CleanValidationCheckoutError) throw error;
    throw new CleanValidationCheckoutError('git-failed', base);
  }
}

export class CleanValidationCheckoutManager {
  #checkout: CleanValidationCheckout | null = null;

  constructor(
    private readonly sourceRoot: string,
    private readonly contract: QualityContract,
    private readonly managed: ManagedGateContext,
  ) {}

  async acquire(
    head: string,
    additionalRefs: readonly string[] = [],
    additionalPolicy?: unknown,
  ): Promise<CleanValidationCheckout> {
    const expectedDigest = validationEnvironmentDigest({
      contract: this.contract,
      head,
      additionalRefs,
      ...(additionalPolicy === undefined ? {} : { additionalPolicy }),
    });
    if (
      this.#checkout &&
      this.#checkout.head === head &&
      this.#checkout.environmentDigest === expectedDigest
    ) {
      await this.#checkout.resetForReuse();
      return this.#checkout;
    }
    const previousCleanup = this.dispose();
    if (previousCleanup && previousCleanup.status !== 'removed') {
      throw new CleanValidationCheckoutError(
        'cleanup-unverifiable',
        `旧验证检出未能安全清理，${describeCleanValidationCheckoutCleanup(previousCleanup)}`,
      );
    }
    this.#checkout = await createCleanValidationCheckout({
      sourceRoot: this.sourceRoot,
      head,
      contract: this.contract,
      additionalRefs,
      ...(additionalPolicy === undefined ? {} : { additionalPolicy }),
      managed: this.managed,
    });
    return this.#checkout;
  }

  dispose(): CleanValidationCheckoutCleanup | null {
    if (!this.#checkout) return null;
    const checkout = this.#checkout;
    this.#checkout = null;
    return checkout.cleanup();
  }
}
