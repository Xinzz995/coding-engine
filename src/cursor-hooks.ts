import { spawnSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  type Stats,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

export type CursorHookAction = 'install' | 'status' | 'remove';
export type CursorHookStatus =
  | 'installed'
  | 'healthy'
  | 'removed'
  | 'absent'
  | 'missing'
  | 'stale'
  | 'conflict'
  | 'error';

export interface CursorHookResult {
  exitCode: 0 | 1;
  status: CursorHookStatus;
  message: string;
  root?: string;
}

export interface CursorHookOptions {
  /** 任意 Git worktree 内路径；命令会自行解析真实 Git 根。 */
  root: string;
  /** 当前 coding-x 发布物内的共同 TDD hook。 */
  bundle: string;
}

export const CURSOR_HOOK_COMMAND = 'node ".cursor/coding-x/tdd-commit-check.mjs"';
export const CURSOR_HOOK_MATCHER = String.raw`\bgit\b[^\r\n]*\bcommit(?=\s|$)`;

const CURSOR_HOOK_ENTRY = Object.freeze({
  command: CURSOR_HOOK_COMMAND,
  matcher: CURSOR_HOOK_MATCHER,
  timeout: 620,
  failClosed: true,
});
const HOOK_FILE = 'tdd-commit-check.mjs';
const INSTALL_FILE = 'install.json';
const SHA256 = /^[a-f0-9]{64}$/;

interface InstallRecord {
  schemaVersion: 1;
  command: string;
  hookFile: string;
  hookSha256: string;
  entrySha256: string;
  cursorDirCreated: boolean;
  managedDirCreated: boolean;
  configCreated: boolean;
}

interface TargetPaths {
  root: string;
  cursorDir: string;
  managedDir: string;
  config: string;
  hook: string;
  install: string;
}

interface CursorConfig {
  exists: boolean;
  raw: Buffer | null;
  value: Record<string, unknown>;
}

interface FileSnapshot {
  path: string;
  exists: boolean;
  bytes: Buffer | null;
  mode: number | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function result(
  status: CursorHookStatus,
  message: string,
  root?: string,
): CursorHookResult {
  return {
    status,
    message,
    root,
    exitCode: status === 'installed'
      || status === 'healthy'
      || status === 'removed'
      || status === 'absent'
      ? 0
      : 1,
  };
}

function resolveGitRoot(cwd: string): string {
  const git = spawnSync('git', ['rev-parse', '--show-toplevel'], {
    cwd,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (git.error || git.status !== 0 || !git.stdout.trim()) {
    throw new Error('当前目录不在可用的 Git worktree 中');
  }
  return realpathSync(git.stdout.trim());
}

function pathsFor(root: string): TargetPaths {
  const cursorDir = join(root, '.cursor');
  const managedDir = join(cursorDir, 'coding-x');
  return {
    root,
    cursorDir,
    managedDir,
    config: join(cursorDir, 'hooks.json'),
    hook: join(managedDir, HOOK_FILE),
    install: join(managedDir, INSTALL_FILE),
  };
}

function lstatIfPresent(path: string): Stats | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

function assertSafeTarget(path: string, kind: 'file' | 'directory'): void {
  const stat = lstatIfPresent(path);
  if (stat === null) return;
  if (stat.isSymbolicLink()) {
    throw new Error(`拒绝写入符号链接：${path}`);
  }
  if (kind === 'directory' ? !stat.isDirectory() : !stat.isFile()) {
    throw new Error(`${path} 不是${kind === 'directory' ? '目录' : '普通文件'}`);
  }
}

function validateTargetLayout(paths: TargetPaths): void {
  assertSafeTarget(paths.cursorDir, 'directory');
  assertSafeTarget(paths.managedDir, 'directory');
  assertSafeTarget(paths.config, 'file');
  assertSafeTarget(paths.hook, 'file');
  assertSafeTarget(paths.install, 'file');
}

function readCursorConfig(path: string): CursorConfig {
  if (!existsSync(path)) {
    return { exists: false, raw: null, value: { version: 1, hooks: {} } };
  }
  const raw = readFileSync(path);
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch (error) {
    throw new Error(`Cursor hooks 配置不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed) || parsed.version !== 1 || !isRecord(parsed.hooks)) {
    throw new Error('Cursor hooks 配置必须是 version=1 且 hooks 为对象');
  }
  const before = parsed.hooks.beforeShellExecution;
  if (before !== undefined && !Array.isArray(before)) {
    throw new Error('Cursor hooks.beforeShellExecution 必须是数组');
  }
  return { exists: true, raw, value: parsed };
}

function readInstallRecord(path: string): InstallRecord | null {
  if (!existsSync(path)) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (error) {
    throw new Error(`coding-x 安装记录不是合法 JSON：${error instanceof Error ? error.message : String(error)}`);
  }
  if (!isRecord(parsed)
      || parsed.schemaVersion !== 1
      || parsed.command !== CURSOR_HOOK_COMMAND
      || parsed.hookFile !== HOOK_FILE
      || typeof parsed.hookSha256 !== 'string'
      || !SHA256.test(parsed.hookSha256)
      || typeof parsed.entrySha256 !== 'string'
      || !SHA256.test(parsed.entrySha256)
      || typeof parsed.cursorDirCreated !== 'boolean'
      || typeof parsed.managedDirCreated !== 'boolean'
      || typeof parsed.configCreated !== 'boolean') {
    throw new Error('coding-x 安装记录结构无效');
  }
  return parsed as unknown as InstallRecord;
}

function hashBytes(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function readBundle(path: string): Buffer | null {
  let descriptor: number;
  try {
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ELOOP') return null;
    throw error;
  }
  try {
    if (!fstatSync(descriptor).isFile()) return null;
    return readFileSync(descriptor);
  } finally {
    closeSync(descriptor);
  }
}

function hashFile(path: string): string {
  return hashBytes(readFileSync(path));
}

function hashManagedEntry(value: unknown): string {
  if (!isRecord(value)) return hashBytes(Buffer.from(JSON.stringify(value)));
  const ordered = Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
  return hashBytes(Buffer.from(JSON.stringify(ordered)));
}

function assertManagedFileSafe(paths: TargetPaths, record: InstallRecord | null): void {
  if (existsSync(paths.hook) && record === null) {
    throw new Error(`发现无安装记录的受管脚本，不会覆盖：${paths.hook}`);
  }
  if (existsSync(paths.hook) && record !== null && hashFile(paths.hook) !== record.hookSha256) {
    throw new Error(`受管脚本已被修改，不会覆盖或删除：${paths.hook}`);
  }
}

function beforeShellEntries(config: Record<string, unknown>): unknown[] {
  const hooks = config.hooks as Record<string, unknown>;
  return (hooks.beforeShellExecution as unknown[] | undefined) ?? [];
}

function isManagedEntry(value: unknown): boolean {
  return isRecord(value) && value.command === CURSOR_HOOK_COMMAND;
}

function isCanonicalEntry(value: unknown): boolean {
  return isRecord(value)
    && Object.keys(value).sort().join(',') === 'command,failClosed,matcher,timeout'
    && value.command === CURSOR_HOOK_ENTRY.command
    && value.matcher === CURSOR_HOOK_ENTRY.matcher
    && value.timeout === CURSOR_HOOK_ENTRY.timeout
    && value.failClosed === CURSOR_HOOK_ENTRY.failClosed;
}

function assertManagedEntrySafe(
  config: Record<string, unknown>,
  record: InstallRecord | null,
): void {
  const entries = beforeShellEntries(config).filter(isManagedEntry);
  if (record === null) {
    if (entries.length > 0) {
      throw new Error('发现无安装记录的受管 Cursor 配置，不会覆盖');
    }
    return;
  }
  if (entries.length !== 1) {
    throw new Error('受管 Cursor 配置已被删除或复制，不会覆盖或删除');
  }
  if (hashManagedEntry(entries[0]) !== record.entrySha256) {
    throw new Error('受管 Cursor 配置已被修改，不会覆盖或删除');
  }
}

function withCanonicalEntry(config: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const hooks = cloned.hooks as Record<string, unknown>;
  const next: unknown[] = [];
  let inserted = false;
  for (const entry of beforeShellEntries(cloned)) {
    if (isManagedEntry(entry)) {
      if (!inserted) {
        next.push({ ...CURSOR_HOOK_ENTRY });
        inserted = true;
      }
      continue;
    }
    next.push(entry);
  }
  if (!inserted) next.push({ ...CURSOR_HOOK_ENTRY });
  hooks.beforeShellExecution = next;
  return cloned;
}

function withoutManagedEntries(config: Record<string, unknown>): Record<string, unknown> {
  const cloned = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  const hooks = cloned.hooks as Record<string, unknown>;
  const next = beforeShellEntries(cloned).filter((entry) => !isManagedEntry(entry));
  if (next.length === 0) delete hooks.beforeShellExecution;
  else hooks.beforeShellExecution = next;
  return cloned;
}

function canDeleteCreatedConfig(config: Record<string, unknown>): boolean {
  if (Object.keys(config).some((key) => key !== 'version' && key !== 'hooks')) return false;
  return config.version === 1
    && isRecord(config.hooks)
    && Object.keys(config.hooks).length === 0;
}

function encodeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
}

function snapshot(path: string): FileSnapshot {
  const stat = lstatIfPresent(path);
  return stat !== null
    ? { path, exists: true, bytes: readFileSync(path), mode: stat.mode & 0o777 }
    : { path, exists: false, bytes: null, mode: null };
}

function atomicWrite(path: string, bytes: Buffer, requestedMode?: number): void {
  const temp = join(dirname(path), `.${basename(path)}.${process.pid}.${randomUUID()}.tmp`);
  const existing = lstatIfPresent(path);
  const mode = requestedMode ?? (existing === null ? 0o644 : existing.mode & 0o777);
  try {
    writeFileSync(temp, bytes, { flag: 'wx', mode });
    renameSync(temp, path);
  } catch (error) {
    try {
      if (existsSync(temp)) unlinkSync(temp);
    } catch {
      // 原错误更有信息量。
    }
    throw error;
  }
}

function writeIfChanged(path: string, bytes: Buffer): void {
  if (existsSync(path) && readFileSync(path).equals(bytes)) return;
  atomicWrite(path, bytes);
}

function restoreSnapshot(value: FileSnapshot): void {
  if (value.exists && value.bytes !== null) {
    mkdirSync(dirname(value.path), { recursive: true });
    atomicWrite(value.path, value.bytes, value.mode ?? 0o644);
  } else if (existsSync(value.path)) {
    unlinkSync(value.path);
  }
}

function rollback(files: FileSnapshot[], createdDirs: string[]): void {
  for (const file of [...files].reverse()) {
    try {
      restoreSnapshot(file);
    } catch {
      // 后续错误会报告主操作失败；尽力恢复其余文件。
    }
  }
  for (const dir of createdDirs) {
    try {
      if (existsSync(dir)) rmdirSync(dir);
    } catch {
      // 非空或已不存在时保留，避免扩大删除范围。
    }
  }
}

function install(paths: TargetPaths, bundle: Buffer): CursorHookResult {
  const config = readCursorConfig(paths.config);
  const record = readInstallRecord(paths.install);
  assertManagedFileSafe(paths, record);
  assertManagedEntrySafe(config.value, record);

  const cursorDirCreated = record?.cursorDirCreated ?? !existsSync(paths.cursorDir);
  const managedDirCreated = record?.managedDirCreated ?? !existsSync(paths.managedDir);
  const configCreated = record?.configCreated ?? !config.exists;
  const hookSha256 = hashBytes(bundle);
  const nextRecord: InstallRecord = {
    schemaVersion: 1,
    command: CURSOR_HOOK_COMMAND,
    hookFile: HOOK_FILE,
    hookSha256,
    entrySha256: hashManagedEntry(CURSOR_HOOK_ENTRY),
    cursorDirCreated,
    managedDirCreated,
    configCreated,
  };
  const nextConfig = withCanonicalEntry(config.value);
  const snapshots = [snapshot(paths.config), snapshot(paths.hook), snapshot(paths.install)];
  const createdDirs: string[] = [];

  try {
    if (!existsSync(paths.cursorDir)) {
      mkdirSync(paths.cursorDir);
      createdDirs.unshift(paths.cursorDir);
    }
    if (!existsSync(paths.managedDir)) {
      mkdirSync(paths.managedDir);
      createdDirs.unshift(paths.managedDir);
    }
    writeIfChanged(paths.hook, bundle);
    writeIfChanged(paths.install, encodeJson(nextRecord));
    writeIfChanged(paths.config, encodeJson(nextConfig));
  } catch (error) {
    rollback(snapshots, createdDirs);
    throw new Error(`安装 Cursor TDD 检查失败并已尝试恢复：${error instanceof Error ? error.message : String(error)}`);
  }

  return result('installed', `✅ Cursor TDD 提交前检查已安装：${paths.config}`, paths.root);
}

function status(paths: TargetPaths, bundle: Buffer): CursorHookResult {
  const config = readCursorConfig(paths.config);
  const record = readInstallRecord(paths.install);
  const hookExists = existsSync(paths.hook);
  const entries = beforeShellEntries(config.value).filter(isManagedEntry);
  const hasManagedTrace = record !== null || hookExists || entries.length > 0;
  if (!hasManagedTrace) {
    return result('missing', '❌ 当前项目尚未安装 Cursor TDD 提交前检查', paths.root);
  }
  assertManagedFileSafe(paths, record);
  assertManagedEntrySafe(config.value, record);
  if (record === null || !hookExists || entries.length !== 1 || !isCanonicalEntry(entries[0])) {
    return result('stale', '❌ Cursor TDD 提交前检查不完整或配置已漂移，请重新运行 install', paths.root);
  }
  if (record.hookSha256 !== hashBytes(bundle)) {
    return result('stale', '❌ Cursor TDD 提交前检查版本已过期，请重新运行 install', paths.root);
  }
  return result('healthy', `✅ Cursor TDD 提交前检查有效：${paths.config}`, paths.root);
}

function remove(paths: TargetPaths): CursorHookResult {
  const config = readCursorConfig(paths.config);
  const record = readInstallRecord(paths.install);
  const hookExists = existsSync(paths.hook);
  const entries = beforeShellEntries(config.value).filter(isManagedEntry);
  if (record === null && !hookExists && entries.length === 0) {
    return result('absent', '✅ 当前项目没有 coding-x 管理的 Cursor TDD 检查', paths.root);
  }
  if (record === null) {
    throw new Error('发现无法确认归属的 Cursor TDD 配置，不会自动删除');
  }
  assertManagedFileSafe(paths, record);
  assertManagedEntrySafe(config.value, record);

  const nextConfig = withoutManagedEntries(config.value);
  const deleteConfig = record.configCreated && canDeleteCreatedConfig(nextConfig);
  const snapshots = [snapshot(paths.config), snapshot(paths.hook), snapshot(paths.install)];
  try {
    if (deleteConfig) {
      if (existsSync(paths.config)) unlinkSync(paths.config);
    } else if (config.exists) {
      writeIfChanged(paths.config, encodeJson(nextConfig));
    }
    if (existsSync(paths.hook)) unlinkSync(paths.hook);
    if (existsSync(paths.install)) unlinkSync(paths.install);
  } catch (error) {
    rollback(snapshots, []);
    throw new Error(`卸载 Cursor TDD 检查失败并已尝试恢复：${error instanceof Error ? error.message : String(error)}`);
  }

  if (record.managedDirCreated) {
    try {
      if (existsSync(paths.managedDir)) rmdirSync(paths.managedDir);
    } catch {
      // 目录中出现其他文件时保留。
    }
  }
  if (record.cursorDirCreated) {
    try {
      if (existsSync(paths.cursorDir)) rmdirSync(paths.cursorDir);
    } catch {
      // 目录中有用户文件时保留。
    }
  }
  return result('removed', `✅ 已移除 coding-x 管理的 Cursor TDD 检查：${paths.root}`, paths.root);
}

export function runCursorHookAction(
  action: CursorHookAction,
  options: CursorHookOptions,
): CursorHookResult {
  let root: string | undefined;
  try {
    root = resolveGitRoot(options.root);
    const paths = pathsFor(root);
    validateTargetLayout(paths);
    if (action === 'remove') return remove(paths);
    const bundle = readBundle(options.bundle);
    if (bundle === null) {
      return result('error', `❌ coding-x 发布物缺少 TDD hook：${options.bundle}`, root);
    }
    if (action === 'install') return install(paths, bundle);
    return status(paths, bundle);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const conflict = /符号链接|配置|安装记录|受管脚本|Cursor hooks|归属|不是目录|不是普通文件/.test(message);
    return result(conflict ? 'conflict' : 'error', `❌ ${message}`, root);
  }
}
