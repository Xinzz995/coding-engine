import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  opendirSync,
  realpathSync,
  rmSync,
  type BigIntStats,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { ManagedGateContext } from './gate.js';
import { runContractPrepareCommands } from './gate.js';
import { resolveExecutablePath } from './agent.js';
import { GIT_NULL_CONFIG_PATH } from './git-environment.js';
import { isGitHead } from '../contracts/validation-contract.js';
import { snapshotQualityContract, type QualityContract } from '../quality/contract.js';
import {
  CLEAN_VALIDATION_CHECKOUT_VERSION,
  validationEnvironmentDigest,
} from '../quality/validation-environment.js';
import { environmentEntries, runManagedWorkspaceProcess } from '../workspace-safety/coordinator.js';
import {
  inlineModuleArguments,
  InlineProgramTransportError,
} from '../workspace-safety/inline-program.js';
import {
  ExternalFileLinkSnapshotBudget,
  ExternalFileLinkSnapshotBudgetError,
  externalFileTargetIdentityKey,
  sameExternalFileLinkIdentity,
  snapshotManagedExternalFileLink,
  type ExternalFileLinkIdentity,
} from './external-file-link-identity.js';
import { assertCleanValidationTreeHasNoMountPoints } from './clean-validation-mounts.js';

export { CLEAN_VALIDATION_CHECKOUT_VERSION, validationEnvironmentDigest };
const TEMP_PREFIX = 'coding-x-validation-';
const GIT_TIMEOUT_MS = 10 * 60_000;
const MAX_GIT_OUTPUT_BYTES = 8 * 1024 * 1024;
// 与 Windows 固定路径检查器的公开上限一致，保证任何平台都能完成同一棵树的收口证明。
const MAX_VALIDATION_TREE_ENTRIES = 100_000;
const MAX_GIT_CONTROL_ENTRIES = 20_000;
const MAX_GIT_CONTROL_BYTES = 32 * 1024 * 1024;
const MAX_EXTERNAL_LINK_FILE_BYTES = 256 * 1024 * 1024;
const MAX_EXTERNAL_LINKS = 1024;
const MAX_EXTERNAL_LINK_TARGET_BYTES = 1024 * 1024 * 1024;
const EXTERNAL_LINK_SNAPSHOT_DEADLINE_MS = 30_000;

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
  cleanup(): CleanValidationCheckoutCleanup;
}

