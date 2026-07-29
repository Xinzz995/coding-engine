import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import {
  accessSync,
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  realpathSync,
  type BigIntStats,
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
import {
  forceKillProcessTreeOnExit,
  forceTerminateProcessTree,
  hasLiveProcessGroup,
  terminateProcessTree,
} from './process-tree.js';
import { EVIDENCE_DIAGNOSTIC_CHARS } from './evidence.js';

export type AgentKind = 'claude' | 'codex' | 'cursor';

interface AgentRunnerFileIdentity {
  device: string;
  inode: string;
  size: string;
  mode: string;
  modifiedNs: string;
  changedNs: string;
}

type NativeAgentRunnerFormat = 'elf' | 'mach-o' | 'pe';

export interface FrozenAgentRunner {
  readonly kind: AgentKind;
  readonly executablePath: string;
  readonly executableSha256: string;
  readonly fileIdentity: Readonly<AgentRunnerFileIdentity>;
  readonly excludedProjectRoot: string;
}

const AGENT_RUNNER_HASH_CHUNK_BYTES = 64 * 1024;

function nativeAgentRunnerFormat(bytes: Buffer): NativeAgentRunnerFormat | null {
  if (bytes.length >= 4 && bytes[0] === 0x7f && bytes.subarray(1, 4).toString('ascii') === 'ELF') {
    return 'elf';
  }
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
  if (bytes.length >= 64 && bytes[0] === 0x4d && bytes[1] === 0x5a) {
    const peOffset = bytes.readUInt32LE(0x3c);
    if (
      peOffset <= bytes.length - 4 &&
      bytes[peOffset] === 0x50 &&
      bytes[peOffset + 1] === 0x45 &&
      bytes[peOffset + 2] === 0 &&
      bytes[peOffset + 3] === 0
    ) {
      return 'pe';
    }
  }
  return null;
}

function insideRoot(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel));
}

function agentRunnerIdentity(stats: BigIntStats): AgentRunnerFileIdentity {
  return {
    device: stats.dev.toString(),
    inode: stats.ino.toString(),
    size: stats.size.toString(),
    mode: stats.mode.toString(),
    modifiedNs: stats.mtimeNs.toString(),
    changedNs: stats.ctimeNs.toString(),
  };
}

function sameAgentRunnerIdentity(
  left: AgentRunnerFileIdentity,
  right: AgentRunnerFileIdentity,
): boolean {
  return (
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.mode === right.mode &&
    left.modifiedNs === right.modifiedNs &&
    left.changedNs === right.changedNs
  );
}

