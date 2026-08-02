import { createHash } from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { closeSync, constants, fstatSync, lstatSync, openSync, readFileSync } from 'node:fs';
import { isAbsolute, join, resolve, win32 } from 'node:path';
import { WorkspaceSafetyError } from './types.js';

export const WINDOWS_SUPERVISOR_EXECUTABLE = 'coding-x-windows-supervisor.exe';

const EXECUTABLE_DOMAIN = Buffer.from('coding-x-windows-supervisor-exe-v1\0', 'utf8');

export interface WindowsSupervisorTimeouts {
  readonly handshakeMs: number;
  readonly naturalDrainMs: number;
  readonly terminateMs: number;
  readonly ackMs: number;
  readonly pollMs: number;
}

export interface WindowsSupervisorAssets {
  readonly root: string;
  readonly executablePath: string;
  readonly helperBytes: Buffer;
  readonly helperDigest: string;
}

export interface WindowsSupervisorLaunch {
  readonly command: string;
  readonly args: readonly string[];
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly detached: true;
  readonly windowsHide: true;
  readonly stdio: readonly ['pipe', 'pipe', 'pipe'];
  readonly assets: WindowsSupervisorAssets;
}

export interface CreateWindowsSupervisorLaunchOptions {
  readonly assetRoot: string;
  readonly environment?: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly timeouts?: Partial<WindowsSupervisorTimeouts>;
}

export const DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS: WindowsSupervisorTimeouts = Object.freeze({
  handshakeMs: 120_000,
  naturalDrainMs: 5000,
  terminateMs: 5000,
  // DRAINED already proves that the Job is empty. This last phase only verifies the bound
  // receipt, closes the supervisor, and settles the operation, but those disk-backed checks can
  // exceed five seconds on a loaded hosted Windows runner. Keep one bounded absolute deadline
  // with enough headroom for that proof instead of treating scheduler variance as contamination.
  ackMs: 30_000,
  pollMs: 25,
});

function invalid(message: string): never {
  throw new WorkspaceSafetyError('invalid', `Invalid Windows supervisor launch: ${message}`);
}

function stableAssetBytes(path: string): Buffer {
  let descriptor: number | undefined;
  try {
    const before = lstatSync(path, { bigint: true });
    if (
      before.isSymbolicLink() ||
      !before.isFile() ||
      before.nlink !== 1n ||
      before.size > 4n * 1024n * 1024n
    ) {
      return invalid('fixed helper asset must be an ordinary bounded single-link file');
    }
    const noFollow = process.platform === 'win32' ? 0 : constants.O_NOFOLLOW;
    descriptor = openSync(path, constants.O_RDONLY | noFollow);
    const opened = fstatSync(descriptor, { bigint: true });
    if (
      !opened.isFile() ||
      opened.nlink !== 1n ||
      opened.dev !== before.dev ||
      opened.ino !== before.ino
    ) {
      return invalid('fixed helper asset identity changed before read');
    }
    const bytes = readFileSync(descriptor);
    const afterHandle = fstatSync(descriptor, { bigint: true });
    const afterPath = lstatSync(path, { bigint: true });
    if (
      afterPath.isSymbolicLink() ||
      !afterPath.isFile() ||
      afterHandle.nlink !== 1n ||
      afterPath.nlink !== 1n ||
      opened.dev !== afterHandle.dev ||
      opened.ino !== afterHandle.ino ||
      opened.size !== afterHandle.size ||
      opened.mtimeNs !== afterHandle.mtimeNs ||
      opened.ctimeNs !== afterHandle.ctimeNs ||
      afterHandle.dev !== afterPath.dev ||
      afterHandle.ino !== afterPath.ino ||
      afterHandle.size !== afterPath.size ||
      afterHandle.mtimeNs !== afterPath.mtimeNs ||
      afterHandle.ctimeNs !== afterPath.ctimeNs ||
      BigInt(bytes.length) !== afterHandle.size
    ) {
      return invalid('fixed helper asset changed during read');
    }
    return bytes;
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
  }
}

function boundedInteger(
  value: unknown,
  name: keyof WindowsSupervisorTimeouts,
  minimum: number,
  maximum: number,
): number {
  if (!Number.isSafeInteger(value) || (value as number) < minimum || (value as number) > maximum) {
    return invalid(`${name} is outside its supported range`);
  }
  return value as number;
}

