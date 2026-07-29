import { createHash } from 'node:crypto';
import { execFileSync, type ExecFileSyncOptionsWithStringEncoding } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  opendirSync,
  readlinkSync,
  readSync,
  realpathSync,
  type BigIntStats,
  type Dirent,
} from 'node:fs';
import {
  basename,
  delimiter,
  dirname,
  extname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import { readSafeControlFileSync, readSafeControlFileUtf8Sync } from './safe-control-file.js';

const HASH_CHUNK_BYTES = 64 * 1024;
export const TRUSTED_TOOL_DEFAULT_TIMEOUT_MS = 60_000;
const GIT_CONTROL_FILE_MAX_BYTES = 4 * 1024 * 1024;
const GIT_MARKER_MAX_BYTES = 64 * 1024;
const GIT_REPLACE_CONTROL_ENTRY_LIMIT = 10_000;
const GIT_REPLACE_CONTROL_DEPTH_LIMIT = 64;

interface FileIdentity {
  device: string;
  inode: string;
  size: string;
  mode: string;
  modifiedNs: string;
  changedNs: string;
}

type NativeExecutableFormat = 'elf' | 'mach-o' | 'pe';

export interface FrozenTrustedTool {
  readonly command: 'git' | 'gh';
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly fileIdentity: Readonly<FileIdentity>;
  readonly nativeFormat: NativeExecutableFormat;
  readonly excludedProjectRoot: string;
  /** Git 的本地控制面；Builder 不能在启动后改写 config/attributes/replace refs。 */
  readonly repositoryControlDigest: string | null;
}

type CacheEntry = { ok: true; value: FrozenTrustedTool } | { ok: false; error: string };

const cache = new Map<string, CacheEntry>();

function hashBytes(value: Buffer | string): string {
  return `sha256:${createHash('sha256').update(value).digest('hex')}`;
}

function controlPathState(path: string): Record<string, string> {
  try {
    const stats = lstatSync(path, { bigint: true });
    const identity = fileIdentityOf(stats);
    if (stats.isSymbolicLink()) {
      return { path, kind: 'symlink', target: readlinkSync(path), ...identity };
    }
    if (stats.isFile()) {
      const content = readSafeControlFileSync(path, { maxBytes: GIT_CONTROL_FILE_MAX_BYTES });
      if (content === null) throw new Error(`Git 控制文件读取时消失：${path}`);
      return { path, kind: 'file', digest: hashBytes(content), ...identity };
    }
    if (stats.isDirectory()) {
      return {
        path,
        kind: 'directory',
        device: identity.device,
        inode: identity.inode,
        mode: identity.mode,
      };
    }
    return { path, kind: 'unsupported', ...identity };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return { path, kind: 'missing' };
    throw error;
  }
}

function recursiveControlStates(
  path: string,
  state: { count: number } = { count: 0 },
  depth = 0,
  alreadyCounted = false,
): Array<Record<string, string>> {
  if (depth > GIT_REPLACE_CONTROL_DEPTH_LIMIT) {
    throw new Error('Git replace refs 控制目录嵌套过深');
  }
  if (!alreadyCounted) {
    state.count += 1;
    if (state.count > GIT_REPLACE_CONTROL_ENTRY_LIMIT) {
      throw new Error('Git replace refs 控制目录条目过多');
    }
  }
  const rootState = controlPathState(path);
  if (rootState.kind !== 'directory') return [rootState];
  const states: Array<Record<string, string>> = [rootState];
  const entries: Dirent[] = [];
  const directory = opendirSync(path);
  try {
    while (true) {
      const entry = directory.readSync();
      if (entry === null) break;
      state.count += 1;
      if (state.count > GIT_REPLACE_CONTROL_ENTRY_LIMIT) {
        throw new Error('Git replace refs 控制目录条目过多');
      }
      entries.push(entry);
    }
  } finally {
    directory.closeSync();
  }
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isDirectory() && !entry.isSymbolicLink())
      states.push(...recursiveControlStates(child, state, depth + 1, true));
    else states.push(controlPathState(child));
  }
  return states;
}