function snapshotAgentRunner(path: string): {
  executableSha256: string;
  fileIdentity: AgentRunnerFileIdentity;
} {
  const noFollow = process.platform === 'win32' ? 0 : (constants.O_NOFOLLOW ?? 0);
  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const before = fstatSync(descriptor, { bigint: true });
    if (!before.isFile()) throw new Error('Agent Runner 不是普通文件');
    const hash = createHash('sha256');
    const chunk = Buffer.allocUnsafe(AGENT_RUNNER_HASH_CHUNK_BYTES);
    let header = Buffer.alloc(0);
    let bytesRead = 0;
    do {
      bytesRead = readSync(descriptor, chunk, 0, chunk.length, null);
      if (bytesRead > 0) {
        const bytes = chunk.subarray(0, bytesRead);
        if (header.length < 4096) {
          header = Buffer.concat([header, bytes.subarray(0, 4096 - header.length)]);
        }
        hash.update(bytes);
      }
    } while (bytesRead > 0);
    const after = fstatSync(descriptor, { bigint: true });
    const beforeIdentity = agentRunnerIdentity(before);
    const afterIdentity = agentRunnerIdentity(after);
    if (!sameAgentRunnerIdentity(beforeIdentity, afterIdentity)) {
      throw new Error('读取期间 Agent Runner 身份发生变化');
    }
    if (nativeAgentRunnerFormat(header) === null) {
      throw new Error('Agent Runner 必须是受支持的原生单文件可执行程序；脚本或未知格式入口被拒绝');
    }
    return {
      executableSha256: `sha256:${hash.digest('hex')}`,
      fileIdentity: afterIdentity,
    };
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

function agentExecutableNames(command: string): string[] {
  if (process.platform !== 'win32' || extname(command) !== '') return [command];
  return [
    command,
    ...(process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .map((extension) => extension.trim())
      .filter(Boolean)
      .map((extension) => `${command}${extension}`),
  ];
}

function agentExecutableCandidates(command: string): string[] {
  if (command.includes('\0') || /[\r\n]/.test(command) || command.trim() !== command) return [];
  if (/\s/.test(command)) {
    throw new Error('正式 Agent Runner 配置必须是单一可执行文件，不能包含拼接参数');
  }
  const names = agentExecutableNames(command);
  const containsSeparator =
    command.includes('/') || command.includes('\\') || command.includes(sep);
  if (isAbsolute(command) || containsSeparator) return isAbsolute(command) ? names : [];
  return (process.env.PATH ?? '').split(delimiter).flatMap((entry) => {
    const unquoted =
      entry.length >= 2 && entry.startsWith('"') && entry.endsWith('"')
        ? entry.slice(1, -1)
        : entry;
    if (!isAbsolute(unquoted)) return [];
    return names.map((name) => resolve(unquoted, name));
  });
}

function resolveAgentRunnerExecutable(kind: AgentKind, projectRoot: string): string {
  const lexicalRoot = resolve(projectRoot);
  const canonicalRoot = realpathSync.native(lexicalRoot);
  for (const candidate of agentExecutableCandidates(resolveBinary(kind))) {
    const lexicalCandidate = resolve(candidate);
    try {
      lstatSync(lexicalCandidate);
    } catch {
      continue;
    }
    if (insideRoot(lexicalRoot, lexicalCandidate)) {
      throw new Error(`Agent Runner 候选位于不可信项目根内：${lexicalCandidate}`);
    }
    try {
      const canonicalParent = join(
        realpathSync.native(dirname(lexicalCandidate)),
        basename(lexicalCandidate),
      );
      if (insideRoot(canonicalRoot, canonicalParent)) {
        throw new Error(`Agent Runner 候选位于不可信项目根内：${lexicalCandidate}`);
      }
    } catch (error) {
      if (error instanceof Error && error.message.includes('不可信项目根')) throw error;
    }
    let real: string;
    try {
      accessSync(lexicalCandidate, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
      real = realpathSync.native(lexicalCandidate);
    } catch {
      continue;
    }
    if (insideRoot(canonicalRoot, real)) {
      throw new Error(`Agent Runner 位于不可信项目根内：${real}`);
    }
    return real;
  }
  throw new Error(`找不到项目外可执行的 ${kind} Agent Runner`);
}

export function freezeAgentRunner(kind: AgentKind, projectRoot: string): FrozenAgentRunner {
  let canonicalRoot: string;
  try {
    canonicalRoot = realpathSync.native(resolve(projectRoot));
  } catch (error) {
    throw new Error(
      `无法核对 Agent Runner 的项目根：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  const executablePath = resolveAgentRunnerExecutable(kind, projectRoot);
  const captured = snapshotAgentRunner(executablePath);
  return Object.freeze({
    kind,
    executablePath,
    executableSha256: captured.executableSha256,
    fileIdentity: Object.freeze({ ...captured.fileIdentity }),
    excludedProjectRoot: canonicalRoot,
  });
}

export function assertFrozenAgentRunner(frozen: FrozenAgentRunner): void {
  if (!isAbsolute(frozen.executablePath)) throw new Error('冻结的 Agent Runner 路径不是绝对路径');
  if (insideRoot(frozen.excludedProjectRoot, frozen.executablePath)) {
    throw new Error('冻结的 Agent Runner 位于不可信项目根内');
  }
  let currentReal: string;
  let current: ReturnType<typeof snapshotAgentRunner>;
  try {
    currentReal = realpathSync.native(frozen.executablePath);
    current = snapshotAgentRunner(frozen.executablePath);
  } catch (error) {
    throw new Error(
      `冻结的 Agent Runner 不可复核：${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    currentReal !== frozen.executablePath ||
    current.executableSha256 !== frozen.executableSha256 ||
    !sameAgentRunnerIdentity(current.fileIdentity, frozen.fileIdentity)
  ) {
    throw new Error('冻结的 Agent Runner 已变化');
  }
}

export function permissionWarning(kind: AgentKind): string {
  const flag =
    kind === 'codex'
      ? '--dangerously-bypass-approvals-and-sandbox'
      : kind === 'cursor'
        ? '--force'
        : '--dangerously-skip-permissions';
  return [
    '',
    '⚠️  coding-x 将以【跳过权限】模式自动运行 AI agent：',
    `   使用 ${kind} ${flag}`,
    '   它会在无人确认的情况下读写文件、执行命令、提交代码。',
    '   请确认当前目录是你信任的项目工作区。',
    '',
  ].join('\n');
}

function executableOnPath(name: string): boolean {
  const path = process.env.PATH ?? '';
  const extensions =
    process.platform === 'win32' ? (process.env.PATHEXT ?? '.COM;.EXE;.BAT;.CMD').split(';') : [''];
  for (const dir of path.split(delimiter).filter(Boolean)) {
    for (const extension of extensions) {
      try {
        accessSync(join(dir, `${name}${extension}`), constants.X_OK);
        return true;
      } catch {
        // Try the next PATH entry.
      }
    }
  }
  return false;
}

export function resolveBinary(kind: AgentKind): string {
  if (kind === 'codex') return process.env.CODING_X_CODEX_BIN ?? 'codex';
  if (kind === 'cursor') {
    if (process.env.CODING_X_CURSOR_BIN) return process.env.CODING_X_CURSOR_BIN;
    // Cursor's install docs currently use `agent`; older installs expose
    // `cursor-agent`. Prefer the unambiguous legacy name when both exist.
    return executableOnPath('cursor-agent') ? 'cursor-agent' : 'agent';
  }
  return process.env.CODING_X_CLAUDE_BIN ?? 'claude';
}

export function buildAgentArgs(kind: AgentKind, prompt: string, model?: string): string[] {
  const bin = resolveBinary(kind);
  const modelArgs = model ? ['--model', model] : [];
  if (kind === 'codex') {
    return [bin, 'exec', '--dangerously-bypass-approvals-and-sandbox', ...modelArgs, prompt];
  }
  if (kind === 'cursor') return [bin, '-p', '--force', ...modelArgs, prompt];
  return [bin, '--print', '--dangerously-skip-permissions', ...modelArgs, prompt];
}

export interface RunResult {
  timedOut: boolean;
  exitCode: number | null;
  /** 从 spawn 前到 runner stdio 关闭的墙钟耗时；超时路径含整棵进程树终止等待。 */
  durationMs: number;
  /** stdout/stderr 实时 tee 后保留的有界合并尾部；是否持久化由 loop 按结局决定。 */
  outputTail: string;
}

export function runAgent(opts: {
  kind: AgentKind;
  prompt: string;
  cwd: string;
  timeoutMs: number;
  /** 透传给 agent CLI 的 --model；undefined = 不传（用户 CLI 默认模型） */
  model?: string;
  /** coding-x 运行上下文等显式子进程环境；其余环境原样继承。 */
  env?: NodeJS.ProcessEnv;
  /** 正式循环在任何项目代码前冻结，并由 Developer/Validator 共同复用。 */
  frozenRunner?: FrozenAgentRunner;
}): Promise<RunResult> {
  // buildAgentArgs()[0] may itself be "node /path mode" when overridden by an
  // env var in tests; split it so the stub receives its trailing args.
  const argv = buildAgentArgs(opts.kind, opts.prompt, opts.model);
  let cmd: string;
  let args: string[];
  if (opts.frozenRunner) {
    if (opts.frozenRunner.kind !== opts.kind) {
      return Promise.resolve({
        timedOut: false,
        exitCode: 1,
        durationMs: 0,
        outputTail: `冻结的 Agent Runner 类型错配：期望 ${opts.kind}，收到 ${opts.frozenRunner.kind}`,
      });
    }
    try {
      assertFrozenAgentRunner(opts.frozenRunner);
    } catch (error) {
      return Promise.resolve({
        timedOut: false,
        exitCode: 1,
        durationMs: 0,
        outputTail: error instanceof Error ? error.message : String(error),
      });
    }
    cmd = opts.frozenRunner.executablePath;
    args = argv.slice(1);
  } else {
    const head = argv[0].split(' ');
    cmd = head[0];
    args = [...head.slice(1), ...argv.slice(1)];
  }

  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const child = spawn(cmd, args, {
      cwd: opts.cwd,
      stdio: ['inherit', 'pipe', 'pipe'],
      detached: process.platform !== 'win32',
      env: { ...process.env, ...opts.env },
    });
    let outputTail = '';
    const keep = (chunk: Buffer | string) => {
      outputTail = (outputTail + String(chunk)).slice(-EVIDENCE_DIAGNOSTIC_CHARS);
    };
    // headless runner 的 stdout/stderr 继续实时可见，同时只滚动保留最近的有界尾部。
    // 与 gate 的 tee 语义一致；不等待整段输出、不把成功 transcript 持久化。
    child.stdout?.on('data', (chunk: Buffer) => {
      process.stdout.write(chunk);
      keep(chunk);
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      process.stderr.write(chunk);
      keep(chunk);
    });
    let settled = false;
    let terminating = false;
    const killOnParentExit = () => forceKillProcessTreeOnExit(child);
    process.once('exit', killOnParentExit);

    const finish = (timedOut: boolean, exitCode: number | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      process.removeListener('exit', killOnParentExit);
      if (opts.frozenRunner) {
        try {
          assertFrozenAgentRunner(opts.frozenRunner);
        } catch (error) {
          keep(
            `\nAgent Runner 调用期间身份失效：${error instanceof Error ? error.message : String(error)}`,
          );
          exitCode = 1;
        }
      }
      resolve({
        timedOut,
        exitCode,
        durationMs: Math.max(0, Date.now() - startedAt),
        outputTail,
      });
    };
    const fail = (err: unknown) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      // 终止失败时保持 exit hook；趁根 pid 尚在同步补杀整树，避免 Windows 先杀根后遗失孙进程。
      forceKillProcessTreeOnExit(child);
      reject(err instanceof Error ? err : new Error(String(err)));
    };

    const timer = setTimeout(() => {
      if (settled || terminating) return;
      terminating = true;
      void terminateProcessTree(child).then(() => {
        finish(true, null);
      }, fail);
    }, opts.timeoutMs);

    // close 晚于 exit，保证 pipe 中最后一段 stdout/stderr 已被 tee/采集后再写 evidence。
    child.once('close', (code) => {
      if (terminating) return;
      if (hasLiveProcessGroup(child) === true) {
        terminating = true;
        keep('\nAgent 根进程退出后仍有后台后代，已强制终止并将本轮判为失败');
        void forceTerminateProcessTree(child).then(() => {
          finish(false, 1);
        }, fail);
        return;
      }
      finish(false, code);
    });

    child.once('error', (err) => {
      if (terminating) return;
      console.error(`\n❌ Agent 错误: ${err.message}`);
      keep(err.message);
      finish(false, 1);
    });
  });
}