function directoryIdentity(path: string): DirectoryIdentity {
  const info = lstatSync(path, { bigint: true });
  if (!info.isDirectory() || info.isSymbolicLink()) {
    throw new CleanValidationCheckoutError('cleanup-unverifiable', '验证临时根不是普通目录');
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

function pathInside(parent: string, candidate: string): boolean {
  const value = relative(resolve(parent), resolve(candidate));
  return value === '' || (!value.startsWith(`..${sep}`) && value !== '..' && !isAbsolute(value));
}

interface ExternalFileTargetSnapshot {
  readonly targetDigest: string;
}

async function observeManagedFileLink(
  linkPath: string,
  relativePath: string,
  context: string,
  budget: ExternalFileLinkSnapshotBudget,
  managed: ManagedGateContext,
  checkoutRoot: string,
  sourceRoot: string,
) {
  try {
    return await snapshotManagedExternalFileLink({
      linkPath,
      checkoutRoot,
      sourceRoot,
      maxFileBytes: MAX_EXTERNAL_LINK_FILE_BYTES,
      budget,
      session: managed.session,
      kind: managed.kind,
      cwd: checkoutRoot,
      ...(managed.termination ? { termination: managed.termination } : {}),
    });
  } catch (error) {
    if (error instanceof ExternalFileLinkSnapshotBudgetError) {
      throw new CleanValidationCheckoutError(
        'artifact-boundary-violated',
        `${context}${error.message}：${relativePath}`,
      );
    }
    throw new CleanValidationCheckoutError(
      'artifact-boundary-violated',
      `${context}无法冻结外部普通文件链接：${relativePath}：${
        error instanceof Error ? error.message : String(error)
      }`,
    );
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
    GIT_CONFIG_GLOBAL: GIT_NULL_CONFIG_PATH,
    GIT_TERMINAL_PROMPT: '0',
    GIT_LFS_SKIP_SMUDGE: '1',
    GIT_ATTR_NOSYSTEM: '1',
    GIT_OPTIONAL_LOCKS: '0',
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
const request = JSON.parse(process.argv[1]);
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
  const statRecord = (info) => [
    info.dev, info.ino, info.uid, info.mode, info.size, info.mtimeNs, info.ctimeNs,
  ].map((value) => value.toString()).join('\0');
  const addFile = (target, path) => {
    const info = lstatSync(target, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('.git/' + path + ' 不是可核对的普通文件');
    }
    entries += 1;
    if (info.size > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('.git/' + path + ' 大小非法');
    bytes += Number(info.size);
    if (entries > ${MAX_GIT_CONTROL_ENTRIES} || bytes > ${MAX_GIT_CONTROL_BYTES}) {
      throw new Error('Git 控制面超过核对上限');
    }
    records.push('f\0' + path + '\0' + (info.mode & 0o777n).toString(8) + '\0' +
      createHash('sha256').update(readFileSync(target)).digest('hex'));
  };
  const addObjectFile = (target, path) => {
    const info = lstatSync(target, { bigint: true });
    if (!info.isFile() || info.isSymbolicLink()) {
      throw new Error('.git/' + path + ' 不是可核对的普通 object 文件');
    }
    entries += 1;
    if (entries > ${MAX_GIT_CONTROL_ENTRIES}) throw new Error('Git 控制面超过核对上限');
    records.push('o\0' + path + '\0' + statRecord(info));
  };
  const visit = (directory, prefix = '') => {
    const listed = readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of listed) {
      const path = prefix === '' ? entry.name : prefix + '/' + entry.name;
      const target = join(directory, entry.name);
      const info = lstatSync(target, { bigint: true });
      if (info.isSymbolicLink()) throw new Error('.git/' + path + ' 不得是符号链接');
      if (info.isDirectory()) {
        entries += 1;
        if (entries > ${MAX_GIT_CONTROL_ENTRIES}) throw new Error('Git 控制面超过核对上限');
        records.push('d\0' + path + '\0' + statRecord(info));
        visit(target, path);
      } else if (
        path === 'objects/info/alternates' || path === 'objects/info/http-alternates'
      ) {
        addFile(target, path);
      } else if (path.startsWith('objects/')) {
        addObjectFile(target, path);
      } else {
        addFile(target, path);
      }
    }
  };
  visit(gitRoot);
  const digestRecords = (selected) =>
    createHash('sha256').update(selected.join('\0')).digest('hex');
  const recordPath = (record) => record.split('\0')[1];
  const isIndexRecord = (record) => recordPath(record) === 'index';
  const isObjectRecord = (record) => {
    const path = record.split('\0')[1];
    return path === 'objects' || path?.startsWith('objects/');
  };
  const indexRecords = records.filter(isIndexRecord);
  const objectRecords = records.filter(isObjectRecord);
  const otherRecords = records.filter(
    (record) => !isIndexRecord(record) && !isObjectRecord(record),
  );
  return {
    tree: digestRecords(records),
    index: digestRecords(indexRecords),
    objects: digestRecords(objectRecords),
    other: digestRecords(otherRecords),
  };
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
    const indexTree = run(['write-tree']).toString('utf8').trim();
    if (indexTree !== tree) throw new Error('初始 Git index tree 与目标提交不一致');
    process.stdout.write(JSON.stringify({
      ok: true, tree, objectFormat, control: controlIdentity(),
    }));
    process.exit(0);
  }
  if (request.mode === 'assert') {
    const control = controlIdentity();
    if (JSON.stringify(control) !== JSON.stringify(request.control)) {
      const changed = ['index', 'objects', 'other'].filter(
        (name) => control[name] !== request.control[name],
      );
      process.stdout.write(JSON.stringify({ ok: false, code: 'identity-changed', diagnostic: '验证检出的 Git 控制文件发生变化：' + changed.join('、') }));
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
  readonly environment: NodeJS.ProcessEnv;
  readonly managed: ManagedGateContext;
}): Promise<GitHelperResult> {
  let args: string[];
  try {
    args = inlineModuleArguments(MANAGED_GIT_HELPER, JSON.stringify(options.request));
  } catch (error) {
    if (error instanceof InlineProgramTransportError) {
      throw new CleanValidationCheckoutError(
        'git-failed',
        `Git helper 无法固定传输：${error.message}`,
      );
    }
    throw error;
  }
  const result = await runManagedWorkspaceProcess(options.managed.session, {
    kind: options.managed.kind,
    delegation: 'read-only-v1',
    executable: realpathSync.native(process.execPath),
    // 固定 helper 从当前受信任进程内存分块传输，执行阶段不再重新打开可替换的脚本路径。
    args,
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

class ArtifactPathPolicy {
  readonly #roots: ReadonlySet<string>;

  constructor(patterns: readonly string[]) {
    const roots = patterns.map((pattern) => {
      if (
        !pattern.endsWith('/**') ||
        pattern.includes('\\') ||
        /[*?[\]{}]/u.test(pattern.slice(0, -3))
      ) {
        throw new CleanValidationCheckoutError(
          'invalid-source',
          `质量契约含无法安全核对的产物路径：${pattern}`,
        );
      }
      return pattern.slice(0, -3);
    });
    this.#roots = new Set(roots);
  }

  isRoot(path: string): boolean {
    return !path.includes('\\') && this.#roots.has(path.replace(/\/$/u, ''));
  }

  allows(path: string): boolean {
    if (path.includes('\\')) return false;
    let candidate = path.replace(/\/$/u, '');
    while (candidate !== '') {
      if (this.#roots.has(candidate)) return true;
      const separator = candidate.lastIndexOf('/');
      if (separator < 0) return false;
      candidate = candidate.slice(0, separator);
    }
    return false;
  }
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

async function assertSafeArtifactTopology(
  root: string,
  sourceRoot: string,
  policy: ArtifactPathPolicy,
  context: string,
  options: {
    readonly capturePreparedExternalLinks: boolean;
    readonly permittedExternalLinks: ReadonlyMap<string, ExternalFileLinkIdentity>;
    readonly signal?: AbortSignal;
    readonly managed: ManagedGateContext;
  },
): Promise<Map<string, ExternalFileLinkIdentity>> {
  const capturedExternalLinks = new Map<string, ExternalFileLinkIdentity>();
  const observedExternalLinks = new Set<string>();
  const externalTargetSnapshots = new Map<string, ExternalFileTargetSnapshot>();
  const externalLinkBudget = new ExternalFileLinkSnapshotBudget(
    {
      maxLinks: MAX_EXTERNAL_LINKS,
      maxUniqueTargetBytes: MAX_EXTERNAL_LINK_TARGET_BYTES,
      deadlineMs: EXTERNAL_LINK_SNAPSHOT_DEADLINE_MS,
    },
    options.signal,
  );
  const checkpoint = (): void => {
    try {
      externalLinkBudget.checkpoint();
    } catch (error) {
      if (error instanceof ExternalFileLinkSnapshotBudgetError) {
        throw new CleanValidationCheckoutError(
          'artifact-boundary-violated',
          `${context}${error.message}`,
        );
      }
      throw error;
    }
  };
  let entries = 0;
  const visit = async (directory: string, prefix = ''): Promise<void> => {
    checkpoint();
    const stream = opendirSync(directory);
    try {
      let entry;
      while ((entry = stream.readSync()) !== null) {
        if (prefix === '' && entry.name === '.git') continue;
        checkpoint();
        entries += 1;
        if (entries > MAX_VALIDATION_TREE_ENTRIES) {
          throw new CleanValidationCheckoutError(
            'artifact-boundary-violated',
            `${context}验证检出内容超过 ${MAX_VALIDATION_TREE_ENTRIES} 项，无法完整核对产物边界`,
          );
        }
        const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
        const target = join(directory, entry.name);
        let targetInfo: BigIntStats;
        try {
          targetInfo = lstatSync(target, { bigint: true });
        } catch {
          throw new CleanValidationCheckoutError(
            'artifact-boundary-violated',
            `${context}验证检出条目在核对期间消失：${path}`,
          );
        }
        if (targetInfo.isSymbolicLink()) {
          if (policy.isRoot(path)) {
            throw new CleanValidationCheckoutError(
              'artifact-boundary-violated',
              `${context}允许的产物根不是普通目录：${path}`,
            );
          }
          const observation = await observeManagedFileLink(
            target,
            path,
            context,
            externalLinkBudget,
            options.managed,
            root,
            sourceRoot,
          );
          if (observation.scope === 'internal') continue;
          if (observation.scope === 'source') {
            throw new CleanValidationCheckoutError(
              'artifact-boundary-violated',
              `${context}验证检出链接回开发工作树：${path}`,
            );
          }
          const observed = observation.identity;
          externalLinkBudget.countLink();
          const targetKey = externalFileTargetIdentityKey(observed.resolvedPath, observed.target);
          const firstTargetObservation = externalLinkBudget.reserveTarget(
            targetKey,
            Number(observed.target.size),
          );
          if (firstTargetObservation) {
            externalTargetSnapshots.set(targetKey, {
              targetDigest: observed.targetDigest,
            });
          } else if (
            externalTargetSnapshots.get(targetKey)?.targetDigest !== observed.targetDigest
          ) {
            throw new CleanValidationCheckoutError(
              'artifact-boundary-violated',
              `${context}外部普通文件链接目标去重身份不一致：${path}`,
            );
          }
          if (options.capturePreparedExternalLinks && policy.allows(path)) {
            capturedExternalLinks.set(path, observed);
          } else {
            const permitted = options.permittedExternalLinks.get(path);
            if (!permitted) {
              throw new CleanValidationCheckoutError(
                'artifact-boundary-violated',
                `${context}验证检出含未经准备阶段确认的外部链接：${path}`,
              );
            }
            if (!sameExternalFileLinkIdentity(permitted, observed)) {
              throw new CleanValidationCheckoutError(
                'artifact-boundary-violated',
                `${context}外部普通文件链接身份或内容发生变化：${path}`,
              );
            }
            observedExternalLinks.add(path);
          }
          continue;
        }
        if (policy.isRoot(path) && !targetInfo.isDirectory()) {
          throw new CleanValidationCheckoutError(
            'artifact-boundary-violated',
            `${context}允许的产物根不是普通目录：${path}`,
          );
        }
        if (targetInfo.isDirectory()) {
          await visit(target, path);
          continue;
        }
        if (!targetInfo.isFile()) {
          throw new CleanValidationCheckoutError(
            'artifact-boundary-violated',
            `${context}验证检出含特殊文件：${path}`,
          );
        }
        if (targetInfo.nlink !== 1n) {
          throw new CleanValidationCheckoutError(
            'artifact-boundary-violated',
            `${context}验证检出含 hard link：${path}`,
          );
        }
      }
    } finally {
      stream.closeSync();
    }
  };
  await visit(root);
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
  if (options.managed.session.state !== 'open') {
    throw new CleanValidationCheckoutError(
      'cleanup-unverifiable',
      `workspace session 处于 ${options.managed.session.state}，不能建立新的验证检出`,
    );
  }
  let contract: QualityContract;
  let additionalPolicy: unknown;
  try {
    contract = snapshotQualityContract(options.contract);
    additionalPolicy =
      options.additionalPolicy === undefined
        ? undefined
        : structuredClone(options.additionalPolicy);
  } catch {
    throw new CleanValidationCheckoutError('invalid-source', '质量契约或附加策略无法建立独立快照');
  }
  const artifactPolicy = new ArtifactPathPolicy([
    ...contract.generatedPaths,
    ...contract.localValidation.allowedPaths,
  ]);
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
  let identity: DirectoryIdentity;
  try {
    identity = directoryIdentity(container);
  } catch (error) {
    try {
      options.managed.session.retainLeaseForIsolation();
    } catch {
      // Preserve the original identity failure; a non-open session already blocks continuation.
    }
    throw error;
  }
  let checkoutRoot = join(container, 'checkout');
  let checkoutIdentity: DirectoryIdentity | null = null;
  let cleanupResult: CleanValidationCheckoutCleanup | undefined;
  const retainCleanupFailure = (
    status: Exclude<CleanValidationCheckoutCleanup['status'], 'removed'>,
    reason: string,
  ): CleanValidationCheckoutCleanup => {
    if (cleanupResult !== undefined) return cleanupResult;
    let isolationDiagnostic = '';
    if (options.managed.session.state === 'open') {
      try {
        options.managed.session.retainLeaseForIsolation();
      } catch (error) {
        isolationDiagnostic = `；保留 workspace 隔离租约失败：${
          error instanceof Error ? error.message : String(error)
        }`;
      }
    }
    cleanupResult = {
      status,
      path: container,
      reason: `${reason}${isolationDiagnostic}`,
    };
    return cleanupResult;
  };
  const cleanup = (): CleanValidationCheckoutCleanup => {
    if (cleanupResult !== undefined) return cleanupResult;
    if (options.managed.session.state !== 'open') {
      return retainCleanupFailure(
        'retained',
        `workspace session 处于 ${options.managed.session.state}，无法证明受管进程已经收口`,
      );
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
      return retainCleanupFailure('retained', '临时根不再满足归属前缀');
    }
    let current: BigIntStats;
    try {
      current = lstatSync(container, { bigint: true });
    } catch (error) {
      return retainCleanupFailure(
        'location-unverifiable',
        `临时根原位置无法核对，不能证明对象已删除或确认实际位置：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (!sameDirectoryIdentity(identity, current)) {
      return retainCleanupFailure(
        'location-unverifiable',
        '临时根身份发生变化，不能推断原验证内容被移动到哪里',
      );
    }
    if (checkoutIdentity !== null) {
      let currentCheckout: BigIntStats;
      try {
        currentCheckout = lstatSync(checkoutRoot, { bigint: true });
      } catch (error) {
        return retainCleanupFailure(
          'location-unverifiable',
          `验证 checkout 原位置无法核对：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (!sameDirectoryIdentity(checkoutIdentity, currentCheckout)) {
        return retainCleanupFailure(
          'location-unverifiable',
          '验证 checkout 身份发生变化，原验证内容的实际位置无法确认',
        );
      }
    }
    try {
      assertCleanValidationTreeHasNoMountPoints(container);
      rmSync(container, { recursive: true, force: false });
      cleanupResult = { status: 'removed', path: container };
      return cleanupResult;
    } catch (error) {
      return retainCleanupFailure(
        'retained',
        error instanceof Error ? error.message : String(error),
      );
    }
  };

  try {
    options.onContainerCreatedForTests?.(container);
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
      contract,
      head: options.head,
      additionalRefs,
      ...(additionalPolicy === undefined ? {} : { additionalPolicy }),
    });
    let permittedExternalLinks = new Map<string, ExternalFileLinkIdentity>();

    const assertCurrent = async (
      context: string,
      capturePreparedExternalLinks = false,
    ): Promise<void> => {
      try {
        assertCleanValidationTreeHasNoMountPoints(checkoutRoot);
      } catch (error) {
        throw new CleanValidationCheckoutError(
          'artifact-boundary-violated',
          `${context}${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const observed = await runGitHelper({
        request: { mode: 'assert', git, root: checkoutRoot, control, objectFormat },
        cwd: checkoutRoot,
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
        .filter((path) => !artifactPolicy.allows(path));
      unexpected.push(
        ...observed.untrackedDirectories.filter((path) => !artifactPolicy.allows(path)),
      );
      if (unexpected.length > 0) {
        throw new CleanValidationCheckoutError(
          'artifact-boundary-violated',
          `${context}验证检出产生未允许内容：${unexpected.slice(0, 20).join('、')}`,
        );
      }
      const captured = await assertSafeArtifactTopology(
        checkoutRoot,
        sourceRoot,
        artifactPolicy,
        context,
        {
          capturePreparedExternalLinks,
          permittedExternalLinks,
          signal: options.managed.termination?.signal,
          managed: options.managed,
        },
      );
      if (capturePreparedExternalLinks) permittedExternalLinks = captured;
    };

    const prepare = async (context: string): Promise<void> => {
      const prepared = await runContractPrepareCommands(
        contract.localValidation.prepare,
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
    return {
      root: checkoutRoot,
      head: options.head,
      tree,
      environmentDigest,
      processEnvironment,
      gitExecutable: git,
      additionalRefs,
      assertCurrent: async (context) => await assertCurrent(context),
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
  #cleanupFailure: CleanValidationCheckoutCleanup | null = null;
  readonly #contract: QualityContract;
  readonly #createCheckout: typeof createCleanValidationCheckout;

  constructor(
    private readonly sourceRoot: string,
    contract: QualityContract,
    private readonly managed: ManagedGateContext,
    /** @internal 仅供验证管理器拒绝错误返回值的测试 seam。 */
    createCheckout: typeof createCleanValidationCheckout = createCleanValidationCheckout,
  ) {
    this.#contract = snapshotQualityContract(contract);
    this.#createCheckout = createCheckout;
  }

  async acquire(
    head: string,
    additionalRefs: readonly string[] = [],
    additionalPolicy?: unknown,
  ): Promise<CleanValidationCheckout> {
    const normalizedRefs = [...new Set(additionalRefs)].sort();
    const policySnapshot =
      additionalPolicy === undefined ? undefined : structuredClone(additionalPolicy);
    const expectedDigest = validationEnvironmentDigest({
      contract: this.#contract,
      head,
      additionalRefs: normalizedRefs,
      ...(policySnapshot === undefined ? {} : { additionalPolicy: policySnapshot }),
    });
    const previousCleanup = this.dispose();
    if (previousCleanup && previousCleanup.status !== 'removed') {
      throw new CleanValidationCheckoutError(
        'cleanup-unverifiable',
        `旧验证检出未能安全清理，${describeCleanValidationCheckoutCleanup(previousCleanup)}`,
      );
    }
    const created = await this.#createCheckout({
      sourceRoot: this.sourceRoot,
      head,
      contract: this.#contract,
      additionalRefs: normalizedRefs,
      ...(policySnapshot === undefined ? {} : { additionalPolicy: policySnapshot }),
      managed: this.managed,
    });
    if (created.environmentDigest !== expectedDigest) {
      const createdCleanup = created.cleanup();
      if (createdCleanup.status !== 'removed') {
        throw new CleanValidationCheckoutError(
          'cleanup-unverifiable',
          `新验证检出返回了错误环境摘要且未能安全清理，${describeCleanValidationCheckoutCleanup(createdCleanup)}`,
        );
      }
      throw new CleanValidationCheckoutError(
        'identity-changed',
        '新验证检出返回的环境摘要与管理器预计算值不一致',
      );
    }
    this.#checkout = created;
    return created;
  }

  dispose(): CleanValidationCheckoutCleanup | null {
    if (!this.#checkout) return this.#cleanupFailure;
    const checkout = this.#checkout;
    this.#checkout = null;
    const cleanup = checkout.cleanup();
    this.#cleanupFailure = cleanup.status === 'removed' ? null : cleanup;
    return cleanup;
  }
}