function readGitDirFromMarker(projectRoot: string): {
  gitDir: string | null;
  markerStates: Array<Record<string, string>>;
} {
  const marker = join(projectRoot, '.git');
  const markerState = controlPathState(marker);
  if (markerState.kind === 'missing') return { gitDir: null, markerStates: [markerState] };
  if (markerState.kind === 'directory') {
    return { gitDir: realpathSync.native(marker), markerStates: [markerState] };
  }
  if (markerState.kind !== 'file') {
    throw new Error('项目 .git 标记不是受支持的目录或 worktree 文件');
  }
  const markerContent = readSafeControlFileUtf8Sync(marker, { maxBytes: GIT_MARKER_MAX_BYTES });
  if (markerContent === null) throw new Error('项目 .git worktree 标记读取时消失');
  const match = /^gitdir:\s*(.+?)\s*$/i.exec(markerContent);
  if (!match) throw new Error('项目 .git worktree 标记非法');
  const lexical = isAbsolute(match[1]) ? match[1] : resolve(dirname(marker), match[1]);
  return {
    gitDir: realpathSync.native(lexical),
    markerStates: [markerState, controlPathState(lexical)],
  };
}

function assertNoDynamicLocalGitConfig(path: string): void {
  const state = controlPathState(path);
  if (state.kind === 'missing') return;
  if (state.kind !== 'file') throw new Error(`Git 配置不是普通文件：${path}`);
  const content = readSafeControlFileUtf8Sync(path, {
    maxBytes: GIT_CONTROL_FILE_MAX_BYTES,
  });
  if (content === null) throw new Error(`Git 配置读取时消失：${path}`);
  if (/^\s*\[\s*include(?:if)?(?:\.|\s|\])/im.test(content)) {
    throw new Error(`Git 本地配置含动态 include，无法完整冻结：${path}`);
  }
  if (/^\s*\[\s*filter(?:\.|\s|\])/im.test(content)) {
    throw new Error(`Git 本地配置含可执行 filter，正式绑定不允许运行：${path}`);
  }
  let section = '';
  for (const line of content.split(/\r?\n/)) {
    const sectionMatch = /^\s*\[\s*([a-z0-9.-]+)(?:\s+"[^"]*")?\s*\]/i.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1].toLowerCase();
      continue;
    }
    const keyMatch = /^\s*([a-z][a-z0-9.-]*)\s*(?:=|\s)/i.exec(line);
    if (!keyMatch || /^\s*[#;]/.test(line)) continue;
    const key = keyMatch[1].toLowerCase();
    const baseSection = section.split('.')[0];
    const unsafe =
      (baseSection === 'core' &&
        ['attributesfile', 'excludesfile', 'fsmonitor', 'sshcommand', 'worktree'].includes(key)) ||
      (baseSection === 'diff' && key === 'external') ||
      (baseSection === 'diff' && (key === 'command' || key === 'textconv')) ||
      (baseSection === 'credential' && key === 'helper') ||
      (baseSection === 'url' && (key === 'insteadof' || key === 'pushinsteadof')) ||
      (baseSection === 'remote' && (key === 'uploadpack' || key === 'receivepack'));
    if (unsafe) {
      throw new Error(`Git 本地配置含未受信任的 ${section}.${key}：${path}`);
    }
  }
}

function repositoryControlDigest(projectRoot: string): string {
  const resolved = readGitDirFromMarker(projectRoot);
  if (resolved.gitDir === null) return hashBytes(JSON.stringify(resolved.markerStates));
  const gitDir = resolved.gitDir;
  const commonMarker = join(gitDir, 'commondir');
  const commonMarkerState = controlPathState(commonMarker);
  let commonDir = gitDir;
  if (commonMarkerState.kind === 'file') {
    const content = readSafeControlFileUtf8Sync(commonMarker, { maxBytes: GIT_MARKER_MAX_BYTES });
    if (content === null) throw new Error('Git commondir 标记读取时消失');
    const value = content.trim();
    if (!value || value.includes('\0') || /[\r\n]/.test(value)) {
      throw new Error('Git commondir 标记非法');
    }
    commonDir = realpathSync.native(isAbsolute(value) ? value : resolve(gitDir, value));
  }
  assertNoDynamicLocalGitConfig(join(commonDir, 'config'));
  assertNoDynamicLocalGitConfig(join(gitDir, 'config.worktree'));
  const states = [
    ...resolved.markerStates,
    commonMarkerState,
    controlPathState(join(commonDir, 'config')),
    controlPathState(join(gitDir, 'config.worktree')),
    controlPathState(join(commonDir, 'info', 'attributes')),
    controlPathState(join(commonDir, 'info', 'exclude')),
    controlPathState(join(commonDir, 'info', 'grafts')),
    controlPathState(join(commonDir, 'objects', 'info', 'alternates')),
    ...recursiveControlStates(join(commonDir, 'refs', 'replace')),
  ];
  return hashBytes(JSON.stringify(states));
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function fileIdentityOf(stats: BigIntStats): FileIdentity {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: stats.size.toString(),
    mode: stats.mode.toString(),
    modifiedNs: stats.mtimeNs.toString(),
    changedNs: stats.ctimeNs.toString(),
  };
}

function sameIdentity(left: FileIdentity, right: FileIdentity): boolean {
  return Object.keys(left).every(
    (key) => left[key as keyof FileIdentity] === right[key as keyof FileIdentity],
  );
}

function nativeExecutableFormat(bytes: Buffer): NativeExecutableFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes.subarray(1, 4).toString('ascii') === 'ELF') {
    return 'elf';
  }
  if (bytes.length >= 2 && bytes[0] === 0x4d && bytes[1] === 0x5a) return 'pe';
  if (bytes.length >= 4) {
    const magic = bytes.readUInt32BE(0);
    if (
      [
        0xfeedface, 0xcefaedfe, 0xfeedfacf, 0xcffaedfe, 0xcafebabe, 0xbebafeca, 0xcafebabf,
        0xbfbafeca,
      ].includes(magic)
    )
      return 'mach-o';
  }
  return null;
}