export function resolveWindowsSupervisorTimeouts(
  input: Partial<WindowsSupervisorTimeouts> = {},
): WindowsSupervisorTimeouts {
  return {
    handshakeMs: boundedInteger(
      input.handshakeMs ?? DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS.handshakeMs,
      'handshakeMs',
      10,
      300_000,
    ),
    naturalDrainMs: boundedInteger(
      input.naturalDrainMs ?? DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS.naturalDrainMs,
      'naturalDrainMs',
      0,
      60_000,
    ),
    terminateMs: boundedInteger(
      input.terminateMs ?? DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS.terminateMs,
      'terminateMs',
      1,
      60_000,
    ),
    ackMs: boundedInteger(
      input.ackMs ?? DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS.ackMs,
      'ackMs',
      10,
      60_000,
    ),
    pollMs: boundedInteger(
      input.pollMs ?? DEFAULT_WINDOWS_SUPERVISOR_TIMEOUTS.pollMs,
      'pollMs',
      1,
      1000,
    ),
  };
}

function environmentValue(environment: NodeJS.ProcessEnv, name: string): string {
  const keys = Object.keys(environment).filter((candidate) => candidate.toLowerCase() === name);
  if (keys.length !== 1) return invalid(`required ${name} environment value is ambiguous`);
  const value = environment[keys[0]];
  if (typeof value !== 'string' || value.length === 0 || value.includes('\0')) {
    return invalid(`required ${name} environment value is unavailable`);
  }
  return value;
}

export function readWindowsSupervisorAssets(assetRoot: string): WindowsSupervisorAssets {
  if (!isAbsolute(assetRoot) || assetRoot.includes('\0')) {
    return invalid('assetRoot must be an absolute path');
  }
  const root = resolve(assetRoot);
  const rootInfo = lstatSync(root);
  if (rootInfo.isSymbolicLink() || !rootInfo.isDirectory()) {
    return invalid('assetRoot must be an ordinary directory');
  }
  const executablePath = join(root, WINDOWS_SUPERVISOR_EXECUTABLE);
  const executableBytes = stableAssetBytes(executablePath);
  const helperBytes = Buffer.concat([EXECUTABLE_DOMAIN, executableBytes]);
  const helperDigest = `sha256:${createHash('sha256').update(helperBytes).digest('hex')}`;
  return { root, executablePath, helperBytes, helperDigest };
}

export function createWindowsSupervisorLaunch(
  options: CreateWindowsSupervisorLaunchOptions,
): WindowsSupervisorLaunch {
  if ((options.platform ?? process.platform) !== 'win32') {
    throw new WorkspaceSafetyError('unsupported', 'Windows Job Objects require Windows');
  }
  const assets = readWindowsSupervisorAssets(options.assetRoot);
  const environment = options.environment ?? process.env;
  const systemRoot = environmentValue(environment, 'systemroot');
  const temp = environmentValue(environment, 'temp');
  const tmp = environmentValue(environment, 'tmp');
  if (!win32.isAbsolute(systemRoot) || !win32.isAbsolute(temp) || !win32.isAbsolute(tmp)) {
    return invalid('SystemRoot, TEMP, and TMP must be absolute paths');
  }
  const timeoutsBase64 = Buffer.from(
    JSON.stringify(resolveWindowsSupervisorTimeouts(options.timeouts)),
    'utf8',
  ).toString('base64');
  return {
    command: assets.executablePath,
    args: ['--expected-helper-digest', assets.helperDigest, '--timeouts-base64', timeoutsBase64],
    cwd: assets.root,
    env: { SystemRoot: systemRoot, TEMP: temp, TMP: tmp },
    detached: true,
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
    assets,
  };
}

export function spawnWindowsJobSupervisor(
  launch: WindowsSupervisorLaunch,
): ChildProcessWithoutNullStreams {
  if (process.platform !== 'win32') {
    throw new WorkspaceSafetyError('unsupported', 'Windows Job Objects require Windows');
  }
  return spawn(launch.command, [...launch.args], {
    cwd: launch.cwd,
    env: { ...launch.env },
    detached: launch.detached,
    windowsHide: launch.windowsHide,
    shell: false,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}