function snapshot(
  path: string,
): Pick<FrozenTrustedTool, 'executableSha256' | 'fileIdentity' | 'nativeFormat'> {
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error('不是普通文件');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(HASH_CHUNK_BYTES);
    let prefix = Buffer.alloc(0);
    let read = 0;
    do {
      read = readSync(descriptor, chunk, 0, chunk.length, null);
      if (read > 0) {
        const bytes = chunk.subarray(0, read);
        if (prefix.length < 4) prefix = Buffer.from(bytes.subarray(0, 4));
        hash.update(bytes);
      }
    } while (read > 0);
    const after = fstatSync(descriptor, { bigint: true });
    const beforeIdentity = fileIdentityOf(before);
    const afterIdentity = fileIdentityOf(after);
    if (!sameIdentity(beforeIdentity, afterIdentity)) throw new Error('读取期间文件身份变化');
    const nativeFormat = nativeExecutableFormat(prefix);
    if (nativeFormat === null) throw new Error('不是受支持的原生单文件可执行程序');
    return {
      executableSha256: `sha256:${hash.digest('hex')}`,
      fileIdentity: afterIdentity,
      nativeFormat,
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function executableNames(command: string): string[] {
  if (process.platform !== 'win32' || extname(command) !== '') return [command];
  const extensions = (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
    .split(';')
    .map((value) => value.trim())
    .filter(Boolean);
  return [command, ...extensions.map((extension) => `${command}${extension}`)];
}

function pathCandidates(command: string): string[] {
  return (process.env.PATH ?? '').split(delimiter).flatMap((entry) => {
    const unquoted =
      entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry;
    if (!isAbsolute(unquoted)) return [];
    return executableNames(command).map((name) => resolve(unquoted, name));
  });
}

function canonicalProjectRoot(projectRoot: string): string {
  try {
    return realpathSync.native(resolve(projectRoot));
  } catch (error) {
    throw new Error(
      `无法核对可信工具的项目根：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

function freeze(command: 'git' | 'gh', projectRoot: string): FrozenTrustedTool {
  if (command === 'gh') assertTrustedGhEnvironment(projectRoot);
  for (const candidate of pathCandidates(command)) {
    let real: string;
    try {
      accessSync(candidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      if (insideRoot(projectRoot, candidate)) {
        throw new Error(`${command} PATH 候选位于不可信项目根内：${candidate}`);
      }
      real = realpathSync.native(candidate);
    } catch (error) {
      if (error instanceof Error && error.message.includes('不可信项目根')) throw error;
      continue;
    }
    if (insideRoot(projectRoot, real)) {
      throw new Error(`${command} 可执行文件位于不可信项目根内：${real}`);
    }
    if (
      process.platform === 'win32' &&
      ['.cmd', '.bat', '.ps1'].includes(extname(real).toLowerCase())
    ) {
      throw new Error(`${command} 解析为未受支持的 Windows shell 包装器：${real}`);
    }
    const captured = snapshot(real);
    return Object.freeze({
      command,
      executablePath: real,
      executableSha256: captured.executableSha256,
      fileIdentity: Object.freeze({ ...captured.fileIdentity }),
      nativeFormat: captured.nativeFormat,
      excludedProjectRoot: projectRoot,
      repositoryControlDigest: command === 'git' ? repositoryControlDigest(projectRoot) : null,
    });
  }
  throw new Error(`找不到项目外可信的 ${command} 可执行文件`);
}

function cacheKey(command: 'git' | 'gh', projectRoot: string): string {
  return `${command}\0${projectRoot}`;
}

export function freezeTrustedTool(command: 'git' | 'gh', projectRoot: string): FrozenTrustedTool {
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  const key = cacheKey(command, canonicalRoot);
  const existing = cache.get(key);
  if (existing) {
    if (!existing.ok) throw new Error(existing.error);
    assertTrustedTool(existing.value);
    return existing.value;
  }
  try {
    const value = freeze(command, canonicalRoot);
    cache.set(key, { ok: true, value });
    return value;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    cache.set(key, { ok: false, error: message });
    throw new Error(message);
  }
}

export function assertTrustedTool(tool: FrozenTrustedTool): void {
  let currentReal: string;
  let current: ReturnType<typeof snapshot>;
  try {
    currentReal = realpathSync.native(tool.executablePath);
    current = snapshot(tool.executablePath);
  } catch (error) {
    throw new Error(
      `冻结的 ${tool.command} 不可复核：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    currentReal !== tool.executablePath ||
    current.executableSha256 !== tool.executableSha256 ||
    current.nativeFormat !== tool.nativeFormat ||
    !sameIdentity(current.fileIdentity, tool.fileIdentity)
  ) {
    throw new Error(`冻结的 ${tool.command} 已变化，拒绝继续使用`);
  }
  if (tool.command === 'git') {
    const currentControlDigest = repositoryControlDigest(tool.excludedProjectRoot);
    if (currentControlDigest !== tool.repositoryControlDigest) {
      throw new Error('Git 本地控制配置、属性、替换引用或对象来源在启动后发生变化');
    }
  }
}

function environmentWithoutProjectPath(projectRoot: string): NodeJS.ProcessEnv {
  const safePath = (process.env.PATH ?? '')
    .split(delimiter)
    .filter((entry) => {
      const unquoted =
        entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
          ? entry.slice(1, -1)
          : entry;
      if (!isAbsolute(unquoted) || insideRoot(projectRoot, resolve(unquoted))) return false;
      try {
        return !insideRoot(projectRoot, realpathSync.native(unquoted));
      } catch {
        return true;
      }
    })
    .join(delimiter);
  return { ...process.env, PATH: safePath };
}

function hardenGitEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const hardened = { ...environment };
  for (const key of Object.keys(hardened)) {
    if (key.startsWith('GIT_')) delete hardened[key];
  }
  const nullConfig = process.platform === 'win32' ? 'NUL' : '/dev/null';
  return {
    ...hardened,
    GIT_CONFIG_COUNT: '0',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: nullConfig,
    GIT_CONFIG_SYSTEM: nullConfig,
    GIT_ATTR_NOSYSTEM: '1',
    GIT_EXTERNAL_DIFF: '',
    GIT_NO_REPLACE_OBJECTS: '1',
    GIT_OPTIONAL_LOCKS: '0',
  };
}

/** gh 的配置根不能由受审项目自身提供；稳定的用户级目录仍可复用现有登录。 */
export function assertTrustedGhEnvironment(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = process.env,
): void {
  const lexicalRoot = resolve(projectRoot);
  const canonicalRoot = canonicalProjectRoot(projectRoot);
  for (const key of ['GH_CONFIG_DIR', 'XDG_CONFIG_HOME', 'HOME'] as const) {
    const value = environment[key];
    if (!value) continue;
    const lexical = isAbsolute(value) ? resolve(value) : resolve(lexicalRoot, value);
    if (insideRoot(lexicalRoot, lexical) || insideRoot(canonicalRoot, lexical)) {
      throw new Error(`${key} 位于不可信项目根内，无法安全复用 gh 登录配置`);
    }
    try {
      if (insideRoot(canonicalRoot, realpathSync.native(lexical))) {
        throw new Error(`${key} 真实路径位于不可信项目根内，无法安全复用 gh 登录配置`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('不可信项目根')) throw error;
      // 尚不存在的用户配置目录允许由 gh 在项目外按需处理。
    }
  }
}

export type TrustedToolExecOptions = Omit<
  ExecFileSyncOptionsWithStringEncoding,
  'encoding' | 'env'
> & {
  projectRoot: string;
  env?: NodeJS.ProcessEnv;
};

function execTrustedToolOutputSync(
  command: 'git' | 'gh',
  args: readonly string[],
  options: TrustedToolExecOptions,
  encoding: 'utf8' | 'buffer',
): string | Buffer {
  const tool = freezeTrustedTool(command, options.projectRoot);
  assertTrustedTool(tool);
  const execOptions = { ...options } as Partial<TrustedToolExecOptions>;
  const extraEnvironment = execOptions.env;
  delete execOptions.projectRoot;
  delete execOptions.env;
  const safeEnvironment = environmentWithoutProjectPath(tool.excludedProjectRoot);
  const invocationEnvironment =
    command === 'git'
      ? hardenGitEnvironment({ ...safeEnvironment, ...(extraEnvironment ?? {}) })
      : { ...safeEnvironment, ...(extraEnvironment ?? {}) };
  if (command === 'gh') {
    assertTrustedGhEnvironment(tool.excludedProjectRoot, invocationEnvironment);
  }
  let result: string | Buffer | undefined;
  let invocationError: unknown;
  try {
    const invocationArgs =
      command === 'git'
        ? [
            '--no-replace-objects',
            '-c',
            `core.worktree=${tool.excludedProjectRoot}`,
            '-c',
            'core.bare=false',
            // Husky 等工具会合法地写入仓库级 core.hooksPath。可信 Git 调用
            // 不需要执行项目 hooks，因此在命令行层明确禁用，而不是拒绝整个仓库。
            '-c',
            `core.hooksPath=${process.platform === 'win32' ? 'NUL' : '/dev/null'}`,
            ...args,
          ]
        : [...args];
    result = execFileSync(tool.executablePath, invocationArgs, {
      ...execOptions,
      encoding,
      timeout: execOptions.timeout ?? TRUSTED_TOOL_DEFAULT_TIMEOUT_MS,
      env: {
        ...invocationEnvironment,
        // 调用方可以补充认证等环境变量，但不能把项目目录重新塞回 PATH。
        PATH: safeEnvironment.PATH,
      },
    });
  } catch (error) {
    invocationError = error;
  }
  try {
    assertTrustedTool(tool);
  } catch (identityError) {
    throw new Error(`调用期间冻结的 ${tool.command} 身份发生变化，拒绝采用命令结果`, {
      cause: identityError,
    });
  }
  if (invocationError !== undefined) {
    throw invocationError instanceof Error
      ? invocationError
      : new Error(
          typeof invocationError === 'string' ? invocationError : '可信工具调用抛出了非 Error 异常',
        );
  }
  if (result === undefined) throw new Error(`${tool.command} 未返回可核对的文本结果`);
  return result;
}

export function execTrustedToolSync(
  command: 'git' | 'gh',
  args: readonly string[],
  options: TrustedToolExecOptions,
): string {
  return execTrustedToolOutputSync(command, args, options, 'utf8') as string;
}

export class TrustedGitBlobUtf8Error extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TrustedGitBlobUtf8Error';
  }
}

export interface TrustedGitBlobText {
  readonly content: string;
  readonly bytes: number;
}

export interface TrustedGitBlobReadOptions {
  readonly maxBuffer?: number;
  readonly timeout?: number;
}

/**
 * 从精确提交读取 Git blob，并证明原始字节可以无损表示为 UTF-8。
 * 合法编码的 U+FFFD 会保留；只拒绝解码器本来会静默替换的非法字节。
 */
export function readTrustedGitBlobUtf8Sync(
  projectRoot: string,
  commit: string,
  path: string,
  options: TrustedGitBlobReadOptions = {},
): TrustedGitBlobText {
  if (!/^[a-f0-9]{40}(?:[a-f0-9]{24})?$/i.test(commit)) {
    throw new Error('Git blob 读取必须绑定精确提交');
  }
  if (!path || path.includes('\0')) throw new Error('Git blob 路径无效');
  const bytes = execTrustedToolOutputSync(
    'git',
    ['cat-file', 'blob', `${commit}:${path}`],
    {
      projectRoot,
      cwd: projectRoot,
      stdio: ['ignore', 'pipe', 'pipe'],
      ...options,
    },
    'buffer',
  ) as Buffer;
  let content: string;
  try {
    // ignoreBOM=true 表示不丢弃 BOM，确保文本可以还原到同一组字节。
    content = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new TrustedGitBlobUtf8Error(`${path} 不是合法 UTF-8 文本`);
  }
  if (!Buffer.from(content, 'utf8').equals(bytes)) {
    throw new TrustedGitBlobUtf8Error(`${path} 的 UTF-8 解码无法保持原始字节身份`);
  }
  return { content, bytes: bytes.length };
}

export function trustedToolName(tool: FrozenTrustedTool): string {
  return `${tool.command}:${basename(tool.executablePath)}`;
}
